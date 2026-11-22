/**
 * AI text carries {{p:memberId}} / {{n:id}} tokens, never real names (Q-045). A text shown to ONE player
 * about their own character (traits GEN-048, the origin narration GEN-065) resolves at render time, so a
 * renamed character shows the new name: their own token is the character name, any other token (another
 * player, an unknown id) a neutral word, so no name the reader may not know leaks (GEN-067).
 * The GM feed / ending have their own fog-of-war renderers (gm/loop.ts `renderTokens`, gm/finale.ts).
 */
export const UNKNOWN_PERSON = 'ใครบางคน';

export function resolveOwnTokens(text: string, ownMemberId: string, characterName: string): string {
  return text.split(`{{p:${ownMemberId}}}`).join(characterName).replace(/\{\{[pn]:[^}]*\}\}/g, UNKNOWN_PERSON);
}
