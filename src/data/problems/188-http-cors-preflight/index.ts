import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {corsPreflightStep} from './steps/1-cors-preflight';

/**
 * Drill: CORS written by hand on a small notes API. Preflights are answered before routing against an
 * exact origin allowlist, actual requests echo an allowed origin with credentials, and every response
 * says what it varies on.
 */
export const httpCorsPreflightProblem: Problem = {
  id: 'http-cors-preflight',
  title: 'CORS: preflight, allowlist, Vary',
  tagline:
    'Answer OPTIONS preflights with an exact grant or a bare 403, echo only allowlisted origins with credentials, never the wildcard, and Vary on Origin everywhere.',
  difficulty: 'easy',
  concepts: ['http'],
  minutes: 15,
  statement: `# CORS: preflight, allowlist, Vary

A page on \`https://app.example.com\` that calls \`https://api.example.com\` is making a cross-origin
request, and the browser will only hand the response to the page's script if the API says so in
\`Access-Control-*\` headers. For anything beyond a plain form-style request (a JSON body, an
\`Authorization\` header, a \`DELETE\`) the browser first asks with a **preflight**: an \`OPTIONS\` request
carrying \`Origin\`, \`Access-Control-Request-Method\` and \`Access-Control-Request-Headers\`. Every single-page
app on a separate API host, every admin console and every embedded widget depends on the server
answering that question exactly.

The server declares; the browser enforces. A grant that is too wide (\`*\`, or echoing whatever \`Origin\`
arrives) lets any site read a logged-in user's data. A response that forgets \`Vary: Origin\` lets a shared
cache hand one origin's answer to another.

The surface is a notes API: \`GET /api/notes\` (200, JSON list), \`POST /api/notes\` (201),
\`DELETE /api/notes/{id}\` (204), with \`ALLOWED_ORIGINS = {"https://app.example.com",
"https://admin.example.com"}\`, methods \`GET, POST, DELETE\`, \`ALLOWED_HEADERS = {"authorization",
"content-type"}\` and \`MAX_AGE = 600\`.

## What you build here

1. CORS on every \`/api/...\` path, without a CORS library: preflights answered before routing (204 with
   \`Allow-Origin\`, \`Allow-Methods\`, \`Allow-Headers\`, \`Allow-Credentials: true\`, \`Max-Age: 600\` and
   \`Vary\`, or 403 with no \`Access-Control-*\` header), and actual requests that always carry
   \`Vary: Origin\` and echo an allowed origin with \`Allow-Credentials: true\`.

## Left out on purpose

\`Access-Control-Expose-Headers\`, Private Network Access preflights, wildcard subdomain allowlists,
CSRF tokens and \`SameSite\` cookies (the protection CORS is not), and loading the allowlist from
configuration per environment.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Browser', sub: 'page on https://app.example.com', x: 20, y: 30},
      {id: 'external', kind: 'external', label: 'Other site', sub: 'page on https://evil.example.com', x: 20, y: 75},
      {id: 'notes', kind: 'service', label: 'notes API', sub: '/api/notes · CORS by hand', x: 70, y: 50},
    ],
    edges: [
      {from: 'client', to: 'notes', kind: 'http', label: 'OPTIONS 204 grant · then GET / POST / DELETE'},
      {from: 'external', to: 'notes', kind: 'http', label: 'OPTIONS 403 · actual requests ungranted'},
    ],
  },
  steps: [corsPreflightStep],
  learn,
};
