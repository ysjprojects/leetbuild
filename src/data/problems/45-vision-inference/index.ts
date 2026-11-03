import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Vision inference: the debugging a vision service owes before it serves tenants. A request whose
 * storage key stays inside the tenant's prefix → a per-tenant GPU pool of leases in one Lua script →
 * model calls with a deadline, bounded retries and a downgrade the result admits to → events keyed by
 * model version with a digest instead of the image → a read path with a tenant scope and a shelf
 * life. The two models are deterministic stand-ins the harness serves over gRPC.
 */
export const visionInferenceProblem: Problem = {
  id: 'vision-inference',
  title: 'Vision Inference',
  tagline: 'Tenant images through a leased GPU pool to a large model, with a recorded fallback to a small one.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Vision Inference

A vision inference service turns an image into a label and a confidence for many tenants at once. The
label is the visible part; what decides whether the platform is safe is whose image gets read, who
holds the GPU, what the service answers when a model is down, and how long a prediction is served.

## The real system

NVIDIA Triton Inference Server has the admission half built in: with \`--rate-limit\` on, a model
instance runs only when the resources its instance group declares (named counts per device) are
free, they are held for the execution and released after it, and a priority picks the next instance
under contention; with the limiter off, a request is scheduled as soon as an instance is idle. The
tenant half lives in the service in front of it, which is what this course builds.

## What you build here

One service, **visiond**, sharing one contract, the \`vision\` support package (\`config\`: the two
model addresses, the topic, \`GPU_TOKENS\` = 10, \`LEASE_S\` = 300, \`RESULT_TTL_S\` = 30 days, the key
layout; the inference store, the object store stand-in, the outbox):

1. \`POST /v1/inferences\` \`{image, task}\`: a task from the catalog, a storage key inside
   \`tenants/{tenant}/images/\` decided before the fetch, an \`Idempotency-Key\`; the pending inference
   is stored under \`(tenant, key)\` with the SHA-256 of the bytes as \`content_hash\`.
2. **Redis GPU pool**: \`vision:gpu:{tenant}\`, a sorted set of ticket → lease expiry. \`admit\` is one
   Lua script (sweep expired leases, count, add); a refusal says when the earliest lease ends;
   \`release\` removes the caller's ticket only.
3. **Model client** (gRPC \`Predictor.Predict\`, a large and a small deployment the checks serve):
   admit first, a 2-second deadline, three calls to the large model on \`UNAVAILABLE\` or
   \`DEADLINE_EXCEEDED\`, then one call to the small model marked \`downgraded\`, the ticket released on
   every path.
4. **Kafka**: one \`vision.inference\` event per inference keyed by \`model_version\`, with the digest and
   no image reference, an idempotent producer, an outbox row from the delivery report.
5. \`GET /v1/inferences/{id}\`: 404 for another tenant's id, 202 while pending, 410 with metadata after
   30 days.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and it looks right. In every step, debug it against the failure modes the task names, fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Video and multi-image batches, model serving itself (batching, quantization, warm pools), EXIF and
media-type checks, byte quotas, billing, the outbox relay and the quality pipeline that consumes the
events.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'visiond', sub: 'API + worker', x: 28, y: 50},
      {id: 'objects', kind: 'db', label: 'Object store', sub: 'tenants/{t}/images/', x: 50, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'inferences · GPU pool · outbox', x: 50, y: 88},
      {id: 'large', kind: 'grpc', label: 'Large model', sub: 'Predict · 2 s', x: 74, y: 22},
      {id: 'small', kind: 'grpc', label: 'Small model', sub: 'downgrade target', x: 74, y: 46},
      {id: 'kafka', kind: 'kafka', label: 'vision.inference', sub: 'key = model version', x: 74, y: 72},
      {id: 'quality', kind: 'service', label: 'Quality pipeline', sub: 'per-version metrics', x: 93, y: 72},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST · GET inferences'},
      {from: 'api', to: 'objects', kind: 'plain', label: 'fetch scoped key'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'rows · EVALSHA admit · ZREM'},
      {from: 'api', to: 'large', kind: 'grpc', label: 'Predict ×3'},
      {from: 'api', to: 'small', kind: 'grpc', label: 'Predict (downgrade)'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce (digest, no image)'},
      {from: 'kafka', to: 'quality', kind: 'kafka', label: 'consume'},
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
