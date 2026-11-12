/**
 * Hand-written support modules the text-to-SQL steps import but no step builds: the `querygen`
 * package. `config` is the contract every step agrees on (addresses, the topic, the system
 * workspaces, the partition column); `queries` is the query store (Redis); `catalog` renders a
 * table's DDL; `agents` and `warehouse` are the deterministic stand-ins the checks serve over gRPC
 * in place of the model agents and the warehouse.
 */
import {CPP_DIGEST_H, CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'querygen/__init__.py': '',
  'querygen/config.py': `"""Addresses, topics and names every step of querygen agrees on."""
# The agents (Intent, PickTables, PruneColumns, Generate): a stand-in served by the checks (querygen.agents).
AGENTS = "agents:9000"
# The warehouse (Execute): a stand-in served by the checks (querygen.warehouse).
WAREHOUSE = "warehouse:9000"
# Feedback events with the evaluation signals, keyed by user, for the eval consumer.
TOPIC = "query.feedback"
# The curated system workspaces a question may be answered from.
SYSTEM_WORKSPACES = frozenset({"mobility", "ads", "core-services", "platform-engineering", "it"})
# Every warehouse table is partitioned by day on this column.
PARTITION_COLUMN = "datestr"
# Per-call deadlines: the classifying agents (Intent, PickTables, PruneColumns) and Generate.
AGENT_DEADLINE_S = 10
GENERATE_DEADLINE_S = 30

# Keys in Redis. query:{query_id} and idem:{user}:{key} belong to the query store (querygen.queries);
# decision:{workspace}:{qhash} and budget:{user} to step 2; eval:{workspace} to step 5's consumer.
`,
  'querygen/queries.py': `"""
The query store (provided): query records in Redis, by id and by (user, Idempotency-Key).

A record is a dict: query_id, user, workspace, question, status ("pending_ack", "generated", "ran"),
tables_proposed, tables_acked, sql, run_ok, has_output.
"""
import json

import redis

QUERY_TTL_S = 7 * 86_400

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class QueryStore:
    def find(self, user: str, idem_key: str) -> dict | None:
        """The record this user created under idem_key, if any."""
        query_id = r.get(f"idem:{user}:{idem_key}")
        return self.get(query_id) if query_id else None

    def put(self, user: str, idem_key: str, record: dict) -> None:
        """Store a new record under its id and under (user, idem_key)."""
        self.save(record)
        r.set(f"idem:{user}:{idem_key}", record["query_id"], ex=QUERY_TTL_S)

    def get(self, query_id: str) -> dict | None:
        """The record, None when there is none."""
        raw = r.get(f"query:{query_id}")
        return json.loads(raw) if raw else None

    def save(self, record: dict) -> None:
        """Write the record back under its id."""
        r.set(f"query:{record['query_id']}", json.dumps(record), ex=QUERY_TTL_S)


store = QueryStore()
`,
  'querygen/catalog.py': `"""
The workspace catalog (provided): a table's DDL as the generator sees it.

Tier-1 tables (the "_tier1" suffix) carry thousands of attribute columns: about 18 000 tokens of DDL
each, the way the source's widest tables cost 40-60K tokens.
"""
COLUMNS = {
    "trips": ("datestr STRING", "trip_uuid STRING", "city_id BIGINT", "driver_uuid STRING", "rider_uuid STRING", "status STRING", "fare_usd DOUBLE"),
    "drivers": ("datestr STRING", "driver_uuid STRING", "city_id BIGINT", "vehicle_type STRING", "rating DOUBLE"),
    "riders": ("datestr STRING", "rider_uuid STRING", "city_id BIGINT", "signup_channel STRING"),
    "cities": ("datestr STRING", "city_id BIGINT", "city_name STRING", "country_code STRING"),
    "ad_campaigns": ("datestr STRING", "campaign_id STRING", "advertiser_id STRING", "spend_usd DOUBLE", "impressions BIGINT"),
}
TIER1_SUFFIX = "_tier1"
TIER1_ATTRIBUTES = 4000


def schema_for(table: str) -> str:
    """CREATE TABLE <table> (<column TYPE>, ...)."""
    tier1 = table.endswith(TIER1_SUFFIX)
    base = table[: -len(TIER1_SUFFIX)] if tier1 else table
    columns = list(COLUMNS.get(base, ("datestr STRING",)))
    if tier1:
        columns += [f"attr_{i:04d} STRING" for i in range(1, TIER1_ATTRIBUTES + 1)]
    return f"CREATE TABLE {table} ({', '.join(columns)})"
`,
  'querygen/agents.py': `"""
The stand-in for the model agents. The checks serve it over gRPC (sqlagents.Agents at
querygen.config.AGENTS); querygen's code never calls it directly. Deterministic on purpose: the course
grades what the service does around the models, not the SQL a model would write.

intent(question): "hr-payroll" (not a system workspace) for a question starting "offtopic:", "ads"
  when it mentions a campaign or an advertiser, "mobility" otherwise
pick_tables(question, workspace): the workspace's tables from WORKSPACE_TABLES
prune_columns(question, schemas): each schema without its attr_* columns
generate(question, workspace, schemas): JSON {"sql", "explanation"} over the first schema's table;
  a question starting "garbled:" gets prose, "nosql:" JSON without sql, "blank:" an empty sql.
  A prompt whose schemas exceed CONTEXT_LIMIT_TOKENS is refused with INVALID_ARGUMENT.
"""
import json

CONTEXT_LIMIT_TOKENS = 32_000
WORKSPACE_TABLES = {
    "mobility": ["trips", "drivers"],
    "ads": ["ad_campaigns"],
    "core-services": ["cities"],
    "platform-engineering": ["trips"],
    "it": ["riders"],
}


def intent(question: str) -> str:
    q = question.lower()
    if q.startswith("offtopic:"):
        return "hr-payroll"
    if "campaign" in q or "advertiser" in q:
        return "ads"
    return "mobility"


def pick_tables(question: str, workspace: str) -> list[str]:
    return list(WORKSPACE_TABLES.get(workspace, ["trips"]))


def prompt_tokens(schemas) -> int:
    return sum(len(s) for s in schemas) // 4


def prune_columns(question: str, schemas) -> list[str]:
    pruned = []
    for schema in schemas:
        head, _, rest = schema.partition(" (")
        kept = [c for c in rest[:-1].split(", ") if not c.startswith("attr_")]
        pruned.append(f"{head} ({', '.join(kept)})")
    return pruned


def generate(question: str, workspace: str, schemas) -> str:
    if question.startswith("garbled:"):
        return "Sure! Here is the SQL you asked for:\\nSELECT * FROM trips"
    if question.startswith("nosql:"):
        return json.dumps({"explanation": "No table answers that question."})
    if question.startswith("blank:"):
        return json.dumps({"sql": "", "explanation": ""})
    table = schemas[0].split(" ")[2] if schemas else "trips"
    return json.dumps({"sql": f"SELECT * FROM {table} WHERE datestr = '2026-11-01'", "explanation": f"Rows of {table} for 2026-11-01."})
`,
  'querygen/warehouse.py': `"""
The stand-in for the warehouse. The checks serve it over gRPC (sqlagents.Warehouse at
querygen.config.WAREHOUSE). It does not parse SQL: it answers ROWS_PER_DAY rows of (datestr,
trip_uuid), fewer when the statement ends in a smaller LIMIT, and none for the hallucinated filter
status = 'Finished' (the trips table says 'completed').
"""
import re

COLUMNS = ["datestr", "trip_uuid"]
ROWS_PER_DAY = 2500


def execute(sql: str) -> list[list[str]]:
    if "'Finished'" in sql:
        return []
    m = re.search(r"(?i)\\blimit\\s+(\\d+)\\s*;?\\s*$", sql.strip())
    n = ROWS_PER_DAY if m is None else min(int(m.group(1)), ROWS_PER_DAY)
    return [["2026-11-01", f"trip-{i:05d}"] for i in range(1, n + 1)]
`,
};

