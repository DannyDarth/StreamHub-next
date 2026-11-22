//! Twitch sign-in (OAuth implicit flow) through a local redirect server, like StreamHub 1.x.
//!
//! Twitch redirects the browser to http://localhost:65432/redirect#access_token=…
//! The token is in the URL fragment, which browsers never send to servers, so the redirect page
//! reads it with JavaScript and sends it to /token, where StreamHub picks it up.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

pub const CLIENT_ID: &str = "phiay4sq36lfv9zu7cbqwz2ndnesfd8";
const PORT: u16 = 65432;
const REDIRECT_URI: &str = "http://localhost:65432/redirect";
const SCOPES: &[&str] = &[
    "user:manage:blocked_users",
    "user:read:blocked_users",
    "user:read:follows",
    "user:read:subscriptions",
    "chat:edit",
    "chat:read",
    "whispers:edit",
    "whispers:read",
];
const TIMEOUT: Duration = Duration::from_secs(300);

const REDIRECT_PAGE: &str = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>StreamHub</title>
<style>body{font:16px system-ui,sans-serif;background:#0e0e10;color:#efeff1;display:grid;place-items:center;height:100vh;margin:0}</style>
</head><body><p id="m">Signing in to StreamHub…</p>
<script>
fetch("/token?" + location.hash.slice(1))
  .then(function (r) { return r.text(); })
  .then(function (t) { document.getElementById("m").textContent = t; })
  .catch(function () { document.getElementById("m").textContent = "Sign-in failed. Please try again in StreamHub."; });
</script></body></html>"#;

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'+', _) => out.push(b' '),
            (b'%', Some(v)) => {
                out.push(v);
                i += 2;
            }
            (b, _) => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

fn new_state() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}{:x}", nanos, std::process::id())
}

pub fn authorize_url(state: &str) -> String {
    format!(
        "https://id.twitch.tv/oauth2/authorize?response_type=token&client_id={}&redirect_uri={}&scope={}&state={}&force_verify=true",
        CLIENT_ID,
        percent_encode(REDIRECT_URI),
        percent_encode(&SCOPES.join(" ")),
        state
    )
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

/// Read the request line ("GET /path?query HTTP/1.1") and return the target.
fn read_target(stream: &TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?.to_string();
    // drain the headers
    let mut header = String::new();
    while reader.read_line(&mut header).ok()? > 2 {
        header.clear();
    }
    Some(target)
}

/// Serve the redirect page until a token with the right state arrives, or time out.
fn wait_for_token(listener: TcpListener, state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + TIMEOUT;

    while Instant::now() < deadline {
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

        let Some(target) = read_target(&stream) else { continue };
        let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));

        match path {
            "/redirect" => respond(&mut stream, "200 OK", "text/html", REDIRECT_PAGE),
            "/token" => {
                if let Some(error) = query_param(query, "error") {
                    respond(&mut stream, "200 OK", "text/plain", "Sign-in was cancelled. You can close this tab.");
                    return Err(format!("Twitch sign-in failed: {error}"));
                }
                let token = query_param(query, "access_token").unwrap_or_default();
                let valid = query_param(query, "state").as_deref() == Some(state)
                    && query_param(query, "token_type").as_deref() == Some("bearer")
                    && !token.is_empty()
                    && token.chars().all(|c| c.is_ascii_alphanumeric());
                if valid {
                    respond(&mut stream, "200 OK", "text/plain", "Signed in to StreamHub. You can close this tab.");
                    return Ok(token);
                }
                respond(&mut stream, "400 Bad Request", "text/plain", "Invalid sign-in response. Please try again.");
            }
            _ => respond(&mut stream, "404 Not Found", "text/plain", "Not found"),
        }
    }

    Err("Twitch sign-in timed out".into())
}

/// Open Twitch's sign-in page in the default browser and wait for the access token.
#[tauri::command]
pub async fn twitch_login(app: tauri::AppHandle) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", PORT))
        .map_err(|e| format!("Couldn't start the sign-in server on port {PORT}: {e}"))?;
    let state = new_state();
    app.opener()
        .open_url(authorize_url(&state), None::<&str>)
        .map_err(|e| format!("Couldn't open the browser: {e}"))?;

    let token = tauri::async_runtime::spawn_blocking(move || wait_for_token(listener, &state))
        .await
        .map_err(|e| e.to_string())??;

    // bring StreamHub back to the front
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_authorize_url() {
        let url = authorize_url("abc");
        assert!(url.contains("client_id=phiay4sq36lfv9zu7cbqwz2ndnesfd8"));
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A65432%2Fredirect"));
        assert!(url.contains("scope=user%3Amanage%3Ablocked_users%20"));
        assert!(url.ends_with("&state=abc&force_verify=true"));
    }

    #[test]
    fn reads_query_params() {
        let q = "access_token=abc123&scope=chat%3Aread+chat%3Aedit&state=xyz&token_type=bearer";
        assert_eq!(query_param(q, "access_token").as_deref(), Some("abc123"));
        assert_eq!(query_param(q, "scope").as_deref(), Some("chat:read chat:edit"));
        assert_eq!(query_param(q, "missing"), None);
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
