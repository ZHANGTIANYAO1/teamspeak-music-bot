<template>
  <div class="search-page">
    <button class="back-btn" @click="$router.back()">
      <Icon icon="mdi:arrow-left" />
      返回
    </button>
    <div class="search-header">
      <div class="search-input-wrap">
        <Icon icon="mdi:magnify" class="search-icon" />
        <input
          ref="searchInput"
          v-model="query"
          class="search-input"
          placeholder="搜索歌曲、歌手、专辑..."
          @keyup.enter="doSearch"
          autofocus
        />
      </div>

      <div
        v-if="localAudioEnabled"
        class="local-upload"
        :class="{ dragging: isDragging, uploading }"
        @dragenter.prevent="isDragging = true"
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="handleDrop"
      >
        <Icon icon="mdi:tray-arrow-up" class="upload-icon" />
        <div class="upload-copy">
          <div class="upload-title">拖拽本地音频 / 视频到这里上传</div>
          <div class="upload-subtitle">音频支持 mp3、flac、wav、m4a、ogg、opus、aac、webm 等，视频支持 mp4、mov、avi、mkv、flv、wmv 等（只取其中的音轨播放）；上传后可直接播放或加入队列</div>
        </div>
        <button class="upload-btn" :disabled="uploading" @click="fileInput?.click()">
          {{ uploading ? '上传中...' : '选择文件' }}
        </button>
        <input
          ref="fileInput"
          class="file-input"
          type="file"
          multiple
          accept="audio/*,video/*,.mp3,.flac,.wav,.m4a,.aac,.ogg,.opus,.webm,.wma,.alac,.aiff,.ape,.mp4,.mov,.avi,.mkv,.flv,.wmv,.m4v,.mpg,.mpeg,.3gp,.ts,.m2ts,.ogv"
          @change="handleFileSelect"
        />
      </div>
      <div v-else class="local-upload disabled">
        <Icon icon="mdi:music-off" class="upload-icon" />
        <div class="upload-copy">
          <div class="upload-title">本地音频播放已关闭</div>
          <div class="upload-subtitle">管理员可在「设置 → 行为设置 → 本地音频播放」中开启。</div>
        </div>
      </div>
      <div v-if="uploadMessage" class="upload-message" :class="uploadMessageType">{{ uploadMessage }}</div>
    </div>

    <div v-if="loading" class="loading">搜索中...</div>

    <template v-else-if="allSongs.length || allAlbums.length || allPlaylists.length">
      <!-- Only enabled sources are offered (enabledProviders gate); Jellyfin
           (opt-in) comes first when enabled. -->
      <div class="source-bar">
        <button
          v-if="sourceEnabled('jellyfin')"
          class="source-btn"
          :class="{ active: selectedSource === 'jellyfin' }"
          @click="selectedSource = 'jellyfin'"
        >Jellyfin</button>
        <button
          v-if="sourceEnabled('netease')"
          class="source-btn"
          :class="{ active: selectedSource === 'netease' }"
          @click="selectedSource = 'netease'"
        >网易云</button>
        <button
          v-if="sourceEnabled('qq')"
          class="source-btn"
          :class="{ active: selectedSource === 'qq' }"
          @click="selectedSource = 'qq'"
        >QQ</button>
        <button
          v-if="sourceEnabled('bilibili')"
          class="source-btn"
          :class="{ active: selectedSource === 'bilibili' }"
          @click="selectedSource = 'bilibili'"
        >B站</button>
        <button
          v-if="sourceEnabled('kugou')"
          class="source-btn"
          :class="{ active: selectedSource === 'kugou' }"
          @click="selectedSource = 'kugou'"
        >酷狗</button>
        <button
          v-if="hasLocalSongs"
          class="source-btn"
          :class="{ active: selectedSource === 'local' }"
          @click="selectedSource = 'local'"
        >本地</button>
      </div>

      <div class="tab-bar">
        <button
          class="tab"
          :class="{ active: activeTab === 'songs' }"
          @click="activeTab = 'songs'"
        >
          单曲<span class="tab-count">{{ filteredSongs.length }}</span>
        </button>
        <button
          v-if="selectedSource !== 'bilibili' && selectedSource !== 'local' && selectedSource !== 'kugou'"
          class="tab"
          :class="{ active: activeTab === 'albums' }"
          @click="activeTab = 'albums'"
        >
          专辑<span class="tab-count">{{ filteredAlbums.length }}</span>
        </button>
        <button
          v-if="selectedSource !== 'bilibili' && selectedSource !== 'local' && selectedSource !== 'kugou'"
          class="tab"
          :class="{ active: activeTab === 'playlists' }"
          @click="activeTab = 'playlists'"
        >
          歌单<span class="tab-count">{{ filteredPlaylists.length }}</span>
        </button>
      </div>

      <section v-if="activeTab === 'albums' && filteredAlbums.length" class="result-section">
        <div class="card-grid">
          <router-link
            v-for="al in filteredAlbums"
            :key="`${al.platform}-${al.id}`"
            :to="`/album/${al.id}?platform=${al.platform}`"
            class="card hover-scale"
          >
            <CoverArt :url="al.coverUrl" :size="160" :radius="10" :show-shadow="true" />
            <div class="card-name">
              {{ al.name }}
              <span class="platform-badge" :class="badgeClass(al.platform)">{{ badgeLabel(al.platform) }}</span>
            </div>
            <div class="card-sub">{{ al.artist }}</div>
          </router-link>
        </div>
      </section>

      <section v-if="activeTab === 'playlists' && filteredPlaylists.length" class="result-section">
        <div class="card-grid">
          <router-link
            v-for="pl in filteredPlaylists"
            :key="`${pl.platform}-${pl.id}`"
            :to="`/playlist/${pl.id}?platform=${pl.platform}`"
            class="card hover-scale"
          >
            <CoverArt :url="pl.coverUrl" :size="160" :radius="10" :show-shadow="true" />
            <button
              class="fav-badge"
              :class="{ favorited: isFav(pl) }"
              @click.prevent.stop="toggleFavPlaylist(pl)"
            >
              <Icon :icon="isFav(pl) ? 'mdi:heart' : 'mdi:heart-outline'" />
            </button>
            <div class="card-name">
              {{ pl.name }}
              <span class="platform-badge" :class="badgeClass(pl.platform)">{{ badgeLabel(pl.platform) }}</span>
            </div>
          </router-link>
        </div>
      </section>

      <section v-if="activeTab === 'songs' && filteredSongs.length" class="result-section">
        <SongCard
          v-for="(song, i) in filteredSongs"
          :key="`${song.platform}-${song.id}`"
          :song="song"
          :index="i + 1"
          :active="store.currentSong?.id === song.id"
          @play="store.playSong(song)"
          @playNext="store.playNextSong(song)"
          @add="store.addSong(song)"
        />
      </section>

      <div v-if="showLoadMore" class="load-more-wrap">
        <button class="load-more-btn" :disabled="currentLoadingMore" @click="loadMore">
          <Icon v-if="currentLoadingMore" icon="mdi:loading" class="spin" />
          {{ currentLoadingMore ? '加载中...' : '加载更多' }}
        </button>
      </div>
    </template>

    <div v-else-if="searched" class="empty">未找到相关结果</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore } from '../stores/player.js';
