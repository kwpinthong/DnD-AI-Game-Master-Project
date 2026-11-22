import {
  PHASES,
  PHASE_LABEL,
  RoomActionCode,
  RoomClientMessage,
  RoomHello,
  RoomOmen,
  WEATHERS,
  actionTextProblem,
  normalizeActionText,
  type RoomEntry,
  type RoomState,
} from '@isekai/protocol';
import { CONTRACT_FIXTURES as F } from '@isekai/protocol/contract';
import { HIT_ENTRY, WHISPER_ENTRY, type MockOp, type MockScenario, type MockStep } from './scenarios.ts';

/** One open socket as the mock server sees it. */
export interface MockPeer {
  deliver(message: unknown): void;
  /** The server closes this socket (the client reconnects by itself). */
  drop(): void;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * The mock play room (GEN-100), one per mock base URL: it answers `hello` like the server (room, the entries
 * after `afterSeq`, ready), answers the client messages, plays the scenario's script in order and takes the
 * gallery's simulate buttons. Everything it sends is a fixture or a fixture with the turn moved on; C4 parses
 * all of it against `RoomServerMessage`.
 */
export class MockRoomServer {
  readonly scenario: MockScenario;
  private state: RoomState;
  private entries: RoomEntry[];
  private seq: number;
  private readonly peers = new Set<MockPeer>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly timeScale: number;
  private scriptStarted = false;

  constructor(scenario: MockScenario, { timeScale = 1 }: { timeScale?: number } = {}) {
    this.scenario = scenario;
    this.timeScale = timeScale;
    this.state = clone(scenario.room.state);
    this.entries = clone([...scenario.room.entries]);
    this.seq = Math.max(0, ...this.entries.map((e) => e.seq));
  }

  /** A socket's first message. */
  hello(peer: MockPeer, raw: unknown): void {
    const hello = RoomHello.safeParse(raw);
    if (!hello.success) {
      peer.deliver({ type: 'error', code: 'bad_message', message: 'ข้อความแรกต้องเป็น hello' });
      peer.drop();
      return;
    }
    this.peers.add(peer);
    peer.deliver(clone(this.state));
    for (const entry of this.entries) if (entry.seq > hello.data.afterSeq) peer.deliver({ type: 'entry', entry });
    peer.deliver({ type: 'ready', lastSeq: this.seq });
    if (!this.scriptStarted) this.startScript(this.scenario.room.script);
  }

  receive(peer: MockPeer, raw: unknown): void {
    const omen = RoomOmen.safeParse(raw);
    if (omen.success) return this.omen(peer);
    const parsed = RoomClientMessage.safeParse(raw);
    if (!parsed.success) return peer.deliver({ type: 'error', code: 'bad_message', message: 'ข้อความไม่ถูกต้อง' });
    const message = parsed.data;
    switch (message.type) {
      case 'hello':
        return this.hello(peer, message);
      case 'action':
        return this.action(peer, message.text, message.visibility, message.rest, message.train);
      case 'whisper':
        return this.whisper(peer, message.to, message.text);
      case 'retry':
        this.state.gmStatus = null;
        return this.broadcastState();
      case 'move':
        peer.deliver(F.RoomMoveAccepted[0]);
        this.state.you.place = clone(F.RoomMoveAccepted[0]!.place);
        return this.broadcastState();
    }
  }

  leave(peer: MockPeer): void {
    this.peers.delete(peer);
  }

  run(op: MockOp): void {
    this[op]();
  }

  // --- the simulate buttons ---

  /** Turn 1 → 2, then the next period (new weather), NOCTHERION → the next day. */
  nextTurn(): void {
    const s = this.state;
    if (s.turn === 1) s.turn = 2;
    else {
      s.turn = 1;
      const i = PHASES.indexOf(s.phase);
      if (i === PHASES.length - 1) {
        s.day += 1;
        s.you.secretUsed = false;
      }
      s.phase = PHASES[(i + 1) % PHASES.length]!;
      const w = s.weather ? WEATHERS.indexOf(s.weather.weather) : -1;
      s.weather = { weather: WEATHERS[(w + 1) % WEATHERS.length]!, disaster: s.day >= 5 };
    }
    s.status = 'collecting';
    s.you.action = null;
    if (s.you.lock?.code === 'resolving') s.you.lock = null;
    s.members = s.members.map((m) => (m.submitted === undefined ? m : { ...m, submitted: false }));
    s.submittedCount = 0;
    this.broadcastState();
    this.addEntry({ kind: 'feed', place: null, text: `ประกาศ: เริ่ม ${PHASE_LABEL[s.phase]} เทิร์น ${s.turn}` });
  }

