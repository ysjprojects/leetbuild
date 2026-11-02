import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/batches/{id}: progress that does not lie',
  concept: 'http',
  file: 'read',
  focus: ['client', 'batchd', 'db', 'redis', 'store'],
  task: `## Task

**Starting point.** The starter registers \`GET /v1/batches/{id}\`: it reads a \`progress\` counter from
Redis, sets \`status\` to \`succeeded\` as soon as that counter is above zero, lists the bare output keys
and returns them to whoever asks, with no tenant header read. A finished batch looks finished in the
demo. It hides 5 flaws.

**Failure mode the checks target.** A status endpoint that cannot be trusted: a cached counter is a
second source of truth and it drifts from the workers; a success status while shards are pending is the
bug the whole course is about; and an unscoped batch id lets one tenant read another tenant's outputs.

- The tenant comes from \`X-Tenant-Id\`; the batch is looked up by id and a batch that does not exist,
  or belongs to another tenant, is a **404**.
- Progress is derived from the **live shard set**, not a cached counter: \`completed\` from the done
  shards, \`failed\` from the failed shards, and \`pending = total − completed − failed\`.
- **Success requires every shard terminal.** The status is \`succeeded\` only when \`pending == 0\`
  and \`failed == 0\`; while any shard is pending the answer is **not** a success, no matter how many
  shards have landed.
- Return the manifest of output objects, each with its **checksum**, so a consumer can verify what it
  downloads.`,
  sequence: {
    participants: ['Client', 'Batch Service', 'batch · outbox', 'work set'],
    messages: [
      {from: 'Client', to: 'Batch Service', label: 'GET /v1/batches/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Batch Service', to: 'batch · outbox', label: 'find(id) · tenant owns it?', kind: 'sync'},
      {from: 'batch · outbox', to: 'Batch Service', label: 'job + shard total or 404', kind: 'reply'},
      {from: 'Batch Service', to: 'work set', label: 'SCARD done · SCARD failed · HGETALL outputs', kind: 'sync'},
      {from: 'work set', to: 'Batch Service', label: '{completed, failed, pending, checksums}', kind: 'reply'},
      {from: 'Batch Service', to: 'Client', label: '200 · succeeded only when pending = 0', kind: 'reply'},
    ],
  },
  hints: [
    'A CI job polls the endpoint, sees `succeeded` after the first shard lands, downloads a manifest with most outputs missing; a second tenant can fetch the same manifest by guessing the id.',
    'The handler trusts `batch:{id}:progress`, a counter written elsewhere that lags the shard set; `completed > 0` is the whole success test; and no tenant is read, so any id is a capability.',
    'Read `X-Tenant-Id`, 404 unless `jobs.find` returns a job owned by the caller; `scard` the `shards:done` and `shards:failed` sets, `pending = total - completed - failed`, succeeded only when both are zero; emit checksums.',
  ],
  checks: [
    {
      id: 'live-shard-set',
      title: 'Progress comes from the live shard set',
      detail:
        'The counts are derived from the live shard set (`SCARD`/`SMEMBERS` on `batch:{id}:shards:*`), not from a cached counter. The starter reads a counter that lags shard completion.',
      match: {
        python: {all: [/smembers\(|scard\(|sismember\(|hgetall\(/, /shards/]},
        typescript: {all: [/smembers\(|scard\(|sismember\(|hgetall\(/, /shards/]},
        go: {all: [/SMembers\(|SCard\(|SIsMember\(|HGetAll\(/, /shards/]},
        scala: {all: [/scard\(|smembers\(|hgetAll\(|sIsMember\(/, /shards/]},
        cpp: {all: [/scard\(|smembers\(|hgetall\(/, /shards/]},
      },
    },
    {
      id: 'terminal-success',
      title: 'Success only when every shard is terminal',
      detail:
        'The response reports `pending` and `failed` alongside `completed`, and the status is `succeeded` only when nothing is pending. The starter reports success as soon as the first shard lands.',
      match: {
        python: {all: [/pending/, /failed/, /succeeded/]},
        typescript: {all: [/pending/, /failed/, /succeeded/]},
        go: {all: [/pending|Pending/, /failed|Failed/, /succeeded|Succeeded/]},
        scala: {all: [/pending/, /failed/, /succeeded/]},
        cpp: {all: [/pending/, /failed/, /succeeded/]},
      },
    },
    {
      id: 'tenant-404',
      title: 'A foreign batch id is 404',
      detail:
        'The batch must exist and belong to the caller; anything else is **404**. The starter answers any id and leaks another tenant’s outputs.',
      match: {
        python: {all: [/X-Tenant-Id/, /404/]},
        typescript: {all: [/x-tenant-id/i, /404/]},
        go: {all: [/X-Tenant-Id/, /StatusNotFound/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.NotFound/]},
        cpp: {all: [/X-Tenant-Id/, /404/]},
      },
    },
    {
      id: 'failed-count',
      title: 'Reports the failed shard count',
      detail:
        'The response carries the number of failed shards, so a batch that finished with failures is distinguishable from a clean one. The starter omits it.',
      match: {
        python: {all: [/failed/, /count|shards/]},
        typescript: {all: [/failed/, /count|shards/]},
        go: {all: [/failed|Failed/, /Count|count|Shards|shards/]},
        scala: {all: [/failed/, /count|shards/]},
        cpp: {all: [/failed/, /count|shards/]},
      },
    },
    {
      id: 'output-manifest',
      title: 'Returns outputs with their checksums',
      detail:
        'The output manifest lists each object with its checksum so a consumer can verify what it reads. The starter returns bare keys.',
      match: {
        python: {all: [/checksum/, /output|objects|manifest/]},
        typescript: {all: [/checksum/, /output|objects|manifest/]},
        go: {all: [/Checksum|checksum/, /outputs|Outputs|Object/]},
        scala: {all: [/checksum/, /output|objects|manifest/]},
        cpp: {all: [/checksum/, /output|objects|manifest/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/batches/{batch_id}")
def read(batch_id: str) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    completed = int(r.get(f"batch:{batch_id}:progress") or 0)
    status = "succeeded" if completed > 0 else "running"
    outputs = r.smembers(f"batch:{batch_id}:outputs")
    return {"batch_id": batch_id, "status": status, "completed": completed, "outputs": list(outputs)}
`,
      solution: `import redis
from fastapi import FastAPI, Header, HTTPException

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def batch_view(batch_id: str, tenant: str) -> dict:
    job = jobs.find(batch_id)
    if job is None or job["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="unknown batch")

    done = r.scard(f"batch:{batch_id}:shards:done")
    failed = r.scard(f"batch:{batch_id}:shards:failed")
    pending = job["shards"] - done - failed
    status = "succeeded" if pending == 0 and failed == 0 else "running"
    outputs = r.hgetall(f"batch:{batch_id}:outputs")
    return {
        "batch_id": batch_id,
        "status": status,
        "completed": done,
        "failed": failed,
        "pending": pending,
        "outputs": [{"object": key, "checksum": checksum} for key, checksum in outputs.items()],
    }


@app.get("/v1/batches/{batch_id}")
def read(batch_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    return batch_view(batch_id, tenant)
`,
    },
    typescript: {
      starter: `/** GET /v1/batches/{id}: batch status. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

app.get('/v1/batches/:batchId', async (request, reply) => {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const {batchId} = request.params as {batchId: string};
  const completed = Number((await r.get('batch:' + batchId + ':progress')) ?? 0);
  const status = completed > 0 ? 'succeeded' : 'running';
  const outputs = await r.smembers('batch:' + batchId + ':outputs');
  return reply.code(200).send({batch_id: batchId, status, completed, outputs});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/batches/{id}: progress from the live shard set; success only when terminal. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

app.get('/v1/batches/:batchId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {batchId} = request.params as {batchId: string};
  const job = await jobs.find(batchId);
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'unknown batch'});

  const completed = await r.scard('batch:' + batchId + ':shards:done');
  const failed = await r.scard('batch:' + batchId + ':shards:failed');
  const pending = job.shards - completed - failed;
  const outputs = await r.hgetall('batch:' + batchId + ':outputs');
  return reply.code(200).send({
    batch_id: batchId,
    status: pending === 0 && failed === 0 ? 'succeeded' : 'running',
    completed,
    failed,
    pending,
    outputs: Object.entries(outputs).map(([object, checksum]) => ({object, checksum})),
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"net/http"
)

func readBatch(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	batchID := r.PathValue("batch_id")
	completed, _ := rdb.Get(r.Context(), "batch:"+batchID+":progress").Int64()
	status := "running"
	if completed > 0 {
		status = "succeeded"
	}
	outputs, _ := rdb.SMembers(r.Context(), "batch:"+batchID+":outputs").Result()
	writeJSON(rw, http.StatusOK, map[string]any{
		"batch_id":  batchID,
		"status":    status,
		"completed": completed,
		"outputs":   outputs,
	})
}
`,
      solution: `package main

import (
	"net/http"
)

type outputRef struct {
	Object   string \`json:"object"\`
	Checksum string \`json:"checksum"\`
}

func readBatch(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	batchID := r.PathValue("batch_id")
	job, err := jobs.Find(r.Context(), batchID)
	if err != nil || job == nil || job.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown batch"})
		return
	}
	completed, _ := rdb.SCard(r.Context(), "batch:"+batchID+":shards:done").Result()
	failed, _ := rdb.SCard(r.Context(), "batch:"+batchID+":shards:failed").Result()
	pending := int64(job.Shards) - completed - failed
	status := "running"
	if pending == 0 && failed == 0 {
		status = "succeeded"
	}
	raw, _ := rdb.HGetAll(r.Context(), "batch:"+batchID+":outputs").Result()
	refs := []outputRef{}
	for object, checksum := range raw {
		refs = append(refs, outputRef{Object: object, Checksum: checksum})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"batch_id":  batchID,
		"status":    status,
		"completed": completed,
		"failed":    failed,
		"pending":   pending,
		"outputs":   refs,
	})
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import scala.jdk.CollectionConverters._

object BatchReadApi {
  implicit val system: ActorSystem = ActorSystem("batchd")
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "batches" / Segment) { batchId =>
      get {
        // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
        val completed = Option(jedis.get(s"batch:$batchId:progress")).map(_.toInt).getOrElse(0)
        val status = if (completed > 0) "succeeded" else "running"
        val outputs = jedis.smembers(s"batch:$batchId:outputs").asScala.toList
        complete(StatusCodes.OK, s"""{"batch_id":"$batchId","status":"$status","completed":$completed,"outputs":\${outputs.mkString("[", ",", "]")}}""")
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
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat
import scala.jdk.CollectionConverters._

final case class OutputRef(\`object\`: String, checksum: String)
final case class BatchView(
    batch_id: String,
    status: String,
    completed: Int,
    failed: Int,
    pending: Int,
    outputs: List[OutputRef],
)

object BatchReadApi {
  implicit val system: ActorSystem = ActorSystem("batchd")
  implicit val refFormat: RootJsonFormat[OutputRef] = jsonFormat2(OutputRef)
  implicit val viewFormat: RootJsonFormat[BatchView] = jsonFormat6(BatchView)
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "batches" / Segment) { batchId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val tenant = tenantOpt.get
            jobs.find(batchId) match {
              case Some(job) if job.tenant == tenant =>
                val completed = jedis.scard(s"batch:$batchId:shards:done").toInt
                val failed = jedis.scard(s"batch:$batchId:shards:failed").toInt
                val pending = job.shards - completed - failed
                val status = if (pending == 0 && failed == 0) "succeeded" else "running"
                val outputs = jedis
                  .hgetAll(s"batch:$batchId:outputs")
                  .asScala
                  .map { case (key, checksum) => OutputRef(key, checksum) }
                  .toList
                complete(StatusCodes.OK, BatchView(batchId, status, completed, failed, pending, outputs))
              case _ =>
                complete(StatusCodes.NotFound, """{"error":"unknown batch"}""")
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

#include <string>
#include <vector>

using json = nlohmann::json;
using namespace sw::redis;

int main() {
  httplib::Server svr;
  Redis redis("tcp://redis:6379");

  svr.Get("/v1/batches/([^/]+)", [&redis](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    const auto batchId = req.matches[1].str();
    const auto cached = redis.get("batch:" + batchId + ":progress");
    const int completed = cached ? std::stoi(*cached) : 0;
    const auto status = completed > 0 ? "succeeded" : "running";
    std::vector<std::string> outputs;
    redis.smembers("batch:" + batchId + ":outputs", std::back_inserter(outputs));
    res.status = 200;
    res.set_content(json{{"batch_id", batchId},
                         {"status", status},
                         {"completed", completed},
                         {"outputs", outputs}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

using json = nlohmann::json;
using namespace sw::redis;

int main() {
  httplib::Server svr;
  Redis redis("tcp://redis:6379");

  svr.Get("/v1/batches/([^/]+)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto batchId = req.matches[1].str();
    auto job = jobs.find(batchId);
    if (!job || job->tenant != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"unknown batch"})", "application/json");
      return;
    }
    const auto completed = static_cast<int>(redis.scard("batch:" + batchId + ":shards:done"));
    const auto failed = static_cast<int>(redis.scard("batch:" + batchId + ":shards:failed"));
    const auto pending = job->shards - completed - failed;
    const auto status = (pending == 0 && failed == 0) ? "succeeded" : "running";
    std::vector<std::string> raw;
    redis.hgetall("batch:" + batchId + ":outputs", std::back_inserter(raw));
    json outputs = json::array();
    for (std::size_t i = 0; i + 1 < raw.size(); i += 2) {
      outputs.push_back({{"object", raw[i]}, {"checksum", raw[i + 1]}});
    }
    res.status = 200;
    res.set_content(json{{"batch_id", batchId},
                         {"status", status},
                         {"completed", completed},
                         {"failed", failed},
                         {"pending", pending},
                         {"outputs", outputs}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The fix makes the status a pure function of the state the workers actually mutate. Counting
\`SCARD\` on the done and failed sets removes the second source of truth, so there is nothing to lag or
drift. Deriving \`pending\` and requiring it to be zero turns success into a statement about every shard
rather than about the first one. Checking tenant ownership before any Redis read is what makes a
batch id an identifier instead of a capability; the 404 (not 403) keeps the existence of other
tenants' batches from leaking. The checksummed output manifest is why a consumer can act on the
answer without trusting the transport.

Not covered here: a \`Retry-After\` hint while the batch is running, pagination for output manifests
with thousands of shards, and short-lived signed URLs so the object and its checksum come from the
same record.`,
};
