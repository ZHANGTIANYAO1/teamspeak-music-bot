<template>
  <div class="settings-page">
    <button class="back-btn" @click="$router.back()">
      <Icon icon="mdi:arrow-left" />
      返回
    </button>
    <h1 class="page-title">设置</h1>

    <!-- Theme Toggle -->
    <section class="settings-section">
      <h2 class="section-title">外观</h2>
      <div class="setting-row">
        <div class="setting-label">
          <Icon icon="mdi:theme-light-dark" class="setting-icon" />
          主题模式
        </div>
        <button class="theme-toggle" @click="store.toggleTheme()">
          <Icon :icon="store.theme === 'dark' ? 'mdi:weather-night' : 'mdi:weather-sunny'" />
          {{ store.theme === 'dark' ? '深色' : '浅色' }}
        </button>
      </div>
    </section>

    <!-- Bot Management -->
    <section class="settings-section">
      <h2 class="section-title">机器人管理</h2>
      <div class="bot-list">
        <div v-for="bot in store.bots" :key="bot.id" class="bot-item">
          <div class="bot-info">
            <div class="bot-name">{{ bot.name }}</div>
            <div class="bot-status" :class="botStatusClass(bot)">
              {{ botStatusText(bot) }}
            </div>
          </div>
          <div class="bot-actions">
            <button class="btn-sm" @click="toggleBot(bot.id, bot.connected)">
              {{ bot.connected ? '停止' : '启动' }}
            </button>
            <button class="btn-sm btn-edit" @click="openEditBot(bot)">
              <Icon icon="mdi:pencil" />
            </button>
            <button class="btn-sm btn-delete" @click="deleteBot(bot.id, bot.name)">
              <Icon icon="mdi:delete" />
            </button>
          </div>
        </div>
      </div>

      <!-- Edit Bot Modal -->
      <div v-if="editingBot" class="edit-modal-overlay" @click.self="editingBot = null">
        <div class="edit-modal">
          <h3 class="modal-title">编辑机器人</h3>
          <div class="form-group">
            <label>名称</label>
            <input v-model="editForm.name" class="input" />
          </div>
          <div class="form-group">
            <label>服务器地址</label>
            <input v-model="editForm.serverAddress" class="input" placeholder="ts.example.com" />
          </div>
          <div class="form-row">
            <div class="form-group" style="flex:1">
              <label>端口</label>
              <input v-model.number="editForm.serverPort" type="number" class="input" />
            </div>
            <div class="form-group" style="flex:2">
              <label>昵称</label>
              <input v-model="editForm.nickname" class="input" />
            </div>
          </div>
          <div class="form-group">
            <label>默认频道（可选）</label>
            <input v-model="editForm.defaultChannel" class="input" placeholder="音乐频道" />
          </div>
          <div class="form-group">
            <label>频道密码（可选）</label>
            <input v-model="editForm.channelPassword" class="input" type="password" />
          </div>
          <div class="modal-actions">
            <button class="btn-secondary" @click="editingBot = null">取消</button>
            <button class="btn-primary" @click="saveEditBot">保存（需重启机器人生效）</button>
          </div>
        </div>
      </div>

      <!-- Create Bot -->
      <div class="create-bot">
        <h3 class="subsection-title">创建新实例</h3>
        <div class="form-group">
          <label>名称</label>
          <input v-model="newBotName" class="input" placeholder="我的音乐机器人" />
        </div>
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label>服务器地址</label>
            <input v-model="newBotServer" class="input" placeholder="localhost 或 ts.example.com" />
          </div>
          <div class="form-group" style="flex:1">
            <label>端口</label>
            <input v-model.number="newBotPort" type="number" class="input" placeholder="9987" />
          </div>
        </div>
        <div class="form-group">
          <label>昵称</label>
          <input v-model="newBotNickname" class="input" placeholder="MusicBot" />
        </div>
        <div class="form-group">
          <label>默认频道（可选）</label>
          <input v-model="newBotChannel" class="input" placeholder="音乐频道" />
        </div>
        <button class="btn-primary" @click="createBot">创建</button>
      </div>
    </section>

    <!-- Music Account - QR Code Login -->
    <section class="settings-section">
      <h2 class="section-title">音乐账号</h2>

      <!-- NetEase -->
      <div class="account-card">
        <div class="account-header">
          <Icon icon="mdi:cloud-outline" class="account-icon" />
          <div class="account-info">
            <div class="account-name">网易云音乐</div>
            <div class="account-status" :class="{ logged: neteaseAuth.loggedIn }">
              {{ neteaseAuth.loggedIn ? `已登录: ${neteaseAuth.nickname}` : '未登录' }}
            </div>
          </div>
        </div>

        <div class="login-methods">
          <button
            class="login-btn"
            :class="{ active: neteaseLoginMode === 'qr' }"
            @click="startQrLogin('netease')"
            :disabled="neteaseQr.loading"
          >
            <Icon icon="mdi:qrcode" />
            扫码登录
          </button>
          <button
            class="login-btn"
            :class="{ active: neteaseLoginMode === 'cookie' }"
            @click="neteaseLoginMode = 'cookie'"
          >
            <Icon icon="mdi:cookie" />
            Cookie登录
          </button>
        </div>

        <!-- QR Code -->
        <div v-if="neteaseLoginMode === 'qr'" class="qr-section">
          <div v-if="neteaseQr.loading" class="qr-loading">
            <Icon icon="mdi:loading" class="spin" />
            生成二维码中...
          </div>
          <div v-else-if="neteaseQr.dataUrl" class="qr-wrap">
            <img :src="neteaseQr.dataUrl" class="qr-image" alt="QR Code" />
            <div class="qr-status" :class="neteaseQr.status">
              <template v-if="neteaseQr.status === 'waiting'">
                <Icon icon="mdi:cellphone" /> 请使用网易云音乐APP扫码
              </template>
              <template v-else-if="neteaseQr.status === 'scanned'">
                <Icon icon="mdi:check" /> 已扫码，请在手机上确认
              </template>
              <template v-else-if="neteaseQr.status === 'confirmed'">
                <Icon icon="mdi:check-circle" /> 登录成功!
              </template>
              <template v-else-if="neteaseQr.status === 'expired'">
                <Icon icon="mdi:refresh" /> 二维码已过期
                <button class="btn-link" @click="startQrLogin('netease')">重新生成</button>
              </template>
            </div>
          </div>
        </div>

        <!-- Cookie -->
        <div v-if="neteaseLoginMode === 'cookie'" class="cookie-section">
          <textarea
            v-model="neteaseCookie"
            class="textarea"
            placeholder="粘贴网易云音乐Cookie..."
            rows="3"
          />
          <button class="btn-primary btn-save" @click="saveCookie('netease')">保存Cookie</button>
        </div>
      </div>

      <!-- QQ Music -->
      <div class="account-card">
        <div class="account-header">
          <Icon icon="mdi:music-circle-outline" class="account-icon" />
          <div class="account-info">
            <div class="account-name">QQ音乐</div>
            <div class="account-status" :class="{ logged: qqAuth.loggedIn }">
              {{ qqAuth.loggedIn ? `已登录: ${qqAuth.nickname}` : '未登录' }}
            </div>
          </div>
        </div>

        <div class="login-methods">
          <button
            class="login-btn"
            :class="{ active: qqLoginMode === 'qr' }"
            @click="startQrLogin('qq')"
            :disabled="qqQr.loading"
          >
            <Icon icon="mdi:qrcode" />
            扫码登录
          </button>
          <button
            class="login-btn"
            :class="{ active: qqLoginMode === 'cookie' }"
            @click="qqLoginMode = 'cookie'"
          >
            <Icon icon="mdi:cookie" />
            Cookie登录
          </button>
        </div>

        <!-- QR Code -->
        <div v-if="qqLoginMode === 'qr'" class="qr-section">
          <div v-if="qqQr.loading" class="qr-loading">
            <Icon icon="mdi:loading" class="spin" />
            生成二维码中...
          </div>
          <div v-else-if="qqQr.dataUrl" class="qr-wrap">
            <img :src="qqQr.dataUrl" class="qr-image" alt="QR Code" />
            <div class="qr-status" :class="qqQr.status">
              <template v-if="qqQr.status === 'waiting'">
                <Icon icon="mdi:cellphone" /> 请使用QQ音乐APP扫码
              </template>
              <template v-else-if="qqQr.status === 'scanned'">
                <Icon icon="mdi:check" /> 已扫码，请在手机上确认
              </template>
              <template v-else-if="qqQr.status === 'confirmed'">
                <Icon icon="mdi:check-circle" /> 登录成功!
              </template>
              <template v-else-if="qqQr.status === 'expired'">
                <Icon icon="mdi:refresh" /> 二维码已过期
                <button class="btn-link" @click="startQrLogin('qq')">重新生成</button>
              </template>
            </div>
          </div>
        </div>

        <!-- Cookie -->
        <div v-if="qqLoginMode === 'cookie'" class="cookie-section">
          <textarea
            v-model="qqCookie"
            class="textarea"
            placeholder="粘贴QQ音乐Cookie..."
            rows="3"
          />
          <button class="btn-primary btn-save" @click="saveCookie('qq')">保存Cookie</button>
        </div>
      </div>
      <!-- BiliBili -->
      <div class="account-card">
        <div class="account-header">
          <Icon icon="mdi:video-outline" class="account-icon bilibili-icon" />
          <div class="account-info">
            <div class="account-name">哔哩哔哩</div>
            <div class="account-status" :class="{ logged: bilibiliAuth.loggedIn }">
              {{ bilibiliAuth.loggedIn ? `已登录: ${bilibiliAuth.nickname}` : '未登录' }}
            </div>
          </div>
        </div>

        <div class="login-methods">
          <button
            class="login-btn"
            :class="{ active: bilibiliLoginMode === 'qr' }"
            @click="startQrLogin('bilibili')"
            :disabled="bilibiliQr.loading"
          >
            <Icon icon="mdi:qrcode" />
            扫码登录
          </button>
          <button
            class="login-btn"
            :class="{ active: bilibiliLoginMode === 'cookie' }"
            @click="bilibiliLoginMode = 'cookie'"
          >
            <Icon icon="mdi:cookie" />
            Cookie登录
          </button>
        </div>

        <!-- QR Code -->
        <div v-if="bilibiliLoginMode === 'qr'" class="qr-section">
          <div v-if="bilibiliQr.loading" class="qr-loading">
            <Icon icon="mdi:loading" class="spin" />
            生成二维码中...
          </div>
          <div v-else-if="bilibiliQr.dataUrl" class="qr-wrap">
            <img :src="bilibiliQr.dataUrl" class="qr-image" alt="QR Code" />
            <div class="qr-status" :class="bilibiliQr.status">
              <template v-if="bilibiliQr.status === 'waiting'">
                <Icon icon="mdi:cellphone" /> 请使用哔哩哔哩APP扫码
              </template>
              <template v-else-if="bilibiliQr.status === 'scanned'">
                <Icon icon="mdi:check" /> 已扫码，请在手机上确认
              </template>
              <template v-else-if="bilibiliQr.status === 'confirmed'">
                <Icon icon="mdi:check-circle" /> 登录成功!
              </template>
              <template v-else-if="bilibiliQr.status === 'expired'">
                <Icon icon="mdi:refresh" /> 二维码已过期
                <button class="btn-link" @click="startQrLogin('bilibili')">重新生成</button>
              </template>
            </div>
          </div>
        </div>

        <!-- Cookie -->
        <div v-if="bilibiliLoginMode === 'cookie'" class="cookie-section">
          <textarea
            v-model="bilibiliCookie"
            class="textarea"
            placeholder="粘贴哔哩哔哩Cookie..."
            rows="3"
          />
          <button class="btn-primary btn-save" @click="saveCookie('bilibili')">保存Cookie</button>
        </div>
      </div>
    </section>

    <!-- Audio Quality -->
    <section class="settings-section">
      <h2 class="section-title">音质设置</h2>
      <div class="setting-row">
        <div class="setting-label">
          <Icon icon="mdi:music-note-eighth" class="setting-icon" />
          音源质量
        </div>
        <div class="quality-options">
          <button
            v-for="q in qualityLevels"
            :key="q.value"
            class="quality-btn"
            :class="{ active: currentQuality === q.value }"
            @click="setQuality(q.value)"
          >
            <div class="quality-name">{{ q.label }}</div>
            <div class="quality-desc">{{ q.desc }}</div>
          </button>
        </div>
      </div>
    </section>

    <!-- Command Prefix -->
    <section class="settings-section">
      <h2 class="section-title">命令设置</h2>
      <div class="setting-row">
        <div class="setting-label">
          <Icon icon="mdi:console" class="setting-icon" />
          命令前缀
        </div>
        <div class="prefix-input-wrap">
          <input v-model="commandPrefix" class="input input-sm" placeholder="!" />
          <button class="btn-primary" @click="savePrefix">保存</button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import QRCode from 'qrcode';
