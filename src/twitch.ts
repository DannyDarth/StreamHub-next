import type { LiveStream, TwitchUser } from "./types";

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
