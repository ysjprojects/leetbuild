import {type FC, memo, useEffect, useRef} from 'react';

/**
 * A short confetti burst over the whole viewport when a step is accepted. Pure canvas, no
 * dependency; mounts, runs for `DURATION_MS`, then calls `onDone` so the parent unmounts it.
 */
const DURATION_MS = 1800;
const COUNT = 140;
const COLORS = ['#ff3fa6', '#ff7ac8', '#ffb0dc', '#a78bfa', '#6ee7b7', '#fbbf24', '#fbf6ff'];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rotation: number;
  spin: number;
}

const Confetti: FC<{onDone: () => void}> = memo(({onDone}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const el = canvas.current;
    if (el === null) return undefined;
    const ctx = el.getContext('2d');
    if (ctx === null) return undefined;
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    el.width = width * dpr;
    el.height = height * dpr;
    ctx.scale(dpr, dpr);
    // Two bursts from the lower corners, like a stage cannon, so the editor stays readable.
    const particles: Particle[] = Array.from({length: COUNT}, (_, i) => {
      const fromLeft = i % 2 === 0;
      const angle = (fromLeft ? -Math.PI / 3 : (-2 * Math.PI) / 3) + (Math.random() - 0.5) * 0.9;
      const speed = 520 + Math.random() * 420;
      return {
        x: fromLeft ? 0 : width,
        y: height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 5 + Math.random() * 6,
        color: COLORS[i % COLORS.length],
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 12,
      };
    });
    const started = performance.now();
    let last = started;
    let frame = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const elapsed = now - started;
      ctx.clearRect(0, 0, width, height);
      const fade = elapsed > DURATION_MS - 500 ? Math.max(0, (DURATION_MS - elapsed) / 500) : 1;
      for (const p of particles) {
        p.vy += 1400 * dt;
        p.vx *= 0.99;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rotation += p.spin * dt;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }
      if (elapsed < DURATION_MS) frame = window.requestAnimationFrame(tick);
      else onDoneRef.current();
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return <canvas aria-hidden className="pointer-events-none fixed inset-0 z-[60] h-full w-full" ref={canvas} />;
});
Confetti.displayName = 'Confetti';

export default Confetti;
