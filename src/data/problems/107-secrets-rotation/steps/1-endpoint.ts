import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/secrets: material that never comes back out',
  concept: 'http',
  file: 'api',
  focus: ['ops', 'api', 'vault', 'db', 'audit'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the create endpoint: it
registers the route, parses the body and answers 201. It compiles, it serves the demo, and it hides
three production flaws — the material it hands back, the material it writes to the audit line, and
the rotation interval it never stores. Review it like the service owner, fix it, and prove the fix
with the checks below.

Implement \`POST /v1/secrets\` with body
\`{"name": "db-password", "material": "…", "rotation_seconds": 2592000}\`.

- The operator comes from the authenticated \`X-Operator-Id\` header; a missing operator is **401**.
- \`name\` matches \`^[a-z0-9][a-z0-9_-]{0,63}$\` (**400** otherwise).
- \`material\` is a non-empty string of at most **64 KiB** (\`1 << 16\` bytes) of UTF-8 — **400** when
  empty, **413** when larger.
- \`rotation_seconds\` is an integer from **300** to **7 776 000** (90 days) and defaults to
  **2 592 000** (30 days) — **400** otherwise. Every secret carries an interval: there is no
  "rotate never".
- The version id is server-generated and the **fingerprint** is the lowercase hex SHA-256 of the
  material, so a consumer can tell two versions apart without ever holding one.
- The **201** body is a projection of the version: \`name\`, \`version_id\`, \`fingerprint\`,
  \`rotation_seconds\`, \`rotate_at\`, and \`health\`. The material is written once and is never part
  of it.
- \`health\` is \`"overdue"\` once \`now >= rotate_at\` and \`"ok"\` before: a secret whose interval
  elapsed without a rotation must not keep reporting itself healthy.
- The audit line carries ids only — operator, name, version id, fingerprint. The material goes to
  the vault, never to a log sink that outlives the request.

**Failure mode the checks target.** Returning the material "for convenience caching" hands the
plaintext to every caller and every proxy that logs a response body. Logging it puts the same bytes
into the log pipeline with a longer retention than the secret has. And a version created with no
rotation interval is a secret that lives for years: nothing ever schedules its rotation, and nothing
can tell that it is overdue.`,
  sequence: {
    participants: ['Operator', 'Secrets API', 'Vault', 'audit log'],
    messages: [
      {from: 'Operator', to: 'Secrets API', label: 'POST /v1/secrets · X-Operator-Id', kind: 'sync'},
      {from: 'Secrets API', to: 'Secrets API', label: 'validate name · material cap · rotation interval', kind: 'sync'},
      {from: 'Secrets API', to: 'Vault', label: 'write material once', kind: 'sync'},
      {from: 'Vault', to: 'Secrets API', label: 'stored', kind: 'reply'},
      {from: 'Secrets API', to: 'audit log', label: 'secret.created · ids only', kind: 'async'},
      {from: 'Secrets API', to: 'Operator', label: '201 {version_id, fingerprint, rotate_at, health}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'create',
      title: 'Registers POST /v1/secrets',
      detail: 'The create route exists on `POST /v1/secrets`; every other check builds on it.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/secrets["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/secrets['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/secrets"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"secrets"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/secrets"/]},
      },
    },
    {
      id: 'material-sealed',
      title: 'The 201 body never carries material',
      detail:
        'The response is built by a `publicVersion`/`public_version` projection carrying `version_id`, `fingerprint`, `rotate_at` and `health` — never the material. The draft returns `material` in the create response, so the plaintext leaves the vault on the first call.',
      match: {
        python: {
          all: [/def public_version\(/, /fingerprint\(/, /status_code\s*=\s*201/],
          none: [/JSONResponse\(\s*\{[^}]*["']material["']/],
        },
        typescript: {
          all: [/function publicVersion\(/, /fingerprint\(/, /code\(\s*201\s*\)/],
          none: [/code\(\s*201\s*\)\.send\([^)]*material/],
        },
        go: {
          all: [/func publicVersion\(/, /fingerprint\(/, /StatusCreated/],
          none: [/StatusCreated[\s\S]{0,120}?"material"/],
        },
        scala: {
          all: [/def publicVersion\(/, /fingerprint\(/, /StatusCodes\.Created/],
          none: [/StatusCodes\.Created[\s\S]{0,120}?material/],
        },
        cpp: {
          all: [/publicVersion\(/, /fingerprint\(/, /\b201\b/],
          none: [/\{\s*"material"/],
        },
      },
    },
    {
      id: 'audit-ids-only',
      title: 'The audit line carries ids, not the material',
      detail:
        'The create is logged with operator, name, version id and fingerprint. The draft logs the material itself, shipping tenant secrets into a pipeline whose retention outlives them.',
      match: {
        python: {all: [/logger\.info\(/], none: [/logger\.\w+\([^)]*material/]},
        typescript: {all: [/\.log\.info\(/], none: [/log\.\w+\([^)]*material/]},
        go: {all: [/log\.Printf\(/], none: [/log\.\w+\([^)]*[Mm]aterial/]},
        scala: {all: [/log\.info\(/], none: [/log\.info\([^\n]*material/]},
        cpp: {all: [/(std::)?(cerr|clog)\s*<</], none: [/(std::)?(cerr|clog)[^;]*material/]},
      },
    },
    {
      id: 'rotation-policy',
      title: 'Every secret carries a bounded rotation interval',
      detail:
        'The interval defaults to 30 days and is rejected outside 300..7 776 000 seconds (**400**). The draft accepts no interval at all, so secrets are created with no rotation policy and live for years.',
      match: {
        python: {
          all: [/DEFAULT_ROTATION_SECONDS/, /MIN_ROTATION_SECONDS/, /MAX_ROTATION_SECONDS/, /status_code\s*=\s*400/],
        },
        typescript: {
          all: [/DEFAULT_ROTATION_SECONDS/, /MIN_ROTATION_SECONDS/, /MAX_ROTATION_SECONDS/, /code\(\s*400\s*\)/],
        },
        go: {all: [/defaultRotationSeconds/, /minRotationSeconds/, /maxRotationSeconds/, /StatusBadRequest/]},
        scala: {
          all: [/DefaultRotationSeconds/, /MinRotationSeconds/, /MaxRotationSeconds/, /StatusCodes\.BadRequest/],
        },
        cpp: {all: [/kDefaultRotationSeconds/, /kMinRotationSeconds/, /kMaxRotationSeconds/, /\b400\b/]},
      },
    },
    {
      id: 'health-overdue',
      title: 'An elapsed interval raises the health state',
      detail:
        'Health is derived from the interval — `healthOf(rotate_at, now)` answers `"overdue"` once the interval has elapsed — and the create response reports it. The draft reports no health at all, so an unrotated secret looks exactly like a fresh one.',
      match: {
        python: {all: [/def health_of\(/, /"overdue"/]},
        typescript: {all: [/function healthOf\(/, /'overdue'/]},
        go: {all: [/func healthOf\(/, /"overdue"/]},
        scala: {all: [/def healthOf\(/, /"overdue"/]},
        cpp: {all: [/healthOf\(/, /"overdue"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("secrets")


class CreateSecret(BaseModel):
    name: str
    material: str
    rotation_seconds: int | None = None


class VersionStore:
    def put(self, name: str, version_id: str, material: str, fp: str, rotate_at: float) -> None:
        """Write the version: the material is written once and never read back by the API."""
        raise NotImplementedError


store = VersionStore()


@app.post("/v1/secrets")
def create_secret(body: CreateSecret, operator: str = Header(default="", alias="X-Operator-Id")) -> JSONResponse:
    # TODO: this draft returns the material "for convenience caching", logs it in the audit line,
    # and stores no rotation interval. Review all three, then check the response, the log and the policy.
    version_id = str(uuid.uuid4())
    logger.info("secret.created operator=%s name=%s version=%s material=%r", operator, body.name, version_id, body.material)
    store.put(body.name, version_id, body.material, "", 0.0)
    return JSONResponse(
        {"name": body.name, "version_id": version_id, "material": body.material},
        status_code=201,
    )
`,
      solution: `import hashlib
import logging
import re
import time
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("secrets")

MAX_MATERIAL_BYTES = 1 << 16
MIN_ROTATION_SECONDS = 300
MAX_ROTATION_SECONDS = 7_776_000
DEFAULT_ROTATION_SECONDS = 2_592_000
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class CreateSecret(BaseModel):
    name: str
    material: str
    rotation_seconds: int | None = None


class VersionStore:
    def put(self, name: str, version_id: str, material: str, fp: str, rotate_at: float) -> None:
        """Write the version: the material is written once and never read back by the API."""
        raise NotImplementedError


store = VersionStore()


def fingerprint(material: str) -> str:
    """SHA-256 of the material: consumers compare versions without ever holding the material."""
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def health_of(rotate_at: float, now: float) -> str:
    """A secret whose interval elapsed without a rotation is overdue, not quietly healthy."""
    return "overdue" if now >= rotate_at else "ok"


def public_version(name: str, version_id: str, fp: str, rotation_seconds: int, rotate_at: float) -> dict:
    """The only shape a version may leave the service in: ids, a fingerprint, the interval and health."""
    return {
        "name": name,
        "version_id": version_id,
        "fingerprint": fp,
        "rotation_seconds": rotation_seconds,
        "rotate_at": rotate_at,
        "health": health_of(rotate_at, time.time()),
    }


@app.post("/v1/secrets")
def create_secret(
    body: CreateSecret,
    operator: str | None = Header(default=None, alias="X-Operator-Id"),
) -> JSONResponse:
    if operator is None or operator == "":
        raise HTTPException(status_code=401, detail="missing X-Operator-Id")
    if NAME_PATTERN.match(body.name) is None:
        raise HTTPException(status_code=400, detail="name must be 1..64 chars of [a-z0-9_-]")
    if body.material == "":
        raise HTTPException(status_code=400, detail="material must be a non-empty string")
    if len(body.material.encode("utf-8")) > MAX_MATERIAL_BYTES:
        raise HTTPException(status_code=413, detail="material exceeds 64 KiB")
    rotation_seconds = body.rotation_seconds if body.rotation_seconds is not None else DEFAULT_ROTATION_SECONDS
    if not MIN_ROTATION_SECONDS <= rotation_seconds <= MAX_ROTATION_SECONDS:
        raise HTTPException(status_code=400, detail="rotation_seconds must be 300..7776000")

    version_id = str(uuid.uuid4())
    fp = fingerprint(body.material)
    rotate_at = time.time() + rotation_seconds
    store.put(body.name, version_id, body.material, fp, rotate_at)
    logger.info(
        "secret.created operator=%s name=%s version=%s fingerprint=%s",
        operator,
        body.name,
        version_id,
        fp,
    )
    return JSONResponse(public_version(body.name, version_id, fp, rotation_seconds, rotate_at), status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/secrets: a model-generated draft that hands the material back to the caller. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface CreateBody {
  name: string;
  material: string;
  rotation_seconds?: number;
}

app.post('/v1/secrets', async (request, reply) => {
  const operator = request.headers['x-operator-id'];
  const body = request.body as CreateBody;
  // TODO: this draft returns the material "for convenience caching", logs it in the audit line,
  // and stores no rotation interval. Review all three.
  const versionId = randomUUID();
  request.log.info({operator, name: body.name, version: versionId, material: body.material}, 'secret.created');
  return reply.code(201).send({name: body.name, version_id: versionId, material: body.material});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/secrets: material written once, ids and a fingerprint on the way out. */
import {createHash, randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './secret_store';

export const app = Fastify();

const MAX_MATERIAL_BYTES = 1 << 16;
const MIN_ROTATION_SECONDS = 300;
const MAX_ROTATION_SECONDS = 7_776_000;
const DEFAULT_ROTATION_SECONDS = 2_592_000;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface CreateBody {
  name: string;
  material: string;
  rotation_seconds?: number;
}

interface PublicVersion {
  name: string;
  version_id: string;
  fingerprint: string;
  rotation_seconds: number;
  rotate_at: number;
  health: string;
}

function fingerprint(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

function healthOf(rotateAt: number, now: number): string {
  return now >= rotateAt ? 'overdue' : 'ok';
}

function publicVersion(
  name: string,
  versionId: string,
  fp: string,
  rotationSeconds: number,
  rotateAt: number,
): PublicVersion {
  return {
    name,
    version_id: versionId,
    fingerprint: fp,
    rotation_seconds: rotationSeconds,
    rotate_at: rotateAt,
    health: healthOf(rotateAt, Date.now()),
  };
}

app.post('/v1/secrets', async (request, reply) => {
  const operator = request.headers['x-operator-id'];
  if (typeof operator !== 'string' || operator === '')
    return reply.code(401).send({error: 'missing X-Operator-Id'});

  const body = request.body as Partial<CreateBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.name !== 'string')
    return reply.code(400).send({error: 'name is required'});
  if (!NAME_PATTERN.test(body.name))
    return reply.code(400).send({error: 'name must be 1..64 chars of [a-z0-9_-]'});
  if (typeof body.material !== 'string' || body.material === '')
    return reply.code(400).send({error: 'material must be a non-empty string'});
  if (Buffer.byteLength(body.material, 'utf8') > MAX_MATERIAL_BYTES)
    return reply.code(413).send({error: 'material exceeds 64 KiB'});

  const rotationSeconds = body.rotation_seconds ?? DEFAULT_ROTATION_SECONDS;
  if (
    !Number.isInteger(rotationSeconds) ||
    rotationSeconds < MIN_ROTATION_SECONDS ||
    rotationSeconds > MAX_ROTATION_SECONDS
  )
    return reply.code(400).send({error: 'rotation_seconds must be 300..7776000'});

  const versionId = randomUUID();
  const fp = fingerprint(body.material);
  const rotateAt = Date.now() + rotationSeconds * 1000;
  await store.put({name: body.name, version_id: versionId, material: body.material, fingerprint: fp, rotate_at: rotateAt});
  request.log.info({operator, name: body.name, version: versionId, fingerprint: fp}, 'secret.created');
  return reply.code(201).send(publicVersion(body.name, versionId, fp, rotationSeconds, rotateAt));
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type CreateSecret struct {
	Name            string \`json:"name"\`
	Material        string \`json:"material"\`
	RotationSeconds *int   \`json:"rotation_seconds"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createSecret(rw http.ResponseWriter, r *http.Request) {
	operator := r.Header.Get("X-Operator-Id")
	var body CreateSecret
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft returns the material "for convenience caching", logs it in the audit line,
	// and stores no rotation interval. Review all three.
	versionID := newVersionID()
	log.Printf("secret.created operator=%s name=%s version=%s material=%q", operator, body.Name, versionID, body.Material)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"name":       body.Name,
		"version_id": versionID,
		"material":   body.Material,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/secrets", createSecret)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"time"
)

const (
	maxMaterialBytes       = 1 << 16
	minRotationSeconds     = 300
	maxRotationSeconds     = 7_776_000
	defaultRotationSeconds = 2_592_000
)

var namePattern = regexp.MustCompile("^[a-z0-9][a-z0-9_-]{0,63}$")

type CreateSecret struct {
	Name            string \`json:"name"\`
	Material        string \`json:"material"\`
	RotationSeconds *int   \`json:"rotation_seconds"\`
}

type VersionStore struct{}

// Put writes the material once; nothing in this service ever reads it back.
func (s *VersionStore) Put(name, versionID, material, fp string, rotateAt int64) error { return nil }

var store = &VersionStore{}

func newVersionID() string { return "" }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// fingerprint is the SHA-256 of the material: consumers compare versions without holding one.
func fingerprint(material string) string {
	sum := sha256.Sum256([]byte(material))
	return hex.EncodeToString(sum[:])
}

// healthOf reports a secret whose rotation interval elapsed as overdue, not as healthy.
func healthOf(rotateAt, now int64) string {
	if now >= rotateAt {
		return "overdue"
	}
	return "ok"
}

func publicVersion(name, versionID, fp string, rotationSeconds int, rotateAt int64) map[string]any {
	return map[string]any{
		"name":             name,
		"version_id":       versionID,
		"fingerprint":      fp,
		"rotation_seconds": rotationSeconds,
		"rotate_at":        rotateAt,
		"health":           healthOf(rotateAt, time.Now().Unix()),
	}
}

func createSecret(rw http.ResponseWriter, r *http.Request) {
	operator := r.Header.Get("X-Operator-Id")
	if operator == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Operator-Id"})
		return
	}
	var body CreateSecret
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !namePattern.MatchString(body.Name) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "name must be 1..64 chars of [a-z0-9_-]"})
		return
	}
	if body.Material == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "material must be a non-empty string"})
		return
	}
	if len([]byte(body.Material)) > maxMaterialBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "material exceeds 64 KiB"})
		return
	}
	rotationSeconds := defaultRotationSeconds
	if body.RotationSeconds != nil {
		rotationSeconds = *body.RotationSeconds
	}
	if rotationSeconds < minRotationSeconds || rotationSeconds > maxRotationSeconds {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "rotation_seconds must be 300..7776000"})
		return
	}

	versionID := newVersionID()
	fp := fingerprint(body.Material)
	rotateAt := time.Now().Unix() + int64(rotationSeconds)
	if err := store.Put(body.Name, versionID, body.Material, fp, rotateAt); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("secret.created operator=%s name=%s version=%s fingerprint=%s", operator, body.Name, versionID, fp)
	writeJSON(rw, http.StatusCreated, publicVersion(body.Name, versionID, fp, rotationSeconds, rotateAt))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/secrets", createSecret)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CreateSecret(name: String, material: String, rotation_seconds: Option[Int])

object SecretApi {
  implicit val system: ActorSystem = ActorSystem("secrets-api")
  implicit val createFormat: RootJsonFormat[CreateSecret] = jsonFormat3(CreateSecret)

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }

  val store = VersionStore.open()

  val route: Route =
    path("v1" / "secrets") {
      post {
        optionalHeaderValueByName("X-Operator-Id") { operatorOpt =>
          entity(as[CreateSecret]) { body =>
            // TODO: this draft returns the material "for convenience caching", logs it in the audit
            // line, and stores no rotation interval. Review all three.
            val versionId = UUID.randomUUID().toString
            val createdAt = Instant.now().getEpochSecond
            system.log.info(s"secret.created operator=\${operatorOpt.getOrElse("")} name=\${body.name} version=$versionId material=\${body.material}")
            store.put(body.name, versionId, body.material, "", createdAt)
            complete(StatusCodes.Created, s"""{"name":"\${body.name}","version_id":"$versionId","material":"\${body.material}"}""")
          }
        }
      }
    }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CreateSecret(name: String, material: String, rotation_seconds: Option[Int])
final case class PublicVersion(
    name: String,
    version_id: String,
    fingerprint: String,
    rotation_seconds: Int,
    rotate_at: Long,
    health: String,
)

object SecretApi {
  implicit val system: ActorSystem = ActorSystem("secrets-api")
  implicit val createFormat: RootJsonFormat[CreateSecret] = jsonFormat3(CreateSecret)
  implicit val publicFormat: RootJsonFormat[PublicVersion] = jsonFormat6(PublicVersion)

  val MaxMaterialBytes = 1 << 16
  val MinRotationSeconds = 300
  val MaxRotationSeconds = 7776000
  val DefaultRotationSeconds = 2592000
  val NamePattern = "^[a-z0-9][a-z0-9_-]{0,63}$".r

  val store = VersionStore.open()

  // SHA-256 of the material: consumers compare versions without ever holding the material.
  def fingerprint(material: String): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(material.getBytes(StandardCharsets.UTF_8))
      .map(b => "%02x".format(b))
      .mkString

  // A secret whose interval elapsed without a rotation is overdue, not quietly healthy.
  def healthOf(rotateAt: Long, now: Long): String = if (now >= rotateAt) "overdue" else "ok"

  def publicVersion(name: String, versionId: String, fp: String, rotationSeconds: Int, rotateAt: Long): PublicVersion =
    PublicVersion(name, versionId, fp, rotationSeconds, rotateAt, healthOf(rotateAt, Instant.now().getEpochSecond))

  val route: Route =
    path("v1" / "secrets") {
      post {
        optionalHeaderValueByName("X-Operator-Id") { operatorOpt =>
          entity(as[CreateSecret]) { body =>
            if (!operatorOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Operator-Id"}""")
            } else if (NamePattern.findFirstIn(body.name).isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"name must be 1..64 chars of [a-z0-9_-]"}""")
            } else if (body.material.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"material must be a non-empty string"}""")
            } else if (body.material.getBytes(StandardCharsets.UTF_8).length > MaxMaterialBytes) {
              complete(StatusCodes.RequestEntityTooLarge, """{"error":"material exceeds 64 KiB"}""")
            } else {
              val rotationSeconds = body.rotation_seconds.getOrElse(DefaultRotationSeconds)
              if (rotationSeconds < MinRotationSeconds || rotationSeconds > MaxRotationSeconds) {
                complete(StatusCodes.BadRequest, """{"error":"rotation_seconds must be 300..7776000"}""")
              } else {
                val operator = operatorOpt.get
                val versionId = UUID.randomUUID().toString
                val fp = fingerprint(body.material)
                val rotateAt = Instant.now().getEpochSecond + rotationSeconds
                store.put(body.name, versionId, body.material, fp, rotateAt)
                system.log.info(s"secret.created operator=$operator name=\${body.name} version=$versionId fingerprint=$fp")
                complete(StatusCodes.Created, publicVersion(body.name, versionId, fp, rotationSeconds, rotateAt))
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

#include <iostream>
#include <string>

using json = nlohmann::json;

std::string newVersionId();
long nowSeconds();

struct VersionStore {
  void put(const std::string& name, const std::string& versionId, const std::string& material,
           const std::string& fp, long rotateAt);
};

VersionStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/secrets", [](const httplib::Request& req, httplib::Response& res) {
    const auto operatorId = req.get_header_value("X-Operator-Id");
    const auto body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft returns the material "for convenience caching", logs it in the audit line,
    // and stores no rotation interval. Review all three.
    const auto name = body.value("name", std::string());
    const auto material = body.value("material", std::string());
    const auto versionId = newVersionId();
    store.put(name, versionId, material, "", 0);
    std::cerr << "secret.created operator=" << operatorId << " name=" << name << " version=" << versionId
              << " material=" << material << "\\n";
    res.status = 201;
    res.set_content(
        json{{"name", name}, {"version_id", versionId}, {"material", material}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <regex>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxMaterialBytes = 1 << 16;
constexpr long kMinRotationSeconds = 300;
constexpr long kMaxRotationSeconds = 7776000;
constexpr long kDefaultRotationSeconds = 2592000;

std::string newVersionId();
long nowSeconds();

struct VersionStore {
  void put(const std::string& name, const std::string& versionId, const std::string& material,
           const std::string& fp, long rotateAt);
};

VersionStore store;

// SHA-256 of the material: consumers compare versions without ever holding the material.
std::string fingerprint(const std::string& material);

// A secret whose interval elapsed without a rotation is overdue, not quietly healthy.
std::string healthOf(long rotateAt, long now) {
  return now >= rotateAt ? "overdue" : "ok";
}

json publicVersion(const std::string& name, const std::string& versionId, const std::string& fp,
                   long rotationSeconds, long rotateAt) {
  return {
      {"name", name},
      {"version_id", versionId},
      {"fingerprint", fp},
      {"rotation_seconds", rotationSeconds},
      {"rotate_at", rotateAt},
      {"health", healthOf(rotateAt, nowSeconds())},
  };
}

int main() {
  httplib::Server svr;
  const std::regex namePattern("^[a-z0-9][a-z0-9_-]{0,63}$");

  svr.Post("/v1/secrets", [&namePattern](const httplib::Request& req, httplib::Response& res) {
    const auto operatorId = req.get_header_value("X-Operator-Id");
    if (operatorId.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Operator-Id"})", "application/json");
      return;
    }
    const auto body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("name") || !body["name"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"name is required"})", "application/json");
      return;
    }
    const auto name = body["name"].get<std::string>();
    if (!std::regex_match(name, namePattern)) {
      res.status = 400;
      res.set_content(R"({"error":"name must be 1..64 chars of [a-z0-9_-]"})", "application/json");
      return;
    }
    const auto material = body.value("material", std::string());
    if (material.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"material must be a non-empty string"})", "application/json");
      return;
    }
    if (material.size() > kMaxMaterialBytes) {
      res.status = 413;
      res.set_content(R"({"error":"material exceeds 64 KiB"})", "application/json");
      return;
    }
    const long rotationSeconds = body.value("rotation_seconds", kDefaultRotationSeconds);
    if (rotationSeconds < kMinRotationSeconds || rotationSeconds > kMaxRotationSeconds) {
      res.status = 400;
      res.set_content(R"({"error":"rotation_seconds must be 300..7776000"})", "application/json");
      return;
    }

    const auto versionId = newVersionId();
    const auto fp = fingerprint(material);
    const long rotateAt = nowSeconds() + rotationSeconds;
    store.put(name, versionId, material, fp, rotateAt);
    std::cerr << "secret.created operator=" << operatorId << " name=" << name << " version=" << versionId
              << " fingerprint=" << fp << "\\n";
    res.status = 201;
    res.set_content(publicVersion(name, versionId, fp, rotationSeconds, rotateAt).dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the response first: `public_version` / `publicVersion` is the only projection of a version, and it takes the fingerprint and the interval, never the material. Once that function exists, an accidental `material` field in a handler is visible in review.',
    'The interval is not decoration: default it (30 days), bound it (300 s .. 90 days), and derive `health` from `rotate_at` versus now. A version with no interval can never be overdue, which is how a secret ends up live for years without anyone noticing.',
    'The audit line is a contract with the log pipeline: operator, name, version id, fingerprint. If you need the material for debugging, you need a fingerprint — the SHA-256 identifies the version and leaks nothing, and the vault is the only place the bytes live.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the one boundary that matters for secrets: what leaves the service. Three defects are being checked, and only the first is obvious in the diff. The create response must carry a projection — version id, fingerprint, rotate_at, health — because a response body is copied into proxies, client caches and error reports; the material must be written once and read never. The audit line is the second: a log line is retained, replicated and shipped to a provider, so it may carry ids but never the bytes. The third is the one candidates skip entirely — the rotation interval. A secret with no interval is a secret with an infinite lifetime, and health that cannot become overdue cannot page anyone. Real secret stores add per-version TTLs enforced by a scheduler, a re-wrap path for the material at rest, and a fingerprint index so consumers can prove which version they hold.`,
};
