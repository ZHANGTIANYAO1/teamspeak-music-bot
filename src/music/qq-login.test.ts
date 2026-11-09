import { beforeEach, describe, expect, it, vi } from "vitest";

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("axios", () => ({ default: { create: () => ({ get, post }), isAxiosError: () => false } }));

import { createQqLoginClient, parseQqCredential } from "./qq-login.js";

const credential = {
  musicid: 12345, musickey: "test-music-key", openid: "test-openid", access_token: "test-access",
  refresh_token: "test-token", refresh_key: "test-refresh", expired_at: 1234,
  musickeyCreateTime: 5678, keyExpiresIn: 3600,
};

describe("QQ login transport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("accepts the QQ QR image when Tencent omits its content type", async () => {
    get.mockResolvedValueOnce({
      data: Buffer.from("89504e470d0a1a0a", "hex"),
      headers: { "set-cookie": ["qrsig=test-sig; Path=/"] },
    });
    expect(await createQqLoginClient().getQr()).toMatchObject({
      img: "data:image/png;base64,iVBORw0KGgo=", sig: "test-sig",
    });
  });

  it("exchanges a confirmed QR for the full JSON credential", async () => {
    get
      .mockResolvedValueOnce({
        data: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?uin=12345&ptsigx=sigx','0','','');",
      })
      .mockResolvedValueOnce({ headers: { "set-cookie": ["p_skey=test==; Path=/; Secure"] } });
    post
      .mockResolvedValueOnce({ headers: { location: "https://y.qq.com/portal/wx_redirect.html?code=example&state=state" } })
      .mockResolvedValueOnce({
        headers: {},
        data: { code: 0, req_0: { code: 0, data: { ...credential, loginType: 2 } } },
      });
    expect(await createQqLoginClient().pollQr("test-sig")).toEqual({ status: "confirmed", credential });
    expect(post).toHaveBeenNthCalledWith(
      1, "https://graph.qq.com/oauth2.0/authorize", expect.any(URLSearchParams),
      expect.objectContaining({ headers: { Cookie: "p_skey=test==" } }),
    );
    expect(post).toHaveBeenNthCalledWith(
      2, "https://u.y.qq.com/cgi-bin/musicu.fcg",
      expect.objectContaining({
        req_0: { module: "QQConnectLogin.LoginServer", method: "QQLogin", param: { code: "example" } },
      }),
      expect.anything(),
    );
  });

  it("sends the login type 2 refresh payload and validates the CGI status", async () => {
    post.mockResolvedValue({
      headers: {},
      data: { code: 0, req_0: { code: 104604, data: { ...credential, musickey: "do-not-use" } } },
    });
    expect(await createQqLoginClient().refresh(credential)).toEqual({ status: "rate_limited" });
    expect(post).toHaveBeenCalledWith(
      "https://u.y.qq.com/cgi-bin/musicu.fcg",
      expect.objectContaining({
        comm: expect.objectContaining({ tmeLoginType: "2" }),
        req_0: {
          module: "music.login.LoginServer", method: "Login",
          param: {
            loginMode: 2, musicid: 12345, musickey: "test-music-key", openid: "test-openid",
            access_token: "test-access", refresh_token: "test-token", refresh_key: "test-refresh", expired_in: 1234,
          },
        },
      }),
      expect.anything(),
    );
    post.mockResolvedValueOnce({ headers: {}, data: { code: 104401 } });
    expect(await createQqLoginClient().refresh(credential)).toEqual({ status: "reauth_required" });
    post.mockResolvedValueOnce({ headers: {}, data: { code: 0, req_0: { code: 0, data: { musicid: 12345 } } } });
    expect(await createQqLoginClient().refresh(credential)).toEqual({ status: "upstream_error" });
  });

  it("accepts playback-only QQ credentials and rejects other types or invalid keys", () => {
    expect(parseQqCredential({ str_musicid: "12345", musickey: "music-key" })).toMatchObject({
      musicid: 12345, musickey: "music-key", refresh_key: "",
    });
    expect(parseQqCredential({ ...credential, loginType: 1 })).toBeUndefined();
    expect(parseQqCredential({ ...credential, musickey: "music-key\r\n" })).toBeUndefined();
  });

  it("keeps unchanged OAuth fields when QQ returns a partial rotation for the same account", async () => {
    post.mockResolvedValueOnce({
      headers: {},
      data: { code: 0, req_0: { code: 0, data: {
        musicid: 12345, musickey: "rotated-key", refresh_token: "rotated-token",
      } } },
    });
    expect(await createQqLoginClient().refresh(credential)).toMatchObject({
      status: "refreshed",
      credential: {
        musicid: 12345, musickey: "rotated-key", refresh_token: "rotated-token",
        openid: credential.openid, access_token: credential.access_token,
      },
    });
  });
});
