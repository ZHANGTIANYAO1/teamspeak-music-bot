<template>
  <!-- Admin console for the music-account pool (#164 follow-up).
       One row per login the admin owns; each row can be handed to members (or
       to another admin). See src/web/api/music-accounts.ts for the rules. -->
  <div class="pool">
    <p class="hint">
      这里存放管理员拥有的音乐账号，可以逐个分配给成员。成员自己扫码绑定的账号优先级更高，
      管理员分配的账号只在他们没绑定自己的账号时生效。播放地址、搜索、歌单都会按被分配的账号获取。
    </p>

    <!-- Create -->
    <div class="create-row">
      <select v-model="draft.platform" class="field">
        <option v-for="p in platforms" :key="p.platform" :value="p.platform">
          {{ PLATFORM_LABEL[p.platform] ?? p.platform }}
          {{ p.playbackSupported ? '' : '（暂不支持按账号播放）' }}
        </option>
      </select>
      <input v-model="draft.label" class="field" placeholder="名称，如 网易云-主号" maxlength="64" />
      <input
        v-model.number="draft.capacity"
        class="field field-narrow"
        type="number"
        min="0"
        title="0 = 可分配给多人；1 = 独占，只能给一个人"
        placeholder="人数上限"
      />
      <button class="btn primary" :disabled="creating" @click="create">
        <Icon icon="mdi:plus" /> 添加账号
      </button>
      <button class="btn" :disabled="creating" @click="importShared">
        <Icon icon="mdi:download" /> 从共享账号导入
      </button>
    </div>
    <textarea
      v-model="draft.cookie"
      class="field cookie-input"
      rows="2"
      placeholder="粘贴该账号的 Cookie（仅保存在服务器，列表里只显示掩码）"
    ></textarea>
    <p v-if="error" class="error">{{ error }}</p>

    <!-- List -->
    <div v-if="accounts.length === 0" class="empty">还没有添加任何账号</div>

    <div v-for="a in accounts" :key="a.id" class="account" :class="{ disabled: !a.enabled }">
      <div class="account-head">
        <div class="account-title">
          <span class="badge">{{ PLATFORM_LABEL[a.platform] ?? a.platform }}</span>
          <span class="label">{{ a.label }}</span>
          <span v-if="a.capacity === 1" class="tag exclusive">独占</span>
          <span v-else-if="a.capacity > 1" class="tag">最多 {{ a.capacity }} 人</span>
          <span v-else class="tag">不限人数</span>
          <span v-if="!a.playbackSupported" class="tag warn">该平台暂不支持按账号播放</span>
        </div>
        <div class="account-actions">
          <button class="btn tiny" @click="probe(a)">
            <Icon icon="mdi:shield-check" /> 检测
          </button>
          <label class="switch" :title="a.enabled ? '已启用' : '已停用'">
            <input type="checkbox" :checked="a.enabled" @change="toggleEnabled(a)" />
            <span class="slider"></span>
          </label>
          <button class="btn tiny danger" @click="remove(a)">
            <Icon icon="mdi:trash-can-outline" />
          </button>
        </div>
      </div>

      <div class="account-meta">
        <span class="mono">{{ a.cookiePreview }}</span>
        <span v-if="probeResult[a.id]" class="probe" :class="{ ok: probeResult[a.id]!.loggedIn }">
          {{ probeResult[a.id]!.loggedIn ? `登录有效${probeResult[a.id]!.nickname ? '：' + probeResult[a.id]!.nickname : ''}` : '登录已失效' }}
        </span>
      </div>

      <div class="grantees">
        <span class="grantees-label">已分配：</span>
        <span v-if="a.grantees.length === 0" class="muted">无</span>
        <span v-for="g in a.grantees" :key="g.userId" class="chip">
          {{ g.username }}
          <button class="chip-x" title="收回" @click="revoke(a, g.userId)">×</button>
        </span>
        <select
          class="field field-narrow assign-select"
          :value="''"
          :disabled="assignable(a).length === 0"
          @change="onAssign(a, $event)"
        >
          <option value="">{{ assignable(a).length === 0 ? '已满额' : '+ 分配给…' }}</option>
          <option v-for="u in assignable(a)" :key="u.id" :value="u.id">
            {{ u.username }}{{ u.role === 'admin' ? '（管理员）' : '' }}
          </option>
        </select>
      </div>

      <div class="cookie-edit">
        <input
          v-model="cookieDraft[a.id]"
          class="field"
          type="password"
          placeholder="更新 Cookie（登录失效时用）"
        />
        <button class="btn tiny" :disabled="!cookieDraft[a.id]" @click="updateCookie(a)">
          保存
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';

interface Grantee { userId: string; username: string; grantedAt: string }
interface PoolAccount {
  id: string;
  platform: string;
  label: string;
  cookiePreview: string;
  capacity: number;
  enabled: boolean;
  playbackSupported: boolean;
  granteeCount: number;
  grantees: Grantee[];
}
interface AssignableUser { id: string; username: string; role: string }

const PLATFORM_LABEL: Record<string, string> = {
  netease: '网易云',
  qq: 'QQ音乐',
  kugou: '酷狗',
  bilibili: 'B站',
};

const accounts = ref<PoolAccount[]>([]);
const users = ref<AssignableUser[]>([]);
const platforms = ref<Array<{ platform: string; playbackSupported: boolean }>>([]);
const creating = ref(false);
const error = ref('');
// Default to exclusive: sharing one login between members mixes their
// playback history and recommendations, which is almost never intended.
const draft = reactive({ platform: 'netease', label: '', cookie: '', capacity: 1 });
const cookieDraft = reactive<Record<string, string>>({});
const probeResult = ref<Record<string, { loggedIn: boolean; nickname?: string } | undefined>>({});

const assignable = (a: PoolAccount) => {
  const held = new Set(a.grantees.map((g) => g.userId));
  // An exclusive account that already has a holder offers nobody: the API would
  // answer 409 anyway, so don't dangle options that cannot work.
  if (a.capacity === 1 && a.granteeCount >= 1) return [];
  if (a.capacity > 1 && a.granteeCount >= a.capacity) return [];
  return users.value.filter((u) => !held.has(u.id));
};

const errText = (err: any, fallback: string) => {
  const e = err?.response?.data?.error;
  if (e === 'account_exclusive') return '该账号是独占的，请先收回其他成员';
  if (e === 'account_full') return '该账号已分配满额';
  if (e === 'account_disabled') return '该账号已停用';
  if (e === 'no_shared_login') return '机器人还没有登录该平台的共享账号';
  return e ?? fallback;
};

async function load() {
  try {
    const res = await axios.get('/api/music-accounts');
    accounts.value = res.data.accounts ?? [];
    users.value = res.data.users ?? [];
    platforms.value = res.data.platforms ?? [];
    if (!platforms.value.some((p) => p.platform === draft.platform)) {
      draft.platform = platforms.value[0]?.platform ?? 'netease';
    }
  } catch (err) {
    error.value = errText(err, '加载失败');
  }
}

async function create() {
  error.value = '';
  if (!draft.label.trim() || !draft.cookie.trim()) {
    error.value = '名称和 Cookie 都要填';
    return;
  }
  creating.value = true;
  try {
    await axios.post('/api/music-accounts', {
      platform: draft.platform,
      label: draft.label.trim(),
      cookie: draft.cookie.trim(),
      capacity: Number(draft.capacity) || 0,
    });
    draft.label = '';
    draft.cookie = '';
    draft.capacity = 1;
    await load();
  } catch (err) {
    error.value = errText(err, '添加失败');
  } finally {
    creating.value = false;
  }
}

async function importShared() {
  error.value = '';
  creating.value = true;
  try {
    await axios.post('/api/music-accounts/import-shared', {
      platform: draft.platform,
      label: `${PLATFORM_LABEL[draft.platform] ?? draft.platform} 共享账号`,
      capacity: Number(draft.capacity) || 0,
    });
    await load();
  } catch (err) {
    error.value = errText(err, '导入失败');
  } finally {
    creating.value = false;
  }
}

async function toggleEnabled(a: PoolAccount) {
  error.value = '';
  try {
    await axios.patch(`/api/music-accounts/${a.id}`, { enabled: !a.enabled });
    await load();
  } catch (err) {
    error.value = errText(err, '操作失败');
  }
}

async function updateCookie(a: PoolAccount) {
  error.value = '';
  try {
    await axios.patch(`/api/music-accounts/${a.id}`, { cookie: cookieDraft[a.id] });
    cookieDraft[a.id] = '';
    await load();
  } catch (err) {
    error.value = errText(err, '保存失败');
  }
}

async function remove(a: PoolAccount) {
  if (!confirm(`删除「${a.label}」？已分配给成员的记录会一起收回。`)) return;
  error.value = '';
  try {
    await axios.delete(`/api/music-accounts/${a.id}`);
    await load();
  } catch (err) {
    error.value = errText(err, '删除失败');
  }
}

async function onAssign(a: PoolAccount, ev: Event) {
  const select = ev.target as HTMLSelectElement;
  const userId = select.value;
  select.value = '';
  if (!userId) return;
  error.value = '';
  try {
    await axios.post(`/api/music-accounts/${a.id}/assign`, { userId });
    await load();
  } catch (err) {
    error.value = errText(err, '分配失败');
  }
}

async function revoke(a: PoolAccount, userId: string) {
  error.value = '';
  try {
    await axios.delete(`/api/music-accounts/${a.id}/assign/${userId}`);
    await load();
  } catch (err) {
    error.value = errText(err, '收回失败');
  }
}

async function probe(a: PoolAccount) {
  error.value = '';
  try {
    const res = await axios.post(`/api/music-accounts/${a.id}/probe`);
    probeResult.value[a.id] = { loggedIn: Boolean(res.data.loggedIn), nickname: res.data.nickname };
  } catch (err) {
    probeResult.value[a.id] = { loggedIn: false };
    error.value = errText(err, '检测失败');
  }
}

onMounted(load);
</script>

<style lang="scss" scoped>
.pool {
  margin-top: 12px;
}

.hint {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.6;
  margin: 0 0 12px;
}

.create-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.field {
  padding: 7px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: inherit;
  font-size: 13px;
  min-width: 0;
  &:focus {
    outline: none;
    border-color: var(--color-primary);
  }
}

.field-narrow {
  width: 96px;
}

.cookie-input {
  width: 100%;
  resize: vertical;
  font-family: var(--font-mono, monospace);
  margin-bottom: 8px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: inherit;
  cursor: pointer;
  transition: all var(--transition-fast);
  &:hover:not(:disabled) {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  &:disabled {
    opacity: 0.55;
    cursor: default;
  }
  &.primary {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  &.tiny {
    padding: 4px 8px;
    font-size: 12px;
  }
  &.danger:hover {
    border-color: #e26a6a;
    color: #e26a6a;
  }
}

.empty {
  padding: 16px;
  font-size: 13px;
  color: var(--text-tertiary);
  text-align: center;
}

.account {
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  margin-bottom: 10px;
  background: var(--hover-bg);
  &.disabled {
    opacity: 0.6;
  }
}

.account-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.account-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.badge {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
}

.label {
  font-weight: 600;
  font-size: 14px;
}

.tag {
  font-size: 11px;
  color: var(--text-tertiary);
  &.exclusive {
    color: var(--color-primary);
  }
  &.warn {
    color: #d19a3a;
  }
}

.account-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.account-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-tertiary);
  flex-wrap: wrap;
}

.mono {
  font-family: var(--font-mono, monospace);
}

.probe {
  color: #e26a6a;
  &.ok {
    color: var(--color-online);
  }
}

.grantees {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.grantees-label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.muted {
  font-size: 12px;
  color: var(--text-tertiary);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  font-size: 12px;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
}

.chip-x {
  border: none;
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 0 0 2px;
  &:hover {
    color: #e26a6a;
  }
}

.assign-select {
  margin-left: auto;
}

.cookie-edit {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  .field {
    flex: 1;
  }
}

.switch {
  position: relative;
  display: inline-block;
  width: 34px;
  height: 18px;
  input {
    opacity: 0;
    width: 0;
    height: 0;
  }
  .slider {
    position: absolute;
    inset: 0;
    background: var(--border-color);
    border-radius: 9px;
    cursor: pointer;
    transition: background var(--transition-fast);
  }
  .slider::before {
    content: '';
    position: absolute;
    width: 14px;
    height: 14px;
    left: 2px;
    top: 2px;
    background: #fff;
    border-radius: 50%;
    transition: transform var(--transition-fast);
  }
  input:checked + .slider {
    background: var(--color-primary);
  }
  input:checked + .slider::before {
    transform: translateX(16px);
  }
}

.error {
  margin: 6px 0;
  font-size: 12px;
  color: #e26a6a;
}
</style>
