// CLI args, settings.json and the resolved runtime configuration.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic, HttpError, isPlainObject } from './util.js';
import { isInside, normalizePublicHost } from './security.js';

export const DEFAULT_PORT = 5180;
export const DEFAULT_HOST = '127.0.0.1';
/** The built web client (committed); ATLAS_WEB_DIST points elsewhere (tests use a fake one). */
export const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

export function parseArgs(argv) {
  const out = { cmd: null, positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) out.flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && ['port', 'host', 'data-dir'].includes(k)) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else if (!out.cmd) out.cmd = a;
    else out.positional.push(a);
  }
  return out;
}

/** <workspace>/.atlas, or an existing .corkboard folder from before the project was renamed. */
export function defaultDataDir(workspace) {
  const current = path.join(workspace, '.atlas');
  const legacy = path.join(workspace, '.corkboard');
  if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy;
  return current;
}

export function dataPaths(dataDir) {
  return {
    dataDir,
    settingsFile: path.join(dataDir, 'settings.json'),
    boards: path.join(dataDir, 'boards'),
    backups: path.join(dataDir, 'backups'),
    uploads: path.join(dataDir, 'uploads'),
    gopro: path.join(dataDir, 'gopro'),
    cache: path.join(dataDir, 'cache'),
    thumbs: path.join(dataDir, 'cache', 'thumbs'),
    trash: path.join(dataDir, 'trash'),
  };
}

function cleanPeople(people) {
  if (!Array.isArray(people)) return [];
  return people
    .filter(isPlainObject)
    .slice(0, 50)
    .map((p) => ({
      name: String(p.name ?? '').slice(0, 60),
      color: /^#[0-9a-fA-F]{3,8}$/.test(String(p.color)) ? String(p.color) : '#4a7bd0',
    }))
    .filter((p) => p.name.trim());
}

export async function loadConfig({ folder, flags = {}, env = process.env }) {
  if (!folder) throw new Error('missing <folder>');
  const workspace = path.resolve(folder);
  let st;
  try {
    st = fs.statSync(workspace);
  } catch {
    throw new Error(`folder not found: ${workspace}`);
  }
  if (!st.isDirectory()) throw new Error(`not a folder: ${workspace}`);

  const dataDir = path.resolve(flags['data-dir'] || env.ATLAS_DATA_DIR || env.CORKBOARD_DATA_DIR || defaultDataDir(workspace));
  const paths = dataPaths(dataDir);
  for (const d of [paths.boards, paths.backups, paths.uploads, paths.gopro, paths.thumbs, paths.trash]) {
    await fsp.mkdir(d, { recursive: true });
  }
  let settings = {};
  try {
    settings = await readJson(paths.settingsFile);
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Keep the unreadable file for the user instead of overwriting it later.
      const aside = `${paths.settingsFile}.unreadable-${Date.now()}`;
      await fsp.rename(paths.settingsFile, aside).catch(() => {});
      console.warn(`settings.json was unreadable; moved to ${aside} and using defaults.`);
    } else if (err.code !== 'ENOENT') throw err;
  }
  if (!isPlainObject(settings)) settings = {};
  const portRaw = flags.port ?? env.PORT ?? settings.port ?? DEFAULT_PORT;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad port: ${portRaw}`);
  const host = String(flags.host ?? env.HOST ?? settings.host ?? DEFAULT_HOST);

  const cfg = {
    workspace,
    ...paths,
    port,
    host,
    open: Boolean(flags.open),
    webDist: path.resolve(env.ATLAS_WEB_DIST || DEFAULT_WEB_DIST),
    // Exact public name (e.g. atlas.tailnet-name.ts.net); when set, no other *.ts.net name is accepted.
    publicHost: normalizePublicHost(env.ATLAS_PUBLIC_HOST || settings.publicHost),
    allowTailscale: settings.allowTailscale !== false,
    allowedHosts: Array.isArray(settings.allowedHosts) ? settings.allowedHosts.map(String) : [],
    settings: {
      title: typeof settings.title === 'string' && settings.title.trim() ? settings.title : path.basename(workspace),
      people: cleanPeople(settings.people),
      displayDir: typeof settings.displayDir === 'string' ? settings.displayDir : null,
    },
    rawSettings: settings,
  };
  cfg.displayRoot = resolveDisplayDir(cfg);
  return cfg;
}

/** The display-copies folder: settings.displayDir (relative to workspace or absolute) or <workspace>/compressed. */
export function resolveDisplayDir(cfg) {
  const configured = cfg.settings.displayDir;
  const candidates = configured ? [path.resolve(cfg.workspace, configured)] : [path.join(cfg.workspace, 'compressed')];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }
  return null;
}

export async function updateSettings(cfg, body) {
  if (!isPlainObject(body)) throw new HttpError(400, 'expected an object');
  const next = { ...cfg.rawSettings };
  if ('title' in body) {
    const t = String(body.title ?? '').trim().slice(0, 120);
    if (!t) throw new HttpError(400, 'title must not be empty');
    next.title = t;
  }
  if ('people' in body) next.people = cleanPeople(body.people);
  if ('displayDir' in body) {
    if (body.displayDir === null || body.displayDir === '') next.displayDir = null;
    else {
      // Over the API only folders inside the workspace; edit settings.json by hand for anything else.
      const rel = String(body.displayDir);
      const abs = path.resolve(cfg.workspace, rel);
      if (path.isAbsolute(rel) || !isInside(cfg.workspace, abs)) throw new HttpError(400, 'displayDir must be a folder inside the workspace');
      let ok = false;
      try { ok = fs.statSync(abs).isDirectory(); } catch {}
      if (!ok) throw new HttpError(400, 'displayDir does not exist');
      next.displayDir = rel.replace(/\\/g, '/');
    }
  }
  await writeJsonAtomic(cfg.settingsFile, next);
  cfg.rawSettings = next;
  cfg.settings = {
    title: next.title || path.basename(cfg.workspace),
    people: cleanPeople(next.people),
    displayDir: next.displayDir ?? null,
  };
  cfg.displayRoot = resolveDisplayDir(cfg);
  return publicSettings(cfg);
}

export function publicSettings(cfg) {
  return {
    title: cfg.settings.title,
    people: cfg.settings.people,
    displayDir: cfg.settings.displayDir,
    displayDirFound: Boolean(cfg.displayRoot),
  };
}
