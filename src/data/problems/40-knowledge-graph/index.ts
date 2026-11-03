import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {entityUpsertStep} from './steps/1-endpoint';
import {adjacencyCacheStep} from './steps/2-state';
import {resolutionClientStep} from './steps/3-dependency';
import {graphEventsStep} from './steps/4-events';
import {neighborReadStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Knowledge graph: the course is not "store two tables and join them", it is the debugging you owe
 * a graph layer before it merges two different things into one. Merge decisions the server makes →
 * an adjacency cache invalidated by a version → a resolver whose timeout parks a pair instead of
 * deciding it → entity-keyed events after the commit → a neighbour walk bounded by tenant, depth
 * and size.
 */
export const knowledgeGraphProblem: Problem = {
  id: 'knowledge-graph',
  title: 'Knowledge Graph',
  tagline: 'Alias-checked entity upserts and resolver-gated merges over a versioned Redis adjacency cache.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Knowledge Graph

A knowledge graph records what an AI platform knows about entities (people, companies, documents)
and how they relate. Retrieval, agents and analytics all read it, so its costliest bug is quiet: two
different things merged into one, or one thing split in two. This course is about the parts of the
service that decide when entities merge and how fast a change reaches its readers.

## The real system

Wikidata treats a merge as a risky edit. Merging moves every sitelink, label and statement to a
recipient item, and the obsolete item becomes a redirect, because item ids are persistent
identifiers that are not reused. The automated merge tools stop when they find a sitelink conflict,
the sign that two items may not be the same thing, and an editor settles it. A multi-tenant graph
service has the same shape: evidence the server can check decides a merge, a pair nobody can decide
waits in a review queue, and a merged entity keeps pointing at its survivor.

## What you build here

One service, **graph-api**, over a graph store in Redis (\`graph.store\`, provided: \`entity:{id}\`
hashes with a version, \`alias:{tenant}:{alias}\`, \`edges:{id}\`, the idempotency records, the review
queue \`review:{tenant}\` and the \`outbox\`) and one adjacency cache (\`read_neighbors\` /
\`apply_edge\`, built in step 2 and provided to step 5 as \`graph.adjacency\`):

1. \`POST /v1/entities\` with \`X-Tenant-Id\` and \`Idempotency-Key\`: \`{"type", "name", "aliases"}\`
   creates an entity or extends the same-type entity that claims an alias; a body carrying a merge
   decision is 400, a cross-type alias is 409 with both candidates.
2. A **Redis** adjacency cache: \`adj:{id}\` holds \`{"version", "neighbors"}\` for 5 minutes, and an
   edge bumps \`adj:{id}:version\` on both ends.
3. A **gRPC** \`Resolver.Score\` call under a 1-second deadline: a score of 0.9 or more merges, a
   refusal is final, anything else parks the pair.
4. A **Kafka** \`graph.changed\` record per rename, keyed by entity id, carrying the old and new name
   and the version, produced after the commit, with an outbox behind the delivery report.
5. \`GET /v1/entities/{id}/neighbors\`: the caller's tenant only, depth 1 by default and 2 at most,
   breadth-first, at most 500 neighbours with a \`truncated\` marker.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step you debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Resolution models, graph query languages, bulk import, per-tenant schemas, the consumers of
\`graph.changed\`, and the screen an operator uses to settle a parked pair.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'upsert · neighbours', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'graph-api', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'Graph store', sub: 'entity · alias · edges', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Adjacency cache', sub: 'adj:{id} · version', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'graph.changed', sub: 'key = entity id', x: 44, y: 84},
      {id: 'resolver', kind: 'grpc', label: 'Resolver', sub: 'Score · 1 s', x: 66, y: 12},
      {id: 'review', kind: 'service', label: 'Review queue', sub: 'review:{tenant}', x: 66, y: 38},
      {id: 'consumer', kind: 'service', label: 'Graph consumers', sub: 'search · retrieval index', x: 66, y: 62},
      {id: 'outbox', kind: 'db', label: 'Outbox', sub: 'undelivered events', x: 66, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'upsert · merge · rename'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'read_neighbors · apply_edge'},
      {from: 'api', to: 'resolver', kind: 'grpc', label: 'Score'},
      {from: 'api', to: 'review', kind: 'plain', label: 'park: timeout · below 0.9'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the commit'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'no delivery report'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [entityUpsertStep, adjacencyCacheStep, resolutionClientStep, graphEventsStep, neighborReadStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
