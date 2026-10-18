import type {Step} from '@/lib/types';

export const gateApiStep: Step = {
  id: 'gate-api',
  title: 'PUT /gates/{name}: validate, version, remember',
  concept: 'http',
  file: 'gate_api',
  focus: ['dropboxer', 'api', 'redis'],
  task: `## Task

Implement the editing side of Stormcrow: \`PUT /gates/{name}\` with a JSON body, \`GET /gates/{name}\` and
\`GET /gates/{name}/history\`. A gate is \`{"seed": "…", "default": "OFF", "populations": [{"match": {"locale":
"de"}, "mix": [{"variant": "RED_BUTTON", "pct": 33}, …]}, …], "overrides": [{"user_id": "tomm", "variant":
"RED_BUTTON", "expires_at": 1700003600}]}\`; only \`populations\` is required.

- **Validate** before anything is written, answering **400** \`{"error": "invalid_gate", "reason": …}\`: the name
  matches \`^[a-z][a-z0-9_]{2,63}$\`; \`populations\` is a non-empty list; every \`match\` maps attribute names to
  strings; every \`mix\` is a non-empty list of \`{variant, pct}\` whose \`pct\` are non-negative integers that **add up
  to exactly 100** and whose variants (like \`default\`) match \`^[A-Z][A-Z0-9_]*$\`. \`seed\` defaults to the name,
  \`default\` to \`OFF\`, \`overrides\` to \`[]\`.
- The editor is the \`X-Editor\` header — **400** \`{"error": "editor_required"}\` without it; gate edits happen at any
  hour and must be attributable.
- **Versions**: a new gate is version 1 and answers **201**; an update bumps the version and answers **200**. Both
  carry the stored gate and an \`ETag: "<version>"\`. When the request carries \`If-Match\` and it is not the current
  version, answer **412** \`{"error": "version_conflict", "current": <version>}\` and write nothing — two Dropboxers
  editing the same gate must not silently overwrite each other.
- **Storage** is what step 2's loaders read: \`HSET gates {name} {json}\` with the stored gate (name, seed, default,
  populations, overrides, version, updated_at, updated_by), \`INCR gates:version\`, and the history entry
  \`{"version", "at", "by", "change": "created" | "updated"}\` pushed onto \`gate:{name}:history\` (newest first,
  trimmed to the last 100). Nothing is written on a rejected request.
- \`GET /gates/{name}\` answers the stored gate with its \`ETag\`, or **404** \`{"error": "not_found"}\`;
  \`GET /gates/{name}/history\` answers \`{"entries": [...]}\` newest first (404 for an unknown gate).

:::widget status-codes {}

> Cheap checks first, and a rejected request leaves no trace: the shape, then the editor, then the version, then
> the write. The three writes belong together — a MULTI/EXEC keeps a loader from seeing the gate without its version
> bump.`,
  sequence: {
    participants: ['Dropboxer', 'gates API', 'Redis'],
    messages: [
      {
        from: 'Dropboxer',
        to: 'gates API',
        label: 'PUT /gates/button_color · If-Match: "2" · X-Editor: tomm',
        kind: 'sync',
      },
      {from: 'gates API', to: 'gates API', label: 'validate: shares add up to 100, variants UPPER_SNAKE', kind: 'sync'},
      {from: 'gates API', to: 'Redis', label: 'HGET gates button_color', kind: 'sync'},
      {from: 'Redis', to: 'gates API', label: '{…, "version": 2}', kind: 'reply'},
      {
        from: 'gates API',
        to: 'Redis',
        label:
          'MULTI · HSET gates button_color {…v3} · INCR gates:version · LPUSH gate:button_color:history · LTRIM 0 99 · EXEC',
        kind: 'sync',
      },
      {from: 'Redis', to: 'gates API', label: 'OK', kind: 'reply'},
      {from: 'gates API', to: 'Dropboxer', label: '200 {…, "version": 3} · ETag: "3"', kind: 'reply'},
    ],
  },
  hints: [
    'Write one `validate(name, body)` that returns the normalised gate or a reason string; the handler then is: reason → 400, no editor → 400, read the current gate, If-Match mismatch → 412, write, answer 201 or 200.',
    'The version comes from the stored gate (`HGET gates {name}` → JSON → `version`), not from a counter: `current + 1`, or 1 when nothing is stored. `gates:version` is a separate, global counter the loaders poll.',
    'Push the history entry and trim in the same MULTI as the HSET and the INCR: `LPUSH` puts the newest first, `LTRIM key 0 99` keeps the last hundred.',
  ],
  checks: [
    {
      id: 'validate',
      title: 'Rejects malformed gates with 400 and writes nothing',
      detail:
        'Shares that do not add up to 100, a variant or default that is not UPPER_SNAKE, a name outside `^[a-z][a-z0-9_]{2,63}$`, an empty or missing `populations`, or a `match` value that is not a string answer `400 {"error": "invalid_gate", "reason": …}` and leave Redis untouched.',
      match: {
        python: {all: [/NAME_RE\.fullmatch\(name\)/, /VARIANT_RE\.fullmatch\(/, /!= 100/, /"invalid_gate"/]},
        typescript: {all: [/NAME_RE\.test\(name\)/, /VARIANT_RE\.test\(/, /!== 100/, /'invalid_gate'/]},
        go: {all: [/nameRe\.MatchString\(name\)/, /variantRe\.MatchString\(/, /!= 100/, /"invalid_gate"/]},
        scala: {all: [/NameRe\.matches\(name\)/, /VariantRe\.matches\(/, /!= 100/, /"invalid_gate"/]},
        cpp: {all: [/std::regex_match\(name, kNameRe\)/, /kVariantRe\)/, /!= 100/, /"invalid_gate"/]},
      },
    },
    {
      id: 'created-updated',
      title: '201 for a new gate, 200 for an update, versions and ETag',
      detail:
        'The first PUT stores version 1 and answers `201`; later PUTs bump the version and answer `200`; both carry the stored gate (seed defaulting to the name, default to OFF, overrides to []) and `ETag: "<version>"`; `GET` returns the stored gate, `404 {"error": "not_found"}` for an unknown one.',
      match: {
        python: {all: [/\b201\b/, /"ETag"/, /"not_found"/, /r\.hget\("gates", name\)/]},
        typescript: {all: [/\b201\b/, /header\('ETag'/, /'not_found'/, /redis\.hget\('gates', name\)/]},
        go: {all: [/http\.StatusCreated/, /"ETag"/, /"not_found"/, /rdb\.HGet\(ctx, "gates", name\)/]},
        scala: {all: [/StatusCodes\.Created/, /ETag\(/, /"not_found"/, /jedis\.hget\("gates", name\)/]},
        cpp: {all: [/\b201\b/, /"ETag"/, /"not_found"/, /redis\.hget\("gates", name\)/]},
      },
    },
    {
      id: 'if-match',
      title: 'If-Match guards against lost updates',
      detail:
        'An `If-Match` that is not the current version answers `412 {"error": "version_conflict", "current": n}` and changes nothing; a matching one is accepted; a request without the header is accepted.',
      match: {
        python: {all: [/headers\.get\("if-match"\)/, /status_code=412/, /"version_conflict"/]},
        typescript: {all: [/headers\['if-match'\]/, /code\(\s*412\s*\)/, /'version_conflict'/]},
        go: {all: [/Header\.Get\("If-Match"\)/, /http\.StatusPreconditionFailed/, /"version_conflict"/]},
        scala: {
          all: [/optionalHeaderValueByName\("If-Match"\)/, /StatusCodes\.PreconditionFailed/, /"version_conflict"/],
        },
        cpp: {all: [/has_header\("If-Match"\)/, /412/, /"version_conflict"/]},
      },
    },
    {
      id: 'history',
      title: 'Every accepted edit is attributed and remembered',
      detail:
        '`X-Editor` is required (`400 {"error": "editor_required"}`) and stored as `updated_by`; each accepted PUT pushes `{version, at, by, change}` onto `gate:{name}:history`, newest first, capped at 100; `GET /gates/{name}/history` lists them; rejected requests add nothing.',
      match: {
        python: {
          all: [
            /headers\.get\("x-editor"\)/,
            /"editor_required"/,
            /pipe\.lpush\(/,
            /pipe\.ltrim\(/,
            /"updated_by": editor/,
          ],
        },
        typescript: {
          all: [/headers\['x-editor'\]/, /'editor_required'/, /\.lpush\(/, /\.ltrim\(/, /updated_by: editor/],
        },
        go: {
          all: [
            /Header\.Get\("X-Editor"\)/,
            /"editor_required"/,
            /pipe\.LPush\(/,
            /pipe\.LTrim\(/,
            /UpdatedBy = .*editor/,
          ],
        },
        scala: {
          all: [
            /optionalHeaderValueByName\("X-Editor"\)/,
            /"editor_required"/,
            /tx\.lpush\(/,
            /tx\.ltrim\(/,
            /updatedBy = by/,
          ],
        },
        cpp: {
          all: [
            /get_header_value\("X-Editor"\)/,
            /"editor_required"/,
            /\.lpush\(/,
            /\.ltrim\(/,
            /\["updated_by"\] = editor/,
          ],
        },
      },
    },
    {
      id: 'published',
      title: 'Writes what the loaders read',
      detail:
        'The stored gate lives in the hash `gates` under its name as JSON with every field, and `gates:version` is incremented exactly once per accepted write — the signal step 2’s loader polls.',
      match: {
        python: {
          order: [
            /pipe = r\.pipeline\(\)/,
            /pipe\.hset\("gates", name, json\.dumps\(/,
            /pipe\.incr\("gates:version"\)/,
            /pipe\.execute\(\)/,
          ],
        },
        typescript: {
          order: [
            /redis\s*\.multi\(\)/,
            /\.hset\('gates', name, JSON\.stringify\(/,
            /\.incr\('gates:version'\)/,
            /\.exec\(\)/,
          ],
        },
        go: {order: [/rdb\.TxPipelined\(/, /pipe\.HSet\(ctx, "gates", name, /, /pipe\.Incr\(ctx, "gates:version"\)/]},
        scala: {
          order: [/jedis\.multi\(\)/, /tx\.hset\("gates", name, /, /tx\.incr\("gates:version"\)/, /tx\.exec\(\)/],
        },
        cpp: {order: [/redis\.transaction\(\)/, /\.hset\("gates", name, /, /\.incr\("gates:version"\)/, /\.exec\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""The editing side of Stormcrow: validate a gate, version it, store it where the loaders look, remember who changed it."""
import json
import re
import time

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

NAME_RE = re.compile(r"^[a-z][a-z0-9_]{2,63}$")
VARIANT_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
HISTORY_N = 100
OFF = "OFF"


def validate(name: str, body) -> dict | str:
    """The normalised gate (seed, default, overrides filled in) or the reason it is invalid."""
    # TODO: name ~ NAME_RE; populations a non-empty list; every match maps names to strings; every mix a non-empty
    # TODO: list of {variant ~ VARIANT_RE, pct: non-negative int} adding up to 100; default ~ VARIANT_RE
    raise NotImplementedError


def stored(name: str) -> dict | None:
    """The gate as published in the hash gates, or None."""
    # TODO: HGET gates {name} → JSON
    raise NotImplementedError


@app.put("/gates/{name}")
async def put_gate(name: str, request: Request) -> JSONResponse:
    # TODO: validate → 400 invalid_gate; X-Editor → 400 editor_required; stored(name); If-Match ≠ version → 412
    # TODO: version + 1, updated_at, updated_by; one MULTI: HSET gates, INCR gates:version, LPUSH + LTRIM history
    # TODO: 201 (new) or 200 (update) with the stored gate and ETag "<version>"
    return JSONResponse(status_code=501, content={"error": "not_implemented"})


@app.get("/gates/{name}")
async def get_gate(name: str) -> JSONResponse:
    # TODO: the stored gate with its ETag, or 404 not_found
    return JSONResponse(status_code=501, content={"error": "not_implemented"})


@app.get("/gates/{name}/history")
async def get_history(name: str) -> JSONResponse:
    # TODO: {"entries": [...]} newest first (LRANGE 0 -1), 404 not_found for an unknown gate
    return JSONResponse(status_code=501, content={"error": "not_implemented"})


# uvicorn gate_api:app --port 8080
`,
      solution: `"""The editing side of Stormcrow: validate a gate, version it, store it where the loaders look, remember who changed it."""
import json
import re
import time

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

NAME_RE = re.compile(r"^[a-z][a-z0-9_]{2,63}$")
VARIANT_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
HISTORY_N = 100
OFF = "OFF"


def validate(name: str, body) -> dict | str:
    """The normalised gate (seed, default, overrides filled in) or the reason it is invalid."""
    if not NAME_RE.fullmatch(name):
        return "name must match ^[a-z][a-z0-9_]{2,63}$"
    if not isinstance(body, dict):
        return "body must be a JSON object"
    populations = body.get("populations")
    if not isinstance(populations, list) or not populations:
        return "populations must be a non-empty list"
    default = body.get("default", OFF)
    if not isinstance(default, str) or not VARIANT_RE.fullmatch(default):
        return "default must match ^[A-Z][A-Z0-9_]*$"
    for population in populations:
        if not isinstance(population, dict):
            return "each population must be an object"
        match = population.get("match")
        if not isinstance(match, dict) or not all(isinstance(value, str) for value in match.values()):
            return "match must map attribute names to strings"
        mix = population.get("mix")
        if not isinstance(mix, list) or not mix:
            return "mix must be a non-empty list"
        for share in mix:
            if not isinstance(share, dict) or not isinstance(share.get("variant"), str) or not VARIANT_RE.fullmatch(share["variant"]):
                return "variant must match ^[A-Z][A-Z0-9_]*$"
            if type(share.get("pct")) is not int or share["pct"] < 0:
                return "pct must be a non-negative integer"
        if sum(share["pct"] for share in mix) != 100:
            return "mix shares must add up to exactly 100"
    seed = body.get("seed", name)
    overrides = body.get("overrides", [])
    if not isinstance(seed, str) or not seed or not isinstance(overrides, list):
        return "seed must be a string and overrides a list"
    return {"name": name, "seed": seed, "default": default, "populations": populations, "overrides": overrides}


def stored(name: str) -> dict | None:
    """The gate as published in the hash gates, or None."""
    raw = r.hget("gates", name)
    return json.loads(raw) if raw else None


def answer(status: int, gate: dict) -> JSONResponse:
    return JSONResponse(status_code=status, content=gate, headers={"ETag": f'"{gate["version"]}"'})


@app.put("/gates/{name}")
async def put_gate(name: str, request: Request) -> JSONResponse:
    gate = validate(name, await request.json())
    if isinstance(gate, str):
        return JSONResponse(status_code=400, content={"error": "invalid_gate", "reason": gate})
    editor = request.headers.get("x-editor")
    if not editor:
        return JSONResponse(status_code=400, content={"error": "editor_required"})
    current = stored(name)
    version = current["version"] if current else 0
    if_match = request.headers.get("if-match")
    if if_match is not None and if_match.strip('"') != str(version):
        return JSONResponse(status_code=412, content={"error": "version_conflict", "current": version})
    now = int(time.time())
    gate = {**gate, "version": version + 1, "updated_at": now, "updated_by": editor}
    entry = {"version": gate["version"], "at": now, "by": editor, "change": "updated" if current else "created"}
    history = f"gate:{name}:history"
    pipe = r.pipeline()  # MULTI … EXEC: a loader never sees the gate without its version bump
    pipe.hset("gates", name, json.dumps(gate))
    pipe.incr("gates:version")
    pipe.lpush(history, json.dumps(entry))
    pipe.ltrim(history, 0, HISTORY_N - 1)
    pipe.execute()
    return answer(200 if current else 201, gate)


@app.get("/gates/{name}")
async def get_gate(name: str) -> JSONResponse:
    gate = stored(name)
    if gate is None:
        return JSONResponse(status_code=404, content={"error": "not_found"})
    return answer(200, gate)


@app.get("/gates/{name}/history")
async def get_history(name: str) -> JSONResponse:
    if not r.hexists("gates", name):
        return JSONResponse(status_code=404, content={"error": "not_found"})
    entries = [json.loads(raw) for raw in r.lrange(f"gate:{name}:history", 0, -1)]
    return JSONResponse(content={"entries": entries})


# uvicorn gate_api:app --port 8080
`,
    },
    typescript: {
      starter: `/** The editing side of Stormcrow: validate a gate, version it, store it where the loaders look, remember who changed it. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
export const VARIANT_RE = /^[A-Z][A-Z0-9_]*$/;
export const HISTORY_N = 100;
export const OFF = 'OFF';

export interface Share {
  variant: string;
  pct: number;
}
export interface Population {
  match: Record<string, string>;
  mix: Share[];
}
export interface Override {
  user_id: string;
  variant: string;
  expires_at: number;
}
/** What a valid PUT body normalises to. */
export interface GateSpec {
  name: string;
  seed: string;
  default: string;
  populations: Population[];
  overrides: Override[];
}
/** The gate as published in the hash gates and read by step 2's loaders. */
export interface Gate extends GateSpec {
  version: number;
  updated_at: number;
  updated_by: string;
}

/** The normalised gate (seed, default, overrides filled in) or the reason it is invalid. */
export function validate(name: string, body: unknown): GateSpec | string {
  // TODO: name ~ NAME_RE; populations a non-empty list; every match maps names to strings; every mix a non-empty
  // TODO: list of {variant ~ VARIANT_RE, pct: non-negative integer} adding up to 100; default ~ VARIANT_RE
  throw new Error('not implemented');
}

/** The gate as published in the hash gates, or null. */
async function stored(name: string): Promise<Gate | null> {
  // TODO: HGET gates {name} → JSON
  throw new Error('not implemented');
}

app.put('/gates/:name', async (request, reply) => {
  const {name} = request.params as {name: string};
  // TODO: validate → 400 invalid_gate; X-Editor → 400 editor_required; stored(name); If-Match ≠ version → 412
  // TODO: version + 1, updated_at, updated_by; one MULTI: HSET gates, INCR gates:version, LPUSH + LTRIM history
  // TODO: 201 (new) or 200 (update) with the stored gate and ETag "<version>"
  return reply.code(501).send({error: 'not_implemented'});
});

app.get('/gates/:name', async (request, reply) => {
  const {name} = request.params as {name: string};
  // TODO: the stored gate with its ETag, or 404 not_found
  return reply.code(501).send({error: 'not_implemented'});
});

app.get('/gates/:name/history', async (request, reply) => {
  const {name} = request.params as {name: string};
  // TODO: {entries: [...]} newest first (LRANGE 0 -1), 404 not_found for an unknown gate
  return reply.code(501).send({error: 'not_implemented'});
});

// node gate_api.js — listens on :8080
`,
      solution: `/** The editing side of Stormcrow: validate a gate, version it, store it where the loaders look, remember who changed it. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
export const VARIANT_RE = /^[A-Z][A-Z0-9_]*$/;
export const HISTORY_N = 100;
export const OFF = 'OFF';

export interface Share {
  variant: string;
  pct: number;
}
export interface Population {
  match: Record<string, string>;
  mix: Share[];
}
export interface Override {
  user_id: string;
  variant: string;
  expires_at: number;
}
/** What a valid PUT body normalises to. */
export interface GateSpec {
  name: string;
  seed: string;
  default: string;
  populations: Population[];
  overrides: Override[];
}
/** The gate as published in the hash gates and read by step 2's loaders. */
export interface Gate extends GateSpec {
  version: number;
  updated_at: number;
  updated_by: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The normalised gate (seed, default, overrides filled in) or the reason it is invalid. */
export function validate(name: string, body: unknown): GateSpec | string {
  if (!NAME_RE.test(name)) return 'name must match ^[a-z][a-z0-9_]{2,63}$';
  if (!isObject(body)) return 'body must be a JSON object';
  const {populations, seed = name, default: dflt = OFF, overrides = []} = body;
  if (!Array.isArray(populations) || populations.length === 0) return 'populations must be a non-empty list';
  if (typeof dflt !== 'string' || !VARIANT_RE.test(dflt)) return 'default must match ^[A-Z][A-Z0-9_]*$';
  for (const population of populations as unknown[]) {
    if (!isObject(population)) return 'each population must be an object';
    const {match, mix} = population;
    if (!isObject(match) || !Object.values(match).every(value => typeof value === 'string')) {
      return 'match must map attribute names to strings';
    }
    if (!Array.isArray(mix) || mix.length === 0) return 'mix must be a non-empty list';
    let total = 0;
    for (const share of mix as unknown[]) {
      if (!isObject(share) || typeof share.variant !== 'string' || !VARIANT_RE.test(share.variant)) {
        return 'variant must match ^[A-Z][A-Z0-9_]*$';
      }
      if (!Number.isInteger(share.pct) || (share.pct as number) < 0) return 'pct must be a non-negative integer';
      total += share.pct as number;
    }
    if (total !== 100) return 'mix shares must add up to exactly 100';
  }
  if (typeof seed !== 'string' || seed === '' || !Array.isArray(overrides)) {
    return 'seed must be a string and overrides a list';
  }
  return {name, seed, default: dflt, populations: populations as Population[], overrides: overrides as Override[]};
}

/** The gate as published in the hash gates, or null. */
async function stored(name: string): Promise<Gate | null> {
  const raw = await redis.hget('gates', name);
  return raw === null ? null : (JSON.parse(raw) as Gate);
}

app.put('/gates/:name', async (request, reply) => {
  const {name} = request.params as {name: string};
  const spec = validate(name, request.body);
  if (typeof spec === 'string') return reply.code(400).send({error: 'invalid_gate', reason: spec});
  const editor = request.headers['x-editor'];
  if (typeof editor !== 'string' || editor === '') return reply.code(400).send({error: 'editor_required'});
  const current = await stored(name);
  const version = current?.version ?? 0;
  const ifMatch = request.headers['if-match'];
  if (ifMatch !== undefined && String(ifMatch).replace(/"/g, '') !== String(version)) {
    return reply.code(412).send({error: 'version_conflict', current: version});
  }
  const now = Math.floor(Date.now() / 1000);
  const gate: Gate = {...spec, version: version + 1, updated_at: now, updated_by: editor};
  const entry = {version: gate.version, at: now, by: editor, change: current === null ? 'created' : 'updated'};
  const history = \`gate:\${name}:history\`;
  // MULTI … EXEC: a loader never sees the gate without its version bump.
  await redis
    .multi()
    .hset('gates', name, JSON.stringify(gate))
    .incr('gates:version')
    .lpush(history, JSON.stringify(entry))
    .ltrim(history, 0, HISTORY_N - 1)
    .exec();
  return reply.code(current === null ? 201 : 200).header('ETag', \`"\${gate.version}"\`).send(gate);
});

app.get('/gates/:name', async (request, reply) => {
  const {name} = request.params as {name: string};
  const gate = await stored(name);
  if (gate === null) return reply.code(404).send({error: 'not_found'});
  return reply.header('ETag', \`"\${gate.version}"\`).send(gate);
});

app.get('/gates/:name/history', async (request, reply) => {
  const {name} = request.params as {name: string};
  if ((await redis.hexists('gates', name)) === 0) return reply.code(404).send({error: 'not_found'});
  const entries = (await redis.lrange(\`gate:\${name}:history\`, 0, -1)).map(raw => JSON.parse(raw) as unknown);
  return {entries};
});

// node gate_api.js — listens on :8080
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var (
	nameRe    = regexp.MustCompile(\`^[a-z][a-z0-9_]{2,63}$\`)
	variantRe = regexp.MustCompile(\`^[A-Z][A-Z0-9_]*$\`)
)

const (
	historyN = 100
	off      = "OFF"
)

type Share struct {
	Variant string \`json:"variant"\`
	Pct     int    \`json:"pct"\`
}

type Population struct {
	Match map[string]string \`json:"match"\`
	Mix   []Share           \`json:"mix"\`
}

type Override struct {
	UserID    string \`json:"user_id"\`
	Variant   string \`json:"variant"\`
	ExpiresAt int64  \`json:"expires_at"\`
}

// Gate is what the hash gates holds and step 2's loaders read.
type Gate struct {
	Name        string       \`json:"name"\`
	Seed        string       \`json:"seed"\`
	Default     string       \`json:"default"\`
	Populations []Population \`json:"populations"\`
	Overrides   []Override   \`json:"overrides"\`
	Version     int          \`json:"version"\`
	UpdatedAt   int64        \`json:"updated_at"\`
	UpdatedBy   string       \`json:"updated_by"\`
}

// Entry is one line of gate:{name}:history.
type Entry struct {
	Version int    \`json:"version"\`
	At      int64  \`json:"at"\`
	By      string \`json:"by"\`
	Change  string \`json:"change"\`
}

// gateBody is the PUT body before validation: pointers and any so a missing or mistyped field is visible.
type gateBody struct {
	Seed        *string \`json:"seed"\`
	Default     *string \`json:"default"\`
	Populations []struct {
		Match map[string]any \`json:"match"\`
		Mix   []struct {
			Variant string   \`json:"variant"\`
			Pct     *float64 \`json:"pct"\`
		} \`json:"mix"\`
	} \`json:"populations"\`
	Overrides []Override \`json:"overrides"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// validate returns the normalised gate (seed, default, overrides filled in) or the reason it is invalid.
func validate(name string, body gateBody) (Gate, string) {
	// TODO: name ~ nameRe; populations non-empty; every match value a string; every mix non-empty with
	// TODO: variant ~ variantRe and pct a non-negative whole number, adding up to 100; default ~ variantRe
	_ = math.Trunc
	panic("not implemented")
}

// stored is the gate as published in the hash gates, or nil.
func stored(ctx context.Context, name string) (*Gate, error) {
	// TODO: HGET gates {name} → JSON (redis.Nil → nil, nil)
	panic("not implemented")
}

func putGate(rw http.ResponseWriter, r *http.Request) {
	// TODO: decode the body; validate → 400 invalid_gate; X-Editor → 400 editor_required; stored(name);
	// TODO: If-Match ≠ version → 412; version + 1, updated_at, updated_by; one TxPipelined: HSet gates,
	// TODO: Incr gates:version, LPush + LTrim history; 201 (new) or 200 (update) with the gate and ETag "<version>"
	_, _, _ = strconv.Itoa, strings.Trim, time.Now
	http.Error(rw, "not implemented", http.StatusNotImplemented)
}

func getGate(rw http.ResponseWriter, r *http.Request) {
	// TODO: the stored gate with its ETag, or 404 not_found
	http.Error(rw, "not implemented", http.StatusNotImplemented)
}

func getHistory(rw http.ResponseWriter, r *http.Request) {
	// TODO: {"entries": [...]} newest first (LRange 0 -1), 404 not_found for an unknown gate
	http.Error(rw, "not implemented", http.StatusNotImplemented)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /gates/{name}", putGate)
	mux.HandleFunc("GET /gates/{name}", getGate)
	mux.HandleFunc("GET /gates/{name}/history", getHistory)
	log.Fatal(http.ListenAndServe(":8080", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var (
	nameRe    = regexp.MustCompile(\`^[a-z][a-z0-9_]{2,63}$\`)
	variantRe = regexp.MustCompile(\`^[A-Z][A-Z0-9_]*$\`)
)

const (
	historyN = 100
	off      = "OFF"
)

type Share struct {
	Variant string \`json:"variant"\`
	Pct     int    \`json:"pct"\`
}

type Population struct {
	Match map[string]string \`json:"match"\`
	Mix   []Share           \`json:"mix"\`
}

type Override struct {
	UserID    string \`json:"user_id"\`
	Variant   string \`json:"variant"\`
	ExpiresAt int64  \`json:"expires_at"\`
}

// Gate is what the hash gates holds and step 2's loaders read.
type Gate struct {
	Name        string       \`json:"name"\`
	Seed        string       \`json:"seed"\`
	Default     string       \`json:"default"\`
	Populations []Population \`json:"populations"\`
	Overrides   []Override   \`json:"overrides"\`
	Version     int          \`json:"version"\`
	UpdatedAt   int64        \`json:"updated_at"\`
	UpdatedBy   string       \`json:"updated_by"\`
}

// Entry is one line of gate:{name}:history.
type Entry struct {
	Version int    \`json:"version"\`
	At      int64  \`json:"at"\`
	By      string \`json:"by"\`
	Change  string \`json:"change"\`
}

// gateBody is the PUT body before validation: pointers and any so a missing or mistyped field is visible.
type gateBody struct {
	Seed        *string \`json:"seed"\`
	Default     *string \`json:"default"\`
	Populations []struct {
		Match map[string]any \`json:"match"\`
		Mix   []struct {
			Variant string   \`json:"variant"\`
			Pct     *float64 \`json:"pct"\`
		} \`json:"mix"\`
	} \`json:"populations"\`
	Overrides []Override \`json:"overrides"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// validate returns the normalised gate (seed, default, overrides filled in) or the reason it is invalid.
func validate(name string, body gateBody) (Gate, string) {
	if !nameRe.MatchString(name) {
		return Gate{}, "name must match ^[a-z][a-z0-9_]{2,63}$"
	}
	if len(body.Populations) == 0 {
		return Gate{}, "populations must be a non-empty list"
	}
	gate := Gate{Name: name, Seed: name, Default: off, Overrides: []Override{}}
	if body.Seed != nil {
		gate.Seed = *body.Seed
	}
	if body.Default != nil {
		gate.Default = *body.Default
	}
	if body.Overrides != nil {
		gate.Overrides = body.Overrides
	}
	if gate.Seed == "" || !variantRe.MatchString(gate.Default) {
		return Gate{}, "seed must be a string and default must match ^[A-Z][A-Z0-9_]*$"
	}
	for _, p := range body.Populations {
		if p.Match == nil {
			return Gate{}, "match must map attribute names to strings"
		}
		population := Population{Match: map[string]string{}}
		for key, value := range p.Match {
			s, ok := value.(string)
			if !ok {
				return Gate{}, "match must map attribute names to strings"
			}
			population.Match[key] = s
		}
		if len(p.Mix) == 0 {
			return Gate{}, "mix must be a non-empty list"
		}
		total := 0
		for _, s := range p.Mix {
			if !variantRe.MatchString(s.Variant) {
				return Gate{}, "variant must match ^[A-Z][A-Z0-9_]*$"
			}
			if s.Pct == nil || *s.Pct < 0 || *s.Pct != math.Trunc(*s.Pct) {
				return Gate{}, "pct must be a non-negative integer"
			}
			population.Mix = append(population.Mix, Share{Variant: s.Variant, Pct: int(*s.Pct)})
			total += int(*s.Pct)
		}
		if total != 100 {
			return Gate{}, "mix shares must add up to exactly 100"
		}
		gate.Populations = append(gate.Populations, population)
	}
	return gate, ""
}

// stored is the gate as published in the hash gates, or nil.
func stored(ctx context.Context, name string) (*Gate, error) {
	raw, err := rdb.HGet(ctx, "gates", name).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var gate Gate
	if err := json.Unmarshal([]byte(raw), &gate); err != nil {
		return nil, err
	}
	return &gate, nil
}

func putGate(rw http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var body gateBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_gate", "reason": "body must be a gate object"})
		return
	}
	gate, reason := validate(name, body)
	if reason != "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_gate", "reason": reason})
		return
	}
	editor := r.Header.Get("X-Editor")
	if editor == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "editor_required"})
		return
	}
	ctx := r.Context()
	current, err := stored(ctx, name)
	if err != nil {
		http.Error(rw, "gate store unavailable", http.StatusServiceUnavailable)
		return
	}
	version := 0
	if current != nil {
		version = current.Version
	}
	if ifMatch := r.Header.Get("If-Match"); ifMatch != "" && strings.Trim(ifMatch, \`"\`) != strconv.Itoa(version) {
		writeJSON(rw, http.StatusPreconditionFailed, map[string]any{"error": "version_conflict", "current": version})
		return
	}
	now := time.Now().Unix()
	gate.Version, gate.UpdatedAt, gate.UpdatedBy = version+1, now, editor
	change, status := "created", http.StatusCreated
	if current != nil {
		change, status = "updated", http.StatusOK
	}
	encoded, _ := json.Marshal(gate)
	entry, _ := json.Marshal(Entry{Version: gate.Version, At: now, By: editor, Change: change})
	history := "gate:" + name + ":history"
	// MULTI … EXEC: a loader never sees the gate without its version bump.
	_, err = rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.HSet(ctx, "gates", name, encoded)
		pipe.Incr(ctx, "gates:version")
		pipe.LPush(ctx, history, entry)
		pipe.LTrim(ctx, history, 0, historyN-1)
		return nil
	})
	if err != nil {
		http.Error(rw, "gate store unavailable", http.StatusServiceUnavailable)
		return
	}
	rw.Header().Set("ETag", strconv.Quote(strconv.Itoa(gate.Version)))
	writeJSON(rw, status, gate)
}

func getGate(rw http.ResponseWriter, r *http.Request) {
	gate, err := stored(r.Context(), r.PathValue("name"))
	if err != nil {
		http.Error(rw, "gate store unavailable", http.StatusServiceUnavailable)
		return
	}
	if gate == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not_found"})
		return
	}
	rw.Header().Set("ETag", strconv.Quote(strconv.Itoa(gate.Version)))
	writeJSON(rw, http.StatusOK, gate)
}

func getHistory(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := r.PathValue("name")
	if known, _ := rdb.HExists(ctx, "gates", name).Result(); !known {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not_found"})
		return
	}
	lines, err := rdb.LRange(ctx, "gate:"+name+":history", 0, -1).Result()
	if err != nil {
		http.Error(rw, "gate store unavailable", http.StatusServiceUnavailable)
		return
	}
	entries := make([]json.RawMessage, 0, len(lines))
	for _, line := range lines {
		entries = append(entries, json.RawMessage(line))
	}
	writeJSON(rw, http.StatusOK, map[string]any{"entries": entries})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /gates/{name}", putGate)
	mux.HandleFunc("GET /gates/{name}", getGate)
	mux.HandleFunc("GET /gates/{name}/history", getHistory)
	log.Fatal(http.ListenAndServe(":8080", mux))
}
`,
    },
    scala: {
      starter: `import scala.jdk.CollectionConverters._
import scala.util.Try

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.ETag
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

/** The editing side of Stormcrow: validate a gate, version it, store it where the loaders look, remember who changed it. */
object GateApi {
  val jedis = new JedisPooled("redis", 6379)
  val NameRe = "^[a-z][a-z0-9_]{2,63}$".r
  val VariantRe = "^[A-Z][A-Z0-9_]*$".r
  val HistoryN = 100
  val Off = "OFF"

  case class Share(variant: String, pct: Int)
  case class Population(\`match\`: Map[String, String], mix: List[Share])
  case class Override(userId: String, variant: String, expiresAt: Long)
  /** What the hash gates holds and step 2's loaders read. */
  case class Gate(name: String, seed: String, default: String, populations: List[Population], overrides: List[Override], version: Int, updatedAt: Long, updatedBy: String)
  /** One line of gate:{name}:history. */
  case class Entry(version: Int, at: Long, by: String, change: String)

  implicit val shareFormat: RootJsonFormat[Share] = jsonFormat2(Share)
  implicit val populationFormat: RootJsonFormat[Population] = jsonFormat2(Population)
  implicit val overrideFormat: RootJsonFormat[Override] = jsonFormat(Override, "user_id", "variant", "expires_at")
  implicit val gateFormat: RootJsonFormat[Gate] =
    jsonFormat(Gate, "name", "seed", "default", "populations", "overrides", "version", "updated_at", "updated_by")
  implicit val entryFormat: RootJsonFormat[Entry] = jsonFormat4(Entry)

  private def json(status: StatusCode, body: JsValue, headers: List[HttpHeader] = Nil): Route =
    complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))

  private def error(status: StatusCode, fields: (String, JsValue)*): Route = json(status, JsObject(fields: _*))

  /** The normalised gate (seed, default, overrides filled in; version and audit fields still zero) or the reason it is invalid. */
  def validate(name: String, body: JsValue): Either[String, Gate] = {
    // TODO: name ~ NameRe; populations a non-empty array; every match value a JsString; every mix a non-empty array of
    // TODO: {variant ~ VariantRe, pct: whole and >= 0} adding up to 100; default ~ VariantRe
    ???
  }

  /** The gate as published in the hash gates, or None. */
  private def stored(name: String): Option[Gate] = {
    ??? // TODO: HGET gates {name} → JSON
  }

  val route: Route = concat(
    path("gates" / Segment) { name =>
      concat(
        put {
          entity(as[String]) { raw =>
            optionalHeaderValueByName("X-Editor") { editor =>
              optionalHeaderValueByName("If-Match") { ifMatch =>
                // TODO: validate → 400 invalid_gate; no editor → 400 editor_required; stored(name); If-Match ≠ version → 412
                // TODO: version + 1, updatedAt, updatedBy; one MULTI: hset gates, incr gates:version, lpush + ltrim history
                // TODO: 201 (new) or 200 (update) with the stored gate and ETag(version)
                val _ = (raw, editor, ifMatch)
                complete(StatusCodes.NotImplemented)
              }
            }
          }
        },
        get {
          // TODO: the stored gate with its ETag, or 404 not_found
          complete(StatusCodes.NotImplemented)
        }
      )
    },
    path("gates" / Segment / "history") { name =>
      get {
        // TODO: {"entries": [...]} newest first (lrange 0 -1), 404 not_found for an unknown gate
        complete(StatusCodes.NotImplemented)
      }
    }
  )

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("gates")
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
      solution: `import scala.jdk.CollectionConverters._
import scala.util.Try

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.ETag
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

/** The editing side of Stormcrow: validate a gate, version it, store it where the loaders look, remember who changed it. */
object GateApi {
  val jedis = new JedisPooled("redis", 6379)
  val NameRe = "^[a-z][a-z0-9_]{2,63}$".r
  val VariantRe = "^[A-Z][A-Z0-9_]*$".r
  val HistoryN = 100
  val Off = "OFF"

  case class Share(variant: String, pct: Int)
  case class Population(\`match\`: Map[String, String], mix: List[Share])
  case class Override(userId: String, variant: String, expiresAt: Long)
  /** What the hash gates holds and step 2's loaders read. */
  case class Gate(name: String, seed: String, default: String, populations: List[Population], overrides: List[Override], version: Int, updatedAt: Long, updatedBy: String)
  /** One line of gate:{name}:history. */
  case class Entry(version: Int, at: Long, by: String, change: String)

  implicit val shareFormat: RootJsonFormat[Share] = jsonFormat2(Share)
  implicit val populationFormat: RootJsonFormat[Population] = jsonFormat2(Population)
  implicit val overrideFormat: RootJsonFormat[Override] = jsonFormat(Override, "user_id", "variant", "expires_at")
  implicit val gateFormat: RootJsonFormat[Gate] =
    jsonFormat(Gate, "name", "seed", "default", "populations", "overrides", "version", "updated_at", "updated_by")
  implicit val entryFormat: RootJsonFormat[Entry] = jsonFormat4(Entry)

  private def json(status: StatusCode, body: JsValue, headers: List[HttpHeader] = Nil): Route =
    complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))

  private def error(status: StatusCode, fields: (String, JsValue)*): Route = json(status, JsObject(fields: _*))

  private final class Invalid(val reason: String) extends RuntimeException(reason)
  private def invalid(reason: String): Nothing = throw new Invalid(reason)

  private def share(value: JsValue): Share = value match {
    case JsObject(s) =>
      val variant = s.get("variant") match {
        case Some(JsString(v)) if VariantRe.matches(v) => v
        case _ => invalid("variant must match ^[A-Z][A-Z0-9_]*$")
      }
      val pct = s.get("pct") match {
        case Some(JsNumber(n)) if n.isWhole && n >= 0 => n.toInt
        case _ => invalid("pct must be a non-negative integer")
      }
      Share(variant, pct)
    case _ => invalid("each share must be an object")
  }

  private def population(value: JsValue): Population = value match {
    case JsObject(p) =>
      val matches = p.get("match") match {
        case Some(JsObject(m)) =>
          val strings = m.collect { case (key, JsString(v)) => key -> v }
          if (strings.size != m.size) invalid("match must map attribute names to strings")
          strings
        case _ => invalid("match must map attribute names to strings")
      }
      val mix = p.get("mix") match {
        case Some(JsArray(shares)) if shares.nonEmpty => shares.map(share).toList
        case _ => invalid("mix must be a non-empty list")
      }
      if (mix.map(_.pct).sum != 100) invalid("mix shares must add up to exactly 100")
      Population(matches, mix)
    case _ => invalid("each population must be an object")
  }

  /** The normalised gate (seed, default, overrides filled in; version and audit fields still zero) or the reason it is invalid. */
  def validate(name: String, body: JsValue): Either[String, Gate] =
    try {
      if (!NameRe.matches(name)) invalid("name must match ^[a-z][a-z0-9_]{2,63}$")
      val fields = body match {
        case JsObject(f) => f
        case _ => invalid("body must be a JSON object")
      }
      val populations = fields.get("populations") match {
        case Some(JsArray(ps)) if ps.nonEmpty => ps.map(population).toList
        case _ => invalid("populations must be a non-empty list")
      }
      val default = fields.getOrElse("default", JsString(Off)) match {
        case JsString(d) if VariantRe.matches(d) => d
        case _ => invalid("default must match ^[A-Z][A-Z0-9_]*$")
      }
      val seed = fields.getOrElse("seed", JsString(name)) match {
        case JsString(s) if s.nonEmpty => s
        case _ => invalid("seed must be a string")
      }
      val overrides = fields.getOrElse("overrides", JsArray()) match {
        case JsArray(os) => os.map(_.convertTo[Override]).toList
        case _ => invalid("overrides must be a list")
      }
      Right(Gate(name, seed, default, populations, overrides, 0, 0L, ""))
    } catch {
      case e: Invalid => Left(e.reason)
      case e: DeserializationException => Left(e.getMessage)
    }

  /** The gate as published in the hash gates, or None. */
  private def stored(name: String): Option[Gate] =
    Option(jedis.hget("gates", name)).map(_.parseJson.convertTo[Gate])

  val route: Route = concat(
    path("gates" / Segment) { name =>
      concat(
        put {
          entity(as[String]) { raw =>
            optionalHeaderValueByName("X-Editor") { editor =>
              optionalHeaderValueByName("If-Match") { ifMatch =>
                (validate(name, Try(raw.parseJson).getOrElse(JsNull)), editor.filter(_.nonEmpty)) match {
                  case (Left(reason), _) =>
                    error(StatusCodes.BadRequest, "error" -> JsString("invalid_gate"), "reason" -> JsString(reason))
                  case (_, None) => error(StatusCodes.BadRequest, "error" -> JsString("editor_required"))
                  case (Right(spec), Some(by)) =>
                    val current = stored(name)
                    val version = current.map(_.version).getOrElse(0)
                    if (ifMatch.exists(_.filter(_ != '"') != version.toString))
                      error(StatusCodes.PreconditionFailed, "error" -> JsString("version_conflict"), "current" -> JsNumber(version))
                    else {
                      val now = System.currentTimeMillis() / 1000
                      val gate = spec.copy(version = version + 1, updatedAt = now, updatedBy = by)
                      val entry = Entry(gate.version, now, by, if (current.isDefined) "updated" else "created")
                      val history = s"gate:$name:history"
                      val tx = jedis.multi() // MULTI … EXEC: a loader never sees the gate without its version bump
                      tx.hset("gates", name, gate.toJson.compactPrint)
                      tx.incr("gates:version")
                      tx.lpush(history, entry.toJson.compactPrint)
                      tx.ltrim(history, 0, HistoryN - 1)
                      tx.exec()
                      json(if (current.isDefined) StatusCodes.OK else StatusCodes.Created, gate.toJson, List(ETag(gate.version.toString)))
                    }
                }
              }
            }
          }
        },
        get {
          stored(name) match {
            case Some(gate) => json(StatusCodes.OK, gate.toJson, List(ETag(gate.version.toString)))
            case None => error(StatusCodes.NotFound, "error" -> JsString("not_found"))
          }
        }
      )
    },
    path("gates" / Segment / "history") { name =>
      get {
        if (!jedis.hexists("gates", name)) error(StatusCodes.NotFound, "error" -> JsString("not_found"))
        else {
          val entries = jedis.lrange(s"gate:$name:history", 0, -1).asScala.map(_.parseJson).toVector
          json(StatusCodes.OK, JsObject("entries" -> JsArray(entries)))
        }
      }
    }
  )

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("gates")
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `// The editing side of Stormcrow: validate a gate, version it, store it where the loaders look, remember who changed it.
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <ctime>
#include <iterator>
#include <optional>
#include <regex>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

const std::regex kNameRe("^[a-z][a-z0-9_]{2,63}$");
const std::regex kVariantRe("^[A-Z][A-Z0-9_]*$");
constexpr int kHistoryN = 100;
const std::string kOff = "OFF";

// Fills \`gate\` with the normalised gate (seed, default, overrides filled in) and returns "", or returns the reason the body is invalid.
std::string validate(const std::string& name, const json& body, json& gate) {
  // TODO: name ~ kNameRe; populations a non-empty array; every match value a string; every mix a non-empty array of
  // TODO: {variant ~ kVariantRe, pct: a non-negative integer} adding up to 100; default ~ kVariantRe
  throw std::logic_error("not implemented");
}

// The gate as published in the hash gates, or nullopt.
std::optional<json> stored(const std::string& name) {
  // TODO: HGET gates {name} → JSON
  throw std::logic_error("not implemented");
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

int main() {
  httplib::Server svr;

  svr.Put(R"(/gates/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string name = req.matches[1].str();
    // TODO: validate → 400 invalid_gate; X-Editor → 400 editor_required; stored(name); If-Match ≠ version → 412
    // TODO: version + 1, updated_at, updated_by; one transaction: hset gates, incr gates:version, lpush + ltrim history
    // TODO: 201 (new) or 200 (update) with the stored gate and ETag "<version>"
    reply(res, 501, {{"error", "not_implemented"}});
  });

  svr.Get(R"(/gates/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: the stored gate with its ETag, or 404 not_found
    reply(res, 501, {{"error", "not_implemented"}});
  });

  svr.Get(R"(/gates/([^/]+)/history)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: {"entries": [...]} newest first (lrange 0 -1), 404 not_found for an unknown gate
    reply(res, 501, {{"error", "not_implemented"}});
  });

  svr.listen("0.0.0.0", 8080);
}
`,
      solution: `// The editing side of Stormcrow: validate a gate, version it, store it where the loaders look, remember who changed it.
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <ctime>
#include <iterator>
#include <optional>
#include <regex>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

const std::regex kNameRe("^[a-z][a-z0-9_]{2,63}$");
const std::regex kVariantRe("^[A-Z][A-Z0-9_]*$");
constexpr int kHistoryN = 100;
const std::string kOff = "OFF";

bool upper_snake(const json& value) { return value.is_string() && std::regex_match(value.get<std::string>(), kVariantRe); }

// Fills \`gate\` with the normalised gate (seed, default, overrides filled in) and returns "", or returns the reason the body is invalid.
std::string validate(const std::string& name, const json& body, json& gate) {
  if (!std::regex_match(name, kNameRe)) return "name must match ^[a-z][a-z0-9_]{2,63}$";
  if (!body.is_object()) return "body must be a JSON object";
  const json populations = body.value("populations", json());
  if (!populations.is_array() || populations.empty()) return "populations must be a non-empty list";
  const json default_variant = body.value("default", json(kOff));
  if (!upper_snake(default_variant)) return "default must match ^[A-Z][A-Z0-9_]*$";
  for (const auto& population : populations) {
    const json match = population.is_object() ? population.value("match", json()) : json();
    if (!match.is_object()) return "match must map attribute names to strings";
    for (const auto& item : match.items()) {
      if (!item.value().is_string()) return "match must map attribute names to strings";
    }
    const json mix = population.value("mix", json());
    if (!mix.is_array() || mix.empty()) return "mix must be a non-empty list";
    long long total = 0;
    for (const auto& share : mix) {
      if (!share.is_object() || !upper_snake(share.value("variant", json()))) return "variant must match ^[A-Z][A-Z0-9_]*$";
      const json pct = share.value("pct", json());
      if (!pct.is_number_integer() || pct.get<long long>() < 0) return "pct must be a non-negative integer";
      total += pct.get<long long>();
    }
    if (total != 100) return "mix shares must add up to exactly 100";
  }
  const json seed = body.value("seed", json(name));
  const json overrides = body.value("overrides", json::array());
  if (!seed.is_string() || seed.get<std::string>().empty() || !overrides.is_array()) {
    return "seed must be a string and overrides a list";
  }
  gate = {{"name", name}, {"seed", seed}, {"default", default_variant}, {"populations", populations}, {"overrides", overrides}};
  return "";
}

// The gate as published in the hash gates, or nullopt.
std::optional<json> stored(const std::string& name) {
  const auto raw = redis.hget("gates", name);
  if (!raw) return std::nullopt;
  return json::parse(*raw);
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

std::string etag(int version) { return '"' + std::to_string(version) + '"'; }

int main() {
  httplib::Server svr;

  svr.Put(R"(/gates/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string name = req.matches[1].str();
    json gate;
    const std::string reason = validate(name, json::parse(req.body, nullptr, false), gate);
    if (!reason.empty()) return reply(res, 400, {{"error", "invalid_gate"}, {"reason", reason}});
    const std::string editor = req.get_header_value("X-Editor");
    if (editor.empty()) return reply(res, 400, {{"error", "editor_required"}});
    const auto current = stored(name);
    const int version = current ? current->value("version", 0) : 0;
    if (req.has_header("If-Match")) {
      std::string if_match = req.get_header_value("If-Match");
      if_match.erase(std::remove(if_match.begin(), if_match.end(), '"'), if_match.end());
      if (if_match != std::to_string(version)) {
        return reply(res, 412, {{"error", "version_conflict"}, {"current", version}});
      }
    }
    const long long now = std::time(nullptr);
    gate["version"] = version + 1;
    gate["updated_at"] = now;
    gate["updated_by"] = editor;
    const json entry = {{"version", version + 1}, {"at", now}, {"by", editor}, {"change", current ? "updated" : "created"}};
    const std::string history = "gate:" + name + ":history";
    auto tx = redis.transaction();  // MULTI … EXEC: a loader never sees the gate without its version bump
    tx.hset("gates", name, gate.dump()).incr("gates:version").lpush(history, entry.dump()).ltrim(history, 0, kHistoryN - 1).exec();
    res.set_header("ETag", etag(version + 1));
    reply(res, current ? 200 : 201, gate);
  });

  svr.Get(R"(/gates/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto gate = stored(req.matches[1].str());
    if (!gate) return reply(res, 404, {{"error", "not_found"}});
    res.set_header("ETag", etag(gate->value("version", 0)));
    reply(res, 200, *gate);
  });

  svr.Get(R"(/gates/([^/]+)/history)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string name = req.matches[1].str();
    if (!redis.hexists("gates", name)) return reply(res, 404, {{"error", "not_found"}});
    std::vector<std::string> lines;
    redis.lrange("gate:" + name + ":history", 0, -1, std::back_inserter(lines));
    json entries = json::array();
    for (const auto& line : lines) entries.push_back(json::parse(line));
    reply(res, 200, {{"entries", entries}});
  });

  svr.listen("0.0.0.0", 8080);
}
`,
    },
  },
  harness: {
    python: `import json
import time

MIX = [{"variant": "RED_BUTTON", "pct": 33}, {"variant": "BLUE_BUTTON", "pct": 33}, {"variant": "CONTROL", "pct": 34}]
BODY = {"populations": [{"match": {"locale": "de"}, "mix": MIX}, {"match": {}, "mix": [{"variant": "BLUE_BUTTON", "pct": 100}]}]}
ON = {"populations": [{"match": {}, "mix": [{"variant": "ON", "pct": 100}]}]}
NOT_FOUND = {"error": "not_found"}


def put(c, name, body=None, editor="tomm", if_match=None):
    headers = {}
    if editor is not None:
        headers["X-Editor"] = editor
    if if_match is not None:
        headers["If-Match"] = if_match
    return c.put(f"/gates/{name}", json=BODY if body is None else body, headers=headers)


def stored(ctx, name):
    raw = ctx.redis.hget("gates", name)
    return json.loads(raw) if raw else None


def history(ctx, name):
    return [json.loads(raw) for raw in ctx.redis.lrange(f"gate:{name}:history", 0, -1)]


def untouched(ctx, what):
    assert ctx.redis.keys("*") == [], f"{what} must write nothing, but Redis now holds {ctx.redis.keys('*')}"


def mix(*pcts):
    return [{"variant": v, "pct": p} for v, p in zip(["RED_BUTTON", "BLUE_BUTTON", "CONTROL"], pcts)]


async def check_validate(ctx):
    m = ctx.load("gate_api")
    bad = [
        ("shares adding up to 99", "button_color", {"populations": [{"match": {}, "mix": mix(33, 33, 33)}]}),
        ("shares adding up to 101", "button_color", {"populations": [{"match": {}, "mix": mix(34, 33, 34)}]}),
        ("a negative share (-10 + 110)", "button_color", {"populations": [{"match": {}, "mix": mix(-10, 110)}]}),
        ("a fractional share (33.5 + 66.5)", "button_color", {"populations": [{"match": {}, "mix": mix(33.5, 66.5)}]}),
        ("a share without a pct", "button_color", {"populations": [{"match": {}, "mix": [{"variant": "ON"}]}]}),
        ("the lowercase variant 'red_button'", "button_color", {"populations": [{"match": {}, "mix": [{"variant": "red_button", "pct": 100}]}]}),
        ("the lowercase default 'off'", "button_color", {"default": "off", **ON}),
        ("an empty mix", "button_color", {"populations": [{"match": {}, "mix": []}]}),
        ("an empty populations list", "button_color", {"populations": []}),
        ("no populations at all", "button_color", {"seed": "button_color"}),
        ("a population without a match", "button_color", {"populations": [{"mix": mix(50, 50)}]}),
        ("a match value that is not a string", "button_color", {"populations": [{"match": {"locale": 7}, "mix": mix(50, 50)}]}),
        ("the name 'Button_Color' (upper case)", "Button_Color", ON),
        ("the name 'ab' (too short)", "ab", ON),
        ("the name '1st_gate' (starts with a digit)", "1st_gate", ON),
        ("a 65-character name", "a" * 65, ON),
    ]
    async with ctx.client(m.app) as c:
        for what, name, body in bad:
            r = await put(c, name, body)
            assert r.status_code == 400, f"PUT /gates/{name} with {what} answered {r.status_code}, expected 400"
            data = r.json()
            assert data.get("error") == "invalid_gate", f"PUT /gates/{name} with {what} answered {r.text}, expected error invalid_gate"
            assert isinstance(data.get("reason"), str) and data["reason"], f"the 400 for {what} must carry a reason string, got {r.text}"
        untouched(ctx, "a rejected gate")
        r = await put(c, "button_color", {"populations": []}, editor=None)
        assert r.status_code == 400 and r.json().get("error") == "invalid_gate", f"the shape is checked before the editor: a malformed gate without X-Editor answered {r.status_code} {r.text}, expected 400 invalid_gate"
        untouched(ctx, "a rejected gate")
        r = await put(c, "button_color")
        assert r.status_code == 201, f"a valid gate answered {r.status_code} {r.text}, expected 201"
        r = await put(c, "a" * 64, ON)
        assert r.status_code == 201, f"a 64-character name is within ^[a-z][a-z0-9_]{{2,63}}$ but answered {r.status_code}"
        assert stored(ctx, "button_color") is not None, "the accepted gate must be stored in the hash gates"


async def check_created_updated(ctx):
    m = ctx.load("gate_api")
    async with ctx.client(m.app) as c:
        now = int(time.time())
        r = await put(c, "dark_mode", ON, editor="ana")
        assert r.status_code == 201, f"the first PUT of dark_mode answered {r.status_code}, expected 201 Created"
        gate = r.json()
        assert gate.get("version") == 1, f"a new gate must be version 1, the answer carried version {gate.get('version')!r}"
        assert r.headers.get("etag") == json.dumps("1"), f"the 201 must carry the header ETag: {json.dumps('1')} (the version, quoted), it carried {r.headers.get('etag')!r}"
        assert gate.get("name") == "dark_mode" and gate.get("seed") == "dark_mode" and gate.get("default") == "OFF" and gate.get("overrides") == [], f"seed defaults to the name, default to OFF, overrides to []; the answer was {r.text}"
        assert gate.get("updated_by") == "ana", f"updated_by must be the X-Editor (ana), the answer carried {gate.get('updated_by')!r}"
        assert isinstance(gate.get("updated_at"), int) and abs(gate["updated_at"] - now) <= 5, f"updated_at must be the time of the write in seconds, got {gate.get('updated_at')!r}"
        assert gate == stored(ctx, "dark_mode"), f"the answer must be the stored gate: answered {r.text}, stored {ctx.redis.hget('gates', 'dark_mode')}"
        r = await put(c, "dark_mode", {"seed": "dark_mode_v2", "default": "ON", **ON}, editor="bo")
        assert r.status_code == 200, f"updating an existing gate answered {r.status_code}, expected 200"
        gate = r.json()
        assert gate.get("version") == 2 and r.headers.get("etag") == json.dumps("2"), f"the update must bump the version to 2 and answer ETag {json.dumps('2')}: got version {gate.get('version')!r}, ETag {r.headers.get('etag')!r}"
        assert gate.get("seed") == "dark_mode_v2" and gate.get("default") == "ON" and gate.get("updated_by") == "bo", f"the update must replace the gate's fields (seed, default, updated_by): {r.text}"
        r = await put(c, "dark_mode", ON, editor="bo")
        assert r.status_code == 200 and r.json().get("version") == 3, f"a third PUT must be version 3, got {r.status_code} {r.text}"
        r = await put(c, "other_gate", ON)
        assert r.status_code == 201 and r.json().get("version") == 1, f"every gate counts its own versions: a new gate is version 1 even after three edits elsewhere (gates:version is the global counter, not the gate's); got {r.status_code} {r.text}"
        r = await c.get("/gates/dark_mode")
        assert r.status_code == 200, f"GET /gates/dark_mode answered {r.status_code}, expected 200"
        assert r.json() == stored(ctx, "dark_mode"), f"GET must answer the stored gate: got {r.text}, stored {ctx.redis.hget('gates', 'dark_mode')}"
        assert r.headers.get("etag") == json.dumps("3"), f"GET must carry ETag {json.dumps('3')}, it carried {r.headers.get('etag')!r}"
        r = await c.get("/gates/ghost")
        assert r.status_code == 404, f"GET of an unknown gate answered {r.status_code}, expected 404"
        assert r.json() == NOT_FOUND, f"the 404 body was {r.text}, expected {json.dumps(NOT_FOUND)}"


async def check_if_match(ctx):
    m = ctx.load("gate_api")
    async with ctx.client(m.app) as c:
        for _ in range(2):
            await put(c, "other", ON)  # gates:version is 2 before button_color exists
        await put(c, "button_color")
        await put(c, "button_color")  # button_color is version 2, gates:version 4
        before = stored(ctx, "button_color")
        r = await put(c, "button_color", {"populations": [{"match": {}, "mix": [{"variant": "CONTROL", "pct": 100}]}]}, if_match=json.dumps("1"))
        assert r.status_code == 412, f"If-Match {json.dumps('1')} against version 2 answered {r.status_code}, expected 412"
        expected = {"error": "version_conflict", "current": 2}
        assert r.json() == expected, f"the 412 body was {r.text}, expected {json.dumps(expected)}"
        assert stored(ctx, "button_color") == before, "a 412 must write nothing, but the stored gate changed"
        assert ctx.redis.get("gates:version") == "4", f"a 412 must not bump gates:version, it is {ctx.redis.get('gates:version')!r} (expected '4')"
        assert len(history(ctx, "button_color")) == 2, f"a 412 must not add a history entry, the history holds {len(history(ctx, 'button_color'))}"
        r = await put(c, "button_color", if_match=json.dumps("2"))
        assert r.status_code == 200 and r.json().get("version") == 3, f"If-Match {json.dumps('2')} against version 2 must be accepted (200, version 3), got {r.status_code} {r.text}: compare with the gate's own version, not gates:version"
        r = await put(c, "button_color", if_match="3")
        assert r.status_code == 200 and r.json().get("version") == 3 + 1, f"an unquoted If-Match: 3 against version 3 must be accepted too, got {r.status_code} {r.text}"
        r = await put(c, "button_color", if_match=json.dumps("9"))
        assert r.status_code == 412 and r.json().get("current") == 4, f"If-Match {json.dumps('9')} against version 4 must answer 412 with current 4, got {r.status_code} {r.text}"
        r = await put(c, "button_color")
        assert r.status_code == 200 and r.json().get("version") == 5, f"a PUT without If-Match is accepted (last writer wins is the caller's choice), got {r.status_code} {r.text}"


async def check_history(ctx):
    m = ctx.load("gate_api")
    async with ctx.client(m.app) as c:
        r = await put(c, "button_color", editor=None)
        assert r.status_code == 400, f"a PUT without X-Editor answered {r.status_code}, expected 400"
        assert r.json() == {"error": "editor_required"}, f"the 400 body was {r.text}, expected {json.dumps({'error': 'editor_required'})}"
        untouched(ctx, "a PUT without X-Editor")
        now = int(time.time())
        await put(c, "button_color", editor="ana")
        ctx.clock.advance(60)
        await put(c, "button_color", editor="bo")
        assert stored(ctx, "button_color").get("updated_by") == "bo", "the stored gate's updated_by must be the X-Editor of the last accepted PUT (bo)"
        entries = history(ctx, "button_color")
        assert len(entries) == 2, f"two accepted PUTs must leave two entries in gate:button_color:history, found {len(entries)}"
        got = [(e.get("version"), e.get("by"), e.get("change")) for e in entries]
        assert got == [(2, "bo", "updated"), (1, "ana", "created")], f"history is newest first: expected version 2 by bo (updated), then version 1 by ana (created); found {entries}"
        assert all(isinstance(e.get("at"), int) for e in entries) and entries[1]["at"] >= now - 5 and entries[0]["at"] - entries[1]["at"] >= 59, f"each entry's at is the time of its write in seconds (the second came a minute later): {entries}"
        r = await c.get("/gates/button_color/history")
        assert r.status_code == 200, f"GET /gates/button_color/history answered {r.status_code}, expected 200"
        assert r.json() == {"entries": entries}, f"GET /gates/button_color/history answered {r.text}, expected the stored entries newest first: {json.dumps({'entries': entries})}"
        r = await c.get("/gates/ghost/history")
        assert r.status_code == 404 and r.json() == NOT_FOUND, f"the history of an unknown gate answered {r.status_code} {r.text}, expected 404 {json.dumps(NOT_FOUND)}"
        await put(c, "button_color", if_match=json.dumps("1"))
        await put(c, "button_color", {"populations": []})
        await put(c, "button_color", editor=None)
        assert len(history(ctx, "button_color")) == 2, f"rejected requests (412, invalid gate, missing editor) must not add history entries, the history holds {len(history(ctx, 'button_color'))}"
        for i in range(103):
            await put(c, "button_color", editor=f"bot{i}")
        entries = history(ctx, "button_color")
        assert len(entries) == 100, f"the history is capped at the last 100 entries (LTRIM 0 99), it holds {len(entries)}"
        assert entries[0].get("version") == 105 and entries[-1].get("version") == 6, f"the cap keeps the newest 100: versions 105 down to 6, found {entries[0].get('version')} down to {entries[-1].get('version')}"


async def check_published(ctx):
    m = ctx.load("gate_api")
    async with ctx.client(m.app) as c:
        probe = ctx.redis_after("gates:version", lambda: (stored(ctx, "button_color") is not None, ctx.redis.llen("gate:button_color:history")))
        r = await put(c, "button_color", editor="tomm")
        assert r.status_code == 201, f"PUT answered {r.status_code} {r.text}, expected 201"
        assert probe.fired, "an accepted PUT must INCR gates:version — the signal step 2's loader polls"
        in_hash, entries = probe.result
        assert in_hash and entries == 1, f"at the instant gates:version moved, the gate was {'already' if in_hash else 'not yet'} in the hash and the history held {entries} entries: HSET, INCR, LPUSH and LTRIM belong to one MULTI/EXEC so a loader never sees one without the others"
        await put(c, "dark_mode", ON, editor="ana")
        overrides = [{"user_id": "tomm", "variant": "RED_BUTTON", "expires_at": int(time.time()) + 3600}]
        await put(c, "button_color", {**BODY, "overrides": overrides})
        assert ctx.redis.get("gates:version") == "3", f"three accepted writes must leave gates:version at 3, it is {ctx.redis.get('gates:version')!r}: INCR exactly once per accepted write"
        assert sorted(ctx.redis.hkeys("gates")) == ["button_color", "dark_mode"], f"the hash gates must hold one field per gate, it holds {sorted(ctx.redis.hkeys('gates'))}"
        gate = stored(ctx, "button_color")
        fields = {"name", "seed", "default", "populations", "overrides", "version", "updated_at", "updated_by"}
        assert fields <= set(gate), f"the stored JSON must carry every field {sorted(fields)}, it has {sorted(gate)}"
        assert gate["populations"] == BODY["populations"], f"populations must be stored as sent — an ordered list of {{match, mix}}, mix an ordered list of {{variant, pct}}; stored {json.dumps(gate['populations'])}"
        assert gate["overrides"] == overrides and gate["version"] == 2 and gate["name"] == "button_color" and gate["seed"] == "button_color" and gate["default"] == "OFF", f"the stored button_color must be version 2 with its overrides and defaults, stored {json.dumps(gate)}"
        await put(c, "button_color", if_match=json.dumps("1"))
        await put(c, "button_color", {"populations": []})
        assert ctx.redis.get("gates:version") == "3", f"rejected writes must not move gates:version, it is {ctx.redis.get('gates:version')!r}"
        loader = ctx.load("gates")
        assert loader.refresh() is True, "step 2's loader must see a new gates:version and load the hash"
        assert loader.snapshot.version == 3, f"the loader read gates:version as {loader.snapshot.version}, expected 3"
        assert loader.get_variant("dark_mode", {"user_id": "ana"}) == "ON", "step 2's loader must find dark_mode in the hash and serve its ON population: the stored JSON is not what the loader expects"
        assert loader.get_variant("button_color", {"user_id": "tomm", "locale": "en"}) == "RED_BUTTON", "the stored overrides must reach the loader: tomm's override answers RED_BUTTON"
        assert loader.get_variant("button_color", {"user_id": "ana", "locale": "en"}) == "BLUE_BUTTON", "the stored populations must reach the loader: an English user lands in the catch-all (BLUE_BUTTON 100%)"
`,
    typescript: `const MIX = [
  {variant: 'RED_BUTTON', pct: 33},
  {variant: 'BLUE_BUTTON', pct: 33},
  {variant: 'CONTROL', pct: 34},
];
const BODY = {populations: [{match: {locale: 'de'}, mix: MIX}, {match: {}, mix: [{variant: 'BLUE_BUTTON', pct: 100}]}]};
const ON = {populations: [{match: {}, mix: [{variant: 'ON', pct: 100}]}]};
const NOT_FOUND = {error: 'not_found'};

function put(c, name: string, body: unknown = BODY, options: {editor?: string | null; ifMatch?: string} = {}) {
  const headers: Record<string, string> = {};
  const editor = options.editor === undefined ? 'tomm' : options.editor;
  if (editor !== null) headers['X-Editor'] = editor;
  if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
  return c.put(\`/gates/\${name}\`, {json: body, headers});
}

function stored(ctx, name: string): Record<string, unknown> | null {
  const raw = ctx.redis.hget('gates', name);
  return raw === null ? null : JSON.parse(raw);
}

function history(ctx, name: string): Record<string, unknown>[] {
  return ctx.redis.lrange(\`gate:\${name}:history\`, 0, -1).map((raw: string) => JSON.parse(raw));
}

function untouched(ctx, what: string) {
  assert.deepEqual(ctx.redis.keys('*'), [], \`\${what} must write nothing, but Redis now holds \${JSON.stringify(ctx.redis.keys('*'))}\`);
}

const mix = (...pcts: number[]) => ['RED_BUTTON', 'BLUE_BUTTON', 'CONTROL'].slice(0, pcts.length).map((variant, i) => ({variant, pct: pcts[i]}));

export async function check_validate(ctx) {
  const m = ctx.load('gate_api');
  const c = ctx.client(m.app);
  const bad: [string, string, unknown][] = [
    ['shares adding up to 99', 'button_color', {populations: [{match: {}, mix: mix(33, 33, 33)}]}],
    ['shares adding up to 101', 'button_color', {populations: [{match: {}, mix: mix(34, 33, 34)}]}],
    ['a negative share (-10 + 110)', 'button_color', {populations: [{match: {}, mix: mix(-10, 110)}]}],
    ['a fractional share (33.5 + 66.5)', 'button_color', {populations: [{match: {}, mix: mix(33.5, 66.5)}]}],
    ['a share without a pct', 'button_color', {populations: [{match: {}, mix: [{variant: 'ON'}]}]}],
    ["the lowercase variant 'red_button'", 'button_color', {populations: [{match: {}, mix: [{variant: 'red_button', pct: 100}]}]}],
    ["the lowercase default 'off'", 'button_color', {default: 'off', ...ON}],
    ['an empty mix', 'button_color', {populations: [{match: {}, mix: []}]}],
    ['an empty populations list', 'button_color', {populations: []}],
    ['no populations at all', 'button_color', {seed: 'button_color'}],
    ['a population without a match', 'button_color', {populations: [{mix: mix(50, 50)}]}],
    ['a match value that is not a string', 'button_color', {populations: [{match: {locale: 7}, mix: mix(50, 50)}]}],
    ["the name 'Button_Color' (upper case)", 'Button_Color', ON],
    ["the name 'ab' (too short)", 'ab', ON],
    ["the name '1st_gate' (starts with a digit)", '1st_gate', ON],
    ['a 65-character name', 'a'.repeat(65), ON],
  ];
  for (const [what, name, body] of bad) {
    const r = await put(c, name, body);
    assert.equal(r.status, 400, \`PUT /gates/\${name} with \${what} answered \${r.status}, expected 400\`);
    const data = r.json();
    assert.equal(data.error, 'invalid_gate', \`PUT /gates/\${name} with \${what} answered \${r.text}, expected error invalid_gate\`);
    assert(typeof data.reason === 'string' && data.reason !== '', \`the 400 for \${what} must carry a reason string, got \${r.text}\`);
  }
  untouched(ctx, 'a rejected gate');
  let r = await put(c, 'button_color', {populations: []}, {editor: null});
  assert(r.status === 400 && r.json().error === 'invalid_gate', \`the shape is checked before the editor: a malformed gate without X-Editor answered \${r.status} \${r.text}, expected 400 invalid_gate\`);
  untouched(ctx, 'a rejected gate');
  r = await put(c, 'button_color');
  assert.equal(r.status, 201, \`a valid gate answered \${r.status} \${r.text}, expected 201\`);
  r = await put(c, 'a'.repeat(64), ON);
  assert.equal(r.status, 201, \`a 64-character name is within ^[a-z][a-z0-9_]{2,63}$ but answered \${r.status}\`);
  assert(stored(ctx, 'button_color') !== null, 'the accepted gate must be stored in the hash gates');
}

export async function check_created_updated(ctx) {
  const m = ctx.load('gate_api');
  const c = ctx.client(m.app);
  const now = Math.floor(Date.now() / 1000);
  let r = await put(c, 'dark_mode', ON, {editor: 'ana'});
  assert.equal(r.status, 201, \`the first PUT of dark_mode answered \${r.status}, expected 201 Created\`);
  let gate = r.json();
  assert.equal(gate.version, 1, \`a new gate must be version 1, the answer carried version \${JSON.stringify(gate.version)}\`);
  assert.equal(r.headers.etag, '"1"', \`the 201 must carry the header ETag: "1" (the version, quoted), it carried \${JSON.stringify(r.headers.etag)}\`);
  assert(gate.name === 'dark_mode' && gate.seed === 'dark_mode' && gate.default === 'OFF' && Array.isArray(gate.overrides) && gate.overrides.length === 0, \`seed defaults to the name, default to OFF, overrides to []; the answer was \${r.text}\`);
  assert.equal(gate.updated_by, 'ana', \`updated_by must be the X-Editor (ana), the answer carried \${JSON.stringify(gate.updated_by)}\`);
  assert(Number.isInteger(gate.updated_at) && Math.abs(gate.updated_at - now) <= 5, \`updated_at must be the time of the write in seconds, got \${JSON.stringify(gate.updated_at)}\`);
  assert.deepEqual(gate, stored(ctx, 'dark_mode'), \`the answer must be the stored gate: answered \${r.text}, stored \${ctx.redis.hget('gates', 'dark_mode')}\`);
  r = await put(c, 'dark_mode', {seed: 'dark_mode_v2', default: 'ON', ...ON}, {editor: 'bo'});
  assert.equal(r.status, 200, \`updating an existing gate answered \${r.status}, expected 200\`);
  gate = r.json();
  assert(gate.version === 2 && r.headers.etag === '"2"', \`the update must bump the version to 2 and answer ETag "2": got version \${JSON.stringify(gate.version)}, ETag \${JSON.stringify(r.headers.etag)}\`);
  assert(gate.seed === 'dark_mode_v2' && gate.default === 'ON' && gate.updated_by === 'bo', \`the update must replace the gate's fields (seed, default, updated_by): \${r.text}\`);
  r = await put(c, 'dark_mode', ON, {editor: 'bo'});
  assert(r.status === 200 && r.json().version === 3, \`a third PUT must be version 3, got \${r.status} \${r.text}\`);
  r = await put(c, 'other_gate', ON);
  assert(r.status === 201 && r.json().version === 1, \`every gate counts its own versions: a new gate is version 1 even after three edits elsewhere (gates:version is the global counter, not the gate's); got \${r.status} \${r.text}\`);
  r = await c.get('/gates/dark_mode');
  assert.equal(r.status, 200, \`GET /gates/dark_mode answered \${r.status}, expected 200\`);
  assert.deepEqual(r.json(), stored(ctx, 'dark_mode'), \`GET must answer the stored gate: got \${r.text}, stored \${ctx.redis.hget('gates', 'dark_mode')}\`);
  assert.equal(r.headers.etag, '"3"', \`GET must carry ETag "3", it carried \${JSON.stringify(r.headers.etag)}\`);
  r = await c.get('/gates/ghost');
  assert.equal(r.status, 404, \`GET of an unknown gate answered \${r.status}, expected 404\`);
  assert.deepEqual(r.json(), NOT_FOUND, \`the 404 body was \${r.text}, expected \${JSON.stringify(NOT_FOUND)}\`);
}

export async function check_if_match(ctx) {
  const m = ctx.load('gate_api');
  const c = ctx.client(m.app);
  for (let i = 0; i < 2; i++) await put(c, 'other', ON); // gates:version is 2 before button_color exists
  await put(c, 'button_color');
  await put(c, 'button_color'); // button_color is version 2, gates:version 4
  const before = stored(ctx, 'button_color');
  let r = await put(c, 'button_color', {populations: [{match: {}, mix: [{variant: 'CONTROL', pct: 100}]}]}, {ifMatch: '"1"'});
  assert.equal(r.status, 412, \`If-Match "1" against version 2 answered \${r.status}, expected 412\`);
  const expected = {error: 'version_conflict', current: 2};
  assert.deepEqual(r.json(), expected, \`the 412 body was \${r.text}, expected \${JSON.stringify(expected)}\`);
  assert.deepEqual(stored(ctx, 'button_color'), before, 'a 412 must write nothing, but the stored gate changed');
  assert.equal(ctx.redis.get('gates:version'), '4', \`a 412 must not bump gates:version, it is \${JSON.stringify(ctx.redis.get('gates:version'))} (expected '4')\`);
  assert.equal(history(ctx, 'button_color').length, 2, \`a 412 must not add a history entry, the history holds \${history(ctx, 'button_color').length}\`);
  r = await put(c, 'button_color', BODY, {ifMatch: '"2"'});
  assert(r.status === 200 && r.json().version === 3, \`If-Match "2" against version 2 must be accepted (200, version 3), got \${r.status} \${r.text}: compare with the gate's own version, not gates:version\`);
  r = await put(c, 'button_color', BODY, {ifMatch: '3'});
  assert(r.status === 200 && r.json().version === 4, \`an unquoted If-Match: 3 against version 3 must be accepted too, got \${r.status} \${r.text}\`);
  r = await put(c, 'button_color', BODY, {ifMatch: '"9"'});
  assert(r.status === 412 && r.json().current === 4, \`If-Match "9" against version 4 must answer 412 with current 4, got \${r.status} \${r.text}\`);
  r = await put(c, 'button_color');
  assert(r.status === 200 && r.json().version === 5, \`a PUT without If-Match is accepted (last writer wins is the caller's choice), got \${r.status} \${r.text}\`);
}

export async function check_history(ctx) {
  const m = ctx.load('gate_api');
  const c = ctx.client(m.app);
  let r = await put(c, 'button_color', BODY, {editor: null});
  assert.equal(r.status, 400, \`a PUT without X-Editor answered \${r.status}, expected 400\`);
  assert.deepEqual(r.json(), {error: 'editor_required'}, \`the 400 body was \${r.text}, expected {"error":"editor_required"}\`);
  untouched(ctx, 'a PUT without X-Editor');
  const now = Math.floor(Date.now() / 1000);
  await put(c, 'button_color', BODY, {editor: 'ana'});
  ctx.clock.advance(60);
  await put(c, 'button_color', BODY, {editor: 'bo'});
  assert.equal(stored(ctx, 'button_color')?.updated_by, 'bo', "the stored gate's updated_by must be the X-Editor of the last accepted PUT (bo)");
  let entries = history(ctx, 'button_color');
  assert.equal(entries.length, 2, \`two accepted PUTs must leave two entries in gate:button_color:history, found \${entries.length}\`);
  const got = entries.map(e => [e.version, e.by, e.change]);
  assert.deepEqual(got, [[2, 'bo', 'updated'], [1, 'ana', 'created']], \`history is newest first: expected version 2 by bo (updated), then version 1 by ana (created); found \${JSON.stringify(entries)}\`);
  const at = entries.map(e => e.at as number);
  assert(at.every(Number.isInteger) && at[1] >= now - 5 && at[0] - at[1] >= 59, \`each entry's at is the time of its write in seconds (the second came a minute later): \${JSON.stringify(entries)}\`);
  r = await c.get('/gates/button_color/history');
  assert.equal(r.status, 200, \`GET /gates/button_color/history answered \${r.status}, expected 200\`);
  assert.deepEqual(r.json(), {entries}, \`GET /gates/button_color/history answered \${r.text}, expected the stored entries newest first: \${JSON.stringify({entries})}\`);
  r = await c.get('/gates/ghost/history');
  assert(r.status === 404 && JSON.stringify(r.json()) === JSON.stringify(NOT_FOUND), \`the history of an unknown gate answered \${r.status} \${r.text}, expected 404 \${JSON.stringify(NOT_FOUND)}\`);
  await put(c, 'button_color', BODY, {ifMatch: '"1"'});
  await put(c, 'button_color', {populations: []});
  await put(c, 'button_color', BODY, {editor: null});
  assert.equal(history(ctx, 'button_color').length, 2, \`rejected requests (412, invalid gate, missing editor) must not add history entries, the history holds \${history(ctx, 'button_color').length}\`);
  for (let i = 0; i < 103; i++) await put(c, 'button_color', BODY, {editor: \`bot\${i}\`});
  entries = history(ctx, 'button_color');
  assert.equal(entries.length, 100, \`the history is capped at the last 100 entries (LTRIM 0 99), it holds \${entries.length}\`);
  assert(entries[0].version === 105 && entries[99].version === 6, \`the cap keeps the newest 100: versions 105 down to 6, found \${entries[0].version} down to \${entries[99].version}\`);
}

export async function check_published(ctx) {
  const m = ctx.load('gate_api');
  const c = ctx.client(m.app);
  const probe = ctx.redisAfter('gates:version', () => [stored(ctx, 'button_color') !== null, ctx.redis.llen('gate:button_color:history')]);
  let r = await put(c, 'button_color', BODY, {editor: 'tomm'});
  assert.equal(r.status, 201, \`PUT answered \${r.status} \${r.text}, expected 201\`);
  assert(probe.fired, "an accepted PUT must INCR gates:version — the signal step 2's loader polls");
  const [inHash, entries] = probe.result as [boolean, number];
  assert(inHash && entries === 1, \`at the instant gates:version moved, the gate was \${inHash ? 'already' : 'not yet'} in the hash and the history held \${entries} entries: HSET, INCR, LPUSH and LTRIM belong to one MULTI/EXEC so a loader never sees one without the others\`);
  await put(c, 'dark_mode', ON, {editor: 'ana'});
  const overrides = [{user_id: 'tomm', variant: 'RED_BUTTON', expires_at: Math.floor(Date.now() / 1000) + 3600}];
  await put(c, 'button_color', {...BODY, overrides});
  assert.equal(ctx.redis.get('gates:version'), '3', \`three accepted writes must leave gates:version at 3, it is \${JSON.stringify(ctx.redis.get('gates:version'))}: INCR exactly once per accepted write\`);
  assert.deepEqual(ctx.redis.hkeys('gates').sort(), ['button_color', 'dark_mode'], \`the hash gates must hold one field per gate, it holds \${JSON.stringify(ctx.redis.hkeys('gates').sort())}\`);
  const gate = stored(ctx, 'button_color');
  assert(gate !== null, 'button_color must be stored in the hash gates');
  const fields = ['name', 'seed', 'default', 'populations', 'overrides', 'version', 'updated_at', 'updated_by'];
  const missing = fields.filter(f => !(f in gate));
  assert.equal(missing.length, 0, \`the stored JSON must carry every field \${JSON.stringify(fields)}, it lacks \${JSON.stringify(missing)}\`);
  assert.deepEqual(gate.populations, BODY.populations, \`populations must be stored as sent — an ordered list of {match, mix}, mix an ordered list of {variant, pct}; stored \${JSON.stringify(gate.populations)}\`);
  assert(JSON.stringify(gate.overrides) === JSON.stringify(overrides) && gate.version === 2 && gate.name === 'button_color' && gate.seed === 'button_color' && gate.default === 'OFF', \`the stored button_color must be version 2 with its overrides and defaults, stored \${JSON.stringify(gate)}\`);
  await put(c, 'button_color', BODY, {ifMatch: '"1"'});
  await put(c, 'button_color', {populations: []});
  assert.equal(ctx.redis.get('gates:version'), '3', \`rejected writes must not move gates:version, it is \${JSON.stringify(ctx.redis.get('gates:version'))}\`);
  const loader = ctx.load('gates');
  assert.equal(await loader.refresh(), true, "step 2's loader must see a new gates:version and load the hash");
  assert.equal(loader.snapshot.version, 3, \`the loader read gates:version as \${loader.snapshot.version}, expected 3\`);
  assert.equal(loader.getVariant('dark_mode', {user_id: 'ana'}), 'ON', "step 2's loader must find dark_mode in the hash and serve its ON population: the stored JSON is not what the loader expects");
  assert.equal(loader.getVariant('button_color', {user_id: 'tomm', locale: 'en'}), 'RED_BUTTON', "the stored overrides must reach the loader: tomm's override answers RED_BUTTON");
  assert.equal(loader.getVariant('button_color', {user_id: 'ana', locale: 'en'}), 'BLUE_BUTTON', 'the stored populations must reach the loader: an English user lands in the catch-all (BLUE_BUTTON 100%)');
}
`,
  },
  debrief: `An admin API for configuration is where most "easy" services go wrong, because the hard part is not the write but the *semantics around it*: validation that refuses half-valid shapes (a mix adding up to 99 silently assigns nobody to the last variant), optimistic concurrency so two editors cannot overwrite each other (If-Match / 412 is the HTTP-native way; a version in the body is the common substitute), attribution and history because this state lives outside version control and changes at 3 a.m., and a single version counter the readers can poll cheaply. Stormcrow's post lists exactly these — audit history, overrides, a config pushed on every edit — as what made the system operable rather than merely functional.`,
};
