// Export a board as JSON Canvas (https://jsoncanvas.org), the format Obsidian uses for .canvas files.
const COLORS = { '#fbe1df': '1', '#ffc2d4': '1', '#ffd29a': '2', '#fdf3c4': '3', '#fff27a': '3', '#dcf2e4': '4', '#c8f2b4': '4', '#dde9fb': '5', '#b9e3ff': '5', '#ebe3fb': '6', '#ddd0ff': '6' };

function goproImage(src) {
  if (!src.token) return null;
  // Absolute URL so it renders anywhere (Obsidian loads remote images in text nodes).
  return `https://images-01.gopro.com/resize/1280w/${src.token}`;
}

/** Board → JSON Canvas. Local media become file nodes relative to the workspace folder. */
export function toJsonCanvas(board) {
  const nodes = [];
  const r = (n) => Math.round(n);
  for (const c of [...board.cards].sort((a, b) => (b.type === 'frame') - (a.type === 'frame') || (a.z || 0) - (b.z || 0))) {
    const base = { id: c.id, x: r(c.x), y: r(c.y), width: r(c.w), height: r(c.h) };
    const s = c.src || {};
    if (c.type === 'frame') nodes.push({ ...base, type: 'group', label: c.title || 'Frame' });
    else if (c.type === 'note') nodes.push({ ...base, type: 'text', text: c.text || '', ...(COLORS[c.color] ? { color: COLORS[c.color] } : {}) });
    else if (c.type === 'message') nodes.push({ ...base, type: 'text', text: `**${c.from || ''}**${c.at ? ` · ${c.at}` : ''}\n\n${c.text || ''}` });
    else if (c.type === 'link') nodes.push({ ...base, type: 'link', url: c.url || '' });
    else if (s.kind === 'local') nodes.push({ ...base, type: 'file', file: s.path });
    else if (s.kind === 'gopro') {
      const when = s.capturedAt ? ` · ${String(s.capturedAt).slice(0, 16).replace('T', ' ')}` : '';
      const img = c.type === 'photo' ? goproImage(s) : null;
      nodes.push({ ...base, type: 'text', text: `${img ? `![${s.filename || ''}](${img})\n\n` : ''}${c.caption || s.filename || 'GoPro'}${when}\n[Open on GoPro](https://gopro.com/v/${s.linkId})` });
    } else if (s.kind === 'upload') {
      nodes.push({ ...base, type: 'text', text: `📎 ${c.title || s.name || 'file'}${c.caption ? `\n\n${c.caption}` : ''}` });
    } else nodes.push({ ...base, type: 'text', text: c.caption || c.text || '' });
  }
  const edges = board.strings.map((s) => ({ id: s.id, fromNode: s.from, toNode: s.to, fromSide: 'top', toSide: 'top', toEnd: 'none' }));
  return { nodes, edges };
}

export function downloadCanvas(board) {
  const blob = new Blob([JSON.stringify(toJsonCanvas(board), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(board.title || 'board').replace(/[\\/:*?"<>|]+/g, '_')}.canvas`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
