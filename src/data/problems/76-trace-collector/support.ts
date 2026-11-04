/**
 * Hand-written support modules the trace-collector steps import but no step builds: the `traces`
 * package. `traces.assembly` is the trace assembly of step 2 as the other steps use it: one Redis
 * hash per trace, `insert_span` (one Lua script per span), `load_trace`, `delete_trace` and
 * `quarantine`. The five languages keep the same keys and fields, so a harness reads one layout
 * whatever the stack.
 */
import {scalaPath} from '../scala-support';

/** The assembly script every language runs: KEYS[1] the trace hash; ARGV span id, parent id, tenant, span JSON, TTL. */
const INSERT_SPAN_LUA = `local trace = KEYS[1]
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
`;

const LAYOUT = `trace:{trace_id} is one Redis hash per trace: owner (the tenant of its first span), count,
missing (parent ids a stored span names whose own span has not arrived), root ("" until a root span
arrives; the first one wins), extra_roots, span:{span_id} (the span as JSON) and refs:{span_id}
(how many stored spans wait for that parent). insert_span applies one span in one Lua script: a
span already stored is a no-op, and the hash expires ASSEMBLY_TTL_S after the last new span.
load_trace reads the trace back (spans ordered by start), delete_trace drops it, and quarantine
parks a trace storage refused under quarantine:{trace_id} for QUARANTINE_TTL_S and drops it.`;

const comment = (prefix: string): string =>
  LAYOUT.split('\n')
    .map(line => `${prefix}${line}`)
    .join('\n');

export const supportModules: Record<string, string> = {
  'traces/__init__.py': '',
  'traces/assembly.py': `"""
The trace assembly (provided; step 2 builds the same insert_span).
${LAYOUT}
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ASSEMBLY_TTL_S = 900
QUARANTINE_TTL_S = 7 * 24 * 3600

INSERT_SPAN_LUA = """
${INSERT_SPAN_LUA}"""
insert = r.register_script(INSERT_SPAN_LUA)


def trace_key(trace_id: str) -> str:
    return f"trace:{trace_id}"


def span_doc(span: dict) -> str:
    """The span as the hash stores it under span:{span_id}."""
    return json.dumps(
        {
            "span_id": span["span_id"],
            "parent_span_id": span["parent_span_id"],
            "service": span["service"],
            "start_ms": span["start_ms"],
            "duration_ms": span["duration_ms"],
        }
    )


def insert_span(tenant: str, span: dict) -> dict:
    """Apply one span (trace_id, span_id, parent_span_id, service, start_ms, duration_ms); {inserted, count, missing}."""
    inserted, count, missing = insert(
        keys=[trace_key(span["trace_id"])],
        args=[span["span_id"], span["parent_span_id"], tenant, span_doc(span), ASSEMBLY_TTL_S],
    )
    return {"inserted": inserted == 1, "count": count, "missing": missing}


def load_trace(trace_id: str) -> dict | None:
    """The assembled trace (trace_id, owner, root, count, missing, extra_roots, spans), or None."""
    raw = r.hgetall(trace_key(trace_id))
    if not raw:
        return None
    spans = [{"trace_id": trace_id, **json.loads(value)} for field, value in raw.items() if field.startswith("span:")]
    spans.sort(key=lambda s: (s["start_ms"], s["span_id"]))
    return {
        "trace_id": trace_id,
        "owner": raw.get("owner", ""),
        "root": raw.get("root", ""),
        "count": int(raw.get("count", 0)),
        "missing": int(raw.get("missing", 0)),
        "extra_roots": int(raw.get("extra_roots", 0)),
        "spans": spans,
    }


def delete_trace(trace_id: str) -> None:
    r.delete(trace_key(trace_id))


def quarantine(trace: dict, reason: str) -> None:
    """Park a trace storage refused, with the reason, and drop its assembly state."""
    r.set(f"quarantine:{trace['trace_id']}", json.dumps({"reason": reason, "trace": trace}), ex=QUARANTINE_TTL_S)
    r.delete(trace_key(trace["trace_id"]))
`,
};

