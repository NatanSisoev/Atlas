<!-- Line icons (Lucide geometry, ISC licence), 1.5 stroke. Decorative: the control carries the label. -->
<script lang="ts" module>
  export type IconName =
    | 'back'
    | 'close'
    | 'info'
    | 'play'
    | 'pause'
    | 'prev'
    | 'next'
    | 'settings'
    | 'download'
    | 'external'
    | 'replay'
    | 'retry'
    | 'up';
</script>

<script lang="ts">
  let { name, size = 22, stroke = 1.5, filled = false }: { name: IconName; size?: number; stroke?: number; filled?: boolean } =
    $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={filled ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === 'back'}
    <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
  {:else if name === 'close'}
    <path d="M18 6 6 18" /><path d="m6 6 12 12" />
  {:else if name === 'info'}
    <circle cx="12" cy="12" r="9.25" /><path d="M12 16.5v-5" /><path d="M12 7.75h.01" />
  {:else if name === 'play'}
    <path d="M7 4.6v14.8a.9.9 0 0 0 1.37.77l12-7.4a.9.9 0 0 0 0-1.54l-12-7.4A.9.9 0 0 0 7 4.6z" />
  {:else if name === 'pause'}
    <rect x="6.5" y="4.5" width="3.5" height="15" rx="1" /><rect x="14" y="4.5" width="3.5" height="15" rx="1" />
  {:else if name === 'prev'}
    <path d="m15 18-6-6 6-6" />
  {:else if name === 'next'}
    <path d="m9 18 6-6-6-6" />
  {:else if name === 'settings'}
    <path d="M20 7h-9" /><path d="M14 17H4" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" />
  {:else if name === 'download'}
    <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
  {:else if name === 'external'}
    <path d="M7 7h10v10" /><path d="M7 17 17 7" />
  {:else if name === 'replay'}
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
  {:else if name === 'retry'}
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
  {:else if name === 'up'}
    <path d="m5 12 7-7 7 7" /><path d="M12 19V5" />
  {/if}
</svg>
