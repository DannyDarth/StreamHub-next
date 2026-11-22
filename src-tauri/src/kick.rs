//! Kick: live status of the user's Kick channels.
//!
//! Kick's public API has no "followed channels" list, so (like StreamHub 1.x) StreamHub keeps the
//! user's own list of Kick channels and checks each one. kick.com doesn't allow cross-origin
//! requests from the UI, so the requests are made here.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::streamlink::valid_kick_slug;

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KickChannel {
    pub slug: String,
    pub name: String,
    pub live: bool,
    pub title: String,
    pub category: String,
    pub viewers: Option<u64>,
    pub thumbnail: Option<String>,
    pub avatar: Option<String>,
    pub started_at: Option<String>,
    pub error: Option<String>,
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Kick sometimes returns an image as a srcset ("url 1x, url 2x") or an object.
fn image_url(value: &Value) -> Option<String> {
    let raw = match value {
        Value::String(s) => s.clone(),
        Value::Object(map) => ["src", "url", "responsive"]
            .iter()
            .find_map(|key| map.get(*key).and_then(text))?,
        _ => return None,
    };
    let first = raw.split(',').next()?.split_whitespace().next()?;
    first.starts_with("https://").then(|| first.to_string())
}

/// Read Kick's /api/v2/channels/{slug} response.
pub fn parse_channel(slug: &str, data: &Value) -> KickChannel {
    let user = &data["user"];
    let live = &data["livestream"];
    let is_live = live.is_object() && live["is_live"].as_bool().unwrap_or(true);

    KickChannel {
        slug: slug.to_string(),
        name: text(&user["username"]).unwrap_or_else(|| slug.to_string()),
        live: is_live,
        title: if is_live { text(&live["session_title"]).unwrap_or_default() } else { String::new() },
        category: if is_live {
            text(&live["categories"][0]["name"])
                .or_else(|| text(&live["category"]["name"]))
                .unwrap_or_default()
        } else {
            String::new()
        },
        viewers: if is_live { live["viewer_count"].as_u64().or_else(|| live["viewers"].as_u64()) } else { None },
        thumbnail: if is_live { image_url(&live["thumbnail"]) } else { None },
        avatar: text(&user["profile_pic"]).filter(|u| u.starts_with("https://")),
        started_at: if is_live { text(&live["created_at"]).or_else(|| text(&live["start_time"])) } else { None },
        error: None,
    }
}

async fn check(client: reqwest::Client, slug: String) -> KickChannel {
    let url = format!("https://kick.com/api/v2/channels/{slug}");
    let result = async {
        let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
        match res.status().as_u16() {
            200 => {}
            404 => return Err("Channel not found".to_string()),
            code => return Err(format!("Kick returned {code}")),
        }
        res.json::<Value>().await.map_err(|e| e.to_string())
    }
    .await;

    match result {
        Ok(data) => parse_channel(&slug, &data),
        Err(error) => KickChannel { name: slug.clone(), slug, error: Some(error), ..Default::default() },
    }
}

/// Check which of these Kick channels are live.
#[tauri::command]
pub async fn kick_channels(slugs: Vec<String>) -> Result<Vec<KickChannel>, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .default_headers({
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(reqwest::header::ACCEPT, "application/json".parse().unwrap());
            headers
        })
        .build()
        .map_err(|e| e.to_string())?;

    let mut slugs: Vec<String> = slugs.into_iter().map(|s| s.trim().to_ascii_lowercase()).collect();
    slugs.retain(|s| valid_kick_slug(s));
    slugs.dedup();

    let mut channels = Vec::with_capacity(slugs.len());
    // a few at a time, to be gentle with kick.com
    for chunk in slugs.chunks(5) {
        let tasks: Vec<_> = chunk
            .iter()
            .map(|slug| tauri::async_runtime::spawn(check(client.clone(), slug.clone())))
            .collect();
        for task in tasks {
            channels.push(task.await.map_err(|e| e.to_string())?);
        }
    }
    Ok(channels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_live_channel() {
        let data = json!({
            "user": { "username": "SomeStreamer", "profile_pic": "https://files.kick.com/a.webp" },
            "livestream": {
                "is_live": true,
                "session_title": "Hello",
                "viewer_count": 1234,
                "created_at": "2026-11-22 20:00:00",
                "thumbnail": { "src": "https://images.kick.com/t/720.webp 720w, https://images.kick.com/t/1080.webp 1080w" },
                "categories": [{ "name": "Just Chatting" }]
            }
        });
        let channel = parse_channel("somestreamer", &data);
        assert_eq!(
            channel,
            KickChannel {
                slug: "somestreamer".into(),
                name: "SomeStreamer".into(),
                live: true,
                title: "Hello".into(),
                category: "Just Chatting".into(),
                viewers: Some(1234),
                thumbnail: Some("https://images.kick.com/t/720.webp".into()),
                avatar: Some("https://files.kick.com/a.webp".into()),
                started_at: Some("2026-11-22 20:00:00".into()),
                error: None,
            }
        );
    }

    #[test]
    fn parses_an_offline_channel() {
        let data = json!({ "user": { "username": "Quiet" }, "livestream": null });
        let channel = parse_channel("quiet", &data);
        assert!(!channel.live);
        assert_eq!(channel.name, "Quiet");
        assert_eq!(channel.viewers, None);
        assert_eq!(channel.thumbnail, None);
    }

    #[test]
    fn image_urls() {
        assert_eq!(image_url(&json!("https://x/a.png")), Some("https://x/a.png".into()));
        assert_eq!(image_url(&json!({ "url": "http://x/a.png" })), None);
        assert_eq!(image_url(&json!(null)), None);
    }
}
