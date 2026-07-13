<template>
  <div class="home">
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

    <!-- 私人FM（音源按 enabledProviders 门控；Jellyfin 电台优先） -->
    <section v-if="fmCardCount > 0" class="section">
      <h2 class="section-title">私人FM</h2>
      <div v-if="enabled('jellyfin')" class="fm-card hover-scale" @click="playFm('jellyfin')">
        <div class="fm-icon-wrapper jellyfin">
          <Icon icon="mdi:jellyfish" class="fm-icon" />
        </div>
        <div class="fm-info">
          <div class="fm-title">Jellyfin 电台</div>
          <div class="fm-desc">从收藏出发的 Instant Mix 歌曲流</div>
        </div>
        <Icon icon="mdi:play-circle" class="fm-play-icon" />
      </div>
      <div v-if="enabled('netease')" class="fm-card hover-scale" @click="playFm('netease')">
        <div class="fm-icon-wrapper">
          <Icon icon="mdi:radio" class="fm-icon" />
        </div>
        <div class="fm-info">
          <div class="fm-title">开启私人FM</div>
          <div class="fm-desc">根据你的口味推荐音乐</div>
        </div>
        <Icon icon="mdi:play-circle" class="fm-play-icon" />
      </div>
      <div v-if="enabled('qq') && store.authStatus.qq" class="fm-card hover-scale" @click="playFm('qq')">
        <div class="fm-icon-wrapper qq">
          <Icon icon="mdi:radar" class="fm-icon" />
        </div>
        <div class="fm-info">
          <div class="fm-title">QQ音乐雷达</div>
          <div class="fm-desc">猜你喜欢 / 雷达推荐歌曲流</div>
        </div>
        <Icon icon="mdi:play-circle" class="fm-play-icon" />
      </div>
      <div v-if="enabled('kugou') && store.authStatus.kugou" class="fm-card hover-scale" @click="playFm('kugou')">
        <div class="fm-icon-wrapper kugou">
          <Icon icon="mdi:radio-tower" class="fm-icon" />
        </div>
        <div class="fm-info">
          <div class="fm-title">酷狗私人电台</div>
          <div class="fm-desc">个性化推荐歌曲流</div>
        </div>
        <Icon icon="mdi:play-circle" class="fm-play-icon" />
      </div>
    </section>

    <!-- Jellyfin: 最近添加 -->
    <section class="section" v-if="store.jellyfinLatestAlbums.length > 0">
      <h2 class="section-title">最近添加</h2>
      <div class="playlist-grid">
        <RouterLink
          v-for="al in store.jellyfinLatestAlbums"
          :key="al.id"
          :to="`/album/${al.id}?platform=jellyfin`"
          class="playlist-card hover-scale"
        >
          <CoverArt :url="al.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ al.name }}</div>
          <div class="playlist-count">{{ al.artist }}</div>
        </RouterLink>
      </div>
    </section>

    <!-- Jellyfin: 播放最多 -->
    <section class="section" v-if="store.jellyfinMostPlayed.length > 0">
      <h2 class="section-title">播放最多</h2>
      <div class="daily-grid">
        <div
          v-for="song in store.jellyfinMostPlayed"
          :key="song.id"
          class="daily-card hover-scale"
          @click="store.playSong(song)"
        >
          <CoverArt :url="song.coverUrl" :size="120" :radius="10" :show-shadow="true" />
          <div class="daily-name">{{ song.name }}</div>
          <div class="daily-artist">{{ song.artist }}</div>
        </div>
      </div>
    </section>

    <!-- Jellyfin: 收藏曲目 -->
    <section class="section" v-if="store.jellyfinFavorites.length > 0">
      <h2 class="section-title">
        <Icon icon="mdi:star" style="color: var(--brand-jellyfin)" />
        Jellyfin 收藏
      </h2>
      <div class="daily-grid">
        <div
          v-for="song in store.jellyfinFavorites"
          :key="song.id"
          class="daily-card hover-scale"
          @click="store.playSong(song)"
        >
          <CoverArt :url="song.coverUrl" :size="120" :radius="10" :show-shadow="true" />
          <div class="daily-name">{{ song.name }}</div>
          <div class="daily-artist">{{ song.artist }}</div>
        </div>
      </div>
    </section>

    <!-- Jellyfin: 流派 -->
    <section class="section" v-if="store.jellyfinGenres.length > 0">
      <h2 class="section-title">流派</h2>
      <div class="genre-chips">
        <button
          v-for="g in store.jellyfinGenres"
          :key="g.id"
          class="genre-chip"
          @click="store.playJellyfinGenre(g.id)"
        >
          <Icon icon="mdi:music-note" />
          {{ g.name }}
        </button>
      </div>
    </section>

    <!-- 每日推荐 -->
    <section class="section" v-if="dailyAvailable.length > 0">
      <h2 class="section-title">
        每日推荐
        <SourceTabs :model-value="dailySourceSafe" @update:model-value="dailySource = $event" :sources="dailyAvailable" />
      </h2>
      <div class="daily-grid">
        <div
          v-for="song in (store.dailySongs[dailySourceSafe] ?? []).slice(0, 12)"
          :key="song.id"
          class="daily-card hover-scale"
          @click="store.playSong(song)"
        >
          <CoverArt :url="song.coverUrl" :size="120" :radius="10" :show-shadow="true" />
          <div class="daily-name">{{ song.name }}</div>
          <div class="daily-artist">{{ song.artist }}</div>
        </div>
      </div>
    </section>

    <!-- 推荐歌单 -->
    <section class="section" v-if="recommendAvailable.length > 0">
      <h2 class="section-title">
        推荐歌单
        <SourceTabs :model-value="recommendSourceSafe" @update:model-value="recommendSource = $event" :sources="recommendAvailable" />
      </h2>
      <div class="playlist-grid">
        <RouterLink
          v-for="playlist in (store.recommendPlaylists[recommendSourceSafe] ?? [])"
          :key="playlist.id"
          :to="`/playlist/${playlist.id}?platform=${playlist.platform}`"
          class="playlist-card hover-scale"
        >
          <CoverArt :url="playlist.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ playlist.name }}</div>
        </RouterLink>
      </div>
    </section>

    <!-- 我的收藏 -->
    <section class="section" v-if="store.favoritedPlaylists.length > 0">
      <h2 class="section-title">
        <Icon icon="mdi:heart" style="color: var(--color-primary)" />
        我的收藏
        <span class="section-count">{{ store.favoritedPlaylists.length }}</span>
      </h2>
      <div class="playlist-grid">
        <RouterLink
          v-for="fav in store.favoritedPlaylists"
          :key="fav.id"
          :to="`/playlist/${fav.playlistId}?platform=${fav.platform}`"
          class="playlist-card hover-scale"
        >
          <CoverArt :url="fav.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ fav.name }}</div>
          <div class="playlist-count">{{ fav.songCount }} 首</div>
        </RouterLink>
      </div>
    </section>

    <!-- 我的歌单 -->
    <section class="section" v-if="userAvailable.length > 0">
      <h2 class="section-title">
        我的歌单
        <span v-if="currentUserPlaylists.length > 0" class="section-count">{{ currentUserPlaylists.length }}</span>
        <SourceTabs :model-value="userSourceSafe" @update:model-value="userSource = $event" :sources="userAvailable" />
      </h2>
      <div class="playlist-grid">
        <RouterLink
          v-for="pl in visibleUserPlaylists"
          :key="pl.id"
          :to="`/playlist/${pl.id}?platform=${pl.platform}`"
          class="playlist-card hover-scale"
        >
          <CoverArt :url="pl.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ pl.name }}</div>
          <div class="playlist-count">{{ pl.songCount }} 首</div>
        </RouterLink>
      </div>
      <button
        v-if="currentUserPlaylists.length > USER_PLAYLIST_LIMIT"
        class="expand-btn"
        @click="userPlaylistsExpanded = !userPlaylistsExpanded"
      >
        <Icon :icon="userPlaylistsExpanded ? 'mdi:chevron-up' : 'mdi:chevron-down'" />
        {{ userPlaylistsExpanded ? '收起' : `展开全部 ${currentUserPlaylists.length} 个歌单` }}
      </button>
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
          @click="store.playSong(song)"
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
import { ref, computed, watch, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import { Icon } from '@iconify/vue';
import { usePlayerStore, type Source } from '../stores/player.js';
import { loadTabSource, saveTabSource } from '../stores/sourceTabs.js';
import CoverArt from '../components/CoverArt.vue';
import SourceTabs from '../components/SourceTabs.vue';

const store = usePlayerStore();
const USER_PLAYLIST_LIMIT = 20;
const userPlaylistsExpanded = ref(false);

// Server-side source gate (enabledProviders).
const enabled = (p: string) => store.enabledProviders.includes(p);
const fmCardCount = computed(() =>
  ['jellyfin', 'netease'].filter(enabled).length +
  (enabled('qq') && store.authStatus.qq ? 1 : 0) +
  (enabled('kugou') && store.authStatus.kugou ? 1 : 0),
);

// Available sources per section. Jellyfin has no daily/recommend concept —
// it gets its own home sections instead — so those two tab bars only ever
// carry the legacy sources (which is also what their store maps are keyed by).
type LegacySource = Exclude<Source, 'jellyfin'>;

// Recommend playlists work anonymously on netease (when enabled);
// QQ requires login. This intentionally differs from dailyAvailable/userAvailable.
const recommendAvailable = computed<LegacySource[]>(() => {
  const s: LegacySource[] = [];
  if (enabled('netease')) s.push('netease');
  if (enabled('qq') && store.authStatus.qq) s.push('qq');
  if (enabled('kugou') && store.authStatus.kugou) s.push('kugou');
  return s;
});
const dailyAvailable = computed<LegacySource[]>(() =>
  store.availableSources.filter((s): s is LegacySource => s !== 'jellyfin'),
);
const userAvailable = computed<Source[]>(() => store.availableSources);

// Persisted active source per section.
const recommendSource = ref<Source>(loadTabSource('home.recommend'));
const dailySource     = ref<Source>(loadTabSource('home.daily'));
const userSource      = ref<Source>(loadTabSource('home.user'));

watch(recommendSource, (v) => saveTabSource('home.recommend', v));
watch(dailySource,     (v) => saveTabSource('home.daily',     v));
watch(userSource,      (v) => saveTabSource('home.user',      v));

// Fallback when persisted source is no longer available.
const recommendSourceSafe = computed<LegacySource>(() =>
  (recommendAvailable.value as Source[]).includes(recommendSource.value)
    ? (recommendSource.value as LegacySource)
    : recommendAvailable.value[0] ?? 'netease'
);
const dailySourceSafe = computed<LegacySource>(() =>
  (dailyAvailable.value as Source[]).includes(dailySource.value)
    ? (dailySource.value as LegacySource)
    : dailyAvailable.value[0] ?? 'netease'
);
const userSourceSafe = computed<Source>(() =>
  userAvailable.value.includes(userSource.value)
    ? userSource.value
    : userAvailable.value[0] ?? 'netease'
);

const currentUserPlaylists = computed(() => store.userPlaylists[userSourceSafe.value] ?? []);
const visibleUserPlaylists = computed(() =>
  userPlaylistsExpanded.value
    ? currentUserPlaylists.value
    : currentUserPlaylists.value.slice(0, USER_PLAYLIST_LIMIT)
);

async function playFm(platform: Source) {
  await store.startFm(platform);
}

onMounted(() => {
  store.fetchHomeData();
});
</script>

<style lang="scss" scoped>
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

  @media (max-width: 768px) {
    margin-bottom: 28px;
  }
}

