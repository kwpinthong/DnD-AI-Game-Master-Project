import { describe, expect, it } from 'vitest';
import { validateProposal, type ResolutionState } from '../src/index.ts';
import { baseState, proposal } from './resolution-fixtures.ts';

/** GEN-184: an NPC whose schedule depends on karma can be at another place for one actor (`placeFor`). */
describe('GEN-184 NPC presence per actor', () => {
  const withPlaceFor = (npcId: string, placeFor: Record<string, string>): ResolutionState => {
    const s = baseState();
    return { ...s, npcs: { ...s.npcs, [npcId]: { ...s.npcs[npcId]!, placeFor } } };
  };
  const codes = (state: ResolutionState, npc: string) => validateProposal(state, proposal({ target: { npc } })).map((e) => e.code);

  it('C1: an NPC elsewhere for everyone but here for this actor can be targeted', () => {
    expect(codes(withPlaceFor('npc-far', { 'pc-lin': 'market' }), 'npc-far')).toEqual([]);
  });

  it('C2: an NPC here for everyone but elsewhere for this actor is npc_not_present', () => {
    expect(codes(withPlaceFor('npc-guard', { 'pc-lin': '' }), 'npc-guard')).toContain('npc_not_present');
  });

  it('another actor\'s place does not count for this actor', () => {
    expect(codes(withPlaceFor('npc-guard', { 'pc-other': '' }), 'npc-guard')).toEqual([]);
  });
});
