/**
 * Hand-written support modules the game-matchmaking steps import but no step builds: the
 * `matchmaking` package. `matchmaking.store` holds tickets, the skill pools and matches in Redis
 * (the course's stand-in for the matchmaker's database); `matchmaking.claims` is the roster claim of
 * step 2 as later steps use it: `claim_tickets` and `cancel_ticket`, each one Lua script. The five
 * languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'matchmaking/__init__.py': '',
  'matchmaking/store.py': `"""
The matchmaking store (provided). ticket:{id} is a hash: ticket_id, owner, skill, bucket,
participants ("p1,p2", the owner first), state (waiting or claimed) and match_id ("" while
waiting). pool:{bucket} is a sorted set of the waiting ticket ids scored by skill, pool:depth a hash
of how many tickets wait per bucket. match:{id} is a hash: match_id, bucket, tickets, players,
server_id, state (allocating, joining or abandoned) and reason; match:{id}:joined is the set of
players whose client confirmed the join. outbox is a list of JSON rows {topic, key, payload} a relay
publishes later. open:{player} (step 1) holds the player's open ticket id.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BUCKET_WIDTH = 100
DEPTH_KEY = "pool:depth"


def bucket_of(skill: int) -> int:
    return skill // BUCKET_WIDTH


def ticket_key(ticket_id: str) -> str:
    return f"ticket:{ticket_id}"


def pool_key(bucket: int) -> str:
    return f"pool:{bucket}"


def open_key(player_id: str) -> str:
    return f"open:{player_id}"


def match_key(match_id: str) -> str:
    return f"match:{match_id}"


def _list(text: str) -> list[str]:
    return text.split(",") if text else []


def next_ticket_id() -> str:
    """A fresh ticket id: t-1, t-2, …"""
    return f"t-{r.incr('ticket:seq')}"


def enqueue(ticket_id: str, owner: str, skill: int, participants: list[str]) -> dict:
    """Write the ticket and put it in its skill pool: ZADD pool:{bucket}, HINCRBY pool:depth +1."""
    bucket = bucket_of(skill)
    r.hset(
        ticket_key(ticket_id),
        mapping={
            "ticket_id": ticket_id,
            "owner": owner,
            "skill": skill,
            "bucket": bucket,
            "participants": ",".join(participants),
            "state": "waiting",
            "match_id": "",
        },
    )
    r.zadd(pool_key(bucket), {ticket_id: skill})
    r.hincrby(DEPTH_KEY, str(bucket), 1)
    return get_ticket(ticket_id)


def get_ticket(ticket_id: str) -> dict | None:
    """The ticket (skill and bucket as ints, participants as a list, match_id None while waiting), or None."""
    raw = r.hgetall(ticket_key(ticket_id))
    if not raw:
        return None
    return {
        "ticket_id": raw["ticket_id"],
        "owner": raw["owner"],
        "skill": int(raw["skill"]),
        "bucket": int(raw["bucket"]),
        "participants": _list(raw["participants"]),
        "state": raw["state"],
        "match_id": raw.get("match_id") or None,
    }


def create_match(match_id: str, bucket: int, ticket_ids: list[str]) -> dict:
    """A match over these tickets, allocating: its players are every participant of every ticket."""
    players = [p for t in ticket_ids for p in get_ticket(t)["participants"]]
    r.hset(
        match_key(match_id),
        mapping={
            "match_id": match_id,
            "bucket": bucket,
            "tickets": ",".join(ticket_ids),
            "players": ",".join(players),
            "server_id": "",
            "state": "allocating",
            "reason": "",
        },
    )
    return get_match(match_id)


def get_match(match_id: str) -> dict | None:
    """The match (server_id and reason None when unset, joined sorted), or None."""
    raw = r.hgetall(match_key(match_id))
    if not raw:
        return None
    return {
        "match_id": raw["match_id"],
        "bucket": int(raw["bucket"]),
        "tickets": _list(raw["tickets"]),
        "players": _list(raw["players"]),
        "server_id": raw.get("server_id") or None,
        "state": raw["state"],
        "reason": raw.get("reason") or None,
        "joined": sorted(r.smembers(f"{match_key(match_id)}:joined")),
    }


def set_server(match_id: str, server_id: str) -> None:
    """The allocator placed the match: record the server, the players start joining."""
    r.hset(match_key(match_id), mapping={"server_id": server_id, "state": "joining"})


def confirm_join(match_id: str, player_id: str) -> None:
    """The player's client connected to the match's server."""
    r.sadd(f"{match_key(match_id)}:joined", player_id)


def all_joins_confirmed(match_id: str) -> bool:
    """Whether every player of the match has confirmed the join."""
    match = get_match(match_id)
    return match is not None and set(match["players"]) <= set(match["joined"])


def abandon(match_id: str, reason: str) -> None:
    """The match ended without starting."""
    r.hset(match_key(match_id), mapping={"state": "abandoned", "reason": reason})


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """An event the broker did not take, for the relay to publish later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'matchmaking/claims.py': `"""
The roster claim (provided; step 2 builds the same two functions). claim_tickets takes every ticket
of a roster out of its pool for one match in one Lua script, or none of them; cancel_ticket takes a
waiting ticket out of the queue, its pool entry, depth and open-ticket pointers included.
"""
import redis

from matchmaking import store

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS: pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket.
CLAIM_LUA = """
for i = 3, #KEYS do
  if redis.call('HGET', KEYS[i], 'state') ~= 'waiting' then return 0 end
end
for i = 3, #KEYS do
  redis.call('ZREM', KEYS[1], redis.call('HGET', KEYS[i], 'ticket_id'))
  redis.call('HSET', KEYS[i], 'state', 'claimed', 'match_id', ARGV[1])
end
redis.call('HINCRBY', KEYS[2], ARGV[2], -(#KEYS - 2))
return 1
"""

# KEYS: ticket:{id}, pool:{bucket}, pool:depth, open:{player}…; ARGV: ticket id, bucket.
CANCEL_LUA = """
if redis.call('HGET', KEYS[1], 'state') ~= 'waiting' then return 0 end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HINCRBY', KEYS[3], ARGV[2], -1)
for i = 4, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
end
redis.call('DEL', KEYS[1])
return 1
"""

claim = r.register_script(CLAIM_LUA)
cancel = r.register_script(CANCEL_LUA)


def claim_tickets(match_id: str, bucket: int, ticket_ids: list[str]) -> bool:
    """Claim every ticket of the roster for match_id; False, touching nothing, when one is not waiting."""
    keys = [store.pool_key(bucket), store.DEPTH_KEY, *[store.ticket_key(t) for t in ticket_ids]]
    return claim(keys=keys, args=[match_id, bucket]) == 1


def cancel_ticket(ticket_id: str) -> bool:
    """The players leave the queue; False when the ticket is unknown or already in a match."""
    ticket = store.get_ticket(ticket_id)
    if ticket is None:
        return False
    keys = [store.ticket_key(ticket_id), store.pool_key(ticket["bucket"]), store.DEPTH_KEY]
    keys += [store.open_key(p) for p in ticket["participants"]]
    return cancel(keys=keys, args=[ticket_id, ticket["bucket"]]) == 1
`,
};

export const supportModulesTs: Record<string, string> = {
  'matchmaking/store.ts': `/**
 * The matchmaking store (provided). ticket:{id} is a hash: ticket_id, owner, skill, bucket,
 * participants ("p1,p2", the owner first), state (waiting or claimed) and match_id ("" while
 * waiting). pool:{bucket} is a sorted set of the waiting ticket ids scored by skill, pool:depth a
 * hash of how many tickets wait per bucket. match:{id} is a hash: match_id, bucket, tickets,
 * players, server_id, state (allocating, joining or abandoned) and reason; match:{id}:joined is the
 * set of players whose client confirmed the join. outbox is a list of JSON rows {topic, key,
 * payload} a relay publishes later. open:{player} (step 1) holds the player's open ticket id.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const BUCKET_WIDTH = 100;
export const DEPTH_KEY = 'pool:depth';

export interface Ticket {
  ticket_id: string;
  owner: string;
  skill: number;
  bucket: number;
  participants: string[];
  state: string;
  match_id: string | null;
}

export interface Match {
  match_id: string;
  bucket: number;
  tickets: string[];
  players: string[];
  server_id: string | null;
  state: string;
  reason: string | null;
  joined: string[];
}

export const bucketOf = (skill: number): number => Math.floor(skill / BUCKET_WIDTH);
export const ticketKey = (ticketId: string): string => \`ticket:\${ticketId}\`;
export const poolKey = (bucket: number): string => \`pool:\${bucket}\`;
export const openKey = (playerId: string): string => \`open:\${playerId}\`;
export const matchKey = (matchId: string): string => \`match:\${matchId}\`;

const list = (text: string | undefined): string[] => (text ? text.split(',') : []);

/** A fresh ticket id: t-1, t-2, … */
export async function nextTicketId(): Promise<string> {
  return \`t-\${await redis.incr('ticket:seq')}\`;
}

/** Write the ticket and put it in its skill pool: ZADD pool:{bucket}, HINCRBY pool:depth +1. */
export async function enqueue(ticketId: string, owner: string, skill: number, participants: string[]): Promise<Ticket> {
  const bucket = bucketOf(skill);
  await redis.hset(ticketKey(ticketId), {
    ticket_id: ticketId,
    owner,
    skill: String(skill),
    bucket: String(bucket),
    participants: participants.join(','),
    state: 'waiting',
    match_id: '',
  });
  await redis.zadd(poolKey(bucket), skill, ticketId);
  await redis.hincrby(DEPTH_KEY, String(bucket), 1);
  return (await getTicket(ticketId)) as Ticket;
}

/** The ticket (participants as a list, match_id null while waiting), or null. */
export async function getTicket(ticketId: string): Promise<Ticket | null> {
  const raw = await redis.hgetall(ticketKey(ticketId));
  if (Object.keys(raw).length === 0) return null;
  return {
    ticket_id: raw.ticket_id,
    owner: raw.owner,
    skill: Number(raw.skill),
    bucket: Number(raw.bucket),
    participants: list(raw.participants),
    state: raw.state,
    match_id: raw.match_id ? raw.match_id : null,
  };
}

/** A match over these tickets, allocating: its players are every participant of every ticket. */
export async function createMatch(matchId: string, bucket: number, ticketIds: string[]): Promise<Match> {
  const players: string[] = [];
  for (const ticketId of ticketIds) players.push(...((await getTicket(ticketId)) as Ticket).participants);
  await redis.hset(matchKey(matchId), {
    match_id: matchId,
    bucket: String(bucket),
    tickets: ticketIds.join(','),
    players: players.join(','),
    server_id: '',
    state: 'allocating',
    reason: '',
  });
  return (await getMatch(matchId)) as Match;
}

/** The match (server_id and reason null when unset, joined sorted), or null. */
export async function getMatch(matchId: string): Promise<Match | null> {
  const raw = await redis.hgetall(matchKey(matchId));
  if (Object.keys(raw).length === 0) return null;
  const joined = (await redis.smembers(\`\${matchKey(matchId)}:joined\`)).sort();
  return {
    match_id: raw.match_id,
    bucket: Number(raw.bucket),
    tickets: list(raw.tickets),
    players: list(raw.players),
    server_id: raw.server_id ? raw.server_id : null,
    state: raw.state,
    reason: raw.reason ? raw.reason : null,
    joined,
  };
}

/** The allocator placed the match: record the server, the players start joining. */
export async function setServer(matchId: string, serverId: string): Promise<void> {
  await redis.hset(matchKey(matchId), {server_id: serverId, state: 'joining'});
}

/** The player's client connected to the match's server. */
export async function confirmJoin(matchId: string, playerId: string): Promise<void> {
  await redis.sadd(\`\${matchKey(matchId)}:joined\`, playerId);
}

/** Whether every player of the match has confirmed the join. */
export async function allJoinsConfirmed(matchId: string): Promise<boolean> {
  const match = await getMatch(matchId);
  return match !== null && match.players.every(p => match.joined.includes(p));
}

/** The match ended without starting. */
export async function abandon(matchId: string, reason: string): Promise<void> {
  await redis.hset(matchKey(matchId), {state: 'abandoned', reason});
}

/** An event the broker did not take, for the relay to publish later. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
  'matchmaking/claims.ts': `/**
 * The roster claim (provided; step 2 builds the same two functions). claimTickets takes every ticket
 * of a roster out of its pool for one match in one Lua script, or none of them; cancelTicket takes a
 * waiting ticket out of the queue, its pool entry, depth and open-ticket pointers included.
 */
import Redis from 'ioredis';

import {DEPTH_KEY, getTicket, openKey, poolKey, ticketKey} from './store';

const redis = new Redis({host: 'redis', port: 6379});

/** KEYS: pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket. */
export const CLAIM_LUA = \`
for i = 3, #KEYS do
  if redis.call('HGET', KEYS[i], 'state') ~= 'waiting' then return 0 end
end
for i = 3, #KEYS do
  redis.call('ZREM', KEYS[1], redis.call('HGET', KEYS[i], 'ticket_id'))
  redis.call('HSET', KEYS[i], 'state', 'claimed', 'match_id', ARGV[1])
end
redis.call('HINCRBY', KEYS[2], ARGV[2], -(#KEYS - 2))
return 1
\`;

/** KEYS: ticket:{id}, pool:{bucket}, pool:depth, open:{player}…; ARGV: ticket id, bucket. */
export const CANCEL_LUA = \`
if redis.call('HGET', KEYS[1], 'state') ~= 'waiting' then return 0 end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HINCRBY', KEYS[3], ARGV[2], -1)
for i = 4, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
end
redis.call('DEL', KEYS[1])
return 1
\`;

/** Claim every ticket of the roster for matchId; false, touching nothing, when one is not waiting. */
export async function claimTickets(matchId: string, bucket: number, ticketIds: string[]): Promise<boolean> {
  const keys = [poolKey(bucket), DEPTH_KEY, ...ticketIds.map(ticketKey)];
  return (await redis.eval(CLAIM_LUA, keys.length, ...keys, matchId, String(bucket))) === 1;
}

/** The players leave the queue; false when the ticket is unknown or already in a match. */
export async function cancelTicket(ticketId: string): Promise<boolean> {
  const ticket = await getTicket(ticketId);
  if (ticket === null) return false;
  const keys = [ticketKey(ticketId), poolKey(ticket.bucket), DEPTH_KEY, ...ticket.participants.map(openKey)];
  return (await redis.eval(CANCEL_LUA, keys.length, ...keys, ticketId, String(ticket.bucket))) === 1;
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'matchmaking/store/store.go': `// Package store is the matchmaking store (provided). ticket:{id} is a hash: ticket_id, owner,
// skill, bucket, participants ("p1,p2", the owner first), state (waiting or claimed) and match_id
// ("" while waiting). pool:{bucket} is a sorted set of the waiting ticket ids scored by skill,
// pool:depth a hash of how many tickets wait per bucket. match:{id} is a hash: match_id, bucket,
// tickets, players, server_id, state (allocating, joining or abandoned) and reason;
// match:{id}:joined is the set of players whose client confirmed the join. outbox is a list of JSON
// rows {topic, key, payload} a relay publishes later. open:{player} (step 1) holds the player's open
// ticket id.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// BucketWidth is the skill range one pool covers.
const BucketWidth = 100

// DepthKey is the hash of how many tickets wait per bucket.
const DepthKey = "pool:depth"

// Ticket is one queued ticket; MatchID is "" while it waits.
type Ticket struct {
	TicketID     string   \`json:"ticket_id"\`
	Owner        string   \`json:"owner"\`
	Skill        int      \`json:"skill"\`
	Bucket       int      \`json:"bucket"\`
	Participants []string \`json:"participants"\`
	State        string   \`json:"state"\`
	MatchID      string   \`json:"match_id"\`
}

// Match is one match; ServerID and Reason are "" when unset, Joined is sorted.
type Match struct {
	MatchID  string   \`json:"match_id"\`
	Bucket   int      \`json:"bucket"\`
	Tickets  []string \`json:"tickets"\`
	Players  []string \`json:"players"\`
	ServerID string   \`json:"server_id"\`
	State    string   \`json:"state"\`
	Reason   string   \`json:"reason"\`
	Joined   []string \`json:"joined"\`
}

// BucketOf is the pool a skill falls in (floor division, as in every language of the course).
func BucketOf(skill int) int {
	if skill < 0 && skill%BucketWidth != 0 {
		return skill/BucketWidth - 1
	}
	return skill / BucketWidth
}

// TicketKey is the ticket's hash.
func TicketKey(ticketID string) string { return "ticket:" + ticketID }

// PoolKey is the sorted set of the bucket's waiting tickets.
func PoolKey(bucket int) string { return "pool:" + strconv.Itoa(bucket) }

// OpenKey holds the player's open ticket id.
func OpenKey(playerID string) string { return "open:" + playerID }

// MatchKey is the match's hash.
func MatchKey(matchID string) string { return "match:" + matchID }

func list(text string) []string {
	if text == "" {
		return []string{}
	}
	return strings.Split(text, ",")
}

// NextTicketID is a fresh ticket id: t-1, t-2, …
func NextTicketID(ctx context.Context) string {
	return fmt.Sprintf("t-%d", rdb.Incr(ctx, "ticket:seq").Val())
}

// Enqueue writes the ticket and puts it in its skill pool: ZADD pool:{bucket}, HINCRBY pool:depth +1.
// A Redis error stops it there and is returned, as the other languages' enqueue raises it.
func Enqueue(ctx context.Context, ticketID, owner string, skill int, participants []string) (*Ticket, error) {
	bucket := BucketOf(skill)
	if err := rdb.HSet(ctx, TicketKey(ticketID), map[string]any{
		"ticket_id": ticketID, "owner": owner, "skill": strconv.Itoa(skill), "bucket": strconv.Itoa(bucket),
		"participants": strings.Join(participants, ","), "state": "waiting", "match_id": "",
	}).Err(); err != nil {
		return nil, err
	}
	if err := rdb.ZAdd(ctx, PoolKey(bucket), redis.Z{Score: float64(skill), Member: ticketID}).Err(); err != nil {
		return nil, err
	}
	if err := rdb.HIncrBy(ctx, DepthKey, strconv.Itoa(bucket), 1).Err(); err != nil {
		return nil, err
	}
	return GetTicket(ctx, ticketID), nil
}

// GetTicket is the ticket, or nil.
func GetTicket(ctx context.Context, ticketID string) *Ticket {
	raw := rdb.HGetAll(ctx, TicketKey(ticketID)).Val()
	if len(raw) == 0 {
		return nil
	}
	skill, _ := strconv.Atoi(raw["skill"])
	bucket, _ := strconv.Atoi(raw["bucket"])
	return &Ticket{TicketID: raw["ticket_id"], Owner: raw["owner"], Skill: skill, Bucket: bucket, Participants: list(raw["participants"]), State: raw["state"], MatchID: raw["match_id"]}
}

// CreateMatch is a match over these tickets, allocating: its players are every participant of every ticket.
func CreateMatch(ctx context.Context, matchID string, bucket int, ticketIDs []string) *Match {
	players := []string{}
	for _, ticketID := range ticketIDs {
		players = append(players, GetTicket(ctx, ticketID).Participants...)
	}
	rdb.HSet(ctx, MatchKey(matchID), map[string]any{
		"match_id": matchID, "bucket": strconv.Itoa(bucket), "tickets": strings.Join(ticketIDs, ","),
		"players": strings.Join(players, ","), "server_id": "", "state": "allocating", "reason": "",
	})
	return GetMatch(ctx, matchID)
}

// GetMatch is the match, or nil.
func GetMatch(ctx context.Context, matchID string) *Match {
	raw := rdb.HGetAll(ctx, MatchKey(matchID)).Val()
	if len(raw) == 0 {
		return nil
	}
	bucket, _ := strconv.Atoi(raw["bucket"])
	joined := rdb.SMembers(ctx, MatchKey(matchID)+":joined").Val()
	sort.Strings(joined)
	return &Match{MatchID: raw["match_id"], Bucket: bucket, Tickets: list(raw["tickets"]), Players: list(raw["players"]), ServerID: raw["server_id"], State: raw["state"], Reason: raw["reason"], Joined: joined}
}

// SetServer records the server the allocator placed the match on; the players start joining.
func SetServer(ctx context.Context, matchID, serverID string) {
	rdb.HSet(ctx, MatchKey(matchID), map[string]any{"server_id": serverID, "state": "joining"})
}

// ConfirmJoin records that the player's client connected to the match's server.
func ConfirmJoin(ctx context.Context, matchID, playerID string) {
	rdb.SAdd(ctx, MatchKey(matchID)+":joined", playerID)
}

// AllJoinsConfirmed reports whether every player of the match has confirmed the join.
func AllJoinsConfirmed(ctx context.Context, matchID string) bool {
	m := GetMatch(ctx, matchID)
	if m == nil {
		return false
	}
	joined := map[string]bool{}
	for _, p := range m.Joined {
		joined[p] = true
	}
	for _, p := range m.Players {
		if !joined[p] {
			return false
		}
	}
	return true
}

// Abandon records that the match ended without starting.
func Abandon(ctx context.Context, matchID, reason string) {
	rdb.HSet(ctx, MatchKey(matchID), map[string]any{"state": "abandoned", "reason": reason})
}

// InsertOutbox keeps an event the broker did not take, for the relay to publish later.
func InsertOutbox(ctx context.Context, topic, key string, payload map[string]any) error {
	row, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	return rdb.RPush(ctx, "outbox", string(row)).Err()
}
`,
  'matchmaking/claims/claims.go': `// Package claims is the roster claim (provided; step 2 builds the same two functions). ClaimTickets
// takes every ticket of a roster out of its pool for one match in one Lua script, or none of them;
// CancelTicket takes a waiting ticket out of the queue, its pool entry, depth and open-ticket
// pointers included.
package claims

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"matchmaking/store"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// KEYS: pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket.
var claim = redis.NewScript(\`
for i = 3, #KEYS do
  if redis.call('HGET', KEYS[i], 'state') ~= 'waiting' then return 0 end
end
for i = 3, #KEYS do
  redis.call('ZREM', KEYS[1], redis.call('HGET', KEYS[i], 'ticket_id'))
  redis.call('HSET', KEYS[i], 'state', 'claimed', 'match_id', ARGV[1])
end
redis.call('HINCRBY', KEYS[2], ARGV[2], -(#KEYS - 2))
return 1
\`)

// KEYS: ticket:{id}, pool:{bucket}, pool:depth, open:{player}…; ARGV: ticket id, bucket.
var cancel = redis.NewScript(\`
if redis.call('HGET', KEYS[1], 'state') ~= 'waiting' then return 0 end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HINCRBY', KEYS[3], ARGV[2], -1)
for i = 4, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
end
redis.call('DEL', KEYS[1])
return 1
\`)

// ClaimTickets claims every ticket of the roster for matchID; false, touching nothing, when one is not waiting.
func ClaimTickets(ctx context.Context, matchID string, bucket int, ticketIDs []string) (bool, error) {
	keys := []string{store.PoolKey(bucket), store.DepthKey}
	for _, t := range ticketIDs {
		keys = append(keys, store.TicketKey(t))
	}
	n, err := claim.Run(ctx, rdb, keys, matchID, strconv.Itoa(bucket)).Int64()
	return n == 1, err
}

// CancelTicket takes the players out of the queue; false when the ticket is unknown or already in a match.
func CancelTicket(ctx context.Context, ticketID string) (bool, error) {
	t := store.GetTicket(ctx, ticketID)
	if t == nil {
		return false, nil
	}
	keys := []string{store.TicketKey(ticketID), store.PoolKey(t.Bucket), store.DepthKey}
	for _, p := range t.Participants {
		keys = append(keys, store.OpenKey(p))
	}
	n, err := cancel.Run(ctx, rdb, keys, ticketID, strconv.Itoa(t.Bucket)).Int64()
	return n == 1, err
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'matchmaking/store.h': `// The matchmaking store (provided). ticket:{id} is a hash: ticket_id, owner, skill, bucket,
// participants ("p1,p2", the owner first), state (waiting or claimed) and match_id ("" while
// waiting). pool:{bucket} is a sorted set of the waiting ticket ids scored by skill, pool:depth a
// hash of how many tickets wait per bucket. match:{id} is a hash: match_id, bucket, tickets,
// players, server_id, state (allocating, joining or abandoned) and reason; match:{id}:joined is the
// set of players whose client confirmed the join. outbox is a list of JSON rows {topic, key,
// payload} a relay publishes later. open:{player} (step 1) holds the player's open ticket id.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

constexpr long kBucketWidth = 100;
inline const std::string kDepthKey = "pool:depth";

// One queued ticket; match_id is "" while it waits.
struct Ticket {
  std::string ticket_id;
  std::string owner;
  long skill = 0;
  long bucket = 0;
  std::vector<std::string> participants;
  std::string state;
  std::string match_id;
};

// One match; server_id and reason are "" when unset, joined is sorted.
struct Match {
  std::string match_id;
  long bucket = 0;
  std::vector<std::string> tickets;
  std::vector<std::string> players;
  std::string server_id;
  std::string state;
  std::string reason;
  std::vector<std::string> joined;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The pool a skill falls in (floor division, as in every language of the course).
inline long bucketOf(long skill) { return skill >= 0 || skill % kBucketWidth == 0 ? skill / kBucketWidth : skill / kBucketWidth - 1; }
inline std::string ticketKey(const std::string& ticket_id) { return "ticket:" + ticket_id; }
inline std::string poolKey(long bucket) { return "pool:" + std::to_string(bucket); }
inline std::string openKey(const std::string& player_id) { return "open:" + player_id; }
inline std::string matchKey(const std::string& match_id) { return "match:" + match_id; }

inline std::vector<std::string> splitList(const std::string& text) {
  std::vector<std::string> out;
  if (text.empty()) return out;
  size_t start = 0;
  while (true) {
    const size_t comma = text.find(',', start);
    out.push_back(text.substr(start, comma == std::string::npos ? std::string::npos : comma - start));
    if (comma == std::string::npos) return out;
    start = comma + 1;
  }
}

inline std::string joinList(const std::vector<std::string>& items) {
  std::string out;
  for (const std::string& item : items) out += (out.empty() ? "" : ",") + item;
  return out;
}

// A fresh ticket id: t-1, t-2, …
inline std::string nextTicketId() { return "t-" + std::to_string(redis().incr("ticket:seq")); }

// The ticket, or none.
inline std::optional<Ticket> getTicket(const std::string& ticket_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(ticketKey(ticket_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return Ticket{text("ticket_id"), text("owner"), std::stol(text("skill")), std::stol(text("bucket")), splitList(text("participants")), text("state"), text("match_id")};
}

// Write the ticket and put it in its skill pool: ZADD pool:{bucket}, HINCRBY pool:depth +1.
inline Ticket enqueue(const std::string& ticket_id, const std::string& owner, long skill, const std::vector<std::string>& participants) {
  const long bucket = bucketOf(skill);
  redis().hset(ticketKey(ticket_id), {{"ticket_id", ticket_id}, {"owner", owner}, {"skill", std::to_string(skill)}, {"bucket", std::to_string(bucket)},
                                      {"participants", joinList(participants)}, {"state", "waiting"}, {"match_id", ""}});
  redis().zadd(poolKey(bucket), ticket_id, static_cast<double>(skill));
  redis().hincrby(kDepthKey, std::to_string(bucket), 1);
  return *getTicket(ticket_id);
}

// The match, or none.
inline std::optional<Match> getMatch(const std::string& match_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(matchKey(match_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  std::vector<std::string> joined = redis().smembers(matchKey(match_id) + ":joined");
  std::sort(joined.begin(), joined.end());
  return Match{text("match_id"), std::stol(text("bucket")), splitList(text("tickets")), splitList(text("players")), text("server_id"), text("state"), text("reason"), joined};
}

// A match over these tickets, allocating: its players are every participant of every ticket.
inline Match createMatch(const std::string& match_id, long bucket, const std::vector<std::string>& ticket_ids) {
  std::vector<std::string> players;
  for (const std::string& ticket_id : ticket_ids) {
    const Ticket t = *getTicket(ticket_id);
    players.insert(players.end(), t.participants.begin(), t.participants.end());
  }
  redis().hset(matchKey(match_id), {{"match_id", match_id}, {"bucket", std::to_string(bucket)}, {"tickets", joinList(ticket_ids)},
                                    {"players", joinList(players)}, {"server_id", ""}, {"state", "allocating"}, {"reason", ""}});
  return *getMatch(match_id);
}

// The allocator placed the match: record the server, the players start joining.
inline void setServer(const std::string& match_id, const std::string& server_id) {
  redis().hset(matchKey(match_id), {{"server_id", server_id}, {"state", "joining"}});
}

// The player's client connected to the match's server.
inline void confirmJoin(const std::string& match_id, const std::string& player_id) { redis().sadd(matchKey(match_id) + ":joined", player_id); }

// Whether every player of the match has confirmed the join.
inline bool allJoinsConfirmed(const std::string& match_id) {
  const auto m = getMatch(match_id);
  if (!m) return false;
  for (const std::string& p : m->players) {
    if (std::find(m->joined.begin(), m->joined.end(), p) == m->joined.end()) return false;
  }
  return true;
}

// The match ended without starting.
inline void abandon(const std::string& match_id, const std::string& reason) {
  redis().hset(matchKey(match_id), {{"state", "abandoned"}, {"reason", reason}});
}

// An event the broker did not take, for the relay to publish later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace store
`,
  'matchmaking/claims.h': `// The roster claim (provided; step 2 builds the same two functions). claimTickets takes every
// ticket of a roster out of its pool for one match in one Lua script, or none of them; cancelTicket
// takes a waiting ticket out of the queue, its pool entry, depth and open-ticket pointers included.
#pragma once

#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "matchmaking/store.h"

namespace claims {

// KEYS: pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket.
inline const std::string kClaimLua = R"lua(
for i = 3, #KEYS do
  if redis.call('HGET', KEYS[i], 'state') ~= 'waiting' then return 0 end
end
for i = 3, #KEYS do
  redis.call('ZREM', KEYS[1], redis.call('HGET', KEYS[i], 'ticket_id'))
  redis.call('HSET', KEYS[i], 'state', 'claimed', 'match_id', ARGV[1])
end
redis.call('HINCRBY', KEYS[2], ARGV[2], -(#KEYS - 2))
return 1
)lua";

// KEYS: ticket:{id}, pool:{bucket}, pool:depth, open:{player}…; ARGV: ticket id, bucket.
inline const std::string kCancelLua = R"lua(
if redis.call('HGET', KEYS[1], 'state') ~= 'waiting' then return 0 end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HINCRBY', KEYS[3], ARGV[2], -1)
for i = 4, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
end
redis.call('DEL', KEYS[1])
return 1
)lua";

// Claim every ticket of the roster for match_id; false, touching nothing, when one is not waiting.
inline bool claimTickets(const std::string& match_id, long bucket, const std::vector<std::string>& ticket_ids) {
  std::vector<std::string> keys = {store::poolKey(bucket), store::kDepthKey};
  for (const std::string& t : ticket_ids) keys.push_back(store::ticketKey(t));
  const std::vector<std::string> args = {match_id, std::to_string(bucket)};
  return store::redis().eval<long long>(kClaimLua, keys, args) == 1;
}

// The players leave the queue; false when the ticket is unknown or already in a match.
inline bool cancelTicket(const std::string& ticket_id) {
  const auto t = store::getTicket(ticket_id);
  if (!t) return false;
  std::vector<std::string> keys = {store::ticketKey(ticket_id), store::poolKey(t->bucket), store::kDepthKey};
  for (const std::string& p : t->participants) keys.push_back(store::openKey(p));
  const std::vector<std::string> args = {ticket_id, std::to_string(t->bucket)};
  return store::redis().eval<long long>(kCancelLua, keys, args) == 1;
}

}  // namespace claims
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('matchmaking', 'Store')]: `package matchmaking

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The matchmaking store (provided). ticket:{id} is a hash: ticket_id, owner, skill, bucket,
 * participants ("p1,p2", the owner first), state (waiting or claimed) and match_id ("" while
 * waiting). pool:{bucket} is a sorted set of the waiting ticket ids scored by skill, pool:depth a
 * hash of how many tickets wait per bucket. match:{id} is a hash: match_id, bucket, tickets,
 * players, server_id, state (allocating, joining or abandoned) and reason; match:{id}:joined is the
 * set of players whose client confirmed the join. outbox is a list of JSON rows {topic, key,
 * payload} a relay publishes later. open:{player} (step 1) holds the player's open ticket id.
 */
object Store {
  final case class Ticket(ticketId: String, owner: String, skill: Long, bucket: Long, participants: Seq[String], state: String, matchId: Option[String])
  final case class Match(matchId: String, bucket: Long, tickets: Seq[String], players: Seq[String], serverId: Option[String], state: String, reason: Option[String], joined: Seq[String])

  val BucketWidth = 100L
  val DepthKey = "pool:depth"

  val jedis = new JedisPooled("redis", 6379)

  def bucketOf(skill: Long): Long = Math.floorDiv(skill, BucketWidth)
  def ticketKey(ticketId: String): String = s"ticket:$ticketId"
  def poolKey(bucket: Long): String = s"pool:$bucket"
  def openKey(playerId: String): String = s"open:$playerId"
  def matchKey(matchId: String): String = s"match:$matchId"

  private def list(text: String): Seq[String] = if (text == null || text.isEmpty) Seq.empty else text.split(",").toSeq
  private def optional(text: String): Option[String] = Option(text).filter(_.nonEmpty)

  /** A fresh ticket id: t-1, t-2, … */
  def nextTicketId(): String = s"t-\${jedis.incr("ticket:seq")}"

  /** Write the ticket and put it in its skill pool: ZADD pool:{bucket}, HINCRBY pool:depth +1. */
  def enqueue(ticketId: String, owner: String, skill: Long, participants: Seq[String]): Ticket = {
    val bucket = bucketOf(skill)
    jedis.hset(ticketKey(ticketId), Map(
      "ticket_id" -> ticketId, "owner" -> owner, "skill" -> skill.toString, "bucket" -> bucket.toString,
      "participants" -> participants.mkString(","), "state" -> "waiting", "match_id" -> "").asJava)
    jedis.zadd(poolKey(bucket), skill.toDouble, ticketId)
    jedis.hincrBy(DepthKey, bucket.toString, 1L)
    getTicket(ticketId).get
  }

  /** The ticket, if it exists. */
  def getTicket(ticketId: String): Option[Ticket] = {
    val raw = jedis.hgetAll(ticketKey(ticketId)).asScala.toMap
    if (raw.isEmpty) None
    else Some(Ticket(raw("ticket_id"), raw("owner"), raw("skill").toLong, raw("bucket").toLong, list(raw("participants")), raw("state"), optional(raw.getOrElse("match_id", ""))))
  }

  /** A match over these tickets, allocating: its players are every participant of every ticket. */
  def createMatch(matchId: String, bucket: Long, ticketIds: Seq[String]): Match = {
    val players = ticketIds.flatMap(t => getTicket(t).get.participants)
    jedis.hset(matchKey(matchId), Map(
      "match_id" -> matchId, "bucket" -> bucket.toString, "tickets" -> ticketIds.mkString(","), "players" -> players.mkString(","),
      "server_id" -> "", "state" -> "allocating", "reason" -> "").asJava)
    getMatch(matchId).get
  }

  /** The match, if it exists (joined sorted). */
  def getMatch(matchId: String): Option[Match] = {
    val raw = jedis.hgetAll(matchKey(matchId)).asScala.toMap
    if (raw.isEmpty) None
    else {
      val joined = jedis.smembers(s"\${matchKey(matchId)}:joined").asScala.toSeq.sorted
      Some(Match(raw("match_id"), raw("bucket").toLong, list(raw("tickets")), list(raw("players")), optional(raw.getOrElse("server_id", "")), raw("state"), optional(raw.getOrElse("reason", "")), joined))
    }
  }

  /** The allocator placed the match: record the server, the players start joining. */
  def setServer(matchId: String, serverId: String): Unit =
    jedis.hset(matchKey(matchId), Map("server_id" -> serverId, "state" -> "joining").asJava)

  /** The player's client connected to the match's server. */
  def confirmJoin(matchId: String, playerId: String): Unit = jedis.sadd(s"\${matchKey(matchId)}:joined", playerId)

  /** Whether every player of the match has confirmed the join. */
  def allJoinsConfirmed(matchId: String): Boolean = getMatch(matchId).exists(m => m.players.forall(m.joined.contains))

  /** The match ended without starting. */
  def abandon(matchId: String, reason: String): Unit =
    jedis.hset(matchKey(matchId), Map("state" -> "abandoned", "reason" -> reason).asJava)

  /** An event the broker did not take, for the relay to publish later. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('matchmaking', 'Claims')]: `package matchmaking

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The roster claim (provided; step 2 builds the same two functions). claimTickets takes every ticket
 * of a roster out of its pool for one match in one Lua script, or none of them; cancelTicket takes a
 * waiting ticket out of the queue, its pool entry, depth and open-ticket pointers included.
 */
object Claims {
  val jedis = new JedisPooled("redis", 6379)

  /** KEYS: pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket. */
  val ClaimLua: String =
    """for i = 3, #KEYS do
      |  if redis.call('HGET', KEYS[i], 'state') ~= 'waiting' then return 0 end
      |end
      |for i = 3, #KEYS do
      |  redis.call('ZREM', KEYS[1], redis.call('HGET', KEYS[i], 'ticket_id'))
      |  redis.call('HSET', KEYS[i], 'state', 'claimed', 'match_id', ARGV[1])
      |end
      |redis.call('HINCRBY', KEYS[2], ARGV[2], -(#KEYS - 2))
      |return 1
      |""".stripMargin

  /** KEYS: ticket:{id}, pool:{bucket}, pool:depth, open:{player}…; ARGV: ticket id, bucket. */
  val CancelLua: String =
    """if redis.call('HGET', KEYS[1], 'state') ~= 'waiting' then return 0 end
      |redis.call('ZREM', KEYS[2], ARGV[1])
      |redis.call('HINCRBY', KEYS[3], ARGV[2], -1)
      |for i = 4, #KEYS do
      |  if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
      |end
      |redis.call('DEL', KEYS[1])
      |return 1
      |""".stripMargin

  /** Claim every ticket of the roster for matchId; false, touching nothing, when one is not waiting. */
  def claimTickets(matchId: String, bucket: Long, ticketIds: Seq[String]): Boolean = {
    val keys = Seq(Store.poolKey(bucket), Store.DepthKey) ++ ticketIds.map(Store.ticketKey)
    jedis.eval(ClaimLua, keys.asJava, Seq(matchId, bucket.toString).asJava).asInstanceOf[java.lang.Long] == 1L
  }

  /** The players leave the queue; false when the ticket is unknown or already in a match. */
  def cancelTicket(ticketId: String): Boolean = Store.getTicket(ticketId) match {
    case None => false
    case Some(t) =>
      val keys = Seq(Store.ticketKey(ticketId), Store.poolKey(t.bucket), Store.DepthKey) ++ t.participants.map(Store.openKey)
      jedis.eval(CancelLua, keys.asJava, Seq(ticketId, t.bucket.toString).asJava).asInstanceOf[java.lang.Long] == 1L
  }
}
`,
};
