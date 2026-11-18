import { describe, it, expect, vi } from "vitest";
import { mapKugouSong, mapKugouSongs, mapKugouAlbums, mapKugouPlaylist, mapKugouPlaylists, krcToLrc, KugouProvider } from "./kugou.js";
import { parseLyrics } from "./netease.js";

describe("KugouProvider.getSongUrl failure diagnostics", () => {
  const id = "b3a52a7a958bf0aed0efbba2e9a818b7|32100650|966846";
  const provider = () => {
    const p = new KugouProvider();
    p.setCookie("dfid=test-device");
    return { bot: p, http: p as unknown as { request: (...args: unknown[]) => Promise<unknown> } };
  };

  it("distinguishes a provider verification response from a missing stream", async () => {
    const { bot, http } = provider();
    vi.spyOn(http, "request").mockResolvedValue({ status: 0, errcode: 20028 });
    await expect(bot.getSongUrl(id)).rejects.toMatchObject({
      failure: { code: "provider_verification_required", upstream: { code: 20028 } },
    });
  });

  it("carries only safe status fields on a failed HTTP request", async () => {
    const { bot, http } = provider();
    vi.spyOn(http, "request").mockRejectedValue({ response: { status: 503, data: { hidden: "test-cookie" } } });
    await expect(bot.getSongUrl(id)).rejects.toMatchObject({
      failure: { code: "upstream_request_failed", upstream: { httpStatus: 503 } },
    });
  });
});

describe("mapKugouSongs", () => {
  it("maps the mobile-search song shape to a Song with platform 'kugou'", () => {
    // Shape captured live from mobilecdn.kugou.com/api/v3/search/song.
    const raw = {
      hash: "B3A52A7A958BF0AED0EBFBA2E9A818B7",
      album_audio_id: 32100650,
      album_id: "966846",
      songname: "晴天",
      singername: "周杰伦",
      duration: 269,
    };
    const [song] = mapKugouSongs([raw]);
    expect(song.platform).toBe("kugou");
    expect(song.name).toBe("晴天");
    expect(song.artist).toBe("周杰伦");
    expect(song.duration).toBe(269);
    // The id must round-trip hash + album_audio_id + album_id so getSongUrl
    // can resolve a stream from a search result.
    expect(song.id).toBe("b3a52a7a958bf0aed0ebfba2e9a818b7|32100650|966846");
  });

  it("treats nested audio_info durations as milliseconds and flat search durations as seconds", () => {
    // List endpoints: ms under audio_info.
    expect(mapKugouSong({ audio_info: { hash: "abc", duration: 215000 } }).duration).toBe(215);
    // Search endpoint: a long-form track's flat `duration` stays seconds (no /1000).
    expect(mapKugouSong({ hash: "abc", songname: "x", duration: 10800 }).duration).toBe(10800);
  });

  it("falls back to splitting '歌手 - 歌名' from the filename", () => {
    const song = mapKugouSong({ FileHash: "deadbeef", filename: "周杰伦 - 稻香", Duration: 200 });
    expect(song.artist).toBe("周杰伦");
    expect(song.name).toBe("稻香");
  });

  it("uses PascalCase fields from the gateway shape and skips entries with no hash", () => {
    const songs = mapKugouSongs([
      { FileHash: "aa", SongName: "n", SingerName: "s", MixSongID: 1, AlbumID: 2 },
      { songname: "no hash" } as any,
    ]);
    expect(songs).toHaveLength(1);
    expect(songs[0].id).toBe("aa|1|2");
  });

  it("returns [] for non-array input", () => {
    expect(mapKugouSongs(undefined)).toEqual([]);
  });

  it("maps the NESTED album/playlist track shape (base + audio_info)", () => {
    // Shape captured live from /album/songs (叶惠美).
    const raw = {
      base: { album_id: 966846, album_audio_id: 32100648, audio_name: "以父之名", author_name: "周杰伦" },
      audio_info: { hash: "DBC0207490EB51153EF933EF5A7E98E4", duration: 342047 },
    };
    const [song] = mapKugouSongs([raw]);
    expect(song.name).toBe("以父之名");
    expect(song.artist).toBe("周杰伦");
    expect(song.duration).toBe(342); // ms → s
    expect(song.id).toBe("dbc0207490eb51153ef933ef5a7e98e4|32100648|966846");
  });
});

