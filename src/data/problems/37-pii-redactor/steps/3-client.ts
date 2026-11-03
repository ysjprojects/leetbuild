import type {Step} from '@/lib/types';

export const detectorClientStep: Step = {
  id: 'dependency',
  title: 'The detector client: a deadline, two attempts, a fallback that says so',
  concept: 'grpc',
  file: 'client',
  focus: ['redactor', 'detector', 'regex'],
  task: `## Task

**Starting point.** The starter is the detector client steps 1 and 2 import as \`ner.detect\`:
\`detect(text, entities)\` sends \`Detect\` over gRPC up to four times and, when every attempt fails,
answers \`fallback(text, entities)\`, the regex pass (\`scan\`) over the requested types, skipped
above 10 KiB. With the detector healthy it answers the model's spans; it hides five flaws.

\`\`\`proto
service Detector { rpc Detect(DetectRequest) returns (DetectResponse); }  // spans, model_version
\`\`\`

**Failure mode the checks target.** A slow detector holds every request for as long as it is slow;
a detector that is down takes four attempts per request, and one that rejects the request is
retried anyway; a large document comes back with no spans; a regex answer is labelled as the
model's; and a name no pattern can see goes back unredacted.

- Every attempt carries a **600 ms** deadline (\`DEADLINE_S\`).
- At most \`MAX_ATTEMPTS\` = 2, the second only after \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\`.
- The fallback scans the whole text, whatever its size, and answers \`source: "regex"\`
  (\`FALLBACK_SOURCE\`), \`degraded: true\` and \`PATTERNS_VERSION\`.
- When a requested type has no entry in \`ENTITY_PATTERNS\`, the fallback raises
  \`DetectorUnavailable\`.`,
  sequence: {
    participants: ['Redactor', 'Detector', 'Regex fallback'],
    messages: [
      {from: 'Redactor', to: 'Detector', label: 'Detect(text, entities) · deadline 600 ms', kind: 'sync'},
      {from: 'Detector', to: 'Redactor', label: 'UNAVAILABLE · DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Redactor', to: 'Detector', label: 'attempt 2, the last', kind: 'sync'},
      {from: 'Detector', to: 'Redactor', label: 'still failing', kind: 'reply'},
      {from: 'Redactor', to: 'Regex fallback', label: 'every type covered? scan the whole text', kind: 'sync'},
      {
        from: 'Regex fallback',
        to: 'Redactor',
        label: 'spans · source "regex" · degraded · or DetectorUnavailable',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 600 ms deadline',
      detail:
        'Each `Detect` call is made with a 600 ms deadline (`timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`); the starter sets none, so a detector answering in five seconds holds every request for five seconds.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0?\.6\b/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*600\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/600\s*\*\s*time\.Millisecond/, /context\.WithTimeout\(/]},
        scala: {all: [/DeadlineMs\s*=\s*600L?\b/, /withDeadlineAfter\(\s*DeadlineMs/]},
        cpp: {all: [/milliseconds(?:\s+\w+)?[{(]600[})]/, /set_deadline\(/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Two attempts, and only transient codes are retried',
      detail:
        "At most `MAX_ATTEMPTS` = 2 calls, the second only after `UNAVAILABLE` or `DEADLINE_EXCEEDED`; the starter makes four and retries any code, so an outage quadruples the detector's load and a request it rejected is sent again unchanged.",
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/ATTEMPTS\s*=\s*4\b/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/ATTEMPTS\s*=\s*4\b/]},
        go: {
          all: [/maxAttempts\s*=\s*2\b/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/attempts\s*=\s*4\b/],
        },
        scala: {all: [/MaxAttempts\s*=\s*2\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/Attempts\s*=\s*4\b/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/kAttempts\s*=\s*4\b/]},
      },
    },
    {
      id: 'degraded-marker',
      title: 'A regex answer is marked as one',
      detail:
        'The fallback answers `source: "regex"` (`FALLBACK_SOURCE`), `degraded: true` and the patterns\' version; the starter labels it `model` and not degraded, so a caller cannot tell a weaker redaction from a full one.',
      match: {
        python: {all: [/FALLBACK_SOURCE\s*=\s*["']regex["']/, /FALLBACK_SOURCE,\s*True/]},
        typescript: {all: [/FALLBACK_SOURCE\s*=\s*'regex'/, /source:\s*FALLBACK_SOURCE,\s*degraded:\s*true/]},
        go: {all: [/fallbackSource\s*=\s*"regex"/, /Source:\s*fallbackSource,\s*Degraded:\s*true/]},
        scala: {all: [/FallbackSource\s*=\s*"regex"/, /FallbackSource,\s*degraded\s*=\s*true/]},
        cpp: {all: [/kFallbackSource\s*=\s*"regex"/, /kFallbackSource,\s*true/]},
      },
    },
    {
      id: 'size-independent',
      title: 'The fallback scans texts of every size',
      detail:
        'The regex pass runs over the whole text whatever its length; the starter skips texts over 10 KiB and answers no spans, and the largest documents are the likeliest to carry what must be removed.',
      match: {
        python: {all: [/scan\(text/], none: [/10\s*\*\s*1024|10_?240/]},
        typescript: {all: [/scan\(text/], none: [/10\s*\*\s*1024|10_?240/]},
        go: {all: [/spans\.Scan\(text/], none: [/10\s*\*\s*1024|10_?240/]},
        scala: {all: [/scan\(text/], none: [/10\s*\*\s*1024|10_?240/]},
        cpp: {all: [/spans::scan\(text/], none: [/10\s*\*\s*1024|10'?240/]},
      },
    },
    {
      id: 'uncovered-fails-closed',
      title: 'A type no pattern covers fails closed',
      detail:
        'When a requested type has no entry in `ENTITY_PATTERNS`, the fallback raises `DetectorUnavailable` instead of answering; the starter scans the types it can and drops the rest, so with the detector down a `PERSON` request answers with the name in place.',
      match: {
        python: {all: [/not in ENTITY_PATTERNS/, /raise DetectorUnavailable/]},
        typescript: {
          all: [
            /ENTITY_PATTERNS\[\w+\]\s*===\s*undefined|!\(\w+ in ENTITY_PATTERNS\)/,
            /throw new DetectorUnavailable/,
          ],
        },
        go: {all: [/spans\.EntityPatterns\[\w+\]/, /spans\.ErrDetectorUnavailable/]},
        scala: {all: [/EntityPatterns\.contains/, /throw new DetectorUnavailable/]},
        cpp: {all: [/kEntityPatterns\.(?:count|find|contains)\(/, /throw spans::DetectorUnavailable/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import detector_pb2
import detector_pb2_grpc
from redactor.spans import ENTITY_PATTERNS, PATTERNS_VERSION, Detection, DetectorUnavailable, scan, span

ATTEMPTS = 4

detector = detector_pb2_grpc.DetectorStub(grpc.insecure_channel("detector:9000"))


def fallback(text: str, entities) -> Detection:
    """The regex pass over the requested types."""
    if len(text) > 10 * 1024:
        return Detection([], "model", False, PATTERNS_VERSION)  # too slow to scan inline
    return Detection(scan(text, entities), "model", False, PATTERNS_VERSION)


def detect(text: str, entities) -> Detection:
    """The entity spans of text for the requested types."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    for _ in range(ATTEMPTS):
        try:
            reply = detector.Detect(detector_pb2.DetectRequest(text=text, entities=list(entities)))
        except grpc.RpcError:
            continue
        return Detection([span(s.start, s.end, s.entity) for s in reply.spans], "model", False, reply.model_version)
    return fallback(text, entities)
`,
      solution: `import grpc

import detector_pb2
import detector_pb2_grpc
from redactor.spans import ENTITY_PATTERNS, PATTERNS_VERSION, Detection, DetectorUnavailable, scan, span

DEADLINE_S = 0.6
MAX_ATTEMPTS = 2
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
FALLBACK_SOURCE = "regex"

detector = detector_pb2_grpc.DetectorStub(grpc.insecure_channel("detector:9000"))


def fallback(text: str, entities) -> Detection:
    """The regex pass over the requested types, marked degraded; DetectorUnavailable when a type has no pattern."""
    uncovered = [e for e in entities if e not in ENTITY_PATTERNS]
    if uncovered:
        # A partial answer would hand back the very spans no pattern can see: fail closed instead.
        raise DetectorUnavailable(f"the detector is down and no pattern covers {', '.join(uncovered)}")
    return Detection(scan(text, entities), FALLBACK_SOURCE, True, PATTERNS_VERSION)


def detect(text: str, entities) -> Detection:
    """The entity spans of text for the requested types."""
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = detector.Detect(detector_pb2.DetectRequest(text=text, entities=list(entities)), timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                break  # the request itself was refused: another attempt fails the same way
            continue
        return Detection([span(s.start, s.end, s.entity) for s in reply.spans], "model", False, reply.model_version)
    return fallback(text, entities)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Detection, DetectorUnavailable, ENTITY_PATTERNS, PATTERNS_VERSION, scan, span} from 'redactor/spans';

export const ATTEMPTS = 4;

interface DetectReply {
  spans?: {start: number; end: number; entity: string}[];
  model_version?: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('detector.proto')) as unknown as {
  redactor: {Detector: grpc.ServiceClientConstructor};
};
const detector = new pkg.redactor.Detector('detector:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Detect(request: {text: string; entities: string[]}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<DetectReply>;
};

/** The regex pass over the requested types. */
export function fallback(text: string, entities: readonly string[]): Detection {
  if (text.length > 10 * 1024) return {spans: [], source: 'model', degraded: false, detector_version: PATTERNS_VERSION}; // too slow to scan inline
  return {spans: scan(text, entities), source: 'model', degraded: false, detector_version: PATTERNS_VERSION};
}

/** The entity spans of text for the requested types. */
export async function detect(text: string, entities: readonly string[]): Promise<Detection> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      const reply = await detector.Detect({text, entities: [...entities]}, new grpc.Metadata(), {});
      return {spans: (reply.spans ?? []).map(s => span(s.start, s.end, s.entity)), source: 'model', degraded: false, detector_version: reply.model_version ?? ''};
    } catch {
      continue;
    }
  }
  return fallback(text, entities);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Detection, DetectorUnavailable, ENTITY_PATTERNS, PATTERNS_VERSION, scan, span} from 'redactor/spans';

export const DEADLINE_MS = 600;
export const MAX_ATTEMPTS = 2;
export const RETRYABLE: ReadonlySet<number> = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);
export const FALLBACK_SOURCE = 'regex';

interface DetectReply {
  spans?: {start: number; end: number; entity: string}[];
  model_version?: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('detector.proto')) as unknown as {
  redactor: {Detector: grpc.ServiceClientConstructor};
};
const detector = new pkg.redactor.Detector('detector:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Detect(request: {text: string; entities: string[]}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<DetectReply>;
};

/** The regex pass over the requested types, marked degraded; DetectorUnavailable when a type has no pattern. */
export function fallback(text: string, entities: readonly string[]): Detection {
  const uncovered = entities.filter(e => ENTITY_PATTERNS[e] === undefined);
  // A partial answer would hand back the very spans no pattern can see: fail closed instead.
  if (uncovered.length > 0) throw new DetectorUnavailable(\`the detector is down and no pattern covers \${uncovered.join(', ')}\`);
  return {spans: scan(text, entities), source: FALLBACK_SOURCE, degraded: true, detector_version: PATTERNS_VERSION};
}

/** The entity spans of text for the requested types. */
export async function detect(text: string, entities: readonly string[]): Promise<Detection> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await detector.Detect({text, entities: [...entities]}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return {spans: (reply.spans ?? []).map(s => span(s.start, s.end, s.entity)), source: 'model', degraded: false, detector_version: reply.model_version ?? ''};
    } catch (e) {
      if (!RETRYABLE.has((e as grpc.ServiceError).code)) break; // the request itself was refused: another attempt fails the same way
    }
  }
  return fallback(text, entities);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "redactor/gen/detector"
	"redactor/spans" // spans.Detection, Scan, NewSpan, EntityPatterns, PatternsVersion, ErrDetectorUnavailable
)

const attempts = 4

var (
	detectorConn, _ = grpc.NewClient("detector:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	detector        = pb.NewDetectorClient(detectorConn)
)

// fallback is the regex pass over the requested types.
func fallback(text string, entities []string) (spans.Detection, error) {
	if len(text) > 10*1024 {
		return spans.Detection{Spans: []spans.Span{}, Source: "model", DetectorVersion: spans.PatternsVersion}, nil // too slow to scan inline
	}
	return spans.Detection{Spans: spans.Scan(text, entities), Source: "model", DetectorVersion: spans.PatternsVersion}, nil
}

// detect is the entity spans of text for the requested types.
func detect(ctx context.Context, text string, entities []string) (spans.Detection, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	for attempt := 0; attempt < attempts; attempt++ {
		reply, err := detector.Detect(ctx, &pb.DetectRequest{Text: text, Entities: entities})
		if err != nil {
			continue
		}
		found := make([]spans.Span, 0, len(reply.GetSpans()))
		for _, s := range reply.GetSpans() {
			found = append(found, spans.NewSpan(int(s.GetStart()), int(s.GetEnd()), s.GetEntity()))
		}
		return spans.Detection{Spans: found, Source: "model", DetectorVersion: reply.GetModelVersion()}, nil
	}
	return fallback(text, entities)
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "redactor/gen/detector"
	"redactor/spans" // spans.Detection, Scan, NewSpan, EntityPatterns, PatternsVersion, ErrDetectorUnavailable
)

const (
	deadline       = 600 * time.Millisecond
	maxAttempts    = 2
	fallbackSource = "regex"
)

var (
	detectorConn, _ = grpc.NewClient("detector:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	detector        = pb.NewDetectorClient(detectorConn)
)

func retryable(err error) bool {
	code := status.Code(err)
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

// fallback is the regex pass over the requested types, marked degraded; ErrDetectorUnavailable when a type has no pattern.
func fallback(text string, entities []string) (spans.Detection, error) {
	var uncovered []string
	for _, entity := range entities {
		if _, ok := spans.EntityPatterns[entity]; !ok {
			uncovered = append(uncovered, entity)
		}
	}
	if len(uncovered) > 0 {
		// A partial answer would hand back the very spans no pattern can see: fail closed instead.
		return spans.Detection{}, fmt.Errorf("%w: the detector is down and no pattern covers %s", spans.ErrDetectorUnavailable, strings.Join(uncovered, ", "))
	}
	return spans.Detection{Spans: spans.Scan(text, entities), Source: fallbackSource, Degraded: true, DetectorVersion: spans.PatternsVersion}, nil
}

// detect is the entity spans of text for the requested types.
func detect(ctx context.Context, text string, entities []string) (spans.Detection, error) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := detector.Detect(callCtx, &pb.DetectRequest{Text: text, Entities: entities})
		cancel()
		if err != nil {
			if !retryable(err) {
				break // the request itself was refused: another attempt fails the same way
			}
			continue
		}
		found := make([]spans.Span, 0, len(reply.GetSpans()))
		for _, s := range reply.GetSpans() {
			found = append(found, spans.NewSpan(int(s.GetStart()), int(s.GetEnd()), s.GetEntity()))
		}
		return spans.Detection{Spans: found, Source: "model", DetectorVersion: reply.GetModelVersion()}, nil
	}
	return fallback(text, entities)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import redactor.Spans.{Detection, PatternsVersion, scan, span}
import redactor.detector.{DetectRequest, DetectorGrpc}

object DetectorClient {
  val Attempts = 4

  private val detector = DetectorGrpc.blockingStub(ManagedChannelBuilder.forAddress("detector", 9000).usePlaintext().build())

  /** The regex pass over the requested types. */
  def fallback(text: String, entities: Seq[String]): Detection =
    if (text.length > 10 * 1024) Detection(Seq.empty, "model", degraded = false, PatternsVersion) // too slow to scan inline
    else Detection(scan(text, entities), "model", degraded = false, PatternsVersion)

  /** The entity spans of text for the requested types. */
  def detect(text: String, entities: Seq[String]): Detection = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    var attempt = 0
    while (attempt < Attempts) {
      attempt += 1
      try {
        val reply = detector.detect(DetectRequest(text = text, entities = entities))
        return Detection(reply.spans.map(s => span(s.start, s.end, s.entity)), "model", degraded = false, reply.modelVersion)
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    fallback(text, entities)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import redactor.DetectorUnavailable
import redactor.Spans.{Detection, EntityPatterns, PatternsVersion, scan, span}
import redactor.detector.{DetectRequest, DetectorGrpc}

object DetectorClient {
  val DeadlineMs = 600L
  val MaxAttempts = 2
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  val FallbackSource = "regex"

  private val detector = DetectorGrpc.blockingStub(ManagedChannelBuilder.forAddress("detector", 9000).usePlaintext().build())

  /** The regex pass over the requested types, marked degraded; DetectorUnavailable when a type has no pattern. */
  def fallback(text: String, entities: Seq[String]): Detection = {
    val uncovered = entities.filterNot(EntityPatterns.contains)
    // A partial answer would hand back the very spans no pattern can see: fail closed instead.
    if (uncovered.nonEmpty) throw new DetectorUnavailable(s"the detector is down and no pattern covers \${uncovered.mkString(", ")}")
    Detection(scan(text, entities), FallbackSource, degraded = true, PatternsVersion)
  }

  /** The entity spans of text for the requested types. */
  def detect(text: String, entities: Seq[String]): Detection = {
    var attempt = 0
    var retry = true
    while (attempt < MaxAttempts && retry) {
      attempt += 1
      try {
        val reply = detector.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).detect(DetectRequest(text = text, entities = entities))
        return Detection(reply.spans.map(s => span(s.start, s.end, s.entity)), "model", degraded = false, reply.modelVersion)
      } catch {
        // the request itself was refused: another attempt fails the same way
        case e: StatusRuntimeException => retry = Retryable.contains(e.getStatus.getCode)
      }
    }
    fallback(text, entities)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <memory>
#include <string>
#include <vector>

#include "detector.grpc.pb.h"
#include "redactor/spans.h"  // spans::Detection, scan, span, kEntityPatterns, kPatternsVersion, DetectorUnavailable

constexpr int kAttempts = 4;

auto detector = redactor::Detector::NewStub(grpc::CreateChannel("detector:9000", grpc::InsecureChannelCredentials()));

// The regex pass over the requested types.
spans::Detection fallback(const std::string& text, const std::vector<std::string>& entities) {
  if (text.size() > 10 * 1024) return spans::Detection{{}, "model", false, spans::kPatternsVersion};  // too slow to scan inline
  return spans::Detection{spans::scan(text, entities), "model", false, spans::kPatternsVersion};
}

// The entity spans of text for the requested types.
spans::Detection detect(const std::string& text, const std::vector<std::string>& entities) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  redactor::DetectRequest request;
  request.set_text(text);
  for (const std::string& entity : entities) request.add_entities(entity);
  for (int attempt = 0; attempt < kAttempts; attempt++) {
    grpc::ClientContext ctx;
    redactor::DetectResponse reply;
    if (!detector->Detect(&ctx, request, &reply).ok()) continue;
    spans::Detection detection{{}, "model", false, reply.model_version()};
    for (const auto& s : reply.spans()) detection.spans.push_back(spans::span(s.start(), s.end(), s.entity()));
    return detection;
  }
  return fallback(text, entities);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <memory>
#include <string>
#include <vector>

#include "detector.grpc.pb.h"
#include "redactor/spans.h"  // spans::Detection, scan, span, kEntityPatterns, kPatternsVersion, DetectorUnavailable

constexpr std::chrono::milliseconds kDeadline{600};
constexpr int kMaxAttempts = 2;
const std::string kFallbackSource = "regex";

auto detector = redactor::Detector::NewStub(grpc::CreateChannel("detector:9000", grpc::InsecureChannelCredentials()));

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

// The regex pass over the requested types, marked degraded; throws DetectorUnavailable when a type has no pattern.
spans::Detection fallback(const std::string& text, const std::vector<std::string>& entities) {
  std::string uncovered;
  for (const std::string& entity : entities) {
    if (spans::kEntityPatterns.count(entity) == 0) uncovered += (uncovered.empty() ? "" : ", ") + entity;
  }
  // A partial answer would hand back the very spans no pattern can see: fail closed instead.
  if (!uncovered.empty()) throw spans::DetectorUnavailable("the detector is down and no pattern covers " + uncovered);
  return spans::Detection{spans::scan(text, entities), kFallbackSource, true, spans::kPatternsVersion};
}

// The entity spans of text for the requested types.
spans::Detection detect(const std::string& text, const std::vector<std::string>& entities) {
  redactor::DetectRequest request;
  request.set_text(text);
  for (const std::string& entity : entities) request.add_entities(entity);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    redactor::DetectResponse reply;
    const grpc::Status status = detector->Detect(&ctx, request, &reply);
    if (!status.ok()) {
      if (!retryable(status.error_code())) break;  // the request itself was refused: another attempt fails the same way
      continue;
    }
    spans::Detection detection{{}, "model", false, reply.model_version()};
    for (const auto& s : reply.spans()) detection.spans.push_back(spans::span(s.start(), s.end(), s.entity()));
    return detection;
  }
  return fallback(text, entities);
}
`,
    },
  },
  harness: {
    python: `import grpc

import detector_pb2
import detector_pb2_grpc
from redactor.spans import PATTERNS_VERSION, scan

TEXT = "Mail ada@example.com, SSN 123-45-6789."
NAME = "Ada Lovelace"


class Detector(detector_pb2_grpc.DetectorServicer):
    """The NER model's stand-in: pattern types by their patterns, PERSON for one known name; failing with \`code\` when set."""

    def __init__(self):
        self.code = None

    def Detect(self, request, context):
        if self.code is not None:
            context.abort(self.code, "the detector is failing")
        found = [detector_pb2.EntitySpan(start=s.start, end=s.end, entity=s.entity) for s in scan(request.text, request.entities)]
        at = request.text.find(NAME)
        if "PERSON" in request.entities and at >= 0:
            found.append(detector_pb2.EntitySpan(start=at, end=at + len(NAME), entity="PERSON"))
        found.sort(key=lambda s: s.start)
        return detector_pb2.DetectResponse(spans=found, model_version="ner-2026.10")


def _client(ctx):
    peer = Detector()
    ctx.grpc.serve(detector_pb2_grpc.add_DetectorServicer_to_server, peer)
    return ctx.load("client"), peer


def _found(detection, text):
    return [(text[s.start:s.end], s.entity) for s in detection.spans]


def check_deadline(ctx):
    m, _ = _client(ctx)
    m.detect(TEXT, ["EMAIL"])
    ctx.grpc.set_latency("Detect", 5.0)
    detection = m.detect(TEXT, ["EMAIL"])
    calls = ctx.grpc.calls_to("Detect")
    assert calls, "detect made no Detect call"
    for call in calls:
        assert call.timeout is not None, "a Detect call carries no deadline: a detector answering in 5 s holds the request for 5 s"
        assert 0.5 <= call.timeout <= 0.7, f"a Detect call carries a {call.timeout} s deadline, expected 0.6 s"
    assert _found(detection, TEXT) == [("ada@example.com", "EMAIL")], f"after the deadlines the fallback must still redact the email, got {_found(detection, TEXT)}"


def check_bounded_retry(ctx):
    m, peer = _client(ctx)
    peer.code = grpc.StatusCode.UNAVAILABLE
    m.detect(TEXT, ["EMAIL"])
    n = len(ctx.grpc.calls_to("Detect"))
    assert n == 2, f"with the detector UNAVAILABLE detect made {n} attempts, expected MAX_ATTEMPTS = 2: every extra attempt is load on a detector that is already down"
    peer.code = grpc.StatusCode.INVALID_ARGUMENT
    m.detect(TEXT, ["EMAIL"])
    n = len(ctx.grpc.calls_to("Detect")) - 2
    assert n == 1, f"an INVALID_ARGUMENT was retried ({n} attempts): the request itself was refused, and a second attempt fails the same way"


def check_degraded_marker(ctx):
    m, peer = _client(ctx)
    peer.code = grpc.StatusCode.UNAVAILABLE
    detection = m.detect(TEXT, ["EMAIL", "SSN"])
    assert _found(detection, TEXT) == [("ada@example.com", "EMAIL"), ("123-45-6789", "SSN")], f"the fallback must redact the email and the SSN, got {_found(detection, TEXT)}"
    assert detection.source == "regex" and detection.degraded is True, f"a regex answer must say so (source regex, degraded), got source={detection.source!r} degraded={detection.degraded!r}"
    assert detection.detector_version == PATTERNS_VERSION, f"a regex answer reports the patterns' version {PATTERNS_VERSION}, got {detection.detector_version!r}"
    peer.code = None
    detection = m.detect(TEXT, ["EMAIL", "SSN"])
    assert detection.source == "model" and detection.degraded is False and detection.detector_version == "ner-2026.10", f"the model's answer is source model, not degraded, version ner-2026.10; got {detection}"


def check_size_independent(ctx):
    m, peer = _client(ctx)
    peer.code = grpc.StatusCode.UNAVAILABLE
    text = "lorem ipsum dolor sit amet " * 800 + "Write to ada@example.com."
    detection = m.detect(text, ["EMAIL"])
    assert _found(detection, text) == [("ada@example.com", "EMAIL")], f"a {len(text)}-character text came back with spans {_found(detection, text)}: the fallback must scan texts of every size"


def check_uncovered_fails_closed(ctx):
    m, peer = _client(ctx)
    peer.code = grpc.StatusCode.UNAVAILABLE
    text = f"{NAME}, ada@example.com"
    try:
        detection = m.detect(text, ["EMAIL", "PERSON"])
    except m.DetectorUnavailable:
        pass
    else:
        raise AssertionError(f"with the detector down, a PERSON request answered {_found(detection, text)}: no pattern covers PERSON, so the name went back in place. Raise DetectorUnavailable")
    peer.code = None
    detection = m.detect(text, ["EMAIL", "PERSON"])
    assert sorted(_found(detection, text)) == [("Ada Lovelace", "PERSON"), ("ada@example.com", "EMAIL")], f"with the detector up the model answers both types, got {_found(detection, text)}"
`,
    typescript: `const TEXT = 'Mail ada@example.com, SSN 123-45-6789.';
const NAME = 'Ada Lovelace';

/** The NER model's stand-in: pattern types by their patterns, PERSON for one known name; failing with \`peer.code\` when set. */
function client(ctx) {
  const {scan, PATTERNS_VERSION} = ctx.load('/support/redactor/spans.ts');
  const pkg = ctx.proto('detector.proto');
  const peer: {code: number | null} = {code: null};
  ctx.grpc.serve(pkg.redactor.Detector.service, {
    Detect(call, callback) {
      if (peer.code !== null) return callback({code: peer.code, details: 'the detector is failing'});
      const {text, entities = []} = call.request;
      const found = scan(text, entities).map(s => ({start: s.start, end: s.end, entity: s.entity}));
      const at = text.indexOf(NAME);
      if (entities.includes('PERSON') && at >= 0) found.push({start: at, end: at + NAME.length, entity: 'PERSON'});
      found.sort((a, b) => a.start - b.start);
      callback(null, {spans: found, model_version: 'ner-2026.10'});
    },
  });
  return {m: ctx.load('client'), peer, PATTERNS_VERSION};
}

const found = (detection, text: string) => detection.spans.map(s => [text.slice(s.start, s.end), s.entity]);

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  await m.detect(TEXT, ['EMAIL']);
  ctx.grpc.setLatency('Detect', 5.0);
  const detection = await m.detect(TEXT, ['EMAIL']);
  const calls = ctx.grpc.callsTo('Detect');
  assert(calls.length > 0, 'detect made no Detect call');
  for (const call of calls) {
    assert(call.timeout !== null, 'a Detect call carries no deadline: a detector answering in 5 s holds the request for 5 s');
    assert(call.timeout >= 0.5 && call.timeout <= 0.7, \`a Detect call carries a \${call.timeout} s deadline, expected 0.6 s\`);
  }
  assert.deepStrictEqual(found(detection, TEXT), [['ada@example.com', 'EMAIL']], \`after the deadlines the fallback must still redact the email, got \${JSON.stringify(found(detection, TEXT))}\`);
}

export async function check_bounded_retry(ctx) {
  const {m, peer} = client(ctx);
  peer.code = ctx.grpc.status.UNAVAILABLE;
  await m.detect(TEXT, ['EMAIL']);
  let n = ctx.grpc.callsTo('Detect').length;
  assert.equal(n, 2, \`with the detector UNAVAILABLE detect made \${n} attempts, expected MAX_ATTEMPTS = 2: every extra attempt is load on a detector that is already down\`);
  peer.code = ctx.grpc.status.INVALID_ARGUMENT;
  await m.detect(TEXT, ['EMAIL']);
  n = ctx.grpc.callsTo('Detect').length - 2;
  assert.equal(n, 1, \`an INVALID_ARGUMENT was retried (\${n} attempts): the request itself was refused, and a second attempt fails the same way\`);
}

export async function check_degraded_marker(ctx) {
  const {m, peer, PATTERNS_VERSION} = client(ctx);
  peer.code = ctx.grpc.status.UNAVAILABLE;
  let detection = await m.detect(TEXT, ['EMAIL', 'SSN']);
  assert.deepStrictEqual(found(detection, TEXT), [['ada@example.com', 'EMAIL'], ['123-45-6789', 'SSN']], \`the fallback must redact the email and the SSN, got \${JSON.stringify(found(detection, TEXT))}\`);
  assert(detection.source === 'regex' && detection.degraded === true, \`a regex answer must say so (source regex, degraded), got source=\${detection.source} degraded=\${detection.degraded}\`);
  assert.equal(detection.detector_version, PATTERNS_VERSION, \`a regex answer reports the patterns' version \${PATTERNS_VERSION}\`);
  peer.code = null;
  detection = await m.detect(TEXT, ['EMAIL', 'SSN']);
  assert(detection.source === 'model' && detection.degraded === false && detection.detector_version === 'ner-2026.10', \`the model's answer is source model, not degraded, version ner-2026.10; got \${JSON.stringify(detection)}\`);
}

export async function check_size_independent(ctx) {
  const {m, peer} = client(ctx);
  peer.code = ctx.grpc.status.UNAVAILABLE;
  const text = 'lorem ipsum dolor sit amet '.repeat(800) + 'Write to ada@example.com.';
  const detection = await m.detect(text, ['EMAIL']);
  assert.deepStrictEqual(found(detection, text), [['ada@example.com', 'EMAIL']], \`a \${text.length}-character text came back with spans \${JSON.stringify(found(detection, text))}: the fallback must scan texts of every size\`);
}

export async function check_uncovered_fails_closed(ctx) {
  const {m, peer} = client(ctx);
  peer.code = ctx.grpc.status.UNAVAILABLE;
  const text = \`\${NAME}, ada@example.com\`;
  let answered = null;
  try {
    answered = await m.detect(text, ['EMAIL', 'PERSON']);
  } catch (e) {
    assert.equal((e as Error).constructor.name, 'DetectorUnavailable', \`detect threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected DetectorUnavailable\`);
  }
  assert(answered === null, \`with the detector down, a PERSON request answered \${JSON.stringify(answered && found(answered, text))}: no pattern covers PERSON, so the name went back in place. Throw DetectorUnavailable\`);
  peer.code = null;
  const detection = await m.detect(text, ['EMAIL', 'PERSON']);
  assert.deepStrictEqual(found(detection, text).sort(), [['Ada Lovelace', 'PERSON'], ['ada@example.com', 'EMAIL']], \`with the detector up the model answers both types, got \${JSON.stringify(found(detection, text))}\`);
}
`,
    go: `package main

import (
	"context"
	"errors"
	"slices"
	"sort"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "redactor/gen/detector"
	"redactor/spans"

	"leetbuild/harness"
)

const (
	clientText = "Mail ada@example.com, SSN 123-45-6789."
	clientName = "Ada Lovelace"
)

// clientPeer is the NER model's stand-in: pattern types by their patterns, PERSON for one known
// name; failing with code when it is not OK.
type clientPeer struct {
	pb.UnimplementedDetectorServer
	code codes.Code
}

func (p *clientPeer) Detect(_ context.Context, req *pb.DetectRequest) (*pb.DetectResponse, error) {
	if p.code != codes.OK {
		return nil, status.Error(p.code, "the detector is failing")
	}
	var found []*pb.EntitySpan
	for _, s := range spans.Scan(req.GetText(), req.GetEntities()) {
		found = append(found, &pb.EntitySpan{Start: int32(s.Start), End: int32(s.End), Entity: s.Entity})
	}
	if at := strings.Index(req.GetText(), clientName); at >= 0 && slices.Contains(req.GetEntities(), "PERSON") {
		found = append(found, &pb.EntitySpan{Start: int32(at), End: int32(at + len(clientName)), Entity: "PERSON"})
	}
	sort.Slice(found, func(i, j int) bool { return found[i].Start < found[j].Start })
	return &pb.DetectResponse{Spans: found, ModelVersion: "ner-2026.10"}, nil
}

func clientServe(ctx *harness.Ctx) *clientPeer {
	peer := &clientPeer{}
	pb.RegisterDetectorServer(ctx.GRPC.Server(""), peer)
	return peer
}

func clientDetect(ctx *harness.Ctx, text string, entities ...string) spans.Detection {
	detection, err := detect(context.Background(), text, entities)
	ctx.NoError(err, "detect(%v)", entities)
	return detection
}

func clientFound(detection spans.Detection, text string) []string {
	out := []string{}
	for _, s := range detection.Spans {
		out = append(out, text[s.Start:s.End]+" "+s.Entity)
	}
	return out
}

func CheckDeadline(ctx *harness.Ctx) {
	clientServe(ctx)
	clientDetect(ctx, clientText, "EMAIL")
	ctx.GRPC.SetLatency("Detect", 5.0, "")
	detection := clientDetect(ctx, clientText, "EMAIL")
	calls := ctx.GRPC.CallsTo("Detect", "")
	ctx.Assert(len(calls) > 0, "detect made no Detect call")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a Detect call carries no deadline: a detector answering in 5 s holds the request for 5 s")
		ctx.Assert(500*time.Millisecond <= call.Timeout && call.Timeout <= 700*time.Millisecond, "a Detect call carries a %v deadline, expected 600ms", call.Timeout)
	}
	ctx.Equal(clientFound(detection, clientText), []string{"ada@example.com EMAIL"}, "after the deadlines the fallback must still redact the email")
}

func CheckBoundedRetry(ctx *harness.Ctx) {
	peer := clientServe(ctx)
	peer.code = codes.Unavailable
	detect(context.Background(), clientText, []string{"EMAIL"})
	ctx.Equal(len(ctx.GRPC.CallsTo("Detect", "")), 2, "with the detector UNAVAILABLE, detect must make MAX_ATTEMPTS = 2 attempts (every extra one is load on a detector that is already down); attempts")
	peer.code = codes.InvalidArgument
	detect(context.Background(), clientText, []string{"EMAIL"})
	ctx.Equal(len(ctx.GRPC.CallsTo("Detect", ""))-2, 1, "an INVALID_ARGUMENT means the request itself was refused, and a second attempt fails the same way; attempts")
}

func CheckDegradedMarker(ctx *harness.Ctx) {
	peer := clientServe(ctx)
	peer.code = codes.Unavailable
	detection := clientDetect(ctx, clientText, "EMAIL", "SSN")
	ctx.Equal(clientFound(detection, clientText), []string{"ada@example.com EMAIL", "123-45-6789 SSN"}, "the fallback must redact the email and the SSN")
	ctx.Assert(detection.Source == "regex" && detection.Degraded, "a regex answer must say so (source regex, degraded), got source=%q degraded=%t", detection.Source, detection.Degraded)
	ctx.Equal(detection.DetectorVersion, spans.PatternsVersion, "a regex answer reports the patterns' version")
	peer.code = codes.OK
	detection = clientDetect(ctx, clientText, "EMAIL", "SSN")
	ctx.Assert(detection.Source == "model" && !detection.Degraded && detection.DetectorVersion == "ner-2026.10", "the model's answer is source model, not degraded, version ner-2026.10; got %+v", detection)
}

func CheckSizeIndependent(ctx *harness.Ctx) {
	peer := clientServe(ctx)
	peer.code = codes.Unavailable
	text := strings.Repeat("lorem ipsum dolor sit amet ", 800) + "Write to ada@example.com."
	detection := clientDetect(ctx, text, "EMAIL")
	ctx.Equal(clientFound(detection, text), []string{"ada@example.com EMAIL"}, "a %d-character text: the fallback must scan texts of every size; the spans", len(text))
}

func CheckUncoveredFailsClosed(ctx *harness.Ctx) {
	peer := clientServe(ctx)
	peer.code = codes.Unavailable
	text := clientName + ", ada@example.com"
	detection, err := detect(context.Background(), text, []string{"EMAIL", "PERSON"})
	ctx.Assert(err != nil, "with the detector down, a PERSON request answered %v: no pattern covers PERSON, so the name went back in place. Return spans.ErrDetectorUnavailable", clientFound(detection, text))
	ctx.Assert(errors.Is(err, spans.ErrDetectorUnavailable), "detect returned %v, expected an error wrapping spans.ErrDetectorUnavailable", err)
	peer.code = codes.OK
	detection = clientDetect(ctx, text, "EMAIL", "PERSON")
	got := clientFound(detection, text)
	sort.Strings(got)
	ctx.Equal(got, []string{"Ada Lovelace PERSON", "ada@example.com EMAIL"}, "with the detector up the model answers both types")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <string>
#include <vector>

namespace {

const std::string kText = "Mail ada@example.com, SSN 123-45-6789.";
const std::string kName = "Ada Lovelace";

// The NER model's stand-in: pattern types by their patterns, PERSON for one known name; failing
// with code when it is not OK.
class DetectorPeer final : public redactor::Detector::Service {
 public:
  grpc::StatusCode code = grpc::StatusCode::OK;
  grpc::Status Detect(grpc::ServerContext*, const redactor::DetectRequest* req, redactor::DetectResponse* out) override {
    if (code != grpc::StatusCode::OK) return grpc::Status(code, "the detector is failing");
    const std::vector<std::string> entities(req->entities().begin(), req->entities().end());
    std::vector<spans::Span> found = spans::scan(req->text(), entities);
    const size_t at = req->text().find(kName);
    if (at != std::string::npos && std::find(entities.begin(), entities.end(), "PERSON") != entities.end()) {
      found.push_back(spans::span(static_cast<int>(at), static_cast<int>(at + kName.size()), "PERSON"));
    }
    std::sort(found.begin(), found.end(), [](const spans::Span& a, const spans::Span& b) { return a.start < b.start; });
    for (const spans::Span& s : found) {
      redactor::EntitySpan* e = out->add_spans();
      e->set_start(s.start);
      e->set_end(s.end);
      e->set_entity(s.entity);
    }
    out->set_model_version("ner-2026.10");
    return grpc::Status::OK;
  }
};

DetectorPeer& serve(harness::Ctx& ctx) {
  static DetectorPeer* peer = nullptr;
  delete peer;
  peer = new DetectorPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

std::vector<std::string> found_in(const spans::Detection& detection, const std::string& text) {
  std::vector<std::string> out;
  for (const spans::Span& s : detection.spans) out.push_back(text.substr(s.start, s.end - s.start) + " " + s.entity);
  return out;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  serve(ctx);
  detect(kText, {"EMAIL"});
  ctx.GRPC.SetLatency("Detect", 5.0);
  const spans::Detection detection = detect(kText, {"EMAIL"});
  const auto calls = ctx.GRPC.CallsTo("Detect");
  ctx.Assert(!calls.empty(), "detect made no Detect call");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a Detect call carries no deadline: a detector answering in 5 s holds the request for 5 s");
    ctx.Assert(0.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 0.7, "a Detect call carries a %v s deadline, expected 0.6 s", call.TimeoutSeconds());
  }
  ctx.Equal(found_in(detection, kText), {"ada@example.com EMAIL"}, "after the deadlines the fallback must still redact the email");
}

void CheckBoundedRetry(harness::Ctx& ctx) {
  DetectorPeer& peer = serve(ctx);
  peer.code = grpc::StatusCode::UNAVAILABLE;
  detect(kText, {"EMAIL"});
  ctx.Equal(ctx.GRPC.CallsTo("Detect").size(), 2, "with the detector UNAVAILABLE, detect must make kMaxAttempts = 2 attempts (every extra one is load on a detector that is already down); attempts");
  peer.code = grpc::StatusCode::INVALID_ARGUMENT;
  detect(kText, {"EMAIL"});
  ctx.Equal(ctx.GRPC.CallsTo("Detect").size() - 2, 1, "an INVALID_ARGUMENT means the request itself was refused, and a second attempt fails the same way; attempts");
}

void CheckDegradedMarker(harness::Ctx& ctx) {
  DetectorPeer& peer = serve(ctx);
  peer.code = grpc::StatusCode::UNAVAILABLE;
  spans::Detection detection = detect(kText, {"EMAIL", "SSN"});
  ctx.Equal(found_in(detection, kText), {"ada@example.com EMAIL", "123-45-6789 SSN"}, "the fallback must redact the email and the SSN");
  ctx.Assert(detection.source == "regex" && detection.degraded, "a regex answer must say so (source regex, degraded), got source=%q degraded=%t", detection.source, detection.degraded);
  ctx.Equal(detection.detector_version, spans::kPatternsVersion, "a regex answer reports the patterns' version");
  peer.code = grpc::StatusCode::OK;
  detection = detect(kText, {"EMAIL", "SSN"});
  ctx.Assert(detection.source == "model" && !detection.degraded && detection.detector_version == "ner-2026.10", "the model's answer is source model, not degraded, version ner-2026.10; got source=%q version=%q", detection.source, detection.detector_version);
}

void CheckSizeIndependent(harness::Ctx& ctx) {
  DetectorPeer& peer = serve(ctx);
  peer.code = grpc::StatusCode::UNAVAILABLE;
  std::string text;
  for (int i = 0; i < 800; i++) text += "lorem ipsum dolor sit amet ";
  text += "Write to ada@example.com.";
  const spans::Detection detection = detect(text, {"EMAIL"});
  ctx.Equal(found_in(detection, text), {"ada@example.com EMAIL"}, "a %d-character text: the fallback must scan texts of every size; the spans", text.size());
}

void CheckUncoveredFailsClosed(harness::Ctx& ctx) {
  DetectorPeer& peer = serve(ctx);
  peer.code = grpc::StatusCode::UNAVAILABLE;
  const std::string text = kName + ", ada@example.com";
  bool refused = false;
  std::vector<std::string> answered;
  try {
    answered = found_in(detect(text, {"EMAIL", "PERSON"}), text);
  } catch (const spans::DetectorUnavailable&) {
    refused = true;
  }
  ctx.Assert(refused, "with the detector down, a PERSON request answered %v: no pattern covers PERSON, so the name went back in place. Throw spans::DetectorUnavailable", answered);
  peer.code = grpc::StatusCode::OK;
  std::vector<std::string> got = found_in(detect(text, {"EMAIL", "PERSON"}), text);
  std::sort(got.begin(), got.end());
  ctx.Equal(got, {"Ada Lovelace PERSON", "ada@example.com EMAIL"}, "with the detector up the model answers both types");
}
`,
  },
  hints: [
    "Slow the detector to five seconds: every redaction takes five seconds. Take it down: each request costs four calls, and a 20 KiB document comes back with no spans, labelled as the model's answer.",
    'No call carries a deadline; the loop runs four times and `continue`s on any code; `fallback` returns nothing above `10 * 1024`, stamps every answer `model`, and `scan` drops the types it has no pattern for.',
    'Pass `timeout=DEADLINE_S` (0.6); loop `MAX_ATTEMPTS = 2` and `break` unless the code is in `RETRYABLE`; in `fallback`, raise `DetectorUnavailable` when a type is not in `ENTITY_PATTERNS`, else scan the whole text and answer `FALLBACK_SOURCE`, `degraded=True`.',
  ],
  debrief: `The status code already says whether a second attempt can help: \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` describe the detector, anything else describes the request, so the retry loop keys on the code and stops at two. The deadline bounds what a slow detector costs, and two attempts bound what a dead one costs. The fallback is only safe when it can redact everything that was asked for; when a type has no pattern, an answer would return the very text the caller asked to hide, so failing closed is the safe default. Marking the answer \`regex\` and degraded lets callers and dashboards tell a weaker redaction from a full one. Production clients add a circuit breaker so a dead detector costs nothing per request, and hedge a slow attempt rather than wait out its deadline.`,
};
