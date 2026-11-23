import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  DEFAULTS,
  LANGUAGES,
  QUALITIES,
  applyTheme,
  followSystemTheme,
  loadSettings,
  saveSettings,
} from "./settings";
import { AuthError, followedLive, validateToken } from "./twitch";
import { loadKickSlugs, parseKickInput, saveKickSlugs } from "./kick";
import { h } from "./ui";
import * as browse from "./browse";
import type {
  AdblockStatus,
  EndedEvent,
  KickAccount,
  KickChannel,
  KickFollowed,
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
  search: "",
  kickAccount: null as KickAccount | null,
  kickFollowed: [] as KickFollowed[],
  /** The channel shown in the chat panel. */
  chat: null as { platform: Platform; channel: string } | null,
};

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

/** Every Kick channel shown under "My channels": the ones the user added and the ones they follow. */
function allKickSlugs(): string[] {
  return [...new Set([...state.kickSlugs, ...state.kickFollowed.map((f) => f.slug)])];
}

async function checkKickAccount() {
  try {
    state.kickAccount = await invoke<KickAccount>("kick_account");
  } catch (e) {
    state.kickAccount = null;
    state.kickFollowed = [];
    if (String(e) !== "not-signed-in") state.kickError = `Couldn't check your Kick sign-in: ${String(e)}`;
  }
}

