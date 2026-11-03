import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/scores: features from the server, not the caller',
  concept: 'http',
  file: 'api',
  focus: ['client', 'scorer', 'accounts', 'model'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/scores\` with body
\`{"transaction_id": "tx-…", "account_ref": "acct-…"}\`: it parses the body, reads
\`body.features["declared_risk"]\`, calls the model, writes the result with \`scores.put\` and returns a
band. It serves the demo and hides four flaws.

**Failure mode the checks target.** Caller-supplied features let the entity being scored write its
own risk: a probe account declares itself low-risk and gets approved. The same handler scores accounts
that do not exist and scores every retry again, which inflates the velocity counters the next step
builds on and bills a model call each time.

- \`account_ref\` must resolve in the server's own account store (\`accounts.get(account_ref)\`). An
  unknown account is **404** (\`UNKNOWN_ACCOUNT\`), refused before any feature derivation or model
  work.
- Features are derived server-side by \`derive_features(account, transaction_id)\` and carry a pinned
  \`FEATURE_VERSION\`, so a decision can be replayed later. Anything the caller sends under
  \`features\` or \`declared_risk\` is ignored.
- \`transaction_id\` is the dedupe key: \`scores.get(transaction_id)\` answers a replay with the
  stored decision; only a first sighting is scored and written with
  \`scores.put(transaction_id, result)\`.
- The stored decision carries the score, the band, the feature version and the fallback marker. The
  log line carries ids and the band, not the feature vector, which describes a person.`,
  sequence: {
    participants: ['Merchant client', 'Fraud Scorer', 'Accounts', 'Fraud model'],
    messages: [
      {
        from: 'Merchant client',
        to: 'Fraud Scorer',
        label: 'POST /v1/scores · transaction_id · account_ref',
        kind: 'sync',
      },
      {from: 'Fraud Scorer', to: 'Accounts', label: 'accounts.get(account_ref)', kind: 'sync'},
      {from: 'Accounts', to: 'Fraud Scorer', label: 'account / none', kind: 'reply'},
      {from: 'Fraud Scorer', to: 'Fraud Scorer', label: '404 unknown account', kind: 'sync'},
      {from: 'Fraud Scorer', to: 'Fraud Scorer', label: 'scores.get(transaction_id) → stored', kind: 'sync'},
      {from: 'Fraud Scorer', to: 'Fraud Scorer', label: 'derive_features(account, transaction_id)', kind: 'sync'},
      {from: 'Fraud Scorer', to: 'Fraud model', label: 'Score(features) · 300 ms', kind: 'sync'},
      {from: 'Fraud model', to: 'Fraud Scorer', label: 'score · model version', kind: 'reply'},
      {from: 'Fraud Scorer', to: 'Merchant client', label: '200 {score, band, feature_version}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/scores',
      detail: 'Register the scoring route on `POST /v1/scores`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/scores["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/scores['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/scores"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"scores"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/scores"/]},
      },
    },
    {
      id: 'server-features',
      title: 'Features are derived server-side, at a pinned version',
      detail:
        'The feature vector comes from `derive_features(account, transaction_id)` and carries `FEATURE_VERSION`; nothing the caller sends under `features`/`declared_risk` is read. The starter builds the score from the request body, so the entity being scored grades its own exam.',
      match: {
        python: {all: [/def derive_features\(/, /FEATURE_VERSION/], none: [/body\.features/]},
        typescript: {all: [/function deriveFeatures\(/, /FEATURE_VERSION/], none: [/body\.features/]},
        go: {all: [/func deriveFeatures\(/, /featureVersion/], none: [/body\.Features/]},
        scala: {all: [/def deriveFeatures\(/, /FeatureVersion/], none: [/body\.features/]},
        cpp: {all: [/deriveFeatures\(/, /kFeatureVersion/], none: [/body\.value\(\s*"features"|body\["features"\]/]},
      },
    },
    {
      id: 'account-404',
      title: 'Refuses an unknown account with 404',
      detail:
        'An `account_ref` that does not resolve is **404** and the request stops there: no features, no model call. The starter never looks the account up, so a probe account is scored like a real one.',
      match: {
        python: {all: [/UNKNOWN_ACCOUNT/, /status_code\s*=\s*404/]},
        typescript: {all: [/UNKNOWN_ACCOUNT/, /code\(\s*404\s*\)/]},
        go: {all: [/unknownAccount/, /StatusNotFound/]},
        scala: {all: [/UnknownAccount/, /StatusCodes\.NotFound/]},
        cpp: {all: [/kUnknownAccount/, /status\s*=\s*404/]},
      },
    },
    {
      id: 'replay-dedupe',
      title: 'A replayed transaction id returns the stored score',
      detail:
        'The decision is read back with `scores.get(transaction_id)` before any model work and written with `scores.put(transaction_id, result)` only for a first sighting. The starter writes every decision but reads none back, so each retry is scored as a new decision.',
      match: {
        python: {all: [/scores\.get\(/, /scores\.put\(/]},
        typescript: {all: [/scores\.get\(/, /scores\.put\(/]},
        go: {all: [/scores\.Get\(/, /scores\.Put\(/]},
        scala: {all: [/scores\.get\(/, /scores\.put\(/]},
        cpp: {all: [/scores\.get\(/, /scores\.put\(/]},
      },
    },
    {
      id: 'account-before-model',
      title: 'The account lookup happens before the model call',
      detail:
        'The account is resolved before the model is asked anything, so an unknown account never reaches the model. A lookup that runs after the call has already spent the deadline, the money and the velocity write on a request that had to be refused.',
      match: {
        python: {order: [/accounts\.get\(/, /model\.score\(/]},
        typescript: {order: [/accounts\.get\(/, /model\.score\(/]},
        go: {order: [/accounts\.Get\(/, /model\.Score\(/]},
        scala: {order: [/accounts\.get\(/, /model\.score\(/]},
        cpp: {order: [/accounts\.get\(/, /model\.score\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("scoring")


class ScoreRequest(BaseModel):
    transaction_id: str
    account_ref: str
    features: dict = {}


class AccountStore:
    def get(self, ref: str) -> dict | None:
        """The account record for \`ref\`, or None when the scorer has never seen it."""
        raise NotImplementedError


class ScoreStore:
    def put(self, transaction_id: str, decision: dict) -> None:
        """Store the decision under the transaction id."""
        raise NotImplementedError


class ModelClient:
    def score(self, features: dict) -> dict:
        """The fraud model over gRPC (see the client step for the deadline and the fallback)."""
        raise NotImplementedError


accounts = AccountStore()
scores = ScoreStore()
model = ModelClient()


@app.post("/v1/scores")
def score(body: ScoreRequest) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    declared = body.features
    declared_risk = float(declared.get("declared_risk", 0.0))
    scored = model.score(declared)
    result = {
        "transaction_id": body.transaction_id,
        "account_ref": body.account_ref,
        "score": round(1.0 - declared_risk, 4),
        "band": "approve" if declared_risk < 0.30 else "review",
        "feature_version": "caller",
    }
    scores.put(body.transaction_id, result)
    logger.info("scored tx=%s account=%s band=%s", body.transaction_id, body.account_ref, result["band"])
    return JSONResponse(result, status_code=200)
`,
      solution: `import hashlib
import logging

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

app = FastAPI()
logger = logging.getLogger("scoring")

FEATURE_VERSION = "fx-3"
APPROVE_BAND_MAX = 0.30
REVIEW_BAND_MAX = 0.70
UNKNOWN_ACCOUNT = "unknown_account"


class ScoreRequest(BaseModel):
    # A caller may send features, declared_risk, score — none of them is part of the contract, and
    # the model drops every field it does not declare.
    model_config = ConfigDict(extra="ignore")

    transaction_id: str
    account_ref: str


class AccountStore:
    def get(self, ref: str) -> dict | None:
        """The account record for \`ref\`, or None when the scorer has never seen it."""
        raise NotImplementedError


class ScoreStore:
    def get(self, transaction_id: str) -> dict | None:
        """The decision already stored for this transaction, if any."""
        raise NotImplementedError

    def put(self, transaction_id: str, decision: dict) -> None:
        """Store the decision under the transaction id."""
        raise NotImplementedError


class ModelClient:
    def score(self, features: dict) -> dict:
        """The fraud model over gRPC (see the client step for the deadline and the fallback)."""
        raise NotImplementedError


accounts = AccountStore()
scores = ScoreStore()
model = ModelClient()


def band_for(score: float) -> str:
    if score <= APPROVE_BAND_MAX:
        return "approve"
    if score <= REVIEW_BAND_MAX:
        return "review"
    return "decline"


def derive_features(account: dict, transaction_id: str) -> dict:
    """The server's own view of the transaction: tenure, history, amount band and a tx handle."""
    tx_ref = hashlib.sha256(transaction_id.encode("utf-8")).hexdigest()[:16]
    return {
        "version": FEATURE_VERSION,
        "account_age_days": int(account.get("age_days", 0)),
        "prior_chargebacks": int(account.get("chargebacks", 0)),
        "amount_band": str(account.get("amount_band", "unknown")),
        "tx_ref": tx_ref,
    }


@app.post("/v1/scores")
def score(body: ScoreRequest) -> JSONResponse:
    account = accounts.get(body.account_ref)
    if account is None:
        raise HTTPException(status_code=404, detail=UNKNOWN_ACCOUNT)

    stored = scores.get(body.transaction_id)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    features = derive_features(account, body.transaction_id)
    scored = model.score(features)
    result = {
        "transaction_id": body.transaction_id,
        "account_ref": body.account_ref,
        "score": scored["score"],
        "band": band_for(scored["score"]),
        "feature_version": features["version"],
        "fallback": scored.get("fallback", False),
    }
    scores.put(body.transaction_id, result)
    logger.info("scored tx=%s account=%s band=%s", body.transaction_id, body.account_ref, result["band"])
    return JSONResponse(result, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/scores. */
import Fastify from 'fastify';

export const app = Fastify();

interface ScoreBody {
  transaction_id: string;
  account_ref: string;
  features?: Record<string, number>;
}

interface ScoreDecision {
  transaction_id: string;
  account_ref: string;
  score: number;
  band: string;
  feature_version: string;
}

class AccountStore {
  async get(ref: string): Promise<Record<string, unknown> | null> {
    return null;
  }
}

class ScoreStore {
  async put(transactionId: string, decision: ScoreDecision): Promise<void> {}
}

class ModelClient {
  async score(features: Record<string, number>): Promise<{score: number; fallback: boolean}> {
    return {score: 0.5, fallback: false};
  }
}

const accounts = new AccountStore();
const scores = new ScoreStore();
const model = new ModelClient();

function bandFor(score: number): string {
  if (score <= 0.3) return 'approve';
  if (score <= 0.7) return 'review';
  return 'decline';
}

app.post('/v1/scores', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const body = request.body as ScoreBody;
  const declared = body.features ?? {};
  await model.score(declared);
  const result: ScoreDecision = {
    transaction_id: body.transaction_id,
    account_ref: body.account_ref,
    score: Math.round((1 - (declared.declared_risk ?? 0)) * 10000) / 10000,
    band: bandFor(declared.declared_risk ?? 0),
    feature_version: 'caller',
  };
  await scores.put(body.transaction_id, result);
  request.log.info({tx: body.transaction_id, account: body.account_ref, band: result.band}, 'scored');
  return reply.code(200).send(result);
});

await app.listen({host: '0.0.0.0', port: 8443});
`,
      solution: `/** POST /v1/scores: server-derived features, a required account, and a dedupe key. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const FEATURE_VERSION = 'fx-3';
const APPROVE_BAND_MAX = 0.3;
const REVIEW_BAND_MAX = 0.7;
const UNKNOWN_ACCOUNT = 'unknown_account';

interface ScoreBody {
  transaction_id: string;
  account_ref: string;
}

interface FeatureVector {
  version: string;
  account_age_days: number;
  prior_chargebacks: number;
  amount_band: string;
  tx_ref: string;
}

interface ScoreDecision {
  transaction_id: string;
  account_ref: string;
  score: number;
  band: string;
  feature_version: string;
  fallback: boolean;
}

class AccountStore {
  async get(ref: string): Promise<Record<string, unknown> | null> {
    return null;
  }
}

class ScoreStore {
  async get(transactionId: string): Promise<ScoreDecision | null> {
    return null;
  }

  async put(transactionId: string, decision: ScoreDecision): Promise<void> {}
}

class ModelClient {
  async score(features: FeatureVector): Promise<{score: number; fallback: boolean}> {
    return {score: 0.5, fallback: false};
  }
}

const accounts = new AccountStore();
const scores = new ScoreStore();
const model = new ModelClient();

function bandFor(score: number): string {
  if (score <= APPROVE_BAND_MAX) return 'approve';
  if (score <= REVIEW_BAND_MAX) return 'review';
  return 'decline';
}

function deriveFeatures(account: Record<string, unknown>, transactionId: string): FeatureVector {
  return {
    version: FEATURE_VERSION,
    account_age_days: Number(account.age_days ?? 0),
    prior_chargebacks: Number(account.chargebacks ?? 0),
    amount_band: String(account.amount_band ?? 'unknown'),
    tx_ref: createHash('sha256').update(transactionId).digest('hex').slice(0, 16),
  };
}

app.post('/v1/scores', async (request, reply) => {
  const body = request.body as Partial<ScoreBody> | null;
  if (body === null || typeof body !== 'object') return reply.code(400).send({error: 'invalid body'});
  if (typeof body.transaction_id !== 'string' || typeof body.account_ref !== 'string')
    return reply.code(400).send({error: 'transaction_id and account_ref are required'});

  const account = await accounts.get(body.account_ref);
  if (account === null) return reply.code(404).send({error: UNKNOWN_ACCOUNT});

  const stored = await scores.get(body.transaction_id);
  if (stored !== null) return reply.code(200).send(stored);

  const features = deriveFeatures(account, body.transaction_id);
  const scored = await model.score(features);
  const decision: ScoreDecision = {
    transaction_id: body.transaction_id,
    account_ref: body.account_ref,
    score: scored.score,
    band: bandFor(scored.score),
    feature_version: features.version,
    fallback: scored.fallback,
  };
  await scores.put(body.transaction_id, decision);
  request.log.info({tx: body.transaction_id, account: body.account_ref, band: decision.band}, 'scored');
  return reply.code(200).send(decision);
});

await app.listen({host: '0.0.0.0', port: 8443});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

type ScoreRequest struct {
	TransactionID string             \`json:"transaction_id"\`
	AccountRef    string             \`json:"account_ref"\`
	Features      map[string]float64 \`json:"features"\`
}

type AccountStore struct{}

func (s *AccountStore) Get(ctx context.Context, ref string) (map[string]any, error) {
	return nil, nil
}

type ScoreStore struct{}

func (s *ScoreStore) Put(ctx context.Context, transactionID string, decision map[string]any) error {
	return nil
}

type ModelClient interface {
	Score(ctx context.Context, features map[string]float64) (map[string]any, error)
}

var accounts = &AccountStore{}
var scores = &ScoreStore{}
var model ModelClient

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func score(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	var body ScoreRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	scored, err := model.Score(r.Context(), body.Features)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "model unavailable"})
		return
	}
	decision := map[string]any{
		"transaction_id":  body.TransactionID,
		"account_ref":     body.AccountRef,
		"score":           1 - body.Features["declared_risk"],
		"feature_version": "caller",
		"model_score":     scored["score"],
	}
	_ = scores.Put(r.Context(), body.TransactionID, decision)
	log.Printf("scored tx=%s account=%s", body.TransactionID, body.AccountRef)
	writeJSON(rw, http.StatusOK, decision)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/scores", score)
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
)

const (
	featureVersion = "fx-3"
	approveBandMax = 0.30
	reviewBandMax  = 0.70
	unknownAccount = "unknown_account"
)

// The body names the transaction and the account: every risk opinion a caller adds to it is
// dropped by the decoder, so the caller cannot write its own risk.
type ScoreRequest struct {
	TransactionID string \`json:"transaction_id"\`
	AccountRef    string \`json:"account_ref"\`
}

type FeatureVector struct {
	Version          string \`json:"version"\`
	AccountAgeDays   int    \`json:"account_age_days"\`
	PriorChargebacks int    \`json:"prior_chargebacks"\`
	AmountBand       string \`json:"amount_band"\`
	TxRef            string \`json:"tx_ref"\`
}

type AccountStore struct{}

func (s *AccountStore) Get(ctx context.Context, ref string) (map[string]any, error) {
	return nil, nil
}

type ScoreStore struct{}

func (s *ScoreStore) Get(ctx context.Context, transactionID string) (map[string]any, error) {
	return nil, nil
}

func (s *ScoreStore) Put(ctx context.Context, transactionID string, decision map[string]any) error {
	return nil
}

type ModelClient interface {
	Score(ctx context.Context, features FeatureVector) (map[string]any, error)
}

var accounts = &AccountStore{}
var scores = &ScoreStore{}
var model ModelClient

func bandFor(score float64) string {
	switch {
	case score <= approveBandMax:
		return "approve"
	case score <= reviewBandMax:
		return "review"
	default:
		return "decline"
	}
}

func deriveFeatures(account map[string]any, transactionID string) FeatureVector {
	sum := sha256.Sum256([]byte(transactionID))
	age, _ := account["age_days"].(int)
	chargebacks, _ := account["chargebacks"].(int)
	band, _ := account["amount_band"].(string)
	return FeatureVector{
		Version:          featureVersion,
		AccountAgeDays:   age,
		PriorChargebacks: chargebacks,
		AmountBand:       band,
		TxRef:            hex.EncodeToString(sum[:])[:16],
	}
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func score(rw http.ResponseWriter, r *http.Request) {
	var body ScoreRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	account, err := accounts.Get(r.Context(), body.AccountRef)
	if err != nil || account == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": unknownAccount})
		return
	}
	stored, err := scores.Get(r.Context(), body.TransactionID)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "store unavailable"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	features := deriveFeatures(account, body.TransactionID)
	scored, err := model.Score(r.Context(), features)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "model unavailable"})
		return
	}
	value, _ := scored["score"].(float64)
	decision := map[string]any{
		"transaction_id":  body.TransactionID,
		"account_ref":     body.AccountRef,
		"score":           value,
		"band":            bandFor(value),
		"feature_version": features.Version,
		"fallback":        scored["fallback"],
	}
	if err := scores.Put(r.Context(), body.TransactionID, decision); err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "store unavailable"})
		return
	}
	log.Printf("scored tx=%s account=%s band=%s", body.TransactionID, body.AccountRef, bandFor(value))
	writeJSON(rw, http.StatusOK, decision)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/scores", score)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object Api {
  case class ScoreRequest(transactionId: String, accountRef: String, features: Map[String, Double] = Map.empty)

  val scores = new ScoreStore

  class AccountStore {
    def get(ref: String): Option[JsObject] = None
  }

  class ScoreStore {
    def put(transactionId: String, decision: JsObject): Unit = ()
  }

  class ModelClient {
    def score(features: Map[String, Double]): JsObject = JsObject("score" -> JsNumber(0.5))
  }

  val accounts = new AccountStore
  val model = new ModelClient

  def bandFor(score: Double): String =
    if (score <= 0.3) "approve" else if (score <= 0.7) "review" else "decline"

  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  def score(request: ScoreRequest): JsObject = {
    val declared = request.features.getOrElse("declared_risk", 0.0)
    model.score(request.features)
    val decision = JsObject(
      "transaction_id" -> JsString(request.transactionId),
      "account_ref" -> JsString(request.accountRef),
      "score" -> JsNumber(1.0 - declared),
      "band" -> JsString(bandFor(declared)),
      "feature_version" -> JsString("caller"),
    )
    scores.put(request.transactionId, decision)
    decision
  }

  val route: Route =
    path("v1" / "scores") {
      post {
        entity(as[String]) { raw =>
          complete(score(raw.parseJson.convertTo[ScoreRequest]).compactPrint)
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("scoring")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object Api {
  val FeatureVersion = "fx-3"
  val ApproveBandMax = 0.30
  val ReviewBandMax = 0.70
  val UnknownAccount = "unknown_account"

  case class ScoreRequest(transactionId: String, accountRef: String)

  class AccountStore {
    def get(ref: String): Option[JsObject] = None
  }

  class ScoreStore {
    def get(transactionId: String): Option[JsObject] = None
    def put(transactionId: String, decision: JsObject): Unit = ()
  }

  class ModelClient {
    def score(features: JsObject): JsObject = JsObject("score" -> JsNumber(0.5), "fallback" -> JsBoolean(false))
  }

  val accounts = new AccountStore
  val scores = new ScoreStore
  val model = new ModelClient

  def bandFor(score: Double): String =
    if (score <= ApproveBandMax) "approve" else if (score <= ReviewBandMax) "review" else "decline"

  def deriveFeatures(account: JsObject, transactionId: String): JsObject = {
    val digest = MessageDigest.getInstance("SHA-256").digest(transactionId.getBytes("UTF-8"))
    JsObject(
      "version" -> JsString(FeatureVersion),
      "account_age_days" -> JsNumber(account.fields.getOrElse("age_days", JsNumber(0)).convertTo[Int]),
      "prior_chargebacks" -> JsNumber(account.fields.getOrElse("chargebacks", JsNumber(0)).convertTo[Int]),
      "amount_band" -> JsString(account.fields.getOrElse("amount_band", JsString("unknown")).convertTo[String]),
      "tx_ref" -> JsString(digest.take(8).map("%02x".format(_)).mkString),
    )
  }

  def score(request: ScoreRequest): Either[(StatusCode, String), JsObject] = {
    accounts.get(request.accountRef) match {
      case None => Left((StatusCodes.NotFound, s"""{"error":"$UnknownAccount"}"""))
      case Some(account) =>
        scores.get(request.transactionId) match {
          case Some(stored) => Right(stored)
          case None =>
            val features = deriveFeatures(account, request.transactionId)
            val scored = model.score(features)
            val value = scored.fields("score").convertTo[Double]
            val decision = JsObject(
              "transaction_id" -> JsString(request.transactionId),
              "account_ref" -> JsString(request.accountRef),
              "score" -> JsNumber(value),
              "band" -> JsString(bandFor(value)),
              "feature_version" -> JsString(FeatureVersion),
              "fallback" -> scored.fields.getOrElse("fallback", JsBoolean(false)),
            )
            scores.put(request.transactionId, decision)
            Right(decision)
        }
    }
  }

  val route: Route =
    path("v1" / "scores") {
      post {
        entity(as[String]) { raw =>
          score(raw.parseJson.convertTo[ScoreRequest]) match {
            case Left((status, body)) => complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))
            case Right(decision) => complete(HttpEntity(ContentTypes.\`application/json\`, decision.compactPrint))
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("scoring")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `// POST /v1/scores.
#include <string>

#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

class AccountStore {
 public:
  json get(const std::string& ref) { return json(); }
};

class ScoreStore {
 public:
  void put(const std::string& transaction_id, const json& decision) {}
};

// The gRPC model client; the client step adds the deadline, the retry policy and the rules
// fallback.
class ModelClient {
 public:
  json score(const json& features) { return json{{"score", 0.5}, {"fallback", false}}; }
};

static AccountStore accounts;
static ScoreStore scores;
static ModelClient model;

int main() {
  httplib::Server svr;

  svr.Post("/v1/scores", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content("{\\"error\\":\\"invalid json\\"}", "application/json");
      return;
    }
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const json declared = body.value("features", json::object());
    const double declared_risk = declared.value("declared_risk", 0.0);
    const json scored = model.score(declared);
    const std::string transaction_id = body.value("transaction_id", std::string());
    const json decision = {
        {"transaction_id", transaction_id},
        {"account_ref", body.value("account_ref", std::string())},
        {"score", 1.0 - declared_risk},
        {"feature_version", "caller"},
        {"model_score", scored.value("score", 0.5)},
    };
    scores.put(transaction_id, decision);
    res.status = 200;
    res.set_content(decision.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <functional>
#include <string>

#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

constexpr const char* kFeatureVersion = "fx-3";
constexpr double kApproveBandMax = 0.30;
constexpr double kReviewBandMax = 0.70;
constexpr const char* kUnknownAccount = "unknown_account";

class AccountStore {
 public:
  json get(const std::string& ref) { return json(); }
};

class ScoreStore {
 public:
  json get(const std::string& transaction_id) { return json(); }
  void put(const std::string& transaction_id, const json& decision) {}
};

// The gRPC model client; the client step adds the deadline, the retry policy and the rules
// fallback.
class ModelClient {
 public:
  json score(const json& features) { return json{{"score", 0.5}, {"fallback", false}}; }
};

static AccountStore accounts;
static ScoreStore scores;
static ModelClient model;

static std::string bandFor(double score) {
  if (score <= kApproveBandMax) return "approve";
  if (score <= kReviewBandMax) return "review";
  return "decline";
}

// The server's own view of the transaction: tenure, history, amount band and a transaction handle.
static json deriveFeatures(const json& account, const std::string& transaction_id) {
  return json{
      {"version", kFeatureVersion},
      {"account_age_days", account.value("age_days", 0)},
      {"prior_chargebacks", account.value("chargebacks", 0)},
      {"amount_band", account.value("amount_band", std::string("unknown"))},
      {"tx_ref", std::to_string(std::hash<std::string>{}(transaction_id))},
  };
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/scores", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("transaction_id") || !body.contains("account_ref")) {
      res.status = 400;
      res.set_content("{\\"error\\":\\"transaction_id and account_ref are required\\"}", "application/json");
      return;
    }
    const auto transaction_id = body["transaction_id"].get<std::string>();
    const auto account_ref = body["account_ref"].get<std::string>();

    const json account = accounts.get(account_ref);
    if (account.is_null()) {
      res.status = 404;
      res.set_content(json{{"error", kUnknownAccount}}.dump(), "application/json");
      return;
    }
    const json stored = scores.get(transaction_id);
    if (!stored.is_null()) {
      res.status = 200;
      res.set_content(stored.dump(), "application/json");
      return;
    }
    const json features = deriveFeatures(account, transaction_id);
    const json scored = model.score(features);
    const double score = scored.value("score", 0.5);
    const json decision = {
        {"transaction_id", transaction_id},
        {"account_ref", account_ref},
        {"score", score},
        {"band", bandFor(score)},
        {"feature_version", features["version"]},
        {"fallback", scored.value("fallback", false)},
    };
    scores.put(transaction_id, decision);
    res.status = 200;
    res.set_content(decision.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Send the same body twice with `declared_risk: 0` and an account that does not exist: both calls return `approve`, the second one costs a second model round trip.',
    'The handler reads `body.features`, so the caller sets the input, and nothing consults `accounts` or reads `scores` before `model.score` runs.',
    'Drop `features` from the request model; `accounts.get` (404 on miss), then `scores.get` (return a hit), then `derive_features(account, transaction_id)` with `FEATURE_VERSION`, then the model, then `scores.put`.',
  ],
  debrief: `The guards sit in cost order because each one makes the next unnecessary: an unknown account costs one store read, a replay costs one more, and only a first sighting for a real account pays for feature derivation and a model round trip. Deriving the vector server-side at a pinned \`FEATURE_VERSION\` is what makes the stored decision replayable: six months later the same account history and the same version reproduce the same score, which is what a disputed approval needs. Production scorers go further than this step: they hash the transaction fingerprint so the dedupe store holds no PII, record the model version next to the feature version in the decision, and sign the decision record so a replay can be checked against the original.
`,
};
