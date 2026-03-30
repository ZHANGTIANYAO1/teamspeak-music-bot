<template>
  <div class="player-wrapper" v-if="currentSong">
    <Queue :open="showQueue" @close="showQueue = false" />

    <div class="player-bar frosted-glass">
      <!-- Progress bar -->
      <div
        class="progress-bar-container"
        ref="progressBarRef"
        @click="onProgressClick"
        @mousemove="onProgressHover"
        @mouseleave="progressTooltipVisible = false"
      >
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" :style="{ width: progressPercent + '%' }" />
          <div class="progress-bar-thumb" :style="{ left: progressPercent + '%' }" />
        </div>
        <div
          v-if="progressTooltipVisible"
          class="progress-tooltip"
          :style="{ left: progressTooltipX + 'px' }"
        >
          {{ progressTooltipTime }}
        </div>
      </div>

      <div class="player-left" @click="toggleLyrics">
        <CoverArt :url="currentSong.coverUrl" :size="40" />
        <div class="song-info">
          <div class="song-name">{{ currentSong.name }}</div>
          <div class="song-artist">{{ currentSong.artist }}</div>
        </div>
      </div>

      <div class="player-center">
        <span class="time-display time-current">{{ formatTime(currentElapsed) }}</span>
        <button class="control-btn" @click="store.prev()">
          <Icon icon="mdi:skip-previous" />
        </button>
        <button class="play-btn" @click="togglePlay">
          <Icon :icon="store.isPlaying ? 'mdi:pause' : 'mdi:play'" />
        </button>
        <button class="control-btn" @click="store.next()">
          <Icon icon="mdi:skip-next" />
        </button>
        <button class="control-btn mode-btn" @click="cycleMode" :title="modeLabel">
          <Icon :icon="modeIcon" />
          <span class="mode-label">{{ modeLabel }}</span>
        </button>
        <span class="time-display time-total">{{ formatTime(currentSong?.duration ?? 0) }}</span>
      </div>

      <div class="player-right">
        <Icon icon="mdi:volume-high" class="volume-icon" />
        <input
          type="range"
          min="0"
          max="100"
          :value="activeBot?.volume ?? 75"
          @change="onVolumeChange"
          class="volume-slider"
        />
        <button class="control-btn" :class="{ active: showQueue }" @click="showQueue = !showQueue">
          <Icon icon="mdi:playlist-music" />
        </button>
        <button class="control-btn lyrics-btn" :class="{ active: route.path === '/lyrics' }" @click="toggleLyrics">
          <Icon icon="mdi:microphone" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { Icon } from '@iconify/vue';
import { useRoute, useRouter } from 'vue-router';
import { usePlayerStore } from '../stores/player.js';
import CoverArt from './CoverArt.vue';
import Queue from './Queue.vue';

const route = useRoute();
const router = useRouter();
const showQueue = ref(false);

const store = usePlayerStore();
const activeBot = computed(() => store.activeBot);
const currentSong = computed(() => store.currentSong);

function toggleLyrics() {
  if (route.path === '/lyrics') {
    router.back();
  } else {
    router.push('/lyrics');
  }
}

// Progress — use manual timer instead of relying on reactive getters
const currentElapsed = ref(0);
const progressPercent = ref(0);
const progressTooltipVisible = ref(false);
const progressTooltipX = ref(0);
const progressTooltipTime = ref('0:00');
const progressBarRef = ref<HTMLElement | null>(null);
let rafId: number | null = null;

function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateProgress() {
  // Use store.elapsed which interpolates from server ground truth
  currentElapsed.value = store.elapsed;

  const duration = currentSong.value?.duration ?? 0;
  progressPercent.value = duration > 0
    ? Math.min((currentElapsed.value / duration) * 100, 100)
    : 0;

  rafId = requestAnimationFrame(updateProgress);
}

async function onProgressClick(e: MouseEvent) {
  const bar = progressBarRef.value;
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const duration = currentSong.value?.duration ?? 0;
  const seekTime = ratio * duration;
  await store.seek(seekTime);
}

