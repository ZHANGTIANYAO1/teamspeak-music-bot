import { describe, expect, it } from "vitest";
import type { Request } from "express";
import type { BotDatabase, GrantedMusicAccount } from "../../data/database.js";
import type { MusicProvider } from "../../music/provider.js";
import {
  grantedAccountFor,
  perUserMusicEnabled,
  personalCookieFor,
  resolveMusicCookie,
  resolveProviderForRequest,
} from "./provider-scope.js";

/** Minimal provider stand-in: only `platform` and an optional `withCookie` are
 *  consulted by the scope resolver. */
function fakeProvider(opts: {
  platform?: string;
  withCookie?: (cookie: string) => MusicProvider;
} = {}): MusicProvider {
  const p: Partial<MusicProvider> = { platform: (opts.platform ?? "netease") as MusicProvider["platform"] };
  if (opts.withCookie) p.withCookie = opts.withCookie;
  return p as MusicProvider;
}

/**
 * `own` is the member's self-linked cookie, `granted` an admin assignment.
 * Both default to null so a test only states the state it cares about.
 */
function fakeDb(
  own: string | null,
  granted: GrantedMusicAccount | null = null,
  preferShared = false,
): BotDatabase {
  return {
    getUserMusicCookie: () => own,
    getGrantedMusicAccount: () => granted,
    getUserMusicPreference: () =>
      preferShared ? { preferShared: true } : null,
  } as unknown as BotDatabase;
}

function fakeReq(user?: { id: string; role: string }): Request {
  return { user } as unknown as Request;
}

const GRANTED: GrantedMusicAccount = {
  accountId: "acc-1",
  label: "网易云-主号",
  cookie: "MUSIC_U=shared-with-member",
};

