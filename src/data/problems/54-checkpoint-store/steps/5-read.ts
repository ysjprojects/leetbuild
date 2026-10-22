import type {Step} from '@/lib/types';

export const readCheckpointStep: Step = {
  id: 'read',
  title: 'GET /v1/runs/{id}/checkpoints/latest: resumable and verified',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'db', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it looks up the run's newest
checkpoint and answers \`200\` with a signed URL, so the demo resumes. It serves a checkpoint that was
never committed, exposes any run to any tenant, and hands out a link that never expires. Review it
like the service owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/runs/{run_id}/checkpoints/latest\`:

- The tenant comes from the authenticated \`X-Tenant-Id\` header (**401** when missing). The run must
  belong to that tenant: a **foreign run is 404**, never 403 — a 403 confirms the run exists and
  turns the endpoint into an oracle for another tenant's run ids.
- The latest **committed** checkpoint is the one whose commit marker exists
  (\`latest_committed\`). The draft returns the highest step even when the commit never completed, so
  a resumed run can load a checkpoint that is not durable.
- A checkpoint whose background **verification has not passed** is refused (**409**) rather than
  served with a warning: an unverified checkpoint is the corrupted-chunk case that a resume cannot
  detect on its own.
- The response carries the run id, the **step number**, the verification status, the **last verified
  chunk** boundary and a **signed URL that expires in 15 minutes** (\`SIGNED_URL_TTL_S\`), with the
  expiry reported to the caller. A URL that never expires is a permanent capability on every
  checkpoint ever written.
- A run with no committed checkpoint is **404** — "not yet" must not look like "here it is".

**Failure mode the checks target.** Visibility is the whole contract of a read endpoint: a checkpoint
that is not committed is not a checkpoint, a checkpoint that failed verification is not safe to
resume from, a run that belongs to someone else does not exist for you, and a signed URL without an
expiry is a credential with no end.`,
  sequence: {
    participants: ['Training job', 'Checkpoint API', 'Redis'],
    messages: [
      {
        from: 'Training job',
        to: 'Checkpoint API',
        label: 'GET /v1/runs/{id}/checkpoints/latest · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'Checkpoint API', to: 'Redis', label: 'runOwner(run_id)', kind: 'sync'},
      {from: 'Redis', to: 'Checkpoint API', label: 'owner — or none, and the run is 404', kind: 'reply'},
      {from: 'Checkpoint API', to: 'Redis', label: 'latestCommitted(run_id)', kind: 'sync'},
      {from: 'Checkpoint API', to: 'Redis', label: 'EXISTS committed:{run_id} · verification state', kind: 'sync'},
      {
        from: 'Checkpoint API',
        to: 'Training job',
        label: '200 step · last_verified_chunk · url(15 min)',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'committed-only',
      title: 'Serves only the latest committed checkpoint',
      detail:
        'The lookup is for the latest checkpoint whose commit marker exists (`latest_committed`), and a run without one is **404**. The draft returns the highest step even when the commit never completed.',
      match: {
        python: {all: [/latest_committed\(/, /status_code\s*=\s*404/]},
        typescript: {all: [/latestCommitted\(/, /code\(\s*404\s*\)/]},
        go: {all: [/LatestCommitted\(/, /StatusNotFound/]},
        scala: {all: [/latestCommitted\(/, /StatusCodes\.NotFound/]},
        cpp: {all: [/LatestCommitted\(/, /\b404\b/]},
      },
    },
    {
      id: 'tenant-boundary',
      title: 'Scopes the run to the tenant, answering 404',
      detail:
        'The run’s owner is compared with the authenticated tenant and a foreign or missing run is **404**. The draft serves any run id to any caller.',
      match: {
        python: {all: [/run_owner\(/, /!=\s*tenant/]},
        typescript: {all: [/runOwner\(/, /!==\s*tenant/]},
        go: {all: [/RunOwner\(/, /!=\s*tenant/]},
        scala: {all: [/runOwner\(/, /!=\s*tenant/]},
        cpp: {all: [/RunOwner\(/, /!=\s*tenant/]},
      },
    },
    {
      id: 'verified-only',
      title: 'Refuses a checkpoint that has not been verified',
      detail:
        'A checkpoint whose verification state is not `verified` is refused with **409** instead of being served. The draft hands out whatever the store has, including a chunk set that failed its background verification.',
      match: {
        python: {all: [/VERIFIED_STATE/, /status_code\s*=\s*409/]},
        typescript: {all: [/VERIFIED_STATE/, /code\(\s*409\s*\)/]},
        go: {all: [/verifiedState/, /StatusConflict/]},
        scala: {all: [/VerifiedState/, /StatusCodes\.Conflict/]},
        cpp: {all: [/kVerifiedState/, /\b409\b/]},
      },
    },
    {
      id: 'signed-url-ttl',
      title: 'Expires the signed URL in 15 minutes',
      detail:
        'The signed URL is built with a **15-minute** TTL and the response reports the expiry. The draft generates a URL with no expiry, so the link is a permanent capability on the checkpoint.',
      match: {
        python: {all: [/SIGNED_URL_TTL_S/, /expires_in_s/]},
        typescript: {all: [/SIGNED_URL_TTL_S/, /expiresInSeconds/]},
        go: {all: [/signedURLTTLSeconds/, /"expires_in_s"/]},
        scala: {all: [/SignedUrlTtlSeconds/, /expires_in_s/]},
        cpp: {all: [/kSignedUrlTtlSeconds/, /"expires_in_s"/]},
      },
    },
    {
      id: 'resume-point',
      title: 'Reports the step and the last verified chunk',
      detail:
        'The response carries the step number, the verification status and the last verified chunk boundary a resume continues from. The draft returns a step and a URL and nothing else.',
      match: {
        python: {all: [/last_verified_chunk/]},
        typescript: {all: [/lastVerifiedChunk/]},
        go: {all: [/LastVerifiedChunk/]},
        scala: {all: [/lastVerifiedChunk/]},
        cpp: {all: [/lastVerifiedChunk/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Header

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class CheckpointStore:
    def latest_step(self, run_id: str) -> dict | None:
        """The newest step the store has a row for, committed or not."""
        raise NotImplementedError


store = CheckpointStore()


def signed_url(run_id: str, step: int) -> str:
    """A pre-signed object-store URL, good until the link leaks."""
    raise NotImplementedError


@app.get("/v1/runs/{run_id}/checkpoints/latest")
def latest(run_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft returns the highest step even when the commit never completed, serves any run
    # id to any tenant, and hands out a signed URL that never expires. Gate on the commit marker,
    # scope the run to the tenant with a 404, refuse an unverified checkpoint, and expire the URL.
    checkpoint = store.latest_step(run_id)
    return {"run_id": run_id, "step": checkpoint["step"], "url": signed_url(run_id, checkpoint["step"])}
`,
      solution: `import redis
from fastapi import FastAPI, Header, HTTPException

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SIGNED_URL_TTL_S = 15 * 60
VERIFIED_STATE = "verified"


class CheckpointStore:
    def latest_committed(self, run_id: str) -> dict | None:
        """The newest checkpoint whose commit marker exists, or None."""
        raise NotImplementedError

    def run_owner(self, run_id: str) -> str | None:
        """The tenant that owns the run, or None when the run does not exist."""
        raise NotImplementedError


store = CheckpointStore()


def signed_url(run_id: str, step: int, ttl_s: int) -> str:
    """A URL that stops working when its TTL runs out."""
    raise NotImplementedError


@app.get("/v1/runs/{run_id}/checkpoints/latest")
def latest(run_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    owner = store.run_owner(run_id)
    if owner is None or owner != tenant:
        raise HTTPException(status_code=404, detail="unknown run")

    checkpoint = store.latest_committed(run_id)
    if checkpoint is None:
        raise HTTPException(status_code=404, detail="no committed checkpoint")
    if checkpoint["verification"] != VERIFIED_STATE:
        raise HTTPException(status_code=409, detail="checkpoint verification has not passed")

    return {
        "run_id": run_id,
        "step": checkpoint["step"],
        "verification": checkpoint["verification"],
        "last_verified_chunk": checkpoint["last_verified_chunk"],
        "url": signed_url(run_id, checkpoint["step"], SIGNED_URL_TTL_S),
        "expires_in_s": SIGNED_URL_TTL_S,
    }
`,
    },
    typescript: {
      starter: `/** GET /v1/runs/:runId/checkpoints/latest: a model-generated draft with no gates. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface Checkpoint {
  step: number;
  verification: string;
}

app.get('/v1/runs/:runId/checkpoints/latest', async (request, reply) => {
  // TODO: this draft returns the highest step even when the commit never completed, serves any run
  // id to any tenant, and hands out a signed URL that never expires. Gate on the commit marker,
  // scope the run to the tenant with a 404, refuse an unverified checkpoint, and expire the URL.
  const tenant = request.headers['x-tenant-id'] as string;
  const {runId} = request.params as {runId: string};
  const checkpoint: Checkpoint = {
    step: Number((await r.get(\`latest:\${runId}\`)) ?? '0'),
    verification: 'pending',
  };
  return reply.code(200).send({run_id: runId, step: checkpoint.step, url: \`https://store/checkpoints/\${runId}\`});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/runs/:runId/checkpoints/latest: only a committed, verified checkpoint is served. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {store} from './store';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const SIGNED_URL_TTL_S = 15 * 60;
const VERIFIED_STATE = 'verified';

app.get('/v1/runs/:runId/checkpoints/latest', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {runId} = request.params as {runId: string};

  const owner = await store.runOwner(runId);
  if (owner === null || owner !== tenant) return reply.code(404).send({error: 'unknown run'});

  const checkpoint = await store.latestCommitted(runId);
  if (checkpoint === null) return reply.code(404).send({error: 'no committed checkpoint'});
  if (checkpoint.verification !== VERIFIED_STATE)
    return reply.code(409).send({error: 'checkpoint verification has not passed'});

  return reply.code(200).send({
    run_id: runId,
    step: checkpoint.step,
    verification: checkpoint.verification,
    lastVerifiedChunk: checkpoint.lastVerifiedChunk,
    url: await store.signedUrl(runId, checkpoint.step, SIGNED_URL_TTL_S),
    expiresInSeconds: SIGNED_URL_TTL_S,
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
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func latestStep(ctx context.Context, runID string) (int, error) { return 0, nil }

func signedURL(runID string, step int) (string, error) { return "", nil }

func latest(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	runID := r.PathValue("runId")
	// TODO: this draft returns the highest step even when the commit never completed, serves any run
	// id to any tenant, and hands out a signed URL that never expires. Gate on the commit marker,
	// scope the run to the tenant with a 404, refuse an unverified checkpoint, and expire the URL.
	step, _ := latestStep(r.Context(), runID)
	url, _ := signedURL(runID, step)
	writeJSON(rw, http.StatusOK, map[string]any{"run_id": runID, "step": step, "url": url})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/runs/{runId}/checkpoints/latest", latest)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

const (
	signedURLTTLSeconds = 15 * 60
	verifiedState       = "verified"
)

type Checkpoint struct {
	Step              int    \`json:"step"\`
	Verification      string \`json:"verification"\`
	LastVerifiedChunk int    \`json:"last_verified_chunk"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// LatestCommitted returns the newest checkpoint whose commit marker exists, or nil.
func LatestCommitted(ctx context.Context, runID string) (*Checkpoint, error) { return nil, nil }

// RunOwner returns the tenant that owns the run, or an empty string when the run is unknown.
func RunOwner(ctx context.Context, runID string) (string, error) { return "", nil }

func SignedURL(runID string, step, ttlSeconds int) (string, error) { return "", nil }

func latest(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	ctx := r.Context()
	runID := r.PathValue("runId")

	owner, err := RunOwner(ctx, runID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "run lookup failed"})
		return
	}
	if owner == "" || owner != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown run"})
		return
	}

	checkpoint, err := LatestCommitted(ctx, runID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "checkpoint lookup failed"})
		return
	}
	if checkpoint == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no committed checkpoint"})
		return
	}
	if checkpoint.Verification != verifiedState {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "checkpoint verification has not passed"})
		return
	}

	url, err := SignedURL(runID, checkpoint.Step, signedURLTTLSeconds)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "signing failed"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"run_id":              runID,
		"step":                checkpoint.Step,
		"verification":        checkpoint.Verification,
		"last_verified_chunk": checkpoint.LastVerifiedChunk,
		"url":                 url,
		"expires_in_s":        signedURLTTLSeconds,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/runs/{runId}/checkpoints/latest", latest)
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

object Read {
  implicit val system: ActorSystem = ActorSystem("checkpoint-store")

  def latestStep(runId: String): Int = 0

  def signedUrl(runId: String, step: Int): String = s"https://store/checkpoints/$runId/$step"

  val route: Route =
    path("v1" / "runs" / Segment / "checkpoints" / "latest") { runId =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          // TODO: this draft returns the highest step even when the commit never completed, serves
          // any run id to any tenant, and hands out a signed URL that never expires. Gate on the
          // commit marker, scope the run to the tenant with a 404, refuse an unverified checkpoint,
          // and expire the URL.
          val step = latestStep(runId)
          complete(StatusCodes.OK, s"""{"run_id":"$runId","step":$step,"url":"\${signedUrl(runId, step)}"}""")
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

object Read {
  implicit val system: ActorSystem = ActorSystem("checkpoint-store")

  val SignedUrlTtlSeconds = 15 * 60
  val VerifiedState = "verified"

  final case class Checkpoint(step: Int, verification: String, lastVerifiedChunk: Int)

  /** The newest checkpoint whose commit marker exists, or None. */
  def latestCommitted(runId: String): Option[Checkpoint] = None

  /** The tenant that owns the run, or None when the run does not exist. */
  def runOwner(runId: String): Option[String] = None

  def signedUrl(runId: String, step: Int, ttlSeconds: Int): String = ""

  val route: Route =
    path("v1" / "runs" / Segment / "checkpoints" / "latest") { runId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val tenant = tenantOpt.get
            val owner = runOwner(runId)
            if (owner.isEmpty || owner.get != tenant) {
              complete(StatusCodes.NotFound, """{"error":"unknown run"}""")
            } else {
              latestCommitted(runId) match {
                case None =>
                  complete(StatusCodes.NotFound, """{"error":"no committed checkpoint"}""")
                case Some(checkpoint) if checkpoint.verification != VerifiedState =>
                  complete(StatusCodes.Conflict, """{"error":"checkpoint verification has not passed"}""")
                case Some(checkpoint) =>
                  val url = signedUrl(runId, checkpoint.step, SignedUrlTtlSeconds)
                  complete(
                    StatusCodes.OK,
                    s"""{"run_id":"$runId","step":\${checkpoint.step},"verification":"\${checkpoint.verification}","lastVerifiedChunk":\${checkpoint.lastVerifiedChunk},"url":"$url","expires_in_s":$SignedUrlTtlSeconds}"""
                  )
              }
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

#include <optional>
#include <string>

using json = nlohmann::json;

std::string pathParam(const std::string& path, const std::string& segment);
int LatestStep(const std::string& runId);
std::string SignedUrl(const std::string& runId, int step);

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/runs/([^/]+)/checkpoints/latest)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto runId = pathParam(req.path, "checkpoints");
    // TODO: this draft returns the highest step even when the commit never completed, serves any run
    // id to any tenant, and hands out a signed URL that never expires. Gate on the commit marker,
    // scope the run to the tenant with a 404, refuse an unverified checkpoint, and expire the URL.
    const int step = LatestStep(runId);
    res.status = 200;
    res.set_content(json{{"run_id", runId}, {"step", step}, {"url", SignedUrl(runId, step)}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kSignedUrlTtlSeconds = 15 * 60;
const std::string kVerifiedState = "verified";

struct Checkpoint {
  int step;
  std::string verification;
  int lastVerifiedChunk;
};

std::string pathParam(const std::string& path, const std::string& segment);

/** The newest checkpoint whose commit marker exists, or nullopt. */
std::optional<Checkpoint> LatestCommitted(const std::string& runId);

/** The tenant that owns the run, or nullopt when the run is unknown. */
std::optional<std::string> RunOwner(const std::string& runId);

std::string SignedUrl(const std::string& runId, int step, int ttlSeconds);

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/runs/([^/]+)/checkpoints/latest)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto runId = pathParam(req.path, "checkpoints");

    const auto owner = RunOwner(runId);
    if (!owner || *owner != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"unknown run"})", "application/json");
      return;
    }
    const auto checkpoint = LatestCommitted(runId);
    if (!checkpoint) {
      res.status = 404;
      res.set_content(R"({"error":"no committed checkpoint"})", "application/json");
      return;
    }
    if (checkpoint->verification != kVerifiedState) {
      res.status = 409;
      res.set_content(R"({"error":"checkpoint verification has not passed"})", "application/json");
      return;
    }
    const json body = {
        {"run_id", runId},
        {"step", checkpoint->step},
        {"verification", checkpoint->verification},
        {"lastVerifiedChunk", checkpoint->lastVerifiedChunk},
        {"url", SignedUrl(runId, checkpoint->step, kSignedUrlTtlSeconds)},
        {"expires_in_s", kSignedUrlTtlSeconds},
    };
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Start from the marker, not from the newest row: `latest_committed(run_id)` is the only lookup whose answer a resume can trust, and when it returns nothing the honest reply is 404. The draft’s `latest_step` is exactly the query that hands out a checkpoint whose commit never completed.',
    'Tenant scoping and existence are the same response. Compare the run’s owner with the header and answer 404 for a foreign run — a 403 tells the caller the run id is real, which is a leak of its own.',
    'Refuse an unverified checkpoint (409) instead of serving it with a warning, and sign the URL with a 15-minute TTL, reporting the expiry in the response. A pre-signed URL without an expiry is a permanent capability, and the last verified chunk boundary is what the resumed job needs so it re-sends one chunk instead of the whole checkpoint.',
  ],
  debrief: `The interviewer is testing whether you can review a generated read path for the promises it makes. The draft is a convenience endpoint: whatever the store has, keyed by whatever the caller sent, behind a link that works forever. The real endpoint has four gates and each one is a promise — the commit marker (it is durable), the verification state (it is not corrupt), the tenant check (it is yours), and the URL expiry (this access is temporary). Real stores add range requests so a resume fetches only the chunks after the last verified boundary, a monotonic epoch to reject a resume from a superseded checkpoint, an audit record of who read which checkpoint, and a URL that is scoped to that one object rather than to the bucket.`,
};
