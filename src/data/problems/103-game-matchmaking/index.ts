import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Game matchmaking: the course is not "queue players and pair them", it is the debugging you owe a
 * matchmaker before it puts a player in two games. Validated tickets with a one-open-ticket rule →
 * one atomic Redis claim over every participant ticket that also keeps the depth counters honest →
 * a gRPC allocation with a deadline and a certain, idempotent release on failure → match-id-keyed
 * lifecycle events with "started" only after every join and an outbox behind a rejected produce → a
 * participant-scoped read that shows pending joins as pending.
 */
export const gameMatchmakingProblem: Problem = {
  id: 'game-matchmaking',
  title: 'Game Matchmaking',
  tagline: 'Skill buckets, one atomic roster claim, and tickets that return to the pool when the allocator fails.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Game Matchmaking

Game matchmaking turns a pool of waiting players into matches: who plays whom, which server hosts
the game, and what each player is told while they wait.

## The real system

Open Match, the Kubernetes matchmaking framework from Google for Games, splits the job the same way
this course does. A Game Frontend authenticates the player and creates a Ticket; a Director fetches
matches for a MatchProfile, asks a dedicated game server allocation system for a server, and then
calls \`AssignTickets\` with an AssignmentGroup that sets the connection on every ticket id in the
match at once. The response carries an AssignmentFailure per ticket that could not be assigned
(cause \`TICKET_NOT_FOUND\`), so the Director learns about a roster it can no longer seat instead
of discovering it from a stuck player. This course keeps that shape: claims are all-or-nothing, a
failed allocation returns tickets to the pool, and lifecycle events are keyed by match id.

## What you build here

One service, **matchmakerd**, with five pieces:

1. \`POST /v1/matchmaking/tickets\`: a validated ticket, player from the header, rating clamped to
   the supported band, an optional party of at most five, and the one-open-ticket rule that makes a
   second ticket **409** with the original ticket id.
2. A **Redis** pool: tickets in skill buckets, and one atomic Lua \`EVAL\` that claims every
   participant ticket or none, keeps claimed tickets invisible to other matchmakers, and moves the
   depth counters with the claims and the cancellations.
3. A **gRPC** allocator client: a 3-second deadline, a release of every participant ticket when the
   call fails, a release that is idempotent, and a bounded backoff.
4. A **Kafka** event path: \`match.found\`, \`match.joined\`, \`match.started\` and \`match.abandoned\`
   on \`match.event\`, keyed by match id, with "started" only after every join is confirmed, an
   outbox row when the broker rejects the produce, and abandoned matches published with a reason.
5. \`GET /v1/matches/{id}\`: the roster, the server assignment, the per-player join state and the
   state-machine position, scoped to participants, with claimed-but-not-joined shown as pending.

## The debugging habit

Every starter compiles, serves the happy path and hides flaws. Debug it against the failure modes,
fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Rating updates, party chat, cross-region pools, tournament modes, anti-cheat signals, server
autoscaling and the matchmaking UI.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Game client', sub: 'queue · read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Matchmaking API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis pools', sub: 'pool:{bucket} · claimed', x: 45, y: 50},
      {id: 'matchmaker', kind: 'service', label: 'Matchmaker', sub: 'form rosters', x: 64, y: 20},
      {id: 'allocator', kind: 'grpc', label: 'Game server allocator', sub: 'Allocate', x: 86, y: 20},
      {id: 'kafka', kind: 'kafka', label: 'match.event', sub: 'key = match id', x: 64, y: 55},
      {id: 'store', kind: 'db', label: 'Match store', sub: 'roster · join state', x: 64, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'enqueue ticket'},
      {from: 'redis', to: 'matchmaker', kind: 'redis', label: 'scan pool'},
      {from: 'matchmaker', to: 'redis', kind: 'redis', label: 'EVAL claim participants'},
      {from: 'matchmaker', to: 'allocator', kind: 'grpc', label: 'Allocate'},
      {from: 'allocator', to: 'matchmaker', kind: 'grpc', label: 'server id / FAILED'},
      {from: 'matchmaker', to: 'kafka', kind: 'kafka', label: 'produce match.event'},
      {from: 'matchmaker', to: 'store', kind: 'plain', label: 'roster · join state'},
      {from: 'api', to: 'store', kind: 'plain', label: 'GET match'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
