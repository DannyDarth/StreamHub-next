//! Twitch ad blocking: Streamlink log parsing, proxy rotation and the status shown in the badge.
//!
//! The log messages come from the bundled streamlink-ttvlol plugin and StreamHub's patch of it.
//! Hard rule: StreamHub never falls back to Twitch's own servers (with ads) on its own.

use serde::Serialize;

/// Proxies used when the user hasn't set their own list, in the order they are tried.
pub const DEFAULT_PROXIES: [&str; 5] = [
    "httpproxy://firefox.api.cdn-perfprod.com:2023",
    "httpproxy://chromium.api.cdn-perfprod.com:2023",
    "https://lb-na.cdn-perfprod.com",
    "https://lb-eu.cdn-perfprod.com",
    "https://eu.luminous.dev",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    /// The stream is played through this proxy server.
    Proxy { server: String },
    /// No proxy worked and the user allowed playing directly (through their own VPN).
    Direct,
    /// The ad-free backup stream (e.g. 360p) was found.
    Backup {
        #[serde(rename = "playerType")]
        player_type: String,
    },
    /// An ad break was covered by the backup stream.
    AdCovered,
    /// Twitch sent an ad break through the current route.
    AdDetected,
}

/// Remove Streamlink's "[plugins.twitch][info] " prefix.
pub fn strip_log_prefix(line: &str) -> &str {
    let mut rest = line.trim();
    while rest.starts_with('[') {
        match rest.find(']') {
            Some(end) => rest = &rest[end + 1..],
            None => break,
        }
    }
    rest.trim_start()
}

/// Turn one Streamlink log line into an ad blocking event.
pub fn parse_event(line: &str) -> Option<Event> {
    let msg = strip_log_prefix(line);

    for prefix in ["Using HTTP proxy '", "Using playlist proxy '"] {
        if let Some(rest) = msg.strip_prefix(prefix) {
            let url = rest.split('\'').next().unwrap_or_default();
            let without_scheme = url.split_once("://").map_or(url, |(_, host)| host);
            let server = without_scheme.split('/').next().unwrap_or_default();
            if !server.is_empty() {
                return Some(Event::Proxy { server: server.to_string() });
            }
        }
    }
    if msg.starts_with("No playlist proxies available, falling back to Twitch servers") {
        return Some(Event::Direct);
    }
    if let Some(rest) = msg.strip_prefix("Using ad-free backup stream (") {
        if let Some((player_type, _)) = rest.split_once(')') {
            return Some(Event::Backup { player_type: player_type.to_string() });
        }
    }
    if msg.starts_with("Playing ad-free backup stream during advertisement break") {
        return Some(Event::AdCovered);
    }
    if let Some(rest) = msg.strip_prefix("Detected advertisement break of ") {
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 && rest[digits..].starts_with(" second") {
            return Some(Event::AdDetected);
        }
    }
    None
}

/// The proxy list passed to `--twitch-proxy-playlist`. After an ad, StreamHub restarts Streamlink
/// with the list rotated so the next server is tried first. Each server is tried first at most once.
#[derive(Debug, Clone)]
pub struct ProxyRotation {
    servers: Vec<String>,
    switches: usize,
}

impl ProxyRotation {
    pub fn new(servers: Vec<String>) -> Self {
        let servers = servers
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        Self { servers, switches: 0 }
    }

    pub fn playlist(&self) -> String {
        let mut servers = self.servers.clone();
        if !servers.is_empty() {
            let len = servers.len();
            servers.rotate_left(self.switches % len);
        }
        servers.join(",")
    }

    /// The server that is tried first right now.
    pub fn first(&self) -> Option<&str> {
        if self.servers.is_empty() {
            return None;
        }
        Some(&self.servers[self.switches % self.servers.len()])
    }

