<!-- Chapter story: a full-bleed cover that collapses into a slim bar, then page after page. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import PageSection from './PageSection.svelte';
  import Viewer from './Viewer.svelte';
  import { ApiError } from '../lib/api';
  import { chapterStats } from '../lib/format';
  import { plateText } from '../lib/plates';
  import { coverPath, itemPath, leaveTo, navigate, playPath, router } from '../lib/router.svelte';
  import { cachedChapter, chapterSummary, loadChapter, seedSrc, vt } from '../lib/store.svelte';
  import type { ChapterData, ChapterSummary } from '../lib/types';
  import { motion, viewport } from '../lib/viewport.svelte';
  import { enterFullscreen } from '../lib/fullscreen';

  let {
    id,
    viewerItem = null,
    covered = false,
  }: { id: string; viewerItem?: string | null; covered?: boolean } = $props();

  const initial = () => cachedChapter(id);
  let data = $state<ChapterData | null>(initial()?.data ?? null);
  let fromCache = $state(initial()?.fromCache ?? false);
  let error = $state<ApiError | null>(null);
  let loading = $state(false);

  const summary = $derived<ChapterSummary | null>(data?.chapter ?? chapterSummary(id));
  const cover = $derived(summary?.cover ?? null);
  const order = $derived(data ? data.pages.flatMap((p) => p.items) : []);

  function load() {
    loading = true;
    error = null;
    loadChapter(id)
      .then((res) => {
        data = res.data;
        fromCache = res.fromCache;
      })
      .catch((err: unknown) => {
        if (!data) error = err instanceof ApiError ? err : new ApiError(0, 'network');
      })
      .finally(() => (loading = false));
  }

  onMount(() => {
    load();
    // Coming back to the app (phone unlocked, laptop woke up): refresh quietly.
    const refresh = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  });

  $effect(() => {
    if (summary?.title) document.title = `${summary.title} · Atlas`;
  });

  // ---- layout metrics ----
  const gutter = $derived(viewport.desktop ? 40 : 16);
  const colWidth = $derived(Math.max(0, Math.min(viewport.w - 2 * gutter, 1040)));
  const target = $derived(viewport.desktop ? 260 : 180);
  const spacing = $derived(viewport.desktop ? 6 : 3);
  const maxSingle = $derived(Math.round(Math.min(viewport.h * 0.72, target * 2.4)));

  // Aspect ratios learned from loaded thumbnails when the server did not know them (or knew them wrong).
  let aspects = $state<Record<string, number>>({});
  function onaspect(itemId: string, aspect: number) {
    const it = data?.items[itemId];
    if (!it) return;
    const known = aspects[itemId] ?? (it.w && it.h ? it.w / it.h : null);
    if (known === null || Math.abs(known - aspect) / aspect > 0.03) aspects[itemId] = aspect;
  }

  // ---- collapsing header ----
  let heroEl = $state<HTMLElement | null>(null);
  let solid = $state(false);
  $effect(() => {
    const el = heroEl;
    if (!el) {
      solid = true;
      return;
    }
    const io = new IntersectionObserver(([entry]) => (solid = !entry.isIntersecting), {
      rootMargin: `-${44 + 8}px 0px 0px 0px`,
    });
    io.observe(el);
    return () => io.disconnect();
  });

  // ---- actions ----
  function open(itemId: string, el: HTMLElement) {
    const img = el.querySelector('img');
    if (img?.currentSrc) seedSrc.set(itemId, img.currentSrc);
    navigate(itemPath(id, itemId), { child: true, scroll: 'keep' });
  }

  function play() {
    enterFullscreen();
    navigate(playPath(id), { child: true, transition: false });
  }

  function back(e: MouseEvent) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    leaveTo(coverPath());
  }

  const heroName = $derived(vt.hero === id && router.route.name === 'chapter' && !motion.reduced ? 'hero' : null);
  const mediaName = $derived(router.route.name === 'chapter' && !motion.reduced ? vt.media : null);
  const hrefFor = (itemId: string) => itemPath(id, itemId);
</script>

