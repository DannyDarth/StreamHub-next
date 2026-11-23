//! Chat: Twitch and Kick chat in a StreamHub window (the sites' own popout chat), in the default
//! browser, or in Chatterino, like StreamHub 1.x's chat options.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::streamlink::{valid_channel, valid_kick_slug, Platform};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatProvider {
    Window,
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

fn open_window(app: &AppHandle, platform: Platform, channel: &str) -> Result<(), String> {
    let site = match platform {
        Platform::Twitch => "twitch",
        Platform::Kick => "kick",
    };
    let label = format!("chat-{site}-{channel}");
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    let url = chat_url(platform, channel).parse().map_err(|e| format!("{e}"))?;
    let browser = app.clone();
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(format!("{channel} chat - StreamHub"))
        .inner_size(400.0, 760.0)
        .min_inner_size(280.0, 320.0)
        .on_navigation(move |url| {
            if allowed_in_chat_window(url) {
                return true;
            }
            // links in chat open in the default browser
            if url.scheme() == "https" || url.scheme() == "http" {
                let _ = browser.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Open a channel's chat.
#[tauri::command]
pub fn open_chat(app: AppHandle, platform: Platform, channel: String, provider: ChatProvider) -> Result<(), String> {
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
        // Chatterino is Twitch only: Kick chat opens in a StreamHub window
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
        _ => open_window(&app, platform, &channel),
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
