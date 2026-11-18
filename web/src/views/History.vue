<template>
  <div class="history-page">
    <button class="back-btn" @click="$router.back()">
      <Icon icon="mdi:arrow-left" />
      返回
    </button>
    <h1 class="page-title">播放历史</h1>

    <p v-if="error" class="history-error" role="alert">{{ error }}</p>
    <div v-if="loading" class="loading">加载中...</div>

    <div v-else-if="history.length === 0" class="empty">
      暂无播放记录
    </div>

    <template v-else>
      <div v-if="canDelete" class="toolbar">
        <label class="select-all">
          <input type="checkbox" :checked="allSelected" :disabled="deleting" @change="toggleAll" />
          全选
        </label>
        <span class="spacer" />
        <button class="tool-btn" :disabled="deleting || selected.size === 0" @click="deleteSelected">
          <Icon icon="mdi:delete-outline" />
          删除选中{{ selected.size ? `（${selected.size}）` : '' }}
        </button>
        <button class="tool-btn danger" :disabled="deleting" @click="clearAll">
          <Icon icon="mdi:delete-sweep-outline" />
          清空全部
        </button>
      </div>

      <div class="history-list">
        <div
          v-for="(song, i) in history"
          :key="song.rowId"
          class="history-row"
          :class="{ selected: selected.has(song.rowId) }"
        >
          <input
            v-if="canDelete"
            type="checkbox"
            class="row-check"
            :aria-label="`选择 ${song.name}`"
            :checked="selected.has(song.rowId)"
            :disabled="deleting"
            @change="toggle(song.rowId)"
          />
          <SongCard
            class="row-card"
            :song="song"
            :index="i + 1"
            :active="store.currentSong?.id === song.id"
            @play="store.playSong(song)"
            @playNext="store.playNextSong(song)"
            @add="store.addSong(song)"
          />
          <button
            v-if="canDelete"
            class="row-del"
            title="删除这条记录"
            :aria-label="`删除 ${song.name} 的播放记录`"
            :disabled="deleting"
            @click.stop="deleteHistory([song.rowId])"
          >
            <Icon icon="mdi:close" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore } from '../stores/player.js';
import { useSession } from '../composables/useSession.js';
import SongCard from '../components/SongCard.vue';

const store = usePlayerStore();
const { can, guestCan } = useSession();

import { Song } from '../stores/player.js';

/** History rows carry their DB primary key (`rowId`) so a single record can be removed. */
type HistorySong = Song & { rowId: number };

const history = ref<HistorySong[]>([]);
const loading = ref(true);
const deleting = ref(false);
const error = ref('');
const selected = ref(new Set<number>());
const canDelete = computed(() => can('player.queue') || guestCan('removeClear'));
let historyVersion = 0;

const allSelected = computed(
  () => history.value.length > 0 && selected.value.size === history.value.length
);

function toggle(rowId: number) {
  const next = new Set(selected.value);
  if (next.has(rowId)) next.delete(rowId);
  else next.add(rowId);
  selected.value = next;
}

function toggleAll() {
  selected.value = allSelected.value
    ? new Set<number>()
    : new Set(history.value.map((s) => s.rowId));
}

async function deleteHistory(ids: number[] | null) {
  const botId = store.activeBotId;
  if (!botId || !canDelete.value || deleting.value) return;
  const version = historyVersion;
  const url = `/api/player/${encodeURIComponent(botId)}/history`;
  deleting.value = true;
  error.value = '';
  try {
    if (ids?.length === 1) {
      await axios.delete(`${url}/${ids[0]}`);
    } else {
      await axios.delete(url, { data: ids ? { ids } : { all: true } });
    }
    if (version !== historyVersion) return;
    const removed = new Set(ids);
    history.value = ids ? history.value.filter((song) => !removed.has(song.rowId)) : [];
    selected.value = ids ? new Set([...selected.value].filter((id) => !removed.has(id))) : new Set();
  } catch {
    if (version === historyVersion) error.value = '删除播放记录失败，请重试。';
  } finally {
    if (version === historyVersion) deleting.value = false;
  }
}

function deleteSelected() {
  if (selected.value.size) void deleteHistory([...selected.value]);
}

function clearAll() {
  if (window.confirm('确定清空全部播放历史吗？此操作不可恢复。')) void deleteHistory(null);
}

watch(() => store.activeBotId, async (botId, _previous, onCleanup) => {
  historyVersion++;
  history.value = [];
  selected.value = new Set();
  deleting.value = false;
  error.value = '';
  loading.value = !!botId;
  if (!botId) return;

  const controller = new AbortController();
  onCleanup(() => controller.abort());
  try {
    const { data } = await axios.get(`/api/player/${encodeURIComponent(botId)}/history`, { signal: controller.signal });
    if (!controller.signal.aborted) history.value = data.history;
  } catch {
    if (!controller.signal.aborted) error.value = '加载播放历史失败。';
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}, { immediate: true, flush: 'sync' });

onMounted(async () => {
  if (!store.activeBotId) {
    await store.fetchBots();
  }
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

.history-error {
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;

  .spacer { flex: 1; }

  .select-all {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-secondary);
    cursor: pointer;
    user-select: none;
  }
}

.tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 13px;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  transition: all var(--transition-fast);

  &:hover:not(:disabled) { color: var(--text-primary); }
  &:disabled { opacity: 0.4; cursor: not-allowed; }

  &.danger:hover:not(:disabled) { color: #f2555a; }
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.history-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);

  &.selected { background: rgba(51, 94, 234, 0.08); }

  .row-check {
    flex: none;
    margin-left: 4px;
    cursor: pointer;
  }

  .row-card { flex: 1; min-width: 0; }

  .row-del {
    flex: none;
    display: flex;
    align-items: center;
    padding: 4px;
    color: var(--text-tertiary);
    border-radius: var(--radius-sm);
    transition: all var(--transition-fast);

    &:hover, &:focus-visible { color: #f2555a; }
    &:disabled { opacity: 0.4; cursor: not-allowed; }
  }
}

.loading {
  text-align: center;
  padding: 60px;
  color: var(--text-secondary);
}

.empty {
  text-align: center;
  padding: 80px;
  color: var(--text-tertiary);
  font-size: 14px;
}
</style>