export const supportModulesTs: Record<string, string> = {
  'querygen/config.ts': `/** Addresses, topics and names every step of querygen agrees on. */
/** The agents (Intent, PickTables, PruneColumns, Generate): a stand-in served by the checks (querygen/agents). */
export const AGENTS = 'agents:9000';
/** The warehouse (Execute): a stand-in served by the checks (querygen/warehouse). */
export const WAREHOUSE = 'warehouse:9000';
/** Feedback events with the evaluation signals, keyed by user, for the eval consumer. */
export const TOPIC = 'query.feedback';
/** The curated system workspaces a question may be answered from. */
export const SYSTEM_WORKSPACES: Record<string, true> = {mobility: true, ads: true, 'core-services': true, 'platform-engineering': true, it: true};
/** Every warehouse table is partitioned by day on this column. */
export const PARTITION_COLUMN = 'datestr';
/** Per-call deadlines: the classifying agents (Intent, PickTables, PruneColumns) and Generate. */
export const AGENT_DEADLINE_MS = 10_000;
export const GENERATE_DEADLINE_MS = 30_000;

// Keys in Redis. query:{query_id} and idem:{user}:{key} belong to the query store (querygen/queries);
// decision:{workspace}:{qhash} and budget:{user} to step 2; eval:{workspace} to step 5's consumer.
`,
  'querygen/queries.ts': `/** The query store (provided): query records in Redis, by id and by (user, Idempotency-Key). */
import Redis from 'ioredis';

export const QUERY_TTL_S = 7 * 86_400;

const redis = new Redis({host: 'redis', port: 6379});

export interface QueryRecord {
  query_id: string;
  user: string;
  workspace: string;
  question: string;
  /** pending_ack, generated or ran. */
  status: string;
  tables_proposed: string[];
  tables_acked: string[];
  sql: string;
  run_ok: boolean;
  has_output: boolean;
}

export const store = {
  /** The record this user created under idemKey, if any. */
  async find(user: string, idemKey: string): Promise<QueryRecord | null> {
    const queryId = await redis.get(\`idem:\${user}:\${idemKey}\`);
    return queryId === null ? null : store.get(queryId);
  },

  /** Store a new record under its id and under (user, idemKey). */
  async put(user: string, idemKey: string, record: QueryRecord): Promise<void> {
    await store.save(record);
    await redis.set(\`idem:\${user}:\${idemKey}\`, record.query_id, 'EX', QUERY_TTL_S);
  },

  /** The record, null when there is none. */
  async get(queryId: string): Promise<QueryRecord | null> {
    const raw = await redis.get(\`query:\${queryId}\`);
    return raw === null ? null : (JSON.parse(raw) as QueryRecord);
  },

  /** Write the record back under its id. */
  async save(record: QueryRecord): Promise<void> {
    await redis.set(\`query:\${record.query_id}\`, JSON.stringify(record), 'EX', QUERY_TTL_S);
  },
};
`,
  'querygen/catalog.ts': `/**
 * The workspace catalog (provided): a table's DDL as the generator sees it. Tier-1 tables (the
 * "_tier1" suffix) carry thousands of attribute columns: about 18 000 tokens of DDL each.
 */
export const COLUMNS: Record<string, string[]> = {
  trips: ['datestr STRING', 'trip_uuid STRING', 'city_id BIGINT', 'driver_uuid STRING', 'rider_uuid STRING', 'status STRING', 'fare_usd DOUBLE'],
  drivers: ['datestr STRING', 'driver_uuid STRING', 'city_id BIGINT', 'vehicle_type STRING', 'rating DOUBLE'],
  riders: ['datestr STRING', 'rider_uuid STRING', 'city_id BIGINT', 'signup_channel STRING'],
  cities: ['datestr STRING', 'city_id BIGINT', 'city_name STRING', 'country_code STRING'],
  ad_campaigns: ['datestr STRING', 'campaign_id STRING', 'advertiser_id STRING', 'spend_usd DOUBLE', 'impressions BIGINT'],
};
export const TIER1_SUFFIX = '_tier1';
export const TIER1_ATTRIBUTES = 4000;

/** CREATE TABLE <table> (<column TYPE>, ...). */
export function schemaFor(table: string): string {
  const tier1 = table.endsWith(TIER1_SUFFIX);
  const base = tier1 ? table.slice(0, -TIER1_SUFFIX.length) : table;
  const columns = [...(COLUMNS[base] ?? ['datestr STRING'])];
  if (tier1) for (let i = 1; i <= TIER1_ATTRIBUTES; i++) columns.push(\`attr_\${String(i).padStart(4, '0')} STRING\`);
  return \`CREATE TABLE \${table} (\${columns.join(', ')})\`;
}
`,
  'querygen/agents.ts': `/**
 * The stand-in for the model agents. The checks serve it over gRPC (sqlagents.Agents at
 * querygen/config's AGENTS); querygen's code never calls it directly. Deterministic on purpose.
 *
 * intent(question): "hr-payroll" (not a system workspace) for a question starting "offtopic:", "ads"
 *   when it mentions a campaign or an advertiser, "mobility" otherwise
 * pickTables(question, workspace): the workspace's tables from WORKSPACE_TABLES
 * pruneColumns(question, schemas): each schema without its attr_* columns
 * generate(question, workspace, schemas): JSON {"sql", "explanation"} over the first schema's table;
 *   "garbled:" gets prose, "nosql:" JSON without sql, "blank:" an empty sql. A prompt whose schemas
 *   exceed CONTEXT_LIMIT_TOKENS is refused with INVALID_ARGUMENT.
 */
export const CONTEXT_LIMIT_TOKENS = 32_000;
export const WORKSPACE_TABLES: Record<string, string[]> = {
  mobility: ['trips', 'drivers'],
  ads: ['ad_campaigns'],
  'core-services': ['cities'],
  'platform-engineering': ['trips'],
  it: ['riders'],
};

export function intent(question: string): string {
  const q = question.toLowerCase();
  if (q.startsWith('offtopic:')) return 'hr-payroll';
  if (q.includes('campaign') || q.includes('advertiser')) return 'ads';
  return 'mobility';
}

export function pickTables(question: string, workspace: string): string[] {
  return [...(WORKSPACE_TABLES[workspace] ?? ['trips'])];
}

export function promptTokens(schemas: string[]): number {
  return Math.floor(schemas.reduce((n, s) => n + s.length, 0) / 4);
}

export function pruneColumns(question: string, schemas: string[]): string[] {
  return schemas.map(schema => {
    const at = schema.indexOf(' (');
    const kept = schema
      .slice(at + 2, -1)
      .split(', ')
      .filter(c => !c.startsWith('attr_'));
    return \`\${schema.slice(0, at)} (\${kept.join(', ')})\`;
  });
}

export function generate(question: string, workspace: string, schemas: string[]): string {
  if (question.startsWith('garbled:')) return 'Sure! Here is the SQL you asked for:\\nSELECT * FROM trips';
  if (question.startsWith('nosql:')) return JSON.stringify({explanation: 'No table answers that question.'});
  if (question.startsWith('blank:')) return JSON.stringify({sql: '', explanation: ''});
  const table = schemas.length > 0 ? schemas[0].split(' ')[2] : 'trips';
  return JSON.stringify({sql: \`SELECT * FROM \${table} WHERE datestr = '2026-11-01'\`, explanation: \`Rows of \${table} for 2026-11-01.\`});
}
`,
  'querygen/warehouse.ts': `/**
 * The stand-in for the warehouse. The checks serve it over gRPC (sqlagents.Warehouse at
 * querygen/config's WAREHOUSE). It does not parse SQL: it answers ROWS_PER_DAY rows of (datestr,
 * trip_uuid), fewer when the statement ends in a smaller LIMIT, and none for the hallucinated filter
 * status = 'Finished' (the trips table says 'completed').
 */
export const COLUMNS = ['datestr', 'trip_uuid'];
export const ROWS_PER_DAY = 2500;

export function execute(sql: string): string[][] {
  if (sql.includes("'Finished'")) return [];
  const m = /\\blimit\\s+(\\d+)\\s*;?\\s*$/i.exec(sql.trim());
  const n = m === null ? ROWS_PER_DAY : Math.min(Number(m[1]), ROWS_PER_DAY);
  return Array.from({length: n}, (_, i) => ['2026-11-01', \`trip-\${String(i + 1).padStart(5, '0')}\`]);
}
`,
};

