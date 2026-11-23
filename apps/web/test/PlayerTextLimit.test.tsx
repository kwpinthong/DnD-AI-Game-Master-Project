// ISK-012: the four boxes a player types into (action and Whisper, desktop and phone) stop at 200 code points after trim.
import { PLAYER_TEXT_MAX, RoomState } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionBar, EMPTY_DRAFT, type ActionDraft } from '../src/play/chat/ActionBar.tsx';
import { limitPlayerText } from '../src/play/chat/chat-model.ts';
import { Whispers } from '../src/play/PrivateColumn.tsx';

afterEach(cleanup);

const room = RoomState.parse(CONTRACT_FIXTURES.RoomState[0]);
const CUT = `ตัดเหลือ ${PLAYER_TEXT_MAX} ตัว`;

function Bar({ compact }: { compact: boolean }) {
  const [draft, setDraft] = useState<ActionDraft>(EMPTY_DRAFT);
  return <ActionBar room={room} seenBy={3} draft={draft} setDraft={setDraft} problem={undefined} sending={false} onSend={() => {}} onRetry={() => {}} compact={compact} />;
}

function WhisperBox() {
  const [text, setText] = useState('');
  return <Whispers whispers={[]} allies={[{ ref: 'ref-darin', name: 'ดาริน' }]} canSend problem={undefined} onSend={() => {}} text={text} setText={setText} />;
}

describe('limitPlayerText', () => {
  it('C4: 250 pasted becomes 200 and says it was cut; 200 is left alone', () => {
    expect(limitPlayerText('ก'.repeat(250))).toEqual({ text: 'ก'.repeat(200), cut: true });
    expect(limitPlayerText('ก'.repeat(200))).toEqual({ text: 'ก'.repeat(200), cut: false });
  });

  it('C7: spaces before and after do not count', () => {
    const padded = `  ${'ก'.repeat(200)}  `;
    expect(limitPlayerText(padded)).toEqual({ text: padded, cut: false });
  });

  it('C3: counts code points like the server (a tone mark is one)', () => {
    expect(limitPlayerText('ก่'.repeat(100)).cut).toBe(false);
    expect([...limitPlayerText('ก่'.repeat(101)).text].length).toBe(200);
  });

  it('C9: when the 201st code point is a tone mark, the cut goes before its consonant (no floating mark)', () => {
    const pasted = `${'ก'.repeat(199)}ก่${'ข'.repeat(50)}`; // 200th = ก, 201st = ่
    expect(limitPlayerText(pasted)).toEqual({ text: 'ก'.repeat(199), cut: true });
    const vowelAndTone = `${'ก'.repeat(198)}กี่ข`; // ก ี ่ are 199-201: one grapheme
    expect(limitPlayerText(vowelAndTone).text).toBe('ก'.repeat(198));
  });
});

describe.each([
  ['desktop', false],
  ['phone', true],
])('C4/C5: the action box (%s)', (_name, compact) => {
  it('shows x/200, stops at 200 and says so when a long paste is cut', () => {
    render(<Bar compact={compact} />);
    const box = screen.getByLabelText('พิมพ์สิ่งที่จะทำ') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'ก'.repeat(10) } });
    expect(screen.getByText(`10/${PLAYER_TEXT_MAX}`)).toBeTruthy();
    expect(screen.queryByText(CUT)).toBeNull();

    fireEvent.change(box, { target: { value: 'ก'.repeat(250) } });
    expect(box.value).toBe('ก'.repeat(200));
    expect(screen.getByText(`200/${PLAYER_TEXT_MAX}`)).toBeTruthy();
    expect(screen.getByText(CUT)).toBeTruthy();

    // One more letter at 200 does not go in.
    fireEvent.change(box, { target: { value: `${'ก'.repeat(200)}ข` } });
    expect(box.value).toBe('ก'.repeat(200));

    // C5: the counter is under the box, not in the row with the box and [ส่ง], so it cannot push them off a 390 screen.
    expect(screen.getByText(`200/${PLAYER_TEXT_MAX}`).closest('.chat-compose')).toBeNull();
  });
});

describe('C4: the Whisper box (the same component on desktop and in the phone sheet)', () => {
  it('shows x/200, stops at 200 and says so when a long paste is cut', () => {
    render(<WhisperBox />);
    const form = screen.getByRole('form', { name: 'ส่ง Whisper' });
    const box = within(form).getByLabelText('ข้อความ Whisper') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'ข'.repeat(5) } });
    expect(within(form).getByText(`5/${PLAYER_TEXT_MAX}`)).toBeTruthy();
    fireEvent.change(box, { target: { value: 'ข'.repeat(250) } });
    expect(box.value).toBe('ข'.repeat(200));
    expect(within(form).getByText(`200/${PLAYER_TEXT_MAX}`)).toBeTruthy();
    expect(within(form).getByText(CUT)).toBeTruthy();
  });

  it('the cut notice goes when the box is emptied (after a send)', () => {
    // Like PlayRoom: a send empties the box from outside.
    function Cleared() {
      const [text, setText] = useState('');
      return <Whispers whispers={[]} allies={[{ ref: 'r', name: 'ดาริน' }]} canSend problem={undefined} onSend={() => setText('')} text={text} setText={setText} />;
    }
    render(<Cleared />);
    fireEvent.change(screen.getByLabelText('ข้อความ Whisper'), { target: { value: 'ข'.repeat(250) } });
    expect(screen.getByText(CUT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง Whisper' }));
    expect(screen.queryByText(CUT)).toBeNull();
    expect(screen.getByText(`0/${PLAYER_TEXT_MAX}`)).toBeTruthy();
  });
});
