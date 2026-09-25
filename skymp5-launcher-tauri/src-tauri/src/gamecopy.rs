// The game side of an install: the portable copy, vanilla integrity, cleaned masters, Creation Club files and defaults
use crate::basic::find_original_prefs_ini;
use crate::settings::{ensure_profile_ini, profile_dir, skyrim_prefs_path};
use crate::{game, ini, isolated_game_dir, isolated_game_ready, log, mo2, net, resource_dir, send, store};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const NEVER_LAUNCHED_ERROR: &str = "You must run vanilla skyrim at least once.";
pub const CREATIONS_STAMP: &str = "creations-complete.json";
pub const PRELOADER_DLLS: [&str; 2] = ["d3dx9_42.dll", "winhttp.dll"];
pub const VANILLA_MASTERS: [&str; 6] = ["skyrim.esm", "update.esm", "dawnguard.esm", "hearthfires.esm", "dragonborn.esm", "_resourcepack.esl"];

// Vanilla root files by store edition; only those present get copied. Skyrim.ccc is written empty instead
// so the engine never shows the Creation Club announcement over the main menu.
pub const VANILLA_ROOT_FILES: [&str; 12] = [
    "SkyrimSE.exe", "SkyrimSELauncher.exe", "bink2w64.dll", "ControlMap_Custom.txt",
    "steam_api64.dll", "Galaxy64.dll", "goggame-1711230643.hashdb", "goggame-1711230643.info",
    "High.ini", "Medium.ini", "Low.ini", "Ultra.ini",
];
const VANILLA_ROOT_EXTRA: [&str; 2] = ["Skyrim_Default.ini", "Skyrim/SkyrimPrefs.ini"];

pub fn progress(phase: &str, file: impl Into<String>, index: usize, total: usize) {
    send("install:progress", json!({ "phase": phase, "file": file.into(), "index": index, "total": total, "skipped": false }));
}

fn isolated_progress(msg: impl Into<String>) {
    send("isolated:progress", msg.into());
}

// True if either path is the same as, or nested inside, the other; links compare as their targets
pub fn paths_overlap(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let r = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let s = r.to_string_lossy().trim_start_matches(r"\\?\").trim_end_matches(['\\', '/']).to_lowercase();
        format!("{s}\\")
    };
    let (na, nb) = (norm(a), norm(b));
    na.starts_with(&nb) || nb.starts_with(&na)
}

fn is_vanilla_data_file(name: &str) -> bool {
    let l = name.to_lowercase();
    if l.starts_with("cc") { return false; }
    if VANILLA_MASTERS.contains(&l.as_str()) { return true; }
    if let Some(base) = l.strip_suffix(".bsa") {
        return l.starts_with("skyrim - ") || l == "marketplacetextures.bsa" || l == "_resourcepack.bsa" || base == "skyrim"
            || VANILLA_MASTERS.contains(&format!("{base}.esm").as_str()) || VANILLA_MASTERS.contains(&format!("{base}.esl").as_str());
    }
    false
}

// The vanilla files of a source install, as game-root-relative forward-slash paths: what Copy Game copies and the integrity check verifies
pub fn vanilla_jobs(src: &Path) -> Vec<String> {
    let mut jobs: Vec<String> = VANILLA_ROOT_FILES.iter().chain(VANILLA_ROOT_EXTRA.iter()).filter(|n| mo2::join_rel(src, n).exists()).map(|s| s.to_string()).collect();
    let data = src.join("Data");
    for e in fs::read_dir(&data).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if e.path().is_file() && is_vanilla_data_file(&n) { jobs.push(format!("Data/{n}")); }
    }
    for e in fs::read_dir(data.join("Video")).into_iter().flatten().flatten() {
        if e.path().is_file() { jobs.push(format!("Data/Video/{}", e.file_name().to_string_lossy())); }
    }
    // Localized installs keep vanilla strings loose; English keeps them in the BSAs
    let bases: Vec<String> = VANILLA_MASTERS.iter().map(|m| m.rsplit_once('.').unwrap().0.to_string()).collect();
    for e in fs::read_dir(data.join("Strings")).into_iter().flatten().flatten() {
        let l = e.file_name().to_string_lossy().to_lowercase();
        if e.path().is_file() && !l.starts_with("cc") && bases.iter().any(|b| l.starts_with(&format!("{b}_"))) {
            jobs.push(format!("Data/Strings/{}", e.file_name().to_string_lossy()));
        }
    }
    jobs
}