/** The Go twins: querygen/config, querygen/queries, querygen/catalog, querygen/agents, querygen/warehouse. */
export const supportModulesGo: Record<string, string> = {
  'querygen/config/config.go': `// Package config holds the addresses, topics and names every step of querygen agrees on.
package config

import "time"

const (
	// Agents serves Intent, PickTables, PruneColumns and Generate: a stand-in served by the checks (querygen/agents).
	Agents = "agents:9000"
	// Warehouse serves Execute: a stand-in served by the checks (querygen/warehouse).
	Warehouse = "warehouse:9000"
	// Topic carries feedback events with the evaluation signals, keyed by user, for the eval consumer.
	Topic = "query.feedback"
	// PartitionColumn: every warehouse table is partitioned by day on this column.
	PartitionColumn = "datestr"
	// Per-call deadlines: the classifying agents (Intent, PickTables, PruneColumns) and Generate.
	AgentDeadline    = 10 * time.Second
	GenerateDeadline = 30 * time.Second
)

// SystemWorkspaces are the curated system workspaces a question may be answered from.
var SystemWorkspaces = map[string]bool{"mobility": true, "ads": true, "core-services": true, "platform-engineering": true, "it": true}

// Keys in Redis. query:{query_id} and idem:{user}:{key} belong to the query store (querygen/queries);
// decision:{workspace}:{qhash} and budget:{user} to step 2; eval:{workspace} to step 5's consumer.
`,
  'querygen/queries/queries.go': `// Package queries is the query store (provided): query records in Redis, by id and by
// (user, Idempotency-Key).
package queries

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

const TTL = 7 * 24 * time.Hour

// Record is one question's life: proposed, ACKed, generated, run.
type Record struct {
	QueryID        string   \`json:"query_id"\`
	User           string   \`json:"user"\`
	Workspace      string   \`json:"workspace"\`
	Question       string   \`json:"question"\`
	Status         string   \`json:"status"\` // pending_ack, generated or ran
	TablesProposed []string \`json:"tables_proposed"\`
	TablesAcked    []string \`json:"tables_acked"\`
	SQL            string   \`json:"sql"\`
	RunOK          bool     \`json:"run_ok"\`
	HasOutput      bool     \`json:"has_output"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Find is the record user created under idemKey; nil when there is none.
func Find(ctx context.Context, user, idemKey string) (*Record, error) {
	id, err := rdb.Get(ctx, "idem:"+user+":"+idemKey).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return Get(ctx, id)
}

// Put stores a new record under its id and under (user, idemKey).
func Put(ctx context.Context, user, idemKey string, rec Record) error {
	if err := Save(ctx, rec); err != nil {
		return err
	}
	return rdb.Set(ctx, "idem:"+user+":"+idemKey, rec.QueryID, TTL).Err()
}

// Get is the record; nil when there is none.
func Get(ctx context.Context, queryID string) (*Record, error) {
	raw, err := rdb.Get(ctx, "query:"+queryID).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var rec Record
	if err := json.Unmarshal(raw, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// Save writes the record back under its id.
func Save(ctx context.Context, rec Record) error {
	if rec.TablesProposed == nil {
		rec.TablesProposed = []string{}
	}
	if rec.TablesAcked == nil {
		rec.TablesAcked = []string{}
	}
	doc, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, "query:"+rec.QueryID, doc, TTL).Err()
}
`,
  'querygen/catalog/catalog.go': `// Package catalog is the workspace catalog (provided): a table's DDL as the generator sees it.
// Tier-1 tables (the "_tier1" suffix) carry thousands of attribute columns: about 18 000 tokens of
// DDL each.
package catalog

import (
	"fmt"
	"strings"
)

const (
	Tier1Suffix     = "_tier1"
	Tier1Attributes = 4000
)

var Columns = map[string][]string{
	"trips":        {"datestr STRING", "trip_uuid STRING", "city_id BIGINT", "driver_uuid STRING", "rider_uuid STRING", "status STRING", "fare_usd DOUBLE"},
	"drivers":      {"datestr STRING", "driver_uuid STRING", "city_id BIGINT", "vehicle_type STRING", "rating DOUBLE"},
	"riders":       {"datestr STRING", "rider_uuid STRING", "city_id BIGINT", "signup_channel STRING"},
	"cities":       {"datestr STRING", "city_id BIGINT", "city_name STRING", "country_code STRING"},
	"ad_campaigns": {"datestr STRING", "campaign_id STRING", "advertiser_id STRING", "spend_usd DOUBLE", "impressions BIGINT"},
}

// SchemaFor is CREATE TABLE <table> (<column TYPE>, ...).
func SchemaFor(table string) string {
	tier1 := strings.HasSuffix(table, Tier1Suffix)
	base := strings.TrimSuffix(table, Tier1Suffix)
	columns, ok := Columns[base]
	if !ok {
		columns = []string{"datestr STRING"}
	}
	columns = append([]string{}, columns...)
	if tier1 {
		for i := 1; i <= Tier1Attributes; i++ {
			columns = append(columns, fmt.Sprintf("attr_%04d STRING", i))
		}
	}
	return "CREATE TABLE " + table + " (" + strings.Join(columns, ", ") + ")"
}
`,
  'querygen/agents/agents.go': `// Package agents is the stand-in for the model agents. The checks serve it over gRPC
// (sqlagents.Agents at config.Agents); querygen's code never calls it directly. Deterministic on
// purpose.
//
//	Intent(question): "hr-payroll" (not a system workspace) for "offtopic:", "ads" for a campaign or an advertiser, else "mobility"
//	PickTables(question, workspace): the workspace's tables from WorkspaceTables
//	PruneColumns(question, schemas): each schema without its attr_* columns
//	Generate(question, workspace, schemas): JSON {"sql", "explanation"} over the first schema's table;
//	  "garbled:" gets prose, "nosql:" JSON without sql, "blank:" an empty sql. A prompt whose
//	  schemas exceed ContextLimitTokens is refused with INVALID_ARGUMENT.
package agents

import (
	"encoding/json"
	"strings"
)

const ContextLimitTokens = 32_000

var WorkspaceTables = map[string][]string{
	"mobility":             {"trips", "drivers"},
	"ads":                  {"ad_campaigns"},
	"core-services":        {"cities"},
	"platform-engineering": {"trips"},
	"it":                   {"riders"},
}

func Intent(question string) string {
	q := strings.ToLower(question)
	if strings.HasPrefix(q, "offtopic:") {
		return "hr-payroll"
	}
	if strings.Contains(q, "campaign") || strings.Contains(q, "advertiser") {
		return "ads"
	}
	return "mobility"
}

func PickTables(question, workspace string) []string {
	tables, ok := WorkspaceTables[workspace]
	if !ok {
		return []string{"trips"}
	}
	return append([]string{}, tables...)
}

func PromptTokens(schemas []string) int {
	n := 0
	for _, s := range schemas {
		n += len(s)
	}
	return n / 4
}

func PruneColumns(question string, schemas []string) []string {
	pruned := make([]string, 0, len(schemas))
	for _, schema := range schemas {
		at := strings.Index(schema, " (")
		var kept []string
		for _, c := range strings.Split(schema[at+2:len(schema)-1], ", ") {
			if !strings.HasPrefix(c, "attr_") {
				kept = append(kept, c)
			}
		}
		pruned = append(pruned, schema[:at]+" ("+strings.Join(kept, ", ")+")")
	}
	return pruned
}

func Generate(question, workspace string, schemas []string) string {
	switch {
	case strings.HasPrefix(question, "garbled:"):
		return "Sure! Here is the SQL you asked for:\\nSELECT * FROM trips"
	case strings.HasPrefix(question, "nosql:"):
		return \`{"explanation": "No table answers that question."}\`
	case strings.HasPrefix(question, "blank:"):
		return \`{"sql": "", "explanation": ""}\`
	}
	table := "trips"
	if len(schemas) > 0 {
		table = strings.Split(schemas[0], " ")[2]
	}
	out, _ := json.Marshal(map[string]string{"sql": "SELECT * FROM " + table + " WHERE datestr = '2026-11-01'", "explanation": "Rows of " + table + " for 2026-11-01."})
	return string(out)
}
`,
  'querygen/warehouse/warehouse.go': `// Package warehouse is the stand-in for the warehouse. The checks serve it over gRPC
// (sqlagents.Warehouse at config.Warehouse). It does not parse SQL: it answers RowsPerDay rows of
// (datestr, trip_uuid), fewer when the statement ends in a smaller LIMIT, and none for the
// hallucinated filter status = 'Finished' (the trips table says 'completed').
package warehouse

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

const RowsPerDay = 2500

var Columns = []string{"datestr", "trip_uuid"}

var trailingLimit = regexp.MustCompile(\`(?i)\\blimit\\s+(\\d+)\\s*;?\\s*$\`)

func Execute(sql string) [][]string {
	if strings.Contains(sql, "'Finished'") {
		return [][]string{}
	}
	n := RowsPerDay
	if m := trailingLimit.FindStringSubmatch(strings.TrimSpace(sql)); m != nil {
		if limit, err := strconv.Atoi(m[1]); err == nil && limit < n {
			n = limit
		}
	}
	rows := make([][]string, 0, n)
	for i := 1; i <= n; i++ {
		rows = append(rows, []string{"2026-11-01", fmt.Sprintf("trip-%05d", i)})
	}
	return rows
}
`,
};

