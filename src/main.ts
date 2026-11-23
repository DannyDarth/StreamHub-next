import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { DEFAULTS, QUALITIES, loadSettings, saveSettings } from "./settings";
import { AuthError, followedLive, thumbnail, validateToken } from "./twitch";
import { loadKickSlugs, parseKickInput, saveKickSlugs } from "./kick";
import type {
  AdblockStatus,
  EndedEvent,
  KickChannel,
  LiveStream,
  Platform,
  Settings,
  StatusEvent,
  StreamlinkInfo,
  TwitchUser,
} from "./types";

const TOKEN_KEY = "streamhub.token";
const REFRESH_MS = 60_000;

type View = "twitch" | "kick" | "settings";

interface Playing {
  platform: Platform;
  channel: string;
  status: AdblockStatus | null;
}

const savedToken = localStorage.getItem(TOKEN_KEY) ?? "";
const savedKick = loadKickSlugs();

const state = {
  token: savedToken,
  user: null as TwitchUser | null,
  view: (!savedToken && savedKick.length > 0 ? "kick" : "twitch") as View,
  settings: loadSettings(),
  streams: [] as LiveStream[],
  loading: false,
  error: "",
  playing: new Map<number, Playing>(),
  message: "",
  known: null as Set<string> | null,
  info: null as StreamlinkInfo | null,
  kickSlugs: savedKick,
  kickChannels: [] as KickChannel[],
  kickLoading: false,
  kickError: "",
  kickKnown: null as Set<string> | null,
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

interface LiveItem {
  key: string;
  name: string;
  detail: string;
}

/** Notify about channels that weren't live at the previous check. Returns the new "known" set. */
async function notifyNew(items: LiveItem[], before: Set<string> | null, site: string): Promise<Set<string>> {
  const live = new Set(items.map((i) => i.key));
  if (!before || !state.settings.notifications) return live;
  const fresh = items.filter((i) => !before.has(i.key));
  if (fresh.length === 0) return live;

  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return live;
  if (fresh.length > 3) {
    sendNotification({ title: "StreamHub", body: `${fresh.length} of your ${site} channels went live` });
    return live;
  }
  for (const item of fresh) {
    sendNotification({ title: `${item.name} is live on ${site}`, body: item.detail });
  }
  return live;
}

async function refresh() {
  if (!state.token || !state.user) return;
  state.loading = true;
  render();
  try {
    const streams = await followedLive(state.token, state.user);
    state.streams = streams;
    state.error = "";
    state.known = await notifyNew(
      streams.map((st) => ({ key: st.user_id, name: st.user_name, detail: st.title || st.game_name })),
      state.known,
      "Twitch",
    );
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

async function refreshKick() {
  if (state.kickSlugs.length === 0) {
    state.kickChannels = [];
    render();
    return;
  }
  state.kickLoading = true;
  render();
  try {
    const channels = await invoke<KickChannel[]>("kick_channels", { slugs: state.kickSlugs });
    state.kickChannels = channels;
    state.kickError = "";
    state.kickKnown = await notifyNew(
      channels.filter((c) => c.live).map((c) => ({ key: c.slug, name: c.name, detail: c.title || c.category })),
      state.kickKnown,
      "Kick",
    );
  } catch (e) {
    state.kickError = `Couldn't check your Kick channels: ${String(e)}`;
  } finally {
    state.kickLoading = false;
    render();
  }
}

function addKick(input: string): boolean {
  const { slugs, invalid } = parseKickInput(input);
  if (invalid.length > 0) {
    state.kickError = `Not a Kick channel name: ${invalid.join(", ")}`;
    render();
    return false;
  }
  if (slugs.length === 0) return false;
  state.kickError = "";
  state.kickSlugs = saveKickSlugs([...state.kickSlugs, ...slugs]);
  void refreshKick();
  return true;
}

function removeKick(slug: string) {
  state.kickSlugs = saveKickSlugs(state.kickSlugs.filter((s) => s !== slug));
  state.kickChannels = state.kickChannels.filter((c) => c.slug !== slug);
  state.kickKnown?.delete(slug);
  render();
}

async function watch(platform: Platform, channel: string) {
  state.error = "";
  try {
    const id = await invoke<number>("watch", { platform, channel, settings: state.settings });
    state.playing.set(id, { platform, channel, status: null });
    if (state.settings.chatAutoOpen) void openChat(platform, channel);
  } catch (e) {
    state.error = String(e);
  }
  render();
}

async function openChat(platform: Platform, channel: string) {
  try {
    await invoke("open_chat", { platform, channel, provider: state.settings.chatProvider });
  } catch (e) {
    state.error = String(e);
    render();
  }
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
    h("div", { class: "brand" }, h("img", { class: "logo", src: "/icon.png", alt: "" }), "StreamHub"),
    h("nav", {}, tab("twitch", "Twitch"), tab("kick", "Kick"), tab("settings", "Settings")),
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

function statusChip(platform: Platform, status: AdblockStatus | null): HTMLElement {
  if (!status) {
    return platform === "kick"
      ? h("span", { class: "chip kick", title: "Kick doesn't put ads into the streams Streamlink plays" }, "Kick")
      : h("span", { class: "chip info" }, "Starting…");
  }
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
        statusChip(p.platform, p.status),
        p.status && (p.status.adsCovered || p.status.adsGotThrough)
          ? h(
              "span",
              { class: "muted" },
              `${p.status.adsCovered} ads blocked · ${p.status.adsGotThrough} filtered`,
            )
          : null,
        h("button", { class: "small push", onclick: () => void openChat(p.platform, p.channel) }, "Chat"),
        h("button", { class: "small", onclick: () => void stop(id) }, "Stop"),
      ),
    ),
  );
}

function card(stream: LiveStream): HTMLElement {
  return h(
    "button",
    { class: "card", title: `Watch ${stream.user_name}`, onclick: () => void watch("twitch", stream.user_login) },
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
      h("h1", {}, "Twitch · Following live"),
      h("button", { class: "small", onclick: () => void refresh(), disabled: state.loading }, state.loading ? "Refreshing…" : "Refresh"),
    ),
    list,
  );
}

