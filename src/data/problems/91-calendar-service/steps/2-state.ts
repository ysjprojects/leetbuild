import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis exception and expansion caches per calendar',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it lists the calendar's events,
expands each one, memoises the expansion and drops the instances the caller has cancelled. It
compiles, it serves the demo, and it hides the production flaws behind one cache key. Review it like
the service owner, fix it, and prove the fix with the checks below.

Implement the expansion and exception cache behind \`GET /v1/calendars/{id}/occurrences\` and
\`POST /v1/calendars/{id}/exceptions\`:

- Expansion slices are cached per **\`(calendar, range, generation)\`**: the key is
  \`exp:{calendar}:{start}:{end}:{generation}\` and nothing else may key an expansion. A slice
  cached by event id has no range and no generation to invalidate, so a modification of one
  instance freezes every range that was ever asked for.
- Every key expires: the slice is written with \`EXPIRE ... EXPANSION_TTL_S\` and the exceptions
  hash with \`EXPIRE ... EXCEPTION_TTL_S\`, so no cache entry outlives the events it was derived
  from.
- The read path resolves the current generation, reads the slice of **that** generation and
  overlays the exceptions hash in the **same atomic step** (one Lua \`EVAL\`): a \`cancelled\`
  instance is never returned, a moved instance serves its overridden start, and the answer stamps
  the generation it was served under.
- Every change bumps the per-calendar generation first (\`INCR gen:{calendar}\`), then drops every
  \`exp:{calendar}:*\` slice of the old generations, then writes the exception — one bump
  invalidates all range slices at once.
- The read path must never mix generations: the generation the script read is the generation the
  answer carries, even when the slice had to be expanded and populated on a miss.

**Failure mode the checks target.** A cache keyed by event id cannot distinguish ranges or
generations, so a modification invalidates nothing; an overlay applied after the expansion has been
read from Redis lets a cancellation land between the two commands, and one reader still ships the
cancelled occurrence; and a key with no TTL serves state that outlives the events it came from.`,
  sequence: {
    participants: ['Calendar client', 'Calendar API', 'Redis', 'Expansion worker'],
    messages: [
      {
        from: 'Calendar client',
        to: 'Calendar API',
        label: 'POST /v1/calendars/{id}/exceptions · instance moved or cancelled',
        kind: 'sync',
      },
      {
        from: 'Calendar API',
        to: 'Redis',
        label: 'INCR gen:{id} · SCAN+DEL exp:{id}:* · HSET exc:{id} · EXPIRE EXCEPTION_TTL_S',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Calendar API', label: 'generation N+1', kind: 'reply'},
      {
        from: 'Calendar client',
        to: 'Calendar API',
        label: 'GET /v1/calendars/{id}/occurrences?start · end',
        kind: 'sync',
      },
      {
        from: 'Calendar API',
        to: 'Redis',
        label: 'EVAL read · gen:{id} · exp:{id}:{start}:{end}:{gen} · exc:{id}',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'Calendar API',
        label: '{generation, occurrences} — cancelled dropped, moved overridden',
        kind: 'reply',
      },
      {
        from: 'Calendar API',
        to: 'Expansion worker',
        label: 'expand(calendar, range) only on a slice miss',
        kind: 'sync',
      },
      {
        from: 'Expansion worker',
        to: 'Redis',
        label: 'HSET exp:{id}:{start}:{end}:{gen} · EXPIRE EXPANSION_TTL_S',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'range-key',
      title: 'Keys slices by (calendar, range, generation)',
      detail:
        'The slice key is built from the calendar, the requested range and the generation (`EXPANSION_KEY` plus `expansion_key(calendar, start, end, generation)`). The draft keys by event id alone, so every range shares one slice and a new generation has nothing to point at.',
      match: {
        python: {all: [/EXPANSION_KEY = "exp:\{calendar\}:\{start\}:\{end\}:\{generation\}"/, /def expansion_key\(/]},
        typescript: {all: [/EXPANSION_KEY = 'exp'/, /function expansionKey\(/, /\$\{generation\}/]},
        go: {all: [/expansionKeyFormat/, /"exp:%s:%s:%s:%s"/, /func expansionKey\(/]},
        scala: {all: [/ExpansionKey = "exp:%s:%s:%s:%s"/, /def expansionKey\(/]},
        cpp: {all: [/kExpansionKeyFormat/, /expansionKey\(/]},
      },
    },
    {
      id: 'generation-sweep',
      title: 'One bump drops every range slice',
      detail:
        'Invalidation is an `INCR` of the per-calendar generation plus a scan/delete across the `exp:{calendar}:*` prefix, so every slice of the old generations dies with one bump. The draft deletes only the single slice it happens to know about.',
      match: {
        python: {all: [/def invalidate_calendar\(/, /\.incr\(/, /scan_iter\(/, /\.delete\(/]},
        typescript: {all: [/function invalidateCalendar\(/, /\.incr\(/, /scanStream\(/, /\.del\(/]},
        go: {all: [/func invalidateCalendar\(/, /\.Incr\(/, /\.Scan\(/, /\.Del\(/]},
        scala: {all: [/def invalidateCalendar\(/, /\.incr\(/, /\.scan\(/, /\.del\(/]},
        cpp: {all: [/invalidateCalendar\(/, /\.incr\(/, /\.scan\(/, /\.del\(/]},
      },
    },
    {
      id: 'atomic-overlay',
      title: 'Overlays exceptions in the same EVAL',
      detail:
        'One Lua `EVAL` reads the generation, the slice of that generation and the exceptions hash, drops `cancelled` instances and lets a moved instance override its start. The draft reads the expansion, then applies the exception in a second command, so a cancellation written mid-read is missed.',
      match: {
        python: {all: [/READ_LUA/, /\.eval\(/, /HGETALL/, /'cancelled'/]},
        typescript: {all: [/READ_LUA/, /\.eval\(/, /HGETALL/, /'cancelled'/]},
        go: {all: [/readScript/, /\.Run\(/, /HGETALL/, /'cancelled'/]},
        scala: {all: [/ReadLua/, /\.eval\(/, /HGETALL/, /'cancelled'/]},
        cpp: {all: [/kReadLua/, /\.eval</, /HGETALL/, /'cancelled'/]},
      },
    },
    {
      id: 'ttl',
      title: 'Expansion and exception keys expire',
      detail:
        'The slice is written with `EXPIRE ... EXPANSION_TTL_S` and the overlay with `EXPIRE ... EXCEPTION_TTL_S`, so no cache entry outlives the change that produced it. The draft sets no expiry at all.',
      match: {
        python: {all: [/EXPANSION_TTL_S/, /EXCEPTION_TTL_S/, /\.expire\(/]},
        typescript: {all: [/EXPANSION_TTL_S/, /EXCEPTION_TTL_S/, /\.expire\(/]},
        go: {all: [/expansionTTLS/, /exceptionTTLS/, /\.Expire\(/]},
        scala: {all: [/ExpansionTtlS/, /ExceptionTtlS/, /\.expire\(/]},
        cpp: {all: [/kExpansionTtlS/, /kExceptionTtlS/, /\.expire\(/]},
      },
    },
    {
      id: 'generation-bump',
      title: 'Bumps the generation before the write',
      detail:
        'Every change `INCR`s the per-calendar generation before the new exception is written, and the read answer carries the generation it was served under. The draft writes the exception with no generation at all, so nothing orders a reader against a writer.',
      match: {
        python: {order: [/\.incr\(/, /\.hset\(/], all: [/"generation": generation/]},
        typescript: {order: [/\.incr\(/, /\.hset\(/], all: [/\{generation, occurrences\}/]},
        go: {order: [/\.Incr\(/, /\.HSet\(/], all: [/"generation": generation/]},
        scala: {order: [/\.incr\(/, /\.hset\(/], all: [/"generation":\$generation/]},
        cpp: {order: [/\.incr\(/, /\.hset\(/], all: [/\{"generation", generation\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, Query
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class EventStore:
    def list_events(self, calendar: str) -> list[dict]:
        """The events whose rules can expand into the requested range."""
        raise NotImplementedError


store = EventStore()


def expand_event(event: dict, start: str, end: str) -> list[dict]:
    """RRULE expansion for one event; instances look like {"instance_id": ..., "start": ...}."""
    raise NotImplementedError


@app.get("/v1/calendars/{calendar}/occurrences")
def read_occurrences(calendar: str, start: str = Query(), end: str = Query()) -> dict:
    # TODO: this draft caches each event's expansion by event id with no range bounds and no
    # generation, filters the exceptions in a separate command after the expansion is read, and
    # never expires anything. Review all four.
    occurrences: list[dict] = []
    for event in store.list_events(calendar):
        key = f"expansion:{event['id']}"
        cached = r.get(key)
        if cached is None:
            cached = json.dumps(expand_event(event, start, end))
            r.set(key, cached)
        occurrences.extend(json.loads(cached))
    exceptions = r.hgetall(f"exceptions:{calendar}")
    return {"occurrences": [o for o in occurrences if o["instance_id"] not in exceptions]}


class ExceptionBody(BaseModel):
    instance_id: str
    event_id: str
    status: str
    new_start: str | None = None


@app.post("/v1/calendars/{calendar}/exceptions")
def apply_exception(calendar: str, body: ExceptionBody) -> dict:
    r.delete(f"expansion:{body.event_id}")
    r.hset(f"exceptions:{calendar}", body.instance_id, body.status)
    return {"ok": True}
`,
      solution: `import redis
from fastapi import FastAPI, Query
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

EXPANSION_KEY = "exp:{calendar}:{start}:{end}:{generation}"
EXCEPTION_KEY = "exc:{calendar}"
GENERATION_KEY = "gen:{calendar}"
EXPANSION_TTL_S = 600
EXCEPTION_TTL_S = 900

READ_LUA = """
local generation = redis.call('GET', KEYS[1]) or '0'
local expansion = ARGV[1] .. generation
local out = {generation, redis.call('EXISTS', expansion)}
local occurrences = redis.call('HGETALL', expansion)
local exceptions = redis.call('HGETALL', KEYS[2])
local overlay = {}
for i = 1, #exceptions, 2 do
  overlay[exceptions[i]] = exceptions[i + 1]
end
for i = 1, #occurrences, 2 do
  local state = overlay[occurrences[i]]
  if state ~= 'cancelled' then
    out[#out + 1] = occurrences[i]
    out[#out + 1] = state or occurrences[i + 1]
  end
end
return out
"""


class EventStore:
    def list_events(self, calendar: str) -> list[dict]:
        """The events whose rules can expand into the requested range."""
        raise NotImplementedError


store = EventStore()


def expand_events(events: list[dict], start: str, end: str) -> list[dict]:
    """RRULE expansion; instances look like {"instance_id": ..., "start": ...}."""
    raise NotImplementedError


def expansion_key(calendar: str, start: str, end: str, generation: str) -> str:
    return EXPANSION_KEY.format(calendar=calendar, start=start, end=end, generation=generation)


def exception_key(calendar: str) -> str:
    return EXCEPTION_KEY.format(calendar=calendar)


def generation_key(calendar: str) -> str:
    return GENERATION_KEY.format(calendar=calendar)


def populate_expansion(calendar: str, start: str, end: str, generation: str, occurrences: list[dict]) -> None:
    key = expansion_key(calendar, start, end, generation)
    if occurrences:
        r.hset(key, mapping={o["instance_id"]: o["start"] for o in occurrences})
    r.expire(key, EXPANSION_TTL_S)


def invalidate_calendar(calendar: str) -> str:
    generation = str(r.incr(generation_key(calendar)))
    for key in r.scan_iter(match=f"exp:{calendar}:*", count=100):
        r.delete(key)
    return generation


def read_once(calendar: str, start: str, end: str) -> tuple[str, bool, list[str]]:
    prefix = EXPANSION_KEY.format(calendar=calendar, start=start, end=end, generation="")
    reply = r.eval(READ_LUA, 2, generation_key(calendar), exception_key(calendar), prefix)
    return str(reply[0]), bool(reply[1]), list(reply[2:])


@app.get("/v1/calendars/{calendar}/occurrences")
def read_occurrences(calendar: str, start: str = Query(), end: str = Query()) -> dict:
    generation, exists, items = read_once(calendar, start, end)
    if not exists:
        populate_expansion(calendar, start, end, generation, expand_events(store.list_events(calendar), start, end))
        generation, _, items = read_once(calendar, start, end)
    occurrences = [{"instance_id": items[i], "start": items[i + 1]} for i in range(0, len(items), 2)]
    return {"generation": generation, "occurrences": occurrences}


class ExceptionBody(BaseModel):
    instance_id: str
    status: str
    new_start: str | None = None


@app.post("/v1/calendars/{calendar}/exceptions")
def apply_exception(calendar: str, body: ExceptionBody) -> dict:
    state = body.new_start if body.status == "moved" and body.new_start else "cancelled"
    generation = invalidate_calendar(calendar)
    key = exception_key(calendar)
    r.hset(key, body.instance_id, state)
    r.expire(key, EXCEPTION_TTL_S)
    return {"generation": generation}
`,
    },
    typescript: {
      starter: `/** GET occurrences + POST exceptions: a model-generated draft that caches by event id. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface Occurrence {
  instance_id: string;
  start: string;
}

const store = {
  async listEvents(calendar: string): Promise<Array<{id: string; rrule: string}>> {
    throw new Error('not implemented');
  },
};

async function expandEvent(event: {id: string; rrule: string}, from: string, to: string): Promise<Occurrence[]> {
  throw new Error('not implemented');
}

app.get('/v1/calendars/:calendar/occurrences', async (request, reply) => {
  const {calendar} = request.params as {calendar: string};
  const {start, end} = request.query as {start: string; end: string};
  // TODO: this draft caches each event's expansion by event id with no range bounds and no
  // generation, filters the exceptions in a separate command after the expansion is read, and
  // never expires anything. Review all four.
  const occurrences: Occurrence[] = [];
  for (const event of await store.listEvents(calendar)) {
    const key = \`expansion:\${event.id}\`;
    const cached = await r.get(key);
    if (cached === null) {
      const expanded = await expandEvent(event, start, end);
      await r.set(key, JSON.stringify(expanded));
      occurrences.push(...expanded);
    } else {
      occurrences.push(...(JSON.parse(cached) as Occurrence[]));
    }
  }
  const exceptions = await r.hgetall(\`exceptions:\${calendar}\`);
  return reply.code(200).send({occurrences: occurrences.filter(o => exceptions[o.instance_id] === undefined)});
});

app.post('/v1/calendars/:calendar/exceptions', async (request, reply) => {
  const {calendar} = request.params as {calendar: string};
  const body = request.body as {instance_id: string; event_id: string; status: string};
  await r.del(\`expansion:\${body.event_id}\`);
  await r.hset(\`exceptions:\${calendar}\`, body.instance_id, body.status);
  return reply.code(200).send({ok: true});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET occurrences + POST exceptions: one generation, one atomic overlay, expiring slices. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const EXPANSION_KEY = 'exp';
const EXCEPTION_KEY = 'exc';
const GENERATION_KEY = 'gen';
const EXPANSION_TTL_S = 600;
const EXCEPTION_TTL_S = 900;

const READ_LUA = \`
local generation = redis.call('GET', KEYS[1]) or '0'
local expansion = ARGV[1] .. generation
local out = {generation, redis.call('EXISTS', expansion)}
local occurrences = redis.call('HGETALL', expansion)
local exceptions = redis.call('HGETALL', KEYS[2])
local overlay = {}
for i = 1, #exceptions, 2 do
  overlay[exceptions[i]] = exceptions[i + 1]
end
for i = 1, #occurrences, 2 do
  local state = overlay[occurrences[i]]
  if state ~= 'cancelled' then
    out[#out + 1] = occurrences[i]
    out[#out + 1] = state or occurrences[i + 1]
  end
end
return out
\`;

interface Occurrence {
  instance_id: string;
  start: string;
}

const store = {
  async listEvents(calendar: string): Promise<Array<{id: string; rrule: string}>> {
    throw new Error('not implemented');
  },
};

async function expandEvents(
  events: Array<{id: string; rrule: string}>,
  from: string,
  to: string,
): Promise<Occurrence[]> {
  throw new Error('not implemented');
}

function expansionKey(calendar: string, from: string, to: string, generation: string): string {
  return \`\${EXPANSION_KEY}:\${calendar}:\${from}:\${to}:\${generation}\`;
}

function exceptionKey(calendar: string): string {
  return \`\${EXCEPTION_KEY}:\${calendar}\`;
}

function generationKey(calendar: string): string {
  return \`\${GENERATION_KEY}:\${calendar}\`;
}

async function populateExpansion(
  calendar: string,
  from: string,
  to: string,
  generation: string,
  occurrences: Occurrence[],
): Promise<void> {
  const key = expansionKey(calendar, from, to, generation);
  if (occurrences.length > 0) {
    await r.hset(key, ...occurrences.flatMap(o => [o.instance_id, o.start]));
  }
  await r.expire(key, EXPANSION_TTL_S);
}

async function invalidateCalendar(calendar: string): Promise<string> {
  const generation = String(await r.incr(generationKey(calendar)));
  for await (const batch of r.scanStream({match: \`exp:\${calendar}:*\`, count: 100})) {
    if (batch.length > 0) await r.del(...batch);
  }
  return generation;
}

async function readOnce(calendar: string, from: string, to: string): Promise<[string, boolean, string[]]> {
  const prefix = \`\${EXPANSION_KEY}:\${calendar}:\${from}:\${to}:\`;
  const reply = (await r.eval(READ_LUA, 2, generationKey(calendar), exceptionKey(calendar), prefix)) as string[];
  return [String(reply[0]), Number(reply[1]) === 1, reply.slice(2)];
}

app.get('/v1/calendars/:calendar/occurrences', async (request, reply) => {
  const {calendar} = request.params as {calendar: string};
  const {start, end} = request.query as {start: string; end: string};
  let [generation, exists, items] = await readOnce(calendar, start, end);
  if (!exists) {
    await populateExpansion(
      calendar,
      start,
      end,
      generation,
      await expandEvents(await store.listEvents(calendar), start, end),
    );
    [generation, , items] = await readOnce(calendar, start, end);
  }
  const occurrences: Occurrence[] = [];
  for (let i = 0; i < items.length; i += 2) occurrences.push({instance_id: items[i], start: items[i + 1]});
  return reply.code(200).send({generation, occurrences});
});

app.post('/v1/calendars/:calendar/exceptions', async (request, reply) => {
  const {calendar} = request.params as {calendar: string};
  const body = request.body as {instance_id: string; status: string; new_start?: string};
  const state = body.status === 'moved' && body.new_start !== undefined ? body.new_start : 'cancelled';
  const generation = await invalidateCalendar(calendar);
  const key = exceptionKey(calendar);
  await r.hset(key, body.instance_id, state);
  await r.expire(key, EXCEPTION_TTL_S);
  return reply.code(200).send({generation});
});

void app.listen({port: 8443, host: '0.0.0.0'});
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

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type occurrence struct {
	InstanceID string \`json:"instance_id"\`
	Start      string \`json:"start"\`
}

type store struct{}

func (s *store) listEvents(ctx context.Context, calendar string) ([]string, error) {
	return nil, nil
}

func expandEvent(event string, from, to string) ([]occurrence, error) {
	return nil, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readOccurrences(rw http.ResponseWriter, r *http.Request) {
	calendar := r.PathValue("calendar")
	from := r.URL.Query().Get("start")
	to := r.URL.Query().Get("end")
	ctx := r.Context()
	// TODO: this draft caches each event's expansion by event id with no range bounds and no
	// generation, filters the exceptions in a separate command after the expansion is read, and
	// never expires anything. Review all four.
	events, _ := (&store{}).listEvents(ctx, calendar)
	occurrences := []occurrence{}
	for _, event := range events {
		key := fmt.Sprintf("expansion:%s", event)
		cached, err := rdb.Get(ctx, key).Result()
		if err == redis.Nil {
			expanded, _ := expandEvent(event, from, to)
			raw, _ := json.Marshal(expanded)
			rdb.Set(ctx, key, raw, 0)
			occurrences = append(occurrences, expanded...)
			continue
		}
		var parsed []occurrence
		_ = json.Unmarshal([]byte(cached), &parsed)
		occurrences = append(occurrences, parsed...)
	}
	exceptions, _ := rdb.HGetAll(ctx, fmt.Sprintf("exceptions:%s", calendar)).Result()
	visible := []occurrence{}
	for _, occurrence := range occurrences {
		if _, overridden := exceptions[occurrence.InstanceID]; !overridden {
			visible = append(visible, occurrence)
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{"occurrences": visible})
}

func applyException(rw http.ResponseWriter, r *http.Request) {
	calendar := r.PathValue("calendar")
	body := struct {
		InstanceID string \`json:"instance_id"\`
		EventID    string \`json:"event_id"\`
		Status     string \`json:"status"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	ctx := r.Context()
	rdb.Del(ctx, fmt.Sprintf("expansion:%s", body.EventID))
	rdb.HSet(ctx, fmt.Sprintf("exceptions:%s", calendar), body.InstanceID, body.Status)
	writeJSON(rw, http.StatusOK, map[string]any{"ok": true})
}

func main() {
	rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/calendars/{calendar}/occurrences", readOccurrences)
	mux.HandleFunc("POST /v1/calendars/{calendar}/exceptions", applyException)
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
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	expansionKeyFormat  = "exp:%s:%s:%s:%s"
	exceptionKeyFormat  = "exc:%s"
	generationKeyFormat = "gen:%s"
	expansionTTLS       = 600
	exceptionTTLS       = 900
)

var rdb *redis.Client

var readScript = redis.NewScript(\`
local generation = redis.call('GET', KEYS[1]) or '0'
local expansion = ARGV[1] .. generation
local out = {generation, redis.call('EXISTS', expansion)}
local occurrences = redis.call('HGETALL', expansion)
local exceptions = redis.call('HGETALL', KEYS[2])
local overlay = {}
for i = 1, #exceptions, 2 do
  overlay[exceptions[i]] = exceptions[i + 1]
end
for i = 1, #occurrences, 2 do
  local state = overlay[occurrences[i]]
  if state ~= 'cancelled' then
    out[#out + 1] = occurrences[i]
    out[#out + 1] = state or occurrences[i + 1]
  end
end
return out
\`)

type occurrence struct {
	InstanceID string \`json:"instance_id"\`
	Start      string \`json:"start"\`
}

type store struct{}

func (s *store) listEvents(ctx context.Context, calendar string) ([]string, error) {
	return nil, nil
}

func expandEvents(events []string, from, to string) ([]occurrence, error) {
	return nil, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func expansionKey(calendar, from, to, generation string) string {
	return fmt.Sprintf(expansionKeyFormat, calendar, from, to, generation)
}

func exceptionKey(calendar string) string {
	return fmt.Sprintf(exceptionKeyFormat, calendar)
}

func generationKey(calendar string) string {
	return fmt.Sprintf(generationKeyFormat, calendar)
}

func invalidateCalendar(ctx context.Context, calendar string) (string, error) {
	generation, err := rdb.Incr(ctx, generationKey(calendar)).Result()
	if err != nil {
		return "", err
	}
	var cursor uint64
	for {
		keys, next, scanErr := rdb.Scan(ctx, cursor, fmt.Sprintf("exp:%s:*", calendar), 100).Result()
		if scanErr != nil {
			return "", scanErr
		}
		if len(keys) > 0 {
			rdb.Del(ctx, keys...)
		}
		if cursor = next; cursor == 0 {
			break
		}
	}
	return fmt.Sprintf("%d", generation), nil
}

func readOnce(ctx context.Context, calendar, from, to string) (string, bool, []string) {
	prefix := fmt.Sprintf("exp:%s:%s:%s:", calendar, from, to)
	reply, err := readScript.Run(ctx, rdb, []string{generationKey(calendar), exceptionKey(calendar)}, prefix).StringSlice()
	if err != nil {
		panic(err)
	}
	return reply[0], reply[1] == "1", reply[2:]
}

func readOccurrences(rw http.ResponseWriter, r *http.Request) {
	calendar := r.PathValue("calendar")
	from := r.URL.Query().Get("start")
	to := r.URL.Query().Get("end")
	ctx := r.Context()
	generation, exists, items := readOnce(ctx, calendar, from, to)
	if !exists {
		events, _ := (&store{}).listEvents(ctx, calendar)
		expanded, _ := expandEvents(events, from, to)
		key := expansionKey(calendar, from, to, generation)
		fields := make(map[string]any, len(expanded))
		for _, occurrence := range expanded {
			fields[occurrence.InstanceID] = occurrence.Start
		}
		if len(fields) > 0 {
			rdb.HSet(ctx, key, fields)
		}
		rdb.Expire(ctx, key, expansionTTLS*time.Second)
		generation, _, items = readOnce(ctx, calendar, from, to)
	}
	occurrences := []occurrence{}
	for i := 0; i+1 < len(items); i += 2 {
		occurrences = append(occurrences, occurrence{InstanceID: items[i], Start: items[i+1]})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"generation": generation, "occurrences": occurrences})
}

func applyException(rw http.ResponseWriter, r *http.Request) {
	calendar := r.PathValue("calendar")
	body := struct {
		InstanceID string \`json:"instance_id"\`
		Status     string \`json:"status"\`
		NewStart   string \`json:"new_start"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	ctx := r.Context()
	state := "cancelled"
	if body.Status == "moved" && body.NewStart != "" {
		state = body.NewStart
	}
	generation, err := invalidateCalendar(ctx, calendar)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	key := exceptionKey(calendar)
	rdb.HSet(ctx, key, body.InstanceID, state)
	rdb.Expire(ctx, key, exceptionTTLS*time.Second)
	writeJSON(rw, http.StatusOK, map[string]any{"generation": generation})
}

func main() {
	rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/calendars/{calendar}/occurrences", readOccurrences)
	mux.HandleFunc("POST /v1/calendars/{calendar}/exceptions", applyException)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import scala.jdk.CollectionConverters._

final case class Occurrence(instance_id: String, start: String)
final case class OccurrencesResponse(occurrences: List[Occurrence])
final case class ExceptionRequest(instance_id: String, event_id: String, status: String)

object StateApi {
  implicit val system: ActorSystem = ActorSystem("calendard")
  implicit val occurrenceFormat: RootJsonFormat[Occurrence] = jsonFormat2(Occurrence)
  implicit val responseFormat: RootJsonFormat[OccurrencesResponse] = jsonFormat1(OccurrencesResponse)
  implicit val exceptionFormat: RootJsonFormat[ExceptionRequest] = jsonFormat3(ExceptionRequest)

  val jedis = new Jedis("redis", 6379)

  val events = List("standup", "review")

  def expandEvent(event: String, from: String, to: String): List[Occurrence] = Nil

  // TODO: this draft caches each event's expansion by event id with no range bounds and no
  // generation, filters the exceptions in a separate command after the expansion is read, and
  // never expires anything. Review all four.
  val route: Route =
    path("v1" / "calendars" / Segment / "occurrences") { calendar =>
      get {
        parameters("start", "end") { (from, to) =>
          val occurrences = events.flatMap { event =>
            val key = s"expansion:$event"
            if (!jedis.exists(key)) {
              val expanded = expandEvent(event, from, to)
              if (expanded.nonEmpty) jedis.hset(key, expanded.map(o => o.instance_id -> o.start).toMap.asJava)
            }
            jedis.hgetAll(key).asScala.toList.map { case (instanceId, start) => Occurrence(instanceId, start) }
          }
          val exceptions = jedis.hgetAll(s"exceptions:$calendar").asScala.keySet
          complete(StatusCodes.OK, OccurrencesResponse(occurrences.filterNot(o => exceptions.contains(o.instance_id))))
        }
      }
    } ~
      path("v1" / "calendars" / Segment / "exceptions") { calendar =>
        post {
          entity(as[ExceptionRequest]) { body =>
            jedis.del(s"expansion:\${body.event_id}")
            jedis.hset(s"exceptions:$calendar", body.instance_id, body.status)
            complete(StatusCodes.OK, """{"ok":true}""")
          }
        }
      }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.ScanParams
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import scala.jdk.CollectionConverters._

final case class Occurrence(instance_id: String, start: String)
final case class ExceptionRequest(instance_id: String, status: String, new_start: Option[String])

object StateApi {
  implicit val system: ActorSystem = ActorSystem("calendard")
  implicit val occurrenceFormat: RootJsonFormat[Occurrence] = jsonFormat2(Occurrence)
  implicit val exceptionFormat: RootJsonFormat[ExceptionRequest] = jsonFormat3(ExceptionRequest)

  val ExpansionKey = "exp:%s:%s:%s:%s"
  val ExceptionKey = "exc:%s"
  val GenerationKey = "gen:%s"
  val ExpansionTtlS = 600L
  val ExceptionTtlS = 900L

  val jedis = new Jedis("redis", 6379)

  val ReadLua =
    """
      |local generation = redis.call('GET', KEYS[1]) or '0'
      |local expansion = ARGV[1] .. generation
      |local out = {generation, redis.call('EXISTS', expansion)}
      |local occurrences = redis.call('HGETALL', expansion)
      |local exceptions = redis.call('HGETALL', KEYS[2])
      |local overlay = {}
      |for i = 1, #exceptions, 2 do
      |  overlay[exceptions[i]] = exceptions[i + 1]
      |end
      |for i = 1, #occurrences, 2 do
      |  local state = overlay[occurrences[i]]
      |  if state ~= 'cancelled' then
      |    out[#out + 1] = occurrences[i]
      |    out[#out + 1] = state or occurrences[i + 1]
      |  end
      |end
      |return out
      |""".stripMargin

  val events = List("standup", "review")

  def expandEvents(events: List[String], from: String, to: String): List[Occurrence] = Nil

  def expansionKey(calendar: String, from: String, to: String, generation: Long): String =
    ExpansionKey.format(calendar, from, to, generation.toString)

  def exceptionKey(calendar: String): String = ExceptionKey.format(calendar)

  def generationKey(calendar: String): String = GenerationKey.format(calendar)

  def populateExpansion(calendar: String, from: String, to: String, generation: Long): Unit = {
    val key = expansionKey(calendar, from, to, generation)
    val occurrences = expandEvents(events, from, to)
    if (occurrences.nonEmpty) jedis.hset(key, occurrences.map(o => o.instance_id -> o.start).toMap.asJava)
    jedis.expire(key, ExpansionTtlS)
  }

  def invalidateCalendar(calendar: String): Long = {
    val generation = jedis.incr(generationKey(calendar))
    var cursor = "0"
    val params = new ScanParams().match("exp:" + calendar + ":*").count(100)
    do {
      val result = jedis.scan(cursor, params)
      val keys = result.getResult.asScala.toList
      if (keys.nonEmpty) jedis.del(keys: _*)
      cursor = result.getCursor
    } while (cursor != "0")
    generation
  }

  def readOnce(calendar: String, from: String, to: String): (String, Boolean, List[String]) = {
    val prefix = ExpansionKey.format(calendar, from, to, "")
    val reply = jedis
      .eval(ReadLua, 2, generationKey(calendar), exceptionKey(calendar), prefix)
      .asInstanceOf[java.util.List[String]]
      .asScala
      .toList
    (reply.head, reply(1) == "1", reply.drop(2))
  }

  val route: Route =
    path("v1" / "calendars" / Segment / "occurrences") { calendar =>
      get {
        parameters("start", "end") { (from, to) =>
          val (firstGeneration, exists, firstItems) = readOnce(calendar, from, to)
          val (generation, items) =
            if (exists) {
              (firstGeneration, firstItems)
            } else {
              populateExpansion(calendar, from, to, firstGeneration.toLong)
              val reread = readOnce(calendar, from, to)
              (reread._1, reread._3)
            }
          val occurrences =
            items.grouped(2).collect { case List(instanceId, start) => Occurrence(instanceId, start) }.toList
          val rendered = occurrences.map(o => s"""{"instance_id":"\${o.instance_id}","start":"\${o.start}"}""").mkString(",")
          complete(
            StatusCodes.OK,
            HttpEntity(ContentTypes.\`application/json\`, s"""{"generation":$generation,"occurrences":[$rendered]}""")
          )
        }
      }
    } ~
      path("v1" / "calendars" / Segment / "exceptions") { calendar =>
        post {
          entity(as[ExceptionRequest]) { body =>
            val state = if (body.status == "moved") body.new_start.getOrElse("cancelled") else "cancelled"
            val generation = invalidateCalendar(calendar)
            jedis.hset(exceptionKey(calendar), body.instance_id, state)
            jedis.expire(exceptionKey(calendar), ExceptionTtlS)
            complete(StatusCodes.OK, s"""{"generation":$generation}""")
          }
        }
      }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

using json = nlohmann::json;

struct EventStore {
  std::vector<std::string> listEvents(const std::string& calendar);
};

EventStore store;

std::vector<std::pair<std::string, std::string>> expandEvent(const std::string& event, const std::string& from,
                                                             const std::string& to);

std::string encodeOccurrences(const std::vector<std::pair<std::string, std::string>>& occurrences) {
  json encoded = json::array();
  for (const auto& [instanceId, start] : occurrences) {
    encoded.push_back({{"instance_id", instanceId}, {"start", start}});
  }
  return encoded.dump();
}

std::vector<std::pair<std::string, std::string>> decodeOccurrences(const std::string& raw) {
  std::vector<std::pair<std::string, std::string>> occurrences;
  for (const auto& entry : json::parse(raw, nullptr, false)) {
    occurrences.emplace_back(entry["instance_id"].get<std::string>(), entry["start"].get<std::string>());
  }
  return occurrences;
}

void writeJSON(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/v1/calendars/([^/]+)/occurrences)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto calendar = req.matches[1].str();
    const auto from = req.get_param_value("start");
    const auto to = req.get_param_value("end");
    // TODO: this draft caches each event's expansion by event id with no range bounds and no
    // generation, filters the exceptions in a separate command after the expansion is read, and
    // never expires anything. Review all four.
    json occurrences = json::array();
    for (const auto& event : store.listEvents(calendar)) {
      const auto key = "expansion:" + event;
      auto cached = redis.get(key);
      std::vector<std::pair<std::string, std::string>> expanded;
      if (cached) {
        expanded = decodeOccurrences(*cached);
      } else {
        expanded = expandEvent(event, from, to);
        redis.set(key, encodeOccurrences(expanded));
      }
      for (const auto& [instanceId, start] : expanded) {
        occurrences.push_back({{"instance_id", instanceId}, {"start", start}});
      }
    }
    std::unordered_map<std::string, std::string> exceptions;
    redis.hgetall("exceptions:" + calendar, std::inserter(exceptions, exceptions.end()));
    json visible = json::array();
    for (const auto& occurrence : occurrences) {
      const auto instanceId = occurrence["instance_id"].get<std::string>();
      if (exceptions.count(instanceId) == 0) visible.push_back(occurrence);
    }
    writeJSON(res, 200, json{{"occurrences", visible}});
  });

  svr.Post(R"(/v1/calendars/([^/]+)/exceptions)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto calendar = req.matches[1].str();
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      writeJSON(res, 400, json{{"error", "invalid json"}});
      return;
    }
    redis.del("expansion:" + body.value("event_id", std::string()));
    redis.hset("exceptions:" + calendar, body.value("instance_id", std::string()), body.value("status", std::string()));
    writeJSON(res, 200, json{{"ok", true}});
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <cstdio>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

const std::string kExpansionKeyFormat = "exp:%s:%s:%s:%s";
const std::string kExceptionKeyFormat = "exc:%s";
const std::string kGenerationKeyFormat = "gen:%s";
constexpr long long kExpansionTtlS = 600;
constexpr long long kExceptionTtlS = 900;

const char* kReadLua = R"LUA(
local generation = redis.call('GET', KEYS[1]) or '0'
local expansion = ARGV[1] .. generation
local out = {generation, redis.call('EXISTS', expansion)}
local occurrences = redis.call('HGETALL', expansion)
local exceptions = redis.call('HGETALL', KEYS[2])
local overlay = {}
for i = 1, #exceptions, 2 do
  overlay[exceptions[i]] = exceptions[i + 1]
end
for i = 1, #occurrences, 2 do
  local state = overlay[occurrences[i]]
  if state ~= 'cancelled' then
    out[#out + 1] = occurrences[i]
    out[#out + 1] = state or occurrences[i + 1]
  end
end
return out
)LUA";

struct EventStore {
  std::vector<std::string> listEvents(const std::string& calendar);
};

EventStore store;

std::vector<std::pair<std::string, std::string>> expandEvents(const std::vector<std::string>& events,
                                                              const std::string& from, const std::string& to);

std::string expansionKey(const std::string& calendar, const std::string& from, const std::string& to,
                         const std::string& generation) {
  char buffer[512];
  std::snprintf(buffer, sizeof(buffer), kExpansionKeyFormat.c_str(), calendar.c_str(), from.c_str(), to.c_str(),
                generation.c_str());
  return buffer;
}

std::string exceptionKey(const std::string& calendar) {
  char buffer[256];
  std::snprintf(buffer, sizeof(buffer), kExceptionKeyFormat.c_str(), calendar.c_str());
  return buffer;
}

std::string generationKey(const std::string& calendar) {
  char buffer[256];
  std::snprintf(buffer, sizeof(buffer), kGenerationKeyFormat.c_str(), calendar.c_str());
  return buffer;
}

void populateExpansion(sw::redis::Redis& redis, const std::string& calendar, const std::string& from,
                       const std::string& to, const std::string& generation,
                       const std::vector<std::pair<std::string, std::string>>& occurrences) {
  const auto key = expansionKey(calendar, from, to, generation);
  if (!occurrences.empty()) {
    redis.hset(key, occurrences.begin(), occurrences.end());
  }
  redis.expire(key, kExpansionTtlS);
}

std::string invalidateCalendar(sw::redis::Redis& redis, const std::string& calendar) {
  const auto generation = std::to_string(redis.incr(generationKey(calendar)));
  long long cursor = 0;
  do {
    std::vector<std::string> keys;
    cursor = redis.scan(cursor, "exp:" + calendar + ":*", 100, std::back_inserter(keys));
    if (!keys.empty()) {
      redis.del(keys.begin(), keys.end());
    }
  } while (cursor != 0);
  return generation;
}

void writeJSON(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/v1/calendars/([^/]+)/occurrences)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto calendar = req.matches[1].str();
    const auto from = req.get_param_value("start");
    const auto to = req.get_param_value("end");
    const auto prefix = "exp:" + calendar + ":" + from + ":" + to + ":";
    const auto readOnce = [&](std::string& generation, bool& exists, std::vector<std::string>& items) {
      const auto reply =
          redis.eval<std::vector<std::string>>(kReadLua, {generationKey(calendar), exceptionKey(calendar)}, {prefix});
      generation = reply[0];
      exists = reply[1] == "1";
      items.assign(reply.begin() + 2, reply.end());
    };
    std::string generation;
    bool exists = false;
    std::vector<std::string> items;
    readOnce(generation, exists, items);
    if (!exists) {
      populateExpansion(redis, calendar, from, to, generation, expandEvents(store.listEvents(calendar), from, to));
      readOnce(generation, exists, items);
    }
    json occurrences = json::array();
    for (std::size_t i = 0; i + 1 < items.size(); i += 2) {
      occurrences.push_back({{"instance_id", items[i]}, {"start", items[i + 1]}});
    }
    writeJSON(res, 200, json{{"generation", generation}, {"occurrences", occurrences}});
  });

  svr.Post(R"(/v1/calendars/([^/]+)/exceptions)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto calendar = req.matches[1].str();
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("instance_id")) {
      writeJSON(res, 400, json{{"error", "instance_id is required"}});
      return;
    }
    const auto status = body.value("status", std::string("cancelled"));
    const std::string state =
        status == "moved" ? body.value("new_start", std::string("cancelled")) : std::string("cancelled");
    const auto generation = invalidateCalendar(redis, calendar);
    redis.hset(exceptionKey(calendar), body["instance_id"].get<std::string>(), state);
    redis.expire(exceptionKey(calendar), kExceptionTtlS);
    writeJSON(res, 200, json{{"generation", generation}});
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Start with the key: one expansion slice belongs to `(calendar, start, end, generation)` — `exp:{calendar}:{start}:{end}:{generation}`. If the key is the event id, two ranges share one slice and a new generation has nothing to point at.',
    'Do the overlay where the generation is read: one Lua script that `GET`s `gen:{calendar}`, `HGETALL`s the slice of that generation and `HGETALL`s the exceptions hash, drops `cancelled` instances and lets a moved one override its start. A separate `HGETALL` after the expansion read is exactly the race this step is about.',
    'Close the write path: `INCR` the generation, sweep `exp:{calendar}:*`, then write the exception — and expire both the slice (`EXPANSION_TTL_S`) and the overlay (`EXCEPTION_TTL_S`). A cache without a TTL keeps serving a generation that no longer exists.',
  ],
  debrief: `The interview question behind this step is cache invalidation with a generation stamp. A cached expansion is only as good as the key that names it: per (calendar, range, generation) means one counter bump makes every slice of the old generation unreachable and the sweep reclaims them, while per-event keys silently freeze every range that was ever asked for. The second piece is the overlay: the exception and the slice it modifies must be read under one generation, which is why the read is a single Lua script — drop the cancelled instance and let the moved instance carry its new start before the answer leaves Redis. TTLs close the loop: every key is stamped with the generation that produced it and expires with the change budget, so a slow reader cannot resurrect a generation that no longer exists. Real calendar caches shard by calendar, cap the slices they keep per generation, and let the expansion worker publish a slice with a compare-and-set on the generation.`,
};
