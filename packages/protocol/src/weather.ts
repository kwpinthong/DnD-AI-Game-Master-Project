import { z } from 'zod';

/**
 * The weather of a period (GEN-068), as everyone in the town sees it. Same values as `WEATHERS` in
 * `@isekai/rules`, which holds the rules. Disaster is not a weather the AI picks: it holds from day 5 on.
 */
export const WEATHERS = ['Clear', 'Rain', 'Fog', 'Dark Night', 'Clear Night', 'Storm'] as const;
export const Weather = z.enum(WEATHERS);
export type Weather = z.infer<typeof Weather>;

export const WEATHER_LABEL: Readonly<Record<Weather, string>> = {
  Clear: 'แดดจ้า',
  Rain: 'ฝนตก',
  Fog: 'หมอกจัด',
  'Dark Night': 'คืนเดือนมืด',
  'Clear Night': 'คืนฟ้าโปร่ง',
  Storm: 'พายุ',
};
export const DISASTER_LABEL = 'ภัยพิบัติ';

export const PeriodWeather = z.strictObject({ weather: Weather, disaster: z.boolean() });
export type PeriodWeather = z.infer<typeof PeriodWeather>;

/** e.g. "ฝนตก" or "แดดจ้า · ภัยพิบัติ". */
export const weatherText = (w: PeriodWeather): string => (w.disaster ? `${WEATHER_LABEL[w.weather]} · ${DISASTER_LABEL}` : WEATHER_LABEL[w.weather]);
