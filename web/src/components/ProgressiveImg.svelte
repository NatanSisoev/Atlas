<!-- Shows the first source at once, then swaps to each sharper source once it has decoded. -->
<script lang="ts">
  let {
    srcs,
    alt = '',
    vtName = null,
    fit = 'contain',
    className = '',
    onfail,
  }: {
    srcs: string[];
    alt?: string;
    vtName?: string | null;
    fit?: 'contain' | 'cover';
    className?: string;
    onfail?: () => void;
  } = $props();

  const list = $derived(srcs.filter((s, i) => s && srcs.indexOf(s) === i));
  let shown = $state(0);

  $effect(() => {
    const sources = list;
    shown = 0;
    let alive = true;
    let best = 0;
    sources.slice(1).forEach((src, i) => {
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
      img
        .decode()
        .then(() => {
          if (alive && i + 1 > best) {
            best = i + 1;
            shown = best;
          }
        })
        .catch(() => {
          /* keep the sharpest one that worked */
        });
    });
    return () => {
      alive = false;
    };
  });
</script>

{#if list.length}
  <img
    src={list[shown]}
    {alt}
    class={className}
    style:object-fit={fit}
    style:view-transition-name={vtName}
    draggable="false"
    decoding="async"
    onerror={() => {
      if (shown > 0) shown = 0;
      else onfail?.();
    }}
  />
{/if}

<style>
  img {
    width: 100%;
    height: 100%;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
</style>
