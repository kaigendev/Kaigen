# Current full verification

This catalog belongs to the exact current KaigenToxClient working tree. It is independent of the immutable v0.2.9 / release-0297 selectors. Historical catalogs, source pins, receipts and identity guards remain unchanged.

Run the executable selector with a supported target:

    npm run test:full-current -- plan --platform windows --changed src/types.ts --output <fresh-plan.json>
    npm run test:full-current -- run --plan <plan.json> --plan-sha256 <SHA256> --evidence-root <fresh-directory> --bindings <private-bindings.json>

Targets: windows, debian, macos, web. The mode always selects the complete current applicable set. Unknown input, new source module and shared-contract input retain that broad fallback. A new registered npm leaf enters automatically; aliases deduplicate identical commands. Nested suites bind their real parent invocation. Unregistered test files, reason-only registrations, new Cargo manifests/targets and unsupported new features fail closed. Supported feature variants are explicit; arbitrary all-features combinations are not inferred. The nine-line desktop main target has an exact source-hash exemption; any change reopens applicability.

Cargo discovery uses locked offline metadata. Full library/binary tests run without a name filter. Discovery and execution counts are checked; an unknown ignored test cannot silently skip. Existing scale tests have named Windows monitored jobs and corresponding native ignored routes for other supported targets. Supported variants own their applicable ignored tests. Their actual platform execution is distinct from selector conformance.

Each selected route is required. Every route has an executable program/argument array and an applicability/proof type. Release-only orchestration and laboratory service control retain explicit exclusions; local product contracts, native compatibility/import tests and applicable runtime drivers remain selected. Exclusions do not turn a missing selected runtime prerequisite into a pass. In particular, pq-two-instances:contract runs --self-test; pq-two-instances:runtime requires the exact portable directory and a fresh canonical disposable run root, and never receives --self-test.

browser:engines:runtime is the actual Firefox/WebKit/Chromium Windows-hosted Web route, with pinned installed Playwright, its complete browser cache, offline-built webd, OpenSSL and Chromium executable bindings. It creates only a disposable HTTPS edge/backend/browser context and removes its isolated workspace storage. Worker/CryptoKey/auth reload/clipboard/OPFS recovery and backend teardown are runtime checks. Its retained outgoing browser copy does not establish Tox peer receipt or native macOS Safari acceptance. The driver acquires no components and cannot replace missing prerequisites with source-contract checks.

Bindings stay local. Each key in the plan's selected requires objects maps to {kind,value,sha256}. File SHA is the raw file hash. Directory SHA is SHA-256 of JSON.stringify(sorted recursive entries {path,sha256,bytes}, null, 2) plus newline. Directories refuse symlinks and profile/data/download/history/message/secret material; artifact-root must be a fresh program-only build. Canonical dist and dist-web bindings cannot point elsewhere. Value bindings are nonempty CLI values; output bindings point to absent absolute paths. Drivers retain their stricter existing canonical run-root and receipt checks. Missing/mismatched bindings return BLOCKED before any child, including contract selftests.

Run recomputes the complete plan, checks raw plan/catalog/producer/current source identities, preserves child commands/tool hashes/raw output/counts, propagates failures and stops subsequent required routes. Final PASS requires all selected routes and rechecks immutable prerequisite files/directories, native exe bytes and public source. A receipt reports discovered/selected/executed/excluded/blocked separately. Native receipts bind the Cargo test exe, features and counts; this runner does not observe loaded DLLs or establish prepared native runtime closure. Exact artifact/native finish has its own evidence.

    npm run test:current-verification-contract

This executes disposable Node/Rust fixtures, late suites/modules/features, real child failure, empty execution, artifact/source mutation and missing runtime prerequisite negatives. It also prepares all four current-owner plans. It does not launch actual Kaigen clients, execute the product full baseline, install MSI, contact production or obtain managed components. Raw conformance evidence may be retained using --evidence-root <fresh-directory>.

