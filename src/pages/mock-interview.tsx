import dynamic from 'next/dynamic';
import Head from 'next/head';
import {type FC, memo} from 'react';

/**
 * The AI-assisted mock interview. CodeMirror and the clipboard are browser-only, so the experience
 * is loaded client-side; the route itself is pre-rendered with its metadata like the playground.
 */

const TITLE = 'Mock interview — LeetBuild';
const DESCRIPTION =
  'A timed mock interview: start from a flawed model-generated draft, use an offline AI pair to review it, fix the code under a clock, and submit to the same checks the judge uses.';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

// CodeMirror is browser-only; the experience never renders on the server.
// eslint-disable-next-line react-memo/require-memo
const MockInterview = dynamic(() => import('@/components/MockInterview'), {
  loading: () => (
    <div className="bg-ink-900 text-ink-300 flex h-dvh items-center justify-center">
      <span className="animate-pulse text-sm">loading the mock interview…</span>
    </div>
  ),
  ssr: false,
});

const Page: FC = memo(() => {
  const url = SITE_URL === undefined ? undefined : `${SITE_URL}/mock-interview`;
  return (
    <>
      <Head>
        <title>{TITLE}</title>
        <meta content={DESCRIPTION} name="description" />
        {url !== undefined ? <link href={url} key="canonical" rel="canonical" /> : null}
        <meta content={TITLE} property="og:title" />
        <meta content={DESCRIPTION} property="og:description" />
        {url !== undefined ? <meta content={url} property="og:url" /> : null}
        <meta content={TITLE} name="twitter:title" />
        <meta content={DESCRIPTION} name="twitter:description" />
        <meta content="width=device-width, initial-scale=1" name="viewport" />
      </Head>
      <MockInterview />
    </>
  );
});
Page.displayName = 'MockInterviewPage';

export default Page;
