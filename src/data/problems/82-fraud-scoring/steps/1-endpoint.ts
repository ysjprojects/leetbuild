import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/scores: features from the server, not the caller',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'scorer', 'redis', 'model'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/scores\` with body
\`{"transaction_id", "account_ref", "amount_cents"}\`: it builds the feature vector from the body's
optional \`features\` object (defaulting to \`FEATURE_VERSION\` and zeros), scores it with
\`model.score_transaction\`, stores the decision with \`store.save_decision\` and answers it. It
serves the demo and hides three flaws.

**Failure mode the checks target.** A probe account sends \`features\` describing itself as ten years
old with no chargebacks and is approved; an account the scorer has never seen is scored and costs a
model call; and a client that retries after a timeout gets a second, fresh decision for the same
transaction.

- Look the account up first (\`store.get_account\`): an unknown one is **404**, before any model call
  and without a stored decision.
- The vector is \`features.derive_features(account, amount_cents)\`; nothing else the caller sends is
  read.
- \`transaction_id\` is the dedupe key: \`store.get_decision\` answers a replay with the stored
  decision; only a first sighting calls the model and is saved.
- The decision is \`{transaction_id, account_ref, score, band, fallback, model_version,
  feature_version}\`.`,
  sequence: {
    participants: ['Merchant client', 'scorer', 'Redis', 'Fraud model'],
    messages: [
      {from: 'Merchant client', to: 'scorer', label: 'POST /v1/scores · transaction_id · account_ref', kind: 'sync'},
      {from: 'scorer', to: 'Redis', label: 'get_account(account_ref) → none: 404', kind: 'sync'},
      {from: 'scorer', to: 'Redis', label: 'get_decision(transaction_id) → stored: answer it', kind: 'sync'},
      {from: 'scorer', to: 'scorer', label: 'derive_features(account, amount_cents)', kind: 'sync'},
      {from: 'scorer', to: 'Fraud model', label: 'Score(vector) · 300 ms', kind: 'sync'},
      {from: 'Fraud model', to: 'scorer', label: 'score · model_version', kind: 'reply'},
      {from: 'scorer', to: 'Redis', label: 'save_decision(decision)', kind: 'sync'},
      {from: 'scorer', to: 'Merchant client', label: '200 {score, band, feature_version}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Scores a transaction on POST /v1/scores',
      detail: 'Register `POST /v1/scores`; a known account gets a decision with its transaction id, score and band.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/scores["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/scores['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/scores"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"scores"\s*\)/, /\bpost\b/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/scores"/]},
      },
    },
    {
      id: 'server-features',
      title: 'The feature vector comes from the account store',
      detail:
        "The vector the model sees is `derive_features(account, amount_cents)` at `FEATURE_VERSION`; the body's `features` object is not read, so an account cannot describe its own age or chargeback history.",
      match: {
        python: {all: [/features\.derive_features\(/], none: [/body\.features/]},
        typescript: {all: [/deriveFeatures\(/], none: [/body\.features/]},
        go: {all: [/features\.DeriveFeatures\(/], none: [/body\.Features/]},
        scala: {all: [/Features\.deriveFeatures\(/], none: [/"features"/]},
        cpp: {all: [/features::deriveFeatures\(/], none: [/"features"/]},
      },
    },
    {
      id: 'account-404',
      title: 'An unknown account is 404 before any model call',
      detail:
        'The account is read (`store.get_account`) before anything else; a miss answers **404**, calls no model and stores no decision.',
      match: {
        python: {
          all: [/store\.get_account\(/, /\b404\b/],
          order: [/store\.get_account\(/, /model\.score_transaction\(/],
        },
        typescript: {all: [/getAccount\(/, /\b404\b/], order: [/getAccount\(body/, /scoreTransaction\(/]},
        go: {
          all: [/store\.GetAccount\(/, /StatusNotFound|\b404\b/],
          order: [/store\.GetAccount\(/, /model\.ScoreTransaction\(/],
        },
        scala: {all: [/Store\.getAccount\(/, /NotFound/], order: [/Store\.getAccount\(/, /Model\.scoreTransaction\(/]},
        cpp: {all: [/store::getAccount\(/, /\b404\b/], order: [/store::getAccount\(/, /model::scoreTransaction\(/]},
      },
    },
    {
      id: 'replay-dedupe',
      title: 'A replayed transaction id answers the stored decision',
      detail:
        '`store.get_decision(transaction_id)` is read before the model is called and answers a replay; only a first sighting is scored and saved.',
      match: {
        python: {all: [/store\.get_decision\(/], order: [/store\.get_decision\(/, /model\.score_transaction\(/]},
        typescript: {all: [/getDecision\(body/], order: [/getDecision\(body/, /scoreTransaction\(/]},
        go: {all: [/store\.GetDecision\(/], order: [/store\.GetDecision\(/, /model\.ScoreTransaction\(/]},
        scala: {all: [/Store\.getDecision\(/], order: [/Store\.getDecision\(/, /Model\.scoreTransaction\(/]},
        cpp: {all: [/store::getDecision\(/], order: [/store::getDecision\(/, /model::scoreTransaction\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from pydantic import BaseModel

from fraud import features, model, store  # features.derive_features; model.score_transaction; store.get_account, get_decision, save_decision

app = FastAPI()


class ScoreBody(BaseModel):
    transaction_id: str
    account_ref: str
    amount_cents: int
    features: dict = {}


@app.post("/v1/scores")
def score(body: ScoreBody) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    vector = {
        "feature_version": body.features.get("feature_version", features.FEATURE_VERSION),
        "account_age_days": int(body.features.get("account_age_days", 0)),
        "prior_chargebacks": int(body.features.get("prior_chargebacks", 0)),
        "amount_cents": body.amount_cents,
    }
    verdict = model.score_transaction(vector)
    decision = {"transaction_id": body.transaction_id, "account_ref": body.account_ref, **verdict, "feature_version": vector["feature_version"]}
    store.save_decision(decision)
    return decision
`,
      solution: `from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from fraud import features, model, store  # features.derive_features; model.score_transaction; store.get_account, get_decision, save_decision

app = FastAPI()


class ScoreBody(BaseModel):
    # Anything else in the body is ignored: the entity being scored does not describe itself.
    transaction_id: str
    account_ref: str
    amount_cents: int


@app.post("/v1/scores")
def score(body: ScoreBody) -> dict:
    account = store.get_account(body.account_ref)
    if account is None:
        raise HTTPException(status_code=404, detail="unknown account")
    stored = store.get_decision(body.transaction_id)
    if stored is not None:
        return stored  # a retry answers the first decision
    vector = features.derive_features(account, body.amount_cents)
    verdict = model.score_transaction(vector)
    decision = {"transaction_id": body.transaction_id, "account_ref": body.account_ref, **verdict, "feature_version": vector["feature_version"]}
    store.save_decision(decision)
    return decision
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {FEATURE_VERSION, type Features, deriveFeatures} from 'fraud/features';
import {scoreTransaction} from 'fraud/model';
import {type Decision, getAccount, getDecision, saveDecision} from 'fraud/store';

export const app = Fastify();

interface ScoreBody {
  transaction_id: string;
  account_ref: string;
  amount_cents: number;
  features?: Partial<Features>;
}

app.post('/v1/scores', async request => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const body = request.body as ScoreBody;
  const declared = body.features ?? {};
  const vector: Features = {
    feature_version: declared.feature_version ?? FEATURE_VERSION,
    account_age_days: Number(declared.account_age_days ?? 0),
    prior_chargebacks: Number(declared.prior_chargebacks ?? 0),
    amount_cents: body.amount_cents,
  };
  const verdict = await scoreTransaction(vector);
  const decision: Decision = {transaction_id: body.transaction_id, account_ref: body.account_ref, ...verdict, feature_version: vector.feature_version};
  await saveDecision(decision);
  return decision;
});
`,
      solution: `import Fastify from 'fastify';

import {type Features, deriveFeatures} from 'fraud/features';
import {scoreTransaction} from 'fraud/model';
import {type Decision, getAccount, getDecision, saveDecision} from 'fraud/store';

export const app = Fastify();

// Anything else in the body is ignored: the entity being scored does not describe itself.
interface ScoreBody {
  transaction_id: string;
  account_ref: string;
  amount_cents: number;
}

app.post('/v1/scores', async (request, reply) => {
  const body = request.body as ScoreBody;
  const account = await getAccount(body.account_ref);
  if (account === null) return reply.code(404).send({error: 'unknown account'});
  const stored = await getDecision(body.transaction_id);
  if (stored !== null) return stored; // a retry answers the first decision
  const vector: Features = deriveFeatures(account, body.amount_cents);
  const verdict = await scoreTransaction(vector);
  const decision: Decision = {transaction_id: body.transaction_id, account_ref: body.account_ref, ...verdict, feature_version: vector.feature_version};
  await saveDecision(decision);
  return decision;
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"fraud/features" // features.DeriveFeatures, FeatureVersion
	"fraud/model"    // model.ScoreTransaction
	"fraud/store"    // store.GetAccount, GetDecision, SaveDecision
)

type scoreBody struct {
	TransactionID string            \`json:"transaction_id"\`
	AccountRef    string            \`json:"account_ref"\`
	AmountCents   int64             \`json:"amount_cents"\`
	Features      features.Features \`json:"features"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func postScore(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	var body scoreBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "malformed body", http.StatusBadRequest)
		return
	}
	vector := body.Features
	vector.AmountCents = body.AmountCents
	if vector.FeatureVersion == "" {
		vector.FeatureVersion = features.FeatureVersion
	}
	verdict, err := model.ScoreTransaction(r.Context(), vector)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	decision := store.Decision{TransactionID: body.TransactionID, AccountRef: body.AccountRef, Score: verdict.Score, Band: verdict.Band, Fallback: verdict.Fallback, ModelVersion: verdict.ModelVersion, FeatureVersion: vector.FeatureVersion}
	store.SaveDecision(r.Context(), decision)
	writeJSON(rw, http.StatusOK, decision)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/scores", postScore)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"fraud/features" // features.DeriveFeatures, FeatureVersion
	"fraud/model"    // model.ScoreTransaction
	"fraud/store"    // store.GetAccount, GetDecision, SaveDecision
)

// Anything else in the body is ignored: the entity being scored does not describe itself.
type scoreBody struct {
	TransactionID string \`json:"transaction_id"\`
	AccountRef    string \`json:"account_ref"\`
	AmountCents   int64  \`json:"amount_cents"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func postScore(rw http.ResponseWriter, r *http.Request) {
	var body scoreBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "malformed body", http.StatusBadRequest)
		return
	}
	account := store.GetAccount(r.Context(), body.AccountRef)
	if account == nil {
		http.Error(rw, "unknown account", http.StatusNotFound)
		return
	}
	if stored := store.GetDecision(r.Context(), body.TransactionID); stored != nil {
		writeJSON(rw, http.StatusOK, stored) // a retry answers the first decision
		return
	}
	vector := features.DeriveFeatures(*account, body.AmountCents)
	verdict, err := model.ScoreTransaction(r.Context(), vector)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	decision := store.Decision{TransactionID: body.TransactionID, AccountRef: body.AccountRef, Score: verdict.Score, Band: verdict.Band, Fallback: verdict.Fallback, ModelVersion: verdict.ModelVersion, FeatureVersion: vector.FeatureVersion}
	store.SaveDecision(r.Context(), decision)
	writeJSON(rw, http.StatusOK, decision)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/scores", postScore)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import fraud.{FeatureVector, Features, Model, Store, Verdict} // Features.deriveFeatures; Model.scoreTransaction; Store.getAccount, getDecision, saveDecision

object Api {
  private def ok(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def decisionOf(transactionId: String, accountRef: String, verdict: Verdict, featureVersion: String): JsObject = JsObject(
    "transaction_id" -> JsString(transactionId), "account_ref" -> JsString(accountRef), "score" -> JsNumber(verdict.score),
    "band" -> JsString(verdict.band), "fallback" -> JsBoolean(verdict.fallback), "model_version" -> JsString(verdict.modelVersion),
    "feature_version" -> JsString(featureVersion))

  val route: Route = path("v1" / "scores") {
    post {
      entity(as[String]) { raw =>
        // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
        val body = raw.parseJson.asJsObject.fields
        val declared = body.get("features").map(_.asJsObject.fields).getOrElse(Map.empty[String, JsValue])
        def number(name: String): Long = declared.get(name).map(_.convertTo[Long]).getOrElse(0L)
        val vector = FeatureVector(
          declared.get("feature_version").map(_.convertTo[String]).getOrElse(Features.FeatureVersion),
          number("account_age_days"), number("prior_chargebacks"), body("amount_cents").convertTo[Long])
        val verdict = Model.scoreTransaction(vector)
        val decision = decisionOf(body("transaction_id").convertTo[String], body("account_ref").convertTo[String], verdict, vector.featureVersion)
        Store.saveDecision(decision)
        complete(ok(decision))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import fraud.{Features, Model, Store, Verdict} // Features.deriveFeatures; Model.scoreTransaction; Store.getAccount, getDecision, saveDecision

object Api {
  private def ok(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def decisionOf(transactionId: String, accountRef: String, verdict: Verdict, featureVersion: String): JsObject = JsObject(
    "transaction_id" -> JsString(transactionId), "account_ref" -> JsString(accountRef), "score" -> JsNumber(verdict.score),
    "band" -> JsString(verdict.band), "fallback" -> JsBoolean(verdict.fallback), "model_version" -> JsString(verdict.modelVersion),
    "feature_version" -> JsString(featureVersion))

  val route: Route = path("v1" / "scores") {
    post {
      entity(as[String]) { raw =>
        // Only these three fields are read: the entity being scored does not describe itself.
        val body = raw.parseJson.asJsObject.fields
        val transactionId = body("transaction_id").convertTo[String]
        val accountRef = body("account_ref").convertTo[String]
        Store.getAccount(accountRef) match {
          case None => complete(StatusCodes.NotFound -> "unknown account")
          case Some(account) =>
            Store.getDecision(transactionId) match {
              case Some(stored) => complete(ok(stored)) // a retry answers the first decision
              case None =>
                val vector = Features.deriveFeatures(account, body("amount_cents").convertTo[Long])
                val verdict = Model.scoreTransaction(vector)
                val decision = decisionOf(transactionId, accountRef, verdict, vector.featureVersion)
                Store.saveDecision(decision)
                complete(ok(decision))
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

#include <string>

#include "fraud/features.h"  // features::deriveFeatures, kFeatureVersion
#include "fraud/model.h"     // model::scoreTransaction
#include "fraud/store.h"     // store::getAccount, getDecision, saveDecision

using json = nlohmann::json;

json decisionOf(const std::string& transaction_id, const std::string& account_ref, const model::Verdict& verdict, const std::string& feature_version) {
  return json{{"transaction_id", transaction_id}, {"account_ref", account_ref}, {"score", verdict.score}, {"band", verdict.band},
              {"fallback", verdict.fallback}, {"model_version", verdict.model_version}, {"feature_version", feature_version}};
}

void post_score(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body);
  const json declared = body.value("features", json::object());
  const features::Features fx{declared.value("feature_version", features::kFeatureVersion), declared.value("account_age_days", 0LL),
                              declared.value("prior_chargebacks", 0LL), body.value("amount_cents", 0LL)};
  const model::Verdict verdict = model::scoreTransaction(fx);
  const json decision = decisionOf(body.value("transaction_id", ""), body.value("account_ref", ""), verdict, fx.feature_version);
  store::saveDecision(decision);
  res.set_content(decision.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/scores", post_score); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "fraud/features.h"  // features::deriveFeatures, kFeatureVersion
#include "fraud/model.h"     // model::scoreTransaction
#include "fraud/store.h"     // store::getAccount, getDecision, saveDecision

using json = nlohmann::json;

json decisionOf(const std::string& transaction_id, const std::string& account_ref, const model::Verdict& verdict, const std::string& feature_version) {
  return json{{"transaction_id", transaction_id}, {"account_ref", account_ref}, {"score", verdict.score}, {"band", verdict.band},
              {"fallback", verdict.fallback}, {"model_version", verdict.model_version}, {"feature_version", feature_version}};
}

void post_score(const httplib::Request& req, httplib::Response& res) {
  // Only these three fields are read: the entity being scored does not describe itself.
  const json body = json::parse(req.body);
  const std::string transaction_id = body.value("transaction_id", "");
  const std::string account_ref = body.value("account_ref", "");
  const auto account = store::getAccount(account_ref);
  if (!account) {
    res.status = 404;
    res.set_content("unknown account", "text/plain");
    return;
  }
  if (const auto stored = store::getDecision(transaction_id)) {
    res.set_content(stored->dump(), "application/json");  // a retry answers the first decision
    return;
  }
  const features::Features fx = features::deriveFeatures(*account, body.value("amount_cents", 0LL));
  const model::Verdict verdict = model::scoreTransaction(fx);
  const json decision = decisionOf(transaction_id, account_ref, verdict, fx.feature_version);
  store::saveDecision(decision);
  res.set_content(decision.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/scores", post_score); }
`,
    },
  },
  harness: {
    python: `import fraud_scoring_pb2_grpc
from fraud import store
from fraud.risk_model import ModelPeer

ESTABLISHED = {"account_ref": "acct-1", "tenant": "t-1", "age_days": 400, "chargebacks": 0}
RISKY = {"account_ref": "acct-9", "tenant": "t-1", "age_days": 12, "chargebacks": 2}


def _api(ctx):
    ctx.grpc.serve(fraud_scoring_pb2_grpc.add_ModelServicer_to_server, ModelPeer())
    store.put_account(ESTABLISHED)
    store.put_account(RISKY)
    return ctx.client(ctx.load("api").app)


async def _score(c, tx, account_ref="acct-1", **extra):
    return await c.post("/v1/scores", json={"transaction_id": tx, "account_ref": account_ref, "amount_cents": 4200, **extra})


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _score(c, "tx-1")
    assert r.status_code == 200, f"POST /v1/scores for acct-1 answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("transaction_id") == "tx-1" and body.get("band") in ("approve", "review", "decline"), f"the decision must carry the transaction id and a band, got {body}"
    assert isinstance(body.get("score"), (int, float)), f"the decision must carry the score, got {body}"
    assert len(ctx.grpc.calls_to("Score")) == 1, f"one transaction must cost one model call, it cost {len(ctx.grpc.calls_to('Score'))}"


async def check_server_features(ctx):
    async with _api(ctx) as c:
        r = await _score(c, "tx-7", account_ref="acct-9", features={"feature_version": "fx-3", "account_age_days": 3650, "prior_chargebacks": 0}, declared_risk=0.01)
    assert r.status_code == 200, f"POST /v1/scores for acct-9 answered {r.status_code}: {r.text}"
    calls = ctx.grpc.calls_to("Score")
    assert len(calls) == 1, f"one transaction must cost one model call, it cost {len(calls)}"
    sent = calls[0].request
    got = (sent.feature_version, sent.account_age_days, sent.prior_chargebacks, sent.amount_cents)
    assert got == ("fx-3", 12, 2, 4200), f"the model was asked about (feature_version, age, chargebacks, amount) = {got}, the numbers the caller sent. acct-9 is 12 days old with 2 chargebacks: derive the vector from the account store"
    body = r.json()
    assert body.get("band") == "decline", f"acct-9 with its real history must be declined, the scorer answered {body}"
    assert body.get("feature_version") == "fx-3", f"the decision must carry FEATURE_VERSION, got {body}"


async def check_account_404(ctx):
    async with _api(ctx) as c:
        r = await _score(c, "tx-3", account_ref="acct-404")
    assert r.status_code == 404, f"an account the scorer has never seen answered {r.status_code}: {r.text}, expected 404"
    calls = len(ctx.grpc.calls_to("Score"))
    assert calls == 0, f"the model was asked {calls} time(s) about an unknown account: look the account up before any model work"
    assert store.get_decision("tx-3") is None, f"a decision was stored for an unknown account: {store.get_decision('tx-3')}"


async def check_replay_dedupe(ctx):
    async with _api(ctx) as c:
        first = await _score(c, "tx-5")
        assert first.status_code == 200, f"the first POST answered {first.status_code}: {first.text}"
        replay = await _score(c, "tx-5")
        assert replay.status_code == 200 and replay.json() == first.json(), f"a replay must answer the stored decision: first {first.text}, replay {replay.text}"
        calls = len(ctx.grpc.calls_to("Score"))
        assert calls == 1, f"a retried transaction_id was scored again ({calls} model calls): answer store.get_decision before calling the model"
        other = await _score(c, "tx-6")
    assert other.status_code == 200 and len(ctx.grpc.calls_to("Score")) == 2, "a new transaction_id must be scored"
    assert store.get_decision("tx-5") == first.json(), f"the stored decision for tx-5 is {store.get_decision('tx-5')}, the scorer answered {first.json()}"
`,
    typescript: `function api(ctx) {
  const {modelPeer} = ctx.load('/support/fraud/risk_model.ts');
  ctx.grpc.serve(ctx.proto('fraud_scoring.proto').fraudscore.Model.service, modelPeer);
  const store = ctx.load('/support/fraud/store.ts');
  return {store, c: ctx.client(ctx.load('api').app)};
}

async function seed(store): Promise<void> {
  await store.putAccount({account_ref: 'acct-1', tenant: 't-1', age_days: 400, chargebacks: 0});
  await store.putAccount({account_ref: 'acct-9', tenant: 't-1', age_days: 12, chargebacks: 2});
}

const score = (c, tx: string, accountRef = 'acct-1', extra = {}) =>
  c.post('/v1/scores', {json: {transaction_id: tx, account_ref: accountRef, amount_cents: 4200, ...extra}});

export async function check_route(ctx) {
  const {store, c} = api(ctx);
  await seed(store);
  const r = await score(c, 'tx-1');
  assert.equal(r.status, 200, \`POST /v1/scores for acct-1 answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.transaction_id === 'tx-1' && ['approve', 'review', 'decline'].includes(body.band), \`the decision must carry the transaction id and a band, got \${r.text}\`);
  assert.equal(typeof body.score, 'number', \`the decision must carry the score, got \${r.text}\`);
  assert.equal(ctx.grpc.callsTo('Score').length, 1, 'one transaction must cost one model call');
}

export async function check_server_features(ctx) {
  const {store, c} = api(ctx);
  await seed(store);
  const r = await score(c, 'tx-7', 'acct-9', {features: {feature_version: 'fx-3', account_age_days: 3650, prior_chargebacks: 0}, declared_risk: 0.01});
  assert.equal(r.status, 200, \`POST /v1/scores for acct-9 answered \${r.status}: \${r.text}\`);
  const calls = ctx.grpc.callsTo('Score');
  assert.equal(calls.length, 1, 'one transaction must cost one model call');
  const sent = calls[0].request;
  const got = [sent.feature_version, Number(sent.account_age_days), Number(sent.prior_chargebacks), Number(sent.amount_cents)];
  assert.deepStrictEqual(got, ['fx-3', 12, 2, 4200], \`the model was asked about (feature_version, age, chargebacks, amount) = \${JSON.stringify(got)}, the numbers the caller sent. acct-9 is 12 days old with 2 chargebacks: derive the vector from the account store\`);
  const body = r.json();
  assert.equal(body.band, 'decline', \`acct-9 with its real history must be declined, the scorer answered \${r.text}\`);
  assert.equal(body.feature_version, 'fx-3', \`the decision must carry FEATURE_VERSION, got \${r.text}\`);
}

export async function check_account_404(ctx) {
  const {store, c} = api(ctx);
  await seed(store);
  const r = await score(c, 'tx-3', 'acct-404');
  assert.equal(r.status, 404, \`an account the scorer has never seen answered \${r.status}: \${r.text}, expected 404\`);
  const calls = ctx.grpc.callsTo('Score').length;
  assert.equal(calls, 0, \`the model was asked \${calls} time(s) about an unknown account: look the account up before any model work\`);
  assert.equal(await store.getDecision('tx-3'), null, 'a decision was stored for an unknown account');
}

export async function check_replay_dedupe(ctx) {
  const {store, c} = api(ctx);
  await seed(store);
  const first = await score(c, 'tx-5');
  assert.equal(first.status, 200, \`the first POST answered \${first.status}: \${first.text}\`);
  const replay = await score(c, 'tx-5');
  assert(replay.status === 200 && JSON.stringify(replay.json()) === JSON.stringify(first.json()), \`a replay must answer the stored decision: first \${first.text}, replay \${replay.text}\`);
  const calls = ctx.grpc.callsTo('Score').length;
  assert.equal(calls, 1, \`a retried transaction_id was scored again (\${calls} model calls): answer getDecision before calling the model\`);
  const other = await score(c, 'tx-6');
  assert(other.status === 200 && ctx.grpc.callsTo('Score').length === 2, 'a new transaction_id must be scored');
  assert.deepStrictEqual(await store.getDecision('tx-5'), first.json(), 'the stored decision for tx-5 must be what the scorer answered');
}
`,
    go: `package main

import (
	"context"
	"net/http"

	pb "fraud/gen/fraud_scoring"
	"fraud/riskmodel"
	"fraud/store"

	"leetbuild/harness"
)

var apiBg = context.Background()

func api(ctx *harness.Ctx) *harness.HTTP {
	pb.RegisterModelServer(ctx.GRPC.Server(""), riskmodel.Peer{})
	store.PutAccount(apiBg, store.Account{AccountRef: "acct-1", Tenant: "t-1", AgeDays: 400, Chargebacks: 0})
	store.PutAccount(apiBg, store.Account{AccountRef: "acct-9", Tenant: "t-1", AgeDays: 12, Chargebacks: 2})
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func askScore(c *harness.HTTP, tx, accountRef string, extra map[string]any) *harness.Response {
	body := map[string]any{"transaction_id": tx, "account_ref": accountRef, "amount_cents": 4200}
	for k, v := range extra {
		body[k] = v
	}
	return c.Post("/v1/scores", body)
}

func decisionIn(r *harness.Response) store.Decision {
	var d store.Decision
	r.Decode(&d)
	return d
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := askScore(c, "tx-1", "acct-1", nil)
	ctx.Equal(r.Status, 200, "POST /v1/scores for acct-1 (%s)", r.Text())
	d := decisionIn(r)
	ctx.Assert(d.TransactionID == "tx-1" && (d.Band == "approve" || d.Band == "review" || d.Band == "decline"), "the decision must carry the transaction id and a band, got %s", r.Text())
	ctx.Equal(len(ctx.GRPC.CallsTo("Score", "")), 1, "one transaction must cost one model call; the calls")
}

func CheckServerFeatures(ctx *harness.Ctx) {
	c := api(ctx)
	r := askScore(c, "tx-7", "acct-9", map[string]any{"features": map[string]any{"feature_version": "fx-3", "account_age_days": 3650, "prior_chargebacks": 0}, "declared_risk": 0.01})
	ctx.Equal(r.Status, 200, "POST /v1/scores for acct-9 (%s)", r.Text())
	calls := ctx.GRPC.CallsTo("Score", "")
	ctx.Equal(len(calls), 1, "one transaction must cost one model call; the calls")
	sent := calls[0].Request.(*pb.ScoreRequest)
	ctx.Assert(sent.GetFeatureVersion() == "fx-3" && sent.GetAccountAgeDays() == 12 && sent.GetPriorChargebacks() == 2 && sent.GetAmountCents() == 4200,
		"the model was asked about feature_version %q, age %d, chargebacks %d, amount %d: the numbers the caller sent. acct-9 is 12 days old with 2 chargebacks: derive the vector from the account store",
		sent.GetFeatureVersion(), sent.GetAccountAgeDays(), sent.GetPriorChargebacks(), sent.GetAmountCents())
	d := decisionIn(r)
	ctx.Equal(d.Band, "decline", "acct-9 with its real history must be declined; the band")
	ctx.Equal(d.FeatureVersion, "fx-3", "the decision must carry FeatureVersion")
}

func CheckAccount404(ctx *harness.Ctx) {
	c := api(ctx)
	r := askScore(c, "tx-3", "acct-404", nil)
	ctx.Equal(r.Status, 404, "an account the scorer has never seen (%s)", r.Text())
	ctx.Equal(len(ctx.GRPC.CallsTo("Score", "")), 0, "the model was asked about an unknown account: look the account up before any model work; the calls")
	ctx.Assert(store.GetDecision(apiBg, "tx-3") == nil, "a decision was stored for an unknown account: %+v", store.GetDecision(apiBg, "tx-3"))
}

func CheckReplayDedupe(ctx *harness.Ctx) {
	c := api(ctx)
	first := askScore(c, "tx-5", "acct-1", nil)
	ctx.Equal(first.Status, 200, "the first POST (%s)", first.Text())
	replay := askScore(c, "tx-5", "acct-1", nil)
	ctx.Assert(replay.Status == 200 && decisionIn(replay) == decisionIn(first), "a replay must answer the stored decision: first %s, replay %s", first.Text(), replay.Text())
	ctx.Equal(len(ctx.GRPC.CallsTo("Score", "")), 1, "a retried transaction_id was scored again: answer store.GetDecision before calling the model; the calls")
	other := askScore(c, "tx-6", "acct-1", nil)
	ctx.Assert(other.Status == 200 && len(ctx.GRPC.CallsTo("Score", "")) == 2, "a new transaction_id must be scored")
	stored := store.GetDecision(apiBg, "tx-5")
	ctx.Assert(stored != nil && *stored == decisionIn(first), "the stored decision for tx-5 is %+v, the scorer answered %s", stored, first.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "fraud/risk_model.h"
#include "fraud/store.h"
#include "fraud_scoring.grpc.pb.h"

namespace {

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  static riskmodel::Peer* peer = nullptr;
  delete svr;
  delete peer;
  svr = new httplib::Server;
  peer = new riskmodel::Peer;
  ctx.GRPC.Server("")->RegisterService(peer);
  store::putAccount({"acct-1", "t-1", 400, 0});
  store::putAccount({"acct-9", "t-1", 12, 2});
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response askScore(harness::HTTP& c, const std::string& tx, const std::string& account_ref,
                           const nlohmann::json& extra = nlohmann::json::object()) {
  nlohmann::json body = {{"transaction_id", tx}, {"account_ref", account_ref}, {"amount_cents", 4200}};
  body.update(extra);
  return c.Post("/v1/scores", body.dump(), "Content-Type", "application/json");
}

nlohmann::json bodyOf(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = askScore(c, "tx-1", "acct-1");
  ctx.Equal(r.Status, 200, "POST /v1/scores for acct-1 (%s)", r.Text());
  const auto body = bodyOf(r);
  const std::string band = body.is_object() ? body.value("band", "") : "";
  ctx.Assert(body.is_object() && body.value("transaction_id", "") == "tx-1" && (band == "approve" || band == "review" || band == "decline"),
             "the decision must carry the transaction id and a band, got %s", r.Text());
  ctx.Equal(ctx.GRPC.CallsTo("Score").size(), 1, "one transaction must cost one model call; the calls");
}

void CheckServerFeatures(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = askScore(c, "tx-7", "acct-9",
                          {{"features", {{"feature_version", "fx-3"}, {"account_age_days", 3650}, {"prior_chargebacks", 0}}}, {"declared_risk", 0.01}});
  ctx.Equal(r.Status, 200, "POST /v1/scores for acct-9 (%s)", r.Text());
  const auto calls = ctx.GRPC.CallsTo("Score");
  ctx.Equal(calls.size(), 1, "one transaction must cost one model call; the calls");
  const auto sent = calls[0].Request<fraudscore::ScoreRequest>();
  ctx.Assert(sent.feature_version() == "fx-3" && sent.account_age_days() == 12 && sent.prior_chargebacks() == 2 && sent.amount_cents() == 4200,
             "the model was asked about feature_version %q, age %d, chargebacks %d, amount %d: the numbers the caller sent. acct-9 is 12 days old with 2 chargebacks: derive the vector from the account store",
             sent.feature_version(), sent.account_age_days(), sent.prior_chargebacks(), sent.amount_cents());
  const auto body = bodyOf(r);
  ctx.Equal(body.value("band", ""), "decline", "acct-9 with its real history must be declined; the band");
  ctx.Equal(body.value("feature_version", ""), "fx-3", "the decision must carry kFeatureVersion");
}

void CheckAccount404(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = askScore(c, "tx-3", "acct-404");
  ctx.Equal(r.Status, 404, "an account the scorer has never seen (%s)", r.Text());
  ctx.Equal(ctx.GRPC.CallsTo("Score").size(), 0, "the model was asked about an unknown account: look the account up before any model work; the calls");
  ctx.Assert(!store::getDecision("tx-3"), "a decision was stored for an unknown account");
}

void CheckReplayDedupe(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = askScore(c, "tx-5", "acct-1");
  ctx.Equal(first.Status, 200, "the first POST (%s)", first.Text());
  const auto replay = askScore(c, "tx-5", "acct-1");
  ctx.Assert(replay.Status == 200 && bodyOf(replay) == bodyOf(first), "a replay must answer the stored decision: first %s, replay %s", first.Text(), replay.Text());
  ctx.Equal(ctx.GRPC.CallsTo("Score").size(), 1, "a retried transaction_id was scored again: answer store::getDecision before calling the model; the calls");
  const auto other = askScore(c, "tx-6", "acct-1");
  ctx.Assert(other.Status == 200 && ctx.GRPC.CallsTo("Score").size() == 2, "a new transaction_id must be scored");
  const auto stored = store::getDecision("tx-5");
  ctx.Assert(stored && *stored == bodyOf(first), "the stored decision for tx-5 is %s, the scorer answered %s", stored ? stored->dump() : "nothing", first.Text());
}
`,
  },
  hints: [
    'Send `features: {prior_chargebacks: 0}` for an account with two chargebacks: it is approved. Post an unknown `account_ref`: 200 and a model call. Post one `transaction_id` twice: the model is asked twice.',
    'The handler never reads the account store: the vector is whatever the body says, an unknown account has nothing to stop it, and `save_decision` writes every decision while nothing reads one back before scoring.',
    "Read `store.get_account` and answer 404 on None; answer `store.get_decision(transaction_id)` when it exists; otherwise `derive_features(account, amount_cents)`, `score_transaction`, `save_decision`. Drop the body's `features` field.",
  ],
  debrief: `The guards are in cost order: an unknown account costs one read, a replay one more, and only a first sighting of a real account pays for a model round trip. Deriving the vector from the account store is the rule Radar's velocity attributes follow too: the entity being scored never supplies its own risk inputs. Pinning \`FEATURE_VERSION\` in the stored decision lets a disputed approval be replayed later against the same feature definitions. The dedupe key here is the transaction id alone; a production scorer scopes it per merchant, expires it after the retry horizon, and checks that a replay carries the same account and amount before answering the stored decision.`,
};
