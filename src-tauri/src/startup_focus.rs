//! One-shot startup focus policy. Native operations stay with the WebView owner.

#[derive(Clone, Copy, Debug)]
pub(crate) struct FocusWindow {
    pub(crate) id: usize,
    pub(crate) foreground: bool,
    pub(crate) visible: bool,
    pub(crate) minimized: bool,
    pub(crate) stopped: bool,
    pub(crate) recovering: bool,
}

impl FocusWindow {
    fn eligible(self) -> bool {
        self.id != 0
            && self.foreground
            && self.visible
            && !self.minimized
            && !self.stopped
            && !self.recovering
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct FocusRequest {
    window_id: usize,
    revision: u64,
}

#[derive(Default)]
pub(crate) struct StartupFocusRepair {
    window_id: Option<usize>,
    revision: u64,
    ready: bool,
    queued: Option<FocusRequest>,
    completed: bool,
}

impl StartupFocusRepair {
    pub(crate) fn invalidate(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        self.window_id = None;
        self.ready = false;
        self.queued = None;
        self.completed = false;
    }

    pub(crate) fn request(
        &mut self,
        window: FocusWindow,
        startup_ready: bool,
    ) -> Option<FocusRequest> {
        if window.id == 0 || window.stopped {
            return None;
        }
        if self.window_id != Some(window.id) {
            self.invalidate();
            self.window_id = Some(window.id);
        }
        self.ready |= startup_ready;
        if !self.ready || self.completed || self.queued.is_some() || !window.eligible() {
            return None;
        }
        self.revision = self.revision.wrapping_add(1);
        let request = FocusRequest {
            window_id: window.id,
            revision: self.revision,
        };
        self.queued = Some(request);
        Some(request)
    }

    pub(crate) fn can_apply(&self, request: FocusRequest, window: FocusWindow) -> bool {
        self.queued == Some(request)
            && self.window_id == Some(window.id)
            && request.window_id == window.id
            && request.revision == self.revision
            && self.ready
            && !self.completed
            && window.eligible()
    }

    pub(crate) fn finish(&mut self, request: FocusRequest, succeeded: bool) {
        // A callback from an earlier window must not clear a newer queued repair.
        if self.queued == Some(request) {
            self.queued = None;
            self.completed = succeeded;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn foreground(id: usize) -> FocusWindow {
        FocusWindow {
            id,
            foreground: true,
            visible: true,
            minimized: false,
            stopped: false,
            recovering: false,
        }
    }

    #[test]
    fn waits_for_readiness_and_repairs_once_despite_duplicate_reports() {
        let mut policy = StartupFocusRepair::default();
        let window = foreground(7);
        assert!(policy.request(window, false).is_none());
        let request = policy.request(window, true).unwrap();
        assert!(policy.request(window, true).is_none());
        assert!(policy.request(window, false).is_none());
        assert!(policy.can_apply(request, window));
        policy.finish(request, true);
        assert!(policy.request(window, true).is_none());
        assert!(!policy.can_apply(request, window));
    }

    #[test]
    fn background_hidden_and_minimized_startup_remain_pending_until_return() {
        for unavailable in [
            FocusWindow {
                foreground: false,
                ..foreground(7)
            },
            FocusWindow {
                visible: false,
                ..foreground(7)
            },
            FocusWindow {
                minimized: true,
                ..foreground(7)
            },
        ] {
            let mut policy = StartupFocusRepair::default();
            assert!(policy.request(unavailable, true).is_none());
            let request = policy.request(foreground(7), false).unwrap();
            assert!(policy.can_apply(request, foreground(7)));
        }
    }

    #[test]
    fn losing_foreground_or_visibility_before_execution_preserves_pending_readiness() {
        for unavailable in [
            FocusWindow {
                foreground: false,
                ..foreground(7)
            },
            FocusWindow {
                visible: false,
                ..foreground(7)
            },
            FocusWindow {
                minimized: true,
                ..foreground(7)
            },
        ] {
            let mut policy = StartupFocusRepair::default();
            let request = policy.request(foreground(7), true).unwrap();
            assert!(!policy.can_apply(request, unavailable));
            policy.finish(request, false);
            assert!(policy.request(unavailable, false).is_none());
            assert!(policy.request(foreground(7), false).is_some());
        }
    }

    #[test]
    fn late_old_window_callback_cannot_clear_replacement_request() {
        let mut policy = StartupFocusRepair::default();
        let old_request = policy.request(foreground(7), true).unwrap();
        assert!(!policy.can_apply(old_request, foreground(8)));
        assert!(policy.request(foreground(8), false).is_none());
        let new_request = policy.request(foreground(8), true).unwrap();
        policy.finish(old_request, true);
        assert!(policy.can_apply(new_request, foreground(8)));
        assert!(policy.request(foreground(8), true).is_none());
    }

    #[test]
    fn rebuilt_window_reusing_same_handle_requires_new_readiness() {
        let mut policy = StartupFocusRepair::default();
        let old_request = policy.request(foreground(7), true).unwrap();
        policy.invalidate();
        assert!(!policy.can_apply(old_request, foreground(7)));
        assert!(policy.request(foreground(7), false).is_none());
        let new_request = policy.request(foreground(7), true).unwrap();
        assert_ne!(old_request, new_request);
        policy.finish(old_request, false);
        assert!(policy.can_apply(new_request, foreground(7)));
    }

    #[test]
    fn dispatch_or_native_failure_can_retry_without_reporting_success() {
        let mut policy = StartupFocusRepair::default();
        let first = policy.request(foreground(7), true).unwrap();
        policy.finish(first, false);
        let retry = policy.request(foreground(7), false).unwrap();
        assert_ne!(first, retry);
        policy.finish(first, true);
        assert!(policy.can_apply(retry, foreground(7)));
        policy.finish(retry, true);
        assert!(policy.request(foreground(7), true).is_none());
    }

    #[test]
    fn stopped_or_recovering_windows_never_receive_focus() {
        for unavailable in [
            FocusWindow {
                stopped: true,
                ..foreground(7)
            },
            FocusWindow {
                recovering: true,
                ..foreground(7)
            },
            foreground(0),
        ] {
            let mut policy = StartupFocusRepair::default();
            assert!(policy.request(unavailable, true).is_none());
            let request = policy.request(foreground(7), true).unwrap();
            assert!(!policy.can_apply(request, unavailable));
        }
    }

    #[test]
    fn readiness_during_recovery_is_deferred_until_recovery_finishes() {
        let mut policy = StartupFocusRepair::default();
        let recovering = FocusWindow {
            recovering: true,
            ..foreground(7)
        };
        assert!(policy.request(recovering, true).is_none());
        assert!(policy.request(recovering, false).is_none());
        let request = policy.request(foreground(7), false).unwrap();
        assert!(policy.can_apply(request, foreground(7)));
    }
}
