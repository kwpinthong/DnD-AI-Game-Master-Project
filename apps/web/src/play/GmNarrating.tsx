import { useEffect, useState } from 'react';

/** GEN-115: seconds since mount, updated every second (a page reload mid-turn starts again from 0). */
function useElapsedSeconds(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return seconds;
}

/** Shown while the room's turn is resolving and the AI GM is not stuck; mount it with a per-turn `key`. */
export function GmNarrating() {
  const seconds = useElapsedSeconds();
  return (
    <p role="status" aria-label="GM กำลังเล่า" className="play-gm-narrating">
      GM กำลังเล่า... {seconds} วินาที
    </p>
  );
}
