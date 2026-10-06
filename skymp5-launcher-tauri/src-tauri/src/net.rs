// HTTP helpers: JSON calls to the backend and streamed downloads
use crate::loc::loc;
use futures_util::StreamExt;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

pub const API_URL: &str = "https://api.alduinak.com";

pub fn api_url() -> String {
    std::env::var("API_URL").unwrap_or_else(|_| API_URL.to_string())
}

// Same-host redirects only, never https to http, so a session header cannot leak to another origin
pub fn client() -> reqwest::Client {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        let first = attempt.previous().first().cloned();
        let ok = match first {
            Some(prev) => prev.host_str() == attempt.url().host_str() && !(prev.scheme() == "https" && attempt.url().scheme() != "https"),
            None => true,
        };
        if ok && attempt.previous().len() <= 3 { attempt.follow() } else { attempt.stop() }
    });
    reqwest::Client::builder()
        .redirect(policy)
        .user_agent(concat!("AlduinakLauncher/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

// Free-form redirects for CDN downloads (GitHub, Nexus, SKSE)
pub fn download_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("AlduinakLauncher/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

#[derive(Debug)]
pub struct HttpError {
    pub status: Option<u16>,
    pub server_error: Option<String>,
    pub message: String,
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn err(msg: impl Into<String>) -> HttpError {
    HttpError { status: None, server_error: None, message: msg.into() }
}

pub async fn fetch_json(url: &str, headers: &[(&str, &str)]) -> Result<Value, HttpError> {
    fetch_json_within(url, headers, 10).await
}

// For large documents such as the install manifest, which a slow connection cannot fetch in 10 seconds
pub async fn fetch_json_within(url: &str, headers: &[(&str, &str)], secs: u64) -> Result<Value, HttpError> {
    let mut req = client().get(url).timeout(Duration::from_secs(secs));
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = req.send().await.map_err(|e| err(request_failed(url, e)))?;
    let res = success_or_error(res, url).await?;
    res.json::<Value>().await.map_err(|e| err(invalid_json(url, e)))
}

fn request_failed(url: &str, e: reqwest::Error) -> String {
    loc("net.requestFailed", &[("url", url), ("error", &e.to_string())])
}

fn invalid_json(url: &str, e: impl std::fmt::Display) -> String {
    loc("net.invalidJson", &[("url", url), ("error", &e.to_string())])
}

fn http_status(status: reqwest::StatusCode, url: &str) -> String {
    loc("net.http", &[("status", &status.as_u16().to_string()), ("url", url)])
}

async fn success_or_error(res: reqwest::Response, url: &str) -> Result<reqwest::Response, HttpError> {
    let status = res.status();
    if status.is_redirection() {
        return Err(HttpError { status: Some(status.as_u16()), server_error: None, message: loc("net.redirect", &[("status", &status.as_u16().to_string()), ("url", url)]) });
    }
    if !status.is_success() {
        // Backend errors carry an explanatory { error }
        let detail = res.json::<Value>().await.ok().and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from));
        let message = match &detail {
            Some(d) => loc("net.httpDetail", &[("status", &status.as_u16().to_string()), ("url", url), ("detail", d)]),
            None => http_status(status, url),
        };
        return Err(HttpError { status: Some(status.as_u16()), server_error: detail, message });
    }
    Ok(res)
}

// A JSON document kept in cache and sent back as its own sha256: the server answers 304 only when its copy has the same hash,
// so an edited or stale cache is simply downloaded again
pub async fn fetch_json_cached(url: &str, cache: &std::path::Path, secs: u64) -> Result<Value, HttpError> {
    use sha2::{Digest, Sha256};
    let cached = std::fs::read(cache).ok();
    let mut req = client().get(url).timeout(Duration::from_secs(secs));
    if let Some(bytes) = &cached {
        req = req.header("If-None-Match", format!("\"{}\"", hex::encode(Sha256::digest(bytes))));
    }
    let res = req.send().await.map_err(|e| err(request_failed(url, e)))?;
    if res.status() == reqwest::StatusCode::NOT_MODIFIED {
        if let Some(v) = cached.and_then(|b| serde_json::from_slice::<Value>(&b).ok()) { return Ok(v); }
        return fetch_json_within(url, &[], secs).await;
    }
    let res = success_or_error(res, url).await?;
    let bytes = res.bytes().await.map_err(|e| err(loc("net.downloadFailedUrl", &[("url", url), ("error", &e.to_string())])))?;
    let v = serde_json::from_slice::<Value>(&bytes).map_err(|e| err(invalid_json(url, e)))?;
    let _ = std::fs::write(cache, &bytes);
    Ok(v)
}

pub async fn post_json(url: &str, body: &Value, headers: &[(&str, &str)]) -> Result<Value, HttpError> {
    let mut req = client().post(url).json(body).timeout(Duration::from_secs(10));
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = req.send().await.map_err(|e| err(request_failed(url, e)))?;
    let status = res.status();
    if !status.is_success() {
        return Err(HttpError { status: Some(status.as_u16()), server_error: None, message: http_status(status, url) });
    }
    res.json::<Value>().await.map_err(|e| err(invalid_json(url, e)))
}

// Refuses remote plain-HTTP payloads; loopback stays allowed for a local dev backend
fn assert_secure(url: &str) -> Result<(), String> {
    let u = url::Url::parse(url).map_err(|e| e.to_string())?;
    let local = matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("::1"));
    if u.scheme() == "https" || local { Ok(()) } else { Err(loc("net.insecure", &[("url", url)])) }
}

// Streams url to dest; a failed or partial download leaves no file behind
pub async fn download_file(
    url: &str,
    dest: &Path,
    headers: &[(&str, &str)],
    mut on_progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    assert_secure(url)?;
    let mut req = download_client().get(url).timeout(Duration::from_secs(60 * 60));
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = req.send().await.map_err(|e| loc("net.downloadFailed", &[("error", &e.to_string())]))?;
    if !res.status().is_success() {
        return Err(loc("net.httpDownloading", &[("status", &res.status().as_u16().to_string()), ("url", url)]));
    }
    let total = res.content_length().unwrap_or(0);
    if let Some(dir) = dest.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    let result = async {
        let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
        let mut stream = res.bytes_stream();
        let mut received = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| loc("net.interrupted", &[("error", &e.to_string())]))?;
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            received += chunk.len() as u64;
            on_progress(received, total);
        }
        file.flush().await.map_err(|e| e.to_string())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(dest).await;
    }
    result
}
