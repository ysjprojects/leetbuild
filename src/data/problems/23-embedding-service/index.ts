import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Embedding service — bounded batches, a version-aware vector cache, and an event that fires only
 * after every chunk is durable. Every step ships a plausible model-generated draft that compiles
 * and demos well but fails under upgrade, concurrency or partial failure.
 */
export const embeddingServiceProblem: Problem = {
  id: 'embedding-service',
  title: 'Embedding Service',
  tagline: 'Batch embeddings with a version-aware cache and a document-ready event.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `Build the embedding service behind retrieval. \`POST /v1/embeddings\` turns up to 256
inputs into vectors for the authenticated tenant; \`GET /v1/embeddings/{content_hash}\` serves a
cached vector without paying the model server twice. Cached vectors are namespaced by model version,
so an upgrade can never serve the previous model's output. When every chunk of a document is stored,
one \`embed.ready\` event is published keyed by the document id — and if the broker rejects it, the
event goes to the outbox instead of being lost.`,
  diagram: {
    nodes: [
      {id: 'client', label: 'Client', kind: 'client', x: 6, y: 50},
      {id: 'api', label: 'Embedding API', kind: 'http', x: 28, y: 50},
      {id: 'redis', label: 'Vector cache', kind: 'redis', x: 50, y: 20},
      {id: 'meta', label: 'vectors · documents', kind: 'db', x: 50, y: 80},
      {id: 'model', label: 'Model server', kind: 'grpc', x: 72, y: 12},
      {id: 'fallback', label: 'Fallback model', kind: 'external', x: 72, y: 40},
      {id: 'outbox', label: 'Outbox', kind: 'db', x: 72, y: 70},
      {id: 'topic', label: 'embed.ready', kind: 'kafka', x: 92, y: 24},
      {id: 'indexer', label: 'Indexer', kind: 'service', x: 92, y: 76},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'GET / SET vectors'},
      {from: 'api', to: 'meta', kind: 'plain', label: 'idempotency · documents'},
      {from: 'api', to: 'model', kind: 'grpc', label: 'Embed'},
      {from: 'model', to: 'fallback', kind: 'grpc', label: 'on UNAVAILABLE'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'undelivered event'},
      {from: 'api', to: 'topic', kind: 'kafka', label: 'produce embed.ready'},
      {from: 'topic', to: 'indexer', kind: 'kafka', label: 'consume'},
      {from: 'indexer', to: 'redis', kind: 'redis', label: 'chunk vectors'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
