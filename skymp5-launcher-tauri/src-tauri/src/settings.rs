// Settings tab: graphics in the MO2 profile inis, the FOV, and both hotkey sets
use crate::basic::find_original_prefs_ini;
use crate::ini::{self, Edits};
use crate::{effective_game_path, log, proc, store};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub const PROFILE: &str = "Alduinak";

pub fn profile_dir() -> PathBuf {
    crate::base_dir().join("profiles").join(PROFILE)
}

pub fn skyrim_prefs_path() -> PathBuf {
    profile_dir().join("skyrimprefs.ini")
}

fn profile_ini(name: &str) -> PathBuf {
    profile_dir().join(name)
}

// The file MO2 seeds a missing profile ini from: the player's own, and for Skyrim.ini else the game's default
fn profile_ini_seed(name: &str) -> Option<PathBuf> {
    let own = find_original_prefs_ini().and_then(|p| p.parent().map(|d| d.join(name)));
    let game = effective_game_path();
    let default = (name == "skyrim.ini" && !game.is_empty()).then(|| Path::new(&game).join("Skyrim_Default.ini"));
    [own, default].into_iter().flatten().find(|f| f.exists())
}

fn profile_ini_in_effect(name: &str) -> Option<PathBuf> {
    let p = profile_ini(name);
    if p.exists() { Some(p) } else { profile_ini_seed(name) }
}

// Seeds a missing profile ini so a minimal one never hides the player's settings
pub fn ensure_profile_ini(name: &str) -> std::io::Result<PathBuf> {
    let dest = profile_ini(name);
    if !dest.exists() {
        if let Some(src) = profile_ini_seed(name) {
            std::fs::create_dir_all(dest.parent().unwrap())?;
            std::fs::copy(src, &dest)?;
        }
    }
    Ok(dest)
}

pub fn edits(pairs: &[(&str, &[(&str, &str)])]) -> Edits {
    pairs.iter().map(|(s, kv)| (s.to_string(), kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())).collect()
}

// The engine reads FOV from Skyrim.ini [Display], and SkyrimCustom.ini loads after it
const FOV_KEYS: [&str; 2] = ["fDefaultWorldFOV", "fDefault1stPersonFOV"];
const FOV_INIS: [&str; 2] = ["skyrimcustom.ini", "skyrim.ini"];
const FOV_DEFAULT: f64 = 80.0;

fn clamp_fov(v: &Value) -> Option<i64> {
    let n = match v { Value::Number(n) => n.as_f64()?, Value::String(s) => s.parse().ok()?, _ => return None };
    n.is_finite().then(|| (n.round() as i64).clamp(60, 140))
}

fn fov_in_effect() -> f64 {
    FOV_INIS.iter().filter_map(|n| profile_ini_in_effect(n)).map(|f| ini::read(&f))
        .find_map(|i| ini::get(&i, "Display", FOV_KEYS[0]).and_then(|v| v.parse::<f64>().ok()))
        .unwrap_or(FOV_DEFAULT)
}

// The slider value once moved, else the one the inis give; launches copy the stored one into the client settings
pub fn launcher_fov() -> i64 {
    clamp_fov(&store().get("fov")).or_else(|| clamp_fov(&json!(fov_in_effect()))).unwrap_or(80)
}

// Stores a moved slider value, and writes both profile FOV keys when the value differs from the one in effect
pub fn save_fov(v: &Value) -> std::io::Result<()> {
    let Some(fov) = clamp_fov(v) else { return Ok(()) };
    if fov != launcher_fov() { store().set("fov", json!(fov)); }
    if !skyrim_prefs_path().exists() || fov == fov_in_effect().round() as i64 { return Ok(()); }
    let val = format!("{fov}.0000");
    let e = edits(&[("Display", &[(FOV_KEYS[0], val.as_str()), (FOV_KEYS[1], val.as_str())])]);
    ini::write(&ensure_profile_ini(FOV_INIS[1])?, &e)?;
    if let Some(custom) = profile_ini_in_effect(FOV_INIS[0]) {
        let i = ini::read(&custom);
        if FOV_KEYS.iter().any(|k| ini::get(&i, "Display", k).is_some()) { ini::write(&ensure_profile_ini(FOV_INIS[0])?, &e)?; }
    }
    Ok(())
}

// Server hotkeys live in the Skyrim Platform client settings file
pub fn client_settings_path() -> PathBuf {
    Path::new(&effective_game_path()).join("Data").join("Platform").join("Plugins").join("skymp5-client-settings.txt")
}