function onProgressHover(e: MouseEvent) {
  const bar = progressBarRef.value;
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const duration = currentSong.value?.duration ?? 0;
  progressTooltipVisible.value = true;
  progressTooltipX.value = e.clientX - rect.left;
  progressTooltipTime.value = formatTime(ratio * duration);
}

onMounted(() => {
  rafId = requestAnimationFrame(updateProgress);
});

onUnmounted(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
});

function togglePlay() {
  if (store.isPlaying) {
    store.pause();
  } else {
    store.resume();
  }
}

function onVolumeChange(e: Event) {
  const target = e.target as HTMLInputElement;
  store.setVolume(parseInt(target.value));
}

const modeOrder = ['seq', 'loop', 'random', 'rloop'] as const;
const modeIcons: Record<string, string> = {
  seq: 'mdi:arrow-right',
  loop: 'mdi:repeat',
  random: 'mdi:shuffle',
  rloop: 'mdi:shuffle-variant',
};
const modeLabels: Record<string, string> = {
  seq: '顺序',
  loop: '循环',
  random: '随机',
  rloop: '随机循环',
};

const currentMode = computed(() => activeBot.value?.playMode ?? 'seq');
const modeIcon = computed(() => modeIcons[currentMode.value] ?? modeIcons.seq);
const modeLabel = computed(() => modeLabels[currentMode.value] ?? modeLabels.seq);

function cycleMode() {
  const idx = modeOrder.indexOf(currentMode.value as typeof modeOrder[number]);
  const next = modeOrder[(idx + 1) % modeOrder.length];
  store.setMode(next);
}
</script>

<style lang="scss" scoped>
.player-wrapper {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 100;
}

.player-bar {
  height: var(--player-height);
  display: flex;
  align-items: center;
  padding: 0 24px;
  border-top: 1px solid var(--border-color);
  position: relative;
}

.progress-bar-container {
  position: absolute;
  top: -6px;
  left: 0;
  right: 0;
  height: 12px;
  cursor: pointer;
  z-index: 101;
  display: flex;
  align-items: center;
  padding: 0;

  &:hover {
    .progress-bar-bg { height: 4px; }
    .progress-bar-thumb { opacity: 1; transform: scale(1); }
  }
}

.progress-bar-bg {
  width: 100%;
  height: 2px;
  background: var(--border-color);
  transition: height 0.15s ease;
  position: relative;
  border-radius: 1px;
}

.progress-bar-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: var(--color-primary);
  border-radius: 1px;
  // No transition — updated via rAF for smooth movement
}

.progress-bar-thumb {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  background: var(--color-primary);
  border-radius: 50%;
  transform: scale(0);
  opacity: 0;
  transition: opacity 0.15s, transform 0.15s;
  margin-left: -5px;
  margin-top: -5px;
}

.progress-tooltip {
  position: absolute;
  top: -28px;
  transform: translateX(-50%);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  pointer-events: none;
}

.time-display {
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  min-width: 36px;
}

.time-current { text-align: right; }
.time-total { text-align: left; }

.player-left {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 240px;
  text-decoration: none;
  color: inherit;
  cursor: pointer;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 0.8; }
}

.song-info {
  min-width: 0;
}

.song-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-artist {
  font-size: 11px;
  color: var(--text-secondary);
}

.player-center {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 20px;
}

.control-btn {
  font-size: 20px;
  opacity: 0.7;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }
  &.active { opacity: 1; color: var(--color-primary); }
}

.mode-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 18px;
}

.mode-label {
  font-size: 11px;
  font-weight: 500;
}

.play-btn {
  width: 32px;
  height: 32px;
  background: var(--color-primary);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  color: white;
  transition: transform var(--transition-fast);
  &:hover { transform: scale(1.08); }
  &:active { transform: scale(0.95); }
}

.player-right {
  width: 240px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.volume-icon {
  font-size: 18px;
  opacity: 0.6;
}

.volume-slider {
  width: 80px;
  height: 3px;
  appearance: none;
  background: var(--border-color);
  border-radius: 2px;
  outline: none;

  &::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    background: var(--color-primary);
    border-radius: 50%;
    cursor: pointer;
  }
}

.lyrics-btn {
  margin-left: 8px;
}
</style>
