import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/secrets: a fingerprint goes out, the material stays in',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['ops', 'api', 'vault'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/secrets\` with \`{name, material, rotation_seconds}\`:
it answers 401 without \`X-Operator-Id\`, writes the version through \`vault.create_version\`
(provided: it stores the material and its SHA-256 fingerprint and returns the whole record), writes
an audit line and answers 201 with that record. It serves the demo and hides three flaws.

**Failure mode the checks target.** What leaves the service. The 201 body is copied into proxies,
client logs and error reports; the audit pipeline keeps its lines for years; and a secret created
without an interval is never due for rotation.

- The 201 body is \`public_version(record)\`: \`name\`, \`version_id\`, \`fingerprint\`,
  \`rotation_seconds\`, \`created_at\` and \`rotate_at\`. No material.
- The audit line carries the operator, the name, the version id and the fingerprint.
- \`rotation_seconds\` defaults to \`DEFAULT_ROTATION_SECONDS\` (2 592 000, 30 days) and lies within
  \`MIN_ROTATION_SECONDS\` (300) and \`MAX_ROTATION_SECONDS\` (7 776 000, 90 days); anything else is
  **400**, before a version is written.`,
  sequence: {
    participants: ['Operator', 'secretd', 'secretd.vault', 'audit log'],
    messages: [
      {from: 'Operator', to: 'secretd', label: 'POST /v1/secrets · X-Operator-Id', kind: 'sync'},
      {
        from: 'secretd',
        to: 'secretd',
        label: 'rotation_seconds: default 30 d · 300..7 776 000 → else 400',
        kind: 'sync',
      },
      {from: 'secretd', to: 'secretd.vault', label: 'create_version(name, material, interval, operator)', kind: 'sync'},
      {from: 'secretd.vault', to: 'secretd', label: 'record (with material)', kind: 'reply'},
      {from: 'secretd', to: 'audit log', label: 'secret.created · operator, name, version, fingerprint', kind: 'async'},
      {from: 'secretd', to: 'Operator', label: '201 public_version(record)', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'create-route',
      title: 'Registers POST /v1/secrets behind an operator',
      detail:
        'Register `POST /v1/secrets`: a request without `X-Operator-Id` is **401**, and each create writes the next version (`v1`, `v2`, …) with its material into the vault.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/secrets["']/, /\b401\b/, /vault\.create_version\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/secrets['"]/, /\b401\b/, /createVersion\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/secrets"/, /StatusUnauthorized|\b401\b/, /vault\.CreateVersion\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"secrets"\s*\)/, /Unauthorized|\b401\b/, /Vault\.createVersion\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/secrets"/, /\b401\b/, /vault::createVersion\(/]},
      },
    },
    {
      id: 'material-sealed',
      title: 'The 201 body is a projection without material',
      detail:
        'The response is built by `public_version`/`publicVersion` from the fields it names; the vault record, which carries the material, is never serialized as the body.',
      match: {
        python: {all: [/def public_version\(/, /public_version\(\s*record\s*\)/], none: [/JSONResponse\(\s*record\b/]},
        typescript: {
          all: [/function publicVersion\(|publicVersion\s*=/, /publicVersion\(\s*record\s*\)/],
          none: [/\.send\(\s*record\s*\)/],
        },
        go: {
          all: [/func publicVersion\(/, /publicVersion\(\s*record\s*\)/],
          none: [/writeJSON\([^\n]*,\s*record\s*\)/],
        },
        scala: {all: [/def publicVersion\(/, /publicVersion\(\s*record\s*\)/], none: [/Vault\.toJson\(/]},
        cpp: {all: [/publicVersion\(/, /publicVersion\(\s*record\s*\)/], none: [/json\(\s*record\s*\)/]},
      },
    },
    {
      id: 'audit-ids-only',
      title: 'The audit line carries ids, not the material',
      detail:
        'The create is logged with the operator, the name, the version id and the fingerprint; no log call receives the material.',
      match: {
        python: {all: [/audit\.info\(/, /fingerprint/], none: [/audit\.\w+\([^\n]*material/]},
        typescript: {all: [/console\.info\(/, /fingerprint/], none: [/console\.\w+\([^\n]*material/]},
        go: {all: [/log\.Printf\(/, /Fingerprint/], none: [/log\.\w+\([^\n]*[Mm]aterial/]},
        scala: {all: [/System\.err\.println\(/, /fingerprint/], none: [/println\([^\n]*material/]},
        cpp: {all: [/std::cerr\s*<</, /fingerprint/], none: [/std::cerr[^;]*material/]},
      },
    },
    {
      id: 'rotation-policy',
      title: 'Every secret gets a bounded rotation interval',
      detail:
        'A missing `rotation_seconds` is `DEFAULT_ROTATION_SECONDS` (30 days), and a value outside `MIN_ROTATION_SECONDS`..`MAX_ROTATION_SECONDS` (300..7 776 000) is **400** before anything is written; the starter turns a missing interval into 0.',
      match: {
        python: {
          all: [
            /DEFAULT_ROTATION_SECONDS\s*=\s*2_?592_?000\b/,
            /MIN_ROTATION_SECONDS\s*=\s*300\b/,
            /MAX_ROTATION_SECONDS\s*=\s*7_?776_?000\b/,
            /status_code\s*=\s*400/,
          ],
          none: [/rotation_seconds\s+or\s+0\b/],
          order: [/MIN_ROTATION_SECONDS\s*<=|<\s*MIN_ROTATION_SECONDS/, /vault\.create_version\(/],
        },
        typescript: {
          all: [
            /DEFAULT_ROTATION_SECONDS\s*=\s*2_?592_?000\b/,
            /MIN_ROTATION_SECONDS\s*=\s*300\b/,
            /MAX_ROTATION_SECONDS\s*=\s*7_?776_?000\b/,
            /code\(\s*400\s*\)/,
          ],
          none: [/rotation_seconds\s*\?\?\s*0\b/],
          order: [/<\s*MIN_ROTATION_SECONDS|MIN_ROTATION_SECONDS\s*>/, /createVersion\(/],
        },
        go: {
          all: [
            /defaultRotationSeconds\s*=\s*2_?592_?000\b/,
            /minRotationSeconds\s*=\s*300\b/,
            /maxRotationSeconds\s*=\s*7_?776_?000\b/,
            /StatusBadRequest/,
          ],
          order: [/<\s*minRotationSeconds/, /vault\.CreateVersion\(/],
        },
        scala: {
          all: [
            /DefaultRotationSeconds\s*=\s*2_?592_?000L?\b/,
            /MinRotationSeconds\s*=\s*300L?\b/,
            /MaxRotationSeconds\s*=\s*7_?776_?000L?\b/,
            /BadRequest/,
          ],
          none: [/getOrElse\(\s*0L?\s*\)/],
          order: [/<\s*MinRotationSeconds/, /Vault\.createVersion\(/],
        },
        cpp: {
          all: [
            /kDefaultRotationSeconds\s*=\s*2'?592'?000\b/,
            /kMinRotationSeconds\s*=\s*300\b/,
            /kMaxRotationSeconds\s*=\s*7'?776'?000\b/,
            /\b400\b/,
          ],
          none: [/"rotation_seconds",\s*0LL\s*\)/],
          order: [/<\s*kMinRotationSeconds/, /vault::createVersion\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from secretd import vault  # create_version, get_version, fingerprint

app = FastAPI()
audit = logging.getLogger("secretd.audit")


class CreateSecret(BaseModel):
    name: str
    material: str
    rotation_seconds: int | None = None


@app.post("/v1/secrets")
def create_secret(body: CreateSecret, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    operator = request.headers.get("x-operator-id", "")
    if not operator:
        raise HTTPException(status_code=401, detail="X-Operator-Id is required")
    rotation_seconds = body.rotation_seconds or 0  # 0: rotated on demand
    record = vault.create_version(body.name, body.material, rotation_seconds, operator)
    audit.info("secret.created operator=%s name=%s version=%s material=%s", operator, body.name, record["version_id"], body.material)
    return JSONResponse(record, status_code=201)
`,
      solution: `import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from secretd import vault  # create_version, get_version, fingerprint

app = FastAPI()
audit = logging.getLogger("secretd.audit")

DEFAULT_ROTATION_SECONDS = 2_592_000  # 30 days
MIN_ROTATION_SECONDS = 300
MAX_ROTATION_SECONDS = 7_776_000  # 90 days
PUBLIC_FIELDS = ("name", "version_id", "fingerprint", "rotation_seconds", "created_at", "rotate_at")


class CreateSecret(BaseModel):
    name: str
    material: str
    rotation_seconds: int | None = None


def public_version(record: dict) -> dict:
    """What a response may carry: ids, the fingerprint and the rotation window. The material stays in the vault."""
    return {field: record[field] for field in PUBLIC_FIELDS}


@app.post("/v1/secrets")
def create_secret(body: CreateSecret, request: Request) -> JSONResponse:
    operator = request.headers.get("x-operator-id", "")
    if not operator:
        raise HTTPException(status_code=401, detail="X-Operator-Id is required")
    rotation_seconds = DEFAULT_ROTATION_SECONDS if body.rotation_seconds is None else body.rotation_seconds
    if not MIN_ROTATION_SECONDS <= rotation_seconds <= MAX_ROTATION_SECONDS:
        raise HTTPException(status_code=400, detail=f"rotation_seconds must lie within {MIN_ROTATION_SECONDS}..{MAX_ROTATION_SECONDS}")
    record = vault.create_version(body.name, body.material, rotation_seconds, operator)
    audit.info("secret.created operator=%s name=%s version=%s fingerprint=%s", operator, body.name, record["version_id"], record["fingerprint"])
    return JSONResponse(public_version(record), status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {createVersion} from 'secretd/vault';

export const app = Fastify();

interface CreateSecret {
  name: string;
  material: string;
  rotation_seconds?: number;
}

app.post('/v1/secrets', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const operator = request.headers['x-operator-id'];
  if (typeof operator !== 'string' || operator === '') return reply.code(401).send({error: 'X-Operator-Id is required'});
  const body = request.body as CreateSecret;
  const rotationSeconds = body.rotation_seconds ?? 0; // 0: rotated on demand
  const record = await createVersion(body.name, body.material, rotationSeconds, operator);
  console.info(\`secret.created operator=\${operator} name=\${body.name} version=\${record.version_id} material=\${body.material}\`);
  return reply.code(201).send(record);
});
`,
      solution: `import Fastify from 'fastify';

import {type Version, createVersion} from 'secretd/vault';

export const app = Fastify();

export const DEFAULT_ROTATION_SECONDS = 2_592_000; // 30 days
export const MIN_ROTATION_SECONDS = 300;
export const MAX_ROTATION_SECONDS = 7_776_000; // 90 days

interface CreateSecret {
  name: string;
  material: string;
  rotation_seconds?: number;
}

/** What a response may carry: ids, the fingerprint and the rotation window. The material stays in the vault. */
export function publicVersion(record: Version) {
  const {name, version_id, fingerprint, rotation_seconds, created_at, rotate_at} = record;
  return {name, version_id, fingerprint, rotation_seconds, created_at, rotate_at};
}

app.post('/v1/secrets', async (request, reply) => {
  const operator = request.headers['x-operator-id'];
  if (typeof operator !== 'string' || operator === '') return reply.code(401).send({error: 'X-Operator-Id is required'});
  const body = request.body as CreateSecret;
  const rotationSeconds = body.rotation_seconds ?? DEFAULT_ROTATION_SECONDS;
  if (!Number.isInteger(rotationSeconds) || rotationSeconds < MIN_ROTATION_SECONDS || rotationSeconds > MAX_ROTATION_SECONDS) {
    return reply.code(400).send({error: \`rotation_seconds must lie within \${MIN_ROTATION_SECONDS}..\${MAX_ROTATION_SECONDS}\`});
  }
  const record = await createVersion(body.name, body.material, rotationSeconds, operator);
  console.info(\`secret.created operator=\${operator} name=\${body.name} version=\${record.version_id} fingerprint=\${record.fingerprint}\`);
  return reply.code(201).send(publicVersion(record));
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"secretd/vault" // vault.CreateVersion, GetVersion, Fingerprint
)

type createSecret struct {
	Name            string \`json:"name"\`
	Material        string \`json:"material"\`
	RotationSeconds *int64 \`json:"rotation_seconds"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createSecretHandler(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	operator := r.Header.Get("X-Operator-Id")
	if operator == "" {
		http.Error(rw, "X-Operator-Id is required", http.StatusUnauthorized)
		return
	}
	var body createSecret
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body is not JSON", http.StatusBadRequest)
		return
	}
	var rotationSeconds int64 // 0: rotated on demand
	if body.RotationSeconds != nil {
		rotationSeconds = *body.RotationSeconds
	}
	record, err := vault.CreateVersion(r.Context(), body.Name, body.Material, rotationSeconds, operator)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("secret.created operator=%s name=%s version=%s material=%s", operator, body.Name, record.VersionID, body.Material)
	writeJSON(rw, http.StatusCreated, record)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/secrets", createSecretHandler)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"secretd/vault" // vault.CreateVersion, GetVersion, Fingerprint
)

const (
	defaultRotationSeconds = 2_592_000 // 30 days
	minRotationSeconds     = 300
	maxRotationSeconds     = 7_776_000 // 90 days
)

type createSecret struct {
	Name            string \`json:"name"\`
	Material        string \`json:"material"\`
	RotationSeconds *int64 \`json:"rotation_seconds"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// publicVersion is what a response may carry: ids, the fingerprint and the rotation window. The
// material stays in the vault.
func publicVersion(record *vault.Version) map[string]any {
	return map[string]any{
		"name": record.Name, "version_id": record.VersionID, "fingerprint": record.Fingerprint,
		"rotation_seconds": record.RotationSeconds, "created_at": record.CreatedAt, "rotate_at": record.RotateAt,
	}
}

func createSecretHandler(rw http.ResponseWriter, r *http.Request) {
	operator := r.Header.Get("X-Operator-Id")
	if operator == "" {
		http.Error(rw, "X-Operator-Id is required", http.StatusUnauthorized)
		return
	}
	var body createSecret
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body is not JSON", http.StatusBadRequest)
		return
	}
	rotationSeconds := int64(defaultRotationSeconds)
	if body.RotationSeconds != nil {
		rotationSeconds = *body.RotationSeconds
	}
	if rotationSeconds < minRotationSeconds || rotationSeconds > maxRotationSeconds {
		http.Error(rw, fmt.Sprintf("rotation_seconds must lie within %d..%d", minRotationSeconds, maxRotationSeconds), http.StatusBadRequest)
		return
	}
	record, err := vault.CreateVersion(r.Context(), body.Name, body.Material, rotationSeconds, operator)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("secret.created operator=%s name=%s version=%s fingerprint=%s", operator, body.Name, record.VersionID, record.Fingerprint)
	writeJSON(rw, http.StatusCreated, publicVersion(record))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/secrets", createSecretHandler)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import secretd.Vault // Vault.createVersion, getVersion, fingerprint, toJson

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "secrets") {
    post {
      optionalHeaderValueByName("X-Operator-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Operator-Id is required")
        case Some(operator) =>
          entity(as[String]) { raw =>
            // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
            val body = raw.parseJson.asJsObject.fields
            val name = body("name").convertTo[String]
            val material = body("material").convertTo[String]
            val rotationSeconds = body.get("rotation_seconds").map(_.convertTo[Long]).getOrElse(0L) // 0: rotated on demand
            val record = Vault.createVersion(name, material, rotationSeconds, operator)
            System.err.println(s"secret.created operator=$operator name=$name version=\${record.versionId} material=$material")
            complete(json(StatusCodes.Created, Vault.toJson(record)))
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import secretd.Vault // Vault.createVersion, getVersion, fingerprint, toJson

object Api {
  val DefaultRotationSeconds = 2592000L // 30 days
  val MinRotationSeconds = 300L
  val MaxRotationSeconds = 7776000L // 90 days

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** What a response may carry: ids, the fingerprint and the rotation window. The material stays in the vault. */
  def publicVersion(record: Vault.Version): JsObject = JsObject(
    "name" -> JsString(record.name),
    "version_id" -> JsString(record.versionId),
    "fingerprint" -> JsString(record.fingerprint),
    "rotation_seconds" -> JsNumber(record.rotationSeconds),
    "created_at" -> JsNumber(record.createdAt),
    "rotate_at" -> JsNumber(record.rotateAt))

  val route: Route = path("v1" / "secrets") {
    post {
      optionalHeaderValueByName("X-Operator-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Operator-Id is required")
        case Some(operator) =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            val name = body("name").convertTo[String]
            val material = body("material").convertTo[String]
            val rotationSeconds = body.get("rotation_seconds").map(_.convertTo[Long]).getOrElse(DefaultRotationSeconds)
            if (rotationSeconds < MinRotationSeconds || rotationSeconds > MaxRotationSeconds)
              complete(StatusCodes.BadRequest -> s"rotation_seconds must lie within $MinRotationSeconds..$MaxRotationSeconds")
            else {
              val record = Vault.createVersion(name, material, rotationSeconds, operator)
              System.err.println(s"secret.created operator=$operator name=$name version=\${record.versionId} fingerprint=\${record.fingerprint}")
              complete(json(StatusCodes.Created, publicVersion(record)))
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

#include <iostream>
#include <string>

#include "secretd/vault.h"  // vault::createVersion, getVersion, fingerprint

using json = nlohmann::json;

void create_secret(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string operator_id = req.get_header_value("X-Operator-Id");
  if (operator_id.empty()) {
    res.status = 401;
    res.set_content("X-Operator-Id is required", "text/plain");
    return;
  }
  const json body = json::parse(req.body);
  const long long rotation_seconds = body.value("rotation_seconds", 0LL);  // 0: rotated on demand
  const std::string material = body.value("material", "");
  const vault::Version record = vault::createVersion(body.value("name", ""), material, rotation_seconds, operator_id);
  std::cerr << "secret.created operator=" << operator_id << " name=" << record.name << " version=" << record.version_id
            << " material=" << material << "\\n";
  res.status = 201;
  res.set_content(json(record).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/secrets", create_secret); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "secretd/vault.h"  // vault::createVersion, getVersion, fingerprint

using json = nlohmann::json;

constexpr long long kDefaultRotationSeconds = 2592000;  // 30 days
constexpr long long kMinRotationSeconds = 300;
constexpr long long kMaxRotationSeconds = 7776000;  // 90 days

// What a response may carry: ids, the fingerprint and the rotation window. The material stays in the vault.
json publicVersion(const vault::Version& record) {
  return json{{"name", record.name},
              {"version_id", record.version_id},
              {"fingerprint", record.fingerprint},
              {"rotation_seconds", record.rotation_seconds},
              {"created_at", record.created_at},
              {"rotate_at", record.rotate_at}};
}

void create_secret(const httplib::Request& req, httplib::Response& res) {
  const std::string operator_id = req.get_header_value("X-Operator-Id");
  if (operator_id.empty()) {
    res.status = 401;
    res.set_content("X-Operator-Id is required", "text/plain");
    return;
  }
  const json body = json::parse(req.body);
  const long long rotation_seconds = body.value("rotation_seconds", kDefaultRotationSeconds);
  if (rotation_seconds < kMinRotationSeconds || rotation_seconds > kMaxRotationSeconds) {
    res.status = 400;
    res.set_content("rotation_seconds must lie within 300..7776000", "text/plain");
    return;
  }
  const vault::Version record = vault::createVersion(body.value("name", ""), body.value("material", ""), rotation_seconds, operator_id);
  std::cerr << "secret.created operator=" << operator_id << " name=" << record.name << " version=" << record.version_id
            << " fingerprint=" << record.fingerprint << "\\n";
  res.status = 201;
  res.set_content(publicVersion(record).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/secrets", create_secret); }
`,
    },
  },
  harness: {
    python: `import contextlib
import hashlib
import io
import logging

from secretd import vault

MATERIAL = "pg-password-CANARY-41d7"
OPS = {"X-Operator-Id": "op-ana"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _create(c, name="payments-db", headers=OPS, **extra):
    return await c.post("/v1/secrets", json={"name": name, "material": MATERIAL, **extra}, headers=headers)


def _created(r, what):
    assert r.status_code == 201, f"{what} answered {r.status_code}: {r.text}"
    return r.json()


async def check_create_route(ctx):
    async with _api(ctx) as c:
        anonymous = await _create(c, headers={})
        assert anonymous.status_code == 401, f"a create without X-Operator-Id answered {anonymous.status_code}, expected 401"
        first = _created(await _create(c), "POST /v1/secrets")
        second = _created(await _create(c), "a second POST /v1/secrets for the same name")
    assert first.get("name") == "payments-db" and first.get("version_id") == "v1", f"the first create must answer name payments-db and version_id v1, got {first}"
    assert second.get("version_id") == "v2", f"the second create must answer version_id v2, got {second}"
    stored = vault.get_version("payments-db", "v1")
    assert stored is not None and stored["material"] == MATERIAL, f"the vault must hold version v1 with its material, it holds {stored}"


async def check_material_sealed(ctx):
    async with _api(ctx) as c:
        r = await _create(c, rotation_seconds=3600)
    body = _created(r, "POST /v1/secrets")
    assert "material" not in body, f"the 201 body carries the material: {r.text}. Answer public_version(record): ids, fingerprint and window only"
    assert MATERIAL not in r.text, f"the 201 body carries the material under another name: {r.text}"
    expected = hashlib.sha256(MATERIAL.encode()).hexdigest()
    assert body.get("fingerprint") == expected, f"the 201 body must carry the SHA-256 fingerprint {expected}, got {body.get('fingerprint')!r}"
    for field in ("name", "version_id", "rotation_seconds", "created_at", "rotate_at"):
        assert field in body, f"the 201 body must carry {field}, got {body}"


async def check_audit_ids_only(ctx):
    captured = io.StringIO()
    handler = logging.StreamHandler(captured)
    root = logging.getLogger()
    level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            async with _api(ctx) as c:
                _created(await _create(c), "POST /v1/secrets")
    finally:
        root.removeHandler(handler)
        root.setLevel(level)
    logged = captured.getvalue()
    assert MATERIAL not in logged, f"the material reached the logs: {logged.strip()!r}. The audit line carries the operator, the name, the version id and the fingerprint"
    lines = [line for line in logged.splitlines() if "op-ana" in line]
    assert any("v1" in line for line in lines), f"the create must write an audit line naming the operator and version v1, the logs hold {logged.strip()!r}"


async def check_rotation_policy(ctx):
    async with _api(ctx) as c:
        default = _created(await _create(c, name="default-interval"), "POST /v1/secrets without rotation_seconds")
        assert default.get("rotation_seconds") == 2_592_000, f"a create without rotation_seconds must get the 30-day default (2592000), got {default.get('rotation_seconds')!r}"
        assert default.get("rotate_at") == default.get("created_at", 0) + 2_592_000, f"rotate_at must be created_at + rotation_seconds, got {default}"
        for bad in (0, 299, 7_776_001):
            r = await _create(c, name=f"bad-{bad}", rotation_seconds=bad)
            assert r.status_code == 400, f"rotation_seconds={bad} answered {r.status_code}, expected 400: the interval lies within 300..7776000"
            assert vault.versions(f"bad-{bad}") == [], f"a create refused for rotation_seconds={bad} still wrote a version"
        hourly = _created(await _create(c, name="hourly", rotation_seconds=3600), "POST /v1/secrets with rotation_seconds=3600")
    assert hourly.get("rotate_at") == hourly.get("created_at", 0) + 3600, f"rotate_at must be created_at + 3600, got {hourly}"
`,
    typescript: `import {createHash} from 'node:crypto';

const MATERIAL = 'pg-password-CANARY-41d7';
const OPS = {'X-Operator-Id': 'op-ana'};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), vault: ctx.load('/support/secretd/vault.ts')};
}

const create = (c, name = 'payments-db', extra = {}, headers: Record<string, string> = OPS) =>
  c.post('/v1/secrets', {json: {name, material: MATERIAL, ...extra}, headers});

function created(r, what: string) {
  assert.equal(r.status, 201, \`\${what} answered \${r.status}: \${r.text}\`);
  return r.json();
}

export async function check_create_route(ctx) {
  const {c, vault} = api(ctx);
  const anonymous = await create(c, 'payments-db', {}, {});
  assert.equal(anonymous.status, 401, \`a create without X-Operator-Id answered \${anonymous.status}, expected 401\`);
  const first = created(await create(c), 'POST /v1/secrets');
  const second = created(await create(c), 'a second POST /v1/secrets for the same name');
  assert(first.name === 'payments-db' && first.version_id === 'v1', \`the first create must answer name payments-db and version_id v1, got \${JSON.stringify(first)}\`);
  assert.equal(second.version_id, 'v2', \`the second create must answer version_id v2, got \${JSON.stringify(second)}\`);
  const stored = await vault.getVersion('payments-db', 'v1');
  assert(stored !== null && stored.material === MATERIAL, \`the vault must hold version v1 with its material, it holds \${JSON.stringify(stored)}\`);
}

export async function check_material_sealed(ctx) {
  const {c} = api(ctx);
  const r = await create(c, 'payments-db', {rotation_seconds: 3600});
  const body = created(r, 'POST /v1/secrets');
  assert(!('material' in body), \`the 201 body carries the material: \${r.text}. Answer publicVersion(record): ids, fingerprint and window only\`);
  assert(!r.text.includes(MATERIAL), \`the 201 body carries the material under another name: \${r.text}\`);
  const expected = createHash('sha256').update(MATERIAL).digest('hex');
  assert.equal(body.fingerprint, expected, \`the 201 body must carry the SHA-256 fingerprint \${expected}, got \${JSON.stringify(body.fingerprint)}\`);
  for (const field of ['name', 'version_id', 'rotation_seconds', 'created_at', 'rotate_at']) {
    assert(field in body, \`the 201 body must carry \${field}, got \${r.text}\`);
  }
}

export async function check_audit_ids_only(ctx) {
  const {c} = api(ctx);
  const logged: string[] = [];
  const prior = {log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error};
  const capture = (...args: unknown[]) => void logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.debug = console.warn = console.error = capture;
  try {
    created(await create(c), 'POST /v1/secrets');
  } finally {
    Object.assign(console, prior);
  }
  const leak = logged.find(line => line.includes(MATERIAL));
  assert(leak === undefined, \`the material reached the logs: \${JSON.stringify(leak)}. The audit line carries the operator, the name, the version id and the fingerprint\`);
  assert(
    logged.some(line => line.includes('op-ana') && line.includes('v1')),
    \`the create must write an audit line naming the operator and version v1, the logs hold \${JSON.stringify(logged)}\`,
  );
}

export async function check_rotation_policy(ctx) {
  const {c, vault} = api(ctx);
  const fallback = created(await create(c, 'default-interval'), 'POST /v1/secrets without rotation_seconds');
  assert.equal(fallback.rotation_seconds, 2_592_000, \`a create without rotation_seconds must get the 30-day default (2592000), got \${JSON.stringify(fallback.rotation_seconds)}\`);
  assert.equal(fallback.rotate_at, fallback.created_at + 2_592_000, \`rotate_at must be created_at + rotation_seconds, got \${JSON.stringify(fallback)}\`);
  for (const bad of [0, 299, 7_776_001]) {
    const r = await create(c, \`bad-\${bad}\`, {rotation_seconds: bad});
    assert.equal(r.status, 400, \`rotation_seconds=\${bad} answered \${r.status}, expected 400: the interval lies within 300..7776000\`);
    assert.equal((await vault.versions(\`bad-\${bad}\`)).length, 0, \`a create refused for rotation_seconds=\${bad} still wrote a version\`);
  }
  const hourly = created(await create(c, 'hourly', {rotation_seconds: 3600}), 'POST /v1/secrets with rotation_seconds=3600');
  assert.equal(hourly.rotate_at, hourly.created_at + 3600, \`rotate_at must be created_at + 3600, got \${JSON.stringify(hourly)}\`);
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"secretd/vault"

	"leetbuild/harness"
)

const apiMaterial = "pg-password-CANARY-41d7"

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiCreate(c *harness.HTTP, name string, extra map[string]any, header ...string) *harness.Response {
	body := map[string]any{"name": name, "material": apiMaterial}
	for k, v := range extra {
		body[k] = v
	}
	return c.Post("/v1/secrets", body, header...)
}

func apiCreated(ctx *harness.Ctx, r *harness.Response, what string) map[string]any {
	ctx.Equal(r.Status, 201, "%s (%s)", what, r.Text())
	out, _ := r.JSON().(map[string]any)
	return out
}

func CheckCreateRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	anonymous := apiCreate(c, "payments-db", nil)
	ctx.Equal(anonymous.Status, 401, "a create without X-Operator-Id")
	first := apiCreated(ctx, apiCreate(c, "payments-db", nil, "X-Operator-Id", "op-ana"), "POST /v1/secrets")
	second := apiCreated(ctx, apiCreate(c, "payments-db", nil, "X-Operator-Id", "op-ana"), "a second POST /v1/secrets for the same name")
	ctx.Assert(first["name"] == "payments-db" && first["version_id"] == "v1", "the first create must answer name payments-db and version_id v1, got %v", first)
	ctx.Equal(second["version_id"], "v2", "the second create's version_id")
	stored := vault.GetVersion(context.Background(), "payments-db", "v1")
	ctx.Assert(stored != nil && stored.Material == apiMaterial, "the vault must hold version v1 with its material, it holds %+v", stored)
}

func CheckMaterialSealed(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiCreate(c, "payments-db", map[string]any{"rotation_seconds": 3600}, "X-Operator-Id", "op-ana")
	body := apiCreated(ctx, r, "POST /v1/secrets")
	_, leaked := body["material"]
	ctx.Assert(!leaked, "the 201 body carries the material: %s. Answer publicVersion(record): ids, fingerprint and window only", r.Text())
	ctx.Assert(!strings.Contains(r.Text(), apiMaterial), "the 201 body carries the material under another name: %s", r.Text())
	sum := sha256.Sum256([]byte(apiMaterial))
	ctx.Equal(body["fingerprint"], hex.EncodeToString(sum[:]), "the 201 body must carry the SHA-256 fingerprint")
	for _, field := range []string{"name", "version_id", "rotation_seconds", "created_at", "rotate_at"} {
		_, ok := body[field]
		ctx.Assert(ok, "the 201 body must carry %s, got %s", field, r.Text())
	}
}

func CheckAuditIdsOnly(ctx *harness.Ctx) {
	c := apiClient(ctx)
	var logged bytes.Buffer
	log.SetOutput(&logged)
	r := apiCreate(c, "payments-db", nil, "X-Operator-Id", "op-ana")
	log.SetOutput(os.Stderr)
	apiCreated(ctx, r, "POST /v1/secrets")
	ctx.Assert(!strings.Contains(logged.String(), apiMaterial), "the material reached the logs: %q. The audit line carries the operator, the name, the version id and the fingerprint", strings.TrimSpace(logged.String()))
	found := false
	for _, line := range strings.Split(logged.String(), "\\n") {
		found = found || (strings.Contains(line, "op-ana") && strings.Contains(line, "v1"))
	}
	ctx.Assert(found, "the create must write an audit line naming the operator and version v1, the logs hold %q", strings.TrimSpace(logged.String()))
}

func CheckRotationPolicy(ctx *harness.Ctx) {
	c := apiClient(ctx)
	fallback := apiCreated(ctx, apiCreate(c, "default-interval", nil, "X-Operator-Id", "op-ana"), "POST /v1/secrets without rotation_seconds")
	ctx.Equal(fallback["rotation_seconds"], 2592000, "a create without rotation_seconds must get the 30-day default")
	created, _ := fallback["created_at"].(float64)
	ctx.Equal(fallback["rotate_at"], created+2592000, "rotate_at must be created_at + rotation_seconds")
	for _, bad := range []int{0, 299, 7776001} {
		name := fmt.Sprintf("bad-%d", bad)
		r := apiCreate(c, name, map[string]any{"rotation_seconds": bad}, "X-Operator-Id", "op-ana")
		ctx.Equal(r.Status, 400, "rotation_seconds=%d (the interval lies within 300..7776000)", bad)
		ctx.Equal(len(vault.Versions(context.Background(), name)), 0, "a create refused for rotation_seconds=%d still wrote a version; the versions", bad)
	}
	hourly := apiCreated(ctx, apiCreate(c, "hourly", map[string]any{"rotation_seconds": 3600}, "X-Operator-Id", "op-ana"), "POST /v1/secrets with rotation_seconds=3600")
	hourlyCreated, _ := hourly["created_at"].(float64)
	ctx.Equal(hourly["rotate_at"], hourlyCreated+3600, "rotate_at must be created_at + 3600")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <sstream>
#include <string>

#include "secretd/vault.h"

namespace {

const std::string kMaterial = "pg-password-CANARY-41d7";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response create(harness::HTTP& c, const std::string& name, nlohmann::json extra = nlohmann::json::object()) {
  nlohmann::json body = {{"name", name}, {"material", kMaterial}};
  body.update(extra);
  return c.Post("/v1/secrets", body.dump(), "Content-Type", "application/json", "X-Operator-Id", "op-ana");
}

nlohmann::json created(harness::Ctx& ctx, const harness::Response& r, const std::string& what) {
  ctx.Equal(r.Status, 201, "%s (%s)", what, r.Text());
  return nlohmann::json::parse(r.Text());
}

}  // namespace

void CheckCreateRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto anonymous = c.Post("/v1/secrets", nlohmann::json{{"name", "payments-db"}, {"material", kMaterial}}.dump(), "Content-Type", "application/json");
  ctx.Equal(anonymous.Status, 401, "a create without X-Operator-Id");
  const auto first = created(ctx, create(c, "payments-db"), "POST /v1/secrets");
  const auto second = created(ctx, create(c, "payments-db"), "a second POST /v1/secrets for the same name");
  ctx.Assert(first.value("name", "") == "payments-db" && first.value("version_id", "") == "v1", "the first create must answer name payments-db and version_id v1, got %s", first.dump());
  ctx.Equal(second.value("version_id", ""), "v2", "the second create's version_id");
  const auto stored = vault::getVersion("payments-db", "v1");
  ctx.Assert(stored && stored->material == kMaterial, "the vault must hold version v1 with its material");
}

void CheckMaterialSealed(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = create(c, "payments-db", {{"rotation_seconds", 3600}});
  const auto body = created(ctx, r, "POST /v1/secrets");
  ctx.Assert(!body.contains("material"), "the 201 body carries the material: %s. Answer publicVersion(record): ids, fingerprint and window only", r.Text());
  ctx.Assert(r.Text().find(kMaterial) == std::string::npos, "the 201 body carries the material under another name: %s", r.Text());
  ctx.Equal(body.value("fingerprint", ""), vault::fingerprint(kMaterial), "the 201 body must carry the SHA-256 fingerprint");
  for (const std::string field : {"name", "version_id", "rotation_seconds", "created_at", "rotate_at"}) {
    ctx.Assert(body.contains(field), "the 201 body must carry %s, got %s", field, r.Text());
  }
}

void CheckAuditIdsOnly(harness::Ctx& ctx) {
  auto c = api(ctx);
  std::ostringstream logged;
  auto* out = std::cout.rdbuf(logged.rdbuf());
  auto* err = std::cerr.rdbuf(logged.rdbuf());
  auto* clog = std::clog.rdbuf(logged.rdbuf());
  const auto r = create(c, "payments-db");
  std::cout.rdbuf(out);
  std::cerr.rdbuf(err);
  std::clog.rdbuf(clog);
  created(ctx, r, "POST /v1/secrets");
  ctx.Assert(logged.str().find(kMaterial) == std::string::npos, "the material reached the logs: %q. The audit line carries the operator, the name, the version id and the fingerprint", logged.str());
  std::istringstream lines(logged.str());
  bool found = false;
  for (std::string line; std::getline(lines, line);) {
    found = found || (line.find("op-ana") != std::string::npos && line.find("v1") != std::string::npos);
  }
  ctx.Assert(found, "the create must write an audit line naming the operator and version v1, the logs hold %q", logged.str());
}

void CheckRotationPolicy(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto fallback = created(ctx, create(c, "default-interval"), "POST /v1/secrets without rotation_seconds");
  ctx.Equal(fallback.value("rotation_seconds", 0LL), 2592000LL, "a create without rotation_seconds must get the 30-day default");
  ctx.Equal(fallback.value("rotate_at", 0LL), fallback.value("created_at", 0LL) + 2592000, "rotate_at must be created_at + rotation_seconds");
  for (const long long bad : {0LL, 299LL, 7776001LL}) {
    const std::string name = "bad-" + std::to_string(bad);
    const auto r = create(c, name, {{"rotation_seconds", bad}});
    ctx.Equal(r.Status, 400, "rotation_seconds=%d (the interval lies within 300..7776000)", bad);
    ctx.Equal(vault::versions(name).size(), 0, "a create refused for rotation_seconds=%d still wrote a version; the versions", bad);
  }
  const auto hourly = created(ctx, create(c, "hourly", {{"rotation_seconds", 3600}}), "POST /v1/secrets with rotation_seconds=3600");
  ctx.Equal(hourly.value("rotate_at", 0LL), hourly.value("created_at", 0LL) + 3600, "rotate_at must be created_at + 3600");
}
`,
  },
  hints: [
    'Create a secret and read the 201 body: the material is in it, and in the audit line. Create one without an interval and its rotate_at equals its created_at.',
    'The handler answers the vault record itself, so every field the vault keeps leaves with it; the log line interpolates the request body; `or 0` turns a missing interval into "never due".',
    'Answer `public_version(record)` (name, version_id, fingerprint, rotation_seconds, created_at, rotate_at), log the fingerprint instead of the material, and default to `DEFAULT_ROTATION_SECONDS` with a 400 outside 300..7 776 000 before `create_version`.',
  ],
  debrief: `A projection is the fix because it fails closed: the response is built from the fields it names, so a field the vault adds tomorrow stays inside. The fingerprint is what lets everything downstream talk about a version, consumers proving which one they hold, events and dashboards, without anyone handing the material around. The audit line follows the same rule, since log pipelines are copied, indexed and kept far longer than any secret lives. The interval is checked before the write so a refused create leaves nothing behind. A production vault also encrypts the material under a key it does not store beside it, and keeps the audit log append-only in a separate account.`,
};
