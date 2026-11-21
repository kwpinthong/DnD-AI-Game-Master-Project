import { describe, expect, it } from 'vitest';
import { SRD_VERSION } from '../src/index.ts';

describe('@dnd/srd', () => {
  it('names the SRD release the data comes from', () => {
    expect(SRD_VERSION).toBe('srd-5.1');
  });
});