function kickCard(channel: KickChannel): HTMLElement {
  return h(
    "div",
    { class: "card-wrap" },
    h(
      "button",
      { class: "card", title: `Watch ${channel.name}`, onclick: () => void watch("kick", channel.slug) },
      h(
        "div",
        { class: "thumb" },
        channel.thumbnail
          ? h("img", {
              src: channel.thumbnail,
              alt: "",
              loading: "lazy",
              referrerpolicy: "no-referrer",
              // if Kick won't serve the thumbnail, show the channel's picture instead
              onerror: (e) => {
                const img = e.target as HTMLImageElement;
                if (channel.avatar && !img.dataset.fallback) {
                  img.dataset.fallback = "1";
                  img.src = channel.avatar;
                  img.classList.add("fallback");
                } else {
                  img.remove();
                }
              },
            })
          : channel.avatar
            ? h("img", { src: channel.avatar, alt: "", class: "fallback", referrerpolicy: "no-referrer" })
            : null,
        h("span", { class: "viewers kick" }, `● ${channel.viewers === null ? "Live" : channel.viewers.toLocaleString()}`),
      ),
      h("div", { class: "card-title" }, channel.title || "Untitled stream"),
      h("div", { class: "card-meta" }, h("strong", {}, channel.name), channel.category ? ` · ${channel.category}` : ""),
    ),
    h("button", { class: "remove", title: `Remove ${channel.name}`, onclick: () => removeKick(channel.slug) }, "×"),
  );
}

