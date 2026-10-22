import type {GetStaticPaths, GetStaticProps} from 'next';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import {type FC, memo} from 'react';

import LearnPage from '@/components/LearnPage';
import {AppLoading, LoadingRoute} from '@/components/LoadingScreen';
import {problems} from '@/data/problems';
import {type Guide, guideOf, learnPath} from '@/lib/export';
import {stepBySlug, stepPath, stepSlug} from '@/lib/types';

/**
 * One page for every address — `/` (the problem list), `/<problem>` (a course, reopened on the
 * step last visited) and `/<problem>/<n>-<step>` (step n, numbered like its source file) — so
 * moving between them is ordinary browser navigation with a history entry each, while the
 * playground stays mounted and keeps its state. `/<problem>/learn` is the course's learning guide,
 * a reading page rendered on the server from the guide alone. Every path is pre-rendered from the
 * course data; anything else is a 404.
 */

const TITLE = 'LeetBuild — build systems, then prove you can use AI';
const DESCRIPTION =
  'LeetBuild: practice building systems and reviewing AI-generated code, not just algorithms. Implement an LLM gateway, a RAG service, a URL shortener, a match engine, a news feed and more in Python, TypeScript, Go, Scala or C++ — HTTPS servers, gRPC, Kafka and Redis — with hints, revealable answers, diagrams and LeetCode-style scoring. The AI-era track starts every step from a plausible model-generated draft you have to review, fix and verify. A timed mock interview mode is one switch away.';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

interface Props {
  problemId: string | null;
  stepId: string | null;
  /** The learning guide, when this is its page. */
  guide: Guide | null;
  /** Site-relative canonical address of this page. */
  path: string;
  title: string;
  description: string;
}

/** `dynamic()` wants a plain render function; `AppLoading` reads the route from `LoadingRoute` below. */
const loading = (): JSX.Element => <AppLoading />;

// CodeMirror and IndexedDB are browser-only; the playground never renders on the server.
// eslint-disable-next-line react-memo/require-memo
const LeetBuildPlayground = dynamic(() => import('@/components/LeetBuildPlayground'), {loading, ssr: false});

const Page: FC<Props> = memo(({problemId, stepId, guide, path, title, description}) => {
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
      {guide !== null ? (
        <LearnPage guide={guide} />
      ) : (
        <LoadingRoute.Provider value={problemId}>
          <LeetBuildPlayground problemId={problemId} stepId={stepId} />
        </LoadingRoute.Provider>
      )}
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
      ...(problem.learn === undefined ? [] : [{params: {slug: [problem.id, 'learn']}}]),
    ]),
  ],
  fallback: false,
});

export const getStaticProps: GetStaticProps<Props, {slug?: string[]}> = ({params}) => {
  const [problemId = null, slug = null] = params?.slug ?? [];
  if (problemId === null) {
    return {props: {problemId: null, stepId: null, guide: null, path: '', title: TITLE, description: DESCRIPTION}};
  }
  const problem = problems.find(p => p.id === problemId);
  if (problem === undefined) return {notFound: true};
  if (slug === 'learn') {
    const guide = guideOf(problem);
    if (guide === null) return {notFound: true};
    return {
      props: {
        problemId,
        stepId: null,
        guide,
        path: learnPath(problem.id),
        title: `${problem.title}: the learning guide — LeetBuild`,
        description: `The concepts behind ${problem.title}, walked through with figures, interactive demos and quizzes. ${problem.tagline}`,
      },
    };
  }
  const step = slug === null ? null : stepBySlug(problem, slug) ?? null;
  if (slug !== null && step === null) return {notFound: true};
  return {
    props: {
      problemId,
      stepId: step === null ? null : step.id,
      guide: null,
      path: step === null ? `/${problem.id}` : stepPath(problem, step),
      // Course first: a tab shows ~25 characters, and the course is what tells tabs apart.
      title:
        step === null
          ? `${problem.title} — LeetBuild`
          : `${problem.title} · ${problem.steps.indexOf(step) + 1}. ${step.title} — LeetBuild`,
      description: problem.tagline,
    },
  };
};
