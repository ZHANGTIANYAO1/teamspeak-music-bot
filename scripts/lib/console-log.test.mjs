import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createLineWriter, toAsciiFallback } from "./console-log.mjs";

/** Stand-in for process.stderr: an EventEmitter with a write() we can steer. */
function fakeStream() {
  const stream = new EventEmitter();
  stream.written = [];
  stream.throwOnWrite = false;
  stream.write = (chunk) => {
    if (stream.throwOnWrite) throw new Error("EBADF");
    stream.written.push(chunk);
    return true;
  };
  return stream;
}

describe("toAsciiFallback", () => {
  it("leaves ASCII lines exactly as they are", () => {
    const line = "  [binary] better-sqlite3: OK (loads under v22.23.2, ABI 127)";
    expect(toAsciiFallback(line)).toBe(line);
    expect(toAsciiFallback("")).toBe("");
  });

  it("keeps the English half of the line that crashed setup in #152", () => {
    expect(
      toAsciiFallback(
        "  [binary] ffmpeg-static: GET https://cdn/ffmpeg.gz  (~80 MB, 这一步比较慢,请耐心等待)",
      ),
    ).toBe("  [binary] ffmpeg-static: GET https://cdn/ffmpeg.gz  (~80 MB)");
  });

  it("drops parentheses and separators left stranded by the removed text", () => {
    expect(
      toAsciiFallback("  [binary] better-sqlite3: falling back — 'npm rebuild' (可能需要几分钟)"),
    ).toBe("  [binary] better-sqlite3: falling back - 'npm rebuild'");
    expect(
      toAsciiFallback("  Windows: npm install --global windows-build-tools  (或安装 VS Build Tools)"),
    ).toBe("  Windows: npm install --global windows-build-tools  (VS Build Tools)");
  });

  it("drops a Chinese-only line, which always has an English twin beside it", () => {
    expect(toAsciiFallback("必需的原生模块不可用,机器人无法启动 —— 请查看上面的错误信息。")).toBeNull();
  });

  it("preserves the indentation the summary is aligned on, and drops the dangling dash", () => {
    expect(toAsciiFallback("  - better-sqlite3     FAILED — 编译失败")).toBe(
      "  - better-sqlite3     FAILED",
    );
  });

  it("keeps a separator that belongs to the English half", () => {
    expect(toAsciiFallback("Summary — Node v22.0.0 / ABI 127 / win32-x64:")).toBe(
      "Summary - Node v22.0.0 / ABI 127 / win32-x64:",
    );
  });
});

describe("createLineWriter", () => {
  it("appends a newline and reports the write", () => {
    const stream = fakeStream();
    expect(createLineWriter(stream)("hello")).toBe(true);
    expect(stream.written).toEqual(["hello\n"]);
  });

  it("survives the EIO that killed setup: an 'error' event must not throw", () => {
    const stream = fakeStream();
    createLineWriter(stream);
    expect(stream.listenerCount("error")).toBe(1);
    expect(() => stream.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" }))).not.toThrow();
  });

  it("falls back to ASCII once the console has refused a line", () => {
    const stream = fakeStream();
    const write = createLineWriter(stream);
    write("  [binary] GET https://cdn/ffmpeg.gz  (~80 MB, 这一步比较慢,请耐心等待)");
    stream.emit("error", new Error("write EIO"));
    write("  [binary] GET https://cdn/opus.tar.gz  (~1 MB, 这一步比较慢,请耐心等待)");
    expect(stream.written).toEqual([
      "  [binary] GET https://cdn/ffmpeg.gz  (~80 MB, 这一步比较慢,请耐心等待)\n",
      "  [binary] GET https://cdn/opus.tar.gz  (~1 MB)\n",
    ]);
  });

  it("goes quiet after a second failure rather than retrying a dead stream", () => {
    const stream = fakeStream();
    const write = createLineWriter(stream);
    stream.emit("error", new Error("write EIO"));
    stream.emit("error", new Error("write EPIPE"));
    expect(write("anything at all")).toBe(false);
    expect(stream.written).toEqual([]);
  });

  it("degrades on a synchronous throw too, which never reaches the listener", () => {
    const stream = fakeStream();
    const write = createLineWriter(stream);
    stream.throwOnWrite = true;
    expect(write("  [binary] 下载中 downloading")).toBe(false);
    stream.throwOnWrite = false;
    write("  [binary] 下载中 downloading");
    expect(stream.written).toEqual(["  [binary] downloading\n"]);
  });

  it("degrades each stream on its own, so setup.log keeps the full transcript", () => {
    const console_ = fakeStream();
    const logFile = fakeStream();
    const writeConsole = createLineWriter(console_);
    const writeLog = createLineWriter(logFile);
    console_.emit("error", new Error("write EIO"));

    const line = "  [binary] ffmpeg-static: 下载完成 done";
    writeConsole(line);
    writeLog(line);

    expect(console_.written).toEqual(["  [binary] ffmpeg-static: done\n"]);
    expect(logFile.written).toEqual([`${line}\n`]);
  });

  it("never installs a second listener for a stream that already has a writer", () => {
    const stream = fakeStream();
    createLineWriter(stream);
    createLineWriter(stream);
    expect(stream.listenerCount("error")).toBe(1);
  });

  it("still guards a stream that is not an EventEmitter", () => {
    const stream = { write: vi.fn(() => { throw new Error("EBADF"); }) };
    const write = createLineWriter(stream);
    expect(() => write("line")).not.toThrow();
    expect(write("line")).toBe(false);
  });
});
