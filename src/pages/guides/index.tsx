import type {GetStaticProps} from 'next';
import Head from 'next/head';
import Link from 'next/link';
import {type FC, memo} from 'react';

import {BrandLockup} from '@/components/LoadingScreen';
import {ghostButtonClass} from '@/components/paneShared';
import ThemeToggle from '@/components/ThemeToggle';
import {practiceOf} from '@/data/guides';
import {GUIDES} from '@/data/guides/meta';
import {problems} from '@/data/problems';
import {guidePath, GUIDES_PATH} from '@/lib/export';
import {type GuideId, GUIDE_IDS} from '@/lib/types';

/**
 * The failure-mode guides, `/guides`: the few ways the debugging courses' systems break, one guide
 * each, in the order a request meets them, with how many steps practise each one.
 */

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;
const TITLE = 'Failure-mode guides · LeetBuild';
const DESCRIPTION =
  'The ways the debugging courses break, one guide each: what the failure looks like, how to find it, fix it and prove the fix, and the steps whose starters hide it.';

interface Entry {
  id: GuideId;
  title: string;
  tagline: string;
  steps: number;
  courses: number;
}

const GuideCard: FC<{entry: Entry; number: number}> = memo(({entry, number}) => (
  <Link
    className="border-ink-700 bg-ink-850 hover:border-iris-400/60 group flex flex-col rounded-2xl border p-4 no-underline transition"
    href={guidePath(entry.id)}>
    <span className="flex items-center gap-2">
      <span className="font-code border-ink-600 text-ink-300 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-[11px] font-bold">
        {number}
      </span>
      <span className="text-ink-50 text-[15px] font-bold leading-snug">{entry.title}</span>
    </span>
    <span className="text-ink-200 mt-2 block flex-1 text-[13px] leading-6">{entry.tagline}</span>
    <span className="text-ink-400 border-ink-700/70 mt-3 flex items-center justify-between border-t pt-2.5 text-[11px]">
      <span className="font-code">
        {entry.steps} steps · {entry.courses} courses
      </span>
      <span className="text-iris-300 group-hover:text-iris-200 font-semibold transition">Read ›</span>
    </span>
  </Link>
));
GuideCard.displayName = 'GuideCard';

const GuidesPage: FC<{entries: Entry[]}> = memo(({entries}) => (
  <>
    <Head>
      <title>{TITLE}</title>
      <meta content={DESCRIPTION} name="description" />
      {SITE_URL !== undefined ? <link href={`${SITE_URL}${GUIDES_PATH}`} key="canonical" rel="canonical" /> : null}
      <meta content={TITLE} property="og:title" />
      <meta content={DESCRIPTION} property="og:description" />
      <meta content="width=device-width, initial-scale=1" name="viewport" />
    </Head>
    <main className="mx-auto w-full max-w-5xl px-4 py-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link className="inline-flex" href="/">
          <BrandLockup />
        </Link>
        <span className="ml-auto flex items-center gap-2">
          <ThemeToggle />
        </span>
      </header>
      <section className="mt-8">
        <Link className={`${ghostButtonClass} -ml-3`} href="/">
          ← all courses
        </Link>
        <h1 className="text-ink-50 mt-1 text-3xl font-extrabold leading-tight tracking-tight">Failure-mode guides</h1>
        <p className="text-ink-300 mt-2 max-w-3xl text-[14px] leading-6">
          Every step of a debugging course starts from working code with flaws, and the flaws repeat: a check and a
          write that two requests can split, a retry that charges twice, an offset committed before the work it stands
          for. Each guide takes one failure mode: what it looks like, how to find it, how to fix it and how to prove the
          fix, then the steps whose starters hide it.
        </p>
      </section>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry, i) => (
          <GuideCard entry={entry} key={entry.id} number={i + 1} />
        ))}
      </div>
    </main>
  </>
));
GuidesPage.displayName = 'GuidesPage';

export default GuidesPage;

export const getStaticProps: GetStaticProps<{entries: Entry[]}> = () => ({
  props: {
    entries: GUIDE_IDS.map(id => {
      const practice = practiceOf(id, problems);
      return {
        id,
        title: GUIDES[id].title,
        tagline: GUIDES[id].tagline,
        steps: practice.reduce((n, course) => n + course.steps.length, 0),
        courses: practice.length,
      };
    }),
  },
});
