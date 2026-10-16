<!-- One photo or video in a justified row: never cropped, caption beneath, tap opens the viewer. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import type { Item } from '../lib/types';
  import { fmtDuration } from '../lib/format';
  import { formatTime } from '../lib/model';

  let {
    item,
    width,
    height,
    href,
    vtName = null,
    onopen,
    onaspect,
  }: {
    item: Item;
    width: number;
    height: number;
    href: string;
    vtName?: string | null;
    onopen: (id: string, el: HTMLElement) => void;
    onaspect?: (id: string, aspect: number) => void;
  } = $props();

  let loaded = $state(false);
  let failed = $state(false);

  const video = $derived(item.kind === 'video');
  const duration = $derived(video ? fmtDuration(item.durationSec) : '');
  const srcset = $derived(
    [item.urls.t400 && `${item.urls.t400} 400w`, item.urls.t1200 && `${item.urls.t1200} 1200w`].filter(Boolean).join(', '),
  );
  const label = $derived.by(() => {
    const parts = [item.caption || (video ? 'Video' : 'Photo')];
    if (item.caption && video) parts.push('video');
    if (!item.caption) {
      const time = formatTime(item.takenLocal);
      if (time) parts.push(time);
    }
    if (duration) parts.push(duration);
    return parts.join(', ');
  });

  function onload(e: Event) {
    loaded = true;
    const img = e.currentTarget as HTMLImageElement;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) onaspect?.(item.id, img.naturalWidth / img.naturalHeight);
  }

  function onclick(e: MouseEvent) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onopen(item.id, e.currentTarget as HTMLElement);
  }
</script>

<figure class="tile" style:width="{width}px">
  <a class="frame" {href} style:height="{height}px" aria-label={label} data-item={item.id} {onclick} draggable="false">
    {#if srcset && !failed}
      <img
        {srcset}
        sizes="{Math.ceil(width)}px"
        src={item.urls.t400 || item.urls.t1200}
        alt={item.caption}
        width={Math.round(width)}
        height={Math.round(height)}
        loading="lazy"
        decoding="async"
        draggable="false"
        class:loaded
        style:view-transition-name={vtName}
        {onload}
        onerror={() => (failed = true)}
      />
    {/if}
    {#if video}
      <span class="glyph" aria-hidden="true"><Icon name="play" size={16} stroke={0} filled /></span>
      {#if duration}<span class="pill" aria-hidden="true">{duration}</span>{/if}
    {/if}
  </a>
  {#if item.caption}
    <figcaption class="t-caption" aria-hidden="true">{item.caption}</figcaption>
  {/if}
</figure>

<style>
  .tile {
    flex: none;
    min-width: 0;
  }

  .frame {
    position: relative;
    display: block;
    overflow: hidden;
    background: var(--well);
    -webkit-touch-callout: none;
  }

  .frame:focus-visible {
    outline-offset: 3px;
    border-radius: 0;
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    opacity: 0;
    transition: opacity var(--t-slow) var(--ease);
    user-select: none;
    -webkit-user-select: none;
  }

  img.loaded {
    opacity: 1;
  }

  @media (hover: hover) {
    .frame img {
      transition:
        opacity var(--t-slow) var(--ease),
        filter var(--t-mid) var(--ease);
    }
    .frame:hover img.loaded {
      filter: brightness(1.06);
    }
  }

  .glyph {
    position: absolute;
    left: 50%;
    top: 50%;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    margin: -20px 0 0 -20px;
    padding-left: 2px;
    border-radius: 50%;
    color: #fff;
    background: rgba(14, 14, 13, 0.38);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18) inset;
    pointer-events: none;
  }

  @media (min-width: 720px) {
    figcaption {
      padding: 8px 4px 12px 0;
    }
    .glyph {
      width: 48px;
      height: 48px;
      margin: -24px 0 0 -24px;
    }
  }

  .pill {
    position: absolute;
    right: 6px;
    bottom: 6px;
    padding: 1px 6px;
    border-radius: 999px;
    font-family: var(--sans);
    font-size: 11px;
    line-height: 16px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.01em;
    color: #fff;
    background: rgba(14, 14, 13, 0.5);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    pointer-events: none;
  }

  figcaption {
    padding: 6px 2px 8px 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
    hyphens: auto;
  }
</style>
