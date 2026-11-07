<template>
  <div class="history-page">
    <button class="back-btn" @click="$router.back()">
      <Icon icon="mdi:arrow-left" />
      返回
    </button>
    <h1 class="page-title">播放历史</h1>

    <div v-if="loading" class="loading">加载中...</div>

    <div v-else-if="history.length === 0" class="empty">
      暂无播放记录
    </div>

    <template v-else>
      <div class="toolbar">
        <label class="select-all">
          <input type="checkbox" :checked="allSelected" @change="toggleAll" />
          全选
        </label>
        <span class="spacer" />
        <button class="tool-btn" :disabled="selected.size === 0" @click="deleteSelected">
          <Icon icon="mdi:delete-outline" />
          删除选中{{ selected.size ? `（${selected.size}）` : '' }}
        </button>
        <button class="tool-btn danger" :disabled="history.length === 0" @click="clearAll">
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
            type="checkbox"
            class="row-check"
            :checked="selected.has(song.rowId)"
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
          <button class="row-del" title="删除这条记录" @click.stop="deleteOne(song.rowId)">
            <Icon icon="mdi:close" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore } from '../stores/player.js';
import SongCard from '../components/SongCard.vue';

const store = usePlayerStore();

import { Song } from '../stores/player.js';

/** History rows carry their DB primary key (`rowId`) so a single record can be removed. */
type HistorySong = Song & { rowId: number };

const history = ref<HistorySong[]>([]);
const loading = ref(true);
const selected = ref(new Set<number>());

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

async function deleteOne(rowId: number) {
  if (!store.activeBotId) return;
  try {
    await axios.delete(`/api/player/${store.activeBotId}/history/${rowId}`);
    history.value = history.value.filter((s) => s.rowId !== rowId);
    if (selected.value.has(rowId)) toggle(rowId);
  } catch {
    // Keep the row when the request fails; the list stays consistent with the server.
  }
}

async function deleteSelected() {
  if (!store.activeBotId || selected.value.size === 0) return;
  const ids = Array.from(selected.value);
  try {
    await axios.delete(`/api/player/${store.activeBotId}/history`, { data: { ids } });
    const drop = new Set(ids);
    history.value = history.value.filter((s) => !drop.has(s.rowId));
    selected.value = new Set<number>();
  } catch {
    // Leave the selection in place so the user can retry.
  }
}

async function clearAll() {
  if (!store.activeBotId) return;
  if (!window.confirm('确定清空全部播放历史吗？此操作不可恢复。')) return;
  try {
    await axios.delete(`/api/player/${store.activeBotId}/history`, { data: { all: true } });
    history.value = [];
    selected.value = new Set<number>();
  } catch {
    // No optimistic clear on failure.
  }
}

onMounted(async () => {
  if (!store.activeBotId) {
    await store.fetchBots();
  }

  if (store.activeBotId) {
    try {
      const res = await axios.get(`/api/player/${store.activeBotId}/history`);
      history.value = res.data.history;
    } catch {
      // Ignore if API not ready
    }
  }

  loading.value = false;
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
    opacity: 0;
    color: var(--text-tertiary);
    border-radius: var(--radius-sm);
    transition: all var(--transition-fast);

    &:hover { color: #f2555a; opacity: 1; }
  }

  &:hover .row-del { opacity: 1; }
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
