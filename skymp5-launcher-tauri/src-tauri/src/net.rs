// HTTP helpers: JSON calls to the backend and streamed downloads
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
    let mut req = client().get(url).timeout(Duration::from_secs(10));
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = req.send().await.map_err(|e| err(format!("Request failed: {url}: {e}")))?;
    let status = res.status();
    if status.is_redirection() {
        return Err(HttpError { status: Some(status.as_u16()), server_error: None, message: format!("HTTP {} from {url} (redirect refused)", status.as_u16()) });
    }
    if !status.is_success() {
        // Backend errors carry an explanatory { error }
        let detail = res.json::<Value>().await.ok().and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from));
        let message = match &detail {
            Some(d) => format!("HTTP {} from {url}: {d}", status.as_u16()),
            None => format!("HTTP {} from {url}", status.as_u16()),
        };
        return Err(HttpError { status: Some(status.as_u16()), server_error: detail, message });
    }
    res.json::<Value>().await.map_err(|e| err(format!("Invalid JSON from {url}: {e}")))
}

pub async fn post_json(url: &str, body: &Value, headers: &[(&str, &str)]) -> Result<Value, HttpError> {
    let mut req = client().post(url).json(body).timeout(Duration::from_secs(10));
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = req.send().await.map_err(|e| err(format!("Request failed: {url}: {e}")))?;
    let status = res.status();
    if !status.is_success() {
        return Err(HttpError { status: Some(status.as_u16()), server_error: None, message: format!("HTTP {} from {url}", status.as_u16()) });
    }
    res.json::<Value>().await.map_err(|e| err(format!("Invalid JSON from {url}: {e}")))
}

// Refuses remote plain-HTTP payloads; loopback stays allowed for a local dev backend
fn assert_secure(url: &str) -> Result<(), String> {
    let u = url::Url::parse(url).map_err(|e| e.to_string())?;
    let local = matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("::1"));
    if u.scheme() == "https" || local { Ok(()) } else { Err(format!("Refusing to download over an insecure (non-HTTPS) URL: {url}")) }
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
    let res = req.send().await.map_err(|e| format!("Download failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} downloading {url}", res.status().as_u16()));
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
            let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
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
