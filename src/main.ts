import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { DEFAULTS, QUALITIES, loadSettings, saveSettings } from "./settings";
import { AuthError, followedLive, thumbnail, validateToken } from "./twitch";
import type {
  AdblockStatus,
  EndedEvent,
  LiveStream,
  Settings,
  StatusEvent,
  StreamlinkInfo,
  TwitchUser,
} from "./types";

const TOKEN_KEY = "streamhub.token";
const REFRESH_MS = 60_000;

type View = "live" | "settings";

interface Playing {
  channel: string;
  status: AdblockStatus | null;
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) ?? "",
  user: null as TwitchUser | null,
  view: "live" as View,
  settings: loadSettings(),
  streams: [] as LiveStream[],
  loading: false,
  error: "",
  playing: new Map<number, Playing>(),
  message: "",
  known: null as Set<string> | null,
  info: null as StreamlinkInfo | null,
};

// ---- tiny DOM helper (text is always set with textContent) ----

type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") el.addEventListener(key.replace(/^on/, ""), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    el.append(child);
  }
  return el;
}

const app = document.getElementById("app")!;

// ---- actions ----

async function signIn() {
  state.error = "";
  state.message = "Finish signing in to Twitch in your browser…";
  render();
  try {
    const token = await invoke<string>("twitch_login");
    state.token = token;
    localStorage.setItem(TOKEN_KEY, token);
    state.message = "";
    await start();
  } catch (e) {
    state.message = "";
    state.error = String(e);
    render();
  }
}

function signOut() {
  state.token = "";
  state.user = null;
  state.streams = [];
  state.known = null;
  localStorage.removeItem(TOKEN_KEY);
  render();
}

async function notifyNewStreams(streams: LiveStream[]) {
  const live = new Set(streams.map((s) => s.user_id));
  const before = state.known;
  state.known = live;
  if (!before || !state.settings.notifications) return;
  const fresh = streams.filter((s) => !before.has(s.user_id));
  if (fresh.length === 0) return;

  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return;
  if (fresh.length > 3) {
    sendNotification({ title: "StreamHub", body: `${fresh.length} channels you follow went live` });
    return;
  }
  for (const s of fresh) {
    sendNotification({ title: `${s.user_name} is live`, body: s.title || s.game_name });
  }
}

async function refresh() {
  if (!state.token || !state.user) return;
  state.loading = true;
  render();
  try {
    const streams = await followedLive(state.token, state.user);
    state.streams = streams;
    state.error = "";
    await notifyNewStreams(streams);
  } catch (e) {
    if (e instanceof AuthError) {
      signOut();
      state.error = e.message;
    } else {
      state.error = `Couldn't load your followed channels: ${String(e)}`;
    }
  } finally {
    state.loading = false;
    render();
  }
}

async function start() {
  if (!state.token) {
    render();
    return;
  }
  try {
    state.user = await validateToken(state.token);
  } catch (e) {
    if (e instanceof AuthError) signOut();
    state.error = String(e instanceof Error ? e.message : e);
    render();
    return;
  }
  await refresh();
}

async function watch(channel: string) {
  state.error = "";
  try {
    const id = await invoke<number>("watch", { channel, settings: state.settings });
    state.playing.set(id, { channel, status: null });
  } catch (e) {
    state.error = String(e);
  }
  render();
}

async function stop(id: number) {
  await invoke("stop", { id });
}

function updateSettings(patch: Partial<Settings>) {
  state.settings = { ...state.settings, ...patch };
  saveSettings(state.settings);
}

async function loadInfo() {
  try {
    state.info = await invoke<StreamlinkInfo>("streamlink_info", {
      streamlinkPath: state.settings.streamlinkPath || null,
    });
  } catch {
    state.info = null;
  }
  render();
}

// ---- views ----

