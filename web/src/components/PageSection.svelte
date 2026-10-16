<!-- A page of the story: a date plate, then its photos and videos in justified rows. -->
<script lang="ts">
  import MediaTile from './MediaTile.svelte';
  import { layoutRows } from '../lib/layout';
  import type { Item, Page } from '../lib/types';

  let {
    page,
    items,
    title,
    kicker,
    width,
    target,
    spacing,
    maxSingle,
    aspects,
    vtMedia,
    hrefFor,
    onopen,
    onaspect,
  }: {
    page: Page;
    items: Record<string, Item>;
    title: string;
    kicker: string;
    width: number;
    target: number;
    spacing: number;
    maxSingle: number;
    aspects: Record<string, number>;
    vtMedia: string | null;
    hrefFor: (itemId: string) => string;
    onopen: (id: string, el: HTMLElement) => void;
    onaspect: (id: string, aspect: number) => void;
  } = $props();

  const rows = $derived.by(() => {
    const ids = page.items.filter((id) => items[id]);
    const ratios = ids.map((id) => {
      const fixed = aspects[id];
      if (fixed) return fixed;
      const it = items[id];
      return it.w && it.h ? it.w / it.h : 4 / 3;
    });
    return layoutRows(ids, ratios, { width, target, spacing, maxSingle });
  });

  const headingId = $derived(`page-${page.id}`);
</script>

<section class="page" aria-labelledby={headingId}>
  <header class="plate">
    {#if kicker}<p class="t-kicker">{kicker}</p>{/if}
    <h2 class="t-plate" id={headingId}>{title}</h2>
  </header>
  <div class="rows" style:width="{width}px" style:--gap="{spacing}px">
    {#each rows as row, r (r)}
      <div class="row" class:centered={row.centered}>
        {#each row.tiles as tile (tile.id)}
          <MediaTile
            item={items[tile.id]}
            width={tile.width}
            height={tile.height}
            href={hrefFor(tile.id)}
            vtName={vtMedia === tile.id ? 'media' : null}
            {onopen}
            {onaspect}
          />
        {/each}
      </div>
    {/each}
  </div>
</section>

<style>
  .page {
    margin-top: 72px;
  }

  .plate {
    width: min(calc(100% - 2 * var(--gutter)), var(--col-max));
    max-width: var(--col-max);
    margin: 0 auto 20px;
    display: grid;
    gap: 6px;
  }

  .plate h2 {
    max-width: var(--text-max);
  }

  .rows {
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--gap);
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: var(--gap);
  }

  .row.centered {
    justify-content: center;
  }

  @media (min-width: 720px) {
    .page {
      margin-top: 120px;
    }
    .plate {
      margin-bottom: 28px;
      gap: 8px;
    }
  }
</style>