.section-title {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;

  @media (max-width: 768px) {
    font-size: 18px;
    margin-bottom: 12px;
  }
}

.section-count {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-tertiary);
}

.expand-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  padding: 10px;
  margin-top: 12px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  transition: all var(--transition-fast);

  &:hover {
    background: var(--hover-bg);
    color: var(--color-primary);
  }
}

.bili-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: var(--brand-bilibili);
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
  margin-bottom: 12px;

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

  &.qq {
    background: linear-gradient(135deg, var(--brand-qq), #17a2b8);
  }

  &.kugou {
    background: linear-gradient(135deg, var(--brand-kugou), #1d7fd1);
  }

  // Jellyfin's brand gradient (purple → blue).
  &.jellyfin {
    background: linear-gradient(135deg, var(--brand-jellyfin), #00a4dc);
  }
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
  @media (max-width: 768px) { grid-template-columns: repeat(3, 1fr); gap: 14px; }
}

.daily-card {
  cursor: pointer;
  min-width: 0;
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
  @media (max-width: 768px) { grid-template-columns: repeat(3, 1fr); gap: 14px; }
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

// Jellyfin 流派
.genre-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.genre-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--bg-card);
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);

  &:hover {
    color: var(--brand-jellyfin);
    background: var(--brand-jellyfin-12);
  }
}
</style>
