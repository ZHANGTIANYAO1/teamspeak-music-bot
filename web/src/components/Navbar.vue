<template>
  <nav class="navbar frosted-glass">
    <RouterLink to="/" class="logo">TSMusicBot</RouterLink>

    <div class="nav-links">
      <RouterLink to="/" class="nav-link" active-class="active">发现</RouterLink>
      <RouterLink to="/search" class="nav-link" active-class="active">搜索</RouterLink>
      <RouterLink to="/library" class="nav-link" active-class="active">音乐库</RouterLink>
      <RouterLink to="/history" class="nav-link" active-class="active">播放历史</RouterLink>
      <RouterLink
        v-if="store.savedQueuesEnabled && !session.isGuest.value"
        to="/saved-queues"
        class="nav-link"
        active-class="active"
      >已存队列</RouterLink>
    </div>

    <div class="nav-right">
      <!-- Scoped (dedicated link): static label locked to the one bot, no switching -->
      <div v-if="store.isScoped" class="bot-selector scoped" ref="selectorRef">
        <div class="bot-selector-btn static">
          <span class="bot-dot" :class="{ online: activeBot?.connected }" />
          <span class="bot-selector-name">{{ activeBot?.name ?? '专属机器人' }}</span>
          <span v-if="activeBot?.playing && !activeBot?.paused" class="bot-state-mini playing">▶</span>
          <span v-else-if="activeBot?.paused" class="bot-state-mini paused">⏸</span>
          <span class="scope-badge">专属模式</span>
        </div>
        <button class="scope-exit-btn" @click="exitScope" title="退出专属模式">退出</button>
      </div>

      <!-- Normal: full selector with switching (shown when at least one
           controllable bot exists — scope ∩ permission via displayedBots) -->
      <div v-else-if="displayedBots.length > 0" class="bot-selector" ref="selectorRef">
        <button class="bot-selector-btn" @click="dropdownOpen = !dropdownOpen">
          <span class="bot-dot" :class="{ online: activeBot?.connected }" />
          <span class="bot-selector-name">{{ activeBot?.name ?? '选择机器人' }}</span>
          <span v-if="activeBot?.playing && !activeBot?.paused" class="bot-state-mini playing">▶</span>
          <span v-else-if="activeBot?.paused" class="bot-state-mini paused">⏸</span>
          <Icon icon="mdi:chevron-down" class="bot-chevron" :class="{ rotated: dropdownOpen }" />
        </button>
        <div v-if="dropdownOpen" class="bot-dropdown">
          <div class="bot-dropdown-header">机器人</div>
          <div
            v-for="bot in displayedBots"
            :key="bot.id"
            class="bot-card"
            :class="{ active: bot.id === store.activeBotId }"
          >
            <div class="bot-card-head" @click="bot.connected ? selectBot(bot.id) : undefined">
              <span class="bot-dot" :class="{ online: bot.connected }" />
              <span class="bot-card-name">{{ bot.name }}</span>
              <span v-if="bot.id === store.activeBotId" class="bot-current-badge">当前</span>
              <span v-if="bot.playing && !bot.paused" class="bot-playing-badge">播放中</span>
              <span v-else-if="bot.paused" class="bot-paused-badge">已暂停</span>
              <span v-else-if="bot.connected" class="bot-idle-badge">空闲</span>
              <span v-else class="bot-offline-badge">离线</span>
            </div>
            <div class="bot-card-controls">
              <button
                v-if="bot.connected"
                class="bot-ctrl-btn danger"
                :disabled="togglingBots[bot.id]"
                @click.stop="togglePower(bot)"
              >
                <Icon icon="mdi:link-off" /> 断开
              </button>
              <button
                v-else
                class="bot-ctrl-btn primary"
                :disabled="togglingBots[bot.id]"
                @click.stop="togglePower(bot)"
              >
                <Icon icon="mdi:link-variant" /> 连接
              </button>
              <button
                v-if="bot.playing || bot.paused"
                class="bot-ctrl-btn"
                :disabled="!bot.connected"
                @click.stop="store.pause()"
              >
                <Icon icon="mdi:stop" /> 停止
              </button>
              <button
                v-else
                class="bot-ctrl-btn"
                :disabled="!bot.connected"
                @click.stop="store.resume()"
              >
                <Icon icon="mdi:play" /> 播放
              </button>
              <button
                class="bot-ctrl-btn"
                :disabled="!bot.connected || (!bot.playing && !bot.paused)"
                @click.stop="store.next()"
                title="下一首"
              >
                <Icon icon="mdi:skip-next" />
              </button>
              <button class="bot-ctrl-btn" @click.stop="copyBotLink(bot.id)" title="复制链接">
                <Icon icon="mdi:link-variant" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <RouterLink v-if="!session.isGuest.value" to="/settings" class="settings-btn">
        <Icon icon="mdi:cog" />
      </RouterLink>

      <div v-if="session.currentUser.value" class="nav-user">
        <span class="nav-user-name">{{ session.currentUser.value.username }}</span>
        <span class="nav-user-role" :class="`role-${session.currentUser.value.role}`">
          {{ session.currentUser.value.role === 'admin' ? '管理员' : session.currentUser.value.role === 'guest' ? '游客' : '成员' }}
        </span>
        <button class="nav-user-logout" @click="onLogout" title="退出">
          <Icon icon="mdi:logout" />
        </button>
      </div>
    </div>
  </nav>

  <div v-if="linkDialog.open" class="link-dialog-backdrop" @click="closeLinkDialog">
    <div class="link-dialog" @click.stop>
      <div class="link-dialog-title">{{ linkDialog.name }} 的专属链接</div>
      <div class="link-dialog-hint">选中文本并按 Ctrl/Cmd+C 复制，或点击下方按钮</div>
      <input
        ref="linkInputRef"
        class="link-dialog-input"
        :value="linkDialog.url"
        readonly
        @focus="($event.target as HTMLInputElement).select()"
      />
      <div class="link-dialog-actions">
        <button class="link-dialog-btn primary" @click="copyLinkFromDialog">
          {{ linkDialog.copied ? '已复制' : '复制链接' }}
        </button>
        <button class="link-dialog-btn" @click="closeLinkDialog">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, nextTick, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { usePlayerStore } from '../stores/player.js';
