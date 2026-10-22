import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Code assistant on the AI-era track: the course is not "call a model with a file", it is the review
 * you owe a model-generated completion path before it reads a customer's repository. Repository
 * authorization and a token budget before anything is billed → one atomic Redis index summary per
 * (tenant, repo, commit sha) with checksum invalidation → a deadline-bounded symbol-index call that
 * degrades to the caller's file context → repository-keyed suggestion events carrying token counts
 * and a fingerprint instead of code → a status read whose staleness bound the serve path enforces.
 */
export const codeAssistantProblem: Problem = {
  id: 'code-assistant',
  title: 'Code Assistant',
  tagline: 'Repo-aware completion that respects repository access and context budget.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Code Assistant

A repository-aware code assistant is the piece of an AI platform that completes code where the
developer is already working: it reads the file in the editor, pulls the symbols the surrounding
repository already defines, and asks a model to continue. The visible part is a suggestion; the
parts that decide whether the feature is safe to ship are the repository authorization, the context
budget, the freshness of the index behind every suggestion, and the events that carry the quality
signal without carrying the code.

## The real system

Production assistants answer a completion only for a repository the requesting user may read, and
they decide that from the user's identity rather than from the path in the request, because the
path is caller-supplied and a private repository is one string away. They cap the context they send
to the model, check the cap before the billable call, and key the request by an idempotency token so
the editor's automatic retry does not pay for the same completion twice. They cache the repository's
index summary per commit, never per repository name: a force-push rewrites history, and a cache
keyed by name keeps serving symbols that no longer exist. They call the symbol index under a short
deadline and degrade to the file the caller already sent when the index is slow or rebuilding —
a completion on file context alone is far better than a failed request — and they scope every
returned symbol to the repository boundary the request named. They publish one suggestion event per
accepted or rejected completion, keyed by repository so a repository's quality signal stays ordered,
carrying token counts and a fingerprint of the code rather than the code itself, on an idempotent
producer with \`acks=all\` and an outbox row when the broker rejects the produce. And the status the
editor polls reports the commit that is actually indexed: a suggestion served from an index that is
many commits behind is worse than no suggestion, so the serve path refuses one.

## What you build here

One service, **assistd**, with five pieces:

1. \`POST /v1/completions\`: authenticated tenant, repository authorization before anything is read,
   a context cap of 8 KiB of tokens counted before the model call, and an \`Idempotency-Key\` so a
   replayed request returns the stored completion instead of billing a second one.
2. A **Redis** index cache: one summary per \`(tenant, repo, commit sha)\` with a 10-minute TTL,
   written by a single atomic set and never read across commits.
3. A **gRPC** symbol-index client: a 300 ms deadline per call, a file-only fallback that marks the
   result degraded, no retry against an index that reports it is rebuilding, and symbols filtered to
   the requested repository.
4. A **Kafka** suggestion path: one \`assistant.suggestion\` event per completion keyed by
   repository, an idempotent producer with \`acks=all\`, token counts and a code fingerprint instead
   of the code, and an outbox row when the broker rejects the produce.
5. \`GET /v1/repos/{id}/index/status\`: the indexed commit sha, the symbol count and whether the
   index is current, plus the staleness bound the completion path enforces.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Embedding-based retrieval, multi-file context assembly, model-specific tokenizers, model routing,
the editor protocol itself (LSP, inline diffing), incremental indexing internals, per-seat billing,
prompt caching, and personalization. The five pieces above are the ones that decide whether a
completion respects repository access, stays inside its context budget and can be trusted.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Editor', sub: 'completion · status', x: 8, y: 50},
      {id: 'assistant', kind: 'http', label: 'Code Assistant', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'access', kind: 'service', label: 'Repo access', sub: 'ACL · private repos', x: 45, y: 8},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'index cache · status', x: 45, y: 44},
      {id: 'kafka', kind: 'kafka', label: 'assistant.suggestion', sub: 'key = repository', x: 45, y: 88},
      {id: 'indexer', kind: 'grpc', label: 'Symbol index', sub: 'Symbols · 300 ms', x: 68, y: 16},
      {id: 'files', kind: 'external', label: 'File context', sub: 'caller-provided file', x: 68, y: 44},
      {id: 'inference', kind: 'grpc', label: 'Model provider', sub: 'Complete', x: 68, y: 70},
      {id: 'consumer', kind: 'service', label: 'Quality consumer', sub: 'group repo-quality', x: 87, y: 88},
    ],
    edges: [
      {from: 'client', to: 'assistant', kind: 'http', label: 'HTTPS'},
      {from: 'assistant', to: 'access', kind: 'plain', label: 'can_read · ACL'},
      {from: 'assistant', to: 'redis', kind: 'redis', label: 'index cache · status'},
      {from: 'assistant', to: 'indexer', kind: 'grpc', label: 'Symbols'},
      {from: 'assistant', to: 'files', kind: 'plain', label: 'file context'},
      {from: 'assistant', to: 'inference', kind: 'grpc', label: 'Complete'},
      {from: 'assistant', to: 'kafka', kind: 'kafka', label: 'produce assistant.suggestion'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY quality'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
