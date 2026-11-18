import { readFileSync } from "node:fs";

function loadAppVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    if (typeof manifest.version === "string" && manifest.version.trim()) {
      return manifest.version.trim();
    }
  } catch {
    // A custom bundle may omit the package manifest.
  }
  return "unknown";
}

export const APP_VERSION = loadAppVersion();
