// Mod Organizer 2, fully managed: install, portable instance, archives, mod folders and launch
use crate::{game, log, net, resource_dir, settings::PROFILE};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tokio::io::AsyncReadExt;

pub const MO2_VERSION: &str = "2.5.2";
const MO2_URL: &str = "https://github.com/ModOrganizer2/modorganizer/releases/download/v2.5.2/Mod.Organizer-2.5.2.7z";
const SKSE_VERSION: &str = "skse64_2_02_06";
const MO2_STAMP: &str = ".mo2-integrity.json";
// Top-level root entries that hold player data, caches or another install step rather than MO2 itself
const MO2_DATA_DIRS: [&str; 10] = ["mods", "downloads", "profiles", "overwrite", "webcache", "logs", ".x", ".b", ".skse", "skyrim"];
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn root() -> PathBuf { crate::base_dir() }
pub fn exe() -> PathBuf { root().join("ModOrganizer.exe") }
pub fn downloads_dir() -> PathBuf { root().join("downloads") }
pub fn mods_dir() -> PathBuf { root().join("mods") }
pub fn profile_dir() -> PathBuf { root().join("profiles").join(PROFILE) }
pub fn is_installed() -> bool { exe().exists() }

fn seven_zip() -> PathBuf { resource_dir().join("7zip").join("7z.exe") }
fn fwd(p: &Path) -> String { p.to_string_lossy().replace('\\', "/") }
pub fn sanitize(name: &str) -> String { name.chars().filter(|c| !"<>:\"/\\|?*".contains(*c)).collect() }

pub fn rmrf(p: &Path) {
    if p.is_dir() {
        if fs::remove_dir_all(p).is_err() {
            // Read-only files (7z restores archive attributes) refuse deletion until cleared
            for rel in list_files_rel(p) {
                let f = p.join(&rel);
                if let Ok(m) = fs::metadata(&f) { let mut perm = m.permissions(); #[allow(clippy::permissions_set_readonly_false)] perm.set_readonly(false); let _ = fs::set_permissions(&f, perm); }
            }
            let _ = fs::remove_dir_all(p);
        }
    } else {
        let _ = fs::remove_file(p);
    }
}

// Every file under dir as a forward-slash path relative to dir
pub fn list_files_rel(dir: &Path) -> Vec<String> {
    let mut out = vec![];
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let Ok(rd) = fs::read_dir(if rel.is_empty() { dir.to_path_buf() } else { dir.join(&rel) }) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { stack.push(r) } else { out.push(r) }
        }
    }
    out
}

pub fn join_rel(base: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(base.to_path_buf(), |p, part| p.join(part))
}

// Streaming sha256 off the async runtime, so big archives never stall the window
pub async fn sha256_file(p: &Path) -> Result<String, String> {
    let p = p.to_path_buf();
    tokio::task::spawn_blocking(move || game::sha256_file(&p).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

pub async fn verify_archive(p: &Path, sha: &str) -> bool {
    sha256_file(p).await.map(|h| h.eq_ignore_ascii_case(sha)).unwrap_or(false)
}

// Extracts with the bundled 7-Zip in a child process; on_percent gets 7-Zip's own progress
pub async fn extract_archive(archive: &Path, dest: &Path, mut on_percent: impl FnMut(u32)) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut child = tokio::process::Command::new(seven_zip())
        .args(["x", "-y", "-bsp1", "-bso0"])
        .arg(format!("-o{}", dest.display()))
        .arg(archive)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Could not start 7-Zip: {e}"))?;
    let mut out = child.stdout.take().unwrap();
    let re = Regex::new(r"(\d+)%").unwrap();
    let mut buf = [0u8; 4096];
    let mut last = u32::MAX;
    let deadline = Instant::now() + Duration::from_secs(600);
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), out.read(&mut buf)).await;
        match n {
            Ok(Ok(0)) | Ok(Err(_)) => break,
            Ok(Ok(n)) => {
                let text = String::from_utf8_lossy(&buf[..n]);
                if let Some(pct) = re.captures_iter(&text).last().and_then(|c| c[1].parse::<u32>().ok()) {
                    if pct != last { last = pct; on_percent(pct); }
                }
            }
            Err(_) => {}
        }
        if Instant::now() > deadline { let _ = child.kill().await; return Err("7-Zip timed out".into()); }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else {
        Err(format!("7-Zip could not extract {} (exit {})", archive.file_name().unwrap_or_default().to_string_lossy(), status.code().unwrap_or(-1)))
    }
}

// Size and count of MO2's own exe/dll files; they change only with the pinned version, so a mismatch means corruption or quarantine
fn mo2_binary_stats() -> (u64, u64) {
    let root = root();
    let (mut size, mut count) = (0u64, 0u64);
    for rel in list_files_rel(&root) {
        let top = rel.split('/').next().unwrap_or("").to_lowercase();
        if rel.contains('/') && MO2_DATA_DIRS.contains(&top.as_str()) { continue; }
        let l = rel.to_lowercase();
        if !(l.ends_with(".exe") || l.ends_with(".dll")) { continue; }
        count += 1;
        size += fs::metadata(root.join(&rel)).map(|m| m.len()).unwrap_or(0);
    }
    (size, count)
}

fn write_mo2_stamp() {
    let (size, count) = mo2_binary_stats();
    let _ = fs::write(root().join(MO2_STAMP), format!("{}\n", json!({ "version": MO2_VERSION, "size": size, "count": count })));
}

fn read_mo2_stamp() -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(root().join(MO2_STAMP)).ok()?).ok()
}

async fn download_mo2_archive(on_progress: &(dyn Fn(String) + Sync)) -> Result<PathBuf, String> {
    let archive = std::env::temp_dir().join(format!("mo2-{MO2_VERSION}.7z"));
    on_progress("Downloading Mod Organizer 2…".into());
    net::download_file(MO2_URL, &archive, &[], |r, t| {
        if t > 0 { on_progress(format!("Downloading MO2… {}% ({:.1} / {:.1} MB)", r * 100 / t, r as f64 / 1048576.0, t as f64 / 1048576.0)); }
    }).await?;
    Ok(archive)
}

async fn extract_mo2_archive(archive: &Path, on_progress: &(dyn Fn(String) + Sync)) -> Result<(), String> {
    on_progress("Installing MO2… 0%".into());
    extract_archive(archive, &root(), |pct| on_progress(format!("Installing MO2… {pct}%"))).await?;
    let _ = fs::remove_file(archive);
    if !is_installed() { return Err("MO2 extraction finished but ModOrganizer.exe was not found.".into()); }
    write_mo2_stamp();
    log("[mo2] MO2 installed");
    Ok(())
}

