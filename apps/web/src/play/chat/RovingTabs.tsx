import { useRef, type KeyboardEvent } from 'react';

export interface TabDef<Id extends string> {
  id: Id;
  label: string;
}

export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const panelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

/**
 * A tab list (role=tab) where the arrow keys / Home / End move between the tabs (roving tabindex) and open
 * the one reached. Each tab is >= 44px high. The caller renders the `role="tabpanel"` with `panelId` / `tabId`.
 * GEN-123 uses the same list as the phone's bottom bar.
 */
export function RovingTabs<Id extends string>({ label, prefix, tabs, active, onPick, className }: { label: string; prefix: string; tabs: readonly TabDef<Id>[]; active: Id; onPick: (id: Id) => void; className?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKey(event: KeyboardEvent, index: number) {
    const to = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    const next = (to + tabs.length) % tabs.length;
    onPick(tabs[next]!.id);
    refs.current[next]?.focus();
  }

  return (
    <div role="tablist" aria-label={label} className={['chat-tabs', className].filter(Boolean).join(' ')}>
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={tabId(prefix, tab.id)}
          aria-selected={tab.id === active}
          aria-controls={panelId(prefix, tab.id)}
          tabIndex={tab.id === active ? 0 : -1}
          className="chat-tabs__tab"
          onClick={() => onPick(tab.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
