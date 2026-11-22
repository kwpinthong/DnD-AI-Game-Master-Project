import type { PeriodWeather, Phase, PlaceView } from '@isekai/protocol';
import { useEffect, useState } from 'react';
import { placeArt } from '../place-art.ts';
import { weatherArt } from '../weather-art.ts';
import { PERIOD_WORD } from './chat-model.ts';

/** The painted weather as a small image with its word as alt (nothing for a weather without a painting). */
export function WeatherImg({ weather, className }: { weather: PeriodWeather | null | undefined; className?: string }) {
  const art = weatherArt(weather);
  return art ? <img className={className} src={art.src} alt={art.alt} width={160} height={160} /> : null;
}

/**
 * The place card of the สถานที่ tab (GEN-132): the painting of this place at this period; when the period changes the
 * new one fades in over the old one (art.css, no animation under prefers-reduced-motion). A place without a painting
 * (or an unknown period) is an empty navy frame with the place name: no broken image.
 */
export function PlaceArt({ place, phase, weather }: { place: Pick<PlaceView, 'id' | 'name'>; phase: Phase | string; weather?: PeriodWeather | null | undefined }) {
  const src = placeArt(place.id, phase);
  const [shown, setShown] = useState(src);
  const [before, setBefore] = useState<string | null>(null);
  if (src !== shown) {
    setBefore(shown);
    setShown(src);
  }
  // the old image stays under the new one only while it fades
  useEffect(() => {
    if (before === null) return;
    const id = setTimeout(() => setBefore(null), 600);
    return () => clearTimeout(id);
  }, [before]);

  const word = PERIOD_WORD[phase as Phase];
  return (
    <div className="place-art">
      {before && <img className="place-art__img place-art__img--before" src={before} alt="" aria-hidden="true" />}
      {shown ? (
        <img key={shown} className="place-art__img" src={shown} alt={word ? `${place.name} · ${word}` : place.name} loading="lazy" decoding="async" />
      ) : (
        <span className="place-art__name display">{place.name}</span>
      )}
      <WeatherImg weather={weather} className="place-art__weather" />
    </div>
  );
}