// Resolves at once when the binaries match the stamp; anything else re-extracts over the install
pub async fn ensure_installed(on_progress: &(dyn Fn(String) + Sync)) -> Result<(), String> {
    if is_installed() {
        match read_mo2_stamp() {
            Some(s) if s["version"] == MO2_VERSION => {
                let (size, count) = mo2_binary_stats();
                if s["size"] == json!(size) && s["count"] == json!(count) { return Ok(()); }
                log("[mo2] MO2 binaries do not match the stamp - repairing");
                on_progress("Repairing Mod Organizer 2…".into());
            }
            None => { write_mo2_stamp(); return Ok(()); }
            _ => log(format!("[mo2] MO2 version changed - reinstalling {MO2_VERSION}")),
        }
    }
    let archive = download_mo2_archive(on_progress).await?;
    extract_mo2_archive(&archive, on_progress).await
}

// Downloads first so a failed fetch leaves the install untouched; a launcher-made instance has MO2's own entries removed before extraction
pub async fn reinstall(on_progress: &(dyn Fn(String) + Sync)) -> Result<(), String> {
    let archive = download_mo2_archive(on_progress).await?;
    if is_installed() && root().join("portable.txt").exists() {
        let names: HashSet<String> = list_archive_entries(&archive).await.ok_or("Could not read the downloaded MO2 archive.")?
            .iter().map(|e| e.0.split('/').next().unwrap_or("").to_lowercase()).collect();
        for e in fs::read_dir(root()).into_iter().flatten().flatten() {
            let lower = e.file_name().to_string_lossy().to_lowercase();
            if lower == MO2_STAMP || MO2_DATA_DIRS.contains(&lower.as_str()) || !names.contains(&lower) { continue; }
            rmrf(&e.path());
        }
        let _ = fs::remove_file(root().join(MO2_STAMP));
    }
    extract_mo2_archive(&archive, on_progress).await
}

// MO2 reads game_edition, and the variant picks the My Games folder the profile inis are mapped onto
fn sync_game_edition(ini_path: &Path, skyrim: &str) {
    let edition = game::detect_edition(skyrim);
    if !["Steam", "GOG"].contains(&edition.as_str()) { return; }
    if crate::ini::get(&crate::ini::read(ini_path), "General", "game_edition") == Some(&edition) { return; }
    let _ = crate::ini::write(ini_path, &vec![("General".into(), vec![("game_edition".into(), edition.clone())])]);
}

fn instance_dir_lines() -> Vec<String> {
    let r = fwd(&root());
    vec![
        format!("base_directory={r}"), format!("mod_directory={r}/mods"), format!("download_directory={r}/downloads"),
        format!("cache_directory={r}/webcache"), format!("profiles_directory={r}/profiles"), format!("overwrite_directory={r}/overwrite"),
    ]
}

// lock_gui=false makes MO2 2.5 wait on a moshortcut launch without showing its lock window
const FORCED_SETTINGS: [&str; 1] = ["lock_gui=false"];

// Replaces each key=value line in place or adds it under [Settings]
fn upsert_settings(mut txt: String, lines: &[String]) -> String {
    for line in lines {
        let key = &line[..line.find('=').unwrap_or(0)];
        let re = Regex::new(&format!(r"(?m)^{}=.*$", regex::escape(key))).unwrap();
        let sec = Regex::new(r"(?m)^\[Settings\][ \t]*$").unwrap();
        if re.is_match(&txt) { txt = re.replace(&txt, regex::NoExpand(line)).into_owned(); }
        else if let Some(m) = sec.find(&txt) { txt.insert_str(m.end(), &format!("\r\n{line}")); }
        else { txt.push_str(&format!("\r\n[Settings]\r\n{line}\r\n")); }
    }
    txt
}

fn skse_executable_lines(skyrim: &Path, n: usize) -> Vec<String> {
    vec![
        format!("{n}\\title=SKSE"), format!("{n}\\binary={}", fwd(&skyrim.join("skse64_loader.exe"))),
        format!("{n}\\workingDirectory={}", fwd(skyrim)), format!("{n}\\arguments="),
        format!("{n}\\hide=false"), format!("{n}\\toolbar=true"), format!("{n}\\ownicon=true"),
    ]
}

fn build_instance_ini(skyrim: &Path, style: &str) -> String {
    let mut l: Vec<String> = vec![
        "[General]".into(), "gameName=Skyrim Special Edition".into(),
        format!("gamePath=@ByteArray({})", fwd(skyrim)), format!("selected_profile=@ByteArray({PROFILE})"),
        format!("version={MO2_VERSION}"), "first_start=false".into(), String::new(),
        "[Settings]".into(), "check_for_updates=false".into(),
    ];
    l.extend(instance_dir_lines());
    l.extend(FORCED_SETTINGS.iter().map(|s| s.to_string()));
    if !style.is_empty() { l.push(format!("style={style}")); }
    l.extend([String::new(), "[customExecutables]".into(), "size=1".into()]);
    l.extend(skse_executable_lines(skyrim, 1));
    l.push(String::new());
    l.join("\r\n")
}

// Reinstates a lost SKSE shortcut entry as the next array slot; MO2 cannot resolve moshortcut://:SKSE without it
fn ensure_skse_entry(txt: &str, skyrim: &Path) -> String {
    let mut lines: Vec<String> = txt.lines().map(String::from).collect();
    let Some(start) = lines.iter().position(|l| l.trim() == "[customExecutables]") else {
        while lines.last().is_some_and(|l| l.trim().is_empty()) { lines.pop(); }
        lines.extend([String::new(), "[customExecutables]".into(), "size=1".into()]);
        lines.extend(skse_executable_lines(skyrim, 1));
        lines.push(String::new());
        return lines.join("\r\n");
    };
    let mut end = start + 1;
    while end < lines.len() && !lines[end].trim().starts_with('[') { end += 1; }
    let mut n = 1;
    for i in start + 1..end {
        if let Some(v) = lines[i].strip_prefix("size=").and_then(|v| v.trim().parse::<usize>().ok()) { n = v + 1; lines[i] = format!("size={n}"); break; }
    }
    let mut insert = skse_executable_lines(skyrim, n);
    if n == 1 { insert.insert(0, "size=1".into()); }
    let mut at = end;
    while at > start + 1 && lines[at - 1].trim().is_empty() { at -= 1; }
    lines.splice(at..at, insert);
    lines.join("\r\n")
}

