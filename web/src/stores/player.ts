import { defineStore } from 'pinia';
import axios from 'axios';
import { resolveScopedBot } from './scope.js';
import { useSession } from '../composables/useSession.js';

export interface Song {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl: string;
  platform: 'netease' | 'qq' | 'bilibili' | 'youtube' | 'local' | 'kugou' | 'spotify';
  requestedBy?: string;
  playedAt?: string;
}

export type Source = 'netease' | 'qq' | 'kugou' | 'spotify';

export interface BotStatus {
  id: string;
  name: string;
  connected: boolean;
  playing: boolean;
  paused: boolean;
  currentSong: Song | null;
  queueSize: number;
  volume: number;
  playMode: string;
  elapsed?: number;
}

export interface PlaylistItem {
  id: string;
  name: string;
  coverUrl: string;
  songCount: number;
  platform: string;
}

export interface FavoritePlaylist {
  id: number;
  userId: string;
  platform: string;
  playlistId: string;
  name: string;
  coverUrl: string;
  songCount: number;
  createdAt: string;
}

export interface TimingState {
  serverElapsed: number;
  serverSyncTime: number;
  wasPlaying: boolean;
}

const HOME_CACHE_TTL = 5 * 60 * 1000;

function defaultTiming(): TimingState {
  return { serverElapsed: 0, serverSyncTime: 0, wasPlaying: false };
}

/**
 * Interpolate the live elapsed seconds from the last server anchor.
 *
 * This is a PURE function (its only time source is `Date.now()`), deliberately
 * kept OUT of the Pinia getter so it can be called fresh every animation frame.
 * The `elapsed` getter is a Vue `computed` and caches its result until a
 * REACTIVE dependency changes — but `Date.now()` is not reactive, so a getter
 * only re-runs on a WebSocket push / server poll (every few seconds). Reading
 * the getter from a requestAnimationFrame loop therefore returns a frozen value
 * and the clock appears to jump ~3s at a time (issue #107). Per-frame consumers
 * must call this helper (via the `liveElapsed` action) instead.
 */
export function interpolateElapsed(
  timing: TimingState,
  isPaused: boolean,
  maxDuration: number,
): number {
  // No live anchor yet, or paused: report the frozen server position.
  if (!timing.wasPlaying || timing.serverSyncTime === 0 || isPaused) {
    return Math.min(timing.serverElapsed, maxDuration);
  }
  return Math.min(
    timing.serverElapsed + (Date.now() - timing.serverSyncTime) / 1000,
    maxDuration,
  );
}

