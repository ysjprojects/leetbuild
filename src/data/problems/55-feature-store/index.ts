import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-client';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Feature store: the course is not "cache some numbers in Redis", it is the debugging you owe a
 * feature platform before a model is trained on what it serves. An immutable, reference-checked
 * definition → a versioned online store where the newest event wins and stale values expire → a
 * backfill that scans as of the training cutoff and reports its gaps → per-feature lineage events
 * produced after the partition commits → a stats read where null rate, a pinned baseline and
 * staleness are visible.
 */
export const featureStoreProblem: Problem = {
  id: 'feature-store',
  title: 'Feature Store',
  tagline:
    'A Redis online store where the newest event wins, fed by a backfill that reports the partitions it could not scan.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Feature Store

A feature store makes training and serving read the same numbers: one definition per (name,
version), one value per entity online, one point-in-time scan offline, one lineage event per
partition, and a stats read that says whether the numbers can still be trusted.

## The real system

Feast, the open source feature store, models feature values as time-series records and builds
training sets with a point-in-time join: for each entity row it scans back from the row's timestamp,
at most as far as the feature view's \`ttl\`, and takes the newest value it finds. Its documentation
adds a caveat this course takes seriously: by default the join constrains only the event timestamp,
so a value backfilled after the training timestamp can still be returned unless
\`filter_by_created_timestamp=True\` restricts it. The backfill here carries its cutoff for the same
reason, and the online store lets the newest event win whichever writer arrives last.

## What you build here

One service, **featured**, on one Redis (the course's stand-in for the registry database and the
online store) and the provided \`features\` package: \`features.registry\` (definitions, the compute
registry, the partition log), \`features.online\` (step 2's store, provided to later steps),
\`features.stats\` (running sums, the pinned baseline) and \`features.outbox\`.

1. \`POST /v1/features/definitions\`: one immutable definition per (name, version) under
   \`definition:{name}:{version}\` (\`create_definition\`, one \`SET NX\`, else **409**), a
   \`computation_ref\` that resolves (**422**) and a required \`freshness_slo\` (**400**).
2. The **online store**: \`feature:{name}:{version}:{entity}\` holds \`value\` and \`event_ts\`;
   \`write_value\` stores only a newer value, in one Lua script that also expires the key at
   \`event_ts + freshness_slo\`; \`read_value\` answers \`{value, event_ts, age_s}\`.
3. The **backfill client**: \`backfill(name, version, partitions, as_of)\` calls
   \`OfflineStore.Scan\` over gRPC per partition with a 60 s deadline and the training cutoff, lists
   failed partitions in \`missing\`, and raises \`BackfillAborted\` on \`PERMISSION_DENIED\`.
4. **Lineage**: \`materialize(name, version, partition, rows)\` writes through \`write_value\`,
   commits the partition (\`partitions:{name}:{version}\`), then produces \`feature.event\`
   \`{feature, version, partition, rows}\` keyed by the feature with \`acks=all\`, and writes an
   outbox row when the broker refuses it.
5. \`GET /v1/features/{name}/versions/{v}/stats\`: the null rate, mean and std over the values, the
   pinned baseline (\`baseline:{name}\`), a three-sigma \`drift\` flag, and \`freshness_s\`/\`stale\`
   from the newest value's event time.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and it looks right. In every step, debug it against the failure modes the task names, fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Warehouse-specific SQL, feature authoring UIs, streaming materialization, embedding stores, model
registry integration, per-tenant quotas, lineage graphs across features, and parallel backfills with
their scheduling and retries.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'training · serving', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Feature API', sub: 'definitions · stats', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'Registry', sub: 'definitions · partitions · outbox', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Online store', sub: 'value + event_ts', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'feature.event', sub: 'key = feature name', x: 46, y: 90},
      {id: 'worker', kind: 'service', label: 'Backfill worker', sub: '60 s per partition', x: 70, y: 10},
      {id: 'offline', kind: 'grpc', label: 'Offline store', sub: 'Scan as of the cutoff', x: 70, y: 45},
      {id: 'monitor', kind: 'service', label: 'Drift monitor', sub: 'null rate · baseline', x: 70, y: 85},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'create_definition · SET NX'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'stats read'},
      {from: 'worker', to: 'offline', kind: 'grpc', label: 'Scan(feature, version, partition, as_of)'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'write_value · newer wins'},
      {from: 'worker', to: 'db', kind: 'plain', label: 'commit_partition · outbox'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce feature.event'},
      {from: 'kafka', to: 'monitor', kind: 'kafka', label: 'consume'},
      {from: 'monitor', to: 'redis', kind: 'redis', label: 'stats · baseline'},
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
