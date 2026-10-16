// Request guards: Host allow-list (DNS rebinding), CSRF header, and safe path resolution.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { HttpError } from './util.js';

export function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(0, end + 1) : '';
  }
  return h.split(':')[0].replace(/\.$/, '');
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * settings.publicHost / ATLAS_PUBLIC_HOST → a bare lowercase host name, or null when unset.
 * Throws on anything that is not a plain DNS name (so a typo fails loudly at startup).
 */
export function normalizePublicHost(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const name = hostnameOf(String(raw).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
  if (!HOSTNAME_RE.test(name)) throw new Error(`bad publicHost: ${JSON.stringify(String(raw))} (expected a host name such as atlas.tailnet-name.ts.net)`);
  return name;
}

/**
 * True when the Host header names this machine and not some attacker's domain: localhost, the
 * bind address, settings.allowedHosts, and either exactly cfg.publicHost (when set) or, for
 * backwards compatibility, any *.ts.net name (unless allowTailscale is false).
 */
export function hostAllowed(hostHeader, cfg) {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
  const bind = String(cfg.host || '').toLowerCase();
  if (bind && bind !== '0.0.0.0' && bind !== '::') allowed.add(bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind);
  for (const extra of cfg.allowedHosts || []) allowed.add(String(extra).toLowerCase());
  if (cfg.publicHost) allowed.add(String(cfg.publicHost).toLowerCase());
  if (allowed.has(name)) return true;
  if (!cfg.publicHost && cfg.allowTailscale !== false && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(name)) return true;
  return false;
}

/**
 * Fetch Metadata guard for reads (/api/*, /media/*): browsers label every request with
 * Sec-Fetch-Site, so a page on another site (or another *.ts.net machine: same-site) cannot read
 * or embed our data. Requests without the header (curl, older browsers) and direct navigations
 * ('none') pass; writes are covered by checkCsrf.
 */
export function checkFetchMetadata(req) {
  const site = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (site === 'cross-site' || site === 'same-site') throw new HttpError(403, 'cross-site request');
}

/**
 * State-changing requests must carry a custom header (forces a CORS preflight that we never
 * answer, so other websites cannot forge them) and, when present, a same-host Origin.
 */
export function checkCsrf(req, cfg = {}) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  if (req.headers['x-requested-with'] !== 'atlas') throw new HttpError(403, 'missing X-Requested-With header');
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host.toLowerCase();
    } catch {
      throw new HttpError(403, 'bad origin');
    }
    // Same host, or one of our own names (a reverse proxy such as Tailscale Serve may rewrite Host).
    if (host !== String(req.headers.host || '').toLowerCase() && !hostAllowed(host, cfg)) throw new HttpError(403, 'cross-origin request');
  }
}

/**
 * Turn the raw (still percent-encoded) remainder of a URL path into a relative path.
 * Rejects anything that could climb out of a root: `..`, `.`, empty segments, backslashes,
 * NUL, drive letters, encoded slashes, and dot-files/folders.
 */
export function decodeRelPath(raw) {
  if (typeof raw !== 'string' || !raw) throw new HttpError(404, 'not found');
  const parts = raw.split('/');
  const out = [];
  for (const enc of parts) {
    let seg;
    try {
      seg = decodeURIComponent(enc);
    } catch {
      throw new HttpError(404, 'not found');
    }
    if (!seg || seg === '.' || seg === '..' || seg.startsWith('.')) throw new HttpError(404, 'not found');
    if (/[\\/\0:]/.test(seg) || /[\x00-\x1f]/.test(seg)) throw new HttpError(404, 'not found');
    out.push(seg);
  }
  return out.join('/');
}

/** Resolve rel inside root; throws 404 if the result (or its real path) escapes root. */
export async function resolveInside(root, rel) {
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.includes('\\')) throw new HttpError(404, 'not found');
  const rootAbs = path.resolve(root);
  const full = path.resolve(rootAbs, rel);
  if (!isInside(rootAbs, full)) throw new HttpError(404, 'not found');
  let real, realRoot;
  try {
    [real, realRoot] = await Promise.all([fsp.realpath(full), fsp.realpath(rootAbs)]);
  } catch {
    throw new HttpError(404, 'not found');
  }
  if (!isInside(realRoot, real)) throw new HttpError(404, 'not found');
  return real;
}

export function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https://*.gopro.com",
  "media-src 'self' blob: https://*.gopro.com",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');