async function refreshKick() {
  state.kickLoading = true;
  render();
  try {
    if (state.kickAccount) {
      try {
        state.kickFollowed = await invoke<KickFollowed[]>("kick_followed");
      } catch (e) {
        if (String(e) === "not-signed-in") {
          state.kickAccount = null;
          state.kickFollowed = [];
        } else {
          state.kickError = `Couldn't load the Kick channels you follow: ${String(e)}`;
        }
      }
    }
    // check the channels the user added, and the followed ones that are live (for their pictures)
    const toCheck = [...new Set([...state.kickSlugs, ...state.kickFollowed.filter((f) => f.live).map((f) => f.slug)])];
    const channels = toCheck.length ? await invoke<KickChannel[]>("kick_channels", { slugs: toCheck }) : [];
    state.kickChannels = channels;
    if (!state.kickError.startsWith("Couldn't load")) state.kickError = "";
    const live = kickLive();
    state.kickKnown = await notifyNew(
      live.map((c) => ({ key: c.slug, name: c.name, detail: c.title || c.category })),
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

/** Live Kick channels: from the channel checks, or the followed list when a check failed. */
function kickLive(): KickChannel[] {
  const bySlug = new Map(state.kickChannels.map((c) => [c.slug, c]));
  const followed = new Map(state.kickFollowed.map((f) => [f.slug, f]));
  const live: KickChannel[] = [];
  for (const slug of allKickSlugs()) {
    const checked = bySlug.get(slug);
    if (checked && !checked.error) {
      if (checked.live) live.push(checked);
      continue;
    }
    const f = followed.get(slug);
    if (f?.live) {
      live.push({
        slug,
        name: f.name,
        live: true,
        title: f.title,
        category: f.category,
        viewers: f.viewers,
        thumbnail: null,
        avatar: f.avatar,
        startedAt: null,
        bio: null,
        followers: null,
        error: null,
      });
    }
  }
  return live.sort((a, b) => (b.viewers ?? 0) - (a.viewers ?? 0));
}

async function kickSignIn() {
  state.kickError = "";
  try {
    await invoke("kick_login");
    state.message = "Sign in on kick.com in the window that opened, then close it.";
  } catch (e) {
    state.kickError = String(e);
  }
  render();
}

async function kickSignOut() {
  try {
    await invoke("kick_logout");
  } catch (e) {
    state.kickError = String(e);
  }
  state.kickAccount = null;
  state.kickFollowed = [];
  render();
  void refreshKick();
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
    if (state.settings.chatEnabled && state.settings.chatAutoOpen) void openChat(platform, channel);
  } catch (e) {
    state.error = String(e);
  }
  render();
}

async function openChat(platform: Platform, channel: string) {
  const provider = state.settings.chatProvider;
  try {
    await invoke("open_chat", { platform, channel, provider });
    const inPanel = provider === "panel" || (provider === "chatterino" && platform === "kick");
    if (inPanel) state.chat = { platform, channel };
  } catch (e) {
    state.error = String(e);
  }
  render();
}

async function closeChat() {
  state.chat = null;
  render();
  try {
    await invoke("close_chat");
  } catch (e) {
    state.error = String(e);
    render();
  }
}

/** Close the chat panel when its stream stops. */
function closeChatOf(platform: Platform, channel: string) {
  if (state.chat?.platform === platform && state.chat.channel === channel.toLowerCase()) void closeChat();
}

async function stop(id: number) {
  const p = state.playing.get(id);
  if (p) closeChatOf(p.platform, p.channel);
  await invoke("stop", { id });
}

function updateSettings(patch: Partial<Settings>) {
  state.settings = { ...state.settings, ...patch };
  saveSettings(state.settings);
  if (patch.theme) applyTheme(state.settings.theme);
  if (patch.streamLanguage !== undefined) browse.clearCache();
}

function select<K extends "theme" | "buffer" | "streamLanguage" | "chatProvider">(
  label: string,
  key: K,
  options: readonly (readonly [string, string])[],
  help = "",
): HTMLElement {
  return h(
    "label",
    { class: "field" },
    h("span", {}, label),
    h(
      "select",
      {
        onchange: (e) =>
          updateSettings({ [key]: (e.target as HTMLSelectElement).value } as Partial<Settings>),
      },
      ...options.map(([value, text]) => h("option", { value, selected: state.settings[key] === value }, text)),
    ),
    help ? h("small", { class: "muted" }, help) : null,
  );
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

const ctx: browse.Ctx = {
  render: () => render(),
  token: () => state.token,
  language: () => state.settings.streamLanguage,
  watch: (platform, channel) => void watch(platform, channel),
  openChat: (platform, channel) => void openChat(platform, channel),
  chatEnabled: () => state.settings.chatEnabled,
  kickSaved: (slug) => state.kickSlugs.includes(slug),
  addKick: (slug) => {
    addKick(slug);
  },
  removeKick: (slug) => removeKick(slug),
};

function searchForm(): HTMLElement {
  const site: Platform = state.view === "kick" ? "kick" : "twitch";
  const input = h("input", {
    id: "search",
    type: "search",
    placeholder: site === "kick" ? "Search Kick" : "Search Twitch",
    spellcheck: "false",
    autocomplete: "off",
    oninput: (e) => (state.search = (e.target as HTMLInputElement).value),
  });
  input.value = state.search;
  return h(
    "form",
    {
      class: "search",
      onsubmit: (e) => {
        e.preventDefault();
        const q = state.search.trim();
        if (!q) return;
        state.view = site;
        if (site === "kick") browse.go("kick", { kind: "search", q });
        else browse.go("twitch", { kind: "search", q });
        (document.activeElement as HTMLElement | null)?.blur();
        render();
      },
    },
    input,
  );
}

/** Following / Browse (or My channels / Browse) and a back button. */
function subnav(site: Platform): HTMLElement {
  const page = site === "kick" ? browse.kickPage() : browse.twitchPage();
  const home = site === "kick" ? "mine" : "following";
  const link = (kind: "home" | "browse", label: string) => {
    const active = kind === "home" ? page.kind === home : page.kind !== home;
    return h(
      "button",
      {
        class: `sub${active ? " active" : ""}`,
        onclick: () => {
          if (site === "kick") browse.go("kick", kind === "home" ? { kind: "mine" } : { kind: "browse" });
          else browse.go("twitch", kind === "home" ? { kind: "following" } : { kind: "browse" });
          render();
        },
      },
      label,
    );
  };
  return h(
    "div",
    { class: "subnav" },
    browse.canGoBack(site)
      ? h("button", { class: "small", title: "Back", onclick: () => { browse.back(site); render(); } }, "‹ Back")
      : null,
    link("home", site === "kick" ? "My channels" : "Following"),
    link("browse", "Browse"),
    page.kind !== home
      ? h(
          "button",
          { class: "small push", onclick: () => { browse.refreshPage(site); render(); } },
          "Refresh",
        )
      : null,
  );
}

function header(): HTMLElement {
  const tab = (view: View, label: string) =>
    h(
      "button",
      {
        class: `tab tab-${view}${state.view === view ? " active" : ""}`,
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
    searchForm(),
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
        state.settings.chatEnabled
          ? h("button", { class: "small push", onclick: () => void openChat(p.platform, p.channel) }, "Chat")
          : null,
        h("button", { class: `small${state.settings.chatEnabled ? "" : " push"}`, onclick: () => void stop(id) }, "Stop"),
      ),
    ),
  );
}

function liveView(): HTMLElement {
  const list =
    state.streams.length > 0
      ? h("div", { class: "grid" }, ...state.streams.map((st) => browse.twitchStreamCard(ctx, st)))
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

  );
}

function kickRow(slug: string, checked: KickChannel | undefined): HTMLElement {
  const f = state.kickFollowed.find((x) => x.slug === slug);
  const channel: KickChannel | undefined =
    checked ??
    (f
      ? { slug, name: f.name, live: false, title: "", category: "", viewers: null, thumbnail: null, avatar: f.avatar, startedAt: null, bio: null, followers: null, error: null }
      : undefined);
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
    h(
      "span",
      { class: "muted push" },
      state.kickFollowed.some((f) => f.slug === slug) ? "Following" : "Added",
    ),
  );
}