// SkyrimSE.exe is copied first, so only the marker written last proves a complete copy
pub fn game_copy_complete(dir: &Path) -> bool {
    dir.join("vanilla-copy-complete.json").exists()
}

async fn copy_game_dir(src: &Path, dst: &Path) -> Result<usize, String> {
    let jobs = vanilla_jobs(src);
    if !jobs.iter().any(|j| j.eq_ignore_ascii_case("Data/Skyrim.esm")) { return Err("Skyrim.esm not found in Data - is the Skyrim path correct?".into()); }
    let _ = fs::remove_file(dst.join("vanilla-copy-complete.json"));
    for (i, rel) in jobs.iter().enumerate() {
        let to = mo2::join_rel(dst, rel);
        if let Some(p) = to.parent() { let _ = fs::create_dir_all(p); }
        tokio::fs::copy(mo2::join_rel(src, rel), &to).await.map_err(|e| format!("Failed copying {rel}: {e}"))?;
        isolated_progress(format!("Copying vanilla game files… {}% ({}/{} files, {rel})", (i + 1) * 100 / jobs.len(), i + 1, jobs.len()));
    }
    let _ = fs::write(dst.join("Skyrim.ccc"), "");
    let _ = fs::write(dst.join("vanilla-copy-complete.json"), format!("{}\n", json!({ "files": jobs.len() })));
    log(format!("[isolated] copied {} vanilla file(s) to {}", jobs.len(), dst.display()));
    Ok(jobs.len())
}

// Cleaned master variant a file of this size already is, if any
fn cleaned_variant(name: &str, size: u64) -> Option<&'static MasterVariant> {
    MASTERS.iter().find(|m| m.name.eq_ignore_ascii_case(name)).and_then(|m| m.variants.iter().find(|v| v.dst_size == size))
}

// Vanilla files in the game copy that are missing, resized, or (exe, dlls, masters) differently hashed than the original install
async fn vanilla_mismatches(src: &Path, dir: &Path) -> Vec<String> {
    let mut bad = vec![];
    for rel in vanilla_jobs(src) {
        let from = mo2::join_rel(src, &rel);
        let to = mo2::join_rel(dir, &rel);
        let Ok(want) = fs::metadata(&from).map(|m| m.len()) else { continue };
        let have = fs::metadata(&to).map(|m| m.len()).ok();
        let name = rel.rsplit('/').next().unwrap_or(&rel);
        let cleaned = have.and_then(|h| cleaned_variant(name, h));
        if have != Some(want) && cleaned.is_none() { bad.push(rel); continue; }
        if !mo2::is_risky(&rel) { continue; }
        let got = mo2::sha256_file(&to).await.unwrap_or_default();
        let ok = match cleaned {
            Some(v) => v.dst_sha256.map_or(true, |s| s == got),
            None => mo2::hash_cached(&from).await.map(|h| h == got).unwrap_or(false),
        };
        if !ok { bad.push(rel); }
    }
    bad
}

pub struct Integrity { pub error: Option<String>, pub warning: Option<String>, pub repaired: usize }

// Portable copies are verified against the original install and repaired file by file; a real install is only checked for its masters
pub async fn ensure_vanilla_integrity(game_path: &Path) -> Integrity {
    let portable = store().bool("isolatedGame") && isolated_game_ready() && game_path == isolated_game_dir();
    if portable {
        let original = PathBuf::from(store().str("skyrimPath"));
        if !original.join("Data").join("Skyrim.esm").exists() { return Integrity { error: None, warning: None, repaired: 0 }; }
        let bad = vanilla_mismatches(&original, game_path).await;
        if bad.is_empty() { return Integrity { error: None, warning: None, repaired: 0 }; }
        log(format!("[integrity] repairing {} vanilla file(s): {}", bad.len(), bad.join(", ")));
        for (i, rel) in bad.iter().enumerate() {
            let to = mo2::join_rel(game_path, rel);
            if let Some(p) = to.parent() { let _ = fs::create_dir_all(p); }
            if let Err(e) = tokio::fs::copy(mo2::join_rel(&original, rel), &to).await {
                return Integrity { error: Some(format!("Vanilla file repair failed on {rel}: {e}")), warning: None, repaired: i };
            }
            progress("download", format!("Repairing vanilla game files… {}/{} ({rel})", i + 1, bad.len()), i + 1, bad.len());
        }
        return Integrity { error: None, warning: None, repaired: bad.len() };
    }
    let missing: Vec<&str> = VANILLA_MASTERS.iter().copied().filter(|m| *m != "_resourcepack.esl" && !game_path.join("Data").join(m).exists()).collect();
    let warning = (!missing.is_empty()).then(|| format!("Vanilla file check failed: {} missing from the game folder. Verify the game files in Steam/GOG Galaxy.", missing.join(", ")));
    Integrity { error: None, warning, repaired: 0 }
}

