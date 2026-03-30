import { defineStore } from 'pinia';
import axios from 'axios';

export interface Song {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl: string;
  platform: 'netease' | 'qq';
}

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

const HOME_CACHE_TTL = 5 * 60 * 1000;

export const usePlayerStore = defineStore('player', {
  state: () => ({
    bots: [] as BotStatus[],
    activeBotId: null as string | null,
    queue: [] as Song[],
    theme: 'dark' as 'dark' | 'light',

    // Server-synced elapsed time (ground truth)
    serverElapsed: 0,       // last known server elapsed (seconds)
    serverSyncTime: 0,      // Date.now() when we got serverElapsed
    wasPlaying: false,       // was playing at last sync

    // Home page cache
    recommendPlaylists: [] as PlaylistItem[],
    dailySongs: [] as Song[],
    userPlaylists: [] as PlaylistItem[],
    bilibiliPopular: [] as Song[],
    lastFetchTime: 0,
  }),

  getters: {
    activeBot(): BotStatus | null {
      return this.bots.find((b) => b.id === this.activeBotId) ?? this.bots[0] ?? null;
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
    /** Interpolated elapsed: serverElapsed + time since last sync (if playing) */
    elapsed(): number {
      if (!this.activeBot?.currentSong) return 0;
      const maxDuration = this.activeBot.currentSong.duration || Infinity;
      if (!this.wasPlaying || this.serverSyncTime === 0) return Math.min(this.serverElapsed, maxDuration);
      if (this.isPaused) return Math.min(this.serverElapsed, maxDuration);
      return Math.min(this.serverElapsed + (Date.now() - this.serverSyncTime) / 1000, maxDuration);
    },
  },

  actions: {
    setActiveBotId(id: string) {
      this.activeBotId = id;
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

      if (botId !== (this.activeBotId ?? this.bots[0]?.id)) return;

      // Sync elapsed from server status
      if (status.elapsed !== undefined) {
        this.serverElapsed = status.elapsed;
        this.serverSyncTime = Date.now();
        this.wasPlaying = status.playing && !status.paused;
      }

      // Song changed — reset
      if (status.currentSong?.id !== prevSongId) {
        this.serverElapsed = status.elapsed ?? 0;
        this.serverSyncTime = Date.now();
        this.wasPlaying = status.playing && !status.paused;
      }
    },

    removeBotStatus(botId: string) {
      this.bots = this.bots.filter((b) => b.id !== botId);
    },

    setQueue(queue: Song[]) {
      this.queue = queue;
    },

    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', this.theme);
    },

    loadTheme() {
      const saved = localStorage.getItem('theme') as 'dark' | 'light' | null;
      if (saved) this.theme = saved;
    },

    async fetchBots() {
      const res = await axios.get('/api/bot');
      this.bots = res.data.bots;
      if (!this.activeBotId && this.bots.length > 0) {
        this.activeBotId = this.bots[0].id;
      }
      // Sync elapsed from first status
      const bot = this.activeBot;
      if (bot?.elapsed !== undefined) {
        this.serverElapsed = bot.elapsed;
        this.serverSyncTime = Date.now();
        this.wasPlaying = bot.playing && !bot.paused;
      }
    },

    /** Poll server for real elapsed time */
    async syncElapsed() {
      if (!this.activeBotId || !this.isPlaying) return;
      try {
        const res = await axios.get(`/api/player/${this.activeBotId}/elapsed`);
        this.serverElapsed = res.data.elapsed;
        this.serverSyncTime = Date.now();
        this.wasPlaying = true;
      } catch {
        // ignore
      }
    },

    async fetchQueue() {
      if (!this.activeBotId) return;
      try {
        const res = await axios.get(`/api/player/${this.activeBotId}/queue`);
        this.queue = res.data.queue ?? [];
      } catch {
        // ignore
      }
    },

    _syncAfterAction() {
      this.serverSyncTime = Date.now();
      this.wasPlaying = true;
      // Sync from server after a short delay for accuracy
      setTimeout(() => this.syncElapsed(), 500);
    },

    async playAtIndex(index: number) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/play-at`, { index });
      this.serverElapsed = 0;
      this._syncAfterAction();
    },

    async play(query: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/play`, { query, platform });
      this.serverElapsed = 0;
      this._syncAfterAction();
    },

    async playById(songId: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/play-by-id`, { songId, platform });
      this.serverElapsed = 0;
      this._syncAfterAction();
    },

    async addToQueue(query: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/add`, { query, platform });
    },

    async addToQueueById(songId: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/add-by-id`, { songId, platform });
    },

    async playPlaylist(playlistId: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/play-playlist`, { playlistId, platform });
      this.serverElapsed = 0;
      this._syncAfterAction();
    },

    async pause() {
      if (!this.activeBotId) return;
      // Freeze elapsed at current interpolated value
      this.serverElapsed = this.elapsed;
      this.wasPlaying = false;
      await axios.post(`/api/player/${this.activeBotId}/pause`);
    },

    async resume() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/resume`);
      this.serverSyncTime = Date.now();
      this.wasPlaying = true;
      setTimeout(() => this.syncElapsed(), 300);
    },

    async next() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/next`);
      this.serverElapsed = 0;
      this._syncAfterAction();
    },

    async prev() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/prev`);
      this.serverElapsed = 0;
      this._syncAfterAction();
    },

    async stop() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/stop`);
      this.serverElapsed = 0;
      this.serverSyncTime = 0;
      this.wasPlaying = false;
    },

    async seek(position: number) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/seek`, { position });
      this.serverElapsed = position;
      this._syncAfterAction();
    },

    async setVolume(volume: number) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/volume`, { volume });
    },

    async setMode(mode: string) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/mode`, { mode });
    },

    async fetchHomeData() {
      if (this.lastFetchTime > 0 && Date.now() - this.lastFetchTime < HOME_CACHE_TTL) {
        return;
      }

      const [playlistRes, dailyRes, userRes, biliRes] = await Promise.allSettled([
        axios.get('/api/music/recommend/playlists'),
        axios.get('/api/music/recommend/songs'),
        axios.get('/api/music/user/playlists'),
        axios.get('/api/music/bilibili/popular?limit=12'),
      ]);

      if (playlistRes.status === 'fulfilled') {
        this.recommendPlaylists = playlistRes.value.data.playlists;
      }
      if (dailyRes.status === 'fulfilled') {
        this.dailySongs = dailyRes.value.data.songs;
      }
      if (userRes.status === 'fulfilled') {
        this.userPlaylists = userRes.value.data.playlists;
      }
      if (biliRes.status === 'fulfilled') {
        this.bilibiliPopular = biliRes.value.data.songs;
      }

      this.lastFetchTime = Date.now();
    },
  },
});
