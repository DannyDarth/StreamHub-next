//! Kick: live status of the user's Kick channels.
//!
//! Kick's public API has no "followed channels" list, so (like StreamHub 1.x) StreamHub keeps the
//! user's own list of Kick channels and checks each one.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

use crate::streamlink::valid_kick_slug;

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
    pub bio: Option<String>,
    pub followers: Option<u64>,
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
        bio: text(&user["bio"]),
        followers: data["followers_count"].as_u64(),
        error: None,
    }
}

/// kick.com blocks requests that don't come from a real browser (it answered StreamHub's own
/// HTTP client with 403), so the requests are made by a hidden browser window on kick.com, like
/// StreamHub 1.x did. The window has no access to StreamHub's commands: the script hands the
/// results back by navigating to a special URL, which is cancelled and read here.
pub struct KickFetcher {
    next_id: AtomicU64,
    ready: tokio::sync::watch::Sender<bool>,
    pending: Mutex<HashMap<u64, oneshot::Sender<String>>>,
}

impl Default for KickFetcher {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(0),
            ready: tokio::sync::watch::channel(false).0,
            pending: Mutex::new(HashMap::new()),
        }
    }
}

const FETCHER: &str = "kick-fetcher";
const PAGE: &str = "https://kick.com/robots.txt";
const RESULT_HOST: &str = "streamhub.invalid";

/// Fetches the channels in the page and keeps only the fields StreamHub uses.
/// Runs a script body in the kick.com page and hands its result back (see `run_in_kick`).
const WRAPPER: &str = r#"
(async () => {
  const img = (b) => {
    if (!b) return null;
    const raw = typeof b === "string" ? b : (b.src || b.url || b.responsive || "");
    if (typeof raw !== "string") return null;
    const first = raw.split(",")[0].trim().split(/\s+/)[0];
    return /^https:\/\//.test(first) ? first : null;
  };
  let result;
  try {
    result = await (async () => {
__BODY__
    })();
  } catch (e) {
    result = { status: 0, error: String(e) };
  }
  location.href = "https://__HOST__/kick?id=__ID__&data=" + encodeURIComponent(JSON.stringify(result));
})();
"#;

/// Fetches the channels in the page and keeps only the fields StreamHub uses.
const CHANNELS: &str = r#"
  const pick = (d) => {
    const u = (d && d.user) || {};
    const l = d && d.livestream;
    return {
      user: { username: u.username, profile_pic: u.profile_pic, bio: u.bio },
      followers_count: d && d.followers_count,
      livestream: l ? {
        is_live: l.is_live, session_title: l.session_title, viewer_count: l.viewer_count, viewers: l.viewers,
        created_at: l.created_at, start_time: l.start_time, thumbnail: l.thumbnail,
        categories: (l.categories || []).slice(0, 1).map((c) => ({ name: c.name })),
        category: l.category ? { name: l.category.name } : null,
      } : null,
    };
  };
  const slugs = __SLUGS__;
  const out = [];
  for (let i = 0; i < slugs.length; i += 5) {
    out.push(...await Promise.all(slugs.slice(i, i + 5).map(async (slug) => {
      try {
        const res = await fetch(`/api/v2/channels/${encodeURIComponent(slug)}`, { headers: { Accept: "application/json" } });
        if (!res.ok) return { slug, status: res.status };
        return { slug, status: 200, data: pick(await res.json()) };
      } catch (e) {
        return { slug, status: 0, error: String(e) };
      }
    })));
  }
  return out;
"#;

/// Kick's categories, most watched first.
const CATEGORIES: &str = r#"
  const res = await fetch("/api/v1/subcategories?page=1&limit=40", { headers: { Accept: "application/json" } });
  if (!res.ok) return { status: res.status };
  const p = await res.json();
  const rows = Array.isArray(p) ? p : (p.data && (Array.isArray(p.data) ? p.data : p.data.data)) || p.subcategories || [];
  return {
    status: 200,
    items: rows.filter((r) => r && r.slug).map((r) => ({
      slug: r.slug,
      name: r.name || r.slug,
      image: img(r.banner) || img(r.thumbnail) || img(r.image) || img(r.banner_url),
      viewers: r.viewers ?? r.viewer_count ?? null,
    })),
  };
"#;

