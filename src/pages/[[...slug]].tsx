import type {GetStaticPaths, GetStaticProps} from 'next';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import {type FC, memo} from 'react';

import {problems} from '@/data/problems';
import {stepBySlug, stepPath, stepSlug} from '@/lib/types';

/**
 * One page for every address — `/` (the problem list), `/<problem>` (a course, reopened on the
 * step last visited) and `/<problem>/<n>-<step>` (step n, numbered like its source file) — so
 * moving between them is ordinary browser navigation with a history entry each, while the
 * playground stays mounted and keeps its state. Every path is pre-rendered from the course data;
 * anything else is a 404.
 */

const TITLE = 'LeetBuild — build systems step by step';
const DESCRIPTION =
  'LeetBuild: practice building systems, not just algorithms. Implement a URL shortener, a match engine, a news feed, ride dispatch and more step by step in Python, Go, Scala or C++ — HTTPS servers, gRPC, Kafka and Redis — with hints, revealable answers, diagrams and LeetCode-style scoring.';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

interface Props {
  problemId: string | null;
  stepId: string | null;
  /** Site-relative canonical address of this page. */
  path: string;
  title: string;
  description: string;
}

const loading = () => (
  <div className="bg-ink-900 text-ink-300 flex h-dvh items-center justify-center">
    <span className="animate-pulse text-sm">loading LeetBuild…</span>
  </div>
);

// CodeMirror and IndexedDB are browser-only; the playground never renders on the server.
// eslint-disable-next-line react-memo/require-memo
const LeetBuildPlayground = dynamic(() => import('@/components/LeetBuildPlayground'), {loading, ssr: false});

const Page: FC<Props> = memo(({problemId, stepId, path, title, description}) => {
  const url = SITE_URL === undefined ? undefined : `${SITE_URL}${path}`;
  return (
    <>
      <Head>
        <title>{title}</title>
        <meta content={description} name="description" />
        {url !== undefined ? <link href={url} key="canonical" rel="canonical" /> : null}
        <meta content={title} property="og:title" />
        <meta content={description} property="og:description" />
        {url !== undefined ? <meta content={url} property="og:url" /> : null}
        <meta content={title} name="twitter:title" />
        <meta content={description} name="twitter:description" />
        <meta content="width=device-width, initial-scale=1" name="viewport" />
      </Head>
      <LeetBuildPlayground problemId={problemId} stepId={stepId} />
    </>
  );
});
Page.displayName = 'Page';

export default Page;

export const getStaticPaths: GetStaticPaths = () => ({
  paths: [
    {params: {slug: []}},
    ...problems.flatMap(problem => [
      {params: {slug: [problem.id]}},
      ...problem.steps.map(step => ({params: {slug: [problem.id, stepSlug(problem, step)]}})),
    ]),
  ],
  fallback: false,
});

export const getStaticProps: GetStaticProps<Props, {slug?: string[]}> = ({params}) => {
  const [problemId = null, slug = null] = params?.slug ?? [];
  if (problemId === null) {
    return {props: {problemId: null, stepId: null, path: '', title: TITLE, description: DESCRIPTION}};
  }
  const problem = problems.find(p => p.id === problemId);
  if (problem === undefined) return {notFound: true};
  const step = slug === null ? null : stepBySlug(problem, slug) ?? null;
  if (slug !== null && step === null) return {notFound: true};
  return {
    props: {
      problemId,
      stepId: step === null ? null : step.id,
      path: step === null ? `/${problem.id}` : stepPath(problem, step),
      title: step === null ? `${problem.title} — LeetBuild` : `${step.title} · ${problem.title} — LeetBuild`,
      description: problem.tagline,
    },
  };
};
