Kaigen qTox history import runtime (Windows x64)

The distributed runtime is one reproducibly built MSVC x64 DLL used only while
reading a qTox SQLCipher history database:

- libsqlcipher-0.dll: SQLCipher 4.19.0 / SQLite 3.54.0
  (runtime version string: SQLCipher 4.19.0 community)
- crypto provider: OpenSSL 4.0.3, linked statically with the static MSVC CRT
- SHA-256: 91D26CAB5D2B43D39CB5BD53A865B7FBD7EC4D051A57239B06703C2C433A5D51
- size: 4,882,944 bytes

This is a custom Kaigen full-source SQLite 3.54.0 port onto SQLCipher 4.19.0,
not an upstream SQLCipher release with this SQLite version. The source patch
is patches/sqlcipher/sqlite-3.54.0.patch; its manifest is
patches/sqlcipher/manifest.json. The amalgamation is generated from the
ported source tree; an upstream amalgamation is not substituted.

The current fixed-path offline rebuild used one OpenSSL compilation and two
fresh SQLCipher source extractions with the Kaigen full-source port applied.
These produced byte-identical DLL and
import-library outputs with
/Brepro and deterministic MSVC path mapping. The DLL has 308 named exports,
including all 12 sqlite3 functions loaded by Kaigen. dumpbin /DEPENDENTS lists
only CRYPT32, WS2_32, ADVAPI32, USER32, and KERNEL32. No OpenSSL, MinGW, or
Visual C++ runtime DLL is required or distributed. Byte scans found no build
host profile, project, temporary-directory, or component-update path.

Official inputs:

- SQLCipher v4.19.0 tag, commit c4b275a47932888216bade83aff2bbc73df0ff85
  https://github.com/sqlcipher/sqlcipher/releases/tag/v4.19.0
  source archive SHA-256:
  7075F96CBABE45B4ECFC2E6B1745A625F856F695B0827A5506CE9ED85B906AA0
  source archive size: 19,356,184 bytes
- SQLite 3.54.0 full source
  https://www.sqlite.org/2026/sqlite-src-3540000.zip
  source archive SHA-256:
  8847659821E0C5116BD14A94644C82BA932B2D9A05AC81AF2E34AF814AAD7C58
  source archive size: 14,881,448 bytes
- OpenSSL 4.0.3
  https://github.com/openssl/openssl/releases/tag/openssl-4.0.3
  official source archive SHA-256:
  325B5C806167C13B40B1FFEADFE0248197C00ECCC4CF123EC1E28D2D2FD216D9
  official source archive size: 55,235,667 bytes
- Strawberry Perl 5.42.3.1 portable, build-only and not distributed
  https://github.com/StrawberryPerl/Perl-Dist-Strawberry/releases/tag/SP_54231_64bit
  archive SHA-256:
  6A081A811781C30ACA51DBC036AFD93092AF91E3297901F02C17043795A10690
  archive size: 304,765,269 bytes

Build configuration: OpenSSL VC-WIN64A no-shared no-module no-tests no-asm;
SQLCipher SQLITE_HAS_CODEC, SQLITE_TEMP_STORE=2,
SQLITE_EXTRA_INIT=sqlcipher_extra_init,
SQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown, SQLCIPHER_CRYPTO_OPENSSL,
USE_CRT_DLL=0, SYMBOLS=0; both linked with /Brepro /OPT:REF /OPT:ICF and
/INCREMENTAL:NO. MSVC /experimental:deterministic and /pathmap are supplied
through the CL environment so OpenSSL build information remains host-neutral.

The baseline SQLCipher 4.19.0 / SQLite 3.53.4 DLL produced three synthetic
codec fixtures: qtox-sha1-4096, qtox-v3-sha1-1024, and qtox-v4-sha512. The
SQLite 3.54.0 candidate DLL read these same files, passed keyed SQLite health,
rejected a wrong key, and executed the exact production qTox history SELECT.
Fixture hashes remained unchanged. No real qTox profile was used or verified.

provenance.json records the source/patch/tree/recipe hashes, effective flags,
DLL and import-library identities, exports, and synthetic compatibility proof.

Licenses:

- SQLCipher / SQLite: BSD-style / public-domain components; see upstream.
- OpenSSL: Apache License 2.0.

The exact distributed SHA-256 is enforced by
scripts/prepare-dependencies.ps1.
