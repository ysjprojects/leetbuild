import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Game matchmaking on the AI-era track: the course is not "queue players and pair them", it is the
 * review you owe a model-generated matchmaker before it puts a player in two games. Validated
 * tickets with a one-open-ticket rule → one atomic Redis claim over every participant ticket that
 * also keeps the depth counters honest → a gRPC allocation with a deadline and a certain, idempotent
 * release on failure → match-id-keyed lifecycle events with "started" only after every join and an
 * outbox behind a rejected produce → a participant-scoped read that shows pending joins as pending.
 */
export const gameMatchmakingProblem: Problem = {
  id: 'game-matchmaking',
  title: 'Game Matchmaking',
  tagline: 'Skill-based matches that cannot duplicate players and release tickets on failure.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Game Matchmaking

Game matchmaking is the piece of a multiplayer platform that turns a pool of waiting players into
matches: it decides who plays whom, which server hosts the game, and what every player is told while
they wait. The visible part is a "match found" screen; the parts that decide whether the platform is
safe are the ticket contract, the atomicity of the claim, the failure path when a server cannot be
allocated, the ordering of the lifecycle events, and the read that has to tell each player the truth
about their own join.

## The real system

Production matchmakers never let one player exist twice. A ticket is the unit of waiting: one player
(plus an optional party) holds at most one open ticket, and the ticket carries the rating that
decides its bucket. Forming a match is a transaction over the pool — every participant's ticket is
claimed in one atomic step, or none of them is, because a matchmaker that claims tickets one by one
will, under load or after a crash, put the same player in two rosters. A claimed ticket disappears
from the pool for everyone else, and the pool's depth counters have to keep agreeing with the set of
tickets that are actually still waiting. Formed matches then ask the game server allocator for a
server under a deadline; when that call fails the participants must go back to the pool with their
tickets intact and a delay, or they wait forever in a queue position that no longer exists. Every
lifecycle change — found, joined, started, abandoned — is published keyed by match id, so one
match's events stay ordered on one partition, and "started" may only be published once every join
has been confirmed. Finally, the match read is a per-player view: a participant who is claimed but
has not joined yet must be shown as pending, never as in-game, and a stranger must not be able to
read a match they are not in.

## What you build here

One service, **matchmakerd**, with five pieces:

1. \`POST /v1/matchmaking/tickets\`: a validated ticket — player from the header, rating clamped to
   the supported band, an optional party of at most five — and the one-open-ticket rule that makes a
   second ticket **409** with the original ticket id.
2. A **Redis** pool: tickets in skill buckets, and one atomic Lua \`EVAL\` that claims every
   participant ticket or none, keeps claimed tickets invisible to other matchmakers, and moves the
   depth counters with the claims and the cancellations.
3. A **gRPC** allocator client: an allocation call with a 3-second deadline, a release of every
   participant ticket when it fails, a release that is idempotent, and a backoff that moves the
   match to a fresh attempt instead of retrying the same dead pool.
4. A **Kafka** event path: \`match.found\`, \`match.joined\`, \`match.started\` and \`match.abandoned\`
   on \`match.event\`, keyed by match id, carrying player ids and server ids, with "started" only
   after every join is confirmed, an outbox row when the broker rejects the produce, and abandoned
   matches published with a reason.
5. \`GET /v1/matches/{id}\`: the roster, the server assignment, the per-player join state and the
   state-machine position, scoped to participants, with claimed-but-not-joined shown as pending.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Rating updates after a game, party chat, cross-region pools, tournament modes, anti-cheat signals,
server autoscaling policy, and the client's matchmaking UI. The five pieces above are the ones that
decide whether a player can be in two games, whether a failed allocation strands a queue, and whether
the match a player reads is the match they are actually in.`,
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
