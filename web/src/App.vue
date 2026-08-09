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
    <div v-if="currentSong" class="m-player" @click="onPlayerRowClick">
      <div
        ref="seekBarRef"
        class="m-player-progress"
        :class="{ 'no-seek': !canSeek, dragging: seeking }"
        @pointerdown="onSeekDown"
        @pointermove="onSeekMove"
        @pointerup="onSeekUp"
        @pointercancel="onSeekCancel"
      >
        <div class="m-player-progress-track">
          <div class="m-player-progress-fill" :style="{ width: seekBarPct + '%' }" />
          <div class="m-player-progress-thumb" :style="{ left: seekBarPct + '%' }" />
        </div>
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
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
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
  // While the finger owns the bar, the clock must keep its hands off it — see
  // seekBarPct below. Skipping the write (rather than letting it be overridden)
  // also avoids 60 pointless reactive re-renders per second mid-drag.
  if (!seeking.value) {
    const duration = currentSong.value?.duration ?? 0;
    // liveElapsed() recomputes each frame; the cached `elapsed` getter would
    // leave the mobile bar frozen between server pushes (#107).
    mobileProgressPct.value = duration > 0
      ? Math.min((playerStore.liveElapsed() / duration) * 100, 100)
      : 0;
  }
  mobileRaf = requestAnimationFrame(updateMobileProgress);
}

// --- Mini-player seek (#143) -------------------------------------------------
// The mobile progress bar used to be display-only. It now supports tap-to-seek
// and drag-to-seek via Pointer Events (one code path for touch, pen and mouse —
// no mouse/touch handler pairs) with setPointerCapture, so the drag survives the
// finger sliding off the 12px strip.
//
// Decoupling, exactly the reasoning of composables/useDecoupledSlider.ts (#111):
// updateMobileProgress() rewrites the rendered percentage every animation frame
// from the *server* clock, which is still the pre-seek position while the user
// drags. Binding the bar straight to it would snap the fill back under the
// finger ~60 times a second. So the rendered value is a computed that switches
// its source: the finger while `seeking`, the clock otherwise.
const seekBarRef = ref<HTMLElement | null>(null);
const seeking = ref(false);
const seekPct = ref(0);
let seekPointerId: number | null = null;
// The song the gesture started on. currentSong can advance mid-drag (the track
// ends), and the ratio the finger picked means nothing against a different
// song's duration.
let seekSongId: string | null = null;
// Bumped per gesture so a slow seek POST can't clear the override belonging to a
// newer drag that started while it was still in flight.
let seekGeneration = 0;
// Timestamp of the last seek gesture end, used to swallow the trailing click
// (see onPlayerRowClick).
let seekEndedAt = 0;

const seekBarPct = computed(() => (seeking.value ? seekPct.value : mobileProgressPct.value));

