<!-- Cover: the book's chapters by year, newest first; upcoming and ongoing ones on top. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { chapterStats, chapterYear, initials } from '../lib/format';
  import { chapterPath, router } from '../lib/router.svelte';
  import { loadAtlas, prefetchChapter, store, vt } from '../lib/store.svelte';
  import type { ChapterSummary } from '../lib/types';
  import { motion } from '../lib/viewport.svelte';
  import { prefs } from '../lib/prefs.svelte';

  const atlas = $derived(store.atlas);

  $effect(() => {
    document.title = atlas?.title ? `${atlas.title} · Atlas` : 'Atlas';
  });

  interface Group {
    label: string;
    chapters: ChapterSummary[];
  }

  const groups = $derived.by<Group[]>(() => {
    const list = atlas?.chapters ?? [];
    const newestFirst = (a: ChapterSummary, b: ChapterSummary) =>
      (b.from ?? b.to ?? '').localeCompare(a.from ?? a.to ?? '') || a.title.localeCompare(b.title);
    const out: Group[] = [];
    const pinned = list.filter((c) => c.status === 'ongoing' || c.status === 'upcoming');
    if (pinned.length) {
      out.push({ label: 'Now & next', chapters: [...pinned].sort((a, b) => (a.from ?? '').localeCompare(b.from ?? '')) });
    }
    const byYear = new Map<string, ChapterSummary[]>();
    for (const c of list) {
      if (c.status === 'ongoing' || c.status === 'upcoming') continue;
      const y = chapterYear(c) ?? 'Someday';
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y)?.push(c);
    }
    const years = [...byYear.keys()].sort((a, b) => (a === 'Someday' ? 1 : b === 'Someday' ? -1 : b.localeCompare(a)));
    for (const y of years) out.push({ label: y, chapters: (byYear.get(y) ?? []).sort(newestFirst) });
    return out;
  });

  const people = $derived(atlas?.people ?? []);
  const me = $derived(people.find((p) => p.name === prefs.me) ?? null);
  const avatars = $derived(me ? [me, ...people.filter((p) => p !== me)].slice(0, 2) : people.slice(0, 2));
  const heroName = (id: string) => (vt.hero === id && router.route.name === 'cover' && !motion.reduced ? 'hero' : null);
  const statusWord = (c: ChapterSummary) => (c.status === 'ongoing' ? 'Now' : c.status === 'upcoming' ? 'Upcoming' : '');
</script>

