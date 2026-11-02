import type {Step} from '@/lib/types';

export const mtClientStep: Step = {
  id: 'dependency',
  title: 'MT calls with a marked fallback, never a silent identity',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'mt', 'detector'],
  task: `## Task

**Starting point.** The starter is the machine-translation client behind \`POST /v1/translations\`:
\`translate_segment\` calls the MT stub inside a loop with no attempt counter and a ten-second
timeout, and on any \`RpcError\` it logs the code and hands back the source text stamped with the
target locale as a success; \`remember\` writes whatever came back into translation memory. It
compiles, the demo always shows text, and it hides five flaws.

**Failure mode the checks target.** The provider has an incident. Every request waits up to ten
seconds, then returns English with \`"target": "fr"\` and a 200; the translation-memory cache stores
it, the CDN caches it, the quality metric counts it, and a user in Paris reads English long after
the provider recovers. A rejected language pair is handled by the same catch-all, so a caller bug is
treated like an outage instead of being surfaced.

Requirements:

- Each attempt carries a **two-second deadline**; a call that has not answered by then is a failure,
  not a hang.
- Attempts are **bounded** (three per segment) and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are
  retried. A rejected language pair (\`INVALID_ARGUMENT\`) is surfaced immediately.
- When the call still fails, return the source text **with the \`untranslated\` marker** and a
  **retriable status** (\`503\`), not a 200 that carries the target locale.
- A marked fallback is **not a translation**: \`isCacheable\` answers \`false\` for it, so the
  translation-memory cache cannot replay a failure as localized content.`,
  sequence: {
    participants: ['Translation API', 'MT service', 'Translation memory'],
    messages: [
      {from: 'Translation API', to: 'Translation memory', label: 'tmLookup(tenant, en, fr, v7, text)', kind: 'sync'},
      {from: 'Translation memory', to: 'Translation API', label: 'miss', kind: 'reply'},
      {from: 'Translation API', to: 'MT service', label: 'Translate · deadline 2s', kind: 'sync'},
      {from: 'MT service', to: 'Translation API', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Translation API', to: 'MT service', label: 'Translate · retry 2 of 3', kind: 'sync'},
      {from: 'MT service', to: 'Translation API', label: 'UNAVAILABLE', kind: 'reply'},
      {
        from: 'Translation API',
        to: 'Translation memory',
        label: 'no write: marked fallback is uncacheable',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Puts a two-second deadline on every MT attempt',
      detail:
        'Every `Translate` call carries a **2 second** deadline. The starter uses a ten-second timeout and then swallows the failure, so one slow provider stalls the whole request path.',
      match: {
        python: {all: [/MT_DEADLINE_SECONDS/, /timeout=/]},
        typescript: {all: [/MT_DEADLINE_MS/, /deadline/]},
        go: {all: [/mtDeadline/, /context\.WithTimeout/]},
        scala: {all: [/MtDeadlineMillis/, /deadlineMillis/]},
        cpp: {all: [/kMtDeadline/]},
      },
    },
    {
      id: 'marked-fallback',
      title: 'Marks the fallback and answers with a retriable status',
      detail:
        'A failed call returns the source text with the `untranslated` marker and a **503**, never a 200 carrying the target locale. The starter returns the input text as a successful translation of the target language.',
      match: {
        python: {all: [/UNTRANSLATED_MARKER/, /status_code\s*=\s*503/]},
        typescript: {all: [/UNTRANSLATED_MARKER/, /statusCode\s*=\s*503/]},
        go: {all: [/untranslatedMarker/, /StatusServiceUnavailable/]},
        scala: {all: [/UntranslatedMarker/, /StatusCodes\.ServiceUnavailable/]},
        cpp: {all: [/kUntranslatedMarker/, /\b503\b/]},
      },
    },
    {
      id: 'retriable-only',
      title: 'Retries only retriable codes and never a language-pair rejection',
      detail:
        'Only `UNAVAILABLE`/`DEADLINE_EXCEEDED` are retried; an `INVALID_ARGUMENT` language-pair rejection is surfaced immediately. The starter retries every `RpcError`.',
      match: {
        python: {all: [/RETRIABLE_CODES/, /UNSUPPORTED_PAIR/]},
        typescript: {all: [/RETRIABLE_CODES/, /UNSUPPORTED_PAIR/]},
        go: {all: [/retriableCodes/, /unsupportedPair/]},
        scala: {all: [/RetriableCodes/, /UnsupportedPair/]},
        cpp: {all: [/kRetriableCodes/, /kUnsupportedPair/]},
      },
    },
    {
      id: 'attempts',
      title: 'Bounds the attempts instead of retrying forever',
      detail:
        'At most three attempts per segment. The starter loops until the call returns, so an outage becomes a hot retry loop against an already-struggling provider.',
      match: {
        python: {all: [/MAX_MT_ATTEMPTS/, /range\(/]},
        typescript: {all: [/MAX_MT_ATTEMPTS/, /for\s*\(/]},
        go: {all: [/maxMtAttempts/, /for attempt/]},
        scala: {all: [/MaxMtAttempts/]},
        cpp: {all: [/kMaxMtAttempts/, /for\s*\(/]},
      },
    },
    {
      id: 'never-cache-marked',
      title: 'A marked fallback is never cacheable',
      detail:
        '`isCacheable` answers `false` for a marked response, so the translation-memory write is skipped. The starter caches whatever it returned, failure or not, and serves it as a translation.',
      match: {
        python: {all: [/is_cacheable/, /UNTRANSLATED_MARKER/]},
        typescript: {all: [/isCacheable/, /UNTRANSLATED_MARKER/]},
        go: {all: [/isCacheable/, /untranslatedMarker/]},
        scala: {all: [/isCacheable/, /UntranslatedMarker/]},
        cpp: {all: [/isCacheable/, /kUntranslatedMarker/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import grpc

import mt_pb2
import mt_pb2_grpc

logger = logging.getLogger("mt")

channel = grpc.insecure_channel("mt:9000")
mt = mt_pb2_grpc.MtStub(channel)


class MtResult:
    def __init__(self, translation: str, target: str) -> None:
        self.translation = translation
        self.target = target


def translate_segment(text: str, source: str, target: str, terms: list[dict]) -> MtResult:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    while True:
        try:
            reply = mt.Translate(
                mt_pb2.TranslateRequest(text=text, source=source, target=target),
                timeout=10,
            )
            return MtResult(reply.translation, target)
        except grpc.RpcError as exc:
            logger.warning("mt rpc failed: %s", exc.code())
            time.sleep(0.1)
            return MtResult(text, target)


def remember(terms: list[dict], result: MtResult, text: str) -> None:
    translations[text + "->" + result.target] = result.translation
`,
      solution: `import logging
import time

import grpc

import mt_pb2
import mt_pb2_grpc
from fastapi import HTTPException

logger = logging.getLogger("mt")

channel = grpc.insecure_channel("mt:9000")
mt = mt_pb2_grpc.MtStub(channel)

MT_DEADLINE_SECONDS = 2.0
MAX_MT_ATTEMPTS = 3
RETRIABLE_CODES = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}
UNSUPPORTED_PAIR = grpc.StatusCode.INVALID_ARGUMENT
UNTRANSLATED_MARKER = "untranslated"


class MtResult:
    def __init__(self, translation: str, target: str, marker: str | None = None) -> None:
        self.translation = translation
        self.target = target
        self.marker = marker


def is_cacheable(result: MtResult) -> bool:
    """A marked fallback is not a translation: it must never enter the TM cache."""
    return result.marker != UNTRANSLATED_MARKER


def translate_segment(text: str, source: str, target: str, terms: list[dict]) -> MtResult:
    request = mt_pb2.TranslateRequest(
        text=text,
        source=source,
        target=target,
        glossary=[mt_pb2.Term(source=t["source"], target=t["target"]) for t in terms],
    )
    last_error: grpc.RpcError | None = None
    for _ in range(MAX_MT_ATTEMPTS):
        try:
            reply = mt.Translate(request, timeout=MT_DEADLINE_SECONDS)
            return MtResult(reply.translation, target)
        except grpc.RpcError as exc:
            if exc.code() == UNSUPPORTED_PAIR:
                raise HTTPException(status_code=400, detail="unsupported language pair") from exc
            if exc.code() not in RETRIABLE_CODES:
                raise
            last_error = exc
            logger.warning("mt rpc retriable failure: %s", exc.code())
            time.sleep(0.1)
    logger.warning("mt unavailable after %d attempts: %s", MAX_MT_ATTEMPTS, last_error)
    raise HTTPException(
        status_code=503,
        detail={
            "error": "mt unavailable",
            "marker": UNTRANSLATED_MARKER,
            "translation": text,
            "target": target,
        },
    )
`,
    },
    typescript: {
      starter: `/** The MT client behind POST /v1/translations. */
import {status as GrpcStatus, type ServiceError} from '@grpc/grpc-js';

import {callTranslate} from './mt';

export interface MtResult {
  translation: string;
  target: string;
}

export async function translateSegment(
  text: string,
  source: string,
  target: string,
  terms: Term[],
): Promise<MtResult> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  for (;;) {
    try {
      const reply = await callTranslate({text, source, target, glossary: terms}, {deadline: new Date(Date.now() + 10_000)});
      return {translation: reply.translation, target};
    } catch (error) {
      const code = (error as ServiceError).code ?? GrpcStatus.UNKNOWN;
      if (code === GrpcStatus.UNKNOWN) throw error;
      return {translation: text, target};
    }
  }
}
`,
      solution: `/** The MT client: a two-second deadline, bounded retries, and a fallback nobody can mistake. */
import {status as GrpcStatus, type ServiceError} from '@grpc/grpc-js';

import {callTranslate} from './mt';

const MT_DEADLINE_MS = 2000;
const MAX_MT_ATTEMPTS = 3;
const RETRIABLE_CODES: readonly number[] = [GrpcStatus.UNAVAILABLE, GrpcStatus.DEADLINE_EXCEEDED];
const UNSUPPORTED_PAIR = GrpcStatus.INVALID_ARGUMENT;
const UNTRANSLATED_MARKER = 'untranslated';

export interface MtResult {
  translation: string;
  target: string;
  marker?: string;
}

export class MtUnavailableError extends Error {
  readonly statusCode = 503;
  readonly marker = UNTRANSLATED_MARKER;
  readonly translation: string;
  readonly target: string;

  constructor(translation: string, target: string, cause: unknown) {
    super('mt unavailable');
    this.translation = translation;
    this.target = target;
    this.cause = cause;
  }
}

export function isCacheable(result: MtResult): boolean {
  return result.marker !== UNTRANSLATED_MARKER;
}

export async function translateSegment(
  text: string,
  source: string,
  target: string,
  terms: Term[],
): Promise<MtResult> {
  const request = {text, source, target, glossary: terms};
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_MT_ATTEMPTS; attempt += 1) {
    try {
      const reply = await callTranslate(request, {deadline: new Date(Date.now() + MT_DEADLINE_MS)});
      return {translation: reply.translation, target};
    } catch (error) {
      const code = (error as ServiceError).code ?? GrpcStatus.UNKNOWN;
      if (code === UNSUPPORTED_PAIR) throw new Error('unsupported language pair');
      if (!RETRIABLE_CODES.includes(code)) throw error;
      lastError = error;
    }
  }
  throw new MtUnavailableError(text, target, lastError);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type MtResult struct {
	Translation string
	Target      string
}

var mtClient MtServiceClient

func translateSegment(ctx context.Context, text, source, target string, terms []Term) (MtResult, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	for {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		reply, err := mtClient.Translate(ctx, &TranslateRequest{Text: text, Source: source, Target: target})
		cancel()
		if err != nil {
			log.Printf("mt failed: %v", status.Code(err))
			time.Sleep(100 * time.Millisecond)
			return MtResult{Translation: text, Target: target}, nil
		}
		return MtResult{Translation: reply.Translation, Target: target}, nil
	}
}

func remember(result MtResult, text string) {
	cache[text+"->"+result.Target] = result.Translation
}
`,
      solution: `package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	mtDeadline         = 2 * time.Second
	maxMtAttempts      = 3
	untranslatedMarker = "untranslated"
)

var retriableCodes = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}
var unsupportedPair = codes.InvalidArgument

type MtResult struct {
	Translation string
	Target      string
	Marker      string
}

type MtUnavailableError struct {
	Marker      string
	Translation string
	Target      string
	StatusCode  int
}

func (e *MtUnavailableError) Error() string { return "mt unavailable" }

func isCacheable(result MtResult) bool {
	return result.Marker != untranslatedMarker
}

var mtClient MtServiceClient

func translateSegment(ctx context.Context, text, source, target string, terms []Term) (MtResult, error) {
	request := &TranslateRequest{Text: text, Source: source, Target: target}
	var lastErr error
	for attempt := 0; attempt < maxMtAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, mtDeadline)
		reply, err := mtClient.Translate(callCtx, request)
		cancel()
		if err == nil {
			return MtResult{Translation: reply.Translation, Target: target}, nil
		}
		code := status.Code(err)
		if code == unsupportedPair {
			return MtResult{}, status.Errorf(codes.InvalidArgument, "unsupported language pair")
		}
		if !retriableCodes[code] {
			return MtResult{}, err
		}
		lastErr = err
		log.Printf("mt retriable failure on attempt %d: %v", attempt+1, code)
	}
	log.Printf("mt unavailable after %d attempts: %v", maxMtAttempts, lastErr)
	return MtResult{}, &MtUnavailableError{
		Marker:      untranslatedMarker,
		Translation: text,
		Target:      target,
		StatusCode:  http.StatusServiceUnavailable,
	}
}
`,
    },
    scala: {
      starter: `import scala.concurrent.Future
import scala.util.{Failure, Success}

import org.apache.pekko.http.scaladsl.model.StatusCodes

object MtClient {
  val deadline = new java.util.Date(System.currentTimeMillis() + 10000)

  def translateSegment(text: String, source: String, target: String, terms: List[Term]): Future[MtResult] =
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    retryForever(text, source, target)

  private def retryForever(text: String, source: String, target: String): Future[MtResult] =
    MtStub.translate(text, source, target, deadline).recoverWith {
      case error: MtException =>
        retryForever(text, source, target)
    }

  def isCacheable(result: MtResult): Boolean = true
}
`,
      solution: `import scala.concurrent.Future
import scala.util.{Failure, Success}

import org.apache.pekko.http.scaladsl.model.StatusCodes

final case class MtResult(translation: String, target: String, marker: Option[String] = None, status: Int = 200)

object MtClient {
  val MtDeadlineMillis = 2000L
  val MaxMtAttempts = 3
  val RetriableCodes = Set("UNAVAILABLE", "DEADLINE_EXCEEDED")
  val UnsupportedPair = "INVALID_ARGUMENT"
  val UntranslatedMarker = "untranslated"

  def isCacheable(result: MtResult): Boolean = result.marker.isEmpty

  def translateSegment(text: String, source: String, target: String, terms: List[Term]): Future[MtResult] = {
    val request = TranslateRequest(text, source, target, terms)
    def attempt(number: Int): Future[MtResult] =
      MtStub.translate(request, deadlineMillis = MtDeadlineMillis).recoverWith {
        case error: MtException if error.code == UnsupportedPair =>
          Future.failed(new MtRejected(error.code))
        case error: MtException if RetriableCodes.contains(error.code) && number < MaxMtAttempts =>
          attempt(number + 1)
        case _: MtException =>
          Future.successful(fallback(text, target))
      }
    attempt(1)
  }

  private def fallback(text: String, target: String): MtResult =
    MtResult(text, target, Some(UntranslatedMarker), StatusCodes.ServiceUnavailable.intValue)
}
`,
    },
    cpp: {
      starter: `#include <chrono>
#include <string>
#include <vector>

struct Term {
  std::string source;
  std::string target;
};

struct MtResult {
  std::string translation;
  std::string target;
};

MtResult translateSegment(const std::string& text, const std::string& source, const std::string& target,
                          const std::vector<Term>& terms) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  for (;;) {
    const auto reply = mtClient.translate(text, source, target, std::chrono::seconds(10));
    if (reply) return MtResult{*reply, target};
    return MtResult{text, target};
  }
}

bool isCacheable(const MtResult& result) { return true; }
`,
      solution: `#include <chrono>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

struct Term {
  std::string source;
  std::string target;
};

struct MtResult {
  std::string translation;
  std::string target;
  std::optional<std::string> marker;
  int status = 200;
};

constexpr auto kMtDeadline = std::chrono::milliseconds(2000);
constexpr int kMaxMtAttempts = 3;
const std::vector<std::string> kRetriableCodes = {"UNAVAILABLE", "DEADLINE_EXCEEDED"};
const std::string kUnsupportedPair = "INVALID_ARGUMENT";
const std::string kUntranslatedMarker = "untranslated";

bool isCacheable(const MtResult& result) { return !result.marker.has_value(); }

MtResult translateSegment(const std::string& text, const std::string& source, const std::string& target,
                          const std::vector<Term>& terms) {
  MtTranslateRequest request{text, source, target, terms};
  for (int attempt = 0; attempt < kMaxMtAttempts; ++attempt) {
    const auto reply = mtClient.translate(request, kMtDeadline);
    if (reply) return MtResult{*reply, target, std::nullopt, 200};
    if (mtClient.lastError() == kUnsupportedPair) return MtResult{std::string(), target, std::nullopt, 400};
    bool retriable = false;
    for (const auto& code : kRetriableCodes) retriable = retriable || code == mtClient.lastError();
    if (!retriable) return MtResult{std::string(), target, std::nullopt, 500};
  }
  std::cerr << "mt unavailable after " << kMaxMtAttempts << " attempts\\n";
  return MtResult{text, target, kUntranslatedMarker, 503};
}
`,
    },
  },
  hints: [
    'During the provider incident the dashboard shows zero errors: p99 sits at ten seconds, every response is a 200, and French users are reading English that translation memory keeps serving after recovery.',
    'The loop has no attempt counter, the timeout is ten seconds, every `RpcError` lands in one catch-all that returns the source text as a success, and `remember` caches whatever came back.',
    'Add `MT_DEADLINE_SECONDS = 2`, `MAX_MT_ATTEMPTS = 3`, retry only `RETRIABLE_CODES`, surface `UNSUPPORTED_PAIR` at once, return the fallback with `UNTRANSLATED_MARKER` and 503, and make `is_cacheable` reject it.',
  ],
  debrief: `The deadline is per attempt and the attempts are bounded because the worst case a user can experience has to be a number you chose, not a function of how sick the provider is. Retries are limited to codes that mean "the provider is struggling" because retrying a rejected language pair spends the budget on a bug the caller has to fix. The fallback carries a marker and a 503 because the failure has to stay visible all the way out, and \`isCacheable\` keeps it out of translation memory so a bad minute does not become a bad month. Production clients add jitter between attempts, a circuit breaker per provider, a per-locale fallback-rate counter, and an alert when the marked-fallback ratio crosses a threshold.`,
};
