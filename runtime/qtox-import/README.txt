Kaigen qTox history import runtime (Windows x64)

The distributed runtime is one reproducibly built MSVC x64 DLL used only while
reading a qTox SQLCipher history database:

- libsqlcipher-0.dll: SQLCipher 4.17.0 / SQLite 3.53.3
  (runtime version string: SQLCipher 4.17.0 community)
- crypto provider: OpenSSL 3.5.7, linked statically with the static MSVC CRT
- SHA-256: CD045C07BF315B192ED98FCB655D08F9E8FB6D936456F52EBFC213DD219AF703
- size: 4,996,096 bytes

Two fresh SQLCipher source extractions produced byte-identical DLL and import
library outputs with /Brepro. The DLL has 307 named exports, including all 12
sqlite3 functions loaded by Kaigen. dumpbin /DEPENDENTS lists only CRYPT32,
WS2_32, ADVAPI32, USER32, and KERNEL32. No OpenSSL, MinGW, or Visual C++ runtime
DLL is required or distributed.

Official inputs:

- SQLCipher v4.17.0 tag, commit 810db22f575ee7cf94ea96a3e91622b5fcece3dc
  https://github.com/sqlcipher/sqlcipher/releases/tag/v4.17.0
  source archive SHA-256:
  79C0E164B9C059E7487BF8F29272F601CCA5F3312CC267461F81E349962A5058
- OpenSSL 3.5.7
  https://github.com/openssl/openssl/releases/tag/openssl-3.5.7
  official source archive SHA-256:
  A8C0D28A529CA480F9F36CF5792E2CD21984552A3C8E4AA11A24AA31AEAC98E8

Build configuration: OpenSSL VC-WIN64A no-shared no-module no-tests no-asm;
SQLCipher SQLITE_HAS_CODEC, SQLITE_TEMP_STORE=2, SQLCIPHER_CRYPTO_OPENSSL,
USE_CRT_DLL=0, SYMBOLS=0; both linked with /Brepro /OPT:REF /OPT:ICF and
/INCREMENTAL:NO.

A disposable encrypted qTox-schema smoke test passed the three cipher fallback
formats used by Kaigen, rejected a wrong key, and executed the exact production
history SELECT. No private profile was used. A real qTox fixture remains a
separate native gate and requires an explicitly supplied disposable fixture.

Licenses:

- SQLCipher / SQLite: BSD-style / public-domain components; see upstream.
- OpenSSL: Apache License 2.0.

The exact distributed SHA-256 is enforced by
scripts/prepare-dependencies.ps1.
