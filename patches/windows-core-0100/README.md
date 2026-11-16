# Windows core 0.100 compatibility inputs

Run `node scripts/prepare-windows-core.mjs` before Cargo. The standard build entry points do this automatically. Preparation verifies source-owned crate archives, applies only the exact preimage/postimage transformations in manifest.json, verifies every resulting package tree, and materializes sources under local-data/windows-core-0100. It performs no download or compilation and does not modify the global Cargo registry. Existing materialized packages must match the pinned trees; failures are preserved rather than silently repaired.

Published windows 0.62.2 generated bindings retain their metadata and native API surface. Core/support 0.100.0 sources remain unmodified. Compatibility changes move internal traits, preserve the original Free/Owned resource handling in the windows facade, use alloc::boxed::Box, retain the former HRESULT conversion formulas, and use BSTR.display(). The original 0.62.2 core archive is retained solely as the licensed provenance of handles.rs; it is not a dependency.

Versions, upstream URLs, licenses, archive hashes, exact patch preimages/postimages and complete output tree hashes are in manifest.json. The original packages retain their upstream MIT/Apache-2.0 license files. No new generator, SDK, minimum Windows version, or Rust toolchain is introduced.

WebView2 0.39.1 uses the same core 0.100.0 types. Its callback wrapper changes Ref to InRef while preserving cloned owned callback arguments; the PWSTR helpers and callback macros 0.8.1 are unchanged.

The remaining consumer closure retains tao 0.37.1, wry 0.57.0 and tauri-winrt-notification 0.8.1. tao/wry require core 0.100.0; tao uses the retained windows::core::Owned facade. Toast callbacks explicitly retain their event types and clone borrowed InRef arguments for the existing Option-based helpers. HSTRING uses its display adapter. Tauri, its runtime, notify-rust and opener versions remain unchanged.

The same materializer prepares the pinned embed-resource 3.0.12 and tauri-plugin-fs 2.7.1 diagnostics fixes. Embed-resource uses the supported cc iterator to read INCLUDE. The filesystem plugin retains the permission name for its debug diagnostic.

The Desktop manifest also points to the build sources of vswhom-sys 0.1.3 under `vendor/vswhom-sys-0.1.3`. Those files came from the registry archive with SHA-256 `fb067e4cbd1ff067d1df46c9194b5de0e98efd2810bbc95c5d5e5f25a3231150`. The MIT license is retained. The patch keeps path lengths in `size_t`, uses character counts for wide buffers and avoids shadowing COM and registry status variables.
