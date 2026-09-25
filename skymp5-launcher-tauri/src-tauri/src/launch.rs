// Play: the pre-launch gate, load order sync, the backend launch check, and starting the game
use crate::gamecopy::{self, PRELOADER_DLLS, VANILLA_MASTERS, VANILLA_ROOT_FILES};
use crate::install::{self, data_file_exists, preloader_present, write_client_settings, MANIFEST_SCHEMA, REQUIRED_FILES, UPDATE_LAUNCHER_ERROR};
use crate::{active_server, basic, effective_game_path, game, log, mo2, net, proc, store};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

static LAUNCH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static GAME_WAS_RUNNING: AtomicBool = AtomicBool::new(false);

fn file_name(f: &str) -> String {
    Path::new(f).file_name().unwrap_or_default().to_string_lossy().to_string()
}

fn missing_server_plugins(game: &Path, order: &[String], via_mo2: bool) -> Vec<String> {
    order.iter().map(|f| file_name(f)).filter(|f| !VANILLA_MASTERS.contains(&f.to_lowercase().as_str()) && !data_file_exists(game, via_mo2, f)).collect()
}

// Read-only pre-launch staging check; an empty list means ready
fn launch_readiness(game: &Path, via_mo2: bool, info: Option<&Value>) -> Vec<String> {
    let mut problems = vec![];
    let missing: Vec<String> = REQUIRED_FILES.iter().filter(|f| !data_file_exists(game, via_mo2, f)).map(|f| file_name(f)).collect();
    if !missing.is_empty() { problems.push(format!("Client files missing ({}); run Repair Modlist under Troubleshooting first.", missing.join(", "))); }
    if !game.join("skse64_loader.exe").exists() { problems.push("SKSE is not installed (skse64_loader.exe missing); install the modpack first.".into()); }
    if !game.join("Data").join("Skyrim.esm").exists() || !game.join("Data").join("Update.esm").exists() {
        problems.push("Vanilla game files missing (Skyrim.esm/Update.esm); click UPDATE to repair the game copy.".into());
    }
    if let Some(order) = install::load_order(info).filter(|o| !o.is_empty()) {
        let m = missing_server_plugins(game, &order, via_mo2);
        if !m.is_empty() { problems.push(format!("Required plugins missing ({}); install the server modlist first.", m.join(", "))); }
    }
    if via_mo2 && store().str("modpackState") == "failed" {
        problems.push("The last modpack install did not finish. Press PLAY (it will show UPDATE) or run Repair Modlist to complete it first.".into());
    }
    if !preloader_present(game) { problems.push("The Engine Fixes preloader dll is missing from the game folder; press PLAY (it will show UPDATE) to restore it.".into()); }
    // Online servers need the launcher's Discord login, or the game shows its own auth menu and never connects
    if info.and_then(|i| i["offlineMode"].as_bool()) == Some(false) {
        if store().str("gameSession").is_empty() || !store().get("discordUser").is_object() || store().get("gameProfileId").is_null() {
            problems.push("Discord login required; log in from the launcher topbar before playing, otherwise the in-game auth menu appears and you stay on the main menu.".into());
        }
    }
    problems
}

// Mod Manager None plays from the player's own folder, so the launch refuses dlls the launcher did not install instead of deleting them
fn unknown_direct_dlls(game: &Path) -> Vec<String> {
    let record = mo2::read_direct_record(game);
    let mut owned: HashSet<String> = record["mods"].as_object().into_iter().flatten()
        .flat_map(|(_, r)| r["files"].as_array().cloned().unwrap_or_default())
        .filter_map(|f| f.as_str().map(|s| format!("data/{}", s.to_lowercase()))).collect();
    owned.extend(VANILLA_ROOT_FILES.iter().chain(PRELOADER_DLLS.iter()).map(|s| s.to_lowercase()));
    owned.extend(store().get("rootFiles").as_array().into_iter().flatten().filter_map(|f| f.as_str().map(str::to_lowercase)));
    let dlls = |dir: &str| -> Vec<String> {
        fs::read_dir(mo2::join_rel(game, dir)).into_iter().flatten().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.to_lowercase().ends_with(".dll"))
            .map(|n| if dir.is_empty() { n } else { format!("{dir}/{n}") }).collect()
    };
    dlls("").into_iter().chain(dlls("Data/SKSE/Plugins"))
        .filter(|rel| !owned.contains(&rel.to_lowercase()) && !install::is_skse_root_file(&file_name(rel)))
        .collect()
}