function kickView(): HTMLElement {
  const bySlug = new Map(state.kickChannels.map((c) => [c.slug, c]));
  const live = kickLive();
  const liveSlugs = new Set(live.map((c) => c.slug));
  const all = allKickSlugs();
  const others = all.filter((slug) => !liveSlugs.has(slug));

  return h(
    "main",
    {},
    h(
      "div",
      { class: "toolbar" },
      h("h1", {}, "My Kick channels"),
      h(
        "button",
        { class: "small", onclick: () => void refreshKick(), disabled: state.kickLoading },
        state.kickLoading ? "Refreshing…" : "Refresh",
      ),
    ),
    state.kickError ? h("p", { class: "row-error" }, state.kickError) : null,
    all.length === 0
      ? h(
          "p",
          { class: "empty" },
          "No Kick channels yet. In Settings → Kick, sign in to Kick to see every channel you follow, or add channels yourself.",
        )
      : null,
    live.length > 0 ? h("div", { class: "grid" }, ...live.map(kickCard)) : null,
    live.length === 0 && all.length > 0 && !state.kickLoading
      ? h("p", { class: "empty" }, "None of your Kick channels are live right now.")
      : null,
    others.length > 0 ? h("h2", {}, "Offline") : null,
    others.length > 0 ? h("div", { class: "rows" }, ...others.map((slug) => kickRow(slug, bySlug.get(slug)))) : null,
  );
}

