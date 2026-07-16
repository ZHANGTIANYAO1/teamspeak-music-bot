<template>
  <div class="app" :data-theme="theme">
    <Navbar />
    <main class="main-content">
      <RouterView />
    </main>
    <Player />
    <Toast />
    <Queue class="mobile-queue" :open="mobileQueueOpen" @close="mobileQueueOpen = false" />

    <!-- Mobile mini player -->
    <div v-if="currentSong" class="m-player" @click="router.push('/lyrics')">
      <div class="m-player-progress">
        <div class="m-player-progress-fill" :style="{ width: mobileProgressPct + '%' }" />
      </div>
      <CoverArt :url="currentSong.coverUrl" :size="40" :radius="8" />
      <div class="m-player-info">
        <div class="m-player-name">{{ currentSong.name }}</div>
        <div class="m-player-artist">{{ currentSong.artist }}</div>
      </div>
      <div class="m-player-controls" @click.stop>
        <button v-if="can('player.control')" class="m-player-btn" @click="playerStore.prev()">
          <Icon icon="mdi:skip-previous" />
        </button>
        <button v-if="canTransport" class="m-player-btn" @click="playerStore.isPlaying ? playerStore.pause() : playerStore.resume()">
          <Icon :icon="playerStore.isPlaying ? 'mdi:pause' : 'mdi:play'" />
        </button>
        <button v-if="canSkip" class="m-player-btn" @click="playerStore.next()">
          <Icon icon="mdi:skip-next" />
        </button>
        <button v-if="canModeCtl" class="m-player-btn" @click="cycleMobileMode">
          <Icon :icon="mobileModeIcon" />
        </button>
        <button class="m-player-btn" @click="toggleMobileQueue">
          <Icon icon="mdi:playlist-music" />
        </button>
        <button v-if="canTransport" class="m-player-btn" @click="toggleMobileVolume">
          <Icon icon="mdi:volume-high" />
        </button>
      </div>
      <div v-if="mobileVolumeOpen" class="m-volume-popover" @click.stop>
        <Icon icon="mdi:volume-high" class="m-volume-icon" />
        <input
          type="range"
          min="0"
          max="100"
          :value="mobileVolumeDisplay"
          class="m-volume-slider"
          @input="onMobileVolumeInput"
          @change="onMobileVolumeCommit"
          @pointerup="onMobileVolumeRelease"
          @pointercancel="onMobileVolumeRelease"
          @blur="onMobileVolumeRelease"
        />
        <span class="m-volume-value">{{ mobileVolumeDisplay }}</span>
      </div>
    </div>

    <!-- Mobile bottom tab bar -->
    <nav class="m-tabbar">
      <RouterLink to="/" class="m-tab" :class="{ active: route.path === '/' }">
        <Icon icon="mdi:home" class="tab-icon" />
        <span class="tab-label">发现</span>
      </RouterLink>
      <RouterLink to="/search" class="m-tab" :class="{ active: route.path === '/search' }">
        <Icon icon="mdi:magnify" class="tab-icon" />
        <span class="tab-label">搜索</span>
      </RouterLink>
      <RouterLink to="/library" class="m-tab" :class="{ active: route.path === '/library' }">
        <Icon icon="mdi:music-box-multiple" class="tab-icon" />
        <span class="tab-label">音乐库</span>
      </RouterLink>
      <RouterLink v-if="!session.isGuest.value" to="/settings" class="m-tab" :class="{ active: route.path.startsWith('/settings') }">
        <Icon icon="mdi:cog" class="tab-icon" />
        <span class="tab-label">设置</span>
      </RouterLink>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { usePlayerStore } from './stores/player.js';
import { useDecoupledSlider } from './composables/useDecoupledSlider.js';
import { useWebSocket } from './composables/useWebSocket.js';
import { useSession } from './composables/useSession.js';
import Navbar from './components/Navbar.vue';
import Player from './components/Player.vue';
import CoverArt from './components/CoverArt.vue';
import Toast from './components/Toast.vue';
import Queue from './components/Queue.vue';

const playerStore = usePlayerStore();
const session = useSession();
const { can, guestCan } = session;
// Mobile mini-player transport gating — mirrors components/Player.vue.
const canTransport = computed(() => can('player.control') || guestCan('transport'));
const canSkip = computed(() => can('player.control') || guestCan('skip'));
const canModeCtl = computed(() => can('player.control') || guestCan('playMode'));
const theme = computed(() => playerStore.theme);
const route = useRoute();
const router = useRouter();
const { connect } = useWebSocket();
const currentSong = computed(() => playerStore.currentSong);
// Volume slider decoupled from the 60fps updateMobileProgress() rAF re-render
// so it isn't reset mid-drag (#111 — same root cause as the desktop player).
const {
  display: mobileVolumeDisplay,
  onInput: onMobileVolumeInput,
  onChange: onMobileVolumeCommit,
  onRelease: onMobileVolumeRelease,
} = useDecoupledSlider(
  () => playerStore.activeBot?.volume,
  (v) => playerStore.setVolume(v)
);
const mobileMode = computed(() => playerStore.activeBot?.playMode ?? 'seq');
const mobileModeOrder = ['seq', 'loop', 'random', 'rloop'];
const mobileModeIcons: Record<string, string> = {
  seq: 'mdi:arrow-right',
  loop: 'mdi:repeat',
  random: 'mdi:shuffle',
  rloop: 'mdi:repeat-once',
};
const mobileModeIcon = computed(() => mobileModeIcons[mobileMode.value] ?? mobileModeIcons.seq);
const mobileVolumeOpen = ref(false);
const mobileQueueOpen = ref(false);

