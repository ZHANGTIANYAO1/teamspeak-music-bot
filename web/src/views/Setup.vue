<template>
  <div class="setup-wizard">
    <div class="steps">
      <div v-for="(label, i) in stepLabels" :key="i" class="step" :class="{ active: currentStep === i, done: currentStep > i }">
        <div class="step-dot">{{ currentStep > i ? '✓' : i + 1 }}</div>
        <div class="step-label">{{ label }}</div>
      </div>
    </div>

    <div v-if="currentStep === 0" class="step-content">
      <h2>欢迎使用 TSMusicBot</h2>
      <p class="subtitle">请设置管理员密码以保护你的 WebUI</p>
      <div class="form-group">
        <label>管理员密码</label>
        <input type="password" v-model="adminPassword" placeholder="设置密码" class="input" />
      </div>
      <div class="form-group">
        <label>语言</label>
        <select v-model="locale" class="input">
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </div>
      <div class="form-group">
        <label>主题</label>
        <select v-model="theme" class="input">
          <option value="dark">深色</option>
          <option value="light">浅色</option>
        </select>
      </div>
      <button class="btn-primary" @click="currentStep = 1">下一步</button>
    </div>

    <div v-if="currentStep === 1" class="step-content">
      <h2>连接 TeamSpeak 服务器</h2>
      <div class="form-group">
        <label>服务器地址</label>
        <input v-model="serverAddress" placeholder="ts.example.com" class="input" />
      </div>
      <div class="form-group">
        <label>端口</label>
        <input v-model.number="serverPort" type="number" placeholder="9987" class="input" />
      </div>
      <div class="form-group">
        <label>机器人昵称</label>
        <input v-model="nickname" placeholder="MusicBot" class="input" />
      </div>
      <div class="form-group">
        <label>默认频道名称（可选）</label>
        <input v-model="defaultChannel" :disabled="!!channelId" placeholder="音乐频道" class="input" :class="{ disabled: !!channelId }" />
      </div>
      <div class="form-group">
        <label>默认频道ID（可选）</label>
        <input v-model="channelId" :disabled="!!defaultChannel" placeholder="如 12" class="input" :class="{ disabled: !!defaultChannel }" />
      </div>
      <div class="btn-row">
        <button class="btn-secondary" @click="currentStep = 0">上一步</button>
        <button class="btn-primary" @click="createBotAndNext">下一步</button>
      </div>
    </div>

    <div v-if="currentStep === 2" class="step-content">
      <h2>连接 Jellyfin (可选)</h2>
      <p class="subtitle">连接自建 Jellyfin 服务器作为主音源；也可稍后在「设置」中配置</p>
      <div class="form-group">
        <label>服务器地址</label>
        <input v-model="jellyfin.serverUrl" placeholder="https://jellyfin.example.com" class="input" />
      </div>
      <div class="form-group">
        <label>认证方式</label>
        <select v-model="jellyfin.authMode" class="input">
          <option value="userpass">账号密码</option>
          <option value="apikey">API Key</option>
        </select>
      </div>
      <template v-if="jellyfin.authMode === 'userpass'">
        <div class="form-group">
          <label>用户名</label>
          <input v-model="jellyfin.username" placeholder="Jellyfin 用户名" class="input" />
        </div>
        <div class="form-group">
          <label>密码</label>
          <input v-model="jellyfin.password" type="password" placeholder="Jellyfin 密码" class="input" />
        </div>
      </template>
      <template v-else>
        <div class="form-group">
          <label>API Key</label>
          <input v-model="jellyfin.apiKey" type="password" placeholder="Jellyfin API Key" class="input" />
        </div>
        <div class="form-group">
          <label>用户 ID</label>
          <input v-model="jellyfin.userId" placeholder="该 Key 使用的用户 ID" class="input" />
        </div>
      </template>
      <p v-if="jellyfinTestMessage" class="test-message" :class="{ ok: jellyfinTestOk }">{{ jellyfinTestMessage }}</p>
      <div class="btn-row">
        <button class="btn-secondary" @click="currentStep = 1">上一步</button>
        <button class="btn-secondary" @click="currentStep = 3">跳过</button>
        <button class="btn-secondary" :disabled="jellyfinTesting" @click="testJellyfin">
          {{ jellyfinTesting ? '测试中…' : '测试连接' }}
        </button>
        <button class="btn-primary" :disabled="jellyfinSaving" @click="saveJellyfinAndNext">
          {{ jellyfinSaving ? '保存中…' : '保存并继续' }}
        </button>
      </div>
    </div>

    <div v-if="currentStep === 3" class="step-content done-step">
      <h2>设置完成!</h2>
      <p class="subtitle">TSMusicBot 已准备就绪</p>
      <button class="btn-primary" @click="$router.push('/')">开始使用</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import axios from 'axios';

