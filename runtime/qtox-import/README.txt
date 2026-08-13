Kaigen qTox history import runtime (Windows x64)

These DLLs are copied unchanged from an official qTox Windows x64 build and
are loaded only while importing a qTox SQLCipher history database.

Components:
- libsqlcipher-0.dll: SQLCipher / SQLite (BSD-style license)
- libcrypto-3-x64.dll, libssl-3-x64.dll: OpenSSL 3 (Apache-2.0)
- libgcc_s_seh-1.dll, libstdc++-6.dll, libwinpthread-1.dll:
  GCC/MinGW runtime libraries and runtime exceptions

Sources:
https://github.com/qTox/qTox
https://github.com/sqlcipher/sqlcipher
https://www.openssl.org/source/license.html
https://www.mingw-w64.org/

Exact SHA-256 values are enforced by scripts/prepare-dependencies.ps1.
