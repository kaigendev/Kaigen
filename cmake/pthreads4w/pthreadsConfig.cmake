if(NOT DEFINED PTHREADS4W_ROOT)
  message(FATAL_ERROR "PTHREADS4W_ROOT must point to the pinned pthreads4w source directory")
endif()

set(_pthreads4w_library "${PTHREADS4W_ROOT}/pthreadVC3.lib")
set(_pthreads4w_runtime "${PTHREADS4W_ROOT}/pthreadVC3.dll")
set(_pthreads4w_header "${PTHREADS4W_ROOT}/pthread.h")
if(NOT EXISTS "${_pthreads4w_library}" OR NOT EXISTS "${_pthreads4w_runtime}" OR NOT EXISTS "${_pthreads4w_header}")
  message(FATAL_ERROR "The portable app-local pthreads4w build is incomplete below ${PTHREADS4W_ROOT}")
endif()

if(NOT TARGET PThreads4W::PThreads4W)
  add_library(PThreads4W::PThreads4W SHARED IMPORTED)
  set_target_properties(PThreads4W::PThreads4W PROPERTIES
    IMPORTED_IMPLIB "${_pthreads4w_library}"
    IMPORTED_LOCATION "${_pthreads4w_runtime}"
    INTERFACE_INCLUDE_DIRECTORIES "${PTHREADS4W_ROOT}"
  )
endif()

set(pthreads_FOUND TRUE)
