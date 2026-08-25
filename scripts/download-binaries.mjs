#!/usr/bin/env node

/**
 * Verify / download / repair the native binaries used by TSMusicBot
 * (ffmpeg-static + @discordjs/opus + better-sqlite3), preferring the
 * npmmirror CDN so China users never have to reach GitHub.
 *
 * Called by setup.bat / setup.sh after `npm install --ignore-scripts`.
 *
 * WHY THIS IS NOT JUST A DOWNLOADER
 * ---------------------------------
 * A compiled addon only loads into the exact Node ABI it was built for
 * (process.versions.modules: Node 20 = 115, Node 22 = 127, Node 24 = 137).
 * better-sqlite3 stores its addon at an ABI-agnostic path
 * (build/Release/better_sqlite3.node), so a "file exists and is big enough"
 * check happily keeps a binary built for a *different* Node major around and
 * the bot then dies with `NODE_MODULE_VERSION 137 ... requires 127`.
 * So we validate by actually LOADING each package — in a short-lived child
 * process, because on Windows a loaded .node stays mapped and the OS then
 * refuses to delete or overwrite it.
 *
 * Every repair is staged and swapped in atomically: if a download fails we put
 * the previous file back, so a failed run can never leave the install in a
 * worse state than it started.
 *
 * Usage: node scripts/download-binaries.mjs [cdn_base_url]
 * Env:   TSMB_BINARY_LOG_STDOUT=1  also echo progress to stdout
 *        (setup.bat uses this to show progress live on stderr while stdout
 *         is redirected into setup.log)
 */

import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { get } from "node:https";
import { Readable } from "node:stream";
import { execFileSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createLineWriter } from "./lib/console-log.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = join(ROOT, "node_modules");
const BACKUP_DIR = join(NODE_MODULES, ".tsmusicbot-backup");
const STAMP_FILE = join(NODE_MODULES, ".tsmusicbot-abi");

const CDN = process.argv[2] || "https://cdn.npmmirror.com/binaries";
const PLATFORM = process.platform;
const ARCH = process.arch;
const NODE_ABI = process.versions.modules;
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
/** The newest Node major this project is regularly tested against, and the one
 *  every required addon currently ships a prebuild for. Keep in sync with
 *  TESTED_NODE_MAJOR in scripts/setup.bat. */
const TESTED_NODE_MAJOR = 22;

/** Modules the bot cannot start without. ffmpeg-static is optional: a system
 *  ffmpeg on PATH is a documented fallback, so it only ever produces a WARN. */
const REQUIRED = new Set(["@discordjs/opus", "better-sqlite3"]);

/** ffmpeg-static ships ~40-90 MB depending on platform; anything under this is
 *  certainly a truncated download, not a real build. */
const FFMPEG_MIN_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

// Progress goes to stderr so setup.bat can show it live while stdout is being
// appended to setup.log. TSMB_BINARY_LOG_STDOUT=1 mirrors it into stdout so the
// log keeps the full transcript too.
const ECHO_STDOUT = process.env.TSMB_BINARY_LOG_STDOUT === "1";

// Both writers swallow a failed write instead of letting it become an uncaught
// 'error' event: a console that cannot print the Chinese half of a line (issue
// #152) must not be able to abort a whole setup run. The two streams degrade
// independently, so setup.log keeps the full bilingual transcript either way.
const writeErr = createLineWriter(process.stderr);
const writeOut = createLineWriter(process.stdout);

function log(msg) {
  const line = msg === "" ? "" : `  [binary] ${msg}`;
  writeErr(line);
  if (ECHO_STDOUT) writeOut(line);
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function sizeOf(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function humanSize(filePath) {
  const bytes = sizeOf(filePath);
  if (!bytes) return "unknown size";
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;
}

function ensureExecutable(filePath) {
  if (PLATFORM === "win32") return;
  try {
    chmodSync(filePath, 0o755);
  } catch {
    /* best effort */
  }
}

/** Read the version actually present in node_modules (never hardcode it: the
 *  lockfile can be far ahead of whatever version this script was written for,
 *  and a wrong version means a 404 on the CDN). */
function readInstalledVersion(spec) {
  try {
    const pkgJson = join(NODE_MODULES, ...spec.split("/"), "package.json");
    const version = JSON.parse(readFileSync(pkgJson, "utf8")).version;
    return typeof version === "string" && version ? version : null;
  } catch {
    return null;
  }
}

function summarizeError(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const interesting = lines.find((l) => /NODE_MODULE_VERSION|Error:|error:/.test(l));
  return (interesting || lines[0] || "unknown error").slice(0, 300);
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: 120000 }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirects >= 5) {
          reject(new Error(`too many redirects: ${url}`));
          return;
        }
        resolve(download(new URL(headers.location, url).toString(), redirects + 1));
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${statusCode}: ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`timeout: ${url}`));
    });
  });
}

