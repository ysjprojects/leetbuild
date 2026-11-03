import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {ingestDocumentStep} from './steps/1-ingest-document';
import {chunkEmbedStep} from './steps/2-chunk-embed';
import {hybridRetrieveStep} from './steps/3-hybrid-retrieve';
import {groundedAnswerStep} from './steps/4-grounded-answer';
import {evalGateStep} from './steps/5-eval-gate';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * RAG service: the debugging a retrieval pipeline owes before it answers over a tenant's documents. A
 * versioned ingest with an outbox in one transaction → deterministic chunks embedded in bounded,
 * deadlined batches → tenant-prefiltered hybrid retrieval fused with RRF and cached per tenant → an
 * answer that keeps retrieved text out of the instructions and verifies every quote → an eval gate
 * that blocks a release on evidence. The embedder and the answer model are deterministic stand-ins
 * the harness serves over gRPC.
 */
export const ragServiceProblem: Problem = {
  id: 'rag-service',
  title: 'RAG Service',
  tagline:
    'Cited answers over tenant documents, from a versioned ingest to the eval gate that decides whether a release ships.',
  difficulty: 'hard',
  concepts: ['http', 'grpc', 'redis', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# RAG Service

A RAG service turns a tenant's documents into answers that cite them. The model writes the prose; what
decides whether an answer can be trusted is the path around it: which version of a document was
indexed, whose chunks were searched, which text the model was told to obey, and which release was
allowed to ship.

## The real system

Azure AI Search runs a hybrid query as a keyword (BM25) query and a vector query in parallel, then
merges the two ranked lists with Reciprocal Rank Fusion: a result scores 1/(rank + k) in every list it
appears in, with k = 60, and the sums decide the order. A chunk both retrievers rank well beats one
only a single retriever likes; this course's retrieval step does the same fusion over Redis.

## What you build here

One service, **ragd**, with five pieces sharing one contract, the \`rag\` support package (\`config\`:
the model addresses, the topics, the document key, the system prompt, the token estimate; \`docs\`,
\`search\`, \`embed\`, \`evalstore\`):

1. \`POST /v1/documents\` with \`X-Tenant-Id\` and \`{doc_id, version, content_type, content}\`: a version is
   stored once at \`rag:doc:{tenant}:{doc_id}:{version}\`, and its \`doc.ingest\` event (ids and the hash)
   joins the outbox list \`rag:outbox\` in the same transaction; a relay publishes it.
2. **Chunk worker** \`index_document(tenant, doc_id, version)\`: 800-character chunks overlapping by 100,
   ids \`sha256("{tenant}:{doc_id}:{version}:{start}")\`, \`Embedder.Embed\` over gRPC in batches of 32
   with a two-second deadline and three attempts, \`search.upsert\` by chunk id.
3. **Retrieval** \`retrieve(tenant, query, k)\`: \`search.lexical\` and a tenant-prefiltered \`search.knn\`
   fused with RRF (k = 60), at most 20 hits with their offsets, cached 60 s per tenant.
4. \`POST /v1/answer\` with \`{query, k}\`: \`Llm.Generate\` with the fixed system prompt and the hits as
   passages, at most 3000 tokens of them; a citation survives only when its quote is in the passage;
   \`I don't know\` when nothing supports an answer.
5. **Eval gate**, consumer group \`rag-eval\` on \`eval.samples\`: \`evalstore.record\` per sample, the offset
   committed after it, one verdict per release on \`eval.metrics\` at 200 samples, \`block\` below 0.95
   groundedness, below 0.90 recall@k, or more than 0.01 under the last release that passed.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and it
looks right. In every step, debug it against the failure modes the task names, fix it, and prove the
fix with checks that fail on the starter and pass on your version.

## Left out on purpose

OCR and PDF parsing, the outbox relay, deleting the chunks of a replaced version, reranking, streaming
answers, prompt caching, and the runner that replays golden questions against a release. The five
pieces above decide whether the service is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'upload · ask', x: 8, y: 40},
      {id: 'api', kind: 'http', label: 'ragd API', sub: 'documents · answer', x: 28, y: 40},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'docs · outbox · chunks · cache · eval', x: 50, y: 40},
      {id: 'llm', kind: 'grpc', label: 'Llm', sub: 'Generate', x: 28, y: 85},
      {id: 'worker', kind: 'service', label: 'Chunk worker', sub: 'index_document', x: 72, y: 15},
      {id: 'embed', kind: 'grpc', label: 'Embedder', sub: 'Embed · 2 s', x: 92, y: 15},
      {id: 'events', kind: 'kafka', label: 'eval.samples', sub: 'key = release', x: 92, y: 65},
      {id: 'eval', kind: 'service', label: 'Eval gate', sub: 'group rag-eval', x: 72, y: 65},
      {id: 'metrics', kind: 'kafka', label: 'eval.metrics', sub: 'one verdict per release', x: 72, y: 92},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/documents · /v1/answer'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'MULTI doc + outbox · search · cache'},
      {from: 'api', to: 'llm', kind: 'grpc', label: 'Generate(system, passages)'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'docs.get · upsert'},
      {from: 'worker', to: 'embed', kind: 'grpc', label: 'Embed(batch of 32)'},
      {from: 'events', to: 'eval', kind: 'kafka', label: 'consume'},
      {from: 'eval', to: 'redis', kind: 'redis', label: 'EVALSHA record'},
      {from: 'eval', to: 'metrics', kind: 'kafka', label: 'verdict'},
    ],
  },
  steps: [ingestDocumentStep, chunkEmbedStep, hybridRetrieveStep, groundedAnswerStep, evalGateStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
