import fs from "node:fs";
import path from "node:path";
import type { createQqSessionStore } from "./qq-session.js";

/** Platforms with a persisted credential blob. For jellyfin the "cookie" is a
 *  JSON string carrying the access token / userId / deviceId (see jellyfin.ts). */
type CookiePlatform = "netease" | "qq" | "bilibili" | "kugou" | "jellyfin";

export interface CookieStore {
  save(platform: CookiePlatform, cookie: string): void;
  load(platform: CookiePlatform): string;
}

export function createCookieStore(cookieDir: string, qqStore?: ReturnType<typeof createQqSessionStore>): CookieStore {
  if (!fs.existsSync(cookieDir)) {
    fs.mkdirSync(cookieDir, { recursive: true });
  }

  return {
    save(platform: CookiePlatform, cookie: string): void {
      if (platform === "qq" && qqStore) {
        qqStore.save({ cookie });
        return;
      }
      const filePath = path.join(cookieDir, `${platform}.json`);
      fs.writeFileSync(
        filePath,
        JSON.stringify({ cookie, updatedAt: new Date().toISOString() }),
        { encoding: "utf-8", mode: 0o600 }
      );
    },

    load(platform: CookiePlatform): string {
      if (platform === "qq" && qqStore) return qqStore.load()?.cookie ?? "";
      const filePath = path.join(cookieDir, `${platform}.json`);
      if (!fs.existsSync(filePath)) return "";
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return data.cookie ?? "";
      } catch {
        return "";
      }
    },
  };
}
