import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Model calls with a rules fallback and no silent safe label',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['classifier', 'model', 'rules'],
  task: `## Task

**Starting point.** \`classify(text, taxonomy_id, taxonomy_version)\` calls \`Model.Classify\`
(\`content_classifier.proto\`, a stand-in served at \`classifier.config\`'s \`MODEL\`) in a loop until a
reply that is not a refusal comes back or \`MAX_WAIT_S\` (10 s) has passed, sleeping \`BACKOFF_S\`
between tries. It answers \`{labels, provenance, model_version}\` with provenance \`model\`, and
\`["safe"]\` when the time runs out. Against a healthy model it answers in one call. It hides 5 flaws.

**Failure mode the checks target.** A call with no deadline holds the request as long as a hung
model does; retrying every status, refusals included, spends ten seconds on an answer that will not
change; and \`safe\` marked as the model's launders an outage past review, uncounted.

\`\`\`proto
service Model { rpc Classify(ClassifyRequest) returns (ClassifyReply); }
message ClassifyRequest { string text = 1; string taxonomy_id = 2; int64 taxonomy_version = 3; }
message ClassifyReply { repeated string labels = 1; bool refused = 2; string model_version = 3; }
\`\`\`

- Each call carries a **700 ms** deadline (\`DEADLINE_S\`).
- At most \`MAX_ATTEMPTS\` = 3 calls; only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retried. A
  refusal or any other status ends the attempts.
- Without a model answer, \`rules_classify(text)\` labels the text from \`KEYWORD_RULES\`; no match
  is \`REVIEW_LABEL\`, never \`safe\`.
- A rules result has provenance \`fallback\`, model_version \`rules\`, and adds one to \`FALLBACK_KEY\`.`,
  sequence: {
    participants: ['Content Classifier', 'Model', 'Rules fallback', 'Redis'],
    messages: [
      {from: 'Content Classifier', to: 'Model', label: 'Classify · deadline 700 ms', kind: 'sync'},
      {from: 'Model', to: 'Content Classifier', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Content Classifier', to: 'Model', label: 'attempt 2 of 3 after a backoff', kind: 'sync'},
      {from: 'Model', to: 'Content Classifier', label: '{refused: true}', kind: 'reply'},
      {from: 'Content Classifier', to: 'Rules fallback', label: 'rules_classify(text)', kind: 'sync'},
      {from: 'Rules fallback', to: 'Content Classifier', label: 'keyword labels or review', kind: 'reply'},
      {from: 'Content Classifier', to: 'Redis', label: 'INCR metrics:classifier_fallback_total', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every model call carries a 700 ms deadline',
      detail:
        'Each Classify call carries a deadline of 0.7 s (`timeout=DEADLINE_S`, `deadline: Date.now() + DEADLINE_MS`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`), so a model that hangs costs three short attempts, not the hang. The starter sends no deadline.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.7\b/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*700\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*700\s*\*\s*time\.Millisecond/, /context\.WithTimeout\(/]},
        scala: {all: [/DeadlineMs\s*=\s*700L?\b/, /withDeadlineAfter\(/]},
        cpp: {all: [/kDeadline\{700\}/, /set_deadline\(/]},
      },
    },
    {
      id: 'refusal-terminal',
      title: 'A refusal is terminal, attempts are bounded',
      detail:
        'A refusal ends the attempts after one call; `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried up to `MAX_ATTEMPTS` = 3 calls in all; any other status is not retried. The starter asks again on every failure and every refusal until ten seconds pass.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*3\b/, /grpc\.StatusCode\.UNAVAILABLE/, /reply\.refused/],
          none: [/MAX_WAIT_S/],
        },
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*3\b/, /status\.UNAVAILABLE/, /reply\.refused/], none: [/MAX_WAIT_MS/]},
        go: {all: [/maxAttempts\s*=\s*3\b/, /codes\.Unavailable/, /GetRefused\(\)/], none: [/maxWait\b/]},
        scala: {all: [/MaxAttempts\s*=\s*3\b/, /Status\.Code\.UNAVAILABLE/, /\.refused\b/], none: [/MaxWaitMs/]},
        cpp: {all: [/kMaxAttempts\s*=\s*3\b/, /grpc::StatusCode::UNAVAILABLE/, /\.refused\(\)/], none: [/kMaxWait\b/]},
      },
    },
    {
      id: 'rules-fallback',
      title: 'Falls back to the deterministic keyword rules',
      detail:
        'When the model does not answer, `rules_classify`/`rulesClassify` labels the text from `KEYWORD_RULES`: a refund question is `billing` during an outage. The starter has no fallback.',
      match: {
        python: {all: [/def rules_classify\(/, /KEYWORD_RULES/, /rules_classify\(\s*text\s*\)/]},
        typescript: {all: [/function rulesClassify\(/, /KEYWORD_RULES/, /rulesClassify\(\s*text\s*\)/]},
        go: {all: [/func rulesClassify\(/, /keywordRules/, /rulesClassify\(\s*text\s*\)/]},
        scala: {all: [/def rulesClassify\(/, /KeywordRules/, /rulesClassify\(\s*text\s*\)/]},
        cpp: {all: [/rulesClassify\(const std::string& text\)/, /kKeywordRules/, /rulesClassify\(\s*text\s*\)/]},
      },
    },
    {
      id: 'no-safe-default',
      title: 'Never answers a safe label with no evidence',
      detail:
        'A text the rules cannot place is `REVIEW_LABEL` (`review`); no code path returns `safe`. The starter answers `["safe"]` whenever the model does not.',
      match: {
        python: {all: [/REVIEW_LABEL/], none: [/["']safe["']/]},
        typescript: {all: [/REVIEW_LABEL/], none: [/['"]safe['"]/]},
        go: {all: [/config\.ReviewLabel/], none: [/"safe"/]},
        scala: {all: [/Config\.ReviewLabel/], none: [/"safe"/]},
        cpp: {all: [/config::kReviewLabel/], none: [/"safe"/]},
      },
    },
    {
      id: 'provenance',
      title: 'Fallback results carry their provenance and count separately',
      detail:
        'A rules answer has provenance `fallback` and model_version `rules`, and each one adds one to `FALLBACK_KEY` (`metrics:classifier_fallback_total`), so an outage shows as a spike. The starter marks everything `model` and counts nothing.',
      match: {
        python: {all: [/["']fallback["']/, /["']rules["']/, /\.incr\(\s*FALLBACK_KEY\s*\)/]},
        typescript: {all: [/['"]fallback['"]/, /['"]rules['"]/, /\.incr\(\s*FALLBACK_KEY\s*\)/]},
        go: {all: [/"fallback"/, /"rules"/, /\.Incr\(ctx,\s*config\.FallbackKey\)/]},
        scala: {all: [/"fallback"/, /"rules"/, /\.incr\(\s*Config\.FallbackKey\s*\)/]},
        cpp: {all: [/"fallback"/, /"rules"/, /\.incr\(\s*config::kFallbackKey\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import grpc

import content_classifier_pb2
import content_classifier_pb2_grpc
from classifier.config import MODEL

logger = logging.getLogger("classifier.model")

MAX_WAIT_S = 10.0
BACKOFF_S = 0.1

stub = content_classifier_pb2_grpc.ModelStub(grpc.insecure_channel(MODEL))


def classify(text: str, taxonomy_id: str, taxonomy_version: int) -> dict:
    """Labels for the text: ask the model until it answers."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    request = content_classifier_pb2.ClassifyRequest(text=text, taxonomy_id=taxonomy_id, taxonomy_version=taxonomy_version)
    until = time.monotonic() + MAX_WAIT_S
    while time.monotonic() < until:
        try:
            reply = stub.Classify(request)
        except grpc.RpcError as err:
            logger.warning("model call failed code=%s", err.code())
            time.sleep(BACKOFF_S)
            continue
        if reply.refused:
            time.sleep(BACKOFF_S)
            continue
        return {"labels": list(reply.labels), "provenance": "model", "model_version": reply.model_version}
    return {"labels": ["safe"], "provenance": "model", "model_version": ""}
`,
      solution: `import logging
import time

import grpc
import redis

import content_classifier_pb2
import content_classifier_pb2_grpc
from classifier.config import FALLBACK_KEY, MODEL, REVIEW_LABEL

logger = logging.getLogger("classifier.model")

DEADLINE_S = 0.7
MAX_ATTEMPTS = 3
BACKOFF_S = 0.05
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
KEYWORD_RULES = (
    ("billing", ("invoice", "refund", "charge")),
    ("support", ("broken", "error", "crash")),
    ("security", ("password", "breach", "phishing")),
)

r = redis.Redis(host="redis", port=6379, decode_responses=True)
stub = content_classifier_pb2_grpc.ModelStub(grpc.insecure_channel(MODEL))


def rules_classify(text: str) -> list[str]:
    """Keyword evidence only: a text no rule matches goes to review, never to a safe label."""
    lowered = text.lower()
    labels = [label for label, words in KEYWORD_RULES if any(word in lowered for word in words)]
    return labels or [REVIEW_LABEL]


def classify(text: str, taxonomy_id: str, taxonomy_version: int) -> dict:
    """Labels for the text from the model, or from the keyword rules when the model cannot answer."""
    request = content_classifier_pb2.ClassifyRequest(text=text, taxonomy_id=taxonomy_id, taxonomy_version=taxonomy_version)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Classify(request, timeout=DEADLINE_S)
        except grpc.RpcError as err:
            logger.warning("model call failed attempt=%d code=%s", attempt, err.code())
            if err.code() in RETRYABLE and attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_S * attempt)
                continue
            break
        if reply.refused:
            break  # the model's decision: asking again gets the same answer
        return {"labels": list(reply.labels), "provenance": "model", "model_version": reply.model_version}
    r.incr(FALLBACK_KEY)
    return {"labels": rules_classify(text), "provenance": "fallback", "model_version": "rules"}
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {MODEL} from 'classifier/config';

export const MAX_WAIT_MS = 10_000;
export const BACKOFF_MS = 100;

interface ClassifyRequest {
  text: string;
  taxonomy_id: string;
  taxonomy_version: number;
}
interface ClassifyReply {
  labels: string[];
  refused: boolean;
  model_version: string;
}
interface ModelClient {
  Classify(request: ClassifyRequest, options?: {deadline: number}): Promise<ClassifyReply>;
}

const {contentclassifier} = grpc.loadPackageDefinition(protoLoader.loadSync('content_classifier.proto')) as unknown as {
  contentclassifier: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const stub = new contentclassifier.Model(MODEL, grpc.credentials.createInsecure());

export interface Result {
  labels: string[];
  provenance: string;
  model_version: string;
}

/** Labels for the text: ask the model until it answers. */
export async function classify(text: string, taxonomyId: string, taxonomyVersion: number): Promise<Result> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const request = {text, taxonomy_id: taxonomyId, taxonomy_version: taxonomyVersion};
  const until = Date.now() + MAX_WAIT_MS;
  while (Date.now() < until) {
    let reply: ClassifyReply;
    try {
      reply = await stub.Classify(request);
    } catch (err) {
      console.warn(\`model call failed code=\${(err as grpc.ServiceError).code}\`);
      await sleep(BACKOFF_MS);
      continue;
    }
    if (reply.refused) {
      await sleep(BACKOFF_MS);
      continue;
    }
    return {labels: [...(reply.labels ?? [])], provenance: 'model', model_version: reply.model_version};
  }
  return {labels: ['safe'], provenance: 'model', model_version: ''};
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {FALLBACK_KEY, MODEL, REVIEW_LABEL} from 'classifier/config';

export const DEADLINE_MS = 700;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 50;
const RETRYABLE = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];
const KEYWORD_RULES: [string, string[]][] = [
  ['billing', ['invoice', 'refund', 'charge']],
  ['support', ['broken', 'error', 'crash']],
  ['security', ['password', 'breach', 'phishing']],
];

interface ClassifyRequest {
  text: string;
  taxonomy_id: string;
  taxonomy_version: number;
}
interface ClassifyReply {
  labels: string[];
  refused: boolean;
  model_version: string;
}
interface ModelClient {
  Classify(request: ClassifyRequest, options?: {deadline: number}): Promise<ClassifyReply>;
}

const {contentclassifier} = grpc.loadPackageDefinition(protoLoader.loadSync('content_classifier.proto')) as unknown as {
  contentclassifier: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const stub = new contentclassifier.Model(MODEL, grpc.credentials.createInsecure());
const redis = new Redis({host: 'redis', port: 6379});

export interface Result {
  labels: string[];
  provenance: string;
  model_version: string;
}

/** Keyword evidence only: a text no rule matches goes to review, never to a safe label. */
export function rulesClassify(text: string): string[] {
  const lowered = text.toLowerCase();
  const labels = KEYWORD_RULES.filter(([, words]) => words.some(word => lowered.includes(word))).map(([label]) => label);
  return labels.length > 0 ? labels : [REVIEW_LABEL];
}

/** Labels for the text from the model, or from the keyword rules when the model cannot answer. */
export async function classify(text: string, taxonomyId: string, taxonomyVersion: number): Promise<Result> {
  const request = {text, taxonomy_id: taxonomyId, taxonomy_version: taxonomyVersion};
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let reply: ClassifyReply;
    try {
      reply = await stub.Classify(request, {deadline: Date.now() + DEADLINE_MS});
    } catch (err) {
      const {code} = err as grpc.ServiceError;
      console.warn(\`model call failed attempt=\${attempt} code=\${code}\`);
      if (RETRYABLE.includes(code) && attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS * attempt);
        continue;
      }
      break;
    }
    if (reply.refused) break; // the model's decision: asking again gets the same answer
    return {labels: [...(reply.labels ?? [])], provenance: 'model', model_version: reply.model_version};
  }
  await redis.incr(FALLBACK_KEY);
  return {labels: rulesClassify(text), provenance: 'fallback', model_version: 'rules'};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"classifier/config" // config.Model, config.ReviewLabel, config.FallbackKey
	pb "classifier/gen/content_classifier"
)

const (
	maxWait = 10 * time.Second
	backoff = 100 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.Model, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)

// Result is one classification: the labels, where they came from, and the model that produced them.
type Result struct {
	Labels       []string
	Provenance   string
	ModelVersion string
}

// classify labels the text: it asks the model until it answers.
func classify(ctx context.Context, text, taxonomyID string, taxonomyVersion int) (Result, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	request := &pb.ClassifyRequest{Text: text, TaxonomyId: taxonomyID, TaxonomyVersion: int64(taxonomyVersion)}
	until := time.Now().Add(maxWait)
	for time.Now().Before(until) {
		reply, err := stub.Classify(ctx, request)
		if err != nil {
			log.Printf("model call failed code=%s", status.Code(err))
			time.Sleep(backoff)
			continue
		}
		if reply.GetRefused() {
			time.Sleep(backoff)
			continue
		}
		return Result{Labels: append([]string{}, reply.GetLabels()...), Provenance: "model", ModelVersion: reply.GetModelVersion()}, nil
	}
	return Result{Labels: []string{"safe"}, Provenance: "model"}, nil
}
`,
      solution: `package main

import (
	"context"
	"log"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"classifier/config" // config.Model, config.ReviewLabel, config.FallbackKey
	pb "classifier/gen/content_classifier"
)

const (
	deadline    = 700 * time.Millisecond
	maxAttempts = 3
	backoff     = 50 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.Model, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)
var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Result is one classification: the labels, where they came from, and the model that produced them.
type Result struct {
	Labels       []string
	Provenance   string
	ModelVersion string
}

type rule struct {
	label string
	words []string
}

var keywordRules = []rule{
	{"billing", []string{"invoice", "refund", "charge"}},
	{"support", []string{"broken", "error", "crash"}},
	{"security", []string{"password", "breach", "phishing"}},
}

// rulesClassify is keyword evidence only: a text no rule matches goes to review, never to a safe label.
func rulesClassify(text string) []string {
	lowered := strings.ToLower(text)
	labels := []string{}
	for _, r := range keywordRules {
		for _, word := range r.words {
			if strings.Contains(lowered, word) {
				labels = append(labels, r.label)
				break
			}
		}
	}
	if len(labels) == 0 {
		return []string{config.ReviewLabel}
	}
	return labels
}

// classify labels the text with the model, or with the keyword rules when the model cannot answer.
func classify(ctx context.Context, text, taxonomyID string, taxonomyVersion int) (Result, error) {
	request := &pb.ClassifyRequest{Text: text, TaxonomyId: taxonomyID, TaxonomyVersion: int64(taxonomyVersion)}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Classify(callCtx, request)
		cancel()
		if err != nil {
			code := status.Code(err)
			log.Printf("model call failed attempt=%d code=%s", attempt, code)
			if (code == codes.Unavailable || code == codes.DeadlineExceeded) && attempt < maxAttempts {
				time.Sleep(backoff * time.Duration(attempt))
				continue
			}
			break
		}
		if reply.GetRefused() {
			break // the model's decision: asking again gets the same answer
		}
		return Result{Labels: append([]string{}, reply.GetLabels()...), Provenance: "model", ModelVersion: reply.GetModelVersion()}, nil
	}
	if err := rdb.Incr(ctx, config.FallbackKey).Err(); err != nil {
		return Result{}, err
	}
	return Result{Labels: rulesClassify(text), Provenance: "fallback", ModelVersion: "rules"}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import classifier.{Config, Result}
import contentclassifier.content_classifier.{ClassifyRequest, ModelGrpc}

object ModelClient {
  val MaxWaitMs = 10000L
  val BackoffMs = 100L

  private val stub = ModelGrpc.blockingStub(ManagedChannelBuilder.forTarget(Config.Model).usePlaintext().build())

  /** Labels for the text: ask the model until it answers. */
  def classify(text: String, taxonomyId: String, taxonomyVersion: Long): Result = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val request = ClassifyRequest(text = text, taxonomyId = taxonomyId, taxonomyVersion = taxonomyVersion)
    val until = System.currentTimeMillis() + MaxWaitMs
    while (System.currentTimeMillis() < until) {
      try {
        val reply = stub.classify(request)
        if (!reply.refused) return Result(reply.labels, "model", reply.modelVersion)
        Thread.sleep(BackoffMs)
      } catch {
        case e: StatusRuntimeException =>
          System.err.println(s"model call failed code=\${e.getStatus.getCode}")
          Thread.sleep(BackoffMs)
      }
    }
    Result(Seq("safe"), "model", "")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

import classifier.{Config, Result}
import contentclassifier.content_classifier.{ClassifyRequest, ModelGrpc}

object ModelClient {
  val DeadlineMs = 700L
  val MaxAttempts = 3
  val BackoffMs = 50L
  private val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  private val KeywordRules = Seq(
    "billing" -> Seq("invoice", "refund", "charge"),
    "support" -> Seq("broken", "error", "crash"),
    "security" -> Seq("password", "breach", "phishing")
  )

  private val stub = ModelGrpc.blockingStub(ManagedChannelBuilder.forTarget(Config.Model).usePlaintext().build())
  private val jedis = new JedisPooled("redis", 6379)

  /** Keyword evidence only: a text no rule matches goes to review, never to a safe label. */
  def rulesClassify(text: String): Seq[String] = {
    val lowered = text.toLowerCase
    val labels = KeywordRules.collect { case (label, words) if words.exists(lowered.contains) => label }
    if (labels.isEmpty) Seq(Config.ReviewLabel) else labels
  }

  /** Labels for the text from the model, or from the keyword rules when the model cannot answer. */
  def classify(text: String, taxonomyId: String, taxonomyVersion: Long): Result = {
    val request = ClassifyRequest(text = text, taxonomyId = taxonomyId, taxonomyVersion = taxonomyVersion)
    var attempt = 1
    while (attempt <= MaxAttempts) {
      try {
        val reply = stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).classify(request)
        if (!reply.refused) return Result(reply.labels, "model", reply.modelVersion)
        attempt = MaxAttempts + 1 // the model's decision: asking again gets the same answer
      } catch {
        case e: StatusRuntimeException if Retryable(e.getStatus.getCode) && attempt < MaxAttempts =>
          Thread.sleep(BackoffMs * attempt)
          attempt += 1
        case e: StatusRuntimeException =>
          System.err.println(s"model call failed attempt=$attempt code=\${e.getStatus.getCode}")
          attempt = MaxAttempts + 1
      }
    }
    jedis.incr(Config.FallbackKey)
    Result(rulesClassify(text), "fallback", "rules")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "classifier/config.h"  // config::kModel, kReviewLabel, kFallbackKey, redis()
#include "content_classifier.grpc.pb.h"

constexpr std::chrono::seconds kMaxWait{10};
constexpr std::chrono::milliseconds kBackoff{100};

auto stub = contentclassifier::Model::NewStub(grpc::CreateChannel(config::kModel, grpc::InsecureChannelCredentials()));

// One classification: the labels, where they came from, and the model that produced them.
struct Result {
  std::vector<std::string> labels;
  std::string provenance;
  std::string model_version;
};

// Labels for the text: ask the model until it answers.
Result classify(const std::string& text, const std::string& taxonomy_id, long taxonomy_version) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  contentclassifier::ClassifyRequest request;
  request.set_text(text);
  request.set_taxonomy_id(taxonomy_id);
  request.set_taxonomy_version(taxonomy_version);
  const auto until = std::chrono::steady_clock::now() + kMaxWait;
  while (std::chrono::steady_clock::now() < until) {
    grpc::ClientContext ctx;
    contentclassifier::ClassifyReply reply;
    const grpc::Status status = stub->Classify(&ctx, request, &reply);
    if (!status.ok()) {
      std::cerr << "model call failed code=" << status.error_code() << "\\n";
      std::this_thread::sleep_for(kBackoff);
      continue;
    }
    if (reply.refused()) {
      std::this_thread::sleep_for(kBackoff);
      continue;
    }
    return Result{std::vector<std::string>(reply.labels().begin(), reply.labels().end()), "model", reply.model_version()};
  }
  return Result{{"safe"}, "model", ""};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <iostream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "classifier/config.h"  // config::kModel, kReviewLabel, kFallbackKey, redis()
#include "content_classifier.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{700};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBackoff{50};
const std::vector<std::pair<std::string, std::vector<std::string>>> kKeywordRules = {
    {"billing", {"invoice", "refund", "charge"}},
    {"support", {"broken", "error", "crash"}},
    {"security", {"password", "breach", "phishing"}},
};

auto stub = contentclassifier::Model::NewStub(grpc::CreateChannel(config::kModel, grpc::InsecureChannelCredentials()));

// One classification: the labels, where they came from, and the model that produced them.
struct Result {
  std::vector<std::string> labels;
  std::string provenance;
  std::string model_version;
};

// Keyword evidence only: a text no rule matches goes to review, never to a safe label.
std::vector<std::string> rulesClassify(const std::string& text) {
  std::string lowered = text;
  std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](unsigned char c) { return std::tolower(c); });
  std::vector<std::string> labels;
  for (const auto& [label, words] : kKeywordRules)
    for (const auto& word : words)
      if (lowered.find(word) != std::string::npos) {
        labels.push_back(label);
        break;
      }
  if (labels.empty()) labels.push_back(config::kReviewLabel);
  return labels;
}

// Labels for the text from the model, or from the keyword rules when the model cannot answer.
Result classify(const std::string& text, const std::string& taxonomy_id, long taxonomy_version) {
  contentclassifier::ClassifyRequest request;
  request.set_text(text);
  request.set_taxonomy_id(taxonomy_id);
  request.set_taxonomy_version(taxonomy_version);
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    contentclassifier::ClassifyReply reply;
    const grpc::Status status = stub->Classify(&ctx, request, &reply);
    if (!status.ok()) {
      const auto code = status.error_code();
      std::cerr << "model call failed attempt=" << attempt << " code=" << code << "\\n";
      if ((code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED) && attempt < kMaxAttempts) {
        std::this_thread::sleep_for(kBackoff * attempt);
        continue;
      }
      break;
    }
    if (reply.refused()) break;  // the model's decision: asking again gets the same answer
    return Result{std::vector<std::string>(reply.labels().begin(), reply.labels().end()), "model", reply.model_version()};
  }
  config::redis().incr(config::kFallbackKey);
  return Result{rulesClassify(text), "fallback", "rules"};
}
`,
    },
  },
  harness: {
    python: `import grpc

import content_classifier_pb2
import content_classifier_pb2_grpc
from classifier import config, labeler

BROKEN = "my screen is broken"


class ModelServicer(content_classifier_pb2_grpc.ModelServicer):
    """The stand-in model: answers from classifier.labeler."""

    def Classify(self, request, context):
        labels, refused = labeler.classify(request.text)
        return content_classifier_pb2.ClassifyReply(labels=labels, refused=refused, model_version=labeler.MODEL_VERSION)


def _world(ctx):
    ctx.grpc.serve(content_classifier_pb2_grpc.add_ModelServicer_to_server, ModelServicer(), config.MODEL)
    return ctx.load("client")


def _calls(ctx):
    return ctx.grpc.calls_to("Classify")


def _fallbacks(ctx):
    return int(ctx.redis.get(config.FALLBACK_KEY) or 0)


def _outage(ctx, times=1000):
    ctx.grpc.fail("Classify", grpc.StatusCode.UNAVAILABLE, "model down", times=times, target=config.MODEL)


def check_deadline(ctx):
    m = _world(ctx)
    result = m.classify(BROKEN, "tx-support", 1)
    assert result.get("labels") == ["support"] and result.get("provenance") == "model", f"a healthy model must answer, got {result}"
    calls = _calls(ctx)
    assert len(calls) == 1, f"a healthy model must be called once, saw {len(calls)} calls"
    assert calls[0].timeout is not None, "the Classify call carries no deadline: a hung model holds the request for as long as it hangs"
    assert 0.6 <= calls[0].timeout <= 0.8, f"the deadline must be DEADLINE_S = 0.7 s, got {calls[0].timeout} s"
    ctx.grpc.set_latency("Classify", 5.0, config.MODEL)
    started = ctx.clock.time()
    result = m.classify(BROKEN, "tx-support", 1)
    waited = ctx.clock.time() - started
    assert waited <= 2.6, f"classify waited {waited:.1f} s on a model that hangs: three attempts of 0.7 s, then the fallback"
    assert result.get("provenance") == "fallback" and result.get("labels") == ["support"], f"a hung model must end in the rules fallback, got {result}"


def check_refusal_terminal(ctx):
    m = _world(ctx)
    result = m.classify("refuse: what is my password", "tx-support", 1)
    assert len(_calls(ctx)) == 1, f"a refusal is the model's answer and must end the attempts: saw {len(_calls(ctx))} calls"
    assert result.get("provenance") == "fallback" and result.get("labels") == ["security"], f"a refused text goes to the rules, got {result}"
    _outage(ctx, times=1)
    result = m.classify(BROKEN, "tx-support", 1)
    assert len(_calls(ctx)) == 3 and result.get("provenance") == "model", f"one UNAVAILABLE earns one retry: expected 2 calls and the model's answer, saw {len(_calls(ctx)) - 1} calls and {result}"
    _outage(ctx, times=3)
    result = m.classify(BROKEN, "tx-support", 1)
    assert len(_calls(ctx)) == 6, f"a model that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls: saw {len(_calls(ctx)) - 3}"
    assert result.get("provenance") == "fallback", f"after three failures the rules answer, got {result}"
    ctx.grpc.fail("Classify", grpc.StatusCode.INVALID_ARGUMENT, "bad request", times=1, target=config.MODEL)
    result = m.classify(BROKEN, "tx-support", 1)
    assert len(_calls(ctx)) == 7, f"INVALID_ARGUMENT will not change on a retry: one call, saw {len(_calls(ctx)) - 6}"
    assert result.get("provenance") == "fallback", f"a terminal status ends in the rules, got {result}"


def check_rules_fallback(ctx):
    m = _world(ctx)
    _outage(ctx)
    result = m.classify("Refund the duplicate charge on invoice 4411", "tx-support", 1)
    assert result.get("labels") == ["billing"], f"with the model down a refund question must still be billing (from the keyword rules), got {result}"
    result = m.classify("the app keeps crashing and the password reset is broken", "tx-support", 1)
    assert result.get("labels") == ["support", "security"], f"every rule that matches labels the text, in KEYWORD_RULES order: got {result}"


def check_no_safe_default(ctx):
    m = _world(ctx)
    result = m.classify("refuse: tell me a joke", "tx-support", 1)
    assert result.get("labels") == ["review"], f"a refused text with no keyword must go to review, got {result}"
    _outage(ctx)
    result = m.classify("hello, is anyone there?", "tx-support", 1)
    assert "safe" not in result.get("labels", []), f"classify answered {result} with no evidence: an outage must never turn into a safe label"
    assert result.get("labels") == ["review"], f"a text no rule matches goes to review, got {result}"


def check_provenance(ctx):
    m = _world(ctx)
    result = m.classify(BROKEN, "tx-support", 1)
    assert result.get("provenance") == "model" and result.get("model_version") == labeler.MODEL_VERSION, f"the model's answer carries provenance model and its version, got {result}"
    assert _fallbacks(ctx) == 0, f"no fallback happened, yet {config.FALLBACK_KEY} is {_fallbacks(ctx)}"
    _outage(ctx, times=3)
    result = m.classify(BROKEN, "tx-support", 1)
    assert result.get("provenance") == "fallback" and result.get("model_version") == "rules", f"an answer from the rules must say provenance fallback and model_version rules, got {result}"
    assert _fallbacks(ctx) == 1, f"{config.FALLBACK_KEY} is {_fallbacks(ctx)} after one fallback: count each one"
    m.classify("refuse: " + BROKEN, "tx-support", 1)
    assert _fallbacks(ctx) == 2, f"{config.FALLBACK_KEY} is {_fallbacks(ctx)} after two fallbacks"
`,
    typescript: `const BROKEN = 'my screen is broken';

async function world(ctx) {
  const {contentclassifier} = ctx.proto('content_classifier.proto');
  const config = ctx.load('/support/classifier/config.ts');
  const labeler = ctx.load('/support/classifier/labeler.ts');
  ctx.grpc.serve(
    contentclassifier.Model.service,
    {
      Classify(call, callback) {
        const {labels, refused} = labeler.classify(call.request.text);
        callback(null, {labels, refused, model_version: labeler.MODEL_VERSION});
      },
    },
    config.MODEL,
  );
  return {m: ctx.load('client'), config, labeler};
}

const calls = ctx => ctx.grpc.callsTo('Classify');
const fallbacks = (ctx, config) => Number(ctx.redis.get(config.FALLBACK_KEY) ?? 0);
const outage = (ctx, config, times = 1000) => ctx.grpc.fail('Classify', ctx.grpc.status.UNAVAILABLE, 'model down', times, config.MODEL);
const same = (labels, expected: string[]) => JSON.stringify(labels) === JSON.stringify(expected);

export async function check_deadline(ctx) {
  const {m, config} = await world(ctx);
  let result = await m.classify(BROKEN, 'tx-support', 1);
  assert(same(result.labels, ['support']) && result.provenance === 'model', \`a healthy model must answer, got \${JSON.stringify(result)}\`);
  assert.equal(calls(ctx).length, 1, \`a healthy model must be called once, saw \${calls(ctx).length} calls\`);
  const call = calls(ctx)[0];
  assert(call.timeout !== null && call.timeout !== undefined, 'the Classify call carries no deadline: a hung model holds the request for as long as it hangs');
  assert(0.6 <= call.timeout && call.timeout <= 0.8, \`the deadline must be DEADLINE_MS = 700 ms, got \${call.timeout} s\`);
  ctx.grpc.setLatency('Classify', 5.0, config.MODEL);
  const started = ctx.clock.now();
  result = await m.classify(BROKEN, 'tx-support', 1);
  const waited = (ctx.clock.now() - started) / 1000;
  assert(waited <= 2.6, \`classify waited \${waited.toFixed(1)} s on a model that hangs: three attempts of 0.7 s, then the fallback\`);
  assert(result.provenance === 'fallback' && same(result.labels, ['support']), \`a hung model must end in the rules fallback, got \${JSON.stringify(result)}\`);
}

export async function check_refusal_terminal(ctx) {
  const {m, config} = await world(ctx);
  let result = await m.classify('refuse: what is my password', 'tx-support', 1);
  assert.equal(calls(ctx).length, 1, \`a refusal is the model's answer and must end the attempts: saw \${calls(ctx).length} calls\`);
  assert(result.provenance === 'fallback' && same(result.labels, ['security']), \`a refused text goes to the rules, got \${JSON.stringify(result)}\`);
  outage(ctx, config, 1);
  result = await m.classify(BROKEN, 'tx-support', 1);
  assert(calls(ctx).length === 3 && result.provenance === 'model', \`one UNAVAILABLE earns one retry: expected 2 calls and the model's answer, saw \${calls(ctx).length - 1} calls and \${JSON.stringify(result)}\`);
  outage(ctx, config, 3);
  result = await m.classify(BROKEN, 'tx-support', 1);
  assert.equal(calls(ctx).length, 6, \`a model that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls: saw \${calls(ctx).length - 3}\`);
  assert.equal(result.provenance, 'fallback', \`after three failures the rules answer, got \${JSON.stringify(result)}\`);
  ctx.grpc.fail('Classify', ctx.grpc.status.INVALID_ARGUMENT, 'bad request', 1, config.MODEL);
  result = await m.classify(BROKEN, 'tx-support', 1);
  assert.equal(calls(ctx).length, 7, \`INVALID_ARGUMENT will not change on a retry: one call, saw \${calls(ctx).length - 6}\`);
  assert.equal(result.provenance, 'fallback', \`a terminal status ends in the rules, got \${JSON.stringify(result)}\`);
}

export async function check_rules_fallback(ctx) {
  const {m, config} = await world(ctx);
  outage(ctx, config);
  let result = await m.classify('Refund the duplicate charge on invoice 4411', 'tx-support', 1);
  assert(same(result.labels, ['billing']), \`with the model down a refund question must still be billing (from the keyword rules), got \${JSON.stringify(result)}\`);
  result = await m.classify('the app keeps crashing and the password reset is broken', 'tx-support', 1);
  assert(same(result.labels, ['support', 'security']), \`every rule that matches labels the text, in KEYWORD_RULES order: got \${JSON.stringify(result)}\`);
}

export async function check_no_safe_default(ctx) {
  const {m, config} = await world(ctx);
  let result = await m.classify('refuse: tell me a joke', 'tx-support', 1);
  assert(same(result.labels, ['review']), \`a refused text with no keyword must go to review, got \${JSON.stringify(result)}\`);
  outage(ctx, config);
  result = await m.classify('hello, is anyone there?', 'tx-support', 1);
  assert(!(result.labels ?? []).includes('safe'), \`classify answered \${JSON.stringify(result)} with no evidence: an outage must never turn into a safe label\`);
  assert(same(result.labels, ['review']), \`a text no rule matches goes to review, got \${JSON.stringify(result)}\`);
}

export async function check_provenance(ctx) {
  const {m, config, labeler} = await world(ctx);
  let result = await m.classify(BROKEN, 'tx-support', 1);
  assert(result.provenance === 'model' && result.model_version === labeler.MODEL_VERSION, \`the model's answer carries provenance model and its version, got \${JSON.stringify(result)}\`);
  assert.equal(fallbacks(ctx, config), 0, \`no fallback happened, yet \${config.FALLBACK_KEY} is \${fallbacks(ctx, config)}\`);
  outage(ctx, config, 3);
  result = await m.classify(BROKEN, 'tx-support', 1);
  assert(result.provenance === 'fallback' && result.model_version === 'rules', \`an answer from the rules must say provenance fallback and model_version rules, got \${JSON.stringify(result)}\`);
  assert.equal(fallbacks(ctx, config), 1, \`\${config.FALLBACK_KEY} is \${fallbacks(ctx, config)} after one fallback: count each one\`);
  await m.classify('refuse: ' + BROKEN, 'tx-support', 1);
  assert.equal(fallbacks(ctx, config), 2, \`\${config.FALLBACK_KEY} is \${fallbacks(ctx, config)} after two fallbacks\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"
	"time"

	"google.golang.org/grpc/codes"

	"classifier/config"
	pb "classifier/gen/content_classifier"
	"classifier/labeler"

	"leetbuild/harness"
)

const clientBroken = "my screen is broken"

// clientPeer is the stand-in model: answers from classifier/labeler.
type clientPeer struct {
	pb.UnimplementedModelServer
}

func (clientPeer) Classify(_ context.Context, req *pb.ClassifyRequest) (*pb.ClassifyReply, error) {
	labels, refused := labeler.Classify(req.GetText())
	return &pb.ClassifyReply{Labels: labels, Refused: refused, ModelVersion: labeler.Version}, nil
}

func clientWorld(ctx *harness.Ctx) {
	pb.RegisterModelServer(ctx.GRPC.Server(config.Model), &clientPeer{})
}

func clientClassify(ctx *harness.Ctx, text string) Result {
	result, err := classify(context.Background(), text, "tx-support", 1)
	ctx.NoError(err, "classify(%q)", text)
	return result
}

func clientCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Classify", "") }

func clientFallbacks(ctx *harness.Ctx) int {
	raw, _ := ctx.Redis.Get(config.FallbackKey)
	n, _ := strconv.Atoi(raw)
	return n
}

func clientOutage(ctx *harness.Ctx, times int) {
	ctx.GRPC.Fail("Classify", codes.Unavailable, "model down", times, config.Model)
}

func clientIs(labels []string, expected ...string) bool {
	if len(labels) != len(expected) {
		return false
	}
	for i := range labels {
		if labels[i] != expected[i] {
			return false
		}
	}
	return true
}

func CheckDeadline(ctx *harness.Ctx) {
	clientWorld(ctx)
	result := clientClassify(ctx, clientBroken)
	ctx.Assert(clientIs(result.Labels, "support") && result.Provenance == "model", "a healthy model must answer, got %+v", result)
	calls := clientCalls(ctx)
	ctx.Equal(len(calls), 1, "a healthy model must be called once; calls")
	ctx.Assert(calls[0].HasDeadline(), "the Classify call carries no deadline: a hung model holds the request for as long as it hangs")
	ctx.Assert(600*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 800*time.Millisecond, "the deadline must be 700 ms, got %v", calls[0].Timeout)
	ctx.GRPC.SetLatency("Classify", 5.0, config.Model)
	started := ctx.Clock.Now()
	result = clientClassify(ctx, clientBroken)
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(waited <= 2.6, "classify waited %.1f s on a model that hangs: three attempts of 0.7 s, then the fallback", waited)
	ctx.Assert(result.Provenance == "fallback" && clientIs(result.Labels, "support"), "a hung model must end in the rules fallback, got %+v", result)
}

func CheckRefusalTerminal(ctx *harness.Ctx) {
	clientWorld(ctx)
	result := clientClassify(ctx, "refuse: what is my password")
	ctx.Equal(len(clientCalls(ctx)), 1, "a refusal is the model's answer and must end the attempts; calls")
	ctx.Assert(result.Provenance == "fallback" && clientIs(result.Labels, "security"), "a refused text goes to the rules, got %+v", result)
	clientOutage(ctx, 1)
	result = clientClassify(ctx, clientBroken)
	ctx.Assert(len(clientCalls(ctx)) == 3 && result.Provenance == "model", "one UNAVAILABLE earns one retry: expected 2 calls and the model's answer, saw %d calls and %+v", len(clientCalls(ctx))-1, result)
	clientOutage(ctx, 3)
	result = clientClassify(ctx, clientBroken)
	ctx.Equal(len(clientCalls(ctx)), 6, "a model that stays UNAVAILABLE gets maxAttempts = 3 calls; calls so far")
	ctx.Equal(result.Provenance, "fallback", "after three failures the rules answer; the provenance")
	ctx.GRPC.Fail("Classify", codes.InvalidArgument, "bad request", 1, config.Model)
	result = clientClassify(ctx, clientBroken)
	ctx.Equal(len(clientCalls(ctx)), 7, "INVALID_ARGUMENT will not change on a retry: one call; calls so far")
	ctx.Equal(result.Provenance, "fallback", "a terminal status ends in the rules; the provenance")
}

func CheckRulesFallback(ctx *harness.Ctx) {
	clientWorld(ctx)
	clientOutage(ctx, 1000)
	result := clientClassify(ctx, "Refund the duplicate charge on invoice 4411")
	ctx.Assert(clientIs(result.Labels, "billing"), "with the model down a refund question must still be billing (from the keyword rules), got %+v", result)
	result = clientClassify(ctx, "the app keeps crashing and the password reset is broken")
	ctx.Assert(clientIs(result.Labels, "support", "security"), "every rule that matches labels the text, in keywordRules order: got %+v", result)
}

func CheckNoSafeDefault(ctx *harness.Ctx) {
	clientWorld(ctx)
	result := clientClassify(ctx, "refuse: tell me a joke")
	ctx.Assert(clientIs(result.Labels, "review"), "a refused text with no keyword must go to review, got %+v", result)
	clientOutage(ctx, 1000)
	result = clientClassify(ctx, "hello, is anyone there?")
	for _, label := range result.Labels {
		ctx.Assert(label != "safe", "classify answered %+v with no evidence: an outage must never turn into a safe label", result)
	}
	ctx.Assert(clientIs(result.Labels, "review"), "a text no rule matches goes to review, got %+v", result)
}

func CheckProvenance(ctx *harness.Ctx) {
	clientWorld(ctx)
	result := clientClassify(ctx, clientBroken)
	ctx.Assert(result.Provenance == "model" && result.ModelVersion == labeler.Version, "the model's answer carries provenance model and its version, got %+v", result)
	ctx.Equal(clientFallbacks(ctx), 0, "no fallback happened; %s", config.FallbackKey)
	clientOutage(ctx, 3)
	result = clientClassify(ctx, clientBroken)
	ctx.Assert(result.Provenance == "fallback" && result.ModelVersion == "rules", "an answer from the rules must say provenance fallback and ModelVersion rules, got %+v", result)
	ctx.Equal(clientFallbacks(ctx), 1, "after one fallback (count each one); %s", config.FallbackKey)
	clientClassify(ctx, "refuse: "+clientBroken)
	ctx.Equal(clientFallbacks(ctx), 2, "after two fallbacks; %s", config.FallbackKey)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <cstdlib>
#include <string>
#include <vector>

#include "classifier/labeler.h"

namespace {

const std::string kBroken = "my screen is broken";

// The stand-in model: answers from classifier/labeler.h.
class ClientPeer final : public contentclassifier::Model::Service {
 public:
  grpc::Status Classify(grpc::ServerContext*, const contentclassifier::ClassifyRequest* req, contentclassifier::ClassifyReply* reply) override {
    const auto verdict = labeler::classify(req->text());
    for (const auto& label : verdict.labels) reply->add_labels(label);
    reply->set_refused(verdict.refused);
    reply->set_model_version(labeler::kVersion);
    return grpc::Status::OK;
  }
};

void clientWorld(harness::Ctx& ctx) {
  static ClientPeer* peer = nullptr;
  delete peer;
  peer = new ClientPeer;
  ctx.GRPC.Server(config::kModel)->RegisterService(peer);
}

size_t calls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Classify").size(); }

long fallbacks(harness::Ctx& ctx) {
  const auto raw = ctx.Redis.Get(config::kFallbackKey);
  return raw ? std::strtol(raw->c_str(), nullptr, 10) : 0;
}

void outage(harness::Ctx& ctx, int times) { ctx.GRPC.Fail("Classify", grpc::StatusCode::UNAVAILABLE, "model down", times, config::kModel); }

bool is(const std::vector<std::string>& labels, const std::vector<std::string>& expected) { return labels == expected; }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  clientWorld(ctx);
  Result result = classify(kBroken, "tx-support", 1);
  ctx.Assert(is(result.labels, {"support"}) && result.provenance == "model", "a healthy model must answer, got %v from %q", result.labels, result.provenance);
  const auto all = ctx.GRPC.CallsTo("Classify");
  ctx.Equal(all.size(), 1, "a healthy model must be called once; calls");
  ctx.Assert(all[0].HasDeadline(), "the Classify call carries no deadline: a hung model holds the request for as long as it hangs");
  ctx.Assert(0.6 <= all[0].TimeoutSeconds() && all[0].TimeoutSeconds() <= 0.8, "the deadline must be 700 ms, got %vs", all[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("Classify", 5.0, config::kModel);
  const int64_t started = ctx.Clock.Now();
  result = classify(kBroken, "tx-support", 1);
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(waited <= 2.6, "classify waited %.1f s on a model that hangs: three attempts of 0.7 s, then the fallback", waited);
  ctx.Assert(result.provenance == "fallback" && is(result.labels, {"support"}), "a hung model must end in the rules fallback, got %v from %q", result.labels, result.provenance);
}

void CheckRefusalTerminal(harness::Ctx& ctx) {
  clientWorld(ctx);
  Result result = classify("refuse: what is my password", "tx-support", 1);
  ctx.Equal(calls(ctx), 1, "a refusal is the model's answer and must end the attempts; calls");
  ctx.Assert(result.provenance == "fallback" && is(result.labels, {"security"}), "a refused text goes to the rules, got %v from %q", result.labels, result.provenance);
  outage(ctx, 1);
  result = classify(kBroken, "tx-support", 1);
  ctx.Assert(calls(ctx) == 3 && result.provenance == "model", "one UNAVAILABLE earns one retry: expected 2 calls and the model's answer, saw %d calls and %q", calls(ctx) - 1, result.provenance);
  outage(ctx, 3);
  result = classify(kBroken, "tx-support", 1);
  ctx.Equal(calls(ctx), 6, "a model that stays UNAVAILABLE gets kMaxAttempts = 3 calls; calls so far");
  ctx.Equal(result.provenance, "fallback", "after three failures the rules answer; the provenance");
  ctx.GRPC.Fail("Classify", grpc::StatusCode::INVALID_ARGUMENT, "bad request", 1, config::kModel);
  result = classify(kBroken, "tx-support", 1);
  ctx.Equal(calls(ctx), 7, "INVALID_ARGUMENT will not change on a retry: one call; calls so far");
  ctx.Equal(result.provenance, "fallback", "a terminal status ends in the rules; the provenance");
}

void CheckRulesFallback(harness::Ctx& ctx) {
  clientWorld(ctx);
  outage(ctx, 1000);
  Result result = classify("Refund the duplicate charge on invoice 4411", "tx-support", 1);
  ctx.Assert(is(result.labels, {"billing"}), "with the model down a refund question must still be billing (from the keyword rules), got %v", result.labels);
  result = classify("the app keeps crashing and the password reset is broken", "tx-support", 1);
  ctx.Assert(is(result.labels, {"support", "security"}), "every rule that matches labels the text, in kKeywordRules order: got %v", result.labels);
}

void CheckNoSafeDefault(harness::Ctx& ctx) {
  clientWorld(ctx);
  Result result = classify("refuse: tell me a joke", "tx-support", 1);
  ctx.Assert(is(result.labels, {"review"}), "a refused text with no keyword must go to review, got %v", result.labels);
  outage(ctx, 1000);
  result = classify("hello, is anyone there?", "tx-support", 1);
  ctx.Assert(std::find(result.labels.begin(), result.labels.end(), "safe") == result.labels.end(),
             "classify answered %v with no evidence: an outage must never turn into a safe label", result.labels);
  ctx.Assert(is(result.labels, {"review"}), "a text no rule matches goes to review, got %v", result.labels);
}

void CheckProvenance(harness::Ctx& ctx) {
  clientWorld(ctx);
  Result result = classify(kBroken, "tx-support", 1);
  ctx.Assert(result.provenance == "model" && result.model_version == labeler::kVersion, "the model's answer carries provenance model and its version, got %q %q", result.provenance, result.model_version);
  ctx.Equal(fallbacks(ctx), 0, "no fallback happened; %s", config::kFallbackKey);
  outage(ctx, 3);
  result = classify(kBroken, "tx-support", 1);
  ctx.Assert(result.provenance == "fallback" && result.model_version == "rules", "an answer from the rules must say provenance fallback and model_version rules, got %q %q", result.provenance, result.model_version);
  ctx.Equal(fallbacks(ctx), 1, "after one fallback (count each one); %s", config::kFallbackKey);
  classify("refuse: " + kBroken, "tx-support", 1);
  ctx.Equal(fallbacks(ctx), 2, "after two fallbacks; %s", config::kFallbackKey);
}
`,
  },
  hints: [
    'A model that hangs for five seconds holds the request for five seconds, a text the model refuses is asked again a hundred times, and during an outage every document comes back `safe` as if the model had said so.',
    'The call has no deadline, and the loop retries every failure and every refusal until ten seconds pass; then it answers a fixed label with provenance `model` and counts nothing.',
    '`timeout=DEADLINE_S` on each call; loop over `range(1, MAX_ATTEMPTS + 1)` retrying only `UNAVAILABLE`/`DEADLINE_EXCEEDED`; on a refusal or anything else, `rules_classify(text)` with provenance `fallback`, model_version `rules`, and `INCR FALLBACK_KEY`.',
  ],
  debrief: `The loop sorts what the model can say into kinds. A transient status is worth a bounded retry; any other status, and a refusal, will say the same thing next time, so it ends the attempts. The deadline sits on the call because a sleep between calls does nothing about a call that never returns, and three 700 ms attempts keep the worst case near two seconds. The fallback trades quality for availability, which is only acceptable when it is visible: provenance lets downstream code treat a rules answer differently, and the counter turns an outage into a spike someone can alert on. The rules cannot invent evidence, so a text they cannot place goes to review. Production clients add a circuit breaker that skips the model while it fails, and one budget for the whole request instead of one per call.`,
};