fn heal_instance_paths(ini_path: &Path, skyrim: &Path) {
    let Ok(mut txt) = fs::read_to_string(ini_path) else { return };
    let game_path = fwd(skyrim);
    let skse = fwd(&skyrim.join("skse64_loader.exe"));
    txt = Regex::new(r"(?m)^gamePath=.*$").unwrap().replace(&txt, regex::NoExpand(&format!("gamePath=@ByteArray({game_path})"))).into_owned();
    // The SKSE entry is found by title, as MO2 may reorder the array on save
    let idx = Regex::new(r"(?m)^(\d+)\\title=SKSE\s*$").unwrap().captures(&txt).map(|c| c[1].to_string());
    match idx {
        Some(i) => {
            txt = Regex::new(&format!(r"(?m)^{i}\\binary=.*$")).unwrap().replace(&txt, regex::NoExpand(&format!("{i}\\binary={skse}"))).into_owned();
            txt = Regex::new(&format!(r"(?m)^{i}\\workingDirectory=.*$")).unwrap().replace(&txt, regex::NoExpand(&format!("{i}\\workingDirectory={game_path}"))).into_owned();
        }
        None => txt = ensure_skse_entry(&txt, skyrim),
    }
    let mut lines = instance_dir_lines();
    lines.extend(FORCED_SETTINGS.iter().map(|s| s.to_string()));
    let _ = fs::write(ini_path, upsert_settings(txt, &lines));
}

// A dark stylesheet bundled with MO2, '' if none
fn pick_dark_style() -> String {
    let files: Vec<String> = fs::read_dir(root().join("stylesheets")).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    for name in ["Paper Dark.qss", "paper-dark.qss", "VS15.qss", "dark.qss", "1809.qss"] {
        if files.iter().any(|f| f == name) { return name.into(); }
    }
    files.into_iter().find(|f| f.to_lowercase().contains("dark") && f.to_lowercase().ends_with(".qss")).unwrap_or_default()
}

pub fn server_plugin_lines(load_order: &[String]) -> Vec<String> {
    let vanilla = ["skyrim.esm", "update.esm", "dawnguard.esm", "hearthfires.esm", "dragonborn.esm"];
    load_order.iter().map(|f| Path::new(f).file_name().unwrap_or_default().to_string_lossy().to_string())
        .filter(|f| !vanilla.contains(&f.to_lowercase().as_str())).map(|f| format!("*{f}")).collect()
}

const GENERATED: &str = "# This file was automatically generated by Mod Organizer.";

// Creates or refreshes the portable instance config and the Alduinak profile; mods and downloads are never touched
pub fn ensure_instance(skyrim: &str, load_order: Option<&[String]>) {
    let root = root();
    for d in [downloads_dir(), mods_dir(), profile_dir(), root.join("overwrite")] { let _ = fs::create_dir_all(d); }
    // portable.txt makes MO2 use this local ini instead of the registry-selected global instance
    let _ = fs::write(root.join("portable.txt"), "");
    let ini_path = root.join("ModOrganizer.ini");
    let sky = Path::new(skyrim);
    if ini_path.exists() { heal_instance_paths(&ini_path, sky); } else { let _ = fs::write(&ini_path, build_instance_ini(sky, &pick_dark_style())); }
    sync_game_edition(&ini_path, skyrim);
    let modlist = profile_dir().join("modlist.txt");
    if !modlist.exists() { let _ = fs::write(&modlist, format!("{GENERATED}\r\n")); }
    let plugins = profile_dir().join("plugins.txt");
    match load_order.filter(|l| !l.is_empty()) {
        Some(order) => { let _ = fs::write(&plugins, format!("{GENERATED}\r\n{}\r\n", server_plugin_lines(order).join("\r\n"))); }
        None if !plugins.exists() => { let _ = fs::write(&plugins, format!("{GENERATED}\r\n")); }
        None => {}
    }
}

// Points nxm:// at this instance so Nexus "Mod Manager Download" buttons feed its downloads folder
pub fn register_nxm_handler() {
    let root = root();
    let _ = fs::write(root.join("nxmhandler.ini"), ["[handlers]", "size=1", "1\\games=skyrimse", &format!("1\\executable={}", fwd(&exe())), "1\\arguments=", ""].join("\r\n"));
    let result = (|| -> std::io::Result<()> {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let (nxm, _) = hkcu.create_subkey(r"Software\Classes\nxm")?;
        nxm.set_value("", &"URL:NXM Protocol")?;
        nxm.set_value("URL Protocol", &"")?;
        let (cmd, _) = hkcu.create_subkey(r"Software\Classes\nxm\shell\open\command")?;
        cmd.set_value("", &format!("\"{}\" \"%1\"", root.join("nxmhandler.exe").display()))?;
        Ok(())
    })();
    match result { Ok(_) => log("[mo2] nxm:// handler registered"), Err(e) => log(format!("[mo2] nxm handler registration failed: {e}")) }
}

// A finished download whose .meta records the given Nexus fileId
pub fn find_download_by_file_id(file_id: i64) -> Option<String> {
    let re = Regex::new(r"(?im)^fileID\s*=\s*(\d+)").unwrap();
    fs::read_dir(downloads_dir()).ok()?.flatten().map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.to_lowercase().ends_with(".meta") && !n.to_lowercase().ends_with(".unfinished"))
        .find(|n| fs::read_to_string(downloads_dir().join(format!("{n}.meta"))).ok()
            .and_then(|m| re.captures(&m).and_then(|c| c[1].parse::<i64>().ok())) == Some(file_id))
}

// Downloads into the MO2 downloads folder with one retry; returns the archive name
pub async fn download_to_downloads(url: &str, file_name: &str, headers: &[(&str, &str)], mut on_progress: impl FnMut(u64, u64)) -> Result<String, String> {
    let dest = downloads_dir().join(file_name);
    if dest.exists() { return Ok(file_name.into()); }
    let _ = fs::create_dir_all(downloads_dir());
    let temp = downloads_dir().join(format!("{file_name}.unfinished"));
    let _ = fs::remove_file(&temp);
    if let Err(e) = net::download_file(url, &temp, headers, &mut on_progress).await {
        log(format!("[mo2] download failed ({e}), retrying: {url}"));
        tokio::time::sleep(Duration::from_secs(3)).await;
        net::download_file(url, &temp, headers, &mut on_progress).await?;
    }
    fs::rename(&temp, &dest).map_err(|e| e.to_string())?;
    Ok(file_name.into())
}

