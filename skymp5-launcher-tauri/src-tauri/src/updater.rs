// Launcher self-update: compare with the backend's version, then download the installer and run it silently
use crate::{net, send};
use serde_json::{json, Value};
use std::io::Read;

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |s: &str| s.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..pa.len().max(pb.len()) {
        let c = pa.get(i).unwrap_or(&0).cmp(pb.get(i).unwrap_or(&0));
        if c.is_ne() { return c; }
    }
    std::cmp::Ordering::Equal
}

#[tauri::command]
pub async fn app_check_update(app: tauri::AppHandle) -> Value {
    let current = app.package_info().version.to_string();
    let current = current.as_str();
    match net::fetch_json(&format!("{}/api/version", net::api_url()), &[]).await {
        Ok(d) => {
            let latest = d["launcher"].as_str().unwrap_or("").to_string();
            json!({ "current": current, "latest": latest, "hasUpdate": compare_versions(&latest, current).is_gt(), "downloadUrl": d["launcherUrl"].as_str().unwrap_or("") })
        }
        Err(_) => json!({ "current": current, "latest": null, "hasUpdate": false, "downloadUrl": "" }),
    }
}

// The website ships the installer inside a zip; a plain exe at the same URL still works
fn unpack_update(pkg: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let mut magic = [0u8; 2];
    std::fs::File::open(pkg).and_then(|mut f| f.read_exact(&mut magic)).map_err(|e| e.to_string())?;
    if &magic != b"PK" { return std::fs::rename(pkg, dest).map_err(|e| e.to_string()); }
    send("update:progress", json!({ "phase": "extract" }));
    let mut zip = zip::ZipArchive::new(std::fs::File::open(pkg).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let exes: Vec<String> = zip.file_names().filter(|n| n.to_lowercase().ends_with(".exe")).map(String::from).collect();
    let pick = exes.iter().find(|n| n.to_lowercase().rsplit('/').next().is_some_and(|b| b.starts_with("alduinaklauncher") || b.starts_with("alduinak launcher")))
        .or(if exes.len() == 1 { exes.first() } else { None }).ok_or("The update package has no launcher installer.")?.clone();
    let mut entry = zip.by_name(&pick).map_err(|e| e.to_string())?;
    let mut out = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    drop(entry);
    let _ = std::fs::remove_file(pkg);
    Ok(())
}

#[tauri::command]
pub async fn app_install_update(app: tauri::AppHandle) -> Value {
    let result = async {
        let d = net::fetch_json(&format!("{}/api/version", net::api_url()), &[]).await.map_err(|e| e.message)?;
        let url = d["launcherUrl"].as_str().filter(|u| !u.is_empty()).ok_or("No download URL is configured on the server.")?.to_string();
        // The installer runs with the player's rights, so only HTTPS is accepted
        if !url.starts_with("https:") { return Err("Refusing to install an update from a non-HTTPS URL.".to_string()); }
        let tmp = std::env::temp_dir();
        let (pkg, dest) = (tmp.join("AlduinakLauncher-update.pkg"), tmp.join("AlduinakLauncher-update.exe"));
        send("update:progress", json!({ "phase": "download", "received": 0, "total": 0 }));
        net::download_file(&url, &pkg, &[], |r, t| send("update:progress", json!({ "phase": "download", "received": r, "total": t }))).await?;
        let _ = std::fs::remove_file(&dest);
        unpack_update(&pkg, &dest)?;
        send("update:progress", json!({ "phase": "install" }));
        // /S installs silently and /R relaunches the launcher once the files are replaced
        std::process::Command::new(&dest).args(["/S", "/R"]).spawn().map_err(|e| e.to_string())?;
        Ok(())
    }.await;
    match result {
        Ok(_) => {
            tauri::async_runtime::spawn(async move { tokio::time::sleep(std::time::Duration::from_millis(1200)).await; app.exit(0); });
            json!({ "ok": true })
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}
