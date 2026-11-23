// GEN-136: the phone info sheet has no resize corner marks in the folds, and its first tab is called like the bottom tab.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MobileLayout } from '../src/play/chat/MobileLayout.tsx';

afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));
const chatCss = readFileSync(join(here, '..', 'src', 'play', 'chat', 'chat.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

describe('GEN-136', () => {
  it('C1: .info-fold__body has resize: none (no corner marks)', () => {
    const rules = [...chatCss.matchAll(/\.info-fold__body\s*\{([^}]*)\}/g)].map((m) => m[1]).join(';');
    expect(rules).toMatch(/resize\s*:\s*none/);
  });

  it('C2: the sheet opened from the first bottom tab names its first tab like the bottom tab', () => {
    render(<MobileLayout hud={null} feed={null} actions={null} panel={() => <p>เนื้อหา</p>} />);
    const bottom = within(screen.getByRole('navigation', { name: 'แผงข้อมูล' })).getAllByRole('button')[0]!;
    const name = bottom.textContent;
    expect(name).toBe('ฉาก');
    fireEvent.click(bottom);
    const tabs = within(screen.getByRole('dialog')).getAllByRole('tab');
    expect(tabs[0]!.textContent).toBe(name);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
  });
});