// Seeds the MO2 profile inis from the player's own before anything writes to them, then forces borderless on the fresh copy
pub fn seed_profile_prefs(skyrim: &Path) {
    if let Err(e) = ensure_profile_ini("skyrim.ini") { log(format!("[isolated] could not seed Skyrim.ini: {e}")); }
    let dest = skyrim_prefs_path();
    if dest.exists() { return; }
    let from = [Some(skyrim.join("Skyrim").join("SkyrimPrefs.ini")), find_original_prefs_ini()].into_iter().flatten().find(|p| p.exists());
    let Some(from) = from else { log("[isolated] no source SkyrimPrefs.ini found to seed"); return };
    let r = fs::create_dir_all(profile_dir()).and_then(|_| fs::copy(&from, &dest)).and_then(|_| {
        ini::write(&dest, &crate::settings::edits(&[("Display", &[("bFull Screen", "0"), ("bBorderless", "1")])]))
    });
    match r { Ok(_) => log(format!("[isolated] seeded profile SkyrimPrefs.ini from {}", from.display())), Err(e) => log(format!("[isolated] could not seed SkyrimPrefs.ini: {e}")) }
}

// Seeds the Wait-unbound controlmap when the game has none; a player's own map is never touched
pub fn apply_controlmap_override(game_path: &Path) {
    let dest = game_path.join("Data").join("Interface").join("Controls").join("PC").join("controlmap.txt");
    if dest.exists() { return; }
    let r = fs::create_dir_all(dest.parent().unwrap()).and_then(|_| fs::copy(crate::settings::controlmap_seed(), &dest));
    match r { Ok(_) => log(format!("[defaults] wrote controlmap override to {}", dest.display())), Err(e) => log(format!("[defaults] could not write controlmap override: {e}")) }
}

// Borderless once at first install, the controlmap, an empty Skyrim.ccc in the portable copy, and the MO2 profile ini defaults
pub fn apply_forced_server_defaults(game_path: &Path) {
    let via_mo2 = store().bool("mo2Enabled");
    if via_mo2 && !store().bool("forcedDefaultsApplied") {
        match ini::write(&skyrim_prefs_path(), &crate::settings::edits(&[("Display", &[("bFull Screen", "0"), ("bBorderless", "1")])])) {
            Ok(_) => { store().set("forcedDefaultsApplied", json!(true)); log("[defaults] forced borderless window mode into SkyrimPrefs.ini"); }
            Err(e) => log(format!("[defaults] could not write graphics defaults: {e}")),
        }
    }
    apply_controlmap_override(game_path);
    // Portable copies only: never blank the ccc of a player's real install
    if store().bool("isolatedGame") && game_path == isolated_game_dir() {
        let ccc = game_path.join("Skyrim.ccc");
        if fs::metadata(&ccc).map(|m| m.len() > 0).unwrap_or(true) { let _ = fs::write(&ccc, ""); }
    }
    if !via_mo2 { return; }
    // The Bethesda.net platform drives the "AE content available for download" prompt and the CC news
    if let Ok(dest) = ensure_profile_ini("skyrim.ini") {
        if ini::get(&ini::read(&dest), "Bethesda.net", "bEnablePlatform").map(String::as_str) != Some("0") {
            let _ = ini::write(&dest, &crate::settings::edits(&[("Bethesda.net", &[("bEnablePlatform", "0")])]));
        }
    }
    // MO2 only honors the profile inis the Settings tab edits when local settings are enabled
    let settings_ini = profile_dir().join("settings.ini");
    if ini::get(&ini::read(&settings_ini), "General", "LocalSettings").map(String::as_str) != Some("true") {
        let _ = ini::write(&settings_ini, &crate::settings::edits(&[("General", &[("LocalSettings", "true"), ("LocalSaves", "false")])]));
    }
}

// Two folders the client needs, or it crashes with code 2
pub fn ensure_client_dirs(game_path: &Path) {
    for d in ["PluginsDev", "PluginsNoLoad"] { let _ = fs::create_dir_all(game_path.join("Data").join("Platform").join(d)); }
}