pub fn read_client_settings() -> Map<String, Value> {
    std::fs::read_to_string(client_settings_path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

// The in-game chat settings the client persists: "//" + JSON with fov and fovLauncher
fn read_chat_settings() -> Map<String, Value> {
    let p = Path::new(&effective_game_path()).join("Data").join("Platform").join("PluginsNoLoad").join("chat-settings-no-load.js");
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches("//")).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

// Takes the in-game chat FOV into the slider when its fovLauncher stamp equals the stored slider value
pub fn adopt_chat_fov() {
    let c = read_chat_settings();
    let Some(chat) = c.get("fov").and_then(clamp_fov) else { return };
    let stamp = c.get("fovLauncher").and_then(clamp_fov).unwrap_or(0);
    let mine = clamp_fov(&store().get("fov")).unwrap_or(0);
    if stamp != mine || chat == launcher_fov() { return; }
    match save_fov(&json!(chat)) {
        Ok(_) => log(format!("[fov] adopted in-game value {chat}")),
        Err(e) => log(format!("[fov] adopt failed: {e}")),
    }
}

// Graphics dropdown -> level -> SkyrimPrefs.ini edits, from the game's own Low/Medium/High/Ultra.ini presets
type Level = (&'static str, &'static [(&'static str, &'static [(&'static str, &'static str)])]);
const GFX_LEVELS: &[(&str, &[Level])] = &[
    ("texQuality", &[
        ("high", &[("Display", &[("iTexMipMapSkip", "0")])]),
        ("medium", &[("Display", &[("iTexMipMapSkip", "1")])]),
        ("low", &[("Display", &[("iTexMipMapSkip", "2")])]),
    ]),
    ("aa", &[
        ("taa", &[("Display", &[("bUseTAA", "1"), ("bFXAAEnabled", "0")])]),
        ("fxaa", &[("Display", &[("bUseTAA", "0"), ("bFXAAEnabled", "1")])]),
        ("off", &[("Display", &[("bUseTAA", "0"), ("bFXAAEnabled", "0")])]),
    ]),
    ("shadowQuality", &[
        ("ultra", &[("Display", &[("iShadowMapResolution", "4096"), ("fShadowDistance", "10000")])]),
        ("high", &[("Display", &[("iShadowMapResolution", "2048"), ("fShadowDistance", "8000")])]),
        ("medium", &[("Display", &[("iShadowMapResolution", "2048"), ("fShadowDistance", "3000")])]),
        ("low", &[("Display", &[("iShadowMapResolution", "1024"), ("fShadowDistance", "3000")])]),
    ]),
    ("decals", &[
        ("high", &[("Decals", &[("bDecals", "1"), ("bSkinnedDecals", "1"), ("uMaxDecals", "1000"), ("uMaxSkinDecals", "100"), ("iMaxDecalsPerFrame", "100"), ("iMaxSkinDecalsPerFrame", "25")])]),
        ("medium", &[("Decals", &[("bDecals", "1"), ("bSkinnedDecals", "1"), ("uMaxDecals", "100"), ("uMaxSkinDecals", "35"), ("iMaxDecalsPerFrame", "10"), ("iMaxSkinDecalsPerFrame", "3")])]),
        ("off", &[("Decals", &[("bDecals", "0"), ("bSkinnedDecals", "0"), ("uMaxDecals", "0"), ("uMaxSkinDecals", "0"), ("iMaxDecalsPerFrame", "0"), ("iMaxSkinDecalsPerFrame", "0")])]),
    ]),
    ("godrays", &[
        ("high", &[("Display", &[("bVolumetricLightingEnable", "1"), ("iVolumetricLightingQuality", "2")])]),
        ("medium", &[("Display", &[("bVolumetricLightingEnable", "1"), ("iVolumetricLightingQuality", "1")])]),
        ("low", &[("Display", &[("bVolumetricLightingEnable", "1"), ("iVolumetricLightingQuality", "0")])]),
        ("off", &[("Display", &[("bVolumetricLightingEnable", "0")])]),
    ]),
    ("distantDetail", &[
        ("ultra", &[("TerrainManager", &[("fTreeLoadDistance", "75000"), ("fBlockLevel0Distance", "60000"), ("fBlockLevel1Distance", "90000"), ("fBlockMaximumDistance", "250000"), ("fSplitDistanceMult", "1.5")]), ("Display", &[("fMeshLODLevel1FadeDist", "999999"), ("fMeshLODLevel2FadeDist", "999999")])]),
        ("high", &[("TerrainManager", &[("fTreeLoadDistance", "75000"), ("fBlockLevel0Distance", "35000"), ("fBlockLevel1Distance", "70000"), ("fBlockMaximumDistance", "250000"), ("fSplitDistanceMult", "1.5")]), ("Display", &[("fMeshLODLevel1FadeDist", "999999"), ("fMeshLODLevel2FadeDist", "999999")])]),
        ("medium", &[("TerrainManager", &[("fTreeLoadDistance", "75000"), ("fBlockLevel0Distance", "20000"), ("fBlockLevel1Distance", "32000"), ("fBlockMaximumDistance", "100000"), ("fSplitDistanceMult", "1.1")]), ("Display", &[("fMeshLODLevel1FadeDist", "6000"), ("fMeshLODLevel2FadeDist", "3000")])]),
        ("low", &[("TerrainManager", &[("fTreeLoadDistance", "12500"), ("fBlockLevel0Distance", "15000"), ("fBlockLevel1Distance", "25000"), ("fBlockMaximumDistance", "100000"), ("fSplitDistanceMult", "0.5")]), ("Display", &[("fMeshLODLevel1FadeDist", "4000"), ("fMeshLODLevel2FadeDist", "1600")])]),
    ]),
    ("objectFade", &[
        ("high", &[("LOD", &[("fLODFadeOutMultObjects", "9"), ("fLODFadeOutMultActors", "9"), ("fLODFadeOutMultItems", "6")])]),
        ("medium", &[("LOD", &[("fLODFadeOutMultObjects", "7"), ("fLODFadeOutMultActors", "7"), ("fLODFadeOutMultItems", "3")])]),
        ("low", &[("LOD", &[("fLODFadeOutMultObjects", "5"), ("fLODFadeOutMultActors", "5"), ("fLODFadeOutMultItems", "1.5")])]),
    ]),
];
// Graphics checkbox -> the (section, key) pairs it sets to 1 or 0
const GFX_FLAGS: &[(&str, &[(&str, &str)])] = &[
    ("ssr", &[("Display", "bScreenSpaceReflectionEnabled")]),
    ("ao", &[("Display", "bSAOEnable")]),
    ("precip", &[("Display", "bUsePrecipitationOcclusion")]),
    ("snow", &[("Display", "bEnableImprovedSnow")]),
    ("lensFlare", &[("Imagespace", "bLensFlare"), ("Display", "bIBLFEnable")]),
    ("hdr64", &[("Display", "bUse64bitsHDRRenderTarget")]),
];

fn merge(into: &mut Edits, section: &str, key: &str, value: &str) {
    match into.iter_mut().find(|(s, _)| s.eq_ignore_ascii_case(section)) {
        Some((_, kv)) => {
            kv.retain(|(k, _)| !k.eq_ignore_ascii_case(key));
            kv.push((key.into(), value.into()));
        }
        None => into.push((section.into(), vec![(key.into(), value.into())])),
    }
}

#[tauri::command]
pub fn graphics_load() -> Value {
    adopt_chat_fov();
    let p = skyrim_prefs_path();
    let data = ini::read(&p);
    let orig = find_original_prefs_ini().map(|f| ini::read(&f)).unwrap_or_default();
    // Profile ini first, then the player's own My Games ini
    let val = |s: &str, k: &str| ini::get(&data, s, k).or_else(|| ini::get(&orig, s, k)).cloned();
    let same = |a: &Option<String>, b: &str| a.as_ref().and_then(|x| x.parse::<f64>().ok()).is_some_and(|x| Some(x) == b.parse::<f64>().ok());
    let full = ini::get(&data, "Display", "bFull Screen").map(|v| v == "1").unwrap_or(false);
    let has_mode = ini::get(&data, "Display", "bFull Screen").is_some() || ini::get(&data, "Display", "bBorderless").is_some();
    let borderless = if has_mode { ini::get(&data, "Display", "bBorderless").map(|v| v == "1").unwrap_or(false) } else { true };
    let mut out = json!({
        "ok": true,
        "path": p.to_string_lossy(),
        "exists": p.exists(),
        "windowMode": if full { "fullscreen" } else if borderless { "borderless" } else { "windowed" },
        "width": val("Display", "iSize W").unwrap_or_else(|| "1920".into()),
        "height": val("Display", "iSize H").unwrap_or_else(|| "1080".into()),
        "invertY": val("Controls", "bInvertYValues").as_deref() == Some("1"),
        "fov": launcher_fov(),
    });
    // The level whose keys the inis match best; the first level wins a tie
    for (option, levels) in GFX_LEVELS {
        let mut best = levels[0].0;
        let mut best_score = -1.0;
        for (name, sections) in *levels {
            let pairs: Vec<(&str, &str, &str)> = sections.iter().flat_map(|(s, kv)| kv.iter().map(move |(k, v)| (*s, *k, *v))).collect();
            let score = pairs.iter().filter(|(s, k, v)| same(&val(s, k), v)).count() as f64 / pairs.len() as f64;
            if score > best_score { best = name; best_score = score; }
        }
        out[*option] = json!(best);
    }
    for (flag, pairs) in GFX_FLAGS {
        out[*flag] = json!(val(pairs[0].0, pairs[0].1).as_deref() != Some("0"));
    }
    out
}

#[tauri::command]
pub fn graphics_save(g: Value) -> Value {
    let s = |k: &str| g.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut e: Edits = vec![];
    match s("windowMode").as_str() {
        "fullscreen" => { merge(&mut e, "Display", "bFull Screen", "1"); merge(&mut e, "Display", "bBorderless", "0"); }
        "borderless" => { merge(&mut e, "Display", "bFull Screen", "0"); merge(&mut e, "Display", "bBorderless", "1"); }
        "windowed" => { merge(&mut e, "Display", "bFull Screen", "0"); merge(&mut e, "Display", "bBorderless", "0"); }
        _ => {}
    }
    if !s("width").is_empty() { merge(&mut e, "Display", "iSize W", &s("width")); }
    if !s("height").is_empty() { merge(&mut e, "Display", "iSize H", &s("height")); }
    merge(&mut e, "Controls", "bInvertYValues", if g.get("invertY").and_then(|v| v.as_bool()).unwrap_or(false) { "1" } else { "0" });
    for (option, levels) in GFX_LEVELS {
        if let Some((_, sections)) = levels.iter().find(|(n, _)| *n == s(option)) {
            for (sec, kv) in *sections { for (k, v) in *kv { merge(&mut e, sec, k, v); } }
        }
    }
    for (flag, pairs) in GFX_FLAGS {
        if let Some(on) = g.get(*flag).and_then(|v| v.as_bool()) {
            for (sec, k) in *pairs { merge(&mut e, sec, k, if on { "1" } else { "0" }); }
        }
    }
    let result = ini::write(&skyrim_prefs_path(), &e).and_then(|_| save_fov(g.get("fov").unwrap_or(&Value::Null)));
    match result {
        Ok(_) => json!({ "ok": true, "path": skyrim_prefs_path().to_string_lossy() }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

#[tauri::command]
pub fn graphics_save_fov(v: Value) -> Value {
    match save_fov(&v) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => { log(format!("[graphics] could not save the FOV: {e}")); json!({ "ok": false, "error": e.to_string() }) }
    }
}

// hotkeys field -> skymp5-client settings key; chatFocusKeyCodes is the one list-valued hotkey
const CLIENT_HOTKEY_KEYS: [(&str, &str); 5] = [
    ("freeCursor", "freeCursorKeyCode"), ("voicePtt", "voicePushToTalkKeyCode"),
    ("hideUi", "hideUiKeyCode"), ("altInteract", "altInteractKeyCode"), ("emoteWheel", "emoteWheelKeyCode"),
];
// Hotkeys saved while the game runs wait here for the next launch, as SkyrimPlatform reloads every plugin when its folder changes
const PENDING_HOTKEYS: &str = "pendingClientHotkeys";

fn client_settings_with_pending() -> Map<String, Value> {
    let mut c = read_client_settings();
    if let Some(p) = store().get(PENDING_HOTKEYS).as_object() { c.extend(p.clone()); }
    c
}

#[tauri::command]
pub fn hotkeys_load() -> Value {
    let c = client_settings_with_pending();
    let mut out = json!({
        "ok": true,
        "path": client_settings_path().to_string_lossy(),
        "exists": client_settings_path().exists(),
        "chatFocus": c.get("chatFocusKeyCodes").filter(|v| v.is_array()).cloned().unwrap_or(Value::Null),
    });
    for (field, key) in CLIENT_HOTKEY_KEYS {
        out[field] = c.get(key).filter(|v| v.is_number()).cloned().unwrap_or(Value::Null);
    }
    // Interact / Menus cannot be unbound, so a stored 0 shows the X default
    if out["altInteract"] == json!(0) { out["altInteract"] = Value::Null; }
    out
}

#[tauri::command]
pub async fn hotkeys_save(h: Value) -> Value {
    let mut c = client_settings_with_pending();
    if let Some(list) = h.get("chatFocus").and_then(|v| v.as_array()) {
        c.insert("chatFocusKeyCodes".into(), Value::Array(list.iter().filter(|n| n.is_number()).cloned().collect()));
    }
    for (field, key) in CLIENT_HOTKEY_KEYS {
        if let Some(n) = h.get(field).and_then(|v| v.as_i64()) {
            // Interact / Menus cannot be unbound, so a 0 keeps the stored key
            if field != "altInteract" || n > 0 { c.insert(key.into(), json!(n)); }
        }
    }
    let p = client_settings_path();
    if proc::game_running_or_starting().await {
        let keys = ["chatFocusKeyCodes"].into_iter().chain(CLIENT_HOTKEY_KEYS.iter().map(|(_, k)| *k));
        let pending: Map<String, Value> = keys.filter_map(|k| c.get(k).map(|v| (k.to_string(), v.clone()))).collect();
        store().set(PENDING_HOTKEYS, Value::Object(pending));
        return json!({ "ok": true, "path": p.to_string_lossy(), "deferred": true });
    }
    let result = std::fs::create_dir_all(p.parent().unwrap()).and_then(|_| std::fs::write(&p, serde_json::to_string_pretty(&Value::Object(c)).unwrap()));
    match result {
        Ok(_) => { store().delete(PENDING_HOTKEYS); json!({ "ok": true, "path": p.to_string_lossy() }) }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

// Game hotkeys edit the keyboard and mouse columns of the game's controlmap.txt; mouse button n is 256 + n
pub const GAME_HOTKEY_EVENTS: [&str; 24] = [
    "Forward", "Back", "Strafe Left", "Strafe Right", "Left Attack/Block", "Right Attack/Block",
    "Activate", "Ready Weapon", "Tween Menu", "Toggle POV", "Jump", "Sprint", "Shout", "Sneak",
    "Run", "Toggle Always Run", "Auto-Move", "Favorites", "Journal", "Pause",
    "Quick Inventory", "Quick Magic", "Quick Stats", "Quick Map",
];
const MOUSE_DIK: i64 = 256;

pub fn controlmap_path() -> Option<PathBuf> {
    let gp = effective_game_path();
    (!gp.is_empty()).then(|| Path::new(&gp).join("Data").join("Interface").join("Controls").join("PC").join("controlmap.txt"))
}

// The game saves in-game rebinds to ControlMap_Custom.txt in its working directory, the game root
fn controlmap_custom_path() -> Option<PathBuf> {
    let gp = effective_game_path();
    (!gp.is_empty()).then(|| Path::new(&gp).join("ControlMap_Custom.txt"))
}

pub fn controlmap_seed() -> PathBuf {
    crate::resource_dir().join("controlmap.txt")
}

fn read_controlmap_text() -> (String, bool) {
    if let Some(p) = controlmap_path().filter(|p| p.exists()) {
        return (std::fs::read_to_string(p).unwrap_or_default(), true);
    }
    (std::fs::read_to_string(controlmap_seed()).unwrap_or_default(), false)
}

fn event_re(ev: &str) -> regex::Regex {
    regex::Regex::new(&format!(r"(?m)^({}[ \t]+)(\S+)([ \t]+)(\S+)", regex::escape(ev))).unwrap()
}

// The event's keyboard and mouse columns, from its first line
fn event_columns(text: &str, ev: &str) -> Option<(String, String)> {
    let c = event_re(ev).captures(text)?;
    Some((c[2].to_string(), c[4].to_string()))
}

// Rewrites an event's keyboard and mouse columns, keeping the line's other fields and spacing
fn set_event_columns(text: &str, ev: &str, kb: &str, ms: &str) -> String {
    event_re(ev).replacen(text, 1, |c: &regex::Captures| format!("{}{kb}{}{ms}", &c[1], &c[3])).into_owned()
}

// Line index of an event in the Main Gameplay context, the id ControlMap_Custom.txt entries use
fn gameplay_event_index(text: &str, ev: &str) -> Option<u8> {
    let mut i = 0u8;
    for line in text.split('\n') {
        if line.starts_with("//") { continue; }
        if line.is_empty() || line.starts_with(['\t', ' ', '\r']) { return None; }
        if line.split('\t').next() == Some(ev) { return Some(i); }
        i = i.wrapping_add(1);
    }
    None
}

// Keyboard and mouse entries of ControlMap_Custom.txt: per device a [2, length hi, length lo] header, then [event index, 4-byte big-endian key] entries
fn custom_entries(buf: &[u8]) -> Vec<(usize, u8, usize)> {
    let mut out = vec![];
    let mut off = 0usize;
    for dev in 0..2 {
        if off + 3 > buf.len() { break; }
        let end = (off + (((buf[off + 1] as usize) << 8) | buf[off + 2] as usize)).min(buf.len());
        if end < off + 3 { break; }
        if buf[off] == 2 {
            let mut e = off + 3;
            while e + 5 <= end { out.push((dev, buf[e], e + 1)); e += 5; }
        }
        off = end;
    }
    out
}

fn binding(kb: &str, mouse: &str) -> Option<i64> {
    let hex = |s: &str| i64::from_str_radix(s.trim_start_matches("0x").trim_start_matches("0X"), 16).ok();
    if let Some(m) = hex(mouse).filter(|m| (0..8).contains(m)) { return Some(MOUSE_DIK + m); }
    hex(kb).filter(|k| *k > 0 && *k < 0xff)
}

// The binding the game uses: a ControlMap_Custom.txt entry overrides the controlmap.txt column
fn hotkey_binding(text: &str, ev: &str, custom: &[u8], entries: &[(usize, u8, usize)]) -> Option<i64> {
    let (kb, ms) = event_columns(text, ev)?;
    let mut cols = [kb, ms];
    if let Some(idx) = gameplay_event_index(text, ev) {
        for (dev, index, at) in entries {
            if *index == idx { cols[*dev] = format!("{:x}", u32::from_be_bytes(custom[*at..*at + 4].try_into().unwrap())); }
        }
    }
    binding(&cols[0], &cols[1])
}

#[tauri::command]
pub fn game_hotkeys_load() -> Value {
    let (text, exists) = read_controlmap_text();
    let custom = controlmap_custom_path().and_then(|p| std::fs::read(p).ok()).unwrap_or_default();
    let entries = custom_entries(&custom);
    let keys: Map<String, Value> = GAME_HOTKEY_EVENTS.iter().map(|ev| (ev.to_string(), json!(hotkey_binding(&text, ev, &custom, &entries)))).collect();
    json!({ "ok": true, "path": controlmap_path().map(|p| p.to_string_lossy().to_string()), "exists": exists, "keys": keys })
}

#[tauri::command]
pub fn game_hotkeys_save(keys: Map<String, Value>) -> Value {
    let Some(p) = controlmap_path() else { return json!({ "ok": false, "error": "Skyrim path is not configured yet" }) };
    let (mut text, _) = read_controlmap_text();
    let custom_path = controlmap_custom_path();
    let mut custom = custom_path.as_ref().and_then(|p| std::fs::read(p).ok()).unwrap_or_default();
    let entries = custom_entries(&custom);
    let mut custom_changed = false;
    for (ev, code) in &keys {
        let Some(code) = code.as_i64() else { continue };
        let mouse = (MOUSE_DIK..MOUSE_DIK + 8).contains(&code);
        if !GAME_HOTKEY_EVENTS.contains(&ev.as_str()) || !(mouse || (code > 0 && code < 0xff)) { continue; }
        // One binding per action: the other column goes unbound
        let kb = if mouse { "0xff".to_string() } else { format!("0x{code:x}") };
        let ms = if mouse { format!("0x{:x}", code - MOUSE_DIK) } else { "0xff".to_string() };
        if Some(code) != hotkey_binding(&text, ev, &custom, &entries) {
            if let Some(idx) = gameplay_event_index(&text, ev) {
                for (dev, index, at) in &entries {
                    if *index == idx {
                        let v = u32::from_str_radix((if *dev == 1 { &ms } else { &kb }).trim_start_matches("0x"), 16).unwrap_or(0xff);
                        custom[*at..*at + 4].copy_from_slice(&v.to_be_bytes());
                        custom_changed = true;
                    }
                }
            }
        }
        text = set_event_columns(&text, ev, &kb, &ms);
    }
    let result = std::fs::create_dir_all(p.parent().unwrap()).and_then(|_| std::fs::write(&p, &text)).and_then(|_| {
        if custom_changed { if let Some(cp) = &custom_path { std::fs::write(cp, &custom)?; } }
        Ok(())
    });
    match result {
        Ok(_) => json!({ "ok": true, "path": p.to_string_lossy() }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}
