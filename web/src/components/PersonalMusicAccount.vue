<template>
  <!-- The signed-in user's own music accounts (#164 + #164 follow-up).
       Two ways an account can apply to this user:
         - 自己扫码绑定 (source = personal)   → they may unlink it
         - 管理员分配 (source = granted)     → only the admin can revoke it
       Everything is read from /api/me/music/<platform>/status; the cookie never
       reaches the browser. -->
  <div class="account-card">
    <div class="account-header">
      <Icon icon="mdi:account-music" class="account-icon" />
      <div class="account-info">
        <div class="account-name">我的音乐账号</div>
        <div class="account-status" :class="{ logged: status.loggedIn, granted: status.source === 'granted' }">
          <template v-if="status.source === 'granted'">
            由管理员分配：{{ status.label || '已分配的账号' }}
            <template v-if="status.loggedIn && status.nickname">（{{ status.nickname }}）</template>
            <template v-else-if="!status.loggedIn">，但登录已失效，请联系管理员</template>
          </template>
          <template v-else-if="status.loggedIn">已绑定：{{ status.nickname }}</template>
          <template v-else-if="status.linked">已绑定，但登录已失效，请重新扫码</template>
          <template v-else>未绑定 — 使用机器人的共享账号</template>
        </div>
      </div>
    </div>

    <!-- Platform switch: only the sources this instance has enabled. -->
    <div v-if="platforms.length > 1" class="platform-tabs">
      <button
        v-for="p in platforms"
        :key="p"
        class="platform-tab"
        :class="{ active: p === current }"
        @click="selectPlatform(p)"
      >
        {{ PLATFORM_LABEL[p] ?? p }}
      </button>
    </div>

    <p class="hint">
      <template v-if="status.source === 'granted'">
        这个账号是管理员分配给你的，搜索、歌单、每日推荐和播放都会用它。想换成自己的账号，直接扫码绑定即可 — 自己的账号优先。
      </template>
      <template v-else-if="status.supportsQrLogin">
        绑定后，{{ PLATFORM_LABEL[current] ?? current }}的搜索、歌单、每日推荐和播放地址都按你自己的账号获取，
        看不到管理员的歌单和收藏。仅保存在服务器上，不会显示给任何人。
      </template>
      <template v-else>
        该平台暂不支持在网页端自助绑定，需要账号请联系管理员分配。
      </template>
    </p>

    <!-- 播放用哪个账号。只有真的持有个人/分配账号、且管理员开了这个功能时
         才有得选；否则本来就走共享账号。 -->
    <div
      v-if="status.featureEnabled && status.linked"
      class="account-choice"
      role="radiogroup"
      aria-label="播放使用哪个账号"
    >
      <div class="account-choice-title">网页端播放使用哪个账号</div>

      <div
        class="account-choice-option"
        :class="{ active: !status.preferShared }"
        role="radio"
        :aria-checked="!status.preferShared"
        tabindex="0"
        @click="setPreference(false)"
        @keydown.enter.prevent="setPreference(false)"
        @keydown.space.prevent="setPreference(false)"
      >
        <span class="account-choice-dot" :class="{ on: !status.preferShared }" />
        <span class="account-choice-text">
          <strong>我的账号</strong>
          <em>
            {{ status.source === 'granted' ? '管理员分配给我的那个' : '我自己扫码绑定的' }}；
            播放不了时自动改用共享账号
          </em>
        </span>
      </div>

      <div
        class="account-choice-option"
        :class="{ active: status.preferShared }"
        role="radio"
        :aria-checked="status.preferShared"
        tabindex="0"
        @click="setPreference(true)"
        @keydown.enter.prevent="setPreference(true)"
        @keydown.space.prevent="setPreference(true)"
      >
        <span class="account-choice-dot" :class="{ on: status.preferShared }" />
        <span class="account-choice-text">
          <strong>共享账号（管理员的）</strong>
          <em>会员曲目可以完整播放，但播放记录会记到管理员账号名下</em>
        </span>
      </div>

      <div class="account-choice-note">
        这个选择只影响本站的搜索、歌单和试听。房间里播歌
        （网页点歌后由机器人播放、<code>!play</code>）一直用共享账号，无论这里怎么选。
      </div>
    </div>

    <div class="login-methods">
      <button
        v-if="status.supportsQrLogin"
        class="login-btn"
        :disabled="qr.loading"
        @click="startQrLogin"
      >
        <Icon icon="mdi:qrcode" />
        {{ status.linked ? '重新扫码绑定' : '扫码绑定' }}
      </button>
      <!-- Only the user's OWN login can be removed here; an admin-granted one
           is managed from Settings → 音乐账号分配. -->
      <button v-if="status.canUnlink" class="login-btn" @click="unlink">
        <Icon icon="mdi:link-off" />
        解除绑定
      </button>
    </div>

    <div v-if="qr.loading" class="qr-loading">
      <Icon icon="mdi:loading" class="spin" />
      生成二维码中...
    </div>
    <div v-else-if="qr.dataUrl" class="qr-wrap">
      <img :src="qr.dataUrl" class="qr-image" alt="QR Code" />
      <div class="qr-status" :class="qr.status">
        <template v-if="qr.status === 'waiting'">
          <Icon icon="mdi:cellphone" /> 请使用{{ PLATFORM_LABEL[current] ?? '' }}APP扫码
        </template>
        <template v-else-if="qr.status === 'scanned'">
          <Icon icon="mdi:check" /> 已扫码，请在手机上确认
        </template>
        <template v-else-if="qr.status === 'confirmed'">
          <Icon icon="mdi:check-circle" /> 绑定成功!
        </template>
        <template v-else-if="qr.status === 'expired'">
          <Icon icon="mdi:refresh" /> 二维码已过期
          <button class="btn-link" @click="startQrLogin">重新生成</button>
        </template>
      </div>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import QRCode from 'qrcode';