export const usePlayerStore = defineStore('player', {
  state: () => ({
    bots: [] as BotStatus[],
    activeBotId: null as string | null,
    /** When set, the UI is locked to a single bot (dedicated link, from ?bot).
     * Source of truth is the URL — never persisted to localStorage. */
    scopedBotId: null as string | null,
    /** Per-bot queues keyed by botId */
    queues: {} as Record<string, Song[]>,
    /** Per-bot timing state keyed by botId */
    timings: {} as Record<string, TimingState>,
    theme: 'dark' as 'dark' | 'light',

    // Home page cache, split by source
    recommendPlaylists: { netease: [] as PlaylistItem[], qq: [] as PlaylistItem[], kugou: [] as PlaylistItem[], spotify: [] as PlaylistItem[] },
    dailySongs:         { netease: [] as Song[],         qq: [] as Song[],         kugou: [] as Song[], spotify: [] as Song[] },
    userPlaylists:      { netease: [] as PlaylistItem[], qq: [] as PlaylistItem[], kugou: [] as PlaylistItem[], spotify: [] as PlaylistItem[] },
    bilibiliPopular: [] as Song[],
    authStatus: { netease: false, qq: false, kugou: false, spotify: false },
    lastFetchTime: 0,

    // Favorited playlists (fetched from server, isolated per WebUI user)
    favoritedPlaylists: [] as FavoritePlaylist[],

    // Transient notification for surfacing failures (e.g., "song not playable")
    // to a global Toast. Bumped `id` triggers re-render of the same message.
    notification: null as { id: number; message: string; type: 'error' | 'info' } | null,
  }),

  getters: {
    activeBot(): BotStatus | null {
      return this.bots.find((b) => b.id === this.activeBotId) ?? this.bots[0] ?? null;
    },
    /** True when the UI is locked to a single bot via a dedicated link. */
    isScoped(): boolean {
      return this.scopedBotId !== null;
    },
    currentSong(): Song | null {
      return this.activeBot?.currentSong ?? null;
    },
    isPlaying(): boolean {
      return this.activeBot?.playing ?? false;
    },
    isPaused(): boolean {
      return this.activeBot?.paused ?? false;
    },
    /** Queue for the currently active bot */
    queue(): Song[] {
      const botId = this.activeBotId ?? this.bots[0]?.id;
      if (!botId) return [];
      return this.queues[botId] ?? [];
    },
    /**
     * Interpolated elapsed for the active bot. NOTE: as a Pinia getter this is
     * a Vue `computed` and is CACHED — it only re-runs when a reactive
     * dependency changes, so it does NOT tick every second on its own. Use it
     * for one-off reactive reads; per-frame consumers (progress bar, lyrics)
     * must call the `liveElapsed` action so the clock advances smoothly (#107).
     */
    elapsed(): number {
      const botId = this.activeBotId ?? this.bots[0]?.id;
      if (!botId || !this.activeBot?.currentSong) return 0;
      const timing = this.timings[botId] ?? defaultTiming();
      const maxDuration = this.activeBot.currentSong.duration || Infinity;
      return interpolateElapsed(timing, this.isPaused, maxDuration);
    },
    /** Sources that are currently logged in. Order: netease before qq. */
    availableSources(): Source[] {
      const s: Source[] = [];
      if (this.authStatus.netease) s.push('netease');
      if (this.authStatus.qq) s.push('qq');
      if (this.authStatus.kugou) s.push('kugou');
      if (this.authStatus.spotify) s.push('spotify');
      return s;
    },
  },

  actions: {
    /**
     * Live elapsed seconds for the active bot, recomputed on every call. Unlike
     * the `elapsed` getter (a cached computed), this is an action, so it is NOT
     * memoised — call it from requestAnimationFrame / interval loops so the
     * progress bar and lyrics advance every frame instead of jumping on each
     * server push (#107).
     */
    liveElapsed(): number {
      const botId = this.activeBotId ?? this.bots[0]?.id;
      if (!botId || !this.activeBot?.currentSong) return 0;
      const timing = this.timings[botId] ?? defaultTiming();
      const maxDuration = this.activeBot.currentSong.duration || Infinity;
      return interpolateElapsed(timing, this.isPaused, maxDuration);
    },

    _getTiming(botId: string): TimingState {
      if (!this.timings[botId]) {
        this.timings[botId] = defaultTiming();
      }
      return this.timings[botId];
    },

    _setTiming(botId: string, partial: Partial<TimingState>) {
      const current = this._getTiming(botId);
      this.timings[botId] = { ...current, ...partial };
    },

    getQueueForBot(botId: string): Song[] {
      return this.queues[botId] ?? [];
    },

    setActiveBotId(id: string) {
      // While scoped to a dedicated link, switching bots is blocked.
      if (this.scopedBotId !== null && id !== this.scopedBotId) return;
      this.activeBotId = id;
      // Fetch queue for newly active bot if we don't have it yet
      if (!this.queues[id]) {
        this.fetchQueue();
      }
    },

    /** Lock the UI to a single bot (dedicated link). Sets scope first so the
     * setActiveBotId guard does not block the switch to the scoped bot. */
    setScope(id: string) {
      this.scopedBotId = id;
      this.activeBotId = id;
      // Lazily fetch this bot's queue, mirroring setActiveBotId.
      if (!this.queues[id]) {
        this.fetchQueue();
      }
    },

    clearScope() {
      this.scopedBotId = null;
    },

    /** Reconcile the scope with the desired id from the URL (?bot). A stale or
     * forbidden id resolves to null and clears the scope rather than locking. */
    applyScopeFromQuery(requestedId: string | null) {
      const r = resolveScopedBot(requestedId, this.bots.map((b) => b.id));
      if (r) {
        this.setScope(r);
      } else if (requestedId) {
        this.clearScope();
      }
    },

    updateBotStatus(botId: string, status: BotStatus) {
      const prev = this.bots.find((b) => b.id === botId);
      const prevSongId = prev?.currentSong?.id;

      const index = this.bots.findIndex((b) => b.id === botId);
      if (index >= 0) {
        this.bots[index] = status;
      } else {
        this.bots.push(status);
      }

      // Sync elapsed from server status — always per-bot
      if (status.elapsed !== undefined) {
        this._setTiming(botId, {
          serverElapsed: status.elapsed,
          serverSyncTime: Date.now(),
          wasPlaying: status.playing && !status.paused,
        });
      }

      // Song changed — reset timing for this bot
      if (status.currentSong?.id !== prevSongId) {
        this._setTiming(botId, {
          serverElapsed: status.elapsed ?? 0,
          serverSyncTime: Date.now(),
          wasPlaying: status.playing && !status.paused,
        });
      }
    },

    removeBotStatus(botId: string) {
      this.bots = this.bots.filter((b) => b.id !== botId);
      delete this.queues[botId];
      delete this.timings[botId];
      // If the bot we were locked to is gone, drop the scope so the UI does not
      // stay 'locked' onto a phantom (activeBot would silently fall back to bots[0]).
      if (this.scopedBotId === botId) {
        this.clearScope();
      }
    },

    setQueue(botId: string, queue: Song[]) {
      this.queues[botId] = queue;
    },

    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', this.theme);
    },

    loadTheme() {
      const saved = localStorage.getItem('theme') as 'dark' | 'light' | null;
      if (saved) this.theme = saved;
    },

    async startBotInstance(id: string) {
      await axios.post(`/api/bot/${id}/start`);
    },

    async stopBotInstance(id: string) {
      await axios.post(`/api/bot/${id}/stop`);
    },

    async fetchBots() {
      const res = await axios.get('/api/bot');
      this.bots = res.data.bots;
      if (!this.activeBotId && this.bots.length > 0) {
        this.activeBotId = this.bots[0].id;
      }
      // Sync elapsed from each bot's status
      for (const bot of this.bots) {
        if (bot.elapsed !== undefined) {
          this._setTiming(bot.id, {
            serverElapsed: bot.elapsed,
            serverSyncTime: Date.now(),
            wasPlaying: bot.playing && !bot.paused,
          });
        }
      }
    },

    /** Poll server for real elapsed time for active bot */
    async syncElapsed() {
      if (!this.activeBotId || !this.isPlaying) return;
      try {
        const res = await axios.get(`/api/player/${this.activeBotId}/elapsed`);
        this._setTiming(this.activeBotId, {
          serverElapsed: res.data.elapsed,
          serverSyncTime: Date.now(),
          wasPlaying: true,
        });
      } catch {
        // ignore
      }
    },

    async fetchQueue() {
      if (!this.activeBotId) return;
      try {
        const res = await axios.get(`/api/player/${this.activeBotId}/queue`);
        this.queues[this.activeBotId] = res.data.queue ?? [];
      } catch {
        // ignore
      }
    },

    async fetchQueueForBot(botId: string) {
      try {
        const res = await axios.get(`/api/player/${botId}/queue`);
        this.queues[botId] = res.data.queue ?? [];
      } catch {
        // ignore
      }
    },

    _syncAfterAction() {
      if (!this.activeBotId) return;
      this._setTiming(this.activeBotId, {
        serverSyncTime: Date.now(),
        wasPlaying: true,
      });
      // Sync from server after a short delay for accuracy
      setTimeout(() => this.syncElapsed(), 500);
    },

    async playAtIndex(index: number) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/play-at`, { index });
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },

    async play(query: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/play`, { query, platform });
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },

    async playById(songId: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/play-by-id`, { songId, platform });
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },

    notify(message: string, type: 'error' | 'info' = 'info') {
      this.notification = { id: Date.now(), message, type };
    },

    async playSong(song: Song) {
      if (!this.activeBotId) return;
      // Guests use the non-destructive "play now" (insert-next + skip) so they
      // can't wipe everyone else's queue; members/admins keep the normal behavior.
      const endpoint = useSession().isGuest.value ? 'play-now-song' : 'play-song';
      const res = await axios.post(`/api/player/${this.activeBotId}/${endpoint}`, { song });
      if (res.data?.ok === false && res.data?.message) {
        this.notify(res.data.message, 'error');
      }
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },

    async playNextSong(song: Song) {
      if (!this.activeBotId) return;
      const res = await axios.post(`/api/player/${this.activeBotId}/play-next-song`, { song });
      if (res.data?.message) {
        this.notify(res.data.message, res.data.ok === false ? 'error' : 'info');
      }
      // Refresh queue so the inserted item shows up in the side panel
      this.fetchQueue();
    },

    async addToQueue(query: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/add`, { query, platform });
    },

    async addToQueueById(songId: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/add-by-id`, { songId, platform });
    },

    async addSong(song: Song) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/add-song`, { song });
    },

    async playPlaylist(playlistId: string, platform = 'netease') {
      if (!this.activeBotId) return;
      try {
        const res = await axios.post(`/api/player/${this.activeBotId}/play-playlist`, { playlistId, platform });
        if (res.data?.message) {
          this.notify(res.data.message, res.data.ok === false ? 'error' : 'info');
        }
        this._setTiming(this.activeBotId, { serverElapsed: 0 });
        this._syncAfterAction();
      } catch (e: any) {
        // A 403 here means a guest lacks the "play entire collection" permission
        // (issue #103) — surface it instead of failing silently.
        this.notify(e?.response?.status === 403 ? '没有权限播放整个歌单' : '播放歌单失败', 'error');
      }
    },

    async playAlbum(albumId: string, platform = 'netease') {
      if (!this.activeBotId) return;
      try {
        const res = await axios.post(`/api/player/${this.activeBotId}/play-album`, { albumId, platform });
        if (res.data?.message) {
          this.notify(res.data.message, res.data.ok === false ? 'error' : 'info');
        }
        this._setTiming(this.activeBotId, { serverElapsed: 0 });
        this._syncAfterAction();
      } catch (e: any) {
        this.notify(e?.response?.status === 403 ? '没有权限播放整个专辑' : '播放专辑失败', 'error');
      }
    },

    async pause() {
      if (!this.activeBotId) return;
      // Freeze elapsed at the current LIVE interpolated value. Using the cached
      // `elapsed` getter here could snapshot a value up to a few seconds stale.
      this._setTiming(this.activeBotId, {
        serverElapsed: this.liveElapsed(),
        wasPlaying: false,
      });
      await axios.post(`/api/player/${this.activeBotId}/pause`);
    },

    async resume() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/resume`);
      this._setTiming(this.activeBotId, {
        serverSyncTime: Date.now(),
        wasPlaying: true,
      });
      setTimeout(() => this.syncElapsed(), 300);
    },

    async next() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/next`);
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },

    async prev() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/prev`);
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },

    async stop() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/stop`);
      this._setTiming(this.activeBotId, {
        serverElapsed: 0,
        serverSyncTime: 0,
        wasPlaying: false,
      });
    },

    async seek(position: number) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/seek`, { position });
      this._setTiming(this.activeBotId, { serverElapsed: position });
      this._syncAfterAction();
    },

    async setVolume(volume: number) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/volume`, { volume });
      const bot = this.bots.find((b) => b.id === this.activeBotId);
      if (bot) bot.volume = volume;
    },

    async setMode(mode: string) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/mode`, { mode });
      const bot = this.bots.find((b) => b.id === this.activeBotId);
      if (bot) bot.playMode = mode;
    },

    async startFm(platform: Source = 'netease') {
      if (!this.activeBotId) return;
      const res = await axios.post(`/api/player/${this.activeBotId}/fm`, { platform });
      if (res.data?.message) {
        this.notify(res.data.message, res.data.ok === false ? 'error' : 'info');
      }
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
      this.fetchQueue();
    },

    async fetchFavorites() {
      try {
        const res = await axios.get('/api/favorites');
        this.favoritedPlaylists = res.data.favorites ?? [];
      } catch {
        // not critical
      }
    },

    async addFavorite(playlist: { platform: string; playlistId: string; name: string; coverUrl: string; songCount: number }) {
      try {
        await axios.post('/api/favorites', playlist);
        await this.fetchFavorites();
        this.notify('已收藏', 'info');
      } catch (err: any) {
        // 409 = already favorited (e.g. stale heart); just resync so the UI converges.
        if (err?.response?.status === 409) {
          await this.fetchFavorites();
          return;
        }
        this.notify('收藏失败', 'error');
      }
    },

    async removeFavorite(id: number) {
      try {
        await axios.delete(`/api/favorites/${id}`);
        await this.fetchFavorites();
        this.notify('已取消收藏', 'info');
      } catch (err: any) {
        // 404 = already gone; resync. Otherwise report failure.
        if (err?.response?.status === 404) {
          await this.fetchFavorites();
          return;
        }
        this.notify('取消收藏失败', 'error');
      }
    },

    isFavorited(playlistId: string, platform: string): boolean {
      return this.favoritedPlaylists.some((f) => f.playlistId === playlistId && f.platform === platform);
    },

    async fetchHomeData() {
      // Always check auth status first — if it changed since the cached
      // fetch (e.g., user logged in/out as a different account), the
      // cached playlists belong to a different user and we MUST refetch.
      const [neAuthRes, qqAuthRes, kugouAuthRes, spAuthRes] = await Promise.allSettled([
        axios.get('/api/auth/status', { params: { platform: 'netease' } }),
        axios.get('/api/auth/status', { params: { platform: 'qq' } }),
        axios.get('/api/auth/status', { params: { platform: 'kugou' } }),
        axios.get('/api/auth/status', { params: { platform: 'spotify' } }),
      ]);
      const newAuth = {
        netease: neAuthRes.status === 'fulfilled' && !!neAuthRes.value.data?.loggedIn,
        qq:      qqAuthRes.status === 'fulfilled' && !!qqAuthRes.value.data?.loggedIn,
        kugou:   kugouAuthRes.status === 'fulfilled' && !!kugouAuthRes.value.data?.loggedIn,
        spotify: spAuthRes.status === 'fulfilled' && !!spAuthRes.value.data?.loggedIn,
      };
      const authChanged =
        newAuth.netease !== this.authStatus.netease ||
        newAuth.qq !== this.authStatus.qq ||
        newAuth.kugou !== this.authStatus.kugou ||
        newAuth.spotify !== this.authStatus.spotify;
      this.authStatus.netease = newAuth.netease;
      this.authStatus.qq = newAuth.qq;
      this.authStatus.kugou = newAuth.kugou;
      this.authStatus.spotify = newAuth.spotify;

      // Favorites are user-local and cheap; always refresh them, even on a
      // home-data cache hit, so hearts stay correct across tabs/sessions.
      this.fetchFavorites();

      // Cache hit only if auth is unchanged AND within TTL.
      if (
        !authChanged &&
        this.lastFetchTime > 0 &&
        Date.now() - this.lastFetchTime < HOME_CACHE_TTL
      ) {
        return;
      }

      // 2. NetEase data: recommend playlists work anonymously; daily/user
      // playlists need login but Promise.allSettled isolates failures.
      const neteasePromises = [
        axios.get('/api/music/recommend/playlists', { params: { platform: 'netease' } }),
        axios.get('/api/music/recommend/songs',     { params: { platform: 'netease' } }),
        axios.get('/api/music/user/playlists',      { params: { platform: 'netease' } }),
      ];

      // 3. QQ data: only fetch when QQ is logged in. When not logged in,
      // resolve to empty payloads so the same indexed handling works.
      const emptyPlaylists = { data: { playlists: [] } };
      const emptySongs     = { data: { songs: [] } };
      const qqPromises = this.authStatus.qq
        ? [
            axios.get('/api/music/recommend/playlists', { params: { platform: 'qq' } }),
            axios.get('/api/music/recommend/songs',     { params: { platform: 'qq' } }),
            axios.get('/api/music/user/playlists',      { params: { platform: 'qq' } }),
          ]
        : [
            Promise.resolve(emptyPlaylists),
            Promise.resolve(emptySongs),
            Promise.resolve(emptyPlaylists),
          ];

      // 4. Kugou data: every section (incl. recommend playlists) needs login,
      // so gate all three on auth like QQ.
      const kugouPromises = this.authStatus.kugou
        ? [
            axios.get('/api/music/recommend/playlists', { params: { platform: 'kugou' } }),
            axios.get('/api/music/recommend/songs',     { params: { platform: 'kugou' } }),
            axios.get('/api/music/user/playlists',      { params: { platform: 'kugou' } }),
          ]
        : [
            Promise.resolve(emptyPlaylists),
            Promise.resolve(emptySongs),
            Promise.resolve(emptyPlaylists),
          ];

      const biliPromise = axios.get('/api/music/bilibili/popular?limit=12');

      const results = await Promise.allSettled([
        ...neteasePromises,
        ...qqPromises,
        ...kugouPromises,
        biliPromise,
      ]);

      const [neRecPL, neDaily, neUserPL, qqRecPL, qqDaily, qqUserPL, kgRecPL, kgDaily, kgUserPL, bili] = results;

      this.recommendPlaylists.netease =
        neRecPL.status === 'fulfilled' ? (neRecPL.value.data.playlists ?? []) : [];
      this.dailySongs.netease =
        neDaily.status === 'fulfilled' ? (neDaily.value.data.songs ?? []) : [];
      this.userPlaylists.netease =
        neUserPL.status === 'fulfilled' ? (neUserPL.value.data.playlists ?? []) : [];
      this.recommendPlaylists.qq =
        qqRecPL.status === 'fulfilled' ? (qqRecPL.value.data.playlists ?? []) : [];
      this.dailySongs.qq =
        qqDaily.status === 'fulfilled' ? (qqDaily.value.data.songs ?? []) : [];
      this.userPlaylists.qq =
        qqUserPL.status === 'fulfilled' ? (qqUserPL.value.data.playlists ?? []) : [];
      this.recommendPlaylists.kugou =
        kgRecPL.status === 'fulfilled' ? (kgRecPL.value.data.playlists ?? []) : [];
      this.dailySongs.kugou =
        kgDaily.status === 'fulfilled' ? (kgDaily.value.data.songs ?? []) : [];
      this.userPlaylists.kugou =
        kgUserPL.status === 'fulfilled' ? (kgUserPL.value.data.playlists ?? []) : [];
      // bilibili popular: keep previous value on failure (it's an anonymous endpoint
      // unrelated to user auth state, and stale popular results are harmless)
      if (bili.status === 'fulfilled') {
        this.bilibiliPopular = bili.value.data.songs ?? [];
      }

      // Only mark as fetched if at least the auth-status calls succeeded —
      // a fully failed fetch (network blip / server down) should NOT be
      // cached for 5 minutes, otherwise the user has to hard-reload to
      // recover when connectivity returns.
      const authOk =
        neAuthRes.status === 'fulfilled' ||
        qqAuthRes.status === 'fulfilled' ||
        kugouAuthRes.status === 'fulfilled';
      if (authOk) {
        this.lastFetchTime = Date.now();
      }
    },
  },
});
