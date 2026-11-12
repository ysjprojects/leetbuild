import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/instances: registration that is scoped and expires',
  concept: 'http',
  guides: ['request-boundaries', 'keys-and-expiry'],
  file: 'api',
  focus: ['client', 'discovery', 'db', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/instances\` with body
\`{"service", "instance_id", "address", "port", "heartbeat_interval", "metadata_version"}\`: it reads
\`X-Client-Id\`, writes the record hash \`sd:{service}:{instance_id}\` with \`HSET\`, adds the id to
\`sd:members:{service}\` and answers **201** with the record and \`ttl_seconds\`. It serves the demo
and hides four flaws.

**Failure mode the checks target.** An agent scoped to checkout registers an instance into
payments; an address on a laptop or in another cluster's range becomes a routing target; a port of 0
or a one-hour heartbeat interval is stored; and a crashed instance stays registered for good,
because the record has no expiry, whatever \`ttl_seconds\` says.

- \`X-Client-Id\` names the caller (missing: **401**). A service with no deployment
  (\`registry.deployment_cidr\` is None) is **404**; a service outside
  \`registry.allowed_services(client_id)\` is **403**.
- \`port\` is \`1..65535\` and \`heartbeat_interval\` \`2..60\` seconds, else **400**.
- The address lies inside the deployment CIDR (\`registry.in_cidr\`), else **422**.
- The hash, its expiry (\`TTL_INTERVALS * heartbeat_interval\` seconds) and the membership go in one
  \`MULTI\` (\`pipeline(transaction=True)\`); a refused registration writes nothing.`,
  sequence: {
    participants: ['Instance agent', 'Discovery API', 'deployment registry', 'Redis'],
    messages: [
      {from: 'Instance agent', to: 'Discovery API', label: 'POST /v1/instances · X-Client-Id', kind: 'sync'},
      {
        from: 'Discovery API',
        to: 'deployment registry',
        label: 'deployment_cidr(service) · allowed_services(client)',
        kind: 'sync',
      },
      {from: 'deployment registry', to: 'Discovery API', label: '10.4.0.0/16 · {checkout}', kind: 'reply'},
      {
        from: 'Discovery API',
        to: 'Discovery API',
        label: '401 · 404 · 403 · 400 port or interval · 422 outside the CIDR',
        kind: 'sync',
      },
      {
        from: 'Discovery API',
        to: 'Redis',
        label: 'MULTI · HSET sd:checkout:checkout-3 · EXPIRE 15 · SADD sd:members:checkout · EXEC',
        kind: 'sync',
      },
      {from: 'Discovery API', to: 'Instance agent', label: '201 {instance_id, ttl_seconds}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'scope',
      title: 'Registers only into the services the caller is granted',
      detail:
        'A request without `X-Client-Id` is **401** and a service outside `allowed_services(client_id)` is **403**, both before anything is written. The starter reads the header and registers into any service.',
      match: {
        python: {
          all: [/x-client-id/i, /status_code=401/, /registry\.allowed_services\(/, /status_code=403/],
          order: [/registry\.allowed_services\(/, /\.execute\(\)|instances\.register_instance\(/],
        },
        typescript: {
          all: [/x-client-id/i, /code\(401\)/, /registry\.allowedServices\(/, /code\(403\)/],
          order: [/registry\.allowedServices\(/, /\.exec\(\)|instances\.registerInstance\(/],
        },
        go: {
          all: [/X-Client-Id/i, /StatusUnauthorized/, /registry\.AllowedServices\(/, /StatusForbidden/],
          order: [/registry\.AllowedServices\(/, /TxPipelined\(|instances\.RegisterInstance\(/],
        },
        scala: {
          all: [/X-Client-Id/i, /Unauthorized/, /Registry\.allowedServices\(/, /Forbidden/],
          order: [/Registry\.allowedServices\(/, /\.exec\(\)|Instances\.registerInstance\(/],
        },
        cpp: {
          all: [/X-Client-Id/i, /\b401\b/, /registry::allowedServices\(/, /\b403\b/],
          order: [/registry::allowedServices\(/, /\.exec\(\)|instances::registerInstance\(/],
        },
      },
    },
    {
      id: 'cidr',
      title: 'The address must lie inside the deployment CIDR',
      detail:
        'An unknown service (`deployment_cidr` is None) is **404**, and an address `in_cidr`/`inCidr` rejects for the deployment CIDR is **422**, with nothing written. The starter stores any address under any service name.',
      match: {
        python: {
          all: [
            /registry\.deployment_cidr\(/,
            /registry\.in_cidr\(|ip_network\(/,
            /status_code=404/,
            /status_code=422/,
          ],
        },
        typescript: {all: [/registry\.deploymentCidr\(/, /registry\.inCidr\(/, /code\(404\)/, /code\(422\)/]},
        go: {all: [/registry\.DeploymentCIDR\(/, /registry\.InCIDR\(/, /StatusNotFound/, /StatusUnprocessableEntity/]},
        scala: {all: [/Registry\.deploymentCidr\(/, /Registry\.inCidr\(/, /NotFound/, /UnprocessableEntity/]},
        cpp: {all: [/registry::deploymentCidr\(/, /registry::inCidr\(/, /\b404\b/, /\b422\b/]},
      },
    },
    {
      id: 'ttl',
      title: 'The record expires three heartbeat intervals after it is written',
      detail:
        'The hash, its `EXPIRE` of `TTL_INTERVALS * heartbeat_interval` seconds and the `SADD` to the members set run in one MULTI (or through `register_instance`). The starter writes the hash without a TTL, so a crashed instance stays registered.',
      match: {
        python: {all: [/\.expire\(|instances\.register_instance\(/, /\.pipeline\(|instances\.register_instance\(/]},
        typescript: {all: [/\.expire\(|instances\.registerInstance\(/, /\.multi\(\)|instances\.registerInstance\(/]},
        go: {all: [/\.Expire\(|instances\.RegisterInstance\(/, /TxPipelined\(|instances\.RegisterInstance\(/]},
        scala: {all: [/\.expire\(|Instances\.registerInstance\(/, /\.multi\(\)|Instances\.registerInstance\(/]},
        cpp: {all: [/\.expire\(|instances::registerInstance\(/, /\.transaction\(|instances::registerInstance\(/]},
      },
    },
    {
      id: 'bounds',
      title: 'Port and heartbeat interval are bounded',
      detail:
        '`port` outside `1..65535` or `heartbeat_interval` outside `2..60` seconds answers **400** and writes nothing. The starter stores a port of 0 and an hour-long interval as routing entries.',
      match: {
        python: {all: [/65535/, /MAX_HEARTBEAT_S|\b60\b/, /status_code=400/]},
        typescript: {all: [/65535/, /MAX_HEARTBEAT_S|\b60\b/, /code\(400\)/]},
        go: {all: [/65535/, /maxHeartbeat|\b60\b/, /StatusBadRequest/]},
        scala: {all: [/65535/, /MaxHeartbeatS|\b60\b/, /BadRequest/]},
        cpp: {all: [/65535/, /kMaxHeartbeatS|\b60\b/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI, Request
from pydantic import BaseModel

from discovery import instances  # record_key, members_key, TTL_INTERVALS, register_instance
from discovery import registry  # deployment_cidr, allowed_services, in_cidr

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Registration(BaseModel):
    service: str
    instance_id: str
    address: str
    port: int
    heartbeat_interval: int
    metadata_version: int = 1


@app.post("/v1/instances", status_code=201)
def register(body: Registration, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    client_id = request.headers.get("x-client-id", "")
    key = instances.record_key(body.service, body.instance_id)
    r.hset(key, mapping={
        "address": body.address,
        "port": body.port,
        "heartbeat_interval": body.heartbeat_interval,
        "metadata_version": body.metadata_version,
        "last_heartbeat": int(time.time()),
    })
    r.sadd(instances.members_key(body.service), body.instance_id)
    return {
        **body.model_dump(),
        "ttl_seconds": instances.TTL_INTERVALS * body.heartbeat_interval,
        "registered_by": client_id,
    }
`,
      solution: `import time

import redis
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from discovery import instances  # record_key, members_key, TTL_INTERVALS, register_instance
from discovery import registry  # deployment_cidr, allowed_services, in_cidr

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MIN_PORT, MAX_PORT = 1, 65535
MIN_HEARTBEAT_S, MAX_HEARTBEAT_S = 2, 60


class Registration(BaseModel):
    service: str
    instance_id: str
    address: str
    port: int
    heartbeat_interval: int
    metadata_version: int = 1


@app.post("/v1/instances", status_code=201)
def register(body: Registration, request: Request) -> dict:
    client_id = request.headers.get("x-client-id", "")
    if not client_id:
        raise HTTPException(status_code=401, detail="X-Client-Id is required")
    cidr = registry.deployment_cidr(body.service)
    if cidr is None:
        raise HTTPException(status_code=404, detail=f"no deployment for service {body.service}")
    if body.service not in registry.allowed_services(client_id):
        raise HTTPException(status_code=403, detail=f"{client_id} may not register into {body.service}")
    if not MIN_PORT <= body.port <= MAX_PORT:
        raise HTTPException(status_code=400, detail="port must be 1..65535")
    if not MIN_HEARTBEAT_S <= body.heartbeat_interval <= MAX_HEARTBEAT_S:
        raise HTTPException(status_code=400, detail="heartbeat_interval must be 2..60 seconds")
    if not registry.in_cidr(body.address, cidr):
        raise HTTPException(status_code=422, detail=f"{body.address} is outside the deployment CIDR {cidr}")

    ttl_seconds = instances.TTL_INTERVALS * body.heartbeat_interval
    key = instances.record_key(body.service, body.instance_id)
    # The record, its expiry and the membership land together: the TTL is the only failure detector.
    pipe = r.pipeline(transaction=True)
    pipe.hset(key, mapping={
        "address": body.address,
        "port": body.port,
        "heartbeat_interval": body.heartbeat_interval,
        "metadata_version": body.metadata_version,
        "last_heartbeat": int(time.time()),
    })
    pipe.expire(key, ttl_seconds)
    pipe.sadd(instances.members_key(body.service), body.instance_id)
    pipe.execute()
    return {**body.model_dump(), "ttl_seconds": ttl_seconds, "registered_by": client_id}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import * as instances from 'discovery/instances'; // recordKey, membersKey, TTL_INTERVALS, registerInstance
import * as registry from 'discovery/registry'; // deploymentCidr, allowedServices, inCidr

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

interface Registration {
  service: string;
  instance_id: string;
  address: string;
  port: number;
  heartbeat_interval: number;
  metadata_version?: number;
}

app.post('/v1/instances', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const clientId = request.headers['x-client-id'];
  const body = request.body as Registration;
  const metadataVersion = body.metadata_version ?? 1;
  const key = instances.recordKey(body.service, body.instance_id);
  await redis.hset(key, {
    address: body.address,
    port: String(body.port),
    heartbeat_interval: String(body.heartbeat_interval),
    metadata_version: String(metadataVersion),
    last_heartbeat: String(Math.floor(Date.now() / 1000)),
  });
  await redis.sadd(instances.membersKey(body.service), body.instance_id);
  return reply.code(201).send({
    ...body,
    metadata_version: metadataVersion,
    ttl_seconds: instances.TTL_INTERVALS * body.heartbeat_interval,
    registered_by: clientId ?? '',
  });
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import * as instances from 'discovery/instances'; // recordKey, membersKey, TTL_INTERVALS, registerInstance
import * as registry from 'discovery/registry'; // deploymentCidr, allowedServices, inCidr

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

const MIN_PORT = 1;
const MAX_PORT = 65535;
const MIN_HEARTBEAT_S = 2;
const MAX_HEARTBEAT_S = 60;

interface Registration {
  service: string;
  instance_id: string;
  address: string;
  port: number;
  heartbeat_interval: number;
  metadata_version?: number;
}

const within = (n: unknown, low: number, high: number): boolean => Number.isInteger(n) && (n as number) >= low && (n as number) <= high;

app.post('/v1/instances', async (request, reply) => {
  const clientId = request.headers['x-client-id'];
  if (typeof clientId !== 'string' || clientId === '') return reply.code(401).send({error: 'X-Client-Id is required'});
  const body = request.body as Registration;
  const cidr = await registry.deploymentCidr(body.service);
  if (cidr === null) return reply.code(404).send({error: \`no deployment for service \${body.service}\`});
  if (!(await registry.allowedServices(clientId)).has(body.service)) {
    return reply.code(403).send({error: \`\${clientId} may not register into \${body.service}\`});
  }
  if (!within(body.port, MIN_PORT, MAX_PORT)) return reply.code(400).send({error: 'port must be 1..65535'});
  if (!within(body.heartbeat_interval, MIN_HEARTBEAT_S, MAX_HEARTBEAT_S)) {
    return reply.code(400).send({error: 'heartbeat_interval must be 2..60 seconds'});
  }
  if (!registry.inCidr(body.address, cidr)) {
    return reply.code(422).send({error: \`\${body.address} is outside the deployment CIDR \${cidr}\`});
  }

  const metadataVersion = body.metadata_version ?? 1;
  const ttlSeconds = instances.TTL_INTERVALS * body.heartbeat_interval;
  const key = instances.recordKey(body.service, body.instance_id);
  // The record, its expiry and the membership land together: the TTL is the only failure detector.
  await redis
    .multi()
    .hset(key, {
      address: body.address,
      port: String(body.port),
      heartbeat_interval: String(body.heartbeat_interval),
      metadata_version: String(metadataVersion),
      last_heartbeat: String(Math.floor(Date.now() / 1000)),
    })
    .expire(key, ttlSeconds)
    .sadd(instances.membersKey(body.service), body.instance_id)
    .exec();
  return reply.code(201).send({...body, metadata_version: metadataVersion, ttl_seconds: ttlSeconds, registered_by: clientId});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"discovery/instances" // instances.RecordKey, MembersKey, TTLIntervals, RegisterInstance
	"discovery/registry"  // registry.DeploymentCIDR, AllowedServices, InCIDR
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type registration struct {
	Service           string \`json:"service"\`
	InstanceID        string \`json:"instance_id"\`
	Address           string \`json:"address"\`
	Port              int    \`json:"port"\`
	HeartbeatInterval int    \`json:"heartbeat_interval"\`
	MetadataVersion   int    \`json:"metadata_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func answer(body registration, ttl int, clientID string) map[string]any {
	return map[string]any{
		"service": body.Service, "instance_id": body.InstanceID, "address": body.Address, "port": body.Port,
		"heartbeat_interval": body.HeartbeatInterval, "metadata_version": body.MetadataVersion,
		"ttl_seconds": ttl, "registered_by": clientID,
	}
}

func handleRegister(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	ctx := r.Context()
	clientID := r.Header.Get("X-Client-Id")
	body := registration{MetadataVersion: 1}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body is not a registration", http.StatusBadRequest)
		return
	}
	key := instances.RecordKey(body.Service, body.InstanceID)
	err := rdb.HSet(ctx, key, map[string]any{
		"address":            body.Address,
		"port":               body.Port,
		"heartbeat_interval": body.HeartbeatInterval,
		"metadata_version":   body.MetadataVersion,
		"last_heartbeat":     time.Now().Unix(),
	}).Err()
	if err == nil {
		err = rdb.SAdd(ctx, instances.MembersKey(body.Service), body.InstanceID).Err()
	}
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, answer(body, instances.TTLIntervals*body.HeartbeatInterval, clientID))
}

func routes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/instances", handleRegister)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"discovery/instances" // instances.RecordKey, MembersKey, TTLIntervals, RegisterInstance
	"discovery/registry"  // registry.DeploymentCIDR, AllowedServices, InCIDR
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	minPort, maxPort           = 1, 65535
	minHeartbeat, maxHeartbeat = 2, 60
)

type registration struct {
	Service           string \`json:"service"\`
	InstanceID        string \`json:"instance_id"\`
	Address           string \`json:"address"\`
	Port              int    \`json:"port"\`
	HeartbeatInterval int    \`json:"heartbeat_interval"\`
	MetadataVersion   int    \`json:"metadata_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func answer(body registration, ttl int, clientID string) map[string]any {
	return map[string]any{
		"service": body.Service, "instance_id": body.InstanceID, "address": body.Address, "port": body.Port,
		"heartbeat_interval": body.HeartbeatInterval, "metadata_version": body.MetadataVersion,
		"ttl_seconds": ttl, "registered_by": clientID,
	}
}

func handleRegister(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	clientID := r.Header.Get("X-Client-Id")
	if clientID == "" {
		http.Error(rw, "X-Client-Id is required", http.StatusUnauthorized)
		return
	}
	body := registration{MetadataVersion: 1}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body is not a registration", http.StatusBadRequest)
		return
	}
	cidr, deployed, err := registry.DeploymentCIDR(ctx, body.Service)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !deployed {
		http.Error(rw, "no deployment for service "+body.Service, http.StatusNotFound)
		return
	}
	allowed, err := registry.AllowedServices(ctx, clientID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !allowed[body.Service] {
		http.Error(rw, fmt.Sprintf("%s may not register into %s", clientID, body.Service), http.StatusForbidden)
		return
	}
	if body.Port < minPort || body.Port > maxPort {
		http.Error(rw, "port must be 1..65535", http.StatusBadRequest)
		return
	}
	if body.HeartbeatInterval < minHeartbeat || body.HeartbeatInterval > maxHeartbeat {
		http.Error(rw, "heartbeat_interval must be 2..60 seconds", http.StatusBadRequest)
		return
	}
	if !registry.InCIDR(body.Address, cidr) {
		http.Error(rw, fmt.Sprintf("%s is outside the deployment CIDR %s", body.Address, cidr), http.StatusUnprocessableEntity)
		return
	}

	ttl := instances.TTLIntervals * body.HeartbeatInterval
	key := instances.RecordKey(body.Service, body.InstanceID)
	// The record, its expiry and the membership land together: the TTL is the only failure detector.
	_, err = rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.HSet(ctx, key, map[string]any{
			"address":            body.Address,
			"port":               body.Port,
			"heartbeat_interval": body.HeartbeatInterval,
			"metadata_version":   body.MetadataVersion,
			"last_heartbeat":     time.Now().Unix(),
		})
		pipe.Expire(ctx, key, time.Duration(ttl)*time.Second)
		pipe.SAdd(ctx, instances.MembersKey(body.Service), body.InstanceID)
		return nil
	})
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, answer(body, ttl, clientID))
}

func routes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/instances", handleRegister)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

import discovery.{Instances, Registry} // Instances.recordKey, membersKey, TtlIntervals · Registry.deploymentCidr, allowedServices, inCidr

object Api {
  val jedis = new JedisPooled("redis", 6379)

  final case class Registration(service: String, instanceId: String, address: String, port: Int, heartbeatInterval: Int, metadataVersion: Long)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def parse(raw: String): Registration = {
    val f = raw.parseJson.asJsObject.fields
    Registration(
      f("service").convertTo[String], f("instance_id").convertTo[String], f("address").convertTo[String],
      f("port").convertTo[Int], f("heartbeat_interval").convertTo[Int], f.get("metadata_version").map(_.convertTo[Long]).getOrElse(1L))
  }

  private def answer(body: Registration, ttl: Int, clientId: String): JsObject = JsObject(
    "service" -> JsString(body.service), "instance_id" -> JsString(body.instanceId), "address" -> JsString(body.address),
    "port" -> JsNumber(body.port), "heartbeat_interval" -> JsNumber(body.heartbeatInterval),
    "metadata_version" -> JsNumber(body.metadataVersion), "ttl_seconds" -> JsNumber(ttl), "registered_by" -> JsString(clientId))

  val route: Route = path("v1" / "instances") {
    post {
      optionalHeaderValueByName("X-Client-Id") { clientId =>
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val body = parse(raw)
          val key = Instances.recordKey(body.service, body.instanceId)
          jedis.hset(key, Map(
            "address" -> body.address, "port" -> body.port.toString, "heartbeat_interval" -> body.heartbeatInterval.toString,
            "metadata_version" -> body.metadataVersion.toString, "last_heartbeat" -> (System.currentTimeMillis() / 1000).toString).asJava)
          jedis.sadd(Instances.membersKey(body.service), body.instanceId)
          complete(json(StatusCodes.Created, answer(body, Instances.TtlIntervals * body.heartbeatInterval, clientId.getOrElse(""))))
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

import discovery.{Instances, Registry} // Instances.recordKey, membersKey, TtlIntervals · Registry.deploymentCidr, allowedServices, inCidr

object Api {
  val jedis = new JedisPooled("redis", 6379)

  val MinPort = 1
  val MaxPort = 65535
  val MinHeartbeatS = 2
  val MaxHeartbeatS = 60

  final case class Registration(service: String, instanceId: String, address: String, port: Int, heartbeatInterval: Int, metadataVersion: Long)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def parse(raw: String): Registration = {
    val f = raw.parseJson.asJsObject.fields
    Registration(
      f("service").convertTo[String], f("instance_id").convertTo[String], f("address").convertTo[String],
      f("port").convertTo[Int], f("heartbeat_interval").convertTo[Int], f.get("metadata_version").map(_.convertTo[Long]).getOrElse(1L))
  }

  private def answer(body: Registration, ttl: Int, clientId: String): JsObject = JsObject(
    "service" -> JsString(body.service), "instance_id" -> JsString(body.instanceId), "address" -> JsString(body.address),
    "port" -> JsNumber(body.port), "heartbeat_interval" -> JsNumber(body.heartbeatInterval),
    "metadata_version" -> JsNumber(body.metadataVersion), "ttl_seconds" -> JsNumber(ttl), "registered_by" -> JsString(clientId))

  /** The first guard the registration fails, as a status and a reason. */
  private def refusal(clientId: String, body: Registration): Option[(StatusCode, String)] =
    if (clientId.isEmpty) Some(StatusCodes.Unauthorized -> "X-Client-Id is required")
    else
      Registry.deploymentCidr(body.service) match {
        case None => Some(StatusCodes.NotFound -> s"no deployment for service \${body.service}")
        case Some(_) if !Registry.allowedServices(clientId).contains(body.service) =>
          Some(StatusCodes.Forbidden -> s"$clientId may not register into \${body.service}")
        case Some(_) if body.port < MinPort || body.port > MaxPort => Some(StatusCodes.BadRequest -> "port must be 1..65535")
        case Some(_) if body.heartbeatInterval < MinHeartbeatS || body.heartbeatInterval > MaxHeartbeatS =>
          Some(StatusCodes.BadRequest -> "heartbeat_interval must be 2..60 seconds")
        case Some(cidr) if !Registry.inCidr(body.address, cidr) =>
          Some(StatusCodes.UnprocessableEntity -> s"\${body.address} is outside the deployment CIDR $cidr")
        case Some(_) => None
      }

  val route: Route = path("v1" / "instances") {
    post {
      optionalHeaderValueByName("X-Client-Id") { header =>
        entity(as[String]) { raw =>
          val clientId = header.getOrElse("")
          val body = parse(raw)
          refusal(clientId, body) match {
            case Some((status, reason)) => complete(status -> reason)
            case None =>
              val ttl = Instances.TtlIntervals * body.heartbeatInterval
              val key = Instances.recordKey(body.service, body.instanceId)
              // The record, its expiry and the membership land together: the TTL is the only failure detector.
              val tx = jedis.multi()
              tx.hset(key, Map(
                "address" -> body.address, "port" -> body.port.toString, "heartbeat_interval" -> body.heartbeatInterval.toString,
                "metadata_version" -> body.metadataVersion.toString, "last_heartbeat" -> (System.currentTimeMillis() / 1000).toString).asJava)
              tx.expire(key, ttl.toLong)
              tx.sadd(Instances.membersKey(body.service), body.instanceId)
              tx.exec()
              complete(json(StatusCodes.Created, answer(body, ttl, clientId)))
          }
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
#include <sw/redis++/redis++.h>

#include <string>
#include <unordered_map>

#include "discovery/instances.h"  // instances::recordKey, membersKey, kTtlIntervals, nowSeconds, registerInstance
#include "discovery/registry.h"   // registry::deploymentCidr, allowedServices, inCidr

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

void handle_register(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string client_id = req.get_header_value("X-Client-Id");
  json body = json::parse(req.body);
  const std::string service = body.value("service", "");
  const std::string instance_id = body.value("instance_id", "");
  const long interval = body.value("heartbeat_interval", 0L);
  if (!body.contains("metadata_version")) body["metadata_version"] = 1;
  const std::string key = instances::recordKey(service, instance_id);
  const std::unordered_map<std::string, std::string> fields = {
      {"address", body.value("address", "")},
      {"port", std::to_string(body.value("port", 0L))},
      {"heartbeat_interval", std::to_string(interval)},
      {"metadata_version", std::to_string(body.value("metadata_version", 1L))},
      {"last_heartbeat", std::to_string(instances::nowSeconds())}};
  redis.hset(key, fields.begin(), fields.end());
  redis.sadd(instances::membersKey(service), instance_id);
  body["ttl_seconds"] = instances::kTtlIntervals * interval;
  body["registered_by"] = client_id;
  res.status = 201;
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/instances", handle_register); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <unordered_map>

#include "discovery/instances.h"  // instances::recordKey, membersKey, kTtlIntervals, nowSeconds, registerInstance
#include "discovery/registry.h"   // registry::deploymentCidr, allowedServices, inCidr

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kMinPort = 1;
constexpr long kMaxPort = 65535;
constexpr long kMinHeartbeatS = 2;
constexpr long kMaxHeartbeatS = 60;

void refuse(httplib::Response& res, int status, const std::string& reason) {
  res.status = status;
  res.set_content(json{{"error", reason}}.dump(), "application/json");
}

void handle_register(const httplib::Request& req, httplib::Response& res) {
  const std::string client_id = req.get_header_value("X-Client-Id");
  if (client_id.empty()) return refuse(res, 401, "X-Client-Id is required");
  json body = json::parse(req.body);
  const std::string service = body.value("service", "");
  const std::string instance_id = body.value("instance_id", "");
  const std::string address = body.value("address", "");
  const long port = body.value("port", 0L);
  const long interval = body.value("heartbeat_interval", 0L);
  if (!body.contains("metadata_version")) body["metadata_version"] = 1;
  const auto cidr = registry::deploymentCidr(service);
  if (!cidr) return refuse(res, 404, "no deployment for service " + service);
  if (!registry::allowedServices(client_id).count(service)) return refuse(res, 403, client_id + " may not register into " + service);
  if (port < kMinPort || port > kMaxPort) return refuse(res, 400, "port must be 1..65535");
  if (interval < kMinHeartbeatS || interval > kMaxHeartbeatS) return refuse(res, 400, "heartbeat_interval must be 2..60 seconds");
  if (!registry::inCidr(address, *cidr)) return refuse(res, 422, address + " is outside the deployment CIDR " + *cidr);

  const long ttl = instances::kTtlIntervals * interval;
  const std::string key = instances::recordKey(service, instance_id);
  const std::unordered_map<std::string, std::string> fields = {
      {"address", address},
      {"port", std::to_string(port)},
      {"heartbeat_interval", std::to_string(interval)},
      {"metadata_version", std::to_string(body.value("metadata_version", 1L))},
      {"last_heartbeat", std::to_string(instances::nowSeconds())}};
  // The record, its expiry and the membership land together: the TTL is the only failure detector.
  auto tx = redis.transaction();
  tx.hset(key, fields.begin(), fields.end()).expire(key, std::chrono::seconds(ttl)).sadd(instances::membersKey(service), instance_id).exec();
  body["ttl_seconds"] = ttl;
  body["registered_by"] = client_id;
  res.status = 201;
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/instances", handle_register); }
`,
    },
  },
  harness: {
    python: `from discovery import instances, registry

INSTANCE = {"service": "checkout", "instance_id": "checkout-3", "address": "10.4.2.7", "port": 8080, "heartbeat_interval": 5, "metadata_version": 12}
AGENT = {"X-Client-Id": "checkout-agent"}


def _api(ctx):
    registry.define_service("checkout", "10.4.0.0/16")
    registry.define_service("payments", "10.9.0.0/16")
    registry.grant("checkout-agent", "checkout")
    return ctx.client(ctx.load("api").app)


def _nothing_written(ctx, service, instance_id, why):
    key = instances.record_key(service, instance_id)
    assert ctx.redis.exists(key) == 0, f"{why}, yet {key} was written: a refused registration must leave nothing a router can read"
    assert not ctx.redis.sismember(instances.members_key(service), instance_id), f"{why}, yet {instance_id} was added to sd:members:{service}"


async def check_scope(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/instances", json=INSTANCE)
        assert r.status_code == 401, f"a registration without X-Client-Id answered {r.status_code}, expected 401"
        _nothing_written(ctx, "checkout", "checkout-3", "the caller was anonymous")
        rogue = {**INSTANCE, "service": "payments", "instance_id": "payments-1", "address": "10.9.0.4"}
        r = await c.post("/v1/instances", json=rogue, headers=AGENT)
        assert r.status_code == 403, f"checkout-agent registering into payments answered {r.status_code}, expected 403: its grants name checkout only"
        _nothing_written(ctx, "payments", "payments-1", "checkout-agent has no grant for payments")
        r = await c.post("/v1/instances", json=INSTANCE, headers=AGENT)
    assert r.status_code == 201, f"checkout-agent registering checkout-3 into checkout answered {r.status_code}: {r.text}"
    assert ctx.redis.exists("sd:checkout:checkout-3") == 1, "a granted registration must write sd:checkout:checkout-3"


async def check_cidr(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/instances", json={**INSTANCE, "service": "inventory", "instance_id": "inventory-1"}, headers=AGENT)
        assert r.status_code == 404, f"a registration into inventory, which has no deployment, answered {r.status_code}, expected 404"
        _nothing_written(ctx, "inventory", "inventory-1", "inventory has no deployment")
        for address in ("10.5.0.9", "192.168.1.20", "laptop.local"):
            r = await c.post("/v1/instances", json={**INSTANCE, "address": address}, headers=AGENT)
            assert r.status_code == 422, f"checkout-3 at {address}, outside checkout's CIDR 10.4.0.0/16, answered {r.status_code}, expected 422"
            _nothing_written(ctx, "checkout", "checkout-3", f"{address} is outside 10.4.0.0/16")
        r = await c.post("/v1/instances", json=INSTANCE, headers=AGENT)
    assert r.status_code == 201, f"checkout-3 at 10.4.2.7, inside 10.4.0.0/16, answered {r.status_code}: {r.text}"
    assert ctx.redis.hget("sd:checkout:checkout-3", "address") == "10.4.2.7", f"sd:checkout:checkout-3 holds {ctx.redis.hgetall('sd:checkout:checkout-3')}"


async def check_ttl(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/instances", json=INSTANCE, headers=AGENT)
    assert r.status_code == 201, f"the registration answered {r.status_code}: {r.text}"
    assert r.json().get("ttl_seconds") == 15, f"ttl_seconds is {r.json().get('ttl_seconds')!r}, expected 3 intervals of 5 s = 15"
    ttl = ctx.redis.ttl("sd:checkout:checkout-3")
    assert 14 <= ttl <= 15, f"sd:checkout:checkout-3 has TTL {ttl}: the record must expire 15 s (3 heartbeat intervals) after it is written, or a crashed instance stays registered"
    assert ctx.redis.sismember("sd:members:checkout", "checkout-3"), "checkout-3 must be in sd:members:checkout"
    ctx.clock.advance(16)
    assert ctx.redis.exists("sd:checkout:checkout-3") == 0, "16 s after its only registration, with no heartbeat, sd:checkout:checkout-3 still exists: a crashed instance stays routable"


async def check_bounds(ctx):
    async with _api(ctx) as c:
        for change, why in (({"port": 0}, "port 0"), ({"port": 70000}, "port 70000"), ({"heartbeat_interval": 1}, "a 1 s heartbeat interval"), ({"heartbeat_interval": 3600}, "a 3600 s heartbeat interval")):
            r = await c.post("/v1/instances", json={**INSTANCE, **change}, headers=AGENT)
            assert r.status_code == 400, f"a registration with {why} answered {r.status_code}, expected 400"
            _nothing_written(ctx, "checkout", "checkout-3", f"the registration had {why}")
        r = await c.post("/v1/instances", json={**INSTANCE, "port": 65535, "heartbeat_interval": 60}, headers=AGENT)
    assert r.status_code == 201, f"port 65535 with a 60 s interval is inside the bounds and answered {r.status_code}: {r.text}"
`,
    typescript: `const INSTANCE = {service: 'checkout', instance_id: 'checkout-3', address: '10.4.2.7', port: 8080, heartbeat_interval: 5, metadata_version: 12};
const AGENT = {'X-Client-Id': 'checkout-agent'};

function api(ctx) {
  ctx.redis.set('sd:deploy:checkout', '10.4.0.0/16');
  ctx.redis.set('sd:deploy:payments', '10.9.0.0/16');
  ctx.redis.sadd('sd:grants:checkout-agent', 'checkout');
  return ctx.client(ctx.load('api').app);
}

function nothingWritten(ctx, service: string, instanceId: string, why: string): void {
  const key = 'sd:' + service + ':' + instanceId;
  assert.equal(ctx.redis.exists(key), 0, why + ', yet ' + key + ' was written: a refused registration must leave nothing a router can read');
  assert.equal(ctx.redis.sismember('sd:members:' + service, instanceId), 0, why + ', yet ' + instanceId + ' was added to sd:members:' + service);
}

export async function check_scope(ctx) {
  const c = api(ctx);
  let r = await c.post('/v1/instances', {json: INSTANCE});
  assert.equal(r.status, 401, \`a registration without X-Client-Id answered \${r.status}, expected 401\`);
  nothingWritten(ctx, 'checkout', 'checkout-3', 'the caller was anonymous');
  const rogue = {...INSTANCE, service: 'payments', instance_id: 'payments-1', address: '10.9.0.4'};
  r = await c.post('/v1/instances', {json: rogue, headers: AGENT});
  assert.equal(r.status, 403, \`checkout-agent registering into payments answered \${r.status}, expected 403: its grants name checkout only\`);
  nothingWritten(ctx, 'payments', 'payments-1', 'checkout-agent has no grant for payments');
  r = await c.post('/v1/instances', {json: INSTANCE, headers: AGENT});
  assert.equal(r.status, 201, \`checkout-agent registering checkout-3 into checkout answered \${r.status}: \${r.text}\`);
  assert.equal(ctx.redis.exists('sd:checkout:checkout-3'), 1, 'a granted registration must write sd:checkout:checkout-3');
}

export async function check_cidr(ctx) {
  const c = api(ctx);
  let r = await c.post('/v1/instances', {json: {...INSTANCE, service: 'inventory', instance_id: 'inventory-1'}, headers: AGENT});
  assert.equal(r.status, 404, \`a registration into inventory, which has no deployment, answered \${r.status}, expected 404\`);
  nothingWritten(ctx, 'inventory', 'inventory-1', 'inventory has no deployment');
  for (const address of ['10.5.0.9', '192.168.1.20', 'laptop.local']) {
    r = await c.post('/v1/instances', {json: {...INSTANCE, address}, headers: AGENT});
    assert.equal(r.status, 422, \`checkout-3 at \${address}, outside checkout's CIDR 10.4.0.0/16, answered \${r.status}, expected 422\`);
    nothingWritten(ctx, 'checkout', 'checkout-3', address + ' is outside 10.4.0.0/16');
  }
  r = await c.post('/v1/instances', {json: INSTANCE, headers: AGENT});
  assert.equal(r.status, 201, \`checkout-3 at 10.4.2.7, inside 10.4.0.0/16, answered \${r.status}: \${r.text}\`);
  assert.equal(ctx.redis.hget('sd:checkout:checkout-3', 'address'), '10.4.2.7', 'sd:checkout:checkout-3 must hold the address 10.4.2.7');
}

export async function check_ttl(ctx) {
  const c = api(ctx);
  const r = await c.post('/v1/instances', {json: INSTANCE, headers: AGENT});
  assert.equal(r.status, 201, \`the registration answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().ttl_seconds, 15, \`ttl_seconds is \${JSON.stringify(r.json().ttl_seconds)}, expected 3 intervals of 5 s = 15\`);
  const ttl = ctx.redis.ttl('sd:checkout:checkout-3');
  assert(14 <= ttl && ttl <= 15, \`sd:checkout:checkout-3 has TTL \${ttl}: the record must expire 15 s (3 heartbeat intervals) after it is written, or a crashed instance stays registered\`);
  assert.equal(ctx.redis.sismember('sd:members:checkout', 'checkout-3'), 1, 'checkout-3 must be in sd:members:checkout');
  ctx.clock.advance(16);
  assert.equal(ctx.redis.exists('sd:checkout:checkout-3'), 0, '16 s after its only registration, with no heartbeat, sd:checkout:checkout-3 still exists: a crashed instance stays routable');
}

export async function check_bounds(ctx) {
  const c = api(ctx);
  const cases: [Record<string, number>, string][] = [
    [{port: 0}, 'port 0'],
    [{port: 70000}, 'port 70000'],
    [{heartbeat_interval: 1}, 'a 1 s heartbeat interval'],
    [{heartbeat_interval: 3600}, 'a 3600 s heartbeat interval'],
  ];
  for (const [change, why] of cases) {
    const r = await c.post('/v1/instances', {json: {...INSTANCE, ...change}, headers: AGENT});
    assert.equal(r.status, 400, \`a registration with \${why} answered \${r.status}, expected 400\`);
    nothingWritten(ctx, 'checkout', 'checkout-3', 'the registration had ' + why);
  }
  const r = await c.post('/v1/instances', {json: {...INSTANCE, port: 65535, heartbeat_interval: 60}, headers: AGENT});
  assert.equal(r.status, 201, \`port 65535 with a 60 s interval is inside the bounds and answered \${r.status}: \${r.text}\`);
}
`,
    go: `package main

import (
	"net/http"

	"leetbuild/harness"
)

var instance = map[string]any{"service": "checkout", "instance_id": "checkout-3", "address": "10.4.2.7", "port": 8080, "heartbeat_interval": 5, "metadata_version": 12}

func api(ctx *harness.Ctx) *harness.HTTP {
	ctx.Redis.Set("sd:deploy:checkout", "10.4.0.0/16")
	ctx.Redis.Set("sd:deploy:payments", "10.9.0.0/16")
	ctx.Redis.Do("SADD", "sd:grants:checkout-agent", "checkout")
	mux := http.NewServeMux()
	routes(mux)
	return ctx.HTTP(mux)
}

func with(changes map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range instance {
		out[k] = v
	}
	for k, v := range changes {
		out[k] = v
	}
	return out
}

func register(c *harness.HTTP, body map[string]any) *harness.Response {
	return c.Post("/v1/instances", body, "X-Client-Id", "checkout-agent")
}

func nothingWritten(ctx *harness.Ctx, service, instanceID, why string) {
	key := "sd:" + service + ":" + instanceID
	ctx.Equal(ctx.Redis.Exists(key), 0, "%s, yet %s was written: a refused registration must leave nothing a router can read; exists", why, key)
	ctx.Assert(!ctx.Redis.SIsMember("sd:members:"+service, instanceID), "%s, yet %s was added to sd:members:%s", why, instanceID, service)
}

func CheckScope(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/instances", instance)
	ctx.Equal(r.Status, 401, "a registration without X-Client-Id")
	nothingWritten(ctx, "checkout", "checkout-3", "the caller was anonymous")
	r = register(c, with(map[string]any{"service": "payments", "instance_id": "payments-1", "address": "10.9.0.4"}))
	ctx.Equal(r.Status, 403, "checkout-agent registering into payments (its grants name checkout only)")
	nothingWritten(ctx, "payments", "payments-1", "checkout-agent has no grant for payments")
	r = register(c, instance)
	ctx.Equal(r.Status, 201, "checkout-agent registering checkout-3 into checkout (%s)", r.Text())
	ctx.Equal(ctx.Redis.Exists("sd:checkout:checkout-3"), 1, "a granted registration must write sd:checkout:checkout-3; exists")
}

func CheckCidr(ctx *harness.Ctx) {
	c := api(ctx)
	r := register(c, with(map[string]any{"service": "inventory", "instance_id": "inventory-1"}))
	ctx.Equal(r.Status, 404, "a registration into inventory, which has no deployment")
	nothingWritten(ctx, "inventory", "inventory-1", "inventory has no deployment")
	for _, address := range []string{"10.5.0.9", "192.168.1.20", "laptop.local"} {
		r = register(c, with(map[string]any{"address": address}))
		ctx.Equal(r.Status, 422, "checkout-3 at %s, outside checkout's CIDR 10.4.0.0/16", address)
		nothingWritten(ctx, "checkout", "checkout-3", address+" is outside 10.4.0.0/16")
	}
	r = register(c, instance)
	ctx.Equal(r.Status, 201, "checkout-3 at 10.4.2.7, inside 10.4.0.0/16 (%s)", r.Text())
	address, _ := ctx.Redis.HGet("sd:checkout:checkout-3", "address")
	ctx.Equal(address, "10.4.2.7", "the address in sd:checkout:checkout-3")
}

func CheckTtl(ctx *harness.Ctx) {
	c := api(ctx)
	r := register(c, instance)
	ctx.Equal(r.Status, 201, "the registration (%s)", r.Text())
	var body struct {
		TTLSeconds int \`json:"ttl_seconds"\`
	}
	r.Decode(&body)
	ctx.Equal(body.TTLSeconds, 15, "ttl_seconds (3 intervals of 5 s)")
	ttl := ctx.Redis.TTL("sd:checkout:checkout-3")
	ctx.Assert(14 <= ttl && ttl <= 15, "sd:checkout:checkout-3 has TTL %d: the record must expire 15 s (3 heartbeat intervals) after it is written, or a crashed instance stays registered", ttl)
	ctx.Assert(ctx.Redis.SIsMember("sd:members:checkout", "checkout-3"), "checkout-3 must be in sd:members:checkout")
	ctx.Clock.Advance(16)
	ctx.Equal(ctx.Redis.Exists("sd:checkout:checkout-3"), 0, "16 s after its only registration, with no heartbeat, sd:checkout:checkout-3 must be gone, or a crashed instance stays routable; exists")
}

func CheckBounds(ctx *harness.Ctx) {
	c := api(ctx)
	cases := []struct {
		change map[string]any
		why    string
	}{
		{map[string]any{"port": 0}, "port 0"},
		{map[string]any{"port": 70000}, "port 70000"},
		{map[string]any{"heartbeat_interval": 1}, "a 1 s heartbeat interval"},
		{map[string]any{"heartbeat_interval": 3600}, "a 3600 s heartbeat interval"},
	}
	for _, tc := range cases {
		r := register(c, with(tc.change))
		ctx.Equal(r.Status, 400, "a registration with %s", tc.why)
		nothingWritten(ctx, "checkout", "checkout-3", "the registration had "+tc.why)
	}
	r := register(c, with(map[string]any{"port": 65535, "heartbeat_interval": 60}))
	ctx.Equal(r.Status, 201, "port 65535 with a 60 s interval is inside the bounds (%s)", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <utility>
#include <vector>

#include "discovery/instances.h"

namespace {

const nlohmann::json kInstance = {{"service", "checkout"}, {"instance_id", "checkout-3"}, {"address", "10.4.2.7"},
                                  {"port", 8080},          {"heartbeat_interval", 5},     {"metadata_version", 12}};

harness::HTTP api(harness::Ctx& ctx) {
  ctx.Redis.Set("sd:deploy:checkout", "10.4.0.0/16");
  ctx.Redis.Set("sd:deploy:payments", "10.9.0.0/16");
  ctx.Redis.Do("SADD", "sd:grants:checkout-agent", "checkout");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json with(const nlohmann::json& changes) {
  nlohmann::json out = kInstance;
  out.update(changes);
  return out;
}

harness::Response registerAs(harness::HTTP& c, const nlohmann::json& body) {
  return c.Post("/v1/instances", body.dump(), "Content-Type", "application/json", "X-Client-Id", "checkout-agent");
}

void nothingWritten(harness::Ctx& ctx, const std::string& service, const std::string& instance_id, const std::string& why) {
  const std::string key = "sd:" + service + ":" + instance_id;
  ctx.Equal(ctx.Redis.Exists(key), 0, "%s, yet %s was written: a refused registration must leave nothing a router can read; exists", why, key);
  ctx.Assert(!ctx.Redis.SIsMember("sd:members:" + service, instance_id), "%s, yet %s was added to sd:members:%s", why, instance_id, service);
}

}  // namespace

void CheckScope(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = c.Post("/v1/instances", kInstance.dump(), "Content-Type", "application/json");
  ctx.Equal(r.Status, 401, "a registration without X-Client-Id");
  nothingWritten(ctx, "checkout", "checkout-3", "the caller was anonymous");
  r = registerAs(c, with({{"service", "payments"}, {"instance_id", "payments-1"}, {"address", "10.9.0.4"}}));
  ctx.Equal(r.Status, 403, "checkout-agent registering into payments (its grants name checkout only)");
  nothingWritten(ctx, "payments", "payments-1", "checkout-agent has no grant for payments");
  r = registerAs(c, kInstance);
  ctx.Equal(r.Status, 201, "checkout-agent registering checkout-3 into checkout (%s)", r.Text());
  ctx.Equal(ctx.Redis.Exists("sd:checkout:checkout-3"), 1, "a granted registration must write sd:checkout:checkout-3; exists");
}

void CheckCidr(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = registerAs(c, with({{"service", "inventory"}, {"instance_id", "inventory-1"}}));
  ctx.Equal(r.Status, 404, "a registration into inventory, which has no deployment");
  nothingWritten(ctx, "inventory", "inventory-1", "inventory has no deployment");
  for (const std::string address : {"10.5.0.9", "192.168.1.20", "laptop.local"}) {
    r = registerAs(c, with({{"address", address}}));
    ctx.Equal(r.Status, 422, "checkout-3 at %s, outside checkout's CIDR 10.4.0.0/16", address);
    nothingWritten(ctx, "checkout", "checkout-3", address + " is outside 10.4.0.0/16");
  }
  r = registerAs(c, kInstance);
  ctx.Equal(r.Status, 201, "checkout-3 at 10.4.2.7, inside 10.4.0.0/16 (%s)", r.Text());
  ctx.Equal(ctx.Redis.HGet("sd:checkout:checkout-3", "address").value_or(""), "10.4.2.7", "the address in sd:checkout:checkout-3");
}

void CheckTtl(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = registerAs(c, kInstance);
  ctx.Equal(r.Status, 201, "the registration (%s)", r.Text());
  ctx.Equal(nlohmann::json::parse(r.Text()).value("ttl_seconds", 0L), 15, "ttl_seconds (3 intervals of 5 s)");
  const long long ttl = ctx.Redis.TTL("sd:checkout:checkout-3");
  ctx.Assert(14 <= ttl && ttl <= 15, "sd:checkout:checkout-3 has TTL %d: the record must expire 15 s (3 heartbeat intervals) after it is written, or a crashed instance stays registered", ttl);
  ctx.Assert(ctx.Redis.SIsMember("sd:members:checkout", "checkout-3"), "checkout-3 must be in sd:members:checkout");
  ctx.Clock.Advance(16);
  ctx.Equal(ctx.Redis.Exists("sd:checkout:checkout-3"), 0, "16 s after its only registration, with no heartbeat, sd:checkout:checkout-3 must be gone, or a crashed instance stays routable; exists");
}

void CheckBounds(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::vector<std::pair<nlohmann::json, std::string>> cases = {
      {{{"port", 0}}, "port 0"},
      {{{"port", 70000}}, "port 70000"},
      {{{"heartbeat_interval", 1}}, "a 1 s heartbeat interval"},
      {{{"heartbeat_interval", 3600}}, "a 3600 s heartbeat interval"}};
  for (const auto& [change, why] : cases) {
    const auto r = registerAs(c, with(change));
    ctx.Equal(r.Status, 400, "a registration with %s", why);
    nothingWritten(ctx, "checkout", "checkout-3", "the registration had " + why);
  }
  const auto r = registerAs(c, with({{"port", 65535}, {"heartbeat_interval", 60}}));
  ctx.Equal(r.Status, 201, "port 65535 with a 60 s interval is inside the bounds (%s)", r.Text());
}
`,
  },
  hints: [
    'An instance the checkout agent registered shows up under payments, and a pod killed an hour ago is still listed in sd:members:checkout with its record intact.',
    'The handler writes before it checks anything: no grant lookup, no CIDR test, no bounds. And HSET creates a hash with no TTL, so the ttl_seconds in the answer is a promise nobody keeps.',
    'Guard in order: 401, `deployment_cidr` None → 404, `allowed_services` → 403, port and interval → 400, `in_cidr` → 422. Then one `pipeline(transaction=True)` with `hset`, `expire(key, TTL_INTERVALS * heartbeat_interval)` and `sadd`.',
  ],
  debrief: `Every guard runs before the write, so a refused registration leaves nothing a router could read. The order follows what each answer tells the agent: 401 is a missing identity, 404 a mistyped service, 403 a grant problem, 400 a malformed body, 422 a well-formed address that is simply not this deployment's. The expiry rides in the same MULTI as the hash because the TTL is the registry's only failure detector: a record written without one outlives every crash. Production registries prove the caller with mTLS instead of trusting a header the mesh set, and stamp each registration with the deploy that made it, so an operator can tell an instance from a stray process.`,
};
