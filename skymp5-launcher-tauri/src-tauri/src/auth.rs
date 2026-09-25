// Discord and Nexus logins, and the hardware id the backend's ban system matches
use crate::{effective_game_path, game, log, net, store};
use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::time::{Duration, Instant};
use tauri_plugin_opener::OpenerExt;

const NEXUS_OAUTH_BASE: &str = "https://users.nexusmods.com";
const NEXUS_CLIENT_ID: &str = "skyrp";
const NEXUS_OAUTH_PORT: u16 = 48521;
const APP_NAME: &str = "alduinak-launcher";

// Nexus API policy: every request carries the application name and version
pub fn nexus_headers() -> Vec<(&'static str, String)> {
    vec![
        ("User-Agent", format!("{APP_NAME}/{}", env!("CARGO_PKG_VERSION"))),
        ("Application-Name", APP_NAME.into()),
        ("Application-Version", env!("CARGO_PKG_VERSION").into()),
    ]
}

fn open_url(app: &tauri::AppHandle, url: &str) {
    let _ = app.opener().open_url(url, None::<&str>);
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

// Stable per-machine id (Windows MachineGuid); optional, the backend treats it as a hint
fn hwid() -> Option<String> {
    game::reg_value(r"SOFTWARE\Microsoft\Cryptography", "MachineGuid").filter(|g| g.len() >= 10 && g.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
}

async fn report_hwid(token: String) {
    let Some(hwid) = hwid() else { return };
    let auth = format!("Bearer {token}");
    if let Err(e) = net::post_json(&format!("{}/api/users/me/hwid", net::api_url()), &json!({ "hwid": hwid }), &[("Authorization", &auth)]).await {
        log(format!("[hwid] report failed ({e}) - continuing without it"));
    }
}

// Opens the backend's Discord login in the browser and polls its status until the player finishes
#[tauri::command]
pub async fn discord_login(app: tauri::AppHandle) -> Value {
    let state = random_hex(32);
    open_url(&app, &format!("{}/api/users/login-discord?state={state}", net::api_url()));
    let deadline = Instant::now() + Duration::from_secs(300);
    let (mut unexpected, mut registered) = (0, false);
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(2)).await;
        match net::fetch_json(&format!("{}/api/users/login-discord/status?state={state}", net::api_url()), &[]).await {
            Err(e) if e.status == Some(401) => { registered = true; unexpected = 0; }
            // The state exists only once the browser has loaded the login URL, so an early 403 means it is still opening
            Err(e) if e.status == Some(403) => {
                if registered { return json!({ "success": false, "error": "Login attempt expired - please try again." }); }
            }
            Err(e) => {
                unexpected += 1;
                log(format!("[discord] status poll failed ({e}), {unexpected} in a row"));
                if unexpected >= 10 { return json!({ "success": false, "error": format!("Cannot read the login status from the backend ({e}).") }); }
            }
            Ok(data) => {
                let id = data["masterApiId"].clone();
                let name = data["discordUsername"].as_str().map(String::from).unwrap_or_else(|| format!("Player {id}"));
                let user = json!({ "username": name, "tag": name, "avatar": data["discordAvatar"] });
                let token = data["token"].as_str().unwrap_or("").to_string();
                store().set_many(vec![("discordUser".into(), user.clone()), ("gameProfileId".into(), id.clone()), ("gameSession".into(), json!(token))]);
                log(format!("[discord] logged in as {name} (profileId {id})"));
                tokio::spawn(report_hwid(token));
                return json!({ "success": true, "user": user });
            }
        }
    }
    json!({ "success": false, "error": "Login timed out - please try again." })
}

#[tauri::command]
pub fn discord_logout() -> Value {
    store().set_many(vec![("discordUser".into(), Value::Null), ("gameProfileId".into(), Value::Null), ("gameSession".into(), Value::Null)]);
    // //null makes the in-game client show its own login again
    let game = effective_game_path();
    if !game.is_empty() {
        let _ = std::fs::write(Path::new(&game).join("Data").join("Platform").join("PluginsNoLoad").join("auth-data-no-load.js"), "//null");
    }
    json!({ "success": true })
}

#[tauri::command]
pub fn nexus_get_user() -> Value {
    store().get("nexusUser")
}

