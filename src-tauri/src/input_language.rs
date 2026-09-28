//! Keep the Windows host input context aligned with its focused WebView.
//!
//! WebView2 owns a separate input thread. A layout change in that thread need not
//! update the host thread, which can leave the host's input context stale across
//! focus transitions. Passive renderer notifications wake this bridge; they never
//! supply a layout, consume a shortcut, replay a key, or select an application
//! language. There is no polling thread or global keyboard hook.

pub(crate) fn synchronize(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                // Resolve the current native window here, not before dispatch:
                // the WebView can have been destroyed/rebuilt while IPC waited.
                match target.hwnd() {
                    Ok(hwnd) => windows::synchronize(hwnd.0 as usize),
                    Err(_) => windows::reset(),
                }
            })
            .map_err(|_| "INPUT_LANGUAGE_WINDOW_UNAVAILABLE".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg(any(target_os = "windows", test))]
mod policy {
    use std::time::Duration;

    pub(super) const MIN_SAMPLE_GAP: Duration = Duration::from_millis(40);
    pub(super) const MAX_SAMPLE_GAP: Duration = Duration::from_millis(250);

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(super) struct Snapshot {
        pub owner: usize,
        pub owner_thread: u32,
        pub focus: usize,
        pub focus_thread: u32,
        pub owner_layout: usize,
        pub focus_layout: usize,
        pub modifiers_held: bool,
    }

    impl Snapshot {
        fn same_context(self, other: Self) -> bool {
            self.owner == other.owner
                && self.owner_thread == other.owner_thread
                && self.focus == other.focus
                && self.focus_thread == other.focus_thread
        }
    }

    #[derive(Default)]
    struct Candidate {
        released_at: Option<Duration>,
    }

    #[derive(Default)]
    pub(super) struct Stability {
        previous: Option<Snapshot>,
        candidate: Option<Candidate>,
    }

    impl Stability {
        pub fn reset(&mut self) {
            self.previous = None;
            self.candidate = None;
        }

