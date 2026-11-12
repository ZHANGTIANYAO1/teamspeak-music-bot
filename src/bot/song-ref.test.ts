import { describe, it, expect } from "vitest";
import { parseSongRef, parseSelectionIndex, parsePlaylistRef, findShareShortLink, resolveShareLink } from "./song-ref.js";

describe("parseSongRef (#90 exact-song selection)", () => {
  it("returns null for a plain search term", () => {
    expect(parseSongRef("Die For You")).toBeNull();
    expect(parseSongRef("周杰伦 晴天")).toBeNull();
    expect(parseSongRef("")).toBeNull();
    // A bare number is NOT treated as an id (a song may be named "2002").
    expect(parseSongRef("2002")).toBeNull();
  });

  it("parses an explicit id: prefix with no platform (defer to flags)", () => {
    expect(parseSongRef("id:185868")).toEqual({ id: "185868", platform: null });
    expect(parseSongRef("ID: 004Z8Ihr0JIu5s")).toEqual({ id: "004Z8Ihr0JIu5s", platform: null });
  });

  it("strips trailing punctuation from a pasted id:", () => {
    expect(parseSongRef("id:185868.")).toEqual({ id: "185868", platform: null });
    expect(parseSongRef("id:185868)")).toEqual({ id: "185868", platform: null });
    expect(parseSongRef("id:185868,")).toEqual({ id: "185868", platform: null });
  });

  // Issue #139: `!play id <id>` matches the "<command> <subcommand> <arg>"
  // shape of every other command. The colon form stays supported — users have
  // it in their chat scrollback and in older docs.
  it("parses the space-separated id form", () => {
    expect(parseSongRef("id 185868")).toEqual({ id: "185868", platform: null });
    expect(parseSongRef("ID 004Z8Ihr0JIu5s")).toEqual({ id: "004Z8Ihr0JIu5s", platform: null });
    expect(parseSongRef("id   185868")).toEqual({ id: "185868", platform: null });
    expect(parseSongRef("id 185868.")).toEqual({ id: "185868", platform: null });
  });

  it("does not mistake a word merely starting with 'id' for an id reference", () => {
    expect(parseSongRef("idol")).toBeNull();
    expect(parseSongRef("identity 185868")).toBeNull();
    expect(parseSongRef("id")).toBeNull();
    expect(parseSongRef("id:")).toBeNull();
    // Two remaining tokens are a search phrase, not an id.
    expect(parseSongRef("id die for you")).toBeNull();
  });

  // Without a colon, "id" is just a word — "ID 4" and "ID Bruno" are real track
  // titles. The space form therefore only claims tokens that could actually be
  // an id; everything else stays a search term.
  it("only treats the space form as an id when the token looks like one", () => {
    expect(parseSongRef("id Bruno")).toBeNull();
    expect(parseSongRef("id Marshmello")).toBeNull();
    expect(parseSongRef("id 4ever")).toBeNull();
    // …while every real id shape is still accepted.
    expect(parseSongRef("id 4")).toEqual({ id: "4", platform: null });          // numeric
    expect(parseSongRef("id BV1yxHQeYEuE")).toEqual({ id: "BV1yxHQeYEuE", platform: null });
    expect(parseSongRef("id 004Z8Ihr0JIu5s")).toEqual({ id: "004Z8Ihr0JIu5s", platform: null }); // QQ mid
    expect(parseSongRef("id a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")).toEqual({
      id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      platform: null,
    }); // Jellyfin GUID / Kugou hash
  });

  it("keeps the colon form unrestricted, so a short or odd id still works", () => {
    expect(parseSongRef("id:Bruno")).toEqual({ id: "Bruno", platform: null });
    expect(parseSongRef("id: 4ever")).toEqual({ id: "4ever", platform: null });
  });

  it("does not let the space form swallow a pasted URL", () => {
    // `id <url>` used to fall through to the URL branches; it still must.
    expect(parseSongRef("id https://music.163.com/song?id=185868")).toEqual({
      id: "185868",
      platform: "netease",
    });
    expect(parseSongRef("id https://y.qq.com/n/ryqq/songDetail/004Z8Ihr0JIu5s")).toEqual({
      id: "004Z8Ihr0JIu5s",
      platform: "qq",
    });
  });

  it("does NOT treat NetEase collection (playlist/album/artist) URLs as a song id", () => {
    // These reuse ?id= but are not songs — they should fall through to search,
    // not misresolve to getSongDetail(collectionId) and error "no song".
    expect(parseSongRef("https://music.163.com/playlist?id=123456")).toBeNull();
    expect(parseSongRef("https://music.163.com/#/playlist?id=123456")).toBeNull();
    expect(parseSongRef("https://music.163.com/album?id=123456")).toBeNull();
    expect(parseSongRef("https://music.163.com/artist?id=185858")).toBeNull();
    // A genuine song URL is still parsed.
    expect(parseSongRef("https://music.163.com/song?id=185868")).toEqual({ id: "185868", platform: "netease" });
  });

  it("parses NetEase song URLs", () => {
    expect(parseSongRef("https://music.163.com/song?id=185868")).toEqual({ id: "185868", platform: "netease" });
    expect(parseSongRef("https://music.163.com/#/song?id=185868&userid=1")).toEqual({ id: "185868", platform: "netease" });
    expect(parseSongRef("music.163.com/song/185868")).toEqual({ id: "185868", platform: "netease" });
  });

  it("parses QQ song URLs", () => {
    expect(parseSongRef("https://y.qq.com/n/ryqq/songDetail/004Z8Ihr0JIu5s")).toEqual({ id: "004Z8Ihr0JIu5s", platform: "qq" });
    expect(parseSongRef("https://y.qq.com/n/yqq/song/abc.html?songmid=004Z8Ihr0JIu5s")).toEqual({ id: "004Z8Ihr0JIu5s", platform: "qq" });
  });

  it("parses BiliBili BV ids (bare or in a URL)", () => {
    expect(parseSongRef("BV1yxHQeYEuE")).toEqual({ id: "BV1yxHQeYEuE", platform: "bilibili" });
    expect(parseSongRef("https://www.bilibili.com/video/BV1yxHQeYEuE")).toEqual({ id: "BV1yxHQeYEuE", platform: "bilibili" });
    expect(parseSongRef("https://b23.tv/BV1yxHQeYEuE")).toEqual({ id: "BV1yxHQeYEuE", platform: "bilibili" });
  });

  it.each([
    "https://www.bilibili.com/video/BV1yxHQeYEuE?p=2",
    "https://b23.tv/BV1yxHQeYEuE?p=2",
    "https://www.bilibili.com/video/BV1yxHQeYEuE/?from=share&p=2&vd_source=test#reply",
    "https://www.bilibili.com/video/BV1yxHQeYEuE/?from=share?p=3&p=2",
    "https://www.bilibili.com/video/BV1yxHQeYEuE/?p=%32",
    "[URL]https://www.bilibili.com/video/BV1yxHQeYEuE/?p=2[/URL]",
    "[url]https://www.bilibili.com/video/BV1yxHQeYEuE/?p=2#reply[/url]",
  ])("preserves the Bilibili page query in %s", (input) => {
    expect(parseSongRef(input)).toEqual({ id: "BV1yxHQeYEuE?p=2", platform: "bilibili" });
  });

  it.each([
    "?p=2extra",
    "?p=-2",
    "?page=2",
    "?sp=2",
    "?from=share?p=2",
    "?from=share%3Fp%3D2",
    "?from=share#reply&p=2",
    "#reply?p=2",
  ])("ignores an invalid or unrelated Bilibili page query %s", (query) => {
    expect(parseSongRef(`https://www.bilibili.com/video/BV1yxHQeYEuE${query}`))
      .toEqual({ id: "BV1yxHQeYEuE", platform: "bilibili" });
  });
});