function header(): HTMLElement {
  const tab = (view: View, label: string) =>
    h(
      "button",
      {
        class: `tab${state.view === view ? " active" : ""}`,
        onclick: () => {
          state.view = view;
          if (view === "settings") void loadInfo();
          render();
        },
      },
      label,
    );
  return h(
    "header",
    {},
    h("div", { class: "brand" }, h("span", { class: "logo" }, "▶"), "StreamHub"),
    state.user ? h("nav", {}, tab("live", "Live"), tab("settings", "Settings")) : null,
    h("div", { class: "spacer" }),
    state.user
      ? h(
          "div",
          { class: "user" },
          h("span", {}, state.user.login),
          h("button", { class: "link", onclick: signOut }, "Sign out"),
        )
      : null,
  );
}

function statusChip(status: AdblockStatus | null): HTMLElement {
  if (!status) return h("span", { class: "chip info" }, "Starting…");
  return h(
    "span",
    { class: `chip ${status.level}`, title: status.detail },
    status.label,
    status.server ? ` · ${status.server}` : "",
  );
}

function playingBar(): HTMLElement | null {
  if (state.playing.size === 0) return null;
  return h(
    "section",
    { class: "playing" },
    ...[...state.playing.entries()].map(([id, p]) =>
      h(
        "div",
        { class: "playing-item" },
        h("strong", {}, p.channel),
        statusChip(p.status),
        p.status && (p.status.adsCovered || p.status.adsGotThrough)
          ? h(
              "span",
              { class: "muted" },
              `${p.status.adsCovered} ads blocked · ${p.status.adsGotThrough} filtered`,
            )
          : null,
        h("button", { class: "small", onclick: () => void stop(id) }, "Stop"),
      ),
    ),
  );
}

function card(stream: LiveStream): HTMLElement {
  return h(
    "button",
    { class: "card", title: `Watch ${stream.user_name}`, onclick: () => void watch(stream.user_login) },
    h(
      "div",
      { class: "thumb" },
      h("img", { src: `${thumbnail(stream)}?t=${Math.floor(Date.now() / REFRESH_MS)}`, alt: "", loading: "lazy" }),
      h("span", { class: "viewers" }, `● ${stream.viewer_count.toLocaleString()}`),
    ),
    h("div", { class: "card-title" }, stream.title || "Untitled stream"),
    h("div", { class: "card-meta" }, h("strong", {}, stream.user_name), stream.game_name ? ` · ${stream.game_name}` : ""),
  );
}

function liveView(): HTMLElement {
  const list =
    state.streams.length > 0
      ? h("div", { class: "grid" }, ...state.streams.map(card))
      : h("p", { class: "empty" }, state.loading ? "Loading…" : "None of the channels you follow are live right now.");
  return h(
    "main",
    {},
    h(
      "div",
      { class: "toolbar" },
      h("h1", {}, "Following · Live"),
      h("button", { class: "small", onclick: () => void refresh(), disabled: state.loading }, state.loading ? "Refreshing…" : "Refresh"),
    ),
    list,
  );
}

function checkbox(label: string, help: string, key: keyof Settings): HTMLElement {
  return h(
    "label",
    { class: "check" },
    h("input", {
      type: "checkbox",
      checked: Boolean(state.settings[key]),
      onchange: (e) => {
        updateSettings({ [key]: (e.target as HTMLInputElement).checked } as Partial<Settings>);
        render();
      },
    }),
    h("span", {}, h("strong", {}, label), h("small", {}, help)),
  );
}

function textInput(label: string, key: "streamlinkPath" | "playerPath", placeholder: string): HTMLElement {
  return h(
    "label",
    { class: "field" },
    h("span", {}, label),
    h("input", {
      type: "text",
      value: state.settings[key],
      placeholder,
      spellcheck: "false",
      onchange: (e) => {
        updateSettings({ [key]: (e.target as HTMLInputElement).value.trim() });
        if (key === "streamlinkPath") void loadInfo();
      },
    }),
  );
}

