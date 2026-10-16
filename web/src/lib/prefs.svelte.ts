// Per-device preferences (localStorage; every access guarded, the app works without storage).
export type TypeStyle = 'serif' | 'sans';

const KEY_TYPE = 'atlas:type';
const KEY_ME = 'atlas:me';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage: keep the choice for this session only */
  }
}

export const prefs = $state<{ type: TypeStyle; me: string | null }>({
  type: read(KEY_TYPE) === 'sans' ? 'sans' : 'serif',
  me: read(KEY_ME),
});

export function applyType(): void {
  document.documentElement.dataset.type = prefs.type;
}

export function setType(type: TypeStyle): void {
  prefs.type = type;
  write(KEY_TYPE, type);
  applyType();
}

export function setMe(name: string | null): void {
  prefs.me = name;
  write(KEY_ME, name);
}
