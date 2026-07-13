
# Build & Test Tips

All commands below must be run **inside the build directory**  
(e.g., `mkdir build && cd build && cmake ..`).

## Build
```bash
cmake --build .
````

This compiles the project

## Test

```bash
ctest --verbose
```

Runs all tests with detailed output.

## Test Partuicular Unit Test

This example runs tests with only [Respawn] tag. Tags you can see in test files (.cpp).
If you see more than 1 unit test failed, please select one to work on and iterate with the following command.
```bash
cd build
./unit/unit [Respawn]
```
## Rules 

1) Warn me if I need to run any workflows to rebuild dist files after a patch. 

2) Keep code comments concise and on one line. Don't use the em dash —

3) Don't reinvent the wheel. See if a repo already has code to complete a task before making new functions from scratch.

4) If editing files that are gitignored (such as .env files, gamemode.js, or serversettings.json), make a note of it so I can manually update them on the server
