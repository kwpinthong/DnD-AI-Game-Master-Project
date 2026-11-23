import { LearningType, type LearningEntryView, type LearningLibraryResponse } from '@isekai/protocol';
import { desc, ne } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { learningEntry } from '../db/schema.ts';

/**
 * GEN-084: the server owner's Learning library: every entry not deleted, newest first, in the shape of the page. The
 * style entry's `playerKey` stays here; a voted example's ruling fields are null for a message.
 */

type Row = typeof learningEntry.$inferSelect;

function viewOf(r: Row): LearningEntryView | null {
  const d = JSON.parse(r.detail) as Record<string, unknown>;
  const tags = JSON.parse(r.tags) as string[];
  const base = { id: String(r.id), sourceGameId: r.sourceGameId, sourceGameName: r.sourceGameName, sourceScore: r.sourceScore, content: r.content, tags, status: r.status === 'suspended' ? 'suspended' : 'active', createdAt: r.createdAt } as const;
  switch (r.type) {
    case 'lore':
      return { ...base, type: 'lore', detail: { endingPath: d.endingPath as 'good', npcIds: (d.npcIds as string[] | undefined) ?? [] } };
    case 'feedback_note':
      return { ...base, type: 'feedback_note', detail: { fromComments: d.fromComments as number } };
    case 'good_example':
    case 'avoid': {
      const ruling = d.kind === 'ruling';
      const detail = {
        sourceRef: r.sourceRef,
        kind: d.kind as 'narration',
        npcId: (d.npcId as string | null | undefined) ?? null,
        up: d.up as number,
        down: d.down as number,
        players: d.players as number,
        dcLabel: ruling ? ((d.dcLabel as string | null) ?? null) : null,
        d20: ruling ? ((d.d20 as number | null) ?? null) : null,
        result: ruling ? (d.result as 'success') : null,
      };
      return r.type === 'avoid' ? { ...base, type: 'avoid', detail } : { ...base, type: 'good_example', detail };
    }
    case 'style': {
      const actions = (d.actions as number) || 0;
      return { ...base, type: 'style', detail: { topVerbs: tags, secretShare: actions === 0 ? 0 : (d.secret as number) / actions } };
    }
    default:
      return null;
  }
}

export function learningLibrary(db: DbOrTx): LearningLibraryResponse {
  const entries = db
    .select()
    .from(learningEntry)
    .where(ne(learningEntry.status, 'deleted'))
    .orderBy(desc(learningEntry.createdAt), desc(learningEntry.id))
    .all()
    .flatMap((r) => viewOf(r) ?? []);
  const counts = Object.fromEntries(LearningType.options.map((t) => [t, entries.filter((e) => e.type === t).length])) as LearningLibraryResponse['counts'];
  return { entries, counts };
}
