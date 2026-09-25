// Game process state: whether Skyrim or the SKSE loader runs, and the grace window after a launch
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
// MO2 can take a while to boot Skyrim, so a fresh launch counts as running until the game shows up or this runs out
pub const LAUNCH_GRACE_MS: u64 = 30_000;
pub static LAUNCH_STARTED_AT: AtomicU64 = AtomicU64::new(0);

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
