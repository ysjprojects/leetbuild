import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {protoFiles, protoModules} from './proto';
import {pageTokensStep} from './steps/1-page-tokens';

/**
 * Drill: AIP-158 pagination on a gRPC list method. The server owns the page size, the page token is
 * opaque and bound to its shelf, and each page continues strictly after the last id returned, so books
 * added or removed between calls never cause a duplicate or a skip.
 */
export const grpcPageTokensProblem: Problem = {
  id: 'grpc-page-tokens',
  title: 'gRPC pagination with page tokens',
  tagline:
    'ListBooks by AIP-158: page_size defaults and clamps, an opaque token bound to its shelf, keyset by id so a walk survives inserts and deletes, and an empty token only on the last page.',
  difficulty: 'medium',
  concepts: ['grpc'],
  minutes: 25,
  statement: `# gRPC pagination with page tokens

A list method that returns the whole collection works until a shelf holds a million books. AIP-158,
the pagination rules of Google's APIs, splits the answer: the client sends \`page_size\` and the
\`page_token\` from the previous reply, the server returns one page and a \`next_page_token\`, and an
empty token means the end. Google Cloud's list methods, Kubernetes (\`limit\` and \`continue\`) and
Stripe (\`starting_after\`) all page this way.

The token is opaque: clients store it and send it back, nothing else. That lets the server put a
**key** in it instead of an offset. "Skip 50" breaks as soon as a book before the cursor is added or
removed; "everything after \`b-0050\`" does not. The token also names the shelf it came from, so it
cannot be replayed against another one.

The surface is one RPC, \`library.v1.Library/ListBooks(ListBooksRequest{shelf, page_size, page_token})\`
→ \`ListBooksResponse{books: [Book{id, title}], next_page_token}\`, served on \`:9000\` from the module-level
\`SHELVES\` (shelf → {book id → title}), with \`DEFAULT_PAGE_SIZE = 50\` and \`MAX_PAGE_SIZE = 100\`. An
unknown shelf is \`NOT_FOUND\`; a negative \`page_size\`, a malformed token or another shelf's token is
\`INVALID_ARGUMENT\`.

## What you build here

1. \`ListBooks\`: validate the shelf and \`page_size\`, decode the token, return the books with
   \`id > after\` in ascending order (at most one page), and a token for the last of them only while
   more books follow.

## Left out on purpose

\`total_size\`, \`skip\`, \`filter\` and \`order_by\` (a real token binds those too), signing or encrypting
the token, token expiry, a database index behind the store, and going backwards.`,
  diagram: {
    nodes: [
      {id: 'clients', kind: 'client', label: 'Clients', sub: 'ListBooks(shelf, page_size, page_token)', x: 18, y: 50},
      {id: 'library', kind: 'grpc', label: 'Library', sub: 'library.v1 · keyset by id · :9000', x: 52, y: 50},
      {id: 'catalogue', kind: 'service', label: 'Catalogue', sub: 'adds and removes books in SHELVES', x: 84, y: 50},
    ],
    edges: [
      {from: 'clients', to: 'library', kind: 'grpc', label: 'ListBooks · next_page_token'},
      {from: 'catalogue', to: 'library', kind: 'plain', label: 'writes between pages'},
    ],
  },
  steps: [pageTokensStep],
  support: {python: protoModules, typescript: protoFiles},
  learn,
};
