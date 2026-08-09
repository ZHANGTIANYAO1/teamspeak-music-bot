/**
 * Parsing helpers for picking an EXACT song in a !play / !add / !playnext query,
 * so same-name songs can be disambiguated instead of always getting the single
 * most-popular search hit (issue #90).
 *
 * Two mechanisms:
 *  - A song reference: an explicit id / platform URL → play that exact song.
 *  - A selection index: "#N" → the Nth result of the previous !search.
 */

export interface SongRef {
  id: string;
  /**
   * Platform inferred from a URL. `null` means the platform wasn't encoded in
   * the reference (e.g. a bare `id:`), so the caller should fall back to the
   * command's flags / default provider.
   */
  platform: "netease" | "qq" | "bilibili" | null;
}

/**
 * Could this token plausibly BE an id on a supported platform?
 *   - NetEase / Kugou numeric ids      → all digits
 *   - BiliBili                         → BV + 8-12 alphanumerics
 *   - QQ mid (14), YouTube (11), Spotify (22), Jellyfin GUID / Kugou hash (32)
 *                                      → 11+ chars from the id alphabet
 * Deliberately conservative: anything rejected here just stays an ordinary
 * search term, which is what it almost certainly was.
 */
function looksLikeSongId(token: string): boolean {
  return /^(?:\d+|BV[0-9A-Za-z]{8,12}|[0-9A-Za-z_-]{11,})$/i.test(token);
}

/**
 * Detect an explicit song reference in a query. Recognizes:
 *   - `id <id>` / `id:<id>`             → platform from flags/default
 *   - NetEase song URL                  → music.163.com/song?id=N (also /#/song?id=N, /song/N)
 *   - QQ song URL                       → y.qq.com/.../songDetail/MID (or ?songmid=MID)
 *   - BiliBili BVID (bare or in a URL)  → bilibili.com/video/BVxxxx, b23.tv, or BVxxxx
 * Returns `null` for a plain search term (the common case).
 */
export function parseSongRef(raw: string): SongRef | null {
  const q = (raw ?? "").trim();
  if (!q) return null;

  // Explicit id — platform decided by the command's flags/default. The
  // separator is a colon or plain whitespace, so `id <id>` matches the
  // `!<cmd> <sub> <arg>` shape of every other command (issue #139) while the
  // older `id:<id>` keeps working. Strip trailing punctuation that tags along
  // from a chat paste ("id:12345." / "id:12345)") — no supported id
  // (numeric / BVID / mid) ends in those.
  //
  // The colon is an unambiguous sigil, so `id:<anything>` is always an id. A
  // space is not: "ID 4" and "ID Bruno" are real track titles, and `id <url>`
  // has to keep resolving as a URL. So the space form only claims tokens that
  // could actually be an id; anything else falls through to the URL branches
  // below and ultimately to a plain search.
  const idPrefix = /^id(:\s*|\s+)(\S+)$/i.exec(q);
  if (idPrefix) {
    const id = idPrefix[2].replace(/[.,;)\]]+$/, "");
    if (idPrefix[1].startsWith(":") || looksLikeSongId(id)) {
      return { id, platform: null };
    }
  }

  // BiliBili BV id, bare or inside a bilibili URL (NetEase ids are numeric, so
  // a "BV..." token never collides with them).
  const bv = /BV[0-9A-Za-z]{8,12}/.exec(q);
  if (bv && (/^BV[0-9A-Za-z]{8,12}$/.test(q) || /bilibili\.com|b23\.tv/i.test(q))) {
    return { id: bv[0], platform: "bilibili" };
  }

  // NetEase song URL. Only treat `id=N` as a SONG id when the URL is not a
  // collection page (playlist/album/artist/toplist/djradio) — those reuse the
  // same `id=` param but are NOT songs; getSongDetail() would 404 them into a
  // confusing "no song" error instead of falling back to a normal search.
  if (/music\.163\.com/i.test(q) && !/(playlist|album|artist|toplist|djradio)/i.test(q)) {
    const m = /[?&#/]id=(\d+)/.exec(q) ?? /\/song\/(\d+)/.exec(q);
    if (m) return { id: m[1], platform: "netease" };
  }

  // QQ song URL.
  if (/y\.qq\.com/i.test(q)) {
    const m = /songDetail\/([0-9A-Za-z]+)/.exec(q) ?? /[?&]songmid=([0-9A-Za-z]+)/i.exec(q);
    if (m) return { id: m[1], platform: "qq" };
  }

  return null;
}

/**
 * Detect a "#N" selection token (1-based) referencing the previous !search.
 * Returns the positive integer, or `null` when the query isn't a selection.
 */
export function parseSelectionIndex(raw: string): number | null {
  const m = /^#\s*(\d+)$/.exec((raw ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