import { useSession } from '../composables/useSession.js';

const store = usePlayerStore();
const session = useSession();
const { canControlBot } = session;
const navRouter = useRouter();

async function onLogout() {
  await session.logout();
  navRouter.replace({ name: 'login' });
}
// Belt-and-suspenders: the backend already scopes store.bots to the allowed
// set for members, but filtering here keeps the UI correct if an admin (who
// sees all bots) is constrained, or if the list ever isn't pre-filtered.
const controllableBots = computed(() => store.bots.filter((b) => canControlBot(b.id)));
const activeBot = computed(() => store.activeBot);
// The bots shown in the selector are the INTERSECTION of the permission
// allow-list (controllableBots) and the dedicated-link scope: while scoped the
// selector is locked to the single scoped bot, otherwise the full controllable
// list is shown and switching is allowed.
const displayedBots = computed(() =>
  store.isScoped
    ? controllableBots.value.filter((b) => b.id === store.scopedBotId)
    : controllableBots.value,
);
const dropdownOpen = ref(false);
const selectorRef = ref<HTMLElement | null>(null);
const togglingBots = ref<Record<string, boolean>>({});
const linkInputRef = ref<HTMLInputElement | null>(null);
const publicBaseUrl = ref<string | null>(null);

const linkDialog = reactive({
  open: false,
  url: '',
  name: '',
  copied: false,
});

function selectBot(id: string) {
  store.setActiveBotId(id);
  dropdownOpen.value = false;
}

// Leave dedicated-link mode. Clear scope BEFORE navigating so the router guard
// (which re-attaches ?bot from scopedBotId) sees a null scope and lets us out.
function exitScope() {
  store.clearScope();
  dropdownOpen.value = false;
  navRouter.push('/');
}