describe("parseSelectionIndex (#90 pick from last search)", () => {
  it("parses #N tokens (1-based)", () => {
    expect(parseSelectionIndex("#1")).toBe(1);
    expect(parseSelectionIndex("#2")).toBe(2);
    expect(parseSelectionIndex("# 3")).toBe(3);
    expect(parseSelectionIndex("  #10  ")).toBe(10);
  });

  it("rejects non-selections", () => {
    expect(parseSelectionIndex("2")).toBeNull();
    expect(parseSelectionIndex("#0")).toBeNull();
    expect(parseSelectionIndex("#-1")).toBeNull();
    expect(parseSelectionIndex("Die For You")).toBeNull();
    expect(parseSelectionIndex("#2 extra")).toBeNull();
    expect(parseSelectionIndex("")).toBeNull();
  });
});

describe("parsePlaylistRef (#160 play a playlist from its link)", () => {
  it("returns null for a playlist name or a bare id (caller keeps its old logic)", () => {
    expect(parsePlaylistRef("华语经典")).toBeNull();
    expect(parsePlaylistRef("2829883282")).toBeNull();
    expect(parsePlaylistRef("")).toBeNull();
  });

  it("parses NetEase playlist URLs (web, hash route, mobile share)", () => {
    expect(parsePlaylistRef("https://music.163.com/playlist?id=2829883282")).toEqual({ id: "2829883282", platform: "netease" });
    expect(parsePlaylistRef("https://music.163.com/#/playlist?id=2829883282")).toEqual({ id: "2829883282", platform: "netease" });
    expect(parsePlaylistRef("https://y.music.163.com/m/playlist?id=2829883282&userid=77&creatorId=77")).toEqual({ id: "2829883282", platform: "netease" });
    expect(parsePlaylistRef("https://music.163.com/playlist/2829883282")).toEqual({ id: "2829883282", platform: "netease" });
  });

  it("does not mistake a NetEase userid= for the playlist id", () => {
    expect(parsePlaylistRef("https://music.163.com/playlist?userid=77&id=123")).toEqual({ id: "123", platform: "netease" });
  });

  it("parses QQ Music playlist URLs", () => {
    expect(parsePlaylistRef("https://y.qq.com/n/ryqq/playlist/8052190267")).toEqual({ id: "8052190267", platform: "qq" });
    expect(parsePlaylistRef("https://i.y.qq.com/n2/m/share/details/taoge.html?platform=11&appshare=android_qq&hosteuin=abc&id=8052190267&appversion=13")).toEqual({ id: "8052190267", platform: "qq" });
  });

  it("parses YouTube playlist URLs by their list= id", () => {
    expect(parsePlaylistRef("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG")).toEqual({ id: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG", platform: "youtube" });
    expect(parsePlaylistRef("https://youtu.be/abc?list=PLabc-_1")).toEqual({ id: "PLabc-_1", platform: "youtube" });
  });

  it("unwraps the [URL] BBCode the TeamSpeak client adds to pasted links", () => {
    expect(parsePlaylistRef("[URL]https://y.qq.com/n/ryqq/playlist/8052190267[/URL]")).toEqual({ id: "8052190267", platform: "qq" });
  });

  it("finds the link inside an app's share text", () => {
    expect(parsePlaylistRef("分享某人创建的歌单「深夜」: https://y.music.163.com/m/playlist?id=123&userid=77 (来自@网易云音乐)")).toEqual({ id: "123", platform: "netease" });
  });
});

describe("findShareShortLink (#160)", () => {
  it("finds NetEase and QQ app short links, even inside share text or BBCode", () => {
    expect(findShareShortLink("歌单「深夜」: https://163cn.tv/Abc123 (来自@网易云音乐)")).toBe("https://163cn.tv/Abc123");
    expect(findShareShortLink("[URL]https://c6.y.qq.com/base/fcgi-bin/u?__=AbCd12[/URL]")).toBe("https://c6.y.qq.com/base/fcgi-bin/u?__=AbCd12");
  });

  it("ignores every other host, so we never fetch arbitrary user-supplied URLs", () => {
    expect(findShareShortLink("https://evil.example/163cn.tv/Abc")).toBeNull();
    expect(findShareShortLink("http://127.0.0.1:8080/x")).toBeNull();
    expect(findShareShortLink("华语经典")).toBeNull();
  });
});

describe("resolveShareLink (#160)", () => {
  it("returns the redirect target", async () => {
    const get = async () => ({ status: 302, location: "https://music.163.com/playlist?id=123" });
    expect(await resolveShareLink("https://163cn.tv/Abc", get)).toBe("https://music.163.com/playlist?id=123");
  });

  it("returns null when there is no redirect or the request fails", async () => {
    expect(await resolveShareLink("https://163cn.tv/Abc", async () => ({ status: 200, location: undefined }))).toBeNull();
    expect(await resolveShareLink("https://163cn.tv/Abc", async () => { throw new Error("boom"); })).toBeNull();
  });
});
