# SQLCipher 4.19.0 with SQLite 3.54.0

This is a Kaigen source port, not an upstream SQLCipher release. It retains the SQLCipher 4.19.0 codec and crypto providers while updating the complete SQLite source tree to 3.54.0. Replacing only `sqlite3.c` and `sqlite3.h` is not the build route.

`manifest.json` pins the original SQLCipher archive, the SQLite 3.54.0 full-source archive, the complete patch, every touched file before and after application, and both complete materialized trees. The patch changes 425 paths; its resulting tree contains 2322 files. The tree digest is SHA-256 of ordinally sorted UTF-8 lines `fileSha256<TAB>size<TAB>relativePosixPath<LF>`.

The three-way merge used the following official inputs:

| Input | SHA-256 |
|---|---|
| SQLCipher v4.19.0 | `7075f96cbabe45b4ecfc2e6b1745a625f856f695b0827a5506ce9ed85b906aa0` |
| SQLite 3.53.4 full source, merge base | `d18fa15aec74d8c17e1463f861095adc01b5ad190256acb4f91d22f0368d232b` |
| SQLite 3.54.0 full source, target | `8847659821e0c5116bd14a94644c82ba932b2d9a05ac81af2e34af814aad7c58` |

The target Fossil source ID is `be8d059e9a49089ab2dce5ed26dd87aaf598fdc5fbe0b107c0dd758464bcd5e3`. The patched tree has its own identity in the manifest and must not be described as unmodified SQLite or SQLCipher source.

The one textual conflict was in the CLI input/history path. The resolution keeps SQLite 3.54.0 prompt allocation and cleanup, and skips history insertion for the same SQLCipher key-command patterns. It avoids the former early return, which would bypass the new prompt cleanup. Codec/provider source files are unchanged from SQLCipher 4.19.0; their pager, WAL, backup, ATTACH and PRAGMA integration is retained in the full patch.

Build with PowerShell 7.6.5 through `scripts/rebuild-sqlcipher-runtime.ps1`, supplying the immutable component cache with `-ComponentCacheRoot`. The recipe verifies all source/patch identities, applies the patch with process-scoped Git line-ending settings, builds two independent SQLCipher trees, and requires identical DLL and import-library bytes. OpenSSL 4.0.3 and the MSVC runtime remain statically linked.

The cache must also contain the preserved compatibility producer `sqlcipher-runtime-4.19.0-sqlite-3.53.4-openssl-4.0.3-msvc-x64.dll`: 4,849,664 bytes, SHA-256 `c0e63e5cfd59b5de49798104056d1783b4bfcfbf6e8a365daf38986528182fb2`. It is not the installed candidate. The existing smoke uses this producer for the same three synthetic SQLCipher 3/4 and qTox-format fixtures with a public test key, then checks them with the candidate reader, including keyed database health and wrong-key rejection. Fixture bytes must remain unchanged. No private profile is used.

Build outputs and detailed receipts stay under `work/sqlcipher-rebuild/runs/<run-name>`. The installed runtime pin is updated only after reproducibility, exports, versions, dependencies and compatibility checks succeed. SQLCipher's BSD-style license and SQLite's public-domain terms remain applicable; OpenSSL uses Apache License 2.0.