function resolveBaseUrl(): string {
  const base = publicBaseUrl.value;
  if (base && /^https?:\/\//i.test(base)) return base.replace(/\/+$/, '');
  return window.location.origin;
}

async function tryClipboardWrite(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function copyBotLink(id: string) {
  const bot = store.bots.find((b) => b.id === id);
  const url = `${resolveBaseUrl()}/bot/${id}`;
  linkDialog.url = url;
  linkDialog.name = bot?.name ?? '机器人';
  linkDialog.copied = false;
  linkDialog.open = true;
  dropdownOpen.value = false;
  // Try to copy silently; user can still manually select if it fails.
  const ok = await tryClipboardWrite(url);
  if (ok) linkDialog.copied = true;
  await nextTick();
  linkInputRef.value?.focus();
  linkInputRef.value?.select();
}

async function copyLinkFromDialog() {
  const ok = await tryClipboardWrite(linkDialog.url);
  if (ok) {
    linkDialog.copied = true;
  } else {
    linkInputRef.value?.focus();
    linkInputRef.value?.select();
  }
}

function closeLinkDialog() {
  linkDialog.open = false;
}

async function loadPublicBaseUrl() {
  try {
    const res = await fetch('/api/config/public-url');
    if (!res.ok) return;
    const data = (await res.json()) as { publicUrl?: string | null };
    if (data.publicUrl) publicBaseUrl.value = data.publicUrl;
  } catch {
    // ignore — fall back to window.location.origin
  }
}

async function togglePower(bot: { id: string; connected: boolean; name: string }) {
  if (togglingBots.value[bot.id]) return;
  togglingBots.value[bot.id] = true;
  try {
    if (bot.connected) {
      await store.stopBotInstance(bot.id);
    } else {
      await store.startBotInstance(bot.id);
    }
  } catch (err) {
    console.error(`Failed to toggle bot ${bot.name}`, err);
  } finally {
    togglingBots.value[bot.id] = false;
  }
}

function onClickOutside(e: MouseEvent) {
  if (selectorRef.value && !selectorRef.value.contains(e.target as Node)) {
    dropdownOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', onClickOutside);
  loadPublicBaseUrl();
});

onUnmounted(() => {
  document.removeEventListener('click', onClickOutside);
});
</script>

<style lang="scss" scoped>
.navbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: var(--navbar-height);
  display: flex;
  align-items: center;
  padding: 0 10vw;
  z-index: 100;
  border-bottom: 1px solid var(--border-color);

  @media (max-width: 1336px) {
    padding: 0 5vw;
  }

  @media (max-width: 768px) {
    padding: 0 16px;
    height: 52px;
  }
}

.logo {
  font-size: 18px;
  font-weight: 700;
  color: var(--color-primary);
  margin-right: 40px;

  @media (max-width: 768px) {
    font-size: 17px;
    margin-right: 0;
  }
}

.nav-links {
  display: flex;
  gap: 24px;

  @media (max-width: 768px) {
    display: none;
  }
}

.nav-link {
  font-size: 14px;
  font-weight: 600;
  opacity: 0.6;
  transition: opacity var(--transition-fast);

  &:hover { opacity: 0.8; }
  &.active { opacity: 1; color: var(--color-primary); }
}

.nav-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 16px;
}

.bot-status {
  padding: 4px 12px;
  background: var(--hover-bg);
  border-radius: var(--radius-sm);
  font-size: 12px;
  opacity: 0.6;

  &.online {
    background: var(--color-primary-15);
    color: var(--color-primary);
    opacity: 1;
  }
}

/* Bot selector dropdown */
.bot-selector {
  position: relative;
}

.bot-selector-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
  font-size: 16px;
  font-weight: 600;
  min-height: 44px;
  border: 1px solid var(--border-color);
  transition: background var(--transition-fast), border-color var(--transition-fast);
  cursor: pointer;

  &:hover {
    background: var(--bg-card);
    border-color: var(--color-primary);
  }

  @media (max-width: 768px) {
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 600;
    min-height: 32px;
    gap: 6px;
    border-radius: var(--radius-full);
  }
}

/* Scoped (dedicated-link) selector: locked, non-interactive label + exit */
.bot-selector.scoped {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bot-selector-btn.static {
  cursor: default;

  &:hover {
    background: var(--hover-bg);
    border-color: var(--border-color);
  }
}

.scope-badge {
  font-size: 10px;
  font-weight: 700;
  color: var(--color-primary);
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--color-primary-15);
  flex-shrink: 0;
  white-space: nowrap;

  @media (max-width: 768px) {
    display: none;
  }
}

.scope-exit-btn {
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  border-radius: var(--radius-md);
  background: var(--hover-bg);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--transition-fast), border-color var(--transition-fast);

  &:hover {
    background: var(--bg-card);
    border-color: var(--color-primary);
  }

  @media (max-width: 768px) {
    padding: 6px 10px;
    font-size: 11px;
  }
}