<div class="story" inert={!!viewerItem || covered}>
  <nav class="bar" class:solid class:over-hero={!!cover} aria-label="Chapter">
    <a class="icon-btn" href={coverPath()} onclick={back} aria-label="All chapters"><Icon name="back" /></a>
    <p class="bar-title" aria-hidden="true">{summary?.title ?? ''}</p>
    {#if data && order.length > 0}
      <button class="play" onclick={play} aria-label="Play this chapter">
        <Icon name="play" size={14} stroke={0} filled />
        <span>Play</span>
      </button>
    {:else}
      <span class="bar-spacer"></span>
    {/if}
  </nav>

  {#if summary}
    <header class="hero" class:no-cover={!cover}>
      {#if cover}
        <div class="hero-media" bind:this={heroEl}>
          <img
            src={cover.urls.t1200}
            alt=""
            decoding="sync"
            fetchpriority="high"
            style:view-transition-name={heroName}
          />
        </div>
      {/if}
      <div class="hero-text">
        {#if summary.range}<p class="t-kicker">{summary.range}</p>{/if}
        <h1 class="t-title">{summary.title}</h1>
        <p class="t-meta stats">{chapterStats(summary)}</p>
        {#if fromCache}<p class="t-meta offline-note" role="status">Offline · showing the last saved copy</p>{/if}
      </div>
    </header>
  {:else if !error}
    <div class="hero-text placeholder" aria-hidden="true"><span></span><span></span></div>
  {/if}

  <main class="pages" aria-busy={loading && !data}>
    {#if data}
      {#each data.pages as page (page.id)}
        {@const words = plateText(data.chapter, page)}
        <PageSection
          {page}
          items={data.items}
          title={words.title}
          kicker={words.kicker}
          width={colWidth}
          {target}
          {spacing}
          {maxSingle}
          {aspects}
          vtMedia={mediaName}
          {hrefFor}
          onopen={open}
          {onaspect}
        />
      {/each}

      {#if order.length > 0}
        <footer class="end">
          <span class="rule" aria-hidden="true"></span>
          <p class="end-title">{data.chapter.title}</p>
          {#if data.chapter.range}<p class="t-meta">{data.chapter.range}</p>{/if}
          <div class="end-actions">
            <button class="text-btn solid" onclick={play}>
              <Icon name="play" size={14} stroke={0} filled /> Play this chapter
            </button>
            <a class="text-btn" href={coverPath()} onclick={back}>All chapters</a>
          </div>
        </footer>
      {:else}
        <p class="empty t-body">This chapter has no photos or videos yet.</p>
      {/if}
    {:else if error}
      <div class="problem">
        {#if error.status === 404}
          <h1 class="t-plate">This chapter isn’t here any more.</h1>
          <p class="t-meta">It may have been renamed or moved on the laptop.</p>
          <a class="text-btn" href={coverPath()}>All chapters</a>
        {:else}
          <h1 class="t-plate">Can’t reach Atlas right now.</h1>
          <p class="t-meta">Is the laptop awake and on the same network?</p>
          <button class="text-btn" onclick={load}><Icon name="retry" size={18} /> Try again</button>
        {/if}
      </div>
    {:else}
      <div class="skeleton" aria-hidden="true" style:width="{colWidth}px">
        <span class="sk-kicker"></span>
        <span class="sk-title"></span>
        <div class="sk-row"><span style:flex="1.5"></span><span style:flex="1"></span></div>
        <div class="sk-row"><span style:flex="1"></span><span style:flex="1.33"></span><span style:flex="0.75"></span></div>
      </div>
      <p class="sr-only" role="status">Loading the chapter…</p>
    {/if}
  </main>
</div>

{#if viewerItem && data}
  <Viewer chapterId={id} chapterTitle={data.chapter.title} {order} items={data.items} itemId={viewerItem} />
{/if}

<style>
  .story {
    min-height: 100svh;
    padding-bottom: calc(96px + var(--safe-bottom));
  }

  /* ---- bar ---- */
  .bar {
    position: fixed;
    z-index: 20;
    top: 0;
    left: 0;
    right: 0;
    display: grid;
    grid-template-columns: 44px 1fr auto;
    align-items: center;
    gap: 8px;
    height: calc(var(--bar-h) + var(--safe-top));
    padding: var(--safe-top) calc(var(--safe-right) + 8px) 0 calc(var(--safe-left) + 4px);
    color: var(--ink);
    background: transparent;
    transition:
      background-color var(--t-mid) var(--ease),
      color var(--t-mid) var(--ease),
      box-shadow var(--t-mid) var(--ease);
  }

  .bar.over-hero:not(.solid) {
    color: #fff;
  }

  .bar.solid {
    background: color-mix(in srgb, var(--paper) 92%, transparent);
    backdrop-filter: saturate(1.4) blur(14px);
    -webkit-backdrop-filter: saturate(1.4) blur(14px);
    box-shadow: 0 1px 0 var(--rule);
  }

  .bar.over-hero:not(.solid) :global(:focus-visible) {
    outline-color: #fff;
  }

  .bar-title {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-align: center;
    font-family: var(--font-human);
    font-weight: var(--title-weight);
    font-size: 17px;
    line-height: 22px;
    letter-spacing: var(--plate-tracking);
    opacity: 0;
    transform: translateY(4px);
    transition:
      opacity var(--t-mid) var(--ease),
      transform var(--t-mid) var(--ease);
  }

  :global(:root[data-type='sans']) .bar-title {
    font-size: 15px;
  }

  .bar.solid .bar-title {
    opacity: 1;
    transform: none;
  }

  .bar-spacer {
    width: 44px;
  }

  .play {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 34px;
    margin: 5px 0;
    padding: 0 14px 0 12px;
    border: 0;
    border-radius: 999px;
    font-size: 14px;
    font-weight: 600;
    line-height: 20px;
    cursor: pointer;
    color: var(--paper);
    background: var(--ink);
    transition: background-color var(--t-mid) var(--ease);
    position: relative;
  }

  /* 44px touch target around the 34px pill. */
  .play::after {
    content: '';
    position: absolute;
    inset: -5px -2px;
  }

  .bar.over-hero:not(.solid) .play {
    color: #111;
    background: rgba(255, 255, 255, 0.92);
  }

  .bar.over-hero:not(.solid) .icon-btn:hover {
    background: rgba(255, 255, 255, 0.16);
  }

  /* ---- hero ---- */
  .hero-media {
    position: relative;
    height: min(118vw, 70svh);
    background: var(--well);
    overflow: hidden;
  }

  .hero-media::after {
    content: '';
    position: absolute;
    inset: 0 0 auto 0;
    height: calc(var(--safe-top) + 120px);
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.38), rgba(0, 0, 0, 0));
    pointer-events: none;
  }

  .hero-media img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .hero-text {
    width: min(calc(100% - 2 * var(--gutter)), var(--col-max));
    margin: 28px auto 0;
    display: grid;
    gap: 10px;
  }

  .hero-text .t-title {
    max-width: 14em;
  }

  .hero.no-cover .hero-text {
    margin-top: calc(var(--bar-h) + var(--safe-top) + 40px);
  }

  .stats {
    margin-top: 2px;
  }

  .offline-note {
    margin-top: 6px;
  }

  /* ---- end ---- */
  .end {
    width: min(calc(100% - 2 * var(--gutter)), var(--col-max));
    margin: 120px auto 0;
    display: grid;
    justify-items: center;
    text-align: center;
    gap: 6px;
  }

  .rule {
    width: 40px;
    height: 1px;
    margin-bottom: 28px;
    background: var(--ink-2);
    opacity: 0.5;
  }

  .end-title {
    font-family: var(--font-human);
    font-weight: var(--title-weight);
    letter-spacing: var(--plate-tracking);
    font-size: 22px;
    line-height: 28px;
  }

  .end-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
    margin-top: 24px;
  }

  .empty {
    width: min(calc(100% - 2 * var(--gutter)), var(--text-max));
    margin: 64px auto 0;
    color: var(--ink-2);
  }

  .problem {
    width: min(calc(100% - 2 * var(--gutter)), var(--col-max));
    margin: calc(var(--bar-h) + var(--safe-top) + 18vh) auto 0;
    display: grid;
    justify-items: start;
    gap: 12px;
  }

  .hero + .pages .problem {
    margin-top: 64px;
  }

  .problem .t-meta {
    font-size: 15px;
    line-height: 22px;
  }

  .problem .text-btn {
    margin-top: 8px;
  }

  .hero-text.placeholder {
    margin-top: calc(var(--bar-h) + var(--safe-top) + 40px);
  }

  .placeholder span {
    display: block;
    height: 14px;
    width: 120px;
    background: var(--well);
  }

  .placeholder span + span {
    height: 40px;
    width: 60%;
  }

  /* ---- loading ---- */
  .skeleton {
    margin: 72px auto 0;
    display: grid;
    gap: 6px;
  }

  .skeleton span {
    display: block;
    background: var(--well);
    border-radius: 2px;
  }

  .sk-kicker {
    width: 90px;
    height: 12px;
    margin-bottom: 6px;
  }

  .sk-title {
    width: 160px;
    height: 26px;
    margin-bottom: 20px;
  }

  .sk-row {
    display: flex;
    gap: 3px;
    height: 160px;
    margin-bottom: 3px;
  }

  .skeleton,
  .sk-row span {
    animation: breathe 1.8s var(--ease) infinite alternate;
  }

  @keyframes breathe {
    from {
      opacity: 0.55;
    }
    to {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton,
    .sk-row span {
      animation: none;
    }
  }

  @media (min-width: 720px) {
    .bar {
      padding-left: calc(var(--safe-left) + 12px);
      padding-right: calc(var(--safe-right) + 16px);
    }
    .hero-media {
      height: min(72vh, 56vw);
    }
    .hero-text {
      margin-top: 48px;
      gap: 14px;
    }
    .end {
      margin-top: 160px;
    }
    .sk-row {
      height: 240px;
      gap: 6px;
    }
  }
</style>
