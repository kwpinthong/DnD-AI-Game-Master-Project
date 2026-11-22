import { weatherText, type RoomState } from '@isekai/protocol';
import type { ReactNode } from 'react';
import clockFrame from '../../assets/frames/frame-clock.webp';
import { topBar } from '../../screen-models.ts';
import { playText } from '../../ui/index.ts';
import { PERIOD_WORD, dialAngle, dialLabel } from './chat-model.ts';
import { WeatherImg } from './PlaceArt.tsx';

/** Where the hand turns in frames/frame-clock.webp (800 x 297): the hub of the sun medallion (CREDITS.md: ~29% x, ~77% y). */
const HUB = { x: 232, y: 229 };
const HAND = 125;

/**
 * The desktop clock (GEN-132): the painted frame, the hand turned by code to the slot of the current period
 * (same angles as the dial: morning, afternoon, evening, night from the left), and the day, the period and the turn in the
 * text slot of the frame next to the weather painting. The weather word and "ส่งแล้ว x/y" follow it. The phone keeps the compact clock.
 */
export function ClockHud({ room, children }: { room: RoomState; children?: ReactNode }) {
  const bar = topBar(room);
  return (
    <div className="hud-time hud-time--clock" role="group" aria-label={playText.top.label}>
      <div className="clock">
        <img className="clock__frame" src={clockFrame} alt="" aria-hidden="true" />
        <svg className="clock__hand" viewBox="0 0 800 297" role="img" aria-label={dialLabel(room)}>
          <g className="clock__turn" style={{ transform: `rotate(${dialAngle(room.phase)}deg)`, transformOrigin: `${HUB.x}px ${HUB.y}px` }}>
            <line x1={HUB.x} y1={HUB.y} x2={HUB.x} y2={HUB.y - HAND} className="clock__hand-edge" />
            <line x1={HUB.x} y1={HUB.y} x2={HUB.x} y2={HUB.y - HAND} className="clock__hand-core" />
          </g>
        </svg>
        <div className="clock__slot">
          <WeatherImg weather={room.weather} className="clock__weather" />
          <div className="hud-time__text">
            <span className="hud-time__day">{bar.day}</span>
            <span className="hud-time__now">
              {PERIOD_WORD[room.phase]} · {playText.top.turn(room.turn)}
            </span>
          </div>
        </div>
      </div>
      <span className="hud-time__weather">
        <span className="sr-only">{playText.top.weather} </span>
        {room.weather ? weatherText(room.weather) : bar.weather}
      </span>
      {bar.submitted && <span className="hud-sent">{bar.submitted}</span>}
      {children}
    </div>
  );
}
