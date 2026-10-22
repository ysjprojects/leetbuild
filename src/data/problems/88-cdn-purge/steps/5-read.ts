import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/purges/{id}: accepted is not propagated',
  concept: 'http',
  file: 'read',
  focus: ['client', 'purge', 'tenant'],
  task: `## Task

**Review premise.** The starter reads the purge record and returns it as done. It compiles, and it
is exactly the endpoint that told on-call a domain was clean for six hours while some edges were
still serving the broken pricing page. Review it like the owner of the status contract, fix it, and
prove the fix with the checks below.

Implement \`GET /v1/purges/{purge_id}\`:

- The tenant comes from \`X-Tenant-Id\` (**401** when missing). A purge that belongs to another
  tenant is **404**, exactly like a purge that does not exist: the endpoint must not confirm that
  someone else's purge id is real.
- The response reports \`purge_id\`, \`domain\`, \`status\`, \`outcomes\`, \`accepted_at\` and
  \`propagated_at\`. \`outcomes\` is the per-path map **for every path** — the failed ones included,
  because those are the ones an operator has to act on.
- \`status\` is derived from the per-path outcomes by \`derive_status\`, using exactly these three
  values: \`accepted\` (the purge is recorded, the provider has not confirmed every path),
  \`propagated\` (every path confirmed at the edges) and \`partially_failed\` (at least one path
  reached a terminal failure). There is no \`done\`: done is a claim this service cannot make while
  edges are still catching up.
- \`propagated_at\` is a real timestamp **only** when the status is \`propagated\`; until then it is
  null. The confirmation path (\`mark_propagated\`) records the paths the provider confirmed and
  stamps the time only when the last one lands — a 200 from the provider is acceptance, not
  propagation.
- A provider 200 that has not propagated yet must therefore read as \`accepted\`; a purge where one
  path was refused must read as \`partially_failed\` with that path visible in \`outcomes\`, never as
  a clean purge.

:::widget status-codes {}

**Failure mode the checks target.** The draft answers \`done\` the moment the provider accepted the
batch, so the status endpoint reports success while propagation is still in flight — the six hours
of stale pricing came from trusting that word. It filters \`outcomes\` down to the accepted paths, so
the failures an operator needs are hidden. And it looks up the purge by id alone, so any tenant can
read (and, in the intake endpoint, infer) another tenant's purge.`,
  sequence: {
    participants: ['Client', 'Purge API', 'purge store'],
    messages: [
      {from: 'Client', to: 'Purge API', label: 'GET /v1/purges/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Purge API', to: 'purge store', label: 'get(purge_id)', kind: 'sync'},
      {from: 'purge store', to: 'Purge API', label: 'record with per-path outcomes', kind: 'reply'},
      {from: 'Purge API', to: 'Purge API', label: 'foreign or missing → 404 · derive_status(outcomes)', kind: 'sync'},
      {from: 'Purge API', to: 'Client', label: '200 {status, outcomes, propagated_at}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route-read',
      title: 'Reads one purge through the store and states the status vocabulary',
      detail:
        'Register `GET /v1/purges/{purge_id}`, extract the id, and read the record (`store.get`) with the three purges statuses in scope. The draft reports `done`, a word this service has no evidence for.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/purges\/\{purge_id\}["']/, /store\.get\(/, /PURGE_STATUSES/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/purges\/:purgeId['"]/, /store\.get\(/, /PURGE_STATUSES/]},
        go: {
          all: [
            /HandleFunc\(\s*"GET \/v1\/purges\/\{purge_id\}"/,
            /PathValue\(\s*"purge_id"/,
            /store\.Get\(/,
            /purgeStatuses/,
          ],
        },
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"purges"\s*\/\s*Segment/, /\bget\s*\{/, /store\.get\(/, /PurgeStatuses/],
        },
        cpp: {all: [/svr\.Get\(R"\(\/v1\/purges\//, /store\.get\(/, /kPurgeStatuses/]},
      },
    },
    {
      id: 'status-model',
      title: 'Derives accepted, propagated or partially_failed — never done',
      detail:
        '`derive_status` maps the per-path outcomes to `accepted`, `propagated` or `partially_failed`, and the word `done` appears nowhere. The draft returns `done` as soon as the provider accepted the batch, which is why a propagation failure stayed invisible for six hours.',
      match: {
        python: {
          all: [/STATUS_ACCEPTED/, /STATUS_PROPAGATED/, /STATUS_PARTIALLY_FAILED/, /derive_status\(/],
          none: [/["']done["']/],
        },
        typescript: {
          all: [/STATUS_ACCEPTED/, /STATUS_PROPAGATED/, /STATUS_PARTIALLY_FAILED/, /deriveStatus\(/],
          none: [/['"]done['"]/],
        },
        go: {
          all: [/statusAccepted/, /statusPropagated/, /statusPartiallyFailed/, /deriveStatus\(/],
          none: [/"done"/],
        },
        scala: {
          all: [/StatusAccepted/, /StatusPropagated/, /StatusPartiallyFailed/, /deriveStatus\(/],
          none: [/"done"/],
        },
        cpp: {
          all: [/kStatusAccepted/, /kStatusPropagated/, /kStatusPartiallyFailed/, /deriveStatus\(/],
          none: [/"done"/],
        },
      },
    },
    {
      id: 'tenant-scope',
      title: 'A foreign purge is 404, not forbidden',
      detail:
        'The record is scoped to the calling tenant and a mismatch answers **404**, so the endpoint never confirms that another tenant’s purge id exists. The draft looks the purge up by id alone and returns it to anyone.',
      match: {
        python: {all: [/status_code=404/, /purge\["tenant"\] != tenant/]},
        typescript: {all: [/code\(404\)/, /purge\.tenant !== tenant/]},
        go: {all: [/StatusNotFound/, /purge\.Tenant != tenant/]},
        scala: {all: [/StatusCodes\.NotFound/, /purge\.tenant != tenant/]},
        cpp: {all: [/\b404\b/, /\["tenant"\]\.get<std::string>\(\) != tenant/]},
      },
    },
    {
      id: 'propagated-at',
      title: 'propagated_at is stamped only by a real confirmation',
      detail:
        '`mark_propagated` records the paths the provider confirmed and sets `propagated_at` only once every path has propagated, so the read reports a null timestamp until then. The draft has no confirmation path at all and treats provider acceptance as propagation.',
      match: {
        python: {all: [/mark_propagated\(/, /propagated_at/, /OUTCOME_PROPAGATED/]},
        typescript: {all: [/markPropagated\(/, /propagated_at/, /OUTCOME_PROPAGATED/]},
        go: {all: [/markPropagated\(/, /PropagatedAt/, /outcomePropagated/]},
        scala: {all: [/markPropagated\(/, /propagated_at/, /OutcomePropagated/]},
        cpp: {all: [/markPropagated\(/, /propagated_at/, /kOutcomePropagated/]},
      },
    },
    {
      id: 'failed-visible',
      title: 'Failed paths stay in the response',
      detail:
        'The response carries the whole `outcomes` map, so a purge with one refused pattern reads `partially_failed` with that path in the body. The draft filters the map down to the accepted paths and hides exactly what an operator needs.',
      match: {
        python: {all: [/OUTCOME_FAILED/, /STATUS_PARTIALLY_FAILED/, /"outcomes": purge\["outcomes"\]/]},
        typescript: {all: [/OUTCOME_FAILED/, /STATUS_PARTIALLY_FAILED/, /outcomes: purge\.outcomes/]},
        go: {all: [/outcomeFailed/, /statusPartiallyFailed/, /"outcomes":\s+purge\.Outcomes/]},
        scala: {all: [/OutcomeFailed/, /StatusPartiallyFailed/, /purge\.outcomes\.map/]},
        cpp: {all: [/kOutcomeFailed/, /kStatusPartiallyFailed/, /\{"outcomes", \(\*purge\)\["outcomes"\]\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header

app = FastAPI()


class PurgeStore:
    def get(self, purge_id: str) -> dict | None:
        """The purge record: tenant, domain, paths, per-path outcomes and confirmation times."""
        raise NotImplementedError


store = PurgeStore()


@app.get("/v1/purges/{purge_id}")
def get_purge(purge_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft reports done as soon as the provider accepted the batch, hides the paths
    # that failed, and lets any tenant read any purge. Review all three: a status derived from the
    # per-path outcomes with propagated_at only after confirmation, the full outcome map in the
    # response, and a 404 for a purge that belongs to another tenant.
    purge = store.get(purge_id)
    outcomes = {path: outcome for path, outcome in purge["outcomes"].items() if outcome == "accepted"}
    return {
        "purge_id": purge["purge_id"],
        "domain": purge["domain"],
        "status": "done",
        "outcomes": outcomes,
    }
`,
      solution: `from fastapi import FastAPI, Header, HTTPException

app = FastAPI()

STATUS_ACCEPTED = "accepted"
STATUS_PROPAGATED = "propagated"
STATUS_PARTIALLY_FAILED = "partially_failed"
PURGE_STATUSES = {STATUS_ACCEPTED, STATUS_PROPAGATED, STATUS_PARTIALLY_FAILED}
OUTCOME_PROPAGATED = "propagated"
OUTCOME_FAILED = "failed"
OUTCOME_PENDING = "pending"


class PurgeStore:
    def get(self, purge_id: str) -> dict | None:
        """The purge record: tenant, domain, paths, per-path outcomes and confirmation times."""
        raise NotImplementedError


store = PurgeStore()


def derive_status(outcomes: dict[str, str]) -> str:
    """accepted is not propagated: the status follows the worst per-path outcome."""
    if any(outcome == OUTCOME_FAILED for outcome in outcomes.values()):
        return STATUS_PARTIALLY_FAILED
    if all(outcome == OUTCOME_PROPAGATED for outcome in outcomes.values()):
        return STATUS_PROPAGATED
    return STATUS_ACCEPTED


def mark_propagated(purge: dict, outcomes: dict[str, str], at: str) -> None:
    """Record the paths the provider confirmed, and the time the last of them landed."""
    purge["outcomes"].update(outcomes)
    if derive_status(purge["outcomes"]) == STATUS_PROPAGATED:
        purge["propagated_at"] = at


@app.get("/v1/purges/{purge_id}")
def get_purge(purge_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    purge = store.get(purge_id)
    # A foreign purge is not found, not forbidden: this endpoint must not confirm an id exists.
    if purge is None or purge["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such purge")
    status = derive_status(purge["outcomes"])
    if status not in PURGE_STATUSES:
        raise HTTPException(status_code=500, detail="unknown purge status")
    return {
        "purge_id": purge["purge_id"],
        "domain": purge["domain"],
        "status": status,
        "outcomes": purge["outcomes"],
        "accepted_at": purge["accepted_at"],
        "propagated_at": purge["propagated_at"] if status == STATUS_PROPAGATED else None,
    }
`,
    },
    typescript: {
      starter: `/** GET /v1/purges/:purgeId: a model-generated draft that calls provider acceptance done. */
import Fastify from 'fastify';

export const app = Fastify();

interface Purge {
  purge_id: string;
  tenant: string;
  domain: string;
  paths: string[];
  outcomes: Record<string, string>;
}

const store = {
  async get(purgeId: string): Promise<Purge | null> {
    throw new Error(\`not implemented: purge \${purgeId}\`);
  },
};

app.get('/v1/purges/:purgeId', async (request, reply) => {
  // TODO: this draft reports done as soon as the provider accepted the batch, hides the paths that
  // failed, and lets any tenant read any purge. Review all three: a status derived from the
  // per-path outcomes with propagated_at only after confirmation, the full outcome map in the
  // response, and a 404 for a purge that belongs to another tenant.
  // Fastify types route params as a generic record; this route declares :purgeId.
  const params = request.params as {purgeId: string};
  // The draft assumes the purge exists, so it skips the missing-record path entirely.
  const purge = (await store.get(params.purgeId)) as Purge;
  const outcomes: Record<string, string> = {};
  for (const [path, outcome] of Object.entries(purge.outcomes)) if (outcome === 'accepted') outcomes[path] = outcome;
  return reply.code(200).send({purge_id: purge.purge_id, domain: purge.domain, status: 'done', outcomes});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/purges/:purgeId: accepted is not propagated — the status follows the outcomes. */
import Fastify from 'fastify';

export const app = Fastify();

const STATUS_ACCEPTED = 'accepted';
const STATUS_PROPAGATED = 'propagated';
const STATUS_PARTIALLY_FAILED = 'partially_failed';
const PURGE_STATUSES = [STATUS_ACCEPTED, STATUS_PROPAGATED, STATUS_PARTIALLY_FAILED];
const OUTCOME_PROPAGATED = 'propagated';
const OUTCOME_FAILED = 'failed';
const OUTCOME_PENDING = 'pending';

interface Purge {
  purge_id: string;
  tenant: string;
  domain: string;
  paths: string[];
  outcomes: Record<string, string>;
  accepted_at: string;
  propagated_at: string | null;
}

const store = {
  async get(purgeId: string): Promise<Purge | null> {
    throw new Error(\`not implemented: purge \${purgeId}\`);
  },
};

/** accepted is not propagated: the status follows the worst per-path outcome. */
function deriveStatus(outcomes: Record<string, string>): string {
  if (Object.values(outcomes).some(outcome => outcome === OUTCOME_FAILED)) return STATUS_PARTIALLY_FAILED;
  if (Object.values(outcomes).every(outcome => outcome === OUTCOME_PROPAGATED)) return STATUS_PROPAGATED;
  return STATUS_ACCEPTED;
}

/** Record the paths the provider confirmed, and stamp the time the last of them landed. */
function markPropagated(purge: Purge, outcomes: Record<string, string>, at: string): void {
  Object.assign(purge.outcomes, outcomes);
  if (deriveStatus(purge.outcomes) === STATUS_PROPAGATED) purge.propagated_at = at;
}

app.get('/v1/purges/:purgeId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  // Fastify types route params as a generic record; this route declares :purgeId.
  const params = request.params as {purgeId: string};
  const purge = await store.get(params.purgeId);
  // A foreign purge is not found, not forbidden: this endpoint must not confirm an id exists.
  if (purge === null || purge.tenant !== tenant) return reply.code(404).send({error: 'no such purge'});
  const status = deriveStatus(purge.outcomes);
  if (!PURGE_STATUSES.includes(status)) return reply.code(500).send({error: 'unknown purge status'});
  return reply.code(200).send({
    purge_id: purge.purge_id,
    domain: purge.domain,
    status,
    outcomes: purge.outcomes,
    accepted_at: purge.accepted_at,
    propagated_at: status === STATUS_PROPAGATED ? purge.propagated_at : null,
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
	"net/http"
)

type Purge struct {
	PurgeID string            \`json:"purge_id"\`
	Tenant  string            \`json:"tenant"\`
	Domain  string            \`json:"domain"\`
	Paths   []string          \`json:"paths"\`
	Outcomes map[string]string \`json:"outcomes"\`
}

type PurgeStore struct{}

func (s *PurgeStore) Get(ctx context.Context, purgeID string) (*Purge, error) { return nil, nil }

var store = &PurgeStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func getPurge(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft reports done as soon as the provider accepted the batch, hides the paths
	// that failed, and lets any tenant read any purge. Review all three: a status derived from the
	// per-path outcomes with propagated_at only after confirmation, the full outcome map in the
	// response, and a 404 for a purge that belongs to another tenant.
	purge, _ := store.Get(r.Context(), r.URL.Query().Get("id"))
	outcomes := map[string]string{}
	for path, outcome := range purge.Outcomes {
		if outcome == "accepted" {
			outcomes[path] = outcome
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"purge_id": purge.PurgeID,
		"domain":   purge.Domain,
		"status":   "done",
		"outcomes": outcomes,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/purges/", getPurge)
	http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
)

const (
	statusAccepted        = "accepted"
	statusPropagated      = "propagated"
	statusPartiallyFailed = "partially_failed"

	outcomePropagated = "propagated"
	outcomeFailed     = "failed"
	outcomePending    = "pending"
)

var purgeStatuses = map[string]bool{
	statusAccepted:        true,
	statusPropagated:      true,
	statusPartiallyFailed: true,
}

type Purge struct {
	PurgeID      string            \`json:"purge_id"\`
	Tenant       string            \`json:"tenant"\`
	Domain       string            \`json:"domain"\`
	Paths        []string          \`json:"paths"\`
	Outcomes     map[string]string \`json:"outcomes"\`
	AcceptedAt   string            \`json:"accepted_at"\`
	PropagatedAt *string           \`json:"propagated_at"\`
}

type PurgeStore struct{}

func (s *PurgeStore) Get(ctx context.Context, purgeID string) (*Purge, error) { return nil, nil }

var store = &PurgeStore{}

// deriveStatus: accepted is not propagated — the status follows the worst per-path outcome.
func deriveStatus(outcomes map[string]string) string {
	for _, outcome := range outcomes {
		if outcome == outcomeFailed {
			return statusPartiallyFailed
		}
	}
	for _, outcome := range outcomes {
		if outcome != outcomePropagated {
			return statusAccepted
		}
	}
	return statusPropagated
}

// markPropagated records the paths the provider confirmed, and the time the last of them landed.
func markPropagated(purge *Purge, outcomes map[string]string, at string) {
	for path, outcome := range outcomes {
		purge.Outcomes[path] = outcome
	}
	if deriveStatus(purge.Outcomes) == statusPropagated {
		purge.PropagatedAt = &at
	}
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func getPurge(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	purge, err := store.Get(r.Context(), r.PathValue("purge_id"))
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	// A foreign purge is not found, not forbidden: this endpoint must not confirm an id exists.
	if purge == nil || purge.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such purge"})
		return
	}
	status := deriveStatus(purge.Outcomes)
	if !purgeStatuses[status] {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "unknown purge status"})
		return
	}
	propagatedAt := any(nil)
	if status == statusPropagated {
		propagatedAt = purge.PropagatedAt
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"purge_id":      purge.PurgeID,
		"domain":        purge.Domain,
		"status":        status,
		"outcomes":      purge.Outcomes,
		"accepted_at":   purge.AcceptedAt,
		"propagated_at": propagatedAt,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/purges/{purge_id}", getPurge)
	http.ListenAndServe(":8443", mux)
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
import spray.json.{JsNull, JsObject, JsString, JsValue, RootJsonFormat}

final case class Purge(
    purge_id: String,
    tenant: String,
    domain: String,
    paths: List[String],
    outcomes: Map[String, String],
    accepted_at: String,
    propagated_at: Option[String])

object PurgeReadApi {
  implicit val system: ActorSystem = ActorSystem("cdn-purge")
  implicit val purgeFormat: RootJsonFormat[Purge] = jsonFormat7(Purge)

  val store = PurgeStore.open()

  val route: Route =
    path("v1" / "purges" / Segment) { purgeId =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          // TODO: this draft reports done as soon as the provider accepted the batch, hides the
          // paths that failed, and lets any tenant read any purge. Review all three: a status
          // derived from the per-path outcomes with propagated_at only after confirmation, the
          // full outcome map in the response, and a 404 for a purge that belongs to another tenant.
          store.get(purgeId) match {
            case Some(purge) =>
              val accepted = purge.outcomes.filter { case (_, outcome) => outcome == "accepted" }
              complete(
                StatusCodes.OK,
                JsObject(
                  "purge_id" -> JsString(purge.purge_id),
                  "domain" -> JsString(purge.domain),
                  "status" -> JsString("done"),
                  "outcomes" -> JsObject(accepted.map { case (path, outcome) => path -> JsString(outcome) }),
                ))
            case None => complete(StatusCodes.NotFound, """{"error":"no such purge"}""")
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
import spray.json.{JsNull, JsObject, JsString, JsValue, RootJsonFormat}

final case class Purge(
    purge_id: String,
    tenant: String,
    domain: String,
    paths: List[String],
    outcomes: Map[String, String],
    accepted_at: String,
    propagated_at: Option[String])

object PurgeReadApi {
  implicit val system: ActorSystem = ActorSystem("cdn-purge")
  implicit val purgeFormat: RootJsonFormat[Purge] = jsonFormat7(Purge)

  val StatusAccepted = "accepted"
  val StatusPropagated = "propagated"
  val StatusPartiallyFailed = "partially_failed"
  val PurgeStatuses = Set(StatusAccepted, StatusPropagated, StatusPartiallyFailed)
  val OutcomePropagated = "propagated"
  val OutcomeFailed = "failed"
  val OutcomePending = "pending"

  val store = PurgeStore.open()

  // deriveStatus: accepted is not propagated — the status follows the worst per-path outcome.
  def deriveStatus(outcomes: Map[String, String]): String =
    if (outcomes.values.exists(_ == OutcomeFailed)) StatusPartiallyFailed
    else if (outcomes.values.forall(_ == OutcomePropagated)) StatusPropagated
    else StatusAccepted

  // markPropagated records the paths the provider confirmed, and the time the last of them landed.
  def markPropagated(purge: Purge, outcomes: Map[String, String], at: String): Purge = {
    val merged = purge.outcomes ++ outcomes
    if (deriveStatus(merged) == StatusPropagated) purge.copy(outcomes = merged, propagated_at = Some(at))
    else purge.copy(outcomes = merged)
  }

  val route: Route =
    path("v1" / "purges" / Segment) { purgeId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val tenant = tenantOpt.get
            store.get(purgeId) match {
              // A foreign purge is not found, not forbidden: this endpoint must not confirm an id exists.
              case None => complete(StatusCodes.NotFound, """{"error":"no such purge"}""")
              case Some(purge) if purge.tenant != tenant =>
                complete(StatusCodes.NotFound, """{"error":"no such purge"}""")
              case Some(purge) =>
                val status = deriveStatus(purge.outcomes)
                if (!PurgeStatuses.contains(status)) {
                  complete(StatusCodes.InternalServerError, """{"error":"unknown purge status"}""")
                } else {
                  val propagated =
                    if (status == StatusPropagated) purge.propagated_at.map(JsString(_): JsValue).getOrElse(JsNull)
                    else JsNull
                  complete(
                    StatusCodes.OK,
                    JsObject(
                      "purge_id" -> JsString(purge.purge_id),
                      "domain" -> JsString(purge.domain),
                      "status" -> JsString(status),
                      "outcomes" -> JsObject(purge.outcomes.map { case (path, outcome) => path -> JsString(outcome) }),
                      "accepted_at" -> JsString(purge.accepted_at),
                      "propagated_at" -> propagated,
                    ))
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

#include <map>
#include <optional>
#include <string>

using json = nlohmann::json;

struct PurgeStore {
  std::optional<json> get(const std::string& purgeId);
};

PurgeStore store;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/purges/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft reports done as soon as the provider accepted the batch, hides the paths
    // that failed, and lets any tenant read any purge. Review all three: a status derived from the
    // per-path outcomes with propagated_at only after confirmation, the full outcome map in the
    // response, and a 404 for a purge that belongs to another tenant.
    const auto purge = store.get(req.matches[1]);
    json outcomes = json::object();
    for (const auto& entry : (*purge)["outcomes"].items()) {
      if (entry.value() == "accepted") outcomes[entry.key()] = entry.value();
    }
    res.status = 200;
    res.set_content(
        json{{"purge_id", (*purge)["purge_id"]}, {"domain", (*purge)["domain"]}, {"status", "done"},
             {"outcomes", outcomes}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

const std::string kStatusAccepted = "accepted";
const std::string kStatusPropagated = "propagated";
const std::string kStatusPartiallyFailed = "partially_failed";
const std::set<std::string> kPurgeStatuses = {kStatusAccepted, kStatusPropagated, kStatusPartiallyFailed};
const std::string kOutcomePropagated = "propagated";
const std::string kOutcomeFailed = "failed";
const std::string kOutcomePending = "pending";

struct PurgeStore {
  std::optional<json> get(const std::string& purgeId);
};

PurgeStore store;

// deriveStatus: accepted is not propagated — the status follows the worst per-path outcome.
std::string deriveStatus(const std::map<std::string, std::string>& outcomes) {
  for (const auto& entry : outcomes) {
    if (entry.second == kOutcomeFailed) return kStatusPartiallyFailed;
  }
  for (const auto& entry : outcomes) {
    if (entry.second != kOutcomePropagated) return kStatusAccepted;
  }
  return kStatusPropagated;
}

// markPropagated records the paths the provider confirmed, and the time the last of them landed.
void markPropagated(json& purge, const std::map<std::string, std::string>& outcomes, const std::string& at) {
  for (const auto& entry : outcomes) purge["outcomes"][entry.first] = entry.second;
  if (deriveStatus(purge["outcomes"].get<std::map<std::string, std::string>>()) == kStatusPropagated) {
    purge["propagated_at"] = at;
  }
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/purges/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto purge = store.get(req.matches[1]);
    // A foreign purge is not found, not forbidden: this endpoint must not confirm an id exists.
    if (!purge || (*purge)["tenant"].get<std::string>() != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"no such purge"})", "application/json");
      return;
    }
    const auto outcomes = (*purge)["outcomes"].get<std::map<std::string, std::string>>();
    const auto status = deriveStatus(outcomes);
    if (kPurgeStatuses.count(status) == 0) {
      res.status = 500;
      res.set_content(R"({"error":"unknown purge status"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(
        json{{"purge_id", (*purge)["purge_id"]},
             {"domain", (*purge)["domain"]},
             {"status", status},
             {"outcomes", (*purge)["outcomes"]},
             {"accepted_at", (*purge)["accepted_at"]},
             {"propagated_at", status == kStatusPropagated ? (*purge)["propagated_at"] : json(nullptr)}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Model the purge as the provider reports it: a map from path to outcome, where a path is `pending`, `propagated` or `failed`. `derive_status` then has three cases in priority order — any failure wins, then all propagated, otherwise accepted — and no case in which the endpoint can say the cache is clean before the edges agree.',
    'Stamp `propagated_at` where the confirmation arrives (`mark_propagated`), not where the purge is accepted: the provider’s 200 means it took the request, the confirmation means every edge has dropped the object. Until then the field is null, and the status stays accepted.',
    'Scope the read by tenant and answer 404 for anything that is not the caller’s own purge — the same status a nonexistent id gets, so the endpoint never leaks that another tenant’s purge id is real. Return the outcomes map whole: the failed paths are the payload an operator is reading this endpoint for.',
  ],
  debrief: `The interviewer is testing whether the status endpoint can be trusted at 3 a.m. The draft reads fine because the provider is healthy in the demo and every path is accepted, so \`done\` and \`propagated\` coincide. Three contracts are being checked. First, the vocabulary: \`accepted\`, \`propagated\`, \`partially_failed\` map to what the system actually knows, and a word like \`done\` claims something the service cannot verify while edges are catching up — the six-hour stale-pricing incident is exactly that word being believed. Second, the failure surface: hiding the paths that failed turns a partial purge into a silent one, and the operator cannot fix what the response does not show. Third, tenancy: a purge id is a capability, so a foreign read is 404 rather than 403, and the response never confirms that somebody else's purge exists. Real platforms add a \`Retry-After\`-style hint for a pending purge, per-POP propagation detail from the event stream, and an alert when a purge stays \`accepted\` for longer than the propagation SLO.`,
};
