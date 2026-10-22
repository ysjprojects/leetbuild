import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/replications/{id}/lag: divergence with teeth',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'target'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it answers the lag route with a
number that goes down over time, so the dashboard looks alive. It proves nothing. Find the flaws, fix
them, and prove the fix.

Implement \`GET /v1/replications/{id}/lag\`.

- The operator comes from the authenticated \`X-Operator-Id\` header, and a replication the caller
  does **not** own is **404** — not 403, which would confirm that the id exists, and not 200, which
  leaks another team's replication state to any caller who guesses an id.
- The response reports **per shard**, never a single global number: the shard id, the confirmed
  applied \`offset\`, the source's head offset, and \`lag_changes\` = head − applied, clamped at
  zero. A single global lag hides the one shard that is stuck while the other ninety-nine are
  caught up.
- The divergence check actually runs: sample \`SAMPLE_KEYS\` (256) keys of the shard, digest each one
  in both regions with \`key_digest(region, key)\`, and collect every key whose digests differ. The
  response names the \`divergent_shards\` instead of hiding them, and reports the sample size in
  \`sampled_keys\` so the caller knows how strong the claim is.
- Lag and divergence are different questions and must both be answered: a shard at offset zero-lag
  can still be divergent, because a change applied out of order or with the wrong conflict policy
  leaves rows that no offset difference will ever reveal.

**Failure mode the checks target.** The draft reports one global lag computed from a configured
budget number, so an operator can never see which shard is behind; it marks the replication healthy
because nothing in it ever compares the two regions, so a divergent shard looks current; and it
serves any replication to any caller, so one team can read another team's replica state by guessing
an id. The divergence check is the one that turns this endpoint from a progress report into a proof.`,
  sequence: {
    participants: ['Operator', 'Replicator API', 'Source region', 'Target region'],
    messages: [
      {from: 'Operator', to: 'Replicator API', label: 'GET /v1/replications/{id}/lag', kind: 'sync'},
      {from: 'Replicator API', to: 'Source region', label: 'head offset · digest sampled keys', kind: 'sync'},
      {from: 'Replicator API', to: 'Target region', label: 'applied offset · digest sampled keys', kind: 'sync'},
      {from: 'Target region', to: 'Replicator API', label: 'digests', kind: 'reply'},
      {from: 'Replicator API', to: 'Operator', label: '200 {shards, lag_changes, divergent_shards}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/replications/{id}/lag',
      detail: 'Register the lag route on `GET /v1/replications/{id}/lag`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/replications\/\{replication_id\}\/lag["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/replications\/:id\/lag['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/replications\/\{id\}\/lag"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"replications"\s*\/\s*Segment\s*\/\s*"lag"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/replications\//]},
      },
    },
    {
      id: 'per-shard-lag',
      title: 'Per-shard offsets and lag in changes',
      detail:
        'The response lists one entry per shard with its confirmed offset, the source head offset and `lag_changes` = head − applied, clamped at zero. The draft answers with one global lag number.',
      match: {
        python: {all: [/"shards"/, /"lag_changes"/, /source_head_offset\(/]},
        typescript: {all: [/lag_changes: Math\.max\(/, /sourceHeadOffset\(/, /shards\.push\(/]},
        go: {all: [/json:"shards"/, /json:"lag_changes"/, /sourceHeadOffset\(/]},
        scala: {all: [/"shards"/, /"lag_changes"/, /sourceHeadOffset\(/]},
        cpp: {all: [/"shards"/, /"lag_changes"/, /sourceHeadOffset\(/]},
      },
    },
    {
      id: 'sample-digests',
      title: 'The divergence check samples 256 keys and compares digests',
      detail:
        'The endpoint samples `SAMPLE_KEYS` (256) keys of the shard, digests each one in both regions with `key_digest`, and compares them. The draft never compares the two regions at all.',
      match: {
        python: {all: [/SAMPLE_KEYS = 256/, /key_digest\(/, /sample_keys\(/]},
        typescript: {all: [/SAMPLE_KEYS = 256/, /keyDigest\(/, /sampleKeys\(/]},
        go: {all: [/sampleKeyCount = 256/, /keyDigest\(/, /sampleKeys\(/]},
        scala: {all: [/SampleKeys = 256/, /keyDigest\(/, /sampleKeys\(/]},
        cpp: {all: [/kSampleKeys = 256/, /keyDigest\(/, /sampleKeys\(/]},
      },
    },
    {
      id: 'owner-404',
      title: 'A replication the caller does not own is 404',
      detail:
        'The lookup compares the replication’s owner with the authenticated operator and answers **404** for a foreign replication, so an operator cannot read another team’s replica state by guessing an id. The draft serves any replication to any caller.',
      match: {
        python: {all: [/replication\["owner"\] != x_operator_id/, /status_code\s*=\s*404/]},
        typescript: {all: [/replication\.owner !== operator/, /code\(404\)/]},
        go: {all: [/replication\.Owner != operator/, /StatusNotFound/]},
        scala: {all: [/operatorOpt\.contains\(replication\.owner\)/, /StatusCodes\.NotFound/]},
        cpp: {all: [/replication->owner != operatorId/, /\b404\b/]},
      },
    },
    {
      id: 'divergent-shards',
      title: 'Divergent shards are named, not hidden',
      detail:
        'The shards whose sampled digests differ are collected and returned as `divergent_shards`. The draft always reports the replication healthy.',
      match: {
        python: {all: [/"divergent_shards"/, /divergence_sample\(/]},
        typescript: {all: [/divergent_shards: divergentShards/, /divergenceSample\(/]},
        go: {all: [/json:"divergent_shards"/, /divergenceSample\(/]},
        scala: {all: [/"divergent_shards"/, /divergenceSample\(/]},
        cpp: {all: [/divergent_shards/, /divergenceSample\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

LAG_BUDGET_CHANGES = 10000


class ReplicationStore:
    def get(self, replication_id: str) -> dict | None:
        """The stored replication, if any."""
        raise NotImplementedError


store = ReplicationStore()


# TODO: the draft reports a single global lag taken from the configured budget, never lists the
# per-shard offsets, never samples digests so a divergent shard looks healthy, and serves any
# replication to any caller.
@app.get("/v1/replications/{replication_id}/lag")
def lag(replication_id: str, x_operator_id: str | None = Header(default=None)):
    replication = store.get(replication_id)
    if replication is None:
        return JSONResponse({"error": "unknown replication"}, status_code=404)
    applied = int(r.get("offset") or 0)
    return {
        "replication_id": replication_id,
        "lag": max(LAG_BUDGET_CHANGES - applied, 0),
        "healthy": True,
    }
`,
      solution: `import redis
from fastapi import FastAPI, Header, HTTPException

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# How many keys of a shard the divergence check samples: enough to catch a diverge inside one batch,
# cheap enough to run on every lag read.
SAMPLE_KEYS = 256


class ReplicationStore:
    def get(self, replication_id: str) -> dict | None:
        """The stored replication, if any."""
        raise NotImplementedError


store = ReplicationStore()


def resume_offset(replication_id: str, shard: int) -> int:
    """The offset the shard has confirmed at the target."""
    raw = r.get(f"offset:{replication_id}:{shard}")
    return int(raw) if raw is not None else 0


def source_head_offset(replication_id: str, shard: int) -> int:
    """The newest change the source region holds for the shard."""
    raise NotImplementedError


def key_digest(region: str, key: str) -> str:
    """A digest of one key's value in one region, for comparing the two regions."""
    raise NotImplementedError


def sample_keys(replication_id: str, shard: int, count: int) -> list[str]:
    """The keys of the shard the divergence check inspects."""
    raise NotImplementedError


def divergence_sample(replication: dict, shard: int) -> list[dict]:
    """Sample SAMPLE_KEYS keys of the shard and return the ones whose digests differ."""
    divergences = []
    for key in sample_keys(replication["id"], shard, SAMPLE_KEYS):
        source_digest = key_digest(replication["source_region"], key)
        target_digest = key_digest(replication["target_region"], key)
        if source_digest != target_digest:
            divergences.append({"key": key, "source_digest": source_digest, "target_digest": target_digest})
    return divergences


@app.get("/v1/replications/{replication_id}/lag")
def lag(replication_id: str, x_operator_id: str | None = Header(default=None)):
    replication = store.get(replication_id)
    if replication is None or replication["owner"] != x_operator_id:
        raise HTTPException(status_code=404, detail="unknown replication")
    shards = []
    divergent_shards = []
    for shard in replication["shards"]:
        applied = resume_offset(replication_id, shard)
        head = source_head_offset(replication_id, shard)
        divergences = divergence_sample(replication, shard)
        if divergences:
            divergent_shards.append(shard)
        shards.append(
            {
                "shard": shard,
                "offset": applied,
                "source_head_offset": head,
                "lag_changes": max(head - applied, 0),
                "divergences": divergences,
            }
        )
    return {
        "replication_id": replication_id,
        "sampled_keys": SAMPLE_KEYS,
        "shards": shards,
        "divergent_shards": divergent_shards,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import {Redis} from 'ioredis';

const app = Fastify({logger: true});
const r = new Redis('redis://redis:6379');

const LAG_BUDGET_CHANGES = 10_000;

interface Replication {
  id: string;
  owner: string;
  source_region: string;
  target_region: string;
  shards: number[];
  conflict_policy: string;
}

// TODO: the draft reports a single global lag taken from the configured budget, never lists the
// per-shard offsets, never samples digests so a divergent shard looks healthy, and serves any
// replication to any caller.
app.get('/v1/replications/:id/lag', async (request, reply) => {
  const replication = store.get((request.params as {id: string}).id);
  if (replication === undefined) return reply.code(404).send({error: 'unknown replication'});
  const applied = Number((await r.get('offset')) ?? 0);
  return reply.code(200).send({replication_id: replication.id, lag: Math.max(LAG_BUDGET_CHANGES - applied, 0), healthy: true});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `import Fastify from 'fastify';
import {Redis} from 'ioredis';

const app = Fastify({logger: true});
const r = new Redis('redis://redis:6379');

// How many keys of a shard the divergence check samples: enough to catch a diverge inside one batch,
// cheap enough to run on every lag read.
const SAMPLE_KEYS = 256;

interface Replication {
  id: string;
  owner: string;
  source_region: string;
  target_region: string;
  shards: number[];
  conflict_policy: string;
}

interface Divergence {
  key: string;
  source_digest: string;
  target_digest: string;
}

function keyDigest(region: string, key: string): string {
  throw new Error('digest one key in one region');
}

function sampleKeys(replicationId: string, shard: number, count: number): string[] {
  throw new Error('sample the shard’s keys');
}

function sourceHeadOffset(replicationId: string, shard: number): number {
  throw new Error('read the source head offset');
}

async function resumeOffset(replicationId: string, shard: number): Promise<number> {
  const raw = await r.get(\`offset:\${replicationId}:\${shard}\`);
  return raw === null ? 0 : Number(raw);
}

export function divergenceSample(replication: Replication, shard: number): Divergence[] {
  const divergences: Divergence[] = [];
  for (const key of sampleKeys(replication.id, shard, SAMPLE_KEYS)) {
    const sourceDigest = keyDigest(replication.source_region, key);
    const targetDigest = keyDigest(replication.target_region, key);
    if (sourceDigest !== targetDigest) divergences.push({key, source_digest: sourceDigest, target_digest: targetDigest});
  }
  return divergences;
}

app.get('/v1/replications/:id/lag', async (request, reply) => {
  const operator = request.headers['x-operator-id'];
  const replication = store.get((request.params as {id: string}).id);
  if (replication === undefined || replication.owner !== operator)
    return reply.code(404).send({error: 'unknown replication'});

  const shards = [];
  const divergentShards: number[] = [];
  for (const shard of replication.shards) {
    const offset = await resumeOffset(replication.id, shard);
    const head = sourceHeadOffset(replication.id, shard);
    const divergences = divergenceSample(replication, shard);
    if (divergences.length > 0) divergentShards.push(shard);
    shards.push({
      shard,
      offset,
      source_head_offset: head,
      lag_changes: Math.max(head - offset, 0),
      divergences,
    });
  }
  return reply.code(200).send({
    replication_id: replication.id,
    sampled_keys: SAMPLE_KEYS,
    shards,
    divergent_shards: divergentShards,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
)

const lagBudgetChanges = 10000

var rdb *redis.Client

type Replication struct {
	ID             string \`json:"id"\`
	Owner          string \`json:"owner"\`
	SourceRegion   string \`json:"source_region"\`
	TargetRegion   string \`json:"target_region"\`
	Shards         []int  \`json:"shards"\`
	ConflictPolicy string \`json:"conflict_policy"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// TODO: the draft reports a single global lag taken from the configured budget, never lists the
// per-shard offsets, never samples digests so a divergent shard looks healthy, and serves any
// replication to any caller.
func lag(rw http.ResponseWriter, r *http.Request) {
	replication, err := store.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown replication"})
		return
	}
	raw, _ := rdb.Get(r.Context(), "offset").Int64()
	lag := lagBudgetChanges - int(raw)
	if lag < 0 {
		lag = 0
	}
	writeJSON(rw, http.StatusOK, map[string]any{"replication_id": replication.ID, "lag": lag, "healthy": true})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/replications/{id}/lag", lag)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
)

const sampleKeyCount = 256

var rdb *redis.Client

type Replication struct {
	ID             string \`json:"id"\`
	Owner          string \`json:"owner"\`
	SourceRegion   string \`json:"source_region"\`
	TargetRegion   string \`json:"target_region"\`
	Shards         []int  \`json:"shards"\`
	ConflictPolicy string \`json:"conflict_policy"\`
}

type Divergence struct {
	Key          string \`json:"key"\`
	SourceDigest string \`json:"source_digest"\`
	TargetDigest string \`json:"target_digest"\`
}

type ShardLag struct {
	Shard            int          \`json:"shard"\`
	Offset           int64        \`json:"offset"\`
	SourceHeadOffset int64        \`json:"source_head_offset"\`
	LagChanges       int64        \`json:"lag_changes"\`
	Divergences      []Divergence \`json:"divergences"\`
}

type LagResponse struct {
	ReplicationID   string     \`json:"replication_id"\`
	SampledKeys     int        \`json:"sampled_keys"\`
	Shards          []ShardLag \`json:"shards"\`
	DivergentShards []int      \`json:"divergent_shards"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func keyDigest(region, key string) string {
	return ""
}

func sampleKeys(replicationID string, shard, count int) []string {
	return nil
}

func sourceHeadOffset(ctx context.Context, replicationID string, shard int) int64 {
	return 0
}

func resumeOffset(ctx context.Context, replicationID string, shard int) int64 {
	raw, err := rdb.Get(ctx, offsetKey(replicationID, shard)).Result()
	if err != nil {
		return 0
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return value
}

func divergenceSample(ctx context.Context, replication Replication, shard int) []Divergence {
	divergences := []Divergence{}
	for _, key := range sampleKeys(replication.ID, shard, sampleKeyCount) {
		sourceDigest := keyDigest(replication.SourceRegion, key)
		targetDigest := keyDigest(replication.TargetRegion, key)
		if sourceDigest != targetDigest {
			divergences = append(divergences, Divergence{Key: key, SourceDigest: sourceDigest, TargetDigest: targetDigest})
		}
	}
	return divergences
}

func lag(rw http.ResponseWriter, r *http.Request) {
	operator := r.Header.Get("X-Operator-Id")
	replication, err := store.Get(r.Context(), r.PathValue("id"))
	if err != nil || replication.Owner != operator {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown replication"})
		return
	}
	shards := []ShardLag{}
	divergentShards := []int{}
	for _, shard := range replication.Shards {
		offset := resumeOffset(r.Context(), replication.ID, shard)
		head := sourceHeadOffset(r.Context(), replication.ID, shard)
		divergences := divergenceSample(r.Context(), replication, shard)
		if len(divergences) > 0 {
			divergentShards = append(divergentShards, shard)
		}
		lagChanges := head - offset
		if lagChanges < 0 {
			lagChanges = 0
		}
		shards = append(shards, ShardLag{
			Shard:            shard,
			Offset:           offset,
			SourceHeadOffset: head,
			LagChanges:       lagChanges,
			Divergences:      divergences,
		})
	}
	writeJSON(rw, http.StatusOK, LagResponse{
		ReplicationID:   replication.ID,
		SampledKeys:     sampleKeyCount,
		Shards:          shards,
		DivergentShards: divergentShards,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/replications/{id}/lag", lag)
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

final case class Replication(id: String, owner: String, source_region: String, target_region: String, shards: List[Int], conflict_policy: String)

object LagApi {
  implicit val system: ActorSystem = ActorSystem("replicatord")
  private val jedis = new Jedis("redis", 6379)
  val LagBudgetChanges = 10000

  val store = ReplicationStore.open()

  // TODO: the draft reports a single global lag taken from the configured budget, never lists the
  // per-shard offsets, never samples digests so a divergent shard looks healthy, and serves any
  // replication to any caller.
  val route: Route =
    path("v1" / "replications" / Segment / "lag") { replicationId =>
      get {
        store.get(replicationId) match {
          case None => complete(StatusCodes.NotFound, """{"error":"unknown replication"}""")
          case Some(replication) =>
            val applied = Option(jedis.get("offset")).map(_.toLong).getOrElse(0L)
            val lag = math.max(LagBudgetChanges - applied, 0L)
            complete(StatusCodes.OK, s"""{"replication_id":"$replicationId","lag":$lag,"healthy":true}""")
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

final case class Replication(id: String, owner: String, source_region: String, target_region: String, shards: List[Int], conflict_policy: String)
final case class Divergence(key: String, source_digest: String, target_digest: String)

object LagApi {
  implicit val system: ActorSystem = ActorSystem("replicatord")
  private val jedis = new Jedis("redis", 6379)

  // How many keys of a shard the divergence check samples: enough to catch a diverge inside one
  // batch, cheap enough to run on every lag read.
  val SampleKeys = 256

  val store = ReplicationStore.open()

  def keyDigest(region: String, key: String): String = throw new UnsupportedOperationException("digest a key")

  def sampleKeys(replicationId: String, shard: Int, count: Int): Seq[String] = Seq.empty

  def sourceHeadOffset(replicationId: String, shard: Int): Long = 0L

  def resumeOffset(replicationId: String, shard: Int): Long = {
    val raw = jedis.get(s"offset:$replicationId:$shard")
    if (raw == null) 0L else raw.toLong
  }

  def divergenceSample(replication: Replication, shard: Int): Seq[Divergence] = {
    sampleKeys(replication.id, shard, SampleKeys).flatMap { key =>
      val sourceDigest = keyDigest(replication.source_region, key)
      val targetDigest = keyDigest(replication.target_region, key)
      if (sourceDigest != targetDigest) Some(Divergence(key, sourceDigest, targetDigest)) else None
    }
  }

  val route: Route =
    path("v1" / "replications" / Segment / "lag") { replicationId =>
      get {
        optionalHeaderValueByName("X-Operator-Id") { operatorOpt =>
          store.get(replicationId) match {
            case Some(replication) if operatorOpt.contains(replication.owner) =>
              val shards = replication.shards.map { shard =>
                val offset = resumeOffset(replicationId, shard)
                val head = sourceHeadOffset(replicationId, shard)
                val divergences = divergenceSample(replication, shard)
                val divergencesJson = divergences
                  .map(d => s"""{"key":"\${d.key}","source_digest":"\${d.source_digest}","target_digest":"\${d.target_digest}"}""")
                s"""{"shard":$shard,"offset":$offset,"source_head_offset":$head,"lag_changes":\${math.max(head - offset, 0L)},"divergences":[\${divergencesJson.mkString(",")}]}"""
              }
              val divergentShards =
                replication.shards.filter(shard => divergenceSample(replication, shard).nonEmpty)
              complete(
                StatusCodes.OK,
                s"""{"replication_id":"$replicationId","sampled_keys":$SampleKeys,"shards":[\${shards.mkString(",")}],"divergent_shards":[\${divergentShards.mkString(",")}]}""",
              )
            case _ => complete(StatusCodes.NotFound, """{"error":"unknown replication"}""")
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

#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kLagBudgetChanges = 10000;

struct Replication {
  std::string id;
  std::string owner;
  std::string source_region;
  std::string target_region;
  std::vector<int> shards;
  std::string conflict_policy;
};

int main() {
  httplib::Server svr;

  // TODO: the draft reports a single global lag taken from the configured budget, never lists the
  // per-shard offsets, never samples digests so a divergent shard looks healthy, and serves any
  // replication to any caller.
  svr.Get(R"(/v1/replications/([^/]+)/lag)", [](const httplib::Request& req, httplib::Response& res) {
    const auto replicationId = req.matches[1].str();
    const auto replication = store.get(replicationId);
    if (!replication) {
      res.status = 404;
      res.set_content(R"({"error":"unknown replication"})", "application/json");
      return;
    }
    const auto applied = std::stoll(redis.get("offset").value_or("0"));
    const auto lag = std::max(kLagBudgetChanges - applied, 0LL);
    res.status = 200;
    res.set_content(json{{"replication_id", replicationId}, {"lag", lag}, {"healthy", true}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

using json = nlohmann::json;

// How many keys of a shard the divergence check samples: enough to catch a diverge inside one batch,
// cheap enough to run on every lag read.
constexpr int kSampleKeys = 256;

struct Replication {
  std::string id;
  std::string owner;
  std::string source_region;
  std::string target_region;
  std::vector<int> shards;
  std::string conflict_policy;
};

std::string keyDigest(const std::string& region, const std::string& key);
std::vector<std::string> sampleKeys(const std::string& replicationId, int shard, int count);
int64_t sourceHeadOffset(const std::string& replicationId, int shard);
int64_t resumeOffset(const std::string& replicationId, int shard);

json divergenceSample(const Replication& replication, int shard) {
  json divergences = json::array();
  for (const auto& key : sampleKeys(replication.id, shard, kSampleKeys)) {
    const auto sourceDigest = keyDigest(replication.source_region, key);
    const auto targetDigest = keyDigest(replication.target_region, key);
    if (sourceDigest != targetDigest) {
      divergences.push_back({{"key", key}, {"source_digest", sourceDigest}, {"target_digest", targetDigest}});
    }
  }
  return divergences;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/replications/([^/]+)/lag)", [](const httplib::Request& req, httplib::Response& res) {
    const auto operatorId = req.get_header_value("X-Operator-Id");
    const auto replicationId = req.matches[1].str();
    const auto replication = store.get(replicationId);
    if (!replication || replication->owner != operatorId) {
      res.status = 404;
      res.set_content(R"({"error":"unknown replication"})", "application/json");
      return;
    }
    json shards = json::array();
    std::vector<int> divergentShards;
    for (int shard : replication->shards) {
      const auto offset = resumeOffset(replicationId, shard);
      const auto head = sourceHeadOffset(replicationId, shard);
      const auto divergences = divergenceSample(*replication, shard);
      if (!divergences.empty()) divergentShards.push_back(shard);
      shards.push_back({
          {"shard", shard},
          {"offset", offset},
          {"source_head_offset", head},
          {"lag_changes", std::max<int64_t>(head - offset, 0)},
          {"divergences", divergences},
      });
    }
    res.status = 200;
    res.set_content(
        json{{"replication_id", replicationId},
             {"sampled_keys", kSampleKeys},
             {"shards", shards},
             {"divergent_shards", divergentShards}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Answer per shard, never globally: `lag_changes = max(head - applied, 0)` for each shard in the replication, with the offset read from the durable key the state step wrote. A global number is an average that hides the shard that is stuck.',
    'The divergence check is a sample, not a scan: take `SAMPLE_KEYS` keys of the shard, digest each one in both regions, and keep the keys whose digests differ. Report the sample size next to the result so the caller can judge the claim — and name the `divergent_shards`.',
    'Authorise by ownership and answer **404** for a foreign replication: 403 confirms the id exists, and 200 leaks another team’s state. Reading the operator from the header and comparing it with the stored owner is the whole fix.',
  ],
  debrief: `The interviewer is testing whether you can review a read path for whether it proves anything. A single lag number computed from a budget is not evidence: it cannot show which shard is behind, and it cannot detect divergence at all, because a change applied with the wrong order leaves both regions at the same offset with different rows. The sample is what gives the endpoint teeth — 256 keys, digests compared per region, the divergent shards named — and reporting the sample size is what keeps the claim honest. The ownership check is the security half of the same review: a replication id is guessable, so the endpoint has to answer 404 for someone else's replication. Real platforms add a background reconciler that repairs divergences, a checksum job over full shards, and an alert on the divergence count rather than on the lag.`,
};
