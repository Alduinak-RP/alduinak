// The modlist install: MO2 (unless Mod Manager is None), the manifest replay, SKSE and cleanup, plus the separate install steps
use crate::gamecopy::{self, progress, CREATIONS_STAMP, NEVER_LAUNCHED_ERROR};
use crate::settings::client_settings_path;
use crate::{active_server, auth, basic, effective_game_path, isolated_game_dir, isolated_game_ready, log, mo2, net, proc, send, store};
use regex::Regex;
use sha2::Digest;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri_plugin_opener::OpenerExt;

pub const CLIENT_SCRIPT: &str = "Platform/Plugins/skymp5-client.js";

pub static INSTALLING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

// sha256 of the files SKSE 2.2.6 puts in the game root, per edition
const SKSE_FILE_HASHES: &[(&str, &[(&str, &str)])] = &[
    ("Steam", &[
        ("skse64_loader.exe", "730c2743f6871fbaeb8606c1d3b7a55feca045c3d74858a41b0c6d03cd989fbc"),
        ("skse64_1_6_1170.dll", "c9a2c8a80df6bf2372c5f49468bb2e5ab67786157265b6f29ece9f4eac075d54"),
    ]),
    ("GOG", &[
        ("skse64_loader.exe", "1fe471a2ca8451ef900b72495076e62241ce50af21f8057775b29e1e19069d2e"),
        ("skse64_1_6_1179.dll", "1af746d2db9c4bf8e716c6b122e2faa7ca205039274a10573bd5908ba9712177"),
    ]),
];

pub fn is_skse_root_file(n: &str) -> bool {
    let l = n.to_lowercase();
    l.starts_with("skse64_") && (l.ends_with(".exe") || l.ends_with(".dll"))
}

// Why the SKSE files in the game root are not the official build, None when they are
async fn skse_file_problem(game: &Path) -> Option<String> {
    let edition = mo2::skse_source_for(&game.to_string_lossy()).edition;
    let known = SKSE_FILE_HASHES.iter().find(|(e, _)| *e == edition)?.1;
    for e in fs::read_dir(game).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !is_skse_root_file(&name) { continue; }
        let Some((_, want)) = known.iter().find(|(n, _)| n.eq_ignore_ascii_case(&name)) else { return Some(format!("unexpected SKSE file {name}")) };
        if mo2::sha256_file(&e.path()).await.ok().as_deref() != Some(*want) { return Some(format!("modified SKSE file {name}")); }
    }
    None
}

fn download_progress(label: String) -> impl FnMut(u64, u64) {
    move |r, t| {
        let mb = |n: u64| n as f64 / 1048576.0;
        let file = if t > 0 { format!("{label}… {}% ({:.1} / {:.1} MB)", r * 100 / t, mb(r), mb(t)) } else { format!("{label}… {:.1} MB", mb(r)) };
        progress("mods", file, 0, 0);
    }
}

// Replaces every skse64_* root file, so a stray or modified one never survives a reinstall
pub async fn install_skse_into_root(game: &Path) -> Result<(), String> {
    for e in fs::read_dir(game).into_iter().flatten().flatten() {
        if is_skse_root_file(&e.file_name().to_string_lossy()) { let _ = fs::remove_file(e.path()); }
    }
    let skse = mo2::skse_source_for(&game.to_string_lossy());
    let name = mo2::download_to_downloads(&skse.url, &skse.file_name, &[], download_progress(format!("Downloading SKSE ({})", skse.edition))).await?;
    progress("mods", "Installing SKSE…", 0, 0);
    let archive = mo2::downloads_dir().join(name);
    mo2::install_skse(&archive, game, !store().bool("mo2Enabled")).await?;
    let _ = fs::remove_file(archive);
    Ok(())
}

// Fetched fresh on every install run and never cached, so no local copy can be edited
pub async fn fetch_manifest() -> Result<Value, net::HttpError> {
    let m = net::fetch_json(&format!("{}/api/manifest", net::api_url()), &[]).await?;
    if let Some(list) = m["gameExes"].as_array() {
        *crate::game::KNOWN_GAME_EXES.lock().unwrap() = Some(list.iter().filter_map(|h| h.as_str().map(str::to_lowercase)).collect());
    }
    Ok(expand_manifest(&m))
}

fn join_path(dir: &str, file: &str) -> String {
    if dir.is_empty() { file.to_string() } else { format!("{dir}/{file}") }
}