// An interrupted extraction leaves a partial folder, so a cached one counts only with this marker
const EXTRACT_MARKER: &str = ".complete";

pub async fn extract_to_cache(archive: &Path, id: &str, on_percent: impl FnMut(u32)) -> Result<PathBuf, String> {
    let dir = root().join(".x").join(id);
    if dir.join(EXTRACT_MARKER).exists() { return Ok(dir); }
    if dir.exists() { log(format!("[mo2] discarding incomplete extraction of {id}")); rmrf(&dir); }
    extract_archive(archive, &dir, on_percent).await?;
    fs::write(dir.join(EXTRACT_MARKER), "").map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn clear_build_cache() { rmrf(&root().join(".b")); }

pub fn clear_cache(id: Option<&str>) {
    let dir = match id { Some(i) => root().join(".x").join(i), None => root().join(".x") };
    rmrf(&dir);
    if dir.exists() { let _ = fs::remove_file(dir.join(EXTRACT_MARKER)); }
}

// Materialises a directive (from an extracted archive, or inline base64) under dest_root, verifying its sha256
async fn write_directive(f: &Value, dest_root: &Path, extracted: &HashMap<String, PathBuf>) -> Result<(), String> {
    let to = f["to"].as_str().unwrap_or("");
    let dest = join_rel(dest_root, to);
    if let Some(parent) = dest.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    if let Some(inline) = f.get("inline").and_then(|v| v.as_str()) {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(inline).map_err(|e| e.to_string())?;
        tokio::fs::write(&dest, bytes).await.map_err(|e| e.to_string())?;
    } else {
        let archive = f["archive"].as_str().map(String::from).or_else(|| f["archive"].as_i64().map(|n| n.to_string())).unwrap_or_default();
        let dir = extracted.get(&archive).ok_or(format!("archive {archive} was not extracted"))?;
        let from = f["from"].as_str().unwrap_or("");
        let src = join_rel(dir, from);
        if !src.exists() { return Err(format!("\"{from}\" not found in archive {archive}")); }
        tokio::fs::copy(&src, &dest).await.map_err(|e| e.to_string())?;
    }
    if let Some(want) = f.get("sha256").and_then(|v| v.as_str()) {
        if !sha256_file(&dest).await?.eq_ignore_ascii_case(want) { return Err(format!("hash mismatch for {to}")); }
    }
    Ok(())
}

pub fn archive_id(v: &Value) -> Option<String> {
    v.as_str().map(String::from).or_else(|| v.as_i64().map(|n| n.to_string()))
}

static APPLY_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

// Builds one mod folder in a temp dir and swaps it into place only on success, so a failed reinstall never destroys a working folder
pub async fn apply_mod(name: &str, files: &[Value], extracted: &HashMap<String, PathBuf>, mod_id: i64, hash: &str) -> Result<(), String> {
    let folder = sanitize(name);
    let mod_dir = mods_dir().join(&folder);
    let build = root().join(".b").join(APPLY_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst).to_string());
    rmrf(&build);
    let result = async {
        for f in files {
            write_directive(f, &build, extracted).await.map_err(|e| {
                let to = f["to"].as_str().unwrap_or("");
                match archive_id(&f["archive"]) { Some(a) => format!("{to}: {e} [archive {a}, from {}]", f["from"].as_str().unwrap_or("")), None => format!("{to}: {e} [inline]") }
            })?;
        }
        fs::write(build.join("meta.ini"), ["[General]", "gameName=SkyrimSE", &format!("modid={mod_id}"), &format!("name={folder}"), "repository=Nexus", "alduinakManaged=true", &format!("alduinakHash={hash}"), ""].join("\r\n")).map_err(|e| e.to_string())?;
        // Rename-aside swap: a locked file fails the rename cleanly instead of leaving a half-deleted mod
        let stale = mods_dir().join(format!("{folder}.stale"));
        rmrf(&stale);
        fs::create_dir_all(mods_dir()).map_err(|e| e.to_string())?;
        let moved = mod_dir.exists();
        if moved { fs::rename(&mod_dir, &stale).map_err(|e| e.to_string())?; }
        if let Err(e) = fs::rename(&build, &mod_dir) {
            if moved { let _ = fs::rename(&stale, &mod_dir); }
            return Err(e.to_string());
        }
        rmrf(&stale);
        log(format!("[mo2] installed {folder} ({} file(s))", files.len()));
        Ok(())
    }.await;
    if result.is_err() { rmrf(&build); }
    result
}

pub async fn apply_root_files(files: &[Value], extracted: &HashMap<String, PathBuf>, game_dir: &Path) -> Result<(), String> {
    for f in files { write_directive(f, game_dir, extracted).await?; }
    Ok(())
}

fn meta_value(mod_name: &str, key: &str) -> String {
    let re = Regex::new(&format!(r"(?im)^{key}\s*=\s*(.*)$")).unwrap();
    fs::read_to_string(mods_dir().join(sanitize(mod_name)).join("meta.ini")).ok()
        .and_then(|m| re.captures(&m).map(|c| c[1].trim().to_string())).unwrap_or_default()
}

pub fn is_managed(mod_name: &str) -> bool { meta_value(mod_name, "alduinakManaged").eq_ignore_ascii_case("true") }
pub fn read_mod_hash(mod_name: &str) -> String { meta_value(mod_name, "alduinakHash") }

// Launcher-managed mod folders the manifest order no longer lists; a player's own or copied folder is kept
fn list_stale_managed_mods(order: &[String]) -> Vec<String> {
    let managed: HashSet<String> = order.iter().map(|n| sanitize(n).to_lowercase()).collect();
    fs::read_dir(mods_dir()).into_iter().flatten().flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| {
            let fold = n.to_lowercase();
            !managed.contains(&fold) && fold != "skse" && is_managed(n) && (fold.ends_with(".stale") || meta_value(n, "name").to_lowercase() == fold)
        })
        .collect()
}

