<template>
  <div class="saved-queues-page">
    <button class="back-btn" @click="$router.back()">
      <Icon icon="mdi:arrow-left" />
      返回
    </button>
    <h1 class="page-title">已保存队列</h1>

    <div v-if="disabled" class="empty">
      此功能未启用。请在「设置 → 行为设置」中开启「保存/加载播放清单」。
    </div>

    <template v-else>
      <!-- Save current queue -->
      <section class="save-card">
        <div class="save-title">保存当前队列</div>
        <div class="save-hint">
          将机器人 <strong>{{ activeBotName }}</strong> 当前的播放队列保存为一份清单，稍后可加载或追加。
        </div>
        <div class="save-row">
          <input
            v-model="newName"
            class="input"
            type="text"
            placeholder="清单名称"
            maxlength="80"
            @keyup.enter="onSave"
          />
          <label class="shared-check">
            <input v-model="newShared" type="checkbox" />
            共享
          </label>
          <button class="btn-primary" :disabled="!canSave || saving" @click="onSave">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </section>

      <div v-if="loading" class="loading">加载中...</div>
      <div v-else-if="queues.length === 0" class="empty">还没有已保存的队列</div>

      <div v-else class="queue-list">
        <div v-for="q in queues" :key="q.id" class="queue-row">
          <div class="queue-info">
            <span class="queue-name">{{ q.name }}</span>
            <span v-if="isShared(q)" class="badge shared">共享</span>
            <span v-else class="badge private">私有</span>
            <span class="queue-count">{{ q.songCount }} 首</span>
          </div>
          <div class="queue-actions">
            <button class="btn-sm primary" :disabled="!activeBotId || busyId === q.id" @click="onLoad(q, 'replace')">
              加载
            </button>
            <button class="btn-sm" :disabled="!activeBotId || busyId === q.id" @click="onLoad(q, 'append')">
              追加
            </button>
            <button class="btn-sm danger" :disabled="busyId === q.id" @click="onDelete(q)">
              删除
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import { usePlayerStore } from '../stores/player.js';
import { useSavedQueues } from '../composables/useSavedQueues.js';
import { isShared, type SavedQueueMeta } from '../composables/savedQueues.js';

const store = usePlayerStore();
const { queues, loading, disabled, list, save, load, remove } = useSavedQueues();

const newName = ref('');
const newShared = ref(false);
const saving = ref(false);
const busyId = ref<number | null>(null);

const activeBotId = computed(() => store.activeBotId);
const activeBotName = computed(() => store.activeBot?.name ?? '（未选择）');
const canSave = computed(() => !!activeBotId.value && newName.value.trim().length > 0);

async function onSave() {
  if (!canSave.value || saving.value) return;
  saving.value = true;
  try {
    await save(activeBotId.value!, newName.value.trim(), newShared.value);
    store.notify(`已保存「${newName.value.trim()}」`, 'info');
    newName.value = '';
    newShared.value = false;
  } catch (e: unknown) {
    const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
    store.notify(msg || '保存失败', 'error');
  } finally {
    saving.value = false;
  }
}

async function onLoad(q: SavedQueueMeta, mode: 'replace' | 'append') {
  if (!activeBotId.value) return;
  busyId.value = q.id;
  try {
    const res = await load(q.id, activeBotId.value, mode);
    store.notify(
      mode === 'append' ? `已追加「${q.name}」（${res.loaded} 首）` : `已加载「${q.name}」（${res.loaded} 首）`,
      'info',
    );
    store.fetchQueue();
  } catch {
    store.notify('加载失败', 'error');
  } finally {
    busyId.value = null;
  }
}

async function onDelete(q: SavedQueueMeta) {
  busyId.value = q.id;
  try {
    await remove(q.id);
    store.notify(`已删除「${q.name}」`, 'info');
  } catch {
    store.notify('删除失败', 'error');
  } finally {
    busyId.value = null;
  }
}

onMounted(async () => {
  if (!store.activeBotId) {
    await store.fetchBots();
  }
  await list();
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
  margin-bottom: 24px;
}

.save-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 18px;
  margin-bottom: 24px;
}

.save-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 6px;
}

.save-hint {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 14px;
}

.save-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.input {
  flex: 1;
  min-width: 180px;
  padding: 10px 12px;
  font-size: 14px;
  background: var(--hover-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: inherit;
  &:focus { outline: none; border-color: var(--color-primary); }
}

.shared-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  white-space: nowrap;
  cursor: pointer;
}

.btn-primary {
  padding: 10px 18px;
  font-size: 14px;
  font-weight: 600;
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: #fff;
  border: 1px solid var(--color-primary);
  cursor: pointer;
  transition: filter var(--transition-fast);
  &:hover:not(:disabled) { filter: brightness(1.08); }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}

.queue-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.queue-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  flex-wrap: wrap;
}

.queue-info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.queue-name {
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-count {
  font-size: 12px;
  color: var(--text-tertiary);
}

.badge {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
  &.shared { background: var(--color-primary-15); color: var(--color-primary); }
  &.private { background: var(--hover-bg); color: var(--text-secondary); }
}

.queue-actions {
  display: flex;
  gap: 6px;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: var(--radius-sm);
  background: var(--hover-bg);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  cursor: pointer;
  transition: all var(--transition-fast);
  &:hover:not(:disabled) { background: var(--bg-secondary); border-color: var(--color-primary); }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
  &.primary { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
  &.danger { color: #ef4444; }
}

.loading {
  text-align: center;
  padding: 60px;
  color: var(--text-secondary);
}

.empty {
  text-align: center;
  padding: 60px 20px;
  color: var(--text-tertiary);
  font-size: 14px;
}
</style>
