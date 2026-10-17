import type {GetStaticPaths, GetStaticProps} from 'next';
import Head from 'next/head';
import Link from 'next/link';
import {useRouter} from 'next/router';
import {type FC, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {LinkedInButton, POST_HINT, PROFILE_HINT} from '@/components/Social';
import {problems} from '@/data/problems';
import {downloadCertificate, drawCertificate} from '@/lib/certificate';
import {STEP_POINTS} from '@/lib/scoring';
import {
  type CertificateDetails,
  type CourseSummary,
  certificateId,
  certificateTitle,
  certificateUrl,
  courseShareText,
  linkedInAddCertificateUrl,
  linkedInPostUrl,
  summarize,
} from '@/lib/social';
import {type Language, LANGUAGES} from '@/lib/types';

/**
 * A certificate's own page: pre-rendered per course (so a LinkedIn link unfurls with the course's
 * title), with the learner's details in the query string — name, date, language, score, time, id
 * — drawn on the same canvas the download uses. There is no server: the id is reproducible from
 * the details, nothing more. `/certificate/<course>?n=…&d=…&l=…&s=…&id=…`. Only a summary of the
 * course reaches the browser; the course data itself stays in the build.
 */

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

interface Props {
  course: CourseSummary;
}

const Certificate: FC<{course: CourseSummary}> = memo(({course}) => {
  const router = useRouter();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [origin, setOrigin] = useState(SITE_URL ?? '');
  useEffect(() => {
    if (SITE_URL === undefined) setOrigin(window.location.origin);
  }, []);
  const details = useMemo((): CertificateDetails | null => {
    if (!router.isReady) return null;
    const q = router.query;
    const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
    const name = one(q.n)?.trim();
    const completedAt = Number(one(q.d));
    const language = one(q.l);
    if (!name || !Number.isFinite(completedAt) || !LANGUAGES.includes(language as Language)) return null;
    // The scale the certificate was earned on; links issued before `m` existed fall back to today's.
    const issuedMax = Number(one(q.m));
    const max =
      Number.isInteger(issuedMax) && issuedMax > 0 ? issuedMax : STEP_POINTS[course.difficulty] * course.steps;
    const score = Math.min(max, Math.max(0, Number(one(q.s)) || 0));
    const time = Number(one(q.t));
    return {
      name,
      problem: course,
      completedAt,
      language: language as Language,
      score,
      max,
      time: Number.isFinite(time) && time > 0 ? time : null,
    };
  }, [course, router.isReady, router.query]);
  const claimedId = Array.isArray(router.query.id) ? router.query.id[0] : router.query.id;
  const idMatches = details !== null && certificateId(details) === claimedId;
  const url = details === null ? '' : certificateUrl(origin, details);
  useEffect(() => {
    if (details !== null && canvas.current !== null) drawCertificate(canvas.current, details, url);
  }, [details, url]);
  const onDownload = useCallback(() => {
    if (details !== null) void downloadCertificate(details, url);
  }, [details, url]);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <p className="text-iris-400 text-[11px] font-bold uppercase tracking-wider">Certificate of completion</p>
      <h1 className="text-ink-50 mt-1 text-2xl font-extrabold leading-tight">{course.title}</h1>
      <p className="text-ink-300 mt-1 text-[13px]">{course.tagline}</p>
      {!router.isReady ? null : details === null ? (
        <p className="border-warning-400/50 bg-warning-400/10 text-warning-200 mt-6 rounded-xl border p-4 text-[13px]">
          This certificate link is incomplete. Certificates are issued on the course page once every step is accepted.
        </p>
      ) : (
        <>
          <canvas
            aria-label="certificate"
            className="border-ink-700 mt-6 w-full rounded-xl border shadow-2xl"
            ref={canvas}
          />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              className="bg-iris-400 text-ink-950 hover:bg-iris-300 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition"
              onClick={onDownload}
              type="button">
              ⤓ Download PNG
            </button>
            <LinkedInButton
              label="Add to LinkedIn profile"
              title={PROFILE_HINT}
              tone="solid"
              url={linkedInAddCertificateUrl(details, url)}
            />
            <LinkedInButton
              label="Share on LinkedIn"
              title={POST_HINT}
              tone="solid"
              url={linkedInPostUrl(courseShareText(details, url))}
            />
            <span
              className="font-code text-ink-400 ml-auto text-[11px]"
              title={idMatches ? 'the id matches these details' : 'the id does not match these details'}>
              {certificateId(details)}
              {idMatches ? ' ✓' : ' ✗'}
            </span>
          </div>
          <p className="text-ink-400 mt-3 text-[11px]">
            Issued by LeetBuild to {details.name} for completing every step of {course.title}
            {details.time !== null ? ' within its time budget' : ''}. Every step was judged by running the code in the
            browser against Redis, Kafka, gRPC and Postgres. The id is derived from these details; LeetBuild keeps no
            record of learners.
          </p>
        </>
      )}
      <p className="mt-8 text-[12px]">
        <Link className="text-iris-300 decoration-iris-400/50 hover:text-iris-200 underline" href={`/${course.id}`}>
          Open the {course.title} course on LeetBuild →
        </Link>
      </p>
    </main>
  );
});
Certificate.displayName = 'Certificate';

const Page: FC<Props> = memo(({course}) => {
  const title = `Certificate · ${certificateTitle(course)}`;
  const description = `Certificate of completion for the ${course.title} course on LeetBuild: ${course.tagline}`;
  const url = SITE_URL === undefined ? undefined : `${SITE_URL}/certificate/${course.id}`;
  return (
    <>
      <Head>
        <title>{title}</title>
        <meta content={description} name="description" />
        <meta content="noindex" name="robots" />
        <meta content={title} property="og:title" />
        <meta content={description} property="og:description" />
        <meta content="article" property="og:type" />
        {url !== undefined ? <meta content={url} property="og:url" /> : null}
        <meta content={title} name="twitter:title" />
        <meta content={description} name="twitter:description" />
        <meta content="width=device-width, initial-scale=1" name="viewport" />
      </Head>
      <div className="bg-ink-900 text-ink-100 min-h-dvh">
        <Certificate course={course} />
      </div>
    </>
  );
});
Page.displayName = 'CertificatePage';

export default Page;

export const getStaticPaths: GetStaticPaths = () => ({
  paths: problems.map(problem => ({params: {course: problem.id}})),
  fallback: false,
});

export const getStaticProps: GetStaticProps<Props, {course: string}> = ({params}) => {
  const problem = problems.find(p => p.id === params?.course);
  if (problem === undefined) return {notFound: true};
  return {props: {course: summarize(problem)}};
};
