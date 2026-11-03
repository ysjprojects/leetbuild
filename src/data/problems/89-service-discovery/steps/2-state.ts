import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis registry with TTL heartbeats and atomic replace',
  concept: 'redis',
  file: 'state',
  focus: ['discovery', 'redis', 'reaper'],
  task: `## Task

**Starting point.** The starter serves the two writes that keep a registry entry true, under
\`sd:{service}:{instance_id}\`. \`POST /v1/instances/{service}/{instance_id}/heartbeat\` (body
\`{"address", "port", "metadata_version", "heartbeat_interval"}\`) \`GET\`s the record, overwrites
address and port, \`SET\`s it back and calls \`EXPIRE\` with a constant \`TTL_SECONDS\`;
\`POST …/replace\` writes the replacement and then deletes a \`sd:previous:…\` key. It serves the demo,
which never restarts an instance or deploys, and hides five flaws.

**Failure mode the checks target.** A restarted instance with a new address keeps receiving traffic
at its old one, because the key stays warm while its metadata rots, and two heartbeats can
interleave between the \`GET\`, the \`SET\` and the \`EXPIRE\`. A lagging old replica rolls a
rollout back by overwriting a newer \`metadata_version\`. During every deploy window two live
addresses claim \`checkout-3\`. The TTL is a constant that ignores the promised interval.

- The heartbeat renews an instance that is already registered; a missing key is **410 Gone**.
- Everything moves in one atomic script (\`RENEW_LUA\`, \`register_script\`): the new address, port,
  \`metadata_version\`, the \`last_heartbeat\` stamp from \`redis.call('TIME')\` and the key's expiry.
  No client-side \`expire\` on the renewal path.
- An incoming \`metadata_version\` below the stored one is **409 Conflict** and writes nothing.
- The expiry is \`TTL_INTERVALS * heartbeat_interval\` seconds (three intervals), set inside the same
  script with \`'EX'\`.
- \`replace\` moves one identity to a new address inside one script (\`REPLACE_LUA\`): \`DEL\` the old
  record when its address differs, then \`SET\` the replacement with its own TTL, and answer **200**
  with the address it installed.`,
  sequence: {
    participants: ['Instance', 'Discovery API', 'Redis'],
    messages: [
      {
        from: 'Instance',
        to: 'Discovery API',
        label: 'POST /v1/instances/checkout/checkout-3/heartbeat {version 13, interval 5}',
        kind: 'sync',
      },
      {
        from: 'Discovery API',
        to: 'Redis',
        label: 'EVAL RENEW_LUA KEYS[sd:checkout:checkout-3] ARGV[address, port, 13, 5, 15]',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Discovery API', label: '1 renewed · 0 no such instance · -1 stale version', kind: 'reply'},
      {from: 'Discovery API', to: 'Instance', label: '200 {metadata_version, ttl_seconds} · 409 · 410', kind: 'reply'},
      {from: 'Instance', to: 'Discovery API', label: 'POST …/replace {address 10.4.9.4, version 14}', kind: 'sync'},
      {
        from: 'Discovery API',
        to: 'Redis',
        label: 'EVAL REPLACE_LUA — DEL sd:checkout:checkout-3, then SET address 10.4.9.4 EX 15',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Discovery API', label: 'OK', kind: 'reply'},
      {
        from: 'Discovery API',
        to: 'Instance',
        label: '200 {address 10.4.9.4} — one identity, one address',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'atomic-renew',
      title: 'Metadata and TTL are renewed by one atomic script',
      detail:
        'The renewal reads, clears the version guard, rewrites the record and sets the expiry inside a single `EVAL` (`register_script`, `NewScript`, `eval`), so metadata and liveness can never move apart.',
      match: {
        python: {all: [/RENEW_LUA/, /register_script\(/, /'EX'/]},
        typescript: {all: [/RENEW_LUA/, /\.eval\(/, /'EX'/]},
        go: {all: [/renewScript/, /\.Run\(/, /'EX'/]},
        scala: {all: [/RenewLua/, /\.eval\(/, /'EX'/]},
        cpp: {all: [/kRenewLua/, /\.eval/, /'EX'/]},
      },
    },
    {
      id: 'version-guard',
      title: 'An older metadata version is refused',
      detail:
        'A heartbeat carrying a `metadata_version` below the stored one answers **409 Conflict** and writes nothing, so a restarted or lagging replica cannot undo a rollout. The starter overwrites the version with whatever arrives.',
      match: {
        python: {all: [/metadata_version/, /409/]},
        typescript: {all: [/metadata_version/, /409/]},
        go: {all: [/metadata_version/, /409|StatusConflict/]},
        scala: {all: [/metadata_version/, /409|Conflict/]},
        cpp: {all: [/metadata_version/, /409/]},
      },
    },
    {
      id: 'identity-swap',
      title: 'One identity, one address across a replace',
      detail:
        'The replace script removes the old record (`DEL`) before it writes the replacement inside the same `EVAL`, so no reader sees two addresses for one identity during a deploy. The starter registers the replacement first and removes the original afterwards.',
      match: {
        python: {all: [/REPLACE_LUA/, /DEL/, /SET/]},
        typescript: {all: [/REPLACE_LUA/, /DEL/, /SET/]},
        go: {all: [/replaceScript/, /DEL/, /SET/]},
        scala: {all: [/ReplaceLua/, /DEL/, /SET/]},
        cpp: {all: [/kReplaceLua/, /DEL/, /SET/]},
      },
    },
    {
      id: 'expiry-derived',
      title: 'Expiry is three heartbeat intervals',
      detail:
        'The TTL written by the script is `3 * heartbeat_interval` seconds, derived from the interval the instance promised in the same request — not a constant. A hardcoded TTL either declares a healthy instance dead or keeps a ghost alive for minutes.',
      match: {
        python: {all: [/TTL_INTERVALS/, /heartbeat_interval/, /'EX'/]},
        typescript: {all: [/TTL_INTERVALS/, /heartbeat_interval|heartbeatInterval/, /'EX'/]},
        go: {all: [/ttlIntervals/, /heartbeatInterval|HeartbeatInterval/, /'EX'/]},
        scala: {all: [/TtlIntervals/, /heartbeat_interval|heartbeatInterval/, /'EX'/]},
        cpp: {all: [/kTtlIntervals/, /heartbeatInterval/, /'EX'/]},
      },
    },
    {
      id: 'no-bare-expire',
      title: 'No client-side EXPIRE on the renewal path',
      detail:
        'The renewal never calls `EXPIRE` from the client: a bare expiry refresh is the starter’s signature bug, because it renews liveness without renewing the metadata that liveness is supposed to certify.',
      match: {
        python: {all: [/RENEW_LUA/], none: [/\.expire\(/]},
        typescript: {all: [/RENEW_LUA/], none: [/\.expire\(/]},
        go: {all: [/renewScript/], none: [/\.Expire\(ctx/]},
        scala: {all: [/RenewLua/], none: [/\.expire\(/]},
        cpp: {all: [/kRenewLua/], none: [/\.expire\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("discovery")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_SECONDS = 30


class RenewRequest(BaseModel):
    address: str
    port: int
    metadata_version: int
    heartbeat_interval: int


def key_of(service: str, instance_id: str) -> str:
    return f"sd:{service}:{instance_id}"


@app.post("/v1/instances/{service}/{instance_id}/heartbeat")
def heartbeat(service: str, instance_id: str, body: RenewRequest) -> dict:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    key = key_of(service, instance_id)
    raw = r.get(key)
    if raw is None:
        return {"status": "unregistered"}
    record = json.loads(raw)
    record["address"] = body.address
    record["port"] = body.port
    record["last_heartbeat"] = int(time.time())
    r.set(key, json.dumps(record))
    r.expire(key, TTL_SECONDS)
    logger.info("renew %s", key)
    return {"status": "renewed"}


@app.post("/v1/instances/{service}/{instance_id}/replace")
def replace(service: str, instance_id: str, body: RenewRequest) -> dict:
    key = key_of(service, instance_id)
    record = {"address": body.address, "port": body.port, "metadata_version": body.metadata_version}
    r.set(key, json.dumps(record))
    r.expire(key, TTL_SECONDS)
    previous = f"sd:previous:{service}:{instance_id}"
    if r.exists(previous):
        r.delete(previous)
    return {"status": "replaced", "address": body.address}
`,
      solution: `import json
import logging

import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("discovery")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_INTERVALS = 3

# Renew a live instance in one round trip: the address, the metadata version, the heartbeat stamp
# and the expiry move together, so a restarted instance can never keep stale metadata routable.
RENEW_LUA = """
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local current = cjson.decode(raw)
if tonumber(ARGV[3]) < tonumber(current['metadata_version']) then
  return -1
end
current['address'] = ARGV[1]
current['port'] = tonumber(ARGV[2])
current['metadata_version'] = tonumber(ARGV[3])
current['heartbeat_interval'] = tonumber(ARGV[4])
current['last_heartbeat'] = tonumber(redis.call('TIME')[1])
redis.call('SET', KEYS[1], cjson.encode(current), 'EX', ARGV[5])
return 1
"""

# A deploy moves one identity to one address. The previous record is removed inside the same
# script, before the replacement exists, so no reader ever sees two addresses for one identity.
REPLACE_LUA = """
local raw = redis.call('GET', KEYS[1])
if raw then
  local current = cjson.decode(raw)
  if current['address'] ~= ARGV[1] then
    redis.call('DEL', KEYS[1])
  end
end
redis.call('SET', KEYS[1], ARGV[6], 'EX', ARGV[5])
return 1
"""

renew_script = r.register_script(RENEW_LUA)
replace_script = r.register_script(REPLACE_LUA)


class RenewRequest(BaseModel):
    address: str
    port: int
    metadata_version: int
    heartbeat_interval: int


def key_of(service: str, instance_id: str) -> str:
    return f"sd:{service}:{instance_id}"


@app.post("/v1/instances/{service}/{instance_id}/heartbeat")
def heartbeat(service: str, instance_id: str, body: RenewRequest) -> dict:
    key = key_of(service, instance_id)
    ttl_seconds = TTL_INTERVALS * body.heartbeat_interval
    outcome = renew_script(
        keys=[key],
        args=[body.address, body.port, body.metadata_version, body.heartbeat_interval, ttl_seconds],
    )
    if outcome == 0:
        raise HTTPException(status_code=410, detail="instance is not registered; register again")
    if outcome == -1:
        raise HTTPException(status_code=409, detail="metadata_version is older than the stored one")
    logger.info("renew service=%s instance=%s version=%d ttl=%d", service, instance_id, body.metadata_version, ttl_seconds)
    return {
        "service": service,
        "instance_id": instance_id,
        "address": body.address,
        "metadata_version": body.metadata_version,
        "ttl_seconds": ttl_seconds,
        "key": key,
    }


@app.post("/v1/instances/{service}/{instance_id}/replace")
def replace(service: str, instance_id: str, body: RenewRequest) -> dict:
    key = key_of(service, instance_id)
    ttl_seconds = TTL_INTERVALS * body.heartbeat_interval
    record = json.dumps({
        "service": service,
        "instance_id": instance_id,
        "address": body.address,
        "port": body.port,
        "heartbeat_interval": body.heartbeat_interval,
        "metadata_version": body.metadata_version,
    })
    replace_script(
        keys=[key],
        args=[body.address, body.port, body.metadata_version, body.heartbeat_interval, ttl_seconds, record],
    )
    logger.info("replace service=%s instance=%s address=%s ttl=%d", service, instance_id, body.address, ttl_seconds)
    return {
        "service": service,
        "instance_id": instance_id,
        "address": body.address,
        "metadata_version": body.metadata_version,
        "ttl_seconds": ttl_seconds,
    }
`,
    },
    typescript: {
      starter: `/** Heartbeat and replace for the Redis registry: flawed code. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: 'redis', port: 6379});

const TTL_SECONDS = 30;

interface RenewBody {
  address: string;
  port: number;
  metadata_version: number;
  heartbeat_interval: number;
}

const keyOf = (service: string, instanceId: string): string => \`sd:\${service}:\${instanceId}\`;

interface InstanceRecord {
  service: string;
  instance_id: string;
  address: string;
  port: number;
  metadata_version: number;
  heartbeat_interval: number;
  last_heartbeat: number;
}

app.post('/v1/instances/:service/:instanceId/heartbeat', async (request, reply) => {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const {service, instanceId} = request.params as {service: string; instanceId: string};
  const body = request.body as RenewBody;
  const key = keyOf(service, instanceId);
  const raw = await redis.get(key);
  if (raw === null) return reply.code(200).send({status: 'unregistered'});
  const record = JSON.parse(raw) as InstanceRecord;
  record.address = body.address;
  record.port = body.port;
  record.last_heartbeat = Math.floor(Date.now() / 1000);
  await redis.set(key, JSON.stringify(record));
  await redis.expire(key, TTL_SECONDS);
  request.log.info({key}, 'renewed');
  return reply.code(200).send({status: 'renewed'});
});

app.post('/v1/instances/:service/:instanceId/replace', async (request, reply) => {
  const {service, instanceId} = request.params as {service: string; instanceId: string};
  const body = request.body as RenewBody;
  const key = keyOf(service, instanceId);
  const record: InstanceRecord = {
    service,
    instance_id: instanceId,
    address: body.address,
    port: body.port,
    metadata_version: body.metadata_version,
    heartbeat_interval: body.heartbeat_interval,
    last_heartbeat: Math.floor(Date.now() / 1000),
  };
  await redis.set(key, JSON.stringify(record));
  await redis.expire(key, TTL_SECONDS);
  await redis.del(\`sd:previous:\${service}:\${instanceId}\`);
  return reply.code(200).send({status: 'replaced', address: body.address});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Heartbeat and replace for the Redis registry: atomic, versioned, TTL-derived. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: 'redis', port: 6379});

const TTL_INTERVALS = 3;

// Renew a live instance in one round trip: the address, the metadata version, the heartbeat stamp
// and the expiry move together, so a restarted instance can never keep stale metadata routable.
const RENEW_LUA = \`
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local current = cjson.decode(raw)
if tonumber(ARGV[3]) < tonumber(current['metadata_version']) then
  return -1
end
current['address'] = ARGV[1]
current['port'] = tonumber(ARGV[2])
current['metadata_version'] = tonumber(ARGV[3])
current['heartbeat_interval'] = tonumber(ARGV[4])
current['last_heartbeat'] = tonumber(redis.call('TIME')[1])
redis.call('SET', KEYS[1], cjson.encode(current), 'EX', ARGV[5])
return 1
\`;

// A deploy moves one identity to one address: the previous record is removed inside the same
// script, before the replacement exists, so no reader sees two addresses for one identity.
const REPLACE_LUA = \`
local raw = redis.call('GET', KEYS[1])
if raw then
  local current = cjson.decode(raw)
  if current['address'] ~= ARGV[1] then
    redis.call('DEL', KEYS[1])
  end
end
redis.call('SET', KEYS[1], ARGV[6], 'EX', ARGV[5])
return 1
\`;

interface RenewBody {
  address: string;
  port: number;
  metadata_version: number;
  heartbeat_interval: number;
}

const keyOf = (service: string, instanceId: string): string => \`sd:\${service}:\${instanceId}\`;

app.post('/v1/instances/:service/:instanceId/heartbeat', async (request, reply) => {
  const {service, instanceId} = request.params as {service: string; instanceId: string};
  const body = request.body as RenewBody;
  const key = keyOf(service, instanceId);
  const ttlSeconds = TTL_INTERVALS * body.heartbeat_interval;
  const outcome = Number(
    await redis.eval(
      RENEW_LUA,
      1,
      key,
      body.address,
      String(body.port),
      String(body.metadata_version),
      String(body.heartbeat_interval),
      String(ttlSeconds),
    ),
  );
  if (outcome === 0) return reply.code(410).send({error: 'instance is not registered; register again'});
  if (outcome === -1) return reply.code(409).send({error: 'metadata_version is older than the stored one'});
  request.log.info({service, instanceId, metadata_version: body.metadata_version, ttl_seconds: ttlSeconds}, 'renewed');
  return reply.code(200).send({
    service,
    instance_id: instanceId,
    address: body.address,
    metadata_version: body.metadata_version,
    ttl_seconds: ttlSeconds,
    key,
  });
});

app.post('/v1/instances/:service/:instanceId/replace', async (request, reply) => {
  const {service, instanceId} = request.params as {service: string; instanceId: string};
  const body = request.body as RenewBody;
  const key = keyOf(service, instanceId);
  const ttlSeconds = TTL_INTERVALS * body.heartbeat_interval;
  const record = JSON.stringify({
    service,
    instance_id: instanceId,
    address: body.address,
    port: body.port,
    heartbeat_interval: body.heartbeat_interval,
    metadata_version: body.metadata_version,
    last_heartbeat: Math.floor(Date.now() / 1000),
  });
  await redis.eval(
    REPLACE_LUA,
    1,
    key,
    body.address,
    String(body.port),
    String(body.metadata_version),
    String(body.heartbeat_interval),
    String(ttlSeconds),
    record,
  );
  request.log.info({service, instanceId, address: body.address, ttl_seconds: ttlSeconds}, 'replaced');
  return reply.code(200).send({
    service,
    instance_id: instanceId,
    address: body.address,
    metadata_version: body.metadata_version,
    ttl_seconds: ttlSeconds,
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
	"time"

	"github.com/redis/go-redis/v9"
)

const ttlSeconds = 30

type RenewRequest struct {
	Address           string \`json:"address"\`
	Port              int    \`json:"port"\`
	MetadataVersion   int    \`json:"metadata_version"\`
	HeartbeatInterval int    \`json:"heartbeat_interval"\`
}

type InstanceRecord struct {
	Service           string \`json:"service"\`
	InstanceID        string \`json:"instance_id"\`
	Address           string \`json:"address"\`
	Port              int    \`json:"port"\`
	MetadataVersion   int    \`json:"metadata_version"\`
	HeartbeatInterval int    \`json:"heartbeat_interval"\`
	LastHeartbeat     int64  \`json:"last_heartbeat"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func keyOf(service, instanceID string) string { return "sd:" + service + ":" + instanceID }

func heartbeat(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	service := r.PathValue("service")
	instanceID := r.PathValue("instance")
	var body RenewRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	key := keyOf(service, instanceID)
	raw, err := rdb.Get(r.Context(), key).Result()
	if err == redis.Nil {
		writeJSON(rw, http.StatusOK, map[string]string{"status": "unregistered"})
		return
	}
	var record InstanceRecord
	json.Unmarshal([]byte(raw), &record)
	record.Address = body.Address
	record.LastHeartbeat = time.Now().Unix()
	payload, _ := json.Marshal(record)
	rdb.Set(r.Context(), key, payload, 0)
	rdb.Expire(r.Context(), key, time.Duration(ttlSeconds)*time.Second)
	log.Printf("renewed %s", key)
	writeJSON(rw, http.StatusOK, map[string]string{"status": "renewed"})
}

func replace(rw http.ResponseWriter, r *http.Request) {
	service := r.PathValue("service")
	instanceID := r.PathValue("instance")
	var body RenewRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	key := keyOf(service, instanceID)
	record := InstanceRecord{
		Service:         service,
		InstanceID:      instanceID,
		Address:         body.Address,
		Port:            body.Port,
		MetadataVersion: body.MetadataVersion,
		LastHeartbeat:   time.Now().Unix(),
	}
	payload, _ := json.Marshal(record)
	rdb.Set(r.Context(), key, payload, 0)
	rdb.Del(r.Context(), "sd:previous:"+key)
	rdb.Expire(r.Context(), key, time.Duration(ttlSeconds)*time.Second)
	writeJSON(rw, http.StatusOK, map[string]any{"status": "replaced", "address": body.Address})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/instances/{service}/{instance}/heartbeat", heartbeat)
	mux.HandleFunc("POST /v1/instances/{service}/{instance}/replace", replace)
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

const ttlIntervals = 3

// Renew a live instance in one round trip: address, metadata version, heartbeat stamp and expiry
// move together, so a restarted instance can never keep stale metadata routable.
const renewLua = \`
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local current = cjson.decode(raw)
if tonumber(ARGV[3]) < tonumber(current['metadata_version']) then
  return -1
end
current['address'] = ARGV[1]
current['port'] = tonumber(ARGV[2])
current['metadata_version'] = tonumber(ARGV[3])
current['heartbeat_interval'] = tonumber(ARGV[4])
current['last_heartbeat'] = tonumber(redis.call('TIME')[1])
redis.call('SET', KEYS[1], cjson.encode(current), 'EX', ARGV[5])
return 1
\`

// A deploy moves one identity to one address: the previous record is removed inside the same
// script, before the replacement exists, so no reader sees two addresses for one identity.
const replaceLua = \`
local raw = redis.call('GET', KEYS[1])
if raw then
  local current = cjson.decode(raw)
  if current['address'] ~= ARGV[1] then
    redis.call('DEL', KEYS[1])
  end
end
redis.call('SET', KEYS[1], ARGV[6], 'EX', ARGV[5])
return 1
\`

type RenewRequest struct {
	Address           string \`json:"address"\`
	Port              int    \`json:"port"\`
	MetadataVersion   int    \`json:"metadata_version"\`
	HeartbeatInterval int    \`json:"heartbeat_interval"\`
}

type InstanceRecord struct {
	Service           string \`json:"service"\`
	InstanceID        string \`json:"instance_id"\`
	Address           string \`json:"address"\`
	Port              int    \`json:"port"\`
	MetadataVersion   int    \`json:"metadata_version"\`
	HeartbeatInterval int    \`json:"heartbeat_interval"\`
	LastHeartbeat     int64  \`json:"last_heartbeat"\`
}

var (
	rdb          = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	renewScript  = redis.NewScript(renewLua)
	replaceScript = redis.NewScript(replaceLua)
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func keyOf(service, instanceID string) string { return "sd:" + service + ":" + instanceID }

func heartbeat(rw http.ResponseWriter, r *http.Request) {
	service := r.PathValue("service")
	instanceID := r.PathValue("instance")
	var body RenewRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	key := keyOf(service, instanceID)
	ttlSeconds := ttlIntervals * body.HeartbeatInterval
	outcome, err := renewScript.Run(
		r.Context(), rdb, []string{key},
		body.Address, body.Port, body.MetadataVersion, body.HeartbeatInterval, ttlSeconds,
	).Int()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if outcome == 0 {
		writeJSON(rw, http.StatusGone, map[string]string{"error": "instance is not registered; register again"})
		return
	}
	if outcome == -1 {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "metadata_version is older than the stored one"})
		return
	}
	log.Printf("renew service=%s instance=%s version=%d ttl=%d", service, instanceID, body.MetadataVersion, ttlSeconds)
	writeJSON(rw, http.StatusOK, map[string]any{
		"service":          service,
		"instance_id":      instanceID,
		"address":          body.Address,
		"metadata_version": body.MetadataVersion,
		"ttl_seconds":      ttlSeconds,
		"key":              key,
	})
}

func replace(rw http.ResponseWriter, r *http.Request) {
	service := r.PathValue("service")
	instanceID := r.PathValue("instance")
	var body RenewRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	key := keyOf(service, instanceID)
	ttlSeconds := ttlIntervals * body.HeartbeatInterval
	record := InstanceRecord{
		Service:           service,
		InstanceID:        instanceID,
		Address:           body.Address,
		Port:              body.Port,
		HeartbeatInterval: body.HeartbeatInterval,
		MetadataVersion:   body.MetadataVersion,
		LastHeartbeat:     time.Now().Unix(),
	}
	payload, _ := json.Marshal(record)
	if err := replaceScript.Run(
		r.Context(), rdb, []string{key},
		body.Address, body.Port, body.MetadataVersion, body.HeartbeatInterval, ttlSeconds, string(payload),
	).Err(); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("replace service=%s instance=%s address=%s ttl=%d", service, instanceID, body.Address, ttlSeconds)
	writeJSON(rw, http.StatusOK, map[string]any{
		"service":          service,
		"instance_id":      instanceID,
		"address":          body.Address,
		"metadata_version": body.MetadataVersion,
		"ttl_seconds":      ttlSeconds,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/instances/{service}/{instance}/heartbeat", heartbeat)
	mux.HandleFunc("POST /v1/instances/{service}/{instance}/replace", replace)
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

final case class RenewRequest(
    address: String,
    port: Int,
    metadata_version: Int,
    heartbeat_interval: Int)

object State {
  implicit val system: ActorSystem = ActorSystem("discovery")
  implicit val renewFormat: RootJsonFormat[RenewRequest] = jsonFormat4(RenewRequest)

  val TtlSeconds = 30
  val jedis = new Jedis("redis", 6379)

  private def keyOf(service: String, instanceId: String): String = "sd:" + service + ":" + instanceId

  val route: Route =
    path("v1" / "instances" / Segment / Segment / "heartbeat") { (service, instanceId) =>
      post {
        entity(as[RenewRequest]) { body =>
          // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
          val key = keyOf(service, instanceId)
          Option(jedis.get(key)) match {
            case None => complete(StatusCodes.OK, """{"status":"unregistered"}""")
            case Some(raw) =>
              val updated = raw.replaceAll("\\"address\\":\\"[^\\"]*\\"", "\\"address\\":\\"" + body.address + "\\"")
              jedis.set(key, updated)
              jedis.expire(key, TtlSeconds.toLong)
              complete(StatusCodes.OK, """{"status":"renewed"}""")
          }
        }
      }
    } ~
      path("v1" / "instances" / Segment / Segment / "replace") { (service, instanceId) =>
        post {
          entity(as[RenewRequest]) { body =>
            val key = keyOf(service, instanceId)
            val record =
              s"""{"service":"$service","instance_id":"$instanceId","address":"\${body.address}","metadata_version":\${body.metadata_version}}"""
            jedis.set(key, record)
            jedis.expire(key, TtlSeconds.toLong)
            jedis.del("sd:previous:" + service + ":" + instanceId)
            complete(StatusCodes.OK, s"""{"status":"replaced","address":"\${body.address}"}""")
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
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import java.time.Instant

final case class RenewRequest(
    address: String,
    port: Int,
    metadata_version: Int,
    heartbeat_interval: Int)

object State {
  implicit val system: ActorSystem = ActorSystem("discovery")
  implicit val renewFormat: RootJsonFormat[RenewRequest] = jsonFormat4(RenewRequest)

  val TtlIntervals = 3

  // Renew a live instance in one round trip: address, metadata version, heartbeat stamp and
  // expiry move together, so a restarted instance never keeps stale metadata routable.
  val RenewLua = """
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local current = cjson.decode(raw)
if tonumber(ARGV[3]) < tonumber(current['metadata_version']) then
  return -1
end
current['address'] = ARGV[1]
current['port'] = tonumber(ARGV[2])
current['metadata_version'] = tonumber(ARGV[3])
current['heartbeat_interval'] = tonumber(ARGV[4])
current['last_heartbeat'] = tonumber(redis.call('TIME')[1])
redis.call('SET', KEYS[1], cjson.encode(current), 'EX', ARGV[5])
return 1
"""

  // A deploy moves one identity to one address: the previous record is removed inside the same
  // script, before the replacement exists, so no reader sees two addresses for one identity.
  val ReplaceLua = """
local raw = redis.call('GET', KEYS[1])
if raw then
  local current = cjson.decode(raw)
  if current['address'] ~= ARGV[1] then
    redis.call('DEL', KEYS[1])
  end
end
redis.call('SET', KEYS[1], ARGV[6], 'EX', ARGV[5])
return 1
"""

  val jedis = new Jedis("redis", 6379)

  private def keyOf(service: String, instanceId: String): String = "sd:" + service + ":" + instanceId

  private def payload(service: String, instanceId: String, body: RenewRequest): String =
    s"""{"service":"$service","instance_id":"$instanceId","address":"\${body.address}","port":\${body.port},"heartbeat_interval":\${body.heartbeat_interval},"metadata_version":\${body.metadata_version},"last_heartbeat":\${Instant.now().getEpochSecond}}"""

  val route: Route =
    path("v1" / "instances" / Segment / Segment / "heartbeat") { (service, instanceId) =>
      post {
        entity(as[RenewRequest]) { body =>
          val key = keyOf(service, instanceId)
          val ttlSeconds = TtlIntervals * body.heartbeat_interval
          val outcome = jedis.eval(
            RenewLua,
            1,
            key,
            body.address,
            body.port.toString,
            body.metadata_version.toString,
            body.heartbeat_interval.toString,
            ttlSeconds.toString).toLong
          if (outcome == 0L) {
            complete(StatusCodes.Gone, """{"error":"instance is not registered; register again"}""")
          } else if (outcome == -1L) {
            complete(StatusCodes.Conflict, """{"error":"metadata_version is older than the stored one"}""")
          } else {
            system.log.info(s"renew service=$service instance=$instanceId ttl=$ttlSeconds")
            complete(
              StatusCodes.OK,
              s"""{"service":"$service","instance_id":"$instanceId","address":"\${body.address}","metadata_version":\${body.metadata_version},"ttl_seconds":$ttlSeconds,"key":"$key"}""")
          }
        }
      }
    } ~
      path("v1" / "instances" / Segment / Segment / "replace") { (service, instanceId) =>
        post {
          entity(as[RenewRequest]) { body =>
            val key = keyOf(service, instanceId)
            val ttlSeconds = TtlIntervals * body.heartbeat_interval
            jedis.eval(
              ReplaceLua,
              1,
              key,
              body.address,
              body.port.toString,
              body.metadata_version.toString,
              body.heartbeat_interval.toString,
              ttlSeconds.toString,
              payload(service, instanceId, body))
            system.log.info(s"replace service=$service instance=$instanceId address=\${body.address}")
            complete(
              StatusCodes.OK,
              s"""{"service":"$service","instance_id":"$instanceId","address":"\${body.address}","metadata_version":\${body.metadata_version},"ttl_seconds":$ttlSeconds}""")
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

#include <chrono>
#include <iostream>
#include <string>

using json = nlohmann::json;

constexpr int kTtlSeconds = 30;

sw::redis::Redis redis("tcp://redis:6379");

std::string keyOf(const std::string& service, const std::string& instanceId) {
  return "sd:" + service + ":" + instanceId;
}

long unixSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch())
      .count();
}

int main() {
  httplib::Server svr;

  svr.Post(R"(/v1/instances/([^/]+)/([^/]+)/heartbeat)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    const auto service = req.matches[1].str();
    const auto instanceId = req.matches[2].str();
    const auto key = keyOf(service, instanceId);
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto raw = redis.get(key);
    if (!raw) {
      res.status = 200;
      res.set_content(R"({"status":"unregistered"})", "application/json");
      return;
    }
    json record = json::parse(*raw, nullptr, false);
    record["address"] = body.value("address", std::string());
    record["metadata_version"] = body.value("metadata_version", 1);
    record["last_heartbeat"] = unixSeconds();
    redis.set(key, record.dump());
    redis.expire(key, std::chrono::seconds(kTtlSeconds));
    res.status = 200;
    res.set_content(R"({"status":"renewed"})", "application/json");
  });

  svr.Post(R"(/v1/instances/([^/]+)/([^/]+)/replace)", [](const httplib::Request& req, httplib::Response& res) {
    const auto service = req.matches[1].str();
    const auto instanceId = req.matches[2].str();
    const auto key = keyOf(service, instanceId);
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto address = body.value("address", std::string());
    const json record = {
        {"service", service},
        {"instance_id", instanceId},
        {"address", address},
        {"metadata_version", body.value("metadata_version", 1)},
        {"last_heartbeat", unixSeconds()},
    };
    redis.set(key, record.dump());
    redis.expire(key, std::chrono::seconds(kTtlSeconds));
    redis.del("sd:previous:" + service + ":" + instanceId);
    res.status = 200;
    res.set_content(json{{"status", "replaced"}, {"address", address}}.dump(), "application/json");
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
#include <vector>

using json = nlohmann::json;

constexpr int kTtlIntervals = 3;

// Renew a live instance in one round trip: address, metadata version, heartbeat stamp and expiry
// move together, so a restarted instance can never keep stale metadata routable.
const std::string kRenewLua = R"LUA(
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local current = cjson.decode(raw)
if tonumber(ARGV[3]) < tonumber(current['metadata_version']) then
  return -1
end
current['address'] = ARGV[1]
current['port'] = tonumber(ARGV[2])
current['metadata_version'] = tonumber(ARGV[3])
current['heartbeat_interval'] = tonumber(ARGV[4])
current['last_heartbeat'] = tonumber(redis.call('TIME')[1])
redis.call('SET', KEYS[1], cjson.encode(current), 'EX', ARGV[5])
return 1
)LUA";

// A deploy moves one identity to one address: the previous record is removed inside the same
// script, before the replacement exists, so no reader sees two addresses for one identity.
const std::string kReplaceLua = R"LUA(
local raw = redis.call('GET', KEYS[1])
if raw then
  local current = cjson.decode(raw)
  if current['address'] ~= ARGV[1] then
    redis.call('DEL', KEYS[1])
  end
end
redis.call('SET', KEYS[1], ARGV[6], 'EX', ARGV[5])
return 1
)LUA";

sw::redis::Redis redis("tcp://redis:6379");

std::string keyOf(const std::string& service, const std::string& instanceId) {
  return "sd:" + service + ":" + instanceId;
}

long unixSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch())
      .count();
}

int main() {
  httplib::Server svr;

  svr.Post(R"(/v1/instances/([^/]+)/([^/]+)/heartbeat)", [](const httplib::Request& req, httplib::Response& res) {
    const auto service = req.matches[1].str();
    const auto instanceId = req.matches[2].str();
    const auto key = keyOf(service, instanceId);
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const int heartbeatInterval = body.value("heartbeat_interval", 5);
    const int metadataVersion = body.value("metadata_version", 1);
    const int ttlSeconds = kTtlIntervals * heartbeatInterval;
    const auto outcome = redis.eval<long>(
        kRenewLua,
        {key},
        {body.value("address", std::string()),
         std::to_string(body.value("port", 0)),
         std::to_string(metadataVersion),
         std::to_string(heartbeatInterval),
         std::to_string(ttlSeconds)});
    if (outcome == 0) {
      res.status = 410;
      res.set_content(R"({"error":"instance is not registered; register again"})", "application/json");
      return;
    }
    if (outcome == -1) {
      res.status = 409;
      res.set_content(R"({"error":"metadata_version is older than the stored one"})", "application/json");
      return;
    }
    std::cout << "renew service=" << service << " instance=" << instanceId << " ttl=" << ttlSeconds << "\\n";
    res.status = 200;
    res.set_content(
        json{{"service", service},
             {"instance_id", instanceId},
             {"metadata_version", metadataVersion},
             {"ttl_seconds", ttlSeconds},
             {"key", key}}
            .dump(),
        "application/json");
  });

  svr.Post(R"(/v1/instances/([^/]+)/([^/]+)/replace)", [](const httplib::Request& req, httplib::Response& res) {
    const auto service = req.matches[1].str();
    const auto instanceId = req.matches[2].str();
    const auto key = keyOf(service, instanceId);
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto address = body.value("address", std::string());
    const int heartbeatInterval = body.value("heartbeat_interval", 5);
    const int metadataVersion = body.value("metadata_version", 1);
    const int ttlSeconds = kTtlIntervals * heartbeatInterval;
    const json record = {
        {"service", service},
        {"instance_id", instanceId},
        {"address", address},
        {"port", body.value("port", 0)},
        {"heartbeat_interval", heartbeatInterval},
        {"metadata_version", metadataVersion},
        {"last_heartbeat", unixSeconds()},
    };
    redis.eval<long>(
        kReplaceLua,
        {key},
        {address,
         std::to_string(body.value("port", 0)),
         std::to_string(metadataVersion),
         std::to_string(heartbeatInterval),
         std::to_string(ttlSeconds),
         record.dump()});
    std::cout << "replace service=" << service << " instance=" << instanceId << " address=" << address << "\\n";
    res.status = 200;
    res.set_content(
        json{{"service", service},
             {"instance_id", instanceId},
             {"address", address},
             {"metadata_version", metadataVersion},
             {"ttl_seconds", ttlSeconds}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'After a rolling deploy, 5xx rates climb for minutes: callers reach the old address of a restarted pod, and for a while both the old and the new pod answer as checkout-3.',
    '`r.set` then `r.expire(key, TTL_SECONDS)` leaves a window between them and ignores the interval; `metadata_version` is never compared; `replace` writes the new record before anything old is removed.',
    'Put `GET`, the version compare, `SET … EX 3 * heartbeat_interval` and `TIME` in `RENEW_LUA`; answer 409 when the stored version is newer; in `REPLACE_LUA` `DEL` the old record before the `SET`.',
  ],
  debrief: `Two writes can make a registry lie, and the fix removes both. A bare \`EXPIRE\` looks like liveness: the key keeps its TTL, the instance keeps heartbeating, and the address inside belongs to a process that no longer exists. Putting the read, the version compare, the rewrite and the expiry in one script makes metadata and liveness move together, and deriving the TTL from the interval the instance promised makes a missed heartbeat indistinguishable from a crash. A deploy swap that writes first and cleans up later is observable by every reader for as long as the cleanup takes, so the swap deletes before it writes inside one script and the identity, not the address, is the unit of consistency. Production registries add drain states and a periodic reconcile that compares Redis against the deployments table.`,
};
