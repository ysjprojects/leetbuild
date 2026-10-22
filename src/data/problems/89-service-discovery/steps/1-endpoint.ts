import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/instances: registration that is real and scoped',
  concept: 'http',
  file: 'api',
  focus: ['client', 'discovery', 'db', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it takes a registration,
writes it to Redis under a key, answers 200 and the demo looks perfect. It hides three production
flaws — it trusts the address, it trusts the caller, and it writes an entry that can never die.

Implement \`POST /v1/instances\` with body
\`{"service": "checkout", "instance_id": "checkout-3", "address": "10.4.2.7", "port": 8080, "heartbeat_interval": 5, "metadata_version": 12}\`.

- The caller is identified by the mesh-authenticated \`X-Client-Id\` header; a missing or empty
  value is **401**.
- \`service\` must exist in the registry: **404** when the registry holds no deployment for it.
- The caller must be scoped to that service (\`registry.allowed_services(client_id)\`). A client
  that is authenticated but not scoped for the requested service gets **403**. The draft lets any
  caller register into any service, which is how one team's rollout ends up in another team's
  membership and how a compromised sidecar enumerates the fleet.
- \`instance_id\` must be a non-empty slug of at most 63 characters (**400**).
- \`address\` must parse as an IP literal (**400** when it does not) *and* lie inside the CIDR the
  service's deployment declared (\`registry.deployment_cidr(service)\`). An address outside that
  CIDR — a laptop's public address, another cluster's routable range, an unroutable \`169.254\`
  link-local — is **422**: syntactically fine, semantically not ours. The draft accepts anything,
  so traffic can be pointed at whatever the caller typed.
- \`port\` is an integer in \`1..65535\` (**400**), \`heartbeat_interval\` an integer in \`2..60\`
  seconds (**400**), \`metadata_version\` at least 1 (**400**).
- Store the instance under \`sd:{service}:{instance_id}\` as a JSON record — service, instance id,
  address, port, metadata version, heartbeat interval, \`last_heartbeat\` unix seconds — and set
  the key's expiry to **three heartbeat intervals in the same write**:
  \`SET key value EX 3 * heartbeat_interval\`. A registration without a TTL is a routing entry that
  no crash, no deploy and no decommission can ever remove, and it looks like it worked.
- Answer **201** with \`instance_id\`, \`service\`, \`address\`, \`port\`, \`metadata_version\`,
  \`heartbeat_interval\`, \`ttl_seconds\` and the Redis \`key\`.

**Failure mode the checks target.** Registration is the trust boundary of the whole discovery
plane: every later routing decision reads what this handler wrote. A draft that takes the address
on faith registers instances nobody can reach (and, worse, instances whose addresses were chosen by
whoever holds a service token), a draft that ignores the caller's scope lets any service write
another service's membership, and a draft that stores without a TTL creates the ghost instance:
registered forever, routable forever, gone for minutes.

The tests: an address outside the deployment CIDR is rejected with 422, an authenticated caller
registering into a service it is not scoped for is rejected with 403, and a registration whose key
carries no expiry — a heartbeat that stops — is never routable again.`,
  sequence: {
    participants: ['Instance agent', 'Discovery API', 'service registry', 'Redis'],
    messages: [
      {from: 'Instance agent', to: 'Discovery API', label: 'POST /v1/instances · X-Client-Id', kind: 'sync'},
      {
        from: 'Discovery API',
        to: 'service registry',
        label: 'deployment_cidr(service) · allowed_services',
        kind: 'sync',
      },
      {from: 'service registry', to: 'Discovery API', label: '10.4.0.0/16 · {checkout}', kind: 'reply'},
      {
        from: 'Discovery API',
        to: 'Discovery API',
        label: '422 outside the CIDR · 403 outside the scope · 400 bad port or interval',
        kind: 'sync',
      },
      {
        from: 'Discovery API',
        to: 'Redis',
        label: 'SET sd:checkout:checkout-3 {…} EX 3 · heartbeat_interval',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Discovery API', label: 'OK', kind: 'reply'},
      {from: 'Discovery API', to: 'Instance agent', label: '201 {instance_id, ttl_seconds, key}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'cidr',
      title: 'The address must be inside the deployment CIDR',
      detail:
        'The address is parsed as an IP and tested for membership in `registry.deployment_cidr(service)`; an address outside it answers **422 Unprocessable Entity**. The draft accepts any address, so a registration can point routing at a host that is not ours.',
      match: {
        python: {all: [/ipaddress/, /cidr/, /422/]},
        typescript: {all: [/inCidr/, /cidr/, /422/]},
        go: {all: [/net\.ParseCIDR/, /cidr/, /422|StatusUnprocessableEntity/]},
        scala: {all: [/inCidr/, /cidr/, /422|UnprocessableEntity/]},
        cpp: {all: [/inCidr/, /cidr/, /422/]},
      },
    },
    {
      id: 'scope',
      title: 'Cross-service registration is 403',
      detail:
        'The caller comes from `X-Client-Id` and its allowed services are checked against the requested service: a scoped client may register only into its own service (**403** otherwise). The draft accepts a service name from any caller.',
      match: {
        python: {all: [/X-Client-Id/, /403/, /allowed_services/]},
        typescript: {all: [/x-client-id/, /403/, /allowedServices/]},
        go: {all: [/X-Client-Id/, /403|StatusForbidden/, /[Aa]llowedServices/]},
        scala: {all: [/X-Client-Id/, /403|Forbidden/, /allowedServices/]},
        cpp: {all: [/X-Client-Id/, /403/, /allowedServices/]},
      },
    },
    {
      id: 'ttl',
      title: 'The registration carries the heartbeat expiry',
      detail:
        'The record is written with an explicit expiry of three heartbeat intervals (`SET … EX`, `SetParams.ex`, `time.Second`, `std::chrono::seconds`). The draft uses a plain hash write, so the registration outlives every heartbeat it will never receive.',
      match: {
        python: {all: [/\.set\(/, /ex=/, /heartbeat_interval/]},
        typescript: {all: [/redis\.set\(/, /'EX'/, /heartbeatInterval/]},
        go: {all: [/\.Set\([^;]*Context/, /time\.Second/, /heartbeatInterval|HeartbeatInterval/]},
        scala: {all: [/SetParams/, /ex\(/, /heartbeatInterval|heartbeat_interval/]},
        cpp: {all: [/\.set\(/, /std::chrono::seconds/, /heartbeat/]},
      },
    },
    {
      id: 'bounds',
      title: 'Port and heartbeat interval are bounded',
      detail:
        '`port` is validated against `1..65535` and `heartbeat_interval` against `2..60` seconds, both answering **400**. The draft validates neither, so a port of 0 or a 24-hour interval becomes a routing entry that is wrong in a way only traffic reveals.',
      match: {
        python: {all: [/65535/, /heartbeat_interval/, /400/]},
        typescript: {all: [/65535/, /heartbeatInterval/, /reply\.code\(400\)/]},
        go: {all: [/65535/, /heartbeatInterval|HeartbeatInterval/, /StatusBadRequest|400/]},
        scala: {all: [/65535/, /heartbeatInterval|heartbeat_interval/, /BadRequest|400/]},
        cpp: {all: [/65535/, /heartbeatInterval/, /400/]},
      },
    },
    {
      id: 'response',
      title: 'Answers 201 with the identity and the derived TTL',
      detail:
        'The response is **201 Created** and carries `instance_id`, `metadata_version` and `ttl_seconds` — the caller must be able to read back the TTL it will have to beat. The draft answers 200 with `{"ok": true}`.',
      match: {
        python: {all: [/status_code=201/, /metadata_version/, /ttl_seconds/]},
        typescript: {all: [/reply\.code\(201\)/, /metadata_version/, /ttl_seconds/]},
        go: {all: [/StatusCreated/, /metadata_version/, /ttl_seconds/]},
        scala: {all: [/Created/, /metadata_version/, /ttl_seconds/]},
        cpp: {all: [/201/, /metadata_version/, /ttl_seconds/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("discovery")
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class RegisterRequest(BaseModel):
    service: str
    instance_id: str
    address: str
    port: int
    heartbeat_interval: int
    metadata_version: int = 1


class Registry:
    def deployment_cidr(self, service: str) -> str | None:
        """The CIDR the service's deployment declared, or None when the service is unknown."""
        raise NotImplementedError

    def allowed_services(self, client_id: str) -> set[str]:
        """The services client_id may register into."""
        raise NotImplementedError


registry = Registry()


@app.post("/v1/instances")
def register(body: RegisterRequest, client_id: str = Header(default="", alias="X-Client-Id")) -> JSONResponse:
    # TODO: this draft trusts the address (no deployment CIDR check, so no 422), trusts the caller
    # (any authenticated client may register into any service), and keeps the registration without
    # a TTL. Review all three.
    key = f"sd:{body.service}:{body.instance_id}"
    record = {
        "service": body.service,
        "instance_id": body.instance_id,
        "address": body.address,
        "port": body.port,
        "heartbeat_interval": body.heartbeat_interval,
        "metadata_version": body.metadata_version,
        "last_heartbeat": int(time.time()),
    }
    r.hset(key, mapping={k: str(v) for k, v in record.items()})
    logger.info("registered %s", key)
    return JSONResponse({"instance_id": body.instance_id, "ok": True}, status_code=200)
`,
      solution: `import json
import logging
import time

import ipaddress
import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("discovery")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_INTERVALS = 3
MIN_HEARTBEAT_S = 2
MAX_HEARTBEAT_S = 60
MIN_PORT = 1
MAX_PORT = 65535
MAX_INSTANCE_ID = 63


class RegisterRequest(BaseModel):
    service: str
    instance_id: str
    address: str
    port: int
    heartbeat_interval: int
    metadata_version: int = 1


class Registry:
    def deployment_cidr(self, service: str) -> str | None:
        """The CIDR the service's deployment declared, or None when the service is unknown."""
        raise NotImplementedError

    def allowed_services(self, client_id: str) -> set[str]:
        """The services client_id may register into."""
        raise NotImplementedError


registry = Registry()


@app.post("/v1/instances")
def register(body: RegisterRequest, client_id: str | None = Header(default=None, alias="X-Client-Id")) -> JSONResponse:
    if client_id is None or client_id == "":
        raise HTTPException(status_code=401, detail="missing X-Client-Id")

    cidr = registry.deployment_cidr(body.service)
    if cidr is None:
        raise HTTPException(status_code=404, detail="unknown service")
    if body.service not in registry.allowed_services(client_id):
        raise HTTPException(status_code=403, detail="client is not scoped to this service")

    if not body.instance_id or len(body.instance_id) > MAX_INSTANCE_ID or not body.instance_id[0].isalnum():
        raise HTTPException(status_code=400, detail="invalid instance_id")
    try:
        address = ipaddress.ip_address(body.address)
    except ValueError:
        raise HTTPException(status_code=400, detail="address must be an IP literal")
    if not address.is_private and not address.is_loopback:
        raise HTTPException(status_code=422, detail="address is not routable inside the deployment")
    if address not in ipaddress.ip_network(cidr):
        raise HTTPException(status_code=422, detail="address is outside the deployment CIDR")
    if not MIN_PORT <= body.port <= MAX_PORT:
        raise HTTPException(status_code=400, detail="port must be 1..65535")
    if not MIN_HEARTBEAT_S <= body.heartbeat_interval <= MAX_HEARTBEAT_S:
        raise HTTPException(status_code=400, detail="heartbeat_interval must be 2..60")
    if body.metadata_version < 1:
        raise HTTPException(status_code=400, detail="metadata_version must be >= 1")

    ttl_seconds = TTL_INTERVALS * body.heartbeat_interval
    key = f"sd:{body.service}:{body.instance_id}"
    record = {
        "service": body.service,
        "instance_id": body.instance_id,
        "address": str(address),
        "port": body.port,
        "heartbeat_interval": body.heartbeat_interval,
        "metadata_version": body.metadata_version,
        "last_heartbeat": int(time.time()),
    }
    r.set(key, json.dumps(record), ex=ttl_seconds)
    logger.info("register service=%s instance=%s address=%s ttl=%d", body.service, body.instance_id, address, ttl_seconds)
    return JSONResponse({**record, "ttl_seconds": ttl_seconds, "key": key}, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/instances: a model-generated draft that trusts its caller. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: 'redis', port: 6379});

export const registry = {
  /** The CIDR the service's deployment declared, or null when the service is unknown. */
  deploymentCidr(service: string): string | null {
    throw new Error('not implemented');
  },
  /** The services clientId may register into. */
  allowedServices(clientId: string): Set<string> {
    throw new Error('not implemented');
  },
};

interface RegisterBody {
  service: string;
  instance_id: string;
  address: string;
  port: number;
  heartbeat_interval: number;
  metadata_version?: number;
}

app.post('/v1/instances', async (request, reply) => {
  // TODO: this draft trusts the address (no deployment CIDR check, so no 422), trusts the caller
  // (any authenticated client may register into any service), and keeps the registration without
  // a TTL. Review all three.
  const body = request.body as RegisterBody;
  const key = \`sd:\${body.service}:\${body.instance_id}\`;
  await redis.hset(key, {
    service: body.service,
    instance_id: body.instance_id,
    address: body.address,
    port: String(body.port),
    heartbeat_interval: String(body.heartbeat_interval),
    metadata_version: String(body.metadata_version ?? 1),
    last_heartbeat: String(Math.floor(Date.now() / 1000)),
  });
  request.log.info({key}, 'registered');
  return reply.code(200).send({instance_id: body.instance_id, ok: true});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/instances: registration scoped to the caller, inside the deployment CIDR, with a TTL. */
import {isIP} from 'node:net';

import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: 'redis', port: 6379});

export const registry = {
  /** The CIDR the service's deployment declared, or null when the service is unknown. */
  deploymentCidr(service: string): string | null {
    throw new Error('not implemented');
  },
  /** The services clientId may register into. */
  allowedServices(clientId: string): Set<string> {
    throw new Error('not implemented');
  },
};

const TTL_INTERVALS = 3;
const MIN_HEARTBEAT_S = 2;
const MAX_HEARTBEAT_S = 60;
const MIN_PORT = 1;
const MAX_PORT = 65535;
const MAX_INSTANCE_ID = 63;

interface RegisterBody {
  service: string;
  instance_id: string;
  address: string;
  port: number;
  heartbeat_interval: number;
  metadata_version?: number;
}

function ipv4ToInt(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/** True when the address is a literal inside the CIDR; a host outside it is not ours. */
function inCidr(address: string, cidr: string): boolean {
  const [network, prefixRaw] = cidr.split('/');
  const prefix = Number(prefixRaw);
  const ip = ipv4ToInt(address);
  const net = ipv4ToInt(network ?? '');
  if (ip === null || net === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (((ip & mask) >>> 0) === ((net & mask) >>> 0));
}

app.post('/v1/instances', async (request, reply) => {
  const clientId = request.headers['x-client-id'];
  if (typeof clientId !== 'string' || clientId === '') return reply.code(401).send({error: 'missing X-Client-Id'});

  const body = request.body as Partial<RegisterBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.service !== 'string')
    return reply.code(400).send({error: 'invalid body'});
  const cidr = registry.deploymentCidr(body.service);
  if (cidr === null) return reply.code(404).send({error: 'unknown service'});
  if (!registry.allowedServices(clientId).has(body.service))
    return reply.code(403).send({error: 'client is not scoped to this service'});

  const instanceId = body.instance_id;
  if (typeof instanceId !== 'string' || instanceId === '' || instanceId.length > MAX_INSTANCE_ID)
    return reply.code(400).send({error: 'invalid instance_id'});
  if (typeof body.address !== 'string') return reply.code(400).send({error: 'address must be an IP literal'});
  if (isIP(body.address) !== 4) return reply.code(400).send({error: 'address must be an IP literal'});
  if (!inCidr(body.address, cidr))
    return reply.code(422).send({error: 'address is outside the deployment CIDR'});
  const port = body.port;
  if (!Number.isInteger(port) || (port as number) < MIN_PORT || (port as number) > MAX_PORT)
    return reply.code(400).send({error: 'port must be 1..65535'});
  const heartbeatInterval = body.heartbeat_interval;
  if (!Number.isInteger(heartbeatInterval) || (heartbeatInterval as number) < MIN_HEARTBEAT_S || (heartbeatInterval as number) > MAX_HEARTBEAT_S)
    return reply.code(400).send({error: 'heartbeat_interval must be 2..60'});
  const metadataVersion = body.metadata_version ?? 1;
  if (!Number.isInteger(metadataVersion) || metadataVersion < 1)
    return reply.code(400).send({error: 'metadata_version must be >= 1'});

  const ttlSeconds = TTL_INTERVALS * (heartbeatInterval as number);
  const key = \`sd:\${body.service}:\${instanceId}\`;
  const record = {
    service: body.service,
    instance_id: instanceId,
    address: body.address,
    port,
    heartbeat_interval: heartbeatInterval,
    metadata_version: metadataVersion,
    last_heartbeat: Math.floor(Date.now() / 1000),
  };
  await redis.set(key, JSON.stringify(record), 'EX', ttlSeconds);
  request.log.info({service: body.service, instance_id: instanceId, ttl_seconds: ttlSeconds}, 'registered');
  return reply.code(201).send({...record, ttl_seconds: ttlSeconds, key});
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
	"time"

	"github.com/redis/go-redis/v9"
)

type RegisterRequest struct {
	Service           string \`json:"service"\`
	InstanceID        string \`json:"instance_id"\`
	Address           string \`json:"address"\`
	Port              int    \`json:"port"\`
	HeartbeatInterval int    \`json:"heartbeat_interval"\`
	MetadataVersion   int    \`json:"metadata_version"\`
}

type Registry struct{}

func (r *Registry) DeploymentCIDR(service string) (string, error) { return "", nil }

func (r *Registry) AllowedServices(clientID string) (map[string]bool, error) { return nil, nil }

var (
	registry = &Registry{}
	rdb      = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func register(rw http.ResponseWriter, r *http.Request) {
	var body RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft trusts the address (no deployment CIDR check, so no 422), trusts the caller
	// (any authenticated client may register into any service), and keeps the registration without
	// a TTL. Review all three.
	key := "sd:" + body.Service + ":" + body.InstanceID
	record := map[string]any{
		"service":            body.Service,
		"instance_id":        body.InstanceID,
		"address":            body.Address,
		"port":               body.Port,
		"heartbeat_interval": body.HeartbeatInterval,
		"metadata_version":   body.MetadataVersion,
		"last_heartbeat":     time.Now().Unix(),
	}
	payload, _ := json.Marshal(record)
	rdb.HSet(r.Context(), key, "record", payload)
	log.Printf("registered %s", key)
	writeJSON(rw, http.StatusOK, map[string]any{"instance_id": body.InstanceID, "ok": true})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/instances", register)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	ttlIntervals       = 3
	minHeartbeatSecs   = 2
	maxHeartbeatSecs   = 60
	minPort            = 1
	maxPort            = 65535
	maxInstanceIDBytes = 63
)

type RegisterRequest struct {
	Service           string \`json:"service"\`
	InstanceID        string \`json:"instance_id"\`
	Address           string \`json:"address"\`
	Port              int    \`json:"port"\`
	HeartbeatInterval int    \`json:"heartbeat_interval"\`
	MetadataVersion   int    \`json:"metadata_version"\`
}

type Registry struct{}

func (r *Registry) DeploymentCIDR(ctx context.Context, service string) (string, error) { return "", nil }

func (r *Registry) AllowedServices(ctx context.Context, clientID string) (map[string]bool, error) {
	return nil, nil
}

var (
	registry = &Registry{}
	rdb      = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

/** inCidr reports whether address is an IP literal inside cidr; anything else is not ours. */
func inCidr(address, cidr string) bool {
	ip := net.ParseIP(address)
	if ip == nil {
		return false
	}
	_, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return false
	}
	return network.Contains(ip)
}

func register(rw http.ResponseWriter, r *http.Request) {
	clientID := r.Header.Get("X-Client-Id")
	if clientID == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Client-Id"})
		return
	}
	var body RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	cidr, err := registry.DeploymentCIDR(r.Context(), body.Service)
	if err != nil || cidr == "" {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown service"})
		return
	}
	allowed, err := registry.AllowedServices(r.Context(), clientID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if !allowed[body.Service] {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "client is not scoped to this service"})
		return
	}
	if body.InstanceID == "" || len(body.InstanceID) > maxInstanceIDBytes {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid instance_id"})
		return
	}
	if net.ParseIP(body.Address) == nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "address must be an IP literal"})
		return
	}
	if !inCidr(body.Address, cidr) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "address is outside the deployment CIDR"})
		return
	}
	if body.Port < minPort || body.Port > maxPort {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "port must be 1..65535"})
		return
	}
	if body.HeartbeatInterval < minHeartbeatSecs || body.HeartbeatInterval > maxHeartbeatSecs {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "heartbeat_interval must be 2..60"})
		return
	}
	if body.MetadataVersion < 1 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "metadata_version must be >= 1"})
		return
	}

	ttlSeconds := ttlIntervals * body.HeartbeatInterval
	key := "sd:" + body.Service + ":" + body.InstanceID
	record := map[string]any{
		"service":            body.Service,
		"instance_id":        body.InstanceID,
		"address":            body.Address,
		"port":               body.Port,
		"heartbeat_interval": body.HeartbeatInterval,
		"metadata_version":   body.MetadataVersion,
		"last_heartbeat":     time.Now().Unix(),
	}
	payload, _ := json.Marshal(record)
	if err := rdb.Set(r.Context(), key, payload, time.Duration(ttlIntervals*body.HeartbeatInterval)*time.Second).Err(); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("register service=%s instance=%s address=%s ttl=%d", body.Service, body.InstanceID, body.Address, ttlSeconds)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"service":            body.Service,
		"instance_id":        body.InstanceID,
		"address":            body.Address,
		"port":               body.Port,
		"heartbeat_interval": body.HeartbeatInterval,
		"metadata_version":   body.MetadataVersion,
		"ttl_seconds":        ttlSeconds,
		"key":                key,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/instances", register)
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

import java.time.Instant

final case class RegisterRequest(
    service: String,
    instance_id: String,
    address: String,
    port: Int,
    heartbeat_interval: Int,
    metadata_version: Int)

final case class RegistryDeployment(cidr: String)

trait Registry {
  def deploymentCidr(service: String): Option[RegistryDeployment]
  def allowedServices(clientId: String): Set[String]
}

object Api {
  implicit val system: ActorSystem = ActorSystem("discovery")
  implicit val registerFormat: RootJsonFormat[RegisterRequest] = jsonFormat6(RegisterRequest)

  val registry: Registry = ???
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "instances") {
      post {
        optionalHeaderValueByName("X-Client-Id") { _ =>
          entity(as[RegisterRequest]) { body =>
            // TODO: this draft trusts the address (no deployment CIDR check, so no 422), trusts the
            // caller (any authenticated client may register into any service), and keeps the
            // registration without a TTL. Review all three.
            val key = "sd:" + body.service + ":" + body.instance_id
            jedis.hset(
              key,
              Map(
                "service" -> body.service,
                "instance_id" -> body.instance_id,
                "address" -> body.address,
                "port" -> body.port.toString,
                "heartbeat_interval" -> body.heartbeat_interval.toString,
                "metadata_version" -> body.metadata_version.toString,
                "last_heartbeat" -> Instant.now().getEpochSecond.toString).asJava)
            system.log.info("registered " + key)
            complete(StatusCodes.OK, s"""{"instance_id":"\${body.instance_id}","ok":true}""")
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
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import java.net.Inet4Address
import java.net.InetAddress
import java.nio.charset.StandardCharsets
import java.time.Instant

final case class RegisterRequest(
    service: String,
    instance_id: String,
    address: String,
    port: Int,
    heartbeat_interval: Int,
    metadata_version: Int)

final case class RegistryDeployment(cidr: String)

trait Registry {
  def deploymentCidr(service: String): Option[RegistryDeployment]
  def allowedServices(clientId: String): Set[String]
}

object Api {
  implicit val system: ActorSystem = ActorSystem("discovery")
  implicit val registerFormat: RootJsonFormat[RegisterRequest] = jsonFormat6(RegisterRequest)

  val TtlIntervals = 3
  val MinHeartbeatSecs = 2
  val MaxHeartbeatSecs = 60
  val MinPort = 1
  val MaxPort = 65535
  val MaxInstanceIdLength = 63

  val registry: Registry = ???
  val jedis = new Jedis("redis", 6379)

  private def ipv4(address: String): Option[Long] =
    try {
      InetAddress.getByName(address) match {
        case v4: Inet4Address =>
          Some(v4.getAddress.foldLeft(0L)((acc, byte) => (acc << 8) | (byte & 0xff)))
        case _ => None
      }
    } catch {
      case _: Exception => None
    }

  /** inCidr is true only for an address literal inside the deployment range: 422 otherwise. */
  def inCidr(address: String, cidr: String): Boolean = {
    val parts = cidr.split("/", 2)
    if (parts.length != 2) false
    else {
      val prefix = parts(1).toInt
      val ip = ipv4(address)
      val network = ipv4(parts(0))
      if (ip.isEmpty || network.isEmpty || prefix < 0 || prefix > 32) false
      else {
        val mask = if (prefix == 0) 0L else (0xffffffffL << (32 - prefix)) & 0xffffffffL
        (ip.get & mask) == (network.get & mask)
      }
    }
  }

  val route: Route =
    path("v1" / "instances") {
      post {
        optionalHeaderValueByName("X-Client-Id") { clientIdOpt =>
          entity(as[RegisterRequest]) { body =>
            val clientId = clientIdOpt.filter(_.nonEmpty)
            if (clientId.isEmpty) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Client-Id"}""")
            } else {
              registry.deploymentCidr(body.service) match {
                case None =>
                  complete(StatusCodes.NotFound, """{"error":"unknown service"}""")
                case Some(deployment) =>
                  if (!registry.allowedServices(clientId.get).contains(body.service)) {
                    complete(StatusCodes.Forbidden, """{"error":"client is not scoped to this service"}""")
                  } else if (body.instance_id.isEmpty || body.instance_id.length > MaxInstanceIdLength) {
                    complete(StatusCodes.BadRequest, """{"error":"invalid instance_id"}""")
                  } else if (ipv4(body.address).isEmpty) {
                    complete(StatusCodes.BadRequest, """{"error":"address must be an IP literal"}""")
                  } else if (!inCidr(body.address, deployment.cidr)) {
                    complete(StatusCodes.UnprocessableEntity, """{"error":"address is outside the deployment CIDR"}""")
                  } else if (body.port < MinPort || body.port > MaxPort) {
                    complete(StatusCodes.BadRequest, """{"error":"port must be 1..65535"}""")
                  } else if (body.heartbeat_interval < MinHeartbeatSecs || body.heartbeat_interval > MaxHeartbeatSecs) {
                    complete(StatusCodes.BadRequest, """{"error":"heartbeat_interval must be 2..60"}""")
                  } else if (body.metadata_version < 1) {
                    complete(StatusCodes.BadRequest, """{"error":"metadata_version must be >= 1"}""")
                  } else {
                    val ttlSeconds = TtlIntervals * body.heartbeat_interval
                    val key = "sd:" + body.service + ":" + body.instance_id
                    val payload =
                      s"""{"service":"\${body.service}","instance_id":"\${body.instance_id}","address":"\${body.address}","port":\${body.port},"heartbeat_interval":\${body.heartbeat_interval},"metadata_version":\${body.metadata_version},"last_heartbeat":\${Instant.now().getEpochSecond}}"""
                    jedis.set(key, payload, SetParams.setParams().ex(ttlSeconds.toLong))
                    system.log.info(s"register service=\${body.service} instance=\${body.instance_id} ttl=$ttlSeconds")
                    complete(
                      StatusCodes.Created,
                      s"""{"service":"\${body.service}","instance_id":"\${body.instance_id}","address":"\${body.address}","port":\${body.port},"heartbeat_interval":\${body.heartbeat_interval},"metadata_version":\${body.metadata_version},"ttl_seconds":$ttlSeconds,"key":"$key"}""")
                  }
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
#include <sw/redis++/redis++.h>

#include <iostream>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

struct Registry {
  std::optional<std::string> deploymentCidr(const std::string& service);
  std::set<std::string> allowedServices(const std::string& clientId);
};

Registry registry;
sw::redis::Redis redis("tcp://redis:6379");

int main() {
  httplib::Server svr;

  svr.Post("/v1/instances", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft trusts the address (no deployment CIDR check, so no 422), trusts the caller
    // (any authenticated client may register into any service), and keeps the registration without
    // a TTL. Review all three.
    const auto service = body.value("service", std::string());
    const auto instanceId = body.value("instance_id", std::string());
    const auto key = "sd:" + service + ":" + instanceId;
    const auto record = json{
        {"service", service},
        {"instance_id", instanceId},
        {"address", body.value("address", std::string())},
        {"port", body.value("port", 0)},
        {"heartbeat_interval", body.value("heartbeat_interval", 0)},
        {"metadata_version", body.value("metadata_version", 1)},
    };
    redis.hset(key, "record", record.dump());
    std::cout << "registered " << key << "\\n";
    res.status = 200;
    res.set_content(json{{"instance_id", instanceId}, {"ok", true}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <arpa/inet.h>
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdint>
#include <iostream>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr int kTtlIntervals = 3;
constexpr int kMinHeartbeatSecs = 2;
constexpr int kMaxHeartbeatSecs = 60;
constexpr int kMinPort = 1;
constexpr int kMaxPort = 65535;
constexpr std::size_t kMaxInstanceId = 63;

struct Registry {
  std::optional<std::string> deploymentCidr(const std::string& service);
  std::set<std::string> allowedServices(const std::string& clientId);
};

Registry registry;
sw::redis::Redis redis("tcp://redis:6379");
long unixSeconds();

/** inCidr is true only for an address literal inside the deployment range: 422 otherwise. */
bool inCidr(const std::string& address, const std::string& cidr) {
  const auto slash = cidr.find('/');
  if (slash == std::string::npos) return false;
  in_addr ip{};
  in_addr network{};
  if (inet_pton(AF_INET, address.c_str(), &ip) != 1) return false;
  if (inet_pton(AF_INET, cidr.substr(0, slash).c_str(), &network) != 1) return false;
  const auto prefix = std::stoi(cidr.substr(slash + 1));
  if (prefix < 0 || prefix > 32) return false;
  const uint32_t mask = prefix == 0 ? 0u : htonl(~uint32_t{0} << (32 - prefix));
  return (ip.s_addr & mask) == (network.s_addr & mask);
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/instances", [](const httplib::Request& req, httplib::Response& res) {
    const auto clientId = req.get_header_value("X-Client-Id");
    if (clientId.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Client-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("service") || !body["service"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto service = body["service"].get<std::string>();
    const auto cidr = registry.deploymentCidr(service);
    if (!cidr) {
      res.status = 404;
      res.set_content(R"({"error":"unknown service"})", "application/json");
      return;
    }
    if (registry.allowedServices(clientId).count(service) == 0) {
      res.status = 403;
      res.set_content(R"({"error":"client is not scoped to this service"})", "application/json");
      return;
    }
    const auto instanceId = body.value("instance_id", std::string());
    if (instanceId.empty() || instanceId.size() > kMaxInstanceId) {
      res.status = 400;
      res.set_content(R"({"error":"invalid instance_id"})", "application/json");
      return;
    }
    const auto address = body.value("address", std::string());
    in_addr parsed{};
    if (inet_pton(AF_INET, address.c_str(), &parsed) != 1) {
      res.status = 400;
      res.set_content(R"({"error":"address must be an IP literal"})", "application/json");
      return;
    }
    if (!inCidr(address, *cidr)) {
      res.status = 422;
      res.set_content(R"({"error":"address is outside the deployment CIDR"})", "application/json");
      return;
    }
    const int port = body.value("port", 0);
    if (port < kMinPort || port > kMaxPort) {
      res.status = 400;
      res.set_content(R"({"error":"port must be 1..65535"})", "application/json");
      return;
    }
    const int heartbeatInterval = body.value("heartbeat_interval", 0);
    if (heartbeatInterval < kMinHeartbeatSecs || heartbeatInterval > kMaxHeartbeatSecs) {
      res.status = 400;
      res.set_content(R"({"error":"heartbeat_interval must be 2..60"})", "application/json");
      return;
    }
    const int metadataVersion = body.value("metadata_version", 1);
    if (metadataVersion < 1) {
      res.status = 400;
      res.set_content(R"({"error":"metadata_version must be >= 1"})", "application/json");
      return;
    }

    const int ttlSeconds = kTtlIntervals * heartbeatInterval;
    const auto key = "sd:" + service + ":" + instanceId;
    const auto record = json{
        {"service", service},
        {"instance_id", instanceId},
        {"address", address},
        {"port", port},
        {"heartbeat_interval", heartbeatInterval},
        {"metadata_version", metadataVersion},
        {"last_heartbeat", unixSeconds()},
    };
    redis.set(key, record.dump(), std::chrono::seconds(ttlSeconds));
    std::cout << "register service=" << service << " instance=" << instanceId << " ttl=" << ttlSeconds << "\\n";
    res.status = 201;
    res.set_content(
        json{{"service", service},
             {"instance_id", instanceId},
             {"address", address},
             {"port", port},
             {"heartbeat_interval", heartbeatInterval},
             {"metadata_version", metadataVersion},
             {"ttl_seconds", ttlSeconds},
             {"key", key}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guards in cost order: caller identity, service lookup, scope, then the body — instance id, address literal, CIDR membership, port, heartbeat interval, metadata version. Every guard returns before anything is written, so a rejected registration leaves no key behind.',
    'The address check is two steps, not one: parse the literal (`ipaddress.ip_address`, `isIP`, `net.ParseIP`, `InetAddress`, `inet_pton`) and then test membership in the deployment CIDR. A literal that parses but falls outside is **422**, not 400 — the request is well formed, the instance is simply not ours.',
    'The TTL is not decoration: `SET sd:{service}:{instance_id} payload EX 3 * heartbeat_interval` is the registry’s entire expiry mechanism. The heartbeat renews the same key, and a registration whose key never expires is a routing entry no crash, deploy or decommission can remove.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the boundary where the discovery plane is written to. The draft reads fine because the demo registers one instance, from one client, at one address, and never stops. Three separate defects are checked: the CIDR (an instance address is a fact the platform owns, not a string the caller chooses — public and link-local addresses are rejected as *unprocessable*, not *bad request*), the scope (the mesh tells you who called; the registry tells you what they may register, so a team token that only covers checkout cannot write payments), and the TTL (the registration must expire on its own, because every other safeguard in the system — the reaper, the probe loop, the read API — exists to handle entries that are already wrong). Real discovery services add per-deployment address pools, a registration audit trail, and a two-phase drain so a removing instance stops receiving traffic before its key disappears.`,
};