fn plugins_txt_dirs() -> Vec<PathBuf> {
    let local = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default());
    let existing: Vec<PathBuf> = basic::MYGAMES_VARIANTS.iter().map(|v| local.join(v)).filter(|p| p.exists()).collect();
    if existing.is_empty() { vec![local.join(basic::MYGAMES_VARIANTS[0])] } else { existing }
}

// Skyrim 1.7 writes a ContentCatalog.txt that crashes 1.6 at startup; it is moved aside
fn quarantine_content_catalogs() {
    let re = regex::Regex::new(r"^-?\d+$").unwrap();
    for dir in plugins_txt_dirs() {
        let file = dir.join("ContentCatalog.txt");
        let Some(cat) = fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok()) else { continue };
        let from17 = cat.as_object().is_some_and(|o| o.keys().any(|k| {
            (k.starts_with("CSV1M") || k.starts_with("CSV1CC") || k.starts_with("CSV2")) && k.contains('_') && !re.is_match(&k[k.rfind('_').unwrap() + 1..])
        }));
        if !from17 { continue; }
        match fs::rename(&file, dir.join("ContentCatalog.txt.alduinak-bak")) {
            Ok(_) => log(format!("[catalog] moved {} aside: written by Skyrim 1.7, which crashes 1.6 at startup", file.display())),
            Err(e) => log(format!("[catalog] could not move {} aside: {e}", file.display())),
        }
    }
}

// Mod Manager None: plugins.txt lists exactly the server's plugins
fn fix_load_order(game: &Path, order: &[String]) -> Result<bool, Vec<String>> {
    let plugins: Vec<String> = order.iter().map(|f| file_name(f)).filter(|f| !VANILLA_MASTERS.contains(&f.to_lowercase().as_str())).collect();
    let missing: Vec<String> = plugins.iter().filter(|f| !game.join("Data").join(f).exists()).cloned().collect();
    if !missing.is_empty() { return Err(missing); }
    let next = plugins.iter().map(|f| format!("*{f}")).collect::<Vec<_>>().join("\r\n") + "\r\n";
    let mut changed = false;
    for dir in plugins_txt_dirs() {
        let p = dir.join("Plugins.txt");
        if fs::read_to_string(&p).ok().as_deref() == Some(next.as_str()) { continue; }
        let _ = fs::create_dir_all(&dir);
        if fs::write(&p, &next).is_ok() { changed = true; log(format!("[launch] wrote {} (exactly {} server plugins)", p.display(), plugins.len())); }
    }
    Ok(changed)
}

