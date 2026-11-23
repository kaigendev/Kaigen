//! WebView2 calls belong to Tauri's native webview callback on the UI thread.
use tauri::{webview::PlatformWebview, WebviewWindow};
use webview2_com::{
    ContextMenuRequestedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2ContextMenuItemCollection,
        ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2_11,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
        COREWEBVIEW2_PROCESS_FAILED_KIND,
    },
    ProcessFailedEventHandler,
};
use windows_core::{Interface, BOOL, PWSTR};

#[link(name = "user32")]
unsafe extern "system" {
    fn GetForegroundWindow() -> *mut std::ffi::c_void;
}

pub(super) fn foreground_window_id() -> usize {
    // SAFETY: No arguments or dereferences. This uses the HWND as an identifier.
    unsafe { GetForegroundWindow() as usize }
}

pub(super) fn focus(webview: &PlatformWebview) -> bool {
    // SAFETY: Tauri supplies a live controller on its UI thread. The focus
    // reason is a documented WebView2 constant.
    unsafe {
        webview
            .controller()
            .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
    }
    .is_ok()
}

fn core(webview: &PlatformWebview) -> windows_core::Result<ICoreWebView2> {
    // SAFETY: The controller is borrowed from the live UI-thread callback.
    unsafe { webview.controller().CoreWebView2() }
}

pub(super) fn on_process_failure(
    window: &WebviewWindow,
    on_failure: impl Fn(i32) + Send + 'static,
) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        let Ok(core) = core(&webview) else {
            return;
        };
        let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            // SAFETY: WebView2 supplies the typed callback interface and kind is
            // a live writable slot of the required type.
            unsafe { args.ProcessFailedKind(&mut kind)? };
            on_failure(kind.0);
            Ok(())
        }));
        let mut subscription = 0;
        // SAFETY: The callback and output slot live through registration on
        // the controller's UI thread. WebView2 retains the registered callback.
        let _ = unsafe { core.add_ProcessFailed(&handler, &mut subscription) };
    })
}

pub(super) fn filter_editable_context_menu(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        let Ok(core) = core(&webview) else {
            return;
        };
        let Ok(core): Result<ICoreWebView2_11, _> = core.cast() else {
            return;
        };
        let handler = ContextMenuRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                if let Some(items) = MenuItems::for_editable_target(&args)? {
                    items.filter()?;
                }
            }
            Ok(())
        }));
        let mut subscription = 0;
        // SAFETY: The callback and output slot live through registration on
        // the controller's UI thread. WebView2 retains the registered callback.
        let _ = unsafe { core.add_ContextMenuRequested(&handler, &mut subscription) };
    })
}

struct MenuItems(ICoreWebView2ContextMenuItemCollection);

impl MenuItems {
    fn for_editable_target(
        args: &ICoreWebView2ContextMenuRequestedEventArgs,
    ) -> windows_core::Result<Option<Self>> {
        let mut editable = BOOL::default();
        // SAFETY: WebView2 supplied the callback arguments on the UI thread.
        // The target is typed and editable is a live writable BOOL.
        unsafe {
            args.ContextMenuTarget()?.IsEditable(&mut editable)?;
            if !editable.as_bool() {
                return Ok(None);
            }
            Ok(Some(Self(args.MenuItems()?)))
        }
    }

    fn count(&self) -> windows_core::Result<u32> {
        let mut count = 0;
        // SAFETY: The typed collection is live and count is a writable u32.
        unsafe { self.0.Count(&mut count)? };
        Ok(count)
    }

    fn entry(
        &self,
        index: u32,
        read_name: bool,
    ) -> windows_core::Result<(COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, String)> {
        let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
        let mut name = PWSTR::null();
        // SAFETY: Callers use an index below the current count. Both output
        // slots remain live. Name transfers one COM-allocated string on success.
        unsafe {
            let item = self.0.GetValueAtIndex(index)?;
            item.Kind(&mut kind)?;
            if read_name {
                item.Name(&mut name)?;
            }
        }
        Ok((
            kind,
            if read_name {
                webview2_com::take_pwstr(name)
            } else {
                String::new()
            },
        ))
    }

    fn remove(&self, index: u32) -> windows_core::Result<()> {
        // SAFETY: The typed collection is live. Filter checks the index and
        // only changes the collection on the WebView2 callback's UI thread.
        unsafe { self.0.RemoveValueAtIndex(index) }
    }

    fn filter(&self) -> windows_core::Result<()> {
        for index in (0..self.count()?).rev() {
            let (kind, name) = self.entry(index, true)?;
            if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU
                || matches!(
                    name.as_str(),
                    "emoji"
                        | "moreTools"
                        | "send"
                        | "sendTabToSelf"
                        | "sendToDevices"
                        | "share"
                        | "shareLink"
                )
            {
                self.remove(index)?;
            }
        }

        // Keep native editing commands and collapse separators left by the filter.
        let mut count = self.count()?;
        let mut index = 0;
        let mut previous_was_separator = true;
        while index < count {
            let (kind, _) = self.entry(index, false)?;
            let is_separator = kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR;
            if is_separator && previous_was_separator {
                self.remove(index)?;
                count -= 1;
                continue;
            }
            previous_was_separator = is_separator;
            index += 1;
        }
        if count > 0 && previous_was_separator {
            self.remove(count - 1)?;
        }
        Ok(())
    }
}