.bot-state-mini {
  font-size: 14px;
  &.playing { color: var(--color-online); }
  &.paused { color: var(--color-paused); }

  @media (max-width: 768px) {
    display: none;
  }
}

.bot-chevron {
  font-size: 20px;
  opacity: 0.5;
  transition: transform 0.2s ease;

  &.rotated {
    transform: rotate(180deg);
  }

  @media (max-width: 768px) {
    display: none;
  }
}

.bot-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-tertiary);
  flex-shrink: 0;

  &.online {
    background: var(--color-online);
  }

  @media (max-width: 768px) {
    width: 8px;
    height: 8px;
  }
}

.bot-selector-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  @media (max-width: 768px) {
    max-width: 80px;
  }
}

.bot-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 320px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 6px;
  box-shadow: var(--shadow-dropdown);
  z-index: 200;

  @media (max-width: 768px) {
    position: fixed;
    top: 52px;
    left: 8px;
    right: 8px;
    min-width: auto;
  }
}

.bot-dropdown-header {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  padding: 6px 10px 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.bot-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: var(--radius-sm);
  margin-bottom: 4px;
  border: 1px solid transparent;
  transition: background var(--transition-fast);

  &.active {
    background: var(--color-primary-12);
    border-color: rgba(99, 102, 241, 0.25);
  }
}

.bot-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.bot-card-name {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-current-badge {
  font-size: 10px;
  font-weight: 700;
  color: var(--color-primary);
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--color-primary-15);
  flex-shrink: 0;
}

.bot-playing-badge,
.bot-paused-badge,
.bot-idle-badge,
.bot-offline-badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
  flex-shrink: 0;
}

.bot-playing-badge {
  background: var(--color-online-15);
  color: var(--color-online);
}

.bot-paused-badge {
  background: var(--color-paused-15);
  color: var(--color-paused);
}

.bot-idle-badge {
  background: var(--hover-bg);
  color: var(--text-secondary);
}

.bot-offline-badge {
  background: var(--hover-bg);
  color: var(--text-tertiary);
}

.bot-card-controls {
  display: flex;
  gap: 6px;
}

.bot-ctrl-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--hover-bg);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--transition-fast);

  &:hover:not(:disabled) {
    background: var(--bg-card);
    border-color: var(--color-primary);
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  &.primary {
    background: var(--color-primary);
    color: #fff;
    border-color: var(--color-primary);
  }

  &.danger {
    color: #ef4444;
  }
}

.settings-btn {
  font-size: 22px;
  opacity: 0.6;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }

  @media (max-width: 768px) {
    display: none;
  }
}

.link-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: var(--bg-modal-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.link-dialog {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 20px;
  min-width: 360px;
  max-width: 90vw;
  box-shadow: var(--shadow-modal);
}

.link-dialog-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 6px;
}

.link-dialog-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 12px;
}

.link-dialog-input {
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--hover-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: inherit;
  user-select: all;
  -webkit-user-select: all;

  &:focus {
    outline: none;
    border-color: var(--color-primary);
  }
}

.link-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.link-dialog-btn {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-color);
  background: var(--hover-bg);
  color: inherit;
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);

  &:hover {
    background: var(--bg-card);
  }

  &.primary {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: #fff;

    &:hover {
      filter: brightness(1.08);
    }
  }
}

.nav-user {
  display: flex; align-items: center; gap: 8px; margin-left: 12px;
  color: var(--text-secondary); font-size: 13px;
}
.nav-user-logout {
  height: 28px; width: 28px; display: grid; place-items: center;
  border: 0; background: transparent; color: var(--text-secondary); cursor: pointer;
  border-radius: var(--radius-sm);
  &:hover { background: var(--bg-secondary); color: var(--text-primary); }
}

.nav-user-role {
  font-size: 11px; padding: 2px 6px; border-radius: 4px;
  font-weight: 500;
}
.role-admin { background: rgba(99, 145, 226, 0.18); color: #6391e2; }
.role-member { background: rgba(150, 150, 150, 0.18); color: var(--text-secondary); }
.role-guest { background: rgba(150, 150, 150, 0.18); color: var(--text-secondary); }
</style>