/// Live streams, most viewers first: all of Kick or one category (__SLUG__ is a JSON string or null).
const STREAMS: &str = r#"
  const sub = __SLUG__;
  const pages = await Promise.all([1, 2].map(async (n) => {
    // sort=desc: most viewers first (without it Kick lists streams in no useful order)
    const q = new URLSearchParams({ page: String(n), limit: "24", sort: "desc" });
    if (sub) q.set("subcategory", sub);
    const r = await fetch(`/stream/livestreams/en?${q}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return { status: r.status, rows: [] };
    const p = await r.json();
    return { status: 200, rows: Array.isArray(p) ? p : (p.data || p.livestreams || []) };
  }));
  if (pages[0].status !== 200) return { status: pages[0].status };
  const seen = new Set();
  const items = [];
  for (const row of pages.flatMap((p) => p.rows)) {
    const ch = row.channel || {};
    const slug = ch.slug || row.slug;
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const user = ch.user || {};
    items.push({
      slug,
      name: user.username || ch.username || slug,
      title: row.session_title || row.title || "",
      // Kick's directory has several viewer fields and not all are filled: take the first count above 0
      viewers: [row.viewer_count, row.viewers, row.concurrent_viewers, row.current_viewers, row.viewcount,
        row.livestream && row.livestream.viewer_count, ch.livestream && ch.livestream.viewer_count]
        .map(Number).find((n) => Number.isFinite(n) && n > 0) ?? null,
      thumbnail: img(row.thumbnail) || img(row.thumbnail_url),
      category: (row.categories && row.categories[0] && row.categories[0].name) || (row.category && row.category.name) || "",
      avatar: img(user.profile_pic) || img(ch.profile_pic),
      lid: row.id || (ch.livestream && ch.livestream.id) || null,
    });
  }
  // the directory usually has no viewer counts: ask Kick for them, 25 streams at a time
  const need = items.filter((i) => i.viewers === null && i.lid);
  for (let i = 0; i < need.length; i += 25) {
    const part = need.slice(i, i + 25);
    const q = part.map((p) => "ids[]=" + encodeURIComponent(p.lid)).join("&");
    try {
      const r = await fetch(`/current-viewers?${q}`, { headers: { Accept: "application/json" } });
      if (!r.ok) continue;
      const rows = await r.json();
      if (!Array.isArray(rows)) continue;
      for (const e of rows) {
        const item = part.find((p) => String(p.lid) === String(e.livestream_id));
        const n = Number(e.viewers);
        if (item && e.show_view_count !== false && Number.isFinite(n) && n >= 0) item.viewers = n;
      }
    } catch (e) {
      // keep "Live" for these
    }
  }
  items.forEach((i) => delete i.lid);
  items.sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
  return { status: 200, items };
"#;

fn fetcher_navigation(app: &AppHandle, url: &tauri::Url) -> bool {
    if url.host_str() == Some(RESULT_HOST) {
        let mut id = None;
        let mut data = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "id" => id = value.parse::<u64>().ok(),
                "data" => data = Some(value.into_owned()),
                _ => {}
            }
        }
        if let (Some(id), Some(data)) = (id, data) {
            let fetcher = app.state::<KickFetcher>();
            let tx = fetcher.pending.lock().unwrap().remove(&id);
            if let Some(tx) = tx {
                let _ = tx.send(data);
            }
        }
        return false;
    }
    // stay on kick.com
    url.scheme() == "https" && url.host_str() == Some("kick.com")
}

fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(FETCHER) {
        return Ok(window);
    }
    let nav_app = app.clone();
    let load_app = app.clone();
    WebviewWindowBuilder::new(app, FETCHER, WebviewUrl::External(PAGE.parse().unwrap()))
        .title("StreamHub Kick")
        .visible(false)
        .skip_taskbar(true)
        .focused(false)
        .inner_size(400.0, 300.0)
        .on_navigation(move |url| fetcher_navigation(&nav_app, url))
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) && payload.url().host_str() == Some("kick.com") {
                let _ = load_app.state::<KickFetcher>().ready.send_replace(true);
            }
        })
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct FetchResult {
    slug: String,
    status: u16,
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

fn to_channel(result: FetchResult) -> KickChannel {
    let error = match result.status {
        200 => match &result.data {
            Some(data) => return parse_channel(&result.slug, data),
            None => "Kick returned no data".to_string(),
        },
        404 => "Channel not found".to_string(),
        0 => format!("Couldn't reach Kick: {}", result.error.unwrap_or_default()),
        code => format!("Kick returned {code}"),
    };
    KickChannel { name: result.slug.clone(), slug: result.slug, error: Some(error), ..Default::default() }
}

/// Run a script body in the hidden kick.com page and return the JSON it hands back.
async fn run_in_kick(app: &AppHandle, body: &str) -> Result<String, String> {
    let window = ensure_window(app)?;
    let fetcher = app.state::<KickFetcher>();
    let mut ready = fetcher.ready.subscribe();
    tokio::time::timeout(Duration::from_secs(30), ready.wait_for(|ready| *ready))
        .await
        .map_err(|_| "Kick didn't load in time".to_string())?
        .map_err(|e| e.to_string())?;

    let id = fetcher.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = oneshot::channel();
    fetcher.pending.lock().unwrap().insert(id, tx);

    let script = WRAPPER
        .replace("__BODY__", body)
        .replace("__HOST__", RESULT_HOST)
        .replace("__ID__", &id.to_string());
    if let Err(e) = window.eval(&script) {
        fetcher.pending.lock().unwrap().remove(&id);
        return Err(e.to_string());
    }

    let data = match tokio::time::timeout(Duration::from_secs(45), rx).await {
        Ok(Ok(data)) => data,
        _ => {
            fetcher.pending.lock().unwrap().remove(&id);
            // reload kick.com for the next try
            let _ = fetcher.ready.send_replace(false);
            let _ = window.eval(&format!("location.href = {}", serde_json::to_string(PAGE).unwrap()));
            return Err("Kick didn't answer in time".into());
        }
    };
    Ok(data)
}

/// Browse Kick: "categories", or "streams" (live streams, of one category when `slug` is given).
#[tauri::command]
pub async fn kick_browse(app: AppHandle, kind: String, slug: Option<String>) -> Result<Value, String> {
    let slug = slug.map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty());
    if slug.as_deref().is_some_and(|s| !valid_kick_slug(s)) {
        return Err("Invalid category".into());
    }
    let body = match kind.as_str() {
        "categories" => CATEGORIES.to_string(),
        "streams" => STREAMS.replace("__SLUG__", &serde_json::to_string(&slug).unwrap()),
        _ => return Err("Unknown Kick page".into()),
    };
    let data = run_in_kick(&app, &body).await?;
    let value: Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    match value["status"].as_u64() {
        Some(200) => Ok(value["items"].clone()),
        Some(0) => Err(format!("Couldn't reach Kick: {}", value["error"].as_str().unwrap_or_default())),
        Some(code) => Err(format!("Kick returned {code}")),
        None => Err("Unexpected answer from Kick".into()),
    }
}

/// Check which of these Kick channels are live.
#[tauri::command]
pub async fn kick_channels(app: AppHandle, slugs: Vec<String>) -> Result<Vec<KickChannel>, String> {
    let mut slugs: Vec<String> = slugs.into_iter().map(|s| s.trim().to_ascii_lowercase()).collect();
    slugs.retain(|s| valid_kick_slug(s));
    slugs.dedup();
    if slugs.is_empty() {
        return Ok(Vec::new());
    }

    let data = run_in_kick(&app, &CHANNELS.replace("__SLUGS__", &serde_json::to_string(&slugs).unwrap())).await?;
    let results: Vec<FetchResult> = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    Ok(results.into_iter().map(to_channel).collect())
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
                bio: None,
                followers: None,
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
    fn fetch_results() {
        let offline: FetchResult = serde_json::from_value(json!({ "slug": "a", "status": 403 })).unwrap();
        assert_eq!(to_channel(offline).error.as_deref(), Some("Kick returned 403"));
        let ok: FetchResult = serde_json::from_value(json!({
            "slug": "b", "status": 200, "data": { "user": { "username": "B" }, "livestream": null }
        }))
        .unwrap();
        let channel = to_channel(ok);
        assert_eq!((channel.name.as_str(), channel.live, channel.error), ("B", false, None));
    }

    #[test]
    fn image_urls() {
        assert_eq!(image_url(&json!("https://x/a.png")), Some("https://x/a.png".into()));
        assert_eq!(image_url(&json!({ "url": "http://x/a.png" })), None);
        assert_eq!(image_url(&json!(null)), None);
    }
}