function kickRow(slug: string, channel: KickChannel | undefined): HTMLElement {
  const status = !channel
    ? state.kickLoading
      ? "Checking…"
      : ""
    : channel.error
      ? channel.error
      : "Offline";
  return h(
    "div",
    { class: "row" },
    channel?.avatar
      ? h("img", { class: "avatar", src: channel.avatar, alt: "", referrerpolicy: "no-referrer" })
      : h("span", { class: "avatar" }),
    h("strong", {}, channel?.name ?? slug),
    h("span", { class: channel?.error ? "row-error" : "muted" }, status),
    h("button", { class: "link", onclick: () => removeKick(slug) }, "Remove"),
  );
}

function kickView(): HTMLElement {
  const bySlug = new Map(state.kickChannels.map((c) => [c.slug, c]));
  const live = state.kickSlugs
    .map((slug) => bySlug.get(slug))
    .filter((c): c is KickChannel => Boolean(c?.live))
    .sort((a, b) => (b.viewers ?? 0) - (a.viewers ?? 0));
  const others = state.kickSlugs.filter((slug) => !bySlug.get(slug)?.live);

  const input = h("input", {
    type: "text",
    placeholder: "Add Kick channels: names or kick.com links",
    spellcheck: "false",
  });
  const form = h(
    "form",
    {
      class: "add",
      onsubmit: (e) => {
        e.preventDefault();
        if (addKick(input.value)) input.value = "";
      },
    },
    input,
    h("button", { class: "small", type: "submit" }, "Add"),
  );

  return h(
    "main",
    {},
    h(
      "div",
      { class: "toolbar" },
      h("h1", {}, "Kick · Your channels"),
      h(
        "button",
        { class: "small", onclick: () => void refreshKick(), disabled: state.kickLoading },
        state.kickLoading ? "Refreshing…" : "Refresh",
      ),
    ),
    form,
    state.kickError ? h("p", { class: "row-error" }, state.kickError) : null,
    state.kickSlugs.length === 0
      ? h("p", { class: "empty" }, "Add the Kick channels you watch. StreamHub checks them every minute and tells you when they go live.")
      : null,
    live.length > 0 ? h("div", { class: "grid" }, ...live.map(kickCard)) : null,
    live.length === 0 && state.kickSlugs.length > 0 && !state.kickLoading
      ? h("p", { class: "empty" }, "None of your Kick channels are live right now.")
      : null,
    others.length > 0 ? h("h2", {}, "Offline") : null,
    others.length > 0 ? h("div", { class: "rows" }, ...others.map((slug) => kickRow(slug, bySlug.get(slug)))) : null,
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

    h("h2", {}, "Chat"),
    h(
      "label",
      { class: "field" },
      h("span", {}, "Open chat in"),
      h(
        "select",
        {
          onchange: (e) =>
            updateSettings({ chatProvider: (e.target as HTMLSelectElement).value as Settings["chatProvider"] }),
        },
        ...(
          [
            ["window", "A StreamHub window"],
            ["browser", "My default browser"],
            ["chatterino", "Chatterino (Twitch; Kick opens in a StreamHub window)"],
          ] as const
        ).map(([value, label]) => h("option", { value, selected: s.chatProvider === value }, label)),
      ),
    ),
    checkbox("Open chat with the stream", "Open the channel's chat when a stream starts.", "chatAutoOpen"),

    h("h2", {}, "Notifications"),
    checkbox("Live notifications", "Notify me when a Twitch channel I follow or one of my Kick channels goes live.", "notifications"),

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
let currentView: View | null = null;

function render() {
  // don't rebuild a form while the user is typing in it
  const active = document.activeElement;
  const editing =
    currentView === state.view &&
    (state.view === "settings" || state.view === "kick") &&
    active instanceof HTMLElement &&
    ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) &&
    Boolean(currentBody?.contains(active));
  const body =
    editing && currentBody
      ? currentBody
      : state.view === "settings"
        ? settingsView()
        : state.view === "kick"
          ? kickView()
          : state.user
            ? liveView()
            : signInView();
  currentBody = body;
  currentView = state.view;
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

window.setInterval(() => {
  void refresh();
  void refreshKick();
}, REFRESH_MS);
void start();
void refreshKick();
