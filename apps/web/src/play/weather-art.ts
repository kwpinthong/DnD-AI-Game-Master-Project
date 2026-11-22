import { DISASTER_LABEL, WEATHER_LABEL, type PeriodWeather, type Weather } from '@isekai/protocol';
import clear from '../assets/illustrations/weather-clear.webp';
import darkNight from '../assets/illustrations/weather-dark-night.webp';
import disaster from '../assets/illustrations/weather-disaster.webp';
import fog from '../assets/illustrations/weather-fog.webp';
import rain from '../assets/illustrations/weather-rain.webp';

/** The painted weather of the room (GEN-132). 'Clear Night' and 'Storm' have no painting yet: they get no image (the word stays). */
const ART: Partial<Record<Weather, string>> = { Clear: clear, Rain: rain, Fog: fog, 'Dark Night': darkNight };

/** The image and its alt in words (the weather word, or "ภัยพิบัติ" on a disaster day); null for a weather without a painting. */
export function weatherArt(weather: PeriodWeather | null | undefined): { src: string; alt: string } | null {
  if (!weather) return null;
  if (weather.disaster) return { src: disaster, alt: DISASTER_LABEL };
  const src = ART[weather.weather];
  return src ? { src, alt: WEATHER_LABEL[weather.weather] } : null;
}
