import type {Step} from '@/lib/types';

export const mtClientStep: Step = {
  id: 'dependency',
  title: 'MT calls with a deadline and a marked fallback',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['api', 'mt', 'redis'],
  task: `## Task

**Starting point.** The starter is the MT client every translation goes through:
\`translate_segment(tenant, text, source, target, pinned)\` answers from translation memory (step 2,
provided as \`translate.glossary\`) when it can, otherwise calls \`Translator.Translate\` on
\`mt:9000\` with the pinned glossary's terms up to \`MAX_ATTEMPTS\` times, logging each \`RpcError\`,
and remembers what it ends up with. With the model healthy it translates; it hides four flaws.

**Failure mode the checks target.** The model stalls and every request stalls with it; a language
pair the model does not serve is sent three times and comes back as English; an outage returns the
source text as if it were French; and translation memory keeps that English for an hour after the
model recovers.

\`\`\`proto
service Translator { rpc Translate(TranslateRequest) returns (TranslateReply); }  // INVALID_ARGUMENT: pair not served
\`\`\`

- Every attempt carries a **\`DEADLINE_S\` = 2 s** deadline.
- Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retried, within \`MAX_ATTEMPTS\` = 3;
  \`INVALID_ARGUMENT\` raises \`PairRejected\` at once.
- When no attempt answered, return \`{"text": text, "marker": UNTRANSLATED}\` (\`"untranslated"\`)
  and remember nothing: only a reply from the model goes to \`tm_put\`.`,
  sequence: {
    participants: ['Translation API', 'Translation memory', 'Translator'],
    messages: [
      {from: 'Translation API', to: 'Translation memory', label: 'tm_get(tenant, pair, version, text)', kind: 'sync'},
      {from: 'Translation memory', to: 'Translation API', label: 'miss', kind: 'reply'},
      {from: 'Translation API', to: 'Translator', label: 'Translate · deadline 2 s · ≤ 3 attempts', kind: 'sync'},
      {
        from: 'Translator',
        to: 'Translation API',
        label: 'reply · UNAVAILABLE → retry · INVALID_ARGUMENT → PairRejected',
        kind: 'reply',
      },
      {from: 'Translation API', to: 'Translation memory', label: 'tm_put only for a reply', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Puts a 2-second deadline on every attempt',
      detail:
        'Each `Translate` call carries `DEADLINE_S` (2 s), so a stalled model costs at most three short attempts. The starter calls with no deadline and waits as long as the model does.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*2\b/, /Translate\([^\n]*timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*2000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*2\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*2L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{2\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'retriable-only',
      title: 'Retries an outage, never a rejected language pair',
      detail:
        '`UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried; `INVALID_ARGUMENT` raises `PairRejected` after one call. The starter retries every status code and then returns the source text.',
      match: {
        python: {all: [/INVALID_ARGUMENT/, /raise PairRejected/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        typescript: {all: [/INVALID_ARGUMENT/, /throw new PairRejected/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        go: {all: [/codes\.InvalidArgument/, /ErrPairRejected/, /codes\.Unavailable/, /codes\.DeadlineExceeded/]},
        scala: {all: [/INVALID_ARGUMENT/, /throw new PairRejected/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        cpp: {all: [/INVALID_ARGUMENT/, /throw PairRejected/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'marked-fallback',
      title: 'Marks the fallback untranslated',
      detail:
        'When no attempt answered, the result is the source text with `marker` set to `untranslated`, which the endpoint turns into a 503. The starter returns the source text with no marker, as if it were the translation.',
      match: {
        python: {all: [/UNTRANSLATED\s*=\s*["']untranslated["']/, /["']marker["']:\s*UNTRANSLATED/]},
        typescript: {all: [/UNTRANSLATED\s*=\s*['"]untranslated['"]/, /marker:\s*UNTRANSLATED/]},
        go: {all: [/untranslated\s*=\s*"untranslated"/, /Marker:\s*untranslated/]},
        scala: {all: [/Untranslated\s*=\s*"untranslated"/, /Some\(Untranslated\)/]},
        cpp: {all: [/kUntranslated\s*=\s*"untranslated"/, /\{text,\s*kUntranslated\}/]},
      },
    },
    {
      id: 'no-cached-fallback',
      title: 'Remembers only what the model translated',
      detail:
        "Translation memory gets the model's reply (`tm_put(…, reply.text)`) and nothing on the fallback path, so the first request after recovery reaches the model. The starter remembers the source text it fell back to.",
      match: {
        python: {all: [/tm_put\([^\n]*reply\.text\)/]},
        typescript: {all: [/tmPut\([^\n]*reply\.text\)/]},
        go: {all: [/TMPut\([^\n]*reply\.GetText\(\)\)/]},
        scala: {all: [/tmPut\([^\n]*reply\.text\)/]},
        cpp: {all: [/tmPut\([^\n]*reply\.text\(\)\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

import translation_service_pb2
import translation_service_pb2_grpc
from translate.glossary import tm_get, tm_put

MAX_ATTEMPTS = 3
log = logging.getLogger("mt")

stub = translation_service_pb2_grpc.TranslatorStub(grpc.insecure_channel("mt:9000"))


class PairRejected(Exception):
    """The model does not serve this language pair: a caller bug, not an outage."""


def translate_segment(tenant: str, text: str, source: str, target: str, pinned: dict) -> dict:
    """{"text", "marker"} for one segment under the pinned glossary ({"version", "terms"})."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    version = pinned["version"]
    cached = tm_get(tenant, source, target, version, text)
    if cached is not None:
        return {"text": cached, "marker": None}
    terms = [translation_service_pb2.Term(source=term, target=pinned["terms"][term]) for term in sorted(pinned["terms"])]
    request = translation_service_pb2.TranslateRequest(text=text, source=source, target=target, glossary_version=version, terms=terms)
    translation = text
    for attempt in range(MAX_ATTEMPTS):
        try:
            translation = stub.Translate(request).text
            break
        except grpc.RpcError as exc:
            log.warning("mt attempt %d failed: %s", attempt + 1, exc.code())
    tm_put(tenant, source, target, version, text, translation)
    return {"text": translation, "marker": None}
`,
      solution: `import logging

import grpc

import translation_service_pb2
import translation_service_pb2_grpc
from translate.glossary import tm_get, tm_put

DEADLINE_S = 2
MAX_ATTEMPTS = 3
RETRIABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
UNTRANSLATED = "untranslated"
log = logging.getLogger("mt")

stub = translation_service_pb2_grpc.TranslatorStub(grpc.insecure_channel("mt:9000"))


class PairRejected(Exception):
    """The model does not serve this language pair: a caller bug, not an outage."""


def translate_segment(tenant: str, text: str, source: str, target: str, pinned: dict) -> dict:
    """{"text", "marker"} for one segment under the pinned glossary ({"version", "terms"})."""
    version = pinned["version"]
    cached = tm_get(tenant, source, target, version, text)
    if cached is not None:
        return {"text": cached, "marker": None}
    terms = [translation_service_pb2.Term(source=term, target=pinned["terms"][term]) for term in sorted(pinned["terms"])]
    request = translation_service_pb2.TranslateRequest(text=text, source=source, target=target, glossary_version=version, terms=terms)
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = stub.Translate(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            log.warning("mt attempt %d failed: %s", attempt + 1, exc.code())
            if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
                raise PairRejected(exc.details()) from exc  # retrying cannot change the answer
            if exc.code() not in RETRIABLE:
                break
            continue
        tm_put(tenant, source, target, version, text, reply.text)
        return {"text": reply.text, "marker": None}
    # The model never answered: the caller gets its own text back, marked, and nothing is remembered.
    return {"text": text, "marker": UNTRANSLATED}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Glossary, tmGet, tmPut} from 'translate/glossary';

export const MAX_ATTEMPTS = 3;

export interface Translation {
  text: string;
  marker: string | null;
}

interface TranslateRequest {
  text: string;
  source: string;
  target: string;
  glossary_version: number;
  terms: {source: string; target: string}[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('translation_service.proto')) as unknown as {
  translationsvc: {Translator: grpc.ServiceClientConstructor};
};
const stub = new pkg.translationsvc.Translator('mt:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Translate(request: TranslateRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{text: string; model: string}>;
};

/** The model does not serve this language pair: a caller bug, not an outage. */
export class PairRejected extends Error {}

/** One segment under the pinned glossary. */
export async function translateSegment(tenant: string, text: string, source: string, target: string, pinned: Glossary): Promise<Translation> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const cached = await tmGet(tenant, source, target, pinned.version, text);
  if (cached !== null) return {text: cached, marker: null};
  const terms = Object.keys(pinned.terms)
    .sort()
    .map(term => ({source: term, target: pinned.terms[term]}));
  const request = {text, source, target, glossary_version: pinned.version, terms};
  let translation = text;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      translation = (await stub.Translate(request, new grpc.Metadata(), {})).text;
      break;
    } catch (e) {
      console.warn(\`mt attempt \${attempt + 1} failed: \${grpc.status[(e as grpc.ServiceError).code]}\`);
    }
  }
  await tmPut(tenant, source, target, pinned.version, text, translation);
  return {text: translation, marker: null};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Glossary, tmGet, tmPut} from 'translate/glossary';

export const DEADLINE_MS = 2000;
export const MAX_ATTEMPTS = 3;
export const UNTRANSLATED = 'untranslated';
const RETRIABLE = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

export interface Translation {
  text: string;
  marker: string | null;
}

interface TranslateRequest {
  text: string;
  source: string;
  target: string;
  glossary_version: number;
  terms: {source: string; target: string}[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('translation_service.proto')) as unknown as {
  translationsvc: {Translator: grpc.ServiceClientConstructor};
};
const stub = new pkg.translationsvc.Translator('mt:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Translate(request: TranslateRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{text: string; model: string}>;
};

/** The model does not serve this language pair: a caller bug, not an outage. */
export class PairRejected extends Error {}

/** One segment under the pinned glossary. */
export async function translateSegment(tenant: string, text: string, source: string, target: string, pinned: Glossary): Promise<Translation> {
  const cached = await tmGet(tenant, source, target, pinned.version, text);
  if (cached !== null) return {text: cached, marker: null};
  const terms = Object.keys(pinned.terms)
    .sort()
    .map(term => ({source: term, target: pinned.terms[term]}));
  const request = {text, source, target, glossary_version: pinned.version, terms};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let reply;
    try {
      reply = await stub.Translate(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      console.warn(\`mt attempt \${attempt + 1} failed: \${grpc.status[code]}\`);
      if (code === grpc.status.INVALID_ARGUMENT) throw new PairRejected(details); // retrying cannot change the answer
      if (!RETRIABLE.includes(code)) break;
      continue;
    }
    await tmPut(tenant, source, target, pinned.version, text, reply.text);
    return {text: reply.text, marker: null};
  }
  // The model never answered: the caller gets its own text back, marked, and nothing is remembered.
  return {text, marker: UNTRANSLATED};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"log"
	"sort"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "translate/gen/translation_service"
	"translate/glossary" // glossary.Glossary, glossary.TMGet, glossary.TMPut
)

const maxAttempts = 3

var (
	conn, _ = grpc.NewClient("mt:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	stub    = pb.NewTranslatorClient(conn)
)

// ErrPairRejected: the model does not serve this language pair, a caller bug, not an outage.
var ErrPairRejected = errors.New("language pair rejected")

// Translation is one segment's result: the text and its marker ("" for none).
type Translation struct {
	Text   string
	Marker string
}

func translateRequest(text, source, target string, pinned glossary.Glossary) *pb.TranslateRequest {
	names := make([]string, 0, len(pinned.Terms))
	for term := range pinned.Terms {
		names = append(names, term)
	}
	sort.Strings(names)
	request := &pb.TranslateRequest{Text: text, Source: source, Target: target, GlossaryVersion: pinned.Version}
	for _, term := range names {
		request.Terms = append(request.Terms, &pb.Term{Source: term, Target: pinned.Terms[term]})
	}
	return request
}

// translateSegment translates one segment under the pinned glossary.
func translateSegment(ctx context.Context, tenant, text, source, target string, pinned glossary.Glossary) (Translation, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if cached, ok := glossary.TMGet(ctx, tenant, source, target, pinned.Version, text); ok {
		return Translation{Text: cached}, nil
	}
	request := translateRequest(text, source, target, pinned)
	translation := text
	for attempt := 0; attempt < maxAttempts; attempt++ {
		reply, err := stub.Translate(ctx, request)
		if err == nil {
			translation = reply.GetText()
			break
		}
		log.Printf("mt attempt %d failed: %v", attempt+1, status.Code(err))
	}
	if err := glossary.TMPut(ctx, tenant, source, target, pinned.Version, text, translation); err != nil {
		return Translation{}, err
	}
	return Translation{Text: translation}, nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "translate/gen/translation_service"
	"translate/glossary" // glossary.Glossary, glossary.TMGet, glossary.TMPut
)

const (
	deadline     = 2 * time.Second
	maxAttempts  = 3
	untranslated = "untranslated"
)

var (
	conn, _ = grpc.NewClient("mt:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	stub    = pb.NewTranslatorClient(conn)
)

// ErrPairRejected: the model does not serve this language pair, a caller bug, not an outage.
var ErrPairRejected = errors.New("language pair rejected")

// Translation is one segment's result: the text and its marker ("" for none).
type Translation struct {
	Text   string
	Marker string
}

func translateRequest(text, source, target string, pinned glossary.Glossary) *pb.TranslateRequest {
	names := make([]string, 0, len(pinned.Terms))
	for term := range pinned.Terms {
		names = append(names, term)
	}
	sort.Strings(names)
	request := &pb.TranslateRequest{Text: text, Source: source, Target: target, GlossaryVersion: pinned.Version}
	for _, term := range names {
		request.Terms = append(request.Terms, &pb.Term{Source: term, Target: pinned.Terms[term]})
	}
	return request
}

// translateSegment translates one segment under the pinned glossary.
func translateSegment(ctx context.Context, tenant, text, source, target string, pinned glossary.Glossary) (Translation, error) {
	if cached, ok := glossary.TMGet(ctx, tenant, source, target, pinned.Version, text); ok {
		return Translation{Text: cached}, nil
	}
	request := translateRequest(text, source, target, pinned)
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Translate(callCtx, request)
		cancel()
		if err == nil {
			if err := glossary.TMPut(ctx, tenant, source, target, pinned.Version, text, reply.GetText()); err != nil {
				return Translation{}, err
			}
			return Translation{Text: reply.GetText()}, nil
		}
		code := status.Code(err)
		log.Printf("mt attempt %d failed: %v", attempt+1, code)
		if code == codes.InvalidArgument {
			return Translation{}, fmt.Errorf("%w: %s", ErrPairRejected, status.Convert(err).Message()) // retrying cannot change the answer
		}
		if code != codes.Unavailable && code != codes.DeadlineExceeded {
			break
		}
	}
	// The model never answered: the caller gets its own text back, marked, and nothing is remembered.
	return Translation{Text: text, Marker: untranslated}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import translate.Glossary // Glossary.Pinned, Glossary.tmGet, Glossary.tmPut
import translationsvc.translation_service.{Term, TranslateRequest, TranslatorGrpc}

/** The model does not serve this language pair: a caller bug, not an outage. */
final class PairRejected(message: String) extends Exception(message)

object Client {
  val MaxAttempts = 3

  /** One segment's result: the text and its marker. */
  final case class Translation(text: String, marker: Option[String])

  private val stub = TranslatorGrpc.blockingStub(ManagedChannelBuilder.forAddress("mt", 9000).usePlaintext().build())

  /** One segment under the pinned glossary. */
  def translateSegment(tenant: String, text: String, source: String, target: String, pinned: Glossary.Pinned): Translation = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    Glossary.tmGet(tenant, source, target, pinned.version, text) match {
      case Some(cached) => Translation(cached, None)
      case None =>
        val terms = pinned.terms.toSeq.sortBy(_._1).map { case (term, translation) => Term(term, translation) }
        val request = TranslateRequest(text, source, target, pinned.version, terms)
        var translation = text
        var attempt = 0
        var done = false
        while (!done && attempt < MaxAttempts) {
          attempt += 1
          try { translation = stub.translate(request).text; done = true }
          catch { case e: StatusRuntimeException => System.err.println(s"mt attempt $attempt failed: \${e.getStatus.getCode}") }
        }
        Glossary.tmPut(tenant, source, target, pinned.version, text, translation)
        Translation(translation, None)
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import translate.Glossary // Glossary.Pinned, Glossary.tmGet, Glossary.tmPut
import translationsvc.translation_service.{Term, TranslateRequest, TranslatorGrpc}

/** The model does not serve this language pair: a caller bug, not an outage. */
final class PairRejected(message: String) extends Exception(message)

object Client {
  val DeadlineSeconds = 2L
  val MaxAttempts = 3
  val Untranslated = "untranslated"
  private val Retriable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  /** One segment's result: the text and its marker. */
  final case class Translation(text: String, marker: Option[String])

  private val stub = TranslatorGrpc.blockingStub(ManagedChannelBuilder.forAddress("mt", 9000).usePlaintext().build())

  /** One segment under the pinned glossary. */
  def translateSegment(tenant: String, text: String, source: String, target: String, pinned: Glossary.Pinned): Translation =
    Glossary.tmGet(tenant, source, target, pinned.version, text) match {
      case Some(cached) => Translation(cached, None)
      case None =>
        val terms = pinned.terms.toSeq.sortBy(_._1).map { case (term, translation) => Term(term, translation) }
        val request = TranslateRequest(text, source, target, pinned.version, terms)
        var attempt = 0
        var result: Option[Translation] = None
        while (result.isEmpty && attempt < MaxAttempts) {
          attempt += 1
          try {
            val reply = stub.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).translate(request)
            Glossary.tmPut(tenant, source, target, pinned.version, text, reply.text)
            result = Some(Translation(reply.text, None))
          } catch {
            case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.INVALID_ARGUMENT =>
              throw new PairRejected(Option(e.getStatus.getDescription).getOrElse("language pair rejected")) // retrying cannot change the answer
            case e: StatusRuntimeException if !Retriable.contains(e.getStatus.getCode) => attempt = MaxAttempts
            case e: StatusRuntimeException => System.err.println(s"mt attempt $attempt failed: \${e.getStatus.getCode}")
          }
        }
        // The model never answered: the caller gets its own text back, marked, and nothing is remembered.
        result.getOrElse(Translation(text, Some(Untranslated)))
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <iostream>
#include <stdexcept>
#include <string>

#include "translate/glossary.h"  // glossary::Glossary, glossary::tmGet, glossary::tmPut
#include "translation_service.grpc.pb.h"

constexpr int kMaxAttempts = 3;

auto model = translationsvc::Translator::NewStub(grpc::CreateChannel("mt:9000", grpc::InsecureChannelCredentials()));

// The model does not serve this language pair: a caller bug, not an outage.
struct PairRejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// One segment's result: the text and its marker ("" for none).
struct Translation {
  std::string text;
  std::string marker;
};

translationsvc::TranslateRequest translateRequest(const std::string& text, const std::string& source, const std::string& target, const glossary::Glossary& pinned) {
  translationsvc::TranslateRequest request;
  request.set_text(text);
  request.set_source(source);
  request.set_target(target);
  request.set_glossary_version(pinned.version);
  for (const auto& [term, translation] : pinned.terms) {
    translationsvc::Term* t = request.add_terms();
    t->set_source(term);
    t->set_target(translation);
  }
  return request;
}

// One segment under the pinned glossary.
Translation translateSegment(const std::string& tenant, const std::string& text, const std::string& source, const std::string& target,
                             const glossary::Glossary& pinned) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (const auto cached = glossary::tmGet(tenant, source, target, pinned.version, text)) return {*cached, ""};
  const translationsvc::TranslateRequest request = translateRequest(text, source, target, pinned);
  std::string translation = text;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    translationsvc::TranslateReply reply;
    const grpc::Status status = model->Translate(&ctx, request, &reply);
    if (status.ok()) {
      translation = reply.text();
      break;
    }
    std::cerr << "mt attempt " << attempt + 1 << " failed: " << status.error_code() << "\\n";
  }
  glossary::tmPut(tenant, source, target, pinned.version, text, translation);
  return {translation, ""};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>

#include "translate/glossary.h"  // glossary::Glossary, glossary::tmGet, glossary::tmPut
#include "translation_service.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{2};
constexpr int kMaxAttempts = 3;
const std::string kUntranslated = "untranslated";

auto model = translationsvc::Translator::NewStub(grpc::CreateChannel("mt:9000", grpc::InsecureChannelCredentials()));

// The model does not serve this language pair: a caller bug, not an outage.
struct PairRejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// One segment's result: the text and its marker ("" for none).
struct Translation {
  std::string text;
  std::string marker;
};

translationsvc::TranslateRequest translateRequest(const std::string& text, const std::string& source, const std::string& target, const glossary::Glossary& pinned) {
  translationsvc::TranslateRequest request;
  request.set_text(text);
  request.set_source(source);
  request.set_target(target);
  request.set_glossary_version(pinned.version);
  for (const auto& [term, translation] : pinned.terms) {
    translationsvc::Term* t = request.add_terms();
    t->set_source(term);
    t->set_target(translation);
  }
  return request;
}

// One segment under the pinned glossary.
Translation translateSegment(const std::string& tenant, const std::string& text, const std::string& source, const std::string& target,
                             const glossary::Glossary& pinned) {
  if (const auto cached = glossary::tmGet(tenant, source, target, pinned.version, text)) return {*cached, ""};
  const translationsvc::TranslateRequest request = translateRequest(text, source, target, pinned);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    translationsvc::TranslateReply reply;
    const grpc::Status status = model->Translate(&ctx, request, &reply);
    if (status.ok()) {
      glossary::tmPut(tenant, source, target, pinned.version, text, reply.text());
      return {reply.text(), ""};
    }
    std::cerr << "mt attempt " << attempt + 1 << " failed: " << status.error_code() << "\\n";
    // Retrying cannot change a rejected pair.
    if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) throw PairRejected(status.error_message());
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE && status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED) break;
  }
  // The model never answered: the caller gets its own text back, marked, and nothing is remembered.
  return {text, kUntranslated};
}
`,
    },
  },
  harness: {
    python: `import grpc

import translation_service_pb2
import translation_service_pb2_grpc
from translate.glossary import tm_key

PINNED = {"version": 2, "terms": {"Dashboard": "Tableau de bord"}}
SAMPLE = "Open the Dashboard"
TRANSLATED = "[fr] Open the Tableau de bord"
SERVED = {"en", "fr", "de", "es", "ja", "pt"}


class Translator(translation_service_pb2_grpc.TranslatorServicer):
    """The model: '[target] text' with every glossary term applied; a pair it does not serve is INVALID_ARGUMENT."""

    def Translate(self, request, context):
        if request.source not in SERVED or request.target not in SERVED or request.source == request.target:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, f"pair {request.source}->{request.target} is not served")
        text = request.text
        for term in request.terms:
            text = text.replace(term.source, term.target)
        return translation_service_pb2.TranslateReply(text=f"[{request.target}] {text}", model="mt-2026-10")


def _client(ctx):
    ctx.grpc.serve(translation_service_pb2_grpc.add_TranslatorServicer_to_server, Translator())
    return ctx.load("client")


def _translate(m, text=SAMPLE, target="fr"):
    return m.translate_segment("acme", text, "en", target, PINNED)


def check_deadline(ctx):
    m = _client(ctx)
    healthy = _translate(m)
    assert healthy == {"text": TRANSLATED, "marker": None}, f"with the model healthy translate_segment answered {healthy}, expected {TRANSLATED!r}"
    ctx.grpc.set_latency("Translate", 10.0)
    result = _translate(m, "Close the Dashboard")
    calls = ctx.grpc.calls_to("Translate")[1:]
    for call in calls:
        assert call.timeout is not None, "a Translate call carries no deadline: a stalled model holds every request as long as it stalls"
        assert 1.5 <= call.timeout <= 2.5, f"a Translate call carries a {call.timeout} s deadline, expected DEADLINE_S = 2"
    assert len(calls) == 3, f"a model slower than the deadline was called {len(calls)} times, expected MAX_ATTEMPTS = 3 attempts of 2 s"
    assert result["text"] == "Close the Dashboard", f"a model that never answered in time produced {result}"


def check_retriable_only(ctx):
    m = _client(ctx)
    try:
        result = _translate(m, target="tlh")
    except m.PairRejected:
        pass
    except Exception as exc:
        raise AssertionError(f"a pair the model rejects raised {type(exc).__name__}: {exc}, expected PairRejected")
    else:
        raise AssertionError(f"a pair the model rejects (INVALID_ARGUMENT) returned {result} instead of raising PairRejected")
    calls = len(ctx.grpc.calls_to("Translate"))
    assert calls == 1, f"a rejected language pair was sent to the model {calls} times: INVALID_ARGUMENT is a caller bug, retrying cannot change it"
    ctx.grpc.fail("Translate", grpc.StatusCode.UNAVAILABLE, times=2)
    result = _translate(m)
    assert result == {"text": TRANSLATED, "marker": None}, f"two UNAVAILABLE answers then a reply: translate_segment answered {result}, expected the translation from the third attempt"
    assert len(ctx.grpc.calls_to("Translate")) == 4, "UNAVAILABLE is retried: three attempts for the second segment"


def check_marked_fallback(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Translate", grpc.StatusCode.UNAVAILABLE, times=3)
    result = _translate(m)
    assert len(ctx.grpc.calls_to("Translate")) == 3, f"an outage got {len(ctx.grpc.calls_to('Translate'))} attempts, expected 3"
    assert result == {"text": SAMPLE, "marker": "untranslated"}, f"after three UNAVAILABLE attempts translate_segment answered {result}: the caller cannot tell English from French. Return the source text with marker untranslated"


def check_no_cached_fallback(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Translate", grpc.StatusCode.UNAVAILABLE, times=3)
    _translate(m)
    key = tm_key("acme", "en", "fr", 2, SAMPLE)
    assert not ctx.redis.exists(key), f"translation memory holds {ctx.redis.get(key)!r} for a segment the model never translated: it is served as French for the next hour"
    result = _translate(m)
    assert result == {"text": TRANSLATED, "marker": None}, f"once the model recovered translate_segment answered {result}, expected {TRANSLATED!r}"
    assert len(ctx.grpc.calls_to("Translate")) == 4, "after the outage the next request must reach the model"
    assert ctx.redis.get(key) == TRANSLATED, f"the model's translation must be remembered under {key}"
    _translate(m)
    assert len(ctx.grpc.calls_to("Translate")) == 4, "a remembered translation is answered without a call"
`,
    typescript: `const PINNED = {version: 2, terms: {Dashboard: 'Tableau de bord'}};
const SAMPLE = 'Open the Dashboard';
const TRANSLATED = '[fr] Open the Tableau de bord';
const SERVED = ['en', 'fr', 'de', 'es', 'ja', 'pt'];

/** The model: '[target] text' with every glossary term applied; a pair it does not serve is INVALID_ARGUMENT. */
function client(ctx) {
  const pkg = ctx.proto('translation_service.proto');
  ctx.grpc.serve(pkg.translationsvc.Translator.service, {
    Translate(call, callback) {
      const {source, target, terms} = call.request;
      if (!SERVED.includes(source) || !SERVED.includes(target) || source === target) {
        return callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: \`pair \${source}->\${target} is not served\`});
      }
      let text = call.request.text;
      for (const term of terms ?? []) text = text.split(term.source).join(term.target);
      callback(null, {text: \`[\${target}] \${text}\`, model: 'mt-2026-10'});
    },
  });
  return {m: ctx.load('client'), glossary: ctx.load('/support/translate/glossary.ts')};
}

const translate = (m, text = SAMPLE, target = 'fr') => m.translateSegment('acme', text, 'en', target, PINNED);

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  const healthy = await translate(m);
  assert.deepStrictEqual(healthy, {text: TRANSLATED, marker: null}, \`with the model healthy translateSegment answered \${JSON.stringify(healthy)}\`);
  ctx.grpc.setLatency('Translate', 10.0);
  const result = await translate(m, 'Close the Dashboard');
  const calls = ctx.grpc.callsTo('Translate').slice(1);
  for (const call of calls) {
    assert(call.timeout !== null, 'a Translate call carries no deadline: a stalled model holds every request as long as it stalls');
    assert(1.5 <= call.timeout && call.timeout <= 2.5, \`a Translate call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 2000\`);
  }
  assert.equal(calls.length, 3, \`a model slower than the deadline was called \${calls.length} times, expected MAX_ATTEMPTS = 3 attempts of 2 s\`);
  assert.equal(result.text, 'Close the Dashboard', \`a model that never answered in time produced \${JSON.stringify(result)}\`);
}

export async function check_retriable_only(ctx) {
  const {m} = client(ctx);
  let result;
  try {
    result = await translate(m, SAMPLE, 'tlh');
  } catch (e) {
    assert(e instanceof m.PairRejected, \`a pair the model rejects threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected PairRejected\`);
  }
  assert.equal(result, undefined, \`a pair the model rejects (INVALID_ARGUMENT) returned \${JSON.stringify(result)} instead of throwing PairRejected\`);
  const calls = ctx.grpc.callsTo('Translate').length;
  assert.equal(calls, 1, \`a rejected language pair was sent to the model \${calls} times: INVALID_ARGUMENT is a caller bug, retrying cannot change it\`);
  ctx.grpc.fail('Translate', ctx.grpc.status.UNAVAILABLE, '', 2);
  result = await translate(m);
  assert.deepStrictEqual(result, {text: TRANSLATED, marker: null}, \`two UNAVAILABLE answers then a reply: translateSegment answered \${JSON.stringify(result)}, expected the translation from the third attempt\`);
  assert.equal(ctx.grpc.callsTo('Translate').length, 4, 'UNAVAILABLE is retried: three attempts for the second segment');
}

export async function check_marked_fallback(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Translate', ctx.grpc.status.UNAVAILABLE, '', 3);
  const result = await translate(m);
  assert.equal(ctx.grpc.callsTo('Translate').length, 3, \`an outage got \${ctx.grpc.callsTo('Translate').length} attempts, expected 3\`);
  assert.deepStrictEqual(result, {text: SAMPLE, marker: 'untranslated'}, \`after three UNAVAILABLE attempts translateSegment answered \${JSON.stringify(result)}: the caller cannot tell English from French. Return the source text with marker untranslated\`);
}

export async function check_no_cached_fallback(ctx) {
  const {m, glossary} = client(ctx);
  ctx.grpc.fail('Translate', ctx.grpc.status.UNAVAILABLE, '', 3);
  await translate(m);
  const key = glossary.tmKey('acme', 'en', 'fr', 2, SAMPLE);
  assert(!ctx.redis.exists(key), \`translation memory holds \${JSON.stringify(ctx.redis.get(key))} for a segment the model never translated: it is served as French for the next hour\`);
  const result = await translate(m);
  assert.deepStrictEqual(result, {text: TRANSLATED, marker: null}, \`once the model recovered translateSegment answered \${JSON.stringify(result)}\`);
  assert.equal(ctx.grpc.callsTo('Translate').length, 4, 'after the outage the next request must reach the model');
  assert.equal(ctx.redis.get(key), TRANSLATED, \`the model's translation must be remembered under \${key}\`);
  await translate(m);
  assert.equal(ctx.grpc.callsTo('Translate').length, 4, 'a remembered translation is answered without a call');
}
`,
    go: `package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "translate/gen/translation_service"
	"translate/glossary"

	"leetbuild/harness"
)

const (
	clientSample     = "Open the Dashboard"
	clientTranslated = "[fr] Open the Tableau de bord"
)

var (
	clientBg = context.Background()
	pinned   = glossary.Glossary{Version: 2, Terms: map[string]string{"Dashboard": "Tableau de bord"}}
	served   = map[string]bool{"en": true, "fr": true, "de": true, "es": true, "ja": true, "pt": true}
)

// modelPeer answers '[target] text' with every glossary term applied; a pair it does not serve is InvalidArgument.
type modelPeer struct {
	pb.UnimplementedTranslatorServer
}

func (modelPeer) Translate(_ context.Context, req *pb.TranslateRequest) (*pb.TranslateReply, error) {
	if !served[req.GetSource()] || !served[req.GetTarget()] || req.GetSource() == req.GetTarget() {
		return nil, status.Errorf(codes.InvalidArgument, "pair %s->%s is not served", req.GetSource(), req.GetTarget())
	}
	text := req.GetText()
	for _, term := range req.GetTerms() {
		text = strings.ReplaceAll(text, term.GetSource(), term.GetTarget())
	}
	return &pb.TranslateReply{Text: "[" + req.GetTarget() + "] " + text, Model: "mt-2026-10"}, nil
}

func serveModel(ctx *harness.Ctx) {
	pb.RegisterTranslatorServer(ctx.GRPC.Server(""), modelPeer{})
}

func mustTranslate(ctx *harness.Ctx, text string) Translation {
	result, err := translateSegment(clientBg, "acme", text, "en", "fr", pinned)
	ctx.NoError(err, "translateSegment(%q) failed", text)
	return result
}

func CheckDeadline(ctx *harness.Ctx) {
	serveModel(ctx)
	healthy := mustTranslate(ctx, clientSample)
	ctx.Assert(healthy.Text == clientTranslated && healthy.Marker == "", "with the model healthy translateSegment answered %+v, expected %q", healthy, clientTranslated)
	ctx.GRPC.SetLatency("Translate", 10.0, "")
	result := mustTranslate(ctx, "Close the Dashboard")
	calls := ctx.GRPC.CallsTo("Translate", "")[1:]
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a Translate call carries no deadline: a stalled model holds every request as long as it stalls")
		ctx.Assert(1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "a Translate call carries a %v deadline, expected 2 s", call.Timeout)
	}
	ctx.Equal(len(calls), 3, "a model slower than the deadline must get maxAttempts = 3 attempts of 2 s; the calls")
	ctx.Equal(result.Text, "Close the Dashboard", "a model that never answered in time; the text")
}

func CheckRetriableOnly(ctx *harness.Ctx) {
	serveModel(ctx)
	result, err := translateSegment(clientBg, "acme", clientSample, "en", "tlh", pinned)
	ctx.Assert(err != nil, "a pair the model rejects (InvalidArgument) returned %+v instead of an error wrapping ErrPairRejected", result)
	ctx.Assert(errors.Is(err, ErrPairRejected), "a pair the model rejects returned %v, expected an error wrapping ErrPairRejected", err)
	ctx.Equal(len(ctx.GRPC.CallsTo("Translate", "")), 1, "a rejected language pair is a caller bug, retrying cannot change it; the calls")
	ctx.GRPC.Fail("Translate", codes.Unavailable, "", 2, "")
	second := mustTranslate(ctx, clientSample)
	ctx.Assert(second.Text == clientTranslated && second.Marker == "", "two Unavailable answers then a reply: translateSegment answered %+v, expected the translation from the third attempt", second)
	ctx.Equal(len(ctx.GRPC.CallsTo("Translate", "")), 4, "Unavailable is retried: three attempts for the second segment; the calls")
}

func CheckMarkedFallback(ctx *harness.Ctx) {
	serveModel(ctx)
	ctx.GRPC.Fail("Translate", codes.Unavailable, "", 3, "")
	result := mustTranslate(ctx, clientSample)
	ctx.Equal(len(ctx.GRPC.CallsTo("Translate", "")), 3, "an outage's attempts")
	ctx.Assert(result.Text == clientSample && result.Marker == "untranslated", "after three Unavailable attempts translateSegment answered %+v: the caller cannot tell English from French. Return the source text with Marker untranslated", result)
}

func CheckNoCachedFallback(ctx *harness.Ctx) {
	serveModel(ctx)
	ctx.GRPC.Fail("Translate", codes.Unavailable, "", 3, "")
	mustTranslate(ctx, clientSample)
	key := glossary.TMKey("acme", "en", "fr", 2, clientSample)
	held, _ := ctx.Redis.Get(key)
	ctx.Assert(ctx.Redis.Exists(key) == 0, "translation memory holds %q for a segment the model never translated: it is served as French for the next hour", held)
	result := mustTranslate(ctx, clientSample)
	ctx.Assert(result.Text == clientTranslated && result.Marker == "", "once the model recovered translateSegment answered %+v", result)
	ctx.Equal(len(ctx.GRPC.CallsTo("Translate", "")), 4, "after the outage the next request must reach the model; the calls")
	remembered, _ := ctx.Redis.Get(key)
	ctx.Equal(remembered, clientTranslated, "the model's translation must be remembered under %s", key)
	mustTranslate(ctx, clientSample)
	ctx.Equal(len(ctx.GRPC.CallsTo("Translate", "")), 4, "a remembered translation is answered without a call; the calls")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <set>
#include <string>

namespace {

const std::string kSample = "Open the Dashboard";
const std::string kTranslated = "[fr] Open the Tableau de bord";
const glossary::Glossary kPinned{2, {{"Dashboard", "Tableau de bord"}}};

// The model: '[target] text' with every glossary term applied; a pair it does not serve is INVALID_ARGUMENT.
class ModelPeer final : public translationsvc::Translator::Service {
 public:
  grpc::Status Translate(grpc::ServerContext*, const translationsvc::TranslateRequest* req, translationsvc::TranslateReply* out) override {
    static const std::set<std::string> served = {"en", "fr", "de", "es", "ja", "pt"};
    if (!served.count(req->source()) || !served.count(req->target()) || req->source() == req->target()) {
      return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "pair " + req->source() + "->" + req->target() + " is not served");
    }
    std::string text = req->text();
    for (const auto& term : req->terms()) {
      for (size_t at = text.find(term.source()); at != std::string::npos; at = text.find(term.source(), at + term.target().size())) {
        text.replace(at, term.source().size(), term.target());
      }
    }
    out->set_text("[" + req->target() + "] " + text);
    out->set_model("mt-2026-10");
    return grpc::Status::OK;
  }
};

void serveModel(harness::Ctx& ctx) {
  static ModelPeer* peer = nullptr;
  delete peer;
  peer = new ModelPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

Translation mustTranslate(harness::Ctx& ctx, const std::string& text) {
  try {
    return translateSegment("acme", text, "en", "fr", kPinned);
  } catch (const std::exception& e) {
    ctx.Fatalf("translateSegment(%q) threw %s: %s", text, harness::CurrentExceptionType(), e.what());
  }
  return {};
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  serveModel(ctx);
  const Translation healthy = mustTranslate(ctx, kSample);
  ctx.Assert(healthy.text == kTranslated && healthy.marker.empty(), "with the model healthy translateSegment answered %q (marker %q), expected %q", healthy.text, healthy.marker, kTranslated);
  ctx.GRPC.SetLatency("Translate", 10.0);
  const Translation result = mustTranslate(ctx, "Close the Dashboard");
  auto calls = ctx.GRPC.CallsTo("Translate");
  calls.erase(calls.begin());
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a Translate call carries no deadline: a stalled model holds every request as long as it stalls");
    ctx.Assert(1.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 2.5, "a Translate call carries a %v s deadline, expected kDeadline = 2 s", call.TimeoutSeconds());
  }
  ctx.Equal(calls.size(), 3, "a model slower than the deadline must get kMaxAttempts = 3 attempts of 2 s; the calls");
  ctx.Equal(result.text, "Close the Dashboard", "a model that never answered in time; the text");
}

void CheckRetriableOnly(harness::Ctx& ctx) {
  serveModel(ctx);
  try {
    const Translation result = translateSegment("acme", kSample, "en", "tlh", kPinned);
    ctx.Fatalf("a pair the model rejects (INVALID_ARGUMENT) returned %q instead of throwing PairRejected", result.text);
  } catch (const PairRejected&) {
  } catch (const std::exception& e) {
    ctx.Fatalf("a pair the model rejects threw %s: %s, expected PairRejected", harness::CurrentExceptionType(), e.what());
  }
  ctx.Equal(ctx.GRPC.CallsTo("Translate").size(), 1, "a rejected language pair is a caller bug, retrying cannot change it; the calls");
  ctx.GRPC.Fail("Translate", grpc::StatusCode::UNAVAILABLE, "", 2);
  const Translation second = mustTranslate(ctx, kSample);
  ctx.Assert(second.text == kTranslated && second.marker.empty(), "two UNAVAILABLE answers then a reply: translateSegment answered %q (marker %q), expected the translation from the third attempt", second.text, second.marker);
  ctx.Equal(ctx.GRPC.CallsTo("Translate").size(), 4, "UNAVAILABLE is retried: three attempts for the second segment; the calls");
}

void CheckMarkedFallback(harness::Ctx& ctx) {
  serveModel(ctx);
  ctx.GRPC.Fail("Translate", grpc::StatusCode::UNAVAILABLE, "", 3);
  const Translation result = mustTranslate(ctx, kSample);
  ctx.Equal(ctx.GRPC.CallsTo("Translate").size(), 3, "an outage's attempts");
  ctx.Assert(result.text == kSample && result.marker == "untranslated", "after three UNAVAILABLE attempts translateSegment answered %q (marker %q): the caller cannot tell English from French. Return the source text with marker untranslated", result.text, result.marker);
}

void CheckNoCachedFallback(harness::Ctx& ctx) {
  serveModel(ctx);
  ctx.GRPC.Fail("Translate", grpc::StatusCode::UNAVAILABLE, "", 3);
  mustTranslate(ctx, kSample);
  const std::string key = glossary::tmKey("acme", "en", "fr", 2, kSample);
  ctx.Assert(ctx.Redis.Exists(key) == 0, "translation memory holds %q for a segment the model never translated: it is served as French for the next hour", ctx.Redis.Get(key).value_or(""));
  const Translation result = mustTranslate(ctx, kSample);
  ctx.Assert(result.text == kTranslated && result.marker.empty(), "once the model recovered translateSegment answered %q (marker %q)", result.text, result.marker);
  ctx.Equal(ctx.GRPC.CallsTo("Translate").size(), 4, "after the outage the next request must reach the model; the calls");
  ctx.Equal(ctx.Redis.Get(key), std::optional<std::string>(kTranslated), "the model's translation must be remembered under %s", key);
  mustTranslate(ctx, kSample);
  ctx.Equal(ctx.GRPC.CallsTo("Translate").size(), 4, "a remembered translation is answered without a call; the calls");
}
`,
  },
  hints: [
    'Slow the model to ten seconds: one request waits all ten. Ask for a pair the model does not serve: three calls, then English comes back as if it were French, and it is still served after the model recovers.',
    'The call has no `timeout`, so it waits as long as the model; the loop catches every `RpcError` the same way; after the loop `translation` is still the source text, which goes to `tm_put` and back with no marker.',
    'Pass `timeout=DEADLINE_S`; on `INVALID_ARGUMENT` raise `PairRejected`; `continue` only for `UNAVAILABLE`/`DEADLINE_EXCEEDED`; `tm_put` and return the reply inside the loop; after it, return `{"text": text, "marker": UNTRANSLATED}`.',
  ],
  debrief: `The status code already says whose fault the failure is: \`INVALID_ARGUMENT\` is the caller's and a retry cannot change it, \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are the model's and may pass. The deadline turns a stalled model into one of those codes, and the attempt cap bounds the worst request at six seconds. The marker is what keeps a fallback honest end to end: the endpoint answers 503, the CDN and translation memory skip it, and the quality metric does not count it as French. Production clients add jittered backoff between attempts, a circuit breaker that stops calling a model that keeps failing, and a per-request budget shared by every segment of a document.`,
};