describe("provider-scope", () => {
  it("is off unless config explicitly enables it", () => {
    expect(perUserMusicEnabled({})).toBe(false);
    expect(perUserMusicEnabled({ config: {} })).toBe(false);
    expect(perUserMusicEnabled({ config: { perUserMusicAccounts: false } })).toBe(false);
    expect(perUserMusicEnabled({ config: { perUserMusicAccounts: true } })).toBe(true);
  });

  it("returns the shared provider when the feature is off", () => {
    const shared = fakeProvider({ withCookie: () => fakeProvider() });
    const scoped = resolveProviderForRequest(fakeReq({ id: "u1", role: "member" }), "netease", shared, {
      database: fakeDb("MUSIC_U=abc"),
      config: { perUserMusicAccounts: false },
    });
    expect(scoped).toBe(shared);
  });

  it("returns the shared provider for guests even with a linked cookie", () => {
    const shared = fakeProvider({ withCookie: () => fakeProvider() });
    const scoped = resolveProviderForRequest(fakeReq({ id: "g1", role: "guest" }), "netease", shared, {
      database: fakeDb("MUSIC_U=abc"),
      config: { perUserMusicAccounts: true },
    });
    expect(scoped).toBe(shared);
  });

  it("falls back to the shared provider when the user has no linked cookie", () => {
    const shared = fakeProvider({ withCookie: () => fakeProvider() });
    const scoped = resolveProviderForRequest(fakeReq({ id: "u1", role: "member" }), "netease", shared, {
      database: fakeDb(null),
      config: { perUserMusicAccounts: true },
    });
    expect(scoped).toBe(shared);
  });

  it("falls back to the shared provider when the source has no per-account login", () => {
    const shared = fakeProvider({ platform: "local" });
    const scoped = resolveProviderForRequest(fakeReq({ id: "u1", role: "member" }), "local", shared, {
      database: fakeDb("cookie"),
      config: { perUserMusicAccounts: true },
    });
    expect(scoped).toBe(shared);
  });

  it("returns an account-scoped view when enabled, member, and linked", () => {
    const personal = fakeProvider();
    let seen = "";
    const shared = fakeProvider({
      withCookie: (cookie) => {
        seen = cookie;
        return personal;
      },
    });
    const scoped = resolveProviderForRequest(fakeReq({ id: "u1", role: "member" }), "netease", shared, {
      database: fakeDb("MUSIC_U=abc"),
      config: { perUserMusicAccounts: true },
    });
    expect(scoped).toBe(personal);
    expect(seen).toBe("MUSIC_U=abc");
  });

  it("degrades to the shared provider when withCookie throws", () => {
    const shared = fakeProvider({
      withCookie: () => {
        throw new Error("bad cookie");
      },
    });
    const scoped = resolveProviderForRequest(fakeReq({ id: "u1", role: "member" }), "netease", shared, {
      database: fakeDb("broken"),
      config: { perUserMusicAccounts: true },
    });
    expect(scoped).toBe(shared);
  });

  it("treats a blank stored cookie as unlinked", () => {
    expect(
      personalCookieFor(fakeReq({ id: "u1", role: "member" }), "netease", {
        database: fakeDb("   "),
        config: { perUserMusicAccounts: true },
      }),
    ).toBeNull();
  });

  it("ignores requests with no authenticated user", () => {
    const shared = fakeProvider({ withCookie: () => fakeProvider() });
    expect(
      resolveProviderForRequest(undefined, "netease", shared, {
        database: fakeDb("MUSIC_U=abc"),
        config: { perUserMusicAccounts: true },
      }),
    ).toBe(shared);
  });

  // Personal FM shipped before the admin toggle existed (#164). A linked account
  // has always driven it, so `alwaysPersonal` must keep working with the flag off
  // — otherwise turning the feature off would silently regress that release.
  it("still uses the linked account for personal FM while the toggle is off", () => {
    const personal = fakeProvider();
    const shared = fakeProvider({ withCookie: () => personal });
    const scoped = resolveProviderForRequest(
      fakeReq({ id: "u1", role: "member" }),
      "netease",
      shared,
      { database: fakeDb("MUSIC_U=abc"), config: { perUserMusicAccounts: false } },
      { alwaysPersonal: true },
    );
    expect(scoped).toBe(personal);
  });

  it("keeps guests on the shared provider even for personal FM", () => {
    const shared = fakeProvider({ withCookie: () => fakeProvider() });
    const scoped = resolveProviderForRequest(
      fakeReq({ id: "g1", role: "guest" }),
      "netease",
      shared,
      { database: fakeDb("MUSIC_U=abc"), config: { perUserMusicAccounts: true } },
      { alwaysPersonal: true },
    );
    expect(scoped).toBe(shared);
  });

  // ---------------------------------------------------------------------
  // Admin-assigned accounts (#164 follow-up)
  // ---------------------------------------------------------------------
  describe("admin-assigned accounts", () => {
    it("resolves an assigned account when the member linked nothing themselves", () => {
      const assigned = fakeProvider();
      let seen = "";
      const shared = fakeProvider({
        withCookie: (cookie) => {
          seen = cookie;
          return assigned;
        },
      });
      const scoped = resolveProviderForRequest(
        fakeReq({ id: "u1", role: "member" }),
        "netease",
        shared,
        { database: fakeDb(null, GRANTED), config: { perUserMusicAccounts: true } },
      );
      expect(scoped).toBe(assigned);
      expect(seen).toBe(GRANTED.cookie);
    });

    // Own-beats-assigned: linking your own account must never be silently
    // overridden by whatever the admin handed out earlier.
    it("prefers the member's own login over an assigned one", () => {
      const ownView = fakeProvider();
      const grantedView = fakeProvider();
      let seen = "";
      const shared = fakeProvider({
        withCookie: (cookie) => {
          seen = cookie;
          return cookie === "MUSIC_U=own" ? ownView : grantedView;
        },
      });
      const scoped = resolveProviderForRequest(
        fakeReq({ id: "u1", role: "member" }),
        "netease",
        shared,
        { database: fakeDb("MUSIC_U=own", GRANTED), config: { perUserMusicAccounts: true } },
      );
      expect(scoped).toBe(ownView);
      expect(seen).toBe("MUSIC_U=own");
    });

    // An assignment only exists because the admin turned the feature on, so it
    // must stop applying the moment they turn it off — otherwise "disable"
    // would leave members reading the admin's account.
    it("ignores assignments while the toggle is off", () => {
      const shared = fakeProvider({ withCookie: () => fakeProvider() });
      expect(
        grantedAccountFor(fakeReq({ id: "u1", role: "member" }), "netease", {
          database: fakeDb(null, GRANTED),
          config: { perUserMusicAccounts: false },
        }),
      ).toBeNull();
      expect(
        resolveProviderForRequest(fakeReq({ id: "u1", role: "member" }), "netease", shared, {
          database: fakeDb(null, GRANTED),
          config: { perUserMusicAccounts: false },
        }),
      ).toBe(shared);
    });

    it("never hands an assignment to a guest", () => {
      expect(
        grantedAccountFor(fakeReq({ id: "guest", role: "guest" }), "netease", {
          database: fakeDb(null, GRANTED),
          config: { perUserMusicAccounts: true },
        }),
      ).toBeNull();
    });

    it("reports the source and label so the UI can say 由管理员分配", () => {
      const resolved = resolveMusicCookie(
        fakeReq({ id: "u1", role: "member" }),
        "netease",
        { database: fakeDb(null, GRANTED), config: { perUserMusicAccounts: true } },
      );
      expect(resolved).toEqual({
        source: "granted",
        cookie: GRANTED.cookie,
        label: "网易云-主号",
        accountId: "acc-1",
      });
    });

    it("reports source=personal for a self-linked account", () => {
      const resolved = resolveMusicCookie(
        fakeReq({ id: "u1", role: "member" }),
        "netease",
        { database: fakeDb("MUSIC_U=own", GRANTED), config: { perUserMusicAccounts: true } },
      );
      expect(resolved).toEqual({ source: "personal", cookie: "MUSIC_U=own" });
    });

    it("returns null when neither source applies", () => {
      expect(
        resolveMusicCookie(fakeReq({ id: "u1", role: "member" }), "netease", {
          database: fakeDb(null, null),
          config: { perUserMusicAccounts: true },
        }),
      ).toBeNull();
    });

    it("degrades to the shared provider when an assigned cookie is broken", () => {
      const shared = fakeProvider({
        withCookie: () => {
          throw new Error("bad assigned cookie");
        },
      });
      const scoped = resolveProviderForRequest(
        fakeReq({ id: "u1", role: "member" }),
        "netease",
        shared,
        { database: fakeDb(null, GRANTED), config: { perUserMusicAccounts: true } },
      );
      expect(scoped).toBe(shared);
    });

    // Personal FM keeps the #164 guarantee for the member's OWN login; an
    // assignment is not a #164 artefact and must not ride along.
    it("does not use an assignment for personal FM while the toggle is off", () => {
      const shared = fakeProvider({ withCookie: () => fakeProvider() });
      const scoped = resolveProviderForRequest(
        fakeReq({ id: "u1", role: "member" }),
        "netease",
        shared,
        { database: fakeDb(null, GRANTED), config: { perUserMusicAccounts: false } },
        { alwaysPersonal: true },
      );
      expect(scoped).toBe(shared);
    });
  });
});