pub struct MasterVariant { pub edition: &'static str, pub src_size: u64, pub dst_size: u64, pub patch: &'static str, pub patch_sha256: &'static str, pub dst_sha256: Option<&'static str> }
pub struct Master { pub name: &'static str, pub variants: &'static [MasterVariant] }

// Simple Cleaned Masters: xdelta patches from the store masters to cleaned ones; every size is unique per edition
pub const MASTERS: &[Master] = &[
    Master { name: "Update.esm", variants: &[
        MasterVariant { edition: "GOG", src_size: 18874185, dst_size: 17752650, patch: "Update_GOG.vcdiff", patch_sha256: "06b541edb30db432e228a047862bfce8f2fe5ff67cf29b35a72662a34207656f", dst_sha256: Some("655138032423ae6a9652ab5bfade2cb58bd2d1e9ed8012bad0133e021ba9ed0f") },
        MasterVariant { edition: "Steam", src_size: 18874041, dst_size: 17752506, patch: "Update_Steam.vcdiff", patch_sha256: "d5cd9e32d77353af249b9e5ae13b22e557283229c6d12627583287e1316c106a", dst_sha256: None },
    ] },
    Master { name: "Dawnguard.esm", variants: &[
        MasterVariant { edition: "GOG", src_size: 25885267, dst_size: 24469866, patch: "Dawnguard_GOG.vcdiff", patch_sha256: "056da52435faa591f75595b240c649bec98fc5251b2abb74579eeff8fc14e732", dst_sha256: Some("a17408743060559823dcc958c9fe94c9e70b90fbe6ef474d420585878b8ff1a0") },
        MasterVariant { edition: "Steam", src_size: 25885111, dst_size: 24469710, patch: "Dawnguard_Steam.vcdiff", patch_sha256: "4db3d05112eb757345b9458c8f368688f9566bd1bf3c4376d32a4578b57ffd0a", dst_sha256: None },
    ] },
    Master { name: "HearthFires.esm", variants: &[
        MasterVariant { edition: "GOG", src_size: 3978434, dst_size: 3652958, patch: "HearthFires_GOG.vcdiff", patch_sha256: "eb5a8db796e5f9b02703b093b861cdd0659f38de72d31a0327878d928a92c687", dst_sha256: Some("dcb2b593979a60b9ad511173d1ded23e4713d0287832492d5d4439d0383c7b29") },
        MasterVariant { edition: "Steam", src_size: 3977420, dst_size: 3651944, patch: "HearthFires_Steam.vcdiff", patch_sha256: "34c9cf0a87f18525374ea57a4962e46db072dbe29012beb43392ccab88092b80", dst_sha256: None },
    ] },
    Master { name: "Dragonborn.esm", variants: &[
        MasterVariant { edition: "GOG", src_size: 64663894, dst_size: 64240276, patch: "Dragonborn_GOG.vcdiff", patch_sha256: "3cac74263d7f3a2b9bdb31f5180f193c19f1fe58bd1bf6ddf58b50e2f031770d", dst_sha256: Some("df8ae7dc97ab8a453e2e083cc3cfcd1cb24ec42d14cd5b50e2df39e520b6f386") },
        MasterVariant { edition: "Steam", src_size: 64663863, dst_size: 64240244, patch: "Dragonborn_Steam.vcdiff", patch_sha256: "3383e0b564bf722e76a11f3a246f20937d736803c39a58e5c03419ac4fe94648", dst_sha256: None },
    ] },
    Master { name: "ccBGSSSE001-Fish.esm", variants: &[
        MasterVariant { edition: "Shared", src_size: 1425176, dst_size: 1192492, patch: "ccBGSSSE001-Fish.vcdiff", patch_sha256: "6d5955ba200bc6d1afcdf9eb0baa3134aa2ea65691d1f6bddf12196aea99d333", dst_sha256: Some("8bcf6f1f14404584f650fe95a461594b546e2898213d04ea969d6b24ce757288") },
    ] },
    Master { name: "ccBGSSSE025-AdvDSGS.esm", variants: &[
        MasterVariant { edition: "Shared", src_size: 812873, dst_size: 613611, patch: "ccBGSSSE025-AdvDSGS.vcdiff", patch_sha256: "8de092c469c65b6775b1708a16aa4f8a81ec8caa4e12aa472e8ebb8942cc0748", dst_sha256: Some("ca313e6ae5846c72fbe81a7aa1e0c1103378aa70bcfeb865ef1267508ab7da1d") },
    ] },
    Master { name: "ccQDRSSE001-SurvivalMode.esl", variants: &[
        MasterVariant { edition: "Shared", src_size: 240724, dst_size: 237701, patch: "ccQDRSSE001-SurvivalMode.vcdiff", patch_sha256: "bba4cec10a375a3931ad9a2b38caa815d40fbdda521460442a504bbe715152f2", dst_sha256: Some("cb7f09c86c7ac61f33afa4a0b2a1690daaf0780f5e608074c8517256f62edbf2") },
    ] },
];
// Folder earlier launchers and the standalone patcher kept original masters in
const BACKUP_DIR: &str = "Original ESMs backups";

