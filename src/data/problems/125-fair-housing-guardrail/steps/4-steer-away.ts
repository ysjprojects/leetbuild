import type {Step} from '@/lib/types';

export const steerAwayStep: Step = {
  id: 'steer-away',
  title: 'POST /v1/turn: guard first, regenerate once, never the blocked text, escalate',
  concept: 'http',
  file: 'steer_away',
  focus: ['guard', 'model', 'review', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the guarded turn: it calls
the model, runs the output guard and returns an answer. The demo shows a disclaimer under a flagged
answer and everyone nods. It hides four production flaws, and the first is the exact behaviour the
Fair Housing Act forbids. Review it, fix it, and prove the fix.

Implement \`POST /v1/turn\` with body \`{"conversation_id": "c-8812", "question": "…"}\`, the
endpoint an assistant calls to get a guarded answer in one round trip:

- **Input guard first.** \`guard.evaluate(question, "input")\` runs **before** any model call. A
  blocked question never reaches the model: the user gets \`FALLBACK_MESSAGE\` with outcome
  \`blocked_input\`.
- **Output guard.** The model's answer goes through \`guard.evaluate(answer, "output")\`.
- **Regenerate once.** When the output is blocked, call the model again with
  \`constraint = FHA_CONSTRAINT\` — the fair-housing instructions the Zillow post adds to the
  prompt — and guard the new answer. \`MAX_REGENERATIONS = 1\`: a second block means the question
  cannot be answered compliantly.
- **Never the blocked text.** A blocked turn returns \`FALLBACK_MESSAGE\` — the post's predefined
  message explaining that the assistant cannot help with that part of the request under fair
  housing rules, and what it can help with — with outcome \`blocked_output\`. The model's text is
  not returned, not with a warning, not "for transparency", not at all.
- **Escalate repeat offenders.** Every blocked turn records a strike (\`strikes.record\`, the
  expiring counter from the Redis step). When the count reaches \`REVIEW_AFTER_STRIKES = 3\` the
  conversation is enqueued for human review (\`review.enqueue\`) and the response carries
  \`escalated: true\` so the assistant can slow the conversation down.

**Failure mode the checks target.** Appending a warning to a blocked answer *is* the violation: the
user still gets the neighborhood-by-demographic list, now with a footnote. Skipping the input guard
sends the steering question to the model, spending tokens on an answer that must then be thrown
away — and if the output guard misses it (recall is never 1.0), it ships. No regeneration means a
flagged answer always ends in a refusal when a compliant one was available. And without strikes,
the user who rephrases the same question twenty times is indistinguishable from twenty users.`,
  sequence: {
    participants: ['Assistant', 'fhguard', 'Model', 'Review queue'],
    messages: [
      {from: 'Assistant', to: 'fhguard', label: 'POST /v1/turn {conversation_id, question}', kind: 'sync'},
      {from: 'fhguard', to: 'fhguard', label: 'guard.evaluate(question, "input") → blocked? fallback', kind: 'sync'},
      {from: 'fhguard', to: 'Model', label: 'complete(question)', kind: 'sync'},
      {from: 'Model', to: 'fhguard', label: 'answer', kind: 'reply'},
      {from: 'fhguard', to: 'fhguard', label: 'guard.evaluate(answer, "output") → blocked', kind: 'sync'},
      {from: 'fhguard', to: 'Model', label: 'complete(question, FHA_CONSTRAINT) · once', kind: 'sync'},
      {from: 'Model', to: 'fhguard', label: 'regenerated answer → guard again', kind: 'reply'},
      {from: 'fhguard', to: 'Review queue', label: 'enqueue(conversation) at 3 strikes', kind: 'async'},
      {from: 'fhguard', to: 'Assistant', label: '200 {answer | FALLBACK_MESSAGE, outcome, escalated}', kind: 'reply'},
    ],
  },
  hints: [
    'Order the handler as the post orders the system: input guard, model, output guard. The first guard call must sit above the first model call — a blocked question returns the fallback before the model is ever touched.',
    'Regeneration is a bounded loop: `for _ in range(MAX_REGENERATIONS)` (or `i < MAX_REGENERATIONS`), call `model.complete(question, constraint=FHA_CONSTRAINT)` and guard the result; break on the first allowed answer. The constraint is the fair-housing instruction block from the post, not a vague "be nice".',
    'One function builds every blocked response: record the strike, compare against `REVIEW_AFTER_STRIKES`, enqueue the conversation for review when it is reached, and return `FALLBACK_MESSAGE` with the outcome and `escalated`. Delete `WARNING_NOTE` and every path that returns the model text after a block.',
  ],
  checks: [
    {
      id: 'input-guard-first',
      title: 'Guards the question before calling the model',
      detail:
        '`guard.evaluate(question, "input")` runs before the first model call, and a blocked question returns the fallback without touching the model. The draft only guards the output.',
      match: {
        python: {all: [/"input"/], order: [/guard\.evaluate\(/, /model\.complete\(/]},
        typescript: {all: [/'input'/], order: [/guard\.evaluate\(/, /model\.complete\(/]},
        go: {all: [/"input"/], order: [/guard\.Evaluate\(/, /model\.Complete\(/]},
        scala: {all: [/"input"/], order: [/guard\.evaluate\(/, /model\.complete\(/]},
        cpp: {all: [/"input"/], order: [/guard\.evaluate\(/, /model\.complete\(/]},
      },
    },
    {
      id: 'never-blocked-text',
      title: 'Returns the fallback, never the blocked text',
      detail:
        'A blocked turn answers with `FALLBACK_MESSAGE`, the predefined fair-housing message. The draft returns the model’s text with `WARNING_NOTE` appended — the violation, with a footnote.',
      match: {
        python: {all: [/FALLBACK_MESSAGE/, /blocked_output/], none: [/WARNING_NOTE/]},
        typescript: {all: [/FALLBACK_MESSAGE/, /blocked_output/], none: [/WARNING_NOTE/]},
        go: {all: [/fallbackMessage/, /blocked_output/], none: [/warningNote/]},
        scala: {all: [/FallbackMessage/, /blocked_output/], none: [/WarningNote/]},
        cpp: {all: [/kFallbackMessage/, /blocked_output/], none: [/kWarningNote/]},
      },
    },
    {
      id: 'regenerate-once',
      title: 'Regenerates at most once under the FHA constraint',
      detail:
        'A blocked answer is regenerated once with `FHA_CONSTRAINT` as the model constraint, bounded by `MAX_REGENERATIONS = 1`. The draft never regenerates.',
      match: {
        python: {all: [/MAX_REGENERATIONS\s*=\s*1\b/, /range\(MAX_REGENERATIONS\)/, /constraint=FHA_CONSTRAINT/]},
        typescript: {all: [/MAX_REGENERATIONS\s*=\s*1\b/, /<\s*MAX_REGENERATIONS/, /FHA_CONSTRAINT\)/]},
        go: {all: [/maxRegenerations\s*=\s*1\b/, /<\s*maxRegenerations/, /fhaConstraint\)/]},
        scala: {all: [/MaxRegenerations\s*=\s*1\b/, /<\s*MaxRegenerations/, /FhaConstraint\)/]},
        cpp: {all: [/kMaxRegenerations\s*=\s*1\b/, /<\s*kMaxRegenerations/, /kFhaConstraint\)/]},
      },
    },
    {
      id: 'recheck-regenerated',
      title: 'Guards the regenerated answer again',
      detail:
        'The regenerated answer goes through the output guard before it can be returned; a regeneration that is still blocked ends in the fallback. The draft has no regeneration, so nothing is rechecked.',
      match: {
        python: {order: [/complete\([^)]*FHA_CONSTRAINT/, /guard\.evaluate\([^)]*"output"/]},
        typescript: {order: [/complete\([^)]*FHA_CONSTRAINT/, /guard\.evaluate\([^)]*'output'/]},
        go: {order: [/Complete\([^)]*fhaConstraint/, /guard\.Evaluate\([^)]*"output"/]},
        scala: {order: [/complete\([^)]*FhaConstraint/, /guard\.evaluate\([^)]*"output"/]},
        cpp: {order: [/complete\([^)]*kFhaConstraint/, /guard\.evaluate\([^)]*"output"/]},
      },
    },
    {
      id: 'strikes-escalate',
      title: 'Records strikes and escalates at three',
      detail:
        'Every blocked turn records a strike; at `REVIEW_AFTER_STRIKES = 3` the conversation is enqueued for human review and the response says `escalated: true`. The draft keeps no count.',
      match: {
        python: {all: [/REVIEW_AFTER_STRIKES\s*=\s*3\b/, /strikes\.record\(/, /review\.enqueue\(/, /escalated/]},
        typescript: {all: [/REVIEW_AFTER_STRIKES\s*=\s*3\b/, /strikes\.record\(/, /review\.enqueue\(/, /escalated/]},
        go: {all: [/reviewAfterStrikes\s*=\s*3\b/, /strikes\.Record\(/, /review\.Enqueue\(/, /escalated/]},
        scala: {all: [/ReviewAfterStrikes\s*=\s*3\b/, /strikes\.record\(/, /review\.enqueue\(/, /escalated/]},
        cpp: {all: [/kReviewAfterStrikes\s*=\s*3\b/, /strikes\.record\(/, /review\.enqueue\(/, /escalated/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from dataclasses import dataclass, field

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

WARNING_NOTE = "Note: parts of this answer may touch on characteristics protected by fair housing law."


class TurnRequest(BaseModel):
    conversation_id: str
    question: str


@dataclass
class Decision:
    allowed: bool
    tier: str
    reasons: list[str] = field(default_factory=list)


class Guard:
    def evaluate(self, text: str, direction: str) -> Decision:
        """Stop list, classifier and judge for the conversation's pinned policy."""
        raise NotImplementedError


class Model:
    def complete(self, question: str, constraint: str | None = None) -> str:
        """The assistant's answer; the constraint is prepended to the system prompt."""
        raise NotImplementedError


guard = Guard()
model = Model()


@app.post("/v1/turn")
def turn(body: TurnRequest) -> dict:
    # TODO: this draft never guards the question, returns the blocked text with a warning
    # appended, never regenerates, and keeps no strikes. Review all four.
    answer = model.complete(body.question)
    outbound = guard.evaluate(answer, "output")
    if not outbound.allowed:
        return {
            "conversation_id": body.conversation_id,
            "answer": answer + "\\n\\n" + WARNING_NOTE,
            "outcome": "flagged",
            "reasons": outbound.reasons,
        }
    return {"conversation_id": body.conversation_id, "answer": answer, "outcome": "answered"}
`,
      solution: `from dataclasses import dataclass, field

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

MAX_REGENERATIONS = 1
REVIEW_AFTER_STRIKES = 3
FHA_CONSTRAINT = (
    "Answer the real-estate question without breaking fair housing laws or being discriminatory. "
    "Do not describe, rank or recommend homes, neighborhoods or lenders by race, color, religion, "
    "sex, sexual orientation, gender identity, disability, national origin, familial status, age, "
    "marital status, source of income, criminal background or military status, and do not infer "
    "those characteristics about the user. Answer the parts of the question that do not depend on them."
)
FALLBACK_MESSAGE = (
    "I can't help with that part of the request. Fair housing laws prohibit steering home searches "
    "by characteristics such as race, religion, familial status, disability or source of income. "
    "I can help with price, size, commute, schools' ratings, walkability and listing details."
)


class TurnRequest(BaseModel):
    conversation_id: str
    question: str


@dataclass
class Decision:
    allowed: bool
    tier: str
    reasons: list[str] = field(default_factory=list)


class Guard:
    def evaluate(self, text: str, direction: str) -> Decision:
        """Stop list, classifier and judge for the conversation's pinned policy."""
        raise NotImplementedError


class Model:
    def complete(self, question: str, constraint: str | None = None) -> str:
        """The assistant's answer; the constraint is prepended to the system prompt."""
        raise NotImplementedError


class Strikes:
    def record(self, conversation_id: str) -> int:
        """INCR fh:strikes:{conversation_id} with its expiry; returns the new count."""
        raise NotImplementedError


class ReviewQueue:
    def enqueue(self, conversation_id: str, strikes: int) -> None:
        """Hand the conversation to human review."""
        raise NotImplementedError


guard = Guard()
model = Model()
strikes = Strikes()
review = ReviewQueue()


def steer_away(conversation_id: str, outcome: str, decision: Decision) -> dict:
    count = strikes.record(conversation_id)
    escalated = count >= REVIEW_AFTER_STRIKES
    if escalated:
        review.enqueue(conversation_id, count)
    return {
        "conversation_id": conversation_id,
        "answer": FALLBACK_MESSAGE,
        "outcome": outcome,
        "reasons": decision.reasons,
        "escalated": escalated,
    }


@app.post("/v1/turn")
def turn(body: TurnRequest) -> dict:
    inbound = guard.evaluate(body.question, "input")
    if not inbound.allowed:
        return steer_away(body.conversation_id, "blocked_input", inbound)

    answer = model.complete(body.question)
    outbound = guard.evaluate(answer, "output")
    regenerated = False
    for _ in range(MAX_REGENERATIONS):
        if outbound.allowed:
            break
        answer = model.complete(body.question, constraint=FHA_CONSTRAINT)
        outbound = guard.evaluate(answer, "output")
        regenerated = True

    if not outbound.allowed:
        return steer_away(body.conversation_id, "blocked_output", outbound)
    return {
        "conversation_id": body.conversation_id,
        "answer": answer,
        "outcome": "regenerated" if regenerated else "answered",
        "escalated": False,
    }
`,
    },
    typescript: {
      starter: `/** POST /v1/turn: a model-generated draft that returns flagged answers with a warning. */
import Fastify from 'fastify';

import {guard} from './guard';
import {model} from './model';

export const app = Fastify();

const WARNING_NOTE = 'Note: parts of this answer may touch on characteristics protected by fair housing law.';

interface TurnBody {
  conversation_id: string;
  question: string;
}

app.post('/v1/turn', async (request, reply) => {
  // TODO: this draft never guards the question, returns the blocked text with a warning
  // appended, never regenerates, and keeps no strikes. Review all four.
  const body = request.body as TurnBody;
  const answer = await model.complete(body.question);
  const outbound = await guard.evaluate(answer, 'output');
  if (!outbound.allowed) {
    return reply.code(200).send({
      conversation_id: body.conversation_id,
      answer: \`\${answer}\\n\\n\${WARNING_NOTE}\`,
      outcome: 'flagged',
      reasons: outbound.reasons,
    });
  }
  return reply.code(200).send({conversation_id: body.conversation_id, answer, outcome: 'answered'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/turn: input guard, one constrained regeneration, the fallback instead of blocked text. */
import Fastify from 'fastify';

import {guard, type Decision} from './guard';
import {model} from './model';
import {review} from './review';
import {strikes} from './strikes';

export const app = Fastify();

const MAX_REGENERATIONS = 1;
const REVIEW_AFTER_STRIKES = 3;
const FHA_CONSTRAINT =
  'Answer the real-estate question without breaking fair housing laws or being discriminatory. ' +
  'Do not describe, rank or recommend homes, neighborhoods or lenders by race, color, religion, ' +
  'sex, sexual orientation, gender identity, disability, national origin, familial status, age, ' +
  'marital status, source of income, criminal background or military status, and do not infer ' +
  'those characteristics about the user. Answer the parts of the question that do not depend on them.';
const FALLBACK_MESSAGE =
  "I can't help with that part of the request. Fair housing laws prohibit steering home searches " +
  'by characteristics such as race, religion, familial status, disability or source of income. ' +
  "I can help with price, size, commute, schools' ratings, walkability and listing details.";

interface TurnBody {
  conversation_id: string;
  question: string;
}

async function steerAway(conversationId: string, outcome: 'blocked_input' | 'blocked_output', decision: Decision) {
  const count = await strikes.record(conversationId);
  const escalated = count >= REVIEW_AFTER_STRIKES;
  if (escalated) await review.enqueue(conversationId, count);
  return {conversation_id: conversationId, answer: FALLBACK_MESSAGE, outcome, reasons: decision.reasons, escalated};
}

app.post('/v1/turn', async (request, reply) => {
  const body = request.body as TurnBody;

  const inbound = await guard.evaluate(body.question, 'input');
  if (!inbound.allowed) return reply.code(200).send(await steerAway(body.conversation_id, 'blocked_input', inbound));

  let answer = await model.complete(body.question);
  let outbound = await guard.evaluate(answer, 'output');
  let regenerated = false;
  for (let i = 0; i < MAX_REGENERATIONS && !outbound.allowed; i++) {
    answer = await model.complete(body.question, FHA_CONSTRAINT);
    outbound = await guard.evaluate(answer, 'output');
    regenerated = true;
  }

  if (!outbound.allowed) return reply.code(200).send(await steerAway(body.conversation_id, 'blocked_output', outbound));
  return reply.code(200).send({
    conversation_id: body.conversation_id,
    answer,
    outcome: regenerated ? 'regenerated' : 'answered',
    escalated: false,
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

const warningNote = "Note: parts of this answer may touch on characteristics protected by fair housing law."

type TurnRequest struct {
	ConversationID string \`json:"conversation_id"\`
	Question       string \`json:"question"\`
}

type Decision struct {
	Allowed bool
	Tier    string
	Reasons []string
}

type Guard struct{}

func (g *Guard) Evaluate(ctx context.Context, text, direction string) (Decision, error) {
	return Decision{}, nil
}

type Model struct{}

func (m *Model) Complete(ctx context.Context, question, constraint string) (string, error) {
	return "", nil
}

var (
	guard = &Guard{}
	model = &Model{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func turn(rw http.ResponseWriter, r *http.Request) {
	var body TurnRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft never guards the question, returns the blocked text with a warning
	// appended, never regenerates, and keeps no strikes. Review all four.
	answer, err := model.Complete(r.Context(), body.Question, "")
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "model failed"})
		return
	}
	outbound, _ := guard.Evaluate(r.Context(), answer, "output")
	if !outbound.Allowed {
		writeJSON(rw, http.StatusOK, map[string]any{
			"conversation_id": body.ConversationID,
			"answer":          answer + "\\n\\n" + warningNote,
			"outcome":         "flagged",
			"reasons":         outbound.Reasons,
		})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"conversation_id": body.ConversationID, "answer": answer, "outcome": "answered"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/turn", turn)
	http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
)

const (
	maxRegenerations   = 1
	reviewAfterStrikes = 3
	fhaConstraint      = "Answer the real-estate question without breaking fair housing laws or being discriminatory. " +
		"Do not describe, rank or recommend homes, neighborhoods or lenders by race, color, religion, " +
		"sex, sexual orientation, gender identity, disability, national origin, familial status, age, " +
		"marital status, source of income, criminal background or military status, and do not infer " +
		"those characteristics about the user. Answer the parts of the question that do not depend on them."
	fallbackMessage = "I can't help with that part of the request. Fair housing laws prohibit steering home searches " +
		"by characteristics such as race, religion, familial status, disability or source of income. " +
		"I can help with price, size, commute, schools' ratings, walkability and listing details."
)

type TurnRequest struct {
	ConversationID string \`json:"conversation_id"\`
	Question       string \`json:"question"\`
}

type Decision struct {
	Allowed bool
	Tier    string
	Reasons []string
}

type Guard struct{}

func (g *Guard) Evaluate(ctx context.Context, text, direction string) (Decision, error) {
	return Decision{}, nil
}

type Model struct{}

func (m *Model) Complete(ctx context.Context, question, constraint string) (string, error) {
	return "", nil
}

type Strikes struct{}

// Record increments fh:strikes:{conversation} with its expiry and returns the new count.
func (s *Strikes) Record(ctx context.Context, conversationID string) (int64, error) {
	return 0, nil
}

type ReviewQueue struct{}

func (q *ReviewQueue) Enqueue(ctx context.Context, conversationID string, strikes int64) error {
	return nil
}

var (
	guard   = &Guard{}
	model   = &Model{}
	strikes = &Strikes{}
	review  = &ReviewQueue{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func steerAway(ctx context.Context, conversationID, outcome string, decision Decision) map[string]any {
	count, _ := strikes.Record(ctx, conversationID)
	escalated := count >= reviewAfterStrikes
	if escalated {
		_ = review.Enqueue(ctx, conversationID, count)
	}
	return map[string]any{
		"conversation_id": conversationID,
		"answer":          fallbackMessage,
		"outcome":         outcome,
		"reasons":         decision.Reasons,
		"escalated":       escalated,
	}
}

func turn(rw http.ResponseWriter, r *http.Request) {
	var body TurnRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	ctx := r.Context()

	inbound, err := guard.Evaluate(ctx, body.Question, "input")
	if err != nil || !inbound.Allowed {
		writeJSON(rw, http.StatusOK, steerAway(ctx, body.ConversationID, "blocked_input", inbound))
		return
	}

	answer, err := model.Complete(ctx, body.Question, "")
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "model failed"})
		return
	}
	outbound, err := guard.Evaluate(ctx, answer, "output")
	regenerated := false
	for i := 0; i < maxRegenerations && (err != nil || !outbound.Allowed); i++ {
		answer, err = model.Complete(ctx, body.Question, fhaConstraint)
		if err != nil {
			break
		}
		outbound, err = guard.Evaluate(ctx, answer, "output")
		regenerated = true
	}

	if err != nil || !outbound.Allowed {
		writeJSON(rw, http.StatusOK, steerAway(ctx, body.ConversationID, "blocked_output", outbound))
		return
	}
	outcome := "answered"
	if regenerated {
		outcome = "regenerated"
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"conversation_id": body.ConversationID,
		"answer":          answer,
		"outcome":         outcome,
		"escalated":       false,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/turn", turn)
	http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
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

final case class TurnRequest(conversation_id: String, question: String)
final case class Decision(allowed: Boolean, tier: String, reasons: List[String])
final case class TurnResponse(conversation_id: String, answer: String, outcome: String, reasons: List[String])

object SteerAway {
  implicit val system: ActorSystem = ActorSystem("fhguard")
  implicit val requestFormat: RootJsonFormat[TurnRequest] = jsonFormat2(TurnRequest)
  implicit val responseFormat: RootJsonFormat[TurnResponse] = jsonFormat4(TurnResponse)

  val WarningNote = "Note: parts of this answer may touch on characteristics protected by fair housing law."

  val guard = Guard.open()
  val model = Model.open()

  // TODO: this draft never guards the question, returns the blocked text with a warning appended,
  // never regenerates, and keeps no strikes. Review all four.
  val route: Route =
    path("v1" / "turn") {
      post {
        entity(as[TurnRequest]) { body =>
          val answer = model.complete(body.question, None)
          val outbound = guard.evaluate(answer, "output")
          if (!outbound.allowed) {
            complete(StatusCodes.OK, TurnResponse(body.conversation_id, answer + "\\n\\n" + WarningNote, "flagged", outbound.reasons))
          } else {
            complete(StatusCodes.OK, TurnResponse(body.conversation_id, answer, "answered", Nil))
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

final case class TurnRequest(conversation_id: String, question: String)
final case class Decision(allowed: Boolean, tier: String, reasons: List[String])
final case class TurnResponse(
    conversation_id: String,
    answer: String,
    outcome: String,
    reasons: List[String],
    escalated: Boolean
)

object SteerAway {
  implicit val system: ActorSystem = ActorSystem("fhguard")
  implicit val requestFormat: RootJsonFormat[TurnRequest] = jsonFormat2(TurnRequest)
  implicit val responseFormat: RootJsonFormat[TurnResponse] = jsonFormat5(TurnResponse)

  val MaxRegenerations = 1
  val ReviewAfterStrikes = 3
  val FhaConstraint =
    "Answer the real-estate question without breaking fair housing laws or being discriminatory. " +
      "Do not describe, rank or recommend homes, neighborhoods or lenders by race, color, religion, " +
      "sex, sexual orientation, gender identity, disability, national origin, familial status, age, " +
      "marital status, source of income, criminal background or military status, and do not infer " +
      "those characteristics about the user. Answer the parts of the question that do not depend on them."
  val FallbackMessage =
    "I can't help with that part of the request. Fair housing laws prohibit steering home searches " +
      "by characteristics such as race, religion, familial status, disability or source of income. " +
      "I can help with price, size, commute, schools' ratings, walkability and listing details."

  val guard = Guard.open()
  val model = Model.open()
  val strikes = Strikes.open()
  val review = ReviewQueue.open()

  def steerAway(conversationId: String, outcome: String, decision: Decision): TurnResponse = {
    val count = strikes.record(conversationId)
    val escalated = count >= ReviewAfterStrikes
    if (escalated) review.enqueue(conversationId, count)
    TurnResponse(conversationId, FallbackMessage, outcome, decision.reasons, escalated)
  }

  val route: Route =
    path("v1" / "turn") {
      post {
        entity(as[TurnRequest]) { body =>
          val inbound = guard.evaluate(body.question, "input")
          if (!inbound.allowed) {
            complete(StatusCodes.OK, steerAway(body.conversation_id, "blocked_input", inbound))
          } else {
            var answer = model.complete(body.question, None)
            var outbound = guard.evaluate(answer, "output")
            var regenerated = false
            var attempt = 0
            while (attempt < MaxRegenerations && !outbound.allowed) {
              answer = model.complete(body.question, Some(FhaConstraint))
              outbound = guard.evaluate(answer, "output")
              regenerated = true
              attempt += 1
            }
            if (!outbound.allowed) {
              complete(StatusCodes.OK, steerAway(body.conversation_id, "blocked_output", outbound))
            } else {
              val outcome = if (regenerated) "regenerated" else "answered"
              complete(StatusCodes.OK, TurnResponse(body.conversation_id, answer, outcome, Nil, escalated = false))
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

#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kWarningNote = "Note: parts of this answer may touch on characteristics protected by fair housing law.";

struct Decision {
  bool allowed;
  std::string tier;
  std::vector<std::string> reasons;
};

struct Guard {
  Decision evaluate(const std::string& text, const std::string& direction);
};

struct Model {
  std::string complete(const std::string& question, const std::string& constraint = "");
};

Guard guard;
Model model;

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/turn", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto conversationId = body.value("conversation_id", std::string());
    const auto question = body.value("question", std::string());
    // TODO: this draft never guards the question, returns the blocked text with a warning
    // appended, never regenerates, and keeps no strikes. Review all four.
    const std::string answer = model.complete(question);
    const Decision outbound = guard.evaluate(answer, "output");
    res.status = 200;
    if (!outbound.allowed) {
      res.set_content(
          json{{"conversation_id", conversationId},
               {"answer", answer + "\\n\\n" + kWarningNote},
               {"outcome", "flagged"},
               {"reasons", outbound.reasons}}
              .dump(),
          "application/json");
      return;
    }
    res.set_content(
        json{{"conversation_id", conversationId}, {"answer", answer}, {"outcome", "answered"}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kMaxRegenerations = 1;
constexpr long long kReviewAfterStrikes = 3;
const std::string kFhaConstraint =
    "Answer the real-estate question without breaking fair housing laws or being discriminatory. "
    "Do not describe, rank or recommend homes, neighborhoods or lenders by race, color, religion, "
    "sex, sexual orientation, gender identity, disability, national origin, familial status, age, "
    "marital status, source of income, criminal background or military status, and do not infer "
    "those characteristics about the user. Answer the parts of the question that do not depend on them.";
const std::string kFallbackMessage =
    "I can't help with that part of the request. Fair housing laws prohibit steering home searches "
    "by characteristics such as race, religion, familial status, disability or source of income. "
    "I can help with price, size, commute, schools' ratings, walkability and listing details.";

struct Decision {
  bool allowed;
  std::string tier;
  std::vector<std::string> reasons;
};

struct Guard {
  Decision evaluate(const std::string& text, const std::string& direction);
};

struct Model {
  std::string complete(const std::string& question, const std::string& constraint = "");
};

struct Strikes {
  long long record(const std::string& conversationId);
};

struct ReviewQueue {
  void enqueue(const std::string& conversationId, long long strikes);
};

Guard guard;
Model model;
Strikes strikes;
ReviewQueue review;

json steerAway(const std::string& conversationId, const std::string& outcome, const Decision& decision) {
  const long long count = strikes.record(conversationId);
  const bool escalated = count >= kReviewAfterStrikes;
  if (escalated) review.enqueue(conversationId, count);
  return json{{"conversation_id", conversationId},
              {"answer", kFallbackMessage},
              {"outcome", outcome},
              {"reasons", decision.reasons},
              {"escalated", escalated}};
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/turn", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto conversationId = body.value("conversation_id", std::string());
    const auto question = body.value("question", std::string());
    res.status = 200;

    const Decision inbound = guard.evaluate(question, "input");
    if (!inbound.allowed) {
      res.set_content(steerAway(conversationId, "blocked_input", inbound).dump(), "application/json");
      return;
    }

    std::string answer = model.complete(question);
    Decision outbound = guard.evaluate(answer, "output");
    bool regenerated = false;
    for (int i = 0; i < kMaxRegenerations && !outbound.allowed; i++) {
      answer = model.complete(question, kFhaConstraint);
      outbound = guard.evaluate(answer, "output");
      regenerated = true;
    }

    if (!outbound.allowed) {
      res.set_content(steerAway(conversationId, "blocked_output", outbound).dump(), "application/json");
      return;
    }
    res.set_content(
        json{{"conversation_id", conversationId},
             {"answer", answer},
             {"outcome", regenerated ? "regenerated" : "answered"},
             {"escalated", false}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you understand what a guardrail's "block" has to mean at the product edge. The draft's warning footnote is the classic generated compromise — it keeps the answer and adds a disclaimer — and it is precisely the behaviour the law forbids, because the user still received the steered list. Four defects are being checked: the input guard before the model (the post's pre-processing integration: a blocked question costs nothing and never risks a miss on the way out), the fallback as the only thing a blocked turn returns (the post's predefined message), one constrained regeneration before giving up (the post's prompt-instruction layer, applied when it is needed instead of refusing outright), and the strike counter that turns twenty rephrasings into a review ticket. The regeneration recheck is the one candidates skip: a constrained answer is more likely to comply, not guaranteed to. Real systems add a per-conversation cooldown after escalation, a human-readable reason code the assistant can show, and sampled logging of blocked turns (hashes and scores, never text) for the human review loop the post describes.`,
};
