import { ref } from 'vue';
import axios from 'axios';
import { sortQueues, type SavedQueueMeta } from './savedQueues.js';

/**
 * API composable for the Saved Queues feature (#119). Wraps /api/saved-queues.
 * `disabled` becomes true when the server returns 403 (savedQueuesEnabled off),
 * so the page can render a "feature disabled" state instead of an error.
 */
export function useSavedQueues() {
  const queues = ref<SavedQueueMeta[]>([]);
  const loading = ref(false);
  const disabled = ref(false);
  const error = ref<string | null>(null);

  async function list(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await axios.get('/api/saved-queues');
      queues.value = sortQueues((res.data?.queues ?? []) as SavedQueueMeta[]);
      disabled.value = false;
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 403) {
        disabled.value = true;
        queues.value = [];
      } else {
        error.value = '加载已保存队列失败';
      }
    } finally {
      loading.value = false;
    }
  }

  async function save(botId: string, name: string, shared: boolean): Promise<void> {
    await axios.post('/api/saved-queues', { botId, name, shared });
    await list();
  }

  async function load(id: number, botId: string, mode: 'replace' | 'append'): Promise<{ loaded: number; mode: string }> {
    const res = await axios.post(`/api/saved-queues/${id}/load`, { botId, mode });
    return res.data;
  }

  async function remove(id: number): Promise<void> {
    await axios.delete(`/api/saved-queues/${id}`);
    await list();
  }

  return { queues, loading, disabled, error, list, save, load, remove };
}
