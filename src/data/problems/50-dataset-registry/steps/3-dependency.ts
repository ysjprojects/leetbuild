import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Validation calls before anything is promoted',
  concept: 'grpc',
  file: 'client',
  focus: ['registry', 'validator', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the validator client: it
calls the validator, reads the result and promotes on a pass. It compiles, it passes the demo
because the validator is fast and the object is small, and it hides three production flaws. Review
it like the owner of the gate in front of every promotion.

Implement \`POST /v1/datasets/{dataset}/versions/{version}/validate\`.

- The validator call carries a **30000 ms (30 s) deadline** — a call timeout, a context with
  timeout, \`withDeadlineAfter\`, \`set_deadline\`. Without it a stuck validator holds the request
  open and the candidate is never decided.
- A **timeout never promotes.** On \`DEADLINE_EXCEEDED\` mark the candidate \`pending\`, keep the
  previous version as latest, and answer \`202\`. The draft promotes on timeout, so unvalidated data
  reaches training under a clean version name.
- The report must say **how much of the object was covered**: \`rows_scanned\` and \`rows_total\`, or
  an explicit coverage figure. A check that only ever inspected the first 1000 rows is not a check
  of the dataset, and the caller has to be able to see that.
- Review comments **create a new candidate version** (\`next_candidate_version\` → \`-r2\`, \`-r3\`, …)
  through \`rework_candidate\`. The draft edits the reviewed candidate in place, so the artifact the
  reviewer approved is not the artifact that gets promoted.

**Failure mode the checks target.** A deadline that promotes on expiry is worse than no deadline:
it converts "I do not know" into "validated". An in-place edit after review is the quiet one — the
version hash still describes the bytes, but nobody can say which review the promoted artifact
actually passed.`,
  sequence: {
    participants: ['Registry API', 'Validator (gRPC)', 'registry store'],
    messages: [
      {from: 'Registry API', to: 'Validator (gRPC)', label: 'Validate(request) · deadline 30 s', kind: 'sync'},
      {from: 'Validator (gRPC)', to: 'Registry API', label: 'report {rows_scanned, passed}', kind: 'reply'},
      {from: 'Registry API', to: 'registry store', label: 'mark_pending on timeout or failure', kind: 'sync'},
      {from: 'Registry API', to: 'registry store', label: 'promote(version) only after a pass', kind: 'sync'},
      {from: 'registry store', to: 'Registry API', label: 'latest version held', kind: 'reply'},
      {from: 'Registry API', to: 'Registry API', label: 'rework_candidate → next_candidate_version', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/datasets/{dataset}/versions/{version}/validate',
      detail: 'Expose candidate validation on the versioned validate route.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/datasets\/\{dataset\}\/versions\/\{version\}\/validate["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/datasets\/:dataset\/versions\/:version\/validate['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/datasets\/\{dataset\}\/versions\/\{version\}\/validate"/]},
        scala: {
          all: [
            /path\(\s*"v1"\s*\/\s*"datasets"\s*\/\s*Segment\s*\/\s*"versions"\s*\/\s*Segment\s*\/\s*"validate"\s*\)/,
          ],
        },
        cpp: {all: [/svr\.Post\(/, /\/versions\//, /validate/]},
      },
    },
    {
      id: 'deadline',
      title: 'The validator call has a 30-second deadline',
      detail:
        'The call is created with a 30 000 ms deadline (`VALIDATION_DEADLINE_S`, `validationDeadline`, `ValidationDeadlineSeconds`, `kValidationDeadlineSeconds`). The draft calls the validator with no deadline at all.',
      match: {
        python: {all: [/VALIDATION_DEADLINE_S\s*=\s*30/, /timeout=VALIDATION_DEADLINE_S/]},
        typescript: {all: [/VALIDATION_DEADLINE_S\s*=\s*30/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/validationDeadline/, /context\.WithTimeout\(/]},
        scala: {all: [/ValidationDeadlineSeconds\s*=\s*30/, /withDeadlineAfter/]},
        cpp: {all: [/kValidationDeadlineSeconds\s*=\s*30/, /set_deadline\(/]},
      },
    },
    {
      id: 'timeout-no-promote',
      title: 'A timeout marks the candidate pending and holds the previous version',
      detail:
        '`DEADLINE_EXCEEDED` raises a timeout error, the candidate is marked pending and the previous version stays latest. The draft promotes on timeout, so unvalidated bytes reach training.',
      match: {
        python: {all: [/ValidationTimedOut/, /pending/]},
        typescript: {all: [/ValidationTimedOut/, /pending/]},
        go: {all: [/ErrValidationTimedOut/, /MarkPending/]},
        scala: {all: [/ValidationTimedOut/, /markPending/]},
        cpp: {all: [/ValidationTimedOut/, /mark_pending/]},
      },
    },
    {
      id: 'coverage',
      title: 'Validation reports its coverage of the object',
      detail:
        'The report carries `rows_scanned` and `rows_total` (or an explicit coverage), so a partial scan is visible instead of implied. The draft samples a 1000-row prefix and reports it as a pass.',
      match: {
        python: {all: [/rows_scanned/, /rows_total/]},
        typescript: {all: [/rowsScanned/, /rowsTotal/]},
        go: {all: [/RowsScanned/, /RowsTotal/]},
        scala: {all: [/rowsScanned/, /rowsTotal/]},
        cpp: {all: [/rows_scanned/, /rows_total/]},
      },
    },
    {
      id: 'new-candidate',
      title: 'Review feedback opens a new candidate version',
      detail:
        '`rework_candidate` derives the next candidate with `next_candidate_version` instead of editing the reviewed candidate in place, so the approved artifact and the promoted artifact are the same object.',
      match: {
        python: {all: [/def rework_candidate\(/, /next_candidate_version/]},
        typescript: {all: [/function reworkCandidate\(/, /nextCandidateVersion/]},
        go: {all: [/func reworkCandidate\(/, /nextCandidateVersion/]},
        scala: {all: [/def reworkCandidate\(/, /nextCandidateVersion/]},
        cpp: {all: [/reworkCandidate\(/, /nextCandidateVersion/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import registry_pb2
import registry_pb2_grpc

app = FastAPI()
logger = logging.getLogger("registry-client")

VALIDATOR_SAMPLE_ROWS = 1000


class Candidate(BaseModel):
    dataset: str
    version: str
    content_sha256: str
    rows_total: int
    notes: str = ""


class RegistryStore:
    """The pointer boundary this client promotes through."""

    def mark_pending(self, dataset: str, version: str) -> None:
        raise NotImplementedError

    def latest(self, dataset: str) -> str:
        raise NotImplementedError

    def promote(self, dataset: str, version: str) -> str:
        raise NotImplementedError


store = RegistryStore()
channel = grpc.insecure_channel("validator:50051")


def validate_candidate(stub, candidate: Candidate) -> dict:
    # TODO: this draft promotes on timeout, validates only the first 1000 rows, and mutates a
    # candidate in place after review comments. Review all three.
    request = registry_pb2.ValidateRequest(
        dataset=candidate.dataset, version=candidate.version, limit=VALIDATOR_SAMPLE_ROWS
    )
    response = stub.Validate(request)
    return {"checked": VALIDATOR_SAMPLE_ROWS, "passed": response.passed}


@app.post("/v1/datasets/{dataset}/versions/{version}/validate")
def validate(
    dataset: str,
    version: str,
    body: Candidate,
    tenant: str = Header(alias="X-Tenant-Id"),
) -> JSONResponse:
    stub = registry_pb2_grpc.ValidatorStub(channel)
    try:
        report = validate_candidate(stub, body)
    except grpc.RpcError:
        store.promote(body.dataset, body.version)
        return JSONResponse({"promoted": True, "latest": body.version}, status_code=200)
    if not report["passed"]:
        store.mark_pending(body.dataset, body.version)
        return JSONResponse({"promoted": False}, status_code=202)
    store.promote(body.dataset, body.version)
    return JSONResponse({"promoted": True, "latest": body.version}, status_code=200)


def apply_review(candidate: Candidate, comments: str) -> Candidate:
    """The draft edits the reviewed candidate in place."""
    candidate.notes = comments
    return candidate
`,
      solution: `import logging

import grpc
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import registry_pb2
import registry_pb2_grpc

app = FastAPI()
logger = logging.getLogger("registry-client")

VALIDATION_DEADLINE_S = 30


class ValidationTimedOut(RuntimeError):
    """The validator did not answer inside the deadline, so nothing may be promoted."""


class Candidate(BaseModel):
    dataset: str
    version: str
    content_sha256: str
    rows_total: int
    notes: str = ""


class RegistryStore:
    """The pointer boundary this client promotes through."""

    def mark_pending(self, dataset: str, version: str) -> None:
        raise NotImplementedError

    def latest(self, dataset: str) -> str:
        raise NotImplementedError

    def promote(self, dataset: str, version: str) -> str:
        raise NotImplementedError


store = RegistryStore()
channel = grpc.insecure_channel("validator:50051")


def next_candidate_version(version: str) -> str:
    """Review feedback opens a new candidate: <version>-r2, -r3, …"""
    base, _, revision = version.partition("-r")
    if revision.isdigit():
        return f"{base}-r{int(revision) + 1}"
    return f"{version}-r2"


def validate_candidate(stub, candidate: Candidate) -> dict:
    """Validate under a hard deadline and report how much of the object was actually covered."""
    request = registry_pb2.ValidateRequest(dataset=candidate.dataset, version=candidate.version)
    try:
        response = stub.Validate(request, timeout=VALIDATION_DEADLINE_S)
    except grpc.RpcError as err:
        if err.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
            raise ValidationTimedOut(f"{candidate.dataset}@{candidate.version}") from err
        raise
    return {
        "rows_scanned": response.rows_scanned,
        "rows_total": candidate.rows_total,
        "coverage": response.rows_scanned / max(candidate.rows_total, 1),
        "passed": response.passed,
        "checks": [check.name for check in response.checks],
    }


@app.post("/v1/datasets/{dataset}/versions/{version}/validate")
def validate(
    dataset: str,
    version: str,
    body: Candidate,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    stub = registry_pb2_grpc.ValidatorStub(channel)
    try:
        report = validate_candidate(stub, body)
    except ValidationTimedOut as err:
        store.mark_pending(body.dataset, body.version)
        held = store.latest(body.dataset)
        logger.warning("validation timed out dataset=%s version=%s held=%s", body.dataset, body.version, held)
        return JSONResponse(
            {"promoted": False, "pending": True, "latest": held, "reason": str(err)}, status_code=202
        )
    if not report["passed"]:
        store.mark_pending(body.dataset, body.version)
        return JSONResponse(
            {"promoted": False, "pending": True, "latest": store.latest(body.dataset)}, status_code=202
        )
    promoted = store.promote(body.dataset, body.version)
    return JSONResponse({"promoted": True, "latest": promoted, "coverage": report["coverage"]}, status_code=200)


def rework_candidate(candidate: Candidate, comments: str) -> Candidate:
    """Review comments produce a new candidate version, never an edit of the reviewed one."""
    return Candidate(
        dataset=candidate.dataset,
        version=next_candidate_version(candidate.version),
        content_sha256=candidate.content_sha256,
        rows_total=candidate.rows_total,
        notes=comments,
    )
`,
    },
    typescript: {
      starter: `/** Validator client: a model-generated draft. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

export const app = Fastify();

const VALIDATOR_SAMPLE_ROWS = 1000;
const proto = protoLoader.loadSync('registry.proto');
const registry = grpc.loadPackageDefinition(proto) as unknown as {
  registry: {ValidatorClient: new (address: string, creds: grpc.ChannelCredentials) => ValidatorClient};
};

interface ValidatorClient {
  Validate(request: unknown, callback: (err: grpc.ServiceError | null, response: ValidationResponse) => void): void;
}

interface ValidationResponse {
  rows_scanned: number;
  passed: boolean;
}

interface Candidate {
  dataset: string;
  version: string;
  content_sha256: string;
  rows_total: number;
  notes?: string;
}

const stub = new registry.registry.ValidatorClient('validator:50051', grpc.credentials.createInsecure());

function validateCandidate(candidate: Candidate): Promise<{checked: number; passed: boolean}> {
  // TODO: this draft promotes on timeout, validates only the first 1000 rows, and mutates a
  // candidate in place after review comments. Review all three.
  const {promise, resolve, reject} = Promise.withResolvers<{checked: number; passed: boolean}>();
  stub.Validate(
    {dataset: candidate.dataset, version: candidate.version, limit: VALIDATOR_SAMPLE_ROWS},
    (err, response) => {
      if (err !== null) {
        reject(err);
        return;
      }
      resolve({checked: VALIDATOR_SAMPLE_ROWS, passed: response.passed});
    },
  );
  return promise;
}

app.post('/v1/datasets/:dataset/versions/:version/validate', async (request, reply) => {
  const body = request.body as Candidate;
  try {
    const report = await validateCandidate(body);
    return reply.code(report.passed ? 200 : 202).send({promoted: report.passed});
  } catch (err) {
    return reply.code(200).send({promoted: true, latest: body.version});
  }
});

function applyReview(candidate: Candidate, comments: string): Candidate {
  // The draft edits the reviewed candidate in place.
  candidate.notes = comments;
  return candidate;
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Validator client: 30-second deadline, reported coverage, review opens a new candidate. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

export const app = Fastify();

const VALIDATION_DEADLINE_S = 30;
const DEADLINE_MS = VALIDATION_DEADLINE_S * 1000;

const proto = protoLoader.loadSync('registry.proto');
const registry = grpc.loadPackageDefinition(proto) as unknown as {
  registry: {ValidatorClient: new (address: string, creds: grpc.ChannelCredentials) => ValidatorClient};
};

interface ValidatorClient {
  Validate(request: unknown, options: grpc.CallOptions, callback: (err: grpc.ServiceError | null, response: ValidationResponse) => void): void;
}

interface ValidationResponse {
  rows_scanned: number;
  passed: boolean;
}

interface Candidate {
  dataset: string;
  version: string;
  content_sha256: string;
  rows_total: number;
  notes?: string;
}

interface ValidationReport {
  rowsScanned: number;
  rowsTotal: number;
  coverage: number;
  passed: boolean;
}

export class ValidationTimedOut extends Error {}

const stub = new registry.registry.ValidatorClient('validator:50051', grpc.credentials.createInsecure());

function nextCandidateVersion(version: string): string {
  const match = /^(.*)-r(\\d+)$/.exec(version);
  return match === null ? \`\${version}-r2\` : \`\${match[1]}-r\${Number(match[2]) + 1}\`;
}

function validateCandidate(candidate: Candidate): Promise<ValidationReport> {
  const {promise, resolve, reject} = Promise.withResolvers<ValidationReport>();
  stub.Validate(
    {dataset: candidate.dataset, version: candidate.version},
    {deadline: Date.now() + DEADLINE_MS},
    (err, response) => {
      if (err !== null) {
        if (err.code === grpc.status.DEADLINE_EXCEEDED) {
          reject(new ValidationTimedOut(\`\${candidate.dataset}@\${candidate.version}\`));
        } else {
          reject(err);
        }
        return;
      }
      resolve({
        rowsScanned: response.rows_scanned,
        rowsTotal: candidate.rows_total,
        coverage: response.rows_scanned / Math.max(candidate.rows_total, 1),
        passed: response.passed,
      });
    },
  );
  return promise;
}

function reworkCandidate(candidate: Candidate, comments: string): Candidate {
  return {
    dataset: candidate.dataset,
    version: nextCandidateVersion(candidate.version),
    content_sha256: candidate.content_sha256,
    rows_total: candidate.rows_total,
    notes: comments,
  };
}

app.post('/v1/datasets/:dataset/versions/:version/validate', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as Candidate;
  try {
    const report = await validateCandidate(body);
    if (!report.passed) {
      await store.markPending(body.dataset, body.version);
      return reply.code(202).send({promoted: false, pending: true, latest: await store.latest(body.dataset)});
    }
    const promoted = await store.promote(body.dataset, body.version);
    return reply.code(200).send({promoted: true, latest: promoted, coverage: report.coverage});
  } catch (err) {
    if (!(err instanceof ValidationTimedOut)) throw err;
    await store.markPending(body.dataset, body.version);
    const held = await store.latest(body.dataset);
    request.log.warn({dataset: body.dataset, version: body.version, held}, 'validation timed out');
    return reply.code(202).send({promoted: false, pending: true, latest: held});
  }
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

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	registrypb "registry/proto"
)

const validatorSampleRows = 1000

type Candidate struct {
	Dataset       string
	Version       string
	ContentSHA256 string
	RowsTotal     int64
}

type ValidationReport struct {
	Checked int64
	Passed  bool
}

func validateCandidate(ctx context.Context, client registrypb.ValidatorClient, candidate Candidate) (ValidationReport, error) {
	// TODO: this draft promotes on timeout, validates only the first 1000 rows, and mutates a
	// candidate in place after review comments. Review all three.
	response, err := client.Validate(ctx, &registrypb.ValidateRequest{
		Dataset: candidate.Dataset,
		Version: candidate.Version,
		Limit:   validatorSampleRows,
	})
	if err != nil {
		return ValidationReport{}, err
	}
	return ValidationReport{Checked: validatorSampleRows, Passed: response.Passed}, nil
}

func main() {
	conn, err := grpc.NewClient("validator:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatal(err)
	}
	client := registrypb.NewValidatorClient(conn)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/datasets/{dataset}/versions/{version}/validate", func(rw http.ResponseWriter, r *http.Request) {
		var body Candidate
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(rw, "invalid json", http.StatusBadRequest)
			return
		}
		report, err := validateCandidate(r.Context(), client, body)
		if err != nil {
			store.Promote(r.Context(), body.Dataset, body.Version)
			writeJSON(rw, http.StatusOK, map[string]any{"promoted": true, "latest": body.Version})
			return
		}
		if !report.Passed {
			store.MarkPending(r.Context(), body.Dataset, body.Version)
			writeJSON(rw, http.StatusAccepted, map[string]any{"promoted": false})
			return
		}
		store.Promote(r.Context(), body.Dataset, body.Version)
		writeJSON(rw, http.StatusOK, map[string]any{"promoted": true, "latest": body.Version})
	})
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	registrypb "registry/proto"
)

const validationDeadline = 30 * time.Second

var ErrValidationTimedOut = errors.New("validator did not answer inside the deadline")

type Candidate struct {
	Dataset       string
	Version       string
	ContentSHA256 string
	RowsTotal     int64
}

type ValidationReport struct {
	RowsScanned int64
	RowsTotal   int64
	Coverage    float64
	Passed      bool
}

func nextCandidateVersion(version string) string {
	for i := len(version) - 1; i >= 0; i-- {
		if version[i] == '-' && version[i+1] == 'r' {
			if revision, err := strconv.Atoi(version[i+2:]); err == nil {
				return version[:i] + "-r" + strconv.Itoa(revision+1)
			}
		}
	}
	return version + "-r2"
}

func validateCandidate(ctx context.Context, client registrypb.ValidatorClient, candidate Candidate) (ValidationReport, error) {
	ctx, cancel := context.WithTimeout(ctx, validationDeadline)
	defer cancel()

	response, err := client.Validate(ctx, &registrypb.ValidateRequest{
		Dataset: candidate.Dataset,
		Version: candidate.Version,
	})
	if err != nil {
		if status.Code(err) == codes.DeadlineExceeded {
			return ValidationReport{}, ErrValidationTimedOut
		}
		return ValidationReport{}, err
	}
	rowsTotal := max(candidate.RowsTotal, 1)
	return ValidationReport{
		RowsScanned: response.RowsScanned,
		RowsTotal:   candidate.RowsTotal,
		Coverage:    float64(response.RowsScanned) / float64(rowsTotal),
		Passed:      response.Passed,
	}, nil
}

func reworkCandidate(candidate Candidate, comments string) Candidate {
	return Candidate{
		Dataset:       candidate.Dataset,
		Version:       nextCandidateVersion(candidate.Version),
		ContentSHA256: candidate.ContentSHA256,
		RowsTotal:     candidate.RowsTotal,
	}
}

func main() {
	conn, err := grpc.NewClient("validator:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatal(err)
	}
	client := registrypb.NewValidatorClient(conn)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/datasets/{dataset}/versions/{version}/validate", func(rw http.ResponseWriter, r *http.Request) {
		var body Candidate
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(rw, "invalid json", http.StatusBadRequest)
			return
		}
		report, err := validateCandidate(r.Context(), client, body)
		if errors.Is(err, ErrValidationTimedOut) {
			store.MarkPending(r.Context(), body.Dataset, body.Version)
			held, _ := store.Latest(r.Context(), body.Dataset)
			log.Printf("validation timed out dataset=%s version=%s held=%s", body.Dataset, body.Version, held)
			writeJSON(rw, http.StatusAccepted, map[string]any{"promoted": false, "pending": true, "latest": held})
			return
		}
		if err != nil {
			http.Error(rw, "TRY_AGAIN", http.StatusServiceUnavailable)
			return
		}
		if !report.Passed {
			store.MarkPending(r.Context(), body.Dataset, body.Version)
			held, _ := store.Latest(r.Context(), body.Dataset)
			writeJSON(rw, http.StatusAccepted, map[string]any{"promoted": false, "pending": true, "latest": held})
			return
		}
		promoted, err := store.Promote(r.Context(), body.Dataset, body.Version)
		if err != nil {
			http.Error(rw, "TRY_AGAIN", http.StatusServiceUnavailable)
			return
		}
		writeJSON(rw, http.StatusOK, map[string]any{"promoted": true, "latest": promoted, "coverage": report.Coverage})
	})
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Candidate(dataset: String, version: String, content_sha256: String, rowsTotal: Long)
final case class ValidationReport(checked: Long, passed: Boolean)

object Client {
  implicit val system: ActorSystem = ActorSystem("dataset-registry")
  implicit val candidateFormat: RootJsonFormat[Candidate] = jsonFormat4(Candidate)

  val SampleRows = 1000
  val stub = RegistryValidatorGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("validator", 50051).usePlaintext().build()
  )

  def validateCandidate(candidate: Candidate): ValidationReport = {
    // TODO: this draft promotes on timeout, validates only the first 1000 rows, and mutates a
    // candidate in place after review comments. Review all three.
    val response = stub.validate(ValidateRequest(candidate.dataset, candidate.version, SampleRows))
    ValidationReport(SampleRows, response.passed)
  }

  val route: Route =
    path("v1" / "datasets" / Segment / "versions" / Segment / "validate") { (dataset, version) =>
      post {
        entity(as[Candidate]) { body =>
          try {
            val report = validateCandidate(body)
            if (report.passed) {
              val promoted = store.promote(body.dataset, body.version)
              complete(StatusCodes.OK, s"""{"promoted":true,"latest":"$promoted"}""")
            } else {
              store.markPending(body.dataset, body.version)
              complete(StatusCodes.Accepted, """{"promoted":false}""")
            }
          } catch {
            case _: Throwable =>
              store.promote(body.dataset, body.version)
              complete(StatusCodes.OK, s"""{"promoted":true,"latest":"$version"}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Candidate(dataset: String, version: String, content_sha256: String, rowsTotal: Long)
final case class ValidationReport(rowsScanned: Long, rowsTotal: Long, coverage: Double, passed: Boolean)

class ValidationTimedOut(version: String) extends RuntimeException(s"validator timed out for $version")

object Client {
  implicit val system: ActorSystem = ActorSystem("dataset-registry")
  implicit val candidateFormat: RootJsonFormat[Candidate] = jsonFormat4(Candidate)

  val ValidationDeadlineSeconds = 30
  val stub = RegistryValidatorGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("validator", 50051).usePlaintext().build()
  )

  def nextCandidateVersion(version: String): String = {
    val marker = version.lastIndexOf("-r")
    if (marker < 0) s"$version-r2"
    else
      version.substring(marker + 2).toIntOption match {
        case Some(revision) => s"\${version.substring(0, marker)}-r\${revision + 1}"
        case None => s"$version-r2"
      }
  }

  def validateCandidate(candidate: Candidate): ValidationReport = {
    val response =
      try stub.withDeadlineAfter(ValidationDeadlineSeconds, TimeUnit.SECONDS).validate(
        ValidateRequest(candidate.dataset, candidate.version)
      )
      catch {
        case err: StatusRuntimeException if err.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
          throw new ValidationTimedOut(candidate.version)
      }
    ValidationReport(
      response.rowsScanned,
      candidate.rowsTotal,
      response.rowsScanned.toDouble / math.max(candidate.rowsTotal, 1L),
      response.passed
    )
  }

  def reworkCandidate(candidate: Candidate, comments: String): Candidate =
    Candidate(candidate.dataset, nextCandidateVersion(candidate.version), candidate.content_sha256, candidate.rowsTotal)

  val route: Route =
    path("v1" / "datasets" / Segment / "versions" / Segment / "validate") { (dataset, version) =>
      post {
        entity(as[Candidate]) { body =>
          try {
            val report = validateCandidate(body)
            if (report.passed) {
              val promoted = store.promote(body.dataset, body.version)
              complete(StatusCodes.OK, s"""{"promoted":true,"latest":"$promoted","coverage":\${report.coverage}}""")
            } else {
              store.markPending(body.dataset, body.version)
              val held = store.latest(body.dataset)
              complete(StatusCodes.Accepted, s"""{"promoted":false,"pending":true,"latest":"$held"}""")
            }
          } catch {
            case _: ValidationTimedOut =>
              store.markPending(body.dataset, body.version)
              val held = store.latest(body.dataset)
              complete(StatusCodes.Accepted, s"""{"promoted":false,"pending":true,"latest":"$held"}""")
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
#include <grpcpp/grpcpp.h>

#include <iostream>
#include <string>

#include "registry.grpc.pb.h"

using json = nlohmann::json;

constexpr long kValidatorSampleRows = 1000;

struct ValidationReport {
  long checked;
  bool passed;
};

static ValidationReport validateCandidate(Registry::Validator::Stub& stub, const std::string& dataset,
                                          const std::string& version) {
  // TODO: this draft promotes on timeout, validates only the first 1000 rows, and mutates a
  // candidate in place after review comments. Review all three.
  ValidateRequest request;
  request.set_dataset(dataset);
  request.set_version(version);
  request.set_limit(kValidatorSampleRows);
  ValidateResponse response;
  grpc::ClientContext ctx;
  stub.Validate(&ctx, request, &response);
  return {kValidatorSampleRows, response.passed()};
}

int main() {
  auto channel = grpc::CreateChannel("validator:50051", grpc::InsecureChannelCredentials());
  auto stub = Registry::Validator::NewStub(channel);
  httplib::Server svr;

  svr.Post(R"(/v1/datasets/([^/]+)/versions/([^/]+)/validate)", [&stub](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const std::string dataset = req.matches[1];
    const std::string version = req.matches[2];
    try {
      const auto report = validateCandidate(*stub, dataset, version);
      if (!report.passed) {
        store.mark_pending(dataset, version);
        res.status = 202;
        res.set_content(R"({"promoted":false})", "application/json");
        return;
      }
      store.promote(dataset, version);
      res.status = 200;
      res.set_content(json{{"promoted", true}, {"latest", version}}.dump(), "application/json");
    } catch (const std::exception&) {
      store.promote(dataset, version);
      res.status = 200;
      res.set_content(json{{"promoted", true}, {"latest", version}}.dump(), "application/json");
    }
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>

#include "registry.grpc.pb.h"

using json = nlohmann::json;

constexpr int kValidationDeadlineSeconds = 30;

struct ValidationReport {
  long rows_scanned;
  long rows_total;
  double coverage;
  bool passed;
};

struct ValidationTimedOut : std::runtime_error {
  explicit ValidationTimedOut(const std::string& version) : std::runtime_error("validator timed out for " + version) {}
};

static std::string nextCandidateVersion(const std::string& version) {
  const auto marker = version.rfind("-r");
  if (marker == std::string::npos) return version + "-r2";
  return version.substr(0, marker) + "-r" + std::to_string(std::stoi(version.substr(marker + 2)) + 1);
}

static ValidationReport validateCandidate(Registry::Validator::Stub& stub, const std::string& dataset,
                                          const std::string& version, long rowsTotal) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kValidationDeadlineSeconds));
  ValidateRequest request;
  request.set_dataset(dataset);
  request.set_version(version);
  ValidateResponse response;
  const auto status = stub.Validate(&ctx, request, &response);
  if (!status.ok()) {
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) throw ValidationTimedOut(version);
    throw std::runtime_error(status.error_message());
  }
  const long total = rowsTotal > 0 ? rowsTotal : 1;
  return {response.rows_scanned(), rowsTotal, static_cast<double>(response.rows_scanned()) / total, response.passed()};
}

static std::string reworkCandidate(const std::string& version, const std::string& contentSha256) {
  return nextCandidateVersion(version) + "@" + contentSha256;
}

int main() {
  auto channel = grpc::CreateChannel("validator:50051", grpc::InsecureChannelCredentials());
  auto stub = Registry::Validator::NewStub(channel);
  httplib::Server svr;

  svr.Post(R"(/v1/datasets/([^/]+)/versions/([^/]+)/validate)", [&stub](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const std::string dataset = req.matches[1];
    const std::string version = req.matches[2];
    const long rowsTotal = body.value("rows_total", 1L);
    try {
      const auto report = validateCandidate(*stub, dataset, version, rowsTotal);
      if (!report.passed) {
        store.mark_pending(dataset, version);
        res.status = 202;
        res.set_content(json{{"promoted", false}, {"pending", true}, {"latest", store.latest(dataset)}}.dump(),
                        "application/json");
        return;
      }
      const auto promoted = store.promote(dataset, version);
      res.status = 200;
      res.set_content(json{{"promoted", true}, {"latest", promoted}, {"coverage", report.coverage}}.dump(),
                      "application/json");
    } catch (const ValidationTimedOut& err) {
      store.mark_pending(dataset, version);
      const auto held = store.latest(dataset);
      std::cerr << "validation timed out dataset=" << dataset << " version=" << version << "\\n";
      res.status = 202;
      res.set_content(json{{"promoted", false}, {"pending", true}, {"latest", held}, {"reason", err.what()}}.dump(),
                      "application/json");
    }
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The deadline is an argument on the call itself (`timeout=`, `deadline: Date.now() + …`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`). It is 30 seconds, and it exists so a stuck validator produces a decision instead of an open request.',
    'On `DEADLINE_EXCEEDED` the candidate is `pending` and the previous version is still latest: return 202 with the held version. Promoting on timeout turns "I do not know" into "validated" — exactly the failure this gate exists to prevent.',
    'A report without `rows_scanned`/`rows_total` hides a prefix scan. And review comments are a new artifact: `rework_candidate` derives `-r2`; editing the reviewed candidate in place means the approved bytes are not the promoted bytes.',
  ],
  debrief: `The interviewer is testing the gate in front of a promotion, not the gRPC call itself. The draft looks right because the validator is fast, the object is small and nobody has left review comments yet. Three defects are checked: a missing deadline, a timeout that promotes, and a report with no coverage — a 1000-row sample presented as a pass. The fourth idea is version identity: review feedback has to create a new candidate, because a version name that can be edited after approval cannot be relied on by anyone downstream. Real registries add schema conformance and license compatibility to the same report, cache the report by (content hash, validator version), and require the validator's own version in the promotion record so a validator upgrade can invalidate old passes.`,
};
