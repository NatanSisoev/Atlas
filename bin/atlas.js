#!/usr/bin/env node
// atlas CLI: serve | info | prepare
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseArgs, loadConfig } from '../src/config.js';
import { detectTools, run, toolSummary } from '../src/tools.js';
import { createLocalIndex } from '../src/local.js';
import { createApp, VERSION } from '../src/server.js';

const USAGE = `atlas ${VERSION}

Usage:
  node bin/atlas.js serve <folder> [--port 5180] [--host 127.0.0.1] [--open]
  node bin/atlas.js info <folder>
  node bin/atlas.js prepare <folder> [--apply]

Everything the app writes goes into <folder>/.atlas/. Your media is never modified.
The book is at /, the old canvas at /board/.
`;

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`atlas needs Node 20 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const folder = args.positional[0];

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {}
}

async function serve() {
  // A bug in one request must never take the server (and unsaved work) down.
  process.on('unhandledRejection', (err) => console.error(`unhandled: ${err && err.stack ? err.stack : err}`));
  process.on('uncaughtException', (err) => console.error(`uncaught: ${err && err.stack ? err.stack : err}`));
  const cfg = await loadConfig({ folder, flags: args.flags });
  const tools = await detectTools();
  const { server } = await createApp(cfg, tools, { log: (m) => console.log(m) });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${cfg.port} is busy. Is atlas already running? Try --port ${cfg.port + 1}.`);
    else console.error(err.message);
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    const { port } = server.address();
    const shown = cfg.host === '0.0.0.0' || cfg.host === '::' ? 'localhost' : cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
    const url = `http://${shown === '127.0.0.1' ? 'localhost' : shown}:${port}`;
    const t = toolSummary(tools);
    console.log(`\n  atlas ${VERSION}`);
    console.log(`  folder : ${cfg.workspace}`);
    console.log(`  data   : ${cfg.dataDir}`);
    console.log(`  display: ${cfg.displayRoot || '(none — originals are shown)'}`);
    console.log(`  tools  : ffmpeg ${t.ffmpeg ? 'yes' : 'no'} · imagemagick ${t.magick ? 'yes' : 'no'} · exiftool ${t.exiftool ? 'yes' : 'no'}`);
    console.log(`  app    : ${fs.existsSync(path.join(cfg.webDist, 'index.html')) ? cfg.webDist : `not built (${cfg.webDist}) — run npm run build`}; old board at /board/`);
    console.log(`  names  : ${cfg.publicHost ? `localhost and ${cfg.publicHost} only` : cfg.allowTailscale ? 'localhost and any *.ts.net name (set "publicHost" to pin one)' : 'localhost only'}`);
    console.log(`\n  open ${url}  (Ctrl+C to stop)\n`);
    if (cfg.open) openBrowser(url);
  });
  const stop = () => {
    console.log('\nstopping…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function info() {
  const cfg = await loadConfig({ folder, flags: args.flags });
  const tools = await detectTools();
  const items = await createLocalIndex(cfg, tools, (m) => console.log(`  ${m}`)).list();
  const photos = items.filter((i) => i.type === 'photo');
  const videos = items.filter((i) => i.type === 'video');
  const t = toolSummary(tools);
  console.log(`folder   ${cfg.workspace}`);
  console.log(`data     ${cfg.dataDir}`);
  console.log(`display  ${cfg.displayRoot || '(none)'}`);
  console.log(`media    ${photos.length} photos, ${videos.length} videos (${items.filter((i) => i.hasDisplay).length} with display copies)`);
  const dated = items.filter((i) => i.capturedAt).map((i) => i.capturedAt).sort();
  if (dated.length) console.log(`dates    ${dated[0].slice(0, 10)} → ${dated.at(-1).slice(0, 10)} (${dated.length} dated)`);
  console.log(`tools    ffmpeg ${t.ffmpeg ? 'yes' : 'no'}, imagemagick ${t.magick ? 'yes' : 'no'}, exiftool ${t.exiftool ? 'yes' : 'no'}`);
}

async function prepare() {
  const cfg = await loadConfig({ folder, flags: args.flags });
  const tools = await detectTools();
  const apply = Boolean(args.flags.apply);
  const items = await createLocalIndex(cfg, tools).list();
  const missing = items.filter((i) => !i.hasDisplay);
  // Never write next to the user's media: generated copies live in .atlas/display.
  const outRoot = path.join(cfg.dataDir, 'display');
  console.log(`${missing.length} of ${items.length} files have no display copy. Target folder: ${outRoot}`);
  if (!missing.length) return;
  const plan = missing.map((i) => {
    const out = path.join(outRoot, i.type === 'video' ? i.path.replace(/\.[^.]+$/, '.mp4') : i.path.replace(/\.[^.]+$/, '.jpg'));
    const src = path.join(cfg.workspace, i.path);
    const tool = i.type === 'video' ? tools.ffmpeg : tools.magick?.cmd;
    const argv = i.type === 'video'
      ? ['-hide_banner', '-loglevel', 'error', '-n', '-i', src, '-vf', "scale='min(1920,iw)':-2", '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]
      : [src, '-auto-orient', '-resize', '2000x2000>', '-quality', '85', out];
    return { i, out, tool, argv };
  });
  for (const p of plan) console.log(`  ${p.i.type === 'video' ? 'video' : 'photo'}  ${p.i.path}  →  ${path.relative(cfg.workspace, p.out)}${p.tool ? '' : '  (skipped: tool missing)'}`);
  if (!apply) {
    console.log('\nDry run: nothing written. Re-run with --apply to create these copies.');
    return;
  }
  for (const p of plan) {
    if (!p.tool || fs.existsSync(p.out)) continue;
    await fsp.mkdir(path.dirname(p.out), { recursive: true });
    process.stdout.write(`  ${p.i.path} … `);
    const tmp = p.out.replace(/(\.[^.]+)$/, '.part$1');
    const argv = p.argv.slice(0, -1).concat(tmp);
    const r = await run(p.tool, argv, { timeout: 6 * 60 * 60 * 1000 });
    if (r.ok) { await fsp.rename(tmp, p.out); console.log('ok'); } else { await fsp.rm(tmp, { force: true }); console.log(`failed: ${r.stderr.split('\n')[0]}`); }
  }
}

const commands = { serve, info, prepare };
if (!args.cmd || args.flags.help || !commands[args.cmd] || !folder) {
  process.stdout.write(USAGE);
  process.exit(args.cmd && !args.flags.help ? 1 : 0);
}
commands[args.cmd]().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