// Writes modlist.txt in the manifest's order (separators included); the player's own mods stay below the managed set
pub fn set_modlist_order(order: &[String]) {
    let _ = fs::create_dir_all(profile_dir());
    let managed: HashSet<&String> = order.iter().collect();
    for name in order.iter().filter(|n| n.ends_with("_separator")) {
        let dir = mods_dir().join(name);
        if !dir.exists() {
            let _ = fs::create_dir_all(&dir);
            let _ = fs::write(dir.join("meta.ini"), ["[General]", "gameName=SkyrimSE", "modid=0", &format!("name={name}"), "alduinakManaged=true", ""].join("\r\n"));
        }
    }
    let path = profile_dir().join("modlist.txt");
    let user: Vec<String> = fs::read_to_string(&path).unwrap_or_default().lines()
        .filter(|l| {
            if !(l.starts_with('+') || l.starts_with('-')) { return false; }
            let n = l[1..].trim().to_string();
            !managed.contains(&n) && !is_managed(&n) && mods_dir().join(&n).exists()
        }).map(String::from).collect();
    // An empty order means a broken manifest: never mass-prune on it
    if !order.is_empty() {
        for name in list_stale_managed_mods(order) { rmrf(&mods_dir().join(&name)); log(format!("[mo2] removed stale managed mod: {name}")); }
    }
    let mut lines = vec![GENERATED.to_string()];
    lines.extend(order.iter().map(|n| format!("+{n}")));
    lines.extend(user);
    let _ = fs::write(path, lines.join("\r\n") + "\r\n");
}

pub fn set_plugins(lines: &[String]) {
    if lines.is_empty() { return; }
    let _ = fs::create_dir_all(profile_dir());
    let _ = fs::write(profile_dir().join("plugins.txt"), format!("{GENERATED}\r\n{}\r\n", lines.join("\r\n")));
}

pub struct SkseSource { pub edition: String, pub url: String, pub file_name: String }

// The SKSE build matching the game's store edition
pub fn skse_source_for(game_dir: &str) -> SkseSource {
    let edition = game::detect_edition(game_dir);
    let gog = edition == "GOG";
    SkseSource {
        url: format!("https://skse.silverlock.org/beta/{SKSE_VERSION}{}.7z", if gog { "_gog" } else { "" }),
        file_name: format!("{SKSE_VERSION}{}.7z", if gog { "_gog" } else { "" }),
        edition: if gog { "GOG".into() } else { "Steam".into() },
    }
}

pub fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    for rel in list_files_rel(from) {
        let dest = join_rel(to, &rel);
        if let Some(p) = dest.parent() { fs::create_dir_all(p)?; }
        fs::copy(join_rel(from, &rel), dest)?;
    }
    Ok(())
}

// Loader and runtime dlls into the game root; the Data payload becomes the SKSE mod, or goes straight into Data when direct
pub async fn install_skse(archive: &Path, game_dir: &Path, direct: bool) -> Result<(), String> {
    let tmp = root().join(".skse");
    rmrf(&tmp);
    extract_archive(archive, &tmp, |_| {}).await?;
    let result = (|| -> Result<usize, String> {
        // Descend a single wrapper folder to the real root
        let mut dir = tmp.clone();
        for _ in 0..3 {
            let entries: Vec<fs::DirEntry> = fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten().collect();
            if entries.iter().any(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case("skse64_loader.exe")) { break; }
            let dirs: Vec<&fs::DirEntry> = entries.iter().filter(|e| e.path().is_dir()).collect();
            if dirs.len() == 1 && entries.len() == 1 { dir = dirs[0].path(); continue; }
            break;
        }
        let mut copied = 0;
        for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            let n = e.file_name().to_string_lossy().to_lowercase();
            if e.path().is_file() && (n.ends_with(".exe") || n.ends_with(".dll")) {
                fs::copy(e.path(), game_dir.join(e.file_name())).map_err(|e| e.to_string())?;
                copied += 1;
            }
        }
        if copied == 0 { return Err("no skse64 exe/dll found in the SKSE archive".into()); }
        if let Some(data) = fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten().find(|e| e.path().is_dir() && e.file_name().to_string_lossy().eq_ignore_ascii_case("data")) {
            if direct {
                copy_tree(&data.path(), &game_dir.join("Data")).map_err(|e| e.to_string())?;
            } else {
                let mod_dir = mods_dir().join("SKSE");
                rmrf(&mod_dir);
                copy_tree(&data.path(), &mod_dir).map_err(|e| e.to_string())?;
                fs::write(mod_dir.join("meta.ini"), ["[General]", "gameName=SkyrimSE", "modid=0", "name=SKSE", "repository=", "alduinakManaged=true", ""].join("\r\n")).map_err(|e| e.to_string())?;
            }
        }
        Ok(copied)
    })();
    rmrf(&tmp);
    let copied = result?;
    log(format!("[mo2] SKSE installed ({copied} root file(s))"));
    Ok(())
}

// Mod Manager None: mods go straight into the game's Data, and this record in the game root says which files each one owns
const DIRECT_RECORD: &str = "alduinak-installed.json";

pub fn read_direct_record(game_dir: &Path) -> Value {
    fs::read_to_string(game_dir.join(DIRECT_RECORD)).ok().and_then(|t| serde_json::from_str(&t).ok()).filter(|v: &Value| v["mods"].is_object()).unwrap_or_else(|| json!({ "mods": {} }))
}

fn write_direct_record(game_dir: &Path, record: &Value) {
    let _ = fs::write(game_dir.join(DIRECT_RECORD), serde_json::to_string_pretty(record).unwrap());
}

pub async fn apply_mod_direct(game_dir: &Path, m: &Value, extracted: &HashMap<String, PathBuf>) -> Result<(), String> {
    let data = game_dir.join("Data");
    let files = m["files"].as_array().cloned().unwrap_or_default();
    for f in &files { write_directive(f, &data, extracted).await?; }
    let mut record = read_direct_record(game_dir);
    record["mods"][m["name"].as_str().unwrap_or("")] = json!({ "hash": m["hash"].as_str().unwrap_or(""), "files": files.iter().map(|f| f["to"].clone()).collect::<Vec<_>>() });
    write_direct_record(game_dir, &record);
    Ok(())
}

// Deletes the files of recorded mods the manifest dropped, unless a kept mod owns the same path
pub fn prune_direct_mods(game_dir: &Path, keep: &HashSet<String>) {
    let mut record = read_direct_record(game_dir);
    let mods = record["mods"].as_object().cloned().unwrap_or_default();
    let owned: HashSet<String> = mods.iter().filter(|(n, _)| keep.contains(*n)).flat_map(|(_, r)| r["files"].as_array().cloned().unwrap_or_default()).filter_map(|f| f.as_str().map(|s| s.to_lowercase())).collect();
    for (name, r) in &mods {
        if keep.contains(name) { continue; }
        for to in r["files"].as_array().into_iter().flatten().filter_map(|f| f.as_str()) {
            if !owned.contains(&to.to_lowercase()) { let _ = fs::remove_file(join_rel(&game_dir.join("Data"), to)); }
        }
        record["mods"].as_object_mut().unwrap().remove(name);
        log(format!("[mo2] removed dropped mod {name} from the game folder"));
    }
    write_direct_record(game_dir, &record);
}

