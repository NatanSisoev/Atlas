<!-- Routes: "/" Cover, "/c/:id" Story, "/c/:id/i/:itemId" Viewer over the story, "/c/:id/play" Play. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Cover from './components/Cover.svelte';
  import Story from './components/Story.svelte';
  import Play from './components/Play.svelte';
  import SettingsSheet from './components/SettingsSheet.svelte';
  import { coverPath, hooks, navigate, parse, router, type Route } from './lib/router.svelte';
  import { loadAtlas, vt } from './lib/store.svelte';
  import { motion } from './lib/viewport.svelte';

  // Name the elements that morph during the next route change; clear them when it is done.
  hooks.willChange = (prev: Route, next: Route) => {
    vt.hero = null;
    vt.media = null;
    if (motion.reduced) return;
    if (prev.name === 'cover' && next.name === 'chapter') vt.hero = next.id;
    else if (prev.name === 'chapter' && next.name === 'cover') vt.hero = prev.id;
    if ((prev.name === 'chapter' || prev.name === 'viewer') && next.name === 'viewer') vt.media = next.itemId;
    else if (prev.name === 'viewer' && next.name === 'chapter') {
      vt.media = prev.itemId;
      revealTile(prev.itemId);
    }
  };
  hooks.didChange = () => {
    vt.hero = null;
    vt.media = null;
  };

  /** Before the viewer closes, scroll the story (hidden under it) so the photo's tile is in view. */
  function revealTile(itemId: string) {
    const el = document.querySelector<HTMLElement>(`[data-item="${CSS.escape(itemId)}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top >= 60 && r.bottom <= window.innerHeight) return;
    window.scrollTo(0, Math.max(0, window.scrollY + r.top - (window.innerHeight - r.height) / 2));
  }

  /** In-app links navigate without reloading; anything else (old board, media, new tab) is native. */
  function onLinkClick(e: MouseEvent) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.('a');
    if (!a || !a.href || a.target || a.hasAttribute('download') || a.dataset.native !== undefined) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || parse(url.pathname).name === 'notfound') return;
    e.preventDefault();
    if (url.pathname !== location.pathname) navigate(url.pathname);
  }

  onMount(() => {
    loadAtlas();
    const refresh = () => {
      if (document.visibilityState === 'visible') loadAtlas();
    };
    document.addEventListener('click', onLinkClick);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      document.removeEventListener('click', onLinkClick);
      document.removeEventListener('visibilitychange', refresh);
    };
  });

  const route = $derived(router.route);
  const storyId = $derived(route.name === 'chapter' || route.name === 'viewer' || route.name === 'play' ? route.id : null);
</script>

{#if route.name === 'cover'}
  <Cover />
{:else if storyId !== null}
  {#key storyId}
    <Story id={storyId} viewerItem={route.name === 'viewer' ? route.itemId : null} covered={route.name === 'play'} />
    {#if route.name === 'play'}
      <Play id={storyId} />
    {/if}
  {/key}
{:else}
  <main class="lost">
    <p class="t-plate">This page isn’t in the book.</p>
    <a class="text-btn" href={coverPath()}>Go to the cover</a>
  </main>
{/if}

<SettingsSheet />

<style>
  .lost {
    display: grid;
    justify-items: start;
    gap: 20px;
    width: min(calc(100% - 2 * var(--gutter)), var(--text-max));
    margin: 22vh auto 0;
  }
</style>