/** The C++ twins as headers (querygen/*.h), plus digest.h (SHA-256) and ids.h (UUIDs). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'ids.h': CPP_IDS_H,
  'querygen/config.h': `// Addresses, topics and names every step of querygen agrees on.
#pragma once

#include <chrono>
#include <set>
#include <string>

#include <sw/redis++/redis++.h>

namespace config {

// The agents (Intent, PickTables, PruneColumns, Generate): a stand-in served by the checks (querygen/agents.h).
inline constexpr const char* kAgents = "agents:9000";
// The warehouse (Execute): a stand-in served by the checks (querygen/warehouse.h).
inline constexpr const char* kWarehouse = "warehouse:9000";
// Feedback events with the evaluation signals, keyed by user, for the eval consumer.
inline constexpr const char* kTopic = "query.feedback";
// Every warehouse table is partitioned by day on this column.
inline constexpr const char* kPartitionColumn = "datestr";
// Per-call deadlines: the classifying agents (Intent, PickTables, PruneColumns) and Generate.
inline constexpr std::chrono::seconds kAgentDeadline{10};
inline constexpr std::chrono::seconds kGenerateDeadline{30};
// The curated system workspaces a question may be answered from.
inline const std::set<std::string> kSystemWorkspaces = {"mobility", "ads", "core-services", "platform-engineering", "it"};

// Keys in Redis. query:{query_id} and idem:{user}:{key} belong to the query store (querygen/queries.h);
// decision:{workspace}:{qhash} and budget:{user} to step 2; eval:{workspace} to step 5's consumer.

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'querygen/queries.h': `// The query store (provided): query records in Redis, by id and by (user, Idempotency-Key).
// A record is a JSON object: query_id, user, workspace, question, status (pending_ack, generated,
// ran), tables_proposed, tables_acked, sql, run_ok, has_output.
#pragma once

#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "querygen/config.h"

namespace queries {

inline constexpr long long kTtlSeconds = 7 * 86400;

// The record, nullopt when there is none.
inline std::optional<nlohmann::json> get(const std::string& query_id) {
  const auto raw = config::redis().get("query:" + query_id);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// The record this user created under idem_key, if any.
inline std::optional<nlohmann::json> find(const std::string& user, const std::string& idem_key) {
  const auto query_id = config::redis().get("idem:" + user + ":" + idem_key);
  if (!query_id) return std::nullopt;
  return get(*query_id);
}

// Write the record back under its id.
inline void save(const nlohmann::json& record) {
  config::redis().set("query:" + record.at("query_id").get<std::string>(), record.dump(), std::chrono::seconds(kTtlSeconds));
}

// Store a new record under its id and under (user, idem_key).
inline void put(const std::string& user, const std::string& idem_key, const nlohmann::json& record) {
  save(record);
  config::redis().set("idem:" + user + ":" + idem_key, record.at("query_id").get<std::string>(), std::chrono::seconds(kTtlSeconds));
}

}  // namespace queries
`,
  'querygen/catalog.h': `// The workspace catalog (provided): a table's DDL as the generator sees it. Tier-1 tables (the
// "_tier1" suffix) carry thousands of attribute columns: about 18 000 tokens of DDL each.
#pragma once

#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace catalog {

inline const std::string kTier1Suffix = "_tier1";
inline constexpr int kTier1Attributes = 4000;

inline const std::map<std::string, std::vector<std::string>> kColumns = {
    {"trips", {"datestr STRING", "trip_uuid STRING", "city_id BIGINT", "driver_uuid STRING", "rider_uuid STRING", "status STRING", "fare_usd DOUBLE"}},
    {"drivers", {"datestr STRING", "driver_uuid STRING", "city_id BIGINT", "vehicle_type STRING", "rating DOUBLE"}},
    {"riders", {"datestr STRING", "rider_uuid STRING", "city_id BIGINT", "signup_channel STRING"}},
    {"cities", {"datestr STRING", "city_id BIGINT", "city_name STRING", "country_code STRING"}},
    {"ad_campaigns", {"datestr STRING", "campaign_id STRING", "advertiser_id STRING", "spend_usd DOUBLE", "impressions BIGINT"}},
};

// CREATE TABLE <table> (<column TYPE>, ...).
inline std::string schema_for(const std::string& table) {
  const bool tier1 = table.size() > kTier1Suffix.size() &&
                     table.compare(table.size() - kTier1Suffix.size(), kTier1Suffix.size(), kTier1Suffix) == 0;
  const std::string base = tier1 ? table.substr(0, table.size() - kTier1Suffix.size()) : table;
  const auto it = kColumns.find(base);
  std::vector<std::string> columns = it == kColumns.end() ? std::vector<std::string>{"datestr STRING"} : it->second;
  if (tier1) {
    char name[32];
    for (int i = 1; i <= kTier1Attributes; i++) {
      std::snprintf(name, sizeof name, "attr_%04d STRING", i);
      columns.emplace_back(name);
    }
  }
  std::string ddl = "CREATE TABLE " + table + " (";
  for (size_t i = 0; i < columns.size(); i++) ddl += (i == 0 ? "" : ", ") + columns[i];
  return ddl + ")";
}

}  // namespace catalog
`,
  'querygen/agents.h': `// The stand-in for the model agents. The checks serve it over gRPC (sqlagents::Agents at
// config::kAgents); querygen's code never calls it directly. Deterministic on purpose.
//
// intent(question): "hr-payroll" (not a system workspace) for "offtopic:", "ads" for a campaign or an
//   advertiser, "mobility" otherwise
// pick_tables(question, workspace): the workspace's tables from kWorkspaceTables
// prune_columns(question, schemas): each schema without its attr_* columns
// generate(question, workspace, schemas): JSON {"sql", "explanation"} over the first schema's table;
//   "garbled:" gets prose, "nosql:" JSON without sql, "blank:" an empty sql. A prompt whose schemas
//   exceed kContextLimitTokens is refused with INVALID_ARGUMENT.
#pragma once

#include <algorithm>
#include <cctype>
#include <map>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace agents {

inline constexpr long long kContextLimitTokens = 32000;

inline const std::map<std::string, std::vector<std::string>> kWorkspaceTables = {
    {"mobility", {"trips", "drivers"}}, {"ads", {"ad_campaigns"}}, {"core-services", {"cities"}},
    {"platform-engineering", {"trips"}}, {"it", {"riders"}},
};

inline bool starts_with(const std::string& s, const std::string& prefix) { return s.rfind(prefix, 0) == 0; }

inline std::string intent(const std::string& question) {
  std::string q = question;
  std::transform(q.begin(), q.end(), q.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (starts_with(q, "offtopic:")) return "hr-payroll";
  if (q.find("campaign") != std::string::npos || q.find("advertiser") != std::string::npos) return "ads";
  return "mobility";
}

inline std::vector<std::string> pick_tables(const std::string&, const std::string& workspace) {
  const auto it = kWorkspaceTables.find(workspace);
  return it == kWorkspaceTables.end() ? std::vector<std::string>{"trips"} : it->second;
}

inline long long prompt_tokens(const std::vector<std::string>& schemas) {
  long long n = 0;
  for (const auto& s : schemas) n += static_cast<long long>(s.size());
  return n / 4;
}

inline std::vector<std::string> prune_columns(const std::string&, const std::vector<std::string>& schemas) {
  std::vector<std::string> pruned;
  for (const auto& schema : schemas) {
    const size_t at = schema.find(" (");
    const std::string inner = schema.substr(at + 2, schema.size() - at - 3);
    std::string kept;
    size_t start = 0;
    while (start <= inner.size()) {
      size_t comma = inner.find(", ", start);
      if (comma == std::string::npos) comma = inner.size();
      const std::string column = inner.substr(start, comma - start);
      if (!starts_with(column, "attr_")) kept += (kept.empty() ? "" : ", ") + column;
      start = comma + 2;
    }
    pruned.push_back(schema.substr(0, at) + " (" + kept + ")");
  }
  return pruned;
}

inline std::string generate(const std::string& question, const std::string&, const std::vector<std::string>& schemas) {
  if (starts_with(question, "garbled:")) return "Sure! Here is the SQL you asked for:\\nSELECT * FROM trips";
  if (starts_with(question, "nosql:")) return nlohmann::json{{"explanation", "No table answers that question."}}.dump();
  if (starts_with(question, "blank:")) return nlohmann::json{{"sql", ""}, {"explanation", ""}}.dump();
  std::string table = "trips";
  if (!schemas.empty()) {
    const std::string& s = schemas[0];
    const size_t from = std::string("CREATE TABLE ").size();
    table = s.substr(from, s.find(' ', from) - from);
  }
  return nlohmann::json{{"sql", "SELECT * FROM " + table + " WHERE datestr = '2026-11-01'"},
                        {"explanation", "Rows of " + table + " for 2026-11-01."}}
      .dump();
}

}  // namespace agents
`,
  'querygen/warehouse.h': `// The stand-in for the warehouse. The checks serve it over gRPC (sqlagents::Warehouse at
// config::kWarehouse). It does not parse SQL: it answers kRowsPerDay rows of (datestr, trip_uuid),
// fewer when the statement ends in a smaller LIMIT, and none for the hallucinated filter
// status = 'Finished' (the trips table says 'completed').
#pragma once

#include <cstdio>
#include <regex>
#include <string>
#include <vector>

namespace warehouse {

inline constexpr int kRowsPerDay = 2500;
inline const std::vector<std::string> kColumns = {"datestr", "trip_uuid"};

inline std::vector<std::vector<std::string>> execute(const std::string& sql) {
  if (sql.find("'Finished'") != std::string::npos) return {};
  static const std::regex trailing_limit(R"(\\blimit\\s+(\\d+)\\s*;?\\s*$)", std::regex::icase);
  int n = kRowsPerDay;
  std::smatch m;
  const std::string trimmed = sql.substr(0, sql.find_last_not_of(" \\t\\r\\n") + 1);
  if (std::regex_search(trimmed, m, trailing_limit)) n = std::min(n, std::stoi(m[1].str()));
  std::vector<std::vector<std::string>> rows;
  char id[16];
  for (int i = 1; i <= n; i++) {
    std::snprintf(id, sizeof id, "trip-%05d", i);
    rows.push_back({"2026-11-01", id});
  }
  return rows;
}

}  // namespace warehouse
`,
};

/** The Scala twins: the \`querygen\` objects the steps import, compiled with them by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('querygen', 'Config')]: `package querygen

/** Addresses, topics and names every step of querygen agrees on. */
object Config {
  /** The agents (Intent, PickTables, PruneColumns, Generate): a stand-in served by the checks. */
  val Agents = "agents:9000"
  /** The warehouse (Execute): a stand-in served by the checks. */
  val Warehouse = "warehouse:9000"
  /** Feedback events with the evaluation signals, keyed by user, for the eval consumer. */
  val Topic = "query.feedback"
  /** The curated system workspaces a question may be answered from. */
  val SystemWorkspaces: Set[String] = Set("mobility", "ads", "core-services", "platform-engineering", "it")
  /** Every warehouse table is partitioned by day on this column. */
  val PartitionColumn = "datestr"
  /** Per-call deadlines: the classifying agents (Intent, PickTables, PruneColumns) and Generate. */
  val AgentDeadlineMs = 10000L
  val GenerateDeadlineMs = 30000L