// Files a cheat would swap: code, plugins and compiled scripts; hashed on every Play, the rest only sized
pub fn is_risky(name: &str) -> bool {
    let l = name.to_lowercase();
    [".dll", ".exe", ".esp", ".esm", ".esl", ".pex"].iter().any(|e| l.ends_with(e))
}

// Why a mod installed straight into Data differs from the manifest, None when it matches
pub async fn direct_mod_problem(game_dir: &Path, m: &Value) -> Option<String> {
    let record = read_direct_record(game_dir);
    let rec = &record["mods"][m["name"].as_str().unwrap_or("")];
    if !rec.is_object() || rec["hash"].as_str().unwrap_or("") != m["hash"].as_str().unwrap_or("") { return Some("not installed at this version".into()); }
    for f in m["files"].as_array().into_iter().flatten() {
        let to = f["to"].as_str().unwrap_or("");
        let p = join_rel(&game_dir.join("Data"), to);
        let Ok(meta) = fs::metadata(&p) else { return Some(format!("missing file {to}")) };
        if f["size"].as_u64().is_some_and(|s| s != meta.len()) { return Some(format!("resized file {to}")); }
        if let (true, Some(want)) = (is_risky(to), f["sha256"].as_str()) {
            if !sha256_file(&p).await.map(|h| h.eq_ignore_ascii_case(want)).unwrap_or(false) { return Some(format!("modified file {to}")); }
        }
    }
    None
}

// Why the risky files under dir differ from the directives, None when they all match; never cached, so a restored mtime hides nothing
pub async fn risky_file_problem(dir: &Path, files: &[Value]) -> Result<Option<String>, String> {
    let expected: HashMap<String, String> = files.iter()
        .filter_map(|f| Some((f["to"].as_str()?.to_lowercase(), f["sha256"].as_str()?.to_lowercase())))
        .filter(|(to, _)| is_risky(to)).collect();
    let present: Vec<String> = list_files_rel(dir).into_iter().filter(|r| is_risky(r)).collect();
    for rel in &present {
        let Some(want) = expected.get(&rel.to_lowercase()) else { return Ok(Some(format!("unexpected file {rel}"))) };
        if sha256_file(&join_rel(dir, rel)).await?.to_lowercase() != *want { return Ok(Some(format!("modified file {rel}"))); }
    }
    let have: HashSet<String> = present.iter().map(|r| r.to_lowercase()).collect();
    Ok(expected.keys().find(|to| !have.contains(*to)).map(|to| format!("missing file {to}")))
}

// Byte size of an installed mod folder without the launcher's meta.ini; None when missing or unreadable
pub fn mod_folder_size(name: &str) -> Option<u64> {
    let dir = mods_dir().join(sanitize(name));
    if !dir.exists() { return None; }
    let mut total = 0;
    for rel in list_files_rel(&dir) {
        if rel.eq_ignore_ascii_case("meta.ini") { continue; }
        total += fs::metadata(join_rel(&dir, &rel)).ok()?.len();
    }
    Some(total)
}

fn is_plugin(n: &str) -> bool { let l = n.to_lowercase(); l.ends_with(".esp") || l.ends_with(".esm") || l.ends_with(".esl") }

// Does a mod folder ship a plugin or an SKSE plugin dll?
fn mod_has_restricted_content(dir: &Path) -> bool {
    list_files_rel(dir).iter().any(|r| { let l = r.to_lowercase(); is_plugin(&l) || (l.ends_with(".dll") && l.contains("skse/plugins/")) })
}

// Plugins, BSAs and CC files in overwrite load at top priority and desync the load order
pub fn clean_overwrite() -> Vec<String> {
    let ow = root().join("overwrite");
    let junk: Vec<String> = fs::read_dir(&ow).into_iter().flatten().flatten().filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| { let l = n.to_lowercase(); is_plugin(&l) || l.ends_with(".bsa") || l.starts_with("cc") }).collect();
    let removed: Vec<String> = junk.into_iter().filter(|n| fs::remove_file(ow.join(n)).is_ok()).collect();
    if removed.is_empty() { return removed; }
    let gone: HashSet<String> = removed.iter().filter(|n| is_plugin(n)).map(|n| n.to_lowercase()).collect();
    let plugins = profile_dir().join("plugins.txt");
    if let Ok(t) = fs::read_to_string(&plugins) {
        let kept: Vec<&str> = t.lines().filter(|l| !gone.contains(&l.trim_start_matches('*').trim().to_lowercase())).collect();
        let _ = fs::write(&plugins, kept.join("\r\n"));
    }
    log(format!("[mo2] cleaned {} stray overwrite item(s): {}", removed.len(), removed.join(", ")));
    removed
}

// Disables player-added mods that ship plugins or SKSE dlls
pub fn enforce_mod_rules() -> Vec<String> {
    let path = profile_dir().join("modlist.txt");
    let Ok(text) = fs::read_to_string(&path) else { return vec![] };
    let mut disabled = vec![];
    let out: Vec<String> = text.lines().map(|line| {
        let Some(name) = line.strip_prefix('+').map(str::trim) else { return line.to_string() };
        if name.is_empty() || name.ends_with("_separator") || is_managed(name) { return line.to_string(); }
        if mod_has_restricted_content(&mods_dir().join(name)) { disabled.push(name.to_string()); return format!("-{name}"); }
        line.to_string()
    }).collect();
    if !disabled.is_empty() {
        let _ = fs::write(&path, out.join("\r\n"));
        log(format!("[mo2] disabled {} unauthorised mod(s): {}", disabled.len(), disabled.join(", ")));
    }
    disabled
}

// Hash and listing caches keyed by path, size and modified time, so repeated scans skip unchanged files
static HASH_CACHE: Mutex<Option<HashMap<PathBuf, (u64, SystemTime, String)>>> = Mutex::new(None);
static LIST_CACHE: Mutex<Option<HashMap<PathBuf, (u64, SystemTime, String)>>> = Mutex::new(None);

fn stat(p: &Path) -> Option<(u64, SystemTime)> {
    let m = fs::metadata(p).ok()?;
    Some((m.len(), m.modified().ok()?))
}

