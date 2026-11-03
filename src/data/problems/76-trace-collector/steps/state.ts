import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis trace assembly with late spans and dedupe',
  concept: 'redis',
  file: 'state',
  focus: ['collector', 'redis'],
  task: `## Task

**Starting point.** The starter implements \`insert_span(tenant, span)\`: it appends the span to a
list under \`trace:{trace_id}\` with \`RPUSH\`, reads the list back, recomputes the roots on the
client and returns the count and gap state. Serial traffic assembles correctly, so the demo shows a
tree. The starter hides five flaws.

**Failure mode the checks target.** One root cause: the assembly is a sequence of independent
commands instead of one step. The list and the computed root can disagree, so a late root flips the
tree between two reads; a retry inserts a span twice and corrupts the gap count; and a key with no
expiry makes every aborted trace permanent.

- State lives under \`trace:{trace_id}\` as one hash: \`count\`, \`missing\`, \`root\` (\`""\` while
  unknown), \`extra_roots\`, \`seen:{span_id}\`, \`refs:{span_id}\` (spans naming it as parent) and
  the owner tenant.
- **One atomic script** (\`EVAL\`) inserts the span and updates every field; no \`RPUSH\`/\`LRANGE\`
  and no client-side recompute remain.
- A redelivered span is a no-op under a **per-span dedupe key** \`span:{trace_id}:{span_id}\`, set
  with \`NX\` \`EX\` inside the script before any state changes; the script returns whether the span
  was new.
- A span whose parent is present closes the gaps that referenced it (\`missing\` decreases by
  \`refs:{span_id}\`); an absent parent increments \`missing\` once. The first root wins; a second is
  counted in \`extra_roots\`.
- Every key expires **15 minutes after the last span**: \`EXPIRE\` on every insert, the same TTL on
  the marker.`,
  sequence: {
    participants: ['Traces SDK', 'Trace Collector', 'Redis'],
    messages: [
      {from: 'Traces SDK', to: 'Trace Collector', label: 'POST /v1/spans · span without its parent yet', kind: 'sync'},
      {from: 'Trace Collector', to: 'Redis', label: 'EVAL insert · KEYS[trace:{id}, span:{id}:{span}]', kind: 'sync'},
      {from: 'Redis', to: 'Trace Collector', label: '{1, count, missing, ttl}', kind: 'reply'},
      {from: 'Traces SDK', to: 'Trace Collector', label: 'the same span again (exporter retry)', kind: 'sync'},
      {from: 'Trace Collector', to: 'Redis', label: 'SET marker NX inside the script', kind: 'sync'},
      {from: 'Redis', to: 'Trace Collector', label: '{0, count, missing, ttl} · tree untouched', kind: 'reply'},
      {
        from: 'Trace Collector',
        to: 'Trace Collector',
        label: 'late root closes its gaps · first root wins, extra_roots counts',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'EXPIRE 900 s after the last span', kind: 'async'},
    ],
  },
  hints: [
    'During an incident the waterfall for one trace changes shape between two refreshes, a retried export batch raises the span count without adding spans, and Redis memory climbs until the instance is restarted.',
    '`RPUSH` then a client recompute is two states with a reader in between; nothing marks a span as already seen, so a duplicate is appended; and no key carries a TTL.',
    'Move the insert into `INSERT_SPAN_LUA` run with `eval`: `SET` `span:{trace}:{span}` `NX` `EX`, return early if it existed, `HINCRBY` count/missing/refs, `HSET` root first-wins, `EXPIRE` with `ASSEMBLY_TTL_S`.',
  ],
  checks: [
    {
      id: 'atomic',
      title: 'One atomic script inserts the span and updates the state',
      detail:
        'The insert, the counters and the seen/refs fields are written inside a single `EVAL`/`Run` of the script. The starter appends with `RPUSH` and recomputes the root in a separate command, so two readers can observe two different trees for one trace.',
      match: {
        python: {
          all: [
            /INSERT_SPAN_LUA/,
            /\.eval\(/,
            /redis\.call\('HINCRBY', trace, 'count'/,
            /redis\.call\('HSET', trace, 'seen:' \.\. span_id, 1\)/,
          ],
        },
        typescript: {
          all: [
            /INSERT_SPAN_LUA/,
            /\.eval\(/,
            /redis\.call\('HINCRBY', trace, 'count'/,
            /redis\.call\('HSET', trace, 'seen:' \.\. span_id, 1\)/,
          ],
        },
        go: {
          all: [
            /insertSpanScript/,
            /\.Run\(/,
            /redis\.call\('HINCRBY', trace, 'count'/,
            /redis\.call\('HSET', trace, 'seen:' \.\. span_id, 1\)/,
          ],
        },
        scala: {
          all: [
            /InsertSpanLua/,
            /\.eval\(/,
            /redis\.call\('HINCRBY', trace, 'count'/,
            /redis\.call\('HSET', trace, 'seen:' \.\. span_id, 1\)/,
          ],
        },
        cpp: {
          all: [
            /kInsertSpanLua/,
            /eval<std::vector<long long>>/,
            /redis\.call\('HINCRBY', trace, 'count'/,
            /redis\.call\('HSET', trace, 'seen:' \.\. span_id, 1\)/,
          ],
        },
      },
    },
    {
      id: 'dedupe',
      title: 'A redelivered span is a no-op under a span dedupe key',
      detail:
        'The script claims `span:{trace_id}:{span_id}` with `NX` `EX` before it changes anything and reports whether the span was new, so a retrying exporter cannot move the tree. The starter has no marker, so a duplicate span is inserted twice.',
      match: {
        python: {
          all: [
            /def dedupe_key/,
            /span:\{trace_id\}:\{span_id\}/,
            /redis\.call\('SET', marker, '1', 'NX', 'EX', ttl\)/,
          ],
        },
        typescript: {
          all: [
            /function dedupeKey/,
            /span:\$\{traceId\}:\$\{spanId\}/,
            /redis\.call\('SET', marker, '1', 'NX', 'EX', ttl\)/,
          ],
        },
        go: {all: [/func dedupeKey/, /span:%s:%s/, /redis\.call\('SET', marker, '1', 'NX', 'EX', ttl\)/]},
        scala: {
          all: [/def dedupeKey/, /span:\$traceId:\$spanId/, /redis\.call\('SET', marker, '1', 'NX', 'EX', ttl\)/],
        },
        cpp: {
          all: [
            /dedupeKey\(/,
            /"span:" \+ traceId \+ ":" \+ spanId/,
            /redis\.call\('SET', marker, '1', 'NX', 'EX', ttl\)/,
          ],
        },
      },
    },
    {
      id: 'ttl',
      title: 'Abandoned traces expire 15 minutes after the last span',
      detail:
        'Every insert refreshes `EXPIRE` on the trace hash and the dedupe marker carries the same `EX` TTL, so a trace that goes quiet for 15 minutes is dropped. The starter writes keys that never expire, so half-assembled traces accumulate forever.',
      match: {
        python: {all: [/ASSEMBLY_TTL_S\s*=\s*900/, /redis\.call\('EXPIRE', trace, ttl\)/, /'EX', ttl/]},
        typescript: {all: [/ASSEMBLY_TTL_S\s*=\s*900/, /redis\.call\('EXPIRE', trace, ttl\)/, /'EX', ttl/]},
        go: {all: [/assemblyTTLS/, /redis\.call\('EXPIRE', trace, ttl\)/, /'EX', ttl/]},
        scala: {all: [/AssemblyTtlS/, /redis\.call\('EXPIRE', trace, ttl\)/, /'EX', ttl/]},
        cpp: {all: [/kAssemblyTtlS/, /redis\.call\('EXPIRE', trace, ttl\)/, /'EX', ttl/]},
      },
    },
    {
      id: 'root-state',
      title: 'Late spans close gaps and never open a second tree',
      detail:
        'The same script keeps `root` first-wins (counting further roots in `extra_roots`), decrements `missing` by the `refs:{span_id}` that were waiting for the arriving span, and increments it once for a parent that has not arrived. The starter recomputes roots from a list, so a late root flips the tree.',
      match: {
        python: {
          all: [
            /redis\.call\('HSET', trace, 'root', span_id\)/,
            /redis\.call\('HINCRBY', trace, 'missing', -refs\)/,
            /redis\.call\('HINCRBY', trace, 'refs:' \.\. parent_id, 1\)/,
            /'extra_roots'/,
          ],
        },
        typescript: {
          all: [
            /redis\.call\('HSET', trace, 'root', span_id\)/,
            /redis\.call\('HINCRBY', trace, 'missing', -refs\)/,
            /redis\.call\('HINCRBY', trace, 'refs:' \.\. parent_id, 1\)/,
            /'extra_roots'/,
          ],
        },
        go: {
          all: [
            /redis\.call\('HSET', trace, 'root', span_id\)/,
            /redis\.call\('HINCRBY', trace, 'missing', -refs\)/,
            /redis\.call\('HINCRBY', trace, 'refs:' \.\. parent_id, 1\)/,
            /'extra_roots'/,
          ],
        },
        scala: {
          all: [
            /redis\.call\('HSET', trace, 'root', span_id\)/,
            /redis\.call\('HINCRBY', trace, 'missing', -refs\)/,
            /redis\.call\('HINCRBY', trace, 'refs:' \.\. parent_id, 1\)/,
            /'extra_roots'/,
          ],
        },
        cpp: {
          all: [
            /redis\.call\('HSET', trace, 'root', span_id\)/,
            /redis\.call\('HINCRBY', trace, 'missing', -refs\)/,
            /redis\.call\('HINCRBY', trace, 'refs:' \.\. parent_id, 1\)/,
            /'extra_roots'/,
          ],
        },
      },
    },
    {
      id: 'no-client-recompute',
      title: 'The tree is never recomputed from a client-side list',
      detail:
        'No list of spans and no client-side root recomputation survive in the assembly path: `RPUSH`/`LRANGE` (and their `SMEMBERS` cousin) are gone, because a tree rebuilt from a list is a second source of truth.',
      match: {
        python: {all: [/INSERT_SPAN_LUA/], none: [/\.rpush\(/, /\.lrange\(/, /\.smembers\(/]},
        typescript: {all: [/INSERT_SPAN_LUA/], none: [/\.rpush\(/, /\.lrange\(/, /\.smembers\(/]},
        go: {all: [/insertSpanScript/], none: [/\.RPush\(/, /\.LRange\(/, /\.SMembers\(/]},
        scala: {all: [/InsertSpanLua/], none: [/\.rpush\(/, /\.lrange\(/, /\.smembers\(/]},
        cpp: {all: [/kInsertSpanLua/], none: [/\.rpush\(/, /\.lrange\(/, /\.smembers\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert_span(tenant: str, span: dict) -> dict:
    """Assemble one span into its trace and answer with the state the ingest path reports."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    trace_id = span["trace_id"]
    key = f"trace:{trace_id}"
    r.rpush(f"{key}:spans", json.dumps(span))
    spans = [json.loads(item) for item in r.lrange(f"{key}:spans", 0, -1)]
    seen = {item["span_id"] for item in spans}
    roots = [item for item in spans if not item["parent_span_id"]]
    missing = [
        item for item in spans if item["parent_span_id"] and item["parent_span_id"] not in seen
    ]
    r.hset(
        key,
        mapping={
            "count": len(spans),
            "root": roots[0]["span_id"] if roots else "",
            "missing": len(missing),
            "owner": tenant,
        },
    )
    return {
        "trace_id": trace_id,
        "inserted": True,
        "count": len(spans),
        "missing": len(missing),
    }
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# 15 minutes after the last span of the trace, the partial assembly is dropped.
ASSEMBLY_TTL_S = 900

INSERT_SPAN_LUA = """
local trace = KEYS[1]
local marker = KEYS[2]
local span_id = ARGV[1]
local parent_id = ARGV[2]
local ttl = tonumber(ARGV[3])
local tenant = ARGV[4]

if redis.call('SET', marker, '1', 'NX', 'EX', ttl) == false then
  return {0, tonumber(redis.call('HGET', trace, 'count') or 0), tonumber(redis.call('HGET', trace, 'missing') or 0), redis.call('TTL', trace)}
end

if redis.call('HGET', trace, 'count') == false then
  redis.call('HSET', trace, 'count', 0, 'missing', 0, 'root', '', 'owner', tenant)
end

redis.call('HINCRBY', trace, 'count', 1)
redis.call('HSET', trace, 'seen:' .. span_id, 1)

local refs = tonumber(redis.call('HGET', trace, 'refs:' .. span_id) or 0)
if refs > 0 then
  redis.call('HINCRBY', trace, 'missing', -refs)
end

if parent_id == '' then
  if redis.call('HGET', trace, 'root') == '' then
    redis.call('HSET', trace, 'root', span_id)
  else
    redis.call('HINCRBY', trace, 'extra_roots', 1)
  end
else
  redis.call('HINCRBY', trace, 'refs:' .. parent_id, 1)
  if redis.call('HEXISTS', trace, 'seen:' .. parent_id) == 0 then
    redis.call('HINCRBY', trace, 'missing', 1)
  end
end

redis.call('EXPIRE', trace, ttl)
return {1, tonumber(redis.call('HGET', trace, 'count')), tonumber(redis.call('HGET', trace, 'missing')), ttl}
"""


def trace_key(trace_id: str) -> str:
    return f"trace:{trace_id}"


def dedupe_key(trace_id: str, span_id: str) -> str:
    """One marker per (trace, span): a retried export cannot insert the same span twice."""
    return f"span:{trace_id}:{span_id}"


def insert_span(tenant: str, span: dict) -> dict:
    result = r.eval(
        INSERT_SPAN_LUA,
        2,
        trace_key(span["trace_id"]),
        dedupe_key(span["trace_id"], span["span_id"]),
        span["span_id"],
        span["parent_span_id"] or "",
        ASSEMBLY_TTL_S,
        tenant,
    )
    status, count, missing, ttl = (int(value) for value in result)
    return {
        "trace_id": span["trace_id"],
        "inserted": status == 1,
        "duplicate": status == 0,
        "count": count,
        "missing": missing,
        "ttl": ttl,
    }
`,
    },
    typescript: {
      starter: `/** Trace assembly. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

export interface Span {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  service: string;
  start_ms: number;
  duration_ms: number;
}

export interface AssemblyState {
  trace_id: string;
  inserted: boolean;
  count: number;
  missing: number;
}

export async function insertSpan(tenant: string, span: Span): Promise<AssemblyState> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const key = \`trace:\${span.trace_id}\`;
  await r.rpush(\`\${key}:spans\`, JSON.stringify(span));
  const raw = await r.lrange(\`\${key}:spans\`, 0, -1);
  const spans = raw.map(item => JSON.parse(item) as Span);
  const seen = new Set(spans.map(item => item.span_id));
  const roots = spans.filter(item => item.parent_span_id === '');
  const missing = spans.filter(item => item.parent_span_id !== '' && !seen.has(item.parent_span_id));
  await r.hset(key, {
    count: spans.length,
    root: roots[0]?.span_id ?? '',
    missing: missing.length,
    owner: tenant,
  });
  return {trace_id: span.trace_id, inserted: true, count: spans.length, missing: missing.length};
}
`,
      solution: `/** Trace assembly: one script inserts the span, closes the gaps it can and refreshes the TTL. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

/** 15 minutes after the last span of the trace, the partial assembly is dropped. */
const ASSEMBLY_TTL_S = 900;

export interface Span {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  service: string;
  start_ms: number;
  duration_ms: number;
}

export interface AssemblyState {
  trace_id: string;
  inserted: boolean;
  duplicate: boolean;
  count: number;
  missing: number;
  ttl: number;
}

export function traceKey(traceId: string): string {
  return \`trace:\${traceId}\`;
}

export function dedupeKey(traceId: string, spanId: string): string {
  return \`span:\${traceId}:\${spanId}\`;
}

const INSERT_SPAN_LUA = \`
local trace = KEYS[1]
local marker = KEYS[2]
local span_id = ARGV[1]
local parent_id = ARGV[2]
local ttl = tonumber(ARGV[3])
local tenant = ARGV[4]

if redis.call('SET', marker, '1', 'NX', 'EX', ttl) == false then
  return {0, tonumber(redis.call('HGET', trace, 'count') or 0), tonumber(redis.call('HGET', trace, 'missing') or 0), redis.call('TTL', trace)}
end

if redis.call('HGET', trace, 'count') == false then
  redis.call('HSET', trace, 'count', 0, 'missing', 0, 'root', '', 'owner', tenant)
end

redis.call('HINCRBY', trace, 'count', 1)
redis.call('HSET', trace, 'seen:' .. span_id, 1)

local refs = tonumber(redis.call('HGET', trace, 'refs:' .. span_id) or 0)
if refs > 0 then
  redis.call('HINCRBY', trace, 'missing', -refs)
end

if parent_id == '' then
  if redis.call('HGET', trace, 'root') == '' then
    redis.call('HSET', trace, 'root', span_id)
  else
    redis.call('HINCRBY', trace, 'extra_roots', 1)
  end
else
  redis.call('HINCRBY', trace, 'refs:' .. parent_id, 1)
  if redis.call('HEXISTS', trace, 'seen:' .. parent_id) == 0 then
    redis.call('HINCRBY', trace, 'missing', 1)
  end
end

redis.call('EXPIRE', trace, ttl)
return {1, tonumber(redis.call('HGET', trace, 'count')), tonumber(redis.call('HGET', trace, 'missing')), ttl}
\`;

export async function insertSpan(tenant: string, span: Span): Promise<AssemblyState> {
  const reply = (await r.eval(
    INSERT_SPAN_LUA,
    2,
    traceKey(span.trace_id),
    dedupeKey(span.trace_id, span.span_id),
    span.span_id,
    span.parent_span_id ?? '',
    String(ASSEMBLY_TTL_S),
    tenant,
  )) as [number, number, number, number];
  return {
    trace_id: span.trace_id,
    inserted: reply[0] === 1,
    duplicate: reply[0] === 0,
    count: reply[1],
    missing: reply[2],
    ttl: reply[3],
  };
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type Span struct {
	TraceID      string \`json:"trace_id"\`
	SpanID       string \`json:"span_id"\`
	ParentSpanID string \`json:"parent_span_id"\`
	Service      string \`json:"service"\`
	StartMS      int64  \`json:"start_ms"\`
	DurationMS   int64  \`json:"duration_ms"\`
}

func insertSpan(ctx context.Context, tenant string, span Span) (map[string]any, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	key := fmt.Sprintf("trace:%s", span.TraceID)
	payload, _ := json.Marshal(span)
	if err := rdb.RPush(ctx, key+":spans", payload).Err(); err != nil {
		return nil, err
	}
	raw, _ := rdb.LRange(ctx, key+":spans", 0, -1).Result()
	var spans []Span
	seen := map[string]bool{}
	for _, item := range raw {
		var parsed Span
		_ = json.Unmarshal([]byte(item), &parsed)
		spans = append(spans, parsed)
		seen[parsed.SpanID] = true
	}
	root := ""
	missing := 0
	for _, parsed := range spans {
		if parsed.ParentSpanID == "" && root == "" {
			root = parsed.SpanID
		}
		if parsed.ParentSpanID != "" && !seen[parsed.ParentSpanID] {
			missing++
		}
	}
	rdb.HSet(ctx, key, "count", len(spans), "root", root, "missing", missing, "owner", tenant)
	return map[string]any{
		"trace_id": span.TraceID,
		"inserted": true,
		"count":    len(spans),
		"missing":  missing,
	}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// Fifteen minutes after the last span of the trace, the partial assembly is dropped.
const assemblyTTLS = 900

var rdb *redis.Client

type Span struct {
	TraceID      string \`json:"trace_id"\`
	SpanID       string \`json:"span_id"\`
	ParentSpanID string \`json:"parent_span_id"\`
	Service      string \`json:"service"\`
	StartMS      int64  \`json:"start_ms"\`
	DurationMS   int64  \`json:"duration_ms"\`
}

var insertSpanScript = redis.NewScript(\`
local trace = KEYS[1]
local marker = KEYS[2]
local span_id = ARGV[1]
local parent_id = ARGV[2]
local ttl = tonumber(ARGV[3])
local tenant = ARGV[4]

if redis.call('SET', marker, '1', 'NX', 'EX', ttl) == false then
  return {0, tonumber(redis.call('HGET', trace, 'count') or 0), tonumber(redis.call('HGET', trace, 'missing') or 0), redis.call('TTL', trace)}
end

if redis.call('HGET', trace, 'count') == false then
  redis.call('HSET', trace, 'count', 0, 'missing', 0, 'root', '', 'owner', tenant)
end

redis.call('HINCRBY', trace, 'count', 1)
redis.call('HSET', trace, 'seen:' .. span_id, 1)

local refs = tonumber(redis.call('HGET', trace, 'refs:' .. span_id) or 0)
if refs > 0 then
  redis.call('HINCRBY', trace, 'missing', -refs)
end

if parent_id == '' then
  if redis.call('HGET', trace, 'root') == '' then
    redis.call('HSET', trace, 'root', span_id)
  else
    redis.call('HINCRBY', trace, 'extra_roots', 1)
  end
else
  redis.call('HINCRBY', trace, 'refs:' .. parent_id, 1)
  if redis.call('HEXISTS', trace, 'seen:' .. parent_id) == 0 then
    redis.call('HINCRBY', trace, 'missing', 1)
  end
end

redis.call('EXPIRE', trace, ttl)
return {1, tonumber(redis.call('HGET', trace, 'count')), tonumber(redis.call('HGET', trace, 'missing')), ttl}
\`)

func traceKey(traceID string) string {
	return fmt.Sprintf("trace:%s", traceID)
}

func dedupeKey(traceID, spanID string) string {
	return fmt.Sprintf("span:%s:%s", traceID, spanID)
}

func insertSpan(ctx context.Context, tenant string, span Span) (map[string]any, error) {
	values, err := insertSpanScript.Run(
		ctx,
		rdb,
		[]string{traceKey(span.TraceID), dedupeKey(span.TraceID, span.SpanID)},
		span.SpanID,
		span.ParentSpanID,
		assemblyTTLS,
		tenant,
	).Int64Slice()
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"trace_id":  span.TraceID,
		"inserted":  values[0] == 1,
		"duplicate": values[0] == 0,
		"count":     values[1],
		"missing":   values[2],
		"ttl":       values[3],
	}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis
import spray.json._

object TraceState {
  val jedis = new Jedis("redis", 6379)

  def insertSpan(tenant: String, span: Map[String, Any]): Map[String, Any] = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val traceId = span("trace_id").toString
    val key = s"trace:$traceId"
    jedis.rpush(s"$key:spans", span.toJson.compactPrint)
    val stored = jedis.lrange(s"$key:spans", 0, -1).toArray.toList
    val parsed = stored.map(_.toString.parseJson.asJsObject.fields)
    val seen = parsed.map(item => item("span_id").convertTo[String]).toSet
    val roots = parsed.filter(item => item("parent_span_id").convertTo[String].isEmpty)
    val missing = parsed.count { item =>
      val parent = item("parent_span_id").convertTo[String]
      parent.nonEmpty && !seen.contains(parent)
    }
    jedis.hset(key, "count", parsed.size.toString)
    jedis.hset(key, "root", roots.headOption.map(item => item("span_id").convertTo[String]).getOrElse(""))
    jedis.hset(key, "missing", missing.toString)
    jedis.hset(key, "owner", tenant)
    Map("trace_id" -> traceId, "inserted" -> true, "count" -> parsed.size, "missing" -> missing)
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

object TraceState {
  // Fifteen minutes after the last span of the trace, the partial assembly is dropped.
  val AssemblyTtlS = 900L

  val jedis = new Jedis("redis", 6379)

  val InsertSpanLua =
    """
      |local trace = KEYS[1]
      |local marker = KEYS[2]
      |local span_id = ARGV[1]
      |local parent_id = ARGV[2]
      |local ttl = tonumber(ARGV[3])
      |local tenant = ARGV[4]
      |
      |if redis.call('SET', marker, '1', 'NX', 'EX', ttl) == false then
      |  return {0, tonumber(redis.call('HGET', trace, 'count') or 0), tonumber(redis.call('HGET', trace, 'missing') or 0), redis.call('TTL', trace)}
      |end
      |
      |if redis.call('HGET', trace, 'count') == false then
      |  redis.call('HSET', trace, 'count', 0, 'missing', 0, 'root', '', 'owner', tenant)
      |end
      |
      |redis.call('HINCRBY', trace, 'count', 1)
      |redis.call('HSET', trace, 'seen:' .. span_id, 1)
      |
      |local refs = tonumber(redis.call('HGET', trace, 'refs:' .. span_id) or 0)
      |if refs > 0 then
      |  redis.call('HINCRBY', trace, 'missing', -refs)
      |end
      |
      |if parent_id == '' then
      |  if redis.call('HGET', trace, 'root') == '' then
      |    redis.call('HSET', trace, 'root', span_id)
      |  else
      |    redis.call('HINCRBY', trace, 'extra_roots', 1)
      |  end
      |else
      |  redis.call('HINCRBY', trace, 'refs:' .. parent_id, 1)
      |  if redis.call('HEXISTS', trace, 'seen:' .. parent_id) == 0 then
      |    redis.call('HINCRBY', trace, 'missing', 1)
      |  end
      |end
      |
      |redis.call('EXPIRE', trace, ttl)
      |return {1, tonumber(redis.call('HGET', trace, 'count')), tonumber(redis.call('HGET', trace, 'missing')), ttl}
      |""".stripMargin

  def traceKey(traceId: String): String = s"trace:$traceId"

  def dedupeKey(traceId: String, spanId: String): String = s"span:$traceId:$spanId"

  def insertSpan(tenant: String, span: Map[String, Any]): Map[String, Any] = {
    val traceId = span("trace_id").toString
    val spanId = span("span_id").toString
    val parentId = span.getOrElse("parent_span_id", "").toString
    val result = jedis
      .eval(
        InsertSpanLua,
        2,
        traceKey(traceId),
        dedupeKey(traceId, spanId),
        spanId,
        parentId,
        AssemblyTtlS.toString,
        tenant
      )
      .asInstanceOf[java.util.List[Long]]
    Map(
      "trace_id" -> traceId,
      "inserted" -> (result.get(0) == 1L),
      "duplicate" -> (result.get(0) == 0L),
      "count" -> result.get(1),
      "missing" -> result.get(2),
      "ttl" -> result.get(3)
    )
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

std::unique_ptr<sw::redis::Redis> redis;

json insertSpan(const std::string& tenant, const json& span) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string traceId = span.value("trace_id", std::string());
  const std::string key = "trace:" + traceId;
  const std::string payload = span.dump();
  redis->rpush(key + ":spans", payload);
  std::vector<std::string> stored;
  redis->lrange(key + ":spans", 0, -1, std::back_inserter(stored));
  std::vector<json> spans;
  for (const auto& item : stored) spans.push_back(json::parse(item));
  std::vector<std::string> seen;
  for (const auto& item : spans) seen.push_back(item.value("span_id", std::string()));
  std::string root;
  long long missing = 0;
  for (const auto& item : spans) {
    const std::string parent = item.value("parent_span_id", std::string());
    if (parent.empty() && root.empty()) root = item.value("span_id", std::string());
    if (!parent.empty() &&
        std::find(seen.begin(), seen.end(), parent) == seen.end()) missing += 1;
  }
  redis->hset(key, "count", std::to_string(spans.size()));
  redis->hset(key, "root", root);
  redis->hset(key, "missing", std::to_string(missing));
  redis->hset(key, "owner", tenant);
  return json{{"trace_id", traceId}, {"inserted", true}, {"count", spans.size()}, {"missing", missing}};
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

// Fifteen minutes after the last span of the trace, the partial assembly is dropped.
constexpr long long kAssemblyTtlS = 900;

const char* kInsertSpanLua = R"LUA(
local trace = KEYS[1]
local marker = KEYS[2]
local span_id = ARGV[1]
local parent_id = ARGV[2]
local ttl = tonumber(ARGV[3])
local tenant = ARGV[4]

if redis.call('SET', marker, '1', 'NX', 'EX', ttl) == false then
  return {0, tonumber(redis.call('HGET', trace, 'count') or 0), tonumber(redis.call('HGET', trace, 'missing') or 0), redis.call('TTL', trace)}
end

if redis.call('HGET', trace, 'count') == false then
  redis.call('HSET', trace, 'count', 0, 'missing', 0, 'root', '', 'owner', tenant)
end

redis.call('HINCRBY', trace, 'count', 1)
redis.call('HSET', trace, 'seen:' .. span_id, 1)

local refs = tonumber(redis.call('HGET', trace, 'refs:' .. span_id) or 0)
if refs > 0 then
  redis.call('HINCRBY', trace, 'missing', -refs)
end

if parent_id == '' then
  if redis.call('HGET', trace, 'root') == '' then
    redis.call('HSET', trace, 'root', span_id)
  else
    redis.call('HINCRBY', trace, 'extra_roots', 1)
  end
else
  redis.call('HINCRBY', trace, 'refs:' .. parent_id, 1)
  if redis.call('HEXISTS', trace, 'seen:' .. parent_id) == 0 then
    redis.call('HINCRBY', trace, 'missing', 1)
  end
end

redis.call('EXPIRE', trace, ttl)
return {1, tonumber(redis.call('HGET', trace, 'count')), tonumber(redis.call('HGET', trace, 'missing')), ttl}
)LUA";

std::unique_ptr<sw::redis::Redis> redis;

std::string traceKey(const std::string& traceId) { return "trace:" + traceId; }

std::string dedupeKey(const std::string& traceId, const std::string& spanId) {
  return "span:" + traceId + ":" + spanId;
}

json insertSpan(const std::string& tenant, const json& span) {
  const std::string traceId = span.value("trace_id", std::string());
  const std::string spanId = span.value("span_id", std::string());
  const std::string parentId = span.value("parent_span_id", std::string());
  const std::vector<std::string> keys = {traceKey(traceId), dedupeKey(traceId, spanId)};
  const std::vector<std::string> args = {
      spanId, parentId, std::to_string(kAssemblyTtlS), tenant};
  const auto result = redis->eval<std::vector<long long>>(kInsertSpanLua, keys, args);
  return json{
      {"trace_id", traceId},
      {"inserted", result[0] == 1},
      {"duplicate", result[0] == 0},
      {"count", result[1]},
      {"missing", result[2]},
      {"ttl", result[3]},
  };
}
`,
    },
  },
  debrief: `The fix is one Lua script because the property worth protecting is that a reader observes exactly one state per span insert. The starter writes the list, then the root, and everything follows: a late root rewrites \`root\` while the children are already there, a retried export appends the same span twice so \`count\` and \`missing\` drift from the spans actually held, and because nothing expires, every abandoned trace occupies memory until a restart. Inside the script the marker is claimed first, the counters and the refs/seen fields move together, and the \`EXPIRE\` slides with the last span, so "abandoned" becomes a property of the data rather than of a cleanup job. Production collectors also cap spans per trace and spill oversized traces to disk, both assuming an atomic insert.`,
};
