import { PERIODS } from '@isekai/rules';

/**
 * GEN-183: the enum values of the game data sets (apps/server/assets, edited at /admin). The server's asset
 * schemas and the admin form both read these. Asset weathers are wider than the live `WEATHERS` of weather.ts.
 */
export const ASSET_RANKS = ['F', 'B', 'A', 'S', 'SS'] as const;
export const ASSET_ALIGNMENTS = ['Good', 'Evil', 'Neutral'] as const;
export const ASSET_PERIODS = PERIODS;
export const ASSET_WEATHERS = ['Clear', 'Clear Morning', 'Clear Night', 'Rain', 'Storm', 'Fog', 'Dark Night', 'Disaster'] as const;