import type { Song } from '../stores/player.js';
import SongCard from '../components/SongCard.vue';
import CoverArt from '../components/CoverArt.vue';
import { mergeDedup, hasMore, nextOffset } from './searchPagination.js';

const PAGE_SIZE = 20;

const store = usePlayerStore();
const route = useRoute();
const router = useRouter();

const SOURCE_STORAGE_KEY = 'search-source';

type SearchSource = 'jellyfin' | 'netease' | 'qq' | 'bilibili' | 'local' | 'kugou';

const SEARCH_SOURCES: SearchSource[] = ['jellyfin', 'netease', 'qq', 'bilibili', 'local', 'kugou'];

function loadSource(): SearchSource {
  try {
    const stored = localStorage.getItem(SOURCE_STORAGE_KEY);
    if (SEARCH_SOURCES.includes(stored as SearchSource)) return stored as SearchSource;
  } catch { /* localStorage blocked */ }
  return 'netease';
}

type TabType = 'songs' | 'albums' | 'playlists';

const query = ref((route.query.q as string) || '');
const activeTab = ref<TabType>('songs');
const selectedSource = ref<SearchSource>(loadSource());

interface Album { id: string; name: string; artist: string; coverUrl: string; songCount?: number; platform: string; }
interface Playlist { id: string; name: string; coverUrl: string; songCount?: number; platform: string; }

