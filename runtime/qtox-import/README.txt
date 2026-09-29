Kaigen qTox history import runtime (Windows x64)

The distributed runtime is one reproducibly built MSVC x64 DLL used only while
reading a qTox SQLCipher history database:

- libsqlcipher-0.dll: SQLCipher 4.19.0 / SQLite 3.53.4
  (runtime version string: SQLCipher 4.19.0 community)
- crypto provider: OpenSSL 3.5.8 LTS, linked statically with the static MSVC CRT
- SHA-256: 4C5B3A4433C8882040050E77260E4D0CF4971916B7160E1DAE0DA2B078F3C4B6
- size: 4,996,608 bytes

Two independent clean fixed-path runs, each using two fresh SQLCipher source
extractions, produced byte-identical DLL and import-library outputs with
/Brepro and deterministic MSVC path mapping. The DLL has 307 named exports,
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
- OpenSSL 3.5.8 LTS
  https://github.com/openssl/openssl/releases/tag/openssl-3.5.8
  official source archive SHA-256:
  A8F84A39918EC6415CE765D9B429D313BA97B8143169C172E734B9514464F5B2
  official source archive size: 53,213,818 bytes
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
