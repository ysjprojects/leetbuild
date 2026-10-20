import type {Problem} from '@/lib/types';

import {ingestDocumentStep} from './steps/1-ingest-document';
import {chunkEmbedStep} from './steps/2-chunk-embed';
import {hybridRetrieveStep} from './steps/3-hybrid-retrieve';
import {groundedAnswerStep} from './steps/4-grounded-answer';
import {evalGateStep} from './steps/5-eval-gate';

/**
 * RAG service on the AI-era track: the course is not "wire an LLM to a vector store", it is the
 * review you owe a model-generated draft before it touches a tenant's documents. Idempotent
 * ingest with a transactional outbox → deterministic chunking and bounded embedding retries →
 * tenant-scoped hybrid retrieval with real citation offsets → grounded answers that treat
 * retrieved text as data → an eval gate that can block a prompt or model release.
 */
export const ragServiceProblem: Problem = {
  id: 'rag-service',
  title: 'RAG Service',
  tagline: 'Ingest, chunk, retrieve and answer over tenant documents — then gate releases on evals, not vibes.',
  difficulty: 'hard',
  concepts: ['http', 'grpc', 'redis', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# RAG Service

A RAG service turns a tenant's documents into grounded answers. The model is the visible part;
the parts that decide whether the product is safe are the ingestion contract, the chunk identity,
the tenant boundary on retrieval, and the eval gate in front of every release.

## The real system

Production RAG platforms ingest documents continuously, keep multiple versions of the same
document, and serve many tenants from one index. They use hybrid retrieval because embeddings miss
exact identifiers that keyword search catches, and keyword search misses paraphrases that embeddings
catch. They attach citations that point at character offsets a UI can highlight. They treat every
retrieved string as untrusted input, because one poisoned document can otherwise steer every answer
in the tenant. And they do not ship a prompt "because it looked better in the demo": they score it
against golden labels and block regressions.

## What you build here

One service, **ragd**, with five pieces:

1. \`POST /v1/documents\`: authenticated tenant, validated document, SHA-256 idempotency keyed by
   \`(tenant, doc_id, version, hash)\`, and a document row plus outbox row committed together.
2. A **Kafka** consumer that chunks at ~800 characters with 100-character overlap, gives every chunk
   a deterministic id, embeds batches of 32 over **gRPC** with a 2-second deadline, retries only
   retryable statuses, and upserts by chunk id.
3. **Redis** hybrid retrieval: a per-tenant lexical index, a vector index filtered by tenant, rank
   fusion, a hard cap of 20 candidates, and citations with real offsets.
4. \`POST /v1/answer\`: a prompt that delimits retrieved text as untrusted data, refuses when no span
   supports an answer, and returns only citations whose quote is a literal substring of the chunk.
5. An **eval** consumer in group \`rag-eval\` that computes groundedness, recall@k and refusal
   correctness over at least 200 samples, blocks releases below threshold or more than 1% worse
   than the previous release, and stores metrics before committing offsets.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

OCR and PDF parsing, embedding-model training, vector-index operations, reranking, streaming answers,
prompt caching, human review queues and per-tenant cost accounting. The five pieces above are the
ones that decide whether the service is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'upload · ask', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'RAG API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'documents · outbox', sub: 'tx + eval metrics', x: 45, y: 14},
      {id: 'kafka', kind: 'kafka', label: 'doc.ingest', sub: 'key = tenant:doc_id', x: 45, y: 50},
      {id: 'events', kind: 'kafka', label: 'answer.events', sub: 'answer ids, no text', x: 45, y: 86},
      {id: 'worker', kind: 'service', label: 'Chunk/embed worker', sub: 'group chunk-embed', x: 64, y: 34},
      {id: 'redis', kind: 'redis', label: 'Redis index', sub: 'lex · chunk · cache', x: 64, y: 64},
      {id: 'embed', kind: 'grpc', label: 'Embedding service', sub: 'Embed(texts)', x: 84, y: 18},
      {id: 'llm', kind: 'grpc', label: 'LLM provider', sub: 'grounded prompt', x: 84, y: 50},
      {id: 'eval', kind: 'service', label: 'Eval consumer', sub: 'group rag-eval', x: 64, y: 92},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'tx: document + outbox'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce doc.ingest'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'candidates · cache'},
      {from: 'api', to: 'embed', kind: 'grpc', label: 'Embed(query)'},
      {from: 'api', to: 'llm', kind: 'grpc', label: 'answer'},
      {from: 'api', to: 'events', kind: 'kafka', label: 'produce answer.events'},
      {from: 'kafka', to: 'worker', kind: 'kafka', label: 'consume'},
      {from: 'worker', to: 'embed', kind: 'grpc', label: 'Embed(batch)'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'upsert chunk'},
      {from: 'events', to: 'eval', kind: 'kafka', label: 'consume rag-eval'},
      {from: 'eval', to: 'db', kind: 'plain', label: 'metrics'},
      {from: 'eval', to: 'events', kind: 'kafka', label: 'eval.metrics'},
    ],
  },
  steps: [ingestDocumentStep, chunkEmbedStep, hybridRetrieveStep, groundedAnswerStep, evalGateStep],
};
