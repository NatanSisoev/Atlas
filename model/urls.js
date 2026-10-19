// @ts-check
// URL checks shared by the web client and the tests. Pure, no dependencies.

/** Code points the URL parser drops or treats specially: C0 controls, DEL and the backslash. */
const UNSAFE = /[\u0000-\u001f\u007f\\]/;

/**
 * A media URL from the API, only when it is a same-origin "/media/…" path; anything else is ''.
 * The URL parser silently removes tabs and newlines ("/\t/evil.example/x" would resolve to
 * https://evil.example/x), so those are refused before parsing, and the result is compared by
 * origin rather than by its spelling. Returns the normalised path and query.
 * @param {unknown} v
 * @param {string} [origin] the page's origin (location.origin in the browser)
 * @returns {string}
 */
export function safeMediaPath(v, origin) {
  if (typeof v !== 'string' || !v.startsWith('/') || UNSAFE.test(v)) return '';
  const base = origin || (typeof location !== 'undefined' && location.origin) || 'http://atlas.invalid';
  try {
    const u = new URL(v, base);
    if (u.origin !== new URL(base).origin || !u.pathname.startsWith('/media/')) return '';
    return u.pathname + u.search;
  } catch {
    return '';
  }
}
