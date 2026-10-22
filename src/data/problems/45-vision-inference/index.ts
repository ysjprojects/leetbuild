import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Vision inference on the AI-era track: the course is not "call a model with an image", it is the
 * review you owe a model-generated vision service before it serves tenants. A validated, scoped,
 * idempotent upload contract → a per-tenant GPU admission pool with an owner-checked release → a
 * model call with a deadline that downgrades honestly instead of inventing a label → per-version
 * quality events with digests and an outbox → a read path with a tenant scope and a shelf life.
 */
export const visionInferenceProblem: Problem = {
  id: 'vision-inference',
  title: 'Vision Inference',
  tagline: 'Image inference with tenant quotas, honest fallbacks and results that expire.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Vision Inference

A vision inference service is the piece of an AI platform that turns an image into a prediction for
many tenants at once. The visible part is a label and a confidence; the parts that decide whether the
platform is safe are the storage scope, the GPU admission pool, the failure policy in front of the
models, and the retention of the results it has already produced.

## The real system

Production vision services never dereference what a caller sends: they accept a key inside the
tenant's own prefix and reject everything else before a byte is read. They admit work through a
per-tenant pool so a burst from one customer cannot take the whole GPU, and they let a crashed
worker's admission expire rather than leak slots forever. They call the models under a deadline and,
when the large model is overloaded, recalibrate to the small one **honestly** — the downgrade is in
the response, never replaced by a fabricated label. They publish one event per completed inference,
keyed so per-version quality streams stay ordered, carrying digests rather than bytes or URLs. And
they expire results on a schedule while keeping the metadata that proves a decision was made, because
keeping predictions forever quietly builds a training set of tenant data.

## What you build here

One service, **visiond**, with five pieces:

1. \`POST /v1/inferences\`: authenticated tenant, a task from \`classify\` / \`detect\` / \`embed\`, a
   storage key that must stay inside \`tenants/{tenant}/images/\` (**403 before any fetch**), and an
   \`Idempotency-Key\` keyed by the image's content hash so a retry returns the stored inference.
2. A **Redis** GPU admission pool: 10 concurrent tokens per tenant, acquired by one atomic Lua
   \`EVAL\` with the TTL set at first write, released only by the owner of the ticket, answering
   \`429\` with \`Retry-After\` instead of queueing.
3. A **gRPC** model client: a 2-second deadline per attempt, at most three attempts against the large
   model, only \`UNAVAILABLE\` / \`DEADLINE_EXCEEDED\` retried, an explicit downgrade to the small
   model, and the exact model version on every result.
4. A **Kafka** event path: one \`vision.inference\` event per inference keyed by model version, an
   idempotent producer with \`acks=all\`, a payload of task, latency, confidence summary and digest,
   an outbox row when the produce is rejected, and a consumer that commits after the counter moves.
5. \`GET /v1/inferences/{id}\`: 404 for another tenant's id, 410 with metadata once the result has
   expired, 202 while the worker is still writing it.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Video and multi-image batches, model serving details (batching, quantization, warm pools), media type
sniffing and EXIF handling, per-tenant byte quotas, billing, the labeling UI, and the training
pipeline that consumes the events. The five pieces above are the ones that decide whether the vision
service is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Vision API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'store', kind: 'db', label: 'Object store', sub: 'tenants/{t}/images/', x: 44, y: 8},
      {id: 'db', kind: 'db', label: 'Results', sub: 'predictions · metadata', x: 44, y: 34},
      {id: 'state', kind: 'redis', label: 'Redis', sub: 'tokens · holders', x: 44, y: 62},
      {id: 'worker', kind: 'service', label: 'Inference worker', sub: 'result lock', x: 62, y: 50},
      {id: 'model', kind: 'grpc', label: 'Large model', sub: 'Predict', x: 82, y: 20},
      {id: 'small', kind: 'external', label: 'Small model', sub: 'downgrade target', x: 82, y: 44},
      {id: 'kafka', kind: 'kafka', label: 'vision.inference', sub: 'key = model version', x: 82, y: 68},
      {id: 'consumer', kind: 'service', label: 'Quality consumer', sub: 'per-version counters', x: 62, y: 86},
      {id: 'outbox', kind: 'db', label: 'outbox', sub: 'pending publishes', x: 62, y: 12},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'store', kind: 'plain', label: 'scoped key'},
      {from: 'api', to: 'state', kind: 'redis', label: 'admit · release'},
      {from: 'api', to: 'db', kind: 'plain', label: 'inference · metadata'},
      {from: 'api', to: 'worker', kind: 'plain', label: 'dispatch'},
      {from: 'worker', to: 'model', kind: 'grpc', label: 'Predict · 2 s deadline'},
      {from: 'worker', to: 'small', kind: 'grpc', label: 'downgrade'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce vision.inference'},
      {from: 'worker', to: 'outbox', kind: 'plain', label: 'produce rejected'},
      {from: 'outbox', to: 'kafka', kind: 'kafka', label: 'relay'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'state', kind: 'redis', label: 'HINCRBY quality'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