const props = withDefaults(defineProps<{ platforms?: string[] }>(), {
  platforms: () => ['netease'],
});

const PLATFORM_LABEL: Record<string, string> = {
  netease: '网易云',
  qq: 'QQ音乐',
  kugou: '酷狗',
  bilibili: 'B站',
};

const current = ref(props.platforms[0] ?? 'netease');
const status = reactive({
  linked: false,
  loggedIn: false,
  nickname: '',
  label: '',
  source: 'none' as 'none' | 'personal' | 'granted',
  canUnlink: false,
  supportsQrLogin: false,
  preferShared: false,
  featureEnabled: false,
});
const qr = reactive({
  loading: false,
  dataUrl: '',
  key: '',
  status: 'waiting' as 'waiting' | 'scanned' | 'confirmed' | 'expired',
});
const error = ref('');
let pollTimer: ReturnType<typeof setInterval> | null = null;

const base = () => `/api/me/music/${current.value}`;

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshStatus() {
  try {
    const res = await axios.get(`${base()}/status`);
    status.linked = Boolean(res.data?.linked);
    status.loggedIn = Boolean(res.data?.loggedIn);
    status.nickname = res.data?.nickname ?? '';
    status.label = res.data?.label ?? '';
    status.source = res.data?.source ?? 'none';
    status.canUnlink = Boolean(res.data?.canUnlink);
    status.supportsQrLogin = Boolean(res.data?.supportsQrLogin);
    status.preferShared = Boolean(res.data?.preferShared);
    status.featureEnabled = Boolean(res.data?.featureEnabled);
  } catch {
    // Leave the last known state
  }
}

function resetQr() {
  stopPolling();
  qr.dataUrl = '';
  qr.key = '';
  qr.status = 'waiting';
}

function selectPlatform(p: string) {
  if (p === current.value) return;
  current.value = p;
  error.value = '';
  resetQr();
  void refreshStatus();
}

async function startQrLogin() {
  stopPolling();
  error.value = '';
  qr.loading = true;
  qr.dataUrl = '';
  qr.status = 'waiting';
  try {
    const res = await axios.post(`${base()}/qrcode`);
    const { qrUrl, qrImg, key } = res.data;
    qr.key = key;
    // Dark-on-light only: many in-app scanners can't read an inverted code.
    qr.dataUrl = qrImg || (await QRCode.toDataURL(qrUrl, {
      width: 200,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    }));
    pollTimer = setInterval(pollQrStatus, 2000);
  } catch (err: any) {
    const code = err?.response?.status;
    error.value = code === 501
      ? '该平台暂不支持自助绑定，请联系管理员分配账号'
      : (err?.response?.data?.error ?? '二维码生成失败');
  } finally {
    qr.loading = false;
  }
}

