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
  theme: "dark" | "light" | "system";
  /** Smoother playback: how much video Streamlink keeps buffered. */
  buffer: "normal" | "more" | "most";
  /** Browse pages: only streams in this language ("" = all). */
  streamLanguage: string;
}

export type ChatProvider = "panel" | "browser" | "chatterino";

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
  bio: string | null;
  followers: number | null;
  error: string | null;
}

/** Helix /search/channels */
export interface TwitchChannelResult {
  id: string;
  broadcaster_login: string;
  display_name: string;
  is_live: boolean;
  game_name: string;
  title: string;
  thumbnail_url: string;
}

/** Helix /games and /search/categories */
export interface TwitchGame {
  id: string;
  name: string;
  box_art_url: string;
}

/** Helix /users */
export interface TwitchProfile {
  id: string;
  login: string;
  display_name: string;
  description: string;
  profile_image_url: string;
  offline_image_url: string;
}

export interface KickCategory {
  slug: string;
  name: string;
  image: string | null;
  viewers: number | null;
}

export interface KickStream {
  slug: string;
  name: string;
  title: string;
  viewers: number | null;
  thumbnail: string | null;
  category: string;
  avatar?: string | null;
}

/** A channel the signed-in Kick account follows (kick::FOLLOWED). */
export interface KickFollowed {
  slug: string;
  name: string;
  live: boolean;
  viewers: number | null;
  title: string;
  category: string;
  avatar: string | null;
}

export interface KickAccount {
  username: string;
  avatar: string | null;
}