/** Pointer x → 0..1 along the strip, or null when the element isn't measurable. */
function seekRatio(e: PointerEvent): number | null {
  const el = seekBarRef.value;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return null;
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

/** Duration guard: live streams report 0/undefined and ratio*0 would seek to 0,
 *  while a missing duration would produce NaN — which the API rejects with 400. */
function seekableDuration(): number {
  const duration = currentSong.value?.duration ?? 0;
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

// Drives the `no-seek` class as well as the gesture guard, so a bar that cannot
// be seeked also gives `touch-action` back to the page — otherwise the strip
// would be a 12px band that neither seeks nor scrolls.
const canSeek = computed(() => canTransport.value && seekableDuration() > 0);

function endSeekGesture() {
  const el = seekBarRef.value;
  if (el && seekPointerId !== null && el.hasPointerCapture?.(seekPointerId)) {
    el.releasePointerCapture(seekPointerId);
  }
  seekPointerId = null;
  seekEndedAt = Date.now();
}

function onSeekDown(e: PointerEvent) {
  // Seeking is gated on transport, like the desktop player's `no-seek` state:
  // without it the bar stays purely visual and taps fall through to the row.
  if (!canSeek.value) return;
  // One gesture at a time: a second finger landing on the strip would otherwise
  // steal seekPointerId, leaving the first pointer captured forever and
  // committing whichever finger happened to lift first.
  if (seekPointerId !== null) return;
  const ratio = seekRatio(e);
  if (ratio === null) return;
  // Never let the row's router.push('/lyrics') fire while the user is seeking.
  e.stopPropagation();
  e.preventDefault(); // suppress text selection / compat mouse events during the drag
  seekPointerId = e.pointerId;
  seekSongId = currentSong.value?.id ?? null;
  seekGeneration += 1;
  seekBarRef.value?.setPointerCapture?.(e.pointerId);
  seeking.value = true;
  seekPct.value = ratio * 100;
}

function onSeekMove(e: PointerEvent) {
  if (!seeking.value || e.pointerId !== seekPointerId) return;
  const ratio = seekRatio(e);
  if (ratio === null) return;
  e.stopPropagation();
  seekPct.value = ratio * 100;
}

async function onSeekUp(e: PointerEvent) {
  if (!seeking.value || e.pointerId !== seekPointerId) return;
  e.stopPropagation();
  // A tap never moves, so pointerup is also the commit point for tap-to-seek.
  const ratio = seekRatio(e) ?? seekPct.value / 100;
  seekPct.value = ratio * 100;
  const duration = seekableDuration();
  const generation = seekGeneration;
  // If the track advanced while the finger was down, the ratio belongs to a
  // song that is no longer playing — drop the seek rather than applying it to
  // whatever started next.
  const sameSong = currentSong.value?.id === seekSongId;
  endSeekGesture(); // must run synchronously, before the awaited POST
  try {
    if (duration > 0 && sameSong) await playerStore.seek(ratio * duration);
  } catch {
    // Seek rejected (403/400/offline) — fall back to the server clock below.
  } finally {
    // Release the local override only once seek() has resolved. store.seek()
    // moves its timing anchor to the requested position in the same tick, so
    // liveElapsed() already reports the new spot and the bar simply carries on
    // from where the finger left it. Releasing at pointerup instead would show
    // the *old* position for one round-trip and then jump a second time.
    // (_syncAfterAction re-polls 500ms later, but that only nudges the bar by
    // the network delta — not worth freezing the clock for.)
    if (generation === seekGeneration) seeking.value = false;
  }
}

function onSeekCancel(e: PointerEvent) {
  if (e.pointerId !== seekPointerId) return;
  // Gesture stolen (system gesture, call, …): abandon without seeking and hand
  // the bar straight back to the clock.
  endSeekGesture();
  seeking.value = false;
}

// The whole mini player lives inside `v-if="currentSong"`, so when playback
// stops mid-drag the strip is destroyed and no pointerup/pointercancel can ever
// reach it — element removal is not a pointercancel trigger. Without this the
// `seeking` override would stay true and the progress bar would sit frozen for
// the rest of the session. Bumping the generation also neuters the finally of
// any seek still in flight.
watch(currentSong, () => {
  if (!seeking.value) return;
  seekGeneration += 1;
  seekPointerId = null;
  seekSongId = null;
  seeking.value = false;
});

function onPlayerRowClick() {
  // Both a tap and a drag on the strip emit a trailing `click`, which would
  // otherwise navigate to /lyrics the moment the user finishes seeking. A
  // `@click.stop` on the strip is not enough: after a drag the click's target is
  // the nearest common ancestor of the pointerdown/pointerup hit-tests, i.e.
  // `.m-player` itself once the finger has left the 12px strip. So the row
  // swallows any click arriving right after a seek gesture. A timestamp rather
  // than a flag, so a gesture that produces no click at all (preventDefault,
  // pointercancel) can't leave the row permanently unclickable — and so an inert
  // strip (no transport permission, unknown duration) still falls through here
  // and navigates, exactly as it did before.
  if (Date.now() - seekEndedAt < 400) return;
  router.push('/lyrics');
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
  // The visible track stays 2px, but 2px is not a touch target (#143), so the
  // hit area is 12px and grows DOWNWARD into the mini player's own 8px top
  // padding. It must not reach the transport buttons: they are 32px tall and
  // centred in the 58px row's 42px content box, i.e. their top edge sits at
  // 8 + (42 - 32) / 2 = 13px. 12px clears them by 1px. Growing upward is not an
  // option — that is outside the player's rounded top edge.
  height: 12px;
  // Without this the browser claims the gesture for page scrolling partway
  // through the drag and the pointermove stream stops.
  touch-action: none;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;

  // No transport permission → purely decorative (mirrors Player.vue's .no-seek).
  // Handing touch-action back matters: an inert strip must not eat gestures.
  &.no-seek {
    touch-action: auto;
  }
}

.m-player-progress-track {
  position: relative;
  // Nudged down inside the 12px hit area so the drag thumb, which is centred on
  // the track, stays within the card instead of poking out above its top edge.
  // The 8px thumb's box is (3 + 1 - 4) = 0 to 8, i.e. exactly flush with the
  // card. (The container is absolutely positioned, so it forms a BFC and this
  // margin cannot collapse through it.)
  margin-top: 3px;
  height: 2px;
  border-radius: 1px;
  background: var(--border-color);
}

.m-player-progress-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: var(--color-primary);
  border-radius: 1px;
}

.m-player-progress-thumb {
  position: absolute;
  top: 1px;
  width: 8px;
  height: 8px;
  margin-top: -4px;
  margin-left: -4px;
  background: var(--color-primary);
  border-radius: var(--radius-full);
  opacity: 0;
  transform: scale(0);
  transition: opacity var(--transition-fast), transform var(--transition-fast);
  pointer-events: none;
}

.m-player-progress.dragging .m-player-progress-thumb {
  opacity: 1;
  transform: scale(1);
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
