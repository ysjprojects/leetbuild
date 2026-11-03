import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'A validator call that gates promotion',
  concept: 'grpc',
  file: 'client',
  focus: ['registry', 'validator', 'redis'],
  task: `## Task

**Starting point.** The starter is the promotion gate:
\`validate_and_promote(dataset, version, actor)\` reads the record (\`store.version\`), asks the
validator over gRPC for a report on the first \`SAMPLE_ROWS\` = 1000 rows, records \`validated\` with
\`store.set_validation\` and calls \`pointer.promote\` (step 2, provided). With a healthy validator it
promotes, and it hides four flaws.

**Failure mode the checks target.** A stalled validator holds the promotion open with no end; a
validator that is down or late lets unchecked bytes become \`latest\`; a report that says \`passed:
false\` promotes anyway; and a bad row past the first thousand is never read.

\`\`\`proto
service Validator { rpc Validate(ValidateRequest) returns (ValidationReport); }
// ValidateRequest {dataset, version, content_sha256, max_rows}  (max_rows 0: every row)
// ValidationReport {passed, rows_scanned, rows_total, failures}
\`\`\`

- Every call carries a **\`DEADLINE_S\` = 30 s** deadline.
- A failed call (\`DEADLINE_EXCEEDED\`, \`UNAVAILABLE\`, any status) is no verdict: status \`pending\`,
  raise \`ValidationPending\`, no promotion.
- \`passed: false\` records \`rejected\` with the report and returns \`"rejected"\`; no promotion.
- The request asks for every row (\`max_rows\` = 0); a report with \`rows_scanned\` below the record's
  \`row_count\` is \`pending\` as well.
- Only a full pass records \`validated\` with the report and promotes.`,
  sequence: {
    participants: ['registryd', 'Validator', 'Redis pointer'],
    messages: [
      {from: 'registryd', to: 'Validator', label: 'Validate · max_rows 0 · deadline 30 s', kind: 'sync'},
      {
        from: 'Validator',
        to: 'registryd',
        label: 'report · or DEADLINE_EXCEEDED / UNAVAILABLE → pending',
        kind: 'reply',
      },
      {
        from: 'registryd',
        to: 'registryd',
        label: 'rows_scanned < row_count → pending · !passed → rejected',
        kind: 'sync',
      },
      {from: 'registryd', to: 'Redis pointer', label: 'promote only on a full pass', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'The validator call carries a 30-second deadline',
      detail:
        'Every `Validate` call is made with `DEADLINE_S` (30 s), so a stalled validator turns into `ValidationPending` after 30 seconds. The starter sets no deadline at all.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*30\b/, /Validate\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*30_?000\b/, /Validate\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*30\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*30L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{30\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'timeout-no-promote',
      title: 'No verdict marks the version pending and leaves the pointer',
      detail:
        'A failed call records `pending` and raises `ValidationPending`; the previous version stays latest. The starter swallows the error and promotes, so unchecked bytes reach training.',
      match: {
        python: {all: [/raise ValidationPending/, /["']pending["']/], none: [/except grpc\.RpcError:\s*\n\s*pass\b/]},
        typescript: {all: [/throw new ValidationPending/, /'pending'/]},
        go: {all: [/Errorf\([^\n]*ErrValidationPending/, /"pending"/]},
        scala: {all: [/throw new ValidationPending/, /"pending"/]},
        cpp: {all: [/throw ValidationPending/, /"pending"/]},
      },
    },
    {
      id: 'rejected-held',
      title: 'A failed report is rejected, not promoted',
      detail:
        'A report with `passed: false` records `rejected` with the report and returns without promoting. The starter records `validated` for any report that came back.',
      match: {
        python: {all: [/["']rejected["']/]},
        typescript: {all: [/'rejected'/]},
        go: {all: [/"rejected"/]},
        scala: {all: [/"rejected"/]},
        cpp: {all: [/"rejected"/]},
      },
    },
    {
      id: 'coverage',
      title: 'A pass counts only when it covers every row',
      detail:
        "The request sets `max_rows` to 0 (every row), and a report whose `rows_scanned` is below the record's `row_count` is `pending`. The starter asks for a 1000-row sample, so a bad row at 1200 is never seen.",
      match: {
        python: {all: [/max_rows\s*=\s*0\b/, /rows_scanned\s*</], none: [/SAMPLE_ROWS/]},
        typescript: {all: [/max_rows:\s*0\b/, /rows_scanned\)?\s*</], none: [/SAMPLE_ROWS/]},
        go: {all: [/MaxRows:\s*0\b/, /GetRowsScanned\(\)\s*</], none: [/sampleRows/]},
        scala: {all: [/maxRows\s*=\s*0L?\b/, /rowsScanned\s*</], none: [/SampleRows/]},
        cpp: {all: [/set_max_rows\(\s*0\s*\)/, /rows_scanned\(\)\s*</], none: [/kSampleRows/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import dataset_registry_pb2
import dataset_registry_pb2_grpc
from registry import pointer, store

SAMPLE_ROWS = 1000

validator = dataset_registry_pb2_grpc.ValidatorStub(grpc.insecure_channel("validator:9000"))


class ValidationPending(Exception):
    """The validator gave no verdict on every row: the version stays a candidate and the latest stays put."""


def report_of(reply) -> dict:
    return {"passed": reply.passed, "rows_scanned": reply.rows_scanned, "rows_total": reply.rows_total, "failures": list(reply.failures)}


def validate_and_promote(dataset: str, version: str, actor: str) -> str:
    """Validate a registered version and promote it when it passed; returns its status (validated or rejected)."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    record = store.version(dataset, version)
    if record is None:
        raise KeyError(f"{dataset}@{version} is not registered")
    request = dataset_registry_pb2.ValidateRequest(dataset=dataset, version=version, content_sha256=record["content_sha256"], max_rows=SAMPLE_ROWS)
    try:
        reply = validator.Validate(request)
        store.set_validation(dataset, version, "validated", report_of(reply))
    except grpc.RpcError:
        pass  # the upload path already checked the bytes; a slow validator must not block training
    pointer.promote(dataset, version, actor)
    return "validated"
`,
      solution: `import grpc

import dataset_registry_pb2
import dataset_registry_pb2_grpc
from registry import pointer, store

DEADLINE_S = 30

validator = dataset_registry_pb2_grpc.ValidatorStub(grpc.insecure_channel("validator:9000"))


class ValidationPending(Exception):
    """The validator gave no verdict on every row: the version stays a candidate and the latest stays put."""


def report_of(reply) -> dict:
    return {"passed": reply.passed, "rows_scanned": reply.rows_scanned, "rows_total": reply.rows_total, "failures": list(reply.failures)}


def validate_and_promote(dataset: str, version: str, actor: str) -> str:
    """Validate a registered version and promote it when it passed; returns its status (validated or rejected)."""
    record = store.version(dataset, version)
    if record is None:
        raise KeyError(f"{dataset}@{version} is not registered")
    request = dataset_registry_pb2.ValidateRequest(dataset=dataset, version=version, content_sha256=record["content_sha256"], max_rows=0)
    try:
        reply = validator.Validate(request, timeout=DEADLINE_S)
    except grpc.RpcError as exc:
        # DEADLINE_EXCEEDED, UNAVAILABLE and the rest say nothing about the bytes: no verdict yet.
        store.set_validation(dataset, version, "pending", None)
        raise ValidationPending(f"validator: {exc.code().name}") from exc
    report = report_of(reply)
    if reply.rows_scanned < record["row_count"]:
        store.set_validation(dataset, version, "pending", report)
        raise ValidationPending(f"validator scanned {reply.rows_scanned} of {record['row_count']} rows")
    if not reply.passed:
        store.set_validation(dataset, version, "rejected", report)
        return "rejected"
    store.set_validation(dataset, version, "validated", report)
    pointer.promote(dataset, version, actor)
    return "validated"
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {promote} from 'registry/pointer';
import {type Report, setValidation, version as versionOf} from 'registry/store';

export const SAMPLE_ROWS = 1000;

interface ValidateRequest {
  dataset: string;
  version: string;
  content_sha256: string;
  max_rows: number;
}

interface ValidationReport {
  passed: boolean;
  rows_scanned: number | string;
  rows_total: number | string;
  failures: string[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('dataset_registry.proto')) as unknown as {
  datasetregistry: {Validator: grpc.ServiceClientConstructor};
};
const validator = new pkg.datasetregistry.Validator('validator:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Validate(request: ValidateRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<ValidationReport>;
};

/** The validator gave no verdict on every row: the version stays a candidate and the latest stays put. */
export class ValidationPending extends Error {}

export const reportOf = (reply: ValidationReport): Report => ({
  passed: Boolean(reply.passed),
  rows_scanned: Number(reply.rows_scanned),
  rows_total: Number(reply.rows_total),
  failures: [...(reply.failures ?? [])],
});

/** Validate a registered version and promote it when it passed; returns its status (validated or rejected). */
export async function validateAndPromote(dataset: string, version: string, actor: string): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const record = await versionOf(dataset, version);
  if (record === null) throw new Error(\`\${dataset}@\${version} is not registered\`);
  try {
    const reply = await validator.Validate(
      {dataset, version, content_sha256: record.content_sha256, max_rows: SAMPLE_ROWS},
      new grpc.Metadata(),
      {},
    );
    await setValidation(dataset, version, 'validated', reportOf(reply));
  } catch {
    // the upload path already checked the bytes; a slow validator must not block training
  }
  await promote(dataset, version, actor);
  return 'validated';
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {promote} from 'registry/pointer';
import {type Report, setValidation, version as versionOf} from 'registry/store';

export const DEADLINE_MS = 30_000;

interface ValidateRequest {
  dataset: string;
  version: string;
  content_sha256: string;
  max_rows: number;
}

interface ValidationReport {
  passed: boolean;
  rows_scanned: number | string;
  rows_total: number | string;
  failures: string[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('dataset_registry.proto')) as unknown as {
  datasetregistry: {Validator: grpc.ServiceClientConstructor};
};
const validator = new pkg.datasetregistry.Validator('validator:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Validate(request: ValidateRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<ValidationReport>;
};

/** The validator gave no verdict on every row: the version stays a candidate and the latest stays put. */
export class ValidationPending extends Error {}

export const reportOf = (reply: ValidationReport): Report => ({
  passed: Boolean(reply.passed),
  rows_scanned: Number(reply.rows_scanned),
  rows_total: Number(reply.rows_total),
  failures: [...(reply.failures ?? [])],
});

/** Validate a registered version and promote it when it passed; returns its status (validated or rejected). */
export async function validateAndPromote(dataset: string, version: string, actor: string): Promise<string> {
  const record = await versionOf(dataset, version);
  if (record === null) throw new Error(\`\${dataset}@\${version} is not registered\`);
  let reply: ValidationReport;
  try {
    reply = await validator.Validate(
      {dataset, version, content_sha256: record.content_sha256, max_rows: 0},
      new grpc.Metadata(),
      {deadline: Date.now() + DEADLINE_MS},
    );
  } catch (e) {
    // DEADLINE_EXCEEDED, UNAVAILABLE and the rest say nothing about the bytes: no verdict yet.
    await setValidation(dataset, version, 'pending', null);
    throw new ValidationPending(\`validator: \${grpc.status[(e as grpc.ServiceError).code]}\`);
  }
  const report = reportOf(reply);
  if (Number(reply.rows_scanned) < record.row_count) {
    await setValidation(dataset, version, 'pending', report);
    throw new ValidationPending(\`validator scanned \${report.rows_scanned} of \${record.row_count} rows\`);
  }
  if (!report.passed) {
    await setValidation(dataset, version, 'rejected', report);
    return 'rejected';
  }
  await setValidation(dataset, version, 'validated', report);
  await promote(dataset, version, actor);
  return 'validated';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"registry/pointer" // pointer.Promote(ctx, dataset, version, actor) (string, error)
	"registry/store"   // store.Version, SetValidation, Report
	pb "datasetregistry/gen/dataset_registry"
)

const sampleRows = 1000

var (
	validatorConn, _ = grpc.NewClient("validator:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	validator        = pb.NewValidatorClient(validatorConn)
)

// ErrValidationPending: the validator gave no verdict on every row, the version stays a candidate
// and the latest stays put.
var ErrValidationPending = errors.New("validation pending")

func reportOf(reply *pb.ValidationReport) *store.Report {
	return &store.Report{Passed: reply.GetPassed(), RowsScanned: reply.GetRowsScanned(), RowsTotal: reply.GetRowsTotal(), Failures: append([]string{}, reply.GetFailures()...)}
}

// validateAndPromote validates a registered version and promotes it when it passed; it returns its
// status (validated or rejected).
func validateAndPromote(ctx context.Context, dataset, version, actor string) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	record := store.Version(ctx, dataset, version)
	if record == nil {
		return "", fmt.Errorf("%s@%s is not registered", dataset, version)
	}
	reply, err := validator.Validate(ctx, &pb.ValidateRequest{Dataset: dataset, Version: version, ContentSha256: record.ContentSHA256, MaxRows: sampleRows})
	if err == nil {
		store.SetValidation(ctx, dataset, version, "validated", reportOf(reply))
	} // on an error: the upload path already checked the bytes; a slow validator must not block training
	if _, err := pointer.Promote(ctx, dataset, version, actor); err != nil {
		return "", err
	}
	return "validated", nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"registry/pointer" // pointer.Promote(ctx, dataset, version, actor) (string, error)
	"registry/store"   // store.Version, SetValidation, Report
	pb "datasetregistry/gen/dataset_registry"
)

const deadline = 30 * time.Second

var (
	validatorConn, _ = grpc.NewClient("validator:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	validator        = pb.NewValidatorClient(validatorConn)
)

// ErrValidationPending: the validator gave no verdict on every row, the version stays a candidate
// and the latest stays put.
var ErrValidationPending = errors.New("validation pending")

func reportOf(reply *pb.ValidationReport) *store.Report {
	return &store.Report{Passed: reply.GetPassed(), RowsScanned: reply.GetRowsScanned(), RowsTotal: reply.GetRowsTotal(), Failures: append([]string{}, reply.GetFailures()...)}
}

// validateAndPromote validates a registered version and promotes it when it passed; it returns its
// status (validated or rejected).
func validateAndPromote(ctx context.Context, dataset, version, actor string) (string, error) {
	record := store.Version(ctx, dataset, version)
	if record == nil {
		return "", fmt.Errorf("%s@%s is not registered", dataset, version)
	}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	reply, err := validator.Validate(callCtx, &pb.ValidateRequest{Dataset: dataset, Version: version, ContentSha256: record.ContentSHA256, MaxRows: 0})
	if err != nil {
		// DeadlineExceeded, Unavailable and the rest say nothing about the bytes: no verdict yet.
		if err := store.SetValidation(ctx, dataset, version, "pending", nil); err != nil {
			return "", err
		}
		return "", fmt.Errorf("%w: validator: %v", ErrValidationPending, status.Code(err))
	}
	report := reportOf(reply)
	if reply.GetRowsScanned() < record.RowCount {
		if err := store.SetValidation(ctx, dataset, version, "pending", report); err != nil {
			return "", err
		}
		return "", fmt.Errorf("%w: validator scanned %d of %d rows", ErrValidationPending, reply.GetRowsScanned(), record.RowCount)
	}
	if !reply.GetPassed() {
		return "rejected", store.SetValidation(ctx, dataset, version, "rejected", report)
	}
	if err := store.SetValidation(ctx, dataset, version, "validated", report); err != nil {
		return "", err
	}
	if _, err := pointer.Promote(ctx, dataset, version, actor); err != nil {
		return "", err
	}
	return "validated", nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import spray.json._

import registry.{Pointer, Store} // Pointer.promote, Store.version, Store.setValidation
import datasetregistry.dataset_registry.{ValidateRequest, ValidationReport, ValidatorGrpc}

/** The validator gave no verdict on every row: the version stays a candidate and the latest stays put. */
final class ValidationPending(message: String) extends Exception(message)

object Client {
  val SampleRows = 1000L

  private val validator = ValidatorGrpc.blockingStub(ManagedChannelBuilder.forAddress("validator", 9000).usePlaintext().build())

  def reportOf(reply: ValidationReport): JsObject = JsObject(
    "passed" -> JsBoolean(reply.passed), "rows_scanned" -> JsNumber(reply.rowsScanned), "rows_total" -> JsNumber(reply.rowsTotal),
    "failures" -> JsArray(reply.failures.map(JsString(_)).toVector))

  /** Validate a registered version and promote it when it passed; returns its status (validated or rejected). */
  def validateAndPromote(dataset: String, version: String, actor: String): String = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val record = Store.version(dataset, version).getOrElse(throw new IllegalArgumentException(s"$dataset@$version is not registered"))
    val request = ValidateRequest(dataset = dataset, version = version, contentSha256 = record.contentSha256, maxRows = SampleRows)
    try Store.setValidation(dataset, version, "validated", Some(reportOf(validator.validate(request))))
    catch { case _: StatusRuntimeException => () } // the upload path already checked the bytes; a slow validator must not block training
    Pointer.promote(dataset, version, actor)
    "validated"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import spray.json._

import registry.{Pointer, Store} // Pointer.promote, Store.version, Store.setValidation
import datasetregistry.dataset_registry.{ValidateRequest, ValidationReport, ValidatorGrpc}

/** The validator gave no verdict on every row: the version stays a candidate and the latest stays put. */
final class ValidationPending(message: String) extends Exception(message)

object Client {
  val DeadlineSeconds = 30L

  private val validator = ValidatorGrpc.blockingStub(ManagedChannelBuilder.forAddress("validator", 9000).usePlaintext().build())

  def reportOf(reply: ValidationReport): JsObject = JsObject(
    "passed" -> JsBoolean(reply.passed), "rows_scanned" -> JsNumber(reply.rowsScanned), "rows_total" -> JsNumber(reply.rowsTotal),
    "failures" -> JsArray(reply.failures.map(JsString(_)).toVector))

  /** Validate a registered version and promote it when it passed; returns its status (validated or rejected). */
  def validateAndPromote(dataset: String, version: String, actor: String): String = {
    val record = Store.version(dataset, version).getOrElse(throw new IllegalArgumentException(s"$dataset@$version is not registered"))
    val request = ValidateRequest(dataset = dataset, version = version, contentSha256 = record.contentSha256, maxRows = 0L)
    val reply =
      try validator.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).validate(request)
      catch {
        // DEADLINE_EXCEEDED, UNAVAILABLE and the rest say nothing about the bytes: no verdict yet.
        case e: StatusRuntimeException =>
          Store.setValidation(dataset, version, "pending", None)
          throw new ValidationPending(s"validator: \${e.getStatus.getCode}")
      }
    val report = reportOf(reply)
    if (reply.rowsScanned < record.rowCount) {
      Store.setValidation(dataset, version, "pending", Some(report))
      throw new ValidationPending(s"validator scanned \${reply.rowsScanned} of \${record.rowCount} rows")
    }
    if (!reply.passed) {
      Store.setValidation(dataset, version, "rejected", Some(report))
      "rejected"
    } else {
      Store.setValidation(dataset, version, "validated", Some(report))
      Pointer.promote(dataset, version, actor)
      "validated"
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <stdexcept>
#include <string>
#include <vector>

#include "registry/pointer.h"  // pointer::promote(dataset, version, actor) -> previous
#include "registry/store.h"    // store::version, setValidation
#include "dataset_registry.grpc.pb.h"

using json = nlohmann::json;

constexpr long kSampleRows = 1000;

auto validator = datasetregistry::Validator::NewStub(grpc::CreateChannel("validator:9000", grpc::InsecureChannelCredentials()));

// The validator gave no verdict on every row: the version stays a candidate and the latest stays put.
struct ValidationPending : std::runtime_error {
  using std::runtime_error::runtime_error;
};

json reportOf(const datasetregistry::ValidationReport& reply) {
  std::vector<std::string> failures;
  for (int i = 0; i < reply.failures_size(); i++) failures.push_back(reply.failures(i));
  return json{{"passed", reply.passed()}, {"rows_scanned", reply.rows_scanned()}, {"rows_total", reply.rows_total()}, {"failures", failures}};
}

// Validate a registered version and promote it when it passed; returns its status (validated or rejected).
std::string validateAndPromote(const std::string& dataset, const std::string& version, const std::string& actor) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto record = store::version(dataset, version);
  if (!record) throw std::invalid_argument(dataset + "@" + version + " is not registered");
  grpc::ClientContext ctx;
  datasetregistry::ValidateRequest request;
  request.set_dataset(dataset);
  request.set_version(version);
  request.set_content_sha256(record->content_sha256);
  request.set_max_rows(kSampleRows);
  datasetregistry::ValidationReport reply;
  // On an error: the upload path already checked the bytes; a slow validator must not block training.
  if (validator->Validate(&ctx, request, &reply).ok()) store::setValidation(dataset, version, "validated", reportOf(reply));
  pointer::promote(dataset, version, actor);
  return "validated";
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

#include "registry/pointer.h"  // pointer::promote(dataset, version, actor) -> previous
#include "registry/store.h"    // store::version, setValidation
#include "dataset_registry.grpc.pb.h"

using json = nlohmann::json;

constexpr std::chrono::seconds kDeadline{30};

auto validator = datasetregistry::Validator::NewStub(grpc::CreateChannel("validator:9000", grpc::InsecureChannelCredentials()));

// The validator gave no verdict on every row: the version stays a candidate and the latest stays put.
struct ValidationPending : std::runtime_error {
  using std::runtime_error::runtime_error;
};

json reportOf(const datasetregistry::ValidationReport& reply) {
  std::vector<std::string> failures;
  for (int i = 0; i < reply.failures_size(); i++) failures.push_back(reply.failures(i));
  return json{{"passed", reply.passed()}, {"rows_scanned", reply.rows_scanned()}, {"rows_total", reply.rows_total()}, {"failures", failures}};
}

// Validate a registered version and promote it when it passed; returns its status (validated or rejected).
std::string validateAndPromote(const std::string& dataset, const std::string& version, const std::string& actor) {
  const auto record = store::version(dataset, version);
  if (!record) throw std::invalid_argument(dataset + "@" + version + " is not registered");
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  datasetregistry::ValidateRequest request;
  request.set_dataset(dataset);
  request.set_version(version);
  request.set_content_sha256(record->content_sha256);
  request.set_max_rows(0);
  datasetregistry::ValidationReport reply;
  const grpc::Status status = validator->Validate(&ctx, request, &reply);
  if (!status.ok()) {
    // DEADLINE_EXCEEDED, UNAVAILABLE and the rest say nothing about the bytes: no verdict yet.
    store::setValidation(dataset, version, "pending", std::nullopt);
    throw ValidationPending("validator: " + status.error_message());
  }
  const json report = reportOf(reply);
  if (reply.rows_scanned() < record->row_count) {
    store::setValidation(dataset, version, "pending", report);
    throw ValidationPending("validator scanned " + std::to_string(reply.rows_scanned()) + " of " + std::to_string(record->row_count) + " rows");
  }
  if (!reply.passed()) {
    store::setValidation(dataset, version, "rejected", report);
    return "rejected";
  }
  store::setValidation(dataset, version, "validated", report);
  pointer::promote(dataset, version, actor);
  return "validated";
}
`,
    },
  },
  harness: {
    python: `import grpc

import dataset_registry_pb2
import dataset_registry_pb2_grpc
from registry import pointer, store

DS = "imdb-reviews"


class Validator(dataset_registry_pb2_grpc.ValidatorServicer):
    """Scans the object's rows (every row when max_rows is 0); a row marked BAD fails. A cap truncates every scan."""

    def __init__(self):
        self.cap = 0

    def Validate(self, request, context):
        content = store.read_object(request.content_sha256)
        if content is None:
            context.abort(grpc.StatusCode.NOT_FOUND, f"no object {request.content_sha256}")
        rows = [line for line in content.split("\\n") if line]
        limit = len(rows) if request.max_rows <= 0 else min(request.max_rows, len(rows))
        if self.cap:
            limit = min(limit, self.cap)
        failures = [f"row {i + 1}: label missing" for i, row in enumerate(rows[:limit]) if "BAD" in row]
        return dataset_registry_pb2.ValidationReport(passed=not failures, rows_scanned=limit, rows_total=len(rows), failures=failures)


def _register(version, n, bad_at=0):
    content = "".join(f"{i},review {i},{'BAD' if i == bad_at else 'pos'}\\n" for i in range(1, n + 1))
    sha = store.put_object(content)
    store.put_version({"tenant": "t1", "dataset": DS, "version": version, "content_sha256": sha, "license": "mit", "owner": "team-lm", "size_bytes": len(content), "row_count": n, "status": "registered"})


def _client(ctx):
    validator = Validator()
    ctx.grpc.serve(dataset_registry_pb2_grpc.add_ValidatorServicer_to_server, validator)
    m = ctx.load("client")
    _register("2026-01", 10)
    assert m.validate_and_promote(DS, "2026-01", "alice") == "validated", "a clean version with a healthy validator must be validated"
    assert pointer.latest(DS) == "2026-01", f"a validated version must be promoted, latest is {pointer.latest(DS)!r}"
    return m, validator


def _pending(m, version, why):
    try:
        got = m.validate_and_promote(DS, version, "bob")
    except m.ValidationPending:
        return
    except Exception as other:
        raise AssertionError(f"{why}: validate_and_promote raised {type(other).__name__}: {other}, expected ValidationPending")
    raise AssertionError(f"{why}: validate_and_promote returned {got!r} instead of raising ValidationPending")


def _held(version, status, why):
    record = store.version(DS, version)
    assert record["status"] == status, f"{why}: {version} has status {record['status']!r}, expected {status!r}"
    assert pointer.latest(DS) == "2026-01", f"{why}: the latest version is {pointer.latest(DS)!r}, expected 2026-01 to stay"


def check_deadline(ctx):
    m, _ = _client(ctx)
    calls = ctx.grpc.calls_to("Validate")
    assert calls, "no Validate call was made"
    for call in calls:
        assert call.timeout is not None, "the Validate call carries no deadline: a stalled validator holds the promotion open"
        assert 29.5 <= call.timeout <= 30.5, f"the Validate call carries a {call.timeout} s deadline, expected DEADLINE_S = 30"
    ctx.grpc.set_latency("Validate", 120.0)
    _register("2026-02", 10)
    before = ctx.clock.time()
    _pending(m, "2026-02", "with the validator taking 120 s")
    waited = ctx.clock.time() - before
    assert waited <= 31, f"the promotion waited {waited:.0f} s on the validator, expected at most the 30 s deadline"
    _held("2026-02", "pending", "after the deadline")


def check_timeout_no_promote(ctx):
    m, _ = _client(ctx)
    _register("2026-02", 10)
    _register("2026-03", 10)
    ctx.grpc.fail("Validate", grpc.StatusCode.UNAVAILABLE, "validator restarting")
    _pending(m, "2026-02", "with the validator UNAVAILABLE")
    _held("2026-02", "pending", "with the validator UNAVAILABLE")
    ctx.grpc.set_latency("Validate", 120.0)
    _pending(m, "2026-03", "with the validator past its deadline")
    _held("2026-03", "pending", "with the validator past its deadline")
    ctx.grpc.set_latency("Validate", 0.0)
    assert m.validate_and_promote(DS, "2026-02", "bob") == "validated", "once the validator answers, the pending version must be validated"
    assert pointer.latest(DS) == "2026-02", f"the validated 2026-02 must be promoted, latest is {pointer.latest(DS)!r}"


def check_rejected_held(ctx):
    m, _ = _client(ctx)
    _register("2026-02", 10, bad_at=3)
    got = m.validate_and_promote(DS, "2026-02", "bob")
    assert got == "rejected", f"a report with passed false must make validate_and_promote return 'rejected', got {got!r}"
    _held("2026-02", "rejected", "after a failed report")
    report = store.version(DS, "2026-02")["report"]
    assert report is not None and report.get("passed") is False and report.get("failures"), f"the rejected version must keep the validator's report, it holds {report}"


def check_coverage(ctx):
    m, validator = _client(ctx)
    _register("2026-02", 1500, bad_at=1200)
    _register("2026-03", 1500)
    try:
        got = m.validate_and_promote(DS, "2026-02", "bob")
    except m.ValidationPending:
        got = "pending"
    asked = [call.request.max_rows for call in ctx.grpc.calls_to("Validate")]
    assert got == "rejected", f"a version with a bad row at 1200 came back {got!r}: the validator was asked for max_rows {asked[-1]}, so it never read that row. Ask for every row (max_rows 0)"
    _held("2026-02", "rejected", "with a bad row at 1200")
    validator.cap = 500
    _pending(m, "2026-03", "with a validator that scanned 500 of 1500 rows")
    _held("2026-03", "pending", "after a scan of 500 of 1500 rows")
`,
    typescript: `const DS = 'imdb-reviews';

async function register(store, version: string, n: number, badAt = 0): Promise<void> {
  let content = '';
  for (let i = 1; i <= n; i++) content += \`\${i},review \${i},\${i === badAt ? 'BAD' : 'pos'}\\n\`;
  const sha = await store.putObject(content);
  await store.putVersion({tenant: 't1', dataset: DS, version, content_sha256: sha, license: 'mit', owner: 'team-lm', size_bytes: content.length, row_count: n, status: 'registered', report: null});
}

/** The validator scans the object's rows (every row when max_rows is 0); a row marked BAD fails. A cap truncates every scan. */
async function client(ctx) {
  const store = ctx.load('/support/registry/store.ts');
  const pointer = ctx.load('/support/registry/pointer.ts');
  const peer = {cap: 0};
  const pkg = ctx.proto('dataset_registry.proto');
  ctx.grpc.serve(pkg.datasetregistry.Validator.service, {
    async Validate(call, callback) {
      const content = await store.readObject(call.request.content_sha256);
      if (content === null) return callback({code: ctx.grpc.status.NOT_FOUND, details: 'no object'});
      const rows = content.split('\\n').filter(line => line !== '');
      const max = Number(call.request.max_rows);
      let limit = max <= 0 ? rows.length : Math.min(max, rows.length);
      if (peer.cap) limit = Math.min(limit, peer.cap);
      const failures = rows.slice(0, limit).flatMap((row, i) => (row.includes('BAD') ? [\`row \${i + 1}: label missing\`] : []));
      callback(null, {passed: failures.length === 0, rows_scanned: limit, rows_total: rows.length, failures});
    },
  });
  const m = ctx.load('client');
  await register(store, '2026-01', 10);
  assert.equal(await m.validateAndPromote(DS, '2026-01', 'alice'), 'validated', 'a clean version with a healthy validator must be validated');
  assert.equal(await pointer.latest(DS), '2026-01', 'a validated version must be promoted');
  return {m, store, pointer, peer};
}

async function pending(m, version: string, why: string): Promise<void> {
  let got;
  try {
    got = await m.validateAndPromote(DS, version, 'bob');
  } catch (e) {
    if (e instanceof m.ValidationPending) return;
    assert.fail(\`\${why}: validateAndPromote threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected ValidationPending\`);
  }
  assert.fail(\`\${why}: validateAndPromote returned \${JSON.stringify(got)} instead of throwing ValidationPending\`);
}

async function held({store, pointer}, version: string, status: string, why: string): Promise<void> {
  const record = await store.version(DS, version);
  assert.equal(record.status, status, \`\${why}: \${version} has status \${record.status}, expected \${status}\`);
  assert.equal(await pointer.latest(DS), '2026-01', \`\${why}: the latest version must stay 2026-01\`);
}

export async function check_deadline(ctx) {
  const env = await client(ctx);
  const calls = ctx.grpc.callsTo('Validate');
  assert(calls.length > 0, 'no Validate call was made');
  for (const call of calls) {
    assert(call.timeout !== null, 'the Validate call carries no deadline: a stalled validator holds the promotion open');
    assert(29.5 <= call.timeout && call.timeout <= 30.5, \`the Validate call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 30000\`);
  }
  ctx.grpc.setLatency('Validate', 120);
  await register(env.store, '2026-02', 10);
  const before = ctx.clock.now();
  await pending(env.m, '2026-02', 'with the validator taking 120 s');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 31, \`the promotion waited \${waited} s on the validator, expected at most the 30 s deadline\`);
  await held(env, '2026-02', 'pending', 'after the deadline');
}

export async function check_timeout_no_promote(ctx) {
  const env = await client(ctx);
  await register(env.store, '2026-02', 10);
  await register(env.store, '2026-03', 10);
  ctx.grpc.fail('Validate', ctx.grpc.status.UNAVAILABLE, 'validator restarting', 1);
  await pending(env.m, '2026-02', 'with the validator UNAVAILABLE');
  await held(env, '2026-02', 'pending', 'with the validator UNAVAILABLE');
  ctx.grpc.setLatency('Validate', 120);
  await pending(env.m, '2026-03', 'with the validator past its deadline');
  await held(env, '2026-03', 'pending', 'with the validator past its deadline');
  ctx.grpc.setLatency('Validate', 0);
  assert.equal(await env.m.validateAndPromote(DS, '2026-02', 'bob'), 'validated', 'once the validator answers, the pending version must be validated');
  assert.equal(await env.pointer.latest(DS), '2026-02', 'the validated 2026-02 must be promoted');
}

export async function check_rejected_held(ctx) {
  const env = await client(ctx);
  await register(env.store, '2026-02', 10, 3);
  const got = await env.m.validateAndPromote(DS, '2026-02', 'bob');
  assert.equal(got, 'rejected', \`a report with passed false must make validateAndPromote return 'rejected', got \${JSON.stringify(got)}\`);
  await held(env, '2026-02', 'rejected', 'after a failed report');
  const {report} = await env.store.version(DS, '2026-02');
  assert(report !== null && report.passed === false && report.failures.length > 0, \`the rejected version must keep the validator's report, it holds \${JSON.stringify(report)}\`);
}

export async function check_coverage(ctx) {
  const env = await client(ctx);
  await register(env.store, '2026-02', 1500, 1200);
  await register(env.store, '2026-03', 1500);
  let got;
  try {
    got = await env.m.validateAndPromote(DS, '2026-02', 'bob');
  } catch (e) {
    if (!(e instanceof env.m.ValidationPending)) throw e;
    got = 'pending';
  }
  const asked = ctx.grpc.callsTo('Validate').map(c => Number(c.request.max_rows));
  assert.equal(got, 'rejected', \`a version with a bad row at 1200 came back \${got}: the validator was asked for max_rows \${asked[asked.length - 1]}, so it never read that row. Ask for every row (max_rows 0)\`);
  await held(env, '2026-02', 'rejected', 'with a bad row at 1200');
  env.peer.cap = 500;
  await pending(env.m, '2026-03', 'with a validator that scanned 500 of 1500 rows');
  await held(env, '2026-03', 'pending', 'after a scan of 500 of 1500 rows');
}
`,
    go: `package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"registry/pointer"
	"registry/store"
	pb "datasetregistry/gen/dataset_registry"

	"leetbuild/harness"
)

const clientDS = "imdb-reviews"

var clientBg = context.Background()

// validatorPeer scans the object's rows (every row when max_rows is 0); a row marked BAD fails. A
// cap truncates every scan.
type validatorPeer struct {
	pb.UnimplementedValidatorServer
	cap int64
}

func (v *validatorPeer) Validate(_ context.Context, req *pb.ValidateRequest) (*pb.ValidationReport, error) {
	content, found := store.ReadObject(clientBg, req.GetContentSha256())
	if !found {
		return nil, status.Errorf(codes.NotFound, "no object %s", req.GetContentSha256())
	}
	var rows []string
	for _, line := range strings.Split(content, "\\n") {
		if line != "" {
			rows = append(rows, line)
		}
	}
	limit := int64(len(rows))
	if req.GetMaxRows() > 0 && req.GetMaxRows() < limit {
		limit = req.GetMaxRows()
	}
	if v.cap > 0 && v.cap < limit {
		limit = v.cap
	}
	failures := []string{}
	for i := int64(0); i < limit; i++ {
		if strings.Contains(rows[i], "BAD") {
			failures = append(failures, fmt.Sprintf("row %d: label missing", i+1))
		}
	}
	return &pb.ValidationReport{Passed: len(failures) == 0, RowsScanned: limit, RowsTotal: int64(len(rows)), Failures: failures}, nil
}

func clientRegister(ctx *harness.Ctx, version string, n, badAt int) {
	var b strings.Builder
	for i := 1; i <= n; i++ {
		label := "pos"
		if i == badAt {
			label = "BAD"
		}
		fmt.Fprintf(&b, "%d,review %d,%s\\n", i, i, label)
	}
	content := b.String()
	sha := store.PutObject(clientBg, content)
	err := store.PutVersion(clientBg, &store.VersionRecord{Tenant: "t1", Dataset: clientDS, Version: version, ContentSHA256: sha, License: "mit", Owner: "team-lm", SizeBytes: int64(len(content)), RowCount: int64(n), Status: "registered"})
	ctx.NoError(err, "seeding %s", version)
}

func clientLatest(ctx *harness.Ctx) string {
	latest, err := pointer.Latest(clientBg, clientDS)
	ctx.NoError(err, "reading the latest version")
	return latest
}

func client(ctx *harness.Ctx) *validatorPeer {
	peer := &validatorPeer{}
	pb.RegisterValidatorServer(ctx.GRPC.Server(""), peer)
	clientRegister(ctx, "2026-01", 10, 0)
	got, err := validateAndPromote(clientBg, clientDS, "2026-01", "alice")
	ctx.NoError(err, "a clean version with a healthy validator")
	ctx.Equal(got, "validated", "a clean version with a healthy validator; its status")
	ctx.Equal(clientLatest(ctx), "2026-01", "a validated version must be promoted; the latest")
	return peer
}

func clientPending(ctx *harness.Ctx, version, why string) {
	got, err := validateAndPromote(clientBg, clientDS, version, "bob")
	ctx.Assert(err != nil, "%s: validateAndPromote returned %q instead of ErrValidationPending", why, got)
	ctx.Assert(errors.Is(err, ErrValidationPending), "%s: validateAndPromote failed with %v, expected ErrValidationPending", why, err)
}

func clientHeld(ctx *harness.Ctx, version, status, why string) {
	rec := store.Version(clientBg, clientDS, version)
	ctx.Equal(rec.Status, status, "%s: the status of %s", why, version)
	ctx.Equal(clientLatest(ctx), "2026-01", "%s: the latest version must stay 2026-01; latest", why)
}

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	calls := ctx.GRPC.CallsTo("Validate", "")
	ctx.Assert(len(calls) > 0, "no Validate call was made")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "the Validate call carries no deadline: a stalled validator holds the promotion open")
		ctx.Assert(29500*time.Millisecond <= call.Timeout && call.Timeout <= 30500*time.Millisecond, "the Validate call carries a %v deadline, expected 30 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Validate", 120, "")
	clientRegister(ctx, "2026-02", 10, 0)
	before := ctx.Clock.Now()
	clientPending(ctx, "2026-02", "with the validator taking 120 s")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 31, "the promotion waited %.0f s on the validator, expected at most the 30 s deadline", waited)
	clientHeld(ctx, "2026-02", "pending", "after the deadline")
}

func CheckTimeoutNoPromote(ctx *harness.Ctx) {
	client(ctx)
	clientRegister(ctx, "2026-02", 10, 0)
	clientRegister(ctx, "2026-03", 10, 0)
	ctx.GRPC.Fail("Validate", codes.Unavailable, "validator restarting", 1, "")
	clientPending(ctx, "2026-02", "with the validator UNAVAILABLE")
	clientHeld(ctx, "2026-02", "pending", "with the validator UNAVAILABLE")
	ctx.GRPC.SetLatency("Validate", 120, "")
	clientPending(ctx, "2026-03", "with the validator past its deadline")
	clientHeld(ctx, "2026-03", "pending", "with the validator past its deadline")
	ctx.GRPC.SetLatency("Validate", 0, "")
	got, err := validateAndPromote(clientBg, clientDS, "2026-02", "bob")
	ctx.NoError(err, "once the validator answers")
	ctx.Equal(got, "validated", "once the validator answers, the pending version's status")
	ctx.Equal(clientLatest(ctx), "2026-02", "the validated 2026-02 must be promoted; the latest")
}

func CheckRejectedHeld(ctx *harness.Ctx) {
	client(ctx)
	clientRegister(ctx, "2026-02", 10, 3)
	got, err := validateAndPromote(clientBg, clientDS, "2026-02", "bob")
	ctx.NoError(err, "a failed report is a verdict, not an error")
	ctx.Equal(got, "rejected", "a report with passed false; validateAndPromote returned")
	clientHeld(ctx, "2026-02", "rejected", "after a failed report")
	report := store.Version(clientBg, clientDS, "2026-02").Report
	ctx.Assert(report != nil && !report.Passed && len(report.Failures) > 0, "the rejected version must keep the validator's report, it holds %+v", report)
}

func CheckCoverage(ctx *harness.Ctx) {
	peer := client(ctx)
	clientRegister(ctx, "2026-02", 1500, 1200)
	clientRegister(ctx, "2026-03", 1500, 0)
	got, err := validateAndPromote(clientBg, clientDS, "2026-02", "bob")
	if errors.Is(err, ErrValidationPending) {
		got = "pending"
	}
	calls := ctx.GRPC.CallsTo("Validate", "")
	asked := calls[len(calls)-1].Request.(*pb.ValidateRequest).GetMaxRows()
	ctx.Equal(got, "rejected", "a version with a bad row at 1200: the validator was asked for max_rows %d, so it must read that row (ask for every row, max_rows 0); the status", asked)
	clientHeld(ctx, "2026-02", "rejected", "with a bad row at 1200")
	peer.cap = 500
	clientPending(ctx, "2026-03", "with a validator that scanned 500 of 1500 rows")
	clientHeld(ctx, "2026-03", "pending", "after a scan of 500 of 1500 rows")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

namespace {

const std::string kDS = "imdb-reviews";

// Scans the object's rows (every row when max_rows is 0); a row marked BAD fails. A cap truncates every scan.
class ValidatorPeer final : public datasetregistry::Validator::Service {
 public:
  long long cap = 0;
  grpc::Status Validate(grpc::ServerContext*, const datasetregistry::ValidateRequest* req, datasetregistry::ValidationReport* out) override {
    const auto content = store::readObject(req->content_sha256());
    if (!content) return grpc::Status(grpc::StatusCode::NOT_FOUND, "no object " + req->content_sha256());
    std::vector<std::string> rows;
    std::string line;
    for (char ch : *content) {
      if (ch == '\\n') {
        if (!line.empty()) rows.push_back(line);
        line.clear();
      } else {
        line += ch;
      }
    }
    if (!line.empty()) rows.push_back(line);
    long long limit = static_cast<long long>(rows.size());
    if (req->max_rows() > 0 && req->max_rows() < limit) limit = req->max_rows();
    if (cap > 0 && cap < limit) limit = cap;
    for (long long i = 0; i < limit; i++) {
      if (rows[i].find("BAD") != std::string::npos) out->add_failures("row " + std::to_string(i + 1) + ": label missing");
    }
    out->set_passed(out->failures_size() == 0);
    out->set_rows_scanned(limit);
    out->set_rows_total(static_cast<long long>(rows.size()));
    return grpc::Status::OK;
  }
};

void registerVersion(const std::string& version, int n, int bad_at = 0) {
  std::string content;
  for (int i = 1; i <= n; i++) content += std::to_string(i) + ",review " + std::to_string(i) + "," + (i == bad_at ? "BAD" : "pos") + "\\n";
  store::VersionRecord rec;
  rec.tenant = "t1";
  rec.dataset = kDS;
  rec.version = version;
  rec.content_sha256 = store::putObject(content);
  rec.license = "mit";
  rec.owner = "team-lm";
  rec.size_bytes = static_cast<long long>(content.size());
  rec.row_count = n;
  store::putVersion(rec);
}

ValidatorPeer& client(harness::Ctx& ctx) {
  static ValidatorPeer* peer = nullptr;
  delete peer;
  peer = new ValidatorPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  registerVersion("2026-01", 10);
  ctx.Equal(validateAndPromote(kDS, "2026-01", "alice"), "validated", "a clean version with a healthy validator; its status");
  ctx.Equal(pointer::latest(kDS), "2026-01", "a validated version must be promoted; the latest");
  return *peer;
}

void pending(harness::Ctx& ctx, const std::string& version, const std::string& why) {
  std::string got;
  try {
    got = validateAndPromote(kDS, version, "bob");
  } catch (const ValidationPending&) {
    return;
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: validateAndPromote threw %s: %s, expected ValidationPending", why, harness::CurrentExceptionType(), e.what());
  }
  ctx.Fatalf("%s: validateAndPromote returned %q instead of throwing ValidationPending", why, got);
}

void held(harness::Ctx& ctx, const std::string& version, const std::string& status, const std::string& why) {
  ctx.Equal(store::version(kDS, version)->status, status, "%s: the status of %s", why, version);
  ctx.Equal(pointer::latest(kDS), "2026-01", "%s: the latest version must stay 2026-01; latest", why);
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  const auto calls = ctx.GRPC.CallsTo("Validate");
  ctx.Assert(!calls.empty(), "no Validate call was made");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "the Validate call carries no deadline: a stalled validator holds the promotion open");
    ctx.Assert(29.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 30.5, "the Validate call carries a %v s deadline, expected kDeadline = 30 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Validate", 120.0);
  registerVersion("2026-02", 10);
  const auto before = ctx.Clock.Now();
  pending(ctx, "2026-02", "with the validator taking 120 s");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 31, "the promotion waited %v s on the validator, expected at most the 30 s deadline", waited);
  held(ctx, "2026-02", "pending", "after the deadline");
}

void CheckTimeoutNoPromote(harness::Ctx& ctx) {
  client(ctx);
  registerVersion("2026-02", 10);
  registerVersion("2026-03", 10);
  ctx.GRPC.Fail("Validate", grpc::StatusCode::UNAVAILABLE, "validator restarting", 1);
  pending(ctx, "2026-02", "with the validator UNAVAILABLE");
  held(ctx, "2026-02", "pending", "with the validator UNAVAILABLE");
  ctx.GRPC.SetLatency("Validate", 120.0);
  pending(ctx, "2026-03", "with the validator past its deadline");
  held(ctx, "2026-03", "pending", "with the validator past its deadline");
  ctx.GRPC.SetLatency("Validate", 0);
  ctx.Equal(validateAndPromote(kDS, "2026-02", "bob"), "validated", "once the validator answers, the pending version's status");
  ctx.Equal(pointer::latest(kDS), "2026-02", "the validated 2026-02 must be promoted; the latest");
}

void CheckRejectedHeld(harness::Ctx& ctx) {
  client(ctx);
  registerVersion("2026-02", 10, 3);
  ctx.Equal(validateAndPromote(kDS, "2026-02", "bob"), "rejected", "a report with passed false; validateAndPromote returned");
  held(ctx, "2026-02", "rejected", "after a failed report");
  const auto report = store::version(kDS, "2026-02")->report;
  ctx.Assert(report && !report->value("passed", true) && !report->value("failures", nlohmann::json::array()).empty(),
             "the rejected version must keep the validator's report, it holds %s", report ? report->dump() : "nothing");
}

void CheckCoverage(harness::Ctx& ctx) {
  ValidatorPeer& peer = client(ctx);
  registerVersion("2026-02", 1500, 1200);
  registerVersion("2026-03", 1500);
  std::string got;
  try {
    got = validateAndPromote(kDS, "2026-02", "bob");
  } catch (const ValidationPending&) {
    got = "pending";
  }
  const auto calls = ctx.GRPC.CallsTo("Validate");
  const long long asked = calls.back().Request<datasetregistry::ValidateRequest>().max_rows();
  ctx.Equal(got, "rejected", "a version with a bad row at 1200: the validator was asked for max_rows %d, so it must read that row (ask for every row, max_rows 0); the status", asked);
  held(ctx, "2026-02", "rejected", "with a bad row at 1200");
  peer.cap = 500;
  pending(ctx, "2026-03", "with a validator that scanned 500 of 1500 rows");
  held(ctx, "2026-03", "pending", "after a scan of 500 of 1500 rows");
}
`,
  },
  hints: [
    'Stop the validator and promote: the version becomes `latest` anyway. Give it a file whose row 1200 is broken: it passes. Give it one whose row 3 is broken: it is promoted too.',
    'The call has no deadline, its error is swallowed before `promote` runs, the reply is recorded as `validated` whatever `passed` says, and `max_rows` asks for a 1000-row sample, which the report then treats as the whole file.',
    'Call with `timeout=DEADLINE_S` and `max_rows=0`; on `RpcError` record `pending` and raise `ValidationPending`; on `rows_scanned < row_count` the same; on `not passed` record `rejected` and return; only then record `validated` and `pointer.promote`.',
  ],
  debrief: `The gate has three outcomes, and the code keeps them apart because they mean different things to the training runs downstream: \`validated\` moves the pointer, \`rejected\` is a verdict about the bytes, \`pending\` is a verdict about the validator. A timeout or an outage says nothing about the data, so it can neither promote nor reject. Coverage belongs in the same rule: a pass over 500 of 1500 rows is a statement about 500 rows, which is why the registry compares \`rows_scanned\` with the row count it measured itself. Production validators run asynchronously against large objects and report progress; the registry then keeps a validation job id per version, retries pending ones from a queue, and records the rule set version each report was produced with.`,
};
