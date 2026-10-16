// Entry point: fonts and tokens first, then the app. No inline scripts anywhere (CSP script-src 'self').
import './styles/fonts.css';
import './styles/app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { applyType } from './lib/prefs.svelte';

applyType();

const target = document.getElementById('app');
if (target) mount(App, { target });
