import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Embedding service: a bounded batch API with replays → a vector cache keyed by model version and
 * written once → a model server client with a deadline, one retry and a model check → one
 * document-keyed event after every chunk is stored → an exact-key read that names the model.
 */
export const embeddingServiceProblem: Problem = {
  id: 'embedding-service',
  title: 'Embedding Service',
  tagline: 'Bounded batches, a vector cache keyed by model version, and an event per stored document.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Embedding Service

Retrieval starts with vectors. One service turns text into them for every tenant, keeps them so a
document is embedded once per model, and tells the indexer when a document is complete. A vector
only means something next to vectors from the same model, so the model version travels with every
vector the service stores, reads or announces.

## The real system

OpenAI's \`POST /v1/embeddings\` takes an array of at most 2048 inputs, caps each input at 8192
tokens and a request at 300,000 tokens summed across its inputs, and names the model in every
response. Behind an endpoint like that sit a model server with deadlines, a vector cache whose key
includes the model, and a pipeline that indexes a document once all of its chunks are embedded.

## What you build here

One service, **embedd**, with five pieces sharing the \`embedding\` support package: \`config\` (the
model server at \`MODEL_SERVER\`, \`MODEL_VERSION = embed-v2\` and \`PREVIOUS_VERSION = embed-v1\`
with their \`DIMENSIONS\`, \`TOPIC\`, \`content_hash\`, \`vector_key\`, \`EmbedError\`, \`Chunk\`),
\`cache\`, \`replays\` and \`outbox\`:

1. \`POST /v1/embeddings\` with \`{"inputs": [...]}\`, \`X-Tenant-Id\` and \`Idempotency-Key\`: 1..256
   inputs of at most 8 KiB each, embedded through step 3's \`embed\`, and a replay answered from
   \`replays\` instead of the model.
2. **Redis**: \`store_vector(tenant, model_version, text, compute)\` writes
   \`emb:{tenant}:{model}:{hash}\` with one \`SET NX EX\`, first writer wins; provided to the later
   steps as \`cache.store_vector\` beside \`cache.read_vector\`.
3. **gRPC** \`Embedder.Embed\` (\`embedder.proto\`): \`embed(text, model_version)\` under a 2-second
   deadline, two attempts, \`UNAVAILABLE\` retried, a reply from another model refused.
4. **Kafka**: \`publish_ready(tenant, document_id, chunks)\` stores every chunk's vector, then
   produces one \`embed.ready\` event keyed by document id with \`acks=all\`; a refused record goes to
   the outbox from the delivery report.
5. \`GET /v1/embeddings/{content_hash}?model_version=\`: the tenant's vector under that model, read
   by its exact key, 404 on a miss, with the model and dimension in the body.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Tokenization and token-based limits and pricing, chunking documents, the outbox relay, batching
inputs into one model call, and the retriever that consumes the vectors.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'X-Tenant-Id · Idempotency-Key', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'embedd', sub: 'POST · GET /v1/embeddings', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'emb:{tenant}:{model}:{hash}', x: 50, y: 18},
      {id: 'model', kind: 'grpc', label: 'Model server', sub: 'Embedder.Embed · 2 s', x: 50, y: 50},
      {id: 'topic', kind: 'kafka', label: 'embed.ready', sub: 'key = document id', x: 50, y: 84},
      {id: 'outbox', kind: 'db', label: 'Outbox', sub: 'refused records', x: 74, y: 70},
      {id: 'indexer', kind: 'service', label: 'Indexer', sub: 'one event per document', x: 76, y: 30},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'store_vector · read_vector · replays'},
      {from: 'api', to: 'model', kind: 'grpc', label: 'Embed'},
      {from: 'api', to: 'topic', kind: 'kafka', label: 'produce after the writes'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'delivery failed'},
      {from: 'topic', to: 'indexer', kind: 'kafka', label: 'consume'},
      {from: 'indexer', to: 'api', kind: 'http', label: 'GET vectors'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
