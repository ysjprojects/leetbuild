import Link from 'next/link';
import {type CSSProperties, type FC, createContext, memo, useContext} from 'react';

/**
 * The screen a visitor sees before the app is interactive, in two phases: while the playground
 * chunk downloads (`app`, rendered into the static HTML, so it is there before any script runs) and
 * while the progress store reads IndexedDB (`progress`). It is a shape-true skeleton of what is
 * about to appear — the landing page on `/`, the three-pane playground on a course — so nothing
 * jumps when the real thing takes over. Bones shimmer (`.lb-bone`, globals.scss) unless motion is
 * reduced; the status line is a live region.
 */

export type LoadingPhase = 'app' | 'progress';

/** The course route being loaded (`null` for the problem list), provided by the page to the dynamic import's placeholder. */
export const LoadingRoute = createContext<string | null>(null);

export const wordmarkClass =
  'from-iris-300 to-ink-50 bg-gradient-to-r bg-clip-text font-extrabold tracking-tight text-transparent';

/** The brand colours of the mark (public/leetbuild-logo.svg): fixed, not themed — a logo is the same on every background. */
const MARK_VIOLET = '#6c4cf1';
const MARK_MINT = '#2dd4a0';

/** The rising-steps mark, inline so it paints with the first frame and never flashes; 24 px tall beside the wordmark. */
export const LogoMark: FC<{className?: string}> = memo(({className = 'h-6 w-6'}) => (
  <svg aria-hidden className={`shrink-0 ${className}`} viewBox="0 0 512 512">
    <rect fill={MARK_VIOLET} height="127.2" rx="17.8" width="127.2" x="51.1" y="333.7" />
    <rect fill={MARK_VIOLET} height="127.2" rx="17.8" width="127.2" x="192.4" y="192.4" />
    <rect fill={MARK_VIOLET} height="127.2" rx="17.8" width="127.2" x="192.4" y="333.7" />
    <rect fill={MARK_MINT} height="127.2" rx="17.8" width="127.2" x="333.7" y="51.1" />
    <rect fill={MARK_VIOLET} height="127.2" rx="17.8" width="127.2" x="333.7" y="192.4" />
    <rect fill={MARK_VIOLET} height="127.2" rx="17.8" width="127.2" x="333.7" y="333.7" />
  </svg>
));
LogoMark.displayName = 'LogoMark';

/** The mark and the wordmark as one unit: every surface uses this so the lockup cannot drift. */
export const BrandLockup: FC<{className?: string; size?: 'md' | 'lg'}> = memo(({className = '', size = 'md'}) => (
  <span className={`flex items-center gap-2 ${className}`}>
    <LogoMark className={size === 'lg' ? 'h-10 w-10' : 'h-6 w-6'} />
    <span className={`${wordmarkClass} ${size === 'lg' ? 'text-2xl' : 'text-lg'}`}>LeetBuild</span>
  </span>
));
BrandLockup.displayName = 'BrandLockup';

