// Viewport metrics shared by layout code. Breakpoint matches the CSS (720px).
export const DESKTOP_MIN = 720;

function measure() {
  const w = document.documentElement.clientWidth || window.innerWidth;
  const h = window.innerHeight;
  return { w, h, desktop: w >= DESKTOP_MIN };
}

export const viewport = $state(measure());

let frame = 0;
const update = () => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const m = measure();
    if (m.w !== viewport.w) viewport.w = m.w;
    if (m.h !== viewport.h) viewport.h = m.h;
    if (m.desktop !== viewport.desktop) viewport.desktop = m.desktop;
  });
};
window.addEventListener('resize', update);
window.addEventListener('orientationchange', update);

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
export const motion = $state({ reduced: motionQuery.matches });
motionQuery.addEventListener('change', (e) => {
  motion.reduced = e.matches;
});
