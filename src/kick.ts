const KEY = "streamhub.kick.channels";

export function loadKickSlugs(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function saveKickSlugs(slugs: string[]): string[] {
  const unique = [...new Set(slugs.map((s) => s.trim().toLowerCase()).filter(Boolean))];
  try {
    localStorage.setItem(KEY, JSON.stringify(unique));
  } catch {
    // storage unavailable: the list lasts until StreamHub closes
  }
  return unique;
}

/**
 * Channel names or kick.com links, separated by commas, spaces or new lines.
 * Returns the valid slugs and the entries that aren't valid.
 */
export function parseKickInput(input: string): { slugs: string[]; invalid: string[] } {
  const slugs: string[] = [];
  const invalid: string[] = [];
  for (const entry of input.split(/[\s,]+/).filter(Boolean)) {
    const slug = entry
      .replace(/^https?:\/\/(?:www\.)?kick\.com\//i, "")
      .replace(/^\/+|\/+$/g, "")
      .replace(/[?#].*$/, "")
      .toLowerCase();
    if (/^[a-z0-9_-]{1,64}$/.test(slug)) slugs.push(slug);
    else invalid.push(entry);
  }
  return { slugs, invalid };
}
