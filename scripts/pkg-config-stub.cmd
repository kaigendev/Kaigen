@echo off
rem c-toxcore's CMake requires a pkg-config executable even on MSVC, where
rem libsodium is resolved through a native CMake config and toxav/bootstrapd
rem are disabled. Report a version, then report optional Unix packages absent.
if "%~1"=="--version" (
  echo 0.29.2
  exit /b 0
)
exit /b 1
