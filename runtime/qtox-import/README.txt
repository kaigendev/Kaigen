Kaigen qTox history import runtime (Windows x64)

The distributed runtime is one reproducibly built MSVC x64 DLL used only while
reading a qTox SQLCipher history database:

- libsqlcipher-0.dll: SQLCipher 4.18.0 / SQLite 3.53.4
  (runtime version string: SQLCipher 4.18.0 community)
- crypto provider: OpenSSL 3.5.7, linked statically with the static MSVC CRT
- SHA-256: A69C768C63F8EF883419EB5B6C3CD41570A5D3F82650C6AC3E4A7F75BB4288D2
- size: 4,992,000 bytes

Two independent clean fixed-path runs, each using two fresh SQLCipher source
extractions, produced byte-identical DLL and import-library outputs with
/Brepro and deterministic MSVC path mapping. The DLL has 307 named exports,
including all 12 sqlite3 functions loaded by Kaigen. dumpbin /DEPENDENTS lists
only CRYPT32, WS2_32, ADVAPI32, USER32, and KERNEL32. No OpenSSL, MinGW, or
Visual C++ runtime DLL is required or distributed. Byte scans found no build
host profile, project, temporary-directory, or component-update path.

Official inputs:

- SQLCipher v4.18.0 tag, commit 63697beb0fafcb61faa7a3e6fd267036548ab11b
  https://github.com/sqlcipher/sqlcipher/releases/tag/v4.18.0
  source archive SHA-256:
  1DF02D1B346FA27FEAF2DA2CB2C0D8209E788248E461EC288718AA5D3E9643E5
  source archive size: 19,351,009 bytes
- OpenSSL 3.5.7
  https://github.com/openssl/openssl/releases/tag/openssl-3.5.7
  official source archive SHA-256:
  A8C0D28A529CA480F9F36CF5792E2CD21984552A3C8E4AA11A24AA31AEAC98E8
  official source archive size: 53,153,930 bytes
- Strawberry Perl 5.42.3.1 portable, build-only and not distributed
  https://github.com/StrawberryPerl/Perl-Dist-Strawberry/releases/tag/SP_54231_64bit
  archive SHA-256:
  6A081A811781C30ACA51DBC036AFD93092AF91E3297901F02C17043795A10690
  archive size: 304,765,269 bytes

Build configuration: OpenSSL VC-WIN64A no-shared no-module no-tests no-asm;
SQLCipher SQLITE_HAS_CODEC, SQLITE_TEMP_STORE=2, SQLCIPHER_CRYPTO_OPENSSL,
USE_CRT_DLL=0, SYMBOLS=0; both linked with /Brepro /OPT:REF /OPT:ICF and
/INCREMENTAL:NO. MSVC /experimental:deterministic and /pathmap are supplied
through the CL environment so OpenSSL build information remains host-neutral.

A disposable encrypted qTox-schema smoke test passed the three cipher fallback
formats used by Kaigen, rejected a wrong key, and executed the exact production
history SELECT. No private profile was used. A real qTox fixture remains a
separate native gate and requires an explicitly supplied disposable fixture.

Licenses:

- SQLCipher / SQLite: BSD-style / public-domain components; see upstream.
- OpenSSL: Apache License 2.0.

The exact distributed SHA-256 is enforced by
scripts/prepare-dependencies.ps1.
