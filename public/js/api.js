// Thin client for the atlas server API.

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(method, url, { body, headers = {}, keepalive = false } = {}) {
  const init = { method, headers: { 'X-Requested-With': 'atlas', ...headers }, keepalive, cache: 'no-store' };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ApiError(0, 'You appear to be offline', null);
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `HTTP ${res.status}`, data);
  return data;
}

export const api = {
  health: () => request('GET', '/api/health'),
  settings: () => request('GET', '/api/settings'),
  saveSettings: (s) => request('PUT', '/api/settings', { body: s }),

  boards: () => request('GET', '/api/boards'),
  createBoard: (title) => request('POST', '/api/boards', { body: { title } }),
  board: (id) => request('GET', `/api/boards/${encodeURIComponent(id)}`),
  saveBoard: (doc, rev, opts = {}) =>
    request('PUT', `/api/boards/${encodeURIComponent(doc.id)}`, { body: doc, headers: { 'If-Match': String(rev) }, ...opts }),
  deleteBoard: (id) => request('DELETE', `/api/boards/${encodeURIComponent(id)}`),

  local: () => request('GET', '/api/local'),

  goproLinks: () => request('GET', '/api/gopro/links'),
  addGoproLink: (url) => request('POST', '/api/gopro/links', { body: { url } }),
  refreshGoproLink: (id) => request('POST', `/api/gopro/links/${encodeURIComponent(id)}/refresh`),
  deleteGoproLink: (id) => request('DELETE', `/api/gopro/links/${encodeURIComponent(id)}`),
  goproItems: (id) => request('GET', `/api/gopro/links/${encodeURIComponent(id)}/items`),

  /** Upload with progress. onProgress(fraction). */
  upload(file, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads');
      xhr.setRequestHeader('X-Requested-With', 'atlas');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'pasted.png'));
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(xhr.status, (data && data.error) || `Upload failed (${xhr.status})`, data));
      };
      xhr.onerror = () => reject(new ApiError(0, 'Upload failed: connection lost', null));
      xhr.send(file);
    });
  },
};

// ---- media URLs ----
const enc = (p) => String(p).split('/').map(encodeURIComponent).join('/');

export function thumbUrl(src, cssWidth) {
  if (!src) return null;
  if (src.kind === 'local') {
    const w = [200, 400, 800, 1200].find((s) => s >= cssWidth) || 1200;
    return `/media/local/thumb/${enc(src.path)}?w=${w}${src.v ? `&v=${encodeURIComponent(src.v)}` : ''}`;
  }
  if (src.kind === 'gopro') {
    const w = [450, 640, 1280].find((s) => s >= cssWidth) || 1280;
    return src.token ? `/media/gopro/thumb/${encodeURIComponent(src.token)}?w=${w}` : null;
  }
  if (src.kind === 'upload') {
    const w = [200, 400, 800, 1200].find((s) => s >= cssWidth) || 1200;
    return `/media/uploads/${encodeURIComponent(src.id)}/thumb?w=${w}`;
  }
  return null;
}

/** Full-size viewing URL (display copy for local media). */
export function viewUrl(src) {
  if (!src) return null;
  if (src.kind === 'local') return `/media/local/display/${enc(src.path)}`;
  if (src.kind === 'gopro') {
    if (/video/i.test(src.mediaType || '')) return `/media/gopro/play/${encodeURIComponent(src.mediumId)}`;
    return src.token ? `/media/gopro/thumb/${encodeURIComponent(src.token)}?w=2560` : null;
  }
  if (src.kind === 'upload') return `/media/uploads/${encodeURIComponent(src.id)}`;
  return null;
}

export function originalUrl(src, download = false) {
  if (!src) return null;
  if (src.kind === 'local') return `/media/local/original/${enc(src.path)}${download ? '?download=1' : ''}`;
  if (src.kind === 'gopro') return `/media/gopro/original/${encodeURIComponent(src.mediumId)}`;
  if (src.kind === 'upload') {
    const q = new URLSearchParams();
    if (download) q.set('download', '1');
    if (src.name) q.set('name', src.name);
    return `/media/uploads/${encodeURIComponent(src.id)}?${q}`;
  }
  return null;
}
