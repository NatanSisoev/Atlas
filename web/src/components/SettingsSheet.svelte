<!-- Settings: title style (the owner's M1 type choice), who this device belongs to, the old board. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { prefs, setMe, setType, type TypeStyle } from '../lib/prefs.svelte';
  import { store } from '../lib/store.svelte';

  let dialog: HTMLDialogElement;

  $effect(() => {
    if (!dialog) return;
    if (store.settingsOpen && !dialog.open) dialog.showModal();
    else if (!store.settingsOpen && dialog.open) dialog.close();
  });

  const people = $derived(store.atlas?.people ?? []);
  const types: { value: TypeStyle; label: string; sample: string }[] = [
    { value: 'serif', label: 'Serif', sample: 'Summer by the sea' },
    { value: 'sans', label: 'Sans', sample: 'Summer by the sea' },
  ];

  function onBackdrop(e: MouseEvent) {
    if (e.target === dialog) store.settingsOpen = false;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} aria-labelledby="settings-title" onclose={() => (store.settingsOpen = false)} onclick={onBackdrop}>
  <div class="sheet">
    <header>
      <h2 id="settings-title">Settings</h2>
      <button class="icon-btn" onclick={() => (store.settingsOpen = false)} aria-label="Close settings">
        <Icon name="close" size={20} />
      </button>
    </header>

    <fieldset>
      <legend>Title style</legend>
      <div class="types">
        {#each types as t (t.value)}
          <label class="type" class:checked={prefs.type === t.value}>
            <input type="radio" name="type" value={t.value} checked={prefs.type === t.value} onchange={() => setType(t.value)} />
            <span class="sample {t.value}">{t.sample}</span>
            <span class="type-label">{t.label}</span>
          </label>
        {/each}
      </div>
    </fieldset>

    <fieldset>
      <legend>This device is</legend>
      {#if people.length}
        <div class="people">
          {#each people as p (p.name)}
            <label class="person" class:checked={prefs.me === p.name}>
              <input type="radio" name="me" value={p.name} checked={prefs.me === p.name} onchange={() => setMe(p.name)} />
              <span class="dot" style:background={p.color} aria-hidden="true"></span>
              <span>{p.name}</span>
            </label>
          {/each}
          <label class="person" class:checked={!prefs.me || !people.some((p) => p.name === prefs.me)}>
            <input
              type="radio"
              name="me"
              value=""
              checked={!prefs.me || !people.some((p) => p.name === prefs.me)}
              onchange={() => setMe(null)}
            />
            <span class="dot none" aria-hidden="true"></span>
            <span>Not set</span>
          </label>
        </div>
      {:else}
        <p class="note">No people are set up yet. Add them in the old board’s settings.</p>
      {/if}
    </fieldset>

    <div class="links">
      <a class="row-link" href="/board/" data-native>
        <span>Open the old board</span>
        <Icon name="external" size={18} />
      </a>
    </div>

    <p class="note foot">Light and dark follow this device’s setting.</p>
  </div>
</dialog>

<style>
  dialog {
    width: 100%;
    max-width: 100%;
    max-height: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--ink);
    overflow: hidden;
  }

  dialog::backdrop {
    background: rgba(14, 14, 13, 0.36);
    animation: fade-in var(--t-mid) var(--ease);
  }

  dialog[open] {
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }

  .sheet {
    width: 100%;
    max-height: calc(100% - var(--safe-top) - 24px);
    overflow: auto;
    padding: 8px calc(var(--safe-right) + 20px) calc(var(--safe-bottom) + 24px) calc(var(--safe-left) + 20px);
    border-radius: 20px 20px 0 0;
    background: var(--sheet);
    box-shadow: var(--shadow);
    animation: sheet-up var(--t-slow) var(--ease);
  }

  @keyframes sheet-up {
    from {
      transform: translateY(32px);
      opacity: 0;
    }
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet,
    dialog::backdrop {
      animation-name: fade-in;
    }
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 -10px 8px 0;
  }

  h2 {
    font-size: 17px;
    line-height: 22px;
    font-weight: 600;
  }

  fieldset {
    margin: 0;
    padding: 16px 0 20px;
    border: 0;
    border-top: 1px solid var(--rule);
  }

  legend {
    float: left;
    width: 100%;
    margin-bottom: 12px;
    font-size: 13px;
    line-height: 18px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-2);
  }

  input[type='radio'] {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
    margin: 0;
    pointer-events: none;
  }

  .types {
    clear: both;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .type {
    position: relative;
    display: grid;
    gap: 10px;
    padding: 14px 14px 12px;
    border-radius: 12px;
    box-shadow: 0 0 0 1px var(--rule) inset;
    cursor: pointer;
    transition: box-shadow var(--t-fast) var(--ease);
  }

  .type.checked {
    box-shadow: 0 0 0 2px var(--ink) inset;
  }

  .type:has(input:focus-visible),
  .person:has(input:focus-visible) {
    outline: 2px solid var(--ink);
    outline-offset: 2px;
  }

  .sample {
    font-size: 24px;
    line-height: 26px;
    min-height: 52px;
  }

  .sample.serif {
    font-family: var(--serif);
    font-weight: 400;
    letter-spacing: -0.012em;
  }

  .sample.sans {
    font-family: var(--sans);
    font-weight: 700;
    letter-spacing: -0.04em;
  }

  .type-label {
    font-size: 13px;
    line-height: 18px;
    color: var(--ink-2);
  }

  .people {
    clear: both;
    display: grid;
    gap: 2px;
  }

  .person {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    padding: 0 12px;
    border-radius: 10px;
    cursor: pointer;
    font-size: 16px;
  }

  .person:hover {
    background: var(--hover);
  }

  .person.checked {
    background: var(--well);
    font-weight: 600;
  }

  .person.checked::after {
    content: '';
    margin-left: auto;
    width: 10px;
    height: 6px;
    border-left: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
    transform: rotate(-45deg) translate(1px, -2px);
  }

  .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
  }

  .dot.none {
    box-shadow: 0 0 0 1.5px var(--ink-2) inset;
  }

  .note {
    clear: both;
    font-size: 14px;
    line-height: 20px;
    color: var(--ink-2);
  }

  .links {
    border-top: 1px solid var(--rule);
    padding-top: 8px;
  }

  .row-link {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 48px;
    margin: 0 -12px;
    padding: 0 12px;
    border-radius: 10px;
    font-size: 16px;
    text-decoration: none;
  }

  .row-link:hover {
    background: var(--hover);
  }

  .foot {
    margin-top: 12px;
    font-size: 13px;
  }

  @media (min-width: 720px) {
    dialog[open] {
      align-items: center;
    }
    .sheet {
      width: 440px;
      border-radius: 18px;
      padding: 12px 24px 24px;
    }
  }
</style>
