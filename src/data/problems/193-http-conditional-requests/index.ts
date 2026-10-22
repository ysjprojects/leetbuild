import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {preconditionsStep} from './steps/1-preconditions';

/**
 * Drill: RFC 9110 conditional requests on one resource: strong ETags and Last-Modified, the §13.2.2
 * evaluation order, weak versus strong comparison, 304 versus 412, and 428 for writes that name no
 * version, which is what makes the lost update impossible.
 */
export const httpConditionalRequestsProblem: Problem = {
  id: 'http-conditional-requests',
  title: 'Conditional requests by the book',
  tagline:
    'If-Match, If-None-Match, If-Modified-Since and If-Unmodified-Since in RFC 9110 order: 304 for caches, 412 for stale writers, 428 for blind ones.',
  difficulty: 'hard',
  concepts: ['http'],
  minutes: 40,
  statement: `# Conditional requests by the book

A conditional request asks the server to act only if its copy is still the one the client knows. The client
names that copy with a validator the server handed out: an \`ETag\` or a \`Last-Modified\` date. Caches use it to
revalidate (\`If-None-Match\`, \`If-Modified-Since\` → \`304 Not Modified\`, no body). Writers use it for optimistic
concurrency (\`If-Match\`, \`If-Unmodified-Since\` → \`412 Precondition Failed\`): two editors who read the same
version cannot both save. Browser caches, CDNs, S3 and WebDAV all run on these four headers.

The rules are exact. RFC 9110 §13.2.2 fixes the order in which the four headers are evaluated, \`If-Match\`
compares tags strongly and \`If-None-Match\` weakly, and a date that does not parse is ignored. RFC 6585 adds
\`428 Precondition Required\` for a server that refuses writes without a condition.

The surface is \`GET\`, \`PUT\` and \`DELETE\` on \`/docs/{id}\`, a PUT body of \`{"text": …}\`, and a module-level
store of \`{text, etag, modified}\`. \`ETag\` is the first 16 hex digits of \`sha256(text)\`, quoted;
\`Last-Modified\` is the IMF-fixdate of the clock at write time. Statuses: 200, 201, 204, 304, 404, 412, 428.

## What you build here

1. \`preconditions\` and the 428: 404 for a missing doc on GET and DELETE; then \`If-Match\` (strong, 412), else
   \`If-Unmodified-Since\` (412), then \`If-None-Match\` (weak, 304 on GET, 412 otherwise), else
   \`If-Modified-Since\` (GET, 304); then 428 for a PUT or DELETE on an existing doc without \`If-Match\`.

## Left out on purpose

HEAD, \`If-Range\` and range requests, \`Cache-Control\` and \`Vary\`, weak ETags minted by the server, the two
obsolete HTTP-date formats, and an atomic compare-and-set in a shared store (here one process on one event loop
holds the store, so check and write cannot interleave).`,
  diagram: {
    nodes: [
      {
        id: 'client',
        kind: 'client',
        label: 'Clients and caches',
        sub: 'If-Match · If-None-Match · dates',
        x: 22,
        y: 50,
      },
      {id: 'service', kind: 'service', label: 'docs API', sub: 'DOCS · id → text, etag, modified', x: 72, y: 50},
    ],
    edges: [{from: 'client', to: 'service', kind: 'http', label: 'GET / PUT / DELETE /docs/{id}'}],
  },
  steps: [preconditionsStep],
  learn,
};
