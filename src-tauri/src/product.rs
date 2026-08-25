use serde::{Deserialize, Serialize};

/// Product selection is explicit because Debian desktop and Debian web-server
/// share an operating system while requiring disjoint capabilities.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProductTarget {
    Desktop,
    WebServer,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityMatrix {
    pub tauri_windows: bool,
    pub browser_authorization: bool,
    pub workspace_supervisor: bool,
    pub server_installation: bool,
    pub streamed_browser_files: bool,
}

impl CapabilityMatrix {
    pub const fn for_target(target: ProductTarget) -> Self {
        match target {
            ProductTarget::Desktop => Self {
                tauri_windows: true,
                browser_authorization: false,
                workspace_supervisor: false,
                server_installation: false,
                streamed_browser_files: false,
            },
            ProductTarget::WebServer => Self {
                tauri_windows: false,
                browser_authorization: true,
                workspace_supervisor: true,
                server_installation: true,
                streamed_browser_files: true,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_capabilities_are_disjoint_at_the_adapter_boundary() {
        let desktop = CapabilityMatrix::for_target(ProductTarget::Desktop);
        let web = CapabilityMatrix::for_target(ProductTarget::WebServer);
        assert!(desktop.tauri_windows);
        assert!(!web.tauri_windows);
        assert!(!desktop.browser_authorization);
        assert!(web.browser_authorization);
        assert!(!desktop.server_installation);
        assert!(web.server_installation);
    }
}
