/**
 * Kugou Music (酷狗音乐) provider.
 *
 * A self-contained provider (bilibili-style: direct API calls, no embedded API
 * server, no extra npm dependency). The request signing / device registration /
 * KRC lyric decoding are ported from the MIT-licensed reference implementation
 * `MakcRe/KuGouMusicApi` (Copyright (c) 2023 MakcRe), reimplemented here with
 * Node's built-in `crypto` and `zlib` so no third-party crypto packages are
 * pulled in.
 *
 * VERIFICATION NOTE: search and lyrics were verified live during development.
 * The play-URL endpoint (`/v5/url`) is gated by Kugou's risk-control and may
 * return `errcode 20028 "本次请求需要验证"` from flagged (datacenter) IPs even
 * for free songs; on such hosts a logged-in session (QR login below) and/or a
 * residential IP is required. QR login and VIP audio could not be verified in
 * the build environment.
 */
import { normalizeCookie } from "./cookie-normalize.js";
import axios, { type AxiosInstance } from "axios";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { parseLyrics } from "./netease.js";
import type {
  Album,
  AuthStatus,
  LyricLine,
  MusicProvider,
  Playlist,
  PlaylistDetail,
  QrCodeResult,
  SearchResult,
  Song,
  SongUrlResult,
} from "./provider.js";

// ---------------------------------------------------------------------------
// Constants (util/config.json + util/helper.js salts)
// ---------------------------------------------------------------------------
const APPID = 1005;
const CLIENTVER = 20489;
const SRCAPPID = 2919;
const USER_AGENT = "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi";

const SALT_ANDROID = "OIlwieks28dk2k092lksi2UIkp";
const SALT_WEB = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
const SALT_SIGNKEY = "57ae12eb6890223e355ccfcb74edf70d";

// RSA public key used by the reference for /register/dev (`rsaEncrypt2`).
const RSA_PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\n" +
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/g" +
  "bjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1" +
  "+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6D" +
  "JE5E221wf/4WLFxwAtRQIDAQAB\n" +
  "-----END PUBLIC KEY-----";

// KRC lyric XOR key (util/util.js decodeLyrics).
const KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];

const QUALITY_MAP: Record<string, string> = {
  standard: "128",
  higher: "320",
  exhigh: "320",
  lossless: "flac",
  hires: "high",
  "128": "128",
  "320": "320",
  flac: "flac",
  high: "high",
};

// ---------------------------------------------------------------------------
// Crypto / signing primitives (ported from util/crypto.js + util/helper.js)
// ---------------------------------------------------------------------------
function md5(input: string | Buffer): string {
  return crypto.createHash("md5").update(input).digest("hex");
}

function randomString(len = 16): string {
  const pool = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < len; i++) out += pool[Math.floor(Math.random() * pool.length)];
  return out;
}

function getGuid(): string {
  const e = () => (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
  return `${e()}${e()}-${e()}-${e()}-${e()}-${e()}${e()}${e()}`;
}

/** MID = decimal string of the MD5 hex digest interpreted as a base-16 bigint. */
function calculateMid(str: string): string {
  const digest = md5(str);
  let acc = 0n;
  for (const ch of digest) acc = acc * 16n + BigInt(parseInt(ch, 16));
  return acc.toString();
}

/** Android request signature: md5(salt + sorted(k=v...) + body + salt). */
function signatureAndroid(params: Record<string, unknown>, data = ""): string {
  const s = Object.keys(params)
    .sort()
    .map((k) => {
      const v = params[k];
      return `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`;
    })
    .join("");
  return md5(`${SALT_ANDROID}${s}${data}${SALT_ANDROID}`);
}

/** Web request signature (QR login): md5(salt + sort("k=v") + salt). */
function signatureWeb(params: Record<string, unknown>): string {
  const s = Object.keys(params)
    .map((k) => `${k}=${params[k]}`)
    .sort()
    .join("");
  return md5(`${SALT_WEB}${s}${SALT_WEB}`);
}

/** key param for /song/url: md5(hash + salt + appid + mid + userid). */
function signKey(hash: string, mid: string, userid: string | number, appid: number): string {
  return md5(`${hash}${SALT_SIGNKEY}${appid}${mid}${userid || 0}`);
}

/** sign param for personal-fm etc: md5(appid + salt + clientver + data). */
function signParamsKey(data: string | number): string {
  return md5(`${APPID}${SALT_ANDROID}${CLIENTVER}${data}`);
}

/** AES-128-CBC/Pkcs7, key/iv derived from md5 of a random 6-char string. */
function playlistAesEncrypt(obj: unknown): { key: string; str: string } {
  const key = randomString(6).toLowerCase();
  const digest = md5(key);
  const encKey = digest.substring(0, 16);
  const iv = digest.substring(16, 32);
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(encKey, "utf8"), Buffer.from(iv, "utf8"));
  const plain = typeof obj === "object" ? JSON.stringify(obj) : String(obj);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { key, str: enc.toString("base64") };
}