// Downloads a cleaning patch once into the downloads folder, verified by sha256
async fn cleaned_master_patch(v: &MasterVariant) -> Result<PathBuf, String> {
    let dir = mo2::downloads_dir().join("cleaned-masters");
    let file = dir.join(v.patch);
    if file.exists() && mo2::sha256_file(&file).await.map(|h| h == v.patch_sha256).unwrap_or(false) { return Ok(file); }
    let _ = fs::create_dir_all(&dir);
    net::download_file(&format!("{}/files/cleaned-masters/{}", net::api_url(), v.patch), &file, &[], |_, _| {}).await?;
    if mo2::sha256_file(&file).await? != v.patch_sha256 {
        let _ = fs::remove_file(&file);
        return Err(format!("{} failed its checksum after download", v.patch));
    }
    Ok(file)
}

pub struct MastersResult { pub error: Option<String>, pub cleaned: usize, pub warning: Option<String> }

// Cleans the masters and Creation plugins in Data without keeping backups (Steam/GOG verify restores them); strict turns failures into errors
pub async fn ensure_cleaned_masters(game_path: &Path, force: bool, strict: bool) -> MastersResult {
    let portable = store().bool("isolatedGame") && game_path == isolated_game_dir();
    let data = game_path.join("Data");
    let original = PathBuf::from(store().str("skyrimPath"));
    let (mut unknown, mut failed, mut cleaned) = (vec![], vec![], 0);
    let xdelta = resource_dir().join("xdelta").join("xdelta3.exe");
    for (i, m) in MASTERS.iter().enumerate() {
        let file = data.join(m.name);
        let restore = original.join("Data").join(m.name);
        if force && portable && restore.exists() && file.exists() {
            if tokio::fs::copy(&restore, &file).await.is_ok() { log(format!("[masters] restored {} from {}", m.name, restore.display())); }
        }
        let Ok(size) = fs::metadata(&file).map(|md| md.len()) else { continue };
        if m.variants.iter().any(|v| v.dst_size == size) { continue; }
        let Some(v) = m.variants.iter().find(|v| v.src_size == size) else { unknown.push(format!("{} (size {size})", m.name)); continue };
        progress("download", format!("Cleaning masters… {}% ({}/{}, {} {})", i * 100 / MASTERS.len(), i + 1, MASTERS.len(), m.name, v.edition), i + 1, MASTERS.len());
        if !xdelta.exists() {
            let error = "xdelta3.exe is missing from the launcher install. Reinstall the launcher.".to_string();
            if strict { return MastersResult { error: Some(error), cleaned, warning: None }; }
            log(format!("[masters] {error}"));
            failed.push(m.name.to_string());
            break;
        }
        let tmp = PathBuf::from(format!("{}.alduinak-tmp", file.display()));
        let result = async {
            let patch = cleaned_master_patch(v).await?;
            let out = tokio::process::Command::new(&xdelta).args(["-d", "-f", "-s"]).arg(&file).arg(&patch).arg(&tmp).creation_flags(0x0800_0000).output().await.map_err(|e| e.to_string())?;
            if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
            let ok = fs::metadata(&tmp).map(|md| md.len() == v.dst_size).unwrap_or(false)
                && match v.dst_sha256 { Some(s) => mo2::sha256_file(&tmp).await? == s, None => true };
            if !ok { return Err("the patched file does not match the cleaned master".into()); }
            fs::rename(&tmp, &file).map_err(|e| e.to_string())
        }.await;
        if let Err(e) = result {
            let _ = fs::remove_file(&tmp);
            let error = format!("Could not clean {}: {e}", m.name);
            if strict { return MastersResult { error: Some(error), cleaned, warning: None }; }
            log(format!("[masters] {error}"));
            failed.push(m.name.to_string());
            continue;
        }
        cleaned += 1;
        log(format!("[masters] cleaned {} ({})", m.name, v.edition));
    }
    mo2::rmrf(&data.join(BACKUP_DIR));
    let mut w = vec![];
    if !unknown.is_empty() { w.push(format!("No cleaned-master patch for {}; they stay as shipped.", unknown.join(", "))); }
    if !failed.is_empty() { w.push(format!("Could not clean {}; they stay as shipped (see install.log, or use Clean Masters under Troubleshooting).", failed.join(", "))); }
    MastersResult { error: None, cleaned, warning: (!w.is_empty()).then(|| w.join(" ")) }
}