#[tauri::command]
pub fn nexus_logout() -> Value {
    store().set_many(vec![("nexusOauth".into(), Value::Null), ("nexusUser".into(), Value::Null)]);
    json!({ "success": true })
}

async fn post_form(url: &str, params: &[(&str, &str)]) -> Result<Value, String> {
    let mut req = net::download_client().post(url).form(params).header("accept", "application/json").timeout(Duration::from_secs(15));
    for (k, v) in nexus_headers() { req = req.header(k, v); }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(body["error_description"].as_str().or(body["error"].as_str()).map(String::from).unwrap_or_else(|| format!("HTTP {status} from Nexus")));
    }
    Ok(body)
}

async fn oauth_user_info(token: &str) -> Result<Value, String> {
    let mut req = net::download_client().get(format!("{NEXUS_OAUTH_BASE}/oauth/userinfo")).bearer_auth(token).timeout(Duration::from_secs(15));
    for (k, v) in nexus_headers() { req = req.header(k, v); }
    let res = req.send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() { return Err(format!("Nexus userinfo HTTP {}", res.status())); }
    let info: Value = res.json().await.map_err(|e| e.to_string())?;
    let premium = info["membership_roles"].as_array().is_some_and(|r| r.iter().any(|x| x == "premium"));
    Ok(json!({ "name": info["name"].as_str().unwrap_or("Nexus user"), "isPremium": premium, "profileUrl": info["avatar"] }))
}

fn store_tokens(t: &Value, previous_refresh: Option<&str>) -> String {
    let access = t["access_token"].as_str().unwrap_or("").to_string();
    let expires = crate::proc::now_ms() + t["expires_in"].as_u64().map(|s| s * 1000).unwrap_or(6 * 3600 * 1000);
    store().set("nexusOauth", json!({
        "accessToken": access,
        "refreshToken": t["refresh_token"].as_str().or(previous_refresh),
        "expiresAt": expires,
    }));
    access
}

