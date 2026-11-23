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
  // chat is optional: off until the user turns it on
  chatEnabled: false,
  chatProvider: "panel",
  chatAutoOpen: false,
  theme: "dark",
  buffer: "normal",
  streamLanguage: "",
};

/** Languages for the browse pages' filter. */
export const LANGUAGES: [string, string][] = [
  ["", "All languages"],
  ["en", "English"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["ru", "Russian"],
  ["tr", "Turkish"],
  ["ar", "Arabic"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
];

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

/** Apply the theme setting (and follow Windows when it's "system"). */
export function applyTheme(theme: Settings["theme"]): void {
  const dark = theme === "dark" || (theme === "system" && systemDark.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function followSystemTheme(get: () => Settings["theme"]): void {
  systemDark.addEventListener("change", () => applyTheme(get()));
}

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    const settings = { ...DEFAULTS, ...saved };
    // the chat window became the chat panel
    if ((settings.chatProvider as string) === "window") settings.chatProvider = "panel";
    return settings;
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
