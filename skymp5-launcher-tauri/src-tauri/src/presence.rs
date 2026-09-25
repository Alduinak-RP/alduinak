// Discord Rich Presence while the game runs and the setting is on
use crate::{active_server, log, net, server_query, store};
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

const DISCORD_APP_ID: &str = "1525331715613261934";
const PARTY_MAX: i64 = 1200;
const WEBSITE: &str = "https://alduinak.com/";

static ACTIVE: AtomicBool = AtomicBool::new(false);
static GAME_RUNNING: AtomicBool = AtomicBool::new(false);
static CLIENT: Mutex<Option<DiscordIpcClient>> = Mutex::new(None);

pub fn set_running(running: bool) {
    GAME_RUNNING.store(running, Ordering::SeqCst);
    let want = running && store().bool("discordPresence");
    if want && !ACTIVE.swap(true, Ordering::SeqCst) {
        tauri::async_runtime::spawn(run());
    } else if !want {
        ACTIVE.store(false, Ordering::SeqCst);
    }
}

// Re-applies the toggle after the setting changes
pub fn refresh() {
    set_running(GAME_RUNNING.load(Ordering::SeqCst));
}

async fn update(start: i64) {
    let status = net::fetch_json(&format!("{}/api/status{}", net::api_url(), server_query()), &[]).await.ok();
    let players = status.as_ref().filter(|s| s["status"] == "online").and_then(|s| s["players"].as_i64());
    let max = active_server().and_then(|s| s["maxPlayers"].as_i64()).unwrap_or(PARTY_MAX);
    let state = match players { Some(p) => format!("{p}/{max} players online"), None => "server offline".into() };
    let mut act = activity::Activity::new()
        .details("Playing Alduinak")
        .state(&state)
        .timestamps(activity::Timestamps::new().start(start))
        .assets(activity::Assets::new().large_image("alduinak").large_text("Alduinak RP").small_image("alduinaklogoofficial").small_text("SkyMP"))
        .buttons(vec![activity::Button::new("Website", WEBSITE)]);
    // Discord refuses a party of fewer than one; the state line already says 0
    let party;
    if let Some(p) = players.filter(|p| *p > 0) {
        party = activity::Party::new().id("alduinak").size([p.min(max) as i32, max as i32]);
        act = act.party(party);
    }
    let mut guard = CLIENT.lock().unwrap();
    if guard.is_none() {
        if let Ok(mut c) = DiscordIpcClient::new(DISCORD_APP_ID) {
            if c.connect().is_ok() { *guard = Some(c); }
        }
    }
    if let Some(c) = guard.as_mut() {
        if c.set_activity(act).is_err() { *guard = None; }
    }
}

async fn run() {
    let start = crate::proc::now_ms() as i64 / 1000;
    log("[presence] started");
    while ACTIVE.load(Ordering::SeqCst) {
        update(start).await;
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
    if let Some(mut c) = CLIENT.lock().unwrap().take() { let _ = c.clear_activity(); let _ = c.close(); }
    log("[presence] stopped");
}