function playlistAesDecrypt(strBase64: string, key: string): unknown {
  const digest = md5(key);
  const encKey = digest.substring(0, 16);
  const iv = digest.substring(16, 32);
  const decipher = crypto.createDecipheriv("aes-128-cbc", Buffer.from(encKey, "utf8"), Buffer.from(iv, "utf8"));
  const dec = Buffer.concat([decipher.update(Buffer.from(strBase64, "base64")), decipher.final()]);
  const text = dec.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** RSAES-PKCS1-v1_5 with the bundled public key; hex output (rsaEncrypt2). */
function rsaEncrypt2(obj: unknown): string {
  const plain = Buffer.from(typeof obj === "object" ? JSON.stringify(obj) : String(obj), "utf8");
  const enc = crypto.publicEncrypt(
    { key: RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    plain,
  );
  return enc.toString("hex");
}

/** Decode a base64 KRC lyric blob: drop 4-byte header, XOR, zlib-inflate. */
function decodeKrc(base64: string): string {
  try {
    const bytes = Buffer.from(base64, "base64").subarray(4);
    const out = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ KRC_KEY[i % KRC_KEY.length];
    return zlib.inflateSync(out).toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Convert a decoded KRC lyric to standard LRC so the shared parseLyrics() can
 * read it. KRC line timestamps are `[startMs,durationMs]` (not `[mm:ss.xx]`)
 * and each line carries inline `<offset,dur,0>` word timings that must be
 * stripped. Metadata tags like `[ti:...]` are passed through (parseLyrics
 * ignores them).
 */
export function krcToLrc(krc: string): string {
  return krc
    .split("\n")
    .map((line) => {
      const m = line.match(/^\[(\d+),(\d+)\](.*)$/);
      if (m) {
        const startMs = Number(m[1]);
        const mm = Math.floor(startMs / 60000);
        const ss = Math.floor((startMs % 60000) / 1000);
        const cs = Math.floor((startMs % 1000) / 10);
        const ts = `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}]`;
        return ts + m[3].replace(/<\d+,\d+,\d+>/g, "");
      }
      return line.replace(/<\d+,\d+,\d+>/g, "");
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Composite song id: Kugou needs both `hash` and `album_audio_id` (+album_id)
// to resolve a stream, so the provider encodes all three into Song.id.
// ---------------------------------------------------------------------------
function makeId(hash: string, albumAudioId: string | number, albumId: string | number): string {
  return `${(hash || "").toLowerCase()}|${albumAudioId || 0}|${albumId || 0}`;
}
function parseId(id: string): { hash: string; albumAudioId: string; albumId: string } {
  const [hash = "", albumAudioId = "0", albumId = "0"] = (id || "").split("|");
  return { hash, albumAudioId, albumId };
}

// ---------------------------------------------------------------------------
// Pure mappers (exported for unit testing — mirror qq.ts / netease.ts pattern)
// ---------------------------------------------------------------------------
interface KugouRawSong {
  hash?: string;
  FileHash?: string;
  SQFileHash?: string;
  sqhash?: string;
  album_audio_id?: number | string;
  album_id?: number | string;
  AlbumID?: number | string;
  MixSongID?: number | string;
  songname?: string;
  SongName?: string;
  filename?: string;
  FileName?: string;
  singername?: string;
  SingerName?: string;
  album_name?: string;
  AlbumName?: string;
  duration?: number;
  Duration?: number;
  timelen?: number;
  // Playlist (/pubsongs/.../get_other_list_file) shape: a single combined
  // "歌手 - 歌名" lives in `name`, with `mixsongid`/`audio_id` as the audio id.
  name?: string;
  mixsongid?: number | string;
  audio_id?: number | string;
  albuminfo?: { name?: string };
  // Cover art lives in different fields per endpoint: `sizable_cover` (daily/FM,
  // a `{size}` template), `cover` (playlist), or `trans_param.union_cover`
  // (search). All may carry a `{size}` placeholder that fixCover() resolves.
  sizable_cover?: string;
  album_sizable_cover?: string;
  cover?: string;
  trans_param?: { union_cover?: string };
}

/** Split a Kugou "歌手 - 歌名" filename into {artist,name} when needed. */
function splitFilename(filename: string): { name: string; artist: string } {
  const idx = filename.indexOf(" - ");
  if (idx < 0) return { name: filename.trim(), artist: "" };
  return { artist: filename.slice(0, idx).trim(), name: filename.slice(idx + 3).trim() };
}

/** Album/playlist/FM list endpoints nest fields under base/audio_info. */
interface KugouNestedTrack extends KugouRawSong {
  base?: { album_id?: number | string; album_audio_id?: number | string; audio_name?: string; author_name?: string; album_name?: string };
  audio_info?: { hash?: string; duration?: number; timelength?: number };
  album_info?: { album_name?: string };
}

export function mapKugouSong(raw: KugouNestedTrack): Song {
  const base = raw.base ?? {};
  const audioInfo = raw.audio_info ?? {};
  // Handle both the flat search shape and the nested album/playlist/FM shape.
  const hash = String(raw.hash ?? raw.FileHash ?? audioInfo.hash ?? "").toLowerCase();
  const albumAudioId = raw.album_audio_id ?? raw.MixSongID ?? raw.mixsongid ?? raw.audio_id ?? base.album_audio_id ?? 0;
  const albumId = raw.album_id ?? raw.AlbumID ?? base.album_id ?? 0;
  // The playlist endpoint packs "歌手 - 歌名" into `name` (no separate
  // songname/singername), so treat it like `filename` and split it.
  const fallback = splitFilename(raw.filename ?? raw.FileName ?? raw.name ?? "");
  // Use firstStr (not `??`) so an empty-string field doesn't mask a real value
  // in a later one.
  const name = firstStr(raw.songname, raw.SongName, base.audio_name, fallback.name).trim();
  const artist = firstStr(raw.singername, raw.SingerName, base.author_name, fallback.artist).trim();
  // Determine duration by SOURCE, not magnitude: the search endpoint reports
  // `duration` in SECONDS, while the nested album/playlist `audio_info` reports
  // milliseconds (a magnitude heuristic would mis-handle multi-hour tracks).
  let duration: number;
  if (audioInfo.duration != null) duration = Math.round(Number(audioInfo.duration) / 1000);
  else if (audioInfo.timelength != null) duration = Math.round(Number(audioInfo.timelength) / 1000);
  else if (raw.timelen != null) duration = Math.round(Number(raw.timelen) / 1000); // ms
  else duration = Number(raw.duration ?? raw.Duration ?? 0) || 0; // seconds
  if (!Number.isFinite(duration) || duration < 0) duration = 0;
  // Cover art is endpoint-specific: `sizable_cover` (daily/FM), `cover`
  // (playlist), or `trans_param.union_cover` (search). firstStr skips empty
  // fields; fixCover resolves the `{size}` template + upgrades http→https.
  const coverUrl = fixCover(
    firstStr(raw.sizable_cover, raw.album_sizable_cover, raw.cover, raw.trans_param?.union_cover)
  );
  return {
    id: makeId(hash, albumAudioId, albumId),
    name: name || "未知歌曲",
    artist: artist || "未知歌手",
    album: firstStr(raw.album_name, raw.AlbumName, base.album_name, raw.album_info?.album_name, raw.albuminfo?.name),
    duration,
    coverUrl,
    platform: "kugou",
  };
}

export function mapKugouSongs(list: KugouNestedTrack[] | undefined): Song[] {
  if (!Array.isArray(list)) return [];
  // Drop entries that yield no hash (the first id segment) regardless of shape.
  return list.map(mapKugouSong).filter((s) => s.id.split("|")[0] !== "");
}

interface KugouRawAlbum {
  albumid?: number | string;
  album_id?: number | string;
  AlbumID?: number | string;
  albumname?: string;
  album_name?: string;
  AlbumName?: string;
  singername?: string;
  SingerName?: string;
  author_name?: string;
  imgurl?: string;
  sizable_cover?: string;
  songcount?: number;
  song_count?: number;
}

function fixCover(url: string | undefined): string {
  if (!url) return "";
  return url.replace(/\{size\}/g, "240").replace(/^http:/, "https:");
}

/** First non-empty string among the candidates. Unlike `??`, an empty string —
 *  which Kugou returns for absent cover/name fields — is treated as missing, so
 *  a real value in a later field isn't masked by an earlier `""`. */
function firstStr(...vals: Array<string | number | undefined | null>): string {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v);
    if (s !== "") return s;
  }
  return "";
}

export function mapKugouAlbum(raw: KugouRawAlbum): Album {
  return {
    id: String(raw.albumid ?? raw.album_id ?? raw.AlbumID ?? ""),
    name: (raw.albumname ?? raw.album_name ?? raw.AlbumName ?? "").toString(),
    artist: (raw.singername ?? raw.SingerName ?? raw.author_name ?? "").toString(),
    coverUrl: fixCover(raw.sizable_cover ?? raw.imgurl),
    songCount: Number(raw.songcount ?? raw.song_count ?? 0) || 0,
    platform: "kugou",
  };
}

export function mapKugouAlbums(list: KugouRawAlbum[] | undefined): Album[] {
  if (!Array.isArray(list)) return [];
  return list.map(mapKugouAlbum);
}

// Playlist shapes differ by endpoint (user lists vs special_recommend), so map
// defensively. The id MUST be the `global_collection_id` because that is the
// only key getPlaylistSongs()/getPlaylistDetail() can open a playlist by.
interface KugouRawPlaylist {
  global_collection_id?: string;
  gid?: string | number;
  specialid?: string | number;
  listid?: string | number;
  id?: string | number;
  name?: string;
  specialname?: string;
  list_name?: string;
  pic?: string;
  imgurl?: string;
  flexible_cover?: string;
  cover?: string;
  img?: string;
  count?: number | string;
  songcount?: number | string;
  song_count?: number | string;
  total?: number | string;
  // Present in real payloads but not used for mapping (kept for shape fidelity):
  // `percount` is special_recommend's (unreliable, often 0) song count; `type`
  // is the list kind in get_all_list.
  percount?: number | string;
  type?: number | string;
}

export function mapKugouPlaylist(raw: KugouRawPlaylist): Playlist {
  // The id MUST be the `global_collection_id` (the `collection_*` form) — it is
  // the ONLY key getPlaylistSongs()/getPlaylistDetail() can open a playlist by.
  // A numeric `specialid`/`listid`/`id` is NOT openable, so it must NOT become
  // the id (mapKugouPlaylists drops entries that resolve to ""). `gid` is the
  // common alias for the same collection key in some list shapes.
  const id = String(raw.global_collection_id ?? raw.gid ?? "");
  const name = firstStr(raw.name, raw.specialname, raw.list_name).trim();
  return {
    id,
    name: name || "未知歌单",
    coverUrl: fixCover(firstStr(raw.pic, raw.imgurl, raw.flexible_cover, raw.cover, raw.img)),
    songCount: Number(raw.count ?? raw.songcount ?? raw.song_count ?? raw.total ?? 0) || 0,
    platform: "kugou",
  };
}

export function mapKugouPlaylists(list: KugouRawPlaylist[] | undefined): Playlist[] {
  if (!Array.isArray(list)) return [];
  // Drop entries with no resolvable global_collection_id (can't be opened).
  return list.map(mapKugouPlaylist).filter((p) => p.id !== "");
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
type CookieMap = Record<string, string>;

export class KugouProvider implements MusicProvider {
  readonly platform = "kugou" as const;

  private readonly http: AxiosInstance;
  private readonly mobileHttp: AxiosInstance;
  private quality = "128";

  // Device identity (generated once) + login cookies (persisted via CookieStore).
  private guid = "";
  private mid = "";
  private cookie: CookieMap = {};
  private dfidPromise: Promise<void> | null = null;

  constructor() {
    this.http = axios.create({ timeout: 10000 });
    this.mobileHttp = axios.create({ timeout: 10000, headers: { "User-Agent": USER_AGENT } });
    this.ensureDevice();
  }

  private ensureDevice(): void {
    if (this.guid) return;
    this.guid = md5(getGuid());
    this.mid = calculateMid(this.guid);
  }

  // --- Cookie persistence (CookieStore stores a flat "k=v; k=v" string) ------
  setCookie(cookie: string): void {
    const map: CookieMap = {};
    // Normalise first: a pasted `Set-Cookie` line would otherwise land
    // Max-Age/Expires/Path in the map as cookie names.
    for (const part of normalizeCookie(cookie).split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k) map[k] = v;
    }
    this.cookie = map;
    if (map.dfid) {
      /* keep registered device */
    }
  }

  getCookie(): string {
    return Object.entries(this.cookie)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  setQuality(quality: string): void {
    this.quality = QUALITY_MAP[quality] ?? "128";
  }
  getQuality(): string {
    return this.quality;
  }

  // --- Shared signed request pipeline (mirrors util/request.js) --------------
  private async request(opts: {
    method: "GET" | "POST";
    url: string;
    baseURL?: string;
    params?: Record<string, unknown>;
    data?: unknown;
    xRouter?: string;
    encryptType?: "android" | "web";
    encryptKey?: boolean;
    clearDefaultParams?: boolean;
    extraHeaders?: Record<string, string>;
    responseType?: "json" | "arraybuffer";
    /** Per-request device-fingerprint override (e.g. /v5/url uses a random one
     *  when no real dfid has been registered, mirroring the reference). */
    dfid?: string;
  }): Promise<any> {
    this.ensureDevice();
    const dfid = opts.dfid || this.cookie.dfid || "-";
    const token = this.cookie.token || "";
    const userid = this.cookie.userid || "0";
    const clienttime = Math.floor(Date.now() / 1000);

    const defaults: Record<string, unknown> = {
      dfid,
      mid: this.mid,
      uuid: "-",
      appid: APPID,
      clientver: CLIENTVER,
      clienttime,
    };
    if (token) defaults.token = token;
    if (userid && userid !== "0") defaults.userid = userid;

    const params: Record<string, unknown> = opts.clearDefaultParams
      ? { ...(opts.params ?? {}) }
      : { ...defaults, ...(opts.params ?? {}) };

    if (opts.encryptKey) {
      params.key = signKey(String(params.hash ?? ""), this.mid, userid, APPID);
    }

    const body = Buffer.isBuffer(opts.data)
      ? opts.data
      : typeof opts.data === "object" && opts.data !== null
        ? JSON.stringify(opts.data)
        : (opts.data ?? "");

    if (params.signature === undefined) {
      params.signature =
        opts.encryptType === "web" ? signatureWeb(params) : signatureAndroid(params, typeof body === "string" ? body : "");
    }

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      dfid,
      clienttime: String(clienttime),
      mid: this.mid,
      "kg-rc": "1",
      "kg-thash": "5d816a0",
      "kg-rec": "1",
      "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
      ...(opts.xRouter ? { "x-router": opts.xRouter } : {}),
      ...(opts.extraHeaders ?? {}),
    };

    const res = await this.http.request({
      method: opts.method,
      baseURL: opts.baseURL ?? "https://gateway.kugou.com",
      url: opts.url,
      params,
      data: opts.data,
      headers,
      responseType: opts.responseType ?? "json",
    });
    return res.data;
  }

  /** Register a device fingerprint to obtain a `dfid` (required by /song/url). */
  private async ensureDfid(): Promise<void> {
    if (this.cookie.dfid) return;
    if (!this.dfidPromise) {
      this.dfidPromise = this.registerDev().catch(() => {
        /* swallow — handled below */
      });
    }
    await this.dfidPromise;
    // registerDev resolves WITHOUT throwing on a soft failure (HTTP 200 with an
    // in-body status!=1, e.g. risk-control), so a thrown-only retry would cache
    // the failure forever. Clear the memo whenever no dfid was obtained.
    if (!this.cookie.dfid) this.dfidPromise = null;
  }

  private async registerDev(): Promise<void> {
    const dataMap = {
      availableRamSize: 4983533568,
      availableRomSize: 48114719,
      availableSDSize: 48114717,
      basebandVer: "",
      batteryLevel: 100,
      batteryStatus: 3,
      brand: "Redmi",
      buildSerial: "unknown",
      device: "marble",
      imei: this.guid,
      imsi: "",
      manufacturer: "Xiaomi",
      uuid: this.guid,
      accelerometer: false,
      accelerometerValue: "",
      gravity: false,
      gravityValue: "",
      gyroscope: false,
      gyroscopeValue: "",
      light: false,
      lightValue: "",
      magnetic: false,
      magneticValue: "",
      orientation: false,
      orientationValue: "",
      pressure: false,
      pressureValue: "",
      step_counter: false,
      step_counterValue: "",
      temperature: false,
      temperatureValue: "",
    };
    const aes = playlistAesEncrypt(dataMap);
    const p = rsaEncrypt2({ aes: aes.key, uid: this.cookie.userid || 0, token: this.cookie.token || "" });
    const raw = await this.request({
      method: "POST",
      baseURL: "https://userservice.kugou.com",
      url: "/risk/v2/r_register_dev",
      params: { part: 1, platid: 1, p },
      data: aes.str,
      encryptType: "android",
      responseType: "arraybuffer",
    });
    const decoded = playlistAesDecrypt(Buffer.from(raw).toString("base64"), aes.key) as {
      status?: number;
      data?: { dfid?: string };
    };
    if (decoded?.status === 1 && decoded.data?.dfid) {
      this.cookie.dfid = decoded.data.dfid;
    }
  }

  // --- Search (verified live via the unsigned mobile endpoint) ---------------
  async search(query: string, limit = 20, offset = 0): Promise<SearchResult> {
    const q = query.trim();
    if (!q) return { songs: [], playlists: [], albums: [] };
    try {
      // Songs only. `page` is the 1-based cursor; the web pages in limit-aligned
      // steps so offset is a multiple of pagesize.
      const page = Math.floor(offset / limit) + 1;
      const res = await this.mobileHttp.get("http://mobilecdn.kugou.com/api/v3/search/song", {
        params: { format: "json", keyword: q, page, pagesize: limit, showtype: 1 },
      });
      const info = res.data?.data?.info as KugouRawSong[] | undefined;
      return { songs: mapKugouSongs(info), playlists: [], albums: [] };
    } catch {
      return { songs: [], playlists: [], albums: [] };
    }
  }

  // --- Play URL --------------------------------------------------------------
  async getSongUrl(songId: string, quality?: string): Promise<SongUrlResult | null> {
    const { hash, albumAudioId, albumId } = parseId(songId);
    if (!hash) return null;
    await this.ensureDfid();
    const q = quality ? (QUALITY_MAP[quality] ?? this.quality) : this.quality;
    try {
      const data = await this.request({
        method: "GET",
        url: "/v5/url",
        xRouter: "trackercdn.kugou.com",
        encryptKey: true,
        // /v5/url must never present "-": use the registered dfid, else a random
        // 24-char one (matches reference module/song_url.js).
        dfid: this.cookie.dfid || randomString(24),
        params: {
          album_id: Number(albumId) || 0,
          area_code: 1,
          hash,
          ssa_flag: "is_fromtrack",
          version: 11430,
          page_id: 151369488,
          quality: q,
          album_audio_id: Number(albumAudioId) || 0,
          behavior: "play",
          pid: 2,
          cmd: 26,
          pidversion: 3001,
          IsFreePart: 0,
          ppage_id: "463467626,350369493,788954147",
          cdnBackup: 1,
          module: "",
          clientver: 11430,
        },
      });
      const urls: string[] = Array.isArray(data?.url) ? data.url : [];
      const backup: string[] = Array.isArray(data?.backupUrl) ? data.backupUrl : [];
      const url = urls.find(Boolean) || backup.find(Boolean);
      if (!url) return null;
      return { url };
    } catch {
      return null;
    }
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    const { hash, albumAudioId, albumId } = parseId(songId);
    if (!hash) return null;
    // Kugou has no cheap "detail by hash" that adds value here; return a stub so
    // queue/history have a stable id+platform (mirrors qq.ts's fallback).
    return {
      id: makeId(hash, albumAudioId, albumId),
      name: "未知歌曲",
      artist: "未知歌手",
      album: "",
      duration: 0,
      coverUrl: "",
      platform: "kugou",
    };
  }

  // --- Lyrics (verified live) ------------------------------------------------
  async getLyrics(songId: string): Promise<LyricLine[]> {
    const { hash } = parseId(songId);
    if (!hash) return [];
    try {
      const search = await this.request({
        method: "GET",
        baseURL: "https://lyrics.kugou.com",
        url: "/v1/search",
        clearDefaultParams: true,
        params: { album_audio_id: 0, appid: APPID, clientver: CLIENTVER, duration: 0, hash, keyword: "", lrctxt: 1, man: "no" },
      });
      const candidate = search?.candidates?.[0];
      if (!candidate?.id || !candidate?.accesskey) return [];
      const dl = await this.request({
        method: "GET",
        baseURL: "https://lyrics.kugou.com",
        url: "/download",
        clearDefaultParams: true,
        params: { ver: 1, client: "android", id: candidate.id, accesskey: candidate.accesskey, fmt: "krc", charset: "utf8" },
      });
      if (!dl?.content) return [];
      const isPlain = dl.fmt === "lrc" || Number(dl.contenttype) !== 0;
      const text = isPlain ? Buffer.from(dl.content, "base64").toString("utf8") : krcToLrc(decodeKrc(dl.content));
      return parseLyrics(text);
    } catch {
      return [];
    }
  }

  // --- Playlist (歌单, by global_collection_id) ------------------------------
  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    const PAGE_SIZE = 30;
    const out: Song[] = [];
    try {
      for (let i = 0; i < 12; i++) {
        const data = await this.request({
          method: "GET",
          url: "/pubsongs/v2/get_other_list_file_nofilt",
          params: {
            area_code: 1,
            begin_idx: i * PAGE_SIZE,
            plat: 1,
            type: 1,
            mode: 1,
            personal_switch: 1,
            extend_fields: "abtags,hot_cmt,popularization",
            pagesize: PAGE_SIZE,
            global_collection_id: playlistId,
          },
        });
        const list = (data?.data?.songs ?? data?.data?.info ?? data?.songs ?? []) as KugouNestedTrack[];
        out.push(...mapKugouSongs(list));
        // Break on the RAW count so filtered-out tracks don't truncate early.
        if (list.length < PAGE_SIZE) break;
      }
    } catch {
      // return whatever was collected so far
    }
    return out;
  }

  async getPlaylistDetail(playlistId: string): Promise<PlaylistDetail | null> {
    try {
      const data = await this.request({
        method: "POST",
        url: "/v3/get_list_info",
        xRouter: "pubsongs.kugou.com",
        data: { data: [{ global_collection_id: playlistId }], userid: this.cookie.userid || 0, token: this.cookie.token || "" },
      });
      const info = data?.data?.[0] ?? data?.data;
      if (!info) return null;
      return {
        id: playlistId,
        name: info.name ?? info.list_name ?? "",
        description: info.intro ?? "",
        coverUrl: fixCover(info.pic ?? info.flexible_cover),
        songCount: Number(info.count ?? info.song_count ?? 0) || 0,
      };
    } catch {
      return null;
    }
  }

  // 推荐歌单 (精选/个性化歌单). Ported from reference top_playlist.js
  // (/v2/special_recommend). The misspelled keys `retrun_min` /
  // `return_special_falg` are intentional — the server expects those exact names.
  async getRecommendPlaylists(): Promise<Playlist[]> {
    try {
      const dateTime = Math.floor(Date.now() / 1000).toString();
      const data = await this.request({
        method: "POST",
        url: "/v2/special_recommend",
        xRouter: "specialrec.service.kugou.com",
        data: {
          appid: APPID,
          mid: this.mid,
          clientver: CLIENTVER,
          platform: "android",
          clienttime: dateTime,
          userid: this.cookie.userid || 0,
          module_id: 1,
          page: 1,
          pagesize: 30,
          key: signParamsKey(dateTime),
          special_recommend: {
            withtag: 1,
            withsong: 1,
            sort: 1,
            ugc: 1,
            is_selected: 0,
            withrecommend: 1,
            area_code: 1,
            categoryid: 0,
          },
          req_multi: 1,
          retrun_min: 5,
          return_special_falg: 1,
        },
      });
      // The list is nested under one of several shapes across API versions.
      const d = data?.data ?? {};
      const list =
        d.special_list ?? d.info ?? d.list ?? d.special ?? (Array.isArray(d) ? d : []);
      return mapKugouPlaylists(list as KugouRawPlaylist[]);
    } catch {
      return [];
    }
  }

  // --- Album (专辑) ----------------------------------------------------------
  async getAlbumSongs(albumId: string): Promise<Song[]> {
    // Kugou caps album pagesize at 50 (larger → "invalid param"); paginate.
    const PAGE_SIZE = 50;
    const out: Song[] = [];
    let rawFetched = 0;
    try {
      for (let page = 1; page <= 8; page++) {
        const data = await this.request({
          method: "POST",
          url: "/v1/album_audio/lite",
          xRouter: "openapi.kugou.com",
          extraHeaders: { "kg-tid": "255" },
          data: { album_id: albumId, is_buy: "", page, pagesize: PAGE_SIZE },
        });
        const list = (data?.data?.songs ?? []) as KugouNestedTrack[];
        out.push(...mapKugouSongs(list));
        rawFetched += list.length;
        const total = Number(data?.data?.total ?? 0);
        // Decide on the RAW page size — filtered-out (unplayable) tracks must
        // not end pagination early and truncate the album.
        if (list.length < PAGE_SIZE || (total && rawFetched >= total)) break;
      }
    } catch {
      // return whatever was collected so far
    }
    return out;
  }

  // --- Personal FM (个性化电台) ---------------------------------------------
  async getPersonalFm(): Promise<Song[]> {
    try {
      const now = Date.now();
      const userid = this.cookie.userid && this.cookie.userid !== "0" ? this.cookie.userid : "";
      const identity: Record<string, unknown> = {};
      if (userid) {
        // Convey the logged-in identity to the recommender (reference personal_fm.js).
        identity.userid = userid;
        identity.kguid = userid;
      }
      if (this.cookie.token) identity.token = this.cookie.token;
      if (this.cookie.vip_type) identity.vip_type = this.cookie.vip_type;
      const data = await this.request({
        method: "POST",
        url: "/v2/personal_recommend",
        xRouter: "persnfm.service.kugou.com",
        data: {
          appid: APPID,
          clienttime: now,
          mid: this.mid,
          action: "play",
          recommend_source_locked: 0,
          song_pool_id: 0,
          callerid: 0,
          m_type: 1,
          platform: "ios",
          area_code: 1,
          remain_songcnt: 0,
          clientver: CLIENTVER,
          is_overplay: 0,
          mode: "normal",
          fakem: "ca981cfc583a4c37f28d2d49000013c16a0a",
          key: signParamsKey(now),
          ...identity,
        },
      });
      const songs = data?.data?.song_list ?? data?.data?.songs ?? [];
      return mapKugouSongs(songs as KugouRawSong[]);
    } catch {
      return [];
    }
  }

  // --- 每日推荐歌曲 (daily recommend) ---------------------------------------
  // Ported from reference recommend_songs.js (/everyday_song_recommend).
  // Requires a logged-in cookie (userid/token) for personalised results.
  async getDailyRecommendSongs(): Promise<Song[]> {
    try {
      const userid = this.cookie.userid && this.cookie.userid !== "0" ? this.cookie.userid : "0";
      const data = await this.request({
        method: "POST",
        url: "/everyday_song_recommend",
        xRouter: "everydayrec.service.kugou.com",
        encryptType: "android",
        data: { platform: "android", userid },
      });
      const d = data?.data ?? {};
      const list = d.song_list ?? d.songs ?? d.list ?? d.info ?? [];
      return mapKugouSongs(list as KugouNestedTrack[]);
    } catch {
      return [];
    }
  }

  // --- 用户歌单 (the logged-in user's own playlists) ------------------------
  // Ported from reference user_playlist.js (/v7/get_all_list).
  async getUserPlaylists(): Promise<Playlist[]> {
    try {
      const userid = this.cookie.userid || "0";
      const token = this.cookie.token || "";
      if (!userid || userid === "0" || !token) return [];
      const out: Playlist[] = [];
      const seen = new Set<string>();
      const PAGE_SIZE = 30;
      for (let page = 1; page <= 10; page++) {
        const data = await this.request({
          method: "POST",
          url: "/v7/get_all_list",
          xRouter: "cloudlist.service.kugou.com",
          encryptType: "android",
          params: { plat: 1, userid: Number(userid), token },
          data: { userid: Number(userid), token, total_ver: 979, type: 2, page, pagesize: PAGE_SIZE },
        });
        const d = data?.data ?? {};
        const list = (d.info ?? d.list ?? []) as KugouRawPlaylist[];
        // Dedup by id: some Kugou list endpoints ignore `page`/`pagesize` and
        // return the whole list every time, which would otherwise duplicate
        // entries 10× for users with ≥30 playlists.
        let added = 0;
        for (const pl of mapKugouPlaylists(list)) {
          if (seen.has(pl.id)) continue;
          seen.add(pl.id);
          out.push(pl);
          added++;
        }
        // Stop on a short page (real pagination) OR when a page contributed
        // nothing new (the endpoint re-returned an already-seen set).
        if (list.length < PAGE_SIZE || added === 0) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  // --- QR login --------------------------------------------------------------
  async getQrCode(): Promise<QrCodeResult> {
    const data = await this.request({
      method: "GET",
      baseURL: "https://login-user.kugou.com",
      url: "/v2/qrcode",
      encryptType: "web",
      params: {
        appid: 1001,
        type: 1,
        plat: 4,
        qrcode_txt: "https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&",
        srcappid: SRCAPPID,
      },
    });
    const key = data?.data?.qrcode ?? "";
    return {
      key,
      qrUrl: `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}`,
    };
  }

  async checkQrCodeStatus(key: string): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    try {
      const data = await this.request({
        method: "GET",
        baseURL: "https://login-user.kugou.com",
        url: "/v2/get_userinfo_qrcode",
        encryptType: "web",
        params: { plat: 4, appid: APPID, srcappid: SRCAPPID, qrcode: key },
      });
      const status = Number(data?.data?.status);
      if (status === 4) {
        // Success: persist token + userid for subsequent (VIP) playback.
        if (data.data.token) this.cookie.token = String(data.data.token);
        if (data.data.userid) this.cookie.userid = String(data.data.userid);
        if (data.data.nickname) this.cookie.nickname = String(data.data.nickname);
        return "confirmed";
      }
      if (status === 2) return "scanned";
      if (status === 1) return "waiting";
      return "expired";
    } catch {
      return "expired";
    }
  }

  async getAuthStatus(): Promise<AuthStatus> {
    if (!this.cookie.token || !this.cookie.userid || this.cookie.userid === "0") {
      return { loggedIn: false };
    }
    return {
      loggedIn: true,
      nickname: this.safeNickname(),
    };
  }

  /** Kugou nicknames may arrive percent-encoded; decode defensively so a bare
   *  '%' can't throw and turn /api/auth/status into a 500 (which would blank
   *  EVERY platform's card, since the UI batches the four status calls). */
  private safeNickname(): string {
    const raw = this.cookie.nickname;
    if (!raw) return "酷狗用户";
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
}
