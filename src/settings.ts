import type { Settings } from "./types";

const KEY = "streamhub.settings";

export const QUALITIES = ["best", "1080p60", "1080p", "720p60", "720p", "480p", "360p", "160p", "worst"];

export const DEFAULTS: Settings = {
  streamlinkPath: "",
  playerPath: "",
  quality: "best",
  lowLatency: false,
  // ad blocking is on unless the user turns it off
  proxyEnabled: true,
  proxies: [],
  direct: false,
  backupStream: false,
  badge: true,
  notifications: true,
  chatProvider: "window",
  chatAutoOpen: false,
};

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable: settings last until StreamHub closes
  }
}
