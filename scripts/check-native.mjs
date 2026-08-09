#!/usr/bin/env node

/**
 * Preflight: can THIS Node build actually load the native modules that are
 * sitting in node_modules?
 *
 * A compiled addon is tied to one Node ABI (process.versions.modules:
 * Node 20 = 115, Node 22 = 127, Node 24 = 137). Install under one Node major,
 * launch under another, and the bot dies deep inside startup with a
 * `NODE_MODULE_VERSION ...` stack that says nothing about how to fix it.
 * This script turns that into one actionable sentence, before anything starts.
 *
 * Exit code:
 *   0  every required native module loads (or is simply not installed yet —
 *      that is npm install's problem, not an ABI problem)
 *   1  a required native module definitively fails to load; the bot could not
 *      have started anyway, so there is no false-positive risk here.
 *
 * Usage: node scripts/check-native.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = join(ROOT, "node_modules");
const STAMP_FILE = join(NODE_MODULES, ".tsmusicbot-abi");
const NODE_ABI = process.versions.modules;

/** Only the modules the bot cannot start without. ffmpeg-static is optional
 *  (a system ffmpeg on PATH works too), so it is not checked here. */
const REQUIRED = ["@discordjs/opus", "better-sqlite3"];

function pkgDirOf(spec) {
  return join(NODE_MODULES, ...spec.split("/"));
}

function summarizeError(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const interesting = lines.find((l) => /NODE_MODULE_VERSION|Error:|error:/.test(l));
  return (interesting || lines[0] || "unknown error").slice(0, 300);
}

/**
 * The snippet that actually forces each package's addon to be dlopen()ed.
 * NOTE: better-sqlite3 loads its .node lazily, inside the Database constructor,
 * so a bare `require('better-sqlite3')` succeeds even against a wrong-ABI
 * binary. Opening an in-memory database is the cheapest way to really load it.
 */
const PROBE_EXPR = {
  "@discordjs/opus": "require('@discordjs/opus')",
  "better-sqlite3": "new (require('better-sqlite3'))(':memory:').close()",
};

/**
 * Load-probe in a throwaway child process. Child process on purpose: requiring
 * an addon in this process would keep the DLL mapped, and Windows then refuses
 * to let setup.bat replace the file we just told the user to replace.
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
    //  requires NODE_MODULE_VERSION 127..." -> first number is the build target.
    const abis = [...text.matchAll(/NODE_MODULE_VERSION (\d+)/g)].map((m) => m[1]);
    return {
      ok: false,
      abiMismatch: abis.length >= 2,
      compiledAbi: abis.length >= 2 ? abis[0] : null,
      error: summarizeError(text),
    };
  }
}

function readStamp() {
  try {
    return JSON.parse(readFileSync(STAMP_FILE, "utf8"));
  } catch {
    return null;
  }
}

const setupCmd = process.platform === "win32" ? "scripts\\setup.bat" : "bash scripts/setup.sh";

const broken = [];
for (const spec of REQUIRED) {
  if (!existsSync(pkgDirOf(spec))) continue; // not installed yet -> npm install's job
  const probe = probeRequire(spec);
  if (!probe.ok) broken.push({ spec, ...probe });
}

function report() {
  const stamp = readStamp();
  const mismatch = broken.find((b) => b.abiMismatch);
  const out = (line) => process.stderr.write(`${line}\n`);

  out("");
  out("============================================================");
  if (mismatch) {
    out("  [ERROR] 原生模块与当前 Node 版本不匹配");
    out("          Native modules do not match this Node version");
  } else {
    out("  [ERROR] 原生模块无法加载 / native module failed to load");
  }
  out("============================================================");
  out(`  本机 Node / running Node : ${process.version}  (ABI ${NODE_ABI})`);
  if (stamp && stamp.abi) {
    out(`  安装时 Node / built with : ${stamp.nodeVersion || "?"}  (ABI ${stamp.abi})`);
    out(`                             ← node_modules/.tsmusicbot-abi, ${stamp.updatedAt || "?"}`);
  }
  out("");
  for (const b of broken) {
    if (b.abiMismatch) {
      out(`  x ${b.spec}: 本机 Node ${process.version} (ABI ${NODE_ABI}),`);
      out(`      但 node_modules 里的原生模块是给 ABI ${b.compiledAbi} 编译的。`);
      out(`      built for ABI ${b.compiledAbi}, this Node needs ABI ${NODE_ABI}.`);
    } else {
      out(`  x ${b.spec}: ${b.error}`);
    }
  }
  out("");
  out("  怎么修 / How to fix:");
  out(`    1) 重新运行安装脚本 / re-run setup:  ${setupCmd}`);
  out("       (它会自动为当前 Node 版本重新安装原生模块)");
  out("       (setup now repairs the native modules for whatever Node you run)");
  out("    2) 或者换回安装时用的 Node 版本 / or switch back to the Node version");
  out("       you installed with, then start again.");
  out("============================================================");
  out("");
}

if (broken.length > 0) {
  report();
  // exitCode rather than exit(): lets the message flush when stderr is piped.
  process.exitCode = 1;
}
