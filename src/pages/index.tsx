import dynamic from 'next/dynamic';
import {JetBrains_Mono, Sora} from 'next/font/google';
import Head from 'next/head';
import {type FC, memo} from 'react';

const sora = Sora({subsets: ['latin'], weight: ['400', '500', '600', '700', '800']});
const mono = JetBrains_Mono({subsets: ['latin'], variable: '--font-code', weight: ['400', '600']});

const TITLE = 'LeetBuild — build systems step by step';
const DESCRIPTION =
  'LeetBuild: practice building systems, not just algorithms. Implement a URL shortener, a match engine, a news feed, ride dispatch and more step by step in Python, Go, Scala or C++ — HTTPS servers, gRPC, Kafka and Redis — with hints, revealable answers, diagrams and LeetCode-style scoring.';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

const loading = () => (
  <div className="flex h-dvh items-center justify-center bg-plum-900 text-plum-200">
    <span className="animate-pulse text-sm">loading LeetBuild…</span>
  </div>
);

// CodeMirror and IndexedDB are browser-only; the playground never renders on the server.
// eslint-disable-next-line react-memo/require-memo
const LeetBuildPlayground = dynamic(() => import('@/components/LeetBuildPlayground'), {loading, ssr: false});

const Home: FC = memo(() => (
  <>
    <Head>
      <title>{TITLE}</title>
      <meta content={DESCRIPTION} name="description" />
      {SITE_URL !== undefined ? <link href={SITE_URL} key="canonical" rel="canonical" /> : null}
      <meta content={TITLE} property="og:title" />
      <meta content={DESCRIPTION} property="og:description" />
      {SITE_URL !== undefined ? <meta content={SITE_URL} property="og:url" /> : null}
      <meta content={TITLE} name="twitter:title" />
      <meta content={DESCRIPTION} name="twitter:description" />
      <meta content="width=device-width, initial-scale=1" name="viewport" />
    </Head>
    <div className={`${sora.className} ${mono.variable}`}>
      <LeetBuildPlayground />
    </div>
  </>
));
Home.displayName = 'Home';

export default Home;