// Copies the manifest's Creation Club files from the player's own Skyrim install (never downloaded) into the game's Data
pub async fn ensure_creations(manifest: &Value, game_path: &Path) -> Result<Option<String>, String> {
    let c = &manifest["creations"];
    let files = c["files"].as_array().cloned().unwrap_or_default();
    if files.is_empty() { return Ok(None); }
    let portable = store().bool("isolatedGame") && game_path == isolated_game_dir();
    let source_root = if portable { PathBuf::from(store().str("skyrimPath")) } else { game_path.to_path_buf() };
    let search: Vec<String> = c["searchDirs"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(String::from)).collect();
    let dirs = mo2::creation_dirs(&source_root, &search);
    let stamp_path = game_path.join(CREATIONS_STAMP);
    let stamp: Value = fs::read_to_string(&stamp_path).ok().and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()).unwrap_or(Value::Null);
    let stamped: HashMap<String, Value> = if stamp["hash"] == c["hash"] {
        stamp["files"].as_array().into_iter().flatten().filter_map(|f| Some((f["name"].as_str()?.to_lowercase(), f.clone()))).collect()
    } else { HashMap::new() };
    let accepted = |f: &Value, size: u64, sha: &str| f["accept"].as_array().into_iter().flatten().any(|a| a["size"].as_u64() == Some(size) && a["sha256"].as_str().is_some_and(|s| s.eq_ignore_ascii_case(sha)));
    let mtime = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).map(|t| format!("{t:?}")).unwrap_or_default();
    let (mut done, mut missing, mut warnings) = (vec![], vec![], vec![]);
    for (i, f) in files.iter().enumerate() {
        let name = f["name"].as_str().unwrap_or("");
        let title = f["title"].as_str().unwrap_or(name);
        let to = mo2::join_rel(game_path, f["to"].as_str().unwrap_or(""));
        let size = fs::metadata(&to).map(|m| m.len()).ok();
        if let (Some(s), Some(prior)) = (size, stamped.get(&name.to_lowercase())) {
            if prior["size"].as_u64() == Some(s) && prior["mtime"].as_str() == Some(mtime(&to).as_str()) { done.push(prior.clone()); continue; }
        }
        if let Some(s) = size {
            progress("download", format!("Checking {title} ({name})…"), i, files.len());
            let sha = mo2::hash_cached(&to).await.unwrap_or_default();
            if accepted(f, s, &sha) { done.push(json!({ "name": name, "size": s, "mtime": mtime(&to), "sha256": sha })); continue; }
            log(format!("[creations] {name}: {} does not match the server copy (size {s}, sha256 {sha})", to.display()));
        }
        progress("download", format!("Looking for {title} ({name}) in your Skyrim install…"), i, files.len());
        let candidates: Vec<PathBuf> = dirs.iter().filter(|d| d.join(name) != to).cloned().collect();
        let (found, rejected) = mo2::locate_creation(f, &candidates).await;
        for r in rejected { log(format!("[creations] {name}: {} does not match the server copy (size {}, sha256 {})", r["path"].as_str().unwrap_or(""), r["size"], r["sha256"].as_str().unwrap_or(""))); }
        let Some((from, verified)) = found else {
            if let (Some(s), true) = (size, f["kind"] == "archive") {
                let sha = mo2::hash_cached(&to).await.unwrap_or_default();
                warnings.push(format!("{name} differs from the server copy (sha256 {sha}) and was kept"));
                done.push(json!({ "name": name, "size": s, "mtime": mtime(&to), "sha256": sha }));
                continue;
            }
            missing.push((title.to_string(), if size.is_some() { format!("{name}, whose copy in Data is a different version") } else { name.to_string() }));
            continue;
        };
        let sha = mo2::hash_cached(&from).await.unwrap_or_default();
        if !verified { warnings.push(format!("{name} at {} differs from the server copy (sha256 {sha}) and was used anyway", from.display())); }
        if let Some(p) = to.parent() { let _ = fs::create_dir_all(p); }
        // Our own quarantine of this install is moved back rather than copied
        if from.parent().is_some_and(|p| p == game_path.join(mo2::CC_QUARANTINE_DIR)) {
            fs::rename(&from, &to).map_err(|e| format!("Could not move {name} back from {}: {e}", from.display()))?;
        } else {
            let tmp = PathBuf::from(format!("{}.alduinak-tmp", to.display()));
            progress("download", format!("Copying {title} ({name}) from {}…", from.display()), i, files.len());
            let r = async {
                tokio::fs::copy(&from, &tmp).await.map_err(|e| e.to_string())?;
                if mo2::sha256_file(&tmp).await? != sha { return Err("the copy does not match its source".to_string()); }
                fs::rename(&tmp, &to).map_err(|e| e.to_string())
            }.await;
            if let Err(e) = r { let _ = fs::remove_file(&tmp); return Err(format!("Could not copy {name} from {}: {e}", from.display())); }
        }
        done.push(json!({ "name": name, "size": fs::metadata(&to).map(|m| m.len()).unwrap_or(0), "mtime": mtime(&to), "sha256": sha }));
    }
    if !missing.is_empty() {
        let mut by_title: Vec<(String, Vec<String>)> = vec![];
        for (t, n) in missing {
            match by_title.iter_mut().find(|(x, _)| *x == t) { Some((_, v)) => v.push(n), None => by_title.push((t, vec![n])) }
        }
        let list = by_title.iter().map(|(t, n)| format!("{t} ({})", n.join(", "))).collect::<Vec<_>>().join(", ");
        let where_ = if dirs.is_empty() { format!("{} (no Data folder found)", source_root.display()) } else { dirs.iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", ") };
        return Err(format!("Alduinak needs the free Creations included with Skyrim Special Edition 1.6 (no Anniversary Edition purchase needed): {list}. Not found in {where_}. Verify the game files in Steam (Properties > Installed Files > Verify integrity of game files) or GOG Galaxy, or move them back from the folder another launcher put them in, then press Update again."));
    }
    let _ = fs::write(&stamp_path, serde_json::to_string_pretty(&json!({ "hash": c["hash"], "files": done })).unwrap());
    store().set("creationFiles", json!(files.iter().filter_map(|f| f["name"].as_str()).collect::<Vec<_>>()));
    for w in &warnings { log(format!("[creations] {w}")); }
    Ok((!warnings.is_empty()).then(|| format!("Creation Club: {}", warnings.join("; "))))
}

