// Browse, search and channel pages for Twitch and Kick.

import { invoke } from "@tauri-apps/api/core";
import { h } from "./ui";
import {
  boxArt,
  channelPage,
  gameStreams,
  searchCategories,
  searchChannels,
  thumbnail,
  topGames,
  topStreams,
  type ChannelPage,
} from "./twitch";
import type {
  KickCategory,
  KickChannel,
  KickStream,
  LiveStream,
  Platform,
  TwitchChannelResult,
  TwitchGame,
} from "./types";

export type TwitchPage =
  | { kind: "following" }
  | { kind: "browse" }
  | { kind: "game"; id: string; name: string }
  | { kind: "search"; q: string }
  | { kind: "channel"; login: string };

export type KickPage =
  | { kind: "mine" }
  | { kind: "browse" }
  | { kind: "category"; slug: string; name: string }
  | { kind: "search"; q: string }
  | { kind: "channel"; slug: string };

/** What the pages need from the app. */
export interface Ctx {
  render(): void;
  token(): string;
  /** Browse pages' language filter ("" = all). */
  language(): string;
  watch(platform: Platform, channel: string): void;
  openChat(platform: Platform, channel: string): void;
  chatEnabled(): boolean;
  kickSaved(slug: string): boolean;
  addKick(slug: string): void;
  removeKick(slug: string): void;
}

// ---- navigation: one stack of pages per site ----

export const nav = {
  twitch: [{ kind: "following" }] as TwitchPage[],
  kick: [{ kind: "mine" }] as KickPage[],
};

export function twitchPage(): TwitchPage {
  return nav.twitch[nav.twitch.length - 1];
}

export function kickPage(): KickPage {
  return nav.kick[nav.kick.length - 1];
}

export function go(site: "twitch", page: TwitchPage): void;
export function go(site: "kick", page: KickPage): void;
export function go(site: Platform, page: TwitchPage | KickPage): void {
  // the first page of a section starts a new stack
  const root = page.kind === "following" || page.kind === "mine" || page.kind === "browse";
  if (site === "twitch") {
    if (root) nav.twitch = [page as TwitchPage];
    else nav.twitch.push(page as TwitchPage);
  } else {
    if (root) nav.kick = [page as KickPage];
    else nav.kick.push(page as KickPage);
  }
  window.scrollTo(0, 0);
}

export function back(site: Platform): void {
  if (site === "twitch" && nav.twitch.length > 1) nav.twitch.pop();
  if (site === "kick" && nav.kick.length > 1) nav.kick.pop();
}

export function canGoBack(site: Platform): boolean {
  return (site === "twitch" ? nav.twitch : nav.kick).length > 1;
}

// ---- loading, cached per page for a minute ----

interface Entry {
  loading: boolean;
  error: string;
  data: unknown;
  at: number;
}

const cache = new Map<string, Entry>();
const MAX_AGE = 60_000;

function load<T>(ctx: Ctx, key: string, fetcher: () => Promise<T>): Entry {
  let entry = cache.get(key);
  const stale = !entry || (!entry.loading && Date.now() - entry.at > MAX_AGE);
  if (stale) {
    entry = { loading: true, error: "", data: entry?.data ?? null, at: Date.now() };
    cache.set(key, entry);
    const current = entry;
    fetcher()
      .then((data) => {
        current.data = data;
        current.error = "";
      })
      .catch((e) => {
        current.error = String(e instanceof Error ? e.message : e);
      })
      .finally(() => {
        current.loading = false;
        current.at = Date.now();
        ctx.render();
      });
  }
  return entry!;
}

/** Forget everything loaded (e.g. after the language filter changed). */
export function clearCache(): void {
  cache.clear();
}

export function refreshPage(site: Platform): void {
  const page = site === "twitch" ? twitchPage() : kickPage();
  for (const key of cache.keys()) {
    if (key.startsWith(`${site}:${page.kind}`)) cache.delete(key);
  }
}

function status(entry: Entry, empty: string, hasData: boolean): HTMLElement | null {
  if (entry.error) return h("p", { class: "row-error" }, entry.error);
  if (!hasData) return h("p", { class: "empty" }, entry.loading ? "Loading…" : empty);
  return null;
}

