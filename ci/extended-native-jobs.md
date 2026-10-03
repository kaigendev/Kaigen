# Extended native verification

The ordinary PQ gate runs every current feature-only test (nine) in both desktop and web-core. It is a separate PR/push job, not a substitute for handshake/crash/replay coverage. The three ignored tests run only through named scale jobs and manual CI opt-in.

From the source root, with already prepared pinned native inputs:

- npm run test:pq-faults -- --evidence-root <fresh-local-output>
- npm run test:native-scale -- --evidence-root <fresh-local-output>
- node scripts/extended-native-verification.mjs --job <catalog-job-id> --evidence-root <fresh-local-output>

Compilation is locked/offline and has a 1200-second timeout. Missing prepared components fail; the runner never downloads them. CI prepares components through the existing dedicated component workflow and uses PowerShell 7.6.5.

Each job obtains its exact test executable from Cargo JSON, discovers all and ignored tests separately, verifies the selected names/count/ignored mode, and executes only those exact tests single-threaded. Zero tests, missing/extra selected tests, skips, wrong terminal statuses, failed processes and exceeded budgets fail the job. Result JSON distinguishes total discovery, selected execution, excluded tests and ignored inventory. Failure logs and observed counts are retained.

Runtime budgets are in extended-native-jobs.json. The monitor enforces elapsed time and OS peak working set. Fixture bytes are sampled every 500 ms; this is a measured sample maximum, not a filesystem quota. Partial scans are recorded. The native tests also assert their fixed input sizes, bounded windows or canonical usage. Compilation memory is not included in runtime measurements.

Evidence uses disposable TEMP/TMP trees. The qTox output override and fault-injection environment overrides are removed. Successful native tests remove their synthetic fixtures. Only result/process/resource logs are uploaded in CI; profile fixtures and synthetic passwords are excluded.

The result binds Rust/native source inputs, Cargo test artifact features/profile, exact executable hash, selected toolchain metadata, effective compiler override flags, raw output digests and actually observed native DLL paths/hashes. The current runner executes the recorded Cargo executable. Pre-repair receipts that invoked cargo through PATH must be described as such.

verify-extended-native-output.mjs can validate a preserved execution after a reviewed output-parser repair. It checks the original producer snapshot, current unchanged Rust/native inputs, exact artifact, discovery, command, resources, DLLs and raw test counts. An optional original catalog snapshot is allowed only when the selected job descriptor is identical. It writes a new reanalysis result and never reruns native tests or rewrites the original receipt.
