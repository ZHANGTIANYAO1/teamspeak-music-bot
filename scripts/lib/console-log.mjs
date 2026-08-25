/**
 * Crash-proof line logging for the setup scripts.
 *
 * WHY THIS EXISTS (issue #152)
 * ----------------------------
 * setup.bat runs `chcp 65001` and shows progress on stderr. Some Windows
 * consoles - Windows Server 2012 R2 above all - cannot render non-ASCII text in
 * that code page and the OS fails the write with EIO. `process.stderr` is an
 * ordinary stream, so that EIO arrives as an 'error' event, and a stream with
 * no 'error' listener rethrows it as an uncaught exception:
 *
 *     Error: write EIO
 *         at afterWriteDispatched (node:internal/stream_base_commons:159:15)
 *         ...
 *         at log (scripts/download-binaries.mjs:84:18)
 *         at ensureFfmpeg (scripts/download-binaries.mjs:451:5)
 *
 * That is setup killing itself inside its own progress logging, on the first
 * line of the run that happened to contain Chinese - nothing was wrong with the
 * download it was about to start.
 *
 * So: listen for the error and degrade instead of dying.
 *   full  -> ascii : drop the CJK the console choked on, keep the English half
 *   ascii -> off   : the stream is simply gone (closed pipe) - stay quiet
 * Each stream degrades on its own, so a console that gives up does not cost
 * setup.log its full bilingual transcript: that stdout is a redirected file.
 */

const HAS_NON_ASCII = /[^\x00-\x7F]/;

/** Placeholders for a removed run: one that separated words, one that did not. */
const SPACED = "\u0000";
const TIGHT = "\u0001";

/** Punctuation the bilingual strings use that has an obvious ASCII twin. */
const PUNCTUATION = new Map(
  Object.entries({
    "—": "-",
    "–": "-",
    "…": "...",
    "“": '"',
    "”": '"',
    "‘": "'",
    "’": "'",
    "，": ",",
    "。": ".",
    "、": ",",
    "：": ":",
    "；": ";",
    "（": "(",
    "）": ")",
    "！": "!",
    "？": "?",
    "←": "<-",
    "→": "->",
    "×": "x",
  }),
);

/**
 * Best-effort ASCII rendering of a log line, for a console that cannot print
 * anything else. Returns null when nothing worth printing survives - every
 * Chinese-only line in these scripts sits directly beside an English line
 * saying the same thing, so dropping it loses no information.
 */
export function toAsciiFallback(text) {
  if (!HAS_NON_ASCII.test(text)) return text;

  let out = "";
  for (const ch of text) out += PUNCTUATION.get(ch) ?? ch;

  out = out
    .replace(/[\u0000\u0001]/g, "")
    // Mark each removed run rather than just deleting it, so the tidy-up below
    // can tell "a separator that introduced text we dropped" from "a separator
    // that belongs to the English half". SPACED was holding two ASCII words
    // apart; TIGHT was hugging a bracket or a comma.
    .replace(/[ \t]*[^\x00-\x7F]+[ \t]*/g, (run) =>
      /^[ \t]/.test(run) && /[ \t]$/.test(run) ? SPACED : TIGHT,
    )
    // "(可能需要几分钟)" — the parentheses held nothing else.
    .replace(/[ \t]*\([ \t]*(?:[\u0000\u0001][ \t]*)+\)/g, "")
    // "FAILED — 编译失败", "(~80 MB, 请耐心等待)" — drop the trailing marks along
    // with the separators that were only ever there to introduce them.
    .replace(/[ \t]*[-,;:]*[ \t]*(?:[\u0000\u0001][ \t,;:-]*)+(?=[)\]]|$)/gm, "")
    .replace(/\u0000/g, " ")
    .replace(/\u0001/g, "")
    .replace(/[ \t]+$/gm, "");

  return /[A-Za-z0-9]/.test(out) ? out : null;
}

/** One degradation state per stream, shared by every writer built on it. */
const guards = new WeakMap();

function guardFor(stream) {
  const existing = guards.get(stream);
  if (existing) return existing;

  const guard = { mode: "full" };
  guards.set(stream, guard);
  try {
    // The whole point: without this listener the next EIO/EPIPE is fatal.
    stream.on("error", () => degrade(guard));
  } catch {
    /* not an EventEmitter - the try/catch around write() still guards us */
  }
  return guard;
}

function degrade(guard) {
  guard.mode = guard.mode === "full" ? "ascii" : "off";
}

/**
 * Build a `writeLine(text)` that appends a newline, never throws, and never
 * lets a failed console write take the process down with it.
 * Returns true when the line reached the stream.
 */
export function createLineWriter(stream) {
  const guard = guardFor(stream);

  return function writeLine(text) {
    if (guard.mode === "off") return false;

    let line = text;
    if (guard.mode === "ascii") {
      line = toAsciiFallback(text);
      if (line === null) return false;
    }

    try {
      stream.write(`${line}\n`);
      return true;
    } catch {
      // A synchronous throw (EBADF on a closed handle) never reaches the
      // 'error' listener, so degrade here too.
      degrade(guard);
      return false;
    }
  };
}
