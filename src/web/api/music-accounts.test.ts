import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createDatabase } from "../../data/database.js";
import { createUserStore } from "../../data/users.js";
import { createMusicAccountsRouter } from "./music-accounts.js";

function mount(opts: { cookieStore?: { save: any; load: any }; providers?: Record<string, any> } = {}) {
  const db = createDatabase(":memory:");
  const insert = db.db.prepare(
    "INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES (?,?,?,?,?,?)",
  );
  insert.run("u1", "alice", "x", 0, 0, "member");
  insert.run("u2", "bob", "x", 0, 0, "member");
  insert.run("u3", "carol", "x", 0, 0, "member");
  insert.run("u4", "root2", "x", 0, 0, "admin");

  const users = createUserStore(db.db);
  const providers = opts.providers ?? {
    netease: {
      platform: "netease",
      withCookie: vi.fn(() => ({ getAuthStatus: async () => ({ loggedIn: true, nickname: "主号" }) })),
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: "admin", username: "admin", role: "admin" };
    next();
  });
  app.use(
    "/api/music-accounts",
    createMusicAccountsRouter(db, users, providers as any, pino({ level: "silent" }), opts.cookieStore as any),
  );
  return { app, db, providers };
}

const SECRET = "MUSIC_U=abcdefghijklmnopqrstuvwxyz0123456789";

async function seed(app: express.Express, over: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/music-accounts")
    .send({ platform: "netease", label: "主号", cookie: SECRET, ...over });
  return res;
}

