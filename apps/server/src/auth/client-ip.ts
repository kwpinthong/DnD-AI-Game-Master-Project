/**
 * The client's IP for per-client limits (Q-170). On Railway the edge proxy puts the client first in
 * X-Forwarded-For, so its first hop is the client (Nok's call: trust it); without the header (local
 * runs, tests) the socket address is. A client can still fake the header when reaching the server
 * without the proxy in front, which is why only the admin code (not the create code) counts this way.
 */
export function clientIp(forwardedFor: string | string[] | undefined, socketAddress: string | undefined): string {
  const header = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const first = header?.split(',')[0]?.trim();
  if (first) return first;
  return socketAddress?.trim() || 'unknown';
}

/** An IP for logs: the last IPv4 octet, or everything after the first three IPv6 groups, is hidden. */
export function maskIp(ip: string): string {
  const v4 = /^(.*\d+\.\d+\.\d+)\.\d+$/.exec(ip);
  if (v4) return `${v4[1]}.x`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}:x`;
  return 'x';
}
