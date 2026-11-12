import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis trace assembly with late spans and dedupe',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['collector', 'redis'],
  task: `## Task

**Starting point.** The starter is the assembly behind \`POST /v1/spans\`: \`insert_span(tenant,
span)\` applies one span to the hash \`trace_key(trace_id)\` (\`trace:{trace_id}\`) one command at a
time. It reads \`root\`, writes \`owner\` and \`span:{span_id}\` (the JSON \`span_doc\` gives),
increments \`count\`, sets \`root\` or counts \`extra_roots\` for a root span, and for a child whose
parent is absent increments \`refs:{parent}\` and, the first time, \`missing\`. It answers
\`{inserted, count, missing}\`. Serial traffic assembles correctly; it hides four flaws.

**Failure mode the checks target.** Two root spans of one trace that arrive together both become
the root; an exporter that retries a batch counts every span twice; a parent that arrives after
its children leaves the trace marked incomplete; and a trace that stops half way stays in Redis
forever.

- One Lua script (\`EVAL\`, \`register_script\`, \`defineCommand\`, \`NewScript\`) applies the
  span; no client-side command on the hash remains.
- A span already stored (\`span:{span_id}\` exists) changes nothing and answers \`inserted: false\`.
- An arriving span that \`refs:{span_id}\` was waiting for deletes that field and decrements
  \`missing\`.
- Every new span sets the hash to expire \`ASSEMBLY_TTL_S\` (900 s) later.`,
  sequence: {
    participants: ['Trace Collector', 'Redis'],
    messages: [
      {
        from: 'Trace Collector',
        to: 'Redis',
        label: 'EVAL insert · trace:{id} · span, parent, tenant, doc, 900',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'HSETNX span:{span} · 0 → a retry, nothing changes', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'HDEL refs:{span} → missing - 1 · root first wins', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'absent parent → refs:{parent} + 1 · EXPIRE 900', kind: 'sync'},
      {from: 'Redis', to: 'Trace Collector', label: '{inserted, count, missing}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic',
      title: 'One Lua script applies the span',
      detail:
        'The read of `root` and every write happen inside one script (`EVAL`/`register_script`/`defineCommand`/`NewScript`), so a second insert cannot land between them; the starter reads `root`, then writes it, and two roots arriving together both win.',
      match: {
        python: {all: [/register_script\(|\.eval\(/], none: [/\br\.h(set|setnx|incrby|get|exists)\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/], none: [/redis\.h(set|setnx|incrby|get|exists)\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/], none: [/rdb\.H(Set|SetNX|IncrBy|Get|Exists)\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/], none: [/jedis\.h(set|setnx|incrBy|get|exists)\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/], none: [/redis\.h(set|setnx|incrby|get|exists)\(/]},
      },
    },
    {
      id: 'dedupe',
      title: 'A span already stored is a no-op',
      detail:
        'The script claims `span:{span_id}` with `HSETNX` (or a `SET … NX` marker) before it changes anything, and a span already there answers `inserted: false` with the counters untouched.',
      match: {
        python: {all: [/["']HSETNX["'],\s*\w+,\s*["']span:["']|["']NX["']/]},
        typescript: {all: [/["']HSETNX["'],\s*\w+,\s*["']span:["']|["']NX["']/]},
        go: {all: [/["']HSETNX["'],\s*\w+,\s*["']span:["']|["']NX["']/]},
        scala: {all: [/["']HSETNX["'],\s*\w+,\s*["']span:["']|["']NX["']/]},
        cpp: {all: [/["']HSETNX["'],\s*\w+,\s*["']span:["']|["']NX["']/]},
      },
    },
    {
      id: 'late-parent',
      title: 'A late parent closes the gap its children opened',
      detail:
        'When a span arrives that `refs:{span_id}` was waiting for, the script deletes that field and decrements `missing`; the starter only ever increments it, so a trace whose root came last stays incomplete.',
      match: {
        python: {all: [/["']refs:["']\s*\.\.\s*\w+/, /["']missing["'],\s*-/]},
        typescript: {all: [/["']refs:["']\s*\.\.\s*\w+/, /["']missing["'],\s*-/]},
        go: {all: [/["']refs:["']\s*\.\.\s*\w+/, /["']missing["'],\s*-/]},
        scala: {all: [/["']refs:["']\s*\.\.\s*\w+/, /["']missing["'],\s*-/]},
        cpp: {all: [/["']refs:["']\s*\.\.\s*\w+/, /["']missing["'],\s*-/]},
      },
    },
    {
      id: 'ttl',
      title: 'A trace expires 15 minutes after its last span',
      detail:
        'Every new span sets `EXPIRE` on the hash to `ASSEMBLY_TTL_S` (900 s), so a trace that goes quiet is dropped; the starter writes a key that never expires.',
      match: {
        python: {all: [/\b900\b/, /["']EXPIRE["']|\.expire\(/i]},
        typescript: {all: [/\b900\b/, /["']EXPIRE["']|\.expire\(/i]},
        go: {all: [/\b900\b/, /["']EXPIRE["']|\.Expire\(/i]},
        scala: {all: [/\b900\b/, /["']EXPIRE["']|\.expire\(/i]},
        cpp: {all: [/\b900\b/, /["']EXPIRE["']|\.expire\(/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from traces.assembly import span_doc, trace_key  # trace:{trace_id}; the JSON stored under span:{span_id}

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert_span(tenant: str, span: dict) -> dict:
    """Apply one span (trace_id, span_id, parent_span_id, service, start_ms, duration_ms) to its trace; {inserted, count, missing}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = trace_key(span["trace_id"])
    span_id, parent_id = span["span_id"], span["parent_span_id"]
    root = r.hget(key, "root")
    r.hsetnx(key, "owner", tenant)
    r.hset(key, f"span:{span_id}", span_doc(span))
    count = r.hincrby(key, "count", 1)
    if not parent_id:
        if root:
            r.hincrby(key, "extra_roots", 1)
        else:
            r.hset(key, "root", span_id)
    elif not r.hexists(key, f"span:{parent_id}"):
        if r.hincrby(key, f"refs:{parent_id}", 1) == 1:
            r.hincrby(key, "missing", 1)
    return {"inserted": True, "count": count, "missing": int(r.hget(key, "missing") or 0)}
`,
      solution: `import redis

from traces.assembly import span_doc, trace_key  # trace:{trace_id}; the JSON stored under span:{span_id}

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ASSEMBLY_TTL_S = 900  # a trace that goes quiet for 15 minutes is dropped

# KEYS[1] the trace hash; ARGV span id, parent id, tenant, span JSON, TTL. Runs as one step.
INSERT_SPAN_LUA = """
local trace = KEYS[1]
local span_id, parent_id, tenant, doc, ttl = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5])
if redis.call('HSETNX', trace, 'span:' .. span_id, doc) == 0 then
  return {0, tonumber(redis.call('HGET', trace, 'count') or '0'), tonumber(redis.call('HGET', trace, 'missing') or '0')}
end
redis.call('HSETNX', trace, 'owner', tenant)
local count = redis.call('HINCRBY', trace, 'count', 1)
if redis.call('HDEL', trace, 'refs:' .. span_id) == 1 then
  redis.call('HINCRBY', trace, 'missing', -1)
end
if parent_id == '' then
  if redis.call('HSETNX', trace, 'root', span_id) == 0 then
    redis.call('HINCRBY', trace, 'extra_roots', 1)
  end
elseif redis.call('HEXISTS', trace, 'span:' .. parent_id) == 0 then
  if redis.call('HINCRBY', trace, 'refs:' .. parent_id, 1) == 1 then
    redis.call('HINCRBY', trace, 'missing', 1)
  end
end
redis.call('EXPIRE', trace, ttl)
return {1, count, tonumber(redis.call('HGET', trace, 'missing') or '0')}
"""
insert = r.register_script(INSERT_SPAN_LUA)


def insert_span(tenant: str, span: dict) -> dict:
    """Apply one span (trace_id, span_id, parent_span_id, service, start_ms, duration_ms) to its trace; {inserted, count, missing}."""
    inserted, count, missing = insert(
        keys=[trace_key(span["trace_id"])],
        args=[span["span_id"], span["parent_span_id"], tenant, span_doc(span), ASSEMBLY_TTL_S],
    )
    return {"inserted": inserted == 1, "count": count, "missing": missing}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {type Inserted, type Span, spanDoc, traceKey} from 'traces/assembly';

const redis = new Redis({host: 'redis', port: 6379});

/** Apply one span to its trace; {inserted, count, missing}. */
export async function insertSpan(tenant: string, span: Span): Promise<Inserted> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = traceKey(span.trace_id);
  const root = await redis.hget(key, 'root');
  await redis.hsetnx(key, 'owner', tenant);
  await redis.hset(key, \`span:\${span.span_id}\`, spanDoc(span));
  const count = await redis.hincrby(key, 'count', 1);
  if (span.parent_span_id === '') {
    if (root) await redis.hincrby(key, 'extra_roots', 1);
    else await redis.hset(key, 'root', span.span_id);
  } else if (!(await redis.hexists(key, \`span:\${span.parent_span_id}\`))) {
    if ((await redis.hincrby(key, \`refs:\${span.parent_span_id}\`, 1)) === 1) await redis.hincrby(key, 'missing', 1);
  }
  return {inserted: true, count, missing: Number((await redis.hget(key, 'missing')) ?? 0)};
}
`,
      solution: `import Redis from 'ioredis';

import {type Inserted, type Span, spanDoc, traceKey} from 'traces/assembly';

export const ASSEMBLY_TTL_S = 900; // a trace that goes quiet for 15 minutes is dropped

// KEYS[1] the trace hash; ARGV span id, parent id, tenant, span JSON, TTL. Runs as one step.
export const INSERT_SPAN_LUA = \`
local trace = KEYS[1]
local span_id, parent_id, tenant, doc, ttl = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5])
if redis.call('HSETNX', trace, 'span:' .. span_id, doc) == 0 then
  return {0, tonumber(redis.call('HGET', trace, 'count') or '0'), tonumber(redis.call('HGET', trace, 'missing') or '0')}
end
redis.call('HSETNX', trace, 'owner', tenant)
local count = redis.call('HINCRBY', trace, 'count', 1)
if redis.call('HDEL', trace, 'refs:' .. span_id) == 1 then
  redis.call('HINCRBY', trace, 'missing', -1)
end
if parent_id == '' then
  if redis.call('HSETNX', trace, 'root', span_id) == 0 then
    redis.call('HINCRBY', trace, 'extra_roots', 1)
  end
elseif redis.call('HEXISTS', trace, 'span:' .. parent_id) == 0 then
  if redis.call('HINCRBY', trace, 'refs:' .. parent_id, 1) == 1 then
    redis.call('HINCRBY', trace, 'missing', 1)
  end
end
redis.call('EXPIRE', trace, ttl)
return {1, count, tonumber(redis.call('HGET', trace, 'missing') or '0')}
\`;

interface AssemblyRedis extends Redis {
  insertSpan(key: string, spanId: string, parentId: string, tenant: string, doc: string, ttl: number): Promise<number[]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as AssemblyRedis;
redis.defineCommand('insertSpan', {numberOfKeys: 1, lua: INSERT_SPAN_LUA});

/** Apply one span to its trace; {inserted, count, missing}. */
export async function insertSpan(tenant: string, span: Span): Promise<Inserted> {
  const [inserted, count, missing] = await redis.insertSpan(traceKey(span.trace_id), span.span_id, span.parent_span_id, tenant, spanDoc(span), ASSEMBLY_TTL_S);
  return {inserted: inserted === 1, count, missing};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"traces/assembly" // assembly.Span, assembly.Inserted, assembly.TraceKey, assembly.SpanDoc
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// insertSpan applies one span to its trace.
func insertSpan(ctx context.Context, tenant string, span assembly.Span) (assembly.Inserted, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := assembly.TraceKey(span.TraceID)
	root, err := rdb.HGet(ctx, key, "root").Result()
	if err != nil && err != redis.Nil {
		return assembly.Inserted{}, err
	}
	rdb.HSetNX(ctx, key, "owner", tenant)
	rdb.HSet(ctx, key, "span:"+span.SpanID, assembly.SpanDoc(span))
	count := rdb.HIncrBy(ctx, key, "count", 1).Val()
	if span.ParentSpanID == "" {
		if root != "" {
			rdb.HIncrBy(ctx, key, "extra_roots", 1)
		} else {
			rdb.HSet(ctx, key, "root", span.SpanID)
		}
	} else if !rdb.HExists(ctx, key, "span:"+span.ParentSpanID).Val() {
		if rdb.HIncrBy(ctx, key, "refs:"+span.ParentSpanID, 1).Val() == 1 {
			rdb.HIncrBy(ctx, key, "missing", 1)
		}
	}
	missing, _ := rdb.HGet(ctx, key, "missing").Int64()
	return assembly.Inserted{Inserted: true, Count: count, Missing: missing}, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"traces/assembly" // assembly.Span, assembly.Inserted, assembly.TraceKey, assembly.SpanDoc
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const assemblyTTLSeconds = 900 // a trace that goes quiet for 15 minutes is dropped

// insertSpanScript: KEYS[1] the trace hash; ARGV span id, parent id, tenant, span JSON, TTL. Runs as one step.
var insertSpanScript = redis.NewScript(\`
local trace = KEYS[1]
local span_id, parent_id, tenant, doc, ttl = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5])
if redis.call('HSETNX', trace, 'span:' .. span_id, doc) == 0 then
  return {0, tonumber(redis.call('HGET', trace, 'count') or '0'), tonumber(redis.call('HGET', trace, 'missing') or '0')}
end
redis.call('HSETNX', trace, 'owner', tenant)
local count = redis.call('HINCRBY', trace, 'count', 1)
if redis.call('HDEL', trace, 'refs:' .. span_id) == 1 then
  redis.call('HINCRBY', trace, 'missing', -1)
end
if parent_id == '' then
  if redis.call('HSETNX', trace, 'root', span_id) == 0 then
    redis.call('HINCRBY', trace, 'extra_roots', 1)
  end
elseif redis.call('HEXISTS', trace, 'span:' .. parent_id) == 0 then
  if redis.call('HINCRBY', trace, 'refs:' .. parent_id, 1) == 1 then
    redis.call('HINCRBY', trace, 'missing', 1)
  end
end
redis.call('EXPIRE', trace, ttl)
return {1, count, tonumber(redis.call('HGET', trace, 'missing') or '0')}
\`)

// insertSpan applies one span to its trace.
func insertSpan(ctx context.Context, tenant string, span assembly.Span) (assembly.Inserted, error) {
	out, err := insertSpanScript.Run(ctx, rdb, []string{assembly.TraceKey(span.TraceID)}, span.SpanID, span.ParentSpanID, tenant, assembly.SpanDoc(span), assemblyTTLSeconds).Int64Slice()
	if err != nil {
		return assembly.Inserted{}, err
	}
	return assembly.Inserted{Inserted: out[0] == 1, Count: out[1], Missing: out[2]}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import traces.Assembly // Assembly.Span, Assembly.Inserted, Assembly.traceKey, Assembly.spanDoc

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** Apply one span to its trace. */
  def insertSpan(tenant: String, span: Assembly.Span): Assembly.Inserted = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = Assembly.traceKey(span.traceId)
    val root = Option(jedis.hget(key, "root"))
    jedis.hsetnx(key, "owner", tenant)
    jedis.hset(key, s"span:\${span.spanId}", Assembly.spanDoc(span))
    val count = jedis.hincrBy(key, "count", 1)
    if (span.parentSpanId.isEmpty) {
      if (root.exists(_.nonEmpty)) jedis.hincrBy(key, "extra_roots", 1) else jedis.hset(key, "root", span.spanId)
    } else if (!jedis.hexists(key, s"span:\${span.parentSpanId}")) {
      if (jedis.hincrBy(key, s"refs:\${span.parentSpanId}", 1) == 1L) jedis.hincrBy(key, "missing", 1)
    }
    Assembly.Inserted(inserted = true, count, Option(jedis.hget(key, "missing")).map(_.toLong).getOrElse(0L))
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import traces.Assembly // Assembly.Span, Assembly.Inserted, Assembly.traceKey, Assembly.spanDoc

object State {
  val jedis = new JedisPooled("redis", 6379)

  val AssemblyTtlSeconds: Long = 900 // a trace that goes quiet for 15 minutes is dropped

  // KEYS[1] the trace hash; ARGV span id, parent id, tenant, span JSON, TTL. Runs as one step.
  val InsertSpanLua: String =
    """local trace = KEYS[1]
      |local span_id, parent_id, tenant, doc, ttl = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5])
      |if redis.call('HSETNX', trace, 'span:' .. span_id, doc) == 0 then
      |  return {0, tonumber(redis.call('HGET', trace, 'count') or '0'), tonumber(redis.call('HGET', trace, 'missing') or '0')}
      |end
      |redis.call('HSETNX', trace, 'owner', tenant)
      |local count = redis.call('HINCRBY', trace, 'count', 1)
      |if redis.call('HDEL', trace, 'refs:' .. span_id) == 1 then
      |  redis.call('HINCRBY', trace, 'missing', -1)
      |end
      |if parent_id == '' then
      |  if redis.call('HSETNX', trace, 'root', span_id) == 0 then
      |    redis.call('HINCRBY', trace, 'extra_roots', 1)
      |  end
      |elseif redis.call('HEXISTS', trace, 'span:' .. parent_id) == 0 then
      |  if redis.call('HINCRBY', trace, 'refs:' .. parent_id, 1) == 1 then
      |    redis.call('HINCRBY', trace, 'missing', 1)
      |  end
      |end
      |redis.call('EXPIRE', trace, ttl)
      |return {1, count, tonumber(redis.call('HGET', trace, 'missing') or '0')}
      |""".stripMargin

  /** Apply one span to its trace. */
  def insertSpan(tenant: String, span: Assembly.Span): Assembly.Inserted = {
    val args = List(span.spanId, span.parentSpanId, tenant, Assembly.spanDoc(span), AssemblyTtlSeconds.toString).asJava
    val out = jedis.eval(InsertSpanLua, List(Assembly.traceKey(span.traceId)).asJava, args).asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    Assembly.Inserted(out(0) == 1L, out(1), out(2))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

#include "traces/assembly.h"  // assembly::Span, assembly::Inserted, assembly::traceKey, assembly::spanDoc

sw::redis::Redis redis("tcp://redis:6379");

// Apply one span to its trace.
assembly::Inserted insertSpan(const std::string& tenant, const assembly::Span& span) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = assembly::traceKey(span.trace_id);
  const auto root = redis.hget(key, "root");
  redis.hsetnx(key, "owner", tenant);
  redis.hset(key, "span:" + span.span_id, assembly::spanDoc(span));
  const long long count = redis.hincrby(key, "count", 1);
  if (span.parent_span_id.empty()) {
    if (root && !root->empty()) {
      redis.hincrby(key, "extra_roots", 1);
    } else {
      redis.hset(key, "root", span.span_id);
    }
  } else if (!redis.hexists(key, "span:" + span.parent_span_id)) {
    if (redis.hincrby(key, "refs:" + span.parent_span_id, 1) == 1) redis.hincrby(key, "missing", 1);
  }
  const auto missing = redis.hget(key, "missing");
  return assembly::Inserted{true, count, missing ? std::stoll(*missing) : 0};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

#include "traces/assembly.h"  // assembly::Span, assembly::Inserted, assembly::traceKey, assembly::spanDoc

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kTtlSeconds = 900;  // a trace that goes quiet for 15 minutes is dropped

// KEYS[1] the trace hash; ARGV span id, parent id, tenant, span JSON, TTL. Runs as one step.
const std::string kInsertLua = R"lua(
local trace = KEYS[1]
local span_id, parent_id, tenant, doc, ttl = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5])
if redis.call('HSETNX', trace, 'span:' .. span_id, doc) == 0 then
  return {0, tonumber(redis.call('HGET', trace, 'count') or '0'), tonumber(redis.call('HGET', trace, 'missing') or '0')}
end
redis.call('HSETNX', trace, 'owner', tenant)
local count = redis.call('HINCRBY', trace, 'count', 1)
if redis.call('HDEL', trace, 'refs:' .. span_id) == 1 then
  redis.call('HINCRBY', trace, 'missing', -1)
end
if parent_id == '' then
  if redis.call('HSETNX', trace, 'root', span_id) == 0 then
    redis.call('HINCRBY', trace, 'extra_roots', 1)
  end
elseif redis.call('HEXISTS', trace, 'span:' .. parent_id) == 0 then
  if redis.call('HINCRBY', trace, 'refs:' .. parent_id, 1) == 1 then
    redis.call('HINCRBY', trace, 'missing', 1)
  end
end
redis.call('EXPIRE', trace, ttl)
return {1, count, tonumber(redis.call('HGET', trace, 'missing') or '0')}
)lua";

// Apply one span to its trace.
assembly::Inserted insertSpan(const std::string& tenant, const assembly::Span& span) {
  std::vector<long long> out;
  redis.eval(kInsertLua, {assembly::traceKey(span.trace_id)}, {span.span_id, span.parent_span_id, tenant, assembly::spanDoc(span), std::to_string(kTtlSeconds)},
             std::back_inserter(out));
  return assembly::Inserted{out.at(0) == 1, out.at(1), out.at(2)};
}
`,
    },
  },
  harness: {
    python: `TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
KEY = f"trace:{TRACE}"
ROOT_A = "00f067aa0ba902b7"
ROOT_B = "00f067aa0ba902c1"
PARENT = "00f067aa0ba902c4"
CHILD_1 = "00f067aa0ba902c2"
CHILD_2 = "00f067aa0ba902c3"
ORPHAN = "00f067aa0ba902c5"
ABSENT = "00f067aa0ba902c6"


def _span(span_id, parent="", start=1712345678901):
    return {"trace_id": TRACE, "span_id": span_id, "parent_span_id": parent, "service": "checkout", "start_ms": start, "duration_ms": 412}


def _field(ctx, name):
    return ctx.redis.hget(KEY, name)


def check_atomic(ctx):
    m = ctx.load("state")
    # A second root span of the same trace lands while the first is being applied.
    rival = ctx.redis_after(KEY, lambda: m.insert_span("acme", _span(ROOT_B, start=1712345678902)))
    m.insert_span("acme", _span(ROOT_A))
    assert rival.fired, f"nothing touched {KEY}"
    if rival.error is not None:
        raise rival.error
    count, root, extra = _field(ctx, "count"), _field(ctx, "root"), _field(ctx, "extra_roots")
    assert count == "2", f"two spans were applied and count is {count!r}"
    assert root in (ROOT_A, ROOT_B) and extra == "1", f"two root spans arrived together: root is {root!r} and extra_roots {extra!r}. The first to land keeps the root and the second is counted in extra_roots; run the whole insert as one Lua script so nothing lands between the read of root and its write"


def check_dedupe(ctx):
    m = ctx.load("state")
    first = m.insert_span("acme", _span(CHILD_1, PARENT))
    second = m.insert_span("acme", _span(CHILD_1, PARENT))
    assert first["inserted"] is True, f"the first insert of a span must answer inserted True, got {first}"
    assert second["inserted"] is False, f"an exporter retried the same span and insert_span answered {second}: a span already stored must answer inserted False"
    assert _field(ctx, "count") == "1", f"after one span and its retry count is {_field(ctx, 'count')!r}, expected 1"
    assert _field(ctx, f"refs:{PARENT}") == "1" and _field(ctx, "missing") == "1", f"the retry moved the gap counters: refs:{PARENT} {_field(ctx, f'refs:{PARENT}')!r}, missing {_field(ctx, 'missing')!r}, expected 1 and 1"
    assert second["count"] == 1 and second["missing"] == 1, f"the retry must answer the trace's current count and missing (1, 1), got {second}"


def check_late_parent(ctx):
    m = ctx.load("state")
    m.insert_span("acme", _span(CHILD_1, PARENT))
    m.insert_span("acme", _span(CHILD_2, PARENT))
    assert _field(ctx, "missing") == "1" and _field(ctx, f"refs:{PARENT}") == "2", f"two children of an absent parent: missing must be 1 and refs:{PARENT} 2, got {_field(ctx, 'missing')!r} and {_field(ctx, f'refs:{PARENT}')!r}"
    result = m.insert_span("acme", _span(PARENT, start=1712345678800))
    assert result["missing"] == 0 and _field(ctx, "missing") == "0", f"the parent the two children waited for arrived, yet missing is {_field(ctx, 'missing')!r} (insert_span answered {result}): its arrival must close the gap"
    assert not ctx.redis.hexists(KEY, f"refs:{PARENT}"), f"refs:{PARENT} must be deleted once {PARENT} arrived"
    assert _field(ctx, "root") == PARENT, f"the late root must become the root, root is {_field(ctx, 'root')!r}"
    m.insert_span("acme", _span(ORPHAN, ABSENT))
    assert _field(ctx, "missing") == "1", f"a new child of an absent parent opens a new gap: missing is {_field(ctx, 'missing')!r}, expected 1"


def check_ttl(ctx):
    m = ctx.load("state")
    m.insert_span("acme", _span(ROOT_A))
    ttl = ctx.redis.ttl(KEY)
    assert 890 <= ttl <= 900, f"{KEY} has TTL {ttl} after its first span, expected 900 s (ASSEMBLY_TTL_S): a trace that stops half way would stay forever"
    ctx.redis.expire(KEY, 5)
    m.insert_span("acme", _span(CHILD_1, ROOT_A))
    ttl = ctx.redis.ttl(KEY)
    assert 890 <= ttl <= 900, f"a new span arrived 5 s before {KEY} expired and its TTL is {ttl}: every new span must set it to 900 s again"
`,
    typescript: `const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const KEY = \`trace:\${TRACE}\`;
const ROOT_A = '00f067aa0ba902b7';
const ROOT_B = '00f067aa0ba902c1';
const PARENT = '00f067aa0ba902c4';
const CHILD_1 = '00f067aa0ba902c2';
const CHILD_2 = '00f067aa0ba902c3';
const ORPHAN = '00f067aa0ba902c5';
const ABSENT = '00f067aa0ba902c6';

const span = (span_id: string, parent = '', start_ms = 1712345678901) => ({trace_id: TRACE, span_id, parent_span_id: parent, service: 'checkout', start_ms, duration_ms: 412});
const field = (ctx, name: string) => ctx.redis.hget(KEY, name);

export async function check_atomic(ctx) {
  const m = ctx.load('state');
  // A second root span of the same trace lands while the first is being applied.
  const rival = ctx.redisAfter(KEY, () => m.insertSpan('acme', span(ROOT_B, '', 1712345678902)));
  await m.insertSpan('acme', span(ROOT_A));
  assert(rival.fired, \`nothing touched \${KEY}\`);
  if (rival.error !== undefined) throw rival.error;
  await rival.result;
  const [count, root, extra] = [field(ctx, 'count'), field(ctx, 'root'), field(ctx, 'extra_roots')];
  assert.equal(count, '2', \`two spans were applied and count is \${JSON.stringify(count)}\`);
  assert((root === ROOT_A || root === ROOT_B) && extra === '1', \`two root spans arrived together: root is \${JSON.stringify(root)} and extra_roots \${JSON.stringify(extra)}. The first to land keeps the root and the second is counted in extra_roots; run the whole insert as one Lua script so nothing lands between the read of root and its write\`);
}

export async function check_dedupe(ctx) {
  const m = ctx.load('state');
  const first = await m.insertSpan('acme', span(CHILD_1, PARENT));
  const second = await m.insertSpan('acme', span(CHILD_1, PARENT));
  assert.equal(first.inserted, true, \`the first insert of a span must answer inserted true, got \${JSON.stringify(first)}\`);
  assert.equal(second.inserted, false, \`an exporter retried the same span and insertSpan answered \${JSON.stringify(second)}: a span already stored must answer inserted false\`);
  assert.equal(field(ctx, 'count'), '1', \`after one span and its retry count is \${JSON.stringify(field(ctx, 'count'))}, expected 1\`);
  assert(field(ctx, \`refs:\${PARENT}\`) === '1' && field(ctx, 'missing') === '1', \`the retry moved the gap counters: refs:\${PARENT} \${JSON.stringify(field(ctx, \`refs:\${PARENT}\`))}, missing \${JSON.stringify(field(ctx, 'missing'))}, expected 1 and 1\`);
  assert(second.count === 1 && second.missing === 1, \`the retry must answer the trace's current count and missing (1, 1), got \${JSON.stringify(second)}\`);
}

export async function check_late_parent(ctx) {
  const m = ctx.load('state');
  await m.insertSpan('acme', span(CHILD_1, PARENT));
  await m.insertSpan('acme', span(CHILD_2, PARENT));
  assert(field(ctx, 'missing') === '1' && field(ctx, \`refs:\${PARENT}\`) === '2', \`two children of an absent parent: missing must be 1 and refs:\${PARENT} 2, got \${JSON.stringify(field(ctx, 'missing'))} and \${JSON.stringify(field(ctx, \`refs:\${PARENT}\`))}\`);
  const result = await m.insertSpan('acme', span(PARENT, '', 1712345678800));
  assert(result.missing === 0 && field(ctx, 'missing') === '0', \`the parent the two children waited for arrived, yet missing is \${JSON.stringify(field(ctx, 'missing'))} (insertSpan answered \${JSON.stringify(result)}): its arrival must close the gap\`);
  assert.equal(ctx.redis.hexists(KEY, \`refs:\${PARENT}\`), 0, \`refs:\${PARENT} must be deleted once \${PARENT} arrived\`);
  assert.equal(field(ctx, 'root'), PARENT, \`the late root must become the root, root is \${JSON.stringify(field(ctx, 'root'))}\`);
  await m.insertSpan('acme', span(ORPHAN, ABSENT));
  assert.equal(field(ctx, 'missing'), '1', \`a new child of an absent parent opens a new gap: missing is \${JSON.stringify(field(ctx, 'missing'))}, expected 1\`);
}

export async function check_ttl(ctx) {
  const m = ctx.load('state');
  await m.insertSpan('acme', span(ROOT_A));
  let ttl = ctx.redis.ttl(KEY);
  assert(890 <= ttl && ttl <= 900, \`\${KEY} has TTL \${ttl} after its first span, expected 900 s (ASSEMBLY_TTL_S): a trace that stops half way would stay forever\`);
  ctx.redis.expire(KEY, 5);
  await m.insertSpan('acme', span(CHILD_1, ROOT_A));
  ttl = ctx.redis.ttl(KEY);
  assert(890 <= ttl && ttl <= 900, \`a new span arrived 5 s before \${KEY} expired and its TTL is \${ttl}: every new span must set it to 900 s again\`);
}
`,
    go: `package main

import (
	"context"

	"traces/assembly"

	"leetbuild/harness"
)

const (
	stTrace  = "4bf92f3577b34da6a3ce929d0e0e4736"
	stKey    = "trace:" + stTrace
	stRootA  = "00f067aa0ba902b7"
	stRootB  = "00f067aa0ba902c1"
	stParent = "00f067aa0ba902c4"
	stChild1 = "00f067aa0ba902c2"
	stChild2 = "00f067aa0ba902c3"
	stOrphan = "00f067aa0ba902c5"
	stAbsent = "00f067aa0ba902c6"
)

func stSpan(spanID, parent string, start int64) assembly.Span {
	return assembly.Span{TraceID: stTrace, SpanID: spanID, ParentSpanID: parent, Service: "checkout", StartMs: start, DurationMs: 412}
}

func apply(ctx *harness.Ctx, span assembly.Span) assembly.Inserted {
	result, err := insertSpan(context.Background(), "acme", span)
	ctx.NoError(err, "insertSpan(%s)", span.SpanID)
	return result
}

func field(ctx *harness.Ctx, name string) string {
	v, _ := ctx.Redis.HGet(stKey, name)
	return v
}

func CheckAtomic(ctx *harness.Ctx) {
	// A second root span of the same trace lands while the first is being applied.
	rival := ctx.Redis.After(stKey, func() any {
		result, err := insertSpan(context.Background(), "acme", stSpan(stRootB, "", 1712345678902))
		ctx.NoError(err, "the rival insertSpan")
		return result
	})
	apply(ctx, stSpan(stRootA, "", 1712345678901))
	ctx.Assert(rival.Fired, "nothing touched %s", stKey)
	ctx.Assert(rival.Err == nil, "the rival insert failed: %v", rival.Err)
	ctx.Equal(field(ctx, "count"), "2", "two spans were applied; count")
	root, extra := field(ctx, "root"), field(ctx, "extra_roots")
	ctx.Assert((root == stRootA || root == stRootB) && extra == "1", "two root spans arrived together: root is %q and extra_roots %q. The first to land keeps the root and the second is counted in extra_roots; run the whole insert as one Lua script so nothing lands between the read of root and its write", root, extra)
}

func CheckDedupe(ctx *harness.Ctx) {
	first := apply(ctx, stSpan(stChild1, stParent, 1712345678901))
	second := apply(ctx, stSpan(stChild1, stParent, 1712345678901))
	ctx.Assert(first.Inserted, "the first insert of a span must answer Inserted true, got %+v", first)
	ctx.Assert(!second.Inserted, "an exporter retried the same span and insertSpan answered %+v: a span already stored must answer Inserted false", second)
	ctx.Equal(field(ctx, "count"), "1", "after one span and its retry; count")
	ctx.Assert(field(ctx, "refs:"+stParent) == "1" && field(ctx, "missing") == "1", "the retry moved the gap counters: refs:%s %q, missing %q, expected 1 and 1", stParent, field(ctx, "refs:"+stParent), field(ctx, "missing"))
	ctx.Assert(second.Count == 1 && second.Missing == 1, "the retry must answer the trace's current count and missing (1, 1), got %+v", second)
}

func CheckLateParent(ctx *harness.Ctx) {
	apply(ctx, stSpan(stChild1, stParent, 1712345678901))
	apply(ctx, stSpan(stChild2, stParent, 1712345678901))
	ctx.Assert(field(ctx, "missing") == "1" && field(ctx, "refs:"+stParent) == "2", "two children of an absent parent: missing must be 1 and refs:%s 2, got %q and %q", stParent, field(ctx, "missing"), field(ctx, "refs:"+stParent))
	result := apply(ctx, stSpan(stParent, "", 1712345678800))
	ctx.Assert(result.Missing == 0 && field(ctx, "missing") == "0", "the parent the two children waited for arrived, yet missing is %q (insertSpan answered %+v): its arrival must close the gap", field(ctx, "missing"), result)
	_, waiting := ctx.Redis.HGet(stKey, "refs:"+stParent)
	ctx.Assert(!waiting, "refs:%s must be deleted once %s arrived", stParent, stParent)
	ctx.Equal(field(ctx, "root"), stParent, "the late root must become the root; root")
	apply(ctx, stSpan(stOrphan, stAbsent, 1712345678901))
	ctx.Equal(field(ctx, "missing"), "1", "a new child of an absent parent opens a new gap; missing")
}

func CheckTtl(ctx *harness.Ctx) {
	apply(ctx, stSpan(stRootA, "", 1712345678901))
	ttl := ctx.Redis.TTL(stKey)
	ctx.Assert(890 <= ttl && ttl <= 900, "%s has TTL %d after its first span, expected 900 s (ASSEMBLY_TTL_S): a trace that stops half way would stay forever", stKey, ttl)
	ctx.Redis.Do("EXPIRE", stKey, 5)
	apply(ctx, stSpan(stChild1, stRootA, 1712345678901))
	ttl = ctx.Redis.TTL(stKey)
	ctx.Assert(890 <= ttl && ttl <= 900, "a new span arrived 5 s before %s expired and its TTL is %d: every new span must set it to 900 s again", stKey, ttl)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>

#include "traces/assembly.h"

namespace {

const std::string kTrace = "4bf92f3577b34da6a3ce929d0e0e4736";
const std::string kKey = "trace:" + kTrace;
const std::string kRootA = "00f067aa0ba902b7";
const std::string kRootB = "00f067aa0ba902c1";
const std::string kParent = "00f067aa0ba902c4";
const std::string kChild1 = "00f067aa0ba902c2";
const std::string kChild2 = "00f067aa0ba902c3";
const std::string kOrphan = "00f067aa0ba902c5";
const std::string kAbsent = "00f067aa0ba902c6";

assembly::Span stSpan(const std::string& span_id, const std::string& parent, long long start = 1712345678901LL) {
  return assembly::Span{kTrace, span_id, parent, "checkout", start, 412};
}

std::string field(harness::Ctx& ctx, const std::string& name) { return ctx.Redis.HGet(kKey, name).value_or(""); }

struct Rival {
  bool fired = false;
  std::optional<std::string> err;
};

}  // namespace

void CheckAtomic(harness::Ctx& ctx) {
  // A second root span of the same trace lands while the first is being applied.
  auto rival = std::make_shared<Rival>();
  ctx.Redis.After(kKey, [rival] {
    rival->fired = true;
    try {
      ::insertSpan("acme", stSpan(kRootB, "", 1712345678902LL));
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  ::insertSpan("acme", stSpan(kRootA, ""));
  ctx.Assert(rival->fired, "nothing touched %s", kKey);
  ctx.Assert(!rival->err, "the rival insert failed: %s", rival->err.value_or(""));
  ctx.Equal(field(ctx, "count"), "2", "two spans were applied; count");
  const std::string root = field(ctx, "root");
  const std::string extra = field(ctx, "extra_roots");
  ctx.Assert((root == kRootA || root == kRootB) && extra == "1",
             "two root spans arrived together: root is %q and extra_roots %q. The first to land keeps the root and the second is counted in extra_roots; run the whole insert as one Lua script so nothing lands between the read of root and its write",
             root, extra);
}

void CheckDedupe(harness::Ctx& ctx) {
  const auto first = ::insertSpan("acme", stSpan(kChild1, kParent));
  const auto second = ::insertSpan("acme", stSpan(kChild1, kParent));
  ctx.Assert(first.inserted, "the first insert of a span must answer inserted true");
  ctx.Assert(!second.inserted, "an exporter retried the same span and insertSpan answered inserted true: a span already stored must answer inserted false");
  ctx.Equal(field(ctx, "count"), "1", "after one span and its retry; count");
  ctx.Assert(field(ctx, "refs:" + kParent) == "1" && field(ctx, "missing") == "1", "the retry moved the gap counters: refs:%s %q, missing %q, expected 1 and 1", kParent,
             field(ctx, "refs:" + kParent), field(ctx, "missing"));
  ctx.Assert(second.count == 1 && second.missing == 1, "the retry must answer the trace's current count and missing (1, 1), got %v and %v", second.count, second.missing);
}

void CheckLateParent(harness::Ctx& ctx) {
  ::insertSpan("acme", stSpan(kChild1, kParent));
  ::insertSpan("acme", stSpan(kChild2, kParent));
  ctx.Assert(field(ctx, "missing") == "1" && field(ctx, "refs:" + kParent) == "2", "two children of an absent parent: missing must be 1 and refs:%s 2, got %q and %q", kParent,
             field(ctx, "missing"), field(ctx, "refs:" + kParent));
  const auto result = ::insertSpan("acme", stSpan(kParent, "", 1712345678800LL));
  ctx.Assert(result.missing == 0 && field(ctx, "missing") == "0", "the parent the two children waited for arrived, yet missing is %q (insertSpan answered %v): its arrival must close the gap",
             field(ctx, "missing"), result.missing);
  ctx.Assert(!ctx.Redis.HGet(kKey, "refs:" + kParent), "refs:%s must be deleted once %s arrived", kParent, kParent);
  ctx.Equal(field(ctx, "root"), kParent, "the late root must become the root; root");
  ::insertSpan("acme", stSpan(kOrphan, kAbsent));
  ctx.Equal(field(ctx, "missing"), "1", "a new child of an absent parent opens a new gap; missing");
}

void CheckTtl(harness::Ctx& ctx) {
  ::insertSpan("acme", stSpan(kRootA, ""));
  long long ttl = ctx.Redis.TTL(kKey);
  ctx.Assert(890 <= ttl && ttl <= 900, "%s has TTL %v after its first span, expected 900 s (ASSEMBLY_TTL_S): a trace that stops half way would stay forever", kKey, ttl);
  ctx.Redis.Do("EXPIRE", kKey, "5");
  ::insertSpan("acme", stSpan(kChild1, kRootA));
  ttl = ctx.Redis.TTL(kKey);
  ctx.Assert(890 <= ttl && ttl <= 900, "a new span arrived 5 s before %s expired and its TTL is %v: every new span must set it to 900 s again", kKey, ttl);
}
`,
  },
  hints: [
    'Send two root spans of one trace at once and read the hash: both claimed the root and extra_roots is unset. Retry a span: count is 2. Send children, then their parent: missing stays 1.',
    'Each field is its own command, so another insert lands between the read of root and its write. Nothing asks whether span:{span_id} already exists, nothing decrements missing, and nothing sets a TTL.',
    'Move the insert into one Lua script: `HSETNX span:{id}` (0 → return the counters), `HDEL refs:{id}` → `HINCRBY missing -1`, `HSETNX root` else `extra_roots`, absent parent → `refs`/`missing`, then `EXPIRE` with `ASSEMBLY_TTL_S`.',
  ],
  debrief: `The script is the unit of consistency: Redis runs it without interleaving, so the read of \`root\`, the dedupe claim and the gap counters describe one moment, whatever the other inserts are doing. The span field doubles as the dedupe marker because the span has to be stored anyway, so a retried export costs one HSETNX and changes nothing. The \`refs:\` counter is what lets a late parent close its gap in constant time instead of rescanning every child. Collectors that buffer whole traces bound them by count as well as by time: the OpenTelemetry Collector's tail sampler caps the traces it holds with \`num_traces\` and drops the oldest, which a per-key TTL cannot do when an incident floods the collector with new traces.`,
};