describe("krcToLrc", () => {
  it("converts KRC [startMs,durMs] line timestamps + strips word timings into parseable LRC", () => {
    // Shape captured live from lyrics.kugou.com (周杰伦 - 晴天).
    const krc = [
      "[ti:晴天]",
      "[ar:周杰伦]",
      "[0,2250]<0,160,0>晴<160,160,0>天",
      "[63000,1800]<0,200,0>故<200,200,0>事",
    ].join("\n");
    const lrc = krcToLrc(krc);
    expect(lrc).toContain("[00:00.00]晴天");
    expect(lrc).toContain("[01:03.00]故事");
    expect(lrc).not.toMatch(/<\d+,\d+,\d+>/); // word timings stripped

    // And the shared LRC parser must now actually produce timed lines.
    const lines = parseLyrics(lrc);
    expect(lines.length).toBe(2);
    expect(lines[0]).toEqual({ time: 0, text: "晴天" });
    expect(lines[1].time).toBe(63);
    expect(lines[1].text).toBe("故事");
  });
});

describe("mapKugouAlbums", () => {
  it("maps album shape and normalises {size} covers to https", () => {
    const [album] = mapKugouAlbums([
      { album_id: 966846, album_name: "叶惠美", singername: "周杰伦", sizable_cover: "http://imge.kugou.com/x/{size}/abc.jpg", songcount: 11 },
    ]);
    expect(album.platform).toBe("kugou");
    expect(album.id).toBe("966846");
    expect(album.name).toBe("叶惠美");
    expect(album.coverUrl).toBe("https://imge.kugou.com/x/240/abc.jpg");
    expect(album.songCount).toBe(11);
  });
});

describe("mapKugouSong — playlist (get_other_list_file) shape", () => {
  it("splits the combined `name` and uses `mixsongid` as the audio id", () => {
    // Shape captured live from /pubsongs/v2/get_other_list_file_nofilt (我喜欢).
    // The combined "歌手 - 歌名" is in `name`; there is no separate songname.
    const raw = {
      name: "KOKIA - ありがとう… (谢谢…)",
      hash: "E9A08A98614DD992F11A68A5E5F1C79F",
      album_id: "1491689",
      mixsongid: 37533796,
      timelen: 248528, // ms
      cover: "http://imge.kugou.com/stdmusic/{size}/20210113/x.jpg",
    };
    const song = mapKugouSong(raw);
    expect(song.artist).toBe("KOKIA");
    expect(song.name).toBe("ありがとう… (谢谢…)");
    // hash lowercased | mixsongid | album_id — so getSongUrl can resolve it.
    expect(song.id).toBe("e9a08a98614dd992f11a68a5e5f1c79f|37533796|1491689");
    expect(song.duration).toBe(249); // timelen ms → s
    expect(song.coverUrl).toBe("https://imge.kugou.com/stdmusic/240/20210113/x.jpg");
  });
});

