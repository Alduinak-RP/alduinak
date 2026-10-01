// Game process state: whether Skyrim or the SKSE loader runs, and the grace window after a launch
use crate::log;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
// MO2 can take a while to boot Skyrim, so a fresh launch counts as running until the game shows up or this runs out
pub const LAUNCH_GRACE_MS: u64 = 30_000;
pub static LAUNCH_STARTED_AT: AtomicU64 = AtomicU64::new(0);
const GAME_WINDOW_WAIT_MS: u64 = 120_000;
static WATCHING_GAME_WINDOW: AtomicBool = AtomicBool::new(false);

#[link(name = "user32")]
extern "system" {
    fn FindWindowW(class: *const u16, title: *const u16) -> isize;
    fn ClipCursor(rect: *const std::ffi::c_void) -> i32;
    fn GetCursorPos(point: *mut [i32; 2]) -> i32;
    fn SetCursorPos(x: i32, y: i32) -> i32;
}

fn game_window_open() -> bool {
    let class: Vec<u16> = "Skyrim Special Edition\0".encode_utf16().collect();
    unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) != 0 }
}

// A game that ends without destroying its window (crash, Engine Fixes' safe exit) leaves Display Tweaks' cursor clip on
fn release_cursor() {
    let mut pos = [0i32; 2];
    // Moving the cursor in place makes Windows show the cursor of the window now under it
    let (unclipped, moved) = unsafe { (ClipCursor(std::ptr::null()) != 0, GetCursorPos(&mut pos) != 0 && SetCursorPos(pos[0], pos[1]) != 0) };
    log(format!("[launch] game window closed: cursor clip released {unclipped}, cursor moved in place {moved}"));
}

// Polls the game window, which goes the moment the process ends, and frees the cursor then
pub fn watch_game_window() {
    if WATCHING_GAME_WINDOW.swap(true, Ordering::SeqCst) { return; }
    tauri::async_runtime::spawn(async {
        let started = now_ms();
        let mut seen = false;
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if game_window_open() { seen = true; }
            else if seen { release_cursor(); break; }
            else if now_ms().saturating_sub(started) > GAME_WINDOW_WAIT_MS { break; }
        }
        WATCHING_GAME_WINDOW.store(false, Ordering::SeqCst);
    });
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub async fn is_process_running(image: &str) -> bool {
    let out = tokio::process::Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {image}"), "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await;
    out.map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains(&image.to_lowercase())).unwrap_or(false)
}

pub async fn game_running() -> bool {
    let running = is_process_running("SkyrimSE.exe").await || is_process_running("skse64_loader.exe").await;
    if running { LAUNCH_STARTED_AT.store(0, Ordering::SeqCst); }
    running
}

pub fn launch_in_grace() -> bool {
    now_ms().saturating_sub(LAUNCH_STARTED_AT.load(Ordering::SeqCst)) < LAUNCH_GRACE_MS
}

pub async fn game_running_or_starting() -> bool {
    game_running().await || launch_in_grace()
}
