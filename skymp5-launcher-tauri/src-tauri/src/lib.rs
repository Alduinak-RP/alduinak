mod basic;
mod game;
mod ini;
mod net;
mod proc;
mod settings;
mod store;

use serde_json::Value;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

pub use store::Store;

static STORE: OnceLock<Store> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn store() -> &'static Store {
    STORE.get_or_init(Store::open)
}

// Sends an event to the window, the counterpart of Electron's webContents.send
pub fn send(channel: &str, payload: impl serde::Serialize + Clone) {
    if let Some(app) = APP.get() {
        let _ = app.emit(channel, payload);
    }
}

pub fn log(msg: impl AsRef<str>) {
    let line = format!("{}\n", msg.as_ref());
    print!("{line}");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(store::data_dir().join("install.log")) {
        let _ = f.write_all(line.as_bytes());
    }
}

// The selected game server from the cached list, the first one when the choice is gone
pub fn active_server() -> Option<Value> {
    let servers = store().get("cachedServers");
    let list = servers.as_array()?;
    let id = store().str("activeServerId");
    list.iter().find(|s| s.get("id").and_then(|v| v.as_str()) == Some(id.as_str()) && !id.is_empty()).or(list.first()).cloned()
}

// The main server answers the plain URLs; any other selected server is named in the query
pub fn server_query() -> String {
    let srv = active_server();
    let main = store().get("cachedServers").as_array().and_then(|l| l.first().cloned());
    let id = |v: &Option<Value>| v.as_ref().and_then(|s| s.get("id")).and_then(|i| i.as_str()).map(String::from);
    match (id(&srv), id(&main)) {
        (Some(s), Some(m)) if s != m => format!("?server={}", url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>()),
        _ => String::new(),
    }
}

// Bundled 7-Zip, xdelta and the controlmap seed; the src-tauri/resources folder in development
pub fn resource_dir() -> PathBuf {
    let bundled = APP.get().and_then(|a| a.path().resource_dir().ok());
    match bundled {
        Some(d) if d.join("controlmap.txt").exists() => d,
        _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"),
    }
}

pub fn base_dir() -> PathBuf {
    let b = store().str("baseDirPath");
    PathBuf::from(if b.is_empty() { store::DEFAULT_BASE_DIR.to_string() } else { b })
}

pub fn isolated_game_dir() -> PathBuf {
    base_dir().join("skyrim")
}

pub fn isolated_game_ready() -> bool {
    isolated_game_dir().join("SkyrimSE.exe").exists()
}

pub fn effective_game_path() -> String {
    if store().bool("isolatedGame") && isolated_game_ready() {
        return isolated_game_dir().to_string_lossy().to_string();
    }
    store().str("skyrimPath")
}

// When the stored path is empty or invalid, auto-fill it from the registry and persist
pub fn ensure_skyrim_path() {
    if game::is_valid_skyrim_path(&store().str("skyrimPath")) {
        return;
    }
    if let Some(p) = game::detect_skyrim_path() {
        log(format!("[detect] Skyrim path auto-detected: {p}"));
        store().set_many(vec![("skyrimPath".into(), Value::from(p.clone())), ("gameStore".into(), Value::from(game::detect_edition(&p)))]);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let _ = APP.set(app.handle().clone());
            ensure_skyrim_path();
            let mut window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("Alduinak Launcher")
                .inner_size(1280.0, 720.0)
                .min_inner_size(1024.0, 600.0)
                .decorations(false)
                .background_color(tauri::window::Color(8, 5, 3, 255));
            // Debug builds expose DevTools on a port for testing
            if cfg!(debug_assertions) {
                window = window.additional_browser_args("--remote-debugging-port=9334 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
            }
            window.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            basic::settings_load,
            basic::settings_save,
            basic::dialog_open_folder,
            basic::game_detect_path,
            basic::game_check_path,
            basic::api_status,
            basic::api_serverinfo,
            basic::api_modlist,
            basic::api_news,
            basic::open_external,
            basic::folder_open,
            basic::game_isolated_status,
            settings::graphics_load,
            settings::graphics_save,
            settings::graphics_save_fov,
            settings::hotkeys_load,
            settings::hotkeys_save,
            settings::game_hotkeys_load,
            settings::game_hotkeys_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the launcher");
}