// Launcher, Skyrim Platform and SKSE write these under Data/Platform and Data/SKSE/Plugins; no mod ships them
pub fn is_client_own_file(rel: &str) -> bool {
    let l = rel.to_lowercase();
    l.starts_with("data/platform/logs/") || l.starts_with("data/platform/pluginsnoload/") || l.starts_with("data/platform/pluginsdev/")
        || l.ends_with("skymp5-client-settings.txt") || l.ends_with(".log") || l.starts_with("data/skse/plugins/skse64_")
}

// Files in the portable game copy the launcher never installs; empty whenever a cleanup would not be safe
fn game_copy_strays(game_path: &Path, manifest: &Value) -> Vec<String> {
    let src = PathBuf::from(store().str("skyrimPath"));
    let base = store().str("baseDirPath");
    let safe = store().bool("isolatedGame") && store().bool("mo2Enabled") && !base.is_empty() && game_path == isolated_game_dir()
        && Path::new(&base).join("alduinak-instance.txt").exists() && !src.as_os_str().is_empty() && !paths_overlap(&src, game_path)
        && src.join("Data").join("Skyrim.esm").exists();
    if !safe { return vec![]; }
    let mut keep: HashSet<String> = vanilla_jobs(&src).into_iter().map(|j| j.to_lowercase()).collect();
    keep.extend(["skyrim.ccc", "vanilla-copy-complete.json", CREATIONS_STAMP, "data/platform/plugins/skymp5-client-settings.txt",
        "data/platform/pluginsnoload/auth-data-no-load.js", "data/interface/controls/pc/controlmap.txt", "controlmap_custom.txt"].map(String::from));
    keep.extend(PRELOADER_DLLS.map(String::from));
    for f in manifest["creations"]["files"].as_array().into_iter().flatten().chain(manifest["root"].as_array().into_iter().flatten()) {
        if let Some(to) = f["to"].as_str() { keep.insert(to.to_lowercase()); }
    }
    let skse = regex::Regex::new(r"^skse64_[^/]*\.(exe|dll)$").unwrap();
    mo2::list_files_rel(game_path).into_iter().filter(|rel| {
        let l = rel.to_lowercase();
        !(keep.contains(&l) || skse.is_match(&l) || is_client_own_file(&l))
            && !fs::symlink_metadata(mo2::join_rel(game_path, rel)).map(|m| m.file_type().is_symlink()).unwrap_or(true)
    }).collect()
}

