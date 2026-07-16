import { createRouter, createWebHistory } from 'vue-router';
import { useSession } from '../composables/useSession.js';
import { usePlayerStore } from '../stores/player.js';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('../views/Home.vue') },
    { path: '/search', name: 'search', component: () => import('../views/Search.vue') },
    { path: '/library', name: 'library', component: () => import('../views/Library.vue') },
    {
      path: '/playlist/:id',
      name: 'playlist',
      component: () => import('../views/Playlist.vue'),
      meta: { kind: 'playlist' },
    },
    {
      path: '/album/:id',
      name: 'album',
      component: () => import('../views/Playlist.vue'),
      meta: { kind: 'album' },
    },
    { path: '/lyrics', name: 'lyrics', component: () => import('../views/Lyrics.vue') },
    { path: '/history', name: 'history', component: () => import('../views/History.vue') },
    { path: '/saved-queues', name: 'saved-queues', component: () => import('../views/SavedQueues.vue') },
    { path: '/settings', name: 'settings', component: () => import('../views/Settings.vue') },
    { path: '/setup', name: 'setup', component: () => import('../views/Setup.vue') },
    { path: '/bot/:id', name: 'bot', component: () => import('../views/BotRedirect.vue') },

    // Auth views
    { path: '/login', name: 'login', component: () => import('../views/Login.vue'), meta: { public: true } },
    { path: '/first-run', name: 'first-run', component: () => import('../views/FirstRunSetup.vue'), meta: { public: true } },
  ],
});

const PUBLIC_NAMES = new Set(['login', 'first-run']);

router.beforeEach(async (to) => {
  const session = useSession();
  if (!session.ready.value) {
    await session.refresh();
  }

  if (session.needsSetup.value && to.name !== 'first-run') {
    return { name: 'first-run' };
  }
  if (!session.needsSetup.value && to.name === 'first-run') {
    return { name: 'home' };
  }

  if (PUBLIC_NAMES.has(to.name as string)) {
    if (to.name === 'login' && session.isAuthenticated.value) {
      return { name: 'home' };
    }
    return true;
  }

  if (!session.isAuthenticated.value) {
    return { name: 'login', query: { next: to.fullPath } };
  }

  // Guests may never reach settings/setup, even by typing the URL.
  const GUEST_BLOCKED = new Set(['settings', 'setup']);
  if (session.isGuest.value && GUEST_BLOCKED.has(to.name as string)) {
    return { name: 'home' };
  }

  // Navigation is allowed to proceed to `to` past here (auth/setup redirects above take precedence).
  // Sync + preserve the dedicated-link scope carried by ?bot.
  const store = usePlayerStore();
  const qBot = typeof to.query.bot === 'string' && to.query.bot ? to.query.bot : null;
  if (qBot) {
    // URL carries a scope — set tentatively; App.vue's applyScopeFromQuery (after fetchBots) validates/clears it.
    store.scopedBotId = qBot;
    return true;
  }
  if (store.scopedBotId) {
    // scoped, but this navigation dropped ?bot → re-attach so the lock survives in-app nav + refresh.
    if (to.query.bot !== store.scopedBotId) {
      return { path: to.path, query: { ...to.query, bot: store.scopedBotId }, hash: to.hash };
    }
  }
  return true;
});

export default router;
