export type Level = "ok" | "info" | "warn";

/** Sent by the Rust side (adblock::Status). */
export interface AdblockStatus {
  level: Level;
  label: string;
  detail: string;
  server: string | null;
  adsCovered: number;
  adsGotThrough: number;
}

export interface StatusEvent {
  id: number;
  channel: string;
  status: AdblockStatus;
}

export interface EndedEvent {
  id: number;
  channel: string;
  code: number | null;
  error: string | null;
}

export interface StreamlinkInfo {
  streamlink: string | null;
  plugin: string | null;
  bundledPlugin: boolean;
  defaultProxies: string[];
}

/** Passed to the `watch` command (streamlink::WatchSettings). */
export interface Settings {
  streamlinkPath: string;
  playerPath: string;
  quality: string;
  lowLatency: boolean;
  proxyEnabled: boolean;
  proxies: string[];
  direct: boolean;
  backupStream: boolean;
  badge: boolean;
  notifications: boolean;
  chatEnabled: boolean;
  chatProvider: ChatProvider;
  chatAutoOpen: boolean;
}

export type ChatProvider = "window" | "browser" | "chatterino";

export interface TwitchUser {
  id: string;
  login: string;
}

export interface LiveStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_name: string;
  title: string;
  viewer_count: number;
  started_at: string;
  thumbnail_url: string;
}

export type Platform = "twitch" | "kick";

/** Sent by the Rust side (kick::KickChannel). */
export interface KickChannel {
  slug: string;
  name: string;
  live: boolean;
  title: string;
  category: string;
  viewers: number | null;
  thumbnail: string | null;
  avatar: string | null;
  startedAt: string | null;
  error: string | null;
}
