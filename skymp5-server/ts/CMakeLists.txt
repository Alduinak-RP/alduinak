include(${CMAKE_SOURCE_DIR}/cmake/yarn.cmake)

file(GLOB_RECURSE sources ${CMAKE_CURRENT_LIST_DIR}/*.ts)

set(out
  ${SKYMP_DIST_SERVER_DIR}/dist_back/skymp5-server.js
)

# The package.json build-ts script bundles into build/dist/server, so its two steps run here with the selected dir
set(esbuild_args ts/index.ts --loader:.node=copy --bundle --platform=node --target=node16 --keep-names --minify --sourcemap --target=es2022 "\"--outfile=${out}\"")

if(WIN32)
  add_custom_command(
    OUTPUT ${out}
    COMMAND yarn --cwd "\"${SKYMP5_SERVER_SOURCE_DIR}\"" tsc --noEmit
    COMMAND yarn --cwd "\"${SKYMP5_SERVER_SOURCE_DIR}\"" esbuild ${esbuild_args}
    DEPENDS ${sources}
  )
else()
  add_custom_command(
    OUTPUT ${out}
    COMMAND yarn
    COMMAND yarn tsc --noEmit
    COMMAND yarn esbuild ${esbuild_args}
    WORKING_DIRECTORY ${SKYMP5_SERVER_SOURCE_DIR}
    DEPENDS ${sources}
  )
endif()

add_custom_target(skymp5-server-ts ALL
  DEPENDS ${out}
  SOURCES ${sources}
)
