// Fullscreen and screen wake lock for Play. Every call is optional and fails quietly.

export function enterFullscreen(): void {
  try {
    const el = document.documentElement;
    if (!document.fullscreenElement && typeof el.requestFullscreen === 'function') {
      el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
  } catch {
    /* not allowed here */
  }
}

export function exitFullscreen(): void {
  try {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  } catch {
    /* ignore */
  }
}

type WakeLockSentinelLike = { release(): Promise<void> };
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } };

/** Keep the screen on while mounted; returns a release function. */
export function keepAwake(): () => void {
  let lock: WakeLockSentinelLike | null = null;
  let active = true;
  const request = () => {
    const wl = (navigator as WakeLockNavigator).wakeLock;
    if (!active || !wl || document.visibilityState !== 'visible') return;
    wl.request('screen')
      .then((l) => {
        if (active) lock = l;
        else l.release().catch(() => {});
      })
      .catch(() => {});
  };
  request();
  document.addEventListener('visibilitychange', request);
  return () => {
    active = false;
    document.removeEventListener('visibilitychange', request);
    lock?.release().catch(() => {});
    lock = null;
  };
}