  /** Another player's act lands on you: the pinned hit of the fixtures. */
  hit(): void {
    this.addEntry({ kind: 'hit', place: HIT_ENTRY.place, text: HIT_ENTRY.text, ...(HIT_ENTRY.hit ? { hit: clone(HIT_ENTRY.hit) } : {}) });
  }

  /** One more player sends this turn's action. */
  othersSubmit(): void {
    const players = this.state.members.filter((m) => m.role === 'player').length;
    this.state.submittedCount = Math.min(players, this.state.submittedCount + 1);
    this.broadcastState();
  }

  /** The turn closes and the GM works it out. */
  closeTurn(): void {
    const s = this.state;
    s.status = 'resolving';
    s.you.lock ??= { code: 'resolving', message: `กำลังสรุปผล ${s.phase} เทิร์น ${s.turn}…` };
    this.broadcastState();
  }

  /** Every socket drops; something happens meanwhile, which the reconnect replays. */
  drop(): void {
    for (const peer of [...this.peers]) peer.drop();
    this.peers.clear();
    this.addEntry({ kind: 'feed', place: this.state.you.place, text: 'ระหว่างที่คุณหลุด: ทหารยามเดินผ่านน้ำพุไปทางโบสถ์' });
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // --- internals ---

  private startScript(script: readonly MockStep[]): void {
    this.scriptStarted = true;
    for (const step of script) {
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.run(step.op);
      }, step.afterMs * this.timeScale);
      this.timers.add(t);
    }
  }

  private broadcast(message: unknown): void {
    for (const peer of this.peers) peer.deliver(message);
  }

  private broadcastState(): void {
    this.broadcast(clone(this.state));
  }

  private addEntry(fields: Pick<RoomEntry, 'kind' | 'place' | 'text'> & Partial<RoomEntry>): void {
    const { day, phase, turn } = this.state;
    const entry: RoomEntry = { ...fields, seq: ++this.seq, day, phase, turn };
    this.entries.push(entry);
    this.broadcast({ type: 'entry', entry });
  }

  private reject(peer: MockPeer, code: RoomActionCode, message: string): void {
    peer.deliver({ type: 'action_rejected', code, message });
  }

  private action(peer: MockPeer, text: string, visibility: string, rest: boolean, train: boolean): void {
    const you = this.state.you;
    if (you.role !== 'player') return this.reject(peer, 'not_a_player', 'GM ไม่มีตัวละคร');
    if (you.lock) {
      const code = RoomActionCode.safeParse(you.lock.code);
      return this.reject(peer, code.success ? code.data : 'invalid_action', you.lock.message);
    }
    const problem = actionTextProblem(text);
    if (problem) return this.reject(peer, problem.code, problem.message);
    if (visibility !== 'public' && visibility !== 'secret') return this.reject(peer, 'invalid_action', 'เลือก Public หรือ Secret');
    if (visibility === 'secret' && you.secretUsed) return peer.deliver(F.RoomActionRejected[0]);
    you.action = { text: normalizeActionText(text), visibility, rest, ...(train ? { train: true as const } : {}) };
    if (visibility === 'secret') you.secretUsed = true;
    const me = this.state.members.find((m) => m.memberId === you.memberId);
    if (me && !me.submitted) {
      me.submitted = true;
      this.state.submittedCount += 1;
    }
    peer.deliver({ type: 'action_accepted' });
    this.broadcastState();
  }

  private whisper(peer: MockPeer, to: string, text: string): void {
    const ally = this.state.you.allies.find((a) => a.ref === to);
    const problem = actionTextProblem(text);
    if (!ally) return peer.deliver(F.RoomWhisperRejected[0]);
    if (problem) return peer.deliver({ type: 'whisper_rejected', code: problem.code, message: problem.message });
    peer.deliver({ type: 'whisper_accepted' });
    this.addEntry({ kind: 'whisper', place: null, text: normalizeActionText(text), whisper: { from: WHISPER_ENTRY.whisper?.from ?? 'คุณ', to: ally.name, mine: true } });
  }

  private omen(peer: MockPeer): void {
    const astral = this.state.you.astral;
    if (!astral?.omen.canSend) return peer.deliver(F.RoomOmenRejected[0]);
    astral.omen.canSend = false;
    peer.deliver(F.RoomOmenAccepted[0]);
    this.broadcastState();
  }
}
