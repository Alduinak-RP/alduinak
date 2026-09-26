// Settings, paths and the read-only backend calls behind the main window
use crate::{active_server, base_dir, ensure_skyrim_path, game, isolated_game_dir, isolated_game_ready, log, net, server_query, store};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub const MYGAMES_VARIANTS: [&str; 4] = ["Skyrim Special Edition", "Skyrim Special Edition GOG", "Skyrim Special Edition EPIC", "Skyrim Special Edition MS"];

pub fn documents_dir() -> PathBuf {
    crate::APP.get().and_then(|a| a.path().document_dir().ok()).unwrap_or_else(|| PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join("Documents"))
}

// The player's own SkyrimPrefs.ini, found only where Skyrim.ini sits beside it
pub fn find_original_prefs_ini() -> Option<PathBuf> {
    MYGAMES_VARIANTS.iter().map(|v| documents_dir().join("My Games").join(v)).find(|d| d.join("SkyrimPrefs.ini").exists() && d.join("Skyrim.ini").exists()).map(|d| d.join("SkyrimPrefs.ini"))
}

#[tauri::command]
pub async fn settings_load() -> Value {
    // Refresh the server list on every load; offline launches keep the cached one
    if let Ok(Value::Array(list)) = net::fetch_json(&format!("{}/api/servers", net::api_url()), &[]).await {
        if !list.is_empty() {
            store().set("cachedServers", Value::Array(list));
        }
    }
    ensure_skyrim_path();
    let s = store();
    let servers = s.get("cachedServers");
    // Whitelist only what the window reads: the store also holds login tokens
    json!({
        "skyrimPath": s.str("skyrimPath"),
        "baseDirPath": base_dir().to_string_lossy(),
        "activeServerId": active_server().and_then(|v| v.get("id").cloned()).unwrap_or(Value::from("")),
        "mo2Enabled": s.bool("mo2Enabled"),
        "isolatedGame": s.bool("isolatedGame"),
        "discordPresence": s.bool("discordPresence"),
        "voice": crate::install::VOICE_KEYS.iter().map(|k| (k.to_string(), s.get(k))).collect::<serde_json::Map<_, _>>(),
        "multiServer": servers.as_array().map(|a| a.len() > 1).unwrap_or(false),
        "servers": servers,
        "discordUser": s.get("discordUser"),
    })
}