pub async fn hash_cached(p: &Path) -> Result<String, String> {
    let (size, mtime) = stat(p).ok_or("unreadable")?;
    if let Some((s, t, h)) = HASH_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(p) {
        if *s == size && *t == mtime { return Ok(h.clone()); }
    }
    let h = sha256_file(p).await?.to_lowercase();
    HASH_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(p.to_path_buf(), (size, mtime, h.clone()));
    Ok(h)
}

// Finished (non-partial) archives in the downloads folder
fn list_download_archives() -> Vec<(String, PathBuf, u64)> {
    let partial = Regex::new(r"(?i)\.(meta|unfinished|part|tmp|crdownload|download)$").unwrap();
    fs::read_dir(downloads_dir()).into_iter().flatten().flatten()
        .filter(|e| e.path().is_file())
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
        .filter(|(n, _)| !partial.is_match(n))
        .filter_map(|(n, p)| { let s = fs::metadata(&p).ok()?.len(); Some((n, p, s)) })
        .collect()
}

// A finished archive in downloads with the given sha256, found by content whatever its name
pub async fn find_archive_by_hash(hash: &str, size: Option<u64>) -> Option<PathBuf> {
    for (_, full, s) in list_download_archives() {
        if size.is_some_and(|want| want > 0 && want != s) { continue; }
        if hash_cached(&full).await.map(|h| h.eq_ignore_ascii_case(hash)).unwrap_or(false) { return Some(full); }
    }
    None
}

// 7-Zip listing of an archive, None while locked, truncated or not an archive
async fn list_archive_contents(archive: &Path, technical: bool) -> Option<String> {
    let (size, mtime) = stat(archive)?;
    let key = if technical { archive.with_extension("slt") } else { archive.to_path_buf() };
    if let Some((s, t, l)) = LIST_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&key) {
        if *s == size && *t == mtime { return Some(l.clone()); }
    }
    let mut cmd = tokio::process::Command::new(seven_zip());
    cmd.arg("l");
    if technical { cmd.arg("-slt"); }
    let out = tokio::time::timeout(Duration::from_secs(60), cmd.arg(archive).creation_flags(CREATE_NO_WINDOW).output()).await.ok()?.ok()?;
    if !out.status.success() { return None; }
    let listing = String::from_utf8_lossy(&out.stdout).to_string();
    LIST_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, (size, mtime, listing.clone()));
    Some(listing)
}

// File entries (path, size) of an archive from a technical listing, directories excluded
pub async fn list_archive_entries(archive: &Path) -> Option<Vec<(String, u64)>> {
    let text = list_archive_contents(archive, true).await?;
    let body = Regex::new(r"(?m)^-{10,}\s*$").unwrap().split(&text).nth(1).unwrap_or("").to_string();
    let get = |block: &str, key: &str| Regex::new(&format!(r"(?m)^{key} = (.*)$")).unwrap().captures(block).map(|c| c[1].trim().to_string());
    Some(body.split("\r\n\r\n").flat_map(|b| b.split("\n\n")).filter_map(|block| {
        let p = get(block, "Path")?;
        if get(block, "Attributes").is_some_and(|a| a.starts_with('D')) { return None; }
        Some((p.replace('\\', "/"), get(block, "Size").and_then(|s| s.parse().ok()).unwrap_or(0)))
    }).collect())
}

pub struct Wanted { pub name: String, pub hash: Option<String>, pub size: Option<u64>, pub name_pattern: Option<Regex>, pub expect: Vec<Regex> }

// Polls the downloads folder until every wanted archive is there; hash items match by content, name-only items need a readable listing
// with every expected entry. on_found fires as each one lands. The deadline slides while the player is actively staging files.
pub async fn wait_for_downloads(
    wanted: &[Wanted],
    on_progress: impl Fn(usize, usize, String),
    cancelled: impl Fn() -> bool,
    mut on_found: impl FnMut(usize, PathBuf),
) -> Result<Vec<PathBuf>, String> {
    let timeout = Duration::from_secs(900);
    let interval = Duration::from_secs(5);
    let mut deadline = Instant::now() + timeout;
    let hard_deadline = Instant::now() + timeout * 3;
    let mut found: Vec<Option<PathBuf>> = vec![None; wanted.len()];
    let mut prev_size: HashMap<PathBuf, u64> = HashMap::new();
    loop {
        tokio::time::sleep(interval).await;
        if cancelled() { return Err("Cancelled".into()); }
        let archives = list_download_archives();
        let mut progressed = false;
        let mut suspect: HashSet<String> = HashSet::new();
        for i in 0..wanted.len() {
            if found[i].is_some() { continue; }
            let w = &wanted[i];
            for (file, full, size) in &archives {
                if found.iter().flatten().any(|f| f == full) { continue; }
                let settled = prev_size.get(full) == Some(size);
                let name_hit = w.name_pattern.as_ref().is_some_and(|re| re.is_match(file));
                if let Some(hash) = &w.hash {
                    if !settled { continue; }
                    if w.size.is_some_and(|s| s > 0 && s != *size) { if name_hit { suspect.insert(file.clone()); } continue; }
                    match hash_cached(full).await {
                        Ok(h) if h.eq_ignore_ascii_case(hash) => {}
                        Ok(_) => { if name_hit { suspect.insert(file.clone()); } continue; }
                        Err(_) => continue,
                    }
                } else if let Some(re) = &w.name_pattern {
                    if !re.is_match(file) { continue; }
                    let Some(listing) = list_archive_contents(full, false).await else { continue };
                    if w.expect.iter().any(|e| !e.is_match(&listing)) { if settled { suspect.insert(file.clone()); } continue; }
                } else {
                    continue;
                }
                log(format!("[wait] \"{}\" matched by \"{file}\"", w.name));
                found[i] = Some(full.clone());
                progressed = true;
                on_found(i, full.clone());
                break;
            }
        }
        for (_, full, size) in &archives {
            if prev_size.get(full) != Some(size) { progressed = true; }
            prev_size.insert(full.clone(), *size);
        }
        if progressed { deadline = Instant::now() + timeout; }
        let remaining: Vec<&str> = wanted.iter().zip(&found).filter(|(_, f)| f.is_none()).map(|(w, _)| w.name.as_str()).collect();
        let claimed: HashSet<String> = found.iter().flatten().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string())).collect();
        let mismatched: Vec<String> = suspect.into_iter().filter(|f| !claimed.contains(f)).collect();
        let note = if mismatched.is_empty() { String::new() } else {
            format!(" ({})", mismatched.iter().map(|f| format!("{f} is not the exact file the server expects - download it through its link on the downloads page, which pins the right version; if that version is gone from Nexus the server admin must update the modlist")).collect::<Vec<_>>().join("; "))
        };
        let done = wanted.len() - remaining.len();
        if remaining.is_empty() {
            on_progress(done, wanted.len(), "All downloads received".into());
            return Ok(found.into_iter().flatten().collect());
        }
        on_progress(done, wanted.len(), format!("Waiting for downloads: {}{note}", remaining.join(", ")));
        if Instant::now() > deadline || Instant::now() > hard_deadline {
            return Err(format!("Timed out waiting to download: {}{note}", remaining.join(", ")));
        }
    }
}

