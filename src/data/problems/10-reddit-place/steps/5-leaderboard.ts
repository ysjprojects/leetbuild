import type {Step} from '@/lib/types';

export const leaderboardStep: Step = {
  id: 'leaderboard',
  title: 'Leaderboard and per-pixel history from the placements stream',
  concept: 'redis',
  file: 'leaderboard',
  focus: ['kafka', 'worker', 'redis'],
  task: `## Task

Implement the **leaderboard** worker — a member of consumer group \`leaderboard\` reading \`placements\` —
and the two endpoints that read what it keeps. \`history_key(x, y)\` is provided and returns
\`history:{x}:{y}\`.

- Disable auto-commit. Auto-commit acknowledges records on a timer, *before* you know they were
  counted; a crash then loses tiles silently.
- For every record: parse the JSON, then
  \`ZINCRBY place:leaders 1 {user}\` (one more tile for the user) and
  \`LPUSH history:{x}:{y} {"user", "color", "ts"}\` + \`LTRIM history:{x}:{y} 0 9\` (the last
  **\`HISTORY_LEN\`** = 10 placements on that pixel, newest first), **then** commit the offset.
  Committing after the writes is at-least-once: a crash between the two replays the record and
  over-counts by one instead of losing it — the right trade-off for a scoreboard.
- Skip malformed records (log and commit) rather than crash-looping on a poison message.
- \`GET /top\` answers the **10** users with the most tiles: \`ZREVRANGE place:leaders 0 9 WITHSCORES\` →
  \`[{"user": …, "tiles": …}, …]\`.
- \`GET /history?x=&y=\` answers the pixel's recent placements newest first (**400** when \`x\`/\`y\` are
  outside \`[0, SIZE)\`): \`LRANGE history:{x}:{y} 0 9\` → \`[{"user", "color", "ts"}, …]\`.

:::widget consumer-groups {"partitions": 8}

:::widget delivery-semantics {}

> "Who placed this pixel?" was the most popular request of the original and the only one the CDN
> could not cache. Answering it from a 10-element list is one O(1) Redis read instead of a
> wide-table lookup per hover.`,
  sequence: {
    participants: ['Kafka', 'leaderboard', 'Redis', 'Client'],
    messages: [
      {
        from: 'Kafka',
        to: 'leaderboard',
        label: 'poll → {ana, 3, 7, 12, ts} (partition 2, offset 41 207)',
        kind: 'reply',
      },
      {from: 'leaderboard', to: 'Redis', label: 'ZINCRBY place:leaders 1 ana', kind: 'sync'},
      {
        from: 'leaderboard',
        to: 'Redis',
        label: 'LPUSH history:3:7 {ana, 12, ts} · LTRIM history:3:7 0 9',
        kind: 'sync',
      },
      {from: 'leaderboard', to: 'Kafka', label: 'commit offset 41 208 (partition 2)', kind: 'sync'},
      {from: 'Client', to: 'leaderboard', label: 'GET /top', kind: 'sync'},
      {from: 'leaderboard', to: 'Redis', label: 'ZREVRANGE place:leaders 0 9 WITHSCORES', kind: 'sync'},
      {from: 'Client', to: 'leaderboard', label: 'GET /history?x=3&y=7', kind: 'sync'},
      {from: 'leaderboard', to: 'Redis', label: 'LRANGE history:3:7 0 9', kind: 'sync'},
    ],
  },
  hints: [
    'Consumer configuration is where auto-commit is disabled (`enable.auto.commit=false`; in kafka-go, use `FetchMessage` + `CommitMessages` instead of `ReadMessage`).',
    'The order inside the loop is the whole point: ZINCRBY, LPUSH, LTRIM first, commit second. LPUSH + LTRIM 0 HISTORY_LEN-1 is the idiom for "a capped list, newest first" — the trim bound is inclusive.',
    'ZINCRBY creates the key and the member when they do not exist, so the worker needs no setup; `/top` reads (member, score) pairs in descending order — `0 9` is inclusive — and `/history` validates the coordinates before building the key.',
  ],
  checks: [
    {
      id: 'consumer',
      title: 'Joins consumer group leaderboard on placements with auto-commit off',
      detail:
        'The consumer uses `group.id` `leaderboard`, subscribes to `placements`, and commits offsets explicitly after processing — not on a timer.',
      match: {
        python: {
          all: [
            /"group\.id"\s*:\s*"leaderboard"/,
            /subscribe\(\s*\[\s*"placements"\s*\]\s*\)/,
            /"enable\.auto\.commit"\s*:\s*False/,
          ],
        },
        typescript: {
          all: [
            /groupId:\s*['"]leaderboard['"]/,
            /subscribe\(\s*\{[^\n]*topic:\s*['"]placements['"]/,
            /autoCommit:\s*false/,
          ],
        },
        go: {
          all: [/GroupID:\s*"leaderboard"/, /Topic:\s*"placements"/, /reader\.FetchMessage\(/],
          none: [/ReadMessage\(/],
        },
        scala: {
          all: [
            /"group\.id"\s*,\s*"leaderboard"|GROUP_ID_CONFIG\s*,\s*"leaderboard"/,
            /subscribe\([^\n]*"placements"/,
            /"enable\.auto\.commit"\s*,\s*"false"|ENABLE_AUTO_COMMIT_CONFIG\s*,\s*"false"/,
          ],
        },
        cpp: {
          all: [
            /"group\.id"\s*,\s*"leaderboard"/,
            /subscribe\([^\n]*"placements"/,
            /"enable\.auto\.commit"\s*,\s*"false"/,
          ],
        },
      },
    },
    {
      id: 'zincrby',
      title: 'Counts one tile per placement in the leaders sorted set',
      detail: 'Each record is `ZINCRBY place:leaders 1 user` — atomic in Redis, and the set stays sorted by count.',
      match: {
        python: {all: [/\br\.zincrby\(\s*LEADERS_KEY\s*,\s*1(\.0)?\s*,/]},
        typescript: {all: [/\bredis\.zincrby\(\s*LEADERS_KEY\s*,\s*1\s*,/]},
        go: {all: [/rdb\.ZIncrBy\(\s*ctx\s*,\s*leadersKey\s*,\s*1(\.0)?\s*,/]},
        scala: {all: [/jedis\.zincrby\(\s*LeadersKey\s*,\s*1(\.0|d)?\s*,/]},
        cpp: {all: [/redis\.zincrby\(\s*kLeadersKey\s*,\s*1(\.0)?\s*,/]},
      },
    },
    {
      id: 'history-capped',
      title: 'Keeps the last 10 placements per pixel, newest first',
      detail:
        'Each record is `LPUSH history:{x}:{y} …` followed by `LTRIM history:{x}:{y} 0 HISTORY_LEN-1` so no pixel’s list grows past 10.',
      match: {
        python: {
          all: [
            /\br\.lpush\(/,
            /\br\.ltrim\(\s*\w+\s*,\s*0\s*,\s*(HISTORY_LEN\s*-\s*1|9)\s*\)/,
            /(?<!def )history_key\(/,
          ],
        },
        typescript: {
          all: [
            /\bredis\.lpush\(/,
            /\bredis\.ltrim\(\s*\w+\s*,\s*0\s*,\s*(HISTORY_LEN\s*-\s*1|9)\s*\)/,
            /(?<!function )historyKey\(/,
          ],
        },
        go: {
          all: [
            /rdb\.LPush\(/,
            /rdb\.LTrim\(\s*ctx\s*,\s*\w+\s*,\s*0\s*,\s*(historyLen\s*-\s*1|9)\s*\)/,
            /(?<!func )historyKey\(/,
          ],
        },
        scala: {
          all: [
            /jedis\.lpush\(/,
            /jedis\.ltrim\(\s*\w+\s*,\s*0L?\s*,\s*(HistoryLen\s*-\s*1|9L?)\s*\)/,
            /(?<!def )historyKey\(/,
          ],
        },
        cpp: {
          all: [
            /redis\.lpush\(/,
            /redis\.ltrim\(\s*\w+\s*,\s*0\s*,\s*(kHistoryLen\s*-\s*1|9)\s*\)/,
            /(?<!string )history_key\(/,
          ],
        },
      },
    },
    {
      id: 'commit-after',
      title: 'Commits after the writes',
      detail:
        'Commit the offset only once the sorted set and the history list have been updated: at-least-once, never at-most-once.',
      match: {
        python: {order: [/\br\.zincrby\(/, /\br\.ltrim\(/, /consumer\.commit\(/]},
        typescript: {order: [/\bredis\.zincrby\(/, /\bredis\.ltrim\(/, /consumer\.commitOffsets\(/]},
        go: {order: [/rdb\.ZIncrBy\(/, /rdb\.LTrim\(/, /reader\.CommitMessages\(/]},
        scala: {order: [/jedis\.zincrby\(/, /jedis\.ltrim\(/, /consumer\.commitSync\(/]},
        cpp: {order: [/redis\.zincrby\(/, /redis\.ltrim\(/, /consumer->commitSync\(/]},
      },
    },
    {
      id: 'endpoints',
      title: 'GET /top reads the 10 highest counts; GET /history reads a pixel’s list',
      detail:
        '`/top` reads `place:leaders` in descending score order with scores (`ZREVRANGE … 0 9 WITHSCORES`) into `[{user, tiles}]`; `/history` validates `x`/`y` (400) and reads `LRANGE history:{x}:{y} 0 9`.',
      match: {
        python: {
          all: [
            /\br\.zrevrange\([^\n]*withscores\s*=\s*True|\br\.zrange\([^\n]*desc\s*=\s*True[^\n]*withscores\s*=\s*True/,
            /\br\.lrange\(/,
            /"tiles"/,
            /status_code\s*=\s*400/,
          ],
        },
        typescript: {
          all: [
            /\bredis\.zrevrange\([^\n]*['"]WITHSCORES['"]|\bredis\.zrange\([^\n]*['"]REV['"][^\n]*['"]WITHSCORES['"]/,
            /\bredis\.lrange\(/,
            /\btiles\b/,
            /code\(\s*400\s*\)|status\(\s*400\s*\)/,
          ],
        },
        go: {
          all: [
            /ZRevRangeWithScores\(|ZRangeArgsWithScores\(/,
            /rdb\.LRange\(/,
            /"tiles"/,
            /http\.StatusBadRequest|\b400\b/,
          ],
        },
        scala: {
          all: [
            /zrevrangeWithScores\(|zrangeWithScores\([^\n]*rev/,
            /jedis\.lrange\(/,
            /"tiles"/,
            /StatusCodes\.BadRequest|\b400\b/,
          ],
        },
        cpp: {all: [/redis\.zrevrange\(/, /redis\.lrange\(/, /"tiles"/, /status\s*=\s*400/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import threading
from contextlib import asynccontextmanager

import redis
from confluent_kafka import Consumer
from fastapi import FastAPI, HTTPException


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=run, daemon=True).start()  # the worker lives beside the API
    yield


app = FastAPI(lifespan=lifespan)
log = logging.getLogger("leaderboard")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SIZE = 100
TOP_N = 10
HISTORY_LEN = 10
LEADERS_KEY = "place:leaders"

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "leaderboard",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe(["placements"])


def history_key(x: int, y: int) -> str:
    """history:{x}:{y} (provided)."""
    return f"history:{x}:{y}"


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        # TODO: parse JSON (skip + commit malformed records)
        # TODO: ZINCRBY LEADERS_KEY 1 user; LPUSH history_key(x, y) {"user", "color", "ts"}; LTRIM 0 HISTORY_LEN-1
        # TODO: then commit this message
        raise NotImplementedError


@app.get("/top")
def top() -> list[dict]:
    # TODO: ZREVRANGE LEADERS_KEY 0 TOP_N-1 WITHSCORES → [{"user": …, "tiles": …}]
    return []


@app.get("/history")
def history(x: int = -1, y: int = -1) -> list[dict]:
    # TODO: 400 unless 0 <= x, y < SIZE; LRANGE history_key(x, y) 0 HISTORY_LEN-1 → [{"user", "color", "ts"}]
    return []
`,
      solution: `import json
import logging
import threading
from contextlib import asynccontextmanager

import redis
from confluent_kafka import Consumer
from fastapi import FastAPI, HTTPException


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=run, daemon=True).start()  # the worker lives beside the API
    yield


app = FastAPI(lifespan=lifespan)
log = logging.getLogger("leaderboard")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SIZE = 100
TOP_N = 10
HISTORY_LEN = 10
LEADERS_KEY = "place:leaders"

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "leaderboard",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["placements"])


def history_key(x: int, y: int) -> str:
    """history:{x}:{y} (provided)."""
    return f"history:{x}:{y}"


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        try:
            event = json.loads(msg.value())
            user, x, y = str(event["user"]), int(event["x"]), int(event["y"])
            entry = json.dumps({"user": user, "color": int(event["color"]), "ts": int(event["ts"])})
        except (ValueError, KeyError, TypeError):
            log.warning("skipping malformed record at offset %d", msg.offset())
            consumer.commit(message=msg, asynchronous=False)
            continue
        key = history_key(x, y)
        r.zincrby(LEADERS_KEY, 1, user)
        r.lpush(key, entry)
        r.ltrim(key, 0, HISTORY_LEN - 1)  # newest first, never more than 10
        consumer.commit(message=msg, asynchronous=False)


@app.get("/top")
def top() -> list[dict]:
    rows = r.zrevrange(LEADERS_KEY, 0, TOP_N - 1, withscores=True)
    return [{"user": user, "tiles": int(score)} for user, score in rows]


@app.get("/history")
def history(x: int = -1, y: int = -1) -> list[dict]:
    if not (0 <= x < SIZE and 0 <= y < SIZE):
        raise HTTPException(status_code=400, detail=f"x and y must be in [0, {SIZE})")
    return [json.loads(item) for item in r.lrange(history_key(x, y), 0, HISTORY_LEN - 1)]
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const SIZE = 100;
export const TOP_N = 10;
export const HISTORY_LEN = 10;
export const LEADERS_KEY = 'place:leaders';

const kafka = new Kafka({clientId: 'leaderboard', brokers: ['kafka:9092']});

/** history:{x}:{y} (provided). */
export function historyKey(x: number, y: number): string {
  return \`history:\${x}:\${y}\`;
}

/** The worker, started beside the API: one member of group leaderboard reading placements. */
export async function run(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'leaderboard'});
  await consumer.connect();
  await consumer.subscribe({topic: 'placements', fromBeginning: true});
  await consumer.run({
    // TODO: disable auto-commit
    eachMessage: async ({topic, partition, message}) => {
      // TODO: parse JSON (skip + commit malformed records)
      // TODO: ZINCRBY LEADERS_KEY 1 user; LPUSH historyKey(x, y) {user, color, ts}; LTRIM 0 HISTORY_LEN-1
      // TODO: then commit this message: consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}])
      throw new Error('not implemented');
    },
  });
}

app.get('/top', async () => {
  // TODO: ZREVRANGE LEADERS_KEY 0 TOP_N-1 WITHSCORES → [{user, tiles}]
  return [];
});

app.get('/history', async (request, reply) => {
  // TODO: 400 unless 0 <= x, y < SIZE; LRANGE historyKey(x, y) 0 HISTORY_LEN-1 → [{user, color, ts}]
  return [];
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const SIZE = 100;
export const TOP_N = 10;
export const HISTORY_LEN = 10;
export const LEADERS_KEY = 'place:leaders';

const kafka = new Kafka({clientId: 'leaderboard', brokers: ['kafka:9092']});

/** history:{x}:{y} (provided). */
export function historyKey(x: number, y: number): string {
  return \`history:\${x}:\${y}\`;
}

interface Placement {
  user: string;
  x: number;
  y: number;
  color: number;
  ts: number;
}

/** The placements event, or null when the record is not one. */
function parse(value: Buffer | null): Placement | null {
  try {
    const event = JSON.parse(value?.toString() ?? '') as Partial<Placement>;
    const {user, x, y, color, ts} = event;
    if (typeof user !== 'string' || !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(color) || !Number.isInteger(ts)) return null;
    return {user, x: x as number, y: y as number, color: color as number, ts: ts as number};
  } catch {
    return null;
  }
}

/** The worker, started beside the API: one member of group leaderboard reading placements. */
export async function run(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'leaderboard'});
  await consumer.connect();
  await consumer.subscribe({topic: 'placements', fromBeginning: true});
  await consumer.run({
    autoCommit: false, // commit when the record is counted, not on a timer
    eachMessage: async ({topic, partition, message}) => {
      const next = {topic, partition, offset: String(Number(message.offset) + 1)};
      const event = parse(message.value);
      if (event === null) {
        console.warn(\`skipping malformed record at offset \${message.offset}\`);
        await consumer.commitOffsets([next]);
        return;
      }
      const key = historyKey(event.x, event.y);
      await redis.zincrby(LEADERS_KEY, 1, event.user);
      await redis.lpush(key, JSON.stringify({user: event.user, color: event.color, ts: event.ts}));
      await redis.ltrim(key, 0, HISTORY_LEN - 1); // newest first, never more than 10
      await consumer.commitOffsets([next]); // after the writes: at-least-once
    },
  });
}

app.get('/top', async () => {
  const rows = await redis.zrevrange(LEADERS_KEY, 0, TOP_N - 1, 'WITHSCORES');
  const top: {user: string; tiles: number}[] = [];
  for (let i = 0; i + 1 < rows.length; i += 2) top.push({user: rows[i], tiles: Number(rows[i + 1])});
  return top;
});

app.get('/history', async (request, reply) => {
  const query = request.query as {x?: string; y?: string};
  const x = Number(query.x ?? -1);
  const y = Number(query.y ?? -1);
  if (!(Number.isInteger(x) && Number.isInteger(y) && 0 <= x && x < SIZE && 0 <= y && y < SIZE))
    return reply.code(400).send({error: \`x and y must be in [0, \${SIZE})\`});
  const items = await redis.lrange(historyKey(x, y), 0, HISTORY_LEN - 1);
  return items.map(item => JSON.parse(item));
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	size       = 100
	topN       = 10
	historyLen = 10
	leadersKey = "place:leaders"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "leaderboard",
	Topic:   "placements",
})

type placementEvent struct {
	User  string \`json:"user"\`
	X     int    \`json:"x"\`
	Y     int    \`json:"y"\`
	Color int    \`json:"color"\`
	Ts    int64  \`json:"ts"\`
}

type historyEntry struct {
	User  string \`json:"user"\`
	Color int    \`json:"color"\`
	Ts    int64  \`json:"ts"\`
}

type leader struct {
	User  string \`json:"user"\`
	Tiles int64  \`json:"tiles"\`
}

// historyKey is history:{x}:{y} (provided).
func historyKey(x, y int) string { return fmt.Sprintf("history:%d:%d", x, y) }

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: parse JSON (skip + commit malformed records: bad JSON or a missing field)
		// TODO: ZIncrBy leadersKey 1 user; LPush historyKey(x, y) entry; LTrim 0 historyLen-1; then CommitMessages
		_ = json.Unmarshal
		return nil
	}
}

func top(rw http.ResponseWriter, r *http.Request) {
	// TODO: ZRevRangeWithScores leadersKey 0 topN-1 → []leader
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode([]leader{})
}

func history(rw http.ResponseWriter, r *http.Request) {
	x, errX := strconv.Atoi(r.URL.Query().Get("x"))
	y, errY := strconv.Atoi(r.URL.Query().Get("y"))
	// TODO: 400 unless both parse and 0 <= x, y < size; LRange historyKey(x, y) 0 historyLen-1 → []historyEntry
	_, _, _, _ = x, y, errX, errY
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode([]historyEntry{})
}

func main() {
	go func() { log.Fatal(run(context.Background())) }()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /top", top)
	mux.HandleFunc("GET /history", history)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	size       = 100
	topN       = 10
	historyLen = 10
	leadersKey = "place:leaders"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "leaderboard",
	Topic:   "placements",
})

type placementEvent struct {
	User  string \`json:"user"\`
	X     int    \`json:"x"\`
	Y     int    \`json:"y"\`
	Color int    \`json:"color"\`
	Ts    int64  \`json:"ts"\`
}

type historyEntry struct {
	User  string \`json:"user"\`
	Color int    \`json:"color"\`
	Ts    int64  \`json:"ts"\`
}

type leader struct {
	User  string \`json:"user"\`
	Tiles int64  \`json:"tiles"\`
}

// historyKey is history:{x}:{y} (provided).
func historyKey(x, y int) string { return fmt.Sprintf("history:%d:%d", x, y) }

// parse is the placements event, or false when the record is not one: bad JSON, a field of the
// wrong type, or a field missing.
func parse(value []byte) (placementEvent, bool) {
	var event placementEvent
	var fields map[string]json.RawMessage
	if json.Unmarshal(value, &fields) != nil || json.Unmarshal(value, &event) != nil {
		return event, false
	}
	for _, name := range []string{"user", "x", "y", "color", "ts"} {
		if _, ok := fields[name]; !ok {
			return event, false
		}
	}
	return event, event.User != ""
}

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		event, ok := parse(msg.Value)
		if !ok {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		entry, _ := json.Marshal(historyEntry{User: event.User, Color: event.Color, Ts: event.Ts})
		key := historyKey(event.X, event.Y)
		if err := rdb.ZIncrBy(ctx, leadersKey, 1, event.User).Err(); err != nil {
			return err // do not commit: the record will be redelivered
		}
		if err := rdb.LPush(ctx, key, entry).Err(); err != nil {
			return err
		}
		if err := rdb.LTrim(ctx, key, 0, historyLen-1).Err(); err != nil { // newest first, never more than 10
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}

func top(rw http.ResponseWriter, r *http.Request) {
	rows, err := rdb.ZRevRangeWithScores(r.Context(), leadersKey, 0, topN-1).Result()
	if err != nil {
		http.Error(rw, "try again", http.StatusServiceUnavailable)
		return
	}
	out := make([]leader, 0, len(rows))
	for _, z := range rows {
		out = append(out, leader{User: z.Member.(string), Tiles: int64(z.Score)})
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(out)
}

func history(rw http.ResponseWriter, r *http.Request) {
	x, errX := strconv.Atoi(r.URL.Query().Get("x"))
	y, errY := strconv.Atoi(r.URL.Query().Get("y"))
	if errX != nil || errY != nil || x < 0 || x >= size || y < 0 || y >= size {
		http.Error(rw, "x and y must be in [0, size)", http.StatusBadRequest)
		return
	}
	items, err := rdb.LRange(r.Context(), historyKey(x, y), 0, historyLen-1).Result()
	if err != nil {
		http.Error(rw, "try again", http.StatusServiceUnavailable)
		return
	}
	out := make([]historyEntry, 0, len(items))
	for _, item := range items {
		var e historyEntry
		if json.Unmarshal([]byte(item), &e) == nil {
			out = append(out, e)
		}
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(out)
}

func main() {
	go func() { log.Fatal(run(context.Background())) }()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /top", top)
	mux.HandleFunc("GET /history", history)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import place.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import scala.util.Try
import spray.json._

object Leaderboard {
  val jedis = new JedisPooled("redis", 6379)
  val Size = 100
  val TopN = 10
  val HistoryLen = 10
  val LeadersKey = "place:leaders"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "leaderboard")
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("placements").asJava)

  /** history:{x}:{y} (provided). */
  def historyKey(x: Int, y: Int): String = s"history:$x:$y"

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        // TODO: parse the JSON (skip malformed records)
        // TODO: ZINCRBY LeadersKey 1 user; LPUSH historyKey(x, y) {"user", "color", "ts"}; LTRIM 0 HistoryLen-1
      }
      // TODO: commit synchronously after the batch is processed
    }

  val route: Route =
    concat(
      path("top") {
        get {
          // TODO: ZREVRANGE LeadersKey 0 TopN-1 WITHSCORES → [{"user": …, "tiles": …}]
          complete(HttpEntity(ContentTypes.\`application/json\`, "[]"))
        }
      },
      path("history") {
        get {
          parameters("x".as[Int], "y".as[Int]) { (x, y) =>
            // TODO: 400 unless 0 <= x, y < Size; LRANGE historyKey(x, y) 0 HistoryLen-1 → [{"user", "color", "ts"}]
            complete(HttpEntity(ContentTypes.\`application/json\`, "[]"))
          }
        }
      },
    )

  def main(args: Array[String]): Unit = {
    new Thread(() => run()).start()
    implicit val system: ActorSystem = ActorSystem("leaderboard")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import place.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import scala.util.Try
import spray.json._

object Leaderboard {
  val jedis = new JedisPooled("redis", 6379)
  val Size = 100
  val TopN = 10
  val HistoryLen = 10
  val LeadersKey = "place:leaders"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "leaderboard")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("placements").asJava)

  /** history:{x}:{y} (provided). */
  def historyKey(x: Int, y: Int): String = s"history:$x:$y"

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        Try(record.value().parseJson.asJsObject.fields).toOption.flatMap { f =>
          (f.get("user"), f.get("x"), f.get("y"), f.get("color"), f.get("ts")) match {
            case (Some(JsString(user)), Some(JsNumber(x)), Some(JsNumber(y)), Some(JsNumber(color)), Some(JsNumber(ts))) =>
              Some((user, x.toInt, y.toInt, color.toInt, ts.toLong))
            case _ => None
          }
        } match {
          case Some((user, x, y, color, ts)) =>
            val key = historyKey(x, y)
            val entry = JsObject("user" -> JsString(user), "color" -> JsNumber(color), "ts" -> JsNumber(ts)).compactPrint
            jedis.zincrby(LeadersKey, 1.0, user)
            jedis.lpush(key, entry)
            jedis.ltrim(key, 0, HistoryLen - 1) // newest first, never more than 10
          case None => System.err.println(s"skipping malformed record at offset \${record.offset()}")
        }
      }
      consumer.commitSync() // after every record of the batch has been counted
    }

  val route: Route =
    concat(
      path("top") {
        get {
          val rows = jedis.zrevrangeWithScores(LeadersKey, 0, TopN - 1).asScala.map { t =>
            JsObject("user" -> JsString(t.getElement), "tiles" -> JsNumber(t.getScore.toLong))
          }
          complete(HttpEntity(ContentTypes.\`application/json\`, JsArray(rows.toVector).compactPrint))
        }
      },
      path("history") {
        get {
          parameters("x".as[Int], "y".as[Int]) { (x, y) =>
            if (x < 0 || x >= Size || y < 0 || y >= Size)
              complete(HttpResponse(StatusCodes.BadRequest, entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"x and y must be in [0, Size)"}""")))
            else {
              val items = jedis.lrange(historyKey(x, y), 0, HistoryLen - 1).asScala.map(_.parseJson)
              complete(HttpEntity(ContentTypes.\`application/json\`, JsArray(items.toVector).compactPrint))
            }
          }
        }
      },
    )

  def main(args: Array[String]): Unit = {
    new Thread(() => run()).start()
    implicit val system: ActorSystem = ActorSystem("leaderboard")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kSize = 100;
constexpr int kTopN = 10;
constexpr int kHistoryLen = 10;
const std::string kLeadersKey = "place:leaders";

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "leaderboard", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"placements"});
  return consumer;
}

auto consumer = make_consumer();

// history:{x}:{y} (provided).
std::string history_key(int x, int y) { return "history:" + std::to_string(x) + ":" + std::to_string(y); }

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const json event = json::parse(static_cast<const char*>(msg->payload()), nullptr, false);
    // TODO: skip + commit malformed records (not an object, no string "user", no number "x"/"y"/"color"/"ts")
    // TODO: zincrby kLeadersKey 1 user; lpush history_key(x, y) {"user", "color", "ts"}; ltrim 0 kHistoryLen-1
    // TODO: then commitSync this message
  }
}

int main() {
  std::thread(run).detach();
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get("/top", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: ZREVRANGE kLeadersKey 0 kTopN-1 WITHSCORES → [{"user": …, "tiles": …}]
    res.set_content("[]", "application/json");
  });

  svr.Get("/history", [](const httplib::Request& req, httplib::Response& res) {
    const int x = req.has_param("x") ? std::stoi(req.get_param_value("x")) : -1;
    const int y = req.has_param("y") ? std::stoi(req.get_param_value("y")) : -1;
    // TODO: 400 unless 0 <= x, y < kSize; LRANGE history_key(x, y) 0 kHistoryLen-1 → [{"user", "color", "ts"}]
    res.set_content("[]", "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kSize = 100;
constexpr int kTopN = 10;
constexpr int kHistoryLen = 10;
const std::string kLeadersKey = "place:leaders";

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "leaderboard", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"placements"});
  return consumer;
}

auto consumer = make_consumer();

// history:{x}:{y} (provided).
std::string history_key(int x, int y) { return "history:" + std::to_string(x) + ":" + std::to_string(y); }

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const json event = json::parse(static_cast<const char*>(msg->payload()), nullptr, false);
    if (!event.is_object() || !event.contains("user") || !event["user"].is_string() || !event.contains("x") ||
        !event["x"].is_number() || !event["y"].is_number() || !event["color"].is_number() || !event["ts"].is_number()) {
      std::cerr << "skipping malformed record at offset " << msg->offset() << "\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    const std::string user = event["user"].get<std::string>();
    const std::string key = history_key(event["x"].get<int>(), event["y"].get<int>());
    const std::string entry = json{{"user", user}, {"color", event["color"]}, {"ts", event["ts"]}}.dump();
    redis.zincrby(kLeadersKey, 1, user);
    redis.lpush(key, entry);
    redis.ltrim(key, 0, kHistoryLen - 1);  // newest first, never more than 10
    consumer->commitSync(msg.get());
  }
}

int main() {
  std::thread(run).detach();
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get("/top", [](const httplib::Request& req, httplib::Response& res) {
    std::vector<std::pair<std::string, double>> rows;
    redis.zrevrange(kLeadersKey, 0, kTopN - 1, std::back_inserter(rows));
    json out = json::array();
    for (const auto& [user, score] : rows) out.push_back({{"user", user}, {"tiles", static_cast<long long>(score)}});
    res.set_content(out.dump(), "application/json");
  });

  svr.Get("/history", [](const httplib::Request& req, httplib::Response& res) {
    const int x = req.has_param("x") ? std::stoi(req.get_param_value("x")) : -1;
    const int y = req.has_param("y") ? std::stoi(req.get_param_value("y")) : -1;
    if (x < 0 || x >= kSize || y < 0 || y >= kSize) {
      res.status = 400;
      res.set_content(R"re({"error":"x and y must be in [0, kSize)"})re", "application/json");
      return;
    }
    std::vector<std::string> items;
    redis.lrange(history_key(x, y), 0, kHistoryLen - 1, std::back_inserter(items));
    json out = json::array();
    for (const auto& item : items) out.push_back(json::parse(item, nullptr, false));
    res.set_content(out.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import json

TS = 1700000000000
LEADERS = "place:leaders"


def _seed(ctx, *placements):
    """placements: (user, x, y, color) tuples, or just user names (one tile each on (3, 7))."""
    for i, p in enumerate(placements):
        user, x, y, color = p if isinstance(p, tuple) else (p, 3, 7, 12)
        ctx.kafka.seed("placements", key=f"{x}:{y}", value=json.dumps({"user": user, "x": x, "y": y, "color": color, "ts": TS + i}))


def check_consumer(ctx):
    _seed(ctx, "ana", ("bo", 4, 7, 5))
    bo = ctx.kafka.records("placements")[1]
    ctx.redis.set("history:4:7", "corrupt")  # bo's pixel: the worker's write fails while it handles her tile
    m = ctx.load("leaderboard")
    try:
        ctx.drain(m.run)
    except Exception:
        pass  # the worker died on bo's placement
    m.consumer.close()  # the process is stopped (deploy, SIGTERM): its consumer leaves the group
    committed = ctx.kafka.committed_offset("leaderboard", "placements", bo.partition)
    assert committed is None or committed <= bo.offset, f"bo's placement never reached her pixel's history, yet group leaderboard committed past it (offset {committed}) by the time the worker stopped: offsets were acknowledged for what was delivered, not for what was processed. Turn auto-commit off and commit after the writes"
    ctx.redis.delete("history:4:7")  # the fault is repaired and the worker restarts
    m = ctx.load("leaderboard")
    ctx.drain(m.run)
    history = ctx.redis.lrange("history:4:7", 0, -1)
    assert history and json.loads(history[0]).get("user") == "bo", f"after the restart bo's placement must be replayed into history:4:7, which holds {history}: it was lost"
    lag = ctx.kafka.lag("leaderboard", "placements")
    assert lag == 0, f"group leaderboard on placements has {lag} uncommitted record(s) after the worker processed everything: commit each record once it is counted"


def check_zincrby(ctx):
    _seed(ctx, "ana", "bo", ("ana", 4, 7, 1), ("ana", 5, 7, 2), ("cy", 0, 0, 15))
    m = ctx.load("leaderboard")
    ctx.drain(m.run)
    assert ctx.redis.type(LEADERS) == "zset", f"{LEADERS} is {ctx.redis.type(LEADERS)!r}, expected a sorted set (keys: {ctx.redis.keys()})"
    assert ctx.redis.zscore(LEADERS, "ana") == 3, f"ana in {LEADERS} scores {ctx.redis.zscore(LEADERS, 'ana')!r}, expected 3"
    assert ctx.redis.zscore(LEADERS, "bo") == 1, f"bo in {LEADERS} scores {ctx.redis.zscore(LEADERS, 'bo')!r}, expected 1"
    assert ctx.redis.zscore(LEADERS, "cy") == 1, f"cy in {LEADERS} scores {ctx.redis.zscore(LEADERS, 'cy')!r}, expected 1"


def check_history_capped(ctx):
    _seed(ctx, *[(f"u{i:02d}", 3, 7, i % 16) for i in range(12)], ("zed", 4, 7, 5))
    m = ctx.load("leaderboard")
    ctx.drain(m.run)
    key = m.history_key(3, 7)
    assert key == "history:3:7", f"history_key(3, 7) is {key!r}, expected history:3:7"
    assert ctx.redis.type(key) == "list", f"{key} is {ctx.redis.type(key)!r}, expected a list (keys: {ctx.redis.keys()})"
    items = ctx.redis.lrange(key, 0, -1)
    assert len(items) == 10, f"{key} holds {len(items)} entries after 12 placements, expected HISTORY_LEN = 10 (LPUSH + LTRIM 0 9)"
    entries = [json.loads(i) for i in items]
    assert [e.get("user") for e in entries] == [f"u{i:02d}" for i in range(11, 1, -1)], f"the list must be newest first and keep the last 10: {[e.get('user') for e in entries]}"
    assert entries[0].get("color") == 11 and entries[0].get("ts") == TS + 11, f"each entry carries user, color and ts: {entries[0]}"
    assert ctx.redis.lrange("history:4:7", 0, -1) and json.loads(ctx.redis.lrange("history:4:7", 0, -1)[0]).get("user") == "zed", "every pixel has its own list"


def check_commit_after(ctx):
    _seed(ctx, "ana")
    ctx.kafka.seed("placements", key="bad", value="not json")
    ctx.kafka.seed("placements", key="bad", value=json.dumps({"user": "ghost"}))
    placement = ctx.kafka.records("placements")[0]
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append((dict(offsets), ctx.redis.zscore(LEADERS, "ana"), ctx.redis.llen("history:3:7"))))
    m = ctx.load("leaderboard")
    ctx.drain(m.run)
    assert at_commit, "no offset was ever committed"
    covering = [(score, hist) for offsets, score, hist in at_commit if offsets.get(("placements", placement.partition), 0) > placement.offset]
    assert covering, "ana's placement was never committed"
    assert covering[0] == (1, 1), f"the commit must come after ZINCRBY and LPUSH: when ana's placement was committed the score was {covering[0][0]!r} and the history held {covering[0][1]} entries"
    assert ctx.kafka.lag("leaderboard", "placements") == 0, "malformed records must be skipped and committed, not left to replay forever"
    assert ctx.redis.zcard(LEADERS) == 1, f"malformed records must not be counted: {ctx.redis.zrange(LEADERS, 0, -1)}"


async def check_endpoints(ctx):
    m = ctx.load("leaderboard")
    ctx.redis.zadd(LEADERS, {f"user{i:02d}": 100 - i for i in range(12)})
    for i in range(3):
        ctx.redis.lpush("history:3:7", json.dumps({"user": f"u{i}", "color": i, "ts": TS + i}))
    async with ctx.client(m.app) as c:
        r = await c.get("/top")
        assert r.status_code == 200, f"GET /top answered {r.status_code}"
        rows = r.json()
        assert isinstance(rows, list) and len(rows) == 10, f"expected the 10 top users, got {rows}"
        assert [row.get("user") for row in rows] == [f"user{i:02d}" for i in range(10)], f"rows must be in descending score order: {[row.get('user') for row in rows]}"
        assert [row.get("tiles") for row in rows] == [100 - i for i in range(10)], f"each row carries the tile count as 'tiles': {rows}"
        r = await c.get("/history", params={"x": 3, "y": 7})
        assert r.status_code == 200, f"GET /history?x=3&y=7 answered {r.status_code}"
        assert [e.get("user") for e in r.json()] == ["u2", "u1", "u0"], f"history must be newest first with user, color and ts: {r.json()}"
        assert r.json()[0] == {"user": "u2", "color": 2, "ts": TS + 2}, f"each entry is the stored document: {r.json()[0]}"
        r = await c.get("/history", params={"x": 0, "y": 0})
        assert r.status_code == 200 and r.json() == [], f"a pixel nobody painted has an empty history, got {r.status_code} {r.text}"
        for bad in ({"x": -1, "y": 0}, {"x": 0, "y": m.SIZE}, {"x": m.SIZE, "y": 0}):
            r = await c.get("/history", params=bad)
            assert r.status_code == 400, f"GET /history with {bad} answered {r.status_code}, expected 400"
`,
    typescript: `const TS = 1700000000000;
const LEADERS = 'place:leaders';

/** placements: [user, x, y, color] tuples, or just user names (one tile each on (3, 7)). */
function seed(ctx, ...placements: (string | [string, number, number, number])[]): void {
  placements.forEach((p, i) => {
    const [user, x, y, color] = typeof p === 'string' ? [p, 3, 7, 12] : p;
    ctx.kafka.seed('placements', {key: \`\${x}:\${y}\`, value: {user, x, y, color, ts: TS + i}});
  });
}

export async function check_consumer(ctx) {
  seed(ctx, 'ana', ['bo', 4, 7, 5]);
  const bo = ctx.kafka.records('placements')[1];
  ctx.redis.set('history:4:7', 'corrupt'); // bo's pixel: the worker's write fails while it handles her tile
  const m = ctx.load('leaderboard');
  await ctx.drain(m.run()).catch(() => undefined); // the worker died on bo's placement; the process is stopped (deploy, SIGTERM)
  const committed = ctx.kafka.committedOffset('leaderboard', 'placements', bo.partition);
  assert(committed === null || committed <= bo.offset, \`bo's placement never reached her pixel's history, yet group leaderboard committed past it (offset \${committed}) by the time the worker stopped: offsets were acknowledged for what was delivered, not for what was processed. Turn auto-commit off and commit after the writes\`);
  ctx.redis.del('history:4:7'); // the fault is repaired and the worker restarts
  await ctx.drain(m.run());
  const history: string[] = ctx.redis.lrange('history:4:7', 0, -1);
  assert(history.length > 0 && JSON.parse(history[0]).user === 'bo', \`after the restart bo's placement must be replayed into history:4:7, which holds \${JSON.stringify(history)}: it was lost\`);
  const lag = ctx.kafka.lag('leaderboard', 'placements');
  assert.equal(lag, 0, \`group leaderboard on placements has \${lag} uncommitted record(s) after the worker processed everything: commit each record once it is counted\`);
}

export async function check_zincrby(ctx) {
  seed(ctx, 'ana', 'bo', ['ana', 4, 7, 1], ['ana', 5, 7, 2], ['cy', 0, 0, 15]);
  const m = ctx.load('leaderboard');
  await ctx.drain(m.run());
  assert.equal(ctx.redis.type(LEADERS), 'zset', \`\${LEADERS} is \${ctx.redis.type(LEADERS)}, expected a sorted set (keys: \${JSON.stringify(ctx.redis.keys('*'))})\`);
  for (const [user, tiles] of [['ana', 3], ['bo', 1], ['cy', 1]] as const) {
    const score = ctx.redis.zscore(LEADERS, user);
    assert.equal(Number(score), tiles, \`\${user} in \${LEADERS} scores \${JSON.stringify(score)}, expected \${tiles}\`);
  }
}

export async function check_history_capped(ctx) {
  const users = Array.from({length: 12}, (_, i) => \`u\${String(i).padStart(2, '0')}\`);
  seed(ctx, ...users.map((u, i): [string, number, number, number] => [u, 3, 7, i % 16]), ['zed', 4, 7, 5]);
  const m = ctx.load('leaderboard');
  await ctx.drain(m.run());
  const key = m.historyKey(3, 7);
  assert.equal(key, 'history:3:7', \`historyKey(3, 7) is \${JSON.stringify(key)}, expected history:3:7\`);
  assert.equal(ctx.redis.type(key), 'list', \`\${key} is \${ctx.redis.type(key)}, expected a list (keys: \${JSON.stringify(ctx.redis.keys('*'))})\`);
  const items: string[] = ctx.redis.lrange(key, 0, -1);
  assert.equal(items.length, 10, \`\${key} holds \${items.length} entries after 12 placements, expected HISTORY_LEN = 10 (LPUSH + LTRIM 0 9)\`);
  const entries = items.map(i => JSON.parse(i));
  assert.deepEqual(entries.map(e => e.user), users.slice(2).reverse(), \`the list must be newest first and keep the last 10: \${JSON.stringify(entries.map(e => e.user))}\`);
  assert(entries[0].color === 11 && entries[0].ts === TS + 11, \`each entry carries user, color and ts: \${JSON.stringify(entries[0])}\`);
  const other: string[] = ctx.redis.lrange('history:4:7', 0, -1);
  assert(other.length > 0 && JSON.parse(other[0]).user === 'zed', 'every pixel has its own list');
}

export async function check_commit_after(ctx) {
  seed(ctx, 'ana');
  ctx.kafka.seed('placements', {key: 'bad', value: 'not json'});
  ctx.kafka.seed('placements', {key: 'bad', value: {user: 'ghost'}});
  const placement = ctx.kafka.records('placements')[0];
  const atCommit: [Record<string, number>, number | null, number][] = [];
  ctx.kafka.onCommit((group: string, offsets: Map<string, number>) => {
    const score = ctx.redis.zscore(LEADERS, 'ana');
    atCommit.push([Object.fromEntries(offsets), score === null ? null : Number(score), ctx.redis.llen('history:3:7')]);
  });
  const m = ctx.load('leaderboard');
  await ctx.drain(m.run());
  assert(atCommit.length > 0, 'no offset was ever committed');
  const covering = atCommit.filter(([offsets]) => (offsets[\`placements|\${placement.partition}\`] ?? 0) > placement.offset).map(([, score, hist]) => [score, hist]);
  assert(covering.length > 0, "ana's placement was never committed");
  assert.deepEqual(covering[0], [1, 1], \`the commit must come after ZINCRBY and LPUSH: when ana's placement was committed the score was \${JSON.stringify(covering[0][0])} and the history held \${covering[0][1]} entries\`);
  assert.equal(ctx.kafka.lag('leaderboard', 'placements'), 0, 'malformed records must be skipped and committed, not left to replay forever');
  assert.equal(ctx.redis.zcard(LEADERS), 1, \`malformed records must not be counted: \${JSON.stringify(ctx.redis.zrange(LEADERS, 0, -1))}\`);
}

export async function check_endpoints(ctx) {
  const m = ctx.load('leaderboard');
  const members = Array.from({length: 12}, (_, i) => [100 - i, \`user\${String(i).padStart(2, '0')}\`]).flat();
  ctx.redis.zadd(LEADERS, ...members);
  for (let i = 0; i < 3; i++) ctx.redis.lpush('history:3:7', JSON.stringify({user: \`u\${i}\`, color: i, ts: TS + i}));
  const c = ctx.client(m.app);
  let r = await c.get('/top');
  assert.equal(r.status, 200, \`GET /top answered \${r.status}\`);
  const rows = r.json();
  assert(Array.isArray(rows) && rows.length === 10, \`expected the 10 top users, got \${JSON.stringify(rows)}\`);
  assert.deepEqual(rows.map(row => row.user), Array.from({length: 10}, (_, i) => \`user\${String(i).padStart(2, '0')}\`), \`rows must be in descending score order: \${JSON.stringify(rows.map(row => row.user))}\`);
  assert.deepEqual(rows.map(row => row.tiles), Array.from({length: 10}, (_, i) => 100 - i), \`each row carries the tile count as 'tiles': \${JSON.stringify(rows)}\`);
  r = await c.get('/history', {query: {x: 3, y: 7}});
  assert.equal(r.status, 200, \`GET /history?x=3&y=7 answered \${r.status}\`);
  assert.deepEqual(r.json().map(e => e.user), ['u2', 'u1', 'u0'], \`history must be newest first with user, color and ts: \${r.text}\`);
  assert.deepEqual(r.json()[0], {user: 'u2', color: 2, ts: TS + 2}, \`each entry is the stored document: \${JSON.stringify(r.json()[0])}\`);
  r = await c.get('/history', {query: {x: 0, y: 0}});
  assert(r.status === 200 && r.json().length === 0, \`a pixel nobody painted has an empty history, got \${r.status} \${r.text}\`);
  for (const bad of [{x: -1, y: 0}, {x: 0, y: m.SIZE}, {x: m.SIZE, y: 0}]) {
    r = await c.get('/history', {query: bad});
    assert.equal(r.status, 400, \`GET /history with \${JSON.stringify(bad)} answered \${r.status}, expected 400\`);
  }
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/segmentio/kafka-go"
	"leetbuild/harness"
)

const (
	ldTS      = 1700000000000
	ldLeaders = "place:leaders"
)

// ldTile is one placement to seed: user on (x, y) with color.
type ldTile struct {
	user        string
	x, y, color int
}

// ldEntry is a history entry as the checks read it.
type ldEntry struct {
	User  string \`json:"user"\`
	Color int    \`json:"color"\`
	Ts    int64  \`json:"ts"\`
}

// ldSeed puts placements on the topic as step 3's producer does; a bare user name is one tile on (3, 7).
func ldSeed(ctx *harness.Ctx, tiles ...ldTile) {
	for i, t := range tiles {
		value, _ := json.Marshal(map[string]any{"user": t.user, "x": t.x, "y": t.y, "color": t.color, "ts": ldTS + i})
		ctx.Kafka.Seed("placements", fmt.Sprintf("%d:%d", t.x, t.y), value)
	}
}

func ldAt37(user string) ldTile { return ldTile{user, 3, 7, 12} }

// ldRun runs the worker until it returns or waits for records that will not come; what it returned.
func ldRun(ctx *harness.Ctx) error {
	var err error
	ctx.Drain(func() { err = run(context.Background()) })
	return err
}

func ldUsers(ctx *harness.Ctx, items []string) []string {
	users := []string{}
	for _, item := range items {
		var e ldEntry
		ctx.NoError(json.Unmarshal([]byte(item), &e), "a history entry is not JSON: %q", item)
		users = append(users, e.User)
	}
	return users
}

func CheckConsumer(ctx *harness.Ctx) {
	ldSeed(ctx, ldAt37("ana"), ldTile{"bo", 4, 7, 5})
	bo := ctx.Kafka.Records("placements")[1]
	ctx.Redis.Set("history:4:7", "corrupt") // bo's pixel: the worker's write fails while it handles her tile
	ldRun(ctx)                              // the worker died on bo's placement
	// The process is stopped (deploy, SIGTERM): its reader leaves the group.
	config := reader.Config()
	reader.Close()
	committed := ctx.Kafka.CommittedOffset("leaderboard", "placements", bo.Partition)
	ctx.Assert(committed == -1 || committed <= bo.Offset, "bo's placement never reached her pixel's history, yet group leaderboard committed past it (offset %d) by the time the worker stopped: offsets were acknowledged for what was delivered, not for what was processed. Fetch, write, then CommitMessages", committed)
	ctx.Redis.Del("history:4:7") // the fault is repaired and the worker restarts
	reader = kafka.NewReader(config)
	ctx.NoError(ldRun(ctx), "run returned an error after the restart")
	history := ctx.Redis.LRange("history:4:7", 0, -1)
	ctx.Assert(len(history) > 0 && ldUsers(ctx, history)[0] == "bo", "after the restart bo's placement must be replayed into history:4:7, which holds %s: it was lost", harness.Show(history))
	lag := ctx.Kafka.Lag("leaderboard", "placements")
	ctx.Assert(lag == 0, "group leaderboard on placements has %d uncommitted record(s) after the worker processed everything: commit each record once it is counted", lag)
}

func CheckZincrby(ctx *harness.Ctx) {
	ldSeed(ctx, ldAt37("ana"), ldAt37("bo"), ldTile{"ana", 4, 7, 1}, ldTile{"ana", 5, 7, 2}, ldTile{"cy", 0, 0, 15})
	ctx.NoError(ldRun(ctx), "run returned an error")
	ctx.Equal(ctx.Redis.Type(ldLeaders), "zset", "%s must be a sorted set (keys: %s): its type", ldLeaders, harness.Show(ctx.Redis.Keys("*")))
	for _, want := range []struct {
		user  string
		tiles int
	}{{"ana", 3}, {"bo", 1}, {"cy", 1}} {
		score, _ := ctx.Redis.ZScore(ldLeaders, want.user)
		ctx.Equal(score, want.tiles, "%s's score in %s", want.user, ldLeaders)
	}
}

func CheckHistoryCapped(ctx *harness.Ctx) {
	tiles := []ldTile{}
	for i := 0; i < 12; i++ {
		tiles = append(tiles, ldTile{fmt.Sprintf("u%02d", i), 3, 7, i % 16})
	}
	ldSeed(ctx, append(tiles, ldTile{"zed", 4, 7, 5})...)
	ctx.NoError(ldRun(ctx), "run returned an error")
	key := historyKey(3, 7)
	ctx.Equal(key, "history:3:7", "historyKey(3, 7)")
	ctx.Equal(ctx.Redis.Type(key), "list", "%s must be a list (keys: %s): its type", key, harness.Show(ctx.Redis.Keys("*")))
	items := ctx.Redis.LRange(key, 0, -1)
	ctx.Assert(len(items) == 10, "%s holds %d entries after 12 placements, expected historyLen = 10 (LPUSH + LTRIM 0 9)", key, len(items))
	want := []string{}
	for i := 11; i > 1; i-- {
		want = append(want, fmt.Sprintf("u%02d", i))
	}
	ctx.Equal(ldUsers(ctx, items), want, "the list must be newest first and keep the last 10: its users")
	var first ldEntry
	ctx.NoError(json.Unmarshal([]byte(items[0]), &first), "a history entry is not JSON")
	ctx.Assert(first.Color == 11 && first.Ts == ldTS+11, "each entry carries user, color and ts: %s", items[0])
	other := ctx.Redis.LRange("history:4:7", 0, -1)
	ctx.Assert(len(other) > 0 && ldUsers(ctx, other)[0] == "zed", "every pixel has its own list")
}

func CheckCommitAfter(ctx *harness.Ctx) {
	ldSeed(ctx, ldAt37("ana"))
	ctx.Kafka.Seed("placements", "bad", "not json")
	ctx.Kafka.Seed("placements", "bad", \`{"user":"ghost"}\`)
	placement := ctx.Kafka.Records("placements")[0]
	type snapshot struct {
		offsets harness.KafkaOffsets
		score   float64
		scored  bool
		history int64
	}
	var atCommit []snapshot
	ctx.Kafka.OnCommit(func(group string, offsets harness.KafkaOffsets) {
		s := snapshot{offsets: harness.KafkaOffsets{}, history: ctx.Redis.LLen("history:3:7")}
		for tp, offset := range offsets {
			s.offsets[tp] = offset
		}
		s.score, s.scored = ctx.Redis.ZScore(ldLeaders, "ana")
		atCommit = append(atCommit, s)
	})
	ctx.NoError(ldRun(ctx), "run returned an error")
	ctx.Assert(len(atCommit) > 0, "no offset was ever committed")
	var covering []snapshot
	for _, s := range atCommit {
		if s.offsets[harness.KafkaTopicPartition{Topic: "placements", Partition: placement.Partition}] > placement.Offset {
			covering = append(covering, s)
		}
	}
	ctx.Assert(len(covering) > 0, "ana's placement was never committed")
	c := covering[0]
	ctx.Assert(c.scored && c.score == 1 && c.history == 1, "the commit must come after ZINCRBY and LPUSH: when ana's placement was committed the score was %v (present: %v) and the history held %d entries", c.score, c.scored, c.history)
	ctx.Equal(ctx.Kafka.Lag("leaderboard", "placements"), 0, "malformed records must be skipped and committed, not left to replay forever: the lag")
	ctx.Assert(ctx.Redis.ZCard(ldLeaders) == 1, "malformed records must not be counted: %v", ctx.Redis.ZRangeWithScores(ldLeaders, 0, -1))
}

func CheckEndpoints(ctx *harness.Ctx) {
	args := []any{"ZADD", ldLeaders}
	for i := 0; i < 12; i++ {
		args = append(args, 100-i, fmt.Sprintf("user%02d", i))
	}
	ctx.Redis.Do(args...)
	for i := 0; i < 3; i++ {
		entry, _ := json.Marshal(ldEntry{User: fmt.Sprintf("u%d", i), Color: i, Ts: ldTS + int64(i)})
		ctx.Redis.Do("LPUSH", "history:3:7", string(entry))
	}
	api := ctx.Main(main).HTTP()
	r := api.Get("/top")
	ctx.Equal(r.Status, 200, "GET /top")
	var rows []map[string]any
	r.Decode(&rows)
	ctx.Assert(len(rows) == 10, "expected the 10 top users, got %s", r.Text())
	users, tiles := []any{}, []any{}
	wantUsers, wantTiles := []any{}, []any{}
	for i, row := range rows {
		users, tiles = append(users, row["user"]), append(tiles, row["tiles"])
		wantUsers, wantTiles = append(wantUsers, fmt.Sprintf("user%02d", i)), append(wantTiles, float64(100-i))
	}
	ctx.Equal(users, wantUsers, "rows must be in descending score order: their users")
	ctx.Equal(tiles, wantTiles, "each row carries the tile count as %q", "tiles")
	r = api.Get("/history?x=3&y=7")
	ctx.Equal(r.Status, 200, "GET /history?x=3&y=7")
	var entries []map[string]any
	r.Decode(&entries)
	got := []any{}
	for _, e := range entries {
		got = append(got, e["user"])
	}
	ctx.Equal(got, []any{"u2", "u1", "u0"}, "history must be newest first with user, color and ts (%s): its users", r.Text())
	ctx.Equal(entries[0], map[string]any{"user": "u2", "color": 2.0, "ts": float64(ldTS + 2)}, "each entry is the stored document")
	r = api.Get("/history?x=0&y=0")
	ctx.Assert(r.Status == 200, "a pixel nobody painted has an empty history, got %d %s", r.Status, r.Text())
	var empty []any
	r.Decode(&empty)
	ctx.Assert(len(empty) == 0, "a pixel nobody painted has an empty history, got %d %s", r.Status, r.Text())
	for _, bad := range []string{"x=-1&y=0", fmt.Sprintf("x=0&y=%d", size), fmt.Sprintf("x=%d&y=0", size)} {
		r = api.Get("/history?" + bad)
		ctx.Equal(r.Status, 400, "GET /history?%s", bad)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

namespace {

constexpr int64_t ldTS = 1700000000000LL;
const std::string ldLeaders = "place:leaders";

// ldTile is one placement to seed: user on (x, y) with color.
struct ldTile {
  std::string user;
  int x, y, color;
};

// ldSeed puts placements on the topic as step 3's producer does.
void ldSeed(harness::Ctx& ctx, const std::vector<ldTile>& tiles) {
  for (size_t i = 0; i < tiles.size(); i++) {
    const auto& t = tiles[i];
    const nlohmann::json value = {{"user", t.user}, {"x", t.x}, {"y", t.y}, {"color", t.color}, {"ts", ldTS + static_cast<int64_t>(i)}};
    ctx.Kafka.Seed("placements", std::to_string(t.x) + ":" + std::to_string(t.y), value.dump());
  }
}

ldTile ldAt37(const std::string& user) { return {user, 3, 7, 12}; }

// ldRun runs the worker until it returns or waits for records that will not come; what it threw
// (Go's run returns an error; the C++ worker's failure is an exception escaping run).
std::optional<std::string> ldRun(harness::Ctx& ctx) {
  // The worker polls with consume(1000): a few idle seconds, then it counts as waiting (Go's reader
  // blocks without a clock).
  ctx.Clock.SetSleepLimit(ctx.Clock.Sleeps() + 5);
  std::optional<std::string> err;
  ctx.Drain([&err] {
    try {
      run();
    } catch (const std::exception& e) {
      err = e.what();
    }
  });
  return err;
}

void ldNoError(harness::Ctx& ctx, const std::optional<std::string>& err, const char* what) {
  if (err) ctx.Fatalf("%s: %s", what, *err);
}

std::vector<std::string> ldUsers(harness::Ctx& ctx, const std::vector<std::string>& items) {
  std::vector<std::string> users;
  for (const auto& item : items) {
    const auto e = nlohmann::json::parse(item, nullptr, false);
    ctx.Assert(e.is_object(), "a history entry is not JSON: %q", item);
    users.push_back(e.value("user", ""));
  }
  return users;
}

}  // namespace

void CheckConsumer(harness::Ctx& ctx) {
  ldSeed(ctx, {ldAt37("ana"), {"bo", 4, 7, 5}});
  const auto bo = ctx.Kafka.Records("placements")[1];
  ctx.Redis.Set("history:4:7", "corrupt");  // bo's pixel: the worker's write fails while it handles her tile
  ldRun(ctx);                               // the worker died on bo's placement
  // The process is stopped (deploy, SIGTERM): its consumer leaves the group.
  consumer->close();
  const int64_t committed = ctx.Kafka.CommittedOffset("leaderboard", "placements", bo.Partition);
  ctx.Assert(committed == -1 || committed <= bo.Offset, "bo's placement never reached her pixel's history, yet group leaderboard committed past it (offset %d) by the time the worker stopped: offsets were acknowledged for what was delivered, not for what was processed. Consume, write, then commit", committed);
  ctx.Redis.Del("history:4:7");  // the fault is repaired and the worker restarts
  consumer = make_consumer();
  ldNoError(ctx, ldRun(ctx), "run threw after the restart");
  const auto history = ctx.Redis.LRange("history:4:7", 0, -1);
  ctx.Assert(!history.empty() && ldUsers(ctx, history)[0] == "bo", "after the restart bo's placement must be replayed into history:4:7, which holds %v: it was lost", history);
  const int64_t lag = ctx.Kafka.Lag("leaderboard", "placements");
  ctx.Assert(lag == 0, "group leaderboard on placements has %d uncommitted record(s) after the worker processed everything: commit each record once it is counted", lag);
}

void CheckZincrby(harness::Ctx& ctx) {
  ldSeed(ctx, {ldAt37("ana"), ldAt37("bo"), {"ana", 4, 7, 1}, {"ana", 5, 7, 2}, {"cy", 0, 0, 15}});
  ldNoError(ctx, ldRun(ctx), "run threw");
  ctx.Equal(ctx.Redis.Type(ldLeaders), "zset", "%s must be a sorted set (keys: %v): its type", ldLeaders, ctx.Redis.Keys("*"));
  for (const auto& [user, tiles] : std::vector<std::pair<std::string, int>>{{"ana", 3}, {"bo", 1}, {"cy", 1}}) {
    const double score = ctx.Redis.ZScore(ldLeaders, user).value_or(0);
    ctx.Equal(score, tiles, "%s's score in %s", user, ldLeaders);
  }
}

void CheckHistoryCapped(harness::Ctx& ctx) {
  std::vector<ldTile> tiles;
  for (int i = 0; i < 12; i++) tiles.push_back({harness::Sprintf("u%02d", i), 3, 7, i % 16});
  tiles.push_back({"zed", 4, 7, 5});
  ldSeed(ctx, tiles);
  ldNoError(ctx, ldRun(ctx), "run threw");
  const std::string key = history_key(3, 7);
  ctx.Equal(key, "history:3:7", "history_key(3, 7)");
  ctx.Equal(ctx.Redis.Type(key), "list", "%s must be a list (keys: %v): its type", key, ctx.Redis.Keys("*"));
  const auto items = ctx.Redis.LRange(key, 0, -1);
  ctx.Assert(items.size() == 10, "%s holds %d entries after 12 placements, expected kHistoryLen = 10 (LPUSH + LTRIM 0 9)", key, items.size());
  std::vector<std::string> want;
  for (int i = 11; i > 1; i--) want.push_back(harness::Sprintf("u%02d", i));
  ctx.Equal(ldUsers(ctx, items), want, "the list must be newest first and keep the last 10: its users");
  const auto first = nlohmann::json::parse(items[0], nullptr, false);
  ctx.Assert(first.is_object(), "a history entry is not JSON");
  ctx.Assert(first.value("color", -1) == 11 && first.value("ts", int64_t{0}) == ldTS + 11, "each entry carries user, color and ts: %s", items[0]);
  const auto other = ctx.Redis.LRange("history:4:7", 0, -1);
  ctx.Assert(!other.empty() && ldUsers(ctx, other)[0] == "zed", "every pixel has its own list");
}

void CheckCommitAfter(harness::Ctx& ctx) {
  ldSeed(ctx, {ldAt37("ana")});
  ctx.Kafka.Seed("placements", "bad", "not json");
  ctx.Kafka.Seed("placements", "bad", R"({"user":"ghost"})");
  const auto placement = ctx.Kafka.Records("placements")[0];
  struct snapshot {
    harness::KafkaOffsets offsets;
    std::optional<double> score;
    long long history;
  };
  std::vector<snapshot> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets& offsets) {
    atCommit.push_back({offsets, ctx.Redis.ZScore(ldLeaders, "ana"), ctx.Redis.LLen("history:3:7")});
  });
  ldNoError(ctx, ldRun(ctx), "run threw");
  ctx.Assert(!atCommit.empty(), "no offset was ever committed");
  std::vector<snapshot> covering;
  for (const auto& s : atCommit) {
    const auto it = s.offsets.find({"placements", placement.Partition});
    if (it != s.offsets.end() && it->second > placement.Offset) covering.push_back(s);
  }
  ctx.Assert(!covering.empty(), "ana's placement was never committed");
  const auto& c = covering[0];
  ctx.Assert(c.score && *c.score == 1 && c.history == 1, "the commit must come after ZINCRBY and LPUSH: when ana's placement was committed the score was %v (present: %v) and the history held %d entries", c.score.value_or(0), c.score.has_value(), c.history);
  ctx.Equal(ctx.Kafka.Lag("leaderboard", "placements"), 0, "malformed records must be skipped and committed, not left to replay forever: the lag");
  ctx.Assert(ctx.Redis.ZCard(ldLeaders) == 1, "malformed records must not be counted: %v", ctx.Redis.ZRangeWithScores(ldLeaders, 0, -1));
}

void CheckEndpoints(harness::Ctx& ctx) {
  std::vector<std::string> args = {"ZADD", ldLeaders};
  for (int i = 0; i < 12; i++) {
    args.push_back(std::to_string(100 - i));
    args.push_back(harness::Sprintf("user%02d", i));
  }
  ctx.Redis.Must(args);
  for (int i = 0; i < 3; i++) {
    const nlohmann::json entry = {{"user", "u" + std::to_string(i)}, {"color", i}, {"ts", ldTS + i}};
    ctx.Redis.Do("LPUSH", "history:3:7", entry.dump());
  }
  auto api = ctx.Main().HTTP();
  auto r = api.Get("/top");
  ctx.Equal(r.Status, 200, "GET /top");
  auto rows = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(rows.is_array() && rows.size() == 10, "expected the 10 top users, got %s", r.Text());
  nlohmann::json users = nlohmann::json::array(), tiles = nlohmann::json::array();
  nlohmann::json wantUsers = nlohmann::json::array(), wantTiles = nlohmann::json::array();
  for (size_t i = 0; i < rows.size(); i++) {
    users.push_back(rows[i].value("user", nlohmann::json()));
    tiles.push_back(rows[i].value("tiles", nlohmann::json()));
    wantUsers.push_back(harness::Sprintf("user%02d", i));
    wantTiles.push_back(100 - static_cast<int>(i));
  }
  ctx.Equal(users, wantUsers, "rows must be in descending score order: their users");
  ctx.Equal(tiles, wantTiles, "each row carries the tile count as %q", "tiles");
  r = api.Get("/history?x=3&y=7");
  ctx.Equal(r.Status, 200, "GET /history?x=3&y=7");
  const auto entries = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(entries.is_array() && !entries.empty(), "history must be newest first with user, color and ts (%s)", r.Text());
  nlohmann::json got = nlohmann::json::array();
  for (const auto& e : entries) got.push_back(e.value("user", nlohmann::json()));
  ctx.Equal(got, nlohmann::json{"u2", "u1", "u0"}, "history must be newest first with user, color and ts (%s): its users", r.Text());
  ctx.Equal(entries[0], nlohmann::json{{"user", "u2"}, {"color", 2}, {"ts", ldTS + 2}}, "each entry is the stored document");
  r = api.Get("/history?x=0&y=0");
  ctx.Assert(r.Status == 200, "a pixel nobody painted has an empty history, got %d %s", r.Status, r.Text());
  const auto empty = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(empty.is_array() && empty.empty(), "a pixel nobody painted has an empty history, got %d %s", r.Status, r.Text());
  for (const std::string bad : {std::string("x=-1&y=0"), "x=0&y=" + std::to_string(kSize), "x=" + std::to_string(kSize) + "&y=0"}) {
    r = api.Get("/history?" + bad);
    ctx.Equal(r.Status, 400, "GET /history?%s", bad);
  }
}
`,
  },
  debrief: `Two read models from one stream. The sorted set is the leaderboard structure — \`ZINCRBY\` keeps it ordered on every write and the top 10 is one O(log n + 10) read, no scan, no sort at query time. The capped list is the history structure — \`LPUSH\` then \`LTRIM 0 9\` is the Redis idiom for "the last N, newest first", bounded memory with no cleanup job, and the per-pixel key is exactly the lookup the hover makes. Both are rebuilt by replaying the topic, so a lost Redis is an inconvenience, not a data loss. Where the commit sits decides the guarantee: process-then-commit is at-least-once, and a scoreboard that is occasionally one too high beats one that is quietly short. Reddit kept the full per-tile details in a wide Cassandra table for the same query and the same reason — the single-tile endpoint was the busiest uncached call they had; a tiny capped list in front of it is what they would have added with a week more.`,
};
