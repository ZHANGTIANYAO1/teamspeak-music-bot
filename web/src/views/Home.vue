<template>
  <div class="home">
    <!-- Bot Instance Selector -->
    <div class="bot-selector" v-if="store.bots.length > 1">
      <button
        v-for="bot in store.bots"
        :key="bot.id"
        class="bot-tab"
        :class="{ active: bot.id === store.activeBotId }"
        @click="store.setActiveBotId(bot.id)"
      >
        {{ bot.name }}
      </button>
    </div>

    <!-- Search Bar -->
    <div class="search-bar" @click="$router.push('/search')">
      <Icon icon="mdi:magnify" class="search-icon" />
      <span class="search-placeholder">搜索歌曲、歌单、专辑...</span>
    </div>

    <!-- Now Playing -->
    <section v-if="store.currentSong" class="section">
      <h2 class="section-title">正在播放</h2>
      <div class="now-playing">
        <CoverArt :url="store.currentSong.coverUrl" :size="80" :radius="10" :show-shadow="true" />
        <div class="now-playing-info">
          <div class="now-playing-name">{{ store.currentSong.name }}</div>
          <div class="now-playing-artist">{{ store.currentSong.artist }} · {{ store.currentSong.album }}</div>
        </div>
      </div>
    </section>

    <!-- 私人FM -->
    <section class="section">
      <h2 class="section-title">私人FM</h2>
      <div class="fm-card hover-scale" @click="playFm">
        <div class="fm-icon-wrapper">
          <Icon icon="mdi:radio" class="fm-icon" />
        </div>
        <div class="fm-info">
          <div class="fm-title">开启私人FM</div>
          <div class="fm-desc">根据你的口味推荐音乐</div>
        </div>
        <Icon icon="mdi:play-circle" class="fm-play-icon" />
      </div>
    </section>

    <!-- 每日推荐 -->
    <section class="section" v-if="store.dailySongs.length > 0">
      <h2 class="section-title">每日推荐</h2>
      <div class="daily-grid">
        <div
          v-for="song in store.dailySongs.slice(0, 12)"
          :key="song.id"
          class="daily-card hover-scale"
          @click="store.playById(song.id, song.platform)"
        >
          <CoverArt :url="song.coverUrl" :size="120" :radius="10" :show-shadow="true" />
          <div class="daily-name">{{ song.name }}</div>
          <div class="daily-artist">{{ song.artist }}</div>
        </div>
      </div>
    </section>

    <!-- 推荐歌单 -->
    <section class="section" v-if="store.recommendPlaylists.length > 0">
      <h2 class="section-title">推荐歌单</h2>
      <div class="playlist-grid">
        <RouterLink
          v-for="playlist in store.recommendPlaylists"
          :key="playlist.id"
          :to="`/playlist/${playlist.id}?platform=${playlist.platform}`"
          class="playlist-card hover-scale"
        >
          <CoverArt :url="playlist.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ playlist.name }}</div>
        </RouterLink>
      </div>
    </section>

    <!-- 我的歌单 -->
    <section class="section" v-if="store.userPlaylists.length > 0">
      <h2 class="section-title">我的歌单</h2>
      <div class="playlist-grid">
        <RouterLink
          v-for="pl in store.userPlaylists"
          :key="pl.id"
          :to="`/playlist/${pl.id}?platform=${pl.platform}`"
          class="playlist-card hover-scale"
        >
          <CoverArt :url="pl.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ pl.name }}</div>
          <div class="playlist-count">{{ pl.songCount }} 首</div>
        </RouterLink>
      </div>
    </section>

    <!-- B站热门 -->
    <section class="section" v-if="store.bilibiliPopular.length > 0">
      <h2 class="section-title">
        <span class="bili-badge">B</span>
        B站热门
      </h2>
      <div class="daily-grid">
        <div
          v-for="song in store.bilibiliPopular.slice(0, 12)"
          :key="song.id"
          class="daily-card hover-scale"
          @click="store.playById(song.id, song.platform)"
        >
          <CoverArt :url="song.coverUrl" :size="120" :radius="10" :show-shadow="true" />
          <div class="daily-name">{{ song.name }}</div>
          <div class="daily-artist">{{ song.artist }}</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore, type Song } from '../stores/player.js';
import CoverArt from '../components/CoverArt.vue';

const store = usePlayerStore();

async function playFm() {
  try {
    const res = await axios.get('/api/music/personal/fm');
    const songs: Song[] = res.data.songs;
    if (songs.length > 0) {
      await store.play(songs[0].name, songs[0].platform);
      for (let i = 1; i < songs.length; i++) {
        await store.addToQueue(songs[i].name, songs[i].platform);
      }
    }
  } catch {
    // Ignore
  }
}

onMounted(() => {
  store.fetchHomeData();
});
</script>

<style lang="scss" scoped>
.bot-selector {
  display: flex;
  gap: 12px;
  margin-bottom: 28px;
}

.bot-tab {
  padding: 8px 20px;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 600;
  background: var(--hover-bg);
  opacity: 0.6;
  transition: all var(--transition-fast);

  &.active {
    background: var(--color-primary);
    color: white;
    opacity: 1;
  }
}

.search-bar {
  display: flex;
  align-items: center;
  padding: 12px 20px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  margin-bottom: 32px;
  cursor: pointer;
  transition: background var(--transition-fast);

  &:hover { background: var(--hover-bg); }
}

.search-icon {
  font-size: 20px;
  opacity: 0.4;
  margin-right: 12px;
}

.search-placeholder {
  opacity: 0.3;
  font-size: 14px;
}

.section {
  margin-bottom: 36px;
}

.section-title {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.bili-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: #00a1d6;
  color: white;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 800;
}

// Now Playing
.now-playing {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 20px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
}

.now-playing-name {
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 4px;
}

.now-playing-artist {
  font-size: 13px;
  color: var(--text-secondary);
}

// 私人FM
.fm-card {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 20px 24px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: background var(--transition-fast);

  &:hover {
    background: var(--hover-bg);
  }
}

.fm-icon-wrapper {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--color-primary), #6366f1);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.fm-icon {
  font-size: 28px;
  color: white;
}

.fm-info {
  flex: 1;
}

.fm-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
}

.fm-desc {
  font-size: 13px;
  color: var(--text-secondary);
}

.fm-play-icon {
  font-size: 36px;
  color: var(--color-primary);
  opacity: 0.8;
  transition: opacity var(--transition-fast);

  .fm-card:hover & {
    opacity: 1;
  }
}

// 每日推荐
.daily-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 20px;

  @media (max-width: 1200px) { grid-template-columns: repeat(4, 1fr); }
  @media (max-width: 900px) { grid-template-columns: repeat(3, 1fr); }
}

.daily-card {
  cursor: pointer;
}

.daily-name {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.daily-artist {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

// Playlists grid (shared for 推荐歌单 and 我的歌单)
.playlist-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 24px;

  @media (max-width: 1200px) { grid-template-columns: repeat(4, 1fr); }
  @media (max-width: 900px) { grid-template-columns: repeat(3, 1fr); }
}

.playlist-card {
  cursor: pointer;
  display: block;
  text-decoration: none;
  color: inherit;
}

.playlist-name {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.playlist-count {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}
</style>
