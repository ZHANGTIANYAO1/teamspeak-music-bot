/**
 * Cookies for the music platforms are pasted in by hand, and what people paste
 * is usually not a cookie — it is the raw `Set-Cookie` header, attributes and
 * all:
 *
 *   MUSIC_A_T=145...; Max-Age=2147483647; Expires=Thu, 25 Nov 2094 ...; Path=/api/clientlog;
 *   ;MUSIC_R_T=145...; Max-Age=2147483647; Expires=...; Path=/eapi/feedback; ...
 *
 * Every `;`-separated fragment with an `=` is treated as a cookie pair, so
 * `Max-Age`, `Expires` and `Path` become cookie NAMES. The string then gets
 * passed to the sidecar API as `?cookie=...`, and two things happen:
 *
 *  1. the sidecar answers **400** instead of a song URL. Measured on a live
 *     deployment: 34 of 34 `/song/url/v1` calls failed with ERR_BAD_REQUEST
 *     while the cookie file held a header blob, and every one of those surfaced
 *     to the user as 「无法播放（区域/版权限制）」;
 *  2. the query string grows to several KB (5 KB of header re-encoded becomes
 *     closer to 10 KB), which can also trip the HTTP request-line limit.
 *
 * Normalising both on the way in (setCookie) and on the way out (loading the
 * stored file) repairs existing deployments without asking anyone to log in
 * again. Nothing about a VALID cookie changes — see the tests.
 */

/**
 * Attributes that belong to a Set-Cookie LINE, never to a Cookie header. Kept
 * lowercase for the comparison. `size` is Chrome-specific, `partitioned` and
 * `priority` are newer additions, and `comment`/`version` are RFC 2109 leftovers
 * that still show up in hand-copied blobs.
 */
const SET_COOKIE_ATTRIBUTES = new Set([
  "max-age",
  "expires",
  "path",
  "domain",
  "secure",
  "httponly",
  "samesite",
  "priority",
  "partitioned",
  "version",
  "comment",
  "size",
  "sameparty",
]);

/** RFC 6265 cookie-name (token) — anything else is header noise, not a name. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Turn whatever was pasted into a syntactically valid `Cookie:` header value.
 *
 * - drops a leading `Set-Cookie:` / `Cookie:` prefix (people copy the whole line)
 * - drops attribute pairs (`Max-Age`, `Expires`, `Path`, ...)
 * - drops fragments without `=` (`;;`, trailing separators)
 * - drops values that are empty, which the sidecar reads as "unset anyway"
 * - strips CR/LF, which a multi-line paste leaves inside values and which make
 *   the outgoing query string invalid
 * - de-duplicates by name, last one wins (a header blob repeats MUSIC_A_T a
 *   dozen times for different paths; the payload is identical each time)
 *
 * Idempotent: normalising an already-normalised cookie returns it unchanged.
 */
export function normalizeCookie(raw: string): string {
  if (!raw) return "";

  let text = raw.trim();
  const prefix = /^(?:set-)?cookie\s*:\s*/i.exec(text);
  if (prefix) text = text.slice(prefix[0].length);

  const pairs = new Map<string, string>();
  for (const fragment of text.split(";")) {
    const eq = fragment.indexOf("=");
    if (eq <= 0) continue;

    const name = fragment.slice(0, eq).trim();
    // A value may legitimately contain '=' (base64 padding), so keep the rest.
    const value = fragment.slice(eq + 1).replace(/[\r\n]+/g, "").trim();

    if (!name || !value) continue;
    if (!TOKEN.test(name)) continue;
    if (SET_COOKIE_ATTRIBUTES.has(name.toLowerCase())) continue;

    pairs.set(name, value);
  }

  return [...pairs].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** True when `raw` is already a clean cookie header and normalising is a no-op. */
export function isNormalizedCookie(raw: string): boolean {
  return normalizeCookie(raw) === raw;
}
