import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { join } from "node:path";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { getDefaultConfig, loadConfig, saveConfig, migrateLegacyConfig, defaultPlatform } from "./config.js";

// Wrap the fs functions config.ts uses in call-through spies so the atomic-write
// and transient-read-error paths can be observed/forced. Everything else (mkdtemp,
// rmSync, existsSync, …) is the real implementation via `...actual`, so all other
// tests keep their real filesystem behavior. `vi.spyOn` can't be used here because
// the node:fs ESM namespace is non-configurable in this setup.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

describe("config", () => {
  const dirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "tsmusicbot-test-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("returns default config when file does not exist", () => {
    const config = loadConfig("/nonexistent/path/config.json");
    expect(config).toEqual(getDefaultConfig());
  });

  it("defaults voice ducking to disabled at 30 percent", () => {
    expect(getDefaultConfig().voiceDucking).toEqual({
      enabled: false,
      volumePercent: 30,
    });
  });

  it("fills voiceDucking defaults for legacy and partial configs", () => {
    const dir = makeTmpDir();
    const legacyPath = join(dir, "legacy.json");
    writeFileSync(legacyPath, JSON.stringify({ webPort: 4000 }));
    expect(loadConfig(legacyPath).voiceDucking).toEqual({
      enabled: false,
      volumePercent: 30,
    });

    const partialPath = join(dir, "partial.json");
    writeFileSync(partialPath, JSON.stringify({ voiceDucking: { enabled: true } }));
    expect(loadConfig(partialPath).voiceDucking).toEqual({
      enabled: true,
      volumePercent: 30,
    });
  });

  it("loadConfig preserves valid voiceDucking values including range endpoints", () => {
    const dir = makeTmpDir();
    for (const volumePercent of [0, 37.5, 100]) {
      const path = join(dir, `voice-ducking-${volumePercent}.json`);
      writeFileSync(
        path,
        JSON.stringify({ voiceDucking: { enabled: true, volumePercent } }),
      );
      expect(loadConfig(path).voiceDucking).toEqual({ enabled: true, volumePercent });
    }
  });

  it("loadConfig strictly sanitizes malformed voiceDucking values", () => {
    const dir = makeTmpDir();
    const malformed: Array<{ name: string; json: string }> = [
      { name: "null-block", json: JSON.stringify({ voiceDucking: null }) },
      { name: "array-block", json: JSON.stringify({ voiceDucking: [true, 10] }) },
      { name: "string-block", json: JSON.stringify({ voiceDucking: "on" }) },
      {
        name: "wrong-types",
        json: JSON.stringify({ voiceDucking: { enabled: "yes", volumePercent: "25" } }),
      },
      {
        name: "below-range",
        json: JSON.stringify({ voiceDucking: { enabled: true, volumePercent: -1 } }),
      },
      {
        name: "above-range",
        json: JSON.stringify({ voiceDucking: { enabled: true, volumePercent: 101 } }),
      },
      // JSON.parse("1e309") produces Infinity, exercising the finite-number guard.
      {
        name: "non-finite",
        json: '{"voiceDucking":{"enabled":true,"volumePercent":1e309}}',
      },
    ];

    for (const testCase of malformed) {
      const path = join(dir, `${testCase.name}.json`);
      writeFileSync(path, testCase.json);
      const loaded = loadConfig(path).voiceDucking;
      if (testCase.name === "below-range" || testCase.name === "above-range" || testCase.name === "non-finite") {
        expect(loaded).toEqual({ enabled: true, volumePercent: 30 });
      } else {
        expect(loaded).toEqual({ enabled: false, volumePercent: 30 });
      }
    }
  });

  it("defaults to the online sources with jellyfin as opt-in (disabled)", () => {
    const config = getDefaultConfig();
    expect(config.enabledProviders).toEqual(["netease", "qq", "bilibili", "youtube", "kugou"]);
    expect(config.enabledProviders).not.toContain("jellyfin");
  });

  it("keeps pre-gating behavior for legacy configs without enabledProviders", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    // A config written before enabledProviders existed: no such field.
    writeFileSync(path, JSON.stringify({ webPort: 4000 }));
    const config = loadConfig(path);
    expect(config.enabledProviders).toEqual(["netease", "qq", "bilibili", "youtube", "kugou"]);
    expect(defaultPlatform(config)).toBe("netease");
  });

  it("defaultPlatform follows the fixed priority order", () => {
    const config = getDefaultConfig();
    expect(defaultPlatform(config)).toBe("netease");

    // Jellyfin ranks after the online music platforms…
    config.enabledProviders = ["netease", "jellyfin"];
    expect(defaultPlatform(config)).toBe("netease");
    // …but ahead of the video sites…
    config.enabledProviders = ["bilibili", "jellyfin", "youtube"];
    expect(defaultPlatform(config)).toBe("jellyfin");
    // …and is the default when it is the only enabled source.
    config.enabledProviders = ["jellyfin"];
    expect(defaultPlatform(config)).toBe("jellyfin");
    // Nothing enabled → netease fallback (the gate then reports it disabled).
    config.enabledProviders = [];
    expect(defaultPlatform(config)).toBe("netease");
  });

  // --- #126: an explicit operator default source ---

  it("defaultPlatform is null by default (follow the priority order)", () => {
    expect(getDefaultConfig().defaultPlatform).toBeNull();
  });

  it("defaultPlatform() honors an explicit, enabled preference over the priority order", () => {
    const config = getDefaultConfig();
    // Priority would pick netease; a Bilibili-loving server sets B站 instead (#126).
    config.defaultPlatform = "bilibili";
    expect(defaultPlatform(config)).toBe("bilibili");
  });

  it("defaultPlatform() ignores a preference whose source is not enabled", () => {
    const config = getDefaultConfig();
    config.defaultPlatform = "jellyfin"; // opt-in, not enabled in the default config
    // Falls back to the fixed priority order (netease)…
    expect(defaultPlatform(config)).toBe("netease");
    // …until the preferred source is actually enabled.
    config.enabledProviders = [...config.enabledProviders, "jellyfin"];
    expect(defaultPlatform(config)).toBe("jellyfin");
  });

  it("loadConfig keeps a valid, enabled defaultPlatform", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ defaultPlatform: "bilibili" }));
    const config = loadConfig(path);
    expect(config.defaultPlatform).toBe("bilibili");
    expect(defaultPlatform(config)).toBe("bilibili");
  });

  it("loadConfig nulls a defaultPlatform that is unknown, disabled, or the wrong type", () => {
    const dir = makeTmpDir();
    // Unknown provider name.
    const p1 = join(dir, "c1.json");
    writeFileSync(p1, JSON.stringify({ defaultPlatform: "bogus" }));
    expect(loadConfig(p1).defaultPlatform).toBeNull();
    // Known provider, but not in enabledProviders.
    const p2 = join(dir, "c2.json");
    writeFileSync(p2, JSON.stringify({ enabledProviders: ["netease"], defaultPlatform: "bilibili" }));
    expect(loadConfig(p2).defaultPlatform).toBeNull();
    // Wrong type.
    const p3 = join(dir, "c3.json");
    writeFileSync(p3, JSON.stringify({ defaultPlatform: 42 }));
    expect(loadConfig(p3).defaultPlatform).toBeNull();
  });

  it("round-trips defaultPlatform through save/load", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    saveConfig(path, { ...getDefaultConfig(), defaultPlatform: "qq" });
    expect(loadConfig(path).defaultPlatform).toBe("qq");
  });

  it("respects an explicit jellyfin-only enabledProviders from disk", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    // e.g. a config persisted by the short-lived jellyfin-by-default builds.
    writeFileSync(path, JSON.stringify({ enabledProviders: ["jellyfin"] }));
    const config = loadConfig(path);
    expect(config.enabledProviders).toEqual(["jellyfin"]);
    expect(defaultPlatform(config)).toBe("jellyfin");
  });

  // ── audioQuality persistence (#125) ─────────────────────────────────────
  it("defaults audioQuality to each provider's in-memory default", () => {
    const config = getDefaultConfig();
    expect(config.audioQuality).toEqual({
      netease: "exhigh",
      qq: "exhigh",
      bilibili: "high",
      kugou: "128",
      jellyfin: "direct",
    });
  });

  it("fills audioQuality defaults for a legacy config without the field", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ webPort: 4000 }));
    const config = loadConfig(path);
    expect(config.audioQuality).toEqual(getDefaultConfig().audioQuality);
  });

  it("round-trips a saved audioQuality through save/load", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    const config = getDefaultConfig();
    config.audioQuality = {
      netease: "lossless",
      qq: "flac",
      bilibili: "high",
      kugou: "flac",
      jellyfin: "320",
    };
    saveConfig(path, config);
    const loaded = loadConfig(path);
    expect(loaded.audioQuality).toEqual(config.audioQuality);
  });

  it("coerces missing / non-string audioQuality fields to defaults", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    // netease valid, qq blank, bilibili wrong type, kugou missing, jellyfin valid.
    writeFileSync(
      path,
      JSON.stringify({ audioQuality: { netease: "lossless", qq: "  ", bilibili: 320, jellyfin: "192" } }),
    );
    const config = loadConfig(path);
    expect(config.audioQuality).toEqual({
      netease: "lossless",
      qq: "exhigh", // blank → default
      bilibili: "high", // non-string → default
      kugou: "128", // missing → default
      jellyfin: "192",
    });
  });

  it("creates config file on save", () => {
    const dir = makeTmpDir();
    const path = join(dir, "sub", "config.json");
    const config = getDefaultConfig();
    saveConfig(path, config);

    const loaded = loadConfig(path);
    expect(loaded).toEqual(config);
  });

  it("merges partial config with defaults", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");

    // Save a partial config by writing only some fields
    const partial = { webPort: 8080, locale: "en" };
    writeFileSync(path, JSON.stringify(partial), "utf-8");

    const loaded = loadConfig(path);
    expect(loaded.webPort).toBe(8080);
    expect(loaded.locale).toBe("en");
    // defaults should fill in the rest
    expect(loaded.theme).toBe("dark");
    expect(loaded.commandPrefix).toBe("!");
    // auto-pause defaults OFF (occupancy detection is unreliable on some servers)
    expect(loaded.autoPauseOnEmpty).toBe(false);
  });

  // --- #86: config.json must live under (and be created in) the persisted data dir ---

  it("first run writes config.json into the data dir and reads it back", () => {
    const root = makeTmpDir();
    const dataDir = join(root, "data");
    const configPath = join(dataDir, "config.json"); // mirrors index.ts CONFIG_PATH

    // Boot sequence: load (missing -> defaults) then save.
    const config = loadConfig(configPath);
    saveConfig(configPath, config);

    expect(existsSync(configPath)).toBe(true);
    // A subsequent hand-edited file under the SAME persisted path is honored.
    writeFileSync(configPath, JSON.stringify({ webPort: 9999 }), "utf-8");
    expect(loadConfig(configPath).webPort).toBe(9999);
  });

  it("migrates a legacy root config into the data dir, preserving values", () => {
    const root = makeTmpDir();
    const legacyPath = join(root, "config.json");
    const newPath = join(root, "data", "config.json");
    writeFileSync(legacyPath, JSON.stringify({ webPort: 4242, publicUrl: "http://x" }), "utf-8");

    const migrated = migrateLegacyConfig(legacyPath, newPath);

    expect(migrated).toBe(true);
    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(legacyPath)).toBe(false); // legacy moved, not duplicated
    const loaded = loadConfig(newPath);
    expect(loaded.webPort).toBe(4242);
    expect(loaded.publicUrl).toBe("http://x");
  });

  it("does NOT overwrite an existing data-dir config during migration", () => {
    const root = makeTmpDir();
    const legacyPath = join(root, "config.json");
    const newPath = join(root, "data", "config.json");
    writeFileSync(legacyPath, JSON.stringify({ webPort: 1111 }), "utf-8");
    saveConfig(newPath, { ...getDefaultConfig(), webPort: 2222 });

    const migrated = migrateLegacyConfig(legacyPath, newPath);

    expect(migrated).toBe(false); // new location wins, untouched
    expect(loadConfig(newPath).webPort).toBe(2222);
    expect(existsSync(legacyPath)).toBe(true); // legacy left intact when not migrated
  });

  it("migration is a no-op when there is no legacy config", () => {
    const root = makeTmpDir();
    const migrated = migrateLegacyConfig(join(root, "config.json"), join(root, "data", "config.json"));
    expect(migrated).toBe(false);
  });
});

