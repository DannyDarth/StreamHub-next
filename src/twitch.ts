import type { LiveStream, TwitchChannelResult, TwitchGame, TwitchProfile, TwitchUser } from "./types";

export const CLIENT_ID = "phiay4sq36lfv9zu7cbqwz2ndnesfd8";

export class AuthError extends Error {}

/** Check the token and get the signed-in user. */
export async function validateToken(token: string): Promise<TwitchUser> {
  const res = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (res.status === 401) throw new AuthError("Your Twitch sign-in has expired");
  if (!res.ok) throw new Error(`Twitch returned ${res.status}`);
  const data = (await res.json()) as { user_id: string; login: string; client_id: string };
  if (data.client_id !== CLIENT_ID) throw new AuthError("This sign-in belongs to another app");
  return { id: data.user_id, login: data.login };
}

async function helix<T>(token: string, path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`https://api.twitch.tv/helix/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, {
    headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("Your Twitch sign-in has expired");
  if (!res.ok) throw new Error(`Twitch returned ${res.status}`);
  return (await res.json()) as T;
}

/** All live channels the user follows, most viewers first. */
export async function followedLive(token: string, user: TwitchUser): Promise<LiveStream[]> {
  const streams: LiveStream[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const params: Record<string, string> = { user_id: user.id, first: "100" };
    if (cursor) params.after = cursor;
    const data = await helix<{ data: LiveStream[]; pagination?: { cursor?: string } }>(
      token,
      "streams/followed",
      params,
    );
    streams.push(...data.data);
    cursor = data.pagination?.cursor ?? "";
    if (!cursor || data.data.length < 100) break;
  }
  return streams.sort((a, b) => b.viewer_count - a.viewer_count);
}

export function thumbnail(stream: LiveStream, width = 440, height = 248): string {
  return stream.thumbnail_url.replace("{width}", String(width)).replace("{height}", String(height));
}

export function boxArt(game: TwitchGame, width = 188, height = 250): string {
  return game.box_art_url.replace("{width}", String(width)).replace("{height}", String(height));
}

export async function topGames(token: string): Promise<TwitchGame[]> {
  return (await helix<{ data: TwitchGame[] }>(token, "games/top", { first: "60" })).data;
}

/** Live streams in a category, most viewers first. */
export async function gameStreams(token: string, gameId: string, language = ""): Promise<LiveStream[]> {
  const params: Record<string, string> = { game_id: gameId, first: "60" };
  if (language) params.language = language;
  return (await helix<{ data: LiveStream[] }>(token, "streams", params)).data;
}

export async function topStreams(token: string, language = ""): Promise<LiveStream[]> {
  const params: Record<string, string> = { first: "60" };
  if (language) params.language = language;
  return (await helix<{ data: LiveStream[] }>(token, "streams", params)).data;
}

export async function searchChannels(token: string, query: string): Promise<TwitchChannelResult[]> {
  const data = await helix<{ data: TwitchChannelResult[] }>(token, "search/channels", { query, first: "30" });
  // live channels first
  return data.data.sort((a, b) => Number(b.is_live) - Number(a.is_live));
}

export async function searchCategories(token: string, query: string): Promise<TwitchGame[]> {
  return (await helix<{ data: TwitchGame[] }>(token, "search/categories", { query, first: "20" })).data;
}

export interface ChannelPage {
  profile: TwitchProfile;
  stream: LiveStream | null;
  followers: number | null;
}

export async function channelPage(token: string, login: string): Promise<ChannelPage | null> {
  const users = await helix<{ data: TwitchProfile[] }>(token, "users", { login });
  const profile = users.data[0];
  if (!profile) return null;
  const [streams, followers] = await Promise.all([
    helix<{ data: LiveStream[] }>(token, "streams", { user_id: profile.id }),
    helix<{ total: number }>(token, "channels/followers", { broadcaster_id: profile.id, first: "1" }).catch(() => null),
  ]);
  return { profile, stream: streams.data[0] ?? null, followers: followers?.total ?? null };
}
