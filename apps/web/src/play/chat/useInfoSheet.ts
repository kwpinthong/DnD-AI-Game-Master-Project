import { useCallback, useEffect, useState } from 'react';
import type { InfoTab } from './InfoPanel.tsx';

const MARK = 'v3Sheet';
const ours = () => Boolean((window.history.state as Record<string, unknown> | null)?.[MARK]);

/**
 * The phone's info sheet (GEN-123): which tab is open (null = closed). Opening pushes one history entry so the device back
 * button closes the sheet instead of leaving the page; closing with the button pops that entry again, so nothing is left behind.
 */
export function useInfoSheet() {
  const [tab, setTab] = useState<InfoTab | null>(null);
  const open = tab !== null;

  const show = useCallback((next: InfoTab) => {
    if (!ours()) window.history.pushState({ ...(window.history.state as object | null), [MARK]: true }, '');
    setTab(next);
  }, []);

  const close = useCallback(() => {
    if (ours()) window.history.back(); // popstate below closes it
    else setTab(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPop = () => {
      if (!ours()) setTab(null);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // The sheet went away without a back press (the page closed or the layout changed): pop our entry.
      if (ours()) window.history.back();
    };
  }, [open]);

  return { tab, show, close };
}
