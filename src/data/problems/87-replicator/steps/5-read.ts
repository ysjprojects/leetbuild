import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/replications/{id}/lag: every shard, and the ones that diverged',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'source', 'target'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/replications/{id}/lag\`: it loads the replication
(\`store.get\`), takes the smallest confirmed offset (\`resume_offset\`) and the largest source head
(\`regions.source_head_offset\`) across its shards, and answers \`{replication_id, lag_changes,
healthy: true}\`. The number falls as shards catch up, and it hides three flaws.

**Failure mode the checks target.** Any caller who guesses an id reads another team's replication;
the one number mixes offsets of different shards, so nobody can tell which shard is behind; and a
shard whose rows differ between the regions reports healthy, because nothing compares them.

- \`X-Operator-Id\` is required (**401**); a replication the caller does not own is **404**.
- \`shards\`: one entry per shard with \`shard\`, \`offset\`, \`source_head_offset\` and \`lag_changes\` =
  head − offset, never below 0.
- Per shard, take \`regions.sample_keys(source_region, shard, SAMPLE_KEYS)\` (256) and compare
  \`regions.key_digest\` in both regions; list the differing keys as the shard's \`divergent_keys\`, name
  the shard in \`divergent_shards\`, and report \`sampled_keys\`. A shard at zero lag can diverge.`,
  sequence: {
    participants: ['Operator', 'replicatord', 'Redis', 'Source region', 'Target region'],
    messages: [
      {from: 'Operator', to: 'replicatord', label: 'GET /v1/replications/{id}/lag · X-Operator-Id', kind: 'sync'},
      {from: 'replicatord', to: 'Redis', label: 'resume_offset per shard', kind: 'sync'},
      {from: 'replicatord', to: 'Source region', label: 'source_head_offset · sample_keys · key_digest', kind: 'sync'},
      {from: 'replicatord', to: 'Target region', label: 'key_digest of the sampled keys', kind: 'sync'},
      {
        from: 'replicatord',
        to: 'Operator',
        label: '200 {shards: [{lag_changes, divergent_keys}], divergent_shards}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers the lag route',
      detail: 'Register `GET /v1/replications/{id}/lag`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/replications\/\{\w+\}\/lag["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/replications\/:\w+\/lag['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/replications\/\{id\}\/lag"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"replications"\s*\/\s*Segment\s*\/\s*"lag"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/replications\//]},
      },
    },
    {
      id: 'owner-404',
      title: "Another operator's replication is 404",
      detail:
        "The read requires `X-Operator-Id` (401) and compares it with the replication's `owner`, answering **404** for a replication the caller does not own, the same as for one that does not exist.",
      match: {
        python: {all: [/x-operator-id/i, /\["owner"\]\s*!=/, /\b401\b/]},
        typescript: {all: [/x-operator-id/i, /\.owner\s*!==/, /\b401\b/]},
        go: {all: [/X-Operator-Id/i, /\.Owner\s*!=/, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/X-Operator-Id/i, /_\.owner\s*==|\.owner\s*!=/, /Unauthorized/]},
        cpp: {all: [/X-Operator-Id/i, /->owner\s*!=/, /\b401\b/]},
      },
    },
    {
      id: 'per-shard-lag',
      title: 'Reports offset, head and lag per shard',
      detail:
        'The response lists every shard with its confirmed `offset`, its `source_head_offset` and `lag_changes` clamped at zero; a minimum of offsets and a maximum of heads across shards compares numbers from different logs.',
      match: {
        python: {
          all: [/["']lag_changes["']\s*:\s*max\(/, /["']source_head_offset["']/],
          none: [/\bmin\(\s*resume_offset/],
        },
        typescript: {all: [/lag_changes:\s*Math\.max\(/, /source_head_offset/], none: [/Math\.min\(\s*\.\.\./]},
        go: {all: [/json:"lag_changes"/, /json:"source_head_offset"/], none: [/applied\s*=\s*min\(|minOffset/]},
        scala: {all: [/"lag_changes"/, /"source_head_offset"/], none: [/\.min\b/]},
        cpp: {all: [/"lag_changes"/, /"source_head_offset"/], none: [/std::min_element|std::min\(/]},
      },
    },
    {
      id: 'divergent-shards',
      title: 'Samples digests in both regions and names the divergent shards',
      detail:
        "Each shard's sampled keys (`SAMPLE_KEYS` = 256) are digested in the source and the target region; differing keys are listed and their shards named in `divergent_shards`, whatever the shard's lag. The starter reports `healthy: true` without looking.",
      match: {
        python: {
          all: [/SAMPLE_KEYS\s*=\s*256/, /regions\.sample_keys\(/, /regions\.key_digest\(/, /divergent_shards/],
          none: [/["']healthy["']\s*:\s*True/],
        },
        typescript: {
          all: [/SAMPLE_KEYS\s*=\s*256/, /sampleKeys\(/, /keyDigest\(/, /divergent_shards/],
          none: [/healthy:\s*true/],
        },
        go: {
          all: [/sampleKeys\s*=\s*256/, /regions\.SampleKeys\(/, /regions\.KeyDigest\(/, /divergent_shards/],
          none: [/"healthy":\s*true/],
        },
        scala: {
          all: [/SampleKeys\s*=\s*256/, /Regions\.sampleKeys\(/, /Regions\.keyDigest\(/, /divergent_shards/],
          none: [/"healthy"\s*->\s*JsTrue/],
        },
        cpp: {
          all: [/kSampleKeys\s*=\s*256/, /regions::sampleKeys\(/, /regions::keyDigest\(/, /divergent_shards/],
          none: [/\{"healthy",\s*true\}/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from replication import regions, store  # store.get · regions.source_head_offset, sample_keys, key_digest
from replication.offsets import resume_offset

app = FastAPI()


@app.get("/v1/replications/{replication_id}/lag")
def lag(replication_id: str, request: Request) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    replication = store.get(replication_id)
    if replication is None:
        raise HTTPException(status_code=404, detail="no such replication")
    applied = min(resume_offset(replication_id, shard) for shard in replication["shards"])
    head = max(regions.source_head_offset(replication_id, shard) for shard in replication["shards"])
    return {"replication_id": replication_id, "lag_changes": max(head - applied, 0), "healthy": True}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from replication import regions, store  # store.get · regions.source_head_offset, sample_keys, key_digest
from replication.offsets import resume_offset

app = FastAPI()

# Rows of a shard compared per read: enough to catch a shard that diverged, cheap enough to run on every read.
SAMPLE_KEYS = 256


def divergent_keys(replication: dict, shard: int) -> list[str]:
    """The sampled rows of the shard whose digests differ between the two regions."""
    source, target = replication["source_region"], replication["target_region"]
    keys = regions.sample_keys(source, shard, SAMPLE_KEYS)
    return [key for key in keys if regions.key_digest(source, shard, key) != regions.key_digest(target, shard, key)]


@app.get("/v1/replications/{replication_id}/lag")
def lag(replication_id: str, request: Request) -> dict:
    operator = request.headers.get("x-operator-id", "")
    if not operator:
        raise HTTPException(status_code=401, detail="X-Operator-Id is required")
    replication = store.get(replication_id)
    # Another operator's replication is as absent as one that does not exist: the id reveals nothing.
    if replication is None or replication["owner"] != operator:
        raise HTTPException(status_code=404, detail="no such replication")
    shards, divergent_shards = [], []
    for shard in replication["shards"]:
        offset = resume_offset(replication_id, shard)
        head = regions.source_head_offset(replication_id, shard)
        diverged = divergent_keys(replication, shard)  # a shard at zero lag can still hold different rows
        if diverged:
            divergent_shards.append(shard)
        shards.append(
            {"shard": shard, "offset": offset, "source_head_offset": head, "lag_changes": max(head - offset, 0), "divergent_keys": diverged}
        )
    return {"replication_id": replication_id, "sampled_keys": SAMPLE_KEYS, "shards": shards, "divergent_shards": divergent_shards}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {resumeOffset} from 'replication/offsets';
import * as regions from 'replication/regions'; // regions.sourceHeadOffset, sampleKeys, keyDigest
import * as store from 'replication/store'; // store.get

export const app = Fastify();

app.get('/v1/replications/:id/lag', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {id} = request.params as {id: string};
  const replication = await store.get(id);
  if (replication === null) return reply.code(404).send({error: 'no such replication'});
  const offsets = await Promise.all(replication.shards.map(shard => resumeOffset(id, shard)));
  const heads = await Promise.all(replication.shards.map(shard => regions.sourceHeadOffset(id, shard)));
  const lag = Math.max(...heads) - Math.min(...offsets);
  return {replication_id: id, lag_changes: Math.max(lag, 0), healthy: true};
});
`,
      solution: `import Fastify from 'fastify';

import {resumeOffset} from 'replication/offsets';
import * as regions from 'replication/regions'; // regions.sourceHeadOffset, sampleKeys, keyDigest
import * as store from 'replication/store'; // store.get

export const app = Fastify();

// Rows of a shard compared per read: enough to catch a shard that diverged, cheap enough to run on every read.
export const SAMPLE_KEYS = 256;

/** The sampled rows of the shard whose digests differ between the two regions. */
async function divergentKeys(replication: store.Replication, shard: number): Promise<string[]> {
  const diverged: string[] = [];
  for (const key of await regions.sampleKeys(replication.source_region, shard, SAMPLE_KEYS)) {
    const source = await regions.keyDigest(replication.source_region, shard, key);
    const target = await regions.keyDigest(replication.target_region, shard, key);
    if (source !== target) diverged.push(key);
  }
  return diverged;
}

app.get('/v1/replications/:id/lag', async (request, reply) => {
  const operator = request.headers['x-operator-id'];
  if (typeof operator !== 'string' || operator === '') return reply.code(401).send({error: 'X-Operator-Id is required'});
  const {id} = request.params as {id: string};
  const replication = await store.get(id);
  // Another operator's replication is as absent as one that does not exist: the id reveals nothing.
  if (replication === null || replication.owner !== operator) return reply.code(404).send({error: 'no such replication'});
  const shards = [];
  const divergentShards: number[] = [];
  for (const shard of replication.shards) {
    const offset = await resumeOffset(id, shard);
    const head = await regions.sourceHeadOffset(id, shard);
    const diverged = await divergentKeys(replication, shard); // a shard at zero lag can still hold different rows
    if (diverged.length > 0) divergentShards.push(shard);
    shards.push({shard, offset, source_head_offset: head, lag_changes: Math.max(head - offset, 0), divergent_keys: diverged});
  }
  return {replication_id: id, sampled_keys: SAMPLE_KEYS, shards, divergent_shards: divergentShards};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"replication/offsets" // offsets.ResumeOffset
	"replication/regions" // regions.SourceHeadOffset, SampleKeys, KeyDigest
	"replication/store"   // store.Get
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readLag(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	id := r.PathValue("id")
	replication, err := store.Get(r.Context(), id)
	if err != nil || replication == nil {
		http.Error(rw, "no such replication", http.StatusNotFound)
		return
	}
	var applied, head int64 = -1, 0
	for _, shard := range replication.Shards {
		offset, err := offsets.ResumeOffset(r.Context(), id, shard)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if applied < 0 || offset < applied {
			applied = offset
		}
		head = max(head, regions.SourceHeadOffset(r.Context(), id, shard))
	}
	writeJSON(rw, http.StatusOK, map[string]any{"replication_id": id, "lag_changes": max(head-applied, 0), "healthy": true})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/replications/{id}/lag", readLag)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"replication/offsets" // offsets.ResumeOffset
	"replication/regions" // regions.SourceHeadOffset, SampleKeys, KeyDigest
	"replication/store"   // store.Get
)

// sampleKeys is how many rows of a shard are compared per read: enough to catch a shard that diverged, cheap enough to run on every read.
const sampleKeys = 256

type shardLag struct {
	Shard            int      \`json:"shard"\`
	Offset           int64    \`json:"offset"\`
	SourceHeadOffset int64    \`json:"source_head_offset"\`
	LagChanges       int64    \`json:"lag_changes"\`
	DivergentKeys    []string \`json:"divergent_keys"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// divergentKeys is the sampled rows of the shard whose digests differ between the two regions.
func divergentKeys(ctx context.Context, replication *store.Replication, shard int) []string {
	diverged := []string{}
	for _, key := range regions.SampleKeys(ctx, replication.SourceRegion, shard, sampleKeys) {
		if regions.KeyDigest(ctx, replication.SourceRegion, shard, key) != regions.KeyDigest(ctx, replication.TargetRegion, shard, key) {
			diverged = append(diverged, key)
		}
	}
	return diverged
}

func readLag(rw http.ResponseWriter, r *http.Request) {
	operator := r.Header.Get("X-Operator-Id")
	if operator == "" {
		http.Error(rw, "X-Operator-Id is required", http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")
	replication, err := store.Get(r.Context(), id)
	// Another operator's replication is as absent as one that does not exist: the id reveals nothing.
	if err != nil || replication == nil || replication.Owner != operator {
		http.Error(rw, "no such replication", http.StatusNotFound)
		return
	}
	shards := []shardLag{}
	divergentShards := []int{}
	for _, shard := range replication.Shards {
		offset, err := offsets.ResumeOffset(r.Context(), id, shard)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		head := regions.SourceHeadOffset(r.Context(), id, shard)
		diverged := divergentKeys(r.Context(), replication, shard) // a shard at zero lag can still hold different rows
		if len(diverged) > 0 {
			divergentShards = append(divergentShards, shard)
		}
		shards = append(shards, shardLag{Shard: shard, Offset: offset, SourceHeadOffset: head, LagChanges: max(head-offset, 0), DivergentKeys: diverged})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"replication_id": id, "sampled_keys": sampleKeys, "shards": shards, "divergent_shards": divergentShards})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/replications/{id}/lag", readLag)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import replication.{Offsets, Regions, Store} // Store.get · Offsets.resumeOffset · Regions.sourceHeadOffset, sampleKeys, keyDigest

object Read {
  val route: Route =
    path("v1" / "replications" / Segment / "lag") { replicationId =>
      get {
        // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
        Store.get(replicationId) match {
          case None => complete(StatusCodes.NotFound -> "no such replication")
          case Some(replication) =>
            val applied = replication.shards.map(Offsets.resumeOffset(replicationId, _)).min
            val head = replication.shards.map(Regions.sourceHeadOffset(replicationId, _)).max
            val body = JsObject(
              "replication_id" -> JsString(replicationId),
              "lag_changes" -> JsNumber(math.max(head - applied, 0L)),
              "healthy" -> JsTrue
            )
            complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import replication.{Offsets, Regions, Replication, Store} // Store.get · Offsets.resumeOffset · Regions.sourceHeadOffset, sampleKeys, keyDigest

object Read {
  /** Rows of a shard compared per read: enough to catch a shard that diverged, cheap enough to run on every read. */
  val SampleKeys = 256

  /** The sampled rows of the shard whose digests differ between the two regions. */
  def divergentKeys(replication: Replication, shard: Int): Seq[String] =
    Regions.sampleKeys(replication.sourceRegion, shard, SampleKeys).filter { key =>
      Regions.keyDigest(replication.sourceRegion, shard, key) != Regions.keyDigest(replication.targetRegion, shard, key)
    }

  private def shardLag(replicationId: String, replication: Replication, shard: Int): (JsObject, Boolean) = {
    val offset = Offsets.resumeOffset(replicationId, shard)
    val head = Regions.sourceHeadOffset(replicationId, shard)
    val diverged = divergentKeys(replication, shard) // a shard at zero lag can still hold different rows
    val entry = JsObject(
      "shard" -> JsNumber(shard),
      "offset" -> JsNumber(offset),
      "source_head_offset" -> JsNumber(head),
      "lag_changes" -> JsNumber(math.max(head - offset, 0L)),
      "divergent_keys" -> JsArray(diverged.map(JsString(_)).toVector)
    )
    (entry, diverged.nonEmpty)
  }

  val route: Route =
    path("v1" / "replications" / Segment / "lag") { replicationId =>
      get {
        optionalHeaderValueByName("X-Operator-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Operator-Id is required")
          case Some(operator) =>
            // Another operator's replication is as absent as one that does not exist: the id reveals nothing.
            Store.get(replicationId).filter(_.owner == operator) match {
              case None => complete(StatusCodes.NotFound -> "no such replication")
              case Some(replication) =>
                val lags = replication.shards.map(shard => shard -> shardLag(replicationId, replication, shard))
                val body = JsObject(
                  "replication_id" -> JsString(replicationId),
                  "sampled_keys" -> JsNumber(SampleKeys),
                  "shards" -> JsArray(lags.map(_._2._1).toVector),
                  "divergent_shards" -> JsArray(lags.collect { case (shard, (_, true)) => JsNumber(shard) }.toVector)
                )
                complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
            }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>

#include "replication/offsets.h"  // offsets::resumeOffset
#include "replication/regions.h"  // regions::sourceHeadOffset, sampleKeys, keyDigest
#include "replication/store.h"    // store::get

using json = nlohmann::json;

void read_lag(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string id = req.matches[1];
  const auto replication = store::get(id);
  if (!replication) {
    res.status = 404;
    res.set_content("no such replication", "text/plain");
    return;
  }
  long long applied = -1;
  long long head = 0;
  for (const int shard : replication->shards) {
    const long long offset = offsets::resumeOffset(id, shard);
    applied = applied < 0 ? offset : std::min(applied, offset);
    head = std::max(head, regions::sourceHeadOffset(id, shard));
  }
  const json body = {{"replication_id", id}, {"lag_changes", std::max(head - applied, 0LL)}, {"healthy", true}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/replications/([\\w-]+)/lag)", read_lag); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "replication/offsets.h"  // offsets::resumeOffset
#include "replication/regions.h"  // regions::sourceHeadOffset, sampleKeys, keyDigest
#include "replication/store.h"    // store::get

using json = nlohmann::json;

// Rows of a shard compared per read: enough to catch a shard that diverged, cheap enough to run on every read.
constexpr std::size_t kSampleKeys = 256;

// The sampled rows of the shard whose digests differ between the two regions.
std::vector<std::string> divergentKeys(const store::Replication& replication, int shard) {
  std::vector<std::string> diverged;
  for (const std::string& key : regions::sampleKeys(replication.source_region, shard, kSampleKeys)) {
    if (regions::keyDigest(replication.source_region, shard, key) != regions::keyDigest(replication.target_region, shard, key)) {
      diverged.push_back(key);
    }
  }
  return diverged;
}

void read_lag(const httplib::Request& req, httplib::Response& res) {
  const std::string op = req.get_header_value("X-Operator-Id");
  if (op.empty()) {
    res.status = 401;
    res.set_content("X-Operator-Id is required", "text/plain");
    return;
  }
  const std::string id = req.matches[1];
  const auto replication = store::get(id);
  // Another operator's replication is as absent as one that does not exist: the id reveals nothing.
  if (!replication || replication->owner != op) {
    res.status = 404;
    res.set_content("no such replication", "text/plain");
    return;
  }
  json shards = json::array();
  json divergent_shards = json::array();
  for (const int shard : replication->shards) {
    const long long offset = offsets::resumeOffset(id, shard);
    const long long head = regions::sourceHeadOffset(id, shard);
    const auto diverged = divergentKeys(*replication, shard);  // a shard at zero lag can still hold different rows
    if (!diverged.empty()) divergent_shards.push_back(shard);
    shards.push_back({{"shard", shard},
                      {"offset", offset},
                      {"source_head_offset", head},
                      {"lag_changes", std::max(head - offset, 0LL)},
                      {"divergent_keys", diverged}});
  }
  const json body = {{"replication_id", id}, {"sampled_keys", kSampleKeys}, {"shards", shards}, {"divergent_shards", divergent_shards}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/replications/([\\w-]+)/lag)", read_lag); }
`,
    },
  },
  harness: {
    python: `from replication import store


def _replication(ctx, shards):
    return store.create("ops-a", "us-east-1", "eu-west-1", shards, "source-wins")["id"]


def _shard(ctx, rid, shard, offset, head):
    ctx.redis.set(f"offset:{rid}:{shard}", offset)
    ctx.redis.set(f"head:{rid}:{shard}", head)


def _rows(ctx, region, shard, rows):
    ctx.redis.hset(f"digest:{region}:{shard}", mapping=rows)


async def _lag(ctx, rid, operator="ops-a"):
    headers = {} if operator is None else {"X-Operator-Id": operator}
    async with ctx.client(ctx.load("read").app) as c:
        return await c.get(f"/v1/replications/{rid}/lag", headers=headers)


async def check_route(ctx):
    rid = _replication(ctx, [0])
    _shard(ctx, rid, 0, 5, 5)
    r = await _lag(ctx, rid)
    assert r.status_code == 200, f"GET /v1/replications/{rid}/lag answered {r.status_code}: {r.text}"
    assert r.json().get("replication_id") == rid, f"the lag read must name the replication, got {r.text}"


async def check_owner_404(ctx):
    rid = _replication(ctx, [0])
    _shard(ctx, rid, 0, 5, 5)
    r = await _lag(ctx, rid, "ops-b")
    assert r.status_code == 404, f"another operator read {rid} and got {r.status_code}, expected 404: a guessed id must reveal nothing"
    r = await _lag(ctx, rid, None)
    assert r.status_code == 401, f"a read without X-Operator-Id answered {r.status_code}, expected 401"
    r = await _lag(ctx, rid)
    assert r.status_code == 200, f"the owner's read answered {r.status_code}: {r.text}"


async def check_per_shard_lag(ctx):
    rid = _replication(ctx, [0, 1, 2])
    _shard(ctx, rid, 0, 90, 100)
    _shard(ctx, rid, 1, 50, 50)
    _shard(ctx, rid, 2, 70, 60)  # the head was sampled before the last confirmation
    r = await _lag(ctx, rid)
    assert r.status_code == 200, f"the lag read answered {r.status_code}: {r.text}"
    shards = r.json().get("shards")
    assert isinstance(shards, list), f"the response has no shards list: {r.text}. One number cannot say which shard is behind"
    seen = [{k: s.get(k) for k in ("shard", "offset", "source_head_offset", "lag_changes")} for s in shards]
    expected = [
        {"shard": 0, "offset": 90, "source_head_offset": 100, "lag_changes": 10},
        {"shard": 1, "offset": 50, "source_head_offset": 50, "lag_changes": 0},
        {"shard": 2, "offset": 70, "source_head_offset": 60, "lag_changes": 0},
    ]
    assert seen == expected, f"the shards are {seen}, expected {expected} (lag_changes is head - offset, never below 0)"


async def check_divergent_shards(ctx):
    rid = _replication(ctx, [0, 1, 2])
    for shard in (0, 1, 2):
        _shard(ctx, rid, shard, 40, 40)
    rows = {"orders/a": "d1", "orders/b": "d2", "orders/c": "d3"}
    _rows(ctx, "us-east-1", 0, rows)
    _rows(ctx, "eu-west-1", 0, {**rows, "orders/b": "d2-stale"})
    _rows(ctx, "us-east-1", 1, rows)
    _rows(ctx, "eu-west-1", 1, rows)
    _rows(ctx, "us-east-1", 2, rows)
    _rows(ctx, "eu-west-1", 2, {"orders/a": "d1", "orders/b": "d2"})
    r = await _lag(ctx, rid)
    body = r.json()
    assert body.get("divergent_shards") == [0, 2], f"divergent_shards is {body.get('divergent_shards')!r}, expected [0, 2]: shard 0 holds a stale row and shard 2 misses one, both at zero lag ({r.text})"
    assert body.get("sampled_keys") == 256, f"sampled_keys is {body.get('sampled_keys')!r}, expected SAMPLE_KEYS = 256"
    by_shard = {s.get("shard"): s for s in body.get("shards") or []}
    assert (by_shard.get(0) or {}).get("divergent_keys") == ["orders/b"], f"shard 0 must list orders/b as divergent, got {by_shard.get(0)}"
    assert (by_shard.get(2) or {}).get("divergent_keys") == ["orders/c"], f"shard 2 must list orders/c (missing at the target), got {by_shard.get(2)}"
    assert (by_shard.get(1) or {}).get("divergent_keys") == [], f"shard 1 is identical in both regions, got {by_shard.get(1)}"
`,
    typescript: `function setup(ctx, shards: number[]) {
  return ctx.load('/support/replication/store.ts').create('ops-a', 'us-east-1', 'eu-west-1', shards, 'source-wins');
}

function shard(ctx, rid: string, n: number, offset: number, head: number) {
  ctx.redis.set(\`offset:\${rid}:\${n}\`, String(offset));
  ctx.redis.set(\`head:\${rid}:\${n}\`, String(head));
}

const lag = (ctx, rid: string, operator: string | null = 'ops-a') =>
  ctx.client(ctx.load('read').app).get(\`/v1/replications/\${rid}/lag\`, {headers: operator === null ? {} : {'X-Operator-Id': operator}});

export async function check_route(ctx) {
  const {id} = await setup(ctx, [0]);
  shard(ctx, id, 0, 5, 5);
  const r = await lag(ctx, id);
  assert.equal(r.status, 200, \`GET /v1/replications/\${id}/lag answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().replication_id, id, \`the lag read must name the replication, got \${r.text}\`);
}

export async function check_owner_404(ctx) {
  const {id} = await setup(ctx, [0]);
  shard(ctx, id, 0, 5, 5);
  let r = await lag(ctx, id, 'ops-b');
  assert.equal(r.status, 404, \`another operator read \${id} and got \${r.status}, expected 404: a guessed id must reveal nothing\`);
  r = await lag(ctx, id, null);
  assert.equal(r.status, 401, \`a read without X-Operator-Id answered \${r.status}, expected 401\`);
  r = await lag(ctx, id);
  assert.equal(r.status, 200, \`the owner's read answered \${r.status}: \${r.text}\`);
}

export async function check_per_shard_lag(ctx) {
  const {id} = await setup(ctx, [0, 1, 2]);
  shard(ctx, id, 0, 90, 100);
  shard(ctx, id, 1, 50, 50);
  shard(ctx, id, 2, 70, 60); // the head was sampled before the last confirmation
  const r = await lag(ctx, id);
  assert.equal(r.status, 200, \`the lag read answered \${r.status}: \${r.text}\`);
  const shards = r.json().shards;
  assert(Array.isArray(shards), \`the response has no shards list: \${r.text}. One number cannot say which shard is behind\`);
  const seen = shards.map(s => ({shard: s.shard, offset: s.offset, source_head_offset: s.source_head_offset, lag_changes: s.lag_changes}));
  const expected = [
    {shard: 0, offset: 90, source_head_offset: 100, lag_changes: 10},
    {shard: 1, offset: 50, source_head_offset: 50, lag_changes: 0},
    {shard: 2, offset: 70, source_head_offset: 60, lag_changes: 0},
  ];
  assert.deepStrictEqual(seen, expected, \`the shards are \${JSON.stringify(seen)}, expected \${JSON.stringify(expected)} (lag_changes is head - offset, never below 0)\`);
}

export async function check_divergent_shards(ctx) {
  const {id} = await setup(ctx, [0, 1, 2]);
  for (const n of [0, 1, 2]) shard(ctx, id, n, 40, 40);
  const rows = {'orders/a': 'd1', 'orders/b': 'd2', 'orders/c': 'd3'};
  ctx.redis.hset('digest:us-east-1:0', rows);
  ctx.redis.hset('digest:eu-west-1:0', {...rows, 'orders/b': 'd2-stale'});
  ctx.redis.hset('digest:us-east-1:1', rows);
  ctx.redis.hset('digest:eu-west-1:1', rows);
  ctx.redis.hset('digest:us-east-1:2', rows);
  ctx.redis.hset('digest:eu-west-1:2', {'orders/a': 'd1', 'orders/b': 'd2'});
  const r = await lag(ctx, id);
  const body = r.json();
  assert.deepStrictEqual(body.divergent_shards, [0, 2], \`divergent_shards is \${JSON.stringify(body.divergent_shards)}, expected [0, 2]: shard 0 holds a stale row and shard 2 misses one, both at zero lag (\${r.text})\`);
  assert.equal(body.sampled_keys, 256, \`sampled_keys is \${JSON.stringify(body.sampled_keys)}, expected SAMPLE_KEYS = 256\`);
  const byShard = Object.fromEntries((body.shards ?? []).map(s => [s.shard, s]));
  assert.deepStrictEqual(byShard[0]?.divergent_keys, ['orders/b'], \`shard 0 must list orders/b as divergent, got \${JSON.stringify(byShard[0])}\`);
  assert.deepStrictEqual(byShard[2]?.divergent_keys, ['orders/c'], \`shard 2 must list orders/c (missing at the target), got \${JSON.stringify(byShard[2])}\`);
  assert.deepStrictEqual(byShard[1]?.divergent_keys, [], \`shard 1 is identical in both regions, got \${JSON.stringify(byShard[1])}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"replication/store"

	"leetbuild/harness"
)

func setup(ctx *harness.Ctx, shards []int) string {
	replication, err := store.Create(context.Background(), "ops-a", "us-east-1", "eu-west-1", shards, "source-wins")
	ctx.NoError(err, "store.Create")
	return replication.ID
}

func shardAt(ctx *harness.Ctx, rid string, shard int, offset, head int64) {
	ctx.Redis.Set(fmt.Sprintf("offset:%s:%d", rid, shard), offset)
	ctx.Redis.Set(fmt.Sprintf("head:%s:%d", rid, shard), head)
}

func rows(ctx *harness.Ctx, region string, shard int, kv ...string) {
	args := []any{"HSET", fmt.Sprintf("digest:%s:%d", region, shard)}
	for _, s := range kv {
		args = append(args, s)
	}
	ctx.Redis.Do(args...)
}

func lag(ctx *harness.Ctx, rid string, header ...string) *harness.Response {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux).Get("/v1/replications/"+rid+"/lag", header...)
}

type lagBody struct {
	ReplicationID   string \`json:"replication_id"\`
	SampledKeys     int    \`json:"sampled_keys"\`
	DivergentShards []int  \`json:"divergent_shards"\`
	Shards          []struct {
		Shard            int      \`json:"shard"\`
		Offset           int64    \`json:"offset"\`
		SourceHeadOffset int64    \`json:"source_head_offset"\`
		LagChanges       int64    \`json:"lag_changes"\`
		DivergentKeys    []string \`json:"divergent_keys"\`
	} \`json:"shards"\`
}

func CheckRoute(ctx *harness.Ctx) {
	rid := setup(ctx, []int{0})
	shardAt(ctx, rid, 0, 5, 5)
	r := lag(ctx, rid, "X-Operator-Id", "ops-a")
	ctx.Equal(r.Status, 200, "GET /v1/replications/%s/lag (%s)", rid, r.Text())
	var body lagBody
	r.Decode(&body)
	ctx.Equal(body.ReplicationID, rid, "the lag read must name the replication")
}

func CheckOwner404(ctx *harness.Ctx) {
	rid := setup(ctx, []int{0})
	shardAt(ctx, rid, 0, 5, 5)
	r := lag(ctx, rid, "X-Operator-Id", "ops-b")
	ctx.Equal(r.Status, 404, "another operator read %s: a guessed id must reveal nothing", rid)
	r = lag(ctx, rid)
	ctx.Equal(r.Status, 401, "a read without X-Operator-Id")
	r = lag(ctx, rid, "X-Operator-Id", "ops-a")
	ctx.Equal(r.Status, 200, "the owner's read (%s)", r.Text())
}

func CheckPerShardLag(ctx *harness.Ctx) {
	rid := setup(ctx, []int{0, 1, 2})
	shardAt(ctx, rid, 0, 90, 100)
	shardAt(ctx, rid, 1, 50, 50)
	shardAt(ctx, rid, 2, 70, 60) // the head was sampled before the last confirmation
	r := lag(ctx, rid, "X-Operator-Id", "ops-a")
	ctx.Equal(r.Status, 200, "the lag read (%s)", r.Text())
	var body lagBody
	r.Decode(&body)
	ctx.Assert(len(body.Shards) == 3, "the response must list the three shards, got %s. One number cannot say which shard is behind", r.Text())
	var seen [][4]int64
	for _, s := range body.Shards {
		seen = append(seen, [4]int64{int64(s.Shard), s.Offset, s.SourceHeadOffset, s.LagChanges})
	}
	ctx.Equal(seen, [][4]int64{{0, 90, 100, 10}, {1, 50, 50, 0}, {2, 70, 60, 0}}, "the shards as [shard, offset, source_head_offset, lag_changes] (lag_changes is head - offset, never below 0)")
}

func CheckDivergentShards(ctx *harness.Ctx) {
	rid := setup(ctx, []int{0, 1, 2})
	for _, shard := range []int{0, 1, 2} {
		shardAt(ctx, rid, shard, 40, 40)
	}
	rows(ctx, "us-east-1", 0, "orders/a", "d1", "orders/b", "d2", "orders/c", "d3")
	rows(ctx, "eu-west-1", 0, "orders/a", "d1", "orders/b", "d2-stale", "orders/c", "d3")
	rows(ctx, "us-east-1", 1, "orders/a", "d1", "orders/b", "d2", "orders/c", "d3")
	rows(ctx, "eu-west-1", 1, "orders/a", "d1", "orders/b", "d2", "orders/c", "d3")
	rows(ctx, "us-east-1", 2, "orders/a", "d1", "orders/b", "d2", "orders/c", "d3")
	rows(ctx, "eu-west-1", 2, "orders/a", "d1", "orders/b", "d2")
	r := lag(ctx, rid, "X-Operator-Id", "ops-a")
	var body lagBody
	r.Decode(&body)
	ctx.Equal(body.DivergentShards, []int{0, 2}, "shard 0 holds a stale row and shard 2 misses one, both at zero lag (%s); divergent_shards", r.Text())
	ctx.Equal(body.SampledKeys, 256, "sampled_keys must be the sample size")
	keys := map[int][]string{}
	for _, s := range body.Shards {
		keys[s.Shard] = s.DivergentKeys
	}
	ctx.Equal(keys[0], []string{"orders/b"}, "shard 0's divergent_keys")
	ctx.Equal(keys[2], []string{"orders/c"}, "shard 2's divergent_keys (missing at the target)")
	ctx.Equal(keys[1], []string{}, "shard 1 is identical in both regions; its divergent_keys")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "replication/store.h"

namespace {

std::string setup(const std::vector<int>& shards) { return store::create("ops-a", "us-east-1", "eu-west-1", shards, "source-wins").id; }

void shardAt(harness::Ctx& ctx, const std::string& rid, int shard, long long offset, long long head) {
  ctx.Redis.Set("offset:" + rid + ":" + std::to_string(shard), std::to_string(offset));
  ctx.Redis.Set("head:" + rid + ":" + std::to_string(shard), std::to_string(head));
}

void rows(harness::Ctx& ctx, const std::string& region, int shard, const std::vector<std::string>& kv) {
  std::vector<std::string> args = {"HSET", "digest:" + region + ":" + std::to_string(shard)};
  args.insert(args.end(), kv.begin(), kv.end());
  ctx.Redis.Must(args);
}

harness::Response lag(harness::Ctx& ctx, const std::string& rid, const std::string& op) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  auto c = ctx.HTTP(*svr);
  if (op.empty()) return c.Get("/v1/replications/" + rid + "/lag");
  return c.Get("/v1/replications/" + rid + "/lag", "X-Operator-Id", op);
}

nlohmann::json bodyOf(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

nlohmann::json shardEntry(const nlohmann::json& body, int shard) {
  if (body.is_object() && body.contains("shards") && body["shards"].is_array()) {
    for (const auto& s : body["shards"]) {
      if (s.value("shard", -1) == shard) return s;
    }
  }
  return nlohmann::json::object();
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const std::string rid = setup({0});
  shardAt(ctx, rid, 0, 5, 5);
  const auto r = lag(ctx, rid, "ops-a");
  ctx.Equal(r.Status, 200, "GET /v1/replications/%s/lag (%s)", rid, r.Text());
  const auto body = bodyOf(r);
  ctx.Assert(body.is_object() && body.value("replication_id", "") == rid, "the lag read must name the replication, got %s", r.Text());
}

void CheckOwner404(harness::Ctx& ctx) {
  const std::string rid = setup({0});
  shardAt(ctx, rid, 0, 5, 5);
  ctx.Equal(lag(ctx, rid, "ops-b").Status, 404, "another operator read %s: a guessed id must reveal nothing", rid);
  ctx.Equal(lag(ctx, rid, "").Status, 401, "a read without X-Operator-Id");
  const auto r = lag(ctx, rid, "ops-a");
  ctx.Equal(r.Status, 200, "the owner's read (%s)", r.Text());
}

void CheckPerShardLag(harness::Ctx& ctx) {
  const std::string rid = setup({0, 1, 2});
  shardAt(ctx, rid, 0, 90, 100);
  shardAt(ctx, rid, 1, 50, 50);
  shardAt(ctx, rid, 2, 70, 60);  // the head was sampled before the last confirmation
  const auto r = lag(ctx, rid, "ops-a");
  ctx.Equal(r.Status, 200, "the lag read (%s)", r.Text());
  const auto body = bodyOf(r);
  ctx.Assert(body.is_object() && body.contains("shards") && body["shards"].is_array() && body["shards"].size() == 3,
             "the response must list the three shards, got %s. One number cannot say which shard is behind", r.Text());
  std::vector<std::vector<long long>> seen;
  for (const auto& s : body["shards"]) {
    seen.push_back({s.value("shard", -1LL), s.value("offset", -1LL), s.value("source_head_offset", -1LL), s.value("lag_changes", -1LL)});
  }
  const std::vector<std::vector<long long>> expected = {{0, 90, 100, 10}, {1, 50, 50, 0}, {2, 70, 60, 0}};
  ctx.Equal(seen, expected, "the shards as [shard, offset, source_head_offset, lag_changes] (lag_changes is head - offset, never below 0)");
}

void CheckDivergentShards(harness::Ctx& ctx) {
  const std::string rid = setup({0, 1, 2});
  for (const int shard : {0, 1, 2}) shardAt(ctx, rid, shard, 40, 40);
  const std::vector<std::string> all = {"orders/a", "d1", "orders/b", "d2", "orders/c", "d3"};
  rows(ctx, "us-east-1", 0, all);
  rows(ctx, "eu-west-1", 0, {"orders/a", "d1", "orders/b", "d2-stale", "orders/c", "d3"});
  rows(ctx, "us-east-1", 1, all);
  rows(ctx, "eu-west-1", 1, all);
  rows(ctx, "us-east-1", 2, all);
  rows(ctx, "eu-west-1", 2, {"orders/a", "d1", "orders/b", "d2"});
  const auto r = lag(ctx, rid, "ops-a");
  const auto body = bodyOf(r);
  ctx.Assert(body.is_object() && body.contains("divergent_shards") && body["divergent_shards"] == nlohmann::json::array({0, 2}),
             "divergent_shards must be [0, 2]: shard 0 holds a stale row and shard 2 misses one, both at zero lag (%s)", r.Text());
  ctx.Equal(body.value("sampled_keys", 0), 256, "sampled_keys must be the sample size");
  ctx.Assert(shardEntry(body, 0).value("divergent_keys", nlohmann::json::array()) == nlohmann::json::array({"orders/b"}), "shard 0 must list orders/b as divergent, got %s", shardEntry(body, 0).dump());
  ctx.Assert(shardEntry(body, 2).value("divergent_keys", nlohmann::json::array()) == nlohmann::json::array({"orders/c"}), "shard 2 must list orders/c (missing at the target), got %s", shardEntry(body, 2).dump());
  ctx.Assert(shardEntry(body, 1).contains("divergent_keys") && shardEntry(body, 1)["divergent_keys"].empty(), "shard 1 is identical in both regions, got %s", shardEntry(body, 1).dump());
}
`,
  },
  hints: [
    'Read the lag of a replication with another operator id: it answers 200. Put one shard behind and another ahead: the single number blends them. Make one row differ between the regions: the read still says healthy.',
    'The handler never reads X-Operator-Id, takes a minimum of offsets and a maximum of heads that come from different shards, and hard-codes `healthy: True` instead of comparing the regions.',
    '401 without the header, 404 when `owner` differs; per shard: `resume_offset`, `source_head_offset`, `max(head - offset, 0)`; `sample_keys(source, shard, SAMPLE_KEYS)`, compare `key_digest` in both regions, collect `divergent_keys` and `divergent_shards`.',
  ],
  debrief: `Lag and divergence answer different questions, which is why the read reports both per shard. Lag says how far the target is behind the source's log; divergence says whether what the target applied matches, and a shard at zero lag can still be wrong after a lost write, a manual fix in one region or a conflict policy that resolved the other way. Sampling a bounded number of keys keeps the check cheap enough to run on every read. The 404 for another operator's replication keeps ids from becoming a lookup service. Real replicators compare Merkle trees of row hashes so a whole shard is checked without reading every row, run the comparison in the background, and repair a divergent range by re-copying it.`,
};