let tarModule = null;

/** `tar` is not a declared dependency — it only resolves transitively through
 *  prebuild-install / @discordjs/node-pre-gyp. Fail with a sentence a user can
 *  act on instead of a raw MODULE_NOT_FOUND stack. */
function loadTar() {
  if (tarModule) return tarModule;
  try {
    tarModule = createRequire(import.meta.url)("tar");
  } catch {
    throw new Error(
      "'tar' module not available / 找不到 tar 模块 — run `npm install tar` in the project root and retry",
    );
  }
  return tarModule;
}

async function extractTarGz(buf, cwd) {
  const tar = loadTar();
  const tmpFile = join(tmpdir(), `tsmb-${process.pid}-${Date.now()}.tar.gz`);
  writeFileSync(tmpFile, buf);
  try {
    await tar.extract({ cwd, file: tmpFile });
  } finally {
    try {
      rmSync(tmpFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// load probe (the whole point of this rewrite)
// ---------------------------------------------------------------------------

/**
 * The snippet that actually forces each package's addon to be dlopen()ed.
 * NOTE: better-sqlite3 loads its .node lazily, inside the Database constructor
 * (lib/database.js: `DEFAULT_ADDON || (DEFAULT_ADDON = require('bindings')(...))`),
 * so a bare `require('better-sqlite3')` succeeds even against a wrong-ABI binary.
 * Opening an in-memory database is the cheapest way to really load it.
 */
const PROBE_EXPR = {
  "@discordjs/opus": "require('@discordjs/opus')",
  "better-sqlite3": "new (require('better-sqlite3'))(':memory:').close()",
};

/**
 * Try to load a package in a throwaway child process.
 * Child process on purpose: loading an addon here would keep the DLL mapped and
 * Windows would then refuse to rename/delete the file we are about to replace.
 */
function probeRequire(spec) {
  const expr = PROBE_EXPR[spec] || `require(${JSON.stringify(spec)})`;
  try {
    execFileSync(process.execPath, ["-e", expr], {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 120000,
      windowsHide: true,
    });
    return { ok: true };
  } catch (err) {
    const text = [err.stderr && err.stderr.toString(), err.message].filter(Boolean).join("\n");
    // "...compiled against ... NODE_MODULE_VERSION 137. This version of Node.js
    //  requires NODE_MODULE_VERSION 127..."  -> first number is what it was built for.
    const abis = [...text.matchAll(/NODE_MODULE_VERSION (\d+)/g)].map((m) => m[1]);
    return {
      ok: false,
      abiMismatch: abis.length >= 2,
      compiledAbi: abis.length >= 2 ? abis[0] : null,
      error: summarizeError(text),
    };
  }
}

function describeProbe(probe) {
  if (probe.abiMismatch) {
    return `built for Node ABI ${probe.compiledAbi}, but this Node needs ABI ${NODE_ABI}`;
  }
  return probe.error;
}

function probeFfmpegBinary(bin) {
  try {
    const out = execFileSync(bin, ["-version"], {
      stdio: "pipe",
      timeout: 30000,
      windowsHide: true,
    }).toString();
    return { ok: true, version: (out.split(/\r?\n/)[0] || "").slice(0, 60) };
  } catch (err) {
    const text = [err.stderr && err.stderr.toString(), err.message].filter(Boolean).join("\n");
    return { ok: false, error: summarizeError(text) };
  }
}

// ---------------------------------------------------------------------------
// atomic swap helpers
// ---------------------------------------------------------------------------

let stashCounter = 0;

/**
 * Move `target` (file or directory) out of the way into node_modules/.tsmusicbot-backup.
 * Same volume as node_modules, so the rename is atomic, and outside the package's
 * build/ tree so that `npm rebuild` / `node-gyp clean` cannot wipe the backup.
 * Returns { commit, restore } — call exactly one of them.
 */
/** Windows likes to hold a brief lock on a freshly written .node (antivirus,
 *  indexer), and rmSync does not retry by default. */
const RM_OPTS = { recursive: true, force: true, maxRetries: 5, retryDelay: 150 };

function stash(target) {
  if (!existsSync(target)) {
    return { commit() {}, restore() {} };
  }
  mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = join(BACKUP_DIR, `${basename(target)}.${process.pid}.${stashCounter++}.bak`);
  rmSync(backup, RM_OPTS);
  renameSync(target, backup);
  // The backup filename alone cannot say where the artifact came from, and a
  // run that is killed (Ctrl+C during a slow download) never reaches commit or
  // restore. Record the target so the next run can put it back — see
  // recoverOrphanedBackups().
  const manifest = `${backup}.json`;
  try {
    writeFileSync(manifest, `${JSON.stringify({ target })}\n`);
  } catch {
    /* recovery is best-effort; the swap itself still works */
  }

  let settled = false;
  const dropManifest = () => {
    try {
      rmSync(manifest, RM_OPTS);
    } catch {
      /* ignore */
    }
  };
  return {
    commit() {
      if (settled) return;
      settled = true;
      try {
        rmSync(backup, RM_OPTS);
      } catch {
        /* leftover backup is harmless */
      }
      dropManifest();
    },
    restore() {
      if (settled) return;
      settled = true;
      try {
        rmSync(target, RM_OPTS);
        mkdirSync(dirname(target), { recursive: true });
        renameSync(backup, target);
        dropManifest();
        log(`restored the previous ${basename(target)} — nothing was made worse`);
      } catch (err) {
        // Leave the backup AND its manifest in place: recoverOrphanedBackups()
        // on the next run is the second chance.
        log(`WARN: could not restore ${target} from ${backup}: ${err.message}`);
        log(`WARN: the previous file is still at ${backup} — the next run will try again`);
      }
    },
  };
}

/**
 * Put back anything a previous run stashed but never restored — a run killed
 * mid-download, or one whose restore() itself failed. Only acts when the target
 * is currently absent, so it can never clobber a good binary.
 */
function recoverOrphanedBackups() {
  if (!existsSync(BACKUP_DIR)) return;
  let entries;
  try {
    entries = readdirSync(BACKUP_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const manifest = join(BACKUP_DIR, entry);
    const backup = manifest.slice(0, -".json".length);
    try {
      const { target } = JSON.parse(readFileSync(manifest, "utf8"));
      if (!target || !existsSync(backup)) {
        rmSync(manifest, RM_OPTS);
        continue;
      }
      if (existsSync(target)) continue; // a good file is already there — leave it alone
      mkdirSync(dirname(target), { recursive: true });
      renameSync(backup, target);
      rmSync(manifest, RM_OPTS);
      log(`recovered ${basename(target)} left behind by an interrupted run`);
    } catch (err) {
      log(`WARN: could not process leftover backup ${entry}: ${err.message}`);
    }
  }
}

function cleanupBackupDir() {
  try {
    if (existsSync(BACKUP_DIR) && readdirSync(BACKUP_DIR).length === 0) {
      rmSync(BACKUP_DIR, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// per-module results
// ---------------------------------------------------------------------------

/** status: "ok" | "repaired" | "failed" | "missing" */
function makeResult(name, status, detail) {
  return { name, required: REQUIRED.has(name), status, detail };
}

function buildFromSource(command) {
  // stdout -> inherited (setup.bat sends it to the log), stderr -> inherited so
  // compiler progress stays visible; npm's own output is far too noisy to buffer.
  execSync(command, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
}

/**
 * A 404 from the CDN is not a mirror outage: it means this exact package
 * version publishes no prebuilt binary for the running Node ABI at all.
 * better-sqlite3 dropped its Node 20 (ABI 115) builds in 12.10.0, and
 * @discordjs/opus 0.10.0 has none for Node 24 (ABI 137) - so a user on either
 * of those majors lands in the source-build fallback below and is told to
 * install Python and a C++ toolchain. Switching Node major is the far cheaper
 * fix, and nothing else in this output points at it. See issue #152.
 */
function explainMissingPrebuild(name, version, err) {
  if (!/HTTP 404/.test(err.message)) return;
  log(`${name}: ${name}@${version} ships no prebuilt binary for Node ${NODE_MAJOR} (ABI ${NODE_ABI})`);
  log(
    `${name}: Node ${TESTED_NODE_MAJOR} LTS has one — switching Node is usually much quicker than ` +
      `setting up a compiler (换用 Node ${TESTED_NODE_MAJOR} LTS 通常比装编译环境快得多)`,
  );
}

function buildToolsHint() {
  log("Install build tools first:");
  log("  Windows: npm install --global windows-build-tools  (或安装 Visual Studio Build Tools + Python)");
  log("  Ubuntu/Debian: sudo apt install build-essential python3");
  log("  CentOS/RHEL:   sudo yum groupinstall 'Development Tools'");
}

// ---------------------------------------------------------------------------
// ffmpeg-static (OPTIONAL — a system ffmpeg is a documented fallback)
// ---------------------------------------------------------------------------

async function ensureFfmpeg() {
  const name = "ffmpeg-static";
  const ffDir = join(NODE_MODULES, name);
  const ffName = PLATFORM === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const ffDest = join(ffDir, ffName);

  if (!existsSync(ffDir)) {
    log(`${name}: package not installed, skipping (a system ffmpeg on PATH also works)`);
    return makeResult(name, "missing", "package not installed");
  }

  if (existsSync(ffDest) && sizeOf(ffDest) >= FFMPEG_MIN_BYTES) {
    ensureExecutable(ffDest);
    const probe = probeFfmpegBinary(ffDest);
    if (probe.ok) {
      log(`${name}: OK (${humanSize(ffDest)}, ${probe.version})`);
      return makeResult(name, "ok", humanSize(ffDest));
    }
    // Deliberately NOT re-downloading here: ffmpeg is a plain executable with no
    // ABI to mismatch, and forcing an ~80 MB re-download because `-version`
    // could not be spawned would hurt exactly the slow-network users this
    // script exists for.
    log(`${name}: present (${humanSize(ffDest)}) but could not be executed: ${probe.error}`);
    return makeResult(name, "ok", "present, not verified");
  }

  if (existsSync(ffDest)) {
    log(`${name}: existing ffmpeg looks truncated (${humanSize(ffDest)}), re-downloading...`);
  } else {
    log(`${name}: ffmpeg binary missing, downloading...`);
  }

  const url = `${CDN}/ffmpeg-static/b6.1.1/ffmpeg-${PLATFORM}-${ARCH}.gz`;
  const backup = stash(ffDest);
  const tmpDest = `${ffDest}.tsmb-tmp-${process.pid}`;
  try {
    log(`${name}: GET ${url}  (~80 MB, 这一步比较慢,请耐心等待)`);
    const buf = await download(url);
    await pipeline(Readable.from(buf), createGunzip(), createWriteStream(tmpDest));
    ensureExecutable(tmpDest);
    if (sizeOf(tmpDest) < FFMPEG_MIN_BYTES) {
      throw new Error(`downloaded ffmpeg is only ${humanSize(tmpDest)} — truncated`);
    }
    renameSync(tmpDest, ffDest); // atomic swap, same directory
    backup.commit();
    log(`${name}: OK (${humanSize(ffDest)})`);
    return makeResult(name, "repaired", humanSize(ffDest));
  } catch (err) {
    try {
      rmSync(tmpDest, { force: true });
    } catch {
      /* ignore */
    }
    backup.restore();
    log(`${name}: download failed — ${err.message}`);
    log(`${name}: not fatal — install ffmpeg system-wide and put it on PATH instead`);
    return makeResult(name, "failed", err.message);
  }
}

// ---------------------------------------------------------------------------
// @discordjs/opus (REQUIRED)
// ---------------------------------------------------------------------------

async function ensureOpus() {
  const name = "@discordjs/opus";
  const pkgDir = join(NODE_MODULES, "@discordjs", "opus");
  const prebuildRoot = join(pkgDir, "prebuild");
  // node-pre-gyp resolves this directory from the *running* Node's ABI, so a
  // stale build for another ABI simply sits at another path and is ignored.
  const prebuildDirName = `node-v${NODE_ABI}-napi-v3-${PLATFORM}-${ARCH}-unknown-unknown`;
  const destDir = join(prebuildRoot, prebuildDirName);

  if (!existsSync(pkgDir)) {
    log(`${name}: package not installed — run 'npm install' first`);
    return makeResult(name, "missing", "package not installed");
  }

  const before = probeRequire(name);
  if (before.ok) {
    log(`${name}: OK (loads under ${process.version}, ABI ${NODE_ABI})`);
    return makeResult(name, "ok", `ABI ${NODE_ABI}`);
  }
  log(`${name}: unusable — ${describeProbe(before)}`);
  log(`${name}: installing a build for ABI ${NODE_ABI}...`);

  const version = readInstalledVersion(name) || "0.10.0";
  const url =
    `${CDN}/@discordjs/opus/v${version}/opus-v${version}` +
    `-node-v${NODE_ABI}-napi-v3-${PLATFORM}-${ARCH}-unknown-unknown.tar.gz`;

  const backup = stash(destDir);
  let staging = null;
  try {
    try {
      log(`${name}: GET ${url}`);
      const buf = await download(url);
      staging = mkdtempSync(join(pkgDir, ".tsmb-staging-"));
      await extractTarGz(buf, staging);
      const staged = join(staging, prebuildDirName);
      if (!existsSync(join(staged, "opus.node"))) {
        throw new Error(`tarball did not contain ${prebuildDirName}/opus.node`);
      }
      mkdirSync(prebuildRoot, { recursive: true });
      rmSync(destDir, { recursive: true, force: true });
      renameSync(staged, destDir); // atomic swap, same volume
      log(`${name}: prebuilt binary installed`);
    } catch (cdnErr) {
      log(`${name}: CDN install failed (${cdnErr.message})`);
      explainMissingPrebuild(name, version, cdnErr);
      log(`${name}: falling back to a source build — 'npm rebuild ${name}' (可能需要几分钟)`);
      buildFromSource(`npm rebuild ${name}`);
    }

    const after = probeRequire(name);
    if (!after.ok) throw new Error(describeProbe(after));
    backup.commit();
    log(`${name}: repaired, now loads under ${process.version} (ABI ${NODE_ABI})`);
    return makeResult(name, "repaired", `ABI ${NODE_ABI}`);
  } catch (err) {
    backup.restore();
    log(`${name}: FAILED — ${err.message}`);
    buildToolsHint();
    return makeResult(name, "failed", err.message);
  } finally {
    if (staging) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// better-sqlite3 (REQUIRED) — the module the ABI bug actually bites
// ---------------------------------------------------------------------------

async function ensureBetterSqlite3() {
  const name = "better-sqlite3";
  const pkgDir = join(NODE_MODULES, name);
  const dest = join(pkgDir, "build", "Release", "better_sqlite3.node");

  if (!existsSync(pkgDir)) {
    log(`${name}: package not installed — run 'npm install' first`);
    return makeResult(name, "missing", "package not installed");
  }

  const before = probeRequire(name);
  if (before.ok) {
    log(`${name}: OK (loads under ${process.version}, ABI ${NODE_ABI})`);
    return makeResult(name, "ok", `ABI ${NODE_ABI}`);
  }
  // This is the case the old size check could not see: the file is there, it is
  // ~1.9 MB, and it is completely useless because it targets another ABI.
  log(`${name}: unusable — ${describeProbe(before)}`);
  log(`${name}: replacing the native binary with a build for ABI ${NODE_ABI}...`);

  const version = readInstalledVersion(name) || "12.11.1";
  const url = `${CDN}/${name}/v${version}/${name}-v${version}-node-v${NODE_ABI}-${PLATFORM}-${ARCH}.tar.gz`;

  const backup = stash(dest);
  let staging = null;
  try {
    try {
      log(`${name}: GET ${url}`);
      const buf = await download(url);
      staging = mkdtempSync(join(pkgDir, ".tsmb-staging-"));
      await extractTarGz(buf, staging);
      const staged = join(staging, "build", "Release", "better_sqlite3.node");
      if (!existsSync(staged)) {
        throw new Error("tarball did not contain build/Release/better_sqlite3.node");
      }
      mkdirSync(dirname(dest), { recursive: true });
      rmSync(dest, { force: true });
      renameSync(staged, dest); // atomic swap, same volume
      log(`${name}: prebuilt binary installed (${humanSize(dest)})`);
    } catch (cdnErr) {
      log(`${name}: CDN install failed (${cdnErr.message})`);
      explainMissingPrebuild(name, version, cdnErr);
      log(`${name}: falling back to a source build — 'npm rebuild ${name} --build-from-source' (可能需要几分钟)`);
      buildFromSource(`npm rebuild ${name} --build-from-source`);
    }

    const after = probeRequire(name);
    if (!after.ok) throw new Error(describeProbe(after));
    backup.commit();
    log(`${name}: repaired, now loads under ${process.version} (ABI ${NODE_ABI}, ${humanSize(dest)})`);
    return makeResult(name, "repaired", `ABI ${NODE_ABI}`);
  } catch (err) {
    backup.restore();
    log(`${name}: FAILED — ${err.message}`);
    buildToolsHint();
    return makeResult(name, "failed", err.message);
  } finally {
    if (staging) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// stamp
// ---------------------------------------------------------------------------

/** Record which ABI this install was built for. Lives inside node_modules so it
 *  dies together with the thing it describes. check-native.mjs reads it. */
function writeStamp(results) {
  if (!existsSync(NODE_MODULES)) return;
  const stamp = {
    abi: NODE_ABI,
    nodeVersion: process.version,
    platform: PLATFORM,
    arch: ARCH,
    updatedAt: new Date().toISOString(),
    modules: Object.fromEntries(results.map((r) => [r.name, r.status])),
  };
  try {
    writeFileSync(STAMP_FILE, `${JSON.stringify(stamp, null, 2)}\n`);
    log(`ABI stamp written: node_modules/.tsmusicbot-abi (Node ${process.version}, ABI ${NODE_ABI})`);
  } catch (err) {
    log(`WARN: could not write ABI stamp: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const STEPS = [
  ["ffmpeg-static", ensureFfmpeg],
  ["@discordjs/opus", ensureOpus],
  ["better-sqlite3", ensureBetterSqlite3],
];

try {
  log(`Node ${process.version} (ABI ${NODE_ABI}), ${PLATFORM}-${ARCH}, CDN ${CDN}`);

  recoverOrphanedBackups();

  // STRICTLY SEQUENTIAL, and it has to stay that way. The source-build fallback
  // shells out through execSync, which parks the event loop for minutes; the
  // 120s timeout that download() arms is a socket-INACTIVITY timer sitting on
  // that same loop. Run these concurrently and the first module to fall back to
  // a source build kills every download still in flight — the connection is
  // healthy, the timer just never got a chance to be reset. That is not a rare
  // race: npmmirror has no opus prebuild for ABI 137 (Node 24) and no
  // better-sqlite3 prebuild for ABI 115 (Node 20), so on both of the Node
  // versions this project supports, one module 404s within ~100ms and starts
  // building while ffmpeg's ~80MB download is still going. ffmpeg is optional,
  // so the spurious failure used to be swallowed as a WARN and setup still
  // reported success — leaving the user with no ffmpeg and no working playback.
  // Nothing here benefits from overlap anyway: every probe is execFileSync.
  const results = [];
  for (const [name, run] of STEPS) {
    try {
      results.push(await run());
    } catch (err) {
      results.push(makeResult(name, "failed", err?.message ?? String(err)));
    }
  }

  cleanupBackupDir();

  log("");
  log(`Summary — Node ${process.version} / ABI ${NODE_ABI} / ${PLATFORM}-${ARCH}:`);
  for (const r of results) {
    const tag =
      r.status === "ok"
        ? "OK"
        : r.status === "repaired"
          ? "REPAIRED"
          : r.required
            ? "FAILED"
            : "WARN (optional)";
    log(`  - ${r.name.padEnd(17)} ${tag}${r.detail ? `  ${r.detail}` : ""}`);
  }

  const broken = results.filter(
    (r) => r.required && r.status !== "ok" && r.status !== "repaired",
  );
  // Only stamp a build that actually succeeded. The stamp says "node_modules is
  // built for ABI X"; writing it after a failed repair would have check-native
  // print a reassuring "built with ABI 137" right above its own "this module is
  // built for ABI 127" complaint.
  if (broken.length === 0) writeStamp(results);
  // process.exitCode rather than process.exit(): setup.bat redirects stdout to
  // setup.log, and process.exit() can drop output that has not flushed yet.
  if (broken.length > 0) {
    log("");
    log(`ERROR: required native module(s) unusable: ${broken.map((r) => r.name).join(", ")}`);
    log("必需的原生模块不可用,机器人无法启动 —— 请查看上面的错误信息。");
    process.exitCode = 1;
  } else {
    log("All required native modules are ready.");
    process.exitCode = 0;
  }
} catch (e) {
  log(`ERROR: ${e.stack || e.message}`);
  process.exitCode = 1;
}