async function pollQrStatus() {
  if (!qr.key) return;
  try {
    const res = await axios.get(`${base()}/qrcode/status`, { params: { key: qr.key } });
    qr.status = res.data.status;
    if (qr.status === 'confirmed') {
      stopPolling();
      await refreshStatus();
    } else if (qr.status === 'expired') {
      stopPolling();
    }
  } catch {
    // Ignore poll errors
  }
}

/**
 * Switch which login playback uses.
 *
 * `true` = the bot's shared account (usually the admin's, usually the one with
 * a membership), `false` = my own / the assigned one. Nothing is unlinked, so
 * switching back restores the personal account exactly as it was.
 */
async function setPreference(preferShared: boolean) {
  if (preferShared === status.preferShared) return;
  error.value = '';
  const previous = status.preferShared;
  status.preferShared = preferShared; // optimistic — the radio must feel instant
  try {
    await axios.put(`${base()}/preference`, { preferShared });
  } catch (err: any) {
    status.preferShared = previous;
    const code = err?.response?.status;
    error.value =
      code === 409
        ? '管理员未开启「每用户独立账号」，暂时无法切换'
        : (err?.response?.data?.error ?? '切换失败');
  }
}

async function unlink() {
  error.value = '';
  try {
    await axios.delete(base());
    resetQr();
    await refreshStatus();
  } catch (err: any) {
    error.value = err?.response?.data?.error ?? '解除绑定失败';
  }
}

// Settings can render before the provider list is known; follow it if it changes.
watch(
  () => props.platforms,
  (list) => {
    if (list.length > 0 && !list.includes(current.value)) {
      current.value = list[0];
      void refreshStatus();
    }
  },
);

onMounted(refreshStatus);
onUnmounted(stopPolling);
</script>

<style lang="scss" scoped>
.account-card {
  margin-top: 16px;
  padding: 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
}

.account-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.account-icon {
  font-size: 28px;
  color: var(--color-primary);
}

.account-name {
  font-weight: 600;
}

.account-status {
  font-size: 12px;
  color: var(--text-tertiary);
  &.logged { color: var(--color-online); }
  &.granted { color: var(--text-secondary); }
}

.platform-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.platform-tab {
  padding: 5px 12px;
  font-size: 12px;
  border-radius: 14px;
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
  &.active {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
}

.hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin: 0 0 12px;
  line-height: 1.5;
}

.account-choice {
  margin: 12px 0 16px;
  padding: 12px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  border-radius: var(--radius-sm, 8px);
}

.account-choice-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-primary);
}

.account-choice-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm, 8px);
  cursor: pointer;
  transition: background-color 0.15s ease;

  & + & {
    margin-top: 4px;
  }

  &:hover {
    background: var(--hover-bg-strong, rgba(128, 128, 128, 0.08));
  }

  &.active {
    background: var(--hover-bg-strong, rgba(128, 128, 128, 0.1));
  }

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
}

.account-choice-dot {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  border-radius: 50%;
  border: 2px solid var(--text-secondary, #888);
  position: relative;

  &.on {
    border-color: var(--color-primary);

    &::after {
      content: '';
      position: absolute;
      inset: 2px;
      border-radius: 50%;
      background: var(--color-primary);
    }
  }
}

.account-choice-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  line-height: 1.45;

  strong {
    font-weight: 600;
    color: var(--text-primary);
  }

  em {
    font-style: normal;
    color: var(--text-secondary);
    font-size: 12px;
  }
}

/* Scope disclaimer: the radio above governs the web player only. Members were
   reading "共享账号" as "房间里也用这个" — which is true, but for the opposite
   reason, so it needs saying. */
.account-choice-note {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-color, rgba(128, 128, 128, 0.2));
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);

  code {
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--hover-bg-strong, rgba(128, 128, 128, 0.12));
  }
}

.login-methods {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.login-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  color: inherit;
  cursor: pointer;
  transition: all var(--transition-fast);
  &:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
  &:disabled { opacity: 0.6; cursor: default; }
}

.qr-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
}

.qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.qr-image {
  width: 200px;
  height: 200px;
  border-radius: var(--radius-md);
  border: 2px solid var(--border-color);
}

.qr-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  &.confirmed { color: var(--color-online); }
}

.btn-link {
  background: none;
  border: none;
  color: var(--color-primary);
  cursor: pointer;
  padding: 0;
}

.error {
  margin-top: 8px;
  font-size: 12px;
  color: #e26a6a;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
