import type {GetStaticPaths, GetStaticProps} from 'next';
import Head from 'next/head';
import {type FC, memo} from 'react';

import LearnPage from '@/components/LearnPage';
import {sharedGuide} from '@/data/guides';
import {problems} from '@/data/problems';
import {type Guide, guidePath} from '@/lib/export';
import {GUIDE_IDS} from '@/lib/types';

/**
 * A failure-mode guide on its own page, `/guides/<id>`: one way the debugging courses' systems break,
 * walked through like a course's learning guide, ending with the steps whose starters hide it.
 */

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

interface Props {
  guide: Guide;
  path: string;
}

const GuidePage: FC<Props> = memo(({guide, path}) => {
  const title = `${guide.title} · LeetBuild guides`;
  const url = SITE_URL === undefined ? undefined : `${SITE_URL}${path}`;
  return (
    <>
      <Head>
        <title>{title}</title>
        <meta content={guide.tagline} name="description" />
        {url !== undefined ? <link href={url} key="canonical" rel="canonical" /> : null}
        <meta content={title} property="og:title" />
        <meta content={guide.tagline} property="og:description" />
        {url !== undefined ? <meta content={url} property="og:url" /> : null}
        <meta content="width=device-width, initial-scale=1" name="viewport" />
      </Head>
      <LearnPage guide={guide} />
    </>
  );
});
GuidePage.displayName = 'GuidePage';

export default GuidePage;

export const getStaticPaths: GetStaticPaths = () => ({
  paths: GUIDE_IDS.map(id => ({params: {guide: id}})),
  fallback: false,
});

export const getStaticProps: GetStaticProps<Props, {guide: string}> = ({params}) => {
  const id = GUIDE_IDS.find(g => g === params?.guide);
  return id === undefined ? {notFound: true} : {props: {guide: sharedGuide(id, problems), path: guidePath(id)}};
};
