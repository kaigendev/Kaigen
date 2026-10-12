# Focused compact-interface regression tests

These entrypoints run independently of `test:frontend`. UI runners use real React components with disposable synthetic platforms; they do not access personal profiles or send network messages. Use an already installed Chromium and Playwright module. No browser download is performed.

Run from the source root, passing absolute local paths and a new evidence directory for each run:

```sh
npm run test:compact-interface:runtime -- --playwright-module /path/to/playwright/index.mjs --chromium-executable /path/to/chromium --evidence-root /path/to/new/compact-evidence
npm run test:web-service-panel:runtime -- --playwright-module /path/to/playwright/index.mjs --chromium-executable /path/to/chromium --evidence-root /path/to/new/web-panel-evidence
npm run test:web-service-panel:app-runtime -- --playwright-module /path/to/playwright/index.mjs --chromium-executable /path/to/chromium --evidence-root /path/to/new/web-app-evidence
```

The compact runner covers profile data switching, Settings navigation origins, Save/composer geometry, repeated tooltips, contact/message context menus, nested actions, keyboard navigation and simulated touch long press. The Web panel runner covers narrow and short viewports, the service handle, panel focus/scroll/dismissal and retry after a creation error in the same document. Its small application stub isolates the Web shell. The app-runtime runner embeds the actual RootApp with the current Web layout capabilities and a synthetic backend; it checks the handle and real composer controls at 320×401 and 390×844, draft preservation and geometry restoration after closing the panel.

For entropy input and capability controls, set `KAIGEN_UI_TEST_BROWSER` to an installed Chrome/Edge/Chromium executable, then run:

```sh
npm run test:pq-entropy:compact
```

This subset requires the mode-specific controls and entropy field before checking geometry and hit testing. Mouse/touch simulation exercises the actual pointer handlers and the collection time window. Synthetic UI callbacks do not prove a cryptographic exchange. The focused native companion test uses locked, offline dependencies and the current prepared native inputs:

```sh
cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib pq::v2::tests::active_history_role_survives_restart_for_both_peers -- --exact --nocapture
```

On the machine holding the actual prepared Web cache, run the read-only cache identity check against the corresponding producer JSONL receipt:

```sh
npm run test:web-current-cache -- --input-root /path/to/verified/archive-cache --cache-root /path/to/prepared-native-cache --receipt /path/to/producer-cache-receipts.jsonl
```

It derives the component pins from `src/componentVersions.ts`, hashes the actual archives, checks the current preparation recipe, requires non-revoked cache hits, and validates the contract, manifest, required outputs, all output bytes and the libsodium dependency consumed by toxcore. It does not fetch, rebuild or select a fixed libtoxcore version label. To verify a particular build, independently match this receipt's cache fingerprints/output identities to that build's immutable producer record.

Browser geometry and simulated touch results do not establish native Windows window behavior or physical touchscreen behavior. Keep those observations separate from these test results.
