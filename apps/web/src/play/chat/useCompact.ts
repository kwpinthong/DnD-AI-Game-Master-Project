import { useSyncExternalStore } from 'react';

/** GEN-123: one rule for the phone layout: under 768 the phone frame, 768 and up the desktop frame (the tablet gets the desktop one). */
export const COMPACT_QUERY = '(max-width: 767.98px)';

const media = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(COMPACT_QUERY) : null);

function subscribe(onChange: () => void) {
  const m = media();
  m?.addEventListener('change', onChange);
  return () => m?.removeEventListener('change', onChange);
}

/** True while the window is a phone (< 768); false without `matchMedia` (the desktop frame). */
export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, () => media()?.matches ?? false, () => false);
}
