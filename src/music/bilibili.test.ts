import { describe, it, expect, vi } from "vitest";
import { BiliBiliProvider, pickStableAudioUrl } from "./bilibili.js";

describe("BiliBiliProvider.search pagination", () => {
  function mockProvider() {
    const p = new BiliBiliProvider();
    const get = vi.fn().mockResolvedValue({ data: { data: { result: [] } } });
    // Short-circuit the buvid + wbi bootstrap so search only issues the
    // /search/type request we want to inspect.
    (p as any).buvidInitialized = true;
    (p as any).wbiMixinKey = "0".repeat(32);
    (p as any).wbiKeyFetchedAt = Date.now();
    (p as any).api = { get };
    return { p, get };
  }

  function searchParams(get: ReturnType<typeof vi.fn>) {
    const call = get.mock.calls.find(
      (c: any[]) => c[0] === "/x/web-interface/wbi/search/type"
    );
    expect(call, "expected a /search/type call").toBeTruthy();
    // signWbi stringifies every value.
    return call![1].params as Record<string, string>;
  }

  it("adds page (offset/limit+1) alongside page_size", async () => {
    const { p, get } = mockProvider();
    await p.search("hello", 20, 20); // page 2
    const params = searchParams(get);
    expect(params.page).toBe("2");
    expect(params.page_size).toBe("20");
  });

  it("defaults offset to 0 → page 1 (backward compatible)", async () => {
    const { p, get } = mockProvider();
    await p.search("hello", 20);
    expect(searchParams(get).page).toBe("1");
  });
});

describe("BiliBiliProvider multi-P support", () => {
  it("parseBilibiliId extracts bvid and page correctly", async () => {
    const { parseBilibiliId } = await import("./bilibili.js");
    expect(parseBilibiliId("BV1yxHQeYEuE")).toEqual({ bvid: "BV1yxHQeYEuE", page: 1 });
    expect(parseBilibiliId("BV1yxHQeYEuE?p=3")).toEqual({ bvid: "BV1yxHQeYEuE", page: 3 });
    expect(parseBilibiliId("BV1yxHQeYEuE:p2")).toEqual({ bvid: "BV1yxHQeYEuE", page: 2 });
    expect(parseBilibiliId("https://www.bilibili.com/video/BV1yxHQeYEuE?p=5")).toEqual({
      bvid: "BV1yxHQeYEuE",
      page: 5,
    });
    expect(parseBilibiliId("some-other-id")).toEqual({ bvid: "some-other-id", page: 1 });
  });

  function mockViewProvider(viewData: any, playUrlData?: any) {
    const p = new BiliBiliProvider();
    const get = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (url === "/x/web-interface/view") {
        return Promise.resolve({ data: { data: viewData } });
      }
      if (url === "/x/player/playurl") {
        return Promise.resolve({ data: { data: playUrlData ?? {} } });
      }
      return Promise.resolve({ data: {} });
    });
    (p as any).buvidInitialized = true;
    (p as any).api = { get };
    return { p, get };
  }

  const multiPViewData = {
    bvid: "BV1multiP",
    title: "测试多P教程",
    pic: "http://i0.hdslb.com/bfs/archive/test.jpg",
    duration: 300, // 总时长 300 秒 (120 + 180)
    owner: { name: "UP主测试" },
    pages: [
      { cid: 10001, page: 1, part: "第一讲 入门", duration: 120 },
      { cid: 10002, page: 2, part: "第二讲 进阶", duration: 180 },
    ],
  };

  const singlePViewData = {
    bvid: "BV1singleP",
    title: "测试单P视频",
    pic: "http://i0.hdslb.com/bfs/archive/single.jpg",
    duration: 200,
    owner: { name: "UP主测试" },
    pages: [
      { cid: 20001, page: 1, part: "测试单P视频", duration: 200 },
    ],
  };

  it("getSongDetail for single-P video returns total duration and clean bvid", async () => {
    const { p } = mockViewProvider(singlePViewData);
    const song = await p.getSongDetail("BV1singleP");
    expect(song).not.toBeNull();
    expect(song!.id).toBe("BV1singleP");
    expect(song!.name).toBe("测试单P视频");
    expect(song!.duration).toBe(200);
    expect(song!.platform).toBe("bilibili");
  });

  it("getSongDetail for multi-P video without ?p defaults to P1 with P1 duration", async () => {
    const { p } = mockViewProvider(multiPViewData);
    const song = await p.getSongDetail("BV1multiP");
    expect(song).not.toBeNull();
    expect(song!.id).toBe("BV1multiP?p=1");
    expect(song!.name).toBe("测试多P教程 - P1 第一讲 入门");
    expect(song!.duration).toBe(120); // P1 独立时长，而非总时长 300！
    expect(song!.platform).toBe("bilibili");
  });

  it("getSongDetail for multi-P video with ?p=2 returns P2 with P2 duration", async () => {
    const { p } = mockViewProvider(multiPViewData);
    const song = await p.getSongDetail("BV1multiP?p=2");
    expect(song).not.toBeNull();
    expect(song!.id).toBe("BV1multiP?p=2");
    expect(song!.name).toBe("测试多P教程 - P2 第二讲 进阶");
    expect(song!.duration).toBe(180); // P2 独立时长
    expect(song!.platform).toBe("bilibili");
  });

  it("getVideoParts returns all parts with duration and cid", async () => {
    const { p } = mockViewProvider(multiPViewData);
    const partsResult = await p.getVideoParts("BV1multiP");
    expect(partsResult).not.toBeNull();
    expect(partsResult!.bvid).toBe("BV1multiP");
    expect(partsResult!.title).toBe("测试多P教程");
    expect(partsResult!.parts).toHaveLength(2);
    expect(partsResult!.parts[0]).toEqual({
      part: 1,
      cid: 10001,
      title: "第一讲 入门",
      duration: 120,
    });
    expect(partsResult!.parts[1]).toEqual({
      part: 2,
      cid: 10002,
      title: "第二讲 进阶",
      duration: 180,
    });
  });

  it("getSongUrl requests playurl with correct cid for specific part", async () => {
    const playUrlResponse = {
      dash: {
        audio: [
          { bandwidth: 64000, baseUrl: "http://audio.64k.test" },
          { bandwidth: 320000, baseUrl: "http://audio.320k.test" },
        ],
      },
    };
    const { p, get } = mockViewProvider(multiPViewData, playUrlResponse);

    const result = await p.getSongUrl("BV1multiP?p=2");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("http://audio.320k.test");

    const playurlCall = get.mock.calls.find((c: any[]) => c[0] === "/x/player/playurl");
    expect(playurlCall).toBeTruthy();
    expect(playurlCall![1].params.cid).toBe(10002); // 准确传入 P2 的 cid
    expect(playurlCall![1].params.bvid).toBe("BV1multiP"); // 纯净 bvid
  });
});

