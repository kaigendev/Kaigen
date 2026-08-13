get_filename_component(LIBSODIUM_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../work/deps/libsodium/libsodium" ABSOLUTE)

if(NOT TARGET libsodium::libsodium)
  # The application is portable-only: keep both toxcore and libsodium on the
  # static MSVC runtime so client PCs never need a VC Redistributable install.
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded" CACHE STRING "" FORCE)
  add_library(libsodium::libsodium STATIC IMPORTED)
  set_target_properties(libsodium::libsodium PROPERTIES
    IMPORTED_LOCATION "${LIBSODIUM_ROOT}/x64/Release/v143/static/libsodium.lib"
    INTERFACE_COMPILE_DEFINITIONS "SODIUM_STATIC=1"
    INTERFACE_INCLUDE_DIRECTORIES "${LIBSODIUM_ROOT}/include"
  )
endif()
