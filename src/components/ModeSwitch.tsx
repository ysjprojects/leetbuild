import Link from 'next/link';
import {type FC, memo} from 'react';

export type Mode = 'practice' | 'mock';

const ITEMS: readonly {mode: Mode; href: string; label: string; short: string}[] = [
  {mode: 'practice', href: '/', label: 'Practice', short: 'Practice'},
  {mode: 'mock', href: '/mock-interview', label: 'AI mock interview', short: 'Mock'},
];

/**
 * The product's two modes: the regular course catalogue, and a timed mock interview where the
 * learner starts from a flawed AI draft and has an offline AI pair. A link, not client state, so
 * every mode has its own address and Back returns to the other one.
 */
const ModeSwitch: FC<{mode: Mode; className?: string}> = memo(({mode, className = ''}) => (
  <nav
    aria-label="Practice mode"
    className={`border-ink-600 bg-ink-850 flex shrink-0 items-center rounded-full border p-0.5 text-[12px] font-semibold ${className}`}>
    {ITEMS.map(item => (
      <Link
        aria-current={mode === item.mode ? 'page' : undefined}
        className={`rounded-full px-3 py-1.5 transition ${
          mode === item.mode
            ? item.mode === 'mock'
              ? 'bg-danger-400 text-ink-950'
              : 'bg-iris-400 text-ink-950'
            : 'text-ink-300 hover:text-ink-50'
        }`}
        href={item.href}
        key={item.mode}
        title={item.label}>
        <span className="sm:hidden">{item.short}</span>
        <span className="hidden sm:inline">{item.label}</span>
      </Link>
    ))}
  </nav>
));
ModeSwitch.displayName = 'ModeSwitch';

export default ModeSwitch;