import { usePlayerStore } from '../stores/player.js';

const store = usePlayerStore();

function botStatusClass(bot: any) {
  if (!bot.connected) return 'offline';
  if (bot.playing) return 'playing';
  if (bot.paused) return 'paused';
  return 'online';
}

function botStatusText(bot: any) {
  if (!bot.connected) return '离线';
  if (bot.playing) return '播放中';
  if (bot.paused) return '已暂停';
  return '在线';
}

const newBotName = ref('');
const newBotServer = ref('');
const newBotPort = ref(9987);
const newBotNickname = ref('MusicBot');
const newBotChannel = ref('');

// Edit bot
const editingBot = ref<string | null>(null);
const editForm = reactive({
  name: '',
  serverAddress: '',
  serverPort: 9987,
  nickname: '',
  defaultChannel: '',
  channelPassword: '',
});

const neteaseCookie = ref('');
const qqCookie = ref('');
const bilibiliCookie = ref('');
const commandPrefix = ref('!');

// Audio quality
const currentQuality = ref('exhigh');
const qualityLevels = [
  { value: 'standard', label: '标准', desc: '128kbps MP3' },
  { value: 'higher', label: '较高', desc: '192kbps MP3' },
  { value: 'exhigh', label: '极高', desc: '320kbps MP3' },
  { value: 'lossless', label: '无损', desc: 'FLAC' },
  { value: 'hires', label: 'Hi-Res', desc: '高解析度' },
  { value: 'jymaster', label: '超清母带', desc: '最高质量' },
];

