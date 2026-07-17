import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Search-engine hardening for issue #128: searching "TsmusicBot" surfaced a
 * large number of deployed instances' WebUI URLs, letting strangers walk into
 * other people's control pages. The fix is defence in depth — none of these
 * layers is authentication (that's handled elsewhere), they just keep the
 * public URL out of crawler indexes:
 *
 *   1. `X-Robots-Tag: noindex, nofollow` on EVERY response;
 *   2. `GET /robots.txt` → `User-agent: * / Disallow: /`;
 *   3. `<meta name="robots" content="noindex, nofollow">` in web/index.html.
 *
 * The header middleware and the /robots.txt route both live at the top of
 * `createWebServer` in `server.ts`; this test asserts the exact behaviour we
 * expect from them in isolation (the wiring inside server.ts is verified by
 * code review / git diff, matching security-headers.test.ts).
 */
describe("search-engine hardening (issue #128 noindex)", () => {
  function buildApp() {
    const app = express();
    // Mirrors the security-headers middleware in server.ts.
    app.use((_req, res, next) => {
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      next();
    });
    // Mirrors the public /robots.txt route in server.ts.
    app.get("/robots.txt", (_req, res) => {
      res.type("text/plain").send("User-agent: *\nDisallow: /\n");
    });
    app.get("/", (_req, res) => res.json({ ok: true }));
    app.post("/api/session/login", (_req, res) => res.json({ ok: true }));
    return app;
  }

  it("sets X-Robots-Tag: noindex, nofollow on GET responses", async () => {
    const res = await request(buildApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });

  it("sets X-Robots-Tag on POST (API) responses too", async () => {
    const res = await request(buildApp()).post("/api/session/login");
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });

  it("serves /robots.txt disallowing all crawlers", async () => {
    const res = await request(buildApp()).get("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("User-agent: *");
    expect(res.text).toContain("Disallow: /");
  });

  it("still tags the /robots.txt response itself as noindex", async () => {
    const res = await request(buildApp()).get("/robots.txt");
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });
});

describe("frontend robots meta tag (issue #128 noindex)", () => {
  const indexHtmlPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../web/index.html"
  );
  const html = fs.readFileSync(indexHtmlPath, "utf-8");

  const robotsMeta = html.match(
    /<meta\s+name=["']robots["']\s+content=["']([^"']+)["']\s*\/?>/i
  );

  it("declares a robots meta tag", () => {
    expect(robotsMeta).not.toBeNull();
  });

  it("marks the SPA shell noindex, nofollow (covers /bot/<id> dedicated links)", () => {
    expect(robotsMeta?.[1]).toBe("noindex, nofollow");
  });
});