// Compact entries (archive entries and file entries, see the backend's sources/manifestFormat.js) as flat directives
fn expand_entries(entries: &Value, mod_id: &Value, archives: &mut Vec<Value>) -> Vec<Value> {
    let mut files = vec![];
    for e in entries.as_array().into_iter().flatten() {
        if let Some(name) = e["archive"].as_str() {
            let key = e["key"].as_str().unwrap_or("");
            if archives.iter().any(|a| a["id"] == key) { continue; }
            let source = if let Some(url) = e["url"].as_str() { json!({ "type": "url", "url": url }) }
                else if let Some(file_id) = e["fileId"].as_i64() { json!({ "type": "nexus", "modId": if e["modId"].is_null() { mod_id.clone() } else { e["modId"].clone() }, "fileId": file_id }) }
                else { json!({ "type": "manual", "name": name }) };
            archives.push(json!({ "id": key, "name": name, "hash": e["sha256"], "size": e["size"], "source": source }));
            continue;
        }
        let file = e["file"].as_str().unwrap_or("");
        let from = e["from"].as_str().unwrap_or("");
        let (key, from_dir) = from.split_once('/').unwrap_or((from, ""));
        let to_dir = match e["to"].as_str() { None => from_dir, Some("root") => "", Some(t) => t.strip_prefix("root/").unwrap_or(t) };
        let name = e["name"].as_str().unwrap_or(file);
        files.push(json!({ "to": join_path(to_dir, file), "archive": key, "from": join_path(from_dir, name), "sha256": e["sha256"], "size": e["size"] }));
    }
    files
}

// MO2 text file lines without comments and blanks
fn text_lines(v: &Value) -> Vec<String> {
    v.as_str().unwrap_or("").lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(String::from).collect()
}

