// Adding files: file picker, drag-and-drop onto the board, and pasted screenshots.
import { api } from './api.js';
import { toast } from './ui.js';
import { screenToWorld, viewCenter, state } from './board.js';

const progress = document.getElementById('progress');
const fileInput = document.getElementById('fileInput');
let ctx = null;
let pendingAt = null;

function setProgress(fraction, label) {
  if (fraction == null) { progress.hidden = true; return; }
  progress.hidden = false;
  progress.style.setProperty('--p', `${Math.round(fraction * 100)}%`);
  progress.querySelector('.bar').style.setProperty('--p', `${Math.round(fraction * 100)}%`);
  progress.querySelector('.label').textContent = label;
}

export async function uploadFiles(files, at) {
  files = [...files].filter((f) => f && f.size > 0);
  if (!files.length) return;
  if (!state.edit) { toast('Unlock the board (Edit) to add files.'); return; }
  const total = files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  const results = [];
  for (const [i, f] of files.entries()) {
    const label = files.length > 1 ? `Uploading ${i + 1} of ${files.length}: ${f.name || 'file'}` : `Uploading ${f.name || 'file'}`;
    try {
      const r = await api.upload(f, (p) => setProgress((done + p * f.size) / total, label));
      results.push(r);
    } catch (err) {
      toast(`${f.name || 'File'}: ${err.message}`, { error: true });
    }
    done += f.size;
  }
  setProgress(null);
  if (results.length) ctx.addUploads(results, at || viewCenter());
}

export function pickFiles(at = null) {
  pendingAt = at;
  fileInput.value = '';
  fileInput.click();
}

export function initUploads(context) {
  ctx = context;
  fileInput.addEventListener('change', () => uploadFiles(fileInput.files, pendingAt));

  const stage = document.getElementById('stage');
  stage.addEventListener('dragover', (e) => {
    const types = [...(e.dataTransfer?.types || [])];
    if (types.includes('Files') || types.includes('application/x-corkboard-items')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  stage.addEventListener('drop', (e) => {
    const at = screenToWorld(e.clientX, e.clientY);
    const items = e.dataTransfer?.getData('application/x-corkboard-items');
    if (items) {
      e.preventDefault();
      try { ctx.addMedia(JSON.parse(items), at); } catch {}
      return;
    }
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      uploadFiles(e.dataTransfer.files, at);
    }
  });
  // Don't let a missed drop navigate away from the board.
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => e.preventDefault());

  document.addEventListener('paste', (e) => {
    if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) {
      e.preventDefault();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const named = files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `Screenshot ${stamp}${i ? `-${i}` : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
      uploadFiles(named);
      return;
    }
    const text = e.clipboardData?.getData('text/plain')?.trim();
    if (text && state.edit) {
      e.preventDefault();
      ctx.pasteText(text);
    }
  });
}
