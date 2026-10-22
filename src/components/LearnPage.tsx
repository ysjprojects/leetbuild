import Link from 'next/link';
import {type FC, memo, useCallback, useEffect, useMemo, useState} from 'react';

import {type Guide, downloadMarkdown, githubSlug, learnFileName, learnToMarkdown} from '@/lib/export';
import {leetbuildHighlighter} from '@/lib/highlight';

import {BrandLockup} from './LoadingScreen';
import Markdown from './Markdown';
import {ghostButtonClass, linkClass} from './paneShared';
import ThemeToggle from './ThemeToggle';
import {renderWidget} from './widgets';

/**
 * A course's learning guide on its own page: the concepts walked through with figures, interactive
 * demos and pop quizzes, a table of contents that follows the sections, and the static versions to
 * take away — the Markdown (figures as Mermaid, quizzes with the answer behind a spoiler) and a PDF
 * laid out for paper (lib/pdf.ts; figures as images, demos as notes, answers printed).
 */

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
    downloadMarkdown(learnFileName(guide.problemId), learnToMarkdown(guide));
  }, [guide]);
  // The PDF machinery (pdfmake, the figure rasterizer) loads only when someone asks for a PDF.
  const onPdf = useCallback(() => {
    setPreparing(true);
    import('@/lib/guidePdf')
      .then(({downloadGuidePdf}) => downloadGuidePdf(guide, learnFileName(guide.problemId, 'pdf')))
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
        {/* The one way back: the description is where the guide is opened from. */}
        <Link className={`${ghostButtonClass} -ml-3`} href={`/${guide.problemId}`}>
          ← back to the course
        </Link>
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
                  <span className="font-code text-ink-500 w-4 shrink-0 text-right text-[11px] leading-5">{i + 1}</span>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <article className="min-w-0 max-w-4xl">
          <Markdown highlight={leetbuildHighlighter} renderWidget={renderWidget} source={guide.learn} />
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