const allSongs = ref<Song[]>([]);
const allAlbums = ref<Album[]>([]);
const allPlaylists = ref<Playlist[]>([]);
// "加载更多" 分页状态：hasMore 按 (类型, 音源) 记录，loadingMore 按类型记录。
const hasMoreMap = ref<Record<string, boolean>>({});
const loadingMore = ref<Record<TabType, boolean>>({ songs: false, albums: false, playlists: false });
const loading = ref(false);
const searched = ref(false);
const uploading = ref(false);
const isDragging = ref(false);
const uploadMessage = ref('');
const uploadMessageType = ref<'info' | 'error'>('info');
const fileInput = ref<HTMLInputElement | null>(null);
const localAudioEnabled = ref(true);

const filteredSongs = computed(() =>
  allSongs.value.filter((s) => s.platform === selectedSource.value)
);

const filteredAlbums = computed(() =>
  allAlbums.value.filter((a) => a.platform === selectedSource.value)
);

const filteredPlaylists = computed(() =>
  allPlaylists.value.filter((p) => p.platform === selectedSource.value)
);

const hasLocalSongs = computed(() => localAudioEnabled.value && allSongs.value.some((s) => s.platform === 'local'));

// Server-side source gate (enabledProviders). Until /providers loads, the
// store list is empty — treat that as "everything shown" so a slow request
// doesn't blank the bar.
function sourceEnabled(p: string): boolean {
  return store.enabledProviders.length === 0 || store.enabledProviders.includes(p);
}

/** Snap a disabled/stale selection to the configured default (or first enabled). */
function fixupSelectedSource() {
  if (selectedSource.value === 'local' || sourceEnabled(selectedSource.value)) return;
  const def = store.defaultSource as SearchSource;
  selectedSource.value = SEARCH_SOURCES.includes(def) && sourceEnabled(def)
    ? def
    : SEARCH_SOURCES.find((s) => s !== 'local' && sourceEnabled(s)) ?? 'netease';
}

// ---- 分页 / 加载更多 ----
function pageKey(type: TabType, source: string): string {
  return `${type}:${source}`;
}

const currentItems = computed(() => {
  if (activeTab.value === 'albums') return filteredAlbums.value;
  if (activeTab.value === 'playlists') return filteredPlaylists.value;
  return filteredSongs.value;
});

const currentLoadingMore = computed(() => loadingMore.value[activeTab.value]);

const currentHasMore = computed(
  () => hasMoreMap.value[pageKey(activeTab.value, selectedSource.value)] ?? false
);

// 有结果、还有下一页时才显示按钮；加载中时按钮保留但禁用并显示 spinner。
const showLoadMore = computed(() => currentItems.value.length > 0 && currentHasMore.value);

function resetPagination() {
  hasMoreMap.value = {};
  loadingMore.value = { songs: false, albums: false, playlists: false };
}

// 记录某个 (类型, 音源) 是否还有更多：返回条数 === PAGE_SIZE 视为还有下一页。
function setHasMore(type: TabType, source: string, returnedCount: number) {
  hasMoreMap.value = {
    ...hasMoreMap.value,
    [pageKey(type, source)]: hasMore(returnedCount, PAGE_SIZE),
  };
}

// 初始 /search/all 返回的是各音源合并的首页，按音源分组统计每种类型的条数。
function recordInitialHasMore(items: { platform: string }[], type: TabType) {
  const counts: Record<string, number> = {};
  for (const it of items) counts[it.platform] = (counts[it.platform] ?? 0) + 1;
  const next = { ...hasMoreMap.value };
  for (const [source, count] of Object.entries(counts)) {
    next[pageKey(type, source)] = hasMore(count, PAGE_SIZE);
  }
  hasMoreMap.value = next;
}

async function loadMore() {
  const type = activeTab.value;
  const source = selectedSource.value;
  if (loadingMore.value[type]) return;
  if (!currentHasMore.value) return;
  const offset = nextOffset(currentItems.value.length, PAGE_SIZE);
  loadingMore.value = { ...loadingMore.value, [type]: true };
  try {
    const res = await axios.get('/api/music/search', {
      params: { q: query.value, platform: source, limit: PAGE_SIZE, offset },
    });
    if (type === 'albums') {
      const incoming = (res.data.albums ?? []) as Album[];
      allAlbums.value = mergeDedup(allAlbums.value, incoming);
      setHasMore(type, source, incoming.length);
    } else if (type === 'playlists') {
      const incoming = (res.data.playlists ?? []) as Playlist[];
      allPlaylists.value = mergeDedup(allPlaylists.value, incoming);
      setHasMore(type, source, incoming.length);
    } else {
      const incoming = (res.data.songs ?? []) as Song[];
      allSongs.value = mergeDedup(allSongs.value, incoming);
      setHasMore(type, source, incoming.length);
    }
  } catch {
    // 保留 hasMore 现状，允许用户重试。
  } finally {
    loadingMore.value = { ...loadingMore.value, [type]: false };
  }
}