async function loadQuality() {
  try {
    const res = await axios.get('/api/music/quality');
    currentQuality.value = res.data.netease || 'exhigh';
  } catch { /* ignore */ }
}

async function setQuality(q: string) {
  currentQuality.value = q;
  try {
    await axios.post('/api/music/quality', { quality: q });
  } catch { /* ignore */ }
}

// Login mode: 'qr' | 'cookie' | null
const neteaseLoginMode = ref<'qr' | 'cookie' | null>(null);
const qqLoginMode = ref<'qr' | 'cookie' | null>(null);
const bilibiliLoginMode = ref<'qr' | 'cookie' | null>(null);

// Auth status
const neteaseAuth = reactive({ loggedIn: false, nickname: '', avatarUrl: '' });
const qqAuth = reactive({ loggedIn: false, nickname: '', avatarUrl: '' });
const bilibiliAuth = reactive({ loggedIn: false, nickname: '', avatarUrl: '' });

// QR state
interface QrState {
  loading: boolean;
  dataUrl: string;
  key: string;
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired';
  pollTimer: ReturnType<typeof setInterval> | null;
}

const neteaseQr = reactive<QrState>({
  loading: false, dataUrl: '', key: '', status: 'waiting', pollTimer: null,
});
const qqQr = reactive<QrState>({
  loading: false, dataUrl: '', key: '', status: 'waiting', pollTimer: null,
});
const bilibiliQr = reactive<QrState>({
  loading: false, dataUrl: '', key: '', status: 'waiting', pollTimer: null,
});

