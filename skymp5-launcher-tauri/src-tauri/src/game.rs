// Finding and vetting the player's Skyrim install: registry probes, store edition, exe version and hash
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use winreg::enums::HKEY_LOCAL_MACHINE;
use winreg::RegKey;

pub const GAME_VERSION_STEAM: &str = "1.6.1170.0";
pub const GAME_VERSION_GOG: &str = "1.6.1179.0";

// sha256 of the supported SkyrimSE.exe builds (Steam 1.6.1170, GOG 1.6.1179); a manifest gameExes list replaces it
pub static KNOWN_GAME_EXES: Mutex<Option<Vec<String>>> = Mutex::new(None);
const BUILT_IN_GAME_EXES: [&str; 2] = [
    "c434208894f07f604b852f29b8edc3a58c4de63de783373733e72b2b73f33be9",
    "9b0fc7880c4b12d436bfb59bcae64868f176dbc04010adbd9bc2ecb64bc8ed3f",
];

pub fn is_valid_skyrim_path(p: &str) -> bool {
    !p.is_empty() && Path::new(p).join("SkyrimSE.exe").exists()
}

pub fn reg_value(key: &str, value: &str) -> Option<String> {
    RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(key).ok()?.get_value::<String, _>(value).ok().map(|s| s.trim().to_string())
}