export const supportModulesTs: Record<string, string> = {
  'traces/assembly.ts': `/**
 * The trace assembly (provided; step 2 builds the same insertSpan).
${comment(' * ')}
 */
import Redis from 'ioredis';

export const ASSEMBLY_TTL_S = 900;
export const QUARANTINE_TTL_S = 7 * 24 * 3600;

export const INSERT_SPAN_LUA = \`
${INSERT_SPAN_LUA}\`;

export interface Span {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  service: string;
  start_ms: number;
  duration_ms: number;
}

export interface Trace {
  trace_id: string;
  owner: string;
  root: string;
  count: number;
  missing: number;
  extra_roots: number;
  spans: Span[];
}

export interface Inserted {
  inserted: boolean;
  count: number;
  missing: number;
}

interface AssemblyRedis extends Redis {
  insertSpan(key: string, spanId: string, parentId: string, tenant: string, doc: string, ttl: number): Promise<number[]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as AssemblyRedis;
redis.defineCommand('insertSpan', {numberOfKeys: 1, lua: INSERT_SPAN_LUA});

export const traceKey = (traceId: string): string => \`trace:\${traceId}\`;

/** The span as the hash stores it under span:{span_id}. */
export function spanDoc(span: Span): string {
  const {span_id, parent_span_id, service, start_ms, duration_ms} = span;
  return JSON.stringify({span_id, parent_span_id, service, start_ms, duration_ms});
}

/** Apply one span; {inserted, count, missing}. */
export async function insertSpan(tenant: string, span: Span): Promise<Inserted> {
  const [inserted, count, missing] = await redis.insertSpan(traceKey(span.trace_id), span.span_id, span.parent_span_id, tenant, spanDoc(span), ASSEMBLY_TTL_S);
  return {inserted: inserted === 1, count, missing};
}

/** The assembled trace, or null. */
export async function loadTrace(traceId: string): Promise<Trace | null> {
  const raw = await redis.hgetall(traceKey(traceId));
  if (Object.keys(raw).length === 0) return null;
  const spans: Span[] = Object.entries(raw)
    .filter(([field]) => field.startsWith('span:'))
    .map(([, value]) => ({trace_id: traceId, ...(JSON.parse(value) as Omit<Span, 'trace_id'>)}));
  spans.sort((a, b) => a.start_ms - b.start_ms || (a.span_id < b.span_id ? -1 : a.span_id > b.span_id ? 1 : 0));
  const num = (field: string): number => Number(raw[field] ?? 0);
  return {trace_id: traceId, owner: raw.owner ?? '', root: raw.root ?? '', count: num('count'), missing: num('missing'), extra_roots: num('extra_roots'), spans};
}

export async function deleteTrace(traceId: string): Promise<void> {
  await redis.del(traceKey(traceId));
}

/** Park a trace storage refused, with the reason, and drop its assembly state. */
export async function quarantine(trace: Trace, reason: string): Promise<void> {
  await redis.set(\`quarantine:\${trace.trace_id}\`, JSON.stringify({reason, trace}), 'EX', QUARANTINE_TTL_S);
  await redis.del(traceKey(trace.trace_id));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'traces/assembly/assembly.go': `// Package assembly is the trace assembly (provided; step 2 builds the same InsertSpan).
${comment('// ')}
package assembly

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	AssemblyTTLSeconds   = 900
	QuarantineTTLSeconds = 7 * 24 * 3600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// InsertSpanLua applies one span: KEYS[1] the trace hash; ARGV span id, parent id, tenant, span JSON, TTL.
const InsertSpanLua = \`
${INSERT_SPAN_LUA}\`

var insertScript = redis.NewScript(InsertSpanLua)

// Span is one span of a trace (an empty ParentSpanID is a root).
type Span struct {
	TraceID      string \`json:"trace_id"\`
	SpanID       string \`json:"span_id"\`
	ParentSpanID string \`json:"parent_span_id"\`
	Service      string \`json:"service"\`
	StartMs      int64  \`json:"start_ms"\`
	DurationMs   int64  \`json:"duration_ms"\`
}

// Trace is an assembled trace as the hash holds it.
type Trace struct {
	TraceID    string \`json:"trace_id"\`
	Owner      string \`json:"owner"\`
	Root       string \`json:"root"\`
	Count      int64  \`json:"count"\`
	Missing    int64  \`json:"missing"\`
	ExtraRoots int64  \`json:"extra_roots"\`
	Spans      []Span \`json:"spans"\`
}

// Inserted is what one insert did: whether the span was new, and the trace's count and missing after it.
type Inserted struct {
	Inserted bool  \`json:"inserted"\`
	Count    int64 \`json:"count"\`
	Missing  int64 \`json:"missing"\`
}

// TraceKey is the hash of a trace.
func TraceKey(traceID string) string { return "trace:" + traceID }

// SpanDoc is the span as the hash stores it under span:{span_id}.
func SpanDoc(span Span) string {
	doc, _ := json.Marshal(map[string]any{
		"span_id": span.SpanID, "parent_span_id": span.ParentSpanID, "service": span.Service,
		"start_ms": span.StartMs, "duration_ms": span.DurationMs,
	})
	return string(doc)
}

// InsertSpan applies one span.
func InsertSpan(ctx context.Context, tenant string, span Span) (Inserted, error) {
	out, err := insertScript.Run(ctx, rdb, []string{TraceKey(span.TraceID)}, span.SpanID, span.ParentSpanID, tenant, SpanDoc(span), AssemblyTTLSeconds).Int64Slice()
	if err != nil {
		return Inserted{}, err
	}
	return Inserted{Inserted: out[0] == 1, Count: out[1], Missing: out[2]}, nil
}

// LoadTrace is the assembled trace, or nil.
func LoadTrace(ctx context.Context, traceID string) (*Trace, error) {
	raw, err := rdb.HGetAll(ctx, TraceKey(traceID)).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	num := func(field string) int64 {
		n, _ := strconv.ParseInt(raw[field], 10, 64)
		return n
	}
	trace := &Trace{TraceID: traceID, Owner: raw["owner"], Root: raw["root"], Count: num("count"), Missing: num("missing"), ExtraRoots: num("extra_roots"), Spans: []Span{}}
	for field, value := range raw {
		if !strings.HasPrefix(field, "span:") {
			continue
		}
		var span Span
		if err := json.Unmarshal([]byte(value), &span); err != nil {
			return nil, err
		}
		span.TraceID = traceID
		trace.Spans = append(trace.Spans, span)
	}
	sort.Slice(trace.Spans, func(i, j int) bool {
		a, b := trace.Spans[i], trace.Spans[j]
		if a.StartMs != b.StartMs {
			return a.StartMs < b.StartMs
		}
		return a.SpanID < b.SpanID
	})
	return trace, nil
}

// DeleteTrace drops a trace's assembly state.
func DeleteTrace(ctx context.Context, traceID string) error {
	return rdb.Del(ctx, TraceKey(traceID)).Err()
}

// Quarantine parks a trace storage refused, with the reason, and drops its assembly state.
func Quarantine(ctx context.Context, trace *Trace, reason string) error {
	doc, _ := json.Marshal(map[string]any{"reason": reason, "trace": trace})
	if err := rdb.Set(ctx, "quarantine:"+trace.TraceID, doc, QuarantineTTLSeconds*time.Second).Err(); err != nil {
		return err
	}
	return rdb.Del(ctx, TraceKey(trace.TraceID)).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'traces/assembly.h': `// The trace assembly (provided; step 2 builds the same insertSpan).
${comment('// ')}
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <iterator>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace assembly {

constexpr long long kAssemblyTtlSeconds = 900;
constexpr long long kQuarantineTtlSeconds = 7 * 24 * 3600;

inline const std::string kInsertSpanLua = R"lua(
${INSERT_SPAN_LUA})lua";

// One span of a trace (an empty parent_span_id is a root).
struct Span {
  std::string trace_id;
  std::string span_id;
  std::string parent_span_id;
  std::string service;
  long long start_ms = 0;
  long long duration_ms = 0;
};

// An assembled trace as the hash holds it.
struct Trace {
  std::string trace_id;
  std::string owner;
  std::string root;
  long long count = 0;
  long long missing = 0;
  long long extra_roots = 0;
  std::vector<Span> spans;
};

// What one insert did: whether the span was new, and the trace's count and missing after it.
struct Inserted {
  bool inserted = false;
  long long count = 0;
  long long missing = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string traceKey(const std::string& trace_id) { return "trace:" + trace_id; }

inline nlohmann::json spanJson(const Span& s) {
  return {{"trace_id", s.trace_id}, {"span_id", s.span_id}, {"parent_span_id", s.parent_span_id}, {"service", s.service}, {"start_ms", s.start_ms}, {"duration_ms", s.duration_ms}};
}

// The span as the hash stores it under span:{span_id}.
inline std::string spanDoc(const Span& s) {
  return nlohmann::json{{"span_id", s.span_id}, {"parent_span_id", s.parent_span_id}, {"service", s.service}, {"start_ms", s.start_ms}, {"duration_ms", s.duration_ms}}.dump();
}

// Apply one span.
inline Inserted insertSpan(const std::string& tenant, const Span& span) {
  std::vector<long long> out;
  redis().eval(kInsertSpanLua, {traceKey(span.trace_id)}, {span.span_id, span.parent_span_id, tenant, spanDoc(span), std::to_string(kAssemblyTtlSeconds)}, std::back_inserter(out));
  return Inserted{out.at(0) == 1, out.at(1), out.at(2)};
}

// The assembled trace, or none.
inline std::optional<Trace> loadTrace(const std::string& trace_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(traceKey(trace_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* field) { return raw.count(field) ? raw.at(field) : std::string(); };
  const auto num = [&text](const char* field) { return text(field).empty() ? 0LL : std::stoll(text(field)); };
  Trace trace{trace_id, text("owner"), text("root"), num("count"), num("missing"), num("extra_roots"), {}};
  for (const auto& [field, value] : raw) {
    if (field.rfind("span:", 0) != 0) continue;
    const auto doc = nlohmann::json::parse(value);
    trace.spans.push_back(Span{trace_id, doc.value("span_id", ""), doc.value("parent_span_id", ""), doc.value("service", ""), doc.value("start_ms", 0LL), doc.value("duration_ms", 0LL)});
  }
  std::sort(trace.spans.begin(), trace.spans.end(), [](const Span& a, const Span& b) {
    return a.start_ms != b.start_ms ? a.start_ms < b.start_ms : a.span_id < b.span_id;
  });
  return trace;
}

// Drop a trace's assembly state.
inline void deleteTrace(const std::string& trace_id) { redis().del(traceKey(trace_id)); }

// Park a trace storage refused, with the reason, and drop its assembly state.
inline void quarantine(const Trace& trace, const std::string& reason) {
  nlohmann::json spans = nlohmann::json::array();
  for (const Span& s : trace.spans) spans.push_back(spanJson(s));
  const nlohmann::json doc = {{"reason", reason}, {"trace", {{"trace_id", trace.trace_id}, {"owner", trace.owner}, {"spans", spans}}}};
  redis().set("quarantine:" + trace.trace_id, doc.dump(), std::chrono::seconds(kQuarantineTtlSeconds));
  redis().del(traceKey(trace.trace_id));
}

}  // namespace assembly
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('traces', 'Assembly')]: `package traces

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The trace assembly (provided; step 2 builds the same insertSpan).
${comment(' * ')}
 */
object Assembly {
  /** One span of a trace (an empty parentSpanId is a root). */
  final case class Span(traceId: String, spanId: String, parentSpanId: String, service: String, startMs: Long, durationMs: Long)
  /** An assembled trace as the hash holds it. */
  final case class Trace(traceId: String, owner: String, root: String, count: Long, missing: Long, extraRoots: Long, spans: Seq[Span])
  /** What one insert did: whether the span was new, and the trace's count and missing after it. */
  final case class Inserted(inserted: Boolean, count: Long, missing: Long)

  val AssemblyTtlSeconds = 900L
  val QuarantineTtlSeconds: Long = 7L * 24 * 3600

  val jedis = new JedisPooled("redis", 6379)

  val InsertSpanLua: String = """
${INSERT_SPAN_LUA}"""

  def traceKey(traceId: String): String = s"trace:$traceId"

  def spanJson(s: Span): JsObject = JsObject(
    "trace_id" -> JsString(s.traceId), "span_id" -> JsString(s.spanId), "parent_span_id" -> JsString(s.parentSpanId),
    "service" -> JsString(s.service), "start_ms" -> JsNumber(s.startMs), "duration_ms" -> JsNumber(s.durationMs))

  /** The span as the hash stores it under span:{span_id}. */
  def spanDoc(s: Span): String = JsObject(spanJson(s).fields - "trace_id").compactPrint

  /** Apply one span. */
  def insertSpan(tenant: String, span: Span): Inserted = {
    val args = List(span.spanId, span.parentSpanId, tenant, spanDoc(span), AssemblyTtlSeconds.toString).asJava
    val out = jedis.eval(InsertSpanLua, List(traceKey(span.traceId)).asJava, args).asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    Inserted(out(0) == 1L, out(1), out(2))
  }

  /** The assembled trace, if there is one. */
  def loadTrace(traceId: String): Option[Trace] = {
    val raw = jedis.hgetAll(traceKey(traceId)).asScala.toMap
    if (raw.isEmpty) None
    else {
      def num(field: String): Long = raw.get(field).filter(_.nonEmpty).map(_.toLong).getOrElse(0L)
      val spans = raw.collect {
        case (field, value) if field.startsWith("span:") =>
          val doc = value.parseJson.asJsObject.fields
          def text(name: String): String = doc.get(name).collect { case JsString(s) => s }.getOrElse("")
          def long(name: String): Long = doc.get(name).collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
          Span(traceId, text("span_id"), text("parent_span_id"), text("service"), long("start_ms"), long("duration_ms"))
      }.toSeq.sortBy(s => (s.startMs, s.spanId))
      Some(Trace(traceId, raw.getOrElse("owner", ""), raw.getOrElse("root", ""), num("count"), num("missing"), num("extra_roots"), spans))
    }
  }

  /** Drop a trace's assembly state. */
  def deleteTrace(traceId: String): Unit = jedis.del(traceKey(traceId))

  /** Park a trace storage refused, with the reason, and drop its assembly state. */
  def quarantine(trace: Trace, reason: String): Unit = {
    val doc = JsObject("reason" -> JsString(reason), "trace" -> JsObject("trace_id" -> JsString(trace.traceId), "owner" -> JsString(trace.owner), "spans" -> JsArray(trace.spans.map(spanJson).toVector)))
    jedis.set(s"quarantine:\${trace.traceId}", doc.compactPrint, SetParams.setParams().ex(QuarantineTtlSeconds))
    jedis.del(traceKey(trace.traceId))
  }
}
`,
};
