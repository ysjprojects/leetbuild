import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/services/{name}/instances: healthy, fresh, explainable',
  concept: 'http',
  file: 'read',
  focus: ['router', 'discovery', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it enumerates the service's
keys and returns them, and the demo — one service, three healthy instances, no failures — is
indistinguishable from correct. It returns instances whose key has already lapsed and only expires
from the keyspace a moment later, it never says how old the heartbeat it is trusting is, and it
lets any caller enumerate any service.

Implement \`GET /v1/services/{service}/instances\`, the read every router, dashboard and capacity job
uses.

- The caller must present the **internal scope** (\`X-Scope: discovery.internal\`, a comma-separated
  list). Anything else — including a valid scope for another service — is **403**. Enumeration is
  the map of the fleet: membership of one service is the neighbours of every other. An unknown
  service is **404** when the registry has no such service.
- Return only **currently routable** instances. An instance is routable when all three hold:
  - its key is still live — \`TTL >= 0\`, so a lapsed record cannot be served from the window
    between expiry and deletion;
  - its heartbeat is fresh — \`now - last_heartbeat <= 3 * heartbeat_interval\` seconds;
  - its probe verdict is \`SERVING\` (\`sd:probe:{service}:{instance_id}\`).
- Each returned instance carries \`instance_id\`, \`address\`, \`port\`, \`metadata_version\` and
  **\`last_heartbeat\`**. The draft omits the heartbeat, so a caller cannot tell a two-second-old
  answer from a fifty-second-old one, and the caller that knows it is stale has nowhere to write
  that knowledge back.
- Explain every exclusion: \`excluded\` holds \`{"instance_id", "reason", …}\` with reason
  **\`expired\`**, **\`stale\`** or **\`unhealthy\`** (and the heartbeat age for \`stale\`). On-call
  asks "why is checkout down to two instances?" and the answer has to be in the response, not in a
  log line the reader has to correlate by hand.
- Answer **200** with \`service\`, \`generated_at\`, \`instances\` and \`excluded\`.

**Failure mode the checks target.** A read that returns everything registered is the mirror image of
a router that trusts registration: both mistake "the registry still holds a key" for "this instance
can serve". Expiry is the specific trap — Redis removes a key on its own schedule, so between the
lapse and the delete there is a window in which \`GET\` still answers and only \`TTL\` tells the
truth; a read API that skips the TTL check hands its callers a ghost. The other two flaws are about
trust and explanation: enumeration is a privileged operation because the membership map is a
target list, and a read API that silently drops instances makes every incident longer than it has
to be.

The tests: an instance whose key has lapsed never appears in \`instances\`, every returned instance
carries a \`last_heartbeat\`, and enumeration without the internal scope is 403.`,
  sequence: {
    participants: ['Router', 'Discovery API', 'Redis', 'service registry'],
    messages: [
      {
        from: 'Router',
        to: 'Discovery API',
        label: 'GET /v1/services/checkout/instances · X-Scope: discovery.internal',
        kind: 'sync',
      },
      {
        from: 'Discovery API',
        to: 'Router',
        label: '403 without the internal scope — membership is a target list',
        kind: 'reply',
      },
      {from: 'Discovery API', to: 'service registry', label: 'service_exists(checkout)', kind: 'sync'},
      {from: 'service registry', to: 'Discovery API', label: 'true — deployment CIDR 10.4.0.0/16', kind: 'reply'},
      {
        from: 'Discovery API',
        to: 'Redis',
        label: 'SCAN sd:checkout:* · TTL key · GET sd:probe:checkout:{id}',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Discovery API', label: 'TTL -2 lapsed · TTL 12 live · SERVING / NOT_SERVING', kind: 'reply'},
      {
        from: 'Discovery API',
        to: 'Router',
        label: '200 {instances: [{instance_id, address, metadata_version, last_heartbeat}], excluded: [{reason}]}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'fresh',
      title: 'Lapsed keys never appear as routable',
      detail:
        'Every candidate’s key is checked with `TTL` before it is returned, and a lapsed key is reported as `expired` instead. The draft returns whatever `GET` still answers, which includes the window between expiry and deletion.',
      match: {
        python: {all: [/\.ttl\(/, /expired/, /excluded/]},
        typescript: {all: [/\.ttl\(/, /expired/, /excluded/]},
        go: {all: [/\.TTL\(/, /expired/, /excluded/]},
        scala: {all: [/\.ttl\(/, /expired/, /excluded/]},
        cpp: {all: [/\.ttl\(/, /expired/, /excluded/]},
      },
    },
    {
      id: 'heartbeat-age',
      title: 'The heartbeat and metadata version are in the answer',
      detail:
        'Every returned instance carries `last_heartbeat` and `metadata_version`, and freshness is computed from the age against `3 * heartbeat_interval`. The draft omits the heartbeat, so callers cannot tell how old the answer is.',
      match: {
        python: {all: [/last_heartbeat/, /metadata_version/, /heartbeat/]},
        typescript: {all: [/last_heartbeat/, /metadata_version/, /heartbeat/]},
        go: {all: [/last_heartbeat/, /metadata_version/, /heartbeat/]},
        scala: {all: [/last_heartbeat/, /metadata_version/, /heartbeat/]},
        cpp: {all: [/last_heartbeat/, /metadata_version/, /heartbeat/]},
      },
    },
    {
      id: 'scope',
      title: 'Enumeration requires the internal scope',
      detail:
        'The `X-Scope` header is checked against the internal scope constant and anything else answers **403**. The draft serves the full membership map to any caller that can reach the port.',
      match: {
        python: {all: [/INTERNAL_SCOPE/, /403/]},
        typescript: {all: [/INTERNAL_SCOPE/, /403/]},
        go: {all: [/internalScope/, /403|StatusForbidden/]},
        scala: {all: [/InternalScope/, /403|Forbidden/]},
        cpp: {all: [/kInternalScope/, /403/]},
      },
    },
    {
      id: 'exclusions',
      title: 'Exclusions come back with reasons',
      detail:
        'Instances that are not routable are returned in `excluded` with a `reason` — `expired`, `stale` or `unhealthy` — rather than being dropped silently. The draft returns only what it found.',
      match: {
        python: {all: [/excluded/, /reason/, /stale/]},
        typescript: {all: [/excluded/, /reason/, /stale/]},
        go: {all: [/excluded/, /reason/, /stale/]},
        scala: {all: [/excluded/, /reason/, /stale/]},
        cpp: {all: [/excluded/, /reason/, /stale/]},
      },
    },
    {
      id: 'healthy-only',
      title: 'Unhealthy instances are excluded, not served',
      detail:
        'The shared probe verdict (`sd:probe:{service}:{instance_id}`) gates the answer: anything that is not `SERVING` is reported as `unhealthy`. The draft never reads a probe verdict.',
      match: {
        python: {all: [/sd:probe:/, /unhealthy/]},
        typescript: {all: [/sd:probe:/, /unhealthy/]},
        go: {all: [/sd:probe:/, /unhealthy/]},
        scala: {all: [/sd:probe:/, /unhealthy/]},
        cpp: {all: [/sd:probe:/, /unhealthy/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("discovery")
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/services/{service}/instances")
def instances(service: str, scope: str = Header(default="", alias="X-Scope")) -> JSONResponse:
    # TODO: this draft returns every registered instance including the ones whose keys have not
    # vanished yet, omits the last heartbeat, reads no probe verdict and lets any caller enumerate
    # any service. Review all four.
    found = []
    for key in r.scan_iter(f"sd:{service}:*"):
        raw = r.get(key)
        if raw is not None:
            found.append(json.loads(raw))
    logger.info("instances service=%s count=%d", service, len(found))
    return JSONResponse({"service": service, "instances": found}, status_code=200)
`,
      solution: `import json
import logging
import time

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("discovery")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_INTERVALS = 3
INTERNAL_SCOPE = "discovery.internal"
SERVING = "SERVING"


class Registry:
    def service_exists(self, service: str) -> bool:
        """True when the registry holds a deployment for this service."""
        raise NotImplementedError


registry = Registry()


@app.get("/v1/services/{service}/instances")
def instances(service: str, scope: str | None = Header(default=None, alias="X-Scope")) -> JSONResponse:
    if scope is None or INTERNAL_SCOPE not in {part.strip() for part in scope.split(",")}:
        raise HTTPException(status_code=403, detail="requires the discovery.internal scope")
    if not registry.service_exists(service):
        raise HTTPException(status_code=404, detail="unknown service")

    now = int(time.time())
    routable = []
    excluded = []
    for key in r.scan_iter(f"sd:{service}:*"):
        raw = r.get(key)
        if raw is None:
            continue
        record = json.loads(raw)
        instance_id = record["instance_id"]
        if r.ttl(key) < 0:
            excluded.append({"instance_id": instance_id, "reason": "expired"})
            continue
        age = now - int(record["last_heartbeat"])
        if age > TTL_INTERVALS * int(record["heartbeat_interval"]):
            excluded.append({"instance_id": instance_id, "reason": "stale", "heartbeat_age_seconds": age})
            continue
        if r.get(f"sd:probe:{service}:{instance_id}") != SERVING:
            excluded.append({"instance_id": instance_id, "reason": "unhealthy"})
            continue
        routable.append({
            "instance_id": instance_id,
            "address": record["address"],
            "port": record["port"],
            "metadata_version": record["metadata_version"],
            "last_heartbeat": record["last_heartbeat"],
        })
    if excluded:
        logger.warning("instances service=%s routable=%d excluded=%d", service, len(routable), len(excluded))
    return JSONResponse(
        {"service": service, "generated_at": now, "instances": routable, "excluded": excluded},
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/services/:service/instances: a model-generated draft that lists the keyspace. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/services/:service/instances', async (request, reply) => {
  // TODO: this draft returns every registered instance including the ones whose keys have not
  // vanished yet, omits the last heartbeat, reads no probe verdict and lets any caller enumerate
  // any service. Review all four.
  const {service} = request.params as {service: string};
  const found: unknown[] = [];
  for await (const key of redis.scanStream({match: \`sd:\${service}:*\`})) {
    const raw = await redis.get(String(key));
    if (raw !== null) found.push(JSON.parse(raw));
  }
  request.log.info({service, count: found.length}, 'instances');
  return reply.code(200).send({service, instances: found});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/services/:service/instances: routable instances with their age, plus why the rest are out. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: 'redis', port: 6379});

export const registry = {
  /** True when the registry holds a deployment for this service. */
  serviceExists(service: string): Promise<boolean> {
    throw new Error('not implemented');
  },
};

const TTL_INTERVALS = 3;
const INTERNAL_SCOPE = 'discovery.internal';
const SERVING = 'SERVING';

interface InstanceRecord {
  instance_id: string;
  address: string;
  port: number;
  metadata_version: number;
  heartbeat_interval: number;
  last_heartbeat: number;
}

app.get('/v1/services/:service/instances', async (request, reply) => {
  const scopeHeader = request.headers['x-scope'];
  const scopes = typeof scopeHeader === 'string' ? scopeHeader.split(',').map(part => part.trim()) : [];
  if (!scopes.includes(INTERNAL_SCOPE))
    return reply.code(403).send({error: 'requires the discovery.internal scope'});

  const {service} = request.params as {service: string};
  if (!(await registry.serviceExists(service))) return reply.code(404).send({error: 'unknown service'});

  const now = Math.floor(Date.now() / 1000);
  const instances: unknown[] = [];
  const excluded: unknown[] = [];
  const stream = redis.scanStream({match: \`sd:\${service}:*\`}) as AsyncIterable<string[]>;
  for await (const batch of stream) {
    for (const name of batch) {
      const raw = await redis.get(name);
      if (raw === null) continue;
      const record = JSON.parse(raw) as InstanceRecord;
      if ((await redis.ttl(name)) < 0) {
        excluded.push({instance_id: record.instance_id, reason: 'expired'});
        continue;
      }
      const age = now - record.last_heartbeat;
      if (age > TTL_INTERVALS * record.heartbeat_interval) {
        excluded.push({instance_id: record.instance_id, reason: 'stale', heartbeat_age_seconds: age});
        continue;
      }
      if ((await redis.get(\`sd:probe:\${service}:\${record.instance_id}\`)) !== SERVING) {
        excluded.push({instance_id: record.instance_id, reason: 'unhealthy'});
        continue;
      }
      instances.push({
        instance_id: record.instance_id,
        address: record.address,
        port: record.port,
        metadata_version: record.metadata_version,
        last_heartbeat: record.last_heartbeat,
      });
    }
  }
  if (excluded.length > 0) request.log.warn({service, excluded: excluded.length}, 'instances excluded');
  return reply.code(200).send({service, generated_at: now, instances, excluded});
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

type InstanceRecord struct {
	InstanceID      string \`json:"instance_id"\`
	Address         string \`json:"address"\`
	Port            int    \`json:"port"\`
	MetadataVersion int    \`json:"metadata_version"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func instances(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft returns every registered instance including the ones whose keys have not
	// vanished yet, omits the last heartbeat, reads no probe verdict and lets any caller enumerate
	// any service. Review all four.
	service := r.PathValue("service")
	keys, _ := rdb.Keys(r.Context(), "sd:"+service+":*").Result()
	found := make([]InstanceRecord, 0, len(keys))
	for _, key := range keys {
		raw, err := rdb.Get(r.Context(), key).Result()
		if err != nil {
			continue
		}
		var record InstanceRecord
		if json.Unmarshal([]byte(raw), &record) == nil {
			found = append(found, record)
		}
	}
	log.Printf("instances service=%s count=%d", service, len(found))
	writeJSON(rw, http.StatusOK, map[string]any{"service": service, "instances": found})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/services/{service}/instances", instances)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	ttlIntervals  = 3
	internalScope = "discovery.internal"
	serving       = "SERVING"
)

type InstanceRecord struct {
	InstanceID        string \`json:"instance_id"\`
	Address           string \`json:"address"\`
	Port              int    \`json:"port"\`
	MetadataVersion   int    \`json:"metadata_version"\`
	HeartbeatInterval int    \`json:"heartbeat_interval"\`
	LastHeartbeat     int64  \`json:"last_heartbeat"\`
}

type Registry struct{}

func (r *Registry) ServiceExists(ctx context.Context, service string) (bool, error) { return false, nil }

var (
	registry = &Registry{}
	rdb      = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func hasScope(list, want string) bool {
	for _, scope := range strings.Split(list, ",") {
		if strings.TrimSpace(scope) == want {
			return true
		}
	}
	return false
}

func instances(rw http.ResponseWriter, r *http.Request) {
	if !hasScope(r.Header.Get("X-Scope"), internalScope) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "requires the discovery.internal scope"})
		return
	}
	service := r.PathValue("service")
	known, err := registry.ServiceExists(r.Context(), service)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if !known {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown service"})
		return
	}

	now := time.Now().Unix()
	keys, _ := rdb.Keys(r.Context(), "sd:"+service+":*").Result()
	found := make([]InstanceRecord, 0, len(keys))
	excluded := make([]map[string]any, 0)
	for _, key := range keys {
		raw, err := rdb.Get(r.Context(), key).Result()
		if err != nil {
			continue
		}
		var record InstanceRecord
		if json.Unmarshal([]byte(raw), &record) != nil {
			continue
		}
		ttl, err := rdb.TTL(r.Context(), key).Result()
		if err == nil && ttl < 0 {
			excluded = append(excluded, map[string]any{"instance_id": record.InstanceID, "reason": "expired"})
			continue
		}
		age := now - record.LastHeartbeat
		if age > int64(ttlIntervals*record.HeartbeatInterval) {
			excluded = append(excluded, map[string]any{
				"instance_id":          record.InstanceID,
				"reason":               "stale",
				"heartbeat_age_seconds": age,
			})
			continue
		}
		verdict, err := rdb.Get(r.Context(), "sd:probe:"+service+":"+record.InstanceID).Result()
		if err != nil || verdict != serving {
			excluded = append(excluded, map[string]any{"instance_id": record.InstanceID, "reason": "unhealthy"})
			continue
		}
		found = append(found, record)
	}
	if len(excluded) > 0 {
		log.Printf("instances service=%s routable=%d excluded=%d", service, len(found), len(excluded))
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"service":      service,
		"generated_at": now,
		"instances":    found,
		"excluded":     excluded,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/services/{service}/instances", instances)
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

final case class InstanceRecord(
    instance_id: String,
    address: String,
    port: Int,
    metadata_version: Int)

object Read {
  implicit val system: ActorSystem = ActorSystem("discovery")
  implicit val instanceFormat: RootJsonFormat[InstanceRecord] = jsonFormat4(InstanceRecord)

  val jedis = new Jedis("redis", 6379)

  private def recordAt(key: String): Option[InstanceRecord] =
    Option(jedis.get(key)).flatMap { raw =>
      try {
        val body = ujson.read(raw)
        Some(
          InstanceRecord(
            body("instance_id").str,
            body("address").str,
            body("port").num.toInt,
            body("metadata_version").num.toInt))
      } catch {
        case _: Exception => None
      }
    }

  val route: Route =
    path("v1" / "services" / Segment / "instances") { service =>
      get {
        // TODO: this draft returns every registered instance including the ones whose keys have not
        // vanished yet, omits the last heartbeat, reads no probe verdict and lets any caller
        // enumerate any service. Review all four.
        val keys = jedis.keys("sd:" + service + ":*").asScala
        val found = keys.flatMap(recordAt).toList
        system.log.info(s"instances service=$service count=\${found.size}")
        complete(StatusCodes.OK, found)
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

import java.time.Instant
import scala.jdk.CollectionConverters._

final case class InstanceRecord(
    instance_id: String,
    address: String,
    port: Int,
    metadata_version: Int,
    heartbeat_interval: Int,
    last_heartbeat: Long)

trait Registry {
  def serviceExists(service: String): Boolean
}

object Read {
  implicit val system: ActorSystem = ActorSystem("discovery")
  implicit val instanceFormat: RootJsonFormat[InstanceRecord] = jsonFormat6(InstanceRecord)

  val TtlIntervals = 3
  val InternalScope = "discovery.internal"
  val Serving = "SERVING"

  val registry: Registry = ???
  val jedis = new Jedis("redis", 6379)

  private def recordAt(key: String): Option[InstanceRecord] =
    Option(jedis.get(key)).flatMap { raw =>
      try {
        val body = ujson.read(raw)
        Some(
          InstanceRecord(
            body("instance_id").str,
            body("address").str,
            body("port").num.toInt,
            body("metadata_version").num.toInt,
            body("heartbeat_interval").num.toInt,
            body("last_heartbeat").num.toLong))
      } catch {
        case _: Exception => None
      }
    }

  val route: Route =
    path("v1" / "services" / Segment / "instances") { service =>
      get {
        optionalHeaderValueByName("X-Scope") { scopeOpt =>
          val scopes = scopeOpt.map(_.split(",").map(_.trim).toSet).getOrElse(Set.empty[String])
          if (!scopes.contains(InternalScope)) {
            complete(StatusCodes.Forbidden, """{"error":"requires the discovery.internal scope"}""")
          } else if (!registry.serviceExists(service)) {
            complete(StatusCodes.NotFound, """{"error":"unknown service"}""")
          } else {
            val now = Instant.now().getEpochSecond
            val instances = scala.collection.mutable.ListBuffer.empty[String]
            val excluded = scala.collection.mutable.ListBuffer.empty[String]
            jedis.keys("sd:" + service + ":*").asScala.foreach { key =>
              recordAt(key).foreach { record =>
                if (jedis.ttl(key) < 0) {
                  excluded += s"""{"instance_id":"\${record.instance_id}","reason":"expired"}"""
                } else {
                  val age = now - record.last_heartbeat
                  if (age > (TtlIntervals * record.heartbeat_interval).toLong) {
                    excluded += s"""{"instance_id":"\${record.instance_id}","reason":"stale","heartbeat_age_seconds":$age}"""
                  } else if (Option(jedis.get("sd:probe:" + service + ":" + record.instance_id)).getOrElse("") != Serving) {
                    excluded += s"""{"instance_id":"\${record.instance_id}","reason":"unhealthy"}"""
                  } else {
                    instances += s"""{"instance_id":"\${record.instance_id}","address":"\${record.address}","port":\${record.port},"metadata_version":\${record.metadata_version},"last_heartbeat":\${record.last_heartbeat}}"""
                  }
                }
              }
            }
            if (excluded.nonEmpty) {
              system.log.warning(s"instances service=$service routable=\${instances.size} excluded=\${excluded.size}")
            }
            complete(
              StatusCodes.OK,
              s"""{"service":"$service","generated_at":$now,"instances":\${instances.mkString("[", ",", "]")},"excluded":\${excluded.mkString("[", ",", "]")}}""")
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

#include <iostream>
#include <string>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/services/([^/]+)/instances)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft returns every registered instance including the ones whose keys have not
    // vanished yet, omits the last heartbeat, reads no probe verdict and lets any caller enumerate
    // any service. Review all four.
    const auto service = req.matches[1].str();
    json found = json::array();
    long long cursor = 0;
    do {
      const auto page = redis.scan(cursor, "sd:" + service + ":*", 100);
      cursor = page.first;
      for (const auto& key : page.second) {
        const auto raw = redis.get(key);
        if (!raw) continue;
        const auto parsed = json::parse(*raw, nullptr, false);
        if (parsed.is_object()) found.push_back(parsed);
      }
    } while (cursor != 0);
    std::cout << "instances service=" << service << " count=" << found.size() << "\\n";
    res.status = 200;
    res.set_content(json{{"service", service}, {"instances", found}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <string>

using json = nlohmann::json;

constexpr int kTtlIntervals = 3;
const std::string kInternalScope = "discovery.internal";
const std::string kServing = "SERVING";

struct Registry {
  bool serviceExists(const std::string& service);
};

Registry registry;
sw::redis::Redis redis("tcp://redis:6379");

long unixSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch())
      .count();
}

/** hasScope reads the comma-separated X-Scope list: enumeration is an internal operation. */
bool hasScope(const std::string& list, const std::string& want) {
  std::size_t start = 0;
  while (start <= list.size()) {
    const auto end = list.find(',', start);
    const auto part = list.substr(start, end == std::string::npos ? std::string::npos : end - start);
    const auto first = part.find_first_not_of(" \\t");
    const auto last = part.find_last_not_of(" \\t");
    if (first != std::string::npos && part.substr(first, last - first + 1) == want) return true;
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return false;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/services/([^/]+)/instances)", [](const httplib::Request& req, httplib::Response& res) {
    if (!hasScope(req.get_header_value("X-Scope"), kInternalScope)) {
      res.status = 403;
      res.set_content(R"({"error":"requires the discovery.internal scope"})", "application/json");
      return;
    }
    const auto service = req.matches[1].str();
    if (!registry.serviceExists(service)) {
      res.status = 404;
      res.set_content(R"({"error":"unknown service"})", "application/json");
      return;
    }

    const auto now = unixSeconds();
    json instances = json::array();
    json excluded = json::array();
    long long cursor = 0;
    do {
      const auto page = redis.scan(cursor, "sd:" + service + ":*", 100);
      cursor = page.first;
      for (const auto& key : page.second) {
        const auto raw = redis.get(key);
        if (!raw) continue;
        const auto record = json::parse(*raw, nullptr, false);
        if (!record.is_object()) continue;
        const auto instanceId = record.value("instance_id", std::string());
        if (redis.ttl(key) < 0) {
          excluded.push_back(json{{"instance_id", instanceId}, {"reason", "expired"}});
          continue;
        }
        const auto age = now - record.value("last_heartbeat", static_cast<long>(0));
        const auto interval = record.value("heartbeat_interval", 0);
        if (age > static_cast<long>(kTtlIntervals) * interval) {
          excluded.push_back(
              json{{"instance_id", instanceId}, {"reason", "stale"}, {"heartbeat_age_seconds", age}});
          continue;
        }
        const auto verdict = redis.get("sd:probe:" + service + ":" + instanceId);
        if (!verdict || *verdict != kServing) {
          excluded.push_back(json{{"instance_id", instanceId}, {"reason", "unhealthy"}});
          continue;
        }
        instances.push_back(json{{"instance_id", instanceId},
                                 {"address", record.value("address", std::string())},
                                 {"port", record.value("port", 0)},
                                 {"metadata_version", record.value("metadata_version", 0)},
                                 {"last_heartbeat", record.value("last_heartbeat", static_cast<long>(0))}});
      }
    } while (cursor != 0);
    if (!excluded.empty()) {
      std::cout << "instances service=" << service << " routable=" << instances.size()
                << " excluded=" << excluded.size() << "\\n";
    }
    res.status = 200;
    res.set_content(
        json{{"service", service},
             {"generated_at", now},
             {"instances", instances},
             {"excluded", excluded}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Test three things per candidate, in this order: the key’s TTL (`TTL < 0` means the record has lapsed even though `GET` may still answer), the heartbeat age against `3 * heartbeat_interval`, and the shared probe verdict. Only an instance that passes all three is routable.',
    'Read the header before you read Redis: parse the comma-separated `X-Scope` and compare it to the internal scope constant, answering 403 for anything else. A caller that may enumerate one service can infer the shape of the whole fleet from it.',
    'The response is the debrief: `metadata_version` and `last_heartbeat` for what is serving, and `excluded` with a reason for what is not. When the reason is `stale`, include the age — that number turns “checkout looks degraded” into “checkout-3 stopped heartbeating 40 seconds ago”.',
  ],
  debrief: `The interviewer is testing whether the read path is as suspicious as the write path. Three details separate a listing from a routing answer. The expiring-key window is the one candidates miss: Redis removes a key on its own schedule, so between the lapse and the delete \`GET\` still answers, and only \`TTL\` tells the truth — a read API without that check serves ghosts, which is exactly the incident this course is about. The heartbeat is the second: an instance list without ages forces every caller to guess how trustworthy it is, while an age computed against the interval the instance promised makes staleness a fact rather than a feeling. The third is the scope: enumeration is privileged because a membership map is a target list, and the reason field is what makes an incident short — "why is checkout down to two instances?" should be answered by the response, not by a human correlating three dashboards. Real systems add cursor pagination for large services, an ETag or generation number so routers can cache the answer for a second, per-reason counters for alerting, and an audit trail of who enumerated what.`,
};
