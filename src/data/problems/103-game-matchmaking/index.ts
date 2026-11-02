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

Game matchmaking turns a pool of waiting players into matches: it decides who plays whom, which
server hosts the game, and what every player is told while they wait. The visible part is a "match
found" screen; the parts that decide whether the platform is safe are the ticket contract, the
atomicity of the claim, the failure path when a server cannot be allocated, the ordering of the
lifecycle events, and the read that tells each player the state of their own join.

## The real system

Open Match, the Kubernetes matchmaking framework from Google for Games, splits the job the same way
this course does. A Game Frontend authenticates the player and creates a Ticket; a Director fetches
matches for a MatchProfile, asks a dedicated game server allocation system for a server, and then
calls \`AssignTickets\` with an AssignmentGroup that sets the connection on every ticket id in the
match at once. The response carries an AssignmentFailure per ticket that could not be assigned
(cause \`TICKET_NOT_FOUND\`), so the Director learns about a roster it can no longer seat instead
of discovering it from a stuck player. The same questions apply to any matchmaker: a ticket is the
unit of waiting and a player holds one; forming a match claims every participant ticket or none,
because a claim made ticket by ticket puts one player in two rosters under load; a failed
allocation sends the participants back to the pool with their tickets intact; lifecycle events are
keyed by match id so one match stays on one partition; and the match read is a per-player view
where a claimed-but-not-joined participant is pending, not in-game.

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

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step you debug it against the failure modes, fix it, optimize what is
wasteful, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Rating updates after a game, party chat, cross-region pools, tournament modes, anti-cheat signals,
server autoscaling policy, and the client's matchmaking UI. The five pieces above decide whether a
player can be in two games, whether a failed allocation strands a queue, and whether the match a
player reads is the match they are in.`,
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