describe("guestMode config", () => {
  it("defaults to disabled, all-bots, append-only", () => {
    const c = getDefaultConfig();
    expect(c.guestMode.enabled).toBe(false);
    expect(c.guestMode.bots).toBe("all");
    expect(c.guestMode.permissions).toEqual({
      addToQueue: true, playNext: false, playNow: false,
      skip: false, transport: false, removeClear: false, playMode: false,
      playCollection: false,
    });
  });

  it("deep-merges a partial guestMode so missing sub-keys are back-filled", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsmb-cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ guestMode: { enabled: true, permissions: { playNext: true } } }));
    const c = loadConfig(p);
    expect(c.guestMode.enabled).toBe(true);
    expect(c.guestMode.bots).toBe("all"); // back-filled
    expect(c.guestMode.permissions.playNext).toBe(true);
    expect(c.guestMode.permissions.addToQueue).toBe(true); // back-filled default
    expect(c.guestMode.permissions.skip).toBe(false); // back-filled default
    rmSync(dir, { recursive: true, force: true });
  });

  // --- B1: loadConfig must sanitize a hand-edited/legacy/corrupt guestMode ---

  function loadGuestMode(raw: unknown) {
    const dir = mkdtempSync(join(tmpdir(), "tsmb-cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify(raw));
    try {
      return loadConfig(p).guestMode;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  describe("bots normalization", () => {
    it("a numeric bots value falls back to the default \"all\" (no crash)", () => {
      const gm = loadGuestMode({ guestMode: { bots: 5 } });
      expect(gm.bots).toBe("all");
    });
    it("an array bots value is filtered to strings only", () => {
      const gm = loadGuestMode({ guestMode: { bots: ["a", 2, "b"] } });
      expect(gm.bots).toEqual(["a", "b"]);
    });
    it("the literal \"all\" is preserved", () => {
      const gm = loadGuestMode({ guestMode: { bots: "all" } });
      expect(gm.bots).toBe("all");
    });
  });

  describe("permissions coercion", () => {
    it("a non-boolean truthy flag is coerced to false; a real true stays true", () => {
      const gm = loadGuestMode({ guestMode: { permissions: { skip: 1, playNext: true } } });
      expect(gm.permissions.skip).toBe(false);
      expect(gm.permissions.playNext).toBe(true);
    });
    it("a string permissions value yields defaults with no numeric index keys", () => {
      const gm = loadGuestMode({ guestMode: { permissions: "hacked" } });
      // all known flags present at their defaults
      expect(gm.permissions).toEqual({
        addToQueue: true, playNext: false, playNow: false,
        skip: false, transport: false, removeClear: false, playMode: false,
        playCollection: false,
      });
      // no garbage index keys leaked from spreading a string
      expect((gm.permissions as unknown as Record<string, unknown>)["0"]).toBeUndefined();
    });
  });
});

describe("adminGroups normalization", () => {
  function loadAdminGroups(raw: unknown) {
    const dir = mkdtempSync(join(tmpdir(), "tsmb-cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify(raw));
    try {
      return loadConfig(p).adminGroups;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("defaults to [] when absent", () => {
    expect(loadAdminGroups({})).toEqual([]);
  });
  it("keeps valid non-negative integers", () => {
    expect(loadAdminGroups({ adminGroups: [6, 8] })).toEqual([6, 8]);
  });
  it("filters out negatives, non-integers and non-numbers", () => {
    expect(loadAdminGroups({ adminGroups: [6, -1, 2.5, "8", null] })).toEqual([6]);
  });
  it("a non-array value falls back to the default [] (no crash)", () => {
    expect(loadAdminGroups({ adminGroups: "6" })).toEqual([]);
  });
});

describe("spotify config", () => {
  it("defaults are present and disabled", () => {
    const c = getDefaultConfig();
    expect(c.spotify).toEqual({
      enabled: false,
      backend: "auto",
      clientId: "",
      clientSecret: "",
      deviceName: "TSMusicBot",
      bitrate: 320,
    });
  });

  it("loadConfig coerces bad spotify values back to safe defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(
      p,
      JSON.stringify({
        spotify: { enabled: "yes", backend: "bogus", bitrate: 7, clientId: 5 },
      })
    );
    const c = loadConfig(p);
    expect(c.spotify.enabled).toBe(false); // non-boolean → false
    expect(c.spotify.backend).toBe("auto"); // invalid enum → auto
    expect(c.spotify.bitrate).toBe(320); // invalid → 320
    expect(c.spotify.clientId).toBe(""); // non-string → ""
    expect(c.spotify.deviceName).toBe("TSMusicBot"); // missing → default
  });

  it("loadConfig preserves valid spotify values", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(
      p,
      JSON.stringify({
        spotify: {
          enabled: true,
          backend: "librespot",
          clientId: "abc",
          clientSecret: "def",
          deviceName: "MyBot",
          bitrate: 160,
        },
      })
    );
    const c = loadConfig(p);
    expect(c.spotify).toEqual({
      enabled: true,
      backend: "librespot",
      clientId: "abc",
      clientSecret: "def",
      deviceName: "MyBot",
      bitrate: 160,
    });
  });
});

// --- R2-1: saveConfig must write atomically (temp file + rename), never truncate ---

describe("saveConfig atomic write", () => {
  const dirs: string[] = [];
  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "tsmb-atomic-"));
    dirs.push(dir);
    return dir;
  }
  beforeEach(() => {
    vi.clearAllMocks(); // reset call history, keep the call-through implementations
  });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("round-trips (save then load equals) and leaves NO .tmp file behind", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    const config = { ...getDefaultConfig(), webPort: 4567, adminPassword: "pw" };

    saveConfig(path, config);

    expect(loadConfig(path)).toEqual(config);
    // No temp remnants in the target directory.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("writes via a same-dir temp file then renameSync onto the final path", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");

    saveConfig(path, getDefaultConfig());

    expect(vi.mocked(renameSync)).toHaveBeenCalled();
    const [from, to] = vi.mocked(renameSync).mock.calls[0] as [string, string];
    expect(to).toBe(path); // renamed ONTO the real path
    expect(String(from)).not.toBe(path); // ...from a distinct temp file
    expect(join(String(from), "..")).toBe(join(path, "..")); // ...in the SAME directory
  });

  it("does not corrupt a pre-existing valid config when saving over it", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    saveConfig(path, { ...getDefaultConfig(), adminPassword: "first", webPort: 1234 });

    // Overwrite with a different, fully-formed config.
    saveConfig(path, { ...getDefaultConfig(), adminPassword: "second", webPort: 9999 });

    const loaded = loadConfig(path);
    expect(loaded.adminPassword).toBe("second");
    expect(loaded.webPort).toBe(9999);
    // The on-disk file is a single complete JSON document (no partial/truncated write).
    expect(() => JSON.parse(readFileSync(path, "utf-8"))).not.toThrow();
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("cleans up the temp file (no .tmp remnant) when the rename fails", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("rename boom");
    });

    expect(() => saveConfig(path, getDefaultConfig())).toThrow(/rename boom/);
    // The failed write left no temp file lying around.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});

// --- R2-2: loadConfig must not treat a transient/corrupt read as "missing" ---

describe("loadConfig error handling", () => {
  const dirs: string[] = [];
  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "tsmb-load-"));
    dirs.push(dir);
    return dir;
  }
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("(a) ENOENT (missing file) returns defaults — unchanged first-run behavior", () => {
    const dir = makeTmpDir();
    expect(loadConfig(join(dir, "config.json"))).toEqual(getDefaultConfig());
  });

  it("(b) a non-ENOENT read error (EBUSY) rethrows instead of returning defaults", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    // A REAL config exists on disk; a transient lock must NOT collapse to defaults
    // (the caller would otherwise overwrite this real config with defaults).
    saveConfig(path, { ...getDefaultConfig(), adminPassword: "keep-me" });
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      const err = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException;
      err.code = "EBUSY";
      throw err;
    });

    expect(() => loadConfig(path)).toThrow(/EBUSY/);
    // The on-disk config is untouched and still readable once the lock clears.
    expect(loadConfig(path).adminPassword).toBe("keep-me");
  });

  it("(c) corrupt JSON returns defaults AND backs up the original to *.corrupt-*", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    const garbage = "{ not: valid json, ";
    writeFileSync(path, garbage, "utf-8");

    const loaded = loadConfig(path);

    expect(loaded).toEqual(getDefaultConfig());
    const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    expect(backups.length).toBeGreaterThan(0);
    // The corrupt original is preserved verbatim (recoverable, never deleted).
    expect(readFileSync(join(dir, backups[0]), "utf-8")).toBe(garbage);
  });

  // (d)/(e) Valid JSON that is NOT a non-null object (null / [] / 42 / "str") passes
  // JSON.parse but would throw a raw TypeError in the per-field sanitize block
  // (property access on a non-object), bypassing the corrupt-backup path. It must be
  // treated EXACTLY like corrupt JSON: back up to *.corrupt-* (original preserved),
  // return defaults — NOT a thrown TypeError, and NOT a silent defaults-with-no-backup.
  it("(d) a `null` config is treated as corrupt: defaults + *.corrupt-* backup (original preserved)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    writeFileSync(path, "null", "utf-8");

    let loaded: ReturnType<typeof getDefaultConfig>;
    expect(() => {
      loaded = loadConfig(path);
    }).not.toThrow();

    expect(loaded!).toEqual(getDefaultConfig());
    const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    expect(backups.length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, backups[0]), "utf-8")).toBe("null");
  });

  it("(e) a non-object config (`[]` / `42`) is backed up + defaults, not a thrown TypeError", () => {
    for (const content of ["[]", "42"]) {
      const dir = makeTmpDir();
      const path = join(dir, "config.json");
      writeFileSync(path, content, "utf-8");

      let loaded: ReturnType<typeof getDefaultConfig>;
      expect(() => {
        loaded = loadConfig(path);
      }).not.toThrow();

      expect(loaded!).toEqual(getDefaultConfig());
      const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
      expect(backups.length).toBeGreaterThan(0);
      expect(readFileSync(join(dir, backups[0]), "utf-8")).toBe(content);
    }
  });

  it("defaults savedQueuesEnabled and playKeepsQueue to false", () => {
    const c = getDefaultConfig();
    expect(c.savedQueuesEnabled).toBe(false);
    expect(c.playKeepsQueue).toBe(false);
  });

  it("coerces non-boolean savedQueues/playKeepsQueue values to false on load", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ savedQueuesEnabled: "yes", playKeepsQueue: 1 }));
    const c = loadConfig(path);
    expect(c.savedQueuesEnabled).toBe(false);
    expect(c.playKeepsQueue).toBe(false);
  });

  it("preserves savedQueues/playKeepsQueue true when explicitly enabled", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ savedQueuesEnabled: true, playKeepsQueue: true }));
    const c = loadConfig(path);
    expect(c.savedQueuesEnabled).toBe(true);
    expect(c.playKeepsQueue).toBe(true);
  });
});
