import axios from "axios";
import { randomUUID } from "node:crypto";

export interface QqCredential {
  musicid: number;
  musickey: string;
  openid: string;
  access_token: string;
  refresh_token: string;
  refresh_key: string;
  expired_at: number;
  musickeyCreateTime: number;
  keyExpiresIn: number;
}

export type QqPollResult =
  | { status: "waiting" | "scanned" | "expired" }
  | { status: "confirmed"; credential: QqCredential };

export type QqRefreshResult =
  | { status: "refreshed"; credential: QqCredential }
  | { status: "reauth_required" | "rate_limited" | "upstream_error" };

export interface QqLoginClient {
  getQr(): Promise<{ img: string; sig: string }>;
  pollQr(sig: string): Promise<QqPollResult>;
  refresh(credential: QqCredential): Promise<QqRefreshResult>;
}

const QR_HOST = "https://ssl.ptlogin2.qq.com";
const REFERER = "https://xui.ptlogin2.qq.com/";
const QQ_JUMP = "https://graph.qq.com/oauth2.0/login_jump";
const MUSIC_REDIRECT = "https://y.qq.com/portal/wx_redirect.html";
const APP_ID = "100497308";
const LOGIN_SCOPE = { daid: "383", pt_3rd_aid: APP_ID };
const AUTH_REJECTED = new Set([1000, 104400, 104401, 20261, 20272, 20274, 20277, 20278, 20279, 20450]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function token(value: unknown): string {
  return typeof value === "string" && /^[\x21-\x3a\x3c-\x7e]+$/.test(value) ? value : "";
}

function positiveInt(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export function parseQqCredential(value: unknown, previous?: QqCredential): QqCredential | undefined {
  const data = record(value);
  const type = data.loginType ?? data.login_type;
  if (type !== undefined && type !== 2 && type !== "2") return;
  const musicid = positiveInt(data.musicid) || positiveInt(data.str_musicid);
  const musickey = token(data.musickey);
  if (!musicid || !musickey) return;
  const sameAccount = previous?.musicid === musicid ? previous : undefined;
  const sameKey = sameAccount?.musickey === musickey ? sameAccount : undefined;
  return {
    musicid,
    musickey,
    openid: token(data.openid ?? sameAccount?.openid),
    access_token: token(data.access_token ?? sameAccount?.access_token),
    refresh_token: token(data.refresh_token ?? sameAccount?.refresh_token),
    refresh_key: token(data.refresh_key),
    expired_at: positiveInt(data.expired_at ?? sameAccount?.expired_at),
    musickeyCreateTime: positiveInt(data.musickeyCreateTime ?? sameKey?.musickeyCreateTime),
    keyExpiresIn: positiveInt(data.keyExpiresIn ?? sameKey?.keyExpiresIn),
  };
}

export function hasQqRenewalMaterial(credential?: QqCredential): credential is QqCredential {
  // QQ's web QR flow may return OAuth tokens without a separate refresh key.
  return Boolean(credential?.refresh_key || (credential?.openid && credential.access_token && credential.refresh_token));
}

export function qqPlaybackCookie({ musicid, musickey }: QqCredential): string {
  return `uin=${musicid}; qqmusic_uin=${musicid}; qm_keyst=${musickey}; qqmusic_key=${musickey}; login_type=2; tmeLoginType=2`;
}

function hash33(value: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < value.length; i++) hash = (hash * 33 + value.charCodeAt(i)) | 0;
  return hash & 0x7fffffff;
}

function setCookies(headers: string[] = []): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const header of headers) {
    const pair = header.split(";", 1)[0];
    const equals = pair.indexOf("=");
    if (equals < 1) continue;
    const value = token(pair.slice(equals + 1));
    if (value) cookies.set(pair.slice(0, equals), value);
  }
  return cookies;
}

function cookieHeader(cookies: Map<string, string>): string {
  return Array.from(cookies, ([key, value]) => `${key}=${value}`).join("; ");
}

