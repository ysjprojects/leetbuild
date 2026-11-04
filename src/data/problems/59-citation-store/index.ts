import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {citationEndpointStep} from './steps/1-endpoint';
import {citationStateStep} from './steps/2-state';
import {citationClientStep} from './steps/3-client';
import {citationEventsStep} from './steps/4-events';
import {readCitationsStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Citation store: the course is not "save a quote and a link", it is the debugging you owe a
 * citation store before anyone trusts the answer it supports. Spans checked against the named
 * version at write time → a Redis span cache keyed by that immutable version → a gRPC verifier that
 * re-anchors or marks a citation broken under a deadline → document-keyed lineage events committed
 * first, with an outbox → a read that names its evidence and reports the worst status.
 */
export const citationStoreProblem: Problem = {
  id: 'citation-store',
  title: 'Citation Store',
  tagline: 'Quotes pinned to character offsets in an immutable document version, re-checked after every edit.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Citation Store

A citation store lets an answer name its evidence: this quote, from this document, at these offsets,
in this version. Whether the answer can be trusted depends on the offset arithmetic, the version the
offsets resolve against, what happens when the document store does not answer, and whether a
document's citation history survives an edit.

## The real system

The Claude Messages API's citations feature returns, for each cited passage of a plain-text
document, a \`char_location\` block with the \`cited_text\`, the \`document_index\` and the
\`start_char_index\` / \`end_char_index\` the quote was taken from. The quote is extracted from the
source rather than generated, which is what makes an offset pair worth storing; a store that keeps
such citations has to defend that guarantee against later versions of the document.

## What you build here

One service, **citations**, on two provided stores in Redis: \`citations.documents\` (immutable
versions, \`get_version\`, \`latest\`, \`add_version\`) and \`citations.store\` (the hash
\`citation:{id}\` with tenant, answer, document, version, start, end, quote, status and reason;
\`create\`, \`get\`, \`for_answer\`, \`set_verification\`, \`by_key\` / \`bind_key\` for
Idempotency-Keys, \`insert_outbox\`). A citation is \`pending\` until the verifier sets
\`verified\` or \`broken\`.

1. \`POST /v1/citations\`: a tenant, a valid span, the quote compared with the **named version**
   (422 with both texts), and an \`Idempotency-Key\`.
2. \`GET /v1/spans\`: a **Redis** span cache under \`span:{document_id}:{version}:{start}:{end}\` with a
   7-day TTL; an unknown version is 404 and not cached.
3. The verifier: \`DocumentStore.GetCurrent\` over **gRPC** with a 1 s deadline and three attempts
   for retryable codes; a moved quote is re-anchored, a vanished one is \`broken\`.
4. \`publish_verification\`: commit the result, then a **Kafka** \`citation.event\` keyed by document
   id from an idempotent \`acks=all\` producer, with an outbox when the broker does not take it.
5. \`GET /v1/citations/{id}\` and \`GET /v1/answers/{id}/citations\`: the stored evidence for the
   owning tenant (404 otherwise) and the answer's worst status.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Text extraction and OCR, byte offsets in binary formats, document storage itself, highlighting UIs,
fuzzy re-anchoring of reworded prose, citation quality scoring, and answer generation.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'cite · read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Citation API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'citation store', sub: 'citation:{id} · versions · outbox', x: 46, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis span cache', sub: 'span:{doc}:{v}:{s}:{e} · 7 d', x: 46, y: 12},
      {id: 'consumer', kind: 'service', label: 'Verifier', sub: 'reanchor · publish_verification', x: 66, y: 72},
      {id: 'docstore', kind: 'grpc', label: 'Document store', sub: 'GetCurrent · 1 s · 3 attempts', x: 86, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'citation.event', sub: 'key = document_id', x: 46, y: 90},
      {id: 'lineage', kind: 'service', label: 'Lineage consumer', sub: 'per-document history', x: 22, y: 90},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'span cache'},
      {from: 'api', to: 'db', kind: 'plain', label: 'create · get · for_answer'},
      {from: 'consumer', to: 'docstore', kind: 'grpc', label: 'GetCurrent(doc)'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'set_verification · outbox'},
      {from: 'consumer', to: 'kafka', kind: 'kafka', label: 'produce after the commit'},
      {from: 'kafka', to: 'lineage', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [citationEndpointStep, citationStateStep, citationClientStep, citationEventsStep, readCitationsStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