/** Settings → Kick: sign-in and the channels added by hand. */
function kickSettings(): HTMLElement[] {
  const account = state.kickAccount
    ? h(
        "div",
        { class: "kick-account" },
        state.kickAccount.avatar
          ? h("img", { class: "avatar", src: state.kickAccount.avatar, alt: "", referrerpolicy: "no-referrer" })
          : null,
        h("span", { class: "muted" }, "Signed in to Kick as "),
        h("strong", {}, state.kickAccount.username),
        h("span", { class: "muted" }, ` · ${state.kickFollowed.length} followed`),
        h("button", { class: "link", onclick: () => void kickSignOut() }, "Sign out"),
      )
    : h(
        "div",
        { class: "kick-account" },
        h("button", { class: "kick-signin", onclick: () => void kickSignIn() }, "Sign in to Kick"),
        h("span", { class: "muted" }, "to show every channel you follow, without adding them one by one"),
      );

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


  const added = state.kickSlugs.length
    ? h(
        "div",
        { class: "rows" },
        ...state.kickSlugs.map((slug) => {
          const c = state.kickChannels.find((x) => x.slug === slug);
          return h(
            "div",
            { class: "row" },
            c?.avatar
              ? h("img", { class: "avatar", src: c.avatar, alt: "", referrerpolicy: "no-referrer" })
              : h("span", { class: "avatar" }),
            h("strong", {}, c?.name ?? slug),
            h("button", { class: "link push", onclick: () => removeKick(slug) }, "Remove"),
          );
        }),
      )
    : h("p", { class: "muted" }, "None yet.");

  return [
    h("h2", {}, "Kick"),
    account,
    state.kickError ? h("p", { class: "row-error" }, state.kickError) : h("span", {}),
    h("h3", {}, "Channels you added"),
    h("p", { class: "muted" }, "Kick channels to show under My channels even if you don't follow them (or aren't signed in)."),
    form,
    added,
  ];
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
    checkbox("Low latency", "Smaller delay, may buffer more often (Twitch).", "lowLatency"),
    select(
      "Smoother playback",
      "buffer",
      [
        ["normal", "Normal"],
        ["more", "More buffer (fewer stutters, a few seconds behind)"],
        ["most", "Most buffer (for unsteady connections)"],
      ],
      "Keeps more video buffered so short hiccups don't stutter. Not used with low latency.",
    ),

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
    checkbox("Chat", "Add a Chat button to playing streams.", "chatEnabled"),
    !s.chatEnabled
      ? null
      : h(
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
            ["panel", "StreamHub (right side)"],
            ["browser", "My default browser"],
            ["chatterino", "Chatterino (Twitch; Kick chat stays in StreamHub)"],
          ] as const
        ).map(([value, label]) => h("option", { value, selected: s.chatProvider === value }, label)),
      ),
    ),
    s.chatEnabled
      ? checkbox("Open chat with the stream", "Open the channel's chat when a stream starts.", "chatAutoOpen")
      : null,

    ...kickSettings(),

    h("h2", {}, "Browse"),
    select("Stream language", "streamLanguage", LANGUAGES, "Top live streams and categories only show streams in this language."),

    h("h2", {}, "Appearance"),
    select("Theme", "theme", [
      ["dark", "Dark"],
      ["light", "Light"],
      ["system", "Same as Windows"],
    ]),

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
            applyTheme(state.settings.theme);
            browse.clearCache();
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

/** Put the section's sub-navigation on top of a page. */
function withSubnav(site: Platform, page: HTMLElement): HTMLElement {
  const main = page.tagName === "MAIN" ? page : h("main", {}, page);
  main.prepend(subnav(site));
  return main;
}

let currentBody: HTMLElement | null = null;
let currentView: View | null = null;

function render() {
  // don't rebuild a form while the user is typing in it
  const active = document.activeElement;
  const searchFocused = active instanceof HTMLInputElement && active.id === "search";
  const caret = searchFocused ? active.selectionStart : null;
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
          ? withSubnav("kick", browse.kickContent(ctx) ?? kickView())
          : state.user
            ? withSubnav("twitch", browse.twitchContent(ctx) ?? liveView())
            : signInView();
  document.body.classList.toggle("with-chat", Boolean(state.chat));
  const chatBar = state.chat
    ? h(
        "div",
        { class: "chat-bar" },
        h("span", { class: `chip ${state.chat.platform === "kick" ? "kick" : "info"}` }, state.chat.platform === "kick" ? "Kick" : "Twitch"),
        h("strong", {}, `${state.chat.channel} chat`),
        h("button", { class: "chat-close", title: "Close chat", onclick: () => void closeChat() }, "×"),
      )
    : null;
  currentBody = body;
  currentView = state.view;
  app.replaceChildren(
    header(),
    state.error ? h("div", { class: "banner error" }, state.error) : "",
    state.message ? h("div", { class: "banner" }, state.message) : "",
    playingBar() ?? "",
    body,
    chatBar ?? "",
  );
  if (searchFocused) {
    const search = document.getElementById("search") as HTMLInputElement | null;
    search?.focus();
    if (search && caret !== null) search.setSelectionRange(caret, caret);
  }
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
  const p = state.playing.get(payload.id);
  if (p) closeChatOf(p.platform, p.channel);
  state.playing.delete(payload.id);
  if (payload.error) state.error = `${payload.channel}: ${payload.error}`;
  render();
});

window.setInterval(() => {
  void refresh();
  void refreshKick();
}, REFRESH_MS);
void listen("kick-login-closed", async () => {
  state.message = "";
  await checkKickAccount();
  if (!state.kickAccount) state.kickError = "Not signed in to Kick. Sign in on kick.com, then close the window.";
  await refreshKick();
});

applyTheme(state.settings.theme);
followSystemTheme(() => state.settings.theme);
void start();
void checkKickAccount().then(() => refreshKick());