function getQrState(platform: string): QrState {
  if (platform === 'bilibili') return bilibiliQr;
  return platform === 'netease' ? neteaseQr : qqQr;
}

async function checkAuthStatus() {
  try {
    const [nRes, qRes, bRes] = await Promise.all([
      axios.get('/api/auth/status', { params: { platform: 'netease' } }),
      axios.get('/api/auth/status', { params: { platform: 'qq' } }),
      axios.get('/api/auth/status', { params: { platform: 'bilibili' } }),
    ]);
    Object.assign(neteaseAuth, nRes.data);
    Object.assign(qqAuth, qRes.data);
    Object.assign(bilibiliAuth, bRes.data);
  } catch {
    // API not ready
  }
}

async function startQrLogin(platform: string) {
  const qr = getQrState(platform);
  if (platform === 'netease') neteaseLoginMode.value = 'qr';
  else if (platform === 'bilibili') bilibiliLoginMode.value = 'qr';
  else qqLoginMode.value = 'qr';

  // Stop existing poll
  if (qr.pollTimer) clearInterval(qr.pollTimer);
  qr.loading = true;
  qr.dataUrl = '';
  qr.status = 'waiting';

  try {
    const res = await axios.post('/api/auth/qrcode', { platform });
    const { qrUrl, qrImg, key } = res.data;
    qr.key = key;

    // Use server-generated QR image if available, otherwise generate client-side
    if (qrImg) {
      qr.dataUrl = qrImg;
    } else {
      qr.dataUrl = await QRCode.toDataURL(qrUrl, {
        width: 200,
        margin: 2,
        color: {
          dark: store.theme === 'dark' ? '#ffffff' : '#000000',
          light: store.theme === 'dark' ? '#2a2a2a' : '#ffffff',
        },
      });
    }

    qr.loading = false;

    // Start polling
    qr.pollTimer = setInterval(() => pollQrStatus(platform), 2000);
  } catch (err) {
    qr.loading = false;
    console.error('QR generation failed:', err);
  }
}