// Persist source preference
watch(selectedSource, (src) => {
  try { localStorage.setItem(SOURCE_STORAGE_KEY, src); } catch { /* ignore */ }
});

// B站 / 本地上传没有专辑和歌单页签，切换时强制回到单曲。
watch(selectedSource, (src) => {
  if ((src === 'bilibili' || src === 'local' || src === 'kugou') && activeTab.value !== 'songs') {
    activeTab.value = 'songs';
  }
});

function isFav(pl: { id: string; platform: string }): boolean {
  return store.isFavorited(pl.id, pl.platform);
}

async function toggleFavPlaylist(pl: { id: string; platform: string; name: string; coverUrl: string; songCount?: number }) {
  if (isFav(pl)) {
    const fav = store.favoritedPlaylists.find((f) => f.playlistId === pl.id && f.platform === pl.platform);
    if (fav) await store.removeFavorite(fav.id);
  } else {
    await store.addFavorite({
      platform: pl.platform,
      playlistId: pl.id,
      name: pl.name,
      coverUrl: pl.coverUrl,
      songCount: pl.songCount ?? 0,
    });
  }
}

async function doSearch() {
  if (!query.value.trim()) return;
  loading.value = true;
  searched.value = true;
  activeTab.value = 'songs';
  resetPagination();
  router.replace({ query: { q: query.value } });
  try {
    const res = await axios.get('/api/music/search/all', { params: { q: query.value } });
    allSongs.value = res.data.songs ?? [];
    allAlbums.value = res.data.albums ?? [];
    allPlaylists.value = res.data.playlists ?? [];
    recordInitialHasMore(allSongs.value, 'songs');
    recordInitialHasMore(allAlbums.value, 'albums');
    recordInitialHasMore(allPlaylists.value, 'playlists');
  } catch {
    allSongs.value = []; allAlbums.value = []; allPlaylists.value = [];
  } finally {
    loading.value = false;
  }
}


/** Must match LOCAL_UPLOAD_LIMIT in src/web/api/music.ts. */
const UPLOAD_MAX_MB = 500;
const UPLOAD_MAX_BYTES = UPLOAD_MAX_MB * 1024 * 1024;

// Video is accepted too (#149) — the server keeps only the audio track.
// Keep the extension list in sync with AUDIO_EXTENSIONS / VIDEO_EXTENSIONS in
// src/music/local.ts; the server re-validates, this just avoids a round-trip.
function isMediaFile(file: File): boolean {
  return file.type.startsWith('audio/')
    || file.type.startsWith('video/')
    || /\.(mp3|flac|wav|m4a|aac|ogg|opus|webm|wma|alac|aiff|ape|mp4|mov|avi|mkv|flv|wmv|m4v|mpg|mpeg|3gp|ts|m2ts|ogv)$/i.test(file.name);
}