  // Keys in Redis. query:{query_id} and idem:{user}:{key} belong to the query store (Queries);
  // decision:{workspace}:{qhash} and budget:{user} to step 2; eval:{workspace} to step 5's consumer.
}
`,
  [scalaPath('querygen', 'Queries')]: `package querygen

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/** One question's life: proposed, ACKed, generated, run. status is pending_ack, generated or ran. */
final case class QueryRecord(
    query_id: String,
    user: String,
    workspace: String,
    question: String,
    status: String,
    tables_proposed: List[String],
    tables_acked: List[String],
    sql: String,
    run_ok: Boolean,
    has_output: Boolean
)

/** The query store (provided): query records in Redis, by id and by (user, Idempotency-Key). */
object Queries {
  val TtlSeconds: Long = 7L * 86400
  private val jedis = new JedisPooled("redis", 6379)

  def encode(r: QueryRecord): String = ujson.write(
    ujson.Obj(
      "query_id" -> r.query_id,
      "user" -> r.user,
      "workspace" -> r.workspace,
      "question" -> r.question,
      "status" -> r.status,
      "tables_proposed" -> ujson.Arr.from(r.tables_proposed.map(ujson.Str(_))),
      "tables_acked" -> ujson.Arr.from(r.tables_acked.map(ujson.Str(_))),
      "sql" -> r.sql,
      "run_ok" -> r.run_ok,
      "has_output" -> r.has_output
    )
  )