describe("pickStableAudioUrl (#161 long streams dying mid-play)", () => {
  const pcdn = "https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/upgcxcode/1/2/3/3-1-30280.m4s?e=x&deadline=1";
  const szbdyd = "https://cn-hk-eq-01-01.szbdyd.com/upgcxcode/1/2/3/3-1-30280.m4s?deadline=1";
  const upos = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/1/2/3/3-1-30280.m4s?deadline=1";
  const upos2 = "https://upos-sz-mirror08c.bilivideo.com/upgcxcode/1/2/3/3-1-30280.m4s?deadline=1";

  it("prefers an upos/cos mirror over a PCDN baseUrl", () => {
    expect(pickStableAudioUrl({ baseUrl: pcdn, backupUrl: [szbdyd, upos] })).toBe(upos);
  });

  it("keeps the baseUrl when it is already a stable host", () => {
    expect(pickStableAudioUrl({ baseUrl: upos, backupUrl: [upos2] })).toBe(upos);
  });

  it("accepts the snake_case field names", () => {
    expect(pickStableAudioUrl({ base_url: pcdn, backup_url: [upos2] })).toBe(upos2);
  });

  it("falls back to the baseUrl when every candidate is PCDN", () => {
    expect(pickStableAudioUrl({ baseUrl: pcdn, backupUrl: [szbdyd] })).toBe(pcdn);
  });

  it("allows a refreshed URL from the same host if no alternative is available", () => {
    const host = new URL(upos).hostname;
    expect(pickStableAudioUrl({ baseUrl: upos }, new Set([host]))).toBe(upos);
  });

  it("returns undefined when there is no url at all", () => {
    expect(pickStableAudioUrl({})).toBeUndefined();
  });

  it("getSongUrl returns the stable mirror of the best stream", async () => {
    const p = new BiliBiliProvider();
    (p as any).cidCache.set("BV1abc", 42);
    (p as any).api = {
      get: vi.fn().mockResolvedValue({
        data: { data: { dash: { audio: [
          { bandwidth: 64000, baseUrl: "https://upos-sz-mirrorcos.bilivideo.com/low.m4s" },
          { bandwidth: 320000, baseUrl: pcdn, backupUrl: [upos] },
        ] } } },
      }),
    };
    expect((await p.getSongUrl("BV1abc"))?.url).toBe(upos);
  });
});