async function pollQrStatus(platform: string) {
  const qr = getQrState(platform);
  if (!qr.key) return;

  try {
    const res = await axios.get('/api/auth/qrcode/status', {
      params: { key: qr.key, platform },
    });
    qr.status = res.data.status;

    if (qr.status === 'confirmed') {
      if (qr.pollTimer) clearInterval(qr.pollTimer);
      qr.pollTimer = null;
      // Refresh auth status
      await checkAuthStatus();
    } else if (qr.status === 'expired') {
      if (qr.pollTimer) clearInterval(qr.pollTimer);
      qr.pollTimer = null;
    }
  } catch {
    // Ignore poll errors
  }
}

async function createBot() {
  if (!newBotName.value || !newBotServer.value) return;
  try {
    await axios.post('/api/bot', {
      name: newBotName.value,
      serverAddress: newBotServer.value,
      serverPort: newBotPort.value || 9987,
      nickname: newBotNickname.value || newBotName.value,
      defaultChannel: newBotChannel.value || undefined,
      autoStart: false,
    });
    newBotName.value = '';
    newBotServer.value = '';
    newBotPort.value = 9987;
    newBotNickname.value = 'MusicBot';
    newBotChannel.value = '';
    await store.fetchBots();
  } catch {
    // Ignore
  }
}

async function deleteBot(botId: string, botName: string) {
  if (!confirm(`确认删除机器人 "${botName}"？此操作不可撤销。`)) return;
  try {
    await axios.delete(`/api/bot/${botId}`);
    // If deleted bot was the active one, reset activeBotId
    if (store.activeBotId === botId) {
      store.activeBotId = null;
    }
    store.removeBotStatus(botId);
    await store.fetchBots();
  } catch {
    // Ignore
  }
}

async function openEditBot(bot: any) {
  editingBot.value = bot.id;
  editForm.name = bot.name;
  // Fetch saved config to fill all fields
  try {
    const res = await axios.get(`/api/bot/${bot.id}/config`);
    editForm.serverAddress = res.data.serverAddress ?? '';
    editForm.serverPort = res.data.serverPort ?? 9987;
    editForm.nickname = res.data.nickname ?? '';
    editForm.defaultChannel = res.data.defaultChannel ?? '';
    editForm.channelPassword = res.data.channelPassword ?? '';
  } catch {
    // Config not found — use defaults
    editForm.serverAddress = '';
    editForm.serverPort = 9987;
    editForm.nickname = bot.name;
    editForm.defaultChannel = '';
    editForm.channelPassword = '';
  }
}

async function saveEditBot() {
  if (!editingBot.value) return;
  try {
    await axios.put(`/api/bot/${editingBot.value}`, editForm);
    editingBot.value = null;
    await store.fetchBots();
  } catch {
    // Ignore
  }
}

async function toggleBot(botId: string, connected: boolean) {
  try {
    if (connected) {
      await axios.post(`/api/bot/${botId}/stop`);
    } else {
      await axios.post(`/api/bot/${botId}/start`);
    }
    await store.fetchBots();
  } catch {
    // Ignore
  }
}

async function saveCookie(platform: string) {
  const cookie = platform === 'bilibili' ? bilibiliCookie.value : platform === 'netease' ? neteaseCookie.value : qqCookie.value;
  if (!cookie) return;
  try {
    await axios.post('/api/auth/cookie', { platform, cookie });
    await checkAuthStatus();
  } catch {
    // Ignore
  }
}

async function savePrefix() {
  // Prefix is saved client-side for now
}

onMounted(() => {
  store.fetchBots(); // Refresh bot status on page visit
  checkAuthStatus();
  loadQuality();
});

