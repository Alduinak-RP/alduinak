# CMake Workflow

## Alduinak note (2026-07-28): building the C++ locally

The server manager's Build tab has a **Native (C++)** button that runs this whole
flow for you (`server-manager/src/build.js` -> `buildNative`), or `build native`
in the manager console. It uses the same flags as the flatrim CI workflow.

Prerequisite on this box: VS 2022 Community is installed on X: but **without** the
C++ workload, so nothing can compile yet. Add it, elevated:

```
"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vs_installer.exe" modify ^
  --productId Microsoft.VisualStudio.Product.Community ^
  --channelId VisualStudio.17.Release ^
  --add Microsoft.VisualStudio.Workload.NativeDesktop --includeRecommended --passive --norestart
```

That brings MSVC v143, the Windows SDK and CMake. The first native build then
compiles every vcpkg dependency (expect 1-3 hours and tens of GB); later builds
are incremental. The `CI Rebuild` button remains the alternative.

**Two flags in the circulating "SkyMP Build Instructions" note are fictional:**
`-DSKYMP_VOICE_CHAT=ON` is read by nothing, and `-DVCPKG_MANIFEST_FEATURES=voice-chat`
**aborts** the configure (no such vcpkg feature). Do not pass either; voice chat is
already implemented in this fork (see docs/alduinak_voice_chat.md).

## Upstream documentation

Our build system is CMake-based. This document describes some caveats of our CMake code and guides you in making changes in CMake parts of the codebase.

When you switch between commits, you should run `cmake ..` in the `build` directory. This action is called "CMake re-generation".

On Windows the build requires the `Visual Studio 17 2022` generator (v143 toolset). CMake enforces this and errors out on older Visual Studio generators. CI runs on the `windows-2022` runner. A local configure looks like:

```
cmake .. -G "Visual Studio 17 2022" -A x64 -DSKYRIM_DIR="<your Skyrim install folder>"
```

Note: there is no `SKYMP_VOICE_CHAT` CMake option or `voice-chat` vcpkg feature in this tree. Do not pass `-DSKYMP_VOICE_CHAT=ON` (nothing reads it) or `-DVCPKG_MANIFEST_FEATURES=voice-chat` (vcpkg aborts with an unknown-feature error). See `alduinak_voice_chat.md`.

## Adding Source Files

* **Visual Studio**: `Add -> New Item -> /a meaningful source directory, not the build directory/`. No need to re-generate project files.
* **VS Code**: Add file normally, then re-generate project files. CMake extension for VS Code normally re-generates each time you press Ctrl+S in root `CMakeLists.txt`.

## Modifying CMakeLists

* When the content of CMakeLists has changed, you need to re-generate CMake.

* Call `apply_default_settings` for all added targets:
  ```cmake
  apply_default_settings(TARGETS skyrim_platform)
  ```

* When you add a new C/C++ target, that requires dependencies from vcpkg, you do not need to link them manually `target_link_libraries`, but simply add such target to the `VCPKG_DEPENDENT` list:
  ```cmake
  list(APPEND VCPKG_DEPENDENT skyrim_platform)
  ```

* Usually project's CMakeLists.txt has something like this:
  ```cmake
  foreach(target ${VCPKG_DEPENDENT})
    # link everything
  endforeach()
  ```

## CMake Errors

When generating project files with CMake, errors are dumped into the console. If generation fails, then you see these lines in your terminal:
```
- Configuring incomplete, errors occured
```

It is necessary to look above and find `CMake Error at...`. There would be a path and a line number. By the way, VS Code is able to highlight this.

## Troubleshooting

```
 CMake Error at vcpkg/scripts/buildsystems/vcpkg.cmake:857 (_find_package):
   Could not find a configuration file for package "directxtk" that is
   compatible with requested version "".
```
This error has been reported by VS Code user. Solution:
1. It seems that `amd64_x86` kit is selected. SkyMP doesn't support `x86` builds currently. Change the active kit to `amd64`.
   ![image](https://user-images.githubusercontent.com/37947786/125172169-cb8e4080-e1c0-11eb-8e72-b16b47908e39.png)
   ![image](https://user-images.githubusercontent.com/37947786/125172181-df39a700-e1c0-11eb-9d75-d576cf563c22.png)
2. Remove `build/CMakeCache.txt` and `build/CMakeFiles`
3. Re-generate project files.
