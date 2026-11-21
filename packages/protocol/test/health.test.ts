import { describe, expect, it } from 'vitest';
import { HealthResponse } from '../src/index.ts';

describe('HealthResponse', () => {
  it('accepts a connected and a failed database report', () => {
    expect(HealthResponse.parse({ ok: true, db: 'connected' })).toEqual({ ok: true, db: 'connected' });
    expect(HealthResponse.parse({ ok: false, db: 'error' })).toEqual({ ok: false, db: 'error' });
  });

  it('rejects a body without a known db status', () => {
    expect(HealthResponse.safeParse({ ok: true }).success).toBe(false);
    expect(HealthResponse.safeParse({ ok: true, db: 'maybe' }).success).toBe(false);
  });
});
