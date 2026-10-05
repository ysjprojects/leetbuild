import {type ChangeEvent, type FC, memo, useCallback, useEffect, useState} from 'react';

import {RANGE_CLASS} from './frame';

export interface Playback {
  /** Current step in `[0, steps - 1]`. */
  step: number;
  steps: number;
  playing: boolean;
  setStep: (step: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  reset: () => void;
}

/** Deterministic step animation: `setInterval` while playing, wrapping back to 0 after the last step. */
export function usePlayback(steps: number, intervalMs: number, autoplay = false): Playback {
  const [step, setStepRaw] = useState(0);
  const [playing, setPlaying] = useState(autoplay);
  const last = Math.max(0, steps - 1);
  const setStep = useCallback((s: number) => setStepRaw(Math.min(last, Math.max(0, s))), [last]);
  const toggle = useCallback(() => setPlaying(p => !p), []);
  const next = useCallback(() => setStepRaw(s => (s >= last ? 0 : s + 1)), [last]);
  const prev = useCallback(() => setStepRaw(s => (s <= 0 ? last : s - 1)), [last]);
  const reset = useCallback(() => {
    setStepRaw(0);
    setPlaying(false);
  }, []);
  useEffect(() => {
    if (step > last) setStepRaw(last);
  }, [last, step]);
  useEffect(() => {
    if (!playing) return undefined;
    const id = setInterval(() => setStepRaw(s => (s >= last ? 0 : s + 1)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, last, playing]);
  return {step, steps: Math.max(1, steps), playing, setStep, toggle, next, prev, reset};
}

export const BUTTON_CLASS =
  'rounded-md border border-plum-600 bg-plum-800/60 px-2 py-0.5 text-[11px] font-semibold text-plum-200 transition hover:border-candy-500/60 hover:text-white';

const PlaybackControls: FC<{label?: string; playback: Playback}> = memo(({label = 'step', playback}) => {
  const {step, steps, playing, setStep, toggle, next, prev, reset} = playback;
  const onSlide = useCallback((e: ChangeEvent<HTMLInputElement>) => setStep(Number(e.target.value)), [setStep]);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-plum-200">
      <button aria-label={playing ? 'pause' : 'play'} className={BUTTON_CLASS} onClick={toggle} type="button">
        {playing ? '❚❚' : '▶'}
      </button>
      <button aria-label="previous step" className={BUTTON_CLASS} onClick={prev} type="button">
        ‹
      </button>
      <button aria-label="next step" className={BUTTON_CLASS} onClick={next} type="button">
        ›
      </button>
      <button aria-label="reset" className={BUTTON_CLASS} onClick={reset} type="button">
        ↺
      </button>
      <label className="flex items-center gap-1.5">
        <span className="text-plum-300">{label}</span>
        <input
          aria-label={label}
          className={RANGE_CLASS}
          max={steps - 1}
          min={0}
          onChange={onSlide}
          step={1}
          type="range"
          value={step}
        />
        <span className="font-code tabular-nums text-cream">
          {step + 1}/{steps}
        </span>
      </label>
    </div>
  );
});
PlaybackControls.displayName = 'PlaybackControls';

export default PlaybackControls;