        pub fn observe(&mut self, snapshot: Option<Snapshot>, now: Duration) -> Option<Snapshot> {
            let Some(snapshot) = snapshot else {
                self.reset();
                return None;
            };
            if snapshot.owner == 0
                || snapshot.owner_thread == 0
                || snapshot.focus == 0
                || snapshot.focus_thread == 0
                || snapshot.owner_layout == 0
                || snapshot.focus_layout == 0
                || snapshot.owner_thread == snapshot.focus_thread
            {
                self.reset();
                return None;
            }
            let previous = self.previous.replace(snapshot);
            let Some(previous) = previous else {
                return None;
            };
            // A stable disagreement does not identify the stale thread. In
            // particular, copying an unchanged child after the owner switched
            // would undo the user's new layout. Retain aligned observations so
            // only a later child-only change can authorize synchronization.
            if !previous.same_context(snapshot)
                || previous.owner_layout != snapshot.owner_layout
                || snapshot.owner_layout == snapshot.focus_layout
            {
                self.candidate = None;
                return None;
            }
            if previous.focus_layout != snapshot.focus_layout {
                let follows_child =
                    previous.owner_layout == previous.focus_layout || self.candidate.is_some();
                self.candidate = follows_child.then(Candidate::default);
            }
            let candidate = self.candidate.as_mut()?;
            if snapshot.modifiers_held {
                // The context remains validated while a shortcut is held.
                // Preserve its direction, but require a fresh released pair.
                candidate.released_at = None;
                return None;
            }
            let sampled_at = candidate.released_at.replace(now);
            if let Some(sampled_at) = sampled_at {
                let Some(gap) = now.checked_sub(sampled_at) else {
                    self.candidate = None;
                    return None;
                };
                if gap > MAX_SAMPLE_GAP {
                    self.candidate = None;
                } else if gap >= MIN_SAMPLE_GAP {
                    // Consume the observed change before attempting activation.
                    // An unchanged mismatch cannot retry a failed/racing apply.
                    self.candidate = None;
                    return Some(snapshot);
                }
            }
            None
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn sample() -> Snapshot {
            Snapshot {
                owner: 10,
                owner_thread: 20,
                focus: 30,
                focus_thread: 40,
                owner_layout: 0x0419_0419,
                focus_layout: 0x0409_0409,
                modifiers_held: false,
            }
        }

        fn aligned() -> Snapshot {
            Snapshot {
                focus_layout: sample().owner_layout,
                ..sample()
            }
        }

        fn primed() -> Stability {
            let mut state = Stability::default();
            assert_eq!(state.observe(Some(aligned()), ms(0)), None);
            state
        }

        fn ms(value: u64) -> Duration {
            Duration::from_millis(value)
        }

        #[test]
        fn an_unknown_stable_mismatch_does_not_select_a_layout() {
            let mut state = Stability::default();
            for time in [0, 60, 120, 180, 1500, 1560] {
                assert_eq!(state.observe(Some(sample()), ms(time)), None);
            }
        }

        #[test]
        fn an_owner_only_switch_never_selects_the_previous_child_layout() {
            let mut state = primed();
            let changed = Snapshot {
                owner_layout: 0x0409_0409,
                ..aligned()
            };
            // The former policy selected the old child layout at t=120,
            // despite the observed change having originated in the owner.
            for time in [60, 120, 180, 240] {
                assert_eq!(state.observe(Some(changed), ms(time)), None);
            }
        }

        #[test]
        fn a_child_only_switch_requires_two_released_stable_samples() {
            let mut state = primed();
            assert_eq!(state.observe(Some(sample()), ms(60)), None);
            assert_eq!(state.observe(Some(sample()), ms(120)), Some(sample()));
        }

        #[test]
        fn immediate_duplicate_notifications_do_not_prove_stability() {
            let mut state = primed();
            for time in [10, 20, 30, 40] {
                assert_eq!(state.observe(Some(sample()), ms(time)), None);
            }
            assert_eq!(state.observe(Some(sample()), ms(100)), Some(sample()));
        }

        #[test]
        fn idle_expiry_cannot_authorize_an_unchanged_mismatch_again() {
            let mut state = primed();
            assert_eq!(state.observe(Some(sample()), ms(60)), None);
            assert_eq!(state.observe(Some(sample()), ms(1500)), None);
            assert_eq!(state.observe(Some(sample()), ms(1560)), None);
            assert_eq!(state.observe(Some(sample()), ms(1620)), None);
        }

        #[test]
        fn invalid_focus_discards_both_direction_and_stability() {
            let mut state = primed();
            state.observe(Some(sample()), ms(60));
            assert_eq!(state.observe(None, ms(90)), None);
            assert_eq!(state.observe(Some(sample()), ms(120)), None);
            assert_eq!(state.observe(Some(sample()), ms(180)), None);
        }

        #[test]
        fn every_context_or_owner_layout_change_discards_direction() {
            let original = sample();
            let alternatives = [
                Snapshot {
                    owner: 11,
                    ..original
                },
                Snapshot {
                    owner_thread: 21,
                    ..original
                },
                Snapshot {
                    focus: 31,
                    ..original
                },
                Snapshot {
                    focus_thread: 41,
                    ..original
                },
                Snapshot {
                    owner_layout: 0x0407_0407,
                    ..original
                },
            ];
            for changed in alternatives {
                let mut state = primed();
                state.observe(Some(original), ms(60));
                assert_eq!(state.observe(Some(changed), ms(120)), None);
                assert_eq!(state.observe(Some(changed), ms(180)), None);
                assert_eq!(state.observe(Some(changed), ms(240)), None);
            }
        }

        #[test]
        fn simultaneous_owner_and_child_changes_do_not_identify_a_source() {
            let mut state = primed();
            let changed = Snapshot {
                owner_layout: 0x0407_0407,
                ..sample()
            };
            for time in [60, 120, 180] {
                assert_eq!(state.observe(Some(changed), ms(time)), None);
            }
        }

        #[test]
        fn a_pending_child_change_tracks_the_full_hkl_and_restarts_stability() {
            let mut state = primed();
            let changed = Snapshot {
                // Same low LANGID, different full layout handle.
                focus_layout: 0xf001_0409,
                ..sample()
            };
            state.observe(Some(sample()), ms(60));
            assert_eq!(state.observe(Some(changed), ms(120)), None);
            assert_eq!(state.observe(Some(changed), ms(180)), Some(changed));
        }

        #[test]
        fn a_child_switch_while_modifiers_are_held_survives_until_release() {
            let mut state = Stability::default();
            let baseline = Snapshot {
                modifiers_held: true,
                ..aligned()
            };
            let changed = Snapshot {
                modifiers_held: true,
                ..sample()
            };
            assert_eq!(state.observe(Some(baseline), ms(0)), None);
            assert_eq!(state.observe(Some(changed), ms(60)), None);
            assert_eq!(state.observe(Some(changed), ms(1500)), None);
            assert_eq!(state.observe(Some(sample()), ms(1560)), None);
            assert_eq!(state.observe(Some(sample()), ms(1620)), Some(sample()));
        }

        #[test]
        fn held_modifiers_cancel_released_stability_without_forgetting_direction() {
            let mut state = primed();
            state.observe(Some(sample()), ms(60));
            let held = Snapshot {
                modifiers_held: true,
                ..sample()
            };
            assert_eq!(state.observe(Some(held), ms(120)), None);
            assert_eq!(state.observe(Some(sample()), ms(180)), None);
            assert_eq!(state.observe(Some(sample()), ms(240)), Some(sample()));
        }

        #[test]
        fn an_owner_change_while_modifiers_are_held_cannot_restore_authority() {
            let mut state = primed();
            state.observe(Some(sample()), ms(60));
            let changed = Snapshot {
                owner_layout: 0x0407_0407,
                modifiers_held: true,
                ..sample()
            };
            assert_eq!(state.observe(Some(changed), ms(120)), None);
            let released = Snapshot {
                modifiers_held: false,
                ..changed
            };
            assert_eq!(state.observe(Some(released), ms(180)), None);
            assert_eq!(state.observe(Some(released), ms(240)), None);
        }

        #[test]
        fn released_sample_gap_has_inclusive_bounds() {
            for gap in [40, 250] {
                let mut state = primed();
                state.observe(Some(sample()), ms(60));
                assert_eq!(state.observe(Some(sample()), ms(60 + gap)), Some(sample()));
            }
            for gap in [39, 251] {
                let mut state = primed();
                state.observe(Some(sample()), ms(60));
                assert_eq!(state.observe(Some(sample()), ms(60 + gap)), None);
            }
        }

        #[test]
        fn a_backwards_clock_discards_pending_direction() {
            let mut state = primed();
            state.observe(Some(sample()), ms(60));
            assert_eq!(state.observe(Some(sample()), ms(50)), None);
            assert_eq!(state.observe(Some(sample()), ms(120)), None);
        }

        #[test]
        fn matching_layouts_and_same_thread_are_no_ops_and_clear_stability() {
            let original = sample();
            for current in [
                Snapshot {
                    owner_layout: original.focus_layout,
                    ..original
                },
                Snapshot {
                    focus_thread: original.owner_thread,
                    ..original
                },
            ] {
                let mut state = primed();
                state.observe(Some(original), ms(60));
                assert_eq!(state.observe(Some(current), ms(120)), None);
                assert_eq!(state.observe(Some(original), ms(180)), None);
                assert_eq!(state.observe(Some(original), ms(240)), None);
            }
        }

        #[test]
        fn null_windows_threads_and_layouts_never_produce_a_target() {
            let original = sample();
            for current in [
                Snapshot {
                    owner: 0,
                    ..original
                },
                Snapshot {
                    owner_thread: 0,
                    ..original
                },
                Snapshot {
                    focus: 0,
                    ..original
                },
                Snapshot {
                    focus_thread: 0,
                    ..original
                },
                Snapshot {
                    owner_layout: 0,
                    ..original
                },
                Snapshot {
                    focus_layout: 0,
                    ..original
                },
            ] {
                let mut state = Stability::default();
                assert_eq!(state.observe(Some(current), ms(0)), None);
                assert_eq!(state.observe(Some(current), ms(60)), None);
            }
        }

        #[test]
        fn attempted_apply_cannot_be_reused_even_when_activation_failed() {
            let mut state = primed();
            state.observe(Some(sample()), ms(60));
            assert_eq!(state.observe(Some(sample()), ms(120)), Some(sample()));
            for time in [180, 240, 1500, 1560] {
                assert_eq!(state.observe(Some(sample()), ms(time)), None);
            }
        }

        #[test]
        fn successful_activation_is_not_a_feedback_loop() {
            let mut state = primed();
            let aligned = Snapshot {
                owner_layout: sample().focus_layout,
                ..sample()
            };
            state.observe(Some(sample()), ms(60));
            assert_eq!(state.observe(Some(sample()), ms(120)), Some(sample()));
            assert_eq!(state.observe(Some(aligned), ms(180)), None);
            assert_eq!(state.observe(Some(aligned), ms(240)), None);
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::policy::{Snapshot, Stability};
    use std::{cell::RefCell, ffi::c_void, mem::size_of, ptr::null_mut, time::Instant};

    type Hwnd = *mut c_void;
    type Hkl = *mut c_void;

    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct GuiThreadInfo {
        size: u32,
        flags: u32,
        active: Hwnd,
        focus: Hwnd,
        capture: Hwnd,
        menu_owner: Hwnd,
        move_size: Hwnd,
        caret: Hwnd,
        caret_rect: Rect,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> Hwnd;
        fn GetWindowThreadProcessId(window: Hwnd, process: *mut u32) -> u32;
        fn GetGUIThreadInfo(thread: u32, info: *mut GuiThreadInfo) -> i32;
        fn GetKeyboardLayout(thread: u32) -> Hkl;
        fn ActivateKeyboardLayout(layout: Hkl, flags: u32) -> Hkl;
        fn GetAsyncKeyState(key: i32) -> i16;
        fn IsChild(parent: Hwnd, child: Hwnd) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThreadId() -> u32;
        fn GetCurrentProcessId() -> u32;
    }

    thread_local! {
        static OBSERVATIONS: RefCell<(Instant, Stability)> =
            RefCell::new((Instant::now(), Stability::default()));
    }

    pub(super) fn reset() {
        OBSERVATIONS.with(|observations| observations.borrow_mut().1.reset());
    }

    unsafe fn modifiers_held() -> bool {
        [0x10, 0x11, 0x12, 0x5b, 0x5c]
            .iter()
            .any(|key| GetAsyncKeyState(*key) < 0)
    }

    unsafe fn snapshot(owner: usize) -> Option<Snapshot> {
        let window = owner as Hwnd;
        if owner == 0 || GetForegroundWindow() != window {
            return None;
        }
        let mut owner_process = 0;
        let owner_thread = GetWindowThreadProcessId(window, &mut owner_process);
        if owner_process != GetCurrentProcessId() || owner_thread != GetCurrentThreadId() {
            return None;
        }
        // A held shortcut may establish direction, but never permit activation.
        // Include AltGr and a final Shift still held after releasing Control.
        let held_before = modifiers_held();
        let mut info = GuiThreadInfo {
            size: size_of::<GuiThreadInfo>() as u32,
            flags: 0,
            active: null_mut(),
            focus: null_mut(),
            capture: null_mut(),
            menu_owner: null_mut(),
            move_size: null_mut(),
            caret: null_mut(),
            caret_rect: Rect::default(),
        };
        if GetGUIThreadInfo(owner_thread, &mut info) == 0
            || info.focus.is_null()
            || IsChild(window, info.focus) == 0
        {
            return None;
        }
        let focus_thread = GetWindowThreadProcessId(info.focus, null_mut());
        if focus_thread == 0 {
            return None;
        }
        let result = Snapshot {
            owner,
            owner_thread,
            focus: info.focus as usize,
            focus_thread,
            owner_layout: GetKeyboardLayout(owner_thread) as usize,
            focus_layout: GetKeyboardLayout(focus_thread) as usize,
            modifiers_held: held_before || modifiers_held(),
        };
        (GetForegroundWindow() == window).then_some(result)
    }

    pub(super) fn synchronize(owner: usize) {
        let current = unsafe { snapshot(owner) };
        let selected = OBSERVATIONS.with(|observations| {
            let mut observations = observations.borrow_mut();
            let elapsed = observations.0.elapsed();
            observations.1.observe(current, elapsed)
        });
        if let Some(selected) = selected {
            // Discard a racing focus/layout change. No mutable borrow survives
            // this point: activation can synchronously deliver Windows messages.
            if unsafe { snapshot(owner) } == Some(selected) {
                // Flags=0 changes only this UI thread. Never force the browser
                // or other applications, load a layout, or steal input focus.
                let _ = unsafe { ActivateKeyboardLayout(selected.focus_layout as Hkl, 0) };
            }
        }
    }
}
