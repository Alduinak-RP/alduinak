// No console window next to the launcher in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    alduinak_launcher_lib::run()
}
