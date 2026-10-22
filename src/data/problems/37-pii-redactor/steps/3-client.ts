import type {Step} from '@/lib/types';

export const detectorClientStep: Step = {
  id: 'dependency',
  title: 'NER model with a deterministic regex fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['redactor', 'detector', 'regex'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the model answers, the demo
redacts, and when the model is down the service still answers — with a warning header. That last
part is the bug: the fallback returns what it was given. Review it, fix it, and prove the fix.

Detection runs over **gRPC**. The model is the primary path; the fallback must be a **deterministic
regex pass over the declared entity types**, never a pass-through.

- Every attempt carries a **600 ms** deadline, so one slow model cannot pin a worker.
- At most **two attempts** per request, and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are
  retryable. The draft retries a timeout four times while the model is down: that is an amplifier,
  not a retry policy — the outage gets four times the load exactly when it can least take it.
- On failure — including a deadline — redact with the regex pass and return the spans marked
  \`degraded: true\` and \`source: "regex"\`. Degraded must mean "redacted by a weaker detector", not
  "returned unchanged".
- The regex pass runs for **every** text size. The draft skips it above 10 KiB \`(10 * 1024)\`, so the
  large documents — the ones most likely to contain a leak — are exactly the ones left unredacted.

**Failure mode the checks target.** A fallback that returns the input is not a fallback, it is the
outage. And an unbounded retry loop under a deadline turns a slow dependency into a self-inflicted
denial of service. Notice the two failure modes are in tension: the fix is a *bounded* retry with a
*deterministic* fallback, so the service degrades in detection quality instead of degrading in safety.`,
  sequence: {
    participants: ['Redactor', 'Detector', 'Regex fallback'],
    messages: [
      {from: 'Redactor', to: 'Detector', label: 'Detect(text, entities) · deadline 600 ms', kind: 'sync'},
      {from: 'Detector', to: 'Redactor', label: 'UNAVAILABLE · DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Redactor', to: 'Detector', label: 'attempt 2 (the last one, after backoff)', kind: 'sync'},
      {from: 'Detector', to: 'Redactor', label: 'still down', kind: 'reply'},
      {from: 'Redactor', to: 'Regex fallback', label: 'scan declared entity types · any size', kind: 'sync'},
      {from: 'Regex fallback', to: 'Redactor', label: 'deterministic spans', kind: 'reply'},
      {from: 'Redactor', to: 'Redactor', label: 'spans marked {degraded: true, source: "regex"}', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Each attempt carries a 600 ms deadline',
      detail:
        'The client sets a **600 ms** deadline per attempt (`timeout`, `deadline`, `withDeadlineAfter`, `set_deadline`). Without it a slow model pins the request until the caller gives up, and the worker is gone for far longer than the model is slow.',
      match: {
        python: {all: [/DEADLINE_MS\s*=\s*600/, /timeout=/, /grpc\./]},
        typescript: {all: [/DEADLINE_MS\s*=\s*600/, /deadline/, /@grpc\/grpc-js/]},
        go: {all: [/deadlineMs\s*=\s*600/, /context\.WithTimeout/, /grpc\./]},
        scala: {all: [/DeadlineMs\s*=\s*600/, /\.withDeadlineAfter\(/, /io\.grpc/]},
        cpp: {all: [/kDeadlineMs\s*=\s*600/, /ClientContext/, /deadline/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Two attempts, retrying only UNAVAILABLE and DEADLINE_EXCEEDED',
      detail:
        'The attempt budget is **2** and the retryable set is exactly `UNAVAILABLE`/`DEADLINE_EXCEEDED`. The draft retries a timeout four times and retries anything, so an outage is amplified 4×.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*2/, /StatusCode\.UNAVAILABLE/, /StatusCode\.DEADLINE_EXCEEDED/, /RETRYABLE/],
        },
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /RETRYABLE/]},
        go: {all: [/maxAttempts\s*=\s*2/, /codes\.Unavailable/, /codes\.DeadlineExceeded/, /retryable/]},
        scala: {all: [/MaxAttempts\s*=\s*2/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /Retryable/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /kRetryable/]},
      },
    },
    {
      id: 'regex-fallback',
      title: 'Falls back to a deterministic regex pass, not a pass-through',
      detail:
        'A named table of compiled patterns over the declared entity types is scanned when the model fails. The draft has no such pass: it returns a warning header and lets the caller ship the raw text.',
      match: {
        python: {all: [/ENTITY_PATTERNS/, /re\.compile/, /fallback_spans/]},
        typescript: {all: [/ENTITY_PATTERNS/, /new RegExp\(/, /fallbackSpans/]},
        go: {all: [/entityPatterns/, /regexp\.MustCompile/, /fallbackSpans/]},
        scala: {all: [/EntityPatterns/, /\.r\b/, /fallbackSpans/]},
        cpp: {all: [/kEntityPatterns/, /std::regex/, /fallback_spans/]},
      },
    },
    {
      id: 'degraded-marker',
      title: 'Marks the degraded result with its source',
      detail:
        'A fallback answer says so: `source: "regex"` and `degraded: true`. The draft emits a warning header while returning the input, so callers cannot distinguish "redacted by regex" from "not redacted at all".',
      match: {
        python: {all: [/FALLBACK_SOURCE\s*=\s*"regex"/, /"source":\s*source/, /"degraded":/]},
        typescript: {all: [/FALLBACK_SOURCE\s*=\s*'regex'/, /degraded:/, /source\b/]},
        go: {all: [/fallbackSource\s*=\s*"regex"/, /"source":\s*source/, /"degraded":/]},
        scala: {all: [/FallbackSource\s*=\s*"regex"/, /"source"\s*->\s*source/, /"degraded"\s*->/]},
        cpp: {all: [/kFallbackSource\s*=\s*"regex"/, /"source",\s*source/, /"degraded",/]},
      },
    },
    {
      id: 'size-independent',
      title: 'The fallback runs for every text size',
      detail:
        'No 10 KiB cut-off: `(10 * 1024)` / `10_240` must not appear as a guard around the regex pass, because large documents are the ones that must not be skipped.',
      match: {
        python: {all: [/fallback_spans\(/], none: [/\b10\s*\*\s*1024\b/, /10_240/]},
        typescript: {all: [/fallbackSpans\(/], none: [/\b10\s*\*\s*1024\b/, /10_240/]},
        go: {all: [/fallbackSpans\(/], none: [/\b10\s*\*\s*1024\b/, /10_240/]},
        scala: {all: [/fallbackSpans\(/], none: [/\b10\s*\*\s*1024\b/, /10_240/]},
        cpp: {all: [/fallback_spans\(/], none: [/\b10\s*\*\s*1024\b/, /10_240/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

logger = logging.getLogger("redactor")
MAX_RETRIES = 4


class Span:
    def __init__(self, start: int, end: int, entity: str, replacement: str) -> None:
        self.start = start
        self.end = end
        self.entity = entity
        self.replacement = replacement


def regex_pass(text: str, entities: list[str]) -> list[Span]:
    """Last-ditch scan, skipped for large documents to stay fast."""
    if len(text) > 10 * 1024:
        return []
    spans = []
    for entity in entities:
        if entity in text:
            start = text.index(entity)
            spans.append(Span(start, start + len(entity), entity, f"[{entity}]"))
    return spans


def detect(tenant: str, text: str, entities: list[str], stub) -> tuple[list[Span], dict[str, str]]:
    # TODO: a timeout falls back to the input with a warning header, the loop retries a timeout
    # four times while the model is down, and the regex pass is skipped for texts over 10 KiB.
    # Redact via regex on any failure, cap the attempts at two, and drop the size gate.
    for _ in range(MAX_RETRIES + 1):
        try:
            reply = stub.Detect(DetectRequest(text=text, entities=entities))
            return [Span(s.start, s.end, s.entity, f"[{s.entity}]") for s in reply.spans], {}
        except Exception:
            logger.warning("detector attempt failed")
            continue
    if len(text) <= 10 * 1024:
        return regex_pass(text, entities), {"x-detector-degraded": "1"}
    return [], {"x-detector-degraded": "1"}
`,
      solution: `import re
import time

import grpc

DEADLINE_MS = 600
MAX_ATTEMPTS = 2
BACKOFF_MS = 50
FALLBACK_SOURCE = "regex"

ENTITY_PATTERNS = {
    "EMAIL": re.compile(r"[\\w.+-]+@[\\w-]+\\.[\\w.-]+"),
    "PHONE": re.compile(r"\\+?\\d[\\d\\s().-]{7,}\\d"),
    "SSN": re.compile(r"\\b\\d{3}-\\d{2}-\\d{4}\\b"),
}

RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}


class Span:
    def __init__(self, start: int, end: int, entity: str, replacement: str) -> None:
        self.start = start
        self.end = end
        self.entity = entity
        self.replacement = replacement


def fallback_spans(text: str, entities: list[str]) -> list[Span]:
    """Deterministic regex pass over the declared entity types; no size gate."""
    spans = []
    for entity in entities:
        pattern = ENTITY_PATTERNS.get(entity)
        if pattern is None:
            continue
        for match in pattern.finditer(text):
            spans.append(Span(match.start(), match.end(), entity, f"[{entity}]"))
    return spans


def detect(tenant: str, text: str, entities: list[str], stub) -> tuple[list[Span], str]:
    """Model first under a 600 ms deadline with at most two attempts, then the regex fallback."""
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = stub.Detect(
                DetectRequest(text=text, entities=entities),
                timeout=DEADLINE_MS / 1000,
            )
            return [Span(s.start, s.end, s.entity, f"[{s.entity}]") for s in reply.spans], "model"
        except grpc.RpcError as error:
            if error.code() not in RETRYABLE:
                break
            if attempt + 1 < MAX_ATTEMPTS:
                time.sleep(BACKOFF_MS / 1000)
    return fallback_spans(text, entities), FALLBACK_SOURCE


def detection_result(tenant: str, text: str, entities: list[str], stub) -> dict:
    spans, source = detect(tenant, text, entities, stub)
    return {
        "spans": spans,
        "source": source,
        "degraded": source == FALLBACK_SOURCE,
    }
`,
    },
    typescript: {
      starter: `/** A model-generated detector client that retries forever and returns the input when down. */
import * as grpc from '@grpc/grpc-js';

const MAX_RETRIES = 4;

interface Span {
  start: number;
  end: number;
  entity: string;
  replacement: string;
}

function regexPass(text: string, entities: string[]): Span[] {
  // last-ditch scan, skipped for large documents to stay fast
  if (text.length > 10 * 1024) return [];
  const spans: Span[] = [];
  for (const entity of entities) {
    const start = text.indexOf(entity);
    if (start >= 0) spans.push({start, end: start + entity.length, entity, replacement: \`[\${entity}]\`});
  }
  return spans;
}

export async function detect(
  tenant: string,
  text: string,
  entities: string[],
  client: DetectorClient,
): Promise<{spans: Span[]; headers: Record<string, string>}> {
  // TODO: a timeout falls back to the input with a warning header, the loop retries a timeout
  // four times while the model is down, and the regex pass is skipped for texts over 10 KiB.
  // Redact via regex on any failure, cap the attempts at two, and drop the size gate.
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const reply = await new Promise<DetectReply>((resolve, reject) =>
        client.detect({text, entities}, (error, reply) => (error ? reject(error) : resolve(reply))),
      );
      return {spans: reply.spans, headers: {}};
    } catch {
      continue;
    }
  }
  if (text.length <= 10 * 1024) return {spans: regexPass(text, entities), headers: {'x-detector-degraded': '1'}};
  return {spans: [], headers: {'x-detector-degraded': '1'}};
}
`,
      solution: `/** Detector client: 600 ms deadline, two attempts, deterministic regex fallback. */
import * as grpc from '@grpc/grpc-js';

const DEADLINE_MS = 600;
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = 50;
const FALLBACK_SOURCE = 'regex';

const ENTITY_PATTERNS: Record<string, RegExp> = {
  EMAIL: new RegExp('[\\\\w.+-]+@[\\\\w-]+\\\\.[\\\\w.-]+', 'g'),
  PHONE: new RegExp('\\\\+?\\\\d[\\\\d\\\\s().-]{7,}\\\\d', 'g'),
  SSN: new RegExp('\\\\b\\\\d{3}-\\\\d{2}-\\\\d{4}\\\\b', 'g'),
};

const RETRYABLE = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

interface Span {
  start: number;
  end: number;
  entity: string;
  replacement: string;
}

function fallbackSpans(text: string, entities: string[]): Span[] {
  // Deterministic regex pass over the declared entity types; no size gate.
  const spans: Span[] = [];
  for (const entity of entities) {
    const pattern = ENTITY_PATTERNS[entity];
    if (pattern === undefined) continue;
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern))
      spans.push({start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, entity, replacement: \`[\${entity}]\`});
  }
  return spans;
}

export async function detect(
  tenant: string,
  text: string,
  entities: string[],
  client: DetectorClient,
): Promise<{spans: Span[]; source: string}> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await new Promise<DetectReply>((resolve, reject) =>
        client.detect({text, entities}, {deadline: Date.now() + DEADLINE_MS}, (error, reply) =>
          error ? reject(error) : resolve(reply),
        ),
      );
      return {spans: reply.spans, source: 'model'};
    } catch (error) {
      const code = (error as grpc.ServiceError).code;
      if (!RETRYABLE.has(code)) break;
      if (attempt + 1 < MAX_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, BACKOFF_MS));
    }
  }
  return {spans: fallbackSpans(text, entities), source: FALLBACK_SOURCE};
}

export async function detectionResult(tenant: string, text: string, entities: string[], client: DetectorClient) {
  const {spans, source} = await detect(tenant, text, entities, client);
  return {spans, source, degraded: source === FALLBACK_SOURCE};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
)

const maxRetries = 4

type Span struct {
	Start       int    \`json:"start"\`
	End         int    \`json:"end"\`
	Entity      string \`json:"entity"\`
	Replacement string \`json:"replacement"\`
}

func regexPass(text string, entities []string) []Span {
	// last-ditch scan, skipped for large documents to stay fast
	if len(text) > 10*1024 {
		return nil
	}
	var spans []Span
	for _, entity := range entities {
		if idx := strings.Index(text, entity); idx >= 0 {
			spans = append(spans, Span{idx, idx + len(entity), entity, "[" + entity + "]"})
		}
	}
	return spans
}

func detect(ctx context.Context, tenant, text string, entities []string, client DetectorClient) ([]Span, map[string]string) {
	// TODO: a timeout falls back to the input with a warning header, the loop retries a timeout
	// four times while the model is down, and the regex pass is skipped for texts over 10 KiB.
	// Redact via regex on any failure, cap the attempts at two, and drop the size gate.
	for attempt := 0; attempt <= maxRetries; attempt++ {
		reply, err := client.Detect(ctx, &DetectRequest{Text: text, Entities: entities})
		if err == nil {
			return reply.Spans, nil
		}
		log.Printf("detector attempt %d failed: %v", attempt, err)
	}
	if len(text) <= 10*1024 {
		return regexPass(text, entities), map[string]string{"x-detector-degraded": "1"}
	}
	return nil, map[string]string{"x-detector-degraded": "1"}
}
`,
      solution: `package main

import (
	"context"
	"regexp"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	deadlineMs     = 600
	maxAttempts    = 2
	backoffMs      = 50
	fallbackSource = "regex"
)

var entityPatterns = map[string]*regexp.Regexp{
	"EMAIL": regexp.MustCompile(\`[\\w.+-]+@[\\w-]+\\.[\\w.-]+\`),
	"PHONE": regexp.MustCompile(\`\\+?\\d[\\d\\s().-]{7,}\\d\`),
	"SSN":   regexp.MustCompile(\`\\b\\d{3}-\\d{2}-\\d{4}\\b\`),
}

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

type Span struct {
	Start       int    \`json:"start"\`
	End         int    \`json:"end"\`
	Entity      string \`json:"entity"\`
	Replacement string \`json:"replacement"\`
}

// fallbackSpans is the deterministic regex pass over the declared entity types; no size gate.
func fallbackSpans(text string, entities []string) []Span {
	var spans []Span
	for _, entity := range entities {
		pattern := entityPatterns[entity]
		if pattern == nil {
			continue
		}
		for _, match := range pattern.FindAllStringIndex(text, -1) {
			spans = append(spans, Span{match[0], match[1], entity, "[" + entity + "]"})
		}
	}
	return spans
}

var _ = grpc.WithTransportCredentials

func detect(ctx context.Context, tenant, text string, entities []string, client DetectorClient) ([]Span, string) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineMs*time.Millisecond)
		reply, err := client.Detect(callCtx, &DetectRequest{Text: text, Entities: entities})
		cancel()
		if err == nil {
			return reply.Spans, "model"
		}
		if !retryable[status.Code(err)] {
			break
		}
		if attempt+1 < maxAttempts {
			time.Sleep(backoffMs * time.Millisecond)
		}
	}
	return fallbackSpans(text, entities), fallbackSource
}

func detectionResult(ctx context.Context, tenant, text string, entities []string, client DetectorClient) map[string]any {
	spans, source := detect(ctx, tenant, text, entities, client)
	return map[string]any{"spans": spans, "source": source, "degraded": source == fallbackSource}
}
`,
    },
    scala: {
      starter: `import scala.util.{Failure, Success, Try}

import io.grpc.StatusRuntimeException

object DetectorClient {
  val MaxRetries = 4

  def regexPass(text: String, entities: List[String]): List[Span] = {
    // last-ditch scan, skipped for large documents to stay fast
    if (text.length > 10 * 1024) return Nil
    entities.flatMap { entity =>
      val idx = text.indexOf(entity)
      if (idx >= 0) Some(Span(idx, idx + entity.length, entity, s"[$entity]")) else None
    }
  }

  // TODO: a timeout falls back to the input with a warning header, the loop retries a timeout
  // four times while the model is down, and the regex pass is skipped for texts over 10 KiB.
  // Redact via regex on any failure, cap the attempts at two, and drop the size gate.
  def detect(tenant: String, text: String, entities: List[String], stub: DetectorStub): (List[Span], Map[String, String]) = {
    var attempt = 0
    while (attempt <= MaxRetries) {
      Try(stub.detect(DetectRequest(text, entities))) match {
        case Success(reply) => return (reply.spans, Map.empty)
        case Failure(_) => attempt += 1
      }
    }
    if (text.length <= 10 * 1024) (regexPass(text, entities), Map("x-detector-degraded" -> "1"))
    else (Nil, Map("x-detector-degraded" -> "1"))
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.util.{Failure, Success, Try}

import io.grpc.{Status, StatusRuntimeException}

object DetectorClient {
  val DeadlineMs = 600
  val MaxAttempts = 2
  val BackoffMs = 50
  val FallbackSource = "regex"

  val EntityPatterns: Map[String, scala.util.matching.Regex] = Map(
    "EMAIL" -> """[\\w.+-]+@[\\w-]+\\.[\\w.-]+""".r,
    "PHONE" -> """\\+?\\d[\\d\\s().-]{7,}\\d""".r,
    "SSN" -> """\\b\\d{3}-\\d{2}-\\d{4}\\b""".r,
  )

  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  // fallbackSpans is the deterministic regex pass over the declared entity types; no size gate.
  def fallbackSpans(text: String, entities: List[String]): List[Span] =
    entities.flatMap { entity =>
      EntityPatterns.get(entity).toList.flatMap(pattern =>
        pattern.findAllMatchIn(text).map(m => Span(m.start, m.end, entity, s"[$entity]")).toList,
      )
    }

  def detect(tenant: String, text: String, entities: List[String], stub: DetectorStub): (List[Span], String) = {
    var attempt = 0
    while (attempt < MaxAttempts) {
      Try(stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).detect(DetectRequest(text, entities))) match {
        case Success(reply) => return (reply.spans, "model")
        case Failure(error: StatusRuntimeException) if !Retryable.contains(error.getStatus.getCode) => return (fallbackSpans(text, entities), FallbackSource)
        case Failure(_) => attempt += 1
      }
      if (attempt < MaxAttempts) Thread.sleep(BackoffMs)
    }
    (fallbackSpans(text, entities), FallbackSource)
  }

  def detectionResult(tenant: String, text: String, entities: List[String], stub: DetectorStub): Map[String, Any] = {
    val (spans, source) = detect(tenant, text, entities, stub)
    Map("spans" -> spans, "source" -> source, "degraded" -> (source == FallbackSource))
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>
#include <vector>

constexpr int kMaxRetries = 4;

struct Span {
  int start = 0;
  int end = 0;
  std::string entity;
  std::string replacement;
};

std::vector<Span> regex_pass(const std::string& text, const std::vector<std::string>& entities) {
  // last-ditch scan, skipped for large documents to stay fast
  if (text.size() > 10 * 1024) return {};
  std::vector<Span> spans;
  for (const auto& entity : entities) {
    const auto idx = text.find(entity);
    if (idx != std::string::npos)
      spans.push_back({static_cast<int>(idx), static_cast<int>(idx + entity.size()), entity, "[" + entity + "]"});
  }
  return spans;
}

// TODO: a timeout falls back to the input with a warning header, the loop retries a timeout
// four times while the model is down, and the regex pass is skipped for texts over 10 KiB.
// Redact via regex on any failure, cap the attempts at two, and drop the size gate.
std::pair<std::vector<Span>, std::string> detect(const std::string& tenant, const std::string& text, const std::vector<std::string>& entities, Detector::Stub& stub) {
  for (int attempt = 0; attempt <= kMaxRetries; ++attempt) {
    grpc::ClientContext context;
    DetectReply reply;
    if (stub.Detect(&context, DetectRequest{}, &reply).ok()) return {reply.spans, {}};
  }
  if (text.size() <= 10 * 1024) return {regex_pass(text, entities), "x-detector-degraded: 1"};
  return {{}, "x-detector-degraded: 1"};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <regex>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

constexpr int kDeadlineMs = 600;
constexpr int kMaxAttempts = 2;
constexpr int kBackoffMs = 50;
const std::string kFallbackSource = "regex";

const std::unordered_map<std::string, std::regex> kEntityPatterns = {
    {"EMAIL", std::regex(R"([\\w.+-]+@[\\w-]+\\.[\\w.-]+)")},
    {"PHONE", std::regex(R"(\\+?\\d[\\d\\s().-]{7,}\\d)")},
    {"SSN", std::regex(R"(\\b\\d{3}-\\d{2}-\\d{4}\\b)")},
};

const std::vector<grpc::StatusCode> kRetryable = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED};

struct Span {
  int start = 0;
  int end = 0;
  std::string entity;
  std::string replacement;
};

// fallback_spans is the deterministic regex pass over the declared entity types; no size gate.
std::vector<Span> fallback_spans(const std::string& text, const std::vector<std::string>& entities) {
  std::vector<Span> spans;
  for (const auto& entity : entities) {
    const auto pattern = kEntityPatterns.find(entity);
    if (pattern == kEntityPatterns.end()) continue;
    for (auto it = std::sregex_iterator(text.begin(), text.end(), pattern->second); it != std::sregex_iterator(); ++it) {
      const auto& match = *it;
      spans.push_back({static_cast<int>(match.position()), static_cast<int>(match.position() + match.length()), entity, "[" + entity + "]"});
    }
  }
  return spans;
}

std::pair<std::vector<Span>, std::string> detect(const std::string& tenant, const std::string& text, const std::vector<std::string>& entities, Detector::Stub& stub) {
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    DetectRequest request;
    request.set_text(text);
    DetectReply reply;
    const grpc::Status status = stub.Detect(&context, request, &reply);
    if (status.ok()) return {std::vector<Span>(reply.spans().begin(), reply.spans().end()), "model"};
    bool retryable = false;
    for (const auto code : kRetryable) retryable = retryable || status.error_code() == code;
    if (!retryable) break;
    if (attempt + 1 < kMaxAttempts) std::this_thread::sleep_for(std::chrono::milliseconds(kBackoffMs));
  }
  return {fallback_spans(text, entities), kFallbackSource};
}

std::string detection_result(const std::string& tenant, const std::string& text, const std::vector<std::string>& entities, Detector::Stub& stub, std::vector<Span>& out_spans) {
  const auto [spans, source] = detect(tenant, text, entities, stub);
  out_spans = spans;
  nlohmann::json out = {
      {"spans", nlohmann::json::array()},
      {"source", source},
      {"degraded", source == kFallbackSource},
  };
  return out.dump();
}
`,
    },
  },
  hints: [
    'Bounded retries under one budget: `for attempt in range(MAX_ATTEMPTS)` with the deadline set per attempt, and `if error.code() not in RETRYABLE: break`. Retrying an unretryable code is a bug; retrying a retryable one more than once while the dependency is down is an outage amplifier.',
    'The fallback table is data: `ENTITY_PATTERNS = {"EMAIL": re.compile(…), "PHONE": …}` and a loop that runs every declared type over the whole text. Deterministic means the same input yields the same spans — a property the model path cannot offer, which is exactly why the response must say `source: "regex"`.',
    'There is no size guard. The draft’s `len(text) > 10 * 1024: return []` skips redaction for the largest documents; if the regex pass is too slow for a 256 KiB text, make the pass cheaper, not the coverage smaller.',
  ],
  debrief: `The interviewer is testing failure policy for a model dependency: a deadline, a bounded retry, and a fallback that is genuinely safer than the primary path’s absence. The draft fails on all three counts — four retries with no deadline amplifies a model outage, and the "fallback" returns the caller's text behind a warning header, which is not a degraded mode but an exfiltration mode. The interesting sentence is the one about size: gating the regex pass at 10 KiB means the redactor’s coverage silently drops on exactly the documents that matter most, and nothing in the response says so. In production you would also cap concurrent model calls, keep the regex table versioned beside the pattern version reported in step 2, and alert on the degraded rate rather than the error rate.`,
};
