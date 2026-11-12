import type {Step} from '@/lib/types';

export const classifyColumnsStep: Step = {
  id: 'classify-columns',
  title: 'Classify: batches the model can read, a deadline, one retry, a closed tag library',
  concept: 'grpc',
  file: 'classify_columns',
  focus: ['metasense', 'llm'],
  task: `## Task

**Starting point.** The starter's \`classify_columns(entity, columns)\` sends every column in one
\`Classifier.Classify\` call to \`llm-gateway:9000\` (\`data_classification.proto\`) with no deadline,
tries up to 3 times on any error, then returns \`{column_name: assigned_tag}\` straight from the JSON
array in \`content\`. It tags a ten-column demo table and hides 4 flaws.

**Failure mode the checks target.** A 400-column table overflows the model's context window and the
gateway refuses it, every time; a gateway that hangs pins the worker; a request the gateway rejects
as invalid is paid for three times; and a tag the model invented, or a column it skipped, reaches the
catalogue as if it were a classification.

\`\`\`proto
service Classifier { rpc Classify(ClassifyRequest) returns (ClassifyReply); }
message ClassifyRequest { string entity = 1; repeated string columns = 2; repeated string tag_library = 3; }
message ClassifyReply   { string content = 1; string model = 2; }
\`\`\`

- At most **150** columns per call (\`MAX_COLUMNS_PER_CALL\`), results kept in column order.
- Every call carries a **15 s** deadline (\`DEADLINE_S\`).
- At most **2** attempts per call (\`MAX_ATTEMPTS\`), and only \`UNAVAILABLE\` is retried.
- Every requested column gets a tag from \`metasense.taxonomy\`: a missing column or an unknown tag is
  \`"None"\`. Content that is not a JSON array raises \`ClassifyFailed\`, as every failed call does.`,
  sequence: {
    participants: ['metasense', 'LLM gateway'],
    messages: [
      {from: 'metasense', to: 'metasense', label: 'split columns · ≤ 150 per call', kind: 'sync'},
      {from: 'metasense', to: 'LLM gateway', label: 'Classify(entity, columns, tag_library) · 15 s', kind: 'sync'},
      {from: 'LLM gateway', to: 'metasense', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'metasense', to: 'LLM gateway', label: 'Classify · attempt 2 of 2', kind: 'sync'},
      {from: 'LLM gateway', to: 'metasense', label: 'content: [{column_name, assigned_tag}, …]', kind: 'reply'},
      {from: 'metasense', to: 'metasense', label: 'known(tag) else "None" · missing column → "None"', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'batches',
      title: 'Splits a wide table into calls of at most 150 columns',
      detail:
        'A 400-column table is classified in three calls of at most 150 columns and every column comes back tagged, in order. The starter sends all 400 in one call, which the gateway refuses as over the context window.',
      match: {
        python: {all: [/MAX_COLUMNS_PER_CALL\s*=\s*150\b/, /columns\[[^\]\n]*MAX_COLUMNS_PER_CALL/]},
        typescript: {all: [/MAX_COLUMNS_PER_CALL\s*=\s*150\b/, /columns\.slice\([^)\n]*MAX_COLUMNS_PER_CALL/]},
        go: {all: [/maxColumnsPerCall\s*=\s*150\b/, /\+=\s*maxColumnsPerCall/]},
        scala: {all: [/MaxColumnsPerCall\s*=\s*150\b/, /\.grouped\(MaxColumnsPerCall\)/]},
        cpp: {all: [/kMaxColumnsPerCall\s*=\s*150\b/, /\+=\s*kMaxColumnsPerCall/]},
      },
    },
    {
      id: 'deadline',
      title: 'Every call carries a 15-second deadline',
      detail:
        'Each Classify call is made with a deadline of about 15 s; a gateway that hangs is cut there and the call raises `ClassifyFailed` without a retry. The starter sends no deadline and waits as long as the gateway does.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*15\b/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_S\s*=\s*15\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_S\s*\*\s*1000/]},
        go: {all: [/deadline\s*=\s*15\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\)/]},
        scala: {all: [/DeadlineS\s*=\s*15L?\b/, /withDeadlineAfter\(DeadlineS/]},
        cpp: {all: [/kDeadline\{15\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'retry-unavailable',
      title: 'Retries UNAVAILABLE once and nothing else',
      detail:
        'One UNAVAILABLE earns a second call; two in a row raise `ClassifyFailed` after two calls; INVALID_ARGUMENT raises after one. The starter retries any status up to three times.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /StatusCode\.UNAVAILABLE/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /status\.UNAVAILABLE/]},
        go: {all: [/maxAttempts\s*=\s*2\b/, /codes\.Unavailable/]},
        scala: {all: [/MaxAttempts\s*=\s*2\b/, /Status\.Code\.UNAVAILABLE/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2\b/, /StatusCode::UNAVAILABLE/]},
      },
    },
    {
      id: 'taxonomy',
      title: 'Keeps every tag inside the library',
      detail:
        'Each requested column is answered with a tag `known` to the taxonomy: an invented tag and a column the model skipped come back as `"None"`, and content that is not a JSON array raises `ClassifyFailed`. The starter returns whatever the model wrote.',
      match: {
        python: {all: [/taxonomy\.known\(/, /isinstance\(\w+,\s*list\)/]},
        typescript: {all: [/\bknown\(/, /Array\.isArray\(/]},
        go: {all: [/taxonomy\.Known\(/]},
        scala: {all: [/Taxonomy\.known\b/]},
        cpp: {all: [/taxonomy::known\(/, /is_array\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import grpc

import data_classification_pb2 as pb
import data_classification_pb2_grpc as pb_grpc
from metasense import taxonomy  # taxonomy.TAXONOMY, taxonomy.known(tag)

GATEWAY = "llm-gateway:9000"
MAX_ATTEMPTS = 3

stub = pb_grpc.ClassifierStub(grpc.insecure_channel(GATEWAY))


class ClassifyFailed(Exception):
    """The gateway gave no usable answer; the job is retried later."""


def classify_columns(entity: str, columns: list[str]) -> dict[str, str]:
    """One tag per column, from the LLM gateway."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    request = pb.ClassifyRequest(entity=entity, columns=columns, tag_library=taxonomy.TAXONOMY)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Classify(request)
            break
        except grpc.RpcError as err:
            if attempt == MAX_ATTEMPTS:
                raise ClassifyFailed(f"Classify {entity}: {err.code().name}") from err
    return {row["column_name"]: row["assigned_tag"] for row in json.loads(reply.content)}
`,
      solution: `import json

import grpc

import data_classification_pb2 as pb
import data_classification_pb2_grpc as pb_grpc
from metasense import taxonomy  # taxonomy.TAXONOMY, taxonomy.known(tag)

GATEWAY = "llm-gateway:9000"
MAX_COLUMNS_PER_CALL = 150  # Metasense V2 splits wider tables: the model loses track past this
DEADLINE_S = 15
MAX_ATTEMPTS = 2

stub = pb_grpc.ClassifierStub(grpc.insecure_channel(GATEWAY))


class ClassifyFailed(Exception):
    """The gateway gave no usable answer; the job is retried later."""


def classify_batch(entity: str, batch: list[str]) -> dict[str, str]:
    """One call for at most MAX_COLUMNS_PER_CALL columns, retried once on UNAVAILABLE."""
    request = pb.ClassifyRequest(entity=entity, columns=batch, tag_library=taxonomy.TAXONOMY)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Classify(request, timeout=DEADLINE_S)
            break
        except grpc.RpcError as err:
            if err.code() != grpc.StatusCode.UNAVAILABLE or attempt == MAX_ATTEMPTS:
                raise ClassifyFailed(f"Classify {entity}: {err.code().name}") from err
    try:
        rows = json.loads(reply.content)
    except ValueError as err:
        raise ClassifyFailed(f"Classify {entity}: the content is not JSON") from err
    if not isinstance(rows, list):
        raise ClassifyFailed(f"Classify {entity}: the content is not a JSON array")
    answered = {row.get("column_name"): row.get("assigned_tag") for row in rows if isinstance(row, dict)}
    # The library is closed: a tag the model invented, or a column it skipped, is "None" for the owner to check.
    return {column: answered[column] if taxonomy.known(answered.get(column)) else "None" for column in batch}


def classify_columns(entity: str, columns: list[str]) -> dict[str, str]:
    """One tag per column, from the LLM gateway, in column order."""
    tags = {}
    for start in range(0, len(columns), MAX_COLUMNS_PER_CALL):
        tags.update(classify_batch(entity, columns[start : start + MAX_COLUMNS_PER_CALL]))
    return tags
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {TAXONOMY, known} from 'metasense/taxonomy';

export const GATEWAY = 'llm-gateway:9000';
export const MAX_ATTEMPTS = 3;

interface ClassifyRequest {
  entity: string;
  columns: string[];
  tag_library: readonly string[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('data_classification.proto')) as unknown as {
  metasensed: {Classifier: grpc.ServiceClientConstructor};
};
const stub = new pkg.metasensed.Classifier(GATEWAY, grpc.credentials.createInsecure()) as grpc.Client & {
  Classify(request: ClassifyRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{content: string; model: string}>;
};

/** The gateway gave no usable answer; the job is retried later. */
export class ClassifyFailed extends Error {}

/** One tag per column, from the LLM gateway. */
export async function classifyColumns(entity: string, columns: string[]): Promise<Record<string, string>> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  let content = '[]';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      content = (await stub.Classify({entity, columns, tag_library: TAXONOMY}, new grpc.Metadata(), {})).content;
      break;
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) throw new ClassifyFailed(\`Classify \${entity}: \${grpc.status[(e as grpc.ServiceError).code]}\`);
    }
  }
  const rows = JSON.parse(content) as {column_name: string; assigned_tag: string}[];
  return Object.fromEntries(rows.map(row => [row.column_name, row.assigned_tag]));
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {TAXONOMY, known} from 'metasense/taxonomy';

export const GATEWAY = 'llm-gateway:9000';
export const MAX_COLUMNS_PER_CALL = 150; // Metasense V2 splits wider tables: the model loses track past this
export const DEADLINE_S = 15;
export const MAX_ATTEMPTS = 2;

interface ClassifyRequest {
  entity: string;
  columns: string[];
  tag_library: readonly string[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('data_classification.proto')) as unknown as {
  metasensed: {Classifier: grpc.ServiceClientConstructor};
};
const stub = new pkg.metasensed.Classifier(GATEWAY, grpc.credentials.createInsecure()) as grpc.Client & {
  Classify(request: ClassifyRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{content: string; model: string}>;
};

/** The gateway gave no usable answer; the job is retried later. */
export class ClassifyFailed extends Error {}

/** One call for at most MAX_COLUMNS_PER_CALL columns, retried once on UNAVAILABLE. */
async function classifyBatch(entity: string, batch: string[]): Promise<Record<string, string>> {
  let content = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const options = {deadline: Date.now() + DEADLINE_S * 1000};
      content = (await stub.Classify({entity, columns: batch, tag_library: TAXONOMY}, new grpc.Metadata(), options)).content;
      break;
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (code !== grpc.status.UNAVAILABLE || attempt === MAX_ATTEMPTS) throw new ClassifyFailed(\`Classify \${entity}: \${grpc.status[code]}\`);
    }
  }
  let rows: unknown;
  try {
    rows = JSON.parse(content);
  } catch {
    throw new ClassifyFailed(\`Classify \${entity}: the content is not JSON\`);
  }
  if (!Array.isArray(rows)) throw new ClassifyFailed(\`Classify \${entity}: the content is not a JSON array\`);
  const answered = new Map<unknown, unknown>();
  for (const row of rows) if (row !== null && typeof row === 'object') answered.set(row.column_name, row.assigned_tag);
  // The library is closed: a tag the model invented, or a column it skipped, is "None" for the owner to check.
  return Object.fromEntries(batch.map(column => [column, known(answered.get(column)) ? String(answered.get(column)) : 'None']));
}

/** One tag per column, from the LLM gateway, in column order. */
export async function classifyColumns(entity: string, columns: string[]): Promise<Record<string, string>> {
  const tags: Record<string, string> = {};
  for (let start = 0; start < columns.length; start += MAX_COLUMNS_PER_CALL) {
    Object.assign(tags, await classifyBatch(entity, columns.slice(start, start + MAX_COLUMNS_PER_CALL)));
  }
  return tags;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "metasense/gen/data_classification"
	"metasense/taxonomy" // taxonomy.Tags, taxonomy.Known(tag)
)

const (
	gateway     = "llm-gateway:9000"
	maxAttempts = 3
)

var conn, _ = grpc.NewClient(gateway, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewClassifierClient(conn)

// ErrClassifyFailed: the gateway gave no usable answer; the job is retried later.
var ErrClassifyFailed = errors.New("classify failed")

type taggedColumn struct {
	ColumnName  string \`json:"column_name"\`
	AssignedTag string \`json:"assigned_tag"\`
}

// classifyColumns is one tag per column, from the LLM gateway.
func classifyColumns(ctx context.Context, entity string, columns []string) (map[string]string, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	var reply *pb.ClassifyReply
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		var err error
		reply, err = stub.Classify(ctx, &pb.ClassifyRequest{Entity: entity, Columns: columns, TagLibrary: taxonomy.Tags})
		if err == nil {
			break
		}
		if attempt == maxAttempts {
			return nil, fmt.Errorf("%w: Classify %s: %s", ErrClassifyFailed, entity, status.Code(err))
		}
	}
	var rows []taggedColumn
	json.Unmarshal([]byte(reply.GetContent()), &rows)
	tags := map[string]string{}
	for _, row := range rows {
		tags[row.ColumnName] = row.AssignedTag
	}
	return tags, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "metasense/gen/data_classification"
	"metasense/taxonomy" // taxonomy.Tags, taxonomy.Known(tag)
)

const (
	gateway           = "llm-gateway:9000"
	maxColumnsPerCall = 150 // Metasense V2 splits wider tables: the model loses track past this
	deadline          = 15 * time.Second
	maxAttempts       = 2
)

var conn, _ = grpc.NewClient(gateway, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewClassifierClient(conn)

// ErrClassifyFailed: the gateway gave no usable answer; the job is retried later.
var ErrClassifyFailed = errors.New("classify failed")

type taggedColumn struct {
	ColumnName  string \`json:"column_name"\`
	AssignedTag string \`json:"assigned_tag"\`
}

// classifyBatch makes one call for at most maxColumnsPerCall columns, retried once on UNAVAILABLE.
func classifyBatch(ctx context.Context, entity string, batch []string, tags map[string]string) error {
	var reply *pb.ClassifyReply
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		var err error
		reply, err = stub.Classify(callCtx, &pb.ClassifyRequest{Entity: entity, Columns: batch, TagLibrary: taxonomy.Tags})
		cancel()
		if err == nil {
			break
		}
		if status.Code(err) != codes.Unavailable || attempt == maxAttempts {
			return fmt.Errorf("%w: Classify %s: %s", ErrClassifyFailed, entity, status.Code(err))
		}
	}
	var rows []taggedColumn
	if err := json.Unmarshal([]byte(reply.GetContent()), &rows); err != nil {
		return fmt.Errorf("%w: Classify %s: the content is not a JSON array: %v", ErrClassifyFailed, entity, err)
	}
	answered := map[string]string{}
	for _, row := range rows {
		answered[row.ColumnName] = row.AssignedTag
	}
	// The library is closed: a tag the model invented, or a column it skipped, is "None" for the owner to check.
	for _, column := range batch {
		tags[column] = "None"
		if tag, ok := answered[column]; ok && taxonomy.Known(tag) {
			tags[column] = tag
		}
	}
	return nil
}

// classifyColumns is one tag per column, from the LLM gateway.
func classifyColumns(ctx context.Context, entity string, columns []string) (map[string]string, error) {
	tags := map[string]string{}
	for start := 0; start < len(columns); start += maxColumnsPerCall {
		if err := classifyBatch(ctx, entity, columns[start:min(start+maxColumnsPerCall, len(columns))], tags); err != nil {
			return nil, err
		}
	}
	return tags, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import spray.json._

import metasense.Taxonomy // Taxonomy.Tags, Taxonomy.known(tag)
import metasensed.data_classification.{ClassifierGrpc, ClassifyRequest}

/** The gateway gave no usable answer; the job is retried later. */
final class ClassifyFailed(message: String) extends RuntimeException(message)

object ClassifyColumns {
  val Gateway = "llm-gateway:9000"
  val MaxAttempts = 3

  private val stub = ClassifierGrpc.blockingStub(ManagedChannelBuilder.forTarget(Gateway).usePlaintext().build())

  /** One tag per column, from the LLM gateway. */
  def classifyColumns(entity: String, columns: Seq[String]): Map[String, String] = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val request = ClassifyRequest(entity = entity, columns = columns, tagLibrary = Taxonomy.Tags)
    var content = "[]"
    var attempt = 1
    var done = false
    while (!done) {
      try {
        content = stub.classify(request).content
        done = true
      } catch {
        case e: StatusRuntimeException =>
          if (attempt == MaxAttempts) throw new ClassifyFailed(s"Classify $entity: \${e.getStatus.getCode}")
          attempt += 1
      }
    }
    content.parseJson.asInstanceOf[JsArray].elements.map { row =>
      val fields = row.asJsObject.fields
      fields("column_name").asInstanceOf[JsString].value -> fields("assigned_tag").asInstanceOf[JsString].value
    }.toMap
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import spray.json._

import metasense.Taxonomy // Taxonomy.Tags, Taxonomy.known(tag)
import metasensed.data_classification.{ClassifierGrpc, ClassifyRequest}

import scala.util.Try

/** The gateway gave no usable answer; the job is retried later. */
final class ClassifyFailed(message: String) extends RuntimeException(message)

object ClassifyColumns {
  val Gateway = "llm-gateway:9000"
  val MaxColumnsPerCall = 150 // Metasense V2 splits wider tables: the model loses track past this
  val DeadlineS = 15L
  val MaxAttempts = 2

  private val stub = ClassifierGrpc.blockingStub(ManagedChannelBuilder.forTarget(Gateway).usePlaintext().build())

  /** One call for at most MaxColumnsPerCall columns, retried once on UNAVAILABLE. */
  private def classifyBatch(entity: String, batch: Seq[String]): Seq[(String, String)] = {
    val request = ClassifyRequest(entity = entity, columns = batch, tagLibrary = Taxonomy.Tags)
    var content: Option[String] = None
    var attempt = 1
    while (content.isEmpty) {
      try content = Some(stub.withDeadlineAfter(DeadlineS, TimeUnit.SECONDS).classify(request).content)
      catch {
        case e: StatusRuntimeException =>
          if (e.getStatus.getCode != Status.Code.UNAVAILABLE || attempt == MaxAttempts)
            throw new ClassifyFailed(s"Classify $entity: \${e.getStatus.getCode}")
          attempt += 1
      }
    }
    val rows = Try(content.get.parseJson).toOption match {
      case Some(JsArray(elements)) => elements
      case _                       => throw new ClassifyFailed(s"Classify $entity: the content is not a JSON array")
    }
    val answered = rows.collect { case row: JsObject => row.fields }.flatMap { fields =>
      (fields.get("column_name"), fields.get("assigned_tag")) match {
        case (Some(JsString(column)), Some(JsString(tag))) => Some(column -> tag)
        case _                                             => None
      }
    }.toMap
    // The library is closed: a tag the model invented, or a column it skipped, is "None" for the owner to check.
    batch.map(column => column -> answered.get(column).filter(Taxonomy.known).getOrElse("None"))
  }

  /** One tag per column, from the LLM gateway. */
  def classifyColumns(entity: String, columns: Seq[String]): Map[String, String] =
    columns.grouped(MaxColumnsPerCall).flatMap(classifyBatch(entity, _)).toMap
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <map>
#include <stdexcept>
#include <string>
#include <vector>

#include "data_classification.grpc.pb.h"
#include "metasense/taxonomy.h"  // taxonomy::kTags, taxonomy::known(tag)

const std::string kGateway = "llm-gateway:9000";
constexpr int kMaxAttempts = 3;

auto stub = metasensed::Classifier::NewStub(grpc::CreateChannel(kGateway, grpc::InsecureChannelCredentials()));

// The gateway gave no usable answer; the job is retried later.
struct ClassifyFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// One tag per column, from the LLM gateway.
std::map<std::string, std::string> classifyColumns(const std::string& entity, const std::vector<std::string>& columns) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  metasensed::ClassifyRequest request;
  request.set_entity(entity);
  for (const auto& column : columns) request.add_columns(column);
  for (const auto& tag : taxonomy::kTags) request.add_tag_library(tag);
  metasensed::ClassifyReply reply;
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    const grpc::Status status = stub->Classify(&ctx, request, &reply);
    if (status.ok()) break;
    if (attempt == kMaxAttempts) throw ClassifyFailed("Classify " + entity + ": " + status.error_message());
  }
  std::map<std::string, std::string> tags;
  for (const auto& row : nlohmann::json::parse(reply.content())) tags[row["column_name"]] = row["assigned_tag"];
  return tags;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

#include "data_classification.grpc.pb.h"
#include "metasense/taxonomy.h"  // taxonomy::kTags, taxonomy::known(tag)

const std::string kGateway = "llm-gateway:9000";
constexpr size_t kMaxColumnsPerCall = 150;  // Metasense V2 splits wider tables: the model loses track past this
constexpr std::chrono::seconds kDeadline{15};
constexpr int kMaxAttempts = 2;

auto stub = metasensed::Classifier::NewStub(grpc::CreateChannel(kGateway, grpc::InsecureChannelCredentials()));

// The gateway gave no usable answer; the job is retried later.
struct ClassifyFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// One call for at most kMaxColumnsPerCall columns, retried once on UNAVAILABLE.
void classifyBatch(const std::string& entity, const std::vector<std::string>& batch, std::map<std::string, std::string>& tags) {
  metasensed::ClassifyRequest request;
  request.set_entity(entity);
  for (const auto& column : batch) request.add_columns(column);
  for (const auto& tag : taxonomy::kTags) request.add_tag_library(tag);
  metasensed::ClassifyReply reply;
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    const grpc::Status status = stub->Classify(&ctx, request, &reply);
    if (status.ok()) break;
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE || attempt == kMaxAttempts) {
      throw ClassifyFailed("Classify " + entity + ": " + status.error_message());
    }
  }
  const nlohmann::json rows = nlohmann::json::parse(reply.content(), nullptr, false);
  if (!rows.is_array()) throw ClassifyFailed("Classify " + entity + ": the content is not a JSON array");
  std::map<std::string, std::string> answered;
  for (const auto& row : rows) {
    if (row.is_object() && row.contains("column_name") && row["column_name"].is_string() && row.contains("assigned_tag") && row["assigned_tag"].is_string()) {
      answered[row["column_name"].get<std::string>()] = row["assigned_tag"].get<std::string>();
    }
  }
  // The library is closed: a tag the model invented, or a column it skipped, is "None" for the owner to check.
  for (const auto& column : batch) {
    const auto it = answered.find(column);
    tags[column] = it != answered.end() && taxonomy::known(it->second) ? it->second : "None";
  }
}

// One tag per column, from the LLM gateway.
std::map<std::string, std::string> classifyColumns(const std::string& entity, const std::vector<std::string>& columns) {
  std::map<std::string, std::string> tags;
  for (size_t start = 0; start < columns.size(); start += kMaxColumnsPerCall) {
    const size_t stop = std::min(columns.size(), start + kMaxColumnsPerCall);
    classifyBatch(entity, std::vector<std::string>(columns.begin() + static_cast<long>(start), columns.begin() + static_cast<long>(stop)), tags);
  }
  return tags;
}
`,
    },
  },
  harness: {
    python: `import json

import grpc

import data_classification_pb2 as pb
import data_classification_pb2_grpc as pb_grpc

GATEWAY = "llm-gateway:9000"
TABLE = ["customer_name", "customer_email", "salary_band", "remarks", "pickup_geohash", "nric"]
WANT = {"customer_name": "Personal.Name", "customer_email": "Personal.Contact_Info", "salary_band": "None", "remarks": "None", "pickup_geohash": "Geo.Geohash", "nric": "Personal.ID"}


def _tag(column):
    if "passport" in column or "nric" in column:
        return "Personal.ID"
    if "name" in column:
        return "Personal.Name"
    if "email" in column or "phone" in column:
        return "Personal.Contact_Info"
    if "geohash" in column:
        return "Geo.Geohash"
    if "salary" in column:
        return "Financial.Salary"  # a tag the model made up
    return "None"


class Gateway(pb_grpc.ClassifierServicer):
    """The LLM gateway stand-in: refuses prompts over the context window, answers like the model would."""

    def Classify(self, request, context):
        columns = list(request.columns)
        if len(columns) > 150:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, f"{len(columns)} columns exceed the model's context window")
        if request.entity == "garbled":
            return pb.ClassifyReply(content="I could not classify this table.", model="stand-in")
        rows = [{"column_name": c, "assigned_tag": _tag(c)} for c in columns if "remarks" not in c]
        return pb.ClassifyReply(content=json.dumps(rows), model="stand-in")


def _client(ctx):
    ctx.grpc.serve(pb_grpc.add_ClassifierServicer_to_server, Gateway(), GATEWAY)
    return ctx.load("classify_columns")


def _calls(ctx):
    return ctx.grpc.calls_to("Classify")


def _classify(m, entity, columns):
    try:
        return m.classify_columns(entity, columns)
    except Exception as exc:
        raise AssertionError(f"classify_columns({entity!r}, {len(columns)} columns) raised {type(exc).__name__}: {exc}") from exc


def _raises(m, entity, columns, why):
    try:
        got = m.classify_columns(entity, columns)
    except m.ClassifyFailed:
        return
    except Exception as exc:
        raise AssertionError(f"{why}: classify_columns raised {type(exc).__name__}: {exc}, expected ClassifyFailed") from exc
    raise AssertionError(f"{why}: classify_columns returned {got}, expected ClassifyFailed")


def check_batches(ctx):
    m = _client(ctx)
    columns = [f"col_{i:03d}" for i in range(400)]
    columns[320] = "passport_no"
    tags = _classify(m, "deliveries", columns)
    sizes = [len(c.request.columns) for c in _calls(ctx)]
    assert sizes and max(sizes) <= 150, f"the Classify calls carried {sizes} columns: at most 150 per call fit the context window"
    assert len(sizes) == 3, f"400 columns took {len(sizes)} calls, expected 3 (150, 150, 100)"
    assert list(tags) == columns, f"classify_columns answered {len(tags)} columns, expected all 400 in column order"
    assert tags["passport_no"] == "Personal.ID", f"passport_no in the third batch came back {tags['passport_no']!r}, expected Personal.ID"


def check_deadline(ctx):
    m = _client(ctx)
    _classify(m, "deliveries", TABLE)
    call = _calls(ctx)[0]
    assert call.timeout is not None, "the Classify call carries no deadline: a gateway that hangs pins the worker"
    assert 14 <= call.timeout <= 16, f"the Classify deadline is {call.timeout} s, expected DEADLINE_S = 15"
    ctx.grpc.set_latency("Classify", 60.0, GATEWAY)
    before, started = len(_calls(ctx)), ctx.clock.time()
    _raises(m, "deliveries", TABLE, "a gateway that hangs for 60 s")
    waited = ctx.clock.time() - started
    assert waited <= 16, f"classify_columns waited {waited:.0f} s on a gateway that hangs, expected the 15 s deadline to cut it"
    assert len(_calls(ctx)) - before == 1, f"a call cut by its deadline was retried ({len(_calls(ctx)) - before} calls): only UNAVAILABLE is retried"


def check_retry_unavailable(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Classify", grpc.StatusCode.UNAVAILABLE, "gateway restarting", times=1, target=GATEWAY)
    tags = _classify(m, "deliveries", TABLE)
    assert len(_calls(ctx)) == 2 and tags.get("nric") == "Personal.ID", f"one UNAVAILABLE must earn one retry that succeeds: {len(_calls(ctx))} calls, tags {tags}"
    ctx.grpc.fail("Classify", grpc.StatusCode.UNAVAILABLE, "gateway down", times=2, target=GATEWAY)
    _raises(m, "deliveries", TABLE, "a gateway that stays UNAVAILABLE")
    assert len(_calls(ctx)) == 4, f"a gateway that stays UNAVAILABLE got {len(_calls(ctx)) - 2} calls, expected MAX_ATTEMPTS = 2"
    ctx.grpc.fail("Classify", grpc.StatusCode.INVALID_ARGUMENT, "unsupported entity", times=1, target=GATEWAY)
    _raises(m, "deliveries", TABLE, "a request the gateway rejects as INVALID_ARGUMENT")
    assert len(_calls(ctx)) == 5, f"INVALID_ARGUMENT was retried ({len(_calls(ctx)) - 4} calls): a request that is wrong is wrong every time, and each call is paid"


def check_taxonomy(ctx):
    m = _client(ctx)
    tags = _classify(m, "customers", TABLE)
    assert tags.get("salary_band") == "None", f"the model answered the tag Financial.Salary for salary_band and classify_columns kept {tags.get('salary_band')!r}: a tag outside the library is None"
    assert tags.get("remarks") == "None", f"the model skipped remarks and classify_columns answered {tags.get('remarks')!r}: every requested column gets a tag, None when the model gave none"
    assert tags == WANT, f"classify_columns answered {tags}, expected {WANT}"
    _raises(m, "garbled", TABLE, "content that is not a JSON array")
`,
    typescript: `const GATEWAY = 'llm-gateway:9000';
const TABLE = ['customer_name', 'customer_email', 'salary_band', 'remarks', 'pickup_geohash', 'nric'];
const WANT = {customer_name: 'Personal.Name', customer_email: 'Personal.Contact_Info', salary_band: 'None', remarks: 'None', pickup_geohash: 'Geo.Geohash', nric: 'Personal.ID'};

function tagOf(column: string): string {
  if (column.includes('passport') || column.includes('nric')) return 'Personal.ID';
  if (column.includes('name')) return 'Personal.Name';
  if (column.includes('email') || column.includes('phone')) return 'Personal.Contact_Info';
  if (column.includes('geohash')) return 'Geo.Geohash';
  if (column.includes('salary')) return 'Financial.Salary'; // a tag the model made up
  return 'None';
}

/** The LLM gateway stand-in: refuses prompts over the context window, answers like the model would. */
function client(ctx) {
  const {metasensed} = ctx.proto('data_classification.proto');
  ctx.grpc.serve(metasensed.Classifier.service, {
    Classify(call, callback) {
      const columns: string[] = call.request.columns;
      if (columns.length > 150) return callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: \`\${columns.length} columns exceed the model's context window\`});
      if (call.request.entity === 'garbled') return callback(null, {content: 'I could not classify this table.', model: 'stand-in'});
      const rows = columns.filter(c => !c.includes('remarks')).map(c => ({column_name: c, assigned_tag: tagOf(c)}));
      callback(null, {content: JSON.stringify(rows), model: 'stand-in'});
    },
  }, GATEWAY);
  return ctx.load('classify_columns');
}

const calls = ctx => ctx.grpc.callsTo('Classify');

async function classify(m, entity: string, columns: string[]) {
  try {
    return await m.classifyColumns(entity, columns);
  } catch (e) {
    assert.fail(\`classifyColumns(\${entity}, \${columns.length} columns) threw \${e instanceof Error ? \`\${e.constructor.name}: \${e.message}\` : String(e)}\`);
  }
}

async function raises(m, entity: string, columns: string[], why: string) {
  let got;
  try {
    got = await m.classifyColumns(entity, columns);
  } catch (e) {
    assert(e instanceof m.ClassifyFailed, \`\${why}: classifyColumns threw \${e instanceof Error ? \`\${e.constructor.name}: \${e.message}\` : String(e)}, expected ClassifyFailed\`);
    return;
  }
  assert.fail(\`\${why}: classifyColumns resolved \${JSON.stringify(got)}, expected ClassifyFailed\`);
}

export async function check_batches(ctx) {
  const m = client(ctx);
  const columns = Array.from({length: 400}, (_, i) => \`col_\${String(i).padStart(3, '0')}\`);
  columns[320] = 'passport_no';
  const tags = await classify(m, 'deliveries', columns);
  const sizes = calls(ctx).map(c => c.request.columns.length);
  assert(sizes.length > 0 && Math.max(...sizes) <= 150, \`the Classify calls carried \${JSON.stringify(sizes)} columns: at most 150 per call fit the context window\`);
  assert.equal(sizes.length, 3, \`400 columns took \${sizes.length} calls, expected 3 (150, 150, 100)\`);
  assert.deepEqual(Object.keys(tags), columns, \`classifyColumns answered \${Object.keys(tags).length} columns, expected all 400 in column order\`);
  assert.equal(tags.passport_no, 'Personal.ID', \`passport_no in the third batch came back \${tags.passport_no}, expected Personal.ID\`);
}

export async function check_deadline(ctx) {
  const m = client(ctx);
  await classify(m, 'deliveries', TABLE);
  const call = calls(ctx)[0];
  assert(call.timeout !== null, 'the Classify call carries no deadline: a gateway that hangs pins the worker');
  assert(14 <= call.timeout && call.timeout <= 16, \`the Classify deadline is \${call.timeout} s, expected DEADLINE_S = 15\`);
  ctx.grpc.setLatency('Classify', 60.0, GATEWAY);
  const before = calls(ctx).length;
  const started = ctx.clock.now();
  await raises(m, 'deliveries', TABLE, 'a gateway that hangs for 60 s');
  const waited = (ctx.clock.now() - started) / 1000;
  assert(waited <= 16, \`classifyColumns waited \${waited.toFixed(0)} s on a gateway that hangs, expected the 15 s deadline to cut it\`);
  assert.equal(calls(ctx).length - before, 1, 'a call cut by its deadline was retried: only UNAVAILABLE is retried');
}

export async function check_retry_unavailable(ctx) {
  const m = client(ctx);
  ctx.grpc.fail('Classify', ctx.grpc.status.UNAVAILABLE, 'gateway restarting', 1, GATEWAY);
  const tags = await classify(m, 'deliveries', TABLE);
  assert(calls(ctx).length === 2 && tags.nric === 'Personal.ID', \`one UNAVAILABLE must earn one retry that succeeds: \${calls(ctx).length} calls, tags \${JSON.stringify(tags)}\`);
  ctx.grpc.fail('Classify', ctx.grpc.status.UNAVAILABLE, 'gateway down', 2, GATEWAY);
  await raises(m, 'deliveries', TABLE, 'a gateway that stays UNAVAILABLE');
  assert.equal(calls(ctx).length, 4, \`a gateway that stays UNAVAILABLE got \${calls(ctx).length - 2} calls, expected MAX_ATTEMPTS = 2\`);
  ctx.grpc.fail('Classify', ctx.grpc.status.INVALID_ARGUMENT, 'unsupported entity', 1, GATEWAY);
  await raises(m, 'deliveries', TABLE, 'a request the gateway rejects as INVALID_ARGUMENT');
  assert.equal(calls(ctx).length, 5, \`INVALID_ARGUMENT was retried (\${calls(ctx).length - 4} calls): a request that is wrong is wrong every time, and each call is paid\`);
}

export async function check_taxonomy(ctx) {
  const m = client(ctx);
  const tags = await classify(m, 'customers', TABLE);
  assert.equal(tags.salary_band, 'None', \`the model answered the tag Financial.Salary for salary_band and classifyColumns kept \${tags.salary_band}: a tag outside the library is None\`);
  assert.equal(tags.remarks, 'None', \`the model skipped remarks and classifyColumns answered \${tags.remarks}: every requested column gets a tag, None when the model gave none\`);
  assert.deepEqual({...tags}, WANT, \`classifyColumns answered \${JSON.stringify(tags)}\`);
  await raises(m, 'garbled', TABLE, 'content that is not a JSON array');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "metasense/gen/data_classification"

	"leetbuild/harness"
)

const classifyGateway = "llm-gateway:9000"

var classifyTable = []string{"customer_name", "customer_email", "salary_band", "remarks", "pickup_geohash", "nric"}

func classifyTagOf(column string) string {
	switch {
	case strings.Contains(column, "passport") || strings.Contains(column, "nric"):
		return "Personal.ID"
	case strings.Contains(column, "name"):
		return "Personal.Name"
	case strings.Contains(column, "email") || strings.Contains(column, "phone"):
		return "Personal.Contact_Info"
	case strings.Contains(column, "geohash"):
		return "Geo.Geohash"
	case strings.Contains(column, "salary"):
		return "Financial.Salary" // a tag the model made up
	}
	return "None"
}

// gatewayPeer is the LLM gateway stand-in: refuses prompts over the context window, answers like the model would.
type gatewayPeer struct {
	pb.UnimplementedClassifierServer
}

func (gatewayPeer) Classify(_ context.Context, req *pb.ClassifyRequest) (*pb.ClassifyReply, error) {
	if len(req.GetColumns()) > 150 {
		return nil, status.Errorf(codes.InvalidArgument, "%d columns exceed the model's context window", len(req.GetColumns()))
	}
	if req.GetEntity() == "garbled" {
		return &pb.ClassifyReply{Content: "I could not classify this table.", Model: "stand-in"}, nil
	}
	rows := []map[string]string{}
	for _, c := range req.GetColumns() {
		if !strings.Contains(c, "remarks") {
			rows = append(rows, map[string]string{"column_name": c, "assigned_tag": classifyTagOf(c)})
		}
	}
	raw, _ := json.Marshal(rows)
	return &pb.ClassifyReply{Content: string(raw), Model: "stand-in"}, nil
}

func classifyWorld(ctx *harness.Ctx) {
	pb.RegisterClassifierServer(ctx.GRPC.Server(classifyGateway), &gatewayPeer{})
}

func classifyCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Classify", "") }

func classifyOK(ctx *harness.Ctx, entity string, columns []string) map[string]string {
	tags, err := classifyColumns(context.Background(), entity, columns)
	ctx.NoError(err, "classifyColumns(%q, %d columns)", entity, len(columns))
	return tags
}

func classifyFails(ctx *harness.Ctx, entity string, columns []string, why string) {
	tags, err := classifyColumns(context.Background(), entity, columns)
	ctx.Assert(err != nil, "%s: classifyColumns returned %v, expected an error wrapping ErrClassifyFailed", why, tags)
	ctx.Assert(errors.Is(err, ErrClassifyFailed), "%s: classifyColumns returned %v, expected an error wrapping ErrClassifyFailed", why, err)
}

func CheckBatches(ctx *harness.Ctx) {
	classifyWorld(ctx)
	columns := make([]string, 400)
	for i := range columns {
		columns[i] = fmt.Sprintf("col_%03d", i)
	}
	columns[320] = "passport_no"
	tags := classifyOK(ctx, "deliveries", columns)
	var sizes []int
	for _, call := range classifyCalls(ctx) {
		sizes = append(sizes, len(call.Request.(*pb.ClassifyRequest).GetColumns()))
	}
	for _, n := range sizes {
		ctx.Assert(n <= 150, "the Classify calls carried %v columns: at most 150 per call fit the context window", sizes)
	}
	ctx.Equal(len(sizes), 3, "400 columns must take 3 calls (150, 150, 100); calls")
	ctx.Equal(len(tags), 400, "classifyColumns must answer every column; columns answered")
	ctx.Equal(tags["passport_no"], "Personal.ID", "passport_no in the third batch")
}

func CheckDeadline(ctx *harness.Ctx) {
	classifyWorld(ctx)
	classifyOK(ctx, "deliveries", classifyTable)
	call := classifyCalls(ctx)[0]
	ctx.Assert(call.HasDeadline(), "the Classify call carries no deadline: a gateway that hangs pins the worker")
	ctx.Assert(14*time.Second <= call.Timeout && call.Timeout <= 16*time.Second, "the Classify deadline is %v, expected 15 s", call.Timeout)
	ctx.GRPC.SetLatency("Classify", 60, classifyGateway)
	before, started := len(classifyCalls(ctx)), ctx.Clock.Now()
	classifyFails(ctx, "deliveries", classifyTable, "a gateway that hangs for 60 s")
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(waited <= 16, "classifyColumns waited %.0f s on a gateway that hangs, expected the 15 s deadline to cut it", waited)
	ctx.Equal(len(classifyCalls(ctx))-before, 1, "a call cut by its deadline must not be retried (only UNAVAILABLE is); calls")
}

func CheckRetryUnavailable(ctx *harness.Ctx) {
	classifyWorld(ctx)
	ctx.GRPC.Fail("Classify", codes.Unavailable, "gateway restarting", 1, classifyGateway)
	tags := classifyOK(ctx, "deliveries", classifyTable)
	ctx.Assert(len(classifyCalls(ctx)) == 2 && tags["nric"] == "Personal.ID", "one UNAVAILABLE must earn one retry that succeeds: %d calls, tags %v", len(classifyCalls(ctx)), tags)
	ctx.GRPC.Fail("Classify", codes.Unavailable, "gateway down", 2, classifyGateway)
	classifyFails(ctx, "deliveries", classifyTable, "a gateway that stays UNAVAILABLE")
	ctx.Equal(len(classifyCalls(ctx)), 4, "a gateway that stays UNAVAILABLE gets maxAttempts = 2 calls; calls so far")
	ctx.GRPC.Fail("Classify", codes.InvalidArgument, "unsupported entity", 1, classifyGateway)
	classifyFails(ctx, "deliveries", classifyTable, "a request the gateway rejects as INVALID_ARGUMENT")
	ctx.Equal(len(classifyCalls(ctx)), 5, "INVALID_ARGUMENT must not be retried: a request that is wrong is wrong every time, and each call is paid; calls so far")
}

func CheckTaxonomy(ctx *harness.Ctx) {
	classifyWorld(ctx)
	tags := classifyOK(ctx, "customers", classifyTable)
	ctx.Equal(tags["salary_band"], "None", "the model answered the tag Financial.Salary for salary_band: a tag outside the library is None")
	ctx.Equal(tags["remarks"], "None", "the model skipped remarks: every requested column gets a tag, None when the model gave none")
	ctx.Equal(tags, map[string]string{"customer_name": "Personal.Name", "customer_email": "Personal.Contact_Info", "salary_band": "None", "remarks": "None", "pickup_geohash": "Geo.Geohash", "nric": "Personal.ID"}, "the tags")
	classifyFails(ctx, "garbled", classifyTable, "content that is not a JSON array")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

#include "data_classification.grpc.pb.h"

namespace {

const std::string kGatewayTarget = "llm-gateway:9000";
const std::vector<std::string> kTable = {"customer_name", "customer_email", "salary_band", "remarks", "pickup_geohash", "nric"};

bool has(const std::string& column, const char* part) { return column.find(part) != std::string::npos; }

std::string tagOf(const std::string& column) {
  if (has(column, "passport") || has(column, "nric")) return "Personal.ID";
  if (has(column, "name")) return "Personal.Name";
  if (has(column, "email") || has(column, "phone")) return "Personal.Contact_Info";
  if (has(column, "geohash")) return "Geo.Geohash";
  if (has(column, "salary")) return "Financial.Salary";  // a tag the model made up
  return "None";
}

// The LLM gateway stand-in: refuses prompts over the context window, answers like the model would.
class GatewayPeer final : public metasensed::Classifier::Service {
 public:
  grpc::Status Classify(grpc::ServerContext*, const metasensed::ClassifyRequest* req, metasensed::ClassifyReply* reply) override {
    if (req->columns_size() > 150) {
      return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, std::to_string(req->columns_size()) + " columns exceed the model's context window");
    }
    reply->set_model("stand-in");
    if (req->entity() == "garbled") {
      reply->set_content("I could not classify this table.");
      return grpc::Status::OK;
    }
    nlohmann::json rows = nlohmann::json::array();
    for (const auto& c : req->columns()) {
      if (!has(c, "remarks")) rows.push_back({{"column_name", c}, {"assigned_tag", tagOf(c)}});
    }
    reply->set_content(rows.dump());
    return grpc::Status::OK;
  }
};

void world(harness::Ctx& ctx) {
  static GatewayPeer peer;
  ctx.GRPC.Server(kGatewayTarget)->RegisterService(&peer);
}

std::map<std::string, std::string> classifyOK(harness::Ctx& ctx, const std::string& entity, const std::vector<std::string>& columns) {
  try {
    return classifyColumns(entity, columns);
  } catch (const std::exception& e) {
    ctx.Fatalf("classifyColumns(%q, %d columns) threw %s: %s", entity, columns.size(), harness::CurrentExceptionType(), e.what());
  }
}

void classifyFails(harness::Ctx& ctx, const std::string& entity, const std::vector<std::string>& columns, const std::string& why) {
  try {
    const auto tags = classifyColumns(entity, columns);
    ctx.Fatalf("%s: classifyColumns returned %d tags, expected ClassifyFailed", why, tags.size());
  } catch (const ClassifyFailed&) {
  } catch (const harness::Failure&) {
    throw;
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: classifyColumns threw %s: %s, expected ClassifyFailed", why, harness::CurrentExceptionType(), e.what());
  }
}

}  // namespace

void CheckBatches(harness::Ctx& ctx) {
  world(ctx);
  std::vector<std::string> columns;
  for (int i = 0; i < 400; i++) columns.push_back("col_" + std::string(i < 10 ? "00" : i < 100 ? "0" : "") + std::to_string(i));
  columns[320] = "passport_no";
  const auto tags = classifyOK(ctx, "deliveries", columns);
  std::vector<int> sizes;
  for (const auto& call : ctx.GRPC.CallsTo("Classify")) sizes.push_back(call.Request<metasensed::ClassifyRequest>().columns_size());
  for (int n : sizes) ctx.Assert(n <= 150, "the Classify calls carried %v columns: at most 150 per call fit the context window", sizes);
  ctx.Equal(sizes.size(), 3, "400 columns must take 3 calls (150, 150, 100); calls");
  ctx.Equal(tags.size(), 400, "classifyColumns must answer every column; columns answered");
  ctx.Equal(tags.count("passport_no") ? tags.at("passport_no") : "", "Personal.ID", "passport_no in the third batch");
}

void CheckDeadline(harness::Ctx& ctx) {
  world(ctx);
  classifyOK(ctx, "deliveries", kTable);
  const auto call = ctx.GRPC.CallsTo("Classify")[0];
  ctx.Assert(call.HasDeadline(), "the Classify call carries no deadline: a gateway that hangs pins the worker");
  ctx.Assert(14 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 16, "the Classify deadline is %v s, expected 15", call.TimeoutSeconds());
  ctx.GRPC.SetLatency("Classify", 60, kGatewayTarget);
  const size_t before = ctx.GRPC.CallsTo("Classify").size();
  const int64_t started = ctx.Clock.Now();
  classifyFails(ctx, "deliveries", kTable, "a gateway that hangs for 60 s");
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(waited <= 16, "classifyColumns waited %.0f s on a gateway that hangs, expected the 15 s deadline to cut it", waited);
  ctx.Equal(ctx.GRPC.CallsTo("Classify").size() - before, 1, "a call cut by its deadline must not be retried (only UNAVAILABLE is); calls");
}

void CheckRetryUnavailable(harness::Ctx& ctx) {
  world(ctx);
  ctx.GRPC.Fail("Classify", grpc::StatusCode::UNAVAILABLE, "gateway restarting", 1, kGatewayTarget);
  const auto tags = classifyOK(ctx, "deliveries", kTable);
  ctx.Assert(ctx.GRPC.CallsTo("Classify").size() == 2 && tags.count("nric") && tags.at("nric") == "Personal.ID",
             "one UNAVAILABLE must earn one retry that succeeds: %d calls", ctx.GRPC.CallsTo("Classify").size());
  ctx.GRPC.Fail("Classify", grpc::StatusCode::UNAVAILABLE, "gateway down", 2, kGatewayTarget);
  classifyFails(ctx, "deliveries", kTable, "a gateway that stays UNAVAILABLE");
  ctx.Equal(ctx.GRPC.CallsTo("Classify").size(), 4, "a gateway that stays UNAVAILABLE gets kMaxAttempts = 2 calls; calls so far");
  ctx.GRPC.Fail("Classify", grpc::StatusCode::INVALID_ARGUMENT, "unsupported entity", 1, kGatewayTarget);
  classifyFails(ctx, "deliveries", kTable, "a request the gateway rejects as INVALID_ARGUMENT");
  ctx.Equal(ctx.GRPC.CallsTo("Classify").size(), 5, "INVALID_ARGUMENT must not be retried: a request that is wrong is wrong every time, and each call is paid; calls so far");
}

void CheckTaxonomy(harness::Ctx& ctx) {
  world(ctx);
  const auto tags = classifyOK(ctx, "customers", kTable);
  ctx.Equal(tags.count("salary_band") ? tags.at("salary_band") : "<missing>", "None", "the model answered the tag Financial.Salary for salary_band: a tag outside the library is None");
  ctx.Equal(tags.count("remarks") ? tags.at("remarks") : "<missing>", "None", "the model skipped remarks: every requested column gets a tag, None when the model gave none");
  ctx.Equal(tags,
            std::map<std::string, std::string>{{"customer_name", "Personal.Name"}, {"customer_email", "Personal.Contact_Info"}, {"salary_band", "None"},
                                               {"remarks", "None"}, {"pickup_geohash", "Geo.Geohash"}, {"nric", "Personal.ID"}},
            "the tags");
  classifyFails(ctx, "garbled", kTable, "content that is not a JSON array");
}
`,
  },
  hints: [
    'A 400-column table never gets tagged, a hung gateway holds a worker for minutes, a bad request is billed three times, and the catalogue shows `Financial.Salary`, a tag no privacy rule knows.',
    'One call carries every column; no call has a deadline; the loop retries every status the same; and the reply is copied into the result, so the model decides both which columns get a tag and which tags exist.',
    'Slice `columns` by `MAX_COLUMNS_PER_CALL`; pass `timeout=DEADLINE_S`; retry only `grpc.StatusCode.UNAVAILABLE` up to `MAX_ATTEMPTS`; parse into a dict and answer each requested column `tag if taxonomy.known(tag) else "None"`, raising `ClassifyFailed` when the content is not a list.',
  ],
  debrief: `The model is a remote dependency with two failure surfaces, the transport and the text, and the fix bounds both. On the transport side, the batch size keeps the prompt inside the context window, the deadline bounds how long a worker can wait, and retrying only UNAVAILABLE spends a second call where it can help. On the text side, the library is closed: each requested column is looked up, and anything the model invented or skipped becomes "None" for the owner to check rather than a new category. Grab adds a workflow-level rate limiter under the provider's token quota and measures the prompt against verified tags before a new version ships; a backoff before the retry would also keep a recovering gateway from being hit at once.`,
};
