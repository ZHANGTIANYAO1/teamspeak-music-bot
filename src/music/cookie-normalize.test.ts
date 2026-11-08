import { describe, expect, it } from "vitest";
import { isNormalizedCookie, normalizeCookie } from "./cookie-normalize.js";

/**
 * The exact shape found in a live deployment's data/cookies/netease.json. Every
 * `/song/url/v1` call answered 400 while this was stored, and the user saw
 * 「无法播放（区域/版权限制）」 on every play attempt.
 */
const HEADER_BLOB = [
  "MUSIC_A_T=1456043741268; Max-Age=2147483647; Expires=Thu, 25 Nov 2094 21:48:40 GMT; Path=/api/clientlog;",
  ";MUSIC_R_T=1456043923317; Max-Age=2147483647; Expires=Thu, 25 Nov 2094 21:48:40 GMT; Path=/eapi/feedback;",
  ";NMTID=00Oyuu_9EnDq_rMBEMIuKakmlo4dukAAAGht0p3Kw; Max-Age=315360000; Expires=Tue, 04 Nov 2036 18:34:33 GMT; Path=/;",
  ";MUSIC_U=00ABCDEF0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF0123456789abcdef0123456; Max-Age=1296000; Expires=Mon, 23 Nov 2026 09:32:11 GMT; Path=/;",
  ";__csrf=8f14e45fceea167a5a36dedd4bea2543; Max-Age=1296000; Expires=Mon, 23 Nov 2026 09:32:11 GMT; Path=/;",
].join("");

describe("normalizeCookie", () => {
  it("keeps only the real cookie pairs from a pasted Set-Cookie blob", () => {
    expect(normalizeCookie(HEADER_BLOB)).toBe(
      "MUSIC_A_T=1456043741268; MUSIC_R_T=1456043923317; NMTID=00Oyuu_9EnDq_rMBEMIuKakmlo4dukAAAGht0p3Kw; " +
        "MUSIC_U=00ABCDEF0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF0123456789abcdef0123456; " +
        "__csrf=8f14e45fceea167a5a36dedd4bea2543",
    );
  });

  it("drops every attribute name so it cannot be read as a cookie", () => {
    const out = normalizeCookie(HEADER_BLOB);
    for (const attr of ["Max-Age", "Expires", "Path", "Domain", "Secure", "HttpOnly", "SameSite"]) {
      expect(out).not.toContain(`${attr}=`);
    }
  });

  it("shrinks the query string enough to stop the 400", () => {
    // The real blob repeats one attribute set per request path, so it grows
    // several KB and the re-encoded query is what the sidecar rejects. The
    // fixture is the same shape at a smaller scale; what matters is that the
    // bulk (attributes) is gone and only the payload survives.
    expect(normalizeCookie(HEADER_BLOB).length).toBeLessThan(HEADER_BLOB.length * 0.6);
  });

  it("leaves an already-valid cookie untouched", () => {
    const valid = "MUSIC_U=abc123; __csrf=def456; NMTID=xyz";
    expect(normalizeCookie(valid)).toBe(valid);
    expect(isNormalizedCookie(valid)).toBe(true);
  });

  it("is idempotent", () => {
    const once = normalizeCookie(HEADER_BLOB);
    expect(normalizeCookie(once)).toBe(once);
  });

  it("strips a pasted `Set-Cookie:` / `Cookie:` prefix", () => {
    expect(normalizeCookie("Set-Cookie: MUSIC_U=abc; Path=/")).toBe("MUSIC_U=abc");
    expect(normalizeCookie("cookie: MUSIC_U=abc")).toBe("MUSIC_U=abc");
  });

  it("empties out a blob that carries no real cookie at all", () => {
    expect(normalizeCookie("Max-Age=1; Expires=Thu, 25 Nov 2094 21:48:40 GMT; Path=/")).toBe("");
  });

  it("removes CR/LF left inside a value by a multi-line paste", () => {
    expect(normalizeCookie("MUSIC_U=abc\r\ndef; __csrf=x")).toBe("MUSIC_U=abcdef; __csrf=x");
  });

  it("keeps the last value when a name repeats", () => {
    expect(normalizeCookie("MUSIC_A_T=1; MUSIC_A_T=2")).toBe("MUSIC_A_T=2");
  });

  it("keeps '=' inside a value (base64 padding)", () => {
    expect(normalizeCookie("MUSIC_U=abc==; Path=/")).toBe("MUSIC_U=abc==");
  });

  it("drops nameless fragments and empty values", () => {
    expect(normalizeCookie(";; =x; MUSIC_U=abc; empty=;")).toBe("MUSIC_U=abc");
  });

  it("handles the empty string", () => {
    expect(normalizeCookie("")).toBe("");
  });
});
