project(skymp5-client)

file(GLOB_RECURSE sources ${CMAKE_CURRENT_LIST_DIR}/src/*)

if(BUILD_CLIENT)
  include(${CMAKE_SOURCE_DIR}/cmake/yarn.cmake)

  yarn_execute_command(
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
    COMMAND install
  )

  set(out
    ${SKYMP_DIST_CLIENT_DIR}/Data/Platform/Plugins/skymp5-client.js
  )
  # cmake -E env cannot resolve the yarn shim on Windows, only yarn.cmd
  if(WIN32)
    set(yarn_exe yarn.cmd)
  else()
    set(yarn_exe yarn)
  endif()
  add_custom_command(
    OUTPUT ${out}
    COMMAND ${CMAKE_COMMAND} -E env "\"ALDUINAK_CLIENT_OUT=${SKYMP_DIST_CLIENT_DIR}/Data/Platform/Plugins\"" ${yarn_exe} --cwd "\"${CMAKE_CURRENT_LIST_DIR}\"" build
    DEPENDS ${sources}
  )
  add_custom_target(skymp5-client ALL
    DEPENDS ${out}
    SOURCES ${sources}
  )

  add_custom_command(
    TARGET skymp5-client POST_BUILD
    COMMAND ${CMAKE_COMMAND} -DCLIENT_SETTINGS_JSON_PATH=${SKYMP_DIST_CLIENT_DIR}/Data/Platform/Plugins/skymp5-client-settings.txt -DOFFLINE_MODE=${OFFLINE_MODE} -P ${CMAKE_SOURCE_DIR}/cmake/scripts/generate_client_settings.cmake
  )
else()
  add_custom_target(skymp5-client ALL
    SOURCES ${source}
    COMMAND ${CMAKE_COMMAND} -E echo "Building skymp5-client is disabled. To enable it, set BUILD_CLIENT to ON."
  )
endif()