// The compact manifest in the flat shape the installer works with
fn expand_manifest(m: &Value) -> Value {
    let mut archives = vec![];
    let mods: Vec<Value> = m["mods"].as_array().into_iter().flatten().map(|md| json!({
        "name": md["name"], "modId": md["modId"], "version": md["version"], "hash": md["hash"], "size": md["size"],
        "files": expand_entries(&md["files"], &md["modId"], &mut archives),
    })).collect();
    let root = expand_entries(&m["gameFiles"], &Value::Null, &mut archives);
    let root_hash = hex::encode(sha2::Sha256::digest(root.iter().map(|f| format!("{}:{}", f["to"].as_str().unwrap_or(""), f["sha256"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n").as_bytes()));
    let order: Vec<String> = text_lines(&m["modlist"]).into_iter()
        .filter(|l| l.starts_with('+') || (l.starts_with('-') && l.ends_with("_separator"))).map(|l| l[1..].trim().to_string()).collect();
    json!({
        "version": m["version"], "build": m["build"], "mods": mods, "archives": archives, "root": root, "rootHash": root_hash,
        "order": order, "plugins": text_lines(&m["plugins"]), "creations": m["creations"],
        "settings": m["settings"], "initweaks": m["initweaks"],
    })
}

pub fn load_order(info: Option<&Value>) -> Option<Vec<String>> {
    info?["loadOrder"].as_array().map(|l| l.iter().filter_map(|v| v.as_str().map(String::from)).collect())
}

// The manifest mods that carry the SkyMP client
pub fn client_mods(manifest: &Value) -> usize {
    manifest["mods"].as_array().into_iter().flatten().filter(|m| m["files"].as_array().into_iter().flatten().any(|f| f["to"].as_str().is_some_and(|t| t.eq_ignore_ascii_case(CLIENT_SCRIPT)))).count()
}

// Filename pattern for a Nexus archive: downloads embed the mod id; a renamed file still matches on the mod's name words
fn nexus_name_pattern(mod_id: i64, display: &str) -> Regex {
    let words: Vec<String> = Regex::new(r"[a-z]{4,}").unwrap().find_iter(&display.to_lowercase()).take(2).map(|m| m.as_str().to_string()).collect();
    let name_re = words.join(".*");
    let base = format!("(?:^|[^0-9]){mod_id}(?:[^0-9]|$)") + &if name_re.is_empty() { String::new() } else { format!("|{name_re}") };
    Regex::new(&format!("(?i){base}")).unwrap()
}

// The downloads folder plus the backend page listing the pinned Nexus links still needed, once per install run
fn open_download_list(missing: &[Value]) {
    let Some(app) = crate::APP.get() else { return };
    let _ = fs::create_dir_all(mo2::downloads_dir());
    let _ = app.opener().open_path(mo2::downloads_dir().to_string_lossy(), None::<&str>);
    let need: Vec<String> = missing.iter().filter_map(|a| {
        let s = &a["source"];
        Some(format!("{}-{}", s["modId"].as_i64()?, s["fileId"].as_i64().map(|f| f.to_string()).unwrap_or_else(|| "any".into())))
    }).collect();
    let query = if need.is_empty() { String::new() } else { format!("?need={}", url::form_urlencoded::byte_serialize(need.join(",").as_bytes()).collect::<String>()) };
    let _ = app.opener().open_url(format!("{}/api/nexus-downloads{query}", net::api_url()), None::<&str>);
}

// Voice chat settings the game reads as is: device labels, "ptt" or "vad", the detection threshold and the mic gain in dB
pub const VOICE_KEYS: [&str; 5] = ["voiceInputDevice", "voiceOutputDevice", "voiceActivation", "voiceThresholdDb", "voiceGainDb"];

// Writes the SkyMP client settings from scratch, keeping only the player's hotkeys and FOV; online servers also get the login the game reads
pub fn write_client_settings(dest: &Path, srv: &Value, info: Option<&Value>) -> Result<(), String> {
    let mut prev: Map<String, Value> = fs::read_to_string(dest).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default();
    if let Some(p) = store().get("pendingClientHotkeys").as_object() { prev.extend(p.clone()); }
    let mut s = Map::new();
    for k in ["chatFocusKeyCodes", "freeCursorKeyCode", "voicePushToTalkKeyCode", "hideUiKeyCode", "altInteractKeyCode", "emoteWheelKeyCode"] {
        if let Some(v) = prev.get(k) { s.insert(k.into(), v.clone()); }
    }
    s.insert("fov".into(), json!(crate::settings::launcher_fov()));
    for k in VOICE_KEYS {
        let v = store().get(k);
        if !v.is_null() { s.insert(k.into(), v); }
    }
    s.insert("server-ip".into(), srv["address"].clone());
    s.insert("server-port".into(), json!(srv["port"].as_i64().or_else(|| srv["port"].as_str().and_then(|p| p.parse().ok()))));
    // Online mode when serverinfo is unavailable: offline would write a wrong profileId-based gameData
    let offline = info.and_then(|i| i["offlineMode"].as_bool()).unwrap_or(false);
    s.insert("master".into(), json!(info.and_then(|i| i["masterUrl"].as_str()).unwrap_or("")));
    s.insert("server-master-key".into(), srv.get("masterKey").filter(|v| !v.is_null()).or(info.map(|i| &i["masterKey"])).cloned().unwrap_or(Value::Null));
    let profile_id = store().get("gameProfileId");
    if offline {
        if profile_id.is_null() { return Err("No profileId in store - login with Discord before playing".into()); }
        s.insert("gameData".into(), json!({ "profileId": profile_id }));
    } else {
        write_game_login(dest, "");
    }
    fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(dest, serde_json::to_string_pretty(&Value::Object(s)).unwrap() + "\n").map_err(|e| e.to_string())?;
    store().delete("pendingClientHotkeys");
    Ok(())
}

// The login the game reads next to the client settings; an empty token leaves it without one until launch-check hands out a play token
pub fn write_game_login(settings: &Path, token: &str) {
    let (user, profile_id) = (store().get("discordUser"), store().get("gameProfileId"));
    if !user.is_object() || profile_id.is_null() { return; }
    let Some(auth) = settings.parent().and_then(Path::parent).map(|p| p.join("PluginsNoLoad").join("auth-data-no-load.js")) else { return };
    let data = json!({ "session": token, "masterApiId": profile_id, "discordUsername": user["username"].as_str().or(user["tag"].as_str()), "discordDiscriminator": null, "discordAvatar": user["avatar"] });
    let _ = fs::create_dir_all(auth.parent().unwrap());
    if let Err(e) = fs::write(&auth, format!("//{data}")) { log(format!("[writeClientSettings] Failed to write auth-data-no-load.js: {e}")); }
}

fn complete(payload: Value) {
    send("install:complete", payload);
}

// Every archive a list of directives uses, deduplicated in order
fn archive_ids(files: &[Value]) -> Vec<String> {
    let mut seen = HashSet::new();
    files.iter().filter_map(|f| mo2::archive_id(&f["archive"])).filter(|id| seen.insert(id.clone())).collect()
}

struct Replay {
    archive_paths: HashMap<String, PathBuf>,
    extracted: HashMap<String, PathBuf>,
    ref_count: HashMap<String, i64>,
    pending: Vec<Value>,
    failed: Vec<String>,
    installed: usize,
    total: usize,
}

impl Replay {
    async fn ensure_extracted(&mut self, ids: &[String], label: Option<&(dyn Fn(u32) + Sync)>) -> Result<(), String> {
        for id in ids {
            if self.extracted.contains_key(id) { continue; }
            let path = self.archive_paths.get(id).ok_or(format!("archive {id} was never downloaded"))?.clone();
            let dir = mo2::extract_to_cache(&path, id, |p| if let Some(l) = label { l(p) }).await?;
            self.extracted.insert(id.clone(), dir);
        }
        Ok(())
    }

    // Frees an extraction as soon as its last consumer is done, bounding temp disk use
    fn release(&mut self, ids: &[String]) {
        for id in ids {
            let left = self.ref_count.get(id).copied().unwrap_or(0) - 1;
            self.ref_count.insert(id.clone(), left);
            if left <= 0 && self.extracted.remove(id).is_some() { mo2::clear_cache(Some(id)); }
        }
    }

    // Installs every waiting mod whose archives have all arrived
    async fn install_ready(&mut self, game: &Path, direct: bool) {
        let ready: Vec<Value> = self.pending.iter().filter(|m| archive_ids(m["files"].as_array().map(Vec::as_slice).unwrap_or(&[])).iter().all(|id| self.archive_paths.contains_key(id))).cloned().collect();
        for m in ready {
            self.pending.retain(|p| p["name"] != m["name"]);
            self.installed += 1;
            let name = m["name"].as_str().unwrap_or("").to_string();
            let (index, total) = (self.installed, self.total);
            let show = move |pct: u32| progress("mods", format!("Installing {name}… {pct}%"), index, total);
            show(0);
            let files = m["files"].as_array().cloned().unwrap_or_default();
            let ids = archive_ids(&files);
            let result = async {
                self.ensure_extracted(&ids, Some(&show)).await?;
                if direct { mo2::apply_mod_direct(game, &m, &self.extracted).await }
                else { mo2::apply_mod(m["name"].as_str().unwrap_or(""), &files, &self.extracted, m["modId"].as_i64().unwrap_or(0), m["hash"].as_str().unwrap_or("")).await }
            }.await;
            if let Err(e) = result { self.failed.push(format!("{} ({e})", m["name"].as_str().unwrap_or(""))); }
            self.release(&ids);
        }
    }
}

// force rebuilds every mod and the SKSE root step (Repair Modlist); Mod Manager None installs into the game's Data
async fn run_modlist_install(force: bool) -> Result<Value, String> {
    let direct = !store().bool("mo2Enabled");
    let game_str = effective_game_path();
    if game_str.is_empty() { return Err("Skyrim path not configured.".into()); }
    let game = PathBuf::from(&game_str);
    let srv = active_server().ok_or("No server selected - open Settings and choose a server.")?;
    if basic::find_original_prefs_ini().is_none() { return Err(NEVER_LAUNCHED_ERROR.into()); }

    // 0. Vanilla integrity: portable copies are repaired file by file, a real install only warns
    let integrity = gamecopy::ensure_vanilla_integrity(&game).await;
    if let Some(e) = integrity.error { return Err(e); }
    if integrity.repaired > 0 { log(format!("[install] repaired {} vanilla file(s)", integrity.repaired)); }

    // 1. MO2 itself, the portable instance, and the nxm:// handler
    let info = net::fetch_json(&basic::server_info_url(), &[]).await.ok();
    let order = load_order(info.as_ref());
    if !direct {
        mo2::ensure_installed(&|m| progress("download", m, 0, 0)).await?;
        mo2::ensure_instance(&game_str, order.as_deref());
        mo2::register_nxm_handler();
        gamecopy::seed_profile_prefs(Path::new(&{ let s = store().str("skyrimPath"); if s.is_empty() { game_str.clone() } else { s } }));
    }
    gamecopy::apply_forced_server_defaults(&game);

    // 2. Mods from the compiled install manifest
    let manifest = match fetch_manifest().await {
        Ok(m) => m,
        Err(e) if e.status == Some(404) => return Err(e.server_error.unwrap_or_else(|| "The server has not published a mod manifest yet - ask the server admin to run `npm run compile-manifest` on the backend.".into())),
        Err(e) => return Err(format!("Could not fetch the install manifest: {e}")),
    };
    let (Some(mods), Some(archives)) = (manifest["mods"].as_array().cloned(), manifest["archives"].as_array().cloned()) else {
        return Err("Install manifest is missing or malformed - run \"npm run compile-manifest\" on the backend.".into());
    };
    if force {
        // Every Creation file is hashed again and nothing stray in overwrite survives
        let _ = fs::remove_file(game.join(CREATIONS_STAMP));
        if !direct { mo2::clean_overwrite(); }
    }

    // Creation Club files from the player's own install, before any mod: the load order needs them either way
    let creations_warning = gamecopy::ensure_creations(&manifest, &game).await?;
    let masters = gamecopy::ensure_cleaned_masters(&game, false, false).await;
    let setup_warning: Vec<String> = [integrity.warning, creations_warning, masters.warning].into_iter().flatten().collect();

    // 3. SkyMP client files come from a manifest mod
    if client_mods(&manifest) == 0 { return Err("The install manifest has no SkyMP client mod - contact staff.".into()); }
    let files_version = client_version().await;
    let core_up_to_date = files_version.as_deref().is_some_and(|v| v == store().str("filesVersion"));
    gamecopy::ensure_client_dirs(&game);
    write_client_settings(&client_settings_path(), &srv, info.as_ref())?;
    let strays = gamecopy::remove_game_copy_strays(&game, &manifest);
    if strays > 0 { log(format!("[install] removed {strays} stray file(s) from the game copy")); }

    let root_files = manifest["root"].as_array().cloned().unwrap_or_default();
    let finish_order = || {
        let order: Vec<String> = manifest["order"].as_array().filter(|o| !o.is_empty()).map(|o| o.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_else(|| mods.iter().filter_map(|m| m["name"].as_str().map(String::from)).collect());
        if direct {
            // plugins.txt is synced at launch
            mo2::prune_direct_mods(&game, &mods.iter().filter_map(|m| m["name"].as_str().map(String::from)).collect());
        } else {
            let mut order = order;
            if mo2::mods_dir().join("SKSE").exists() && !order.iter().any(|n| n == "SKSE") { order.push("SKSE".into()); }
            mo2::set_modlist_order(&order);
            mo2::set_plugins(&manifest["plugins"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>());
            // The profile's own MO2 settings and ini tweaks, as the reference install has them
            for (name, key) in [("settings.ini", "settings"), ("initweaks.ini", "initweaks")] {
                if let Some(text) = manifest[key].as_str().filter(|t| !t.is_empty()) { let _ = fs::write(mo2::profile_dir().join(name), text.replace('\n', "\r\n")); }
            }
        }
        store().set_many(vec![
            ("installedRootHash".into(), json!(manifest["rootHash"].as_str().unwrap_or(""))),
            ("rootFiles".into(), json!(root_files.iter().filter_map(|f| f["to"].as_str()).collect::<Vec<_>>())),
        ]);
        if let Some(v) = &files_version { store().set("filesVersion", json!(v)); }
    };
    let warning = |extra: Option<&str>| {
        let mut w = setup_warning.clone();
        if let Some(e) = extra { w.push(e.into()); }
        (!w.is_empty()).then(|| w.join(" | "))
    };

    if mods.is_empty() {
        // No mods yet, but the game root still needs SKSE or nothing can launch
        if !game.join("skse64_loader.exe").exists() { install_skse_into_root(&game).await.map_err(|e| format!("SKSE install failed: {e}"))?; }
        finish_order();
        return Ok(json!({ "success": true, "upToDate": core_up_to_date, "modsTotal": 0, "warning": warning(Some("The install manifest has no mods yet - compile it from the reference MO2 install on the backend.")) }));
    }

    // 3a. Which mods need installing: a changed version, a size mismatch, or any changed code, plugin or script
    if force {
        progress("mods", "Clearing the build and extraction caches…", 0, 0);
        mo2::clear_build_cache();
        mo2::clear_cache(None);
    }
    let mut to_install = vec![];
    for (i, m) in mods.iter().enumerate() {
        if force || mod_changed(m, &game, direct).await { to_install.push(m.clone()); }
        if (i + 1) % 10 == 0 || i + 1 == mods.len() { send("install:progress", json!({ "phase": "verify", "index": i + 1, "total": mods.len() })); }
    }
    let root_set_up = game.join("skse64_loader.exe").exists();
    let root_changed = store().str("installedRootHash") != manifest["rootHash"].as_str().unwrap_or("");
    let root_missing = root_files.iter().any(|f| !mo2::join_rel(&game, f["to"].as_str().unwrap_or("")).exists());
    // Root code (the SKSE loader, preloader dlls) is hashed on every Play like mod code
    let mut root_modified = false;
    for f in root_files.iter().filter(|f| f["sha256"].is_string() && mo2::is_risky(f["to"].as_str().unwrap_or(""))) {
        let p = mo2::join_rel(&game, f["to"].as_str().unwrap_or(""));
        if p.exists() && !mo2::sha256_file(&p).await.unwrap_or_default().eq_ignore_ascii_case(f["sha256"].as_str().unwrap_or("")) { root_modified = true; }
    }
    if let Some(p) = skse_file_problem(&game).await { log(format!("[install] {p} - reinstalling SKSE")); root_modified = true; }
    let needs_root = force || !root_set_up || root_changed || root_missing || root_modified;
    log(format!("[install] root check: skse={root_set_up} hashChanged={root_changed} filesMissing={root_missing} modified={root_modified} force={force} -> needsRoot={needs_root}"));

    if to_install.is_empty() && !needs_root {
        finish_order();
        return Ok(json!({ "success": true, "upToDate": true, "modsTotal": mods.len(), "warning": warning(None) }));
    }

    // 3b. Acquire only the archives the mods to install (and root files) reference, verified by sha256
    let mut needed: HashSet<String> = to_install.iter().flat_map(|m| archive_ids(m["files"].as_array().map(Vec::as_slice).unwrap_or(&[]))).collect();
    if needs_root { needed.extend(archive_ids(&root_files)); }
    let token = auth::nexus_auth().await;
    let premium = token.is_some() && store().get("nexusUser")["isPremium"].as_bool().unwrap_or(false);
    let mut replay = Replay { archive_paths: HashMap::new(), extracted: HashMap::new(), ref_count: HashMap::new(), pending: to_install.clone(), failed: vec![], installed: 0, total: to_install.len() };
    let mut need_browser: Vec<Value> = vec![];
    for a in archives.iter().filter(|a| mo2::archive_id(&a["id"]).is_some_and(|id| needed.contains(&id))) {
        let id = mo2::archive_id(&a["id"]).unwrap();
        let name = a["name"].as_str().unwrap_or("").to_string();
        let hash = a["hash"].as_str().unwrap_or("").to_string();
        let source = &a["source"];
        // Already on disk: by Nexus fileId, by name, or by content when renamed or moved in by hand
        let mut candidates = vec![];
        if source["type"] == "nexus" { if let Some(n) = source["fileId"].as_i64().and_then(mo2::find_download_by_file_id) { candidates.push(n); } }
        candidates.push(name.clone());
        let mut existing = None;
        for c in candidates {
            let p = mo2::downloads_dir().join(c);
            if p.exists() && mo2::verify_archive(&p, &hash).await { existing = Some(p); break; }
        }
        if existing.is_none() { existing = mo2::find_archive_by_hash(&hash, a["size"].as_u64()).await; }
        if let Some(p) = existing { replay.archive_paths.insert(id, p); continue; }

        if source["type"] == "url" {
            let url = source["url"].as_str().unwrap_or("");
            let got = mo2::download_to_downloads(url, &name, &[], download_progress(format!("Downloading {name}"))).await?;
            let p = mo2::downloads_dir().join(got);
            if !mo2::verify_archive(&p, &hash).await { return Err(format!("{name}: downloaded file failed verification (hash mismatch).")); }
            replay.archive_paths.insert(id, p);
        } else if source["type"] == "nexus" && premium {
            let (mod_id, file_id) = (source["modId"].as_i64().unwrap_or(0), source["fileId"].as_i64().unwrap_or(0));
            let got = async {
                let link = auth::nexus_download_link(token.as_deref().unwrap_or(""), mod_id, file_id).await?;
                let ext = Path::new(&name).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_else(|| ".zip".into());
                let stem = Path::new(&name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                let headers = auth::nexus_headers();
                let hdr: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
                mo2::download_to_downloads(&link, &format!("{stem}-{mod_id}-{file_id}{ext}"), &hdr, download_progress(format!("Downloading {name}"))).await
            }.await;
            match got {
                Ok(n) => {
                    let p = mo2::downloads_dir().join(n);
                    if !mo2::verify_archive(&p, &hash).await { return Err(format!("{name}: downloaded file failed verification (hash mismatch - the version pin may have changed).")); }
                    replay.archive_paths.insert(id, p);
                }
                // A dead pin must not abort the whole install: fall back to the manual download page
                Err(e) => {
                    log(format!("[install] auto-download failed for {name} (mod {mod_id}, file {file_id}): {e} - falling back to manual download"));
                    progress("mods", format!("{name}: auto-download failed ({e}) - queued for manual download"), 0, 0);
                    need_browser.push(a.clone());
                }
            }
        } else if source["type"] == "nexus" {
            need_browser.push(a.clone());
        } else {
            return Err(format!("{name}: no download source. Add a URL in data/manifest-sources.json on the backend."));
        }
    }

    // 3c. Replay the manifest: each mod installs as soon as all its archives are here
    for m in &to_install { for id in archive_ids(m["files"].as_array().map(Vec::as_slice).unwrap_or(&[])) { *replay.ref_count.entry(id).or_insert(0) += 1; } }
    if needs_root { for id in archive_ids(&root_files) { *replay.ref_count.entry(id).or_insert(0) += 1; } }
    mo2::clear_cache(None);
    replay.install_ready(&game, direct).await;

    // Free accounts: the downloads page plus the folder, installing each archive as it lands
    if !need_browser.is_empty() {
        open_download_list(&need_browser);
        progress("mods", "Opened the downloads list: open each link, click \"Slow Download\", and move every archive into the Alduinak downloads folder. Each mod installs as soon as its archive arrives.", 0, need_browser.len());
        let wanted: Vec<mo2::Wanted> = need_browser.iter().map(|a| mo2::Wanted {
            name: a["name"].as_str().unwrap_or("").into(),
            hash: a["hash"].as_str().map(String::from),
            size: a["size"].as_u64(),
            name_pattern: Some(nexus_name_pattern(a["source"]["modId"].as_i64().unwrap_or(0), a["name"].as_str().unwrap_or(""))),
            expect: vec![],
        }).collect();
        let arrivals: Arc<std::sync::Mutex<Vec<(usize, PathBuf)>>> = Arc::default();
        let sink = arrivals.clone();
        // Arrivals are installed between polls, so an archive landing mid-install waits for the current mod
        let wait = mo2::wait_for_downloads(&wanted,
            |done, total, msg| progress("mods", msg, done, total),
            || CANCEL.load(Ordering::SeqCst),
            move |i, p| sink.lock().unwrap().push((i, p)));
        tokio::pin!(wait);
        loop {
            tokio::select! {
                r = &mut wait => { r?; break; }
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {}
            }
            let landed: Vec<(usize, PathBuf)> = arrivals.lock().unwrap().drain(..).collect();
            if landed.is_empty() { continue; }
            for (i, p) in landed { if let Some(id) = mo2::archive_id(&need_browser[i]["id"]) { replay.archive_paths.insert(id, p); } }
            replay.install_ready(&game, direct).await;
        }
        for (i, p) in arrivals.lock().unwrap().drain(..) { if let Some(id) = mo2::archive_id(&need_browser[i]["id"]) { replay.archive_paths.insert(id, p); } }
        replay.install_ready(&game, direct).await;
    }

    if needs_root && !root_files.is_empty() {
        let ids = archive_ids(&root_files);
        let r = async { replay.ensure_extracted(&ids, None).await?; mo2::apply_root_files(&root_files, &replay.extracted, &game).await }.await;
        if let Err(e) = r { replay.failed.push(format!("root files ({e})")); }
        replay.release(&ids);
    }
    mo2::clear_cache(None);
    if !replay.failed.is_empty() { return Err(format!("{} item(s) failed to install: {}", replay.failed.len(), replay.failed.join("; "))); }

    // 4. Game-root components (only on a version change or a fresh game copy)
    if needs_root { install_skse_into_root(&game).await.map_err(|e| format!("SKSE install failed: {e}"))?; }

    // 5. Match MO2 priority and plugin order, record the installed version
    finish_order();

    // 6. Cleanup: the installed mods no longer need their archives; a repair downloads them again
    let mut done: Vec<PathBuf> = replay.archive_paths.values().filter(|p| p.starts_with(mo2::downloads_dir())).cloned().collect();
    done.sort();
    done.dedup();
    for (i, p) in done.iter().enumerate() {
        progress("mods", format!("Cleaning up downloads… {}% ({}/{})", (i + 1) * 100 / done.len(), i + 1, done.len()), i + 1, done.len());
        for f in [p.clone(), PathBuf::from(format!("{}.meta", p.display()))] { let _ = fs::remove_file(f); }
    }
    Ok(json!({ "success": true, "upToDate": core_up_to_date, "modsTotal": mods.len(), "warning": warning(None) }))
}

// A mod needs installing on a new version, a size mismatch, or any changed code, plugin or script
async fn mod_changed(m: &Value, game: &Path, direct: bool) -> bool {
    let name = m["name"].as_str().unwrap_or("");
    if direct {
        let problem = mo2::direct_mod_problem(game, m).await;
        if let Some(p) = &problem { log(format!("[install] {name}: {p} - installing")); }
        return problem.is_some();
    }
    let dir = mo2::mods_dir().join(mo2::sanitize(name));
    let hash = m["hash"].as_str().unwrap_or("");
    if !dir.exists() || hash.is_empty() || mo2::read_mod_hash(name) != hash { return true; }
    let files = m["files"].as_array().cloned().unwrap_or_default();
    if !files.is_empty() && files.iter().all(|f| f["size"].is_u64()) {
        let expected: u64 = files.iter().filter_map(|f| f["size"].as_u64()).sum();
        match mo2::mod_folder_size(name) {
            // Unreadable mid-scan (AV holding a handle): never wipe a mod over a transient lock
            None => log(format!("[install] {name}: folder unreadable during verify - skipping size check")),
            Some(actual) if actual != expected => { log(format!("[install] {name}: folder is {actual} bytes, manifest expects {expected} - repairing")); return true; }
            _ => {}
        }
    }
    match mo2::risky_file_problem(&dir, &files).await {
        Ok(Some(p)) => { log(format!("[install] {name}: {p} - repairing")); true }
        Ok(None) => false,
        Err(e) => { log(format!("[install] {name}: could not hash its files ({e}) - skipping")); false }
    }
}

#[tauri::command]
pub fn install_start(mode: String, opts: Value) {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        progress("mods", "An install is already running - press Cancel Install to stop it first.", 0, 0);
        complete(json!({ "success": false, "error": "An install is already running - wait for it to finish." }));
        return;
    }
    CANCEL.store(false, Ordering::SeqCst);
    let force = mode == "modlist" && opts["force"].as_bool().unwrap_or(false);
    tauri::async_runtime::spawn(async move {
        let result = run_modlist_install(force).await;
        INSTALLING.store(false, Ordering::SeqCst);
        match result {
            Ok(v) => { store().set("modpackState", json!("ready")); complete(v); }
            Err(e) => {
                let msg = if e == "Cancelled" { "Install cancelled.".to_string() } else { e };
                log(format!("[install] ABORT: {msg}"));
                // The launch gate blocks Play and the update check shows UPDATE until a run succeeds
                store().set("modpackState", json!("failed"));
                complete(json!({ "success": false, "error": msg }));
            }
        }
    });
}

#[tauri::command]
pub fn install_cancel() {
    if INSTALLING.load(Ordering::SeqCst) { CANCEL.store(true, Ordering::SeqCst); }
}

// Runs one separate install step, refusing while another install runs
async fn exclusive<F: std::future::Future<Output = Result<Value, String>>>(f: F) -> Value {
    if INSTALLING.swap(true, Ordering::SeqCst) { return json!({ "success": false, "error": "An install is already running - cancel it first." }); }
    let r = f.await;
    INSTALLING.store(false, Ordering::SeqCst);
    r.unwrap_or_else(|e| json!({ "success": false, "error": e }))
}

// The game folder a step works on; with portable install on it is the copy, never the original
fn repair_game_path(what: &str) -> Result<PathBuf, String> {
    let game = if store().bool("isolatedGame") {
        if !isolated_game_ready() { return Err(format!("Install the game copy first - {what} belongs in the portable copy, not your original Skyrim.")); }
        isolated_game_dir()
    } else {
        PathBuf::from(effective_game_path())
    };
    if !game.join("SkyrimSE.exe").exists() { return Err("No game folder found - install the game copy or set a valid Skyrim path first.".into()); }
    Ok(game)
}

#[tauri::command]
pub async fn install_mo2_only(opts: Value) -> Value {
    exclusive(async {
        let sky = store().str("skyrimPath");
        if !sky.is_empty() && gamecopy::paths_overlap(Path::new(&sky), &mo2::root()) {
            return Err("The install location is inside your Skyrim folder - pick one outside it in Settings before repairing MO2.".into());
        }
        if proc::is_process_running("ModOrganizer.exe").await { return Err("Mod Organizer 2 is running - close it before repairing.".into()); }
        let report = |m: String| progress("download", m, 0, 0);
        if opts["force"].as_bool().unwrap_or(false) { mo2::reinstall(&report).await?; } else { mo2::ensure_installed(&report).await?; }
        if !(store().bool("isolatedGame") && !isolated_game_ready()) {
            let game = effective_game_path();
            if Path::new(&game).join("SkyrimSE.exe").exists() {
                let info = net::fetch_json(&basic::server_info_url(), &[]).await.ok();
                mo2::ensure_instance(&game, load_order(info.as_ref()).as_deref());
                mo2::register_nxm_handler();
                gamecopy::apply_forced_server_defaults(Path::new(&game));
            }
        }
        Ok(json!({ "success": true }))
    }).await
}

#[tauri::command]
pub async fn install_masters(opts: Value) -> Value {
    exclusive(async {
        let game = repair_game_path("the cleaned masters")?;
        let r = gamecopy::ensure_cleaned_masters(&game, opts["force"].as_bool().unwrap_or(false), true).await;
        match r.error { Some(e) => Err(e), None => Ok(json!({ "success": true, "cleaned": r.cleaned, "warning": r.warning })) }
    }).await
}

#[tauri::command]
pub async fn install_skse(opts: Value) -> Value {
    exclusive(async {
        let game = repair_game_path("SKSE")?;
        if opts["force"].as_bool().unwrap_or(false) {
            let _ = fs::remove_file(mo2::downloads_dir().join(mo2::skse_source_for(&game.to_string_lossy()).file_name));
            store().set("installedRootHash", json!(""));
        }
        install_skse_into_root(&game).await?;
        Ok(json!({ "success": true }))
    }).await
}

#[tauri::command]
pub async fn game_create_isolated(base_dir: Option<String>, opts: Value) -> Value {
    exclusive(async {
        let base = gamecopy::create_isolated(base_dir, opts["force"].as_bool().unwrap_or(false)).await?;
        Ok(json!({ "success": true, "dir": base.to_string_lossy() }))
    }).await
}

// Tells whether a Data-relative file is in the real Data or, under MO2, in any mod folder
pub fn data_file_exists(game: &Path, via_mo2: bool, rel: &str) -> bool {
    if mo2::join_rel(&game.join("Data"), rel).exists() { return true; }
    via_mo2 && fs::read_dir(mo2::mods_dir()).into_iter().flatten().flatten().any(|e| mo2::join_rel(&e.path(), rel).exists())
}

pub const REQUIRED_FILES: [&str; 3] = [CLIENT_SCRIPT, "SKSE/Plugins/SkyrimPlatform.dll", "SKSE/Plugins/MpClientPlugin.dll"];

pub fn preloader_present(game: &Path) -> bool {
    gamecopy::PRELOADER_DLLS.iter().any(|f| game.join(f).exists())
}

// The released client version, from the backend's versions.json
async fn client_version() -> Option<String> {
    net::fetch_json(&format!("{}/api/version", net::api_url()), &[]).await.ok()?["client"].as_str().filter(|v| !v.is_empty()).map(String::from)
}

// Update probe for the Play button: the backend's client files version against the installed one
#[tauri::command]
pub async fn files_update_check() -> Value {
    let Some(version) = client_version().await else { return json!({ "ok": false, "updateAvailable": false }) };
    let game = effective_game_path();
    let via_mo2 = store().bool("mo2Enabled");
    let present = !game.is_empty() && REQUIRED_FILES.iter().all(|f| data_file_exists(Path::new(&game), via_mo2, f)) && preloader_present(Path::new(&game));
    let failed = via_mo2 && store().str("modpackState") == "failed";
    json!({ "ok": true, "updateAvailable": version != store().str("filesVersion") || !present || failed, "serverVersion": version })
}

#[cfg(test)]
mod tests {
    // Expands the backend's compiled manifest when one is on this machine
    #[test]
    fn expands_the_compiled_manifest() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../skymp5-backend/data/manifest.json");
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let m = super::expand_manifest(&serde_json::from_str(&text).unwrap());
        let mods = m["mods"].as_array().unwrap();
        let mut seen = std::collections::HashSet::new();
        let mut files = 0;
        for md in mods {
            for f in md["files"].as_array().unwrap() {
                files += 1;
                assert!(seen.insert(format!("{}|{}", md["name"], f["to"])), "duplicate {} {}", md["name"], f["to"]);
                let key = f["archive"].as_str().unwrap();
                assert!(m["archives"].as_array().unwrap().iter().any(|a| a["id"] == key), "no archive {key}");
            }
        }
        assert!(files > 1000 && !m["order"].as_array().unwrap().is_empty() && !m["plugins"].as_array().unwrap().is_empty());
        println!("mods {} files {} archives {} root {}", mods.len(), files, m["archives"].as_array().unwrap().len(), m["root"].as_array().unwrap().len());
    }
}
