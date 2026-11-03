import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Sandbox validation before a catalog version goes live',
  concept: 'grpc',
  file: 'client',
  focus: ['registry', 'sandbox', 'vault', 'redis'],
  task: `## Task

**Starting point.** The starter is \`validate_and_promote(cv, entries)\`, which the registry runs on a
candidate catalog version: it sends every tool of the candidate to the sandbox over gRPC
(\`Sandbox.Validate\`), tries up to three times on an error, then records \`passed\` and calls
\`catalog.promote\` (step 2, provided as \`toolsd.catalog\`). With the sandbox healthy it promotes,
and it hides four flaws.

**Failure mode the checks target.** A wedged sandbox holds the promotion open; a sandbox that never
answered counts as a pass, so a version nobody validated ships; the sandbox, which runs candidate
code, is handed the production provider key; and a schema rejection is sent again and again instead
of being remembered.

\`\`\`proto
service Sandbox { rpc Validate(ValidateRequest) returns (ValidateReport); }  // INVALID_ARGUMENT: a tool's schema does not hold up
\`\`\`

- The call carries a **\`VALIDATE_DEADLINE_S\` = 10 s** deadline and \`authorization: Bearer
  {SANDBOX_TOKEN}\`, the sandbox's own scoped token.
- Any other error (a deadline, \`UNAVAILABLE\`) records \`unavailable\` with a reason and returns it:
  nothing is promoted, and the next request asks the sandbox again.
- \`INVALID_ARGUMENT\` records \`rejected\` with the sandbox's details. A candidate whose recorded
  outcome (\`catalog.validation(cv)\`) is \`rejected\` or \`passed\` is answered from it without a call.
- Only an OK records \`passed\` and calls \`catalog.promote\`. The function returns the outcome.`,
  sequence: {
    participants: ['Registry', 'Redis', 'Sandbox'],
    messages: [
      {from: 'Registry', to: 'Redis', label: 'HGETALL catalog:validation:9 → none', kind: 'sync'},
      {from: 'Registry', to: 'Sandbox', label: 'Validate(9, tools) · 10 s · Bearer sandbox token', kind: 'sync'},
      {from: 'Sandbox', to: 'Registry', label: 'OK · INVALID_ARGUMENT · DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Registry', to: 'Redis', label: 'record passed / rejected / unavailable', kind: 'sync'},
      {from: 'Registry', to: 'Redis', label: 'promote(9) only after OK', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'The sandbox call carries a 10-second deadline',
      detail:
        'Every `Validate` call is made with `VALIDATE_DEADLINE_S` (10 s); a sandbox slower than that ends the call, and the candidate is recorded `unavailable`. The starter sets no deadline, so a wedged sandbox holds the promotion open.',
      match: {
        python: {
          all: [/VALIDATE_DEADLINE_S\s*=\s*10\b/, /Validate\([\s\S]{0,200}?timeout\s*=\s*VALIDATE_DEADLINE_S/],
        },
        typescript: {
          all: [/VALIDATE_DEADLINE_MS\s*=\s*10_?000\b/, /Validate\([\s\S]{0,200}?deadline:[^\n]*VALIDATE_DEADLINE_MS/],
        },
        go: {all: [/validateDeadline\s*=\s*10\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*validateDeadline\)/]},
        scala: {all: [/ValidateDeadlineSeconds\s*=\s*10L?\b/, /withDeadlineAfter\(\s*ValidateDeadlineSeconds/]},
        cpp: {all: [/kValidateDeadline\{10\}/, /set_deadline\([^\n]*kValidateDeadline\)/]},
      },
    },
    {
      id: 'scoped-credential',
      title: 'Dials the sandbox with its own scoped token',
      detail:
        'The `authorization` metadata is `Bearer` plus `SANDBOX_TOKEN`; the sandbox runs candidate code, so whatever credential it receives the candidate can spend. The starter sends `PROVIDER_API_KEY`.',
      match: {
        python: {all: [/["']authorization["']/, /Bearer \{SANDBOX_TOKEN\}/], none: [/Bearer \{PROVIDER_API_KEY\}/]},
        typescript: {
          all: [/['"]authorization['"]/, /Bearer \$\{SANDBOX_TOKEN\}/],
          none: [/Bearer \$\{PROVIDER_API_KEY\}/],
        },
        go: {all: [/"authorization"/, /"Bearer "\s*\+\s*sandboxToken/], none: [/"Bearer "\s*\+\s*providerAPIKey/]},
        scala: {all: [/"authorization"/, /bearer\(SandboxToken\)/], none: [/bearer\(ProviderApiKey\)/]},
        cpp: {all: [/"authorization"/, /"Bearer "\s*\+\s*kSandboxToken/], none: [/"Bearer "\s*\+\s*kProviderApiKey/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'An unanswered validation is not a pass',
      detail:
        'A deadline or `UNAVAILABLE` records `unavailable` with a reason and returns before any promotion, so the active catalog stays where it was. The starter retries, then records `passed` and promotes whatever happened.',
      match: {
        python: {all: [/record_validation\(\s*cv,\s*["']unavailable["']/], none: [/for attempt in/]},
        typescript: {all: [/recordValidation\(\s*cv,\s*['"]unavailable['"]/], none: [/for \(let attempt/]},
        go: {all: [/RecordValidation\(ctx,\s*cv,\s*"unavailable"/], none: [/for attempt :=/]},
        scala: {all: [/\(\s*"unavailable",/], none: [/while \(/]},
        cpp: {all: [/recordValidation\(cv,\s*"unavailable"/], none: [/for \(int attempt/]},
      },
    },
    {
      id: 'terminal-rejection',
      title: 'A schema rejection is terminal for the candidate',
      detail:
        '`INVALID_ARGUMENT` records `rejected` with the details, and a re-request is answered from `catalog.validation(cv)` before any call; an `unavailable` candidate is asked about again. The starter resends a rejection and never consults the record.',
      match: {
        python: {
          all: [/INVALID_ARGUMENT/, /record_validation\(\s*cv,\s*["']rejected["']/],
          order: [/catalog\.validation\(cv\)/, /sandbox\.Validate\(/],
        },
        typescript: {
          all: [/INVALID_ARGUMENT/, /recordValidation\(\s*cv,\s*['"]rejected['"]/],
          order: [/\bvalidation\(cv\)/, /sandbox\.Validate\(/],
        },
        go: {
          all: [/codes\.InvalidArgument/, /RecordValidation\(ctx,\s*cv,\s*"rejected"/],
          order: [/catalog\.Validation\(ctx,\s*cv\)/, /sandbox\.Validate\(/],
        },
        scala: {
          all: [/INVALID_ARGUMENT/, /\(\s*"rejected",/],
          order: [/Catalog\.validation\(cv\)/, /\.validate\(validateRequest/],
        },
        cpp: {
          all: [/INVALID_ARGUMENT/, /recordValidation\(cv,\s*"rejected"/],
          order: [/catalog::validation\(cv\)/, /sandbox->Validate\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import grpc

import tool_registry_pb2
import tool_registry_pb2_grpc
from toolsd import catalog  # catalog.promote, catalog.validation, catalog.record_validation

log = logging.getLogger("toolsd.validate")

SANDBOX_ADDR = "sandbox:9000"
# Credentials from the deployment's config.
SANDBOX_TOKEN = "sbx-validate-only"  # scoped to the sandbox: it can run candidates, nothing else
PROVIDER_API_KEY = "pk-live-toolsd"  # the production model provider key

sandbox = tool_registry_pb2_grpc.SandboxStub(grpc.insecure_channel(SANDBOX_ADDR))


def validate_request(cv: str, entries: dict[str, dict]) -> tool_registry_pb2.ValidateRequest:
    tools = [
        tool_registry_pb2.ToolSpec(
            name=name, version=entry["version"], side_effect=entry["side_effect"], schema_json=json.dumps(entry["schema"], sort_keys=True)
        )
        for name, entry in sorted(entries.items())
    ]
    return tool_registry_pb2.ValidateRequest(catalog_version=cv, tools=tools)


def validate_and_promote(cv: str, entries: dict[str, dict]) -> str:
    """Exercise candidate catalog version cv in the sandbox and promote it if it holds up; the outcome."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    for attempt in range(3):
        try:
            sandbox.Validate(validate_request(cv, entries), metadata=(("authorization", f"Bearer {PROVIDER_API_KEY}"),))
            break
        except grpc.RpcError as exc:
            log.warning("sandbox attempt %d for catalog %s failed: %s", attempt + 1, cv, exc.code())
    catalog.record_validation(cv, "passed", "")
    catalog.promote(cv, entries)
    return "passed"
`,
      solution: `import json
import logging

import grpc

import tool_registry_pb2
import tool_registry_pb2_grpc
from toolsd import catalog  # catalog.promote, catalog.validation, catalog.record_validation

log = logging.getLogger("toolsd.validate")

SANDBOX_ADDR = "sandbox:9000"
VALIDATE_DEADLINE_S = 10
# Credentials from the deployment's config.
SANDBOX_TOKEN = "sbx-validate-only"  # scoped to the sandbox: it can run candidates, nothing else
PROVIDER_API_KEY = "pk-live-toolsd"  # the production model provider key

# Outcomes that say something about the candidate itself: a re-request is answered from the record.
TERMINAL = ("passed", "rejected")

sandbox = tool_registry_pb2_grpc.SandboxStub(grpc.insecure_channel(SANDBOX_ADDR))


def validate_request(cv: str, entries: dict[str, dict]) -> tool_registry_pb2.ValidateRequest:
    tools = [
        tool_registry_pb2.ToolSpec(
            name=name, version=entry["version"], side_effect=entry["side_effect"], schema_json=json.dumps(entry["schema"], sort_keys=True)
        )
        for name, entry in sorted(entries.items())
    ]
    return tool_registry_pb2.ValidateRequest(catalog_version=cv, tools=tools)


def validate_and_promote(cv: str, entries: dict[str, dict]) -> str:
    """Exercise candidate catalog version cv in the sandbox and promote it if it holds up; the outcome."""
    recorded = catalog.validation(cv)
    if recorded is not None and recorded["outcome"] in TERMINAL:
        return recorded["outcome"]
    try:
        sandbox.Validate(
            validate_request(cv, entries),
            timeout=VALIDATE_DEADLINE_S,
            metadata=(("authorization", f"Bearer {SANDBOX_TOKEN}"),),
        )
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
            catalog.record_validation(cv, "rejected", exc.details() or "rejected")  # terminal for this candidate
            return "rejected"
        # A deadline or an outage says nothing about the candidate: it stays unjudged and unpromoted.
        log.warning("sandbox did not judge catalog %s: %s", cv, exc.code())
        catalog.record_validation(cv, "unavailable", exc.code().name)
        return "unavailable"
    catalog.record_validation(cv, "passed", "")
    catalog.promote(cv, entries)
    return "passed"
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Entry, promote, recordValidation, validation} from 'toolsd/catalog';

export const SANDBOX_ADDR = 'sandbox:9000';
// Credentials from the deployment's config.
export const SANDBOX_TOKEN = 'sbx-validate-only'; // scoped to the sandbox: it can run candidates, nothing else
export const PROVIDER_API_KEY = 'pk-live-toolsd'; // the production model provider key

interface ValidateRequest {
  catalog_version: string;
  tools: {name: string; version: string; side_effect: string; schema_json: string}[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('tool_registry.proto')) as unknown as {
  toolsd: {Sandbox: grpc.ServiceClientConstructor};
};
const sandbox = new pkg.toolsd.Sandbox(SANDBOX_ADDR, grpc.credentials.createInsecure()) as grpc.Client & {
  Validate(request: ValidateRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{calls_exercised: number}>;
};

export function validateRequest(cv: string, entries: Record<string, Entry>): ValidateRequest {
  const tools = Object.keys(entries)
    .sort()
    .map(name => ({
      name,
      version: String(entries[name].version),
      side_effect: String(entries[name].side_effect),
      schema_json: JSON.stringify(entries[name].schema),
    }));
  return {catalog_version: cv, tools};
}

/** Exercise candidate catalog version cv in the sandbox and promote it if it holds up; the outcome. */
export async function validateAndPromote(cv: string, entries: Record<string, Entry>): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const metadata = new grpc.Metadata();
  metadata.set('authorization', \`Bearer \${PROVIDER_API_KEY}\`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sandbox.Validate(validateRequest(cv, entries), metadata, {});
      break;
    } catch (e) {
      console.warn(\`sandbox attempt \${attempt} for catalog \${cv} failed: \${(e as grpc.ServiceError).code}\`);
    }
  }
  await recordValidation(cv, 'passed', '');
  await promote(cv, entries);
  return 'passed';
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Entry, promote, recordValidation, validation} from 'toolsd/catalog';

export const SANDBOX_ADDR = 'sandbox:9000';
export const VALIDATE_DEADLINE_MS = 10_000;
// Credentials from the deployment's config.
export const SANDBOX_TOKEN = 'sbx-validate-only'; // scoped to the sandbox: it can run candidates, nothing else
export const PROVIDER_API_KEY = 'pk-live-toolsd'; // the production model provider key

interface ValidateRequest {
  catalog_version: string;
  tools: {name: string; version: string; side_effect: string; schema_json: string}[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('tool_registry.proto')) as unknown as {
  toolsd: {Sandbox: grpc.ServiceClientConstructor};
};
const sandbox = new pkg.toolsd.Sandbox(SANDBOX_ADDR, grpc.credentials.createInsecure()) as grpc.Client & {
  Validate(request: ValidateRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{calls_exercised: number}>;
};

export function validateRequest(cv: string, entries: Record<string, Entry>): ValidateRequest {
  const tools = Object.keys(entries)
    .sort()
    .map(name => ({
      name,
      version: String(entries[name].version),
      side_effect: String(entries[name].side_effect),
      schema_json: JSON.stringify(entries[name].schema),
    }));
  return {catalog_version: cv, tools};
}

/** Exercise candidate catalog version cv in the sandbox and promote it if it holds up; the outcome. */
export async function validateAndPromote(cv: string, entries: Record<string, Entry>): Promise<string> {
  // passed and rejected say something about the candidate itself: a re-request is answered from the record.
  const recorded = await validation(cv);
  if (recorded !== null && (recorded.outcome === 'passed' || recorded.outcome === 'rejected')) return recorded.outcome;
  const metadata = new grpc.Metadata();
  metadata.set('authorization', \`Bearer \${SANDBOX_TOKEN}\`);
  try {
    await sandbox.Validate(validateRequest(cv, entries), metadata, {deadline: Date.now() + VALIDATE_DEADLINE_MS});
  } catch (e) {
    const {code, details} = e as grpc.ServiceError;
    if (code === grpc.status.INVALID_ARGUMENT) {
      await recordValidation(cv, 'rejected', details || 'rejected'); // terminal for this candidate
      return 'rejected';
    }
    // A deadline or an outage says nothing about the candidate: it stays unjudged and unpromoted.
    await recordValidation(cv, 'unavailable', grpc.status[code] ?? 'unavailable');
    return 'unavailable';
  }
  await recordValidation(cv, 'passed', '');
  await promote(cv, entries);
  return 'passed';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"sort"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"toolsd/catalog" // catalog.Promote, catalog.Validation, catalog.RecordValidation
	pb "toolsd/gen/tool_registry"
)

const (
	sandboxAddr = "sandbox:9000"
	// Credentials from the deployment's config.
	sandboxToken   = "sbx-validate-only" // scoped to the sandbox: it can run candidates, nothing else
	providerAPIKey = "pk-live-toolsd"    // the production model provider key
)

var (
	sandboxConn, _ = grpc.NewClient(sandboxAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	sandbox        = pb.NewSandboxClient(sandboxConn)
)

func validateRequest(cv string, entries map[string]catalog.Entry) *pb.ValidateRequest {
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	req := &pb.ValidateRequest{CatalogVersion: cv}
	for _, name := range names {
		version, _ := entries[name]["version"].(string)
		sideEffect, _ := entries[name]["side_effect"].(string)
		schema, _ := json.Marshal(entries[name]["schema"])
		req.Tools = append(req.Tools, &pb.ToolSpec{Name: name, Version: version, SideEffect: sideEffect, SchemaJson: string(schema)})
	}
	return req
}

// validateAndPromote exercises candidate catalog version cv in the sandbox and promotes it if it holds up; the outcome.
func validateAndPromote(ctx context.Context, cv string, entries map[string]catalog.Entry) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	for attempt := 1; attempt <= 3; attempt++ {
		callCtx := metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+providerAPIKey)
		_, err := sandbox.Validate(callCtx, validateRequest(cv, entries))
		if err == nil {
			break
		}
		log.Printf("sandbox attempt %d for catalog %s failed: %v", attempt, cv, status.Code(err))
	}
	if err := catalog.RecordValidation(ctx, cv, "passed", ""); err != nil {
		return "", err
	}
	return "passed", catalog.Promote(ctx, cv, entries)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"toolsd/catalog" // catalog.Promote, catalog.Validation, catalog.RecordValidation
	pb "toolsd/gen/tool_registry"
)

const (
	sandboxAddr      = "sandbox:9000"
	validateDeadline = 10 * time.Second
	// Credentials from the deployment's config.
	sandboxToken   = "sbx-validate-only" // scoped to the sandbox: it can run candidates, nothing else
	providerAPIKey = "pk-live-toolsd"    // the production model provider key
)

var (
	sandboxConn, _ = grpc.NewClient(sandboxAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	sandbox        = pb.NewSandboxClient(sandboxConn)
)

func validateRequest(cv string, entries map[string]catalog.Entry) *pb.ValidateRequest {
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	req := &pb.ValidateRequest{CatalogVersion: cv}
	for _, name := range names {
		version, _ := entries[name]["version"].(string)
		sideEffect, _ := entries[name]["side_effect"].(string)
		schema, _ := json.Marshal(entries[name]["schema"])
		req.Tools = append(req.Tools, &pb.ToolSpec{Name: name, Version: version, SideEffect: sideEffect, SchemaJson: string(schema)})
	}
	return req
}

// validateAndPromote exercises candidate catalog version cv in the sandbox and promotes it if it holds up; the outcome.
func validateAndPromote(ctx context.Context, cv string, entries map[string]catalog.Entry) (string, error) {
	recorded, err := catalog.Validation(ctx, cv)
	if err != nil {
		return "", err
	}
	// passed and rejected say something about the candidate itself: a re-request is answered from the record.
	if outcome := recorded["outcome"]; outcome == "passed" || outcome == "rejected" {
		return outcome, nil
	}
	callCtx, cancel := context.WithTimeout(ctx, validateDeadline)
	defer cancel()
	callCtx = metadata.AppendToOutgoingContext(callCtx, "authorization", "Bearer "+sandboxToken)
	if _, err := sandbox.Validate(callCtx, validateRequest(cv, entries)); err != nil {
		if status.Code(err) == codes.InvalidArgument {
			return "rejected", catalog.RecordValidation(ctx, cv, "rejected", status.Convert(err).Message()) // terminal for this candidate
		}
		// A deadline or an outage says nothing about the candidate: it stays unjudged and unpromoted.
		log.Printf("sandbox did not judge catalog %s: %v", cv, status.Code(err))
		return "unavailable", catalog.RecordValidation(ctx, cv, "unavailable", status.Code(err).String())
	}
	if err := catalog.RecordValidation(ctx, cv, "passed", ""); err != nil {
		return "", err
	}
	return "passed", catalog.Promote(ctx, cv, entries)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ClientInterceptor, ManagedChannelBuilder, Metadata, StatusRuntimeException}
import io.grpc.stub.MetadataUtils
import spray.json._

import toolsd.Catalog // Catalog.promote, Catalog.validation, Catalog.recordValidation
import toolsd.tool_registry.{SandboxGrpc, ToolSpec, ValidateRequest}

object Client {
  val SandboxHost = "sandbox"
  val SandboxPort = 9000
  // Credentials from the deployment's config.
  val SandboxToken = "sbx-validate-only" // scoped to the sandbox: it can run candidates, nothing else
  val ProviderApiKey = "pk-live-toolsd" // the production model provider key

  private def bearer(token: String): ClientInterceptor = {
    val headers = new Metadata()
    headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), s"Bearer $token")
    MetadataUtils.newAttachHeadersInterceptor(headers)
  }

  private val sandbox =
    SandboxGrpc.blockingStub(ManagedChannelBuilder.forAddress(SandboxHost, SandboxPort).usePlaintext().build()).withInterceptors(bearer(ProviderApiKey))

  private def text(entry: JsObject, field: String): String = entry.fields.get(field) match {
    case Some(JsString(s)) => s
    case _                 => ""
  }

  def validateRequest(cv: String, entries: Map[String, JsObject]): ValidateRequest =
    ValidateRequest(
      catalogVersion = cv,
      tools = entries.toSeq.sortBy(_._1).map { case (name, entry) =>
        ToolSpec(name = name, version = text(entry, "version"), sideEffect = text(entry, "side_effect"), schemaJson = entry.fields.getOrElse("schema", JsObject.empty).compactPrint)
      })

  /** Exercise candidate catalog version cv in the sandbox and promote it if it holds up; the outcome. */
  def validateAndPromote(cv: String, entries: Map[String, JsObject]): String = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    var attempt = 0
    var answered = false
    while (!answered && attempt < 3) {
      attempt += 1
      try {
        sandbox.validate(validateRequest(cv, entries))
        answered = true
      } catch {
        case e: StatusRuntimeException => System.err.println(s"sandbox attempt $attempt for catalog $cv failed: \${e.getStatus.getCode}")
      }
    }
    Catalog.recordValidation(cv, "passed", "")
    Catalog.promote(cv, entries)
    "passed"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ClientInterceptor, ManagedChannelBuilder, Metadata, Status, StatusRuntimeException}
import io.grpc.stub.MetadataUtils
import spray.json._

import toolsd.Catalog // Catalog.promote, Catalog.validation, Catalog.recordValidation
import toolsd.tool_registry.{SandboxGrpc, ToolSpec, ValidateRequest}

object Client {
  val SandboxHost = "sandbox"
  val SandboxPort = 9000
  val ValidateDeadlineSeconds = 10L
  // Credentials from the deployment's config.
  val SandboxToken = "sbx-validate-only" // scoped to the sandbox: it can run candidates, nothing else
  val ProviderApiKey = "pk-live-toolsd" // the production model provider key

  /** Outcomes that say something about the candidate itself: a re-request is answered from the record. */
  val Terminal: Set[String] = Set("passed", "rejected")

  private def bearer(token: String): ClientInterceptor = {
    val headers = new Metadata()
    headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), s"Bearer $token")
    MetadataUtils.newAttachHeadersInterceptor(headers)
  }

  private val sandbox =
    SandboxGrpc.blockingStub(ManagedChannelBuilder.forAddress(SandboxHost, SandboxPort).usePlaintext().build()).withInterceptors(bearer(SandboxToken))

  private def text(entry: JsObject, field: String): String = entry.fields.get(field) match {
    case Some(JsString(s)) => s
    case _                 => ""
  }

  def validateRequest(cv: String, entries: Map[String, JsObject]): ValidateRequest =
    ValidateRequest(
      catalogVersion = cv,
      tools = entries.toSeq.sortBy(_._1).map { case (name, entry) =>
        ToolSpec(name = name, version = text(entry, "version"), sideEffect = text(entry, "side_effect"), schemaJson = entry.fields.getOrElse("schema", JsObject.empty).compactPrint)
      })

  /** Exercise candidate catalog version cv in the sandbox and promote it if it holds up; the outcome. */
  def validateAndPromote(cv: String, entries: Map[String, JsObject]): String =
    Catalog.validation(cv).flatMap(_.get("outcome")).filter(Terminal) match {
      case Some(outcome) => outcome
      case None =>
        val (outcome, reason) =
          try {
            sandbox.withDeadlineAfter(ValidateDeadlineSeconds, TimeUnit.SECONDS).validate(validateRequest(cv, entries))
            ("passed", "")
          } catch {
            case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.INVALID_ARGUMENT =>
              ("rejected", Option(e.getStatus.getDescription).getOrElse("rejected")) // terminal for this candidate
            // A deadline or an outage says nothing about the candidate: it stays unjudged and unpromoted.
            case e: StatusRuntimeException => ("unavailable", e.getStatus.getCode.toString)
          }
        Catalog.recordValidation(cv, outcome, reason)
        if (outcome == "passed") Catalog.promote(cv, entries)
        outcome
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "tool_registry.grpc.pb.h"
#include "toolsd/catalog.h"  // catalog::promote, catalog::validation, catalog::recordValidation

using json = nlohmann::json;

const std::string kSandboxAddr = "sandbox:9000";
// Credentials from the deployment's config.
const std::string kSandboxToken = "sbx-validate-only";  // scoped to the sandbox: it can run candidates, nothing else
const std::string kProviderApiKey = "pk-live-toolsd";   // the production model provider key

auto sandbox = toolsd::Sandbox::NewStub(grpc::CreateChannel(kSandboxAddr, grpc::InsecureChannelCredentials()));

toolsd::ValidateRequest validateRequest(const std::string& cv, const json& entries) {
  toolsd::ValidateRequest req;
  req.set_catalog_version(cv);
  for (const auto& [name, entry] : entries.items()) {
    toolsd::ToolSpec* tool = req.add_tools();
    tool->set_name(name);
    tool->set_version(entry.value("version", ""));
    tool->set_side_effect(entry.value("side_effect", ""));
    tool->set_schema_json(entry.contains("schema") ? entry["schema"].dump() : "{}");
  }
  return req;
}

// Exercise candidate catalog version cv in the sandbox and promote it if it holds up; the outcome.
std::string validateAndPromote(const std::string& cv, const json& entries) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (int attempt = 1; attempt <= 3; attempt++) {
    grpc::ClientContext ctx;
    ctx.AddMetadata("authorization", "Bearer " + kProviderApiKey);
    toolsd::ValidateReport report;
    const grpc::Status status = sandbox->Validate(&ctx, validateRequest(cv, entries), &report);
    if (status.ok()) break;
    std::cerr << "sandbox attempt " << attempt << " for catalog " << cv << " failed: " << status.error_message() << "\\n";
  }
  catalog::recordValidation(cv, "passed", "");
  catalog::promote(cv, entries);
  return "passed";
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <string>

#include "tool_registry.grpc.pb.h"
#include "toolsd/catalog.h"  // catalog::promote, catalog::validation, catalog::recordValidation

using json = nlohmann::json;

const std::string kSandboxAddr = "sandbox:9000";
constexpr std::chrono::seconds kValidateDeadline{10};
// Credentials from the deployment's config.
const std::string kSandboxToken = "sbx-validate-only";  // scoped to the sandbox: it can run candidates, nothing else
const std::string kProviderApiKey = "pk-live-toolsd";   // the production model provider key

auto sandbox = toolsd::Sandbox::NewStub(grpc::CreateChannel(kSandboxAddr, grpc::InsecureChannelCredentials()));

toolsd::ValidateRequest validateRequest(const std::string& cv, const json& entries) {
  toolsd::ValidateRequest req;
  req.set_catalog_version(cv);
  for (const auto& [name, entry] : entries.items()) {
    toolsd::ToolSpec* tool = req.add_tools();
    tool->set_name(name);
    tool->set_version(entry.value("version", ""));
    tool->set_side_effect(entry.value("side_effect", ""));
    tool->set_schema_json(entry.contains("schema") ? entry["schema"].dump() : "{}");
  }
  return req;
}

// Exercise candidate catalog version cv in the sandbox and promote it if it holds up; the outcome.
std::string validateAndPromote(const std::string& cv, const json& entries) {
  // passed and rejected say something about the candidate itself: a re-request is answered from the record.
  if (const auto recorded = catalog::validation(cv)) {
    const auto outcome = recorded->find("outcome");
    if (outcome != recorded->end() && (outcome->second == "passed" || outcome->second == "rejected")) return outcome->second;
  }
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kValidateDeadline);
  ctx.AddMetadata("authorization", "Bearer " + kSandboxToken);
  toolsd::ValidateReport report;
  const grpc::Status status = sandbox->Validate(&ctx, validateRequest(cv, entries), &report);
  if (!status.ok()) {
    if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) {
      catalog::recordValidation(cv, "rejected", status.error_message());  // terminal for this candidate
      return "rejected";
    }
    // A deadline or an outage says nothing about the candidate: it stays unjudged and unpromoted.
    std::cerr << "sandbox did not judge catalog " << cv << ": " << status.error_message() << "\\n";
    catalog::recordValidation(cv, "unavailable", status.error_message().empty() ? "sandbox unavailable" : status.error_message());
    return "unavailable";
  }
  catalog::recordValidation(cv, "passed", "");
  catalog::promote(cv, entries);
  return "passed";
}
`,
    },
  },
  harness: {
    python: `import grpc

import tool_registry_pb2
import tool_registry_pb2_grpc
from toolsd import catalog


def _entry(name, version, side_effect, owner):
    return {"name": name, "version": version, "side_effect": side_effect, "owner": owner, "schema": {"type": "object"}, "endpoint": f"https://{owner}.internal", "credential_ref": f"vault://{owner}"}


S1, S2 = _entry("search", "a1", "read", "search"), _entry("search", "a2", "read", "search")
R1, R2 = _entry("refund", "b1", "irreversible", "payments"), _entry("refund", "b2", "irreversible", "payments")
V7 = {"search": S1, "refund": R1}
V9 = {"search": S2, "refund": R2}
V10 = {"search": S2, "refund": R1}
BROKEN = {"search": S2, "broken.refund": _entry("broken.refund", "c1", "irreversible", "payments")}


class Sandbox(tool_registry_pb2_grpc.SandboxServicer):
    """Exercises every tool; a tool named broken.* has a schema it cannot build arguments from."""

    def Validate(self, request, context):
        for tool in request.tools:
            if tool.name.startswith("broken."):
                context.abort(grpc.StatusCode.INVALID_ARGUMENT, f"tool {tool.name}: the sandbox cannot build arguments from its schema")
        return tool_registry_pb2.ValidateReport(calls_exercised=len(request.tools))


def _client(ctx):
    ctx.grpc.serve(tool_registry_pb2_grpc.add_SandboxServicer_to_server, Sandbox())
    catalog.record_validation("7", "passed", "")
    catalog.promote("7", V7)
    return ctx.load("client")


def _active(ctx):
    return ctx.redis.get("catalog:active")


def check_deadline(ctx):
    m = _client(ctx)
    outcome = m.validate_and_promote("9", V9)
    assert outcome == "passed", f"with the sandbox healthy the outcome is {outcome!r}, expected 'passed'"
    calls = ctx.grpc.calls_to("Validate")
    assert calls, "no Validate call was made"
    for call in calls:
        assert call.timeout is not None, "the Validate call carries no deadline: a wedged sandbox would hold the promotion open"
        assert 9.5 <= call.timeout <= 10.5, f"the Validate call carries a {call.timeout} s deadline, expected VALIDATE_DEADLINE_S = 10"
    ctx.grpc.set_latency("Validate", 60.0)
    outcome = m.validate_and_promote("10", V10)
    assert outcome == "unavailable", f"a sandbox slower than the deadline left the outcome {outcome!r}, expected 'unavailable'"
    assert _active(ctx) == "9", f"catalog:active is {_active(ctx)!r} after a timed-out validation, expected '9'"


def check_scoped_credential(ctx):
    m = _client(ctx)
    m.validate_and_promote("9", V9)
    calls = ctx.grpc.calls_to("Validate")
    assert calls, "no Validate call was made"
    for call in calls:
        sent = dict(call.metadata)
        assert sent.get("authorization") == "Bearer sbx-validate-only", f"the sandbox received authorization {sent.get('authorization')!r}, expected 'Bearer sbx-validate-only' (SANDBOX_TOKEN)"
        leaked = [k for k, v in call.metadata if "pk-live" in str(v)]
        assert not leaked, f"the sandbox received the production provider key in {leaked}: the candidate code it runs can spend it"


def check_fail_closed(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Validate", grpc.StatusCode.UNAVAILABLE, "sandbox pool drained", times=5)
    outcome = m.validate_and_promote("9", V9)
    assert outcome == "unavailable", f"a sandbox that answered UNAVAILABLE left the outcome {outcome!r}, expected 'unavailable': no answer is not a pass"
    assert _active(ctx) == "7", f"catalog:active is {_active(ctx)!r}: a candidate nobody validated went live"
    verdict = catalog.validation("9")
    assert verdict is not None and verdict.get("outcome") == "unavailable" and verdict.get("reason"), f"catalog:validation:9 is {verdict}, expected outcome 'unavailable' with a reason"
    assert catalog.resolve("search") == S1, "agents must still resolve catalog 7"


def check_terminal_rejection(ctx):
    m = _client(ctx)
    outcome = m.validate_and_promote("9", BROKEN)
    assert outcome == "rejected", f"a candidate the sandbox refused with INVALID_ARGUMENT left the outcome {outcome!r}, expected 'rejected'"
    calls = len(ctx.grpc.calls_to("Validate"))
    assert calls == 1, f"a schema rejection was sent to the sandbox {calls} times: it is terminal for the candidate, not retried"
    verdict = catalog.validation("9")
    assert verdict is not None and verdict.get("outcome") == "rejected" and "broken.refund" in verdict.get("reason", ""), f"catalog:validation:9 is {verdict}, expected outcome 'rejected' with the sandbox's details"
    again = m.validate_and_promote("9", BROKEN)
    assert again == "rejected", f"a re-request for the rejected candidate answered {again!r}"
    assert len(ctx.grpc.calls_to("Validate")) == 1, "a re-request for a rejected candidate called the sandbox again: answer it from catalog:validation:9"
    assert _active(ctx) == "7", f"catalog:active is {_active(ctx)!r}: a rejected candidate went live"
    ctx.grpc.fail("Validate", grpc.StatusCode.UNAVAILABLE, "sandbox pool drained", times=1)
    first = m.validate_and_promote("10", V10)
    assert first == "unavailable", f"an UNAVAILABLE sandbox left candidate 10 {first!r}, expected 'unavailable'"
    second = m.validate_and_promote("10", V10)
    assert second == "passed", f"after an outage the next request for candidate 10 answered {second!r}: unavailable says nothing about the candidate, ask the sandbox again"
    assert _active(ctx) == "10", f"catalog:active is {_active(ctx)!r}, expected the validated candidate 10"
`,
    typescript: `function entry(name: string, version: string, sideEffect: string, owner: string) {
  return {name, version, side_effect: sideEffect, owner, schema: {type: 'object'}, endpoint: \`https://\${owner}.internal\`, credential_ref: \`vault://\${owner}\`};
}

const S1 = entry('search', 'a1', 'read', 'search');
const S2 = entry('search', 'a2', 'read', 'search');
const R1 = entry('refund', 'b1', 'irreversible', 'payments');
const R2 = entry('refund', 'b2', 'irreversible', 'payments');
const V7 = {search: S1, refund: R1};
const V9 = {search: S2, refund: R2};
const V10 = {search: S2, refund: R1};
const BROKEN = {search: S2, 'broken.refund': entry('broken.refund', 'c1', 'irreversible', 'payments')};

/** The sandbox exercises every tool; a tool named broken.* has a schema it cannot build arguments from. */
async function client(ctx) {
  const pkg = ctx.proto('tool_registry.proto');
  ctx.grpc.serve(pkg.toolsd.Sandbox.service, {
    Validate(call, callback) {
      const broken = call.request.tools.find(t => t.name.startsWith('broken.'));
      if (broken) return callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: \`tool \${broken.name}: the sandbox cannot build arguments from its schema\`});
      callback(null, {calls_exercised: call.request.tools.length});
    },
  });
  const catalog = ctx.load('/support/toolsd/catalog.ts');
  await catalog.recordValidation('7', 'passed', '');
  await catalog.promote('7', V7);
  return {m: ctx.load('client'), catalog};
}

const active = ctx => ctx.redis.get('catalog:active');

export async function check_deadline(ctx) {
  const {m} = await client(ctx);
  const outcome = await m.validateAndPromote('9', V9);
  assert.equal(outcome, 'passed', 'with the sandbox healthy the outcome must be passed');
  const calls = ctx.grpc.callsTo('Validate');
  assert(calls.length > 0, 'no Validate call was made');
  for (const call of calls) {
    assert(call.timeout !== null, 'the Validate call carries no deadline: a wedged sandbox would hold the promotion open');
    assert(9.5 <= call.timeout && call.timeout <= 10.5, \`the Validate call carries a \${call.timeout} s deadline, expected VALIDATE_DEADLINE_MS = 10000\`);
  }
  ctx.grpc.setLatency('Validate', 60.0);
  const late = await m.validateAndPromote('10', V10);
  assert.equal(late, 'unavailable', \`a sandbox slower than the deadline left the outcome \${late}, expected unavailable\`);
  assert.equal(active(ctx), '9', 'catalog:active after a timed-out validation');
}

export async function check_scoped_credential(ctx) {
  const {m} = await client(ctx);
  await m.validateAndPromote('9', V9);
  const calls = ctx.grpc.callsTo('Validate');
  assert(calls.length > 0, 'no Validate call was made');
  for (const call of calls) {
    const sent = call.metadata.get('authorization');
    assert.deepStrictEqual(sent, ['Bearer sbx-validate-only'], \`the sandbox received authorization \${JSON.stringify(sent)}, expected Bearer sbx-validate-only (SANDBOX_TOKEN)\`);
    const leaked = Object.entries(call.metadata.getMap()).filter(([, v]) => String(v).includes('pk-live'));
    assert.equal(leaked.length, 0, \`the sandbox received the production provider key in \${JSON.stringify(leaked)}: the candidate code it runs can spend it\`);
  }
}

export async function check_fail_closed(ctx) {
  const {m, catalog} = await client(ctx);
  ctx.grpc.fail('Validate', ctx.grpc.status.UNAVAILABLE, 'sandbox pool drained', 5);
  const outcome = await m.validateAndPromote('9', V9);
  assert.equal(outcome, 'unavailable', \`a sandbox that answered UNAVAILABLE left the outcome \${outcome}, expected unavailable: no answer is not a pass\`);
  assert.equal(active(ctx), '7', 'a candidate nobody validated went live: catalog:active');
  const verdict = await catalog.validation('9');
  assert(verdict !== null && verdict.outcome === 'unavailable' && verdict.reason, \`catalog:validation:9 is \${JSON.stringify(verdict)}, expected outcome unavailable with a reason\`);
  assert.equal((await catalog.resolve('search')).version, 'a1', 'agents must still resolve catalog 7');
}

export async function check_terminal_rejection(ctx) {
  const {m, catalog} = await client(ctx);
  const outcome = await m.validateAndPromote('9', BROKEN);
  assert.equal(outcome, 'rejected', \`a candidate the sandbox refused with INVALID_ARGUMENT left the outcome \${outcome}, expected rejected\`);
  const calls = ctx.grpc.callsTo('Validate').length;
  assert.equal(calls, 1, \`a schema rejection was sent to the sandbox \${calls} times: it is terminal for the candidate, not retried\`);
  const verdict = await catalog.validation('9');
  assert(verdict !== null && verdict.outcome === 'rejected' && verdict.reason.includes('broken.refund'), \`catalog:validation:9 is \${JSON.stringify(verdict)}, expected outcome rejected with the sandbox's details\`);
  assert.equal(await m.validateAndPromote('9', BROKEN), 'rejected', 'a re-request for the rejected candidate');
  assert.equal(ctx.grpc.callsTo('Validate').length, 1, 'a re-request for a rejected candidate called the sandbox again: answer it from catalog:validation:9');
  assert.equal(active(ctx), '7', 'a rejected candidate went live: catalog:active');
  ctx.grpc.fail('Validate', ctx.grpc.status.UNAVAILABLE, 'sandbox pool drained', 1);
  assert.equal(await m.validateAndPromote('10', V10), 'unavailable', 'an UNAVAILABLE sandbox must leave candidate 10 unavailable');
  const second = await m.validateAndPromote('10', V10);
  assert.equal(second, 'passed', \`after an outage the next request for candidate 10 answered \${second}: unavailable says nothing about the candidate, ask the sandbox again\`);
  assert.equal(active(ctx), '10', 'catalog:active after validating candidate 10');
}
`,
    go: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"toolsd/catalog"
	pb "toolsd/gen/tool_registry"

	"leetbuild/harness"
)

var clientBg = context.Background()

func entry(name, version, sideEffect, owner string) catalog.Entry {
	return catalog.Entry{"name": name, "version": version, "side_effect": sideEffect, "owner": owner, "schema": map[string]any{"type": "object"}, "endpoint": "https://" + owner + ".internal", "credential_ref": "vault://" + owner}
}

var (
	v7     = map[string]catalog.Entry{"search": entry("search", "a1", "read", "search"), "refund": entry("refund", "b1", "irreversible", "payments")}
	v9     = map[string]catalog.Entry{"search": entry("search", "a2", "read", "search"), "refund": entry("refund", "b2", "irreversible", "payments")}
	v10    = map[string]catalog.Entry{"search": entry("search", "a2", "read", "search"), "refund": entry("refund", "b1", "irreversible", "payments")}
	broken = map[string]catalog.Entry{"search": entry("search", "a2", "read", "search"), "broken.refund": entry("broken.refund", "c1", "irreversible", "payments")}
)

// sandboxPeer exercises every tool; a tool named broken.* has a schema it cannot build arguments from.
type sandboxPeer struct {
	pb.UnimplementedSandboxServer
}

func (sandboxPeer) Validate(_ context.Context, req *pb.ValidateRequest) (*pb.ValidateReport, error) {
	for _, tool := range req.GetTools() {
		if strings.HasPrefix(tool.GetName(), "broken.") {
			return nil, status.Errorf(codes.InvalidArgument, "tool %s: the sandbox cannot build arguments from its schema", tool.GetName())
		}
	}
	return &pb.ValidateReport{CallsExercised: int32(len(req.GetTools()))}, nil
}

func client(ctx *harness.Ctx) {
	pb.RegisterSandboxServer(ctx.GRPC.Server(""), sandboxPeer{})
	ctx.NoError(catalog.RecordValidation(clientBg, "7", "passed", ""), "seeding catalog 7 failed")
	ctx.NoError(catalog.Promote(clientBg, "7", v7), "seeding catalog 7 failed")
}

func outcomeOf(ctx *harness.Ctx, cv string, entries map[string]catalog.Entry) string {
	outcome, err := validateAndPromote(clientBg, cv, entries)
	ctx.NoError(err, "validateAndPromote(%s) failed", cv)
	return outcome
}

func active(ctx *harness.Ctx) string {
	cv, _ := ctx.Redis.Get("catalog:active")
	return cv
}

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	ctx.Equal(outcomeOf(ctx, "9", v9), "passed", "with the sandbox healthy, the outcome")
	calls := ctx.GRPC.CallsTo("Validate", "")
	ctx.Assert(len(calls) > 0, "no Validate call was made")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "the Validate call carries no deadline: a wedged sandbox would hold the promotion open")
		ctx.Assert(9500*time.Millisecond <= call.Timeout && call.Timeout <= 10500*time.Millisecond, "the Validate call carries a %v deadline, expected validateDeadline = 10 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Validate", 60.0, "")
	ctx.Equal(outcomeOf(ctx, "10", v10), "unavailable", "a sandbox slower than the deadline; the outcome")
	ctx.Equal(active(ctx), "9", "catalog:active after a timed-out validation")
}

func CheckScopedCredential(ctx *harness.Ctx) {
	client(ctx)
	outcomeOf(ctx, "9", v9)
	calls := ctx.GRPC.CallsTo("Validate", "")
	ctx.Assert(len(calls) > 0, "no Validate call was made")
	for _, call := range calls {
		ctx.Equal(call.Metadata.Get("authorization"), []string{"Bearer sbx-validate-only"}, "the authorization the sandbox received (SANDBOX_TOKEN)")
		for key, values := range call.Metadata {
			for _, v := range values {
				ctx.Assert(!strings.Contains(v, "pk-live"), "the sandbox received the production provider key in %s: the candidate code it runs can spend it", key)
			}
		}
	}
}

func CheckFailClosed(ctx *harness.Ctx) {
	client(ctx)
	ctx.GRPC.Fail("Validate", codes.Unavailable, "sandbox pool drained", 5, "")
	ctx.Equal(outcomeOf(ctx, "9", v9), "unavailable", "a sandbox that answered UNAVAILABLE gave no verdict, and no answer is not a pass; the outcome")
	ctx.Equal(active(ctx), "7", "a candidate nobody validated must not go live; catalog:active")
	verdict, err := catalog.Validation(clientBg, "9")
	ctx.NoError(err, "catalog.Validation failed")
	ctx.Assert(verdict["outcome"] == "unavailable" && verdict["reason"] != "", "catalog:validation:9 is %v, expected outcome unavailable with a reason", verdict)
	e, _ := catalog.Resolve(clientBg, "search", "")
	ctx.Equal(e["version"], "a1", "agents must still resolve catalog 7; the search version")
}

func CheckTerminalRejection(ctx *harness.Ctx) {
	client(ctx)
	ctx.Equal(outcomeOf(ctx, "9", broken), "rejected", "a candidate the sandbox refused with INVALID_ARGUMENT; the outcome")
	ctx.Equal(len(ctx.GRPC.CallsTo("Validate", "")), 1, "a schema rejection is terminal for the candidate, not retried; the Validate calls")
	verdict, _ := catalog.Validation(clientBg, "9")
	ctx.Assert(verdict["outcome"] == "rejected" && strings.Contains(verdict["reason"], "broken.refund"), "catalog:validation:9 is %v, expected outcome rejected with the sandbox's details", verdict)
	ctx.Equal(outcomeOf(ctx, "9", broken), "rejected", "a re-request for the rejected candidate")
	ctx.Equal(len(ctx.GRPC.CallsTo("Validate", "")), 1, "a re-request for a rejected candidate must be answered from catalog:validation:9; the Validate calls")
	ctx.Equal(active(ctx), "7", "a rejected candidate must not go live; catalog:active")
	ctx.GRPC.Fail("Validate", codes.Unavailable, "sandbox pool drained", 1, "")
	ctx.Equal(outcomeOf(ctx, "10", v10), "unavailable", "an UNAVAILABLE sandbox; candidate 10's outcome")
	ctx.Equal(outcomeOf(ctx, "10", v10), "passed", "after an outage the next request must ask the sandbox again (unavailable says nothing about the candidate); candidate 10's outcome")
	ctx.Equal(active(ctx), "10", "catalog:active after validating candidate 10")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>

using json = nlohmann::json;

namespace {

json entry(const std::string& name, const std::string& version, const std::string& side_effect, const std::string& owner) {
  return json{{"name", name},   {"version", version},  {"side_effect", side_effect}, {"owner", owner}, {"schema", {{"type", "object"}}},
              {"endpoint", "https://" + owner + ".internal"}, {"credential_ref", "vault://" + owner}};
}

const json kV7 = {{"search", entry("search", "a1", "read", "search")}, {"refund", entry("refund", "b1", "irreversible", "payments")}};
const json kV9 = {{"search", entry("search", "a2", "read", "search")}, {"refund", entry("refund", "b2", "irreversible", "payments")}};
const json kV10 = {{"search", entry("search", "a2", "read", "search")}, {"refund", entry("refund", "b1", "irreversible", "payments")}};
const json kBroken = {{"search", entry("search", "a2", "read", "search")}, {"broken.refund", entry("broken.refund", "c1", "irreversible", "payments")}};

// Exercises every tool; a tool named broken.* has a schema it cannot build arguments from.
class SandboxPeer final : public toolsd::Sandbox::Service {
 public:
  grpc::Status Validate(grpc::ServerContext*, const toolsd::ValidateRequest* req, toolsd::ValidateReport* out) override {
    for (const auto& tool : req->tools()) {
      if (tool.name().rfind("broken.", 0) == 0) {
        return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "tool " + tool.name() + ": the sandbox cannot build arguments from its schema");
      }
    }
    out->set_calls_exercised(req->tools_size());
    return grpc::Status::OK;
  }
};

void client(harness::Ctx& ctx) {
  static SandboxPeer* peer = nullptr;
  delete peer;
  peer = new SandboxPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  catalog::recordValidation("7", "passed", "");
  catalog::promote("7", kV7);
}

std::string active(harness::Ctx& ctx) { return ctx.Redis.Get("catalog:active").value_or(""); }

std::string verdictOf(const std::string& cv, const std::string& field) {
  const auto verdict = catalog::validation(cv);
  if (!verdict) return "";
  const auto found = verdict->find(field);
  return found == verdict->end() ? "" : found->second;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  ctx.Equal(validateAndPromote("9", kV9), "passed", "with the sandbox healthy, the outcome");
  const auto calls = ctx.GRPC.CallsTo("Validate");
  ctx.Assert(!calls.empty(), "no Validate call was made");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "the Validate call carries no deadline: a wedged sandbox would hold the promotion open");
    ctx.Assert(9.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 10.5, "the Validate call carries a %v s deadline, expected kValidateDeadline = 10 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Validate", 60.0);
  ctx.Equal(validateAndPromote("10", kV10), "unavailable", "a sandbox slower than the deadline; the outcome");
  ctx.Equal(active(ctx), "9", "catalog:active after a timed-out validation");
}

void CheckScopedCredential(harness::Ctx& ctx) {
  client(ctx);
  validateAndPromote("9", kV9);
  const auto calls = ctx.GRPC.CallsTo("Validate");
  ctx.Assert(!calls.empty(), "no Validate call was made");
  for (const auto& call : calls) {
    const auto found = call.Metadata.find("authorization");
    const std::string sent = found == call.Metadata.end() ? "" : found->second;
    ctx.Equal(sent, "Bearer sbx-validate-only", "the authorization the sandbox received (kSandboxToken)");
    for (const auto& [key, value] : call.Metadata) {
      ctx.Assert(value.find("pk-live") == std::string::npos, "the sandbox received the production provider key in %s: the candidate code it runs can spend it", key);
    }
  }
}

void CheckFailClosed(harness::Ctx& ctx) {
  client(ctx);
  ctx.GRPC.Fail("Validate", grpc::StatusCode::UNAVAILABLE, "sandbox pool drained", 5);
  ctx.Equal(validateAndPromote("9", kV9), "unavailable", "a sandbox that answered UNAVAILABLE gave no verdict, and no answer is not a pass; the outcome");
  ctx.Equal(active(ctx), "7", "a candidate nobody validated must not go live; catalog:active");
  ctx.Assert(verdictOf("9", "outcome") == "unavailable" && !verdictOf("9", "reason").empty(), "catalog:validation:9 has outcome %q and reason %q, expected unavailable with a reason", verdictOf("9", "outcome"), verdictOf("9", "reason"));
  const auto search = catalog::resolve("search");
  ctx.Equal(search ? search->value("version", "") : "", "a1", "agents must still resolve catalog 7; the search version");
}

void CheckTerminalRejection(harness::Ctx& ctx) {
  client(ctx);
  ctx.Equal(validateAndPromote("9", kBroken), "rejected", "a candidate the sandbox refused with INVALID_ARGUMENT; the outcome");
  ctx.Equal(ctx.GRPC.CallsTo("Validate").size(), 1, "a schema rejection is terminal for the candidate, not retried; the Validate calls");
  ctx.Assert(verdictOf("9", "outcome") == "rejected" && verdictOf("9", "reason").find("broken.refund") != std::string::npos, "catalog:validation:9 has outcome %q and reason %q, expected rejected with the sandbox's details", verdictOf("9", "outcome"), verdictOf("9", "reason"));
  ctx.Equal(validateAndPromote("9", kBroken), "rejected", "a re-request for the rejected candidate");
  ctx.Equal(ctx.GRPC.CallsTo("Validate").size(), 1, "a re-request for a rejected candidate must be answered from catalog:validation:9; the Validate calls");
  ctx.Equal(active(ctx), "7", "a rejected candidate must not go live; catalog:active");
  ctx.GRPC.Fail("Validate", grpc::StatusCode::UNAVAILABLE, "sandbox pool drained", 1);
  ctx.Equal(validateAndPromote("10", kV10), "unavailable", "an UNAVAILABLE sandbox; candidate 10's outcome");
  ctx.Equal(validateAndPromote("10", kV10), "passed", "after an outage the next request must ask the sandbox again (unavailable says nothing about the candidate); candidate 10's outcome");
  ctx.Equal(active(ctx), "10", "catalog:active after validating candidate 10");
}
`,
  },
  hints: [
    'Make the sandbox time out or answer UNAVAILABLE: the candidate goes live anyway and its recorded outcome says passed. Then look at the authorization header the sandbox receives.',
    'The retry loop catches every error and falls through to the promotion, so a failure and a success end the same way. Nothing reads the recorded verdict first, the call has no deadline, and the metadata carries `PROVIDER_API_KEY`.',
    'Read `catalog.validation(cv)` and answer `passed`/`rejected` from it; one call with `timeout=VALIDATE_DEADLINE_S` and `Bearer {SANDBOX_TOKEN}`; INVALID_ARGUMENT → record `rejected`; any other error → record `unavailable`; promote only after OK.',
  ],
  debrief: `The sandbox's status code already separates the two things that can go wrong: the candidate is bad (INVALID_ARGUMENT), or the sandbox could not say (a deadline, UNAVAILABLE). The fix keeps them apart. A bad candidate is remembered, so a re-request costs nothing and cannot flip the answer; an outage leaves the candidate unjudged and the active catalog where it was. The deadline bounds how long a promotion can hang on the sandbox, and the scoped token bounds what a hostile candidate can do with the credential it is handed. Production registries run candidates in throwaway sandboxes with no network egress, store the sandbox's report next to the verdict, and alert when unavailable verdicts pile up.`,
};
