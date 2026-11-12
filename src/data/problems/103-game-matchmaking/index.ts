import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Game matchmaking: the course is not "queue players and pair them", it is the debugging you owe a
 * matchmaker before it puts a player in two games. One open ticket per player → one Lua claim over
 * a whole roster that keeps the pool depth honest → an allocator call with a deadline and a release
 * that runs once → match-id-keyed events with "started" only after every join and an outbox behind
 * the delivery report → a participant-scoped read that shows pending players as pending.
 */
export const gameMatchmakingProblem: Problem = {
  id: 'game-matchmaking',
  title: 'Game Matchmaking',
  tagline: 'Skill pools in Redis, one Lua claim per roster, and tickets that go back when no server is free.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Game Matchmaking

Game matchmaking turns a pool of waiting players into matches: who plays whom, which server hosts
the game, and what each player is told while they wait. A player in two games and a player in none
are the same bug: a ticket that two matchmakers both thought was theirs, or that nobody gave back.

## The real system

Open Match, the open-source matchmaking framework from Google for Games, splits the job the same
way. A Game Frontend creates a Ticket per player or party; the Backend's \`FetchMatches\` runs a match
function and moves the tickets of every returned match from active to pending, so later queries no
longer see them; the Director asks a game server allocator for a server and calls \`AssignTickets\`,
or calls \`ReleaseTickets\` to move the tickets back to active when the match cannot be placed. This
course builds that claim and release in Redis, with the allocator and the event stream around it.

## What you build here

One service, **matchmakerd**, on one store: \`matchmaking.store\` (provided) keeps \`ticket:{id}\`
hashes, the waiting tickets of each skill bucket in \`pool:{bucket}\` (scored by skill), the
\`pool:depth\` counter per bucket, \`match:{id}\` hashes with their \`:joined\` sets, and an \`outbox\`
list; step 2's claim is provided to later steps as \`matchmaking.claims\`.

1. \`POST /v1/matchmaking/tickets\` with \`X-Player-Id\` and \`{"skill", "party"}\`: a party of at most
   five, the rating clamped to 0..4000, and \`open:{player}\` taken with \`NX\` for every participant,
   so a second ticket is **409** with the open one.
2. **Redis** claims: \`claim_tickets(match_id, bucket, ticket_ids)\` takes a whole roster out of its
   pool in one Lua script or nothing, moving \`pool:depth\` with it; \`cancel_ticket\` is a script too.
3. **gRPC** \`Allocator.Allocate\` under a 3-second deadline, retried with backoff only on
   \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\`; without a server, \`release_roster\` (guarded by
   \`released:{match_id}\`) puts the tickets back and the match is abandoned.
4. **Kafka** \`match.event\`: \`match.found\`, \`match.started\` and \`match.abandoned\` keyed by match id,
   naming every player, \`started\` only once every join is confirmed, an outbox row when the delivery
   fails.
5. \`GET /v1/matches/{id}\`: participants only, every player with \`joined\` or \`pending\`, and a state
   (\`allocating\`, \`joining\`, \`in_game\`, \`abandoned\`) that follows the joins.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Choosing rosters (the match function), widening skill windows over time, rating updates, regions
and latency, backfill into running games, and the relay that drains the outbox.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Game client', sub: 'queue · lobby', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Matchmaking API', sub: 'tickets · matches', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'pool:{bucket} · ticket · match', x: 50, y: 50},
      {id: 'matchmaker', kind: 'service', label: 'Matchmaker', sub: 'claim · allocate · publish', x: 70, y: 20},
      {id: 'allocator', kind: 'grpc', label: 'Game server allocator', sub: 'Allocate', x: 90, y: 20},
      {id: 'kafka', kind: 'kafka', label: 'match.event', sub: 'key = match id', x: 70, y: 82},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST ticket · GET match'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'SET open NX · enqueue · get_match'},
      {from: 'matchmaker', to: 'redis', kind: 'redis', label: 'EVAL claim · EVAL release'},
      {from: 'matchmaker', to: 'allocator', kind: 'grpc', label: 'Allocate · 3 s'},
      {from: 'allocator', to: 'matchmaker', kind: 'grpc', label: 'server id · UNAVAILABLE · RESOURCE_EXHAUSTED'},
      {from: 'matchmaker', to: 'kafka', kind: 'kafka', label: 'found · started · abandoned'},
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
