import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Vision inference: the course is not "call a model with an image", it is the debugging you owe a
 * vision service before it serves tenants. A validated, scoped, idempotent upload contract, a
 * per-tenant GPU admission pool with an owner-checked release, a model call with a deadline that
 * records its downgrade instead of inventing a label, per-version quality events with digests and
 * an outbox, and a read path with a tenant scope and a shelf life.
 */
export const visionInferenceProblem: Problem = {
  id: 'vision-inference',
  title: 'Vision Inference',
  tagline: 'Image inference with tenant-scoped storage keys, a GPU admission pool and results that expire.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Vision Inference

A vision inference service is the piece of an AI platform that turns an image into a prediction for
many tenants at once. The visible part is a label and a confidence; the parts that decide whether the
platform is safe are the storage scope, the GPU admission pool, the failure policy in front of the
models, and the retention of the results it has already produced.

## The real system

NVIDIA Triton Inference Server ships the admission half of this course: its rate limiter
(\`--rate-limit=execution_count\`) schedules requests onto model instances only when the resources an
instance group declares are free, with a priority per model, so one hot model cannot starve the
rest of the GPU; without it, every request is dispatched as soon as an instance is idle. The tenant
half lives in the service in front of it. Multi-tenant vision APIs accept a key inside the tenant's
own prefix and reject everything else before a byte is read, call the models under a deadline and
record a downgrade to the small model in the response rather than replacing it with a fabricated
label, publish one event per inference keyed so per-version quality streams stay ordered and carry
digests rather than bytes or URLs, and expire results on a schedule while keeping the metadata that
proves a decision was made, because keeping predictions forever builds a training set of tenant
data nobody agreed to.

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

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. Your job in every step is the job you will have on a real feature: debug it against
the failure modes, fix it, optimize what is wasteful, and prove the fix with checks that fail on the
starter and pass on your version.

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
