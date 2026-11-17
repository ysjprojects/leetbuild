import Link from 'next/link';
import {useRouter} from 'next/router';
import {type FC, memo, useCallback, useEffect, useMemo, useState} from 'react';

import {type Guide, downloadMarkdown, githubSlug, learnFileName, learnToMarkdown} from '@/lib/export';
import {leetbuildHighlighter} from '@/lib/highlight';
import {sourceCredit} from '@/lib/types';

import {BrandLockup} from './LoadingScreen';
import Markdown from './Markdown';
import {ghostButtonClass, linkClass} from './paneShared';
import ThemeToggle from './ThemeToggle';
import {renderWidget} from './widgets';

/**
 * A learning guide on its own page: a course's (`/<course>/learn`) or a failure-mode guide the
 * debugging courses share (`/guides/<id>`, which ends with the steps to practise it on). The
 * concepts walked through with figures, interactive demos and pop quizzes, a table of contents that
 * follows the sections, and the static versions to take away: the Markdown (figures as Mermaid,
 * quizzes with the answer behind a spoiler) and a PDF laid out for paper (lib/pdf.ts; figures
 * drawn, demos as notes, answers printed). Opened from a step (`?from=/<course>/<step>`), it leads
 * back to that step first.
 */

/** A step of the course a course guide belongs to, for naming the step it was opened from. */
export interface GuideStep {
  href: string;
  title: string;
}

