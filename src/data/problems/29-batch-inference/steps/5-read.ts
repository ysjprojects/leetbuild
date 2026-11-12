import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/batches/{id}: a status read from the shard set',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'batchd', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/batches/{batch_id}\`: 401 without \`X-Tenant-Id\`, the batch
from \`store.by_id\` (404 when there is none), shard counts from \`HGETALL batch:shards:{id}\`, the outputs
from \`batch:outputs:{id}\` sorted by shard, \`status\` \`completed\` once \`batch:pending:{id}\` is empty and
\`in_progress\` before, and \`request_counts\` of \`SHARD_SIZE\` records per done or failed shard. A finished
demo batch reads right. It hides 4 flaws.

**Failure mode the checks target.** The status is what the tenant acts on. An empty pending list
means every shard was claimed, not that every shard finished, so the read says \`completed\` while
workers still run and the tenant downloads half the outputs. A batch with a failed shard is not a
success. Record counts derived from shard counts invent a thousand records per shard. And a batch id is
not a secret: another tenant can read the output URIs.

Requirements:

- A batch that exists but belongs to another tenant is **404**, as an unknown id is.
- \`shards\`: \`{total, pending, running, done, failed}\` from the shard set.
- \`status\`: \`in_progress\` while any shard is \`pending\` or \`running\`; then \`partial\` when any shard
  \`failed\`; \`completed\` only when every shard is \`done\`.
- \`request_counts\`: \`total\` is the batch's \`record_count\`; \`completed\` and \`failed\` come from
  \`batch:totals:{id}\`, the coordinator's folded counts.
- \`outputs\`: \`[{shard_id, uri, checksum}]\` from \`batch:outputs:{id}\`, by shard.`,
  sequence: {
    participants: ['Client', 'batchd', 'Redis'],
    messages: [
      {from: 'Client', to: 'batchd', label: 'GET /v1/batches/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'batchd', to: 'Redis', label: 'store.by_id(id) · tenant matches', kind: 'sync'},
      {from: 'batchd', to: 'Redis', label: 'HGETALL shards · totals · outputs', kind: 'sync'},
      {from: 'Redis', to: 'batchd', label: 'shard states · folded counts · entries', kind: 'reply'},
      {from: 'batchd', to: 'Client', label: '200 {status, shards, request_counts, outputs}', kind: 'reply'},
    ],
  },
  hints: [
    'Symptom: a batch reads `completed` while two of its shards are still running, a batch with a failed shard reads `completed` too, a 2500-record batch reports 3000 completed records, and another tenant can read the batch by id.',
    'Mechanism: the status looks at the pending list, which empties when the last shard is claimed; nothing turns a failed shard into anything but done; `request_counts` multiplies shard counts by `SHARD_SIZE`; and the tenant header is checked for presence only.',
    'Change: 404 when `job["tenant"] != tenant`; status from the shard counts (`pending` or `running` → `in_progress`, else `failed` → `partial`, else `completed`); `request_counts` from `HGETALL batch:totals:{id}` with `total = record_count`.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/batches/{id}',
      detail:
        'A batch with one shard done, one running and one pending answers 200 with status in_progress, the shard counts, request_counts with total and the outputs of the folded shard; an unknown id is 404 and a request without X-Tenant-Id is 401.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/batches\/\{batch_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/batches\/:batch_id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/batches\/\{batch_id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"batches"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^,\n]*v1\/batches\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Answers 404 for another tenant's batch",
      detail:
        'A batch submitted by t1 read with X-Tenant-Id t2 is 404, the same answer as an unknown id, so the output URIs stay with their tenant. The starter answers whoever asks.',
      match: {
        python: {
          all: [
            /\[\s*["']tenant["']\s*\]\s*!=\s*tenant|tenant\s*!=\s*\w+\[\s*["']tenant["']\s*\]|\.get\(\s*["']tenant["']\s*\)\s*!=\s*tenant/,
          ],
        },
        typescript: {all: [/\.tenant\s*!==\s*tenant|tenant\s*!==\s*\w+\.tenant/]},
        go: {all: [/\.Tenant\s*!=\s*tenant|tenant\s*!=\s*\w+\.Tenant/]},
        scala: {all: [/\.tenant\s*(!=|==)\s*tenant|tenant\s*(!=|==)\s*\w+\.tenant/]},
        cpp: {all: [/value\(\s*"tenant"[^)]*\)\s*!=\s*tenant|\[\s*"tenant"\s*\]\s*!=\s*tenant/]},
      },
    },
    {
      id: 'running-not-finished',
      title: 'Not completed while shards still run',
      detail:
        'With one shard done, two running and the pending list empty, the status is in_progress, not completed. The starter reads an empty pending list as a finished batch.',
      match: {
        python: {all: [/["']running["']/], none: [/\.llen\(/]},
        typescript: {all: [/['"]running['"]|\.running\b/], none: [/\.llen\(/]},
        go: {all: [/"running"/], none: [/\.LLen\(/]},
        scala: {all: [/"running"/], none: [/\.llen\(/]},
        cpp: {all: [/"running"/], none: [/\.llen\(/]},
      },
    },
    {
      id: 'failures-partial',
      title: 'A batch with a failed shard is partial',
      detail:
        'With every shard terminal and one of them failed, the status is partial; completed means every shard is done. The starter calls it completed.',
      match: {
        python: {all: [/["']partial["']/]},
        typescript: {all: [/['"]partial['"]/]},
        go: {all: [/"partial"/]},
        scala: {all: [/"partial"/]},
        cpp: {all: [/"partial"/]},
      },
    },
    {
      id: 'record-counts',
      title: 'Counts records from the folded totals',
      detail:
        'A 2500-record batch whose three shards are done, with batch:totals holding completed 2497 and failed 3, reports request_counts {total 2500, completed 2497, failed 3}. The starter reports SHARD_SIZE records per shard, 3000 completed.',
      match: {
        python: {all: [/totals_key\(|batch:totals:/], none: [/\*\s*SHARD_SIZE/]},
        typescript: {all: [/totalsKey\(|batch:totals:/], none: [/\*\s*SHARD_SIZE/]},
        go: {all: [/TotalsKey\(|batch:totals:/], none: [/\*\s*config\.ShardSize/]},
        scala: {all: [/totalsKey\(|batch:totals:/], none: [/\*\s*Config\.ShardSize/]},
        cpp: {all: [/totals_key\(|batch:totals:/], none: [/\*\s*config::kShardSize/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from batch.config import SHARD_SIZE, outputs_key, pending_key, shards_key
from batch.jobs import store

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/batches/{batch_id}")
def get_batch(batch_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    job = store.by_id(batch_id)
    if job is None:
        return JSONResponse({"error": "no such batch"}, status_code=404)
    counts = {"pending": 0, "running": 0, "done": 0, "failed": 0}
    for state in r.hgetall(shards_key(batch_id)).values():
        counts[state] += 1
    status = "completed" if r.llen(pending_key(batch_id)) == 0 else "in_progress"
    entries = sorted((int(shard), json.loads(entry)) for shard, entry in r.hgetall(outputs_key(batch_id)).items())
    return JSONResponse(
        {
            "batch_id": batch_id,
            "status": status,
            "model": job["model"],
            "shards": {"total": job["shards"], **counts},
            "request_counts": {"total": job["record_count"], "completed": counts["done"] * SHARD_SIZE, "failed": counts["failed"] * SHARD_SIZE},
            "outputs": [{"shard_id": shard, "uri": entry["uri"], "checksum": entry["checksum"]} for shard, entry in entries],
        }
    )
`,
      solution: `import json

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from batch.config import outputs_key, shards_key, totals_key
from batch.jobs import store

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/batches/{batch_id}")
def get_batch(batch_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    job = store.by_id(batch_id)
    if job is None or job["tenant"] != tenant:
        return JSONResponse({"error": "no such batch"}, status_code=404)
    counts = {"pending": 0, "running": 0, "done": 0, "failed": 0}
    for state in r.hgetall(shards_key(batch_id)).values():
        counts[state] += 1
    if counts["pending"] or counts["running"]:
        status = "in_progress"
    elif counts["failed"]:
        status = "partial"
    else:
        status = "completed"
    totals = r.hgetall(totals_key(batch_id))
    entries = sorted((int(shard), json.loads(entry)) for shard, entry in r.hgetall(outputs_key(batch_id)).items())
    return JSONResponse(
        {
            "batch_id": batch_id,
            "status": status,
            "model": job["model"],
            "shards": {"total": job["shards"], **counts},
            "request_counts": {"total": job["record_count"], "completed": int(totals.get("completed", 0)), "failed": int(totals.get("failed", 0))},
            "outputs": [{"shard_id": shard, "uri": entry["uri"], "checksum": entry["checksum"]} for shard, entry in entries],
        }
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {SHARD_SIZE, outputsKey, pendingKey, shardsKey} from 'batch/config';
import {store} from 'batch/jobs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/batches/:batch_id', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {batch_id: batchId} = request.params as {batch_id: string};
  const job = await store.byId(batchId);
  if (job === null) return reply.code(404).send({error: 'no such batch'});
  const counts: Record<string, number> = {pending: 0, running: 0, done: 0, failed: 0};
  for (const state of Object.values(await redis.hgetall(shardsKey(batchId)))) counts[state] += 1;
  const status = (await redis.llen(pendingKey(batchId))) === 0 ? 'completed' : 'in_progress';
  const entries = Object.entries(await redis.hgetall(outputsKey(batchId)))
    .map(([shard, entry]) => ({shard_id: Number(shard), ...(JSON.parse(entry) as {uri: string; checksum: string})}))
    .sort((a, b) => a.shard_id - b.shard_id);
  return reply.send({
    batch_id: batchId,
    status,
    model: job.model,
    shards: {total: job.shards, ...counts},
    request_counts: {total: job.record_count, completed: counts.done * SHARD_SIZE, failed: counts.failed * SHARD_SIZE},
    outputs: entries.map(e => ({shard_id: e.shard_id, uri: e.uri, checksum: e.checksum})),
  });
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {outputsKey, shardsKey, totalsKey} from 'batch/config';
import {store} from 'batch/jobs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/batches/:batch_id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {batch_id: batchId} = request.params as {batch_id: string};
  const job = await store.byId(batchId);
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'no such batch'});
  const counts: Record<string, number> = {pending: 0, running: 0, done: 0, failed: 0};
  for (const state of Object.values(await redis.hgetall(shardsKey(batchId)))) counts[state] += 1;
  let status = 'completed';
  if (counts.pending > 0 || counts['running'] > 0) status = 'in_progress';
  else if (counts.failed > 0) status = 'partial';
  const totals = await redis.hgetall(totalsKey(batchId));
  const entries = Object.entries(await redis.hgetall(outputsKey(batchId)))
    .map(([shard, entry]) => ({shard_id: Number(shard), ...(JSON.parse(entry) as {uri: string; checksum: string})}))
    .sort((a, b) => a.shard_id - b.shard_id);
  return reply.send({
    batch_id: batchId,
    status,
    model: job.model,
    shards: {total: job.shards, ...counts},
    request_counts: {total: job.record_count, completed: Number(totals.completed ?? 0), failed: Number(totals.failed ?? 0)},
    outputs: entries.map(e => ({shard_id: e.shard_id, uri: e.uri, checksum: e.checksum})),
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"

	"github.com/redis/go-redis/v9"

	"batch/config" // config.ShardSize, config.ShardsKey/PendingKey/OutputsKey/TotalsKey — provided
	"batch/jobs"   // jobs.ByID(ctx, batchID) → *jobs.Job (with Tenant), nil when absent — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type outputEntry struct {
	ShardID  int    \`json:"shard_id"\`
	URI      string \`json:"uri"\`
	Checksum string \`json:"checksum"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// outputsOf is the folded output entries of a batch, by shard.
func outputsOf(ctx context.Context, batchID string) []outputEntry {
	out := []outputEntry{}
	for shard, raw := range rdb.HGetAll(ctx, config.OutputsKey(batchID)).Val() {
		e := outputEntry{}
		json.Unmarshal([]byte(raw), &e)
		e.ShardID, _ = strconv.Atoi(shard)
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ShardID < out[j].ShardID })
	return out
}

func getBatch(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	batchID := r.PathValue("batch_id")
	job, err := jobs.ByID(r.Context(), batchID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if job == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such batch"})
		return
	}
	counts := map[string]int{"pending": 0, "running": 0, "done": 0, "failed": 0}
	for _, state := range rdb.HGetAll(r.Context(), config.ShardsKey(batchID)).Val() {
		counts[state]++
	}
	status := "in_progress"
	if rdb.LLen(r.Context(), config.PendingKey(batchID)).Val() == 0 {
		status = "completed"
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"batch_id":       batchID,
		"status":         status,
		"model":          job.Model,
		"shards":         map[string]int{"total": job.Shards, "pending": counts["pending"], "running": counts["running"], "done": counts["done"], "failed": counts["failed"]},
		"request_counts": map[string]int{"total": job.RecordCount, "completed": counts["done"] * config.ShardSize, "failed": counts["failed"] * config.ShardSize},
		"outputs":        outputsOf(r.Context(), batchID),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/batches/{batch_id}", getBatch)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"

	"github.com/redis/go-redis/v9"

	"batch/config" // config.ShardSize, config.ShardsKey/PendingKey/OutputsKey/TotalsKey — provided
	"batch/jobs"   // jobs.ByID(ctx, batchID) → *jobs.Job (with Tenant), nil when absent — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type outputEntry struct {
	ShardID  int    \`json:"shard_id"\`
	URI      string \`json:"uri"\`
	Checksum string \`json:"checksum"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// outputsOf is the folded output entries of a batch, by shard.
func outputsOf(ctx context.Context, batchID string) []outputEntry {
	out := []outputEntry{}
	for shard, raw := range rdb.HGetAll(ctx, config.OutputsKey(batchID)).Val() {
		e := outputEntry{}
		json.Unmarshal([]byte(raw), &e)
		e.ShardID, _ = strconv.Atoi(shard)
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ShardID < out[j].ShardID })
	return out
}

func getBatch(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	batchID := r.PathValue("batch_id")
	job, err := jobs.ByID(r.Context(), batchID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if job == nil || job.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such batch"})
		return
	}
	counts := map[string]int{"pending": 0, "running": 0, "done": 0, "failed": 0}
	for _, state := range rdb.HGetAll(r.Context(), config.ShardsKey(batchID)).Val() {
		counts[state]++
	}
	status := "completed"
	if counts["pending"] > 0 || counts["running"] > 0 {
		status = "in_progress"
	} else if counts["failed"] > 0 {
		status = "partial"
	}
	totals := rdb.HGetAll(r.Context(), config.TotalsKey(batchID)).Val()
	completed, _ := strconv.Atoi(totals["completed"])
	failed, _ := strconv.Atoi(totals["failed"])
	writeJSON(rw, http.StatusOK, map[string]any{
		"batch_id":       batchID,
		"status":         status,
		"model":          job.Model,
		"shards":         map[string]int{"total": job.Shards, "pending": counts["pending"], "running": counts["running"], "done": counts["done"], "failed": counts["failed"]},
		"request_counts": map[string]int{"total": job.RecordCount, "completed": completed, "failed": failed},
		"outputs":        outputsOf(r.Context(), batchID),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/batches/{batch_id}", getBatch)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import batch.{Config, Jobs}

object BatchStatus {
  implicit val system: ActorSystem = ActorSystem("batch-status")
  val jedis = new JedisPooled("redis", 6379)

  private def outputs(batchId: String): ujson.Arr =
    ujson.Arr.from(jedis.hgetAll(Config.outputsKey(batchId)).asScala.toList.map { case (s, raw) => s.toInt -> ujson.read(raw) }.sortBy(_._1).map {
      case (shard, entry) => ujson.Obj("shard_id" -> shard, "uri" -> entry("uri"), "checksum" -> entry("checksum"))
    })

  val route: Route =
    path("v1" / "batches" / Segment) { batchId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            Jobs.byId(batchId) match {
              case None => complete(StatusCodes.NotFound, """{"error":"no such batch"}""")
              case Some(row) =>
                val states = jedis.hgetAll(Config.shardsKey(batchId)).asScala.values.toList
                val counts = List("pending", "running", "done", "failed").map(s => s -> states.count(_ == s)).toMap
                val status = if (jedis.llen(Config.pendingKey(batchId)) == 0L) "completed" else "in_progress"
                val body = ujson.Obj(
                  "batch_id" -> batchId,
                  "status" -> status,
                  "model" -> row.job.model,
                  "shards" -> ujson.Obj(
                    "total" -> row.job.shards.toDouble,
                    "pending" -> counts("pending"),
                    "running" -> counts("running"),
                    "done" -> counts("done"),
                    "failed" -> counts("failed")
                  ),
                  "request_counts" -> ujson.Obj(
                    "total" -> row.job.record_count.toDouble,
                    "completed" -> (counts("done") * Config.ShardSize).toDouble,
                    "failed" -> (counts("failed") * Config.ShardSize).toDouble
                  ),
                  "outputs" -> outputs(batchId)
                )
                complete(HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))
            }
          }
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import batch.{Config, Jobs}

object BatchStatus {
  implicit val system: ActorSystem = ActorSystem("batch-status")
  val jedis = new JedisPooled("redis", 6379)

  private def outputs(batchId: String): ujson.Arr =
    ujson.Arr.from(jedis.hgetAll(Config.outputsKey(batchId)).asScala.toList.map { case (s, raw) => s.toInt -> ujson.read(raw) }.sortBy(_._1).map {
      case (shard, entry) => ujson.Obj("shard_id" -> shard, "uri" -> entry("uri"), "checksum" -> entry("checksum"))
    })

  val route: Route =
    path("v1" / "batches" / Segment) { batchId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            Jobs.byId(batchId).filter(_.tenant == tenantOpt.get) match {
              case None => complete(StatusCodes.NotFound, """{"error":"no such batch"}""")
              case Some(row) =>
                val states = jedis.hgetAll(Config.shardsKey(batchId)).asScala.values.toList
                val counts = List("pending", "running", "done", "failed").map(s => s -> states.count(_ == s)).toMap
                val status =
                  if (counts("pending") > 0 || counts("running") > 0) "in_progress"
                  else if (counts("failed") > 0) "partial"
                  else "completed"
                val totals = jedis.hgetAll(Config.totalsKey(batchId)).asScala
                val body = ujson.Obj(
                  "batch_id" -> batchId,
                  "status" -> status,
                  "model" -> row.job.model,
                  "shards" -> ujson.Obj(
                    "total" -> row.job.shards.toDouble,
                    "pending" -> counts("pending"),
                    "running" -> counts("running"),
                    "done" -> counts("done"),
                    "failed" -> counts("failed")
                  ),
                  "request_counts" -> ujson.Obj(
                    "total" -> row.job.record_count.toDouble,
                    "completed" -> totals.get("completed").map(_.toDouble).getOrElse[Double](0.0),
                    "failed" -> totals.get("failed").map(_.toDouble).getOrElse[Double](0.0)
                  ),
                  "outputs" -> outputs(batchId)
                )
                complete(HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))
            }
          }
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

#include <map>
#include <string>

#include "batch/config.h"  // config::kShardSize, config::shards_key/pending_key/outputs_key/totals_key — provided
#include "batch/jobs.h"    // jobs::by_id(batch_id) → the row with its tenant, nullopt when absent — provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// The folded output entries of a batch, by shard.
json outputs_of(const std::string& batch_id) {
  std::map<int, json> by_shard;
  for (const auto& [shard, raw] : redis.hgetall(config::outputs_key(batch_id))) by_shard[std::stoi(shard)] = json::parse(raw);
  json out = json::array();
  for (const auto& [shard, entry] : by_shard) out.push_back({{"shard_id", shard}, {"uri", entry.value("uri", "")}, {"checksum", entry.value("checksum", "")}});
  return out;
}

void get_batch(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const std::string batch_id = req.matches[1].str();
  const auto job = jobs::by_id(batch_id);
  if (!job) {
    res.status = 404;
    res.set_content(R"({"error":"no such batch"})", "application/json");
    return;
  }
  std::map<std::string, long long> counts = {{"pending", 0}, {"running", 0}, {"done", 0}, {"failed", 0}};
  for (const auto& [shard, state] : redis.hgetall(config::shards_key(batch_id))) counts[state]++;
  const std::string status = redis.llen(config::pending_key(batch_id)) == 0 ? "completed" : "in_progress";
  const json body = {
      {"batch_id", batch_id},
      {"status", status},
      {"model", job->value("model", "")},
      {"shards", {{"total", job->value("shards", 0)}, {"pending", counts["pending"]}, {"running", counts["running"]}, {"done", counts["done"]}, {"failed", counts["failed"]}}},
      {"request_counts", {{"total", job->value("record_count", 0)}, {"completed", counts["done"] * config::kShardSize}, {"failed", counts["failed"] * config::kShardSize}}},
      {"outputs", outputs_of(batch_id)},
  };
  res.status = 200;
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/batches/([^/]+))", get_batch); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <string>

#include "batch/config.h"  // config::kShardSize, config::shards_key/pending_key/outputs_key/totals_key — provided
#include "batch/jobs.h"    // jobs::by_id(batch_id) → the row with its tenant, nullopt when absent — provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// The folded output entries of a batch, by shard.
json outputs_of(const std::string& batch_id) {
  std::map<int, json> by_shard;
  for (const auto& [shard, raw] : redis.hgetall(config::outputs_key(batch_id))) by_shard[std::stoi(shard)] = json::parse(raw);
  json out = json::array();
  for (const auto& [shard, entry] : by_shard) out.push_back({{"shard_id", shard}, {"uri", entry.value("uri", "")}, {"checksum", entry.value("checksum", "")}});
  return out;
}

void get_batch(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const std::string batch_id = req.matches[1].str();
  const auto job = jobs::by_id(batch_id);
  if (!job || job->value("tenant", "") != tenant) {
    res.status = 404;
    res.set_content(R"({"error":"no such batch"})", "application/json");
    return;
  }
  std::map<std::string, long long> counts = {{"pending", 0}, {"running", 0}, {"done", 0}, {"failed", 0}};
  for (const auto& [shard, state] : redis.hgetall(config::shards_key(batch_id))) counts[state]++;
  std::string status = "completed";
  if (counts["pending"] > 0 || counts["running"] > 0) status = "in_progress";
  else if (counts["failed"] > 0) status = "partial";
  auto totals = redis.hgetall(config::totals_key(batch_id));
  const long long completed = totals.count("completed") ? std::stoll(totals["completed"]) : 0;
  const long long failed = totals.count("failed") ? std::stoll(totals["failed"]) : 0;
  const json body = {
      {"batch_id", batch_id},
      {"status", status},
      {"model", job->value("model", "")},
      {"shards", {{"total", job->value("shards", 0)}, {"pending", counts["pending"]}, {"running", counts["running"]}, {"done", counts["done"]}, {"failed", counts["failed"]}}},
      {"request_counts", {{"total", job->value("record_count", 0)}, {"completed", completed}, {"failed", failed}}},
      {"outputs", outputs_of(batch_id)},
  };
  res.status = 200;
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/batches/([^/]+))", get_batch); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import json

B = "b1"
TENANT = {"X-Tenant-Id": "t1"}


def _seed(ctx, states, totals=None, record_count=2500, outputs=()):
    """A batch of t1's as steps 1, 2 and 4 leave it: the job, the shard set, the pending list, the folded outputs and totals."""
    ctx.redis.set(f"batch:job:{B}", json.dumps({"batch_id": B, "status": "queued", "model": "sum-v7", "manifest_uri": "s3://acme/in.jsonl", "record_count": record_count, "shards": len(states), "tenant": "t1"}))
    ctx.redis.hset(f"batch:shards:{B}", mapping={str(i): s for i, s in enumerate(states)})
    pending = [str(i) for i, s in enumerate(states) if s == "pending"]
    if pending:
        ctx.redis.rpush(f"batch:pending:{B}", *pending)
    for shard in outputs:
        ctx.redis.hset(f"batch:outputs:{B}", str(shard), json.dumps({"uri": f"s3://batch-outputs/{B}/shard-{shard:05d}.jsonl", "checksum": f"c{shard}", "completed": 998, "failed": 2}))
    if totals:
        ctx.redis.hset(f"batch:totals:{B}", mapping=totals)


async def _get(ctx, headers=TENANT, batch_id=B):
    async with ctx.client(ctx.load("read").app) as c:
        return await c.get(f"/v1/batches/{batch_id}", headers=headers)


async def check_route(ctx):
    _seed(ctx, ["done", "running", "pending"], totals={"completed": 998, "failed": 2}, outputs=(0,))
    r = await _get(ctx)
    assert r.status_code == 200, f"reading the batch answered {r.status_code}: {r.text}"
    body = r.json()
    for key in ("batch_id", "status", "model", "shards", "request_counts", "outputs"):
        assert key in body, f"the body lacks {key!r}: {body}"
    assert body["status"] == "in_progress", f"a batch with a running and a pending shard is in_progress, got {body['status']!r}"
    assert body["shards"] == {"total": 3, "pending": 1, "running": 1, "done": 1, "failed": 0}, f"the shard counts come from the shard set: {body['shards']}"
    assert body["request_counts"].get("total") == 2500, f"request_counts.total is the batch's record_count: {body['request_counts']}"
    assert body["outputs"] == [{"shard_id": 0, "uri": f"s3://batch-outputs/{B}/shard-00000.jsonl", "checksum": "c0"}], f"the outputs are the folded entries with their checksums: {body['outputs']}"
    assert (await _get(ctx, batch_id="nope")).status_code == 404, "an unknown batch id is 404"
    assert (await _get(ctx, headers={})).status_code == 401, "a read without X-Tenant-Id is 401"


async def check_tenant_scope(ctx):
    _seed(ctx, ["done", "done"], totals={"completed": 2000, "failed": 0}, outputs=(0, 1))
    r = await _get(ctx, headers={"X-Tenant-Id": "t2"})
    assert r.status_code == 404, f"tenant t2 read t1's batch and got {r.status_code}: {r.text[:200]}. A batch id is not a secret; another tenant's batch must be 404, as an unknown id is"
    assert (await _get(ctx)).status_code == 200, "the batch's own tenant reads it"


async def check_running_not_finished(ctx):
    _seed(ctx, ["done", "running", "running"], totals={"completed": 998, "failed": 2}, outputs=(0,))
    r = await _get(ctx)
    body = r.json()
    assert body.get("status") == "in_progress", f"with two shards still running the batch is in_progress, the read said {body.get('status')!r}: an empty pending list means every shard was claimed, not finished"
    assert body["shards"]["running"] == 2, f"two shards are running: {body['shards']}"


async def check_failures_partial(ctx):
    _seed(ctx, ["done", "done", "failed"], totals={"completed": 1996, "failed": 4}, outputs=(0, 1))
    body = (await _get(ctx)).json()
    assert body.get("status") == "partial", f"every shard is terminal and one failed: the batch is partial, the read said {body.get('status')!r}"
    _seed(ctx, ["done", "done", "done"], totals={"completed": 2497, "failed": 3}, outputs=(0, 1, 2))
    body = (await _get(ctx)).json()
    assert body.get("status") == "completed", f"every shard done is completed, the read said {body.get('status')!r}"


async def check_record_counts(ctx):
    _seed(ctx, ["done", "done", "done"], totals={"completed": 2497, "failed": 3}, outputs=(0, 1, 2))
    body = (await _get(ctx)).json()
    assert body.get("request_counts") == {"total": 2500, "completed": 2497, "failed": 3}, f"request_counts must be the batch's 2500 records with the folded totals (completed 2497, failed 3), got {body.get('request_counts')}: shard counts times SHARD_SIZE invent records"
`,
    typescript: `const B = 'b1';
const TENANT = {'X-Tenant-Id': 't1'};

/** A batch of t1's as steps 1, 2 and 4 leave it: the job, the shard set, the pending list, the folded outputs and totals. */
function seed(ctx, states: string[], totals: Record<string, number> | null = null, outputs: number[] = []) {
  ctx.redis.set(\`batch:job:\${B}\`, JSON.stringify({batch_id: B, status: 'queued', model: 'sum-v7', manifest_uri: 's3://acme/in.jsonl', record_count: 2500, shards: states.length, tenant: 't1'}));
  states.forEach((s, i) => ctx.redis.hset(\`batch:shards:\${B}\`, String(i), s));
  ctx.redis.del(\`batch:pending:\${B}\`);
  states.forEach((s, i) => {
    if (s === 'pending') ctx.redis.rpush(\`batch:pending:\${B}\`, String(i));
  });
  for (const shard of outputs) {
    ctx.redis.hset(\`batch:outputs:\${B}\`, String(shard), JSON.stringify({uri: \`s3://batch-outputs/\${B}/shard-\${String(shard).padStart(5, '0')}.jsonl\`, checksum: \`c\${shard}\`, completed: 998, failed: 2}));
  }
  if (totals) for (const [k, v] of Object.entries(totals)) ctx.redis.hset(\`batch:totals:\${B}\`, k, String(v));
}

async function get(ctx, headers: Record<string, string> = TENANT, batchId = B) {
  return ctx.client(ctx.load('read').app).get(\`/v1/batches/\${batchId}\`, {headers});
}

export async function check_route(ctx) {
  seed(ctx, ['done', 'running', 'pending'], {completed: 998, failed: 2}, [0]);
  const r = await get(ctx);
  assert.equal(r.status, 200, \`reading the batch answered \${r.status}: \${r.text}\`);
  const body = r.json();
  for (const key of ['batch_id', 'status', 'model', 'shards', 'request_counts', 'outputs']) assert(key in body, \`the body lacks \${key}: \${r.text}\`);
  assert.equal(body.status, 'in_progress', \`a batch with a running and a pending shard is in_progress, got \${JSON.stringify(body.status)}\`);
  assert.deepEqual(body.shards, {total: 3, pending: 1, running: 1, done: 1, failed: 0}, \`the shard counts come from the shard set: \${JSON.stringify(body.shards)}\`);
  assert.equal(body.request_counts.total, 2500, \`request_counts.total is the batch's record_count: \${JSON.stringify(body.request_counts)}\`);
  assert.deepEqual(body.outputs, [{shard_id: 0, uri: \`s3://batch-outputs/\${B}/shard-00000.jsonl\`, checksum: 'c0'}], \`the outputs are the folded entries with their checksums: \${JSON.stringify(body.outputs)}\`);
  assert.equal((await get(ctx, TENANT, 'nope')).status, 404, 'an unknown batch id is 404');
  assert.equal((await get(ctx, {})).status, 401, 'a read without X-Tenant-Id is 401');
}

export async function check_tenant_scope(ctx) {
  seed(ctx, ['done', 'done'], {completed: 2000, failed: 0}, [0, 1]);
  const r = await get(ctx, {'X-Tenant-Id': 't2'});
  assert.equal(r.status, 404, \`tenant t2 read t1's batch and got \${r.status}: \${r.text.slice(0, 200)}. A batch id is not a secret; another tenant's batch must be 404, as an unknown id is\`);
  assert.equal((await get(ctx)).status, 200, "the batch's own tenant reads it");
}

export async function check_running_not_finished(ctx) {
  seed(ctx, ['done', 'running', 'running'], {completed: 998, failed: 2}, [0]);
  const body = (await get(ctx)).json();
  assert.equal(body.status, 'in_progress', \`with two shards still running the batch is in_progress, the read said \${JSON.stringify(body.status)}: an empty pending list means every shard was claimed, not finished\`);
  assert.equal(body.shards.running, 2, \`two shards are running: \${JSON.stringify(body.shards)}\`);
}

export async function check_failures_partial(ctx) {
  seed(ctx, ['done', 'done', 'failed'], {completed: 1996, failed: 4}, [0, 1]);
  let body = (await get(ctx)).json();
  assert.equal(body.status, 'partial', \`every shard is terminal and one failed: the batch is partial, the read said \${JSON.stringify(body.status)}\`);
  seed(ctx, ['done', 'done', 'done'], {completed: 2497, failed: 3}, [0, 1, 2]);
  body = (await get(ctx)).json();
  assert.equal(body.status, 'completed', \`every shard done is completed, the read said \${JSON.stringify(body.status)}\`);
}

export async function check_record_counts(ctx) {
  seed(ctx, ['done', 'done', 'done'], {completed: 2497, failed: 3}, [0, 1, 2]);
  const body = (await get(ctx)).json();
  assert.deepEqual(body.request_counts, {total: 2500, completed: 2497, failed: 3}, \`request_counts must be the batch's 2500 records with the folded totals (completed 2497, failed 3), got \${JSON.stringify(body.request_counts)}: shard counts times SHARD_SIZE invent records\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"leetbuild/harness"
)

const readBatch = "b1"

// readSeed is a batch of t1's as steps 1, 2 and 4 leave it: the job, the shard set, the pending list,
// the folded outputs and totals.
func readSeed(ctx *harness.Ctx, states []string, completed, failed int, outputs []int) {
	job, _ := json.Marshal(map[string]any{"batch_id": readBatch, "status": "queued", "model": "sum-v7", "manifest_uri": "s3://acme/in.jsonl", "record_count": 2500, "shards": len(states), "tenant": "t1"})
	ctx.Redis.Set("batch:job:"+readBatch, string(job))
	ctx.Redis.Del("batch:pending:" + readBatch)
	for i, s := range states {
		ctx.Redis.Do("HSET", "batch:shards:"+readBatch, strconv.Itoa(i), s)
		if s == "pending" {
			ctx.Redis.Do("RPUSH", "batch:pending:"+readBatch, strconv.Itoa(i))
		}
	}
	for _, shard := range outputs {
		entry, _ := json.Marshal(map[string]any{"uri": fmt.Sprintf("s3://batch-outputs/%s/shard-%05d.jsonl", readBatch, shard), "checksum": fmt.Sprintf("c%d", shard), "completed": 998, "failed": 2})
		ctx.Redis.Do("HSET", "batch:outputs:"+readBatch, strconv.Itoa(shard), string(entry))
	}
	ctx.Redis.Do("HSET", "batch:totals:"+readBatch, "completed", completed, "failed", failed)
}

func readGet(ctx *harness.Ctx, batchID string, header ...string) *harness.Response {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux).Get("/v1/batches/"+batchID, header...)
}

func readBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	readSeed(ctx, []string{"done", "running", "pending"}, 998, 2, []int{0})
	r := readGet(ctx, readBatch, "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 200, "reading the batch (%s)", r.Text())
	body := readBody(ctx, r)
	for _, key := range []string{"batch_id", "status", "model", "shards", "request_counts", "outputs"} {
		_, ok := body[key]
		ctx.Assert(ok, "the body lacks %s: %s", key, r.Text())
	}
	ctx.Equal(body["status"], "in_progress", "a batch with a running and a pending shard is in_progress; status")
	ctx.Equal(body["shards"], map[string]any{"total": float64(3), "pending": float64(1), "running": float64(1), "done": float64(1), "failed": float64(0)}, "the shard counts come from the shard set")
	counts, _ := body["request_counts"].(map[string]any)
	ctx.Equal(counts["total"], float64(2500), "request_counts.total is the batch's record_count")
	ctx.Equal(body["outputs"], []any{map[string]any{"shard_id": float64(0), "uri": "s3://batch-outputs/b1/shard-00000.jsonl", "checksum": "c0"}}, "the outputs are the folded entries with their checksums")
	ctx.Equal(readGet(ctx, "nope", "X-Tenant-Id", "t1").Status, 404, "an unknown batch id")
	ctx.Equal(readGet(ctx, readBatch).Status, 401, "a read without X-Tenant-Id")
}

func CheckTenantScope(ctx *harness.Ctx) {
	readSeed(ctx, []string{"done", "done"}, 2000, 0, []int{0, 1})
	r := readGet(ctx, readBatch, "X-Tenant-Id", "t2")
	ctx.Equal(r.Status, 404, "tenant t2 read t1's batch: a batch id is not a secret, another tenant's batch must be 404 as an unknown id is")
	ctx.Equal(readGet(ctx, readBatch, "X-Tenant-Id", "t1").Status, 200, "the batch's own tenant reads it")
}

func CheckRunningNotFinished(ctx *harness.Ctx) {
	readSeed(ctx, []string{"done", "running", "running"}, 998, 2, []int{0})
	body := readBody(ctx, readGet(ctx, readBatch, "X-Tenant-Id", "t1"))
	ctx.Equal(body["status"], "in_progress", "with two shards still running the batch is in_progress (an empty pending list means every shard was claimed, not finished); status")
	shards, _ := body["shards"].(map[string]any)
	ctx.Equal(shards["running"], float64(2), "two shards are running")
}

func CheckFailuresPartial(ctx *harness.Ctx) {
	readSeed(ctx, []string{"done", "done", "failed"}, 1996, 4, []int{0, 1})
	body := readBody(ctx, readGet(ctx, readBatch, "X-Tenant-Id", "t1"))
	ctx.Equal(body["status"], "partial", "every shard is terminal and one failed: the batch is partial; status")
	readSeed(ctx, []string{"done", "done", "done"}, 2497, 3, []int{0, 1, 2})
	body = readBody(ctx, readGet(ctx, readBatch, "X-Tenant-Id", "t1"))
	ctx.Equal(body["status"], "completed", "every shard done is completed; status")
}

func CheckRecordCounts(ctx *harness.Ctx) {
	readSeed(ctx, []string{"done", "done", "done"}, 2497, 3, []int{0, 1, 2})
	body := readBody(ctx, readGet(ctx, readBatch, "X-Tenant-Id", "t1"))
	ctx.Equal(body["request_counts"], map[string]any{"total": float64(2500), "completed": float64(2497), "failed": float64(3)}, "request_counts must be the batch's 2500 records with the folded totals (shard counts times ShardSize invent records)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cstdio>
#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

const std::string kBatch = "b1";

// A batch of t1's as steps 1, 2 and 4 leave it: the job, the shard set, the pending list, the folded
// outputs and totals.
void readSeed(harness::Ctx& ctx, const std::vector<std::string>& states, long long completed, long long failed, const std::vector<int>& outputs) {
  ctx.Redis.Set("batch:job:" + kBatch, json{{"batch_id", kBatch}, {"status", "queued"}, {"model", "sum-v7"}, {"manifest_uri", "s3://acme/in.jsonl"}, {"record_count", 2500}, {"shards", states.size()}, {"tenant", "t1"}}.dump());
  ctx.Redis.Del("batch:pending:" + kBatch);
  for (size_t i = 0; i < states.size(); i++) {
    ctx.Redis.Do("HSET", "batch:shards:" + kBatch, std::to_string(i), states[i]);
    if (states[i] == "pending") ctx.Redis.Do("RPUSH", "batch:pending:" + kBatch, std::to_string(i));
  }
  for (int shard : outputs) {
    char uri[64];
    std::snprintf(uri, sizeof uri, "s3://batch-outputs/b1/shard-%05d.jsonl", shard);
    ctx.Redis.Do("HSET", "batch:outputs:" + kBatch, std::to_string(shard), json{{"uri", uri}, {"checksum", "c" + std::to_string(shard)}, {"completed", 998}, {"failed", 2}}.dump());
  }
  ctx.Redis.Do("HSET", "batch:totals:" + kBatch, "completed", completed, "failed", failed);
}

struct Read {
  httplib::Server svr;
  harness::HTTP http;
  explicit Read(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }
};

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the body must be a JSON object: %s", r.Text());
  return body;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  readSeed(ctx, {"done", "running", "pending"}, 998, 2, {0});
  Read read(ctx);
  const auto r = read.http.Get("/v1/batches/" + kBatch, "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 200, "reading the batch (%s)", r.Text());
  const json body = bodyOf(ctx, r);
  for (const char* key : {"batch_id", "status", "model", "shards", "request_counts", "outputs"}) ctx.Assert(body.contains(key), "the body lacks %s: %s", key, r.Text());
  ctx.Equal(body["status"], "in_progress", "a batch with a running and a pending shard is in_progress; status");
  ctx.Equal(body["shards"], json{{"total", 3}, {"pending", 1}, {"running", 1}, {"done", 1}, {"failed", 0}}, "the shard counts come from the shard set");
  ctx.Equal(body["request_counts"].value("total", -1), 2500, "request_counts.total is the batch's record_count");
  ctx.Equal(body["outputs"], json::array({json{{"shard_id", 0}, {"uri", "s3://batch-outputs/b1/shard-00000.jsonl"}, {"checksum", "c0"}}}), "the outputs are the folded entries with their checksums");
  ctx.Equal(read.http.Get("/v1/batches/nope", "X-Tenant-Id", "t1").Status, 404, "an unknown batch id");
  ctx.Equal(read.http.Get("/v1/batches/" + kBatch).Status, 401, "a read without X-Tenant-Id");
}

void CheckTenantScope(harness::Ctx& ctx) {
  readSeed(ctx, {"done", "done"}, 2000, 0, {0, 1});
  Read read(ctx);
  ctx.Equal(read.http.Get("/v1/batches/" + kBatch, "X-Tenant-Id", "t2").Status, 404, "tenant t2 read t1's batch: a batch id is not a secret, another tenant's batch must be 404 as an unknown id is");
  ctx.Equal(read.http.Get("/v1/batches/" + kBatch, "X-Tenant-Id", "t1").Status, 200, "the batch's own tenant reads it");
}

void CheckRunningNotFinished(harness::Ctx& ctx) {
  readSeed(ctx, {"done", "running", "running"}, 998, 2, {0});
  Read read(ctx);
  const json body = bodyOf(ctx, read.http.Get("/v1/batches/" + kBatch, "X-Tenant-Id", "t1"));
  ctx.Equal(body.value("status", ""), "in_progress", "with two shards still running the batch is in_progress (an empty pending list means every shard was claimed, not finished); status");
  ctx.Equal(body["shards"].value("running", -1), 2, "two shards are running");
}

void CheckFailuresPartial(harness::Ctx& ctx) {
  readSeed(ctx, {"done", "done", "failed"}, 1996, 4, {0, 1});
  Read read(ctx);
  json body = bodyOf(ctx, read.http.Get("/v1/batches/" + kBatch, "X-Tenant-Id", "t1"));
  ctx.Equal(body.value("status", ""), "partial", "every shard is terminal and one failed: the batch is partial; status");
  readSeed(ctx, {"done", "done", "done"}, 2497, 3, {0, 1, 2});
  body = bodyOf(ctx, read.http.Get("/v1/batches/" + kBatch, "X-Tenant-Id", "t1"));
  ctx.Equal(body.value("status", ""), "completed", "every shard done is completed; status");
}

void CheckRecordCounts(harness::Ctx& ctx) {
  readSeed(ctx, {"done", "done", "done"}, 2497, 3, {0, 1, 2});
  Read read(ctx);
  const json body = bodyOf(ctx, read.http.Get("/v1/batches/" + kBatch, "X-Tenant-Id", "t1"));
  ctx.Equal(body["request_counts"], json{{"total", 2500}, {"completed", 2497}, {"failed", 3}}, "request_counts must be the batch's 2500 records with the folded totals (shard counts times kShardSize invent records)");
}
`,
  },
  debrief: `A status is a claim the tenant acts on, so it is computed from the facts that make it true: every shard's state, read from the shard set on each request. The pending list answers a different question (is there work nobody has claimed?), which is why it empties while workers still run. \`partial\` exists because a batch with a failed shard is finished and is not a success, and the tenant needs both facts, as OpenAI's Batch API keeps an error file beside the output file. Record counts come from the coordinator's folded totals because records fail one at a time inside a done shard. The 404 for another tenant's batch matches the unknown-id answer so ids leak nothing. Production status reads add an \`expires_at\` for the completion window and signed, short-lived output URLs instead of raw object paths.`,
};