  def decode(raw: String): QueryRecord = {
    val j = ujson.read(raw)
    QueryRecord(
      j("query_id").str,
      j("user").str,
      j("workspace").str,
      j("question").str,
      j("status").str,
      j("tables_proposed").arr.map(_.str).toList,
      j("tables_acked").arr.map(_.str).toList,
      j("sql").str,
      j("run_ok").bool,
      j("has_output").bool
    )
  }

  /** The record this user created under idemKey, if any. */
  def find(user: String, idemKey: String): Option[QueryRecord] =
    Option(jedis.get(s"idem:$user:$idemKey")).flatMap(get)

  /** Store a new record under its id and under (user, idemKey). */
  def put(user: String, idemKey: String, record: QueryRecord): Unit = {
    save(record)
    jedis.set(s"idem:$user:$idemKey", record.query_id, SetParams.setParams().ex(TtlSeconds))
    ()
  }

  /** The record, None when there is none. */
  def get(queryId: String): Option[QueryRecord] = Option(jedis.get(s"query:$queryId")).map(decode)

  /** Write the record back under its id. */
  def save(record: QueryRecord): Unit = {
    jedis.set(s"query:\${record.query_id}", encode(record), SetParams.setParams().ex(TtlSeconds))
    ()
  }
}
`,
  [scalaPath('querygen', 'Catalog')]: `package querygen

