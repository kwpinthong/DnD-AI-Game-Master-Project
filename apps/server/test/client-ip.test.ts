import { describe, expect, it } from 'vitest';
import { clientIp, maskIp } from '../src/auth/client-ip.ts';

describe('Q-170 client IP', () => {
  it('is the first hop of X-Forwarded-For (Railway), trimmed', () => {
    expect(clientIp('203.0.113.5, 10.0.0.1, 10.0.0.2', '10.0.0.9')).toBe('203.0.113.5');
    expect(clientIp(' 2001:db8::1 ', '10.0.0.9')).toBe('2001:db8::1');
    // Node gives a repeated header as an array: the first one wins.
    expect(clientIp(['198.51.100.7, 10.0.0.1', '1.2.3.4'], '10.0.0.9')).toBe('198.51.100.7');
  });

  it('falls back to the socket address when the header is missing or empty', () => {
    expect(clientIp(undefined, '127.0.0.1')).toBe('127.0.0.1');
    expect(clientIp('', '::ffff:127.0.0.1')).toBe('::ffff:127.0.0.1');
    expect(clientIp(' , 10.0.0.1', '127.0.0.1')).toBe('127.0.0.1');
    expect(clientIp(undefined, undefined)).toBe('unknown');
  });

  it('a masked IP keeps only the network part, for logs', () => {
    expect(maskIp('203.0.113.5')).toBe('203.0.113.x');
    expect(maskIp('::ffff:127.0.0.1')).toBe('::ffff:127.0.0.x');
    expect(maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:85a3:x');
    expect(maskIp('unknown')).toBe('x');
  });
});
