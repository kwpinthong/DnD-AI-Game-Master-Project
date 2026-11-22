import type { SourceRank } from '@isekai/rules';

/**
 * The Start_Scenarios rows whose Passive is a rule the server keeps (GEN-065), by the sheet Name (the key
 * the whole asset layer uses). The other rows' Passive is a d20 bonus through tag matching (`passive`
 * columns, Q-090) or text for the AI GM.
 */
export interface StartRule {
  /** Chronic illness: successful treatments (HEAL / CLEANSE on the player) before it is gone. */
  readonly illnessTreatments?: number;
  /** May enter every RESTRICTED_AREA place, not only the own spawn place. */
  readonly restrictedAccess?: boolean;
  /** Real name of the scenario NPC the player has met from the start. */
  readonly meetsNpc?: string;
  readonly knowsDay12Secret?: boolean;
  /** Resists curses up to this rank. */
  readonly curseResistRank?: SourceRank;
}

export const START_RULES: Readonly<Record<string, StartRule>> = {
  // "ดีบัพ: โรคเรื้อรัง (ต้องรักษา 2 ครั้งจึงหาย) แต่รวยมากและเข้าเขตหวงห้ามได้"
  'คุณชาย/คุณหนูขี้โรค': { illnessTreatments: 2, restrictedAccess: true },
  // "พบ แอสทรา (S) ทันที, รู้ความลับวันที่ 12 และต้านทานคำสาประดับ B"
  'ผู้หลงทางเหนือกาลเวลา': { meetsNpc: 'แอสทรา', knowsDay12Secret: true, curseResistRank: 'B' },
};

/** Verbs that count as a treatment of the chronic illness when the action succeeds. */
export const TREATMENT_VERBS: readonly string[] = ['HEAL', 'CLEANSE'];

export const CHRONIC_ILLNESS_LABEL = 'โรคเรื้อรัง';
