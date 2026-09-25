// Minimal ini reader and in-place editor; section and key names match without regard to case, like the engine
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub type Ini = HashMap<String, HashMap<String, String>>;
pub type Edits = Vec<(String, Vec<(String, String)>)>;

pub fn read(path: &Path) -> Ini {
    let mut out: Ini = HashMap::new();
    let Ok(text) = std::fs::read_to_string(path) else { return out };
    let mut section = String::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') { continue; }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].to_lowercase();
            out.entry(section.clone()).or_default();
            continue;
        }
        if let Some(eq) = line.find('=').filter(|&e| e > 0) {
            let k = line[..eq].trim().to_lowercase();
            let v = line[eq + 1..].trim().to_string();
            out.entry(section.clone()).or_default().entry(k).or_insert(v); // the first value wins, like the engine
        }
    }
    out
}

pub fn get<'a>(ini: &'a Ini, section: &str, key: &str) -> Option<&'a String> {
    ini.get(&section.to_lowercase())?.get(&key.to_lowercase())
}

// Applies edits in place, keeping every other line, comment and the file's line endings; missing keys and sections are appended
pub fn write(path: &Path, edits: &Edits) -> std::io::Result<()> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let eol = if text.contains("\r\n") || !text.contains('\n') { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = if text.is_empty() { vec![] } else { text.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect() };
    while lines.last().is_some_and(|l| l.is_empty()) { lines.pop(); }

    let want: HashMap<String, (&String, HashMap<String, (&String, &String)>)> = edits.iter()
        .map(|(s, kv)| (s.to_lowercase(), (s, kv.iter().map(|(k, v)| (k.to_lowercase(), (k, v))).collect())))
        .collect();
    let mut remaining: HashMap<String, Vec<String>> = edits.iter()
        .map(|(s, kv)| (s.to_lowercase(), kv.iter().map(|(k, _)| k.to_lowercase()).collect()))
        .collect();

    // Unwritten keys go after the section's last non-blank line
    let flush = |sec: &str, result: &mut Vec<String>, remaining: &mut HashMap<String, Vec<String>>| {
        let (Some((_, kv)), Some(keys)) = (want.get(sec), remaining.get_mut(sec)) else { return };
        let mut at = result.len();
        while at > 0 && result[at - 1].trim().is_empty() { at -= 1; }
        let add: Vec<String> = keys.iter().map(|k| { let (name, v) = kv[k]; format!("{name}={v}") }).collect();
        result.splice(at..at, add);
        keys.clear();
    };

    let mut result: Vec<String> = Vec::new();
    let mut cur = String::new();
    for raw in &lines {
        let t = raw.trim();
        if t.starts_with('[') && t.ends_with(']') {
            flush(&cur, &mut result, &mut remaining);
            cur = t[1..t.len() - 1].to_lowercase();
            result.push(raw.clone());
            continue;
        }
        let key = t.find('=').filter(|&e| e > 0).map(|e| t[..e].trim().to_string());
        if let Some(k) = key {
            if let Some((_, kv)) = want.get(&cur) {
                if let Some((_, v)) = kv.get(&k.to_lowercase()) {
                    result.push(format!("{k}={v}"));
                    if let Some(r) = remaining.get_mut(&cur) { r.retain(|x| *x != k.to_lowercase()); }
                    continue;
                }
            }
        }
        result.push(raw.clone());
    }
    flush(&cur, &mut result, &mut remaining);

    let mut seen = HashSet::new();
    for (s, _) in edits {
        let sec = s.to_lowercase();
        if !seen.insert(sec.clone()) || remaining.get(&sec).map_or(true, |r| r.is_empty()) { continue; }
        if result.last().is_some_and(|l| !l.trim().is_empty()) { result.push(String::new()); }
        result.push(format!("[{s}]"));
        flush(&sec, &mut result, &mut remaining);
    }

    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir)?; }
    let mut out = result.join(eol);
    if !result.is_empty() { out.push_str(eol); }
    std::fs::write(path, out)
}
