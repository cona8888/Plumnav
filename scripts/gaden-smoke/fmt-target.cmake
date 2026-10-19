# Project-local CMake compatibility shim. No gas physics or upstream sources change.
find_package(fmt REQUIRED)
if(NOT TARGET fmt)
  add_library(fmt ALIAS fmt::fmt)
endif()
