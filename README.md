# StreamHub (next)

The StreamHub desktop app rebuilt with [Tauri 2](https://tauri.app): a Rust core with a light web UI, replacing the NW.js + Ember app in [DannyDarth/StreamHub](https://github.com/DannyDarth/StreamHub). Windows only.

> **Preview.** There are no releases yet. Test builds come from GitHub Actions (see below). StreamHub 1.x stays the app to use until this one catches up.

## Hard rule: ads must not interrupt streams

- Twitch streams play through ad-free playlist proxies, using the bundled [streamlink-ttvlol](https://github.com/2bc4/streamlink-ttvlol) plugin (pinned and checksum-verified) with StreamHub's patch.
- If an ad gets through, StreamHub restarts Streamlink with the next proxy tried first. Each proxy is tried first once.
- **StreamHub never falls back to Twitch with ads by itself.** Playing directly from Twitch only happens if you turn on **Direct through my VPN**. If the plugin is missing, StreamHub refuses to play instead.
- **Ad-free backup stream** (optional, off by default): during an ad break, plays a lower-quality ad-free stream instead of pausing.
- The ad blocking badge shows the status in the corner of the player window.

## What works in this preview

- Twitch sign-in (same Twitch app and redirect as StreamHub 1.x)
- Followed channels that are live, with live notifications
- Kick: your own list of Kick channels (Kick has no public "followed" list), checked every minute, with live notifications; watch through Streamlink
- Watching through Streamlink, with the ad blocking above and a status bar per stream
- Chat (optional, off by default: Settings → Chat) for Twitch and Kick: in a StreamHub window (the sites' own popout chat; sign in there to send messages), your default browser, or Chatterino; optionally opened with the stream
- Settings: Streamlink path, player, quality, low latency, proxies, VPN mode, backup stream, badge
- Tray icon (closing the window keeps StreamHub running)

Next: search, channel and game pages and the rest of StreamHub 1.x.

Kick doesn't put ads into the streams Streamlink plays, so Kick streams don't need the proxy plugin. If Kick starts doing that, StreamHub will need its own Kick ad blocking.

## Testing a build

1. Open the latest successful run of [Build](../../actions/workflows/build.yml).
2. Download **StreamHub-next-Windows-x64-portable**, unzip it and run `StreamHub.exe` (keep `streamlink-plugins` next to it). The **installer** artifact is also there.
3. You need [Streamlink](https://streamlink.github.io) 8.3 or newer.

## Development

Needs Node 24, Rust stable and Python 3.

```sh
npm install
npm run plugin        # builds src-tauri/resources/streamlink-plugins
npm run tauri dev
```

Tests: `cargo test` in `src-tauri/`, and `pytest plugin/tests` with `STREAMHUB_TWITCH_PLUGIN` set to the built `twitch.py`.

## Layout

| Path | What |
| --- | --- |
| `src/` | UI (TypeScript, no framework): `main.ts`, the badge window `badge.ts` |
| `src-tauri/src/adblock.rs` | Streamlink log parsing, proxy rotation, badge status |
| `src-tauri/src/streamlink.rs` | Finding Streamlink and the plugin, launching, auto-switching proxies |
| `src-tauri/src/kick.rs` | Live status of your Kick channels |
| `src-tauri/src/chat.rs` | Opening chat (window, browser, Chatterino) |
| `src-tauri/src/auth.rs` | Twitch sign-in through `http://localhost:65432/redirect` |
| `src-tauri/src/badge.rs` | Badge window, placed on the player window |
| `plugin/` | Builds and tests the patched streamlink-ttvlol plugin |

## License

MIT, see [LICENSE](LICENSE). The bundled streamlink-ttvlol plugin is BSD-2-Clause (`plugin/LICENSE-streamlink-ttvlol.txt`).