const currentStep = ref(0);
const stepLabels = ['欢迎', 'TS 服务器', 'Jellyfin', '完成'];

const adminPassword = ref('');
const locale = ref('zh');
const theme = ref('dark');
const serverAddress = ref('');
const serverPort = ref(9987);
const nickname = ref('MusicBot');
const defaultChannel = ref('');
const channelId = ref('');

// Jellyfin — the primary music source. Optional: skipping leaves it
// configurable later in Settings.
const jellyfin = reactive({
  serverUrl: '',
  authMode: 'userpass' as 'userpass' | 'apikey',
  username: '',
  password: '',
  apiKey: '',
  userId: '',
});
const jellyfinTesting = ref(false);
const jellyfinSaving = ref(false);
const jellyfinTestOk = ref(false);
const jellyfinTestMessage = ref('');

async function createBotAndNext() {
  try {
    await axios.post('/api/bot', {
      name: `Bot - ${serverAddress.value}`,
      serverAddress: serverAddress.value,
      serverPort: serverPort.value,
      nickname: nickname.value,
      defaultChannel: defaultChannel.value,
      channelId: channelId.value || undefined,
      autoStart: true,
    });
    currentStep.value = 2;
  } catch (err) {
    alert('Failed to create bot: ' + (err as Error).message);
  }
}

async function testJellyfin() {
  jellyfinTesting.value = true;
  jellyfinTestMessage.value = '';
  try {
    const res = await axios.post('/api/auth/jellyfin/test', { ...jellyfin });
    jellyfinTestOk.value = Boolean(res.data?.ok);
    jellyfinTestMessage.value = res.data?.ok
      ? `连接成功：${res.data.serverName ?? 'Jellyfin'} ${res.data.version ?? ''}`
      : `连接失败：${res.data?.error ?? '未知错误'}`;
  } catch {
    jellyfinTestOk.value = false;
    jellyfinTestMessage.value = '测试请求失败，请检查地址后重试';
  } finally {
    jellyfinTesting.value = false;
  }
}

async function saveJellyfinAndNext() {
  jellyfinSaving.value = true;
  try {
    await axios.post('/api/bot/settings', { jellyfin: { ...jellyfin } });
    currentStep.value = 3;
  } catch {
    jellyfinTestOk.value = false;
    jellyfinTestMessage.value = '保存失败，请稍后在「设置」中重试';
  } finally {
    jellyfinSaving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.setup-wizard {
  max-width: 560px;
  margin: 0 auto;
  padding-top: 40px;
}

.steps {
  display: flex;
  justify-content: space-between;
  margin-bottom: 48px;
}

.step {
  text-align: center;
  flex: 1;
}

.step-dot {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
  background: var(--hover-bg);
  margin-bottom: 8px;
  opacity: 0.5;
}

.step.active .step-dot {
  background: var(--color-primary);
  color: white;
  opacity: 1;
}

.step.done .step-dot {
  background: var(--color-primary);
  color: white;
  opacity: 0.7;
}

.step-label {
  font-size: 12px;
  opacity: 0.5;
}

.step.active .step-label { opacity: 1; color: var(--color-primary); }

.step-content h2 {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 8px;
}

.subtitle {
  color: var(--text-secondary);
  margin-bottom: 32px;
}

.form-group {
  margin-bottom: 20px;

  label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 6px;
    opacity: 0.8;
  }
}

.input {
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font-size: 14px;
  color: var(--text-primary);
  outline: none;
  font-family: inherit;

  &:focus {
    border-color: var(--color-primary);
  }
  &.disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
}

.btn-primary {
  padding: 10px 32px;
  background: var(--color-primary);
  color: white;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 600;
  transition: transform var(--transition-fast);

  &:hover { transform: scale(1.04); }
  &:active { transform: scale(0.96); }
}

.btn-secondary {
  padding: 10px 32px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 600;
}

.btn-row {
  display: flex;
  gap: 12px;
  margin-top: 32px;
}

.test-message {
  font-size: 13px;
  color: #e67e22;
  margin-top: -6px;

  &.ok { color: var(--color-online, #22c55e); }
}

.done-step {
  text-align: center;
  padding-top: 60px;
}
</style>