function settingsView(): HTMLElement {
  const s = state.settings;
  const info = state.info;
  const quality = h(
    "select",
    { onchange: (e) => updateSettings({ quality: (e.target as HTMLSelectElement).value }) },
    ...QUALITIES.map((q) => h("option", { value: q, selected: q === s.quality }, q)),
  );
  const proxies = h("textarea", {
    rows: "5",
    spellcheck: "false",
    placeholder: (info?.defaultProxies ?? []).join("\n"),
    onchange: (e) =>
      updateSettings({
        proxies: (e.target as HTMLTextAreaElement).value
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      }),
  });
  proxies.value = s.proxies.join("\n");

  return h(
    "main",
    { class: "settings" },
    h("h1", {}, "Settings"),

    h("h2", {}, "Streamlink"),
    h(
      "p",
      { class: "muted" },
      info?.streamlink ? `Found: ${info.streamlink}` : "Streamlink wasn't found. Install it from streamlink.github.io or set its path.",
    ),
    textInput("Streamlink path (optional)", "streamlinkPath", "Found automatically"),
    textInput("Video player (optional)", "playerPath", "Streamlink's default (VLC)"),
    h("label", { class: "field" }, h("span", {}, "Quality"), quality),
    checkbox("Low latency", "Smaller delay, may buffer more often.", "lowLatency"),

    h("h2", {}, "Twitch ad blocking"),
    h(
      "p",
      { class: "muted" },
      info?.plugin
        ? `Plugin: ${info.plugin}${info.bundledPlugin ? " (bundled)" : ""}`
        : "The ad blocking plugin wasn't found. StreamHub won't play Twitch streams while it's missing.",
    ),
    checkbox("Block ads", "Play Twitch streams through ad-free proxies. If an ad gets through, StreamHub switches to the next proxy.", "proxyEnabled"),
    !s.proxyEnabled ? h("p", { class: "warning" }, "Ad blocking is off: Twitch streams will show ads.") : null,
    h("label", { class: "field" }, h("span", {}, "Proxies, one per line (empty: defaults)"), proxies),
    checkbox(
      "Direct through my VPN",
      "If no proxy works, play from Twitch directly. Only turn this on while a VPN in an ad-free country is connected.",
      "direct",
    ),
    checkbox(
      "Ad-free backup stream",
      "During an ad break, play a lower quality (usually 360p) ad-free stream instead of pausing. Needs the bundled plugin.",
      "backupStream",
    ),
    checkbox("Ad blocking badge", "Show the status in the corner of the player.", "badge"),

    h("h2", {}, "Notifications"),
    checkbox("Live notifications", "Notify me when a channel I follow goes live.", "notifications"),

    h(
      "p",
      {},
      h(
        "button",
        {
          class: "link",
          onclick: () => {
            state.settings = { ...DEFAULTS };
            saveSettings(state.settings);
            render();
          },
        },
        "Reset settings",
      ),
    ),
  );
}

function signInView(): HTMLElement {
  return h(
    "main",
    { class: "signin" },
    h("h1", {}, "Ad-free Twitch, through Streamlink"),
    h("p", { class: "muted" }, "Sign in with Twitch to see the channels you follow."),
    h("button", { class: "primary", onclick: () => void signIn() }, "Sign in with Twitch"),
  );
}

let currentBody: HTMLElement | null = null;

function render() {
  // don't rebuild the settings form while the user is typing in it
  const editing =
    state.view === "settings" &&
    currentBody?.classList.contains("settings") &&
    currentBody.contains(document.activeElement) &&
    document.activeElement !== document.body;
  const body =
    editing && currentBody
      ? currentBody
      : !state.user
        ? signInView()
        : state.view === "settings"
          ? settingsView()
          : liveView();
  currentBody = body;
  app.replaceChildren(
    header(),
    state.error ? h("div", { class: "banner error" }, state.error) : "",
    state.message ? h("div", { class: "banner" }, state.message) : "",
    playingBar() ?? "",
    body,
  );
}

// ---- events from the Rust side ----

void listen<StatusEvent>("adblock-status", ({ payload }) => {
  const p = state.playing.get(payload.id);
  if (p) {
    p.status = payload.status;
    render();
  }
});

void listen<EndedEvent>("stream-ended", ({ payload }) => {
  state.playing.delete(payload.id);
  if (payload.error) state.error = `${payload.channel}: ${payload.error}`;
  render();
});

window.setInterval(() => void refresh(), REFRESH_MS);
void start();
