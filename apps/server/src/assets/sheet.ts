/**
 * `pnpm assets:import` (GEN-062): reads every known tab of the sheet as CSV through its public
 * link (Q-086: "anyone with the link can view", no key, no login) and writes one JSON file per tab.
 *
 * Tabs are found by name on the sheet's /htmlview page, then each is read from
 * /export?format=csv&gid=<gid>. (The gviz CSV endpoint is not used: it answers the first tab for a
 * tab name that does not exist, and drops cells whose type differs from the rest of the column.)
 *
 * Nothing is written unless every tab was read and the whole sheet passed: a failure leaves the
 * JSON already in the repo as it was.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertSheet, formatIssue } from './import.ts';
import { ALL_TABS, OPTIONAL_TABS, TAB_FILES, withEnglishDrafts, type TabName } from './model.ts';

/** The old file's JSON, or undefined when there is none or it is broken (then it is simply replaced, as before). */
function parseOrUndefined(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** "Asset Isekai v1.0 (Nok working copy)". */
export const DEFAULT_SHEET_ID = '1o3wUWJn6nKQmA9S1zKGcj9l6zIgtxlQmWgVPxAs_Q1M';

export class SheetUnreachableError extends Error {
  constructor(message: string) {
    super(`${message} — ไม่ได้เขียนไฟล์ JSON (ไฟล์เดิมยังอยู่ครบ)`);
    this.name = 'SheetUnreachableError';
  }
}

export class AssetImportError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`ชีทมีข้อผิดพลาด ${issues.length} จุด ไม่ได้เขียนไฟล์ JSON:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'AssetImportError';
    this.issues = issues;
  }
}

export interface ImportReport {
  importedTabs: TabName[];
  /** Records per imported tab. */
  counts: Partial<Record<TabName, number>>;
  missingTabs: TabName[];
  tabsWithoutEffectColumns: TabName[];
  warnings: string[];
  /** File names written or removed (empty when the sheet did not change). */
  changedFiles: string[];
}

type FetchLike = (input: string | URL) => Promise<Response>;

export interface ImportOptions {
  sheetId: string;
  outDir: string;
  fetch?: FetchLike;
}

const SHARE_HINT = 'ตรวจว่าชีทแชร์แบบ "ทุกคนที่มีลิงก์ดูได้" (Q-086) และ id ถูกต้อง';

async function get(fetchImpl: FetchLike, url: string, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new SheetUnreachableError(`เข้าถึงชีทไม่ได้ขณะอ่าน${what} (${error instanceof Error ? error.message : String(error)}): ตรวจการเชื่อมต่อ network`);
  }
  if (!response.ok) {
    throw new SheetUnreachableError(`เข้าถึงชีทไม่ได้ขณะอ่าน${what} (HTTP ${response.status}): ${SHARE_HINT}`);
  }
  return response;
}

/** Tab name → gid, from the htmlview page's `items.push({name: "...", ..., gid: "..."})` list. */
function listTabs(html: string): Map<string, string> {
  const tabs = new Map<string, string>();
  const pattern = /items\.push\(\{name: "((?:[^"\\]|\\.)*)", pageUrl: "(?:[^"\\]|\\.)*", gid: "(\d+)"/g;
  for (const [, rawName, gid] of html.matchAll(pattern)) {
    const name = JSON.parse(`"${rawName!.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')}"`) as string;
    if (!tabs.has(name)) tabs.set(name, gid!);
  }
  return tabs;
}

export async function runAssetImport(options: ImportOptions): Promise<ImportReport> {
  const fetchImpl = options.fetch ?? ((input) => fetch(input));
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(options.sheetId)}`;

  const page = await get(fetchImpl, `${base}/htmlview`, 'รายชื่อแท็บ');
  const tabs = listTabs(await page.text());
  if (tabs.size === 0) {
    throw new SheetUnreachableError(`อ่านรายชื่อแท็บจาก ${base}/htmlview ไม่ได้: ${SHARE_HINT}`);
  }

  const csvByTab: Partial<Record<TabName, string>> = {};
  for (const tab of ALL_TABS) {
    const gid = tabs.get(tab);
    if (gid === undefined) continue;
    const response = await get(fetchImpl, `${base}/export?format=csv&gid=${gid}`, `แท็บ ${tab}`);
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('text/csv')) {
      throw new SheetUnreachableError(`แท็บ ${tab} ไม่ได้ตอบเป็น CSV (content-type "${type}"): ${SHARE_HINT}`);
    }
    csvByTab[tab] = await response.text();
  }

  const result = convertSheet(csvByTab);
  if (!result.ok) throw new AssetImportError(result.errors.map(formatIssue));

  // Write every file to a temp name first, then rename: a crash mid-way never leaves a mix.
  mkdirSync(options.outDir, { recursive: true });
  const changedFiles: string[] = [];
  const staged: Array<{ temp: string; target: string }> = [];
  for (const tab of result.importedTabs) {
    const file = TAB_FILES[tab];
    const target = join(options.outDir, file);
    // Line endings ignored: a Windows checkout (core.autocrlf) holds the same file with CRLF.
    const before = existsSync(target) ? readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : undefined;
    // GEN-165: the sheet has no English columns, so the file's English drafts are kept.
    const content = `${JSON.stringify(withEnglishDrafts(tab, result.files[tab], parseOrUndefined(before)), null, 2)}\n`;
    if (before === content) continue;
    const temp = `${target}.tmp`;
    writeFileSync(temp, content);
    staged.push({ temp, target });
    changedFiles.push(file);
  }
  for (const { temp, target } of staged) renameSync(temp, target);
  // An optional tab gone from the sheet must not leave stale data the server would still load.
  for (const tab of result.missingTabs) {
    const target = join(options.outDir, TAB_FILES[tab]);
    if ((OPTIONAL_TABS as readonly string[]).includes(tab) && existsSync(target)) {
      rmSync(target);
      changedFiles.push(TAB_FILES[tab]);
    }
  }

  return {
    importedTabs: result.importedTabs,
    counts: Object.fromEntries(result.importedTabs.map((t) => [t, result.files[t]!.length])),
    missingTabs: result.missingTabs,
    tabsWithoutEffectColumns: result.tabsWithoutEffectColumns,
    warnings: result.warnings.map(formatIssue),
    changedFiles,
  };
}