describe("admin music account pool", () => {
  it("creates an account and never echoes the cookie", async () => {
    const { app } = mount();
    const res = await seed(app);
    expect(res.status).toBe(201);
    expect(res.body.label).toBe("主号");
    expect(res.body.capacity).toBe(0);
    expect(res.body.enabled).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body.cookiePreview).toContain("…");
  });

  it("rejects an unknown platform and a missing cookie", async () => {
    const { app } = mount();
    expect((await seed(app, { platform: "deezer" })).status).toBe(400);
    expect((await seed(app, { cookie: "" })).status).toBe(400);
    expect((await seed(app, { label: "" })).status).toBe(400);
  });

  it("lists accounts with their holders and the assignable users", async () => {
    const { app } = mount();
    const created = await seed(app);
    await request(app).post(`/api/music-accounts/${created.body.id}/assign`).send({ userId: "u1" });

    const res = await request(app).get("/api/music-accounts");
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].granteeCount).toBe(1);
    expect(res.body.accounts[0].grantees[0]).toMatchObject({ userId: "u1", username: "alice" });
    // Guests are excluded from the dropdown by UserStore.listUsers().
    expect(res.body.users.map((u: any) => u.username)).toEqual(["alice", "bob", "carol", "root2"]);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it("toggles enabled and capacity", async () => {
    const { app } = mount();
    const created = await seed(app);
    const res = await request(app)
      .patch(`/api/music-accounts/${created.body.id}`)
      .send({ enabled: false, capacity: 1, label: "备用" });
    expect(res.body).toEqual(expect.objectContaining({ enabled: false, capacity: 1, label: "备用" }));
  });

  it("enforces exclusive capacity (capacity = 1)", async () => {
    const { app } = mount();
    const created = await seed(app, { capacity: 1 });
    const id = created.body.id;

    expect((await request(app).post(`/api/music-accounts/${id}/assign`).send({ userId: "u1" })).status).toBe(200);
    const second = await request(app).post(`/api/music-accounts/${id}/assign`).send({ userId: "u2" });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("account_exclusive");
    expect(second.body.holders).toEqual([{ userId: "u1", username: "alice" }]);

    // Re-assigning the SAME user is idempotent, not a conflict.
    expect((await request(app).post(`/api/music-accounts/${id}/assign`).send({ userId: "u1" })).status).toBe(200);
  });

  it("enforces a numeric capacity", async () => {
    const { app } = mount();
    const created = await seed(app, { capacity: 2 });
    const id = created.body.id;
    expect((await request(app).post(`/api/music-accounts/${id}/assign`).send({ userId: "u1" })).status).toBe(200);
    expect((await request(app).post(`/api/music-accounts/${id}/assign`).send({ userId: "u2" })).status).toBe(200);
    const third = await request(app).post(`/api/music-accounts/${id}/assign`).send({ userId: "u3" });
    expect(third.status).toBe(409);
    expect(third.body.error).toBe("account_full");
  });

  it("allows unlimited grantees when capacity is 0", async () => {
    const { app } = mount();
    const created = await seed(app);
    for (const userId of ["u1", "u2", "u3", "u4"]) {
      expect(
        (await request(app).post(`/api/music-accounts/${created.body.id}/assign`).send({ userId })).status,
      ).toBe(200);
    }
    // An admin can be a grantee too — "assigning an admin out" is allowed.
    const list = await request(app).get("/api/music-accounts");
    expect(list.body.accounts[0].grantees.map((g: any) => g.username).sort()).toEqual([
      "alice", "bob", "carol", "root2",
    ]);
  });

  it("refuses an assignment to a missing user", async () => {
    const { app } = mount();
    const created = await seed(app);
    expect(
      (await request(app).post(`/api/music-accounts/${created.body.id}/assign`).send({ userId: "nope" })).status,
    ).toBe(404);
  });

  it("refuses an assignment from a disabled account", async () => {
    const { app } = mount();
    const created = await seed(app, { enabled: false });
    const res = await request(app)
      .post(`/api/music-accounts/${created.body.id}/assign`)
      .send({ userId: "u1" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("account_disabled");
  });

  it("replaces the previous assignment for the same platform", async () => {
    const { app, db } = mount();
    const first = await seed(app, { label: "一号" });
    const second = await seed(app, { label: "二号" });
    await request(app).post(`/api/music-accounts/${first.body.id}/assign`).send({ userId: "u1" });
    const res = await request(app)
      .post(`/api/music-accounts/${second.body.id}/assign`)
      .send({ userId: "u1" });
    expect(res.body.replacedAccountId).toBe(first.body.id);

    // PK (userId, platform) keeps it to one assigned login per platform.
    const grants = db.listAllMusicAccountGrants().filter((g) => g.userId === "u1");
    expect(grants).toHaveLength(1);
    expect(grants[0].accountId).toBe(second.body.id);
  });

  it("revokes a single assignment", async () => {
    const { app, db } = mount();
    const created = await seed(app);
    await request(app).post(`/api/music-accounts/${created.body.id}/assign`).send({ userId: "u1" });
    const res = await request(app).delete(`/api/music-accounts/${created.body.id}/assign/u1`);
    expect(res.body).toEqual({ ok: true, removed: true });
    expect(db.getGrantedMusicAccount("u1", "netease")).toBeNull();
  });

  // Deleting the account must not leave grants pointing at a dead row.
  it("cascades grantees when the account is deleted", async () => {
    const { app, db } = mount();
    const created = await seed(app);
    await request(app).post(`/api/music-accounts/${created.body.id}/assign`).send({ userId: "u1" });
    expect((await request(app).delete(`/api/music-accounts/${created.body.id}`)).status).toBe(200);
    expect(db.listMusicAccounts()).toHaveLength(0);
    expect(db.getGrantedMusicAccount("u1", "netease")).toBeNull();
  });

  it("probes the login and reports unsupported platforms", async () => {
    const { app } = mount();
    const created = await seed(app);
    const ok = await request(app).post(`/api/music-accounts/${created.body.id}/probe`);
    expect(ok.body).toEqual({ ok: true, loggedIn: true, nickname: "主号" });

    // kugou without a withCookie implementation → 501, not a crash.
    const kugou = await seed(app, { platform: "kugou", label: "酷狗" });
    expect(kugou.status).toBe(201);
    expect((await request(app).post(`/api/music-accounts/${kugou.body.id}/probe`)).status).toBe(501);
  });

  it("imports the shared login into the pool", async () => {
    const cookieStore = {
      save: vi.fn(),
      load: vi.fn(() => "MUSIC_U=shared"),
    };
    const { app } = mount({ cookieStore });
    const res = await request(app)
      .post("/api/music-accounts/import-shared")
      .send({ platform: "netease", label: "从共享导入" });
    expect(res.status).toBe(201);
    expect(res.body.label).toBe("从共享导入");
    expect(cookieStore.load).toHaveBeenCalledWith("netease");
  });

  it("409s import-shared when the bot has no shared login", async () => {
    const cookieStore = { save: vi.fn(), load: vi.fn(() => "") };
    const { app } = mount({ cookieStore });
    const res = await request(app)
      .post("/api/music-accounts/import-shared")
      .send({ platform: "netease" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_shared_login");
  });
});
