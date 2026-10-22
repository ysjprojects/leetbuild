import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/sandbox/jobs: code that declares what it needs',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and answers \`202 queued\`, so the demo submits a job. It trusts everything the caller says.
Review it like the platform owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/sandbox/jobs\` with body
\`{"code": "…", "entry_point": "main.py", "profile": "gvisor", "needs": ["filesystem"]}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`code\` is required and at most **256 KiB** (\`1 << 18\` bytes) of UTF-8 — a larger body is
  **413**. The platform runs whatever it is handed, so the cap is enforced before anything else
  happens.
- \`profile\` must come from the **allowlist** of isolation profiles (\`runc\`, \`gvisor\`,
  \`kata\`); anything else is **400**. The caller asks for a strength, it does not name a runtime.
- \`needs\` is the capability model: the job **declares** what it wants, the profile determines what
  is granted. Every declared capability must be both known (\`network\`, \`filesystem\`,
  \`subprocess\`) and granted by the requested profile — anything undeclared or ungranted is
  **400**. Capabilities are default-deny: an empty \`needs\` gets nothing extra, and the weak
  \`runc\` profile never grants \`network\`.
- \`Idempotency-Key\` is required (**400** when missing). The stored job is looked up **before** a
  new one is created, so a client retry returns the **original job id** and the code is not
  submitted twice.
- Never echo the code back in the response or a log line; the response carries the job id, the
  profile and a digest of the code.

**Failure mode the checks target.** The draft accepts any profile string, treats an undeclared
\`network\` need as allowed, and keys nothing, so a retried submit queues the body again. The
capability half is the quiet one: "the job said it needed the network" is not a permission, it is a
request, and the profile is the thing that decides.`,
  sequence: {
    participants: ['Client', 'Sandbox API', 'job store'],
    messages: [
      {from: 'Client', to: 'Sandbox API', label: 'POST /v1/sandbox/jobs · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Sandbox API', to: 'Sandbox API', label: 'validate tenant · size · profile · capabilities', kind: 'sync'},
      {from: 'Sandbox API', to: 'job store', label: 'lookup(tenant, idem_key)', kind: 'sync'},
      {from: 'job store', to: 'Sandbox API', label: 'stored job / none', kind: 'reply'},
      {from: 'Sandbox API', to: 'job store', label: 'create(tenant, idem_key, job · code_digest)', kind: 'async'},
      {from: 'Sandbox API', to: 'Client', label: '202 {job_id, profile, status}', kind: 'reply'},
    ],
  },
  hints: [
    'Order the rejections: tenant (401), then the size cap (413), then the profile allowlist (400), then the capabilities. A rule that runs after the work starts is not a rule — the code cap in particular must be checked against the byte length of the UTF-8 body, not the character count.',
    'Capabilities are default-deny in two directions: the requested profile must grant each declared need, **and** the need must be in the platform’s capability vocabulary. `runc` grants only `subprocess`, so `needs: ["filesystem"]` under `runc` is a 400, not a silent grant — and an empty `needs` never means "anything".',
    'Key the submit on `(tenant, Idempotency-Key)`: look the job up first and return it when it exists; only create a new one when it does not. That is what makes the client’s retry safe, and it keeps the code digest stable instead of queueing the same body twice.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/sandbox/jobs',
      detail: 'Register the submission route on `POST /v1/sandbox/jobs`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/sandbox\/jobs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/sandbox\/jobs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/sandbox\/jobs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"sandbox"\s*\/\s*"jobs"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/sandbox\/jobs"/]},
      },
    },
    {
      id: 'code-cap',
      title: 'Caps the submitted code at 256 KiB',
      detail:
        'A body over `1 << 18` bytes is **413** before anything is stored. The draft accepts any size, so the platform hands the container service an arbitrarily large program.',
      match: {
        python: {all: [/MAX_CODE_BYTES\s*=\s*1\s*<<\s*18/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_CODE_BYTES\s*=\s*1\s*<<\s*18/, /code\(\s*413\s*\)/]},
        go: {all: [/maxCodeBytes\s*=\s*1\s*<<\s*18/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxCodeBytes\s*=\s*1\s*<<\s*18/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxCodeBytes\s*=\s*1\s*<<\s*18/, /\b413\b/]},
      },
    },
    {
      id: 'profile-allowlist',
      title: 'Rejects an unknown isolation profile',
      detail:
        '`profile` is checked against the allowlist and an unknown value is **400** — the caller picks a strength, not a runtime. The draft stores whatever profile string arrives and reports it back.',
      match: {
        python: {all: [/ALLOWED_PROFILES/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_PROFILES/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedProfiles/, /StatusBadRequest/]},
        scala: {all: [/AllowedProfiles/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedProfiles/, /\b400\b/]},
      },
    },
    {
      id: 'capability-deny',
      title: 'Capabilities are default-deny against the profile',
      detail:
        'Each declared need must be a known capability **and** granted by the requested profile; otherwise **400**. The draft treats an undeclared request for the network as allowed, which is exactly how a job reaches the metadata service.',
      match: {
        python: {all: [/ALLOWED_CAPABILITIES/, /PROFILE_CAPABILITIES/]},
        typescript: {all: [/ALLOWED_CAPABILITIES/, /PROFILE_CAPABILITIES/]},
        go: {all: [/allowedCapabilities/, /profileCapabilities/]},
        scala: {all: [/AllowedCapabilities/, /ProfileCapabilities/]},
        cpp: {all: [/kAllowedCapabilities/, /kProfileCapabilities/]},
      },
    },
    {
      id: 'idempotent-replay',
      title: 'Replays return the original job id',
      detail:
        '`Idempotency-Key` is required, the stored job is looked up before a new one is created, and a replay answers with the original job id instead of queueing the code again. The draft ignores the header and re-executes the whole job on every retry.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.lookup\(/], order: [/store\.lookup\(/, /store\.create\(/]},
        typescript: {all: [/idempotency-key/, /store\.lookup\(/], order: [/store\.lookup\(/, /store\.create\(/]},
        go: {all: [/Idempotency-Key/, /store\.Lookup\(/], order: [/store\.Lookup\(/, /store\.Create\(/]},
        scala: {all: [/Idempotency-Key/, /store\.lookup\(/], order: [/store\.lookup\(/, /store\.create\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.lookup\(/], order: [/store\.lookup\(/, /store\.create\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("sandbox")


class JobRequest(BaseModel):
    code: str
    entry_point: str = "main.py"
    profile: str = "runc"
    needs: list[str] = []


class JobStore:
    def create(self, tenant: str, idem_key: str, job: dict) -> None:
        """Queue the job under (tenant, idem_key)."""
        raise NotImplementedError


store = JobStore()


@app.post("/v1/sandbox/jobs")
def submit(body: JobRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: enforce the 256 KiB code cap, validate the profile against an allowlist, deny
    # capabilities the requested profile does not grant, and replay on (tenant, Idempotency-Key).
    job_id = "job-" + str(abs(hash(body.code)))
    logger.info("sandbox submit tenant=%s code=%r", tenant, body.code)
    return JSONResponse(
        {"job_id": job_id, "profile": body.profile, "needs": body.needs, "status": "queued"},
        status_code=202,
    )
`,
      solution: `import hashlib
import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("sandbox")

MAX_CODE_BYTES = 1 << 18
ALLOWED_PROFILES = {"runc", "gvisor", "kata"}
ALLOWED_CAPABILITIES = {"network", "filesystem", "subprocess"}
PROFILE_CAPABILITIES = {
    "runc": {"subprocess"},
    "gvisor": {"subprocess", "filesystem"},
    "kata": {"subprocess", "filesystem", "network"},
}


class JobRequest(BaseModel):
    code: str
    entry_point: str = "main.py"
    profile: str = "runc"
    needs: list[str] = []


class JobStore:
    def lookup(self, tenant: str, idem_key: str) -> dict | None:
        """The job stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def create(self, tenant: str, idem_key: str, job: dict) -> None:
        """Queue the job under (tenant, idem_key)."""
        raise NotImplementedError


store = JobStore()


def ungranted(profile: str, needs: list[str]) -> list[str]:
    granted = PROFILE_CAPABILITIES[profile]
    return [need for need in needs if need not in ALLOWED_CAPABILITIES or need not in granted]


@app.post("/v1/sandbox/jobs")
def submit(
    body: JobRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    code_bytes = body.code.encode("utf-8")
    if len(code_bytes) > MAX_CODE_BYTES:
        raise HTTPException(status_code=413, detail="code exceeds 256 KiB")
    if body.profile not in ALLOWED_PROFILES:
        raise HTTPException(status_code=400, detail="unknown isolation profile")
    denied = ungranted(body.profile, body.needs)
    if denied:
        raise HTTPException(status_code=400, detail=f"capability not granted: {','.join(denied)}")

    stored = store.lookup(tenant, idem_key)
    if stored is not None:
        return stored

    job = {
        "job_id": uuid.uuid4().hex,
        "tenant": tenant,
        "entry_point": body.entry_point,
        "profile": body.profile,
        "capabilities": sorted(body.needs),
        "code_digest": hashlib.sha256(code_bytes).hexdigest(),
        "status": "queued",
    }
    store.create(tenant, idem_key, job)
    logger.info("sandbox submit tenant=%s job=%s profile=%s", tenant, job["job_id"], job["profile"])
    return job
`,
    },
    typescript: {
      starter: `/** POST /v1/sandbox/jobs: a model-generated draft that believes whatever the caller declares. */
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';

import {store} from './job_store';

export const app = Fastify();

interface JobBody {
  code: string;
  entry_point?: string;
  profile?: string;
  needs?: string[];
}

app.post('/v1/sandbox/jobs', async (request, reply) => {
  // TODO: enforce the 256 KiB code cap, validate the profile against an allowlist, deny
  // capabilities the requested profile does not grant, and replay on (tenant, Idempotency-Key).
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as JobBody;
  const job = {
    job_id: randomUUID(),
    tenant,
    profile: body.profile ?? 'runc',
    needs: body.needs ?? [],
    status: 'queued',
  };
  await store.create(tenant, body.code, job);
  request.log.info({tenant, code: body.code}, 'sandbox submit');
  return reply.code(202).send(job);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/sandbox/jobs: declarative submission — caps, allowlist, default-deny, replay. */
import Fastify from 'fastify';
import {createHash, randomUUID} from 'node:crypto';

import {store} from './job_store';

export const app = Fastify();

const MAX_CODE_BYTES = 1 << 18;
const ALLOWED_PROFILES = new Set(['runc', 'gvisor', 'kata']);
const ALLOWED_CAPABILITIES = new Set(['network', 'filesystem', 'subprocess']);
const PROFILE_CAPABILITIES: Record<string, Set<string>> = {
  runc: new Set(['subprocess']),
  gvisor: new Set(['subprocess', 'filesystem']),
  kata: new Set(['subprocess', 'filesystem', 'network']),
};

interface JobBody {
  code: string;
  entry_point?: string;
  profile?: string;
  needs?: string[];
}

function ungranted(profile: string, needs: string[]): string[] {
  const granted = PROFILE_CAPABILITIES[profile];
  return needs.filter(need => !ALLOWED_CAPABILITIES.has(need) || !granted.has(need));
}

app.post('/v1/sandbox/jobs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = request.body as Partial<JobBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.code !== 'string')
    return reply.code(400).send({error: 'code is required'});
  const profile = typeof body.profile === 'string' ? body.profile : 'runc';
  const needs = Array.isArray(body.needs) ? body.needs : [];
  if (Buffer.byteLength(body.code, 'utf8') > MAX_CODE_BYTES)
    return reply.code(413).send({error: 'code exceeds 256 KiB'});
  if (!ALLOWED_PROFILES.has(profile)) return reply.code(400).send({error: 'unknown isolation profile'});
  const denied = ungranted(profile, needs);
  if (denied.length > 0) return reply.code(400).send({error: \`capability not granted: \${denied.join(',')}\`});

  const stored = await store.lookup(tenant, idemKey);
  if (stored !== null) return reply.code(202).send(stored);

  const job = {
    job_id: randomUUID(),
    tenant,
    entry_point: body.entry_point ?? 'main.py',
    profile,
    capabilities: [...needs].sort(),
    code_digest: createHash('sha256').update(body.code, 'utf8').digest('hex'),
    status: 'queued',
  };
  await store.create(tenant, idemKey, job);
  request.log.info({tenant, job: job.job_id, profile}, 'sandbox submit');
  return reply.code(202).send(job);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
)

type JobRequest struct {
	Code       string   \`json:"code"\`
	EntryPoint string   \`json:"entry_point"\`
	Profile    string   \`json:"profile"\`
	Needs      []string \`json:"needs"\`
}

type JobStore struct{}

func (s *JobStore) Create(ctx context.Context, tenant, idemKey string, job map[string]any) error {
	return nil
}

var store = &JobStore{}

func submit(rw http.ResponseWriter, r *http.Request) {
	// TODO: enforce the 256 KiB code cap, validate the profile against an allowlist, deny
	// capabilities the requested profile does not grant, and replay on (tenant, Idempotency-Key).
	tenant := r.Header.Get("X-Tenant-Id")
	body := JobRequest{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	sum := sha256.Sum256([]byte(body.Code))
	job := map[string]any{
		"job_id":      "job-" + hex.EncodeToString(sum[:8]),
		"tenant":      tenant,
		"profile":     body.Profile,
		"needs":       body.Needs,
		"status":      "queued",
	}
	_ = store.Create(r.Context(), tenant, body.Code, job)
	log.Printf("sandbox submit tenant=%s code=%s", tenant, body.Code)
	writeJSON(rw, http.StatusAccepted, job)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sandbox/jobs", submit)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const maxCodeBytes = 1 << 18

var (
	allowedProfiles     = map[string]bool{"runc": true, "gvisor": true, "kata": true}
	allowedCapabilities = map[string]bool{"network": true, "filesystem": true, "subprocess": true}
	profileCapabilities = map[string]map[string]bool{
		"runc":   {"subprocess": true},
		"gvisor": {"subprocess": true, "filesystem": true},
		"kata":   {"subprocess": true, "filesystem": true, "network": true},
	}
)

type JobRequest struct {
	Code       string   \`json:"code"\`
	EntryPoint string   \`json:"entry_point"\`
	Profile    string   \`json:"profile"\`
	Needs      []string \`json:"needs"\`
}

type JobStore struct{}

func (s *JobStore) Lookup(ctx context.Context, tenant, idemKey string) (map[string]any, bool) {
	return nil, false
}

func (s *JobStore) Create(ctx context.Context, tenant, idemKey string, job map[string]any) error {
	return nil
}

var store = &JobStore{}

func ungranted(profile string, needs []string) []string {
	denied := []string{}
	for _, need := range needs {
		if !allowedCapabilities[need] || !profileCapabilities[profile][need] {
			denied = append(denied, need)
		}
	}
	return denied
}

func submit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	idemKey := r.Header.Get("Idempotency-Key")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	body := JobRequest{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Profile == "" {
		body.Profile = "runc"
	}
	if len([]byte(body.Code)) > maxCodeBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "code exceeds 256 KiB"})
		return
	}
	if !allowedProfiles[body.Profile] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown isolation profile"})
		return
	}
	if denied := ungranted(body.Profile, body.Needs); len(denied) > 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "capability not granted by profile"})
		return
	}
	if stored, ok := store.Lookup(r.Context(), tenant, idemKey); ok {
		writeJSON(rw, http.StatusAccepted, stored)
		return
	}
	sum := sha256.Sum256([]byte(body.Code))
	job := map[string]any{
		"job_id":      uuid.NewString(),
		"tenant":      tenant,
		"entry_point": body.EntryPoint,
		"profile":     body.Profile,
		"needs":       body.Needs,
		"code_digest": hex.EncodeToString(sum[:]),
		"status":      "queued",
	}
	if err := store.Create(r.Context(), tenant, idemKey, job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("sandbox submit tenant=%s job=%s profile=%s", tenant, job["job_id"], body.Profile)
	writeJSON(rw, http.StatusAccepted, job)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sandbox/jobs", submit)
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
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import java.util.UUID

final case class JobRequest(code: String, entry_point: String, profile: String, needs: List[String])

object SandboxApi {
  implicit val system: ActorSystem = ActorSystem("sandbox")
  implicit val jobFormat: RootJsonFormat[JobRequest] = jsonFormat4(JobRequest)

  val store = JobStore.open()

  val route: Route =
    path("v1" / "sandbox" / "jobs") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[JobRequest]) { body =>
            // TODO: enforce the 256 KiB code cap, validate the profile against an allowlist, deny
            // capabilities the requested profile does not grant, and replay on Idempotency-Key.
            val job = Map(
              "job_id" -> UUID.randomUUID().toString,
              "tenant" -> tenant,
              "profile" -> body.profile,
              "needs" -> body.needs
            )
            store.create(tenant, body.code, job)
            system.log.info(s"sandbox submit tenant=$tenant code=\${body.code}")
            complete(StatusCodes.Accepted, job.toJson.compactPrint)
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
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID

final case class JobRequest(code: String, entry_point: String, profile: String, needs: List[String])

object SandboxApi {
  implicit val system: ActorSystem = ActorSystem("sandbox")
  implicit val jobFormat: RootJsonFormat[JobRequest] = jsonFormat4(JobRequest)

  val MaxCodeBytes = 1 << 18
  val AllowedProfiles = Set("runc", "gvisor", "kata")
  val AllowedCapabilities = Set("network", "filesystem", "subprocess")
  val ProfileCapabilities = Map(
    "runc" -> Set("subprocess"),
    "gvisor" -> Set("subprocess", "filesystem"),
    "kata" -> Set("subprocess", "filesystem", "network")
  )

  val store = JobStore.open()

  def ungranted(profile: String, needs: List[String]): List[String] =
    needs.filterNot(need => AllowedCapabilities.contains(need) && ProfileCapabilities(profile).contains(need))

  def digest(code: String): String =
    MessageDigest.getInstance("SHA-256").digest(code.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString

  val route: Route =
    path("v1" / "sandbox" / "jobs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[JobRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.code.getBytes(StandardCharsets.UTF_8).length > MaxCodeBytes) {
                complete(StatusCodes.RequestEntityTooLarge, """{"error":"code exceeds 256 KiB"}""")
              } else if (!AllowedProfiles.contains(body.profile)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown isolation profile"}""")
              } else if (ungranted(body.profile, body.needs).nonEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"capability not granted by profile"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                store.lookup(tenant, idemKey) match {
                  case Some(stored) => complete(StatusCodes.Accepted, stored.toJson.compactPrint)
                  case None =>
                    val job = Map[String, Any](
                      "job_id" -> UUID.randomUUID().toString,
                      "tenant" -> tenant,
                      "entry_point" -> body.entry_point,
                      "profile" -> body.profile,
                      "capabilities" -> body.needs.sorted,
                      "code_digest" -> digest(body.code),
                      "status" -> "queued"
                    )
                    store.create(tenant, idemKey, job)
                    system.log.info(s"sandbox submit tenant=$tenant job=\${job("job_id")}")
                    complete(StatusCodes.Accepted, job.toJson.compactPrint)
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

#include <iostream>
#include <string>

using json = nlohmann::json;

struct JobStore {
  void create(const std::string& tenant, const std::string& idem_key, const json& job);
};

JobStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/sandbox/jobs", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: enforce the 256 KiB code cap, validate the profile against an allowlist, deny
    // capabilities the requested profile does not grant, and replay on (tenant, Idempotency-Key).
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const json job = {
        {"job_id", "job-1"},
        {"tenant", tenant},
        {"profile", body.value("profile", std::string("runc"))},
        {"needs", body.value("needs", json::array())},
        {"status", "queued"},
    };
    store.create(tenant, body.value("code", std::string()), job);
    std::cerr << "sandbox submit tenant=" << tenant << " code=" << body.value("code", std::string()) << std::endl;
    res.status = 202;
    res.set_content(job.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <openssl/sha.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iomanip>
#include <set>
#include <sstream>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxCodeBytes = 1 << 18;
const std::set<std::string> kAllowedProfiles = {"runc", "gvisor", "kata"};
const std::set<std::string> kAllowedCapabilities = {"network", "filesystem", "subprocess"};
const std::map<std::string, std::set<std::string>> kProfileCapabilities = {
    {"runc", {"subprocess"}},
    {"gvisor", {"subprocess", "filesystem"}},
    {"kata", {"subprocess", "filesystem", "network"}},
};

struct JobStore {
  std::optional<json> lookup(const std::string& tenant, const std::string& idem_key);
  void create(const std::string& tenant, const std::string& idem_key, const json& job);
};

JobStore store;

std::vector<std::string> ungranted(const std::string& profile, const std::vector<std::string>& needs) {
  std::vector<std::string> denied;
  const auto& granted = kProfileCapabilities.at(profile);
  for (const auto& need : needs) {
    if (kAllowedCapabilities.count(need) == 0 || granted.count(need) == 0) denied.push_back(need);
  }
  return denied;
}

std::string sha256Hex(const std::string& body) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(body.data()), body.size(), digest);
  std::ostringstream out;
  for (unsigned char byte : digest) out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
  return out.str();
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/sandbox/jobs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto code = body.value("code", std::string());
    const auto profile = body.value("profile", std::string("runc"));
    const auto needs = body.value("needs", std::vector<std::string>{});
    if (code.size() > kMaxCodeBytes) {
      res.status = 413;
      res.set_content(R"({"error":"code exceeds 256 KiB"})", "application/json");
      return;
    }
    if (kAllowedProfiles.count(profile) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown isolation profile"})", "application/json");
      return;
    }
    if (!ungranted(profile, needs).empty()) {
      res.status = 400;
      res.set_content(R"({"error":"capability not granted by profile"})", "application/json");
      return;
    }
    if (const auto stored = store.lookup(tenant, idemKey)) {
      res.status = 202;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    json job = {
        {"job_id", "job-1"},
        {"tenant", tenant},
        {"entry_point", body.value("entry_point", std::string("main.py"))},
        {"profile", profile},
        {"capabilities", needs},
        {"code_digest", sha256Hex(code)},
        {"status", "queued"},
    };
    store.create(tenant, idemKey, job);
    std::cerr << "sandbox submit tenant=" << tenant << " job=" << job["job_id"] << std::endl;
    res.status = 202;
    res.set_content(job.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is trust: what may the caller decide, and what may only
the platform decide? A submission endpoint is an input to a hostile-code pipeline, so the caller
names a *strength* from an allowlist and *declares* capabilities; the platform's profile table
decides what is actually granted, and the default is nothing. The size cap runs first because
everything after it costs memory or a container slot: 256 KiB is about the largest program a model
plausibly writes, and it is the difference between a bounded queue and an OOM. The idempotency key is
the third contract: submission is not idempotent by nature, so a client retry must land on the
*original* job id — that is what stops one flaky socket from running the same code twice, and it is
the reason the response carries an id and a digest instead of the code itself. Real platforms add
image allowlists, per-tenant quota on concurrent jobs, and signed submissions so the registry can
prove the code came from the review path.`,
};
