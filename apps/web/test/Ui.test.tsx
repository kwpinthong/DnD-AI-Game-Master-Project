// GEN-087 base components: buttons (C3), visibility badge (C4) and the shared states every page uses.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, EmptyState, ErrorState, HitCard, MaskIcon, Panel, Skeleton, Toast, VisibilityBadge } from '../src/ui/index.ts';

afterEach(cleanup);

describe('Button', () => {
  it('C3 disabled: cannot be pressed and the browser reports it as disabled', () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" disabled onClick={onClick}>
        ส่ง action
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'ส่ง action' });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('C3 disabled with a reason: the reason is shown as text and linked by aria-describedby', () => {
    render(
      <Button disabled disabledReason="ต้องมีผู้เล่นอย่างน้อย 2 คน">
        เริ่มเกม
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'เริ่มเกม' });
    const reason = screen.getByText('ต้องมีผู้เล่นอย่างน้อย 2 คน');
    expect(reason.id).not.toBe('');
    expect(button.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('C3 loading: cannot be pressed, is aria-busy and says it is working', () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" loading onClick={onClick}>
        ส่ง action
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>('button');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('กำลังดำเนินการ…');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('C3 loading with its own text', () => {
    render(
      <Button loading loadingText="กำลังส่ง…">
        ส่ง
      </Button>,
    );
    expect(screen.getByRole('button').textContent).toContain('กำลังส่ง…');
  });

  it('variants map to classes, default is secondary and type="button"', () => {
    render(
      <>
        <Button>รอง</Button>
        <Button variant="primary">หลัก</Button>
        <Button variant="danger">ลบ</Button>
        <Button type="submit">ส่งฟอร์ม</Button>
      </>,
    );
    const rong = screen.getByRole('button', { name: 'รอง' });
    expect(rong.className).toContain('btn--secondary');
    expect(rong.getAttribute('type')).toBe('button');
    expect(screen.getByRole('button', { name: 'หลัก' }).className).toContain('btn--primary');
    expect(screen.getByRole('button', { name: 'ลบ' }).className).toContain('btn--danger');
    expect(screen.getByRole('button', { name: 'ส่งฟอร์ม' }).getAttribute('type')).toBe('submit');
  });

  it('an enabled button calls onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>กด</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'กด' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('VisibilityBadge', () => {
  it('C4 secret says "ลับ" in words, not by colour alone', () => {
    const { container } = render(<VisibilityBadge visibility="secret" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.textContent).toContain('ลับ');
    expect(badge.className).toContain('badge--secret');
    expect(badge.getAttribute('title')).toBe('Secret');
    // the icon is decoration; the word carries the meaning
    for (const icon of badge.querySelectorAll('.icon')) expect(icon.getAttribute('aria-hidden')).toBe('true');
  });

  it('public says "เปิดเผย"', () => {
    const { container } = render(<VisibilityBadge visibility="public" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.textContent).toContain('เปิดเผย');
    expect(badge.textContent).not.toContain('ลับ');
    expect(badge.className).toContain('badge--public');
    expect(badge.getAttribute('title')).toBe('Public');
  });
});

describe('HitCard', () => {
  it('shows "เกิดกับคุณ", the actor or "ไม่รู้ว่าใครทำ", and acknowledges', () => {
    const onAcknowledge = vi.fn();
    const { rerender } = render(
      <HitCard actor={null} onAcknowledge={onAcknowledge}>
        มีมือล้วงกระเป๋าคุณ เงินหายไป 3 เหรียญ
      </HitCard>,
    );
    const card = screen.getByRole('article', { name: 'เกิดกับคุณ' });
    expect(card.textContent).toContain('ไม่รู้ว่าใครทำ');
    expect(card.textContent).toContain('มีมือล้วงกระเป๋าคุณ');
    fireEvent.click(screen.getByRole('button', { name: 'รับทราบ' }));
    expect(onAcknowledge).toHaveBeenCalledOnce();
    rerender(
      <HitCard actor="หญิงผ้าคลุมเทา" onAcknowledge={onAcknowledge}>
        ถูกผลัก
      </HitCard>,
    );
    expect(screen.getByRole('article').textContent).toContain('หญิงผ้าคลุมเทา');
  });
});

describe('Toast', () => {
  it('is a polite status; success starts with "สำเร็จ:" and can be closed', () => {
    const onClose = vi.fn();
    render(
      <Toast tone="success" onClose={onClose}>
        ได้ความสามารถใหม่: Glare of Truth
      </Toast>,
    );
    const toast = screen.getByRole('status');
    expect(toast.getAttribute('aria-live')).toBe('polite');
    expect(toast.textContent).toMatch(/^สำเร็จ:/);
    fireEvent.click(screen.getByRole('button', { name: 'ปิด' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('danger toast starts with "ผิดพลาด:"', () => {
    render(<Toast tone="danger">ส่งไม่สำเร็จ</Toast>);
    expect(screen.getByRole('status').textContent).toMatch(/^ผิดพลาด:/);
  });
});

describe('EmptyState / ErrorState / Skeleton', () => {
  it('EmptyState shows its title, text and action', () => {
    const onClick = vi.fn();
    render(<EmptyState title="ยังไม่มีเกม" action={<Button onClick={onClick}>สร้างเกมใหม่</Button>}>ใส่โค้ดเกมเพื่อเข้าร่วม</EmptyState>);
    expect(screen.getByRole('heading', { name: 'ยังไม่มีเกม' })).toBeTruthy();
    expect(screen.getByText('ใส่โค้ดเกมเพื่อเข้าร่วม')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'สร้างเกมใหม่' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('ErrorState is an alert with the message and a retry button', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="ต่อ server ไม่ได้" onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('ต่อ server ไม่ได้');
    fireEvent.click(screen.getByRole('button', { name: 'ลองอีกครั้ง' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('Skeleton is a busy status named "กำลังโหลด…" by default', () => {
    render(<Skeleton lines={3} />);
    const skeleton = screen.getByRole('status', { name: 'กำลังโหลด…' });
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    expect(skeleton.querySelectorAll('.skeleton__line')).toHaveLength(3);
  });

  it('Skeleton takes its own label', () => {
    render(<Skeleton label="AI กำลังอ่านบุคลิกของคุณ…" />);
    expect(screen.getByRole('status', { name: 'AI กำลังอ่านบุคลิกของคุณ…' })).toBeTruthy();
  });
});

describe('Panel / MaskIcon', () => {
  it('Panel is a labelled section; private audience gets its own class; ornament corners are hidden from readers', () => {
    const { rerender } = render(
      <Panel title="ทุกคนที่ลานตลาดเห็น">
        <p>feed</p>
      </Panel>,
    );
    const panel = screen.getByRole('region', { name: 'ทุกคนที่ลานตลาดเห็น' });
    expect(panel.className).toContain('panel');
    expect(panel.className).toContain('panel--ornament');
    rerender(
      <Panel title="เห็นคนเดียว" audience="private">
        <p>narration</p>
      </Panel>,
    );
    expect(screen.getByRole('region', { name: 'เห็นคนเดียว' }).className).toContain('panel--private');
  });

  it('Panel can drop the ornament', () => {
    render(
      <Panel title="สรุป" ornament={false}>
        x
      </Panel>,
    );
    expect(screen.getByRole('region', { name: 'สรุป' }).className).not.toContain('panel--ornament');
  });

  it('MaskIcon paints an SVG with currentColor through mask-image and is aria-hidden', () => {
    const { container } = render(<MaskIcon src="/icons/eye.svg" />);
    const icon = container.firstElementChild as HTMLElement;
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.className).toContain('icon');
    expect(icon.style.getPropertyValue('--icon')).toBe('url("/icons/eye.svg")');
  });
});