pub fn remove_game_copy_strays(game_path: &Path, manifest: &Value) -> usize {
    let strays = game_copy_strays(game_path, manifest);
    for rel in &strays {
        let full = mo2::join_rel(game_path, rel);
        match fs::remove_file(&full) { Ok(_) => log(format!("[game] removed stray file {rel}")), Err(e) => log(format!("[game] could not remove stray file {rel}: {e}")) }
        let mut dir = full.parent().map(Path::to_path_buf);
        while let Some(d) = dir.filter(|d| d.starts_with(game_path) && d != game_path) {
            if fs::remove_dir(&d).is_err() { break; }
            dir = d.parent().map(Path::to_path_buf);
        }
    }
    ensure_client_dirs(game_path);
    strays.len()
}

// Builds the portable copy at the install location; force re-copies vanilla and drops the Creation files
pub async fn create_isolated(base_override: Option<String>, force: bool) -> Result<PathBuf, String> {
    let src = store().str("skyrimPath");
    if let Some(p) = game::source_problem(&src) { return Err(p); }
    if find_original_prefs_ini().is_none() { return Err(NEVER_LAUNCHED_ERROR.into()); }
    let mut base = base_override.filter(|b| !b.trim().is_empty()).map(|b| PathBuf::from(b.trim().replace('/', "\\"))).unwrap_or_else(crate::base_dir);
    // A generic folder gets an Alduinak folder nested inside it
    if !base.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("alduinak")) && !base.join("alduinak-instance.txt").exists() {
        base = base.join("Alduinak");
    }
    let src = PathBuf::from(src);
    let dst = base.join("skyrim");
    if paths_overlap(&src, &dst) || paths_overlap(&src, &base) {
        return Err("Choose an install location OUTSIDE your Skyrim folder. Portable install is for compatibility. If you lack the diskspace, turn off portable install.".into());
    }
    store().set("baseDirPath", json!(base.to_string_lossy()));
    let _ = fs::create_dir_all(&base);
    let _ = fs::write(base.join("alduinak-instance.txt"), "");
    isolated_progress("Installing Mod Organizer 2…");
    mo2::ensure_installed(&|m| isolated_progress(m)).await?;
    let mut manifest = Value::Null;
    if force {
        isolated_progress("Removing the old vanilla game files…");
        let _ = fs::remove_file(dst.join("vanilla-copy-complete.json"));
        for rel in vanilla_jobs(&src) { let _ = fs::remove_file(mo2::join_rel(&dst, &rel)); }
        manifest = crate::install::fetch_manifest().await.unwrap_or(Value::Null);
        if manifest.is_object() {
            isolated_progress("Removing the Creation Club files…");
            let _ = fs::remove_file(dst.join(CREATIONS_STAMP));
            for f in manifest["creations"]["files"].as_array().into_iter().flatten() {
                if let Some(to) = f["to"].as_str() { let _ = fs::remove_file(mo2::join_rel(&dst, to)); }
            }
        }
    }
    if force || !game_copy_complete(&dst) { copy_game_dir(&src, &dst).await?; } else { log(format!("[isolated] reusing existing game copy at {}", dst.display())); }
    if manifest.is_object() {
        let n = remove_game_copy_strays(&dst, &manifest);
        if n > 0 { isolated_progress(format!("Removed {n} stray file(s) from the game copy")); }
    }
    isolated_progress("Cleaning the Skyrim masters…");
    if let Some(w) = ensure_cleaned_masters(&dst, false, false).await.warning { log(format!("[isolated] {w}")); }
    let info = crate::net::fetch_json(&crate::basic::server_info_url(), &[]).await.ok();
    let order = crate::install::load_order(info.as_ref());
    mo2::ensure_instance(&dst.to_string_lossy(), order.as_deref());
    mo2::register_nxm_handler();
    seed_profile_prefs(&src);
    store().set("isolatedGame", json!(true));
    log(format!("[isolated] Alduinak install ready at {}", base.display()));
    Ok(base)
}