// A bare cc* match would also catch community mods like CCOR.esp
pub fn is_cc_file(n: &str) -> bool {
    Regex::new(r"(?i)^cc[a-z]{3}sse\d{3}-.*\.(?:es[mlp]|bsa)$").unwrap().is_match(n)
}
pub const CC_QUARANTINE_DIR: &str = "disabled CC mods";

// Existing folders that may hold Creation Club files: search_dirs plus first-level "disabled"/"kzl" folders of the root and its Data
pub fn creation_dirs(game_root: &Path, search_dirs: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vec![];
    let mut seen = HashSet::new();
    let mut add = |p: PathBuf, out: &mut Vec<PathBuf>| {
        if p.is_dir() && seen.insert(p.to_string_lossy().to_lowercase()) { out.push(p); }
    };
    for rel in search_dirs.iter().filter(|r| !r.split(['/', '\\']).any(|x| x == "..")) {
        add(rel.split(['/', '\\']).fold(game_root.to_path_buf(), |p, s| p.join(s)), &mut out);
    }
    let re = Regex::new(r"(?i)disabled|kzl").unwrap();
    for parent in [game_root.to_path_buf(), game_root.join("Data")] {
        for e in fs::read_dir(&parent).into_iter().flatten().flatten() {
            if !(e.path().is_dir() && re.is_match(&e.file_name().to_string_lossy())) { continue; }
            add(e.path(), &mut out);
            // A quarantine folder may mirror the game root, so its own first level is searched too
            for s in fs::read_dir(e.path()).into_iter().flatten().flatten() { if s.path().is_dir() { add(s.path(), &mut out); } }
        }
    }
    out
}

// First verified copy of a creations file in dirs; an archive of another store build is the unverified fallback, plugins never are
pub async fn locate_creation(file: &Value, dirs: &[PathBuf]) -> (Option<(PathBuf, bool)>, Vec<Value>) {
    let accept = file["accept"].as_array().cloned().unwrap_or_default();
    let mut rejected = vec![];
    let mut fallback = None;
    for dir in dirs {
        let full = dir.join(file["name"].as_str().unwrap_or(""));
        let Some((size, _)) = stat(&full).filter(|_| full.is_file()) else { continue };
        let sha = hash_cached(&full).await.unwrap_or_else(|_| "unreadable".into());
        if accept.iter().any(|a| a["size"].as_u64() == Some(size) && a["sha256"].as_str().is_some_and(|s| s.eq_ignore_ascii_case(&sha))) {
            return (Some((full, true)), rejected);
        }
        rejected.push(json!({ "path": full.to_string_lossy(), "size": size, "sha256": sha }));
        if file["kind"] == "archive" && fallback.is_none() && sha != "unreadable" { fallback = Some((full, false)); }
    }
    (fallback, rejected)
}

// Moves Creation Club content the server does not use out of a real install's Data, which the engine would force-load
pub fn disable_cc_content(game: &Path, server_load_order: &[String], keep_names: &[String]) -> usize {
    let mut keep: HashSet<String> = keep_names.iter().map(|f| Path::new(f).file_name().unwrap_or_default().to_string_lossy().to_lowercase()).collect();
    for f in server_load_order {
        let name = Path::new(f).file_name().unwrap_or_default().to_string_lossy().to_lowercase();
        let base = Regex::new(r"\.es[mlp]$").unwrap().replace(&name, "").to_string();
        keep.insert(format!("{base}.bsa"));
        keep.insert(format!("{base} - textures.bsa"));
        keep.insert(name);
    }
    let extras = ["_resourcepack.esl", "_resourcepack.bsa", "marketplacetextures.bsa"];
    let data = game.join("Data");
    let dest = game.join(CC_QUARANTINE_DIR);
    let mut moved = 0;
    for e in fs::read_dir(&data).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let l = name.to_lowercase();
        if !(is_cc_file(&l) || extras.contains(&l.as_str())) || keep.contains(&l) { continue; }
        let _ = fs::create_dir_all(&dest);
        match fs::rename(e.path(), dest.join(&name)) { Ok(_) => moved += 1, Err(err) => log(format!("[mo2] could not move {name} to disabled CC mods: {err}")) }
    }
    if moved > 0 { log(format!("[mo2] moved {moved} Creation Club file(s) to {}", dest.display())); }
    moved
}

// Launches the game through MO2's VFS using the SKSE executable entry, healing a lost shortcut first
pub fn launch_game(skyrim: &str) -> Result<(), String> {
    if !is_installed() { return Err("MO2 is not installed - run Install MO2 under Troubleshooting.".into()); }
    let ini = root().join("ModOrganizer.ini");
    let has = || fs::read_to_string(&ini).map(|t| Regex::new(r"(?m)^\d+\\title=SKSE\s*$").unwrap().is_match(&t)).unwrap_or(false);
    if !has() && !skyrim.is_empty() { ensure_instance(skyrim, None); }
    if !has() { return Err("The MO2 SKSE shortcut is missing from ModOrganizer.ini - run Repair Modlist to repair it.".into()); }
    std::process::Command::new(exe()).args(["-p", PROFILE, "moshortcut://:SKSE"]).current_dir(root()).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn mo2_open() -> Value {
    if !is_installed() { return json!({ "success": false, "error": "MO2 is not installed." }); }
    match std::process::Command::new(exe()).args(["-p", PROFILE]).current_dir(root()).spawn() {
        Ok(_) => json!({ "success": true }),
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

#[tauri::command]
pub fn mo2_status() -> Value {
    let mod_count = fs::read_dir(mods_dir()).map(|rd| rd.flatten().filter(|e| e.path().is_dir()).count()).unwrap_or(0);
    json!({ "installed": is_installed(), "version": MO2_VERSION, "root": root().to_string_lossy(), "modCount": mod_count })
}
