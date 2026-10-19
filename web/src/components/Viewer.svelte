<!-- Immersive viewer over the chapter: swipe or arrow keys to step, swipe down or Esc to close,
     tap to toggle chrome, "i" or swipe up for details. -->
<script lang="ts">
  import { flushSync, onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import ProgressiveImg from './ProgressiveImg.svelte';
  import type { Item } from '../lib/types';
  import { fmtDuration, fmtTaken } from '../lib/format';
  import { chapterPath, itemPath, leaveTo, navigate, parse } from '../lib/router.svelte';
  import { seedSrc, vt } from '../lib/store.svelte';
  import { motion } from '../lib/viewport.svelte';

  let {
    chapterId,
    chapterTitle,
    order,
    items,
    itemId,
    aspects = {},
  }: {
    chapterId: string;
    chapterTitle: string;
    order: string[];
    items: Record<string, Item>;
    itemId: string;
    /** Aspect ratios the story learned from loaded thumbnails (when the server's were missing or wrong). */
    aspects?: Record<string, number>;
  } = $props();

  const GAP = 24;

  const index = $derived(order.indexOf(itemId));
  const current = $derived(items[itemId] ?? null);
  const prevId = $derived(index > 0 ? order[index - 1] : null);
  const nextId = $derived(index >= 0 && index < order.length - 1 ? order[index + 1] : null);
  const slides = $derived(
    [
      prevId ? { id: prevId, k: -1 } : null,
      current ? { id: itemId, k: 0 } : null,
      nextId ? { id: nextId, k: 1 } : null,
    ].filter((s): s is { id: string; k: number } => !!s),
  );

  let root: HTMLDivElement;
  let stageW = $state(0);
  let chrome = $state(true);
  let info = $state(false);
  let dx = $state(0);
  let dy = $state(0);
  let animating = $state(false);
  let videoFailed = $state<Record<string, boolean>>({});
  /** Slides whose t1200 failed (offline, never fetched): they show the tile's t400 instead. */
  let thin = $state<Record<string, boolean>>({});
  /** The details sheet follows a downward drag by this much. */
  let sheetDy = $state(0);
  let sheetSettling = $state(false);
  /** Set once the viewer is closing: pending step animations must not navigate any more. */
  let closed = false;

  /** The photo's shape, so the media box is exactly the photo (no letterbox in the morph). */
  const aspectOf = (id: string): number | null => {
    const a = aspects[id];
    if (a && Number.isFinite(a)) return a;
    const it = items[id];
    return it?.w && it?.h ? it.w / it.h : null;
  };

  const isVideo = (id: string) => items[id]?.kind === 'video';
  const original4k = $derived(!!current && current.kind === 'video' && Math.max(current.w ?? 0, current.h ?? 0) >= 3200);
  const dims = $derived(current && current.w && current.h ? `${current.w} × ${current.h}` : '');
  const taken = $derived(current ? fmtTaken(current.takenLocal) : '');

  // ---- open / close ----

  /**
   * The viewer is closing: stop a running step at once, so the morph back to the tile starts from
   * the still photo (a View Transition started over a running transform transition can also hold
   * the next frames back in Chromium), and no pending step may navigate any more.
   */
  function halt() {
    closed = true;
    animating = false;
    dx = 0;
    dy = 0;
    flushSync();
  }

  function close() {
    if (closed) return;
    halt();
    leaveTo(chapterPath(chapterId));
  }

  // An item id that is not in this chapter: fall back to the chapter.
  $effect(() => {
    if (index < 0) navigate(chapterPath(chapterId), { replace: true, scroll: 'keep', transition: false });
  });

  onMount(() => {
    const html = document.documentElement;
    html.classList.add('locked');
    const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    const saved = metas.map((m) => m.content);
    metas.forEach((m) => (m.content = '#000000'));
    const returnFocus = document.activeElement as HTMLElement | null;
    // Browser or Android Back: in the capture phase, so before the router starts its transition.
    const onpop = () => {
      const r = parse(location.pathname);
      if (r.name !== 'viewer' || r.id !== chapterId) halt();
    };
    window.addEventListener('popstate', onpop, true);
    // The dialog itself takes focus (not the close button: no stray focus ring on a deep link).
    root?.focus({ preventScroll: true });
    return () => {
      closed = true;
      window.removeEventListener('popstate', onpop, true);
      html.classList.remove('locked');
      metas.forEach((m, i) => (m.content = saved[i]));
      const last = itemId;
      // After the story underneath is interactive again (no longer inert).
      requestAnimationFrame(() => {
        const tile = document.querySelector<HTMLElement>(`[data-item="${CSS.escape(last)}"]`);
        (tile ?? returnFocus)?.focus({ preventScroll: true });
      });
    };
  });

  // Warm the next ones beyond the neighbours.
  $effect(() => {
    for (const k of [2, -2]) {
      const id = order[index + k];
      const it = id ? items[id] : null;
      if (it?.urls.t1200) {
        const img = new Image();
        img.decoding = 'async';
        img.src = it.urls.t1200;
      }
    }
  });

  // ---- stepping ----

  /**
   * Step to `id` by replacing this entry. Only while this viewer is still what the address bar
   * shows: on Back (or Esc/Close) during a step animation, location changes at once, while the
   * route and this component follow a moment later.
   */
  function go(id: string) {
    const r = parse(location.pathname);
    if (closed || r.name !== 'viewer' || r.id !== chapterId || r.itemId !== itemId) return;
    navigate(itemPath(chapterId, id), { replace: true, scroll: 'keep', transition: false });
  }

  async function step(dir: 1 | -1) {
    const target = dir > 0 ? nextId : prevId;
    if (animating) return;
    if (!target) {
      // A small bounce at the ends.
      animating = true;
      dx = -dir * 36;
      await wait(140);
      if (closed) return;
      dx = 0;
      await wait(240);
      animating = false;
      return;
    }
    if (motion.reduced || !stageW) {
      go(target);
      return;
    }
    animating = true;
    dx = -dir * (stageW + GAP);
    await wait(260);
    if (closed) return;
    animating = false;
    dx = 0;
    go(target);
  }

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ---- pointer gestures ----

  let start: { x: number; y: number; t: number; id: number; axis: '' | 'x' | 'y' } | null = null;

  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0 || animating || start) return;
    const el = e.target as HTMLElement;
    if (el.closest('button, a')) return;
    // Leave the native video controls alone.
    if (el instanceof HTMLVideoElement) {
      const r = el.getBoundingClientRect();
      if (e.clientY > r.bottom - 72) return;
    }
    start = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, axis: '' };
  }

  function onpointermove(e: PointerEvent) {
    if (!start || e.pointerId !== start.id) return;
    const mx = e.clientX - start.x;
    const my = e.clientY - start.y;
    if (!start.axis) {
      if (Math.hypot(mx, my) < 10) return;
      start.axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    if (start.axis === 'x') {
      const edge = (mx > 0 && !prevId) || (mx < 0 && !nextId);
      dx = edge ? mx * 0.3 : mx;
    } else if (info) {
      // With the details open, a drag down moves the sheet, not the photo.
      sheetDy = Math.max(0, my);
    } else {
      dy = my > 0 ? my : my * 0.3;
    }
  }

  function onpointerup(e: PointerEvent) {
    if (!start || e.pointerId !== start.id) return;
    const s = start;
    start = null;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    const ms = Math.max(1, performance.now() - s.t);
    if (!s.axis) {
      // A tap closes the details first (as Esc does), else toggles the chrome (not on a video,
      // which has its own controls).
      if (ms < 500 && info) info = false;
      else if (ms < 500 && !(e.target instanceof HTMLVideoElement)) chrome = !chrome;
      return;
    }
    if (s.axis === 'x') {
      const fast = Math.abs(mx) / ms > 0.45 && Math.abs(mx) > 30;
      if ((Math.abs(mx) > stageW * 0.2 || fast) && (mx < 0 ? nextId : prevId)) {
        finishStep(mx < 0 ? 1 : -1);
      } else snapBack();
    } else if (info) {
      // With the details open, a swipe down only dismisses them; a swipe up does nothing.
      const fast = my / ms > 0.5 && my > 0;
      if (my > 40 || fast) hideSheet();
      else settleSheet();
    } else {
      const fast = Math.abs(my) / ms > 0.5;
      if (my > 110 || (fast && my > 40)) {
        dy = 0;
        close();
      } else if (my < -60 || (fast && my < -30)) {
        info = true;
        snapBack();
      } else snapBack();
    }
  }

  async function finishStep(dir: 1 | -1) {
    const target = dir > 0 ? nextId : prevId;
    if (!target) return snapBack();
    animating = true;
    dx = -dir * (stageW + GAP);
    await wait(240);
    if (closed) return;
    animating = false;
    dx = 0;
    go(target);
  }

  async function snapBack() {
    animating = true;
    dx = 0;
    dy = 0;
    await wait(240);
    animating = false;
  }

  function onpointercancel() {
    start = null;
    snapBack();
    settleSheet();
  }

  // ---- the details sheet: its top edge (the grip) can be dragged down ----

  function hideSheet() {
    info = false;
    sheetDy = 0;
  }

  async function settleSheet() {
    if (!sheetDy) return;
    sheetSettling = true;
    sheetDy = 0;
    await wait(240);
    sheetSettling = false;
  }

  let grab: { y: number; t: number; id: number } | null = null;

  function ongripdown(e: PointerEvent) {
    if (e.button !== 0 || grab) return;
    grab = { y: e.clientY, t: performance.now(), id: e.pointerId };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function ongripmove(e: PointerEvent) {
    if (!grab || e.pointerId !== grab.id) return;
    sheetDy = Math.max(0, e.clientY - grab.y);
  }

  function ongripup(e: PointerEvent) {
    if (!grab || e.pointerId !== grab.id) return;
    const my = e.clientY - grab.y;
    const ms = Math.max(1, performance.now() - grab.t);
    grab = null;
    if (my > 60 || (my > 20 && my / ms > 0.5)) hideSheet();
    else settleSheet();
  }

  function ongripcancel() {
    grab = null;
    settleSheet();
  }

  // ---- keyboard ----

  function onkeydown(e: KeyboardEvent) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const inVideo = e.target instanceof HTMLVideoElement;
    if (e.key === 'ArrowRight' && !inVideo) {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowLeft' && !inVideo) {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (info) info = false;
      else close();
    } else if (e.key === 'i' || e.key === 'I') {
      info = !info;
    } else if (e.key === 'Tab') {
      trapFocus(e);
    }
  }

  function trapFocus(e: KeyboardEvent) {
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], video[controls], [tabindex]:not([tabindex="-1"])'),
    ).filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (document.activeElement === root || !root.contains(document.activeElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Play the current video when it becomes current (the tap that opened us is a user gesture).
  let videoEl = $state<HTMLVideoElement | null>(null);
  $effect(() => {
    const v = videoEl;
    if (!v) return;
    v.play().catch(() => {
      /* autoplay refused or unplayable: the controls stay */
    });
    return () => v.pause();
  });

  $effect(() => {
    if (info) tick().then(() => root?.querySelector<HTMLElement>('.sheet [data-autofocus]')?.focus({ preventScroll: true }));
    // The sheet closed with focus inside it: keep focus in the viewer.
    else if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  });

  const fade = $derived(dy > 0 ? Math.max(0.35, 1 - dy / 500) : 1);
</script>

<svelte:window {onkeydown} />

<div
  class="viewer"
  class:chrome
  bind:this={root}
  tabindex="-1"
  role="dialog"
  aria-modal="true"
  aria-label="{chapterTitle}: {current?.kind === 'video' ? 'video' : 'photo'} {index + 1} of {order.length}"
  style:--fade={fade}
>
  <div class="backdrop" aria-hidden="true"></div>

  <div
    class="stage"
    bind:clientWidth={stageW}
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    {onpointercancel}
    role="presentation"
  >
    <div class="track" class:animating style:transform="translate3d({dx}px, {Math.max(0, dy)}px, 0) scale({dy > 0 ? 1 - Math.min(dy, 400) / 2000 : 1})">
      {#each slides as s (s.id)}
        {@const it = items[s.id]}
        {@const ar = aspectOf(s.id)}
        <div
          class="slide"
          class:sized={!!ar}
          style:--ar={ar}
          style:transform="translateX({s.k * (stageW + GAP)}px)"
          aria-hidden={s.k !== 0}
        >
          {#if it.kind === 'video' && s.k === 0 && !videoFailed[s.id]}
            <!-- svelte-ignore a11y_media_has_caption (home videos have no caption tracks) -->
            <video
              bind:this={videoEl}
              src={it.urls.display}
              poster={it.urls.t1200}
              controls
              playsinline
              preload="metadata"
              style:view-transition-name={vt.media === s.id && !motion.reduced ? 'media' : null}
              onerror={() => (videoFailed = { ...videoFailed, [s.id]: true })}
            ></video>
          {:else}
            <ProgressiveImg
              srcs={thin[s.id]
                ? [it.urls.t400]
                : s.k === 0
                  ? [seedSrc.get(s.id) ?? '', it.urls.t1200, it.kind === 'photo' ? it.urls.display : '']
                  : [it.urls.t1200]}
              alt={s.k === 0 ? it.caption : ''}
              vtName={s.k === 0 && vt.media === s.id && !motion.reduced ? 'media' : null}
              onfail={() => {
                if (!thin[s.id] && it.urls.t400) thin = { ...thin, [s.id]: true };
              }}
            />
            {#if it.kind === 'video' && s.k === 0}
              <div class="cant-play" role="status">
                <p class="cant-title">This video can’t play in this browser.</p>
                <p class="cant-text">It may be 4K or HEVC. The original opens in your device’s player.</p>
                <div class="cant-actions">
                  <a class="text-btn solid" href={it.urls.original} target="_blank" rel="noopener">Open original</a>
                  <a class="text-btn" href={it.urls.download} download>Download</a>
                </div>
              </div>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <div class="top" aria-hidden={!chrome}>
    <button class="icon-btn" onclick={close} aria-label="Close" tabindex={chrome ? 0 : -1}>
      <Icon name="close" />
    </button>
    <p class="count" aria-live="polite">{index + 1} / {order.length}</p>
    <button
      class="icon-btn"
      onclick={() => (info = !info)}
      aria-label="Details"
      aria-expanded={info}
      tabindex={chrome ? 0 : -1}
    >
      <Icon name="info" />
    </button>
  </div>

  {#if prevId}
    <button class="side prev icon-btn" onclick={() => step(-1)} aria-label="Previous" tabindex={chrome ? 0 : -1}>
      <Icon name="prev" size={26} />
    </button>
  {/if}
  {#if nextId}
    <button class="side next icon-btn" onclick={() => step(1)} aria-label="Next" tabindex={chrome ? 0 : -1}>
      <Icon name="next" size={26} />
    </button>
  {/if}

  {#if current && (current.caption || taken) && !info && !(isVideo(itemId) && !videoFailed[itemId])}
    <div class="bottom" aria-hidden={!chrome}>
      {#if current.caption}<p class="caption">{current.caption}</p>{/if}
      {#if taken}<p class="when">{taken}</p>{/if}
    </div>
  {/if}

  {#if info && current}
    <div
      class="sheet"
      class:settling={sheetSettling}
      role="region"
      aria-label="Details"
      style:transform={sheetDy ? `translate(-50%, ${sheetDy}px)` : null}
    >
      <div
        class="grip"
        aria-hidden="true"
        onpointerdown={ongripdown}
        onpointermove={ongripmove}
        onpointerup={ongripup}
        onpointercancel={ongripcancel}
      ></div>
      {#if current.caption}<p class="sheet-caption">{current.caption}</p>{/if}
      <dl>
        {#if taken}
          <div><dt>Taken</dt><dd>{taken}</dd></div>
        {/if}
        <div><dt>File</dt><dd class="file">{current.name}</dd></div>
        {#if dims}
          <div><dt>Size</dt><dd>{dims}</dd></div>
        {/if}
        {#if current.kind === 'video' && current.durationSec}
          <div><dt>Length</dt><dd>{fmtDuration(current.durationSec)}</dd></div>
        {/if}
      </dl>
      <div class="sheet-actions">
        <a class="text-btn solid" href={current.urls.original} target="_blank" rel="noopener" data-autofocus>
          <Icon name="external" size={18} />
          {current.kind === 'video' && original4k ? 'Open original (4K)' : 'Open original'}
        </a>
        <a class="text-btn" href={current.urls.download} download>
          <Icon name="download" size={18} />
          Download
        </a>
      </div>
      <button class="sheet-close icon-btn" onclick={() => (info = false)} aria-label="Hide details">
        <Icon name="close" size={20} />
      </button>
    </div>
  {/if}
</div>

<style>
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 50;
    color: #f2f1ed;
    overscroll-behavior: contain;
    touch-action: none;
    --focus: #fff;
  }

  .viewer:focus {
    outline: none;
  }

  .viewer :global(:focus-visible) {
    outline-color: #fff;
  }

  .backdrop {
    position: absolute;
    inset: 0;
    background: #000;
    opacity: var(--fade, 1);
  }

  .stage {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }

  .track {
    position: absolute;
    inset: 0;
    will-change: transform;
  }

  .track.animating {
    transition: transform var(--t-mid) var(--ease);
  }

  .slide {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    place-items: center;
    padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
    /* The padded area is the box the photo fits in (cqw/cqh below). */
    container-type: size;
  }

  /* Wide screens with a mouse: the photo sits between the top bar and the caption, never under them. */
  @media (min-width: 900px) and (hover: hover) and (pointer: fine) {
    .slide {
      padding: 56px 76px 84px;
    }

    .viewer .top,
    .viewer .bottom {
      background: none;
    }

    /* The caption belongs to the centred photo, as in Play. */
    .viewer .bottom {
      text-align: center;
    }

    .viewer .caption {
      margin-inline: auto;
    }
  }

  .slide > :global(img),
  .slide > video {
    grid-area: 1 / 1;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  /* With the shape known, the media box is the fitted photo itself, not the whole stage: the
     thumbnail morphs into exactly the photo (no letterbox around it during the transition). */
  .slide.sized > :global(img),
  .slide.sized > video {
    width: min(100cqw, calc(100cqh * var(--ar)));
    height: auto;
    aspect-ratio: var(--ar);
  }

  video {
    background: #000;
  }

  /* A video that cannot play here: its poster steps back behind the message. */
  .slide:has(.cant-play) > :global(img) {
    opacity: 0.4;
  }

  .cant-play {
    grid-area: 1 / 1;
    position: relative; /* above the dimmed poster (opacity makes it a layer of its own) */
    z-index: 1;
    align-self: center;
    width: min(100% - 32px, 440px);
    padding: 20px;
    border-radius: 16px;
    background: rgba(20, 20, 19, 0.88);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    text-align: left;
  }

  .cant-title {
    font-family: var(--font-human);
    font-size: 19px;
    line-height: 26px;
  }

  .cant-text {
    margin-top: 4px;
    font-size: 14px;
    line-height: 20px;
    color: rgba(242, 241, 237, 0.7);
  }

  .cant-actions,
  .sheet-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }

  .viewer .text-btn {
    border-color: rgba(242, 241, 237, 0.24);
    color: #f2f1ed;
  }

  .viewer .text-btn:hover {
    background: rgba(242, 241, 237, 0.1);
  }

  .viewer .text-btn.solid {
    background: #f2f1ed;
    border-color: transparent;
    color: #111;
  }

  .top {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: calc(var(--safe-top) + 6px) calc(var(--safe-right) + 6px) 24px calc(var(--safe-left) + 6px);
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0));
    transition: opacity var(--t-mid) var(--ease);
  }

  .count {
    font-size: 13px;
    line-height: 18px;
    font-variant-numeric: tabular-nums;
    color: rgba(242, 241, 237, 0.78);
  }

  .icon-btn:hover {
    background: rgba(242, 241, 237, 0.12);
  }

  .side {
    position: absolute;
    top: 50%;
    margin-top: -22px;
    display: none;
    background: rgba(0, 0, 0, 0.28);
    transition:
      opacity var(--t-mid) var(--ease),
      background-color var(--t-fast) var(--ease);
  }

  .side.prev {
    left: calc(var(--safe-left) + 16px);
  }

  .side.next {
    right: calc(var(--safe-right) + 16px);
  }

  @media (hover: hover) and (pointer: fine) {
    .side {
      display: inline-grid;
    }
  }

  .bottom {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 40px calc(var(--safe-right) + 20px) calc(var(--safe-bottom) + 20px) calc(var(--safe-left) + 20px);
    background: linear-gradient(to top, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0));
    pointer-events: none;
    transition: opacity var(--t-mid) var(--ease);
  }

  .caption {
    max-width: 34em;
    font-family: var(--font-human);
    font-size: 18px;
    line-height: 26px;
    color: #f2f1ed;
  }

  .when {
    margin-top: 2px;
    font-size: 13px;
    line-height: 18px;
    font-variant-numeric: tabular-nums;
    color: rgba(242, 241, 237, 0.7);
  }

  .viewer:not(.chrome) .top,
  .viewer:not(.chrome) .bottom,
  .viewer:not(.chrome) .side {
    opacity: 0;
    pointer-events: none;
  }

  .sheet {
    position: absolute;
    left: 50%;
    bottom: 0;
    width: min(100%, 560px);
    transform: translateX(-50%);
    padding: 0 calc(var(--safe-right) + 20px) calc(var(--safe-bottom) + 24px) calc(var(--safe-left) + 20px);
    border-radius: 18px 18px 0 0;
    background: rgba(24, 24, 23, 0.94);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.4);
    animation: sheet-in var(--t-slow) var(--ease);
    touch-action: auto;
  }

  .sheet.settling {
    transition: transform var(--t-mid) var(--ease);
  }

  @keyframes sheet-in {
    from {
      transform: translate(-50%, 24px);
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet {
      animation: none;
    }
  }

  /* The grip is the sheet's whole top edge: drag it down to hide the details. */
  .grip {
    display: grid;
    place-items: center;
    height: 28px;
    margin: 0 calc(-1 * (var(--safe-right) + 20px)) 4px calc(-1 * (var(--safe-left) + 20px));
    cursor: grab;
    touch-action: none;
  }

  .grip::before {
    content: '';
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: rgba(242, 241, 237, 0.25);
  }

  .sheet-caption {
    padding-right: 40px;
    font-family: var(--font-human);
    font-size: 22px;
    line-height: 30px;
    margin-bottom: 12px;
  }

  dl {
    display: grid;
    gap: 6px;
    margin: 0;
    font-size: 14px;
    line-height: 20px;
    font-variant-numeric: tabular-nums;
  }

  dl > div {
    display: grid;
    grid-template-columns: 64px 1fr;
    gap: 12px;
  }

  dt {
    color: rgba(242, 241, 237, 0.55);
  }

  dd {
    margin: 0;
    color: rgba(242, 241, 237, 0.92);
  }

  .file {
    overflow-wrap: anywhere;
  }

  .sheet-close {
    position: absolute;
    top: 10px;
    right: calc(var(--safe-right) + 10px);
  }
</style>
