import Head from 'next/head';
import Link from 'next/link';
import {type FC, memo} from 'react';

import {linkClass} from '@/components/paneShared';

const NotFound: FC = memo(() => (
  <>
    <Head>
      <title>Not found — LeetBuild</title>
      <meta content="width=device-width, initial-scale=1" name="viewport" />
    </Head>
    <main className="bg-ink-900 text-ink-200 flex h-dvh flex-col items-center justify-center gap-2 px-4 text-center">
      <p className="font-code text-iris-400 text-[11px] font-bold uppercase tracking-wider">404</p>
      <h1 className="text-ink-50 text-2xl font-extrabold">No such course or step</h1>
      <p className="text-ink-300 text-[13px]">That address does not match any course or step.</p>
      <Link className={`mt-2 text-[13px] ${linkClass}`} href="/">
        ← all problems
      </Link>
    </main>
  </>
));
NotFound.displayName = 'NotFound';

export default NotFound;
