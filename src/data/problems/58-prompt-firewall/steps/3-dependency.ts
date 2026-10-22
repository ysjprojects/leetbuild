import type {Step} from '@/lib/types';

export const detectorClientStep: Step = {
  id: 'dependency',
  title: 'Detector calls with a lexical backstop',
  concept: 'grpc',
  file: 'client',
  focus: ['detector', 'backstop', 'firewall'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the detector client: it
calls the model, loops on errors, and answers. It compiles, it serves the happy path, and it treats
every way the model can fail as a reason to stop screening. Review it, fix it, prove it.

Detection runs over **gRPC**. The model is the primary path; a deterministic lexical backstop is the
floor beneath it.

- Every attempt carries a **500 ms** deadline, so one slow model cannot pin a worker longer than the
  caller's patience.
- At most **two** attempts. Retry only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`; anything else is the
  model telling you the request is wrong and retrying will not fix it.
- **On any detector failure — including a deadline — the lexical backstop runs.** The draft treats
  "the call already failed" as a reason to skip the fallback, which turns a model outage into an
  open firewall. The backstop is the reason the firewall can depend on a model at all.
- The backstop is deterministic and named: delimiter breakouts (\`<|…|>\`) and tool-instruction
  patterns (\`system:\`, \`assistant:\`, \`tool:\`) block, outbound URLs strip. Rules carry stable ids
  so a decision says *which* lexical rule matched.
- **Size never disables screening.** The draft returns \`allow\` for prompts over 64 KiB "to stay
  fast"; a firewall whose coverage shrinks exactly on the largest inputs is not a firewall.

**Failure mode the checks target.** The draft's three flaws are one flaw with three faces: it treats
the absence of a model answer as the absence of a decision. A slow model returns \`allow\`, a prompt
over 64 KiB returns \`allow\`, and a dead model returns \`allow\` after ten retries that mostly
guarantee the outage outlives the request. Deterministic detection is cheaper than model detection
and does not depend on anything being up — so it must be the last thing that happens, not the thing
that gets skipped.`,
  sequence: {
    participants: ['Prompt Firewall', 'Detector', 'Lexical backstop'],
    messages: [
      {from: 'Prompt Firewall', to: 'Detector', label: 'Detect(prompt) · deadline 500 ms', kind: 'sync'},
      {from: 'Detector', to: 'Prompt Firewall', label: 'DEADLINE_EXCEEDED · the model is slow', kind: 'reply'},
      {from: 'Prompt Firewall', to: 'Detector', label: 'attempt 2 · the last one', kind: 'sync'},
      {from: 'Detector', to: 'Prompt Firewall', label: 'still down', kind: 'reply'},
      {
        from: 'Prompt Firewall',
        to: 'Lexical backstop',
        label: 'scan delimiters + tool instructions · any size',
        kind: 'sync',
      },
      {from: 'Lexical backstop', to: 'Prompt Firewall', label: 'deterministic decision with rule ids', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 500 ms deadline',
      detail:
        'The call sets a 500 ms deadline (`timeout`, `deadline`, `withDeadlineAfter`, `set_deadline`). Without it a slow detector pins the request until the caller gives up, and the worker is gone far longer than the model is slow. The draft sets none.',
      match: {
        python: {all: [/DETECTOR_DEADLINE_MS/, /timeout=/]},
        typescript: {all: [/DETECTOR_DEADLINE_MS/, /deadline/]},
        go: {all: [/detectorDeadlineMs/, /context\.WithTimeout/]},
        scala: {all: [/DetectorDeadlineMs/, /withDeadlineAfter/]},
        cpp: {all: [/kDetectorDeadlineMs/, /set_deadline/]},
      },
    },
    {
      id: 'backstop-always',
      title: 'The lexical backstop is the fallthrough on every failure',
      detail:
        'The screening call returns the backstop result after the detector path fails, so a slow or dead model degrades detection quality instead of dropping screening. The draft returns `allow` when the model call fails — the fallback exists but is never reached.',
      match: {
        python: {all: [/return lexical_backstop\(prompt\)/, /except/]},
        typescript: {all: [/return lexicalBackstop\(prompt\)/, /\bcatch\b/]},
        go: {all: [/return lexicalBackstop\(prompt\)/, /err != nil/]},
        scala: {all: [/lexicalBackstop\(prompt\)/, /\bFailure\b/]},
        cpp: {all: [/return lexicalBackstop\(prompt\)/, /status\.ok\(\)/]},
      },
    },
    {
      id: 'bounded-retries',
      title: 'Bounded attempts with a retryable set',
      detail:
        'The attempt budget is **2** and only `UNAVAILABLE`/`DEADLINE_EXCEEDED` are retried. The draft retries ten times on anything, which is an outage amplifier: the slower the model, the more of its capacity the firewall spends asking again.',
      match: {
        python: {all: [/MAX_ATTEMPTS/, /range\(MAX_ATTEMPTS\)/]},
        typescript: {all: [/MAX_ATTEMPTS/, /attempt\s*<\s*MAX_ATTEMPTS/]},
        go: {all: [/maxAttempts/, /attempt\s*<\s*maxAttempts/]},
        scala: {all: [/MaxAttempts/, /attempt\s*<\s*MaxAttempts/]},
        cpp: {all: [/kMaxAttempts/, /attempt\s*<\s*kMaxAttempts/]},
      },
    },
    {
      id: 'size-independent',
      title: 'No size gate disables screening',
      detail:
        'Screening runs for every prompt size; there is no branch that answers `allow` because the prompt is large. The draft skips the detector and the backstop for prompts over 64 KiB, so coverage silently drops on exactly the inputs that matter most.',
      match: {
        python: {all: [/def screen\(/, /lexical_backstop\(/], none: [/65536/, /64\s*\*\s*1024/]},
        typescript: {all: [/function screen\(/, /lexicalBackstop\(/], none: [/65536/, /64\s*\*\s*1024/]},
        go: {all: [/func screen\(/, /lexicalBackstop\(/], none: [/65536/, /64\s*\*\s*1024/]},
        scala: {all: [/def screen\(/, /lexicalBackstop\(/], none: [/65536/, /64\s*\*\s*1024/]},
        cpp: {all: [/screen\(/, /lexicalBackstop\(/], none: [/65536/, /64\s*\*\s*1024/]},
      },
    },
    {
      id: 'backstop-rules',
      title: 'The backstop carries named delimiter and tool-instruction rules',
      detail:
        'The deterministic pass is a table of named rules: delimiter breakouts and tool-instruction patterns block, exfiltration URLs strip. The draft has an empty scan that returns `allow`, so its "fallback" has nothing to match with.',
      match: {
        python: {all: [/BACKSTOP_RULES/, /lex-delimiter/, /lex-tool-instruction/]},
        typescript: {all: [/BACKSTOP_RULES/, /lex-delimiter/, /lex-tool-instruction/]},
        go: {all: [/backstopRules/, /"lex-delimiter"/, /"lex-tool-instruction"/]},
        scala: {all: [/BackstopRules/, /"lex-delimiter"/, /"lex-tool-instruction"/]},
        cpp: {all: [/kBackstopRules/, /"lex-delimiter"/, /"lex-tool-instruction"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

logger = logging.getLogger("firewall-detector")
MAX_RETRIES = 10


def lexical_backstop(prompt: str) -> dict:
    """Deterministic scan, skipped once the model call has already failed."""
    return {"decision": "allow", "rules": [], "spans": []}


def screen(prompt: str, stub) -> dict:
    # TODO: the draft answers allow when the detector fails or is slow, retries the detector ten
    # times while it is down, and skips screening for prompts over 64 KiB. Fall through to the
    # lexical backstop on every failure, cap the attempts at two, and screen every size.
    if len(prompt) > 64 * 1024:
        return {"decision": "allow", "rules": [], "spans": []}
    for attempt in range(MAX_RETRIES):
        try:
            reply = stub.Detect(DetectRequest(prompt=prompt))
            return {"decision": reply.decision, "rules": list(reply.rules), "spans": []}
        except grpc.RpcError as error:
            logger.warning("detector attempt %d failed: %s", attempt, error.code())
    return {"decision": "allow", "rules": [], "spans": []}
`,
      solution: `import logging
import re
import time

import grpc

logger = logging.getLogger("firewall-detector")

DETECTOR_DEADLINE_MS = 500
MAX_ATTEMPTS = 2
RETRY_BACKOFF_MS = 50
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

BACKSTOP_RULES = (
    {"id": "lex-delimiter", "pattern": re.compile(r"<\\|[^|]*\\|>"), "decision": "block"},
    {
        "id": "lex-tool-instruction",
        "pattern": re.compile(r"(?im)^\\s*(system|assistant|tool)\\s*:"),
        "decision": "block",
    },
    {"id": "lex-exfil", "pattern": re.compile(r"https?://\\S+"), "decision": "strip"},
)


def lexical_backstop(prompt: str) -> dict:
    """Delimiter breakouts and tool-instruction patterns, at every size, with no network."""
    matched = [rule for rule in BACKSTOP_RULES if rule["pattern"].search(prompt)]
    if not matched:
        return {"decision": "allow", "rules": [], "spans": []}
    decision = "block" if any(rule["decision"] == "block" for rule in matched) else "strip"
    spans = [
        {"start": match.start(), "end": match.end()}
        for rule in matched
        for match in rule["pattern"].finditer(prompt)
    ]
    return {"decision": decision, "rules": [rule["id"] for rule in matched], "spans": spans}


def screen(prompt: str, stub) -> dict:
    """Model first under a 500 ms deadline, at most two attempts, then the lexical backstop."""
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = stub.Detect(DetectRequest(prompt=prompt), timeout=DETECTOR_DEADLINE_MS / 1000)
            return {"decision": reply.decision, "rules": list(reply.rules), "spans": []}
        except grpc.RpcError as error:
            logger.warning("detector attempt %d failed: %s", attempt, error.code())
            if error.code() not in RETRYABLE:
                break
            if attempt + 1 < MAX_ATTEMPTS:
                time.sleep(RETRY_BACKOFF_MS / 1000)
    return lexical_backstop(prompt)
`,
    },
    typescript: {
      starter: `/** A model-generated detector client that treats a failed call as an allow. */
import * as grpc from '@grpc/grpc-js';

const MAX_RETRIES = 10;

function lexicalBackstop(prompt: string): Verdict {
  // deterministic scan, skipped once the model call has already failed
  return {decision: 'allow', rules: [], spans: []};
}

export async function screen(prompt: string, client: DetectorClient): Promise<Verdict> {
  // TODO: the draft answers allow when the detector fails or is slow, retries the detector ten
  // times while it is down, and skips screening for prompts over 64 KiB. Fall through to the
  // lexical backstop on every failure, cap the attempts at two, and screen every size.
  if (prompt.length > 64 * 1024) return {decision: 'allow', rules: [], spans: []};
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const reply = await new Promise<DetectReply>((resolve, reject) =>
        client.detect({prompt}, (error, reply) => (error ? reject(error) : resolve(reply))),
      );
      return {decision: reply.decision, rules: reply.rules, spans: []};
    } catch {
      continue;
    }
  }
  return {decision: 'allow', rules: [], spans: []};
}
`,
      solution: `/** Detector client: 500 ms deadline, two attempts, then the deterministic lexical backstop. */
import * as grpc from '@grpc/grpc-js';

const DETECTOR_DEADLINE_MS = 500;
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 50;

const RETRYABLE = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

const BACKSTOP_RULES = [
  {id: 'lex-delimiter', pattern: /<|[^|]*|>/, decision: 'block'},
  {id: 'lex-tool-instruction', pattern: /^[ \t]*(system|assistant|tool)[ \t]*:/im, decision: 'block'},
  {id: 'lex-exfil', pattern: /https?://S+/, decision: 'strip'},
] as const;

function sleep(ms: number): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function lexicalBackstop(prompt: string): Verdict {
  // Delimiter breakouts and tool-instruction patterns, at every size, with no network.
  const matched = BACKSTOP_RULES.filter(rule => rule.pattern.test(prompt));
  const spans = matched.flatMap(rule => {
    const found: Span[] = [];
    for (const match of prompt.matchAll(new RegExp(rule.pattern.source, 'g')))
      found.push({start: match.index ?? 0, end: (match.index ?? 0) + match[0].length});
    return found;
  });
  if (matched.length === 0) return {decision: 'allow', rules: [], spans};
  const decision = matched.some(rule => rule.decision === 'block') ? 'block' : 'strip';
  return {decision, rules: matched.map(rule => rule.id), spans};
}

export async function screen(prompt: string, client: DetectorClient): Promise<Verdict> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const {promise, resolve, reject} = Promise.withResolvers<DetectReply>();
      client.detect({prompt}, {deadline: Date.now() + DETECTOR_DEADLINE_MS}, (error, reply) =>
        error ? reject(error) : resolve(reply),
      );
      const reply = await promise;
      return {decision: reply.decision, rules: reply.rules, spans: []};
    } catch (error) {
      if (!RETRYABLE.includes((error as grpc.ServiceError).code)) break;
      if (attempt + 1 < MAX_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
    }
  }
  return lexicalBackstop(prompt);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
)

const maxRetries = 10

func lexicalBackstop(prompt string) Verdict {
	// deterministic scan, skipped once the model call has already failed
	return Verdict{Decision: "allow", Rules: []string{}, Spans: []Span{}}
}

func screen(ctx context.Context, prompt string, client DetectorClient) Verdict {
	// TODO: the draft answers allow when the detector fails or is slow, retries the detector ten
	// times while it is down, and skips screening for prompts over 64 KiB. Fall through to the
	// lexical backstop on every failure, cap the attempts at two, and screen every size.
	if len(prompt) > 64*1024 {
		return Verdict{Decision: "allow", Rules: []string{}, Spans: []Span{}}
	}
	for attempt := 0; attempt < maxRetries; attempt++ {
		reply, err := client.Detect(ctx, &DetectRequest{Prompt: prompt})
		if err == nil {
			return Verdict{Decision: reply.Decision, Rules: reply.Rules, Spans: []Span{}}
		}
		log.Printf("detector attempt %d failed: %v", attempt, err)
	}
	return Verdict{Decision: "allow", Rules: []string{}, Spans: []Span{}}
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
	detectorDeadlineMs = 500
	maxAttempts        = 2
	retryBackoffMs     = 50
)

type backstopRule struct {
	ID       string
	Pattern  *regexp.Regexp
	Decision string
}

var backstopRules = []backstopRule{
	{ID: "lex-delimiter", Pattern: regexp.MustCompile(\`<\\|[^|]*\\|>\`), Decision: "block"},
	{ID: "lex-tool-instruction", Pattern: regexp.MustCompile(\`(?im)^\\s*(system|assistant|tool)\\s*:\`), Decision: "block"},
	{ID: "lex-exfil", Pattern: regexp.MustCompile(\`https?://\\S+\`), Decision: "strip"},
}

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

// lexicalBackstop is the deterministic pass: delimiter breakouts and tool instructions, any size.
func lexicalBackstop(prompt string) Verdict {
	verdict := Verdict{Decision: "allow", Rules: []string{}, Spans: []Span{}}
	for _, rule := range backstopRules {
		if !rule.Pattern.MatchString(prompt) {
			continue
		}
		verdict.Rules = append(verdict.Rules, rule.ID)
		for _, loc := range rule.Pattern.FindAllStringIndex(prompt, -1) {
			verdict.Spans = append(verdict.Spans, Span{Start: loc[0], End: loc[1]})
		}
		if rule.Decision == "block" {
			verdict.Decision = "block"
		} else if verdict.Decision == "allow" {
			verdict.Decision = "strip"
		}
	}
	return verdict
}

func screen(ctx context.Context, prompt string, client DetectorClient) Verdict {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, detectorDeadlineMs*time.Millisecond)
		reply, err := client.Detect(callCtx, &DetectRequest{Prompt: prompt})
		cancel()
		if err != nil {
			if !retryable[status.Code(err)] {
				break
			}
			if attempt+1 < maxAttempts {
				time.Sleep(retryBackoffMs * time.Millisecond)
			}
			continue
		}
		return Verdict{Decision: reply.Decision, Rules: reply.Rules, Spans: []Span{}}
	}
	return lexicalBackstop(prompt)
}
`,
    },
    scala: {
      starter: `import scala.util.{Failure, Success, Try}

import io.grpc.StatusRuntimeException

object DetectorClient {
  val MaxRetries = 10

  def lexicalBackstop(prompt: String): Verdict = {
    // deterministic scan, skipped once the model call has already failed
    Verdict("allow", Nil, Nil)
  }

  // TODO: the draft answers allow when the detector fails or is slow, retries the detector ten
  // times while it is down, and skips screening for prompts over 64 KiB. Fall through to the
  // lexical backstop on every failure, cap the attempts at two, and screen every size.
  def screen(prompt: String, stub: DetectorStub): Verdict = {
    if (prompt.length > 64 * 1024) return Verdict("allow", Nil, Nil)
    var attempt = 0
    while (attempt < MaxRetries) {
      Try(stub.detect(DetectRequest(prompt))) match {
        case Success(reply) => return Verdict(reply.decision, reply.rules, Nil)
        case Failure(_) => attempt += 1
      }
    }
    Verdict("allow", Nil, Nil)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.util.{Failure, Success, Try}

import io.grpc.{Status, StatusRuntimeException}

object DetectorClient {
  val DetectorDeadlineMs = 500
  val MaxAttempts = 2
  val RetryBackoffMs = 50

  final case class BackstopRule(id: String, pattern: scala.util.matching.Regex, decision: String)

  val BackstopRules = List(
    BackstopRule("lex-delimiter", "<\\\\|[^|]*\\\\|>".r, "block"),
    BackstopRule("lex-tool-instruction", "(?im)^\\\\s*(system|assistant|tool)\\\\s*:".r, "block"),
    BackstopRule("lex-exfil", "https?://\\\\S+".r, "strip"),
  )

  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  // Delimiter breakouts and tool-instruction patterns, at every size, with no network.
  def lexicalBackstop(prompt: String): Verdict = {
    val matched = BackstopRules.filter(rule => rule.pattern.findFirstIn(prompt).nonEmpty)
    if (matched.isEmpty) Verdict("allow", Nil, Nil)
    else {
      val decision = if (matched.exists(_.decision == "block")) "block" else "strip"
      val spans = matched.flatMap(rule => rule.pattern.findAllMatchIn(prompt).map(m => Span(m.start, m.end)))
      Verdict(decision, matched.map(_.id), spans)
    }
  }

  def screen(prompt: String, stub: DetectorStub): Verdict = {
    var attempt = 0
    while (attempt < MaxAttempts) {
      Try(stub.withDeadlineAfter(DetectorDeadlineMs, TimeUnit.MILLISECONDS).detect(DetectRequest(prompt))) match {
        case Success(reply) => return Verdict(reply.decision, reply.rules, Nil)
        case Failure(error: StatusRuntimeException) if !Retryable.contains(error.getStatus.getCode) =>
          attempt = MaxAttempts
        case Failure(_) => attempt += 1
      }
      if (attempt < MaxAttempts) Thread.sleep(RetryBackoffMs)
    }
    lexicalBackstop(prompt)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>
#include <vector>

constexpr int kMaxRetries = 10;

Verdict lexicalBackstop(const std::string& prompt) {
  // deterministic scan, skipped once the model call has already failed
  return Verdict{"allow", {}, {}};
}

// TODO: the draft answers allow when the detector fails or is slow, retries the detector ten times
// while it is down, and skips screening for prompts over 64 KiB. Fall through to the lexical
// backstop on every failure, cap the attempts at two, and screen every size.
Verdict screen(const std::string& prompt, Detector::Stub& stub) {
  if (prompt.size() > 64 * 1024) return Verdict{"allow", {}, {}};
  for (int attempt = 0; attempt < kMaxRetries; ++attempt) {
    grpc::ClientContext context;
    DetectRequest request;
    request.set_prompt(prompt);
    DetectReply reply;
    if (stub.Detect(&context, request, &reply).ok()) return Verdict{reply.decision(), {reply.rules().begin(), reply.rules().end()}, {}};
  }
  return Verdict{"allow", {}, {}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <regex>
#include <string>
#include <thread>
#include <vector>

constexpr int kDetectorDeadlineMs = 500;
constexpr int kMaxAttempts = 2;
constexpr int kRetryBackoffMs = 50;

struct BackstopRule {
  std::string id;
  std::regex pattern;
  std::string decision;
};

const std::vector<BackstopRule> kBackstopRules = {
    {"lex-delimiter", std::regex(R"(<\\|[^|]*\\|>)"), "block"},
    {"lex-tool-instruction", std::regex(R"((^|\\n)[ \\t]*(system|assistant|tool)[ \\t]*:)", std::regex::icase), "block"},
    {"lex-exfil", std::regex(R"(https?://\\S+)"), "strip"},
};

// Delimiter breakouts and tool-instruction patterns, at every size, with no network.
Verdict lexicalBackstop(const std::string& prompt) {
  std::string decision = "allow";
  std::vector<std::string> matched;
  std::vector<Span> spans;
  for (const auto& rule : kBackstopRules) {
    bool hit = false;
    for (auto it = std::sregex_iterator(prompt.begin(), prompt.end(), rule.pattern); it != std::sregex_iterator(); ++it) {
      hit = true;
      spans.push_back({static_cast<int>(it->position()), static_cast<int>(it->position() + it->length())});
    }
    if (!hit) continue;
    matched.push_back(rule.id);
    if (rule.decision == "block") decision = "block";
    else if (decision == "allow") decision = "strip";
  }
  return Verdict{decision, matched, spans};
}

Verdict screen(const std::string& prompt, Detector::Stub& stub) {
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDetectorDeadlineMs));
    DetectRequest request;
    request.set_prompt(prompt);
    DetectReply reply;
    const grpc::Status status = stub.Detect(&context, request, &reply);
    if (status.ok()) return Verdict{reply.decision(), {reply.rules().begin(), reply.rules().end()}, {}};
    const bool retryable = status.error_code() == grpc::StatusCode::UNAVAILABLE ||
                           status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
    if (!retryable) break;
    if (attempt + 1 < kMaxAttempts) std::this_thread::sleep_for(std::chrono::milliseconds(kRetryBackoffMs));
  }
  return lexicalBackstop(prompt);
}
`,
    },
  },
  hints: [
    'Bound the retries under one budget: `for attempt in range(MAX_ATTEMPTS)` with the deadline set per attempt, and `if error.code() not in RETRYABLE: break`. Retrying an unretryable code is a bug; retrying a retryable one more than once while the dependency is down is an outage amplifier.',
    'The backstop is the *default outcome* of the function, not a branch inside the catch. Write the detector loop, and let the code after it be `return lexical_backstop(prompt)` — then there is no path from a failed call to `allow`, and no future edit can add one by accident.',
    'Make the backstop a data table with ids (`lex-delimiter`, `lex-tool-instruction`, `lex-exfil`) so a decision names the rule that fired, and drop the size gate entirely. If the scan is too slow on a 128 KiB prompt, make the scan cheaper — never the coverage smaller.',
  ],
  debrief: `The interviewer is testing what your service does when the model does not answer, which is the only question that separates a demo from a firewall. The draft's flaw is one idea in three costumes: the absence of a model answer is treated as the absence of a decision. So a slow model allows, a huge prompt allows, and a dead model allows after ten retries that spend the outage's capacity asking again. The fix inverts the default: the deterministic pass is what runs when nothing else can, and it is defined as a table of named rules so the decision is explainable after the fact. Real deployments add a circuit breaker around the detector, sample-based shadow evaluation of new rules against the model, and a metric on the backstop's share of decisions — a backstop that runs 40% of the time is a detector outage, not a fallback.`,
};