async fn prepare_for_launch(game: &Path, via_mo2: bool) -> Result<(), String> {
    gamecopy::ensure_client_dirs(game);
    let game_s = game.to_string_lossy().to_string();
    if let Some(p) = tokio::task::spawn_blocking({ let g = game_s.clone(); move || game::source_problem(&g) }).await.ok().flatten() { return Err(p); }
    if !via_mo2 {
        let unknown = unknown_direct_dlls(game);
        if !unknown.is_empty() { return Err(format!("Remove these files from your Skyrim folder, or choose Mod Organizer 2 under Install Options: {}", unknown.join(", "))); }
    }
    quarantine_content_catalogs();
    let srv = active_server();
    let info = if srv.is_some() { net::fetch_json(&basic::server_info_url(), &[]).await.ok() } else { None };
    let order = install::load_order(info.as_ref()).unwrap_or_default();
    // A real install force-loads unused Creation Club content through Skyrim.ccc, so it is moved aside
    if game_s == store().str("skyrimPath") {
        let keep: Vec<String> = store().get("creationFiles").as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
        mo2::disable_cc_content(game, &order, &keep);
    }
    if info.as_ref().and_then(|i| i["manifestSchema"].as_u64()).unwrap_or(0) > MANIFEST_SCHEMA { return Err(UPDATE_LAUNCHER_ERROR.into()); }
    let not_ready = launch_readiness(game, via_mo2, info.as_ref());
    if !not_ready.is_empty() { return Err(format!("Not ready to launch:\n{}", not_ready.iter().map(|p| format!("• {p}")).collect::<Vec<_>>().join("\n"))); }
    if let Some(s) = &srv {
        write_client_settings(&game.join("Data").join("Platform").join("Plugins").join("skymp5-client-settings.txt"), s, info.as_ref())?;
        log("[launch] client settings written");
    }
    gamecopy::apply_controlmap_override(game);
    // The instance ini (paths, SKSE shortcut) is healed before every MO2 launch
    if via_mo2 { mo2::ensure_instance(&game_s, (!order.is_empty()).then_some(order.as_slice())); }
    if !order.is_empty() {
        if via_mo2 {
            let missing = missing_server_plugins(game, &order, true);
            if !missing.is_empty() { return Err(format!("Missing required plugins: {}. Run Repair Modlist in Settings first.", missing.join(", "))); }
        } else if let Err(missing) = fix_load_order(game, &order) {
            return Err(format!("Missing required plugins: {}. Install the server's modlist first (see the Modlist panel).", missing.join(", ")));
        }
    } else {
        log("[launch] server load order unavailable - leaving plugins.txt untouched");
    }
    // MO2 lockdown: stray overwrite plugins and player mods with plugins or SKSE dlls
    if via_mo2 { mo2::clean_overwrite(); mo2::enforce_mod_rules(); }
    // The backend approves this session for the game server's own check; unreachable fails open, the server still enforces
    let session = store().str("gameSession");
    if !session.is_empty() && info.as_ref().and_then(|i| i["offlineMode"].as_bool()) == Some(false) {
        let body = json!({ "filesVersion": store().str("filesVersion"), "plugins": order.iter().map(|f| file_name(f)).collect::<Vec<_>>(), "manifestSchema": MANIFEST_SCHEMA });
        match net::post_json(&format!("{}/api/launch-check", net::api_url()), &body, &[("x-session", &session)]).await {
            Ok(check) if check["ok"].as_bool() == Some(false) => {
                return Err(if check["filesOk"].as_bool() == Some(false) { "Your client files are out of date. Press the button again to update, then launch." } else { "Your plugin load order does not match the server. Run Repair Modlist in Settings." }.into());
            }
            Ok(_) => log("[launch] launch-check passed"),
            Err(e) => log(format!("[launch] launch-check unavailable ({e}) - continuing, server will enforce")),
        }
    }
    Ok(())
}

async fn launch() -> Result<(), String> {
    let game_s = effective_game_path();
    if game_s.is_empty() { return Err("Skyrim path not configured.".into()); }
    let game = PathBuf::from(&game_s);
    let via_mo2 = store().bool("mo2Enabled");
    if via_mo2 && !mo2::is_installed() { return Err("MO2 is not set up - run Install MO2 under Troubleshooting.".into()); }
    prepare_for_launch(&game, via_mo2).await?;
    if via_mo2 { return mo2::launch_game(&game_s); }
    let exe = game.join("skse64_loader.exe");
    if !exe.exists() { return Err(format!("skse64_loader.exe not found in {game_s}. Install SKSE there, or choose Mod Organizer 2.")); }
    std::process::Command::new(exe).current_dir(&game).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// Refuses a launch while another is being prepared or starting, or the game already runs
#[tauri::command]
pub async fn launch_skse() -> Value {
    if LAUNCH_IN_FLIGHT.swap(true, Ordering::SeqCst) { return json!({ "success": false, "error": "The game is already launching." }); }
    let result = async {
        if proc::game_running().await { return Err("Skyrim is already running.".to_string()); }
        if proc::launch_in_grace() { return Err("Skyrim is still starting - give MO2 a moment.".to_string()); }
        launch().await?;
        proc::LAUNCH_STARTED_AT.store(proc::now_ms(), Ordering::SeqCst);
        Ok(())
    }.await;
    LAUNCH_IN_FLIGHT.store(false, Ordering::SeqCst);
    match result { Ok(_) => json!({ "success": true }), Err(e) => json!({ "success": false, "error": e }) }
}

// Also adopts an in-game FOV change once the game closes, and follows the game with Discord presence
#[tauri::command]
pub async fn game_is_running() -> bool {
    let running = proc::game_running().await;
    if GAME_WAS_RUNNING.swap(running, Ordering::SeqCst) && !running { crate::settings::adopt_chat_fov(); }
    crate::presence::set_running(running);
    running
}