const mobileProgressPct = ref(0);
let syncTimer: ReturnType<typeof setInterval> | null = null;
let mobileRaf: number | null = null;

function updateMobileProgress() {
  const duration = currentSong.value?.duration ?? 0;
  // liveElapsed() recomputes each frame; the cached `elapsed` getter would
  // leave the mobile bar frozen between server pushes (#107).
  mobileProgressPct.value = duration > 0
    ? Math.min((playerStore.liveElapsed() / duration) * 100, 100)
    : 0;
  mobileRaf = requestAnimationFrame(updateMobileProgress);
}

function toggleMobileVolume() {
  mobileVolumeOpen.value = !mobileVolumeOpen.value;
  if (mobileVolumeOpen.value) mobileQueueOpen.value = false;
}

function toggleMobileQueue() {
  mobileQueueOpen.value = !mobileQueueOpen.value;
  if (mobileQueueOpen.value) mobileVolumeOpen.value = false;
}

function cycleMobileMode() {
  const currentIndex = mobileModeOrder.indexOf(mobileMode.value);
  const nextMode = mobileModeOrder[(currentIndex + 1) % mobileModeOrder.length] ?? mobileModeOrder[0];
  mobileVolumeOpen.value = false;
  mobileQueueOpen.value = false;
  playerStore.setMode(nextMode);
}

onMounted(async () => {
  playerStore.loadTheme();
  connect();
  // Hydrate favorites once per session so deep-links / hard refreshes onto
  // Search or Playlist render hearts correctly without first visiting Home.
  // (fire-and-forget; fetchFavorites swallows the 401 when not yet logged in.)
  playerStore.fetchFavorites();
  // Non-critical: reads savedQueuesEnabled so the nav entry can show/hide.
  // Guests get a 403 (swallowed) → the entry stays hidden for them.
  if (!session.isGuest.value) playerStore.fetchBotSettings();
  syncTimer = setInterval(() => playerStore.syncElapsed(), 3000);
  mobileRaf = requestAnimationFrame(updateMobileProgress);
  // Reconcile the dedicated-link scope only after the bot list is known: the
  // router guard sets scopedBotId tentatively from ?bot, but applyScopeFromQuery
  // validates it against the loaded bots (locks if it exists, clears if stale).
  await playerStore.fetchBots();
  // Read from the authoritative current route (not a possibly-stale reactive
  // snapshot) so the scope reconciles against the ?bot present at refresh time.
  const routeBot = router.currentRoute.value.query.bot;
  const qBot = typeof routeBot === 'string' ? routeBot : null;
  playerStore.applyScopeFromQuery(qBot);
});

onUnmounted(() => {
  if (syncTimer) clearInterval(syncTimer);
  if (mobileRaf !== null) cancelAnimationFrame(mobileRaf);
});
</script>

<style lang="scss">
.app {
  min-height: 100vh;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.main-content {
  padding: 80px 10vw 80px;

  @media (max-width: 1336px) {
    padding: 80px 5vw 80px;
  }

  @media (max-width: 768px) {
    padding: 72px 16px 200px;
  }
}

// Mobile mini player
.m-player {
  position: fixed;
  left: 8px;
  right: 8px;
  bottom: 68px;
  height: 58px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  z-index: 95;
  cursor: pointer;

  @media (min-width: 769px) {
    display: none;
  }
}

.mobile-queue {
  display: none;

  @media (max-width: 768px) {
    display: flex;
  }
}

.m-player-progress {
  position: absolute;
  top: 0;
  left: 10px;
  right: 10px;
  height: 2px;
}

.m-player-progress-fill {
  height: 2px;
  background: var(--color-primary);
  border-radius: 1px;
}

.m-player-info {
  flex: 1;
  min-width: 0;
}

.m-player-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.m-player-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.m-player-artist {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.m-player-btn {
  width: 28px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  opacity: 0.85;
  flex-shrink: 0;
}

.m-volume-popover {
  position: absolute;
  right: 8px;
  bottom: calc(100% + 8px);
  display: flex;
  align-items: center;
  gap: 8px;
  width: min(260px, calc(100vw - 32px));
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-dropdown);
  cursor: default;
}

.m-volume-icon {
  flex: 0 0 auto;
  font-size: 18px;
  color: var(--text-secondary);
}

.m-volume-slider {
  flex: 1 1 auto;
  min-width: 0;
  height: 4px;
  appearance: none;
  background: var(--border-color);
  border-radius: 2px;
  outline: none;

  &::-webkit-slider-thumb {
    appearance: none;
    width: 16px;
    height: 16px;
    background: var(--color-primary);
    border-radius: 50%;
  }
}

.m-volume-value {
  flex: 0 0 30px;
  font-size: 12px;
  color: var(--text-secondary);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

// Mobile bottom tab bar
.m-tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding-bottom: env(safe-area-inset-bottom, 0);
  background: var(--bg-navbar);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border-top: 1px solid var(--border-color);
  z-index: 100;

  @media (min-width: 769px) {
    display: none;
  }
}

.m-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 14px;
  color: var(--text-tertiary);
  text-decoration: none;
  font-family: inherit;

  &.active {
    color: var(--color-primary);
  }

  .tab-icon {
    font-size: 22px;
  }

  .tab-label {
    font-size: 10px;
    font-weight: 500;
  }
}
</style>
