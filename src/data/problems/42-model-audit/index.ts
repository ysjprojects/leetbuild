import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-client';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Model audit trail: the course is not "write a row when the model answers", it is the debugging
 * you owe an audit service before an auditor trusts it. An append-only endpoint that stores
 * validated digests on the server clock → a per-tenant hash chain written by one Lua
 * compare-and-set → a gRPC receipt signer with a deadline and an unsigned queue → a tenant-keyed
 * `audit.appended` event published after the append, with an outbox → a verify endpoint that
 * recomputes the record and the chain.
 */
export const modelAuditProblem: Problem = {
  id: 'model-audit',
  title: 'Model Audit Trail',
  tagline: 'Model decisions kept as digests on a per-tenant Redis hash chain that the verify endpoint recomputes.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Model Audit Trail

An audit trail is the part of an AI platform that answers a question asked long after the fact:
what did the model decide, under which policy, and can we still prove it. A row per decision is
the easy part. What makes the trail worth anything is what it refuses to store, how its records
depend on each other, what happens to a receipt when the signer is down, and whether verification
recomputes anything at all.

## The real system

immudb is an open source database built for this shape: transactions land in an append-only log
with a Merkle tree over it, and its SDKs offer verified reads that check an inclusion proof against
a state the client keeps itself, so a tampered history is caught on the client instead of trusted
from the server. This course applies the same idea with a hash chain per tenant.

## What you build here

One service, **auditd**, on three provided modules: \`audit.digest\` (\`is_digest\`, \`link_digest\`),
\`audit.ledger\` (the records as Redis hashes \`audit:rec:{id}\`, the signing queue and the outbox) and
\`audit.chain\` (the tenant chains as later steps use them):

1. \`POST /v1/audit/decisions\` with \`{model_version, policy_id, input_digest, decision_digest}\`: the
   tenant from \`X-Tenant-Id\`, digests only, \`recorded_at\` from the server clock, **405** on edits.
2. A **Redis** chain per tenant, \`audit:chain:{tenant}\`: \`link:{n} = link_digest(link:{n-1},
   rec:{n}, n)\`, written by one Lua compare-and-set (\`append_entry\`), walked by \`verify_chain\`.
3. A **gRPC** \`ReceiptSigner.Sign\` per record (\`request_receipt\`): 500 ms per attempt, retries
   only on \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, an \`unsigned\` record queued when it fails.
4. A **Kafka** \`audit.appended\` event keyed by tenant, \`{record_id, tenant, position, digest}\`,
   published after the append (\`append_and_publish\`), with an outbox row when the broker refuses.
5. \`GET /v1/audit/decisions/{id}/verify\`: tenant-scoped (404 for foreign records), recomputes the
   record digest and the chain from it, and answers \`chain_length\` and \`first_divergence\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Model registries, retention and legal hold, signing key rotation, ledger replication, the signing
worker that drains the queue, auditor query tooling, and the policy engine that produced the decision.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'append · verify', x: 8, y: 50},
      {id: 'auditd', kind: 'http', label: 'Audit Service', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis chain', sub: 'audit:chain:{tenant}', x: 46, y: 12},
      {id: 'db', kind: 'db', label: 'ledger · outbox', sub: 'audit:rec:{id} · audit:outbox', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'audit.appended', sub: 'key = tenant', x: 46, y: 86},
      {id: 'signer', kind: 'grpc', label: 'Receipt signer', sub: 'Sign · 500 ms', x: 68, y: 16},
      {id: 'queue', kind: 'external', label: 'Signing queue', sub: 'audit:signing_queue', x: 68, y: 42},
      {id: 'mirror', kind: 'service', label: 'Mirror consumer', sub: 'per-tenant chain order', x: 68, y: 86},
    ],
    edges: [
      {from: 'client', to: 'auditd', kind: 'http', label: 'HTTPS'},
      {from: 'auditd', to: 'redis', kind: 'redis', label: 'append_entry (Lua CAS) · verify_chain'},
      {from: 'auditd', to: 'db', kind: 'plain', label: 'insert · set_position · set_receipt'},
      {from: 'auditd', to: 'signer', kind: 'grpc', label: 'Sign(record link)'},
      {from: 'auditd', to: 'queue', kind: 'plain', label: 'queue_unsigned'},
      {from: 'auditd', to: 'kafka', kind: 'kafka', label: 'produce after the append'},
      {from: 'kafka', to: 'mirror', kind: 'kafka', label: 'consume'},
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