/** `?from=` when it is a path on this site (never another origin), as `pathname + search`; else `null`. */
const sameSitePath = (from: string | null): string | null => {
  if (from === null || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) return null;
  try {
    const url = new URL(from, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
};

/** What the back link names for the page the guide was opened from: the step (and its course) when the guide knows it. */
const backLabel = (path: string, guide: Guide, steps: readonly GuideStep[]): string => {
  const pathname = path.split('?')[0];
  if (pathname === '/mock-interview') return 'back to the mock report';
  // A step's address carries its number: `/image-cache/2-cache-aside`.
  const number = /^\/[^/]+\/(\d+)-/.exec(pathname)?.[1];
  if (number === undefined) return 'back';
  const own = steps.find(s => s.href === pathname);
  if (own !== undefined) return `back to step ${number}: ${own.title}`;
  const course = guide.practice?.find(c => c.steps.some(s => s.href === pathname));
  return course === undefined ? 'back to the step' : `back to ${course.course}, step ${number}`;
};

const NO_STEPS: readonly GuideStep[] = [];

/** The guide's sections: every `#` heading outside fenced code, with the anchor the heading renders. */
const sectionsOf = (markdown: string): {title: string; id: string}[] => {
  const out: {title: string; id: string}[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    else if (!fenced && /^#\s+/.test(line)) {
      const title = line.replace(/^#\s+/, '').trim();
      out.push({title, id: githubSlug(title)});
    }
  }
  return out;
};

/** A failure-mode guide's last section: the steps whose starters hide the failure mode, to practise on, by course. */
const Practice: FC<{practice: NonNullable<Guide['practice']>}> = memo(({practice}) => {
  const steps = practice.reduce((n, course) => n + course.steps.length, 0);
  return (
    <section className="border-ink-700 mt-10 border-t pt-4">
      <p className="text-ink-400 text-[10px] font-bold uppercase tracking-wider">Practise it</p>
      <p className="text-ink-300 mt-1 text-[13px] leading-6">
        {steps} {steps === 1 ? 'step starts' : 'steps start'} from a starter that hides this failure mode, in{' '}
        {practice.length} {practice.length === 1 ? 'course' : 'courses'}.
      </p>
      <ul className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
        {practice.map(course => (
          <li className="text-[13px] leading-5" key={course.course}>
            <span className="text-ink-100 font-semibold">{course.course}</span>
            <ul className="mt-0.5 space-y-0.5">
              {course.steps.map(step => (
                <li key={step.href}>
                  <Link className={linkClass} href={step.href}>
                    {step.title}
                  </Link>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
});
Practice.displayName = 'Practice';

const LearnPage: FC<{guide: Guide; steps?: readonly GuideStep[]}> = memo(({guide, steps = NO_STEPS}) => {
  const sections = useMemo(() => sectionsOf(guide.learn), [guide.learn]);
  const router = useRouter();
  // Where the guide was opened from (`?from=`), read after hydration: the page is pre-rendered without it.
  const [from, setFrom] = useState<{href: string; label: string} | null>(null);
  useEffect(() => {
    const path = sameSitePath(new URLSearchParams(window.location.search).get('from'));
    setFrom(path === null || path === guide.back.href ? null : {href: path, label: backLabel(path, guide, steps)});
  }, [guide, router.asPath, steps]);

  // The address's anchor in view once the page is drawn: on a client-side visit nothing else scrolls
  // to it, and a heading inside a `:::details` exists only once that section opens itself.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id === '') return undefined;
    let tries = 0;
    let timer = 0;
    const seek = (): void => {
      const target = document.getElementById(id);
      if (target !== null) target.scrollIntoView({block: 'start'});
      else if (++tries < 20) timer = window.setTimeout(seek, 50);
    };
    timer = window.setTimeout(seek, 0);
    return () => window.clearTimeout(timer);
  }, [guide.id, router.asPath]);

  const [active, setActive] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);

  // The section in view, for the table of contents: the last heading above the top third of the viewport.
  useEffect(() => {
    const headings = sections.map(s => document.getElementById(s.id)).filter((e): e is HTMLElement => e !== null);
    const update = (): void => {
      const line = window.innerHeight / 3;
      let current: string | null = null;
      for (const h of headings) if (h.getBoundingClientRect().top <= line) current = h.id;
      setActive(current ?? headings[0]?.id ?? null);
    };
    update();
    window.addEventListener('scroll', update, {passive: true});
    return () => window.removeEventListener('scroll', update);
  }, [sections]);

  const onDownload = useCallback(() => {
    downloadMarkdown(learnFileName(guide.id), learnToMarkdown(guide));
  }, [guide]);
  // The PDF machinery (pdfmake, the figure rasterizer) loads only when someone asks for a PDF.
  const onPdf = useCallback(() => {
    setPreparing(true);
    import('@/lib/guidePdf')
      .then(({downloadGuidePdf}) => downloadGuidePdf(guide, learnFileName(guide.id, 'pdf')))
      .catch((error: unknown) => {
        console.error(error);
      })
      .finally(() => setPreparing(false));
  }, [guide]);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link className="inline-flex" href="/">
          <BrandLockup />
        </Link>
        <span className="ml-auto flex items-center gap-2">
          <ThemeToggle />
        </span>
      </header>

      <section className="mt-8">
        {/* Back to the step it was opened from, when it was; always the course's description or the guides' index. */}
        <div className="-ml-3 flex flex-wrap items-center gap-x-1">
          {from !== null ? (
            <Link className={ghostButtonClass} href={from.href}>
              ← {from.label}
            </Link>
          ) : null}
          <Link className={ghostButtonClass} href={guide.back.href}>
            {from === null ? `← ${guide.back.label}` : guide.practice === undefined ? 'course overview' : 'all guides'}
          </Link>
        </div>
        <h1 className="text-ink-50 mt-1 text-3xl font-extrabold leading-tight tracking-tight">{guide.title}</h1>
        <p className="text-ink-300 mt-2 max-w-3xl text-[14px] leading-6">{guide.tagline}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button className={ghostButtonClass} onClick={onDownload} title="The guide as Markdown" type="button">
            ⤓ Download .md
          </button>
          <button
            className={ghostButtonClass}
            disabled={preparing}
            onClick={onPdf}
            title="The guide laid out for paper: figures, demos as notes, quiz answers printed"
            type="button">
            {preparing ? 'Preparing the PDF…' : '⤓ Download PDF'}
          </button>
        </div>
      </section>

      <div className="mt-8 grid gap-10 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="contents" className="lg:sticky lg:top-6 lg:self-start">
          <p className="text-ink-400 text-[10px] font-bold uppercase tracking-wider">Contents</p>
          <ol className="mt-2 space-y-1">
            {sections.map((s, i) => (
              <li key={s.id}>
                <a
                  className={`flex gap-2 text-[12px] leading-5 transition ${
                    active === s.id ? 'text-ink-50 font-semibold' : 'text-ink-300 hover:text-ink-50'
                  }`}
                  href={`#${s.id}`}>
                  <span className="font-code text-ink-400 w-4 shrink-0 text-right text-[11px] leading-5">{i + 1}</span>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        {/* Running text holds to about 75 characters a line; figures, demos, code and tables use the full width. */}
        <article className="min-w-0 max-w-4xl [&_[data-prose]]:max-w-[35em]">
          <Markdown highlight={leetbuildHighlighter} renderWidget={renderWidget} source={guide.learn} />
          {guide.practice !== undefined && guide.practice.length > 0 ? <Practice practice={guide.practice} /> : null}
          {guide.sources.length > 0 ? (
            <section className="border-ink-700 mt-10 border-t pt-4">
              <p className="text-ink-400 text-[10px] font-bold uppercase tracking-wider">Sources</p>
              <ul className="mt-2 space-y-1 text-[13px]">
                {guide.sources.map(s => {
                  const credit = sourceCredit(s);
                  return (
                    <li className="text-ink-300" key={s.url}>
                      <a className={linkClass} href={s.url} rel="noreferrer" target="_blank">
                        {s.title}
                      </a>
                      {credit === '' ? null : <span className="text-ink-400"> · {credit}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </article>
      </div>
    </main>
  );
});
LearnPage.displayName = 'LearnPage';

export default LearnPage;