/**
 * The workspace catalog (provided): a table's DDL as the generator sees it. Tier-1 tables (the
 * "_tier1" suffix) carry thousands of attribute columns: about 18 000 tokens of DDL each.
 */
object Catalog {
  val Tier1Suffix = "_tier1"
  val Tier1Attributes = 4000

  val Columns: Map[String, List[String]] = Map(
    "trips" -> List("datestr STRING", "trip_uuid STRING", "city_id BIGINT", "driver_uuid STRING", "rider_uuid STRING", "status STRING", "fare_usd DOUBLE"),
    "drivers" -> List("datestr STRING", "driver_uuid STRING", "city_id BIGINT", "vehicle_type STRING", "rating DOUBLE"),
    "riders" -> List("datestr STRING", "rider_uuid STRING", "city_id BIGINT", "signup_channel STRING"),
    "cities" -> List("datestr STRING", "city_id BIGINT", "city_name STRING", "country_code STRING"),
    "ad_campaigns" -> List("datestr STRING", "campaign_id STRING", "advertiser_id STRING", "spend_usd DOUBLE", "impressions BIGINT")
  )

  /** CREATE TABLE <table> (<column TYPE>, ...). */
  def schemaFor(table: String): String = {
    val tier1 = table.endsWith(Tier1Suffix)
    val base = if (tier1) table.dropRight(Tier1Suffix.length) else table
    val columns = Columns.getOrElse(base, List("datestr STRING")) ++
      (if (tier1) (1 to Tier1Attributes).map(i => f"attr_$i%04d STRING") else Nil)
    s"CREATE TABLE $table (\${columns.mkString(", ")})"
  }
}
`,
};