async function uploadLocalFiles(fileList: File[]) {
  if (!localAudioEnabled.value) {
    uploadMessageType.value = 'error';
    uploadMessage.value = '本地音频播放已关闭';
    return;
  }
  const candidates = fileList.filter(isMediaFile);
  if (candidates.length === 0) {
    uploadMessageType.value = 'error';
    uploadMessage.value = '没有找到可上传的音频 / 视频文件';
    return;
  }

  // Reject oversize files before spending minutes uploading them (#149).
  // The server enforces the same cap (LOCAL_UPLOAD_LIMIT in
  // src/web/api/music.ts) and answers 413 — this only saves the round-trip,
  // which matters now that a single video can be hundreds of megabytes.
  const files = candidates.filter((f) => f.size <= UPLOAD_MAX_BYTES);
  const oversize = candidates.filter((f) => f.size > UPLOAD_MAX_BYTES);
  if (files.length === 0) {
    uploadMessageType.value = 'error';
    uploadMessage.value = `文件太大，单个文件上限 ${UPLOAD_MAX_MB} MB：${oversize[0].name}`;
    return;
  }

  uploading.value = true;
  uploadMessageType.value = 'info';
  uploadMessage.value = `正在上传 ${files.length} 个文件...`;

  const uploaded: Song[] = [];
  const failed: string[] = oversize.map((f) => `${f.name}: 超过 ${UPLOAD_MAX_MB} MB 上限`);
  for (const [i, file] of files.entries()) {
    // Videos are orders of magnitude bigger than the audio files this used to
    // handle (#149), so a silent "正在上传..." can sit there for minutes and
    // look hung. Report per-file percentage while the bytes are in flight, and
    // switch to a processing note once the server takes over (it still has to
    // probe the file and remux the audio track out).
    const label = files.length > 1 ? `（${i + 1}/${files.length}）` : '';
    const setProgress = (text: string) => {
      uploadMessageType.value = 'info';
      uploadMessage.value = `${text}${label}：${file.name}`;
    };
    setProgress('正在上传');
    try {
      const res = await axios.post('/api/music/local/upload', file, {
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
        maxBodyLength: Infinity,
        onUploadProgress: (e) => {
          if (!e.total) return;
          const pct = Math.round((e.loaded / e.total) * 100);
          setProgress(pct >= 100 ? '服务端处理中' : `正在上传 ${pct}%`);
        },
      });
      if (res.data?.song) uploaded.push(res.data.song as Song);
    } catch (err: any) {
      failed.push(`${file.name}: ${err?.response?.data?.error || '上传失败'}`);
    }
  }

  if (uploaded.length > 0) {
    const uploadedKeys = new Set(uploaded.map((s) => `${s.platform}-${s.id}`));
    allSongs.value = [
      ...uploaded,
      ...allSongs.value.filter((s) => !uploadedKeys.has(`${s.platform}-${s.id}`)),
    ];
    selectedSource.value = 'local';
    activeTab.value = 'songs';
    searched.value = true;
    uploadMessageType.value = failed.length ? 'error' : 'info';
    uploadMessage.value = failed.length
      ? `已上传 ${uploaded.length} 个，失败 ${failed.length} 个：${failed[0]}`
      : `已上传 ${uploaded.length} 个本地音频`;
  } else {
    uploadMessageType.value = 'error';
    uploadMessage.value = failed[0] || '上传失败';
  }

  uploading.value = false;
}

function handleDrop(event: DragEvent) {
  isDragging.value = false;
  const files = Array.from(event.dataTransfer?.files ?? []);
  uploadLocalFiles(files);
}

function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  uploadLocalFiles(Array.from(input.files ?? []));
  input.value = '';
}

function badgeLabel(platform: string): string {
  if (platform === 'qq') return 'QQ';
  if (platform === 'bilibili') return 'B站';
  if (platform === 'youtube') return 'YouTube';
  if (platform === 'local') return '本地';
  if (platform === 'kugou') return '酷狗';
  if (platform === 'jellyfin') return 'Jellyfin';
  return '网易云';
}

function badgeClass(platform: string): string {
  if (platform === 'qq') return 'badge-qq';
  if (platform === 'bilibili') return 'badge-bilibili';
  if (platform === 'youtube') return 'badge-youtube';
  if (platform === 'local') return 'badge-local';
  if (platform === 'kugou') return 'badge-kugou';
  if (platform === 'jellyfin') return 'badge-jellyfin';
  return 'badge-netease';
}

async function loadLocalAudioSetting() {
  try {
    const res = await axios.get('/api/bot/settings');
    localAudioEnabled.value = res.data.localAudioEnabled ?? true;
    if (!localAudioEnabled.value && selectedSource.value === 'local') {
      selectedSource.value = 'netease';
    }
  } catch {
    // Guests may not be allowed to read settings; backend still enforces the switch.
  }
}

onMounted(async () => {
  loadLocalAudioSetting();
  if (query.value) doSearch();
  await store.fetchProviders();
  fixupSelectedSource();
});
</script>

<style lang="scss" scoped>
.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  opacity: 0.7;
  margin-bottom: 16px;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }
}

.search-header {
  margin-bottom: 24px;
}

.local-upload {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-card);
  transition: border-color var(--transition-fast), background var(--transition-fast), transform var(--transition-fast);

  &.dragging {
    border-color: var(--color-primary);
    background: var(--color-primary-10);
    transform: translateY(-1px);
  }

  &.uploading {
    opacity: 0.8;
  }
}

.upload-icon {
  flex-shrink: 0;
  font-size: 28px;
  color: var(--color-primary);
}

.upload-copy {
  flex: 1;
  min-width: 0;
}