describe("mapKugouSong — cover art per endpoint", () => {
  it("reads `sizable_cover` (daily/FM shape) and resolves {size}→240, http→https", () => {
    const song = mapKugouSong({
      hash: "abc",
      songname: "x",
      duration: 200,
      sizable_cover: "http://imge.kugou.com/stdmusic/{size}/y.jpg",
    });
    expect(song.coverUrl).toBe("https://imge.kugou.com/stdmusic/240/y.jpg");
  });

  it("falls back to `trans_param.union_cover` (search shape, no top-level cover)", () => {
    const song = mapKugouSong({
      hash: "abc",
      songname: "x",
      duration: 200,
      trans_param: { union_cover: "http://imge.kugou.com/stdmusic/{size}/z.jpg" },
    });
    expect(song.coverUrl).toBe("https://imge.kugou.com/stdmusic/240/z.jpg");
  });

  it("returns an empty coverUrl when no cover field is present", () => {
    expect(mapKugouSong({ hash: "abc", songname: "x", duration: 200 }).coverUrl).toBe("");
  });

  it("skips an empty-string cover field (Kugou returns '') and uses the next non-empty source", () => {
    const song = mapKugouSong({
      hash: "abc",
      songname: "x",
      duration: 200,
      sizable_cover: "", // present but empty — must NOT mask the real cover below
      trans_param: { union_cover: "http://imge.kugou.com/stdmusic/{size}/z.jpg" },
    });
    expect(song.coverUrl).toBe("https://imge.kugou.com/stdmusic/240/z.jpg");
  });
});

describe("mapKugouPlaylists", () => {
  it("maps the user-playlist shape (/v7/get_all_list info), keying id on global_collection_id", () => {
    // Shape captured live from /v7/get_all_list (我喜欢).
    const [pl] = mapKugouPlaylists([
      { name: "我喜欢", count: 7, global_collection_id: "collection_3_2526507197_2_0", listid: 2, type: 0 },
    ]);
    expect(pl.platform).toBe("kugou");
    expect(pl.name).toBe("我喜欢");
    expect(pl.songCount).toBe(7);
    // Must be the global_collection_id — the only id getPlaylistSongs can open.
    expect(pl.id).toBe("collection_3_2526507197_2_0");
  });

  it("maps the recommend shape (/v2/special_recommend), preferring global_collection_id over specialid", () => {
    // Shape captured live from /v2/special_recommend special_list.
    const pl = mapKugouPlaylist({
      specialname: "米津玄师：蒙着眼睛也能炸翻全场",
      specialid: 1154672,
      global_collection_id: "collection_1_1029965246_1154672_0",
      pic: "http://imge.kugou.com/specialimg/{size}/a.jpg",
      percount: 0,
    });
    expect(pl.id).toBe("collection_1_1029965246_1154672_0");
    expect(pl.name).toBe("米津玄师：蒙着眼睛也能炸翻全场");
    expect(pl.coverUrl).toBe("https://imge.kugou.com/specialimg/240/a.jpg");
  });

  it("drops entries whose only id is a non-openable specialid/listid (not a global_collection_id)", () => {
    // getPlaylistSongs can only open a global_collection_id, so a numeric
    // specialid/listid would be a dead id — such entries must be dropped.
    expect(mapKugouPlaylists([{ specialname: "x", specialid: 1154672, listid: 9 }])).toHaveLength(0);
    expect(mapKugouPlaylists([{ name: "no id" }])).toHaveLength(0);
    expect(mapKugouPlaylists(undefined)).toEqual([]);
  });
});

describe("KugouProvider.search pagination", () => {
  function mockProvider() {
    const p = new KugouProvider();
    const get = vi.fn().mockResolvedValue({ data: { data: { info: [] } } });
    (p as any).mobileHttp = { get };
    return { p, get };
  }

  function searchParams(get: ReturnType<typeof vi.fn>) {
    const call = get.mock.calls[0];
    expect(call, "expected a mobile search call").toBeTruthy();
    return call[1].params as Record<string, unknown>;
  }

  it("sets page to offset/limit+1 and keeps pagesize=limit", async () => {
    const { p, get } = mockProvider();
    await p.search("hello", 20, 20); // page 2
    const params = searchParams(get);
    expect(params.page).toBe(2);
    expect(params.pagesize).toBe(20);
  });

  it("defaults offset to 0 → page 1 (backward compatible)", async () => {
    const { p, get } = mockProvider();
    await p.search("hello", 20);
    expect(searchParams(get).page).toBe(1);
  });
});
