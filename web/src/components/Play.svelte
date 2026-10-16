<!-- Play: the chapter as a full-screen slideshow in story order. Title card, a card per page,
     photos for 5 s with a slow drift, videos to the end. Tap or Space pauses, arrows step, Esc exits. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import Icon from './Icon.svelte';
  import ProgressiveImg from './ProgressiveImg.svelte';
  import { ApiError } from '../lib/api';
  import { chapterStats } from '../lib/format';
  import { exitFullscreen, keepAwake } from '../lib/fullscreen';
  import { plateText } from '../lib/plates';
  import { chapterPath, leaveTo } from '../lib/router.svelte';
  import { cachedChapter, loadChapter } from '../lib/store.svelte';
  import type { ChapterData, Item } from '../lib/types';
  import { motion } from '../lib/viewport.svelte';

  let { id }: { id: string } = $props();

  type Slide =
    | { kind: 'title' }
    | { kind: 'plate'; kicker: string; title: string }
    | { kind: 'photo'; item: Item }
    | { kind: 'video'; item: Item }
    | { kind: 'end' };

  const TITLE_MS = 3500;
  const PLATE_MS = 2500;
  const PHOTO_MS = 5000;
  const FADE_MS = 900;

  const initial = () => cachedChapter(id)?.data ?? null;
  let data = $state<ChapterData | null>(initial());
  let error = $state<ApiError | null>(null);

  const slides = $derived.by<Slide[]>(() => {
    if (!data) return [];
    const out: Slide[] = [{ kind: 'title' }];
    for (const page of data.pages) {
      const words = plateText(data.chapter, page);
      out.push({ kind: 'plate', kicker: words.kicker, title: words.title });
      for (const itemId of page.items) {
        const item = data.items[itemId];
        if (item) out.push({ kind: item.kind === 'video' ? 'video' : 'photo', item });
      }
    }
    out.push({ kind: 'end' });
    return out;
  });

  let i = $state(0);
  let paused = $state(false);
  let chrome = $state(true);
  let videoFailed = $state(false);
  const slide = $derived(slides[i] ?? null);
  const photoCount = $derived(slides.filter((s) => s.kind === 'photo' || s.kind === 'video').length);
  const position = $derived(slides.slice(0, i + 1).filter((s) => s.kind === 'photo' || s.kind === 'video').length);

  // ---- timing (pausable) ----
  let timer: ReturnType<typeof setTimeout> | null = null;
  let remaining = 0;
  let startedAt = 0;

  function durationOf(s: Slide | null): number | null {
    if (!s) return null;
    if (s.kind === 'title') return TITLE_MS;
    if (s.kind === 'plate') return PLATE_MS;
    if (s.kind === 'photo') return PHOTO_MS;
    return null; // videos run to their end, the end card waits
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function arm(ms: number) {
    clearTimer();
    remaining = ms;
    startedAt = performance.now();
    if (!paused) timer = setTimeout(next, ms);
  }

  function next() {
    if (i < slides.length - 1) show(i + 1);
  }

  function prev() {
    if (i > 0) show(i - 1);
  }

  function show(n: number) {
    i = Math.max(0, Math.min(slides.length - 1, n));
    videoFailed = false;
    const d = durationOf(slides[i]);
    if (d) arm(d);
    else clearTimer();
    preload(i + 1);
  }

  function togglePause() {
    if (slide?.kind === 'end') return;
    paused = !paused;
    if (paused) {
      if (timer) {
        clearTimer();
        remaining = Math.max(0, remaining - (performance.now() - startedAt));
      }
      videoEl?.pause();
      chrome = true;
    } else {
      if (durationOf(slide)) {
        startedAt = performance.now();
        timer = setTimeout(next, Math.max(400, remaining));
      }
      videoEl?.play().catch(() => {});
      nudgeChrome();
    }
  }

  function preload(n: number) {
    const s = slides[n];
    if (s && s.kind === 'photo') {
      for (const src of [s.item.urls.t1200, s.item.urls.display]) {
        if (!src) continue;
        const img = new Image();
        img.decoding = 'async';
        img.src = src;
      }
    }
  }

  // ---- video ----
  let videoEl = $state<HTMLVideoElement | null>(null);
  $effect(() => {
    const v = videoEl;
    if (!v) return;
    if (!paused) {
      v.play().catch((err: unknown) => {
        // Autoplay with sound refused: try muted, the tap that started Play usually allows sound.
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          v.muted = true;
          v.play().catch(() => {});
        }
      });
    }
  });

  function onVideoError() {
    videoFailed = true;
    arm(3000);
  }

  // ---- chrome ----
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  function nudgeChrome() {
    chrome = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!paused && slide?.kind !== 'end') chrome = false;
    }, 2600);
  }

  let exiting = false;
  function exit() {
    if (exiting) return;
    exiting = true;
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    exitFullscreen();
    leaveTo(chapterPath(id));
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // A focused button handles its own Space/Enter.
    if ((e.key === ' ' || e.key === 'Enter') && (e.target as HTMLElement | null)?.closest?.('button, a')) return;
    if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      togglePause();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
      nudgeChrome();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prev();
      nudgeChrome();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      exit();
    }
  }

  function onStageClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('button, a, video')) return;
    togglePause();
  }

  let wasFullscreen = false;
  function onFullscreenChange() {
    if (document.fullscreenElement) wasFullscreen = true;
    else if (wasFullscreen) exit();
  }

  let rootEl: HTMLDivElement;

  onMount(() => {
    rootEl?.focus({ preventScroll: true });
    const html = document.documentElement;
    html.classList.add('locked');
    const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    const saved = metas.map((m) => m.content);
    metas.forEach((m) => (m.content = '#000000'));
    const release = keepAwake();
    document.addEventListener('fullscreenchange', onFullscreenChange);
    if (document.fullscreenElement) wasFullscreen = true;

    if (!data) {
      loadChapter(id)
        .then((res) => {
          data = res.data;
          show(0);
        })
        .catch((err: unknown) => (error = err instanceof ApiError ? err : new ApiError(0, 'network')));
    } else show(0);
    nudgeChrome();

    return () => {
      clearTimer();
      if (hideTimer) clearTimeout(hideTimer);
      release();
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      html.classList.remove('locked');
      metas.forEach((m, n) => (m.content = saved[n]));
    };
  });

  const origins = ['50% 50%', '30% 35%', '70% 60%', '40% 70%', '65% 30%'];