onUnmounted(() => {
  if (neteaseQr.pollTimer) clearInterval(neteaseQr.pollTimer);
  if (qqQr.pollTimer) clearInterval(qqQr.pollTimer);
  if (bilibiliQr.pollTimer) clearInterval(bilibiliQr.pollTimer);
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

.page-title {
  font-size: 28px;
  font-weight: 800;
  margin-bottom: 32px;
}

.settings-section {
  margin-bottom: 36px;
  padding: 24px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
}

.section-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 16px;
}

.subsection-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
  margin-top: 16px;
}

.setting-row {
  margin-bottom: 16px;
}

.setting-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 8px;
}

.setting-icon {
  font-size: 18px;
  opacity: 0.6;
}

.theme-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 600;
  transition: all var(--transition-fast);
  &:hover { background: var(--color-primary); color: white; }
}

// Bot management
.bot-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bot-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
}

.bot-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.bot-name {
  font-size: 14px;
  font-weight: 500;
}

.bot-status {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  background: var(--border-color);
  color: var(--text-tertiary);
  &.online {
    background: rgba(51, 94, 234, 0.15);
    color: var(--color-primary);
  }
  &.playing {
    background: rgba(76, 175, 80, 0.15);
    color: #4caf50;
  }
  &.paused {
    background: rgba(255, 152, 0, 0.15);
    color: #ff9800;
  }
}

// Account cards
.account-card {
  margin-bottom: 20px;
  padding: 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
}

.account-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.account-icon {
  font-size: 28px;
  color: var(--color-primary);

  &.bilibili-icon {
    color: #00a1d6;
  }
}

.account-name {
  font-size: 15px;
  font-weight: 600;
}

.account-status {
  font-size: 12px;
  color: var(--text-tertiary);
  &.logged { color: #4caf50; }
}

.login-methods {
  display: flex;
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
  transition: all var(--transition-fast);

  &:hover { border-color: var(--color-primary); color: var(--color-primary); }
  &.active {
    background: rgba(51, 94, 234, 0.1);
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}

// QR code
.qr-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px 0;
}

.qr-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 14px;
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
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  background: var(--bg-card);

  &.scanned { color: #ff9800; background: rgba(255, 152, 0, 0.1); }
  &.confirmed { color: #4caf50; background: rgba(76, 175, 80, 0.1); }
  &.expired { color: #f44336; background: rgba(244, 67, 54, 0.1); }
}

.btn-link {
  color: var(--color-primary);
  font-size: 13px;
  font-weight: 600;
  text-decoration: underline;
  margin-left: 8px;
}

// Cookie section
.cookie-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.btn-save {
  align-self: flex-end;
}

// Shared
.form-row {
  display: flex;
  gap: 8px;
}

.input {
  flex: 1;
  padding: 10px 14px;
  background: var(--hover-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  &:focus { border-color: var(--color-primary); }
}

.input-sm { max-width: 80px; }

.textarea {
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  resize: vertical;
  &:focus { border-color: var(--color-primary); }
}

.quality-options {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.quality-btn {
  padding: 12px;
  background: var(--hover-bg);
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  text-align: center;
  transition: all var(--transition-fast);
  cursor: pointer;

  &:hover { border-color: var(--border-color); }
  &.active {
    border-color: var(--color-primary);
    background: rgba(51, 94, 234, 0.1);
  }
}

.quality-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 2px;
}

.quality-desc {
  font-size: 11px;
  color: var(--text-tertiary);
}

.prefix-input-wrap {
  display: flex;
  gap: 8px;
  align-items: center;
}

.btn-primary {
  padding: 10px 20px;
  background: var(--color-primary);
  color: white;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  transition: transform var(--transition-fast);
  &:hover { transform: scale(1.02); }
  &:active { transform: scale(0.98); }
}

.btn-sm {
  padding: 6px 14px;
  background: var(--hover-bg);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
  transition: all var(--transition-fast);
  &:hover { background: var(--color-primary); color: white; }
}

.btn-edit {
  padding: 6px 8px;
  font-size: 14px;
}

.btn-delete {
  padding: 6px 8px;
  font-size: 14px;
  &:hover { background: #f44336; color: white; }
}

.btn-secondary {
  padding: 10px 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
}

.bot-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.create-bot {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.form-group {
  margin-bottom: 12px;
  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 4px;
    opacity: 0.7;
  }
}

.edit-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
}

.edit-modal {
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  padding: 28px;
  width: 480px;
  max-width: 90vw;
  max-height: 80vh;
  overflow-y: auto;
}

.modal-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 20px;
}

.modal-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 20px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
