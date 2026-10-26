import type {Problem} from '@/lib/types';

import {CPP_DIGEST_H} from '../cpp-support';
import {learn} from './learn';
import {byteRangesStep} from './steps/1-byte-ranges';

/**
 * Drill: RFC 9110 byte ranges on one GET route. One range answers 206 with the exact slice, an impossible
 * one 416 with the real length, anything doubtful the whole file, and If-Range keeps a resumed download
 * from stitching two versions together.
 */
export const httpRangeRequestsProblem: Problem = {
  id: 'http-range-requests',
  title: 'Range requests: 206, 416, If-Range',
  tagline:
    'GET /files/{name} with byte ranges: suffix, open-ended and clamped ranges as 206, impossible ones as 416 bytes */len, and a stale If-Range that falls back to the whole file.',
  difficulty: 'hard',
  concepts: ['http'],
  minutes: 40,
  statement: `# Range requests: 206, 416, If-Range

A range request asks for part of a file: \`Range: bytes=500-999\`. The server answers **206 Partial
Content** with exactly those bytes and \`Content-Range: bytes 500-999/1000\`. It is how a download manager
resumes after a dropped connection, how a video player seeks to minute 40, and how a ZIP or Parquet reader
fetches the index at the end of a file first. CDNs fetch large objects from origins the same way. The
rules are RFC 9110 §14.

The hard part is not the slice but everything around it: the three forms of a range spec, clamping, the
difference between a range that is malformed (ignore it) and one that asks for bytes that do not exist
(416), and \`If-Range\`, which makes a resumed request conditional on the version so the client never ends
up with the first half of one file and the second half of another.

The surface is one route, \`GET /files/{name}\`, over a module-level \`FILES\` (name → bytes). Every 200,
206 and 416 carries \`Accept-Ranges: bytes\` and a strong \`ETag\` (a quoted sha256 prefix); bodies are
\`application/octet-stream\`; an unknown name is 404.

## What you build here

1. The \`GET /files/{name}\` handler: \`bytes=a-b\`, \`bytes=a-\` and \`bytes=-n\` as 206 with an exact
   \`Content-Range\` and body; \`a >= len\`, \`bytes=-0\` and any range on an empty file as 416
   \`bytes */len\`; malformed ranges, other units and several ranges as 200 with the whole file; and an
   \`If-Range\` that is not a strong match of the current ETag as 200 with the whole file.

## Left out on purpose

\`multipart/byteranges\` (several ranges are served whole, a documented choice), \`Last-Modified\` and
date-form \`If-Range\`, \`HEAD\`, \`If-None-Match\`/304, streaming the slice from disk, TLS, and the CDN in
front.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Downloader · player', sub: 'Range · If-Range', x: 22, y: 50},
      {id: 'service', kind: 'service', label: 'files_api', sub: 'GET /files/{name} · FILES', x: 72, y: 50},
    ],
    edges: [{from: 'client', to: 'service', kind: 'http', label: '206 slice · 416 */len · 200 whole'}],
  },
  steps: [byteRangesStep],
  support: {cpp: {'sha256.h': CPP_DIGEST_H}},
  learn,
};
