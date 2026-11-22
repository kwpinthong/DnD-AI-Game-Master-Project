/**
 * `pnpm assets:import` — sheet → apps/server/assets/*.json (GEN-062).
 * Optional: ASSET_SHEET_ID=<id> to read another copy of the sheet.
 * Prints tab names, record counts and issues only; never the data itself.
 */
import { DEFAULT_ASSETS_DIR } from './load.ts';
import { DEFAULT_SHEET_ID, runAssetImport } from './sheet.ts';

const sheetId = process.env.ASSET_SHEET_ID?.trim() || DEFAULT_SHEET_ID;

try {
  const report = await runAssetImport({ sheetId, outDir: DEFAULT_ASSETS_DIR });
  console.log(`[assets:import] imported ${report.importedTabs.length} tabs into ${DEFAULT_ASSETS_DIR}`);
  for (const tab of report.importedTabs) console.log(`  ${tab}: ${report.counts[tab]} records`);
  if (report.missingTabs.length > 0) console.log(`[assets:import] optional tabs not in the sheet: ${report.missingTabs.join(', ')}`);
  if (report.tabsWithoutEffectColumns.length > 0) {
    console.log(`[assets:import] tabs without Effect_Type / Stat / Value / Duration columns (Q-090): ${report.tabsWithoutEffectColumns.join(', ')}`);
  }
  for (const warning of report.warnings) console.log(`[assets:import] warning: ${warning}`);
  console.log(
    report.changedFiles.length > 0
      ? `[assets:import] changed: ${report.changedFiles.join(', ')}`
      : '[assets:import] no changes (the sheet matches the JSON in the repo)',
  );
} catch (error) {
  console.error(`[assets:import] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
