<template>
  <div class="song-card" :class="{ active }" @dblclick="showPlay && $emit('play')">
    <div class="song-index">{{ index }}</div>
    <CoverArt :url="song.coverUrl" :size="36" :radius="6" />
    <div class="song-info">
      <div class="song-name-row">
        <span class="song-name">{{ song.name }}</span>
        <span
          class="platform-badge"
          :class="song.platform === 'bilibili' ? 'badge-bilibili' : song.platform === 'qq' ? 'badge-qq' : song.platform === 'youtube' ? 'badge-youtube' : song.platform === 'local' ? 'badge-local' : song.platform === 'kugou' ? 'badge-kugou' : song.platform === 'spotify' ? 'badge-spotify' : 'badge-netease'"
        >{{ song.platform === 'bilibili' ? 'B站' : song.platform === 'qq' ? 'QQ' : song.platform === 'youtube' ? 'YouTube' : song.platform === 'local' ? '本地' : song.platform === 'kugou' ? '酷狗' : song.platform === 'spotify' ? 'Spotify' : '网易云' }}</span>
        <span
          v-if="song.requestedBy"
          class="requester-badge"
          :class="{ 'requester-badge-guest': song.requestedBy === '游客' }"
        >{{ song.requestedBy }}</span>
      </div>
      <div class="song-artist">{{ song.artist }}</div>
    </div>
    <div class="song-album">{{ song.album }}</div>
    <div class="song-duration">{{ formatDuration(song.duration) }}</div>
    <div class="song-actions">
      <button v-if="showPlay" class="action-btn" @click.stop="$emit('play')" title="播放">
        <Icon icon="mdi:play" />
      </button>
      <button v-if="showPlayNext" class="action-btn" @click.stop="$emit('playNext')" title="下一首播放">
        <Icon icon="mdi:playlist-play" />
      </button>
      <button v-if="showAdd" class="action-btn" @click.stop="$emit('add')" title="添加到队列">
        <Icon icon="mdi:playlist-plus" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import CoverArt from './CoverArt.vue';
import { Song } from '../stores/player.js';
import { useSession } from '../composables/useSession.js';

defineProps<{
  song: Song;
  index: number;
  active?: boolean;
}>();

const { can, guestCan } = useSession();
const showPlay = computed(() => can('player.control') || guestCan('playNow'));
const showPlayNext = computed(() => can('player.control') || guestCan('playNext'));
const showAdd = computed(() => can('player.queue') || guestCan('addToQueue'));

defineEmits<{
  play: [];
  playNext: [];
  add: [];
}>();

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
</script>

<style lang="scss" scoped>
.song-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
  cursor: pointer;

  &:hover {
    background: var(--hover-bg);
    .song-actions { opacity: 1; }
  }

  &.active {
    background: var(--color-primary-10);
  }
}

.song-index {
  width: 24px;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
}

.song-info {
  flex: 1;
  min-width: 0;
}

.song-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.song-name {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.platform-badge {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  font-weight: var(--fw-semi);
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  line-height: 1.4;
}

.requester-badge {
  flex-shrink: 0;
  max-width: 96px;
  font-size: var(--fs-micro);
  font-weight: var(--fw-semi);
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  line-height: 1.4;
  background: var(--color-online-15);
  color: var(--color-online);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.requester-badge-guest {
  background: rgba(156, 163, 175, 0.18);
  color: rgba(156, 163, 175, 0.95);
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

.badge-spotify {
  background: var(--brand-spotify-12);
  color: var(--brand-spotify);
}

.song-artist {
  font-size: 12px;
  color: var(--text-secondary);
}

.song-album {
  width: 160px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-duration {
  width: 48px;
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: right;
}

.song-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

// Touch devices have no :hover, so the parent-hover-reveals-actions
// pattern leaves all action buttons invisible. Always show on coarse-
// pointer (touch) inputs — this is also where bigger tap targets matter.
@media (pointer: coarse) {
  .song-actions {
    opacity: 1;
  }
}

.action-btn {
  font-size: 18px;
  padding: 4px;
  border-radius: var(--radius-sm);
  opacity: 0.7;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }
}
</style>
