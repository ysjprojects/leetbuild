import type {Step} from '@/lib/types';

export const citationClientStep: Step = {
  id: 'dependency',
  title: 'Document fetch calls for resolution and re-anchoring',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'docstore'],
  task: `## Task

The starter is a plausible model-generated draft: a healthy document store answers and every
citation comes back verified, so the demo report is green. Every failure path is wrong. Find them,
fix them, and prove the fix.

Implement the verifier that resolves citations against the document store:

- Every fetch carries a **1-second deadline**. Without one, a stuck document store pins the verifier
  worker and the citation is never verified, never broken.
- At most **3 attempts**, and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retryable. A
  **\`NOT_FOUND\` is terminal** — the version does not exist and no amount of retrying will create
  it; return it to the caller immediately.
- When the fetch fails, the citation is **\`broken\` with a \`reason\`** — \`fetch failed: …\` for a
  transport failure. A broken citation is a fact about the document, not an error to swallow.
- A citation whose quote is no longer at those offsets is **re-anchored**: search the fetched
  version text for the quote and, when it is moved, record the new offset and keep the status
  \`verified\`; only when the quote is gone entirely is the citation \`broken\` with
  \`reason: span_moved\`.
- A citation that cannot be resolved is **never dropped** and never counted as verified: the batch
  returns every citation it was given.

**Failure mode the checks target.** The draft fetches with no deadline and retries a \`NOT_FOUND\`
forever, returns whatever text it eventually gets, treats a fetch failure as “still valid” so the
report looks green, and silently drops the citations it cannot resolve. Each of those is invisible
while the document store is healthy and the corpus is unchanged.`,
  sequence: {
    participants: ['Verifier', 'document store', 'citation store'],
    messages: [
      {
        from: 'Verifier',
        to: 'document store',
        label: 'GetVersion(doc, version) · deadline 1 s · attempt ≤ 3',
        kind: 'sync',
      },
      {from: 'document store', to: 'Verifier', label: 'version text / NOT_FOUND / deadline', kind: 'reply'},
      {
        from: 'Verifier',
        to: 'Verifier',
        label: 'retry only UNAVAILABLE / DEADLINE_EXCEEDED · NOT_FOUND terminal',
        kind: 'sync',
      },
      {from: 'Verifier', to: 'Verifier', label: 'reanchor(quote) → new offset or span_moved', kind: 'sync'},
      {from: 'Verifier', to: 'citation store', label: 'put status verified / broken + reason', kind: 'sync'},
      {from: 'Verifier', to: 'Verifier', label: 'every citation returned, none dropped', kind: 'sync'},
    ],
  },
  hints: [
    'The deadline is an argument on the call itself (`timeout=`, `deadline:`, a context with timeout, `withDeadlineAfter`, `set_deadline`) — wrapping the call changes nothing. Bound the attempts with `MAX_ATTEMPTS` and a loop; the draft’s `while true` has no exit for a permanent error.',
    'Retryability is a property of the status, not of “it threw”: compare the code against the retryable set, and treat `NOT_FOUND` as terminal — a missing version is data, not an outage. A timeout is the opposite case: it must produce `broken` with a reason, never `verified`.',
    'Re-anchoring is a search, not a comparison: `text.find(quote)` (or `indexOf`/`strings.Index`/`indexOf`) gives the offset the quote moved to. Record it and stay verified; only a missing quote is `span_moved`. Whatever the outcome, the citation stays in the result — dropping it is how regressions disappear from the report.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every fetch carries a 1-second deadline',
      detail:
        'The call is created with a 1-second deadline — a call timeout, a context with timeout, `withDeadlineAfter`, `set_deadline` or `deadline: Date.now() + DEADLINE_MS`. Without it a stuck document store holds the verifier open forever.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*1\.0/, /timeout=DEADLINE_S/, /\.GetVersion\(/]},
        typescript: {
          all: [/DEADLINE_MS\s*=\s*1_000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.GetVersion\(/],
        },
        go: {all: [/deadlineMS\s*=\s*1000/, /context\.WithTimeout/, /\.GetVersion\(/]},
        scala: {all: [/DeadlineMs\s*=\s*1000/, /withDeadlineAfter/, /\.getVersion\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*1000/, /set_deadline\(/, /->GetVersion\(/]},
      },
    },
    {
      id: 'timeout-broken',
      title: 'A fetch failure yields broken status with a reason',
      detail:
        'A deadline-exceeded fetch marks the citation `broken` with a `reason`; the draft marks every fetch failure `verified` so the report stays green.',
      match: {
        python: {all: [/STATUS_BROKEN/, /grpc\.StatusCode\.DEADLINE_EXCEEDED/, /"reason"/]},
        typescript: {all: [/STATUS_BROKEN/, /DEADLINE_EXCEEDED/, /reason/]},
        go: {all: [/statusBroken/, /codes\.DeadlineExceeded/, /"reason"/]},
        scala: {all: [/StatusBroken/, /DEADLINE_EXCEEDED/, /reason/]},
        cpp: {all: [/kStatusBroken/, /DEADLINE_EXCEEDED/, /"reason"/]},
      },
    },
    {
      id: 'not-found-terminal',
      title: 'A missing version is terminal, attempts are bounded',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS` and only the retryable set is retried; `NOT_FOUND` is returned immediately because a version that does not exist cannot be retried into existence. The draft retries it forever.',
      match: {
        python: {all: [/grpc\.StatusCode\.NOT_FOUND/, /MAX_ATTEMPTS/, /RETRYABLE/]},
        typescript: {all: [/grpc\.status\.NOT_FOUND/, /MAX_ATTEMPTS/, /RETRYABLE/]},
        go: {all: [/codes\.NotFound/, /maxAttempts/, /retryableCodes/]},
        scala: {all: [/Status\.Code\.NOT_FOUND/, /MaxAttempts/, /Retryable/]},
        cpp: {all: [/grpc::StatusCode::NOT_FOUND/, /kMaxAttempts/, /kRetryable/]},
      },
    },
    {
      id: 'broken-kept',
      title: 'A citation is marked broken, never dropped',
      detail:
        'A citation that cannot be resolved comes back `broken` with a `reason` and stays in the batch result. The draft drops it (`continue`) so the report only ever shows the citations that worked.',
      match: {
        python: {all: [/STATUS_BROKEN/, /"reason"/], none: [/\bcontinue\b/]},
        typescript: {all: [/STATUS_BROKEN/, /reason/], none: [/\bcontinue\b/]},
        go: {all: [/statusBroken/, /"reason"/], none: [/\bcontinue\b/]},
        scala: {all: [/StatusBroken/, /reason/], none: [/\.filter\(/]},
        cpp: {all: [/kStatusBroken/, /"reason"/], none: [/\bcontinue;/]},
      },
    },
    {
      id: 'reanchor',
      title: 'Verified only when the span can be re-anchored',
      detail:
        'The fetched text is searched for the quote and the citation is `verified` only when the quote is found (at its new offset). The draft never re-anchors: it guesses the status from whether the fetch returned at all.',
      match: {
        python: {all: [/def reanchor\(/, /STATUS_VERIFIED/], order: [/def reanchor\(/, /STATUS_VERIFIED/]},
        typescript: {
          all: [/function reanchor\(/, /STATUS_VERIFIED/],
          order: [/function reanchor\(/, /STATUS_VERIFIED/],
        },
        go: {all: [/func reanchor\(/, /statusVerified/], order: [/func reanchor\(/, /statusVerified/]},
        scala: {all: [/def reanchor\(/, /StatusVerified/], order: [/def reanchor\(/, /StatusVerified/]},
        cpp: {all: [/reanchor\(/, /kStatusVerified/], order: [/reanchor\(/, /kStatusVerified/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import documents_pb2
import documents_pb2_grpc

channel = grpc.insecure_channel("documents:9000")
documents = documents_pb2_grpc.DocumentStoreStub(channel)

STATUS_VERIFIED = "verified"


def fetch_version(document_id: str, version: int) -> str | None:
    # TODO: fetch with a 1 s deadline, bound the attempts and retry only UNAVAILABLE /
    # DEADLINE_EXCEEDED (NOT_FOUND is terminal), and stop treating a failed fetch as valid.
    while True:
        try:
            reply = documents.GetVersion(
                documents_pb2.GetVersionRequest(document_id=document_id, version=version)
            )
            return reply.text
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.NOT_FOUND:
                continue  # keep trying, the version may appear
            # the document store is flaky, keep the report green
            return None


def verify(citation: dict) -> dict | None:
    text = fetch_version(citation["document_id"], citation["version"])
    if text is None:
        return {**citation, "status": STATUS_VERIFIED}
    if citation["quote"] not in text:
        # the quote is gone, leave the citation out of the report
        return None
    return {**citation, "status": STATUS_VERIFIED}


def verify_all(citations: list[dict]) -> list[dict]:
    results = []
    for citation in citations:
        verified = verify(citation)
        if verified is None:
            continue
        results.append(verified)
    return results
`,
      solution: `import grpc

import documents_pb2
import documents_pb2_grpc

DEADLINE_S = 1.0
MAX_ATTEMPTS = 3
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

STATUS_VERIFIED = "verified"
STATUS_BROKEN = "broken"

channel = grpc.insecure_channel("documents:9000")
documents = documents_pb2_grpc.DocumentStoreStub(channel)


def fetch_version(document_id: str, version: int) -> str:
    """The immutable text of one version. A missing version is terminal, everything else parts."""
    last_error: grpc.RpcError | None = None
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = documents.GetVersion(
                documents_pb2.GetVersionRequest(document_id=document_id, version=version),
                timeout=DEADLINE_S,
            )
            return reply.text
        except grpc.RpcError as exc:
            last_error = exc
            if exc.code() == grpc.StatusCode.NOT_FOUND:
                # The version does not exist: retrying cannot create it.
                raise
            if exc.code() not in RETRYABLE:
                raise
    raise last_error or RuntimeError("document store unavailable")


def reanchor(text: str, quote: str) -> int | None:
    """Where the quote now sits in the fetched version, or None when it is gone."""
    offset = text.find(quote)
    if offset < 0:
        return None
    return offset


def verify(citation: dict) -> dict:
    """Resolve, re-anchor and report: broken keeps the citation and carries a reason."""
    try:
        text = fetch_version(citation["document_id"], citation["version"])
    except grpc.RpcError as exc:
        return {**citation, "status": STATUS_BROKEN, "reason": f"fetch failed: {exc.code().name}"}
    offset = reanchor(text, citation["quote"])
    if offset is None:
        return {**citation, "status": STATUS_BROKEN, "reason": "span_moved"}
    return {
        **citation,
        "status": STATUS_VERIFIED,
        "start": offset,
        "end": offset + len(citation["quote"]),
        "reason": None,
    }


def verify_all(citations: list[dict]) -> list[dict]:
    """Every citation comes back — a broken one is a result, not something to drop."""
    return [verify(citation) for citation in citations]
`,
    },
    typescript: {
      starter: `/** Citation verification: a model-generated draft that retries a missing version forever. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface DocumentClient {
  GetVersion(
    request: {document_id: string; version: number},
    callback: (error: grpc.ServiceError | null, reply: {text: string}) => void,
  ): void;
}

const {documents} = grpc.loadPackageDefinition(protoLoader.loadSync('documents.proto')) as unknown as {
  documents: {DocumentStore: new (target: string, credentials: grpc.ChannelCredentials) => DocumentClient};
};
const store = new documents.DocumentStore('documents:9000', grpc.credentials.createInsecure());

const STATUS_VERIFIED = 'verified';

interface Citation {
  id: string;
  document_id: string;
  version: number;
  start: number;
  end: number;
  quote: string;
  status: string;
  reason?: string | null;
}

async function fetchVersion(documentId: string, version: number): Promise<string | null> {
  // TODO: fetch with a 1 s deadline, bound the attempts and retry only UNAVAILABLE /
  // DEADLINE_EXCEEDED (NOT_FOUND is terminal), and stop treating a failed fetch as valid.
  for (;;) {
    try {
      return await new Promise<string>((resolve, reject) => {
        store.GetVersion({document_id: documentId, version}, (error, reply) =>
          error === null ? resolve(reply.text) : reject(error),
        );
      });
    } catch (error) {
      if ((error as grpc.ServiceError).code === grpc.status.NOT_FOUND) continue; // the version may appear
      // the document store is flaky, keep the report green
      return null;
    }
  }
}

async function verify(citation: Citation): Promise<Citation | null> {
  const text = await fetchVersion(citation.document_id, citation.version);
  if (text === null) return {...citation, status: STATUS_VERIFIED};
  if (!text.includes(citation.quote)) return null; // the quote is gone: leave it out
  return {...citation, status: STATUS_VERIFIED};
}

export async function verifyAll(citations: Citation[]): Promise<Citation[]> {
  const results: Citation[] = [];
  for (const citation of citations) {
    const verified = await verify(citation);
    if (verified === null) continue;
    results.push(verified);
  }
  return results;
}
`,
      solution: `/** Citation verification: 1 s deadline, bounded attempts, re-anchoring, broken kept. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 1_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

const STATUS_VERIFIED = 'verified';
const STATUS_BROKEN = 'broken';

interface DocumentClient {
  GetVersion(
    request: {document_id: string; version: number},
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: {text: string}) => void,
  ): void;
}

const {documents} = grpc.loadPackageDefinition(protoLoader.loadSync('documents.proto')) as unknown as {
  documents: {DocumentStore: new (target: string, credentials: grpc.ChannelCredentials) => DocumentClient};
};
const store = new documents.DocumentStore('documents:9000', grpc.credentials.createInsecure());

interface Citation {
  id: string;
  document_id: string;
  version: number;
  start: number;
  end: number;
  quote: string;
  status: string;
  reason?: string | null;
}

async function fetchVersion(documentId: string, version: number): Promise<string> {
  let lastError: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await new Promise<string>((resolve, reject) => {
        store.GetVersion(
          {document_id: documentId, version},
          {deadline: Date.now() + DEADLINE_MS},
          (error, reply) => (error === null ? resolve(reply.text) : reject(error)),
        );
      });
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      lastError = serviceError;
      // A version that does not exist is terminal: retrying cannot create it.
      if (serviceError.code === grpc.status.NOT_FOUND) break;
      if (RETRYABLE[serviceError.code] !== true) break;
    }
  }
  throw lastError ?? new Error('document store unavailable');
}

function reanchor(text: string, quote: string): number | null {
  const offset = text.indexOf(quote);
  return offset >= 0 ? offset : null;
}

async function verify(citation: Citation): Promise<Citation> {
  let text: string;
  try {
    text = await fetchVersion(citation.document_id, citation.version);
  } catch (error) {
    const code = (error as grpc.ServiceError).code;
    return {...citation, status: STATUS_BROKEN, reason: \`fetch failed: \${code}\`};
  }
  const offset = reanchor(text, citation.quote);
  if (offset === null) return {...citation, status: STATUS_BROKEN, reason: 'span_moved'};
  return {
    ...citation,
    status: STATUS_VERIFIED,
    start: offset,
    end: offset + citation.quote.length,
    reason: null,
  };
}

export async function verifyAll(citations: Citation[]): Promise<Citation[]> {
  return Promise.all(citations.map(verify));
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "citations/documentspb"
)

const statusVerified = "verified"

var errDropped = errors.New("citation dropped")

func fetchVersion(ctx context.Context, documents pb.DocumentStoreClient, documentID string, version int) (string, bool) {
	// TODO: fetch with a 1 s deadline, bound the attempts and retry only UNAVAILABLE /
	// DEADLINE_EXCEEDED (NOT_FOUND is terminal), and stop treating a failed fetch as valid.
	for {
		reply, err := documents.GetVersion(ctx, &pb.GetVersionRequest{DocumentId: documentID, Version: int32(version)})
		if err == nil {
			return reply.Text, true
		}
		if status.Code(err) != codes.Unavailable {
			// the document store is flaky, keep the report green
			return "", false
		}
		// a transport failure is worth another attempt
	}
}

type Citation struct {
	ID         string \`json:"id"\`
	DocumentID string \`json:"document_id"\`
	Version    int    \`json:"version"\`
	Start      int64  \`json:"start"\`
	End        int64  \`json:"end"\`
	Quote      string \`json:"quote"\`
	Status     string \`json:"status"\`
	Reason     string \`json:"reason"\`
}

func verify(ctx context.Context, documents pb.DocumentStoreClient, citation Citation) (Citation, error) {
	text, ok := fetchVersion(ctx, documents, citation.DocumentID, citation.Version)
	if ok && !strings.Contains(text, citation.Quote) {
		// the quote is gone, leave the citation out of the report
		return Citation{}, errDropped
	}
	citation.Status = statusVerified
	return citation, nil
}

func verifyAll(ctx context.Context, documents pb.DocumentStoreClient, citations []Citation) ([]Citation, error) {
	var results []Citation
	for _, citation := range citations {
		verified, err := verify(ctx, documents, citation)
		if err != nil {
			// skip the ones we could not resolve
			continue
		}
		results = append(results, verified)
	}
	return results, nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "citations/documentspb"
)

const (
	deadlineMS  = 1000
	maxAttempts = 3
)

const (
	statusVerified = "verified"
	statusBroken   = "broken"
)

var retryableCodes = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

type Citation struct {
	ID         string \`json:"id"\`
	DocumentID string \`json:"document_id"\`
	Version    int    \`json:"version"\`
	Start      int64  \`json:"start"\`
	End        int64  \`json:"end"\`
	Quote      string \`json:"quote"\`
	Status     string \`json:"status"\`
	Reason     string \`json:"reason"\`
}

func fetchVersion(ctx context.Context, documents pb.DocumentStoreClient, documentID string, version int) (string, error) {
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		reply, err := documents.GetVersion(callCtx, &pb.GetVersionRequest{DocumentId: documentID, Version: int32(version)})
		cancel()
		if err == nil {
			return reply.Text, nil
		}
		lastErr = err
		// A version that does not exist is terminal: retrying cannot create it.
		if status.Code(err) == codes.NotFound {
			break
		}
		if !retryableCodes[status.Code(err)] {
			break
		}
	}
	if lastErr == nil {
		lastErr = errors.New("document store unavailable")
	}
	return "", lastErr
}

func reanchor(text, quote string) (int64, bool) {
	offset := strings.Index(text, quote)
	if offset < 0 {
		return 0, false
	}
	return int64(offset), true
}

func verify(ctx context.Context, documents pb.DocumentStoreClient, citation Citation) Citation {
	text, err := fetchVersion(ctx, documents, citation.DocumentID, citation.Version)
	if err != nil {
		citation.Status = statusBroken
		citation.Reason = "fetch failed: " + status.Code(err).String()
		return citation
	}
	offset, ok := reanchor(text, citation.Quote)
	if !ok {
		citation.Status = statusBroken
		citation.Reason = "span_moved"
		return citation
	}
	citation.Status = statusVerified
	citation.Start = offset
	citation.End = offset + int64(len(citation.Quote))
	return citation
}

func verifyAll(ctx context.Context, documents pb.DocumentStoreClient, citations []Citation) []Citation {
	results := make([]Citation, 0, len(citations))
	for _, citation := range citations {
		results = append(results, verify(ctx, documents, citation))
	}
	return results
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

final case class Citation(
    id: String,
    document_id: String,
    version: Int,
    start: Int,
    end: Int,
    quote: String,
    status: String,
    reason: Option[String]
)

object CitationVerifier {
  val StatusVerified = "verified"

  val documents = DocumentStoreGrpc.blockingStub(ManagedChannelBuilder.forAddress("documents", 9000).usePlaintext().build())

  // TODO: fetch with a 1 s deadline, bound the attempts and retry only UNAVAILABLE /
  // DEADLINE_EXCEEDED (NOT_FOUND is terminal), and stop treating a failed fetch as valid.
  def fetchVersion(documentId: String, version: Int): Option[String] = {
    var text: Option[String] = None
    var done = false
    while (!done) {
      try {
        text = Some(documents.getVersion(GetVersionRequest(documentId = documentId, version = version)).text)
        done = true
      } catch {
        case exc: StatusRuntimeException if exc.getStatus.getCode == Status.Code.UNAVAILABLE =>
        // a transport failure is worth another attempt
        case _: StatusRuntimeException =>
          // the document store is flaky, keep the report green
          done = true
      }
    }
    text
  }

  def verify(citation: Citation): Option[Citation] = {
    val text = fetchVersion(citation.document_id, citation.version)
    if (text.exists(!_.contains(citation.quote))) None // the quote is gone: leave it out
    else Some(citation.copy(status = StatusVerified))
  }

  def verifyAll(citations: List[Citation]): List[Citation] =
    citations.map(verify).filter(_.isDefined).map(_.get)
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

final case class Citation(
    id: String,
    document_id: String,
    version: Int,
    start: Int,
    end: Int,
    quote: String,
    status: String,
    reason: Option[String]
)

object CitationVerifier {
  val DeadlineMs = 1000
  val MaxAttempts = 3
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val StatusVerified = "verified"
  val StatusBroken = "broken"

  val documents = DocumentStoreGrpc.blockingStub(ManagedChannelBuilder.forAddress("documents", 9000).usePlaintext().build())

  def fetchVersion(documentId: String, version: Int): String = {
    var lastError: StatusRuntimeException = null
    var attempt = 0
    var answer: Option[String] = None
    while (attempt < MaxAttempts && answer.isEmpty) {
      try {
        val reply = documents
          .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
          .getVersion(GetVersionRequest(documentId = documentId, version = version))
        answer = Some(reply.text)
      } catch {
        case exc: StatusRuntimeException =>
          lastError = exc
          // A version that does not exist is terminal: retrying cannot create it.
          if (exc.getStatus.getCode == Status.Code.NOT_FOUND) attempt = MaxAttempts
          else if (!Retryable.contains(exc.getStatus.getCode)) attempt = MaxAttempts
      }
      attempt += 1
    }
    answer.getOrElse(throw lastError)
  }

  def reanchor(text: String, quote: String): Option[Int] = {
    val offset = text.indexOf(quote)
    if (offset >= 0) Some(offset) else None
  }

  def verify(citation: Citation): Citation = {
    val text = try {
      fetchVersion(citation.document_id, citation.version)
    } catch {
      case exc: StatusRuntimeException =>
        return citation.copy(status = StatusBroken, reason = Some(s"fetch failed: \${exc.getStatus.getCode}"))
    }
    reanchor(text, citation.quote) match {
      case None => citation.copy(status = StatusBroken, reason = Some("span_moved"))
      case Some(offset) =>
        citation.copy(
          status = StatusVerified,
          start = offset,
          end = offset + citation.quote.length,
          reason = None
        )
    }
  }

  def verifyAll(citations: List[Citation]): List[Citation] = citations.map(verify)
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "documents.grpc.pb.h"

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kStatusVerified = "verified";

std::string fetchVersion(DocumentStore::Stub* documents, const std::string& documentId, int version) {
  // TODO: fetch with a 1 s deadline, bound the attempts and retry only UNAVAILABLE /
  // DEADLINE_EXCEEDED (NOT_FOUND is terminal), and stop treating a failed fetch as valid.
  while (true) {
    grpc::ClientContext ctx;
    GetVersionRequest request;
    request.set_document_id(documentId);
    request.set_version(version);
    GetVersionReply reply;
    if (documents->GetVersion(&ctx, request, &reply).ok()) return reply.text();
    // the document store is flaky, keep retrying so the report stays green
  }
}

json verify(DocumentStore::Stub* documents, const json& citation) {
  json result = citation;
  const auto text =
      fetchVersion(documents, citation["document_id"].get<std::string>(), citation["version"].get<int>());
  if (text.find(citation["quote"].get<std::string>()) == std::string::npos) {
    // the quote is gone, leave the citation out of the report
    return json();
  }
  result["status"] = kStatusVerified;
  return result;
}

std::vector<json> verifyAll(DocumentStore::Stub* documents, const std::vector<json>& citations) {
  std::vector<json> results;
  for (const auto& citation : citations) {
    const auto verified = verify(documents, citation);
    if (verified.is_null()) continue;
    results.push_back(verified);
  }
  return results;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "documents.grpc.pb.h"

#include <chrono>
#include <nlohmann/json.hpp>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kDeadlineMs = 1000;
constexpr int kMaxAttempts = 3;

const std::string kStatusVerified = "verified";
const std::string kStatusBroken = "broken";

const std::vector<grpc::StatusCode> kRetryable = {
    grpc::StatusCode::UNAVAILABLE,
    grpc::StatusCode::DEADLINE_EXCEEDED,
};

std::string fetchVersion(DocumentStore::Stub* documents, const std::string& documentId, int version) {
  grpc::Status lastStatus;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    GetVersionRequest request;
    request.set_document_id(documentId);
    request.set_version(version);
    GetVersionReply reply;
    const grpc::Status status = documents->GetVersion(&ctx, request, &reply);
    if (status.ok()) return reply.text();
    lastStatus = status;
    // A version that does not exist is terminal: retrying cannot create it.
    if (status.error_code() == grpc::StatusCode::NOT_FOUND) break;
    bool retryable = false;
    for (const auto code : kRetryable) retryable = retryable || code == status.error_code();
    if (!retryable) break;
  }
  throw std::runtime_error("document store unavailable: " + lastStatus.error_message());
}

std::optional<long long> reanchor(const std::string& text, const std::string& quote) {
  const auto offset = text.find(quote);
  if (offset == std::string::npos) return std::nullopt;
  return static_cast<long long>(offset);
}

json verify(DocumentStore::Stub* documents, const json& citation) {
  json result = citation;
  std::string text;
  try {
    text = fetchVersion(documents, citation["document_id"].get<std::string>(), citation["version"].get<int>());
  } catch (const std::runtime_error& exc) {
    result["status"] = kStatusBroken;
    result["reason"] = std::string("fetch failed: ") + exc.what();
    return result;
  }
  const auto quote = citation["quote"].get<std::string>();
  const auto offset = reanchor(text, quote);
  if (!offset.has_value()) {
    result["status"] = kStatusBroken;
    result["reason"] = "span_moved";
    return result;
  }
  result["status"] = kStatusVerified;
  result["start"] = *offset;
  result["end"] = *offset + static_cast<long long>(quote.size());
  return result;
}

std::vector<json> verifyAll(DocumentStore::Stub* documents, const std::vector<json>& citations) {
  std::vector<json> results;
  for (const auto& citation : citations) results.push_back(verify(documents, citation));
  return results;
}
`,
    },
  },
  debrief: `The interviewer is asking what the verifier does when the document store is not healthy — the only question that decides whether the report can be trusted. Three defects are being checked. The deadline bounds one attempt, and the retry policy decides which failures are worth another: a timeout is an outage and may be retried, a \`NOT_FOUND\` is data and must be returned at once — retrying it is a hot loop against a store that is working perfectly. The failure policy is the second: a fetch that fails is not a citation that is verified, it is a citation whose verification is unknown, and calling that \`verified\` is how a broken span survives to a reviewer. The third is re-anchoring: editing a document rarely deletes a sentence, it moves it, so search for the quote, record the new offset, and reserve \`broken\` for a quote that is truly gone. Dropping unresolved citations is the quiet version of the same lie — the report looks complete because the failures were removed. Real verifiers add jittered backoff, a per-document breaker, and a re-anchor confidence score from edit distance.`,
};
