import { useEffect, useRef, useState } from 'react';
import Logo from './Logo.jsx';

export const SPLASH_MS = 2400;

/** Full-screen hello that fades away by itself. Shown when the app opens and after you sign up or log in. */
export default function Splash({ text, onDone, ms = SPLASH_MS }) {
  const [leaving, setLeaving] = useState(false);
  // Keep the latest callback without restarting the timers whenever the app re-renders.
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const a = setTimeout(() => setLeaving(true), ms - 450);
    const b = setTimeout(() => done.current(), ms);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [ms]);

  return (
    <div className={`greeting ${leaving ? 'leaving' : ''}`} role="status" aria-live="polite" onClick={() => done.current()}>
      <Logo big />
      <p className="greeting-text">{text}</p>
    </div>
  );
}
