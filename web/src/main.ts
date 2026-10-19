// Entry point: fonts and tokens first, then the app. No inline scripts anywhere (CSP script-src 'self').
import './styles/fonts.css';
import './styles/app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { applyType } from './lib/prefs.svelte';
import { warmWhenControlled } from './lib/offline';
import { listenForFreshCopies } from './lib/store.svelte';
import { router } from './lib/router.svelte';
import { startUpdates } from './lib/updates';

applyType();
warmWhenControlled();
listenForFreshCopies();
startUpdates(() => router.route.name === 'cover' || router.route.name === 'chapter');

const target = document.getElementById('app');
if (target) mount(App, { target });