</script>

<svelte:window {onkeydown} />

<div
  class="player"
  bind:this={rootEl}
  tabindex="-1"
  class:chrome
  class:paused
  class:still={motion.reduced}
  role="region"
  aria-label="Playing {data?.chapter.title ?? 'chapter'}"
  aria-roledescription="slideshow"
  onpointermove={nudgeChrome}
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="stage" onclick={onStageClick}>
    {#if slide && data}
      {#key i}
        <div class="slide" transition:fade={{ duration: FADE_MS }}>
          {#if slide.kind === 'title'}
            <div class="card">
              {#if data.chapter.range}<p class="kicker">{data.chapter.range}</p>{/if}
              <h1 class="card-title big">{data.chapter.title}</h1>
              <p class="meta">{chapterStats(data.chapter)}</p>
            </div>
          {:else if slide.kind === 'plate'}
            <div class="card">
              {#if slide.kicker}<p class="kicker">{slide.kicker}</p>{/if}
              <h2 class="card-title">{slide.title}</h2>
            </div>
          {:else if slide.kind === 'photo'}
            <div class="photo" style:transform-origin={origins[i % origins.length]} style:--hold="{PHOTO_MS + FADE_MS}ms">
              <ProgressiveImg srcs={[slide.item.urls.t1200, slide.item.urls.display]} alt={slide.item.caption} />
            </div>
            {#if slide.item.caption}<p class="caption">{slide.item.caption}</p>{/if}
          {:else if slide.kind === 'video'}
            {#if videoFailed}
              <div class="photo still-frame">
                <ProgressiveImg srcs={[slide.item.urls.t1200]} alt={slide.item.caption} />
              </div>
              <p class="caption">This video can’t play in this browser.</p>
            {:else}
              <!-- svelte-ignore a11y_media_has_caption (home videos have no caption tracks) -->
              <video
                bind:this={videoEl}
                src={slide.item.urls.display}
                poster={slide.item.urls.t1200}
                playsinline
                preload="auto"
                onended={next}
                onerror={onVideoError}
              ></video>
              {#if slide.item.caption}<p class="caption">{slide.item.caption}</p>{/if}
            {/if}
          {:else}
            <div class="card">
              <p class="kicker">The end</p>
              <h2 class="card-title">{data.chapter.title}</h2>
              <div class="end-actions">
                <button class="text-btn solid" onclick={() => show(0)}><Icon name="replay" size={18} /> Play again</button>
                <button class="text-btn" onclick={exit}>Back to the chapter</button>
              </div>
            </div>
          {/if}
        </div>
      {/key}
    {:else if error}
      <div class="card">
        <p class="card-title small">{error.status === 404 ? 'This chapter isn’t here any more.' : 'Can’t reach Atlas right now.'}</p>
        <div class="end-actions"><button class="text-btn" onclick={exit}>Close</button></div>
      </div>
    {/if}
  </div>

  <div class="top">
    <button class="icon-btn" onclick={exit} aria-label="Stop playing"><Icon name="close" /></button>
    {#if photoCount && (slide?.kind === 'photo' || slide?.kind === 'video')}<p class="count">{position} / {photoCount}</p>{/if}
  </div>
  <div class="controls">
    <button class="icon-btn" onclick={() => (prev(), nudgeChrome())} aria-label="Previous" disabled={i === 0}>
      <Icon name="prev" size={26} />
    </button>
    <button class="icon-btn big" onclick={togglePause} aria-label={paused ? 'Resume' : 'Pause'}>
      <Icon name={paused ? 'play' : 'pause'} size={22} stroke={0} filled />
    </button>
    <button class="icon-btn" onclick={() => (next(), nudgeChrome())} aria-label="Next" disabled={i >= slides.length - 1}>
      <Icon name="next" size={26} />
    </button>
  </div>
  <p class="sr-only" aria-live="polite">{paused ? 'Paused' : ''}</p>
</div>

<style>
  .player {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: #000;
    color: #f2f1ed;
    cursor: none;
    touch-action: manipulation;
  }

  .player:focus {
    outline: none;
  }

  .player.chrome {
    cursor: default;
  }

  .player :global(:focus-visible) {
    outline-color: #fff;
  }

  .stage {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }

  .slide {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    place-items: center;
  }

  .photo {
    position: absolute;
    inset: 0;
    animation: drift var(--hold, 5900ms) linear forwards;
  }

  .paused .photo,
  .paused .slide {
    animation-play-state: paused;
  }

  .still .photo {
    animation: none;
  }

  @keyframes drift {
    from {
      transform: scale(1);
    }
    to {
      transform: scale(1.06);
    }
  }

  .photo :global(img) {
    object-fit: contain;
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .caption {
    position: absolute;
    left: 50%;
    bottom: calc(var(--safe-bottom) + 28px);
    transform: translateX(-50%);
    width: min(100% - 48px, 34em);
    text-align: center;
    font-family: var(--font-human);
    font-size: 20px;
    line-height: 28px;
    color: rgba(242, 241, 237, 0.92);
    text-shadow: 0 1px 12px rgba(0, 0, 0, 0.6);
  }

  .card {
    display: grid;
    justify-items: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
    max-width: 22em;
  }

  .kicker {
    font-size: 13px;
    line-height: 18px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
    color: rgba(242, 241, 237, 0.6);
  }

  .card-title {
    font-family: var(--font-human);
    font-weight: var(--title-weight);
    letter-spacing: var(--title-tracking);
    font-size: 40px;
    line-height: 44px;
    text-wrap: balance;
  }

  .card-title.small {
    font-size: 24px;
    line-height: 30px;
  }

  .meta {
    font-size: 14px;
    line-height: 20px;
    font-variant-numeric: tabular-nums;
    color: rgba(242, 241, 237, 0.6);
  }

  .end-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
    margin-top: 20px;
  }

  .player .text-btn {
    border-color: rgba(242, 241, 237, 0.24);
    color: #f2f1ed;
  }

  .player .text-btn.solid {
    background: #f2f1ed;
    color: #111;
    border-color: transparent;
  }

  .top {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: calc(var(--safe-top) + 6px) calc(var(--safe-right) + 16px) 28px calc(var(--safe-left) + 6px);
    /* Readable over a bright sky. */
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.42), rgba(0, 0, 0, 0));
    transition: opacity var(--t-slow) var(--ease);
  }

  .count {
    font-size: 13px;
    line-height: 18px;
    font-variant-numeric: tabular-nums;
    color: rgba(242, 241, 237, 0.7);
  }

  .controls {
    position: absolute;
    left: 50%;
    bottom: calc(var(--safe-bottom) + 84px);
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px;
    border-radius: 999px;
    background: rgba(24, 24, 23, 0.72);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    transition: opacity var(--t-slow) var(--ease);
  }

  .controls .icon-btn:hover,
  .top .icon-btn:hover {
    background: rgba(242, 241, 237, 0.12);
  }

  .controls .icon-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .controls .big {
    width: 52px;
    height: 52px;
    background: rgba(242, 241, 237, 0.12);
  }

  .player:not(.chrome) .top,
  .player:not(.chrome) .controls {
    opacity: 0;
    pointer-events: none;
  }

  @media (min-width: 720px) {
    .card-title {
      font-size: 64px;
      line-height: 68px;
    }
    .card-title.big {
      font-size: 80px;
      line-height: 84px;
    }
    .caption {
      font-size: 22px;
      line-height: 30px;
    }
  }
</style>
