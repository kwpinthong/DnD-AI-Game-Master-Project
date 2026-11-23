import { ASSET_ALIGNMENTS, ASSET_PERIODS, ASSET_RANKS, ASSET_WEATHERS } from '@isekai/protocol';
import { describe, expect, it } from 'vitest';
import { ALIGNMENTS, PERIODS, RANKS, WEATHERS } from '../src/assets/model.ts';

// GEN-183: the asset schema and the admin form read the same enums from @isekai/protocol.
describe('asset enums (GEN-183)', () => {
  it('C1: the server model uses the @isekai/protocol enums themselves', () => {
    expect(PERIODS).toBe(ASSET_PERIODS);
    expect(WEATHERS).toBe(ASSET_WEATHERS);
    expect(RANKS).toBe(ASSET_RANKS);
    expect(ALIGNMENTS).toBe(ASSET_ALIGNMENTS);
  });
});