// Registry keys the store editions write at install time, then every GOG game key, then common Steam library roots
pub fn detect_skyrim_path() -> Option<String> {
    let probes = [
        (r"SOFTWARE\WOW6432Node\GOG.com\Games\1801825368", "path"),
        (r"SOFTWARE\WOW6432Node\GOG.com\Games\1711230643", "path"),
        (r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 489830", "InstallLocation"),
        (r"SOFTWARE\WOW6432Node\Bethesda Softworks\Skyrim Special Edition", "installed path"),
    ];
    let mut candidates: Vec<String> = probes.iter().filter_map(|(k, v)| reg_value(k, v)).collect();
    for root in [r"SOFTWARE\WOW6432Node\GOG.com\Games", r"SOFTWARE\GOG.com\Games"] {
        if let Ok(games) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(root) {
            for name in games.enum_keys().flatten() {
                if let Some(p) = reg_value(&format!(r"{root}\{name}"), "path") {
                    candidates.push(p);
                }
            }
        }
    }
    let suffix = r"steamapps\common\Skyrim Special Edition";
    for drive in ["C", "D", "E", "F", "G"] {
        for base in [r"Program Files (x86)\Steam", "Steam", "SteamLibrary", r"Games\Steam"] {
            candidates.push(format!(r"{drive}:\{base}\{suffix}"));
        }
    }
    candidates.into_iter().find(|p| is_valid_skyrim_path(p))
}

// Store edition by its files; Unknown when no store marker is present
pub fn detect_edition(dir: &str) -> String {
    let names: Vec<String> = fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
    let lower: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();
    let has = |n: &str| lower.iter().any(|x| x == n);
    if has("galaxy64.dll") || lower.iter().any(|n| n.starts_with("goggame-") && (n.ends_with(".info") || n.ends_with(".dll") || n.ends_with(".hashdb"))) {
        return "GOG".into();
    }
    if has("eossdk-win64-shipping.dll") {
        return "Epic Games".into();
    }
    if lower.iter().any(|n| n.starts_with("gaming.desktop") || n.starts_with("appxmanifest")) {
        return "Game Pass".into();
    }
    if has("steam_api64.dll") {
        return "Steam".into();
    }
    "Unknown".into()
}

fn read_at(f: &mut fs::File, size: u64, off: u64, len: usize) -> Option<Vec<u8>> {
    if off + len as u64 > size { return None; }
    f.seek(SeekFrom::Start(off)).ok()?;
    let mut b = vec![0u8; len];
    f.read_exact(&mut b).ok()?;
    Some(b)
}
fn u16le(b: &[u8], o: usize) -> u64 { u16::from_le_bytes([b[o], b[o + 1]]) as u64 }
fn u32le(b: &[u8], o: usize) -> u64 { u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as u64 }

// Resource directory entries (id, offset) at rel inside the .rsrc section
fn rsrc_entries(f: &mut fs::File, size: u64, rsrc_off: u64, rel: u64) -> Option<Vec<(u64, u64)>> {
    let hdr = read_at(f, size, rsrc_off + rel, 16)?;
    let n = (u16le(&hdr, 12) + u16le(&hdr, 14)) as usize;
    let ents = read_at(f, size, rsrc_off + rel + 16, n * 8)?;
    Some((0..n).map(|i| (u32le(&ents, i * 8), u32le(&ents, i * 8 + 4))).collect())
}

// FileVersion from VS_FIXEDFILEINFO in the exe's RT_VERSION resource
pub fn pe_file_version(exe: &Path) -> Option<String> {
    let mut f = fs::File::open(exe).ok()?;
    let size = f.metadata().ok()?.len();
    let dos = read_at(&mut f, size, 0, 64)?;
    if u16le(&dos, 0) != 0x5a4d { return None; }
    let pe = u32le(&dos, 0x3c);
    let coff = read_at(&mut f, size, pe, 24)?;
    if u32le(&coff, 0) != 0x4550 { return None; }
    let num_sections = u16le(&coff, 6);
    let opt_size = u16le(&coff, 20);
    let opt = read_at(&mut f, size, pe + 24, opt_size as usize)?;
    let dir_base = match u16le(&opt, 0) { 0x20b => 112, 0x10b => 96, _ => return None };
    let rsrc_rva = u32le(&opt, dir_base + 16);
    if rsrc_rva == 0 { return None; }
    let sect = read_at(&mut f, size, pe + 24 + opt_size, (num_sections * 40) as usize)?;
    let mut map: Option<(u64, u64)> = None;
    for i in 0..num_sections as usize {
        let va = u32le(&sect, i * 40 + 12);
        let raw = u32le(&sect, i * 40 + 16);
        let ptr = u32le(&sect, i * 40 + 20);
        let vs = u32le(&sect, i * 40 + 8).max(raw);
        if rsrc_rva >= va && rsrc_rva < va + vs { map = Some((va, ptr)); break; }
    }
    let (va, ptr) = map?;
    let rva2off = |rva: u64| rva - va + ptr;
    let rsrc_off = rva2off(rsrc_rva);
    let hi = 0x8000_0000u64;
    let ty = rsrc_entries(&mut f, size, rsrc_off, 0)?.into_iter().find(|(id, off)| *id == 16 && off & hi != 0)?;
    let name = rsrc_entries(&mut f, size, rsrc_off, ty.1 & !hi)?.into_iter().find(|(_, off)| off & hi != 0)?;
    let lang = rsrc_entries(&mut f, size, rsrc_off, name.1 & !hi)?.into_iter().find(|(_, off)| off & hi == 0)?;
    let data_entry = read_at(&mut f, size, rsrc_off + lang.1, 16)?;
    let blob = read_at(&mut f, size, rva2off(u32le(&data_entry, 0)), (u32le(&data_entry, 4) as usize).min(1 << 16))?;
    let sig = blob.windows(4).position(|w| w == [0xbd, 0x04, 0xef, 0xfe])?;
    if sig + 16 > blob.len() { return None; }
    let ms = u32le(&blob, sig + 8);
    let ls = u32le(&blob, sig + 12);
    Some(format!("{}.{}.{}.{}", ms >> 16, ms & 0xffff, ls >> 16, ls & 0xffff))
}

// An unreadable version never blocks, so an odd build only logs
pub fn version_ok(dir: &str, edition: &str) -> bool {
    match pe_file_version(&Path::new(dir).join("SkyrimSE.exe")) {
        None => true,
        Some(v) => v == GAME_VERSION_STEAM || (edition == "GOG" && v == GAME_VERSION_GOG),
    }
}

pub fn sha256_file(p: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 { break; }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

static EXE_HASHES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

// Cached by path and modified time: the exe is large and read on every path check
fn exe_hash(exe: &Path) -> String {
    let mtime = fs::metadata(exe).and_then(|m| m.modified()).map(|t| format!("{t:?}")).unwrap_or_default();
    let key = format!("{}|{mtime}", exe.display());
    let mut cache = EXE_HASHES.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some(h) = cache.get(&key) { return h.clone(); }
    let h = sha256_file(exe).unwrap_or_default();
    cache.insert(key, h.clone());
    h
}

// Why a Skyrim folder cannot be installed or played, None when it is fine
pub fn source_problem(dir: &str) -> Option<String> {
    if !is_valid_skyrim_path(dir) {
        return Some("This folder is not a valid Skyrim install: SkyrimSE.exe was not found.".into());
    }
    let edition = detect_edition(dir);
    if edition != "Steam" && edition != "GOG" {
        return Some(format!("{edition} versions of the game are not supported."));
    }
    if !version_ok(dir, &edition) {
        return Some("Skyrim Version is not Correct. Please update/downgrade.".into());
    }
    let hash = exe_hash(&PathBuf::from(dir).join("SkyrimSE.exe"));
    let known = KNOWN_GAME_EXES.lock().unwrap().clone().unwrap_or_else(|| BUILT_IN_GAME_EXES.iter().map(|s| s.to_string()).collect());
    if !known.contains(&hash) {
        return Some("Unknown versions of the game are not supported.".into());
    }
    None
}
