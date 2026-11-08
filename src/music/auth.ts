import fs from "node:fs";
import path from "node:path";
import { normalizeCookie } from "./cookie-normalize.js";

/** Platforms with a persisted credential blob. For jellyfin the "cookie" is a
 *  JSON string carrying the access token / userId / deviceId (see jellyfin.ts). */
type CookiePlatform = "netease" | "qq" | "bilibili" | "kugou" | "jellyfin";

/**
 * Everything except jellyfin stores a `Cookie:` header value, which people paste
 * by hand and therefore paste wrong — usually the whole `Set-Cookie` line, with
 * `Max-Age` / `Expires` / `Path` in it. Those get read as cookie names and the
 * sidecar answers 400, which the user sees as 「无法播放（区域/版权限制）」.
 * jellyfin's blob is JSON and must not be touched.
 */
function storesCookieHeader(platform: CookiePlatform): boolean {
  return platform !== "jellyfin";
}

export interface CookieStore {
  save(platform: CookiePlatform, cookie: string): void;
  load(platform: CookiePlatform): string;
}

export function createCookieStore(cookieDir: string): CookieStore {
  if (!fs.existsSync(cookieDir)) {
    fs.mkdirSync(cookieDir, { recursive: true });
  }

  function write(platform: CookiePlatform, cookie: string): void {
    const filePath = path.join(cookieDir, `${platform}.json`);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ cookie, updatedAt: new Date().toISOString() }),
      { encoding: "utf-8", mode: 0o600 }
    );
  }

  return {
    save(platform: CookiePlatform, cookie: string): void {
      write(platform, storesCookieHeader(platform) ? normalizeCookie(cookie) : cookie);
    },

    load(platform: CookiePlatform): string {
      const filePath = path.join(cookieDir, `${platform}.json`);
      if (!fs.existsSync(filePath)) return "";
      let stored: string;
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        stored = data.cookie ?? "";
      } catch {
        return "";
      }
      if (!storesCookieHeader(platform)) return stored;

      const clean = normalizeCookie(stored);
      if (clean === stored) return clean;
      // Repair in place: an existing deployment already has the header blob on
      // disk, and fixing it here means the next request is clean without making
      // anyone scan a QR code again. Best-effort — a read-only volume must not
      // take the bot down, the cleaned value is still returned.
      try {
        write(platform, clean);
      } catch {
        /* keep serving the cleaned in-memory value */
      }
      return clean;
    },
  };
}