#[tauri::command]
pub fn settings_save(data: Value) {
    let allowed = ["skyrimPath", "baseDirPath", "activeServerId", "mo2Enabled", "isolatedGame", "discordPresence"];
    let mut pairs: Vec<(String, Value)> = allowed.iter().chain(crate::install::VOICE_KEYS.iter()).filter_map(|k| data.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
    if let Some(p) = data.get("skyrimPath").and_then(|v| v.as_str()) {
        let edition = if game::is_valid_skyrim_path(p) { game::detect_edition(p) } else { String::new() };
        pairs.push(("gameStore".into(), Value::from(edition)));
    }
    let presence = data.get("discordPresence").is_some();
    store().set_many(pairs);
    if presence { crate::presence::refresh(); }
}

#[tauri::command]
pub async fn dialog_open_folder(app: tauri::AppHandle, title: Option<String>) -> Option<String> {
    let title = title.unwrap_or_else(|| "Select Skyrim Installation Folder".into());
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title(title).pick_folder(move |p| { let _ = tx.send(p); });
    rx.await.ok().flatten().map(|p| p.to_string())
}

#[tauri::command]
pub fn game_detect_path() -> Value {
    json!({ "path": game::detect_skyrim_path() })
}

#[tauri::command]
pub async fn game_check_path(dir: String) -> Value {
    let warning = tokio::task::spawn_blocking(move || game::source_problem(&dir)).await.ok().flatten();
    json!({ "warning": warning })
}

#[tauri::command]
pub async fn api_status() -> Value {
    match net::fetch_json(&format!("{}/api/status{}", net::api_url(), server_query()), &[]).await {
        Ok(Value::Object(mut m)) => { m.insert("ok".into(), Value::Bool(true)); Value::Object(m) }
        _ => json!({ "ok": false }),
    }
}

pub fn server_info_url() -> String {
    format!("{}/api/serverinfo{}", net::api_url(), server_query())
}

#[tauri::command]
pub async fn api_serverinfo() -> Value {
    let session = store().str("gameSession");
    let headers: Vec<(&str, &str)> = if session.is_empty() { vec![] } else { vec![("x-session", session.as_str())] };
    net::fetch_json(&server_info_url(), &headers).await.unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn api_modlist() -> Value {
    match net::fetch_json(&format!("{}/api/modlist", net::api_url()), &[]).await {
        Ok(Value::Array(items)) => json!({ "ok": true, "items": items }),
        Ok(_) => json!({ "ok": true, "items": [] }),
        Err(e) => json!({ "ok": false, "error": e.message }),
    }
}

fn news_cache_dir() -> PathBuf {
    store::data_dir().join("news-cache")
}

fn news_cache_path(url: &str) -> PathBuf {
    let ext = url::Url::parse(url).ok().and_then(|u| Path::new(u.path()).extension().map(|e| format!(".{}", e.to_string_lossy()))).unwrap_or_else(|| ".img".into());
    news_cache_dir().join(format!("{}{ext}", hex::encode(Sha1::digest(url.as_bytes()))))
}

// Local file as a URL the window may load through the asset protocol
fn asset_url(p: &Path) -> String {
    let encoded: String = p.to_string_lossy().bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect();
    format!("http://asset.localhost/{encoded}")
}

// News images are cached by URL so each one downloads once; unreferenced files are pruned
async fn cache_news_images(items: &mut [Value]) {
    let _ = std::fs::create_dir_all(news_cache_dir());
    let urls: HashSet<String> = items.iter().filter_map(|i| i.get("image").and_then(|v| v.as_str())).filter(|u| u.starts_with("http://") || u.starts_with("https://")).map(String::from).collect();
    let mut cached: HashMap<String, PathBuf> = HashMap::new();
    for url in &urls {
        let file = news_cache_path(url);
        if !file.exists() {
            let part = file.with_extension("part");
            if let Err(e) = net::download_file(url, &part, &[], |_, _| {}).await {
                log(format!("[news] could not cache {url}: {e}"));
                continue;
            }
            let _ = std::fs::rename(&part, &file);
        }
        cached.insert(url.clone(), file);
    }
    for item in items.iter_mut() {
        let img = item.get("image").and_then(|v| v.as_str()).map(String::from);
        if let Some(file) = img.and_then(|u| cached.get(&u).cloned()) {
            item["image"] = Value::from(asset_url(&file));
        }
    }
    let keep: HashSet<String> = urls.iter().map(|u| news_cache_path(u).file_name().unwrap().to_string_lossy().to_string()).collect();
    for e in std::fs::read_dir(news_cache_dir()).into_iter().flatten().flatten() {
        if !keep.contains(&e.file_name().to_string_lossy().to_string()) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[tauri::command]
pub async fn api_news() -> Value {
    match net::fetch_json(&format!("{}/api/news", net::api_url()), &[]).await {
        Ok(Value::Array(mut items)) => {
            cache_news_images(&mut items).await;
            json!({ "ok": true, "items": items })
        }
        Ok(_) => json!({ "ok": true, "items": [] }),
        Err(e) => json!({ "ok": false, "error": e.message }),
    }
}

// http and https only
#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) {
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

// Quick links: the Alduinak install, the detected Skyrim folder and the SKSE logs
#[tauri::command]
pub fn folder_open(app: tauri::AppHandle, kind: String) -> Value {
    let dir = match kind.as_str() {
        "install" => Some(base_dir()),
        "skyrim" => Some(PathBuf::from(store().str("skyrimPath"))),
        "logs" => Some(find_original_prefs_ini().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_else(|| documents_dir().join("My Games").join(MYGAMES_VARIANTS[0])).join("SKSE")),
        _ => None,
    };
    match dir {
        Some(d) if d.exists() => match app.opener().open_path(d.to_string_lossy(), None::<&str>) {
            Ok(_) => json!({ "success": true }),
            Err(e) => json!({ "success": false, "error": e.to_string() }),
        },
        Some(d) => json!({ "success": false, "error": format!("{} does not exist yet.", d.display()) }),
        None => json!({ "success": false, "error": "That folder does not exist yet." }),
    }
}

#[tauri::command]
pub fn game_isolated_status() -> Value {
    json!({
        "enabled": store().bool("isolatedGame"),
        "ready": isolated_game_ready(),
        "dir": isolated_game_dir().to_string_lossy(),
        "base": store().str("baseDirPath"),
    })
}