    /// Move on to the next server. Returns false when every server has already been tried first.
    pub fn switch(&mut self) -> bool {
        if self.switches + 1 < self.servers.len() {
            self.switches += 1;
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Ok,
    Info,
    Warn,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub level: Level,
    pub label: String,
    pub detail: String,
    pub server: Option<String>,
    pub ads_covered: u32,
    pub ads_got_through: u32,
}

/// Ad blocking state of one running stream.
#[derive(Debug, Default, Clone)]
pub struct Tracker {
    pub server: Option<String>,
    pub direct: bool,
    pub backup: Option<String>,
    pub ads_covered: u32,
    pub ads_got_through: u32,
}

impl Tracker {
    pub fn status(&self, level: Level, label: &str, detail: String) -> Status {
        Status {
            level,
            label: label.to_string(),
            detail,
            server: self.server.clone(),
            ads_covered: self.ads_covered,
            ads_got_through: self.ads_got_through,
        }
    }

    /// Record an event. Returns the status to show, if the event changes what the badge says.
    /// Ad breaks are handled by the caller (it decides whether to switch proxies).
    pub fn record(&mut self, event: &Event) -> Option<Status> {
        match event {
            Event::Proxy { server } => {
                self.server = Some(server.clone());
                self.direct = false;
                let mut detail = format!("via {server}");
                if let Some(backup) = &self.backup {
                    detail.push_str(&format!(" · backup {backup}"));
                }
                Some(self.status(Level::Ok, "Ad-free stream", detail))
            }
            Event::Direct => {
                self.server = None;
                self.direct = true;
                Some(self.status(
                    Level::Warn,
                    "Direct through your VPN",
                    "No proxy worked: playing from Twitch through your VPN".into(),
                ))
            }
            Event::Backup { player_type } => {
                self.backup = Some(player_type.clone());
                None
            }
            Event::AdCovered => {
                self.ads_covered += 1;
                Some(self.status(
                    Level::Ok,
                    "Ad blocked",
                    format!("Backup stream covered the ad break ({} so far)", self.ads_covered),
                ))
            }
            Event::AdDetected => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_prefixes() {
        assert_eq!(strip_log_prefix("[plugins.twitch][info] Hello"), "Hello");
        assert_eq!(strip_log_prefix("[cli][info] Opening stream: 1080p60 (hls)"), "Opening stream: 1080p60 (hls)");
        assert_eq!(strip_log_prefix("plain\r\n"), "plain");
    }

    #[test]
    fn parses_proxy_events() {
        assert_eq!(
            parse_event("[plugins.twitch][info] Using playlist proxy 'https://lb-eu.cdn-perfprod.com/playlist'"),
            Some(Event::Proxy { server: "lb-eu.cdn-perfprod.com".into() })
        );
        assert_eq!(
            parse_event("[plugins.twitch][info] Using HTTP proxy 'httpproxy://firefox.api.cdn-perfprod.com:2023'"),
            Some(Event::Proxy { server: "firefox.api.cdn-perfprod.com:2023".into() })
        );
    }

    #[test]
    fn parses_other_events() {
        assert_eq!(
            parse_event("[plugins.twitch][info] No playlist proxies available, falling back to Twitch servers"),
            Some(Event::Direct)
        );
        assert_eq!(
            parse_event("[plugins.twitch][info] Using ad-free backup stream (autoplay)"),
            Some(Event::Backup { player_type: "autoplay".into() })
        );
        assert_eq!(
            parse_event("[plugins.twitch][info] Playing ad-free backup stream during advertisement break of 30 seconds"),
            Some(Event::AdCovered)
        );
        assert_eq!(
            parse_event("[plugins.twitch][info] Detected advertisement break of 1 second"),
            Some(Event::AdDetected)
        );
        assert_eq!(parse_event("[plugins.twitch][info] Detected advertisement break of many seconds"), None);
        assert_eq!(parse_event("[cli][info] Starting player: mpv"), None);
    }

    #[test]
    fn rotates_each_proxy_first_once() {
        let mut rotation = ProxyRotation::new(vec!["a".into(), " b ".into(), "".into(), "c".into()]);
        assert_eq!(rotation.playlist(), "a,b,c");
        assert_eq!(rotation.first(), Some("a"));
        assert!(rotation.switch());
        assert_eq!(rotation.playlist(), "b,c,a");
        assert!(rotation.switch());
        assert_eq!(rotation.playlist(), "c,a,b");
        assert!(!rotation.switch());
        assert_eq!(rotation.playlist(), "c,a,b");
    }

    #[test]
    fn empty_rotation() {
        let mut rotation = ProxyRotation::new(vec![]);
        assert_eq!(rotation.playlist(), "");
        assert_eq!(rotation.first(), None);
        assert!(!rotation.switch());
    }

    #[test]
    fn tracker_counts_covered_ads() {
        let mut tracker = Tracker::default();
        tracker.record(&Event::Backup { player_type: "autoplay".into() });
        let status = tracker.record(&Event::Proxy { server: "x.example".into() }).unwrap();
        assert_eq!(status.level, Level::Ok);
        assert_eq!(status.detail, "via x.example · backup autoplay");
        let status = tracker.record(&Event::AdCovered).unwrap();
        assert_eq!(status.ads_covered, 1);
        assert_eq!(tracker.record(&Event::AdDetected).map(|s| s.label), None);
    }
}