.upload-title {
  font-size: 14px;
  font-weight: var(--fw-semi);
  color: var(--text-primary);
}

.upload-subtitle {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.4;
}

.upload-btn {
  flex-shrink: 0;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: #fff;
  font-size: 13px;
  font-weight: var(--fw-semi);
  cursor: pointer;

  &:disabled {
    cursor: not-allowed;
    opacity: 0.65;
  }
}

.file-input {
  display: none;
}

.local-upload.disabled {
  opacity: 0.65;
  border-style: solid;
}

.upload-message {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);

  &.error {
    color: #e74c3c;
  }
}

.search-input-wrap {
  display: flex;
  align-items: center;
  padding: 14px 20px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  margin-bottom: 16px;
}

.search-icon {
  font-size: 22px;
  opacity: 0.4;
  margin-right: 12px;
}

.search-input {
  flex: 1;
  border: none;
  background: none;
  outline: none;
  font-size: 16px;
  font-family: inherit;
  color: var(--text-primary);

  &::placeholder {
    color: var(--text-tertiary);
  }
}

.loading {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
}

.empty {
  text-align: center;
  padding: 60px;
  color: var(--text-tertiary);
  font-size: 14px;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.source-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.source-btn {
  padding: 5px 16px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-family: inherit;
  font-weight: var(--fw-semi);
  color: var(--text-secondary);
  background: var(--bg-card);
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;

  &:hover { color: var(--text-primary); }

  &.active {
    color: var(--color-primary);
    background: rgba(51, 94, 234, 0.12);
  }
}

.tab-bar {
  display: flex;
  gap: 6px;
  margin-bottom: 24px;
  padding: 4px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  width: fit-content;
}

.tab {
  padding: 8px 20px;
  border-radius: calc(var(--radius-md) - 2px);
  font-size: 14px;
  font-family: inherit;
  font-weight: var(--fw-semi);
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;

  &:hover { color: var(--text-primary); }

  &.active {
    background: var(--color-primary);
    color: #fff;
    .tab-count { opacity: 0.85; }
  }
}

.tab-count {
  margin-left: 5px;
  opacity: 0.55;
  font-weight: var(--fw-regular);
  font-size: 13px;

  &::before { content: '('; }
  &::after  { content: ')'; }
}

.result-section {
  margin-bottom: 32px;
}

.load-more-wrap {
  display: flex;
  justify-content: center;
  margin: 8px 0 32px;
}

.load-more-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 28px;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-family: inherit;
  font-weight: var(--fw-semi);
  color: var(--text-secondary);
  background: var(--bg-card);
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);

  &:hover:not(:disabled) {
    color: var(--color-primary);
    background: rgba(51, 94, 234, 0.12);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }

  .spin {
    animation: load-more-spin 0.8s linear infinite;
  }
}

@keyframes load-more-spin {
  to { transform: rotate(360deg); }
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px 28px;
}
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-decoration: none;
  color: inherit;
  .card-name { font-size: 14px; line-height: 1.3; max-height: 2.6em; overflow: hidden; }
  .card-sub  { font-size: 12px; opacity: 0.6; }
}

.platform-badge {
  vertical-align: middle;
  flex-shrink: 0;
  font-size: var(--fs-micro);
  font-weight: var(--fw-semi);
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  line-height: 1.4;
}

.badge-netease {
  background: var(--brand-netease-15);
  color: var(--brand-netease);
}

.badge-qq {
  background: var(--brand-qq-15);
  color: var(--brand-qq);
}

.badge-bilibili {
  background: var(--brand-bilibili-15);
  color: var(--brand-bilibili);
}

.badge-youtube {
  background: var(--brand-youtube-12);
  color: var(--brand-youtube);
}

.badge-local {
  background: var(--color-primary-10);
  color: var(--color-primary);
}

.badge-kugou {
  background: var(--brand-kugou-12);
  color: var(--brand-kugou);
}

.badge-jellyfin {
  background: var(--brand-jellyfin-12);
  color: var(--brand-jellyfin);
}

.fav-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  color: rgba(255, 255, 255, 0.7);
  font-size: 16px;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition-fast), color var(--transition-fast);
  z-index: 2;

  .card:hover & {
    opacity: 1;
  }

  &.favorited {
    color: #e74c3c;
    opacity: 1;
  }

  &:hover {
    color: #e74c3c;
    background: rgba(0, 0, 0, 0.7);
  }
}
</style>