// ---- shared pieces ----

function viewers(n: number | null | undefined): string {
  return n === null || n === undefined ? "Live" : n.toLocaleString();
}

function streamCard(opts: {
  platform: Platform;
  channel: string;
  name: string;
  title: string;
  detail: string;
  viewers: number | null;
  image: string | null;
  /** Shown when the stream's picture doesn't load (Kick has none for new streams). */
  fallback?: string | null;
  onName: () => void;
  ctx: Ctx;
}): HTMLElement {
  const { ctx } = opts;
  return h(
    "div",
    { class: "card-wrap" },
    h(
      "button",
      { class: "card", title: `Watch ${opts.name}`, onclick: () => ctx.watch(opts.platform, opts.channel) },
      h(
        "div",
        { class: "thumb" },
        opts.image || opts.fallback
          ? h("img", {
              src: (opts.image || opts.fallback)!,
              class: opts.image ? undefined : "fallback",
              alt: "",
              loading: "lazy",
              referrerpolicy: "no-referrer",
              onerror: (e) => {
                const img = e.target as HTMLImageElement;
                if (opts.fallback && !img.classList.contains("fallback")) {
                  img.classList.add("fallback");
                  img.src = opts.fallback;
                } else {
                  img.remove();
                }
              },
            })
          : null,
        h("span", { class: `viewers${opts.platform === "kick" ? " kick" : ""}` }, `● ${viewers(opts.viewers)}`),
      ),
      h("div", { class: "card-title" }, opts.title || "Untitled stream"),
    ),
    h(
      "div",
      { class: "card-meta" },
      h("button", { class: "name-link", onclick: opts.onName, title: `${opts.name}'s channel` }, opts.name),
      opts.detail ? ` · ${opts.detail}` : "",
    ),
  );
}

