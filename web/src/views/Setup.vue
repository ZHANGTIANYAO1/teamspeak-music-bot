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
        <label>服务器密码 (可选)</label>
        <input v-model="serverPassword" type="password" placeholder="需要密码才能连接的服务器" class="input" />
      </div>
      <div class="form-group">
        <label>默认频道 (可选)</label>
        <input v-model="defaultChannel" placeholder="音乐频道" class="input" />
      </div>
      <div class="btn-row">
        <button class="btn-secondary" @click="currentStep = 0">上一步</button>
        <button class="btn-primary" @click="createBotAndNext">下一步</button>
      </div>
    </div>

    <div v-if="currentStep === 2" class="step-content">
      <h2>登录音乐账号 (可选)</h2>
      <p class="subtitle">登录后可播放 VIP/付费歌曲，跳过则只能播放免费歌曲</p>
      <div class="btn-row">
        <button class="btn-secondary" @click="currentStep = 1">上一步</button>
        <button class="btn-secondary" @click="currentStep = 3">跳过</button>
        <button class="btn-primary" @click="currentStep = 3">完成登录</button>
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
import { ref } from 'vue';
import axios from 'axios';

const currentStep = ref(0);
const stepLabels = ['欢迎', 'TS 服务器', '音乐账号', '完成'];

const adminPassword = ref('');
const locale = ref('zh');
const theme = ref('dark');
const serverAddress = ref('');
const serverPort = ref(9987);
const nickname = ref('MusicBot');
const serverPassword = ref('');
const defaultChannel = ref('');

async function createBotAndNext() {
  try {
    await axios.post('/api/bot', {
      name: `Bot - ${serverAddress.value}`,
      serverAddress: serverAddress.value,
      serverPort: serverPort.value,
      nickname: nickname.value,
      serverPassword: serverPassword.value || undefined,
      defaultChannel: defaultChannel.value,
      autoStart: true,
    });
    currentStep.value = 2;
  } catch (err) {
    alert('Failed to create bot: ' + (err as Error).message);
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

.done-step {
  text-align: center;
  padding-top: 60px;
}
</style>
