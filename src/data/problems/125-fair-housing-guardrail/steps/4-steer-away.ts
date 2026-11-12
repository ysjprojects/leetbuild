import type {Step} from '@/lib/types';

export const steerAwayStep: Step = {
  id: 'steer-away',
  title: 'POST /v1/turn: guard the question, regenerate once, return the fallback, escalate',
  concept: 'http',
  file: 'steer_away',
  focus: ['guard', 'model', 'review', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/turn\` with a body \`{conversation_id, question}\`.
It reads the active policy version (\`cache.active_version()\`), asks the model
(\`model.complete(question)\`, the Assistant service at \`model:9000\`), runs
\`tiers.evaluate(answer, version)\` and answers \`{conversation_id, answer, outcome, reasons,
escalated, policy_version}\`. A blocked answer goes back with \`WARNING_NOTE\` appended and outcome
\`flagged\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Appending a warning to a blocked answer is the violation with a
footnote. The steering question itself reaches the model. A flagged answer always ends the turn
even when a compliant one was one call away. And a user who rephrases the same question twenty
times looks like twenty users.

- Evaluate the question before any model call; a blocked question answers \`FALLBACK_MESSAGE\` with
  outcome \`blocked_input\`.
- A blocked answer is regenerated at most \`MAX_REGENERATIONS\` = 1 time with
  \`model.complete(question, FHA_INSTRUCTIONS)\`, and the new answer is evaluated again.
- A turn still blocked answers \`FALLBACK_MESSAGE\` with outcome \`blocked_output\`; no model text
  goes back.
- Every blocked turn calls \`cache.record_strike\`; the strike that reaches \`REVIEW_AFTER_STRIKES\` = 3
  calls \`store.enqueue_review\` once, and from then on blocked turns answer \`escalated: true\`.`,
  sequence: {
    participants: ['Assistant', 'fhguard', 'Model', 'Review queue'],
    messages: [
      {from: 'Assistant', to: 'fhguard', label: 'POST /v1/turn {conversation_id, question}', kind: 'sync'},
      {from: 'fhguard', to: 'fhguard', label: 'evaluate(question) → blocked? fallback, blocked_input', kind: 'sync'},
      {from: 'fhguard', to: 'Model', label: 'Complete(question)', kind: 'sync'},
      {from: 'fhguard', to: 'fhguard', label: 'evaluate(answer) → blocked', kind: 'sync'},
      {from: 'fhguard', to: 'Model', label: 'Complete(question, FHA_INSTRUCTIONS) · once', kind: 'sync'},
      {from: 'fhguard', to: 'fhguard', label: 'evaluate(new answer) · still blocked → fallback', kind: 'sync'},
      {from: 'fhguard', to: 'Review queue', label: 'record_strike · enqueue_review at the third', kind: 'async'},
      {from: 'fhguard', to: 'Assistant', label: '200 {answer | FALLBACK_MESSAGE, outcome, escalated}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'turn-route',
      title: 'Answers a compliant question with the model’s answer',
      detail:
        '`POST /v1/turn` answers a question nobody blocks with the model’s answer, outcome `answered`, and the active policy version.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/turn["']/, /"answered"/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/turn['"]/, /'answered'/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/turn"/, /"answered"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"turn"\s*\)/, /"answered"/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/turn"/, /"answered"/]},
      },
    },
    {
      id: 'input-guard-first',
      title: 'Evaluates the question before calling the model',
      detail:
        'The question is evaluated before the first model call; a blocked question answers the fallback with outcome `blocked_input` and the model is never asked. The starter only evaluates the answer.',
      match: {
        python: {all: [/"blocked_input"/], order: [/tiers\.evaluate\(body\.question/, /model\.complete\(/]},
        typescript: {all: [/'blocked_input'/], order: [/evaluate\(body\.question/, /\bcomplete\(/]},
        go: {all: [/"blocked_input"/], order: [/tiers\.Evaluate\([^\n]*body\.Question/, /model\.Complete\(/]},
        scala: {all: [/"blocked_input"/], order: [/Tiers\.evaluate\(question/, /Model\.complete\(/]},
        cpp: {all: [/"blocked_input"/], order: [/tiers::evaluate\(question/, /model::complete\(/]},
      },
    },
    {
      id: 'fallback-not-text',
      title: 'Answers the fallback, never the blocked text',
      detail:
        'A turn that stays blocked answers `FALLBACK_MESSAGE` with outcome `blocked_output` and no word of the model’s text; the starter returns the text with a warning appended.',
      match: {
        python: {all: [/FALLBACK_MESSAGE/, /"blocked_output"/], none: [/WARNING_NOTE/, /answer\s*\+/]},
        typescript: {all: [/FALLBACK_MESSAGE/, /'blocked_output'/], none: [/WARNING_NOTE/, /answer\s*\+/]},
        go: {all: [/fallbackMessage/, /"blocked_output"/], none: [/warningNote/, /answer\s*\+/]},
        scala: {all: [/FallbackMessage/, /"blocked_output"/], none: [/WarningNote/, /answer\s*\+/]},
        cpp: {all: [/kFallbackMessage/, /"blocked_output"/], none: [/kWarningNote/, /answer\s*\+/]},
      },
    },
    {
      id: 'regenerate-once',
      title: 'Regenerates once under the FHA instructions and evaluates the new answer',
      detail:
        'A blocked answer is regenerated at most once (`MAX_REGENERATIONS` = 1) with `FHA_INSTRUCTIONS` as the model’s instructions, and the regenerated answer is evaluated before it can go back. The starter never regenerates.',
      match: {
        python: {
          all: [/MAX_REGENERATIONS\s*=\s*1\b/, /range\(MAX_REGENERATIONS\)/],
          order: [/complete\([^)]*FHA_INSTRUCTIONS\)/, /tiers\.evaluate\(answer/],
        },
        typescript: {
          all: [/MAX_REGENERATIONS\s*=\s*1\b/, /<\s*MAX_REGENERATIONS/],
          order: [/complete\([^)]*FHA_INSTRUCTIONS\)/, /evaluate\(answer/],
        },
        go: {
          all: [/maxRegenerations\s*=\s*1\b/, /<\s*maxRegenerations/],
          order: [/Complete\([^\n]*fhaInstructions\)/, /tiers\.Evaluate\([^\n]*\banswer\b/],
        },
        scala: {
          all: [/MaxRegenerations\s*=\s*1\b/, /until\s+MaxRegenerations|<\s*MaxRegenerations/],
          order: [/complete\([^)]*FhaInstructions\)/, /Tiers\.evaluate\(\w*[aA]nswer/],
        },
        cpp: {
          all: [/kMaxRegenerations\s*=\s*1\b/, /<\s*kMaxRegenerations/],
          order: [/complete\([^)]*kFhaInstructions\)/, /tiers::evaluate\(answer/],
        },
      },
    },
    {
      id: 'strikes-escalate',
      title: 'Counts strikes and escalates the third, once',
      detail:
        'Every blocked turn records a strike; the strike that reaches `REVIEW_AFTER_STRIKES` = 3 enqueues the conversation for human review once, and blocked turns from then on answer `escalated: true`. The starter keeps no count.',
      match: {
        python: {all: [/REVIEW_AFTER_STRIKES\s*=\s*3\b/, /cache\.record_strike\(/, /store\.enqueue_review\(/]},
        typescript: {all: [/REVIEW_AFTER_STRIKES\s*=\s*3\b/, /recordStrike\(/, /enqueueReview\(/]},
        go: {all: [/reviewAfterStrikes\s*=\s*3\b/, /cache\.RecordStrike\(/, /store\.EnqueueReview\(/]},
        scala: {all: [/ReviewAfterStrikes\s*=\s*3\b/, /Cache\.recordStrike\(/, /Store\.enqueueReview\(/]},
        cpp: {all: [/kReviewAfterStrikes\s*=\s*3\b/, /cache::recordStrike\(/, /store::enqueueReview\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from pydantic import BaseModel

from fhguard import cache  # active_version() -> str | None, record_strike(conversation_id) -> int
from fhguard import model  # complete(question, instructions="") -> str
from fhguard import store  # enqueue_review(conversation_id, strikes)
from fhguard import tiers  # evaluate(text, policy_version) -> Decision(allowed, tier, score, reasons)

app = FastAPI()

WARNING_NOTE = "Note: parts of this answer may touch on characteristics protected by fair housing law."


class TurnRequest(BaseModel):
    conversation_id: str
    question: str


@app.post("/v1/turn")
def turn(body: TurnRequest) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    version = cache.active_version() or ""
    answer = model.complete(body.question)
    outbound = tiers.evaluate(answer, version)
    if not outbound.allowed:
        return {
            "conversation_id": body.conversation_id,
            "answer": answer + "\\n\\n" + WARNING_NOTE,
            "outcome": "flagged",
            "reasons": outbound.reasons,
            "escalated": False,
            "policy_version": version,
        }
    return {
        "conversation_id": body.conversation_id,
        "answer": answer,
        "outcome": "answered",
        "reasons": [],
        "escalated": False,
        "policy_version": version,
    }
`,
      solution: `from fastapi import FastAPI
from pydantic import BaseModel

from fhguard import cache  # active_version() -> str | None, record_strike(conversation_id) -> int
from fhguard import model  # complete(question, instructions="") -> str
from fhguard import store  # enqueue_review(conversation_id, strikes)
from fhguard import tiers  # evaluate(text, policy_version) -> Decision(allowed, tier, score, reasons)
from fhguard.store import Decision

app = FastAPI()

MAX_REGENERATIONS = 1
REVIEW_AFTER_STRIKES = 3
FHA_INSTRUCTIONS = "Answer without breaking fair housing law: do not describe, rank or recommend homes, neighborhoods or lenders by race, color, religion, sex, disability, familial status, national origin, age or source of income, and do not guess those traits about the user."
FALLBACK_MESSAGE = "I cannot help with that part of the request: fair housing law prohibits steering a home search by protected characteristics. I can help with price, size, commute and listing details."


class TurnRequest(BaseModel):
    conversation_id: str
    question: str


def steer_away(conversation_id: str, outcome: str, decision: Decision, version: str) -> dict:
    strikes = cache.record_strike(conversation_id)
    if strikes == REVIEW_AFTER_STRIKES:
        store.enqueue_review(conversation_id, strikes)
    return {
        "conversation_id": conversation_id,
        "answer": FALLBACK_MESSAGE,
        "outcome": outcome,
        "reasons": decision.reasons,
        "escalated": strikes >= REVIEW_AFTER_STRIKES,
        "policy_version": version,
    }


@app.post("/v1/turn")
def turn(body: TurnRequest) -> dict:
    version = cache.active_version() or ""
    inbound = tiers.evaluate(body.question, version)
    if not inbound.allowed:
        return steer_away(body.conversation_id, "blocked_input", inbound, version)
    answer = model.complete(body.question)
    outbound = tiers.evaluate(answer, version)
    for _ in range(MAX_REGENERATIONS):
        if outbound.allowed:
            break
        answer = model.complete(body.question, FHA_INSTRUCTIONS)
        outbound = tiers.evaluate(answer, version)
    if not outbound.allowed:
        return steer_away(body.conversation_id, "blocked_output", outbound, version)
    return {
        "conversation_id": body.conversation_id,
        "answer": answer,
        "outcome": "answered",
        "reasons": [],
        "escalated": False,
        "policy_version": version,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {activeVersion, recordStrike} from 'fhguard/cache';
import {complete} from 'fhguard/model';
import {enqueueReview} from 'fhguard/store';
import {evaluate} from 'fhguard/tiers';

export const app = Fastify();

const WARNING_NOTE = 'Note: parts of this answer may touch on characteristics protected by fair housing law.';

interface TurnBody {
  conversation_id: string;
  question: string;
}

app.post('/v1/turn', async request => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const body = request.body as TurnBody;
  const version = (await activeVersion()) ?? '';
  const answer = await complete(body.question);
  const outbound = await evaluate(answer, version);
  if (!outbound.allowed) {
    return {
      conversation_id: body.conversation_id,
      answer: \`\${answer}\\n\\n\${WARNING_NOTE}\`,
      outcome: 'flagged',
      reasons: outbound.reasons,
      escalated: false,
      policy_version: version,
    };
  }
  return {conversation_id: body.conversation_id, answer, outcome: 'answered', reasons: [], escalated: false, policy_version: version};
});
`,
      solution: `import Fastify from 'fastify';

import {activeVersion, recordStrike} from 'fhguard/cache';
import {complete} from 'fhguard/model';
import {type Decision, enqueueReview} from 'fhguard/store';
import {evaluate} from 'fhguard/tiers';

export const app = Fastify();

export const MAX_REGENERATIONS = 1;
export const REVIEW_AFTER_STRIKES = 3;
export const FHA_INSTRUCTIONS =
  'Answer without breaking fair housing law: do not describe, rank or recommend homes, neighborhoods or lenders by race, color, religion, sex, disability, familial status, national origin, age or source of income, and do not guess those traits about the user.';
export const FALLBACK_MESSAGE =
  'I cannot help with that part of the request: fair housing law prohibits steering a home search by protected characteristics. I can help with price, size, commute and listing details.';

interface TurnBody {
  conversation_id: string;
  question: string;
}

async function steerAway(conversationId: string, outcome: string, decision: Decision, version: string) {
  const strikes = await recordStrike(conversationId);
  if (strikes === REVIEW_AFTER_STRIKES) await enqueueReview(conversationId, strikes);
  return {
    conversation_id: conversationId,
    answer: FALLBACK_MESSAGE,
    outcome,
    reasons: decision.reasons,
    escalated: strikes >= REVIEW_AFTER_STRIKES,
    policy_version: version,
  };
}

app.post('/v1/turn', async request => {
  const body = request.body as TurnBody;
  const version = (await activeVersion()) ?? '';
  const inbound = await evaluate(body.question, version);
  if (!inbound.allowed) return steerAway(body.conversation_id, 'blocked_input', inbound, version);
  let answer = await complete(body.question);
  let outbound = await evaluate(answer, version);
  for (let i = 0; i < MAX_REGENERATIONS && !outbound.allowed; i++) {
    answer = await complete(body.question, FHA_INSTRUCTIONS);
    outbound = await evaluate(answer, version);
  }
  if (!outbound.allowed) return steerAway(body.conversation_id, 'blocked_output', outbound, version);
  return {conversation_id: body.conversation_id, answer, outcome: 'answered', reasons: [], escalated: false, policy_version: version};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"fhguard/cache" // ActiveVersion(ctx) string; RecordStrike(ctx, conversationID) (int64, error)
	"fhguard/model" // Complete(ctx, question, instructions) (string, error)
	"fhguard/tiers" // Evaluate(ctx, text, policyVersion) store.Decision
)

const warningNote = "Note: parts of this answer may touch on characteristics protected by fair housing law."

type turnRequest struct {
	ConversationID string \`json:"conversation_id"\`
	Question       string \`json:"question"\`
}

func writeJSON(rw http.ResponseWriter, v any) {
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(v)
}

func turn(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var body turnRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "body must be JSON", http.StatusBadRequest)
		return
	}
	version := cache.ActiveVersion(r.Context())
	answer, err := model.Complete(r.Context(), body.Question, "")
	if err != nil {
		http.Error(rw, "model unavailable", http.StatusBadGateway)
		return
	}
	outbound := tiers.Evaluate(r.Context(), answer, version)
	if !outbound.Allowed {
		writeJSON(rw, map[string]any{"conversation_id": body.ConversationID, "answer": answer + "\\n\\n" + warningNote, "outcome": "flagged", "reasons": outbound.Reasons, "escalated": false, "policy_version": version})
		return
	}
	writeJSON(rw, map[string]any{"conversation_id": body.ConversationID, "answer": answer, "outcome": "answered", "reasons": []string{}, "escalated": false, "policy_version": version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/turn", turn)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"fhguard/cache" // ActiveVersion(ctx) string; RecordStrike(ctx, conversationID) (int64, error)
	"fhguard/model" // Complete(ctx, question, instructions) (string, error)
	"fhguard/store" // EnqueueReview(ctx, conversationID, strikes); Decision
	"fhguard/tiers" // Evaluate(ctx, text, policyVersion) store.Decision
)

const (
	maxRegenerations   = 1
	reviewAfterStrikes = 3
	fhaInstructions    = "Answer without breaking fair housing law: do not describe, rank or recommend homes, neighborhoods or lenders by race, color, religion, sex, disability, familial status, national origin, age or source of income, and do not guess those traits about the user."
	fallbackMessage    = "I cannot help with that part of the request: fair housing law prohibits steering a home search by protected characteristics. I can help with price, size, commute and listing details."
)

type turnRequest struct {
	ConversationID string \`json:"conversation_id"\`
	Question       string \`json:"question"\`
}

func writeJSON(rw http.ResponseWriter, v any) {
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(v)
}

func steerAway(ctx context.Context, conversationID, outcome string, decision store.Decision, version string) map[string]any {
	strikes, _ := cache.RecordStrike(ctx, conversationID)
	if strikes == reviewAfterStrikes {
		store.EnqueueReview(ctx, conversationID, strikes)
	}
	return map[string]any{"conversation_id": conversationID, "answer": fallbackMessage, "outcome": outcome, "reasons": decision.Reasons, "escalated": strikes >= reviewAfterStrikes, "policy_version": version}
}

func turn(rw http.ResponseWriter, r *http.Request) {
	var body turnRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "body must be JSON", http.StatusBadRequest)
		return
	}
	version := cache.ActiveVersion(r.Context())
	inbound := tiers.Evaluate(r.Context(), body.Question, version)
	if !inbound.Allowed {
		writeJSON(rw, steerAway(r.Context(), body.ConversationID, "blocked_input", inbound, version))
		return
	}
	answer, err := model.Complete(r.Context(), body.Question, "")
	if err != nil {
		http.Error(rw, "model unavailable", http.StatusBadGateway)
		return
	}
	outbound := tiers.Evaluate(r.Context(), answer, version)
	for i := 0; i < maxRegenerations && !outbound.Allowed; i++ {
		answer, err = model.Complete(r.Context(), body.Question, fhaInstructions)
		if err != nil {
			break
		}
		outbound = tiers.Evaluate(r.Context(), answer, version)
	}
	if !outbound.Allowed {
		writeJSON(rw, steerAway(r.Context(), body.ConversationID, "blocked_output", outbound, version))
		return
	}
	writeJSON(rw, map[string]any{"conversation_id": body.ConversationID, "answer": answer, "outcome": "answered", "reasons": []string{}, "escalated": false, "policy_version": version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/turn", turn)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import fhguard.{Cache, Model, Tiers} // activeVersion(), recordStrike(id); complete(question, instructions); evaluate(text, version)

object SteerAway {
  val WarningNote = "Note: parts of this answer may touch on characteristics protected by fair housing law."

  private def respond(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def reply(conversationId: String, answer: String, outcome: String, reasons: Seq[String], escalated: Boolean, version: String): JsObject =
    JsObject(
      "conversation_id" -> JsString(conversationId),
      "answer" -> JsString(answer),
      "outcome" -> JsString(outcome),
      "reasons" -> JsArray(reasons.map(JsString(_)).toVector),
      "escalated" -> JsBoolean(escalated),
      "policy_version" -> JsString(version),
    )

  val route: Route = path("v1" / "turn") {
    post {
      entity(as[String]) { raw =>
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        val body = raw.parseJson.asJsObject.fields
        val conversationId = body.get("conversation_id").collect { case JsString(s) => s }.getOrElse("")
        val question = body.get("question").collect { case JsString(s) => s }.getOrElse("")
        val version = Cache.activeVersion().getOrElse("")
        val answer = Model.complete(question)
        val outbound = Tiers.evaluate(answer, version)
        if (!outbound.allowed) complete(respond(reply(conversationId, answer + "\\n\\n" + WarningNote, "flagged", outbound.reasons, escalated = false, version)))
        else complete(respond(reply(conversationId, answer, "answered", Seq.empty, escalated = false, version)))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import fhguard.{Cache, Model, Store, Tiers} // activeVersion(), recordStrike(id); complete(question, instructions); enqueueReview; evaluate(text, version)

object SteerAway {
  val MaxRegenerations = 1
  val ReviewAfterStrikes = 3
  val FhaInstructions = "Answer without breaking fair housing law: do not describe, rank or recommend homes, neighborhoods or lenders by race, color, religion, sex, disability, familial status, national origin, age or source of income, and do not guess those traits about the user."
  val FallbackMessage = "I cannot help with that part of the request: fair housing law prohibits steering a home search by protected characteristics. I can help with price, size, commute and listing details."

  private def respond(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def reply(conversationId: String, answer: String, outcome: String, reasons: Seq[String], escalated: Boolean, version: String): JsObject =
    JsObject(
      "conversation_id" -> JsString(conversationId),
      "answer" -> JsString(answer),
      "outcome" -> JsString(outcome),
      "reasons" -> JsArray(reasons.map(JsString(_)).toVector),
      "escalated" -> JsBoolean(escalated),
      "policy_version" -> JsString(version),
    )

  private def steerAway(conversationId: String, outcome: String, decision: Store.Decision, version: String): JsObject = {
    val strikes = Cache.recordStrike(conversationId)
    if (strikes == ReviewAfterStrikes) Store.enqueueReview(conversationId, strikes)
    reply(conversationId, FallbackMessage, outcome, decision.reasons, strikes >= ReviewAfterStrikes, version)
  }

  private def answerTurn(conversationId: String, question: String, version: String): JsObject = {
    val inbound = Tiers.evaluate(question, version)
    if (!inbound.allowed) return steerAway(conversationId, "blocked_input", inbound, version)
    var answer = Model.complete(question)
    var outbound = Tiers.evaluate(answer, version)
    for (_ <- 0 until MaxRegenerations if !outbound.allowed) {
      answer = Model.complete(question, FhaInstructions)
      outbound = Tiers.evaluate(answer, version)
    }
    if (!outbound.allowed) steerAway(conversationId, "blocked_output", outbound, version)
    else reply(conversationId, answer, "answered", Seq.empty, escalated = false, version)
  }

  val route: Route = path("v1" / "turn") {
    post {
      entity(as[String]) { raw =>
        val body = raw.parseJson.asJsObject.fields
        val conversationId = body.get("conversation_id").collect { case JsString(s) => s }.getOrElse("")
        val question = body.get("question").collect { case JsString(s) => s }.getOrElse("")
        complete(respond(answerTurn(conversationId, question, Cache.activeVersion().getOrElse(""))))
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

#include "fhguard/cache.h"  // cache::activeVersion(), cache::recordStrike(conversation_id)
#include "fhguard/model.h"  // model::complete(question, instructions = "")
#include "fhguard/store.h"  // store::enqueueReview(conversation_id, strikes); Decision
#include "fhguard/tiers.h"  // tiers::evaluate(text, policy_version) -> store::Decision

using json = nlohmann::json;

const std::string kWarningNote = "Note: parts of this answer may touch on characteristics protected by fair housing law.";

void turn(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body, nullptr, false);
  const std::string conversation_id = body.value("conversation_id", "");
  const std::string question = body.value("question", "");
  const std::string version = cache::activeVersion().value_or("");
  const std::string answer = model::complete(question);
  const store::Decision outbound = tiers::evaluate(answer, version);
  json out = {{"conversation_id", conversation_id}, {"escalated", false}, {"policy_version", version}};
  if (!outbound.allowed) {
    out["answer"] = answer + "\\n\\n" + kWarningNote;
    out["outcome"] = "flagged";
    out["reasons"] = outbound.reasons;
  } else {
    out["answer"] = answer;
    out["outcome"] = "answered";
    out["reasons"] = json::array();
  }
  res.set_content(out.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/turn", turn); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "fhguard/cache.h"  // cache::activeVersion(), cache::recordStrike(conversation_id)
#include "fhguard/model.h"  // model::complete(question, instructions = "")
#include "fhguard/store.h"  // store::enqueueReview(conversation_id, strikes); Decision
#include "fhguard/tiers.h"  // tiers::evaluate(text, policy_version) -> store::Decision

using json = nlohmann::json;

constexpr int kMaxRegenerations = 1;
constexpr long long kReviewAfterStrikes = 3;
const std::string kFhaInstructions = "Answer without breaking fair housing law: do not describe, rank or recommend homes, neighborhoods or lenders by race, color, religion, sex, disability, familial status, national origin, age or source of income, and do not guess those traits about the user.";
const std::string kFallbackMessage = "I cannot help with that part of the request: fair housing law prohibits steering a home search by protected characteristics. I can help with price, size, commute and listing details.";

json steerAway(const std::string& conversation_id, const std::string& outcome, const store::Decision& decision, const std::string& version) {
  const long long strikes = cache::recordStrike(conversation_id);
  if (strikes == kReviewAfterStrikes) store::enqueueReview(conversation_id, strikes);
  return {{"conversation_id", conversation_id}, {"answer", kFallbackMessage},       {"outcome", outcome},
          {"reasons", decision.reasons},        {"escalated", strikes >= kReviewAfterStrikes}, {"policy_version", version}};
}

json answerTurn(const std::string& conversation_id, const std::string& question, const std::string& version) {
  const store::Decision inbound = tiers::evaluate(question, version);
  if (!inbound.allowed) return steerAway(conversation_id, "blocked_input", inbound, version);
  std::string answer = model::complete(question);
  store::Decision outbound = tiers::evaluate(answer, version);
  for (int i = 0; i < kMaxRegenerations && !outbound.allowed; i++) {
    answer = model::complete(question, kFhaInstructions);
    outbound = tiers::evaluate(answer, version);
  }
  if (!outbound.allowed) return steerAway(conversation_id, "blocked_output", outbound, version);
  return {{"conversation_id", conversation_id}, {"answer", answer}, {"outcome", "answered"},
          {"reasons", json::array()},           {"escalated", false}, {"policy_version", version}};
}

void turn(const httplib::Request& req, httplib::Response& res) {
  const json body = json::parse(req.body, nullptr, false);
  const std::string conversation_id = body.value("conversation_id", "");
  const std::string question = body.value("question", "");
  res.set_content(answerTurn(conversation_id, question, cache::activeVersion().value_or("")).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/turn", turn); }
`,
    },
  },
  harness: {
    python: `import fair_housing_guardrail_pb2 as pb
import fair_housing_guardrail_pb2_grpc as pb_grpc
from fhguard import cache, store
from fhguard.store import Policy

POLICY = Policy("fh-2024-05-21", ["no section 8"])
NEUTRAL_Q = "What do two-bedroom homes near light rail cost?"
NEUTRAL_A = "Two-bedroom homes near light rail start around $750k."
STEER_Q = "Which neighborhood would suit my family?"
STUBBORN_Q = "Which neighborhood would suit my family? Be specific about the people."
BLOCKED_Q = "Which buildings have no section 8 tenants?"
STEERING_A = "Beacon Hill is mostly Latino families, so you would fit right in."
COMPLIANT_A = "Columbia City and Rainier Beach have three-bedroom homes in your budget near light rail."


class Classifier(pb_grpc.ClassifierServicer):
    """Scores 0.92 for text that names a protected group, 0.04 for anything else."""

    def Classify(self, request, context):
        flagged = "latino" in request.text.lower()
        return pb.ClassifyReply(score=0.92 if flagged else 0.04, label="national_origin" if flagged else "")


class Judge(pb_grpc.JudgeServicer):
    def Assess(self, request, context):
        return pb.Assessment(compliant=True)


class Assistant(pb_grpc.AssistantServicer):
    """Steers on a neighborhood question; under instructions it complies, unless asked about the people."""

    def Complete(self, request, context):
        if "neighborhood" not in request.question:
            return pb.CompleteReply(answer=NEUTRAL_A)
        if request.instructions and "about the people" not in request.question:
            return pb.CompleteReply(answer=COMPLIANT_A)
        return pb.CompleteReply(answer=STEERING_A)


def _api(ctx):
    ctx.grpc.serve(pb_grpc.add_ClassifierServicer_to_server, Classifier())
    ctx.grpc.serve(pb_grpc.add_JudgeServicer_to_server, Judge())
    ctx.grpc.serve(pb_grpc.add_AssistantServicer_to_server, Assistant())
    cache.publish(POLICY)
    m = ctx.load("steer_away")
    return m, ctx.client(m.app)


async def _turn(c, question, conversation_id="c-1"):
    r = await c.post("/v1/turn", json={"conversation_id": conversation_id, "question": question})
    assert r.status_code == 200, f"POST /v1/turn answered {r.status_code}: {r.text}"
    return r


async def check_turn_route(ctx):
    m, client = _api(ctx)
    async with client as c:
        body = (await _turn(c, NEUTRAL_Q)).json()
    assert body.get("outcome") == "answered" and body.get("answer") == NEUTRAL_A, f"a compliant question must be answered with the model's answer, got {body}"
    assert body.get("policy_version") == POLICY.version, f"the turn must name the active policy {POLICY.version}, got {body.get('policy_version')!r}"


async def check_input_guard_first(ctx):
    m, client = _api(ctx)
    async with client as c:
        body = (await _turn(c, BLOCKED_Q)).json()
    calls = len(ctx.grpc.calls_to("Complete"))
    assert calls == 0, f"the model was asked a question the guard blocks ({calls} Complete call(s)): evaluate the question before any model call"
    assert body.get("outcome") == "blocked_input", f"a question the stop list blocks answered outcome {body.get('outcome')!r}, expected blocked_input"
    assert body.get("answer") == getattr(m, "FALLBACK_MESSAGE", None), f"a blocked question must answer FALLBACK_MESSAGE, got {body.get('answer')!r}"


async def check_fallback_not_text(ctx):
    m, client = _api(ctx)
    async with client as c:
        r = await _turn(c, STUBBORN_Q)
    assert "Latino" not in r.text, f"the blocked answer reached the user: {r.json().get('answer')!r}. A blocked turn answers the fallback, nothing of the model's text"
    body = r.json()
    assert body.get("outcome") == "blocked_output", f"a turn whose answers stay blocked answered outcome {body.get('outcome')!r}, expected blocked_output"
    assert body.get("answer") == getattr(m, "FALLBACK_MESSAGE", None), f"a blocked turn must answer FALLBACK_MESSAGE, got {body.get('answer')!r}"


async def check_regenerate_once(ctx):
    m, client = _api(ctx)
    async with client as c:
        body = (await _turn(c, STEER_Q)).json()
        calls = ctx.grpc.calls_to("Complete")
        assert len(calls) == 2, f"a blocked answer led to {len(calls)} model call(s), expected the first and one regeneration"
        instructions = getattr(m, "FHA_INSTRUCTIONS", None)
        assert calls[0].request.instructions == "" and instructions and calls[1].request.instructions == instructions, f"the regeneration must carry FHA_INSTRUCTIONS, the calls carried {[c.request.instructions for c in calls]}"
        assert body.get("outcome") == "answered" and body.get("answer") == COMPLIANT_A, f"the compliant regenerated answer must go back, got {body}"
        stubborn = (await _turn(c, STUBBORN_Q, "c-2")).json()
    total = len(ctx.grpc.calls_to("Complete"))
    assert total == 4, f"a turn whose regeneration is blocked too made {total - 2} model calls, expected 2: regenerate at most MAX_REGENERATIONS = 1 time"
    assert stubborn.get("outcome") == "blocked_output", f"a regenerated answer that still steers went back as {stubborn}: evaluate the regenerated answer before returning it"


async def check_strikes_escalate(ctx):
    m, client = _api(ctx)
    async with client as c:
        escalated = [(await _turn(c, BLOCKED_Q, "c-9")).json().get("escalated") for _ in range(3)]
        assert escalated == [False, False, True], f"three blocked turns answered escalated {escalated}, expected [False, False, True]"
        queue = store.review_queue()
        assert queue == [{"conversation_id": "c-9", "strikes": 3}], f"the review queue holds {queue}, expected c-9 once with 3 strikes"
        fourth = (await _turn(c, BLOCKED_Q, "c-9")).json()
        assert fourth.get("escalated") is True, f"a blocked turn after the third strike answered {fourth}"
        assert len(store.review_queue()) == 1, f"the fourth strike enqueued the conversation again: {store.review_queue()}"
        answered = (await _turn(c, NEUTRAL_Q, "c-9")).json()
        assert answered.get("outcome") == "answered" and ctx.redis.get("fh:strikes:c-9") == "4", "an answered turn must not add a strike"
        await _turn(c, STUBBORN_Q, "c-11")
    assert ctx.redis.get("fh:strikes:c-11") == "1", f"a turn blocked on the output must count a strike, fh:strikes:c-11 is {ctx.redis.get('fh:strikes:c-11')!r}"
`,
    typescript: `const POLICY = {version: 'fh-2024-05-21', stop_phrases: ['no section 8']};
const NEUTRAL_Q = 'What do two-bedroom homes near light rail cost?';
const NEUTRAL_A = 'Two-bedroom homes near light rail start around $750k.';
const STEER_Q = 'Which neighborhood would suit my family?';
const STUBBORN_Q = 'Which neighborhood would suit my family? Be specific about the people.';
const BLOCKED_Q = 'Which buildings have no section 8 tenants?';
const STEERING_A = 'Beacon Hill is mostly Latino families, so you would fit right in.';
const COMPLIANT_A = 'Columbia City and Rainier Beach have three-bedroom homes in your budget near light rail.';

/** The classifier flags text naming a protected group; the model steers on a neighborhood question unless instructed. */
async function api(ctx) {
  const pkg = ctx.proto('fair_housing_guardrail.proto');
  ctx.grpc.serve(pkg.fairhousing.Classifier.service, {
    Classify(call, callback) {
      const flagged = call.request.text.toLowerCase().includes('latino');
      callback(null, {score: flagged ? 0.92 : 0.04, label: flagged ? 'national_origin' : ''});
    },
  });
  ctx.grpc.serve(pkg.fairhousing.Judge.service, {
    Assess(call, callback) {
      callback(null, {compliant: true, reason: ''});
    },
  });
  ctx.grpc.serve(pkg.fairhousing.Assistant.service, {
    Complete(call, callback) {
      const {question, instructions} = call.request;
      if (!question.includes('neighborhood')) return callback(null, {answer: NEUTRAL_A});
      if (instructions && !question.includes('about the people')) return callback(null, {answer: COMPLIANT_A});
      callback(null, {answer: STEERING_A});
    },
  });
  await ctx.load('/support/fhguard/cache.ts').publish(POLICY);
  const store = ctx.load('/support/fhguard/store.ts');
  const m = ctx.load('steer_away');
  return {m, c: ctx.client(m.app), store};
}

async function turn(c, question: string, conversationId = 'c-1') {
  const r = await c.post('/v1/turn', {json: {conversation_id: conversationId, question}});
  assert.equal(r.status, 200, \`POST /v1/turn answered \${r.status}: \${r.text}\`);
  return r;
}

export async function check_turn_route(ctx) {
  const {c} = await api(ctx);
  const body = (await turn(c, NEUTRAL_Q)).json();
  assert(body.outcome === 'answered' && body.answer === NEUTRAL_A, \`a compliant question must be answered with the model's answer, got \${JSON.stringify(body)}\`);
  assert.equal(body.policy_version, POLICY.version, \`the turn must name the active policy \${POLICY.version}\`);
}

export async function check_input_guard_first(ctx) {
  const {m, c} = await api(ctx);
  const body = (await turn(c, BLOCKED_Q)).json();
  const calls = ctx.grpc.callsTo('Complete').length;
  assert.equal(calls, 0, \`the model was asked a question the guard blocks (\${calls} Complete call(s)): evaluate the question before any model call\`);
  assert.equal(body.outcome, 'blocked_input', \`a question the stop list blocks answered outcome \${JSON.stringify(body.outcome)}, expected blocked_input\`);
  assert.equal(body.answer, m.FALLBACK_MESSAGE, \`a blocked question must answer FALLBACK_MESSAGE, got \${JSON.stringify(body.answer)}\`);
}

export async function check_fallback_not_text(ctx) {
  const {m, c} = await api(ctx);
  const r = await turn(c, STUBBORN_Q);
  assert(!r.text.includes('Latino'), \`the blocked answer reached the user: \${JSON.stringify(r.json().answer)}. A blocked turn answers the fallback, nothing of the model's text\`);
  const body = r.json();
  assert.equal(body.outcome, 'blocked_output', \`a turn whose answers stay blocked answered outcome \${JSON.stringify(body.outcome)}, expected blocked_output\`);
  assert.equal(body.answer, m.FALLBACK_MESSAGE, \`a blocked turn must answer FALLBACK_MESSAGE, got \${JSON.stringify(body.answer)}\`);
}

export async function check_regenerate_once(ctx) {
  const {m, c} = await api(ctx);
  const body = (await turn(c, STEER_Q)).json();
  const calls = ctx.grpc.callsTo('Complete');
  assert.equal(calls.length, 2, \`a blocked answer led to \${calls.length} model call(s), expected the first and one regeneration\`);
  const sent = calls.map(call => call.request.instructions);
  assert(sent[0] === '' && m.FHA_INSTRUCTIONS && sent[1] === m.FHA_INSTRUCTIONS, \`the regeneration must carry FHA_INSTRUCTIONS, the calls carried \${JSON.stringify(sent)}\`);
  assert(body.outcome === 'answered' && body.answer === COMPLIANT_A, \`the compliant regenerated answer must go back, got \${JSON.stringify(body)}\`);
  const stubborn = (await turn(c, STUBBORN_Q, 'c-2')).json();
  const total = ctx.grpc.callsTo('Complete').length;
  assert.equal(total, 4, \`a turn whose regeneration is blocked too made \${total - 2} model calls, expected 2: regenerate at most MAX_REGENERATIONS = 1 time\`);
  assert.equal(stubborn.outcome, 'blocked_output', \`a regenerated answer that still steers went back as \${JSON.stringify(stubborn)}: evaluate the regenerated answer before returning it\`);
}

export async function check_strikes_escalate(ctx) {
  const {c, store} = await api(ctx);
  const escalated = [];
  for (let i = 0; i < 3; i++) escalated.push((await turn(c, BLOCKED_Q, 'c-9')).json().escalated);
  assert.deepStrictEqual(escalated, [false, false, true], \`three blocked turns answered escalated \${JSON.stringify(escalated)}, expected [false, false, true]\`);
  const queue = await store.reviewQueue();
  assert.deepStrictEqual(queue, [{conversation_id: 'c-9', strikes: 3}], \`the review queue holds \${JSON.stringify(queue)}, expected c-9 once with 3 strikes\`);
  const fourth = (await turn(c, BLOCKED_Q, 'c-9')).json();
  assert.equal(fourth.escalated, true, \`a blocked turn after the third strike answered \${JSON.stringify(fourth)}\`);
  assert.equal((await store.reviewQueue()).length, 1, 'the fourth strike must not enqueue the conversation again');
  const answered = (await turn(c, NEUTRAL_Q, 'c-9')).json();
  assert(answered.outcome === 'answered' && ctx.redis.get('fh:strikes:c-9') === '4', 'an answered turn must not add a strike');
  await turn(c, STUBBORN_Q, 'c-11');
  assert.equal(ctx.redis.get('fh:strikes:c-11'), '1', 'a turn blocked on the output must count a strike');
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"fhguard/cache"
	pb "fhguard/gen/fair_housing_guardrail"
	"fhguard/store"

	"leetbuild/harness"
)

const (
	neutralQ   = "What do two-bedroom homes near light rail cost?"
	neutralA   = "Two-bedroom homes near light rail start around $750k."
	steerQ     = "Which neighborhood would suit my family?"
	stubbornQ  = "Which neighborhood would suit my family? Be specific about the people."
	blockedQ   = "Which buildings have no section 8 tenants?"
	steeringA  = "Beacon Hill is mostly Latino families, so you would fit right in."
	compliantA = "Columbia City and Rainier Beach have three-bedroom homes in your budget near light rail."
)

var turnPolicy = store.Policy{Version: "fh-2024-05-21", StopPhrases: []string{"no section 8"}}

type classifierPeer struct {
	pb.UnimplementedClassifierServer
}

func (classifierPeer) Classify(_ context.Context, req *pb.ClassifyRequest) (*pb.ClassifyReply, error) {
	if strings.Contains(strings.ToLower(req.GetText()), "latino") {
		return &pb.ClassifyReply{Score: 0.92, Label: "national_origin"}, nil
	}
	return &pb.ClassifyReply{Score: 0.04}, nil
}

type judgePeer struct {
	pb.UnimplementedJudgeServer
}

func (judgePeer) Assess(context.Context, *pb.AssessRequest) (*pb.Assessment, error) {
	return &pb.Assessment{Compliant: true}, nil
}

// assistantPeer steers on a neighborhood question; under instructions it complies, unless asked about the people.
type assistantPeer struct {
	pb.UnimplementedAssistantServer
}

func (assistantPeer) Complete(_ context.Context, req *pb.CompleteRequest) (*pb.CompleteReply, error) {
	q := req.GetQuestion()
	if !strings.Contains(q, "neighborhood") {
		return &pb.CompleteReply{Answer: neutralA}, nil
	}
	if req.GetInstructions() != "" && !strings.Contains(q, "about the people") {
		return &pb.CompleteReply{Answer: compliantA}, nil
	}
	return &pb.CompleteReply{Answer: steeringA}, nil
}

func api(ctx *harness.Ctx) *harness.HTTP {
	pb.RegisterClassifierServer(ctx.GRPC.Server("classifier:9000"), classifierPeer{})
	pb.RegisterJudgeServer(ctx.GRPC.Server("judge:9000"), judgePeer{})
	pb.RegisterAssistantServer(ctx.GRPC.Server("model:9000"), assistantPeer{})
	cache.Publish(context.Background(), turnPolicy)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

type turnReply struct {
	Answer        string   \`json:"answer"\`
	Outcome       string   \`json:"outcome"\`
	Reasons       []string \`json:"reasons"\`
	Escalated     bool     \`json:"escalated"\`
	PolicyVersion string   \`json:"policy_version"\`
}

func ask(ctx *harness.Ctx, c *harness.HTTP, question, conversationID string) (turnReply, string) {
	r := c.Post("/v1/turn", map[string]string{"conversation_id": conversationID, "question": question})
	ctx.Equal(r.Status, 200, "POST /v1/turn (%s)", r.Text())
	var out turnReply
	r.Decode(&out)
	return out, r.Text()
}

func CheckTurnRoute(ctx *harness.Ctx) {
	c := api(ctx)
	got, text := ask(ctx, c, neutralQ, "c-1")
	ctx.Assert(got.Outcome == "answered" && got.Answer == neutralA, "a compliant question must be answered with the model's answer, got %s", text)
	ctx.Equal(got.PolicyVersion, turnPolicy.Version, "the turn must name the active policy; policy_version")
}

func CheckInputGuardFirst(ctx *harness.Ctx) {
	c := api(ctx)
	got, _ := ask(ctx, c, blockedQ, "c-1")
	ctx.Equal(len(ctx.GRPC.CallsTo("Complete", "")), 0, "the model must not be asked a question the guard blocks (evaluate the question before any model call); the Complete calls")
	ctx.Equal(got.Outcome, "blocked_input", "a question the stop list blocks; the outcome")
	ctx.Equal(got.Answer, fallbackMessage, "a blocked question must answer fallbackMessage; the answer")
}

func CheckFallbackNotText(ctx *harness.Ctx) {
	c := api(ctx)
	got, text := ask(ctx, c, stubbornQ, "c-1")
	ctx.Assert(!strings.Contains(text, "Latino"), "the blocked answer reached the user: %q. A blocked turn answers the fallback, nothing of the model's text", got.Answer)
	ctx.Equal(got.Outcome, "blocked_output", "a turn whose answers stay blocked; the outcome")
	ctx.Equal(got.Answer, fallbackMessage, "a blocked turn must answer fallbackMessage; the answer")
}

func CheckRegenerateOnce(ctx *harness.Ctx) {
	c := api(ctx)
	got, text := ask(ctx, c, steerQ, "c-1")
	calls := ctx.GRPC.CallsTo("Complete", "")
	ctx.Equal(len(calls), 2, "a blocked answer must lead to the first call and one regeneration; the model calls")
	var sent []string
	for _, call := range calls {
		sent = append(sent, call.Request.(*pb.CompleteRequest).GetInstructions())
	}
	ctx.Equal(sent, []string{"", fhaInstructions}, "the regeneration must carry fhaInstructions; the instructions sent")
	ctx.Assert(got.Outcome == "answered" && got.Answer == compliantA, "the compliant regenerated answer must go back, got %s", text)
	stubborn, stubbornText := ask(ctx, c, stubbornQ, "c-2")
	ctx.Equal(len(ctx.GRPC.CallsTo("Complete", "")), 4, "a turn whose regeneration is blocked too must make 2 model calls (regenerate at most once); the calls after both turns")
	ctx.Assert(stubborn.Outcome == "blocked_output", "a regenerated answer that still steers went back as %s: evaluate the regenerated answer before returning it", stubbornText)
}

func CheckStrikesEscalate(ctx *harness.Ctx) {
	c := api(ctx)
	var escalated []bool
	for i := 0; i < 3; i++ {
		got, _ := ask(ctx, c, blockedQ, "c-9")
		escalated = append(escalated, got.Escalated)
	}
	ctx.Equal(escalated, []bool{false, false, true}, "three blocked turns; escalated")
	bg := context.Background()
	ctx.Equal(store.ReviewQueue(bg), []store.ReviewItem{{ConversationID: "c-9", Strikes: 3}}, "the review queue must hold c-9 once with 3 strikes")
	fourth, text := ask(ctx, c, blockedQ, "c-9")
	ctx.Assert(fourth.Escalated, "a blocked turn after the third strike answered %s", text)
	ctx.Equal(len(store.ReviewQueue(bg)), 1, "the fourth strike must not enqueue the conversation again; the queue length")
	answered, _ := ask(ctx, c, neutralQ, "c-9")
	strikes, _ := ctx.Redis.Get("fh:strikes:c-9")
	ctx.Assert(answered.Outcome == "answered" && strikes == "4", "an answered turn must not add a strike (fh:strikes:c-9 is %q)", strikes)
	ask(ctx, c, stubbornQ, "c-11")
	other, _ := ctx.Redis.Get("fh:strikes:c-11")
	ctx.Equal(other, "1", "a turn blocked on the output must count a strike; fh:strikes:c-11")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <string>
#include <vector>

#include "fair_housing_guardrail.grpc.pb.h"
#include "fhguard/cache.h"
#include "fhguard/store.h"

namespace {

const store::Policy kTurnPolicy{"fh-2024-05-21", {"no section 8"}};
const std::string kNeutralQ = "What do two-bedroom homes near light rail cost?";
const std::string kNeutralA = "Two-bedroom homes near light rail start around $750k.";
const std::string kSteerQ = "Which neighborhood would suit my family?";
const std::string kStubbornQ = "Which neighborhood would suit my family? Be specific about the people.";
const std::string kBlockedQ = "Which buildings have no section 8 tenants?";
const std::string kSteeringA = "Beacon Hill is mostly Latino families, so you would fit right in.";
const std::string kCompliantA = "Columbia City and Rainier Beach have three-bedroom homes in your budget near light rail.";

class ClassifierPeer final : public fairhousing::Classifier::Service {
 public:
  grpc::Status Classify(grpc::ServerContext*, const fairhousing::ClassifyRequest* req, fairhousing::ClassifyReply* out) override {
    std::string text = req->text();
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    const bool flagged = text.find("latino") != std::string::npos;
    out->set_score(flagged ? 0.92 : 0.04);
    out->set_label(flagged ? "national_origin" : "");
    return grpc::Status::OK;
  }
};

class JudgePeer final : public fairhousing::Judge::Service {
 public:
  grpc::Status Assess(grpc::ServerContext*, const fairhousing::AssessRequest*, fairhousing::Assessment* out) override {
    out->set_compliant(true);
    return grpc::Status::OK;
  }
};

// Steers on a neighborhood question; under instructions it complies, unless asked about the people.
class AssistantPeer final : public fairhousing::Assistant::Service {
 public:
  grpc::Status Complete(grpc::ServerContext*, const fairhousing::CompleteRequest* req, fairhousing::CompleteReply* out) override {
    const std::string& q = req->question();
    if (q.find("neighborhood") == std::string::npos) {
      out->set_answer(kNeutralA);
    } else if (!req->instructions().empty() && q.find("about the people") == std::string::npos) {
      out->set_answer(kCompliantA);
    } else {
      out->set_answer(kSteeringA);
    }
    return grpc::Status::OK;
  }
};

struct Peers {
  ClassifierPeer classifier;
  JudgePeer judge;
  AssistantPeer assistant;
};

harness::HTTP api(harness::Ctx& ctx) {
  static Peers* peers = nullptr;
  delete peers;
  peers = new Peers;
  ctx.GRPC.Server("classifier:9000")->RegisterService(&peers->classifier);
  ctx.GRPC.Server("judge:9000")->RegisterService(&peers->judge);
  ctx.GRPC.Server("model:9000")->RegisterService(&peers->assistant);
  cache::publish(kTurnPolicy);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json ask(harness::Ctx& ctx, harness::HTTP& c, const std::string& question, const std::string& conversation_id, std::string* raw = nullptr) {
  const auto r = c.Post("/v1/turn", nlohmann::json{{"conversation_id", conversation_id}, {"question", question}}.dump(), "Content-Type", "application/json");
  ctx.Equal(r.Status, 200, "POST /v1/turn (%s)", r.Text());
  if (raw != nullptr) *raw = r.Text();
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_object() ? j : nlohmann::json::object();
}

}  // namespace

void CheckTurnRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto got = ask(ctx, c, kNeutralQ, "c-1");
  ctx.Assert(got.value("outcome", "") == "answered" && got.value("answer", "") == kNeutralA, "a compliant question must be answered with the model's answer, got %s", got.dump());
  ctx.Equal(got.value("policy_version", ""), kTurnPolicy.version, "the turn must name the active policy; policy_version");
}

void CheckInputGuardFirst(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto got = ask(ctx, c, kBlockedQ, "c-1");
  ctx.Equal(ctx.GRPC.CallsTo("Complete").size(), 0, "the model must not be asked a question the guard blocks (evaluate the question before any model call); the Complete calls");
  ctx.Equal(got.value("outcome", ""), "blocked_input", "a question the stop list blocks; the outcome");
  ctx.Equal(got.value("answer", ""), kFallbackMessage, "a blocked question must answer kFallbackMessage; the answer");
}

void CheckFallbackNotText(harness::Ctx& ctx) {
  auto c = api(ctx);
  std::string raw;
  const auto got = ask(ctx, c, kStubbornQ, "c-1", &raw);
  ctx.Assert(raw.find("Latino") == std::string::npos, "the blocked answer reached the user: %q. A blocked turn answers the fallback, nothing of the model's text", got.value("answer", ""));
  ctx.Equal(got.value("outcome", ""), "blocked_output", "a turn whose answers stay blocked; the outcome");
  ctx.Equal(got.value("answer", ""), kFallbackMessage, "a blocked turn must answer kFallbackMessage; the answer");
}

void CheckRegenerateOnce(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto got = ask(ctx, c, kSteerQ, "c-1");
  const auto calls = ctx.GRPC.CallsTo("Complete");
  ctx.Equal(calls.size(), 2, "a blocked answer must lead to the first call and one regeneration; the model calls");
  std::vector<std::string> sent;
  for (const auto& call : calls) sent.push_back(call.Request<fairhousing::CompleteRequest>().instructions());
  ctx.Equal(sent, std::vector<std::string>{"", kFhaInstructions}, "the regeneration must carry kFhaInstructions; the instructions sent");
  ctx.Assert(got.value("outcome", "") == "answered" && got.value("answer", "") == kCompliantA, "the compliant regenerated answer must go back, got %s", got.dump());
  const auto stubborn = ask(ctx, c, kStubbornQ, "c-2");
  ctx.Equal(ctx.GRPC.CallsTo("Complete").size(), 4, "a turn whose regeneration is blocked too must make 2 model calls (regenerate at most once); the calls after both turns");
  ctx.Assert(stubborn.value("outcome", "") == "blocked_output", "a regenerated answer that still steers went back as %s: evaluate the regenerated answer before returning it", stubborn.dump());
}

void CheckStrikesEscalate(harness::Ctx& ctx) {
  auto c = api(ctx);
  std::vector<bool> escalated;
  for (int i = 0; i < 3; i++) escalated.push_back(ask(ctx, c, kBlockedQ, "c-9").value("escalated", false));
  ctx.Equal(escalated, std::vector<bool>{false, false, true}, "three blocked turns; escalated");
  const auto queue = store::reviewQueue();
  ctx.Assert(queue.size() == 1 && queue[0].value("conversation_id", "") == "c-9" && queue[0].value("strikes", 0) == 3, "the review queue must hold c-9 once with 3 strikes, holds %d item(s)", queue.size());
  const auto fourth = ask(ctx, c, kBlockedQ, "c-9");
  ctx.Assert(fourth.value("escalated", false), "a blocked turn after the third strike answered %s", fourth.dump());
  ctx.Equal(store::reviewQueue().size(), 1, "the fourth strike must not enqueue the conversation again; the queue length");
  const auto answered = ask(ctx, c, kNeutralQ, "c-9");
  ctx.Assert(answered.value("outcome", "") == "answered" && ctx.Redis.Get("fh:strikes:c-9").value_or("") == "4", "an answered turn must not add a strike (fh:strikes:c-9 is %q)", ctx.Redis.Get("fh:strikes:c-9").value_or(""));
  ask(ctx, c, kStubbornQ, "c-11");
  ctx.Equal(ctx.Redis.Get("fh:strikes:c-11").value_or(""), "1", "a turn blocked on the output must count a strike; fh:strikes:c-11");
}
`,
  },
  hints: [
    'Ask which neighborhood suits your family: the answer names who lives there, with a fair-housing note under it. Ask about buildings with no section 8 tenants: the model answers that too, and nobody ever reviews the conversation.',
    'The handler calls the model before any evaluation, so a blocked question still gets an answer. The blocked branch builds its reply from the model text, never asks again with instructions, and nothing counts blocked turns.',
    'Evaluate `body.question` first and return `FALLBACK_MESSAGE` with `blocked_input`; on a blocked answer loop `range(MAX_REGENERATIONS)` over `model.complete(question, FHA_INSTRUCTIONS)` and evaluate again; a blocked turn calls `record_strike` and `enqueue_review` at 3.',
  ],
  debrief: `The fallback is a fixed message because the only safe amount of a blocked answer to show is none: a disclaimer under a steering answer is still steering. Guarding the question first keeps the model from ever composing that answer, and one regeneration under explicit fair-housing instructions recovers the turns where the model merely phrased a compliant answer badly, without letting the guard loop on a stubborn prompt. The strike count turns a pattern into a signal: one blocked turn is a mistake, three in a day is worth a person's time, and enqueuing once keeps the queue honest. Production assistants tell the user why the request was declined and offer the compliant parts of the search, and sample answered turns for human review to measure what the guard missed.`,
};