<div class="cover">
  <header class="top">
    <p class="wordmark">Atlas</p>
    <button
      class="settings"
      onclick={() => (store.settingsOpen = true)}
      aria-label="Settings"
      aria-haspopup="dialog"
    >
      {#if avatars.length}
        <span class="avatars" aria-hidden="true">
          {#each avatars as p (p.name)}
            <span class="avatar" class:me={p === me} style:background={p.color}>{initials(p.name)}</span>
          {/each}
        </span>
      {:else}
        <Icon name="settings" />
      {/if}
    </button>
  </header>

  <main>
    {#if store.atlasFromCache}
      <p class="t-meta offline-note col" role="status">Offline · showing the last saved copy</p>
    {/if}

    {#if atlas && groups.length}
      {#each groups as group, g (group.label)}
        <section class="year" aria-labelledby="group-{g}">
          <h2 class="year-label col" id="group-{g}"><span>{group.label}</span></h2>
          {#each group.chapters as c (c.id)}
            <a
              class="chapter"
              href={chapterPath(c.id)}
              onpointerenter={() => prefetchChapter(c.id)}
              ontouchstart={() => prefetchChapter(c.id)}
              onfocus={() => prefetchChapter(c.id)}
            >
              <div class="media">
                {#if c.cover}
                  <img src={c.cover.urls.t1200} alt="" decoding="async" style:view-transition-name={heroName(c.id)} />
                {/if}
              </div>
              <div class="words">
                {#if statusWord(c) || c.range}
                  <p class="t-kicker">
                    {#if statusWord(c)}<span class="status">{statusWord(c)}</span>{/if}{c.range ?? ''}
                  </p>
                {/if}
                <h3 class="t-title">{c.title}</h3>
                <p class="t-meta">{chapterStats(c)}</p>
              </div>
            </a>
          {/each}
        </section>
      {/each}
    {:else if atlas}
      <div class="empty col">
        <p class="empty-title">The book is still empty.</p>
        <p class="t-meta">
          Put photos or videos in the Atlas folder on the laptop, then come back. They will be laid out as a book, a page for
          each day.
        </p>
      </div>
    {:else if store.atlasState === 'error'}
      <div class="empty col">
        <p class="empty-title">Can’t reach Atlas right now.</p>
        <p class="t-meta">Is the laptop awake and on the same network?</p>
        <button class="text-btn" onclick={() => loadAtlas()}><Icon name="retry" size={18} /> Try again</button>
      </div>
    {:else}
      <div class="skeleton col" aria-hidden="true">
        <span class="sk-year"></span>
        <span class="sk-media"></span>
        <span class="sk-title"></span>
      </div>
      <p class="sr-only" role="status">Loading…</p>
    {/if}
  </main>
</div>

<style>
  .cover {
    min-height: 100svh;
    padding-bottom: calc(96px + var(--safe-bottom));
  }

  .col {
    width: min(calc(100% - 2 * var(--gutter)), var(--col-max));
    margin-left: auto;
    margin-right: auto;
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: min(calc(100% - 2 * var(--gutter)), var(--col-max));
    height: calc(56px + var(--safe-top));
    margin: 0 auto;
    padding-top: var(--safe-top);
  }

  .top .settings {
    margin-right: -8px;
  }

  .wordmark {
    font-family: var(--sans);
    font-size: 15px;
    line-height: 20px;
    font-weight: 650;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  .settings {
    display: inline-grid;
    place-items: center;
    min-width: 44px;
    height: 44px;
    padding: 0 6px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    cursor: pointer;
    transition: background-color var(--t-fast) var(--ease);
  }

  .settings:hover {
    background: var(--hover);
  }

  .avatars {
    display: inline-flex;
  }

  .avatar {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    font-size: 12px;
    line-height: 1;
    font-weight: 650;
    color: #fff;
    box-shadow: 0 0 0 2px var(--paper);
  }

  .avatar + .avatar {
    margin-left: -6px;
  }

  .offline-note {
    margin-top: 8px;
  }

  .year {
    margin-top: 40px;
  }

  .year-label {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 20px;
    font-family: var(--sans);
    font-size: 13px;
    line-height: 18px;
    font-weight: 600;
    letter-spacing: 0.08em;
    font-variant-numeric: tabular-nums;
    text-transform: uppercase;
    color: var(--ink-2);
  }

  .year-label::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--rule);
  }

  .chapter {
    display: block;
    margin: 0 auto 64px;
    width: min(calc(100% - 2 * var(--gutter)), var(--col-max));
    text-decoration: none;
    color: inherit;
    border-radius: 2px;
  }

  .chapter:focus-visible {
    outline-offset: 6px;
  }

  .media {
    aspect-ratio: 4 / 5;
    overflow: hidden;
    background: var(--well);
  }

  .media img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 900ms var(--ease);
  }

  @media (hover: hover) and (prefers-reduced-motion: no-preference) {
    .chapter:hover .media img {
      transform: scale(1.015);
    }
  }

  .words {
    display: grid;
    gap: 8px;
    padding-top: 20px;
  }

  .status {
    color: var(--ink);
    margin-right: 10px;
  }

  .t-title {
    max-width: 14em;
  }

  .empty {
    display: grid;
    justify-items: start;
    gap: 12px;
    margin-top: 18vh;
    max-width: 30em;
  }

  .empty-title {
    font-family: var(--font-human);
    font-weight: var(--title-weight);
    letter-spacing: var(--plate-tracking);
    font-size: 28px;
    line-height: 32px;
  }

  .empty .t-meta {
    font-size: 15px;
    line-height: 22px;
  }

  .empty .text-btn {
    margin-top: 8px;
  }

  .skeleton {
    display: grid;
    gap: 16px;
    margin-top: 40px;
  }

  .skeleton span {
    display: block;
    background: var(--well);
  }

  .sk-year {
    width: 48px;
    height: 12px;
  }

  .sk-media {
    aspect-ratio: 4 / 5;
  }

  .sk-title {
    width: 60%;
    height: 32px;
  }

  @media (min-width: 720px) {
    .top {
      height: calc(72px + var(--safe-top));
    }
    .year {
      margin-top: 56px;
    }
    .year-label {
      margin-bottom: 28px;
    }
    .media,
    .sk-media {
      aspect-ratio: 16 / 9;
      max-height: 62vh;
      width: 100%;
    }
    .words {
      padding-top: 28px;
      gap: 10px;
    }
    .chapter {
      margin-bottom: 96px;
    }
  }
</style>