// ---------------------------------------------------------------------------
// "Play through the shared account" preference
//
// The real case: the member's own NetEase login has no VIP, the admin's does.
// Switching to shared must override BOTH their own link and any assignment —
// it is an explicit instruction, not a fallback.
// ---------------------------------------------------------------------------
describe("provider-scope — shared-account preference", () => {
  it("ignores the member's own cookie when they chose the shared login", () => {
    const resolved = resolveMusicCookie(
      fakeReq({ id: "u1", role: "member" }),
      "netease",
      {
        database: fakeDb("MUSIC_U=mine", null, true),
        config: { perUserMusicAccounts: true },
      },
    );
    expect(resolved).toBeNull();
  });

  it("also overrides an admin assignment", () => {
    const resolved = resolveMusicCookie(
      fakeReq({ id: "u1", role: "member" }),
      "netease",
      {
        database: fakeDb(null, GRANTED, true),
        config: { perUserMusicAccounts: true },
      },
    );
    expect(resolved).toBeNull();
  });

  it("outranks alwaysPersonal, so personal FM follows the choice too", () => {
    const resolved = resolveMusicCookie(
      fakeReq({ id: "u1", role: "member" }),
      "netease",
      {
        database: fakeDb("MUSIC_U=mine", null, true),
        config: { perUserMusicAccounts: true },
      },
      { alwaysPersonal: true },
    );
    expect(resolved).toBeNull();
  });

  it("hands the untouched shared provider back", () => {
    const shared = fakeProvider({ withCookie: () => fakeProvider() });
    const scoped = resolveProviderForRequest(
      fakeReq({ id: "u1", role: "member" }),
      "netease",
      shared,
      {
        database: fakeDb("MUSIC_U=mine", null, true),
        config: { perUserMusicAccounts: true },
      },
    );
    expect(scoped).toBe(shared);
  });

  it("is ignored while the admin has the feature off", () => {
    const shared = fakeProvider({ withCookie: () => fakeProvider() });
    const scoped = resolveProviderForRequest(
      fakeReq({ id: "u1", role: "member" }),
      "netease",
      shared,
      {
        database: fakeDb("MUSIC_U=mine", null, true),
        config: { perUserMusicAccounts: false },
      },
    );
    expect(scoped).toBe(shared);
  });
});

