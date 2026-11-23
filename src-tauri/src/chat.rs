//! Chat: Twitch and Kick chat in a panel on the right of StreamHub's window (the sites' own popout
//! chat), in the default browser, or in Chatterino.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Deserialize;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

use crate::streamlink::{valid_channel, valid_kick_slug, Platform};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatProvider {
    /// The chat panel on the right of StreamHub's window.
    #[serde(alias = "window")]
    Panel,
    Browser,
    Chatterino,
}

pub fn chat_url(platform: Platform, channel: &str) -> String {
    match platform {
        Platform::Twitch => format!("https://www.twitch.tv/popout/{channel}/chat?popout="),
        Platform::Kick => format!("https://kick.com/popout/{channel}/chat"),
    }
}

/// Pages the chat window may show itself (chat, signing in). Everything else opens in the browser.
pub fn allowed_in_chat_window(url: &tauri::Url) -> bool {
    if url.scheme() == "about" {
        return true;
    }
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    let under = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
    under("twitch.tv")
        || under("kick.com")
        || host == "accounts.google.com"
        || host == "appleid.apple.com"
}

fn find_chatterino() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for (var, sub) in [("LOCALAPPDATA", "Programs\\Chatterino"), ("PROGRAMFILES", "Chatterino")] {
        if let Some(base) = std::env::var_os(var) {
            candidates.push(Path::new(&base).join(sub).join("chatterino.exe"));
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&paths).map(|dir| dir.join("chatterino.exe")));
    }
    candidates.into_iter().find(|path| path.is_file())
}

pub const PANEL: &str = "chat-panel";
/// Width of the chat panel on the right of StreamHub's window, in logical pixels.
pub const PANEL_WIDTH: f64 = 340.0;
/// The panel starts below StreamHub's header and the panel's own title bar (drawn by the UI).
pub const PANEL_TOP: f64 = 52.0 + 40.0;

fn panel_bounds(window: &tauri::Window) -> Option<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let scale = window.scale_factor().ok()?;
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    let width = PANEL_WIDTH.min(size.width);
    Some((
        LogicalPosition::new(size.width - width, PANEL_TOP),
        LogicalSize::new(width, (size.height - PANEL_TOP).max(0.0)),
    ))
}

/// Keep the chat panel on the right edge when StreamHub's window is resized.
pub fn layout_panel(app: &AppHandle) {
    let (Some(window), Some(panel)) = (app.get_window("main"), app.get_webview(PANEL)) else { return };
    if let Some((position, size)) = panel_bounds(&window) {
        let _ = panel.set_position(position);
        let _ = panel.set_size(size);
    }
}

fn open_panel(app: &AppHandle, platform: Platform, channel: &str) -> Result<(), String> {
    let url: tauri::Url = chat_url(platform, channel).parse().map_err(|e| format!("{e}"))?;
    if let Some(panel) = app.get_webview(PANEL) {
        panel.navigate(url).map_err(|e| e.to_string())?;
        layout_panel(app);
        return Ok(());
    }

    let window = app.get_window("main").ok_or("StreamHub's window is missing")?;
    let (position, size) = panel_bounds(&window).ok_or("Couldn't size the chat panel")?;
    let browser = app.clone();
    let builder = WebviewBuilder::new(PANEL, WebviewUrl::External(url)).on_navigation(move |url| {
        if allowed_in_chat_window(url) {
            return true;
        }
        // links in chat open in the default browser
        if url.scheme() == "https" || url.scheme() == "http" {
            let _ = browser.opener().open_url(url.as_str(), None::<&str>);
        }
        false
    });
    window.add_child(builder, position, size).map_err(|e| e.to_string())?;
    Ok(())
}

/// Close the chat panel.
#[tauri::command]
pub async fn close_chat(app: AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview(PANEL) {
        panel.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open a channel's chat. Async: creating a webview in a synchronous command deadlocks on Windows
/// (that froze the old chat window and StreamHub's buttons).
#[tauri::command]
pub async fn open_chat(app: AppHandle, platform: Platform, channel: String, provider: ChatProvider) -> Result<(), String> {
    let channel = channel.to_ascii_lowercase();
    let valid = match platform {
        Platform::Twitch => valid_channel(&channel),
        Platform::Kick => valid_kick_slug(&channel),
    };
    if !valid {
        return Err("Invalid channel name".into());
    }

    match (provider, platform) {
        (ChatProvider::Browser, _) => app
            .opener()
            .open_url(chat_url(platform, &channel), None::<&str>)
            .map_err(|e| format!("Couldn't open the browser: {e}")),
        // Chatterino is Twitch only: Kick chat opens in the chat panel
        (ChatProvider::Chatterino, Platform::Twitch) => {
            let exe = find_chatterino()
                .ok_or("Chatterino wasn't found. Install it or pick another chat option in Settings.")?;
            let mut command = Command::new(exe);
            command
                .args(["--channels", &format!("t:{channel}")])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            command.spawn().map(|_| ()).map_err(|e| format!("Couldn't start Chatterino: {e}"))
        }
        _ => open_panel(&app, platform, &channel),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(url: &str) -> bool {
        allowed_in_chat_window(&url.parse().unwrap())
    }

    #[test]
    fn chat_urls() {
        assert_eq!(chat_url(Platform::Twitch, "abc"), "https://www.twitch.tv/popout/abc/chat?popout=");
        assert_eq!(chat_url(Platform::Kick, "a-b"), "https://kick.com/popout/a-b/chat");
    }

    #[test]
    fn chat_window_stays_on_chat_sites() {
        assert!(allowed("https://www.twitch.tv/popout/abc/chat?popout="));
        assert!(allowed("https://passport.twitch.tv/login"));
        assert!(allowed("https://kick.com/popout/abc/chat"));
        assert!(allowed("about:blank"));
        assert!(!allowed("http://www.twitch.tv/"));
        assert!(!allowed("https://eviltwitch.tv/"));
        assert!(!allowed("https://twitch.tv.example.com/"));
        assert!(!allowed("https://example.com/"));
    }
}
