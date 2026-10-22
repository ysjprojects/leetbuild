import Link from 'next/link';
import {type FC, memo, useCallback, useEffect, useMemo, useState} from 'react';

import {type Guide, downloadMarkdown, githubSlug, learnFileName, learnPath, learnToMarkdown} from '@/lib/export';
import {leetbuildHighlighter} from '@/lib/highlight';
import {WIDGETS} from '@/lib/widgets';

import {BrandLockup} from './LoadingScreen';
import Markdown, {type WidgetRenderer} from './Markdown';
import {ghostButtonClass, linkClass} from './paneShared';
import ThemeToggle from './ThemeToggle';
import {renderWidget} from './widgets';

/**
 * A course's learning guide on its own page: the concepts walked through with figures, interactive
 * demos and pop quizzes, a table of contents that follows the sections, and the static version to
 * take away — the Markdown (figures as Mermaid, quizzes with the answer behind a spoiler) or a PDF
 * through the browser's print dialog, with every folded section open and demos replaced by a note.
 */

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

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

const LearnPage: FC<{guide: Guide}> = memo(({guide}) => {
  const sections = useMemo(() => sectionsOf(guide.learn), [guide.learn]);
  const [printing, setPrinting] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  // Where this page lives, for the printed notes; the server does not know the origin unless configured.
  const [origin, setOrigin] = useState(SITE_URL ?? '');
  useEffect(() => {
    if (SITE_URL === undefined) setOrigin(window.location.origin);
  }, []);

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

  // Print = the static version: Day palette on paper, every folded section open; restored afterwards.
  useEffect(() => {
    const done = (): void => {
      setPrinting(false);
      const root = document.documentElement;
      const before = root.dataset.themeBeforePrint;
      if (before !== undefined) {
        root.dataset.theme = before;
        delete root.dataset.themeBeforePrint;
      }
    };
    window.addEventListener('afterprint', done);
    return () => window.removeEventListener('afterprint', done);
  }, []);
  const onPrint = useCallback(() => {
    const root = document.documentElement;
    root.dataset.themeBeforePrint = root.dataset.theme ?? 'dark';
    root.dataset.theme = 'light';
    setPrinting(true);
    // Two frames: one for React to commit the expanded sections, one for the browser to lay them out.
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  }, []);
  const onDownload = useCallback(() => {
    downloadMarkdown(learnFileName(guide.problemId), learnToMarkdown(guide));
  }, [guide]);

  // On paper a demo is a note that says what it showed and where the live one is.
  const renderPrintable = useCallback<WidgetRenderer>(
    (name, params) => (
      <>
        <div className="print:hidden">{renderWidget(name, params)}</div>
        <p className="border-ink-600 text-ink-300 hidden rounded-lg border border-dashed p-3 text-[12px] italic print:block">
          Interactive demo — {WIDGETS[name]?.about ?? name} Open the guide at {origin}
          {learnPath(guide.problemId)} to use it.
        </p>
      </>
    ),
    [guide.problemId, origin],
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 print:max-w-none print:px-0 print:py-0">
      <header className="flex flex-wrap items-center gap-3 print:hidden">
        <Link className="inline-flex" href="/">
          <BrandLockup />
        </Link>
        <span className="ml-auto flex items-center gap-2">
          <ThemeToggle />
        </span>
      </header>

      <section className="mt-8">
        {/* The one way back: the description is where the guide is opened from. */}
        <Link className={`${ghostButtonClass} -ml-3 print:hidden`} href={`/${guide.problemId}`}>
          ← back to the course
        </Link>
        <h1 className="text-ink-50 mt-1 text-3xl font-extrabold leading-tight tracking-tight">{guide.title}</h1>
        <p className="text-ink-300 mt-2 max-w-3xl text-[14px] leading-6">{guide.tagline}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2 print:hidden">
          <button className={ghostButtonClass} onClick={onDownload} title="The guide as Markdown" type="button">
            ⤓ Download .md
          </button>
          <button
            className={ghostButtonClass}
            onClick={onPrint}
            title="Opens the print dialog — choose “Save as PDF”"
            type="button">
            ⎙ Save as PDF
          </button>
        </div>
      </section>

      <div className="mt-8 grid gap-10 lg:grid-cols-[200px_minmax(0,1fr)] print:block">
        <nav aria-label="contents" className="lg:sticky lg:top-6 lg:self-start print:hidden">
          <p className="text-ink-400 text-[10px] font-bold uppercase tracking-wider">Contents</p>
          <ol className="mt-2 space-y-1">
            {sections.map((s, i) => (
              <li key={s.id}>
                <a
                  className={`flex gap-2 text-[12px] leading-5 transition ${
                    active === s.id ? 'text-ink-50 font-semibold' : 'text-ink-300 hover:text-ink-50'
                  }`}
                  href={`#${s.id}`}>
                  <span className="font-code text-ink-500 w-4 shrink-0 text-right text-[11px] leading-5">{i + 1}</span>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <article className="min-w-0 max-w-4xl">
          <Markdown
            expandDetails={printing}
            highlight={leetbuildHighlighter}
            renderWidget={renderPrintable}
            source={guide.learn}
          />
          {guide.sources.length > 0 ? (
            <section className="border-ink-700 mt-10 border-t pt-4">
              <p className="text-ink-400 text-[10px] font-bold uppercase tracking-wider">Sources</p>
              <ul className="mt-2 space-y-1 text-[13px]">
                {guide.sources.map(s => (
                  <li className="text-ink-300" key={s.url}>
                    <a className={linkClass} href={s.url} rel="noreferrer" target="_blank">
                      {s.title}
                    </a>
                    {s.by !== undefined ? ` — ${s.by}` : ''}, {s.date}
                  </li>
                ))}
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