// ---------------------------------------------------------------------------
// Automatic playback fallback
//
// Same scenario, minus an explicit choice: keep the member's own account for
// search / playlists, but when THIS track cannot be resolved on it, try the
// shared login instead of greying the track out.
// ---------------------------------------------------------------------------
describe("provider-scope — playback falls back to the shared login", () => {
  function view(
    getSongUrl: (songId: string, quality?: string) => Promise<{ url: string } | null>,
  ): MusicProvider {
    return { platform: "netease", getSongUrl } as unknown as MusicProvider;
  }

  function scopeWith(
    personal: MusicProvider,
    sharedUrl: () => Promise<{ url: string } | null>,
    options: { fallbackToShared?: boolean } = {},
  ) {
    const shared = view(sharedUrl);
    (shared as Partial<MusicProvider>).withCookie = () => personal;
    return resolveProviderForRequest(
      fakeReq({ id: "u1", role: "member" }),
      "netease",
      shared,
      {
        database: fakeDb("MUSIC_U=mine"),
        config: { perUserMusicAccounts: true },
      },
      options,
    );
  }

  it("uses the shared login when the personal account returns no url", async () => {
    const scoped = scopeWith(view(async () => null), async () => ({ url: "https://shared/x.mp3" }));
    expect((await scoped.getSongUrl("1"))?.url).toBe("https://shared/x.mp3");
  });

  it("uses the shared login when the personal account throws", async () => {
    const scoped = scopeWith(
      view(async () => {
        throw new Error("no membership");
      }),
      async () => ({ url: "https://shared/x.mp3" }),
    );
    expect((await scoped.getSongUrl("1"))?.url).toBe("https://shared/x.mp3");
  });

  it("keeps the personal result when it works", async () => {
    const scoped = scopeWith(
      view(async () => ({ url: "https://mine/x.mp3" })),
      async () => ({ url: "https://shared/x.mp3" }),
    );
    expect((await scoped.getSongUrl("1"))?.url).toBe("https://mine/x.mp3");
  });

  it("can be switched off so playback stays on the member's account", async () => {
    const scoped = scopeWith(
      view(async () => null),
      async () => ({ url: "https://shared/x.mp3" }),
      { fallbackToShared: false },
    );
    expect(await scoped.getSongUrl("1")).toBeNull();
  });

  it("leaves the shared instance itself untouched", async () => {
    const shared = view(async () => ({ url: "https://shared/x.mp3" }));
    (shared as Partial<MusicProvider>).withCookie = () => view(async () => null);
    resolveProviderForRequest(
      fakeReq({ id: "u1", role: "member" }),
      "netease",
      shared,
      { database: fakeDb("MUSIC_U=mine"), config: { perUserMusicAccounts: true } },
    );
    // Calling the shared provider directly must still hit its own implementation.
    expect((await shared.getSongUrl("1"))?.url).toBe("https://shared/x.mp3");
  });
});