export function createQqLoginClient(): QqLoginClient {
  const http = axios.create({ timeout: 10_000, maxRedirects: 0 });

  // QQMusicApi's web CGI profile. Keep authorization fields in the HTTPS body.
  async function musicu(module: string, method: string, param: object, credential?: QqCredential) {
    const gTk = String(hash33(credential?.musickey ?? "", 5381));
    const res = await http.post("https://u.y.qq.com/cgi-bin/musicu.fcg", {
      comm: {
        ct: "24", cv: "4747474", platform: "yqq.json", chid: "0",
        uin: String(credential?.musicid ?? 0), g_tk: gTk, g_tk_new_20200303: gTk,
        format: "json", inCharset: "utf-8", outCharset: "utf-8", notice: "0",
        need_new_code: "1", tmeLoginType: "2",
      },
      req_0: { module, method, param },
    }, { headers: { Referer: "https://y.qq.com/" } });
    const body = record(res.data);
    const item = record(body.req_0);
    return { code: body.code === 0 ? item.code : body.code, data: item.data, cookies: setCookies(res.headers["set-cookie"]) };
  }

  async function authorize(redirect: string): Promise<QqCredential | undefined> {
    const url = new URL(redirect);
    const uin = url.searchParams.get("uin");
    const sigx = url.searchParams.get("ptsigx");
    if (!uin || !/^\d+$/.test(uin) || !sigx) return;
    const noFollow = (status: number) => status >= 200 && status < 400;
    const checked = await http.get("https://ssl.ptlogin2.graph.qq.com/check_sig", {
      params: {
        ...LOGIN_SCOPE, uin, ptsigx: sigx, pttype: "1", service: "ptqrlogin",
        nodirect: "0", s_url: QQ_JUMP, ptlang: "2052", ptredirect: "100",
        aid: "716027609", j_later: "0", low_login_hour: "0", regmaster: "0",
        pt_login_type: "3", pt_aid: "0", pt_aaid: "16", pt_light: "0",
      },
      headers: { Referer: REFERER },
      validateStatus: noFollow,
    });
    const cookies = setCookies(checked.headers["set-cookie"]);
    const pSkey = cookies.get("p_skey");
    if (!pSkey) return;

    const authorized = await http.post("https://graph.qq.com/oauth2.0/authorize", new URLSearchParams({
      response_type: "code", client_id: APP_ID, redirect_uri: `${MUSIC_REDIRECT}?login_type=1&surl=https://y.qq.com/`,
      scope: "get_user_info,get_app_friends", state: "state", switch: "",
      from_ptlogin: "1", src: "1", update_auth: "1", openapi: "1010_1030",
      g_tk: String(hash33(pSkey, 5381)), auth_time: String(Date.now()), ui: randomUUID(),
    }), { headers: { Cookie: cookieHeader(cookies) }, validateStatus: noFollow });
    if (typeof authorized.headers.location !== "string") return;
    const callback = new URL(authorized.headers.location);
    if (callback.origin + callback.pathname !== MUSIC_REDIRECT) return;
    const code = callback.searchParams.get("code");
    if (!code) return;

    const result = await musicu("QQConnectLogin.LoginServer", "QQLogin", { code });
    if (result.code !== 0) return;
    return parseQqCredential(result.data) ?? parseQqCredential({
      musicid: result.cookies.get("qqmusic_uin") ?? uin,
      musickey: result.cookies.get("qqmusic_key") ?? result.cookies.get("qm_keyst"),
    });
  }

  return {
    async getQr() {
      try {
        const res = await http.get(`${QR_HOST}/ptqrshow`, {
          params: { ...LOGIN_SCOPE, appid: "716027609", e: "2", l: "M", s: "3", d: "72", v: "4", t: Math.random() },
          headers: { Referer: REFERER },
          responseType: "arraybuffer",
        });
        const sig = setCookies(res.headers["set-cookie"]).get("qrsig");
        // Tencent can send the PNG without a Content-Type header.
        const bytes = Buffer.from(res.data);
        const isPng = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
        const isJpeg = bytes.subarray(0, 3).toString("hex") === "ffd8ff";
        if (sig && (isPng || isJpeg)) {
          return { img: `data:image/${isPng ? "png" : "jpeg"};base64,${bytes.toString("base64")}`, sig };
        }
      } catch { /* Do not expose the request or response. */ }
      throw new Error("QQ QR code unavailable");
    },
    async pollQr(sig) {
      let response: string;
      try {
        const res = await http.get<string>(`${QR_HOST}/ptqrlogin`, {
          params: {
            ...LOGIN_SCOPE, u1: QQ_JUMP, ptqrtoken: hash33(sig, 0), ptredirect: "0",
            h: "1", t: "1", g: "1", from_ui: "1", ptlang: "2052",
            action: `0-0-${Date.now()}`, js_ver: "20102616", js_type: "1",
            pt_uistyle: "40", aid: "716027609", has_onekey: "1",
          },
          headers: { Referer: REFERER, Cookie: `qrsig=${sig}` },
          responseType: "text",
        });
        response = res.data;
      } catch { return { status: "waiting" }; }

      const fields = /^\s*ptuiCB\((.*)\)/.exec(response)?.[1].match(/'((?:\\.|[^'])*)'/g);
      const code = fields?.[0]?.slice(1, -1);
      if (code === "66") return { status: "waiting" };
      if (code === "67") return { status: "scanned" };
      if (code === "0" && fields?.[2]) {
        try {
          const credential = await authorize(fields[2].slice(1, -1));
          if (credential) return { status: "confirmed", credential };
        } catch { /* A used QR cannot safely replay the authorization code. */ }
      }
      return { status: "expired" };
    },
    async refresh(credential) {
      const { openid, access_token, refresh_token, expired_at, musicid, musickey, refresh_key } = credential;
      try {
        const result = await musicu("music.login.LoginServer", "Login", {
          openid, access_token, refresh_token, expired_in: expired_at, musicid, musickey, refresh_key, loginMode: 2,
        }, credential);
        const code = Number(result.code);
        if (code === 104604 || code === 2001) return { status: "rate_limited" };
        if (AUTH_REJECTED.has(code)) return { status: "reauth_required" };
        const next = result.code === 0 ? parseQqCredential(result.data, credential) : undefined;
        if (next) return { status: "refreshed", credential: next };
      } catch (err) {
        if (axios.isAxiosError(err) && err.response?.status === 429) return { status: "rate_limited" };
      }
      return { status: "upstream_error" };
    },
  };
}