function categoryCard(name: string, image: string | null, sub: string, onclick: () => void): HTMLElement {
  return h(
    "button",
    { class: "category", onclick, title: name },
    h("div", { class: "box" }, image ? h("img", { src: image, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null),
    h("div", { class: "card-title" }, name),
    sub ? h("div", { class: "card-meta" }, sub) : null,
  );
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h("section", { class: "section" }, h("h2", {}, title), ...children);
}

// ---- Twitch pages ----

export function twitchStreamCard(ctx: Ctx, s: LiveStream, showGame = true): HTMLElement {
  return streamCard({
    ctx,
    platform: "twitch",
    channel: s.user_login,
    name: s.user_name,
    title: s.title,
    detail: showGame ? s.game_name : "",
    viewers: s.viewer_count,
    image: `${thumbnail(s)}?t=${Math.floor(Date.now() / MAX_AGE)}`,
    onName: () => {
      go("twitch", { kind: "channel", login: s.user_login });
      ctx.render();
    },
  });
}

function twitchBrowse(ctx: Ctx): HTMLElement {
  const games = load(ctx, "twitch:browse:games", () => topGames(ctx.token()));
  const lang = ctx.language();
  const streams = load(ctx, `twitch:browse:streams:${lang}`, () => topStreams(ctx.token(), lang));
  const gameList = (games.data as TwitchGame[] | null) ?? [];
  const streamList = (streams.data as LiveStream[] | null) ?? [];
  return h(
    "div",
    {},
    section(
      "Top categories",
      status(games, "No categories.", gameList.length > 0),
      gameList.length
        ? h(
            "div",
            { class: "categories" },
            ...gameList.map((g) =>
              categoryCard(g.name, boxArt(g), "", () => {
                go("twitch", { kind: "game", id: g.id, name: g.name });
                ctx.render();
              }),
            ),
          )
        : null,
    ),
    section(
      "Top live streams",
      status(streams, "No live streams.", streamList.length > 0),
      streamList.length ? h("div", { class: "grid" }, ...streamList.map((s) => twitchStreamCard(ctx, s))) : null,
    ),
  );
}

function twitchGame(ctx: Ctx, id: string, name: string): HTMLElement {
  const lang = ctx.language();
  const entry = load(ctx, `twitch:game:${id}:${lang}`, () => gameStreams(ctx.token(), id, lang));
  const list = (entry.data as LiveStream[] | null) ?? [];
  return section(
    name,
    status(entry, "Nobody is live in this category right now.", list.length > 0),
    list.length ? h("div", { class: "grid" }, ...list.map((s) => twitchStreamCard(ctx, s, false))) : null,
  );
}

function twitchSearch(ctx: Ctx, q: string): HTMLElement {
  const channels = load(ctx, `twitch:search:channels:${q}`, () => searchChannels(ctx.token(), q));
  const games = load(ctx, `twitch:search:games:${q}`, () => searchCategories(ctx.token(), q));
  const channelList = (channels.data as TwitchChannelResult[] | null) ?? [];
  const gameList = (games.data as TwitchGame[] | null) ?? [];

  const row = (c: TwitchChannelResult) =>
    h(
      "div",
      { class: "row" },
      c.thumbnail_url ? h("img", { class: "avatar", src: c.thumbnail_url, alt: "" }) : h("span", { class: "avatar" }),
      h(
        "button",
        {
          class: "name-link",
          onclick: () => {
            go("twitch", { kind: "channel", login: c.broadcaster_login });
            ctx.render();
          },
        },
        c.display_name,
      ),
      c.is_live ? h("span", { class: "chip ok" }, "Live") : h("span", { class: "muted" }, "Offline"),
      h("span", { class: "muted ellipsis" }, c.is_live ? [c.game_name, c.title].filter(Boolean).join(" · ") : c.game_name),
      c.is_live
        ? h("button", { class: "small push", onclick: () => ctx.watch("twitch", c.broadcaster_login) }, "Watch")
        : null,
    );

  return h(
    "div",
    {},
    h("h1", { class: "page-title" }, `Results for “${q}”`),
    section(
      "Channels",
      status(channels, "No channels found.", channelList.length > 0),
      channelList.length ? h("div", { class: "rows" }, ...channelList.map(row)) : null,
    ),
    section(
      "Categories",
      status(games, "No categories found.", gameList.length > 0),
      gameList.length
        ? h(
            "div",
            { class: "categories" },
            ...gameList.map((g) =>
              categoryCard(g.name, boxArt(g), "", () => {
                go("twitch", { kind: "game", id: g.id, name: g.name });
                ctx.render();
              }),
            ),
          )
        : null,
    ),
  );
}

function channelHeader(opts: {
  avatar: string | null;
  name: string;
  platform: Platform;
  live: boolean;
  followers: number | null;
  bio: string;
  actions: (Node | null)[];
}): HTMLElement {
  return h(
    "div",
    { class: "channel-head" },
    opts.avatar ? h("img", { class: "channel-avatar", src: opts.avatar, alt: "", referrerpolicy: "no-referrer" }) : h("span", { class: "channel-avatar" }),
    h(
      "div",
      { class: "channel-info" },
      h(
        "h1",
        {},
        opts.name,
        " ",
        opts.live
          ? h("span", { class: `chip ${opts.platform === "kick" ? "kick" : "ok"}` }, "Live")
          : h("span", { class: "chip" }, "Offline"),
      ),
      opts.followers !== null ? h("div", { class: "muted" }, `${opts.followers.toLocaleString()} followers`) : null,
      opts.bio ? h("p", { class: "bio" }, opts.bio) : null,
      h("div", { class: "actions" }, ...opts.actions),
    ),
  );
}

function twitchChannel(ctx: Ctx, login: string): HTMLElement {
  const entry = load(ctx, `twitch:channel:${login}`, () => channelPage(ctx.token(), login));
  const data = entry.data as ChannelPage | null;
  if (!data) {
    return status(entry, "Channel not found.", false) ?? h("p", {}, "");
  }
  const { profile, stream } = data;
  return h(
    "div",
    {},
    channelHeader({
      avatar: profile.profile_image_url || null,
      name: profile.display_name,
      platform: "twitch",
      live: Boolean(stream),
      followers: data.followers,
      bio: profile.description,
      actions: [
        stream ? h("button", { class: "primary", onclick: () => ctx.watch("twitch", profile.login) }, "Watch") : null,
        stream && ctx.chatEnabled()
          ? h("button", { class: "small", onclick: () => ctx.openChat("twitch", profile.login) }, "Chat")
          : null,
      ],
    }),
    stream
      ? h("div", { class: "grid" }, twitchStreamCard(ctx, stream))
      : profile.offline_image_url
        ? h("img", { class: "offline-banner", src: profile.offline_image_url, alt: "" })
        : null,
  );
}

/** The Twitch tab's content for pages other than "following" (null: show the following page). */
export function twitchContent(ctx: Ctx): HTMLElement | null {
  const page = twitchPage();
  switch (page.kind) {
    case "following":
      return null;
    case "browse":
      return twitchBrowse(ctx);
    case "game":
      return twitchGame(ctx, page.id, page.name);
    case "search":
      return twitchSearch(ctx, page.q);
    case "channel":
      return twitchChannel(ctx, page.login);
  }
}

// ---- Kick pages ----

function kickStreams(slug: string | null, language: string): Promise<KickStream[]> {
  return invoke<KickStream[]>("kick_browse", { kind: "streams", slug, language: language || null });
}

function kickCategories(): Promise<KickCategory[]> {
  return invoke<KickCategory[]>("kick_browse", { kind: "categories", slug: null });
}

function kickStreamCard(ctx: Ctx, s: KickStream, showCategory = true): HTMLElement {
  return streamCard({
    ctx,
    platform: "kick",
    channel: s.slug,
    name: s.name,
    title: s.title,
    detail: showCategory ? s.category : "",
    viewers: s.viewers,
    image: s.thumbnail,
    fallback: s.avatar ?? null,
    onName: () => {
      go("kick", { kind: "channel", slug: s.slug });
      ctx.render();
    },
  });
}

function kickCategoryCard(ctx: Ctx, c: KickCategory): HTMLElement {
  return categoryCard(c.name, c.image, c.viewers ? `${c.viewers.toLocaleString()} viewers` : "", () => {
    go("kick", { kind: "category", slug: c.slug, name: c.name });
    ctx.render();
  });
}

function kickBrowse(ctx: Ctx): HTMLElement {
  const cats = load(ctx, "kick:browse:categories", kickCategories);
  const lang = ctx.language();
  const streams = load(ctx, `kick:browse:streams:${lang}`, () => kickStreams(null, lang));
  const catList = (cats.data as KickCategory[] | null) ?? [];
  const streamList = (streams.data as KickStream[] | null) ?? [];
  return h(
    "div",
    {},
    section(
      "Top categories",
      status(cats, "No categories.", catList.length > 0),
      catList.length ? h("div", { class: "categories" }, ...catList.map((c) => kickCategoryCard(ctx, c))) : null,
    ),
    section(
      "Top live streams",
      status(streams, "No live streams.", streamList.length > 0),
      streamList.length ? h("div", { class: "grid" }, ...streamList.map((s) => kickStreamCard(ctx, s))) : null,
    ),
  );
}

function kickCategory(ctx: Ctx, slug: string, name: string): HTMLElement {
  const lang = ctx.language();
  const entry = load(ctx, `kick:category:${slug}:${lang}`, () => kickStreams(slug, lang));
  const list = (entry.data as KickStream[] | null) ?? [];
  return section(
    name,
    status(entry, "Nobody is live in this category right now.", list.length > 0),
    list.length ? h("div", { class: "grid" }, ...list.map((s) => kickStreamCard(ctx, s, false))) : null,
  );
}

function kickChannelData(slug: string): Promise<KickChannel | null> {
  return invoke<KickChannel[]>("kick_channels", { slugs: [slug] }).then((list) => {
    const channel = list[0];
    if (!channel || channel.error === "Channel not found") return null;
    if (channel.error) throw new Error(channel.error);
    return channel;
  });
}

function kickSearch(ctx: Ctx, q: string): HTMLElement {
  const slug = q
    .trim()
    .replace(/^https?:\/\/(?:www\.)?kick\.com\//i, "")
    .replace(/^@/, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
  const validSlug = /^[a-z0-9_-]{1,64}$/.test(slug);
  const channel = validSlug ? load(ctx, `kick:search:channel:${slug}`, () => kickChannelData(slug)) : null;
  const cats = load(ctx, "kick:browse:categories", kickCategories);
  const found = channel?.data as KickChannel | null | undefined;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const catList = ((cats.data as KickCategory[] | null) ?? []).filter((c) =>
    words.every((w) => c.name.toLowerCase().includes(w) || c.slug.includes(w)),
  );

  return h(
    "div",
    {},
    h("h1", { class: "page-title" }, `Results for “${q}”`),
    h("p", { class: "muted" }, "Kick has no channel search: StreamHub looks for a channel with exactly this name."),
    section(
      "Channel",
      channel ? status(channel, "No Kick channel with this name.", Boolean(found)) : h("p", { class: "empty" }, "Not a Kick channel name."),
      found
        ? h(
            "div",
            { class: "rows" },
            h(
              "div",
              { class: "row" },
              found.avatar ? h("img", { class: "avatar", src: found.avatar, alt: "" }) : h("span", { class: "avatar" }),
              h(
                "button",
                {
                  class: "name-link",
                  onclick: () => {
                    go("kick", { kind: "channel", slug: found.slug });
                    ctx.render();
                  },
                },
                found.name,
              ),
              found.live ? h("span", { class: "chip kick" }, "Live") : h("span", { class: "muted" }, "Offline"),
              h("span", { class: "muted ellipsis" }, found.live ? [found.category, found.title].filter(Boolean).join(" · ") : ""),
              found.live ? h("button", { class: "small push", onclick: () => ctx.watch("kick", found.slug) }, "Watch") : null,
            ),
          )
        : null,
    ),
    section(
      "Categories",
      status(cats, "No matching categories.", catList.length > 0),
      catList.length ? h("div", { class: "categories" }, ...catList.map((c) => kickCategoryCard(ctx, c))) : null,
    ),
  );
}

function kickChannel(ctx: Ctx, slug: string): HTMLElement {
  const entry = load(ctx, `kick:channel:${slug}`, () => kickChannelData(slug));
  const c = entry.data as KickChannel | null;
  if (!c) return status(entry, "Channel not found.", false) ?? h("p", {}, "");
  const saved = ctx.kickSaved(c.slug);
  return h(
    "div",
    {},
    channelHeader({
      avatar: c.avatar,
      name: c.name,
      platform: "kick",
      live: c.live,
      followers: c.followers,
      bio: c.bio ?? "",
      actions: [
        c.live ? h("button", { class: "primary", onclick: () => ctx.watch("kick", c.slug) }, "Watch") : null,
        c.live && ctx.chatEnabled() ? h("button", { class: "small", onclick: () => ctx.openChat("kick", c.slug) }, "Chat") : null,
        h(
          "button",
          { class: "small", onclick: () => (saved ? ctx.removeKick(c.slug) : ctx.addKick(c.slug)) },
          saved ? "Remove from my channels" : "Add to my channels",
        ),
      ],
    }),
    c.live
      ? h(
          "div",
          { class: "grid" },
          kickStreamCard(ctx, {
            slug: c.slug,
            name: c.name,
            title: c.title,
            viewers: c.viewers,
            thumbnail: c.thumbnail,
            category: c.category,
            avatar: c.avatar,
          }),
        )
      : null,
  );
}

/** The Kick tab's content for pages other than "mine" (null: show the user's channels). */
export function kickContent(ctx: Ctx): HTMLElement | null {
  const page = kickPage();
  switch (page.kind) {
    case "mine":
      return null;
    case "browse":
      return kickBrowse(ctx);
    case "category":
      return kickCategory(ctx, page.slug, page.name);
    case "search":
      return kickSearch(ctx, page.q);
    case "channel":
      return kickChannel(ctx, page.slug);
  }
}