fn callback_page(ok: bool, message: &str) -> String {
    let accent = if ok { "#c8a25f" } else { "#c0564f" };
    let title = if ok { "Logged in to Nexus" } else { "Nexus login failed" };
    let note = if ok { "This tab will close itself…".to_string() } else { message.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;") };
    let script = if ok { r#"<script>window.close();setTimeout(function(){var n=document.getElementById("note");if(n)n.textContent="You can close this tab and return to the launcher."},600)</script>"# } else { "" };
    format!(r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Alduinak - Nexus login</title><style>html,body{{height:100%;margin:0}}body{{display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at center,#16120d 0%,#0b0906 70%);color:#d8cdb8;font-family:Georgia,serif;text-align:center}}h1{{color:{accent};font-weight:normal;letter-spacing:.12em;text-transform:uppercase;font-size:1.4rem}}p{{color:#857a66}}</style></head><body><div><h1>{title}</h1><p id="note">{note}</p></div>{script}</body></html>"#)
}

// Waits on the loopback callback for the authorization code, answering the browser with a result page
fn wait_for_code(listener: TcpListener, state: &str) -> Result<(String, std::net::TcpStream), String> {
    listener.set_nonblocking(false).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        if Instant::now() > deadline { return Err("Nexus login timed out - try again.".into()); }
        let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let target = req.split_whitespace().nth(1).unwrap_or("/").to_string();
        let url = url::Url::parse(&format!("http://127.0.0.1{target}")).map_err(|e| e.to_string())?;
        if url.path() != "/nexus/callback" {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            continue;
        }
        let q: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
        let fail = |mut s: std::net::TcpStream, msg: String| {
            let page = callback_page(false, &msg);
            let _ = write!(s, "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{page}", page.len());
            Err(msg)
        };
        if let Some(err) = q.get("error") { return fail(stream, format!("Nexus reported: {}", q.get("error_description").unwrap_or(err))); }
        if q.get("state").map(String::as_str) != Some(state) { return fail(stream, "OAuth state mismatch - start the login again from the launcher.".into()); }
        let Some(code) = q.get("code") else { return fail(stream, "The Nexus reply carried no authorization code.".into()) };
        return Ok((code.clone(), stream));
    }
}

// OAuth authorization code + PKCE through a short-lived loopback listener on the registered port
#[tauri::command]
pub async fn nexus_login(app: tauri::AppHandle) -> Value {
    let b64 = |b: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
    let mut v = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut v);
    let verifier = b64(&v);
    let challenge = b64(&Sha256::digest(verifier.as_bytes()));
    let state = b64(&rand::random::<[u8; 16]>());
    let redirect = format!("http://127.0.0.1:{NEXUS_OAUTH_PORT}/nexus/callback");
    let listener = match TcpListener::bind(("127.0.0.1", NEXUS_OAUTH_PORT)) {
        Ok(l) => l,
        Err(_) => return json!({ "success": false, "error": format!("Port {NEXUS_OAUTH_PORT} is already in use - close whatever is using it and try again.") }),
    };
    let params = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("response_type", "code").append_pair("client_id", NEXUS_CLIENT_ID).append_pair("redirect_uri", &redirect)
        .append_pair("scope", "openid profile").append_pair("state", &state).append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256").finish();
    open_url(&app, &format!("{NEXUS_OAUTH_BASE}/oauth/authorize?{params}"));
    let st = state.clone();
    let waited = tokio::task::spawn_blocking(move || wait_for_code(listener, &st)).await;
    let (code, mut stream) = match waited {
        Ok(Ok(x)) => x,
        Ok(Err(e)) => return json!({ "success": false, "error": e }),
        Err(e) => return json!({ "success": false, "error": e.to_string() }),
    };
    let result = async {
        let tokens = post_form(&format!("{NEXUS_OAUTH_BASE}/oauth/token"), &[
            ("grant_type", "authorization_code"), ("client_id", NEXUS_CLIENT_ID), ("code", &code), ("redirect_uri", &redirect), ("code_verifier", &verifier),
        ]).await?;
        if tokens["access_token"].as_str().unwrap_or("").is_empty() { return Err("No access token in the token reply.".to_string()); }
        let access = store_tokens(&tokens, None);
        let user = oauth_user_info(&access).await?;
        store().set("nexusUser", user.clone());
        log(format!("[nexus] OAuth login as {} (premium: {})", user["name"], user["isPremium"]));
        Ok(user)
    }.await;
    let page = callback_page(result.is_ok(), result.as_ref().err().map(String::as_str).unwrap_or(""));
    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{page}", page.len());
    match result {
        Ok(user) => json!({ "success": true, "user": user }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

// The current Nexus bearer token, refreshed when close to expiry; None when logged out
pub async fn nexus_auth() -> Option<String> {
    let oauth = store().get("nexusOauth");
    let access = oauth["accessToken"].as_str()?.to_string();
    let near_expiry = oauth["expiresAt"].as_u64().is_some_and(|e| crate::proc::now_ms() + 60_000 > e);
    if let (true, Some(refresh)) = (near_expiry, oauth["refreshToken"].as_str()) {
        match post_form(&format!("{NEXUS_OAUTH_BASE}/oauth/token"), &[("grant_type", "refresh_token"), ("client_id", NEXUS_CLIENT_ID), ("refresh_token", refresh)]).await {
            Ok(t) => { log("[nexus] OAuth token refreshed"); return Some(store_tokens(&t, Some(refresh))); }
            Err(e) => log(format!("[nexus] token refresh failed: {e}")),
        }
    }
    Some(access)
}

// Premium-only direct download link for a mod file
pub async fn nexus_download_link(token: &str, mod_id: i64, file_id: i64) -> Result<String, String> {
    let url = format!("https://api.nexusmods.com/v1/games/skyrimspecialedition/mods/{mod_id}/files/{file_id}/download_link.json");
    let mut req = net::download_client().get(url).bearer_auth(token).header("accept", "application/json").timeout(Duration::from_secs(15));
    for (k, v) in nexus_headers() { req = req.header(k, v); }
    let res = req.send().await.map_err(|e| e.to_string())?;
    match res.status().as_u16() {
        401 => return Err("Nexus login expired - log in again.".into()),
        403 => return Err("Nexus refused the request (premium required?).".into()),
        s if !(200..300).contains(&s) => return Err(format!("Nexus API HTTP {s}")),
        _ => {}
    }
    let links: Value = res.json().await.map_err(|e| e.to_string())?;
    links[0]["URI"].as_str().map(String::from).ok_or_else(|| "Nexus returned no download link (premium account required).".into())
}