/** Copy the landing page opens with — real text, so it is already in place while the rest loads. */
export const LandingIntro: FC<{stats?: readonly string[]}> = memo(
  ({stats = ['real systems', '5 languages', 'AI-era track', '1337 points']}) => (
    <section className="border-ink-700 from-iris-400/[0.10] relative overflow-hidden rounded-2xl border bg-gradient-to-br via-transparent to-transparent p-5 sm:p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_120%_at_0%_0%,rgba(108,76,241,0.18),transparent_60%),radial-gradient(60%_90%_at_100%_0%,rgba(45,212,160,0.10),transparent_55%)]"
      />
      <div className="relative">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <BrandLockup size="lg" />
          <span className="border-iris-400/40 bg-iris-400/10 text-iris-200 rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wider">
            Practice
          </span>
        </div>
        <h1 className="text-ink-50 mt-7 max-w-3xl text-3xl font-extrabold leading-[1.1] tracking-tight sm:text-4xl">
          Build systems. <span className="text-iris-300">Prove you can use AI.</span>
        </h1>
        <p className="text-ink-200 mt-4 max-w-2xl text-[14px] leading-7">
          Real services, one file at a time. Classic systems and AI-era review problems, judged in five languages.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {stats.map(stat => (
            <span
              className="border-ink-600 bg-ink-850/80 text-ink-200 rounded-full border px-3 py-1 text-[11px] font-semibold"
              key={stat}>
              {stat}
            </span>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Link
            className="bg-iris-400 text-ink-950 hover:bg-iris-300 rounded-lg px-4 py-2 text-[13px] font-bold shadow-[0_8px_24px_rgba(108,76,241,0.18)] transition"
            href="/mock-interview">
            AI mock interview →
          </Link>
          <a
            className="text-iris-300 hover:text-iris-200 decoration-iris-400/40 text-[12px] font-semibold underline"
            href="#problems">
            Browse courses ↓
          </a>
        </div>
      </div>
    </section>
  ),
);
LandingIntro.displayName = 'LandingIntro';

const PHASES: Record<LoadingPhase, {index: number; label: string; width: string}> = {
  app: {index: 1, label: 'loading the app', width: '38%'},
  progress: {index: 2, label: 'restoring your progress', width: '84%'},
};

const Bone: FC<{className: string; style?: CSSProperties}> = memo(({className, style}) => (
  <span aria-hidden className={`lb-bone block ${className}`} style={style} />
));
Bone.displayName = 'Bone';

// ---- the problem list ----------------------------------------------------------------------------

const ROW_TITLES = ['w-36', 'w-44', 'w-32', 'w-40', 'w-48', 'w-36', 'w-40'] as const;
const ROW_TAGLINES = ['w-3/4', 'w-2/3', 'w-4/5', 'w-1/2', 'w-3/4', 'w-2/3', 'w-3/5'] as const;

const ProblemListSkeleton: FC = memo(() => (
  <main className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-5xl space-y-6 px-5 py-6">
      <LandingIntro />
      <section className="border-ink-700 bg-ink-850 rounded-xl border px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-3">
            <Bone className="h-[60px] w-[60px] rounded-full" />
            <div className="space-y-1.5">
              <Bone className="h-5 w-28 rounded" />
              <Bone className="h-3 w-52 rounded" />
            </div>
          </div>
          <div className="min-w-[13rem] space-y-1">
            <span className="flex h-4 items-center justify-between">
              <Bone className="h-3 w-12 rounded" />
              <Bone className="h-3 w-9 rounded" />
            </span>
            {[0, 1, 2].map(i => (
              <span className="flex h-4 items-center gap-2" key={i}>
                <Bone className="h-3 w-9 rounded" />
                <Bone className="h-1.5 flex-1 rounded-full" />
                <Bone className="h-3 w-9 rounded" />
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Bone className="h-[18px] w-[18px] rounded-md" />
            <div className="space-y-1.5">
              <Bone className="h-3.5 w-24 rounded" />
              <Bone className="h-2.5 w-32 rounded" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Bone className="h-[18px] w-[18px] rounded-md" />
            <div className="space-y-1.5">
              <Bone className="h-3.5 w-24 rounded" />
              <Bone className="h-2.5 w-28 rounded" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Bone className="h-[18px] w-[18px] rounded-md" />
            <div className="space-y-1.5">
              <Bone className="h-3.5 w-24 rounded" />
              <Bone className="h-2.5 w-28 rounded" />
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Bone className="h-6 w-6 rounded-full" />
            <div className="space-y-1.5">
              <Bone className="h-3.5 w-24 rounded" />
              <Bone className="h-2.5 w-28 rounded" />
            </div>
          </div>
        </div>
        <div className="border-ink-700/70 mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-2.5">
          {[0, 1, 2, 3].map(i => (
            <div className="flex min-w-[9rem] flex-1 items-center gap-2" key={i}>
              <Bone className="h-3 w-10 rounded" />
              <Bone className="h-1.5 flex-1 rounded-full" />
              <Bone className="h-3 w-9 rounded" />
            </div>
          ))}
          <Bone className="ml-auto h-3 w-12 rounded" />
        </div>
      </section>
      <section>
        <p className="text-iris-400 mb-2 text-[11px] font-bold uppercase tracking-wider">Problems</p>
        <ul className="space-y-2">
          {ROW_TITLES.map((title, i) => (
            <li className="border-ink-700 bg-ink-850 flex items-center gap-3 rounded-xl border px-4 py-3" key={i}>
              <Bone className="h-7 w-7 rounded-full" />
              <span className="min-w-0 flex-1">
                <span className="flex h-[21px] items-center gap-2">
                  <Bone className={`h-4 rounded ${title}`} />
                  <Bone className="h-4 w-12 rounded-full" />
                  <Bone className="h-4 w-14 rounded-full" />
                </span>
                <span className="mt-0.5 flex h-[18px] items-center">
                  <Bone className={`h-3 rounded ${ROW_TAGLINES[i]}`} />
                </span>
                <span className="mt-2 flex h-[17px] items-center gap-3">
                  <Bone className="h-2.5 w-16 rounded-sm" />
                  <Bone className="h-2.5 w-14 rounded" />
                  <Bone className="h-2.5 w-12 rounded" />
                  <Bone className="h-2.5 w-12 rounded" />
                </span>
              </span>
              <Bone className="hidden h-3 w-12 rounded sm:block" />
            </li>
          ))}
        </ul>
      </section>
    </div>
  </main>
));
ProblemListSkeleton.displayName = 'ProblemListSkeleton';

// ---- the playground ------------------------------------------------------------------------------

/** The default split of the real playground (`DEFAULT_SPLIT` in LeetBuildPlayground.tsx). */
const MAIN_STYLE = {'--lb-cols': '0.44fr 8px 0.56fr'} as CSSProperties;
const IDE_STYLE = {'--lb-rows': '0.6fr 8px 0.4fr'} as CSSProperties;

/** A starter file as the editor will show it: `[indent, width]` in characters, `null` a blank line. */
const CODE_LINES: readonly (readonly [number, number] | null)[] = [
  [0, 26],
  [0, 18],
  null,
  [0, 34],
  [4, 42],
  [4, 30],
  null,
  [4, 38],
  [8, 46],
  [8, 22],
  [4, 12],
  null,
  [0, 40],
  [4, 28],
  [8, 50],
  [8, 36],
  [4, 20],
  null,
  [0, 24],
  [4, 44],
  [4, 32],
  [0, 8],
];
const lineStyles = CODE_LINES.map(line =>
  line === null ? null : ({marginLeft: `${line[0]}ch`, width: `${line[1]}ch`} as CSSProperties),
);

const EXPLORER_FILES = ['w-24', 'w-28', 'w-20', 'w-32', 'w-24'] as const;

const PlaygroundSkeleton: FC = memo(() => (
  <main
    className="min-h-0 min-w-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[var(--lb-cols)] lg:overflow-hidden"
    style={MAIN_STYLE}>
    <section className="border-ink-700 min-h-0 min-w-0 border-b lg:h-full lg:border-b-0">
      <div className="flex items-center justify-between px-4 py-2 lg:hidden">
        <Bone className="h-4 w-48 rounded" />
        <Bone className="h-3 w-3 rounded-sm" />
      </div>
      <div className="flex h-[62vh] flex-col overflow-hidden lg:h-full">
        <div className="border-ink-700 flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <Bone className="h-6 w-20 rounded-lg" />
          <Bone className="h-4 w-36 rounded" />
          <Bone className="h-4 w-12 rounded-full" />
          <Bone className="ml-auto h-6 w-6 rounded-md" />
          <Bone className="hidden h-6 w-6 rounded-md lg:block" />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-4 py-3">
          <Bone className="h-48 rounded-xl" />
          <div className="mt-3 flex items-center">
            {[0, 1, 2, 3, 4].map(i => (
              <span className={`flex items-center ${i > 0 ? 'flex-1' : ''}`} key={i}>
                {i > 0 ? <span aria-hidden className="bg-ink-700 h-0.5 min-w-[12px] flex-1" /> : null}
                <Bone className="h-7 w-7 rounded-full" />
              </span>
            ))}
          </div>
          <div className="border-ink-700 mt-3 flex items-center gap-1 border-b pb-2">
            <Bone className="ml-2.5 h-3.5 w-20 rounded" />
            <Bone className="ml-5 h-3.5 w-24 rounded" />
          </div>
          <Bone className="mt-4 h-5 w-2/3 rounded" />
          <Bone className="mt-3 h-3 rounded" />
          <Bone className="mt-2 h-3 w-11/12 rounded" />
          <Bone className="mt-2 h-3 w-4/5 rounded" />
          <Bone className="mt-4 h-3 w-5/6 rounded" />
          <Bone className="mt-2 h-3 w-3/5 rounded" />
          <Bone className="mt-5 h-20 rounded-xl" />
        </div>
        <div className="border-ink-700 flex shrink-0 items-center gap-2 border-t px-4 py-2">
          <Bone className="h-6 w-20 rounded-lg" />
          <Bone className="ml-auto h-6 w-16 rounded-lg" />
        </div>
      </div>
    </section>

    <span aria-hidden className="hidden lg:block" />

    <section className="flex min-h-0 min-w-0 flex-col lg:h-full lg:flex-row">
      <aside className="border-ink-700 hidden shrink-0 overflow-hidden border-r lg:block lg:h-full lg:w-52">
        <div className="space-y-2.5 px-3 py-3">
          <Bone className="h-3 w-14 rounded" />
          {EXPLORER_FILES.map((width, i) => (
            <span className="flex items-center gap-2 pl-2" key={i}>
              <Bone className="h-3 w-3 rounded-sm" />
              <Bone className={`h-3 rounded ${width}`} />
            </span>
          ))}
        </div>
      </aside>
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col lg:grid lg:h-full lg:grid-rows-[var(--lb-rows)]"
        style={IDE_STYLE}>
        <div className="flex h-[56vh] min-h-0 min-w-0 flex-col lg:h-auto">
          <div className="border-ink-700 flex items-center gap-2 border-b px-2 py-1.5">
            <Bone className="h-6 w-6 rounded-md" />
            <Bone className="h-6 w-28 rounded-md" />
            <Bone className="ml-auto h-4 w-10 rounded" />
            <Bone className="bg-iris-400/40 h-6 w-24 rounded-lg" />
          </div>
          <div className="bg-ink-850 font-code flex min-h-0 flex-1 overflow-hidden text-[13px] leading-[18px]">
            <ol
              aria-hidden
              className="border-ink-700 text-ink-500 shrink-0 select-none border-r py-2 pl-2 pr-2 text-right">
              {lineStyles.map((_, i) => (
                <li key={i}>{i + 1}</li>
              ))}
            </ol>
            <div className="min-w-0 flex-1 py-2 pl-3">
              {lineStyles.map((style, i) => (
                <div className="flex h-[18px] items-center" key={i}>
                  {style === null ? null : <Bone className="h-2.5 max-w-full rounded" style={style} />}
                </div>
              ))}
            </div>
          </div>
        </div>
        <span aria-hidden className="hidden lg:block" />
        <div className="border-ink-700 flex h-[40vh] min-h-0 min-w-0 flex-col border-t lg:h-auto lg:border-t-0">
          <div className="border-ink-700 flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
            <span className="text-iris-400 text-[11px] font-bold uppercase tracking-wider">Checks</span>
            <Bone className="h-3 w-40 rounded" />
            <Bone className="h-4 w-24 rounded-full" />
          </div>
          <div className="space-y-2 px-3 py-2">
            <Bone className="h-3 w-5/6 rounded" />
            <Bone className="h-3 w-2/3 rounded" />
            <div className="mt-3 space-y-1.5">
              {[0, 1, 2, 3, 4].map(i => (
                <Bone className="h-8 rounded-lg" key={i} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  </main>
));
PlaygroundSkeleton.displayName = 'PlaygroundSkeleton';

// ---- the screen ----------------------------------------------------------------------------------

export const LoadingScreen: FC<{phase: LoadingPhase; problemId: string | null}> = memo(({phase, problemId}) => {
  const {index, label, width} = PHASES[phase];
  return (
    <div aria-busy className="leetbuild-playground bg-ink-900 text-ink-100 flex h-dvh flex-col overflow-hidden">
      <header className="border-ink-700 bg-ink-950/60 flex shrink-0 items-center gap-x-4 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <BrandLockup />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Bone className="h-6 w-24 rounded-md" />
          <Bone className="h-6 w-16 rounded-full" />
          {problemId !== null ? <Bone className="hidden h-6 w-20 rounded-full sm:block" /> : null}
          <Bone className="h-7 w-7 rounded-full" />
          <Bone className="hidden h-7 w-7 rounded-full sm:block" />
          <Bone className="h-7 w-7 rounded-full" />
        </div>
      </header>
      {/* Progress by phase: the chunk is the first of two waits, the store the second. */}
      <div aria-hidden className="bg-ink-800 h-0.5 shrink-0">
        <div className="lb-progress bg-iris-400 h-full" style={{width}} />
      </div>

      {problemId === null ? <ProblemListSkeleton /> : <PlaygroundSkeleton />}

      <div className="pointer-events-none fixed inset-x-0 bottom-4 flex justify-center px-4">
        <p
          aria-live="polite"
          className="border-ink-700 bg-ink-850/95 text-ink-200 flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] shadow-lg"
          role="status">
          <span aria-hidden className="bg-iris-300 h-1.5 w-1.5 animate-pulse rounded-full motion-reduce:animate-none" />
          <span>
            {label}… <span className="font-code text-ink-400">{index}/2</span>
          </span>
          <span aria-hidden className="text-ink-500 hidden sm:inline">
            ·
          </span>
          <span className="text-ink-400 hidden sm:inline">⌘⏎ or Ctrl+⏎ submits the open file</span>
        </p>
      </div>
    </div>
  );
});
LoadingScreen.displayName = 'LoadingScreen';

/** Placeholder of the page's dynamic import: the route comes through `LoadingRoute`, since `dynamic()` passes no props. */
export const AppLoading: FC = memo(() => <LoadingScreen phase="app" problemId={useContext(LoadingRoute)} />);
AppLoading.displayName = 'AppLoading';
