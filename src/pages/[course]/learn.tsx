import type {GetStaticPaths, GetStaticProps} from 'next';
import Head from 'next/head';
import {type FC, memo} from 'react';

import LearnPage from '@/components/LearnPage';
import {problems} from '@/data/problems';
import {type Guide, guideOf, learnPath} from '@/lib/export';

/**
 * A course's learning guide, `/<problem>/learn`: a reading page rendered on the server from the
 * guide alone. A page of its own, so the playground's page does not load the guide's figures and
 * widgets for the problem list.
 */

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

interface Props {
  guide: Guide;
  /** Site-relative canonical address of this page. */
  path: string;
  title: string;
  description: string;
}

const CourseGuidePage: FC<Props> = memo(({guide, path, title, description}) => {
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
      <LearnPage guide={guide} />
    </>
  );
});
CourseGuidePage.displayName = 'CourseGuidePage';

export default CourseGuidePage;

export const getStaticPaths: GetStaticPaths = () => ({
  paths: problems.filter(problem => problem.learn !== undefined).map(problem => ({params: {course: problem.id}})),
  fallback: false,
});

export const getStaticProps: GetStaticProps<Props, {course: string}> = ({params}) => {
  const problem = problems.find(p => p.id === params?.course);
  const guide = problem === undefined ? null : guideOf(problem);
  if (problem === undefined || guide === null) return {notFound: true};
  return {
    props: {
      guide,
      path: learnPath(problem.id),
      title: `${problem.title}: the learning guide — LeetBuild`,
      description: `The concepts behind ${problem.title}, walked through with figures, interactive demos and quizzes. ${problem.tagline}`,
    },
  };
};
