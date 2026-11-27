/**
 * AI text carries {{p:memberId}} / {{n:id}} tokens, never real names (Q-045). A text shown to ONE player
 * about their own character (traits GEN-048, the origin narration GEN-065) resolves at render time, so a
 * renamed character shows the new name: their own token is the character name, any other token (another
 * player, an unknown id) a neutral word, so no name the reader may not know leaks (GEN-067).
 * The GM feed / ending have their own fog-of-war renderers (gm/loop.ts `renderTokens`, gm/finale.ts).
 */
export const UNKNOWN_PERSON = 'ใครบางคน';

/** How a player is written when the AI did not use their token: the whole look, the title, and (chips, ISK-006) each chip part of the look. */
export interface Looks {
  appearance: string;
  title: string;
  parts: readonly string[];
}

const QUOTED = /("[^"\n]*"|“[^”]*”)/;
const ATTACHED = /^[\p{L}\p{M}\p{N}]/u;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * ISK-008: the reader's own look / title written as text (outside quotes: what someone says stays) is "คุณ", with no
 * space around it (GEN-143). Never what another player's look or title also holds: it may be them. Q-379 A: a chip
 * part with a word attached right after it ("ผมยาวสีดำสลวย") describes, it is not the person, so it stays. The title
 * too: Social Titles are everyday words ("คนแปลกหน้าในชุดคลุม" may be an NPC).
 */
export function youInText(text: string, me: Looks, others: readonly Omit<Looks, 'parts'>[]): string {
  const shared = (s: string) => others.some((o) => o.appearance.includes(s) || o.title.includes(s));
  const look = me.appearance.trim();
  const loose = new Set([me.title.trim(), ...me.parts].filter((s) => s.length > 0 && s !== look && !shared(s)));
  const all = [...new Set([...(look.length > 0 && !shared(look) ? [look] : []), ...loose])].sort((a, b) => b.length - a.length);
  if (all.length === 0) return text;
  const looks = new RegExp(`[ \\t]*(${all.map(escapeRe).join('|')})[ \\t]*`, 'gu');
  const replace = (chunk: string) =>
    chunk.replace(looks, (found: string, m: string, at: number) => (loose.has(m) && found.endsWith(m) && ATTACHED.test(chunk.slice(at + found.length)) ? found : 'คุณ'));
  return text
    .split(QUOTED)
    .map((chunk, i) => (i % 2 === 1 ? chunk : replace(chunk)))
    .join('');
}

export function resolveOwnTokens(text: string, ownMemberId: string, characterName: string): string {
  return text.split(`{{p:${ownMemberId}}}`).join(characterName).replace(/\{\{[pn]:[^}]*\}\}/g, UNKNOWN_PERSON);
}
