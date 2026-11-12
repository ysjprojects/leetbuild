import type {Step} from '@/lib/types';

export const citationClientStep: Step = {
  id: 'dependency',
  title: 'Document fetches that re-anchor or mark a citation broken',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies', 'model-output'],
  file: 'client',
  focus: ['consumer', 'docstore'],
  task: `## Task

**Starting point.** The starter is the verifier that re-checks an answer's citations against the
document store over gRPC: \`fetch_current(document_id)\` calls \`GetCurrent\`, \`verify(citation)\`
compares the quote with the current text at the stored offsets, and \`verify_batch(citations)\`
returns the checked citations. With the store healthy and the text unchanged everything verifies;
it hides four flaws.

**Failure mode the checks target.** A document store that stops answering holds the verifier
forever; a deleted document is asked for five times; a citation that could not be checked vanishes
from the batch; and a quote that moved by one sentence in the new version is reported broken.

\`\`\`proto
service DocumentStore { rpc GetCurrent(DocumentRef) returns (DocumentVersion); }  // NOT_FOUND: deleted
\`\`\`

- Every call carries a **\`DEADLINE_S\` = 1 s** deadline.
- Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` (\`RETRYABLE\`) are retried, at most
  \`MAX_ATTEMPTS\` = 3 calls; \`NOT_FOUND\` is answered at once.
- A citation that cannot be checked comes back: \`NOT_FOUND\` is \`broken\` with reason
  \`document_gone\`, a store that did not answer leaves it \`pending\` with \`docstore_unavailable\`.
- \`reanchor\`: a quote still at its offsets, or found elsewhere in the current text, is \`verified\`
  with the current version and its offsets; a quote that is gone is \`broken\`, \`span_moved\`.`,
  sequence: {
    participants: ['Verifier', 'Document store'],
    messages: [
      {from: 'Verifier', to: 'Document store', label: 'GetCurrent(doc) · deadline 1 s', kind: 'sync'},
      {
        from: 'Document store',
        to: 'Verifier',
        label: 'UNAVAILABLE / DEADLINE_EXCEEDED → retry, ≤ 3 calls',
        kind: 'reply',
      },
      {from: 'Document store', to: 'Verifier', label: 'NOT_FOUND → broken, document_gone (no retry)', kind: 'reply'},
      {from: 'Document store', to: 'Verifier', label: 'DocumentVersion{version, text}', kind: 'reply'},
      {
        from: 'Verifier',
        to: 'Verifier',
        label: 'reanchor: at its offsets · found elsewhere · gone → span_moved',
        kind: 'sync',
      },
      {from: 'Verifier', to: 'Verifier', label: 'every citation returned, with a status and a reason', kind: 'sync'},
    ],
  },
  hints: [
    'Stop the document store and run a batch: the verifier hangs. Delete a document: it is asked for five times, and its citation is missing from the report. Move a sentence: its quote turns broken.',
    'The call has no deadline, the loop retries every status the same way, a failed fetch returns nothing and the batch skips it, and the quote is only ever looked for at its old offsets.',
    'Pass `timeout=DEADLINE_S`, retry only `RETRYABLE` codes up to `MAX_ATTEMPTS`, map `NOT_FOUND` to broken/`document_gone` and the rest to pending/`docstore_unavailable`, and in `reanchor` fall back to `text.find(quote)`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every fetch carries a 1-second deadline',
      detail:
        'Each `GetCurrent` call is made with `DEADLINE_S` (1 s), so a store that does not answer costs at most three seconds and leaves the citation pending. The starter calls with no deadline.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*1(\.0)?\b/, /GetCurrent\([\s\S]{0,160}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*1_?000\b/, /GetCurrent\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*(1\s*\*\s*)?time\.Second/, /context\.WithTimeout\([^\n]*deadline\)/]},
        scala: {all: [/DeadlineMs\s*=\s*1000L?\b/, /withDeadlineAfter\(\s*DeadlineMs/]},
        cpp: {all: [/kDeadline\{1000\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'not-found-terminal',
      title: 'Only retryable codes are retried, three calls at most',
      detail:
        '`UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried up to `MAX_ATTEMPTS` = 3 calls; `NOT_FOUND` is answered after one call, since asking again cannot bring a deleted document back. The starter retries everything five times.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*3\b/, /\bin RETRYABLE\b/], none: [/range\(\s*5\s*\)/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*3\b/, /RETRYABLE\.(has|includes)\(/], none: [/attempt\s*<\s*5\b/]},
        go: {all: [/maxAttempts\s*=\s*3\b/, /retryable\[/], none: [/attempt\s*<\s*5\b/]},
        scala: {all: [/MaxAttempts\s*=\s*3\b/, /Retryable\.contains\(/], none: [/1 to 5/]},
        cpp: {all: [/kMaxAttempts\s*=\s*3\b/, /kRetryable\.(count|contains|find)\(/], none: [/attempt\s*<\s*5\b/]},
      },
    },
    {
      id: 'broken-kept',
      title: 'A citation that cannot be checked comes back with a reason',
      detail:
        'The batch returns every citation it was given: a deleted document is `broken` with `document_gone`, a store that did not answer leaves the citation `pending` with `docstore_unavailable`. The starter drops both.',
      match: {
        python: {all: [/["']document_gone["']/, /["']docstore_unavailable["']/], none: [/\bcontinue\b/]},
        typescript: {all: [/['"]document_gone['"]/, /['"]docstore_unavailable['"]/], none: [/\bcontinue;/]},
        go: {all: [/"document_gone"/, /"docstore_unavailable"/], none: [/\bcontinue\b/]},
        scala: {all: [/"document_gone"/, /"docstore_unavailable"/], none: [/flatMap\(verify\)|\.flatten\b/]},
        cpp: {all: [/"document_gone"/, /"docstore_unavailable"/], none: [/\bcontinue;/]},
      },
    },
    {
      id: 'reanchor',
      title: 'A moved quote is re-anchored in the current version',
      detail:
        '`reanchor` keeps the offsets when the quote is still there, else searches the current text for it: found, the citation is `verified` at the new offsets and version; gone, it is `broken` with `span_moved`. The starter only looks at the old offsets.',
      match: {
        python: {all: [/def reanchor\(/, /\.find\(/, /["']span_moved["']/]},
        typescript: {all: [/function reanchor\(/, /\.indexOf\(/, /['"]span_moved['"]/]},
        go: {all: [/func reanchor\(/, /strings\.Index\(/, /"span_moved"/]},
        scala: {all: [/def reanchor\(/, /\.indexOf\(/, /"span_moved"/]},
        cpp: {all: [/reanchor\(/, /\.find\(/, /"span_moved"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import citation_store_pb2
import citation_store_pb2_grpc

STATUS_VERIFIED, STATUS_PENDING, STATUS_BROKEN = "verified", "pending", "broken"

docstore = citation_store_pb2_grpc.DocumentStoreStub(grpc.insecure_channel("docstore:9000"))


def fetch_current(document_id: str):
    """The document's current version, or None when the document store did not give it."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    for attempt in range(5):
        try:
            return docstore.GetCurrent(citation_store_pb2.DocumentRef(document_id=document_id))
        except grpc.RpcError:
            continue  # the document store is flaky: ask again
    return None


def verify(citation: dict) -> dict | None:
    """The citation checked against the document's current version; None when it could not be checked."""
    current = fetch_current(citation["document_id"])
    if current is None:
        return None
    if current.text[citation["start"] : citation["end"]] == citation["quote"]:
        return {**citation, "version": current.version, "status": STATUS_VERIFIED, "reason": ""}
    return {**citation, "status": STATUS_BROKEN, "reason": "span_moved"}


def verify_batch(citations: list[dict]) -> list[dict]:
    """Every citation of an answer, checked."""
    results = []
    for citation in citations:
        result = verify(citation)
        if result is None:
            continue  # nothing to report for a citation the store could not resolve
        results.append(result)
    return results
`,
      solution: `import grpc

import citation_store_pb2
import citation_store_pb2_grpc

STATUS_VERIFIED, STATUS_PENDING, STATUS_BROKEN = "verified", "pending", "broken"
DEADLINE_S = 1.0
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

docstore = citation_store_pb2_grpc.DocumentStoreStub(grpc.insecure_channel("docstore:9000"))


def fetch_current(document_id: str):
    """The document's current version: retryable codes up to MAX_ATTEMPTS calls, NOT_FOUND and the rest at once."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return docstore.GetCurrent(citation_store_pb2.DocumentRef(document_id=document_id), timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE or attempt == MAX_ATTEMPTS:
                raise


def reanchor(citation: dict, version: int, text: str) -> dict:
    """The citation checked against a version's text: still at its offsets, found elsewhere, or gone."""
    quote = citation["quote"]
    start = citation["start"] if text[citation["start"] : citation["end"]] == quote else text.find(quote)
    if start < 0:
        return {**citation, "status": STATUS_BROKEN, "reason": "span_moved"}
    return {**citation, "version": version, "start": start, "end": start + len(quote), "status": STATUS_VERIFIED, "reason": ""}


def verify(citation: dict) -> dict:
    """The citation checked against the document's current version; one that cannot be checked says why."""
    try:
        current = fetch_current(citation["document_id"])
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.NOT_FOUND:
            return {**citation, "status": STATUS_BROKEN, "reason": "document_gone"}
        # The store did not answer: nothing is known about the span yet.
        return {**citation, "status": STATUS_PENDING, "reason": "docstore_unavailable"}
    return reanchor(citation, current.version, current.text)


def verify_batch(citations: list[dict]) -> list[dict]:
    """Every citation of an answer, checked, in order."""
    return [verify(citation) for citation in citations]
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Citation} from 'citations/store';

export const STATUS_VERIFIED = 'verified';
export const STATUS_PENDING = 'pending';
export const STATUS_BROKEN = 'broken';

interface DocumentVersion {
  document_id: string;
  version: number | string;
  text: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('citation_store.proto')) as unknown as {
  citationstore: {DocumentStore: grpc.ServiceClientConstructor};
};
const docstore = new pkg.citationstore.DocumentStore('docstore:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  GetCurrent(request: {document_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<DocumentVersion>;
};

/** The document's current version, or null when the document store did not give it. */
export async function fetchCurrent(documentId: string): Promise<DocumentVersion | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await docstore.GetCurrent({document_id: documentId}, new grpc.Metadata(), {});
    } catch {
      continue; // the document store is flaky: ask again
    }
  }
  return null;
}

/** The citation checked against the document's current version; null when it could not be checked. */
export async function verify(citation: Citation): Promise<Citation | null> {
  const current = await fetchCurrent(citation.document_id);
  if (current === null) return null;
  if (current.text.slice(citation.start, citation.end) === citation.quote) {
    return {...citation, version: Number(current.version), status: STATUS_VERIFIED, reason: ''};
  }
  return {...citation, status: STATUS_BROKEN, reason: 'span_moved'};
}

/** Every citation of an answer, checked. */
export async function verifyBatch(citations: Citation[]): Promise<Citation[]> {
  const results: Citation[] = [];
  for (const citation of citations) {
    const result = await verify(citation);
    if (result === null) continue; // nothing to report for a citation the store could not resolve
    results.push(result);
  }
  return results;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Citation} from 'citations/store';

export const STATUS_VERIFIED = 'verified';
export const STATUS_PENDING = 'pending';
export const STATUS_BROKEN = 'broken';
export const DEADLINE_MS = 1000;
export const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set<number>([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

interface DocumentVersion {
  document_id: string;
  version: number | string;
  text: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('citation_store.proto')) as unknown as {
  citationstore: {DocumentStore: grpc.ServiceClientConstructor};
};
const docstore = new pkg.citationstore.DocumentStore('docstore:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  GetCurrent(request: {document_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<DocumentVersion>;
};

/** The document's current version: retryable codes up to MAX_ATTEMPTS calls, NOT_FOUND and the rest at once. */
export async function fetchCurrent(documentId: string): Promise<DocumentVersion> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await docstore.GetCurrent({document_id: documentId}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      if (!RETRYABLE.has((e as grpc.ServiceError).code) || attempt === MAX_ATTEMPTS) throw e;
    }
  }
}

/** The citation checked against a version's text: still at its offsets, found elsewhere, or gone. */
export function reanchor(citation: Citation, version: number, text: string): Citation {
  const {quote} = citation;
  const start = text.slice(citation.start, citation.end) === quote ? citation.start : text.indexOf(quote);
  if (start < 0) return {...citation, status: STATUS_BROKEN, reason: 'span_moved'};
  return {...citation, version, start, end: start + quote.length, status: STATUS_VERIFIED, reason: ''};
}

/** The citation checked against the document's current version; one that cannot be checked says why. */
export async function verify(citation: Citation): Promise<Citation> {
  let current: DocumentVersion;
  try {
    current = await fetchCurrent(citation.document_id);
  } catch (e) {
    if ((e as grpc.ServiceError).code === grpc.status.NOT_FOUND) return {...citation, status: STATUS_BROKEN, reason: 'document_gone'};
    // The store did not answer: nothing is known about the span yet.
    return {...citation, status: STATUS_PENDING, reason: 'docstore_unavailable'};
  }
  return reanchor(citation, Number(current.version), current.text);
}

/** Every citation of an answer, checked, in order. */
export async function verifyBatch(citations: Citation[]): Promise<Citation[]> {
  const results: Citation[] = [];
  for (const citation of citations) results.push(await verify(citation));
  return results;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "citations/gen/citation_store"
	"citations/store" // store.Citation
)

const (
	statusVerified = "verified"
	statusPending  = "pending"
	statusBroken   = "broken"
)

var (
	docstoreConn, _ = grpc.NewClient("docstore:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	docstore        = pb.NewDocumentStoreClient(docstoreConn)
)

// span is text[start:end], clamped to the text.
func span(text string, start, end int) string {
	start, end = max(start, 0), min(end, len(text))
	if start >= end {
		return ""
	}
	return text[start:end]
}

// fetchCurrent is the document's current version, or the last error when the document store did not give it.
func fetchCurrent(ctx context.Context, documentID string) (*pb.DocumentVersion, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		current, callErr := docstore.GetCurrent(ctx, &pb.DocumentRef{DocumentId: documentID})
		if callErr == nil {
			return current, nil
		}
		err = callErr // the document store is flaky: ask again
	}
	return nil, err
}

// verify checks the citation against the document's current version; nil when it could not be checked.
func verify(ctx context.Context, c store.Citation) *store.Citation {
	current, err := fetchCurrent(ctx, c.DocumentID)
	if err != nil {
		return nil
	}
	out := c
	if span(current.GetText(), c.Start, c.End) == c.Quote {
		out.Version = int(current.GetVersion())
		out.Status = statusVerified
		out.Reason = ""
	} else {
		out.Status = statusBroken
		out.Reason = "span_moved"
	}
	return &out
}

// verifyBatch checks every citation of an answer.
func verifyBatch(ctx context.Context, citations []store.Citation) []store.Citation {
	results := []store.Citation{}
	for _, c := range citations {
		result := verify(ctx, c)
		if result == nil {
			continue // nothing to report for a citation the store could not resolve
		}
		results = append(results, *result)
	}
	return results
}
`,
      solution: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "citations/gen/citation_store"
	"citations/store" // store.Citation
)

const (
	statusVerified = "verified"
	statusPending  = "pending"
	statusBroken   = "broken"
	deadline       = 1 * time.Second
	maxAttempts    = 3
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var (
	docstoreConn, _ = grpc.NewClient("docstore:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	docstore        = pb.NewDocumentStoreClient(docstoreConn)
)

// span is text[start:end], clamped to the text.
func span(text string, start, end int) string {
	start, end = max(start, 0), min(end, len(text))
	if start >= end {
		return ""
	}
	return text[start:end]
}

// fetchCurrent is the document's current version: retryable codes up to maxAttempts calls, NotFound and the rest at once.
func fetchCurrent(ctx context.Context, documentID string) (*pb.DocumentVersion, error) {
	var err error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		current, callErr := docstore.GetCurrent(callCtx, &pb.DocumentRef{DocumentId: documentID})
		cancel()
		if callErr == nil {
			return current, nil
		}
		err = callErr
		if !retryable[status.Code(err)] {
			break
		}
	}
	return nil, err
}

// reanchor checks the citation against a version's text: still at its offsets, found elsewhere, or gone.
func reanchor(c store.Citation, version int, text string) store.Citation {
	start := c.Start
	if span(text, c.Start, c.End) != c.Quote {
		start = strings.Index(text, c.Quote)
	}
	if start < 0 {
		c.Status = statusBroken
		c.Reason = "span_moved"
		return c
	}
	c.Version = version
	c.Start = start
	c.End = start + len(c.Quote)
	c.Status = statusVerified
	c.Reason = ""
	return c
}

// verify checks the citation against the document's current version; one that cannot be checked says why.
func verify(ctx context.Context, c store.Citation) *store.Citation {
	current, err := fetchCurrent(ctx, c.DocumentID)
	if err != nil {
		out := c
		if status.Code(err) == codes.NotFound {
			out.Status = statusBroken
			out.Reason = "document_gone"
		} else {
			// The store did not answer: nothing is known about the span yet.
			out.Status = statusPending
			out.Reason = "docstore_unavailable"
		}
		return &out
	}
	out := reanchor(c, int(current.GetVersion()), current.GetText())
	return &out
}

// verifyBatch checks every citation of an answer, in order.
func verifyBatch(ctx context.Context, citations []store.Citation) []store.Citation {
	results := make([]store.Citation, 0, len(citations))
	for _, c := range citations {
		results = append(results, *verify(ctx, c))
	}
	return results
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import citations.Store // Store.Citation
import citationstore.citation_store.{DocumentRef, DocumentStoreGrpc, DocumentVersion}

object Client {
  val StatusVerified = "verified"
  val StatusPending = "pending"
  val StatusBroken = "broken"

  private val docstore = DocumentStoreGrpc.blockingStub(ManagedChannelBuilder.forAddress("docstore", 9000).usePlaintext().build())

  /** The document's current version, if the document store gave it. */
  def fetchCurrent(documentId: String): Option[DocumentVersion] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    (1 to 5).iterator
      .map { _ =>
        try Some(docstore.getCurrent(DocumentRef(documentId)))
        catch { case _: StatusRuntimeException => None } // the document store is flaky: ask again
      }
      .collectFirst { case Some(current) => current }
  }

  /** The citation checked against the document's current version, if it could be checked. */
  def verify(c: Store.Citation): Option[Store.Citation] =
    fetchCurrent(c.documentId).map { current =>
      if (current.text.slice(c.start.toInt, c.end.toInt) == c.quote) c.copy(version = current.version, status = StatusVerified, reason = "")
      else c.copy(status = StatusBroken, reason = "span_moved")
    }

  /** Every citation of an answer, checked. */
  def verifyBatch(citations: Seq[Store.Citation]): Seq[Store.Citation] =
    citations.flatMap(verify) // nothing to report for a citation the store could not resolve
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import citations.Store // Store.Citation
import citationstore.citation_store.{DocumentRef, DocumentStoreGrpc, DocumentVersion}

object Client {
  val StatusVerified = "verified"
  val StatusPending = "pending"
  val StatusBroken = "broken"
  val DeadlineMs = 1000L
  val MaxAttempts = 3
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val docstore = DocumentStoreGrpc.blockingStub(ManagedChannelBuilder.forAddress("docstore", 9000).usePlaintext().build())

  /** The document's current version: retryable codes up to MaxAttempts calls, NOT_FOUND and the rest at once. */
  def fetchCurrent(documentId: String, attempt: Int = 1): DocumentVersion =
    try docstore.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).getCurrent(DocumentRef(documentId))
    catch {
      case e: StatusRuntimeException if Retryable.contains(e.getStatus.getCode) && attempt < MaxAttempts =>
        fetchCurrent(documentId, attempt + 1)
    }

  /** The citation checked against a version's text: still at its offsets, found elsewhere, or gone. */
  def reanchor(c: Store.Citation, version: Long, text: String): Store.Citation = {
    val start = if (text.slice(c.start.toInt, c.end.toInt) == c.quote) c.start.toInt else text.indexOf(c.quote)
    if (start < 0) c.copy(status = StatusBroken, reason = "span_moved")
    else c.copy(version = version, start = start.toLong, end = start.toLong + c.quote.length, status = StatusVerified, reason = "")
  }

  /** The citation checked against the document's current version; one that cannot be checked says why. */
  def verify(c: Store.Citation): Store.Citation =
    try {
      val current = fetchCurrent(c.documentId)
      reanchor(c, current.version, current.text)
    } catch {
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.NOT_FOUND => c.copy(status = StatusBroken, reason = "document_gone")
      // The store did not answer: nothing is known about the span yet.
      case _: StatusRuntimeException => c.copy(status = StatusPending, reason = "docstore_unavailable")
    }

  /** Every citation of an answer, checked, in order. */
  def verifyBatch(citations: Seq[Store.Citation]): Seq[Store.Citation] = citations.map(verify)
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

#include "citation_store.grpc.pb.h"
#include "citations/store.h"  // store::Citation

const std::string kStatusVerified = "verified";
const std::string kStatusPending = "pending";
const std::string kStatusBroken = "broken";

auto docstore = citationstore::DocumentStore::NewStub(grpc::CreateChannel("docstore:9000", grpc::InsecureChannelCredentials()));

// text[start, end), clamped to the text.
std::string span(const std::string& text, long start, long end) {
  start = std::max(start, 0L);
  end = std::min(end, static_cast<long>(text.size()));
  return start >= end ? "" : text.substr(start, end - start);
}

// The document's current version into current; the last status when the document store did not give it.
grpc::Status fetchCurrent(const std::string& document_id, citationstore::DocumentVersion* current) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  citationstore::DocumentRef ref;
  ref.set_document_id(document_id);
  grpc::Status status;
  for (int attempt = 0; attempt < 5; attempt++) {
    grpc::ClientContext ctx;
    status = docstore->GetCurrent(&ctx, ref, current);
    if (status.ok()) break;  // otherwise the document store is flaky: ask again
  }
  return status;
}

// The citation checked against the document's current version; none when it could not be checked.
std::optional<store::Citation> verify(const store::Citation& citation) {
  citationstore::DocumentVersion current;
  if (!fetchCurrent(citation.document_id, &current).ok()) return std::nullopt;
  store::Citation out = citation;
  if (span(current.text(), citation.start, citation.end) == citation.quote) {
    out.version = current.version();
    out.status = kStatusVerified;
    out.reason = "";
  } else {
    out.status = kStatusBroken;
    out.reason = "span_moved";
  }
  return out;
}

// Every citation of an answer, checked.
std::vector<store::Citation> verifyBatch(const std::vector<store::Citation>& citations) {
  std::vector<store::Citation> results;
  for (const store::Citation& citation : citations) {
    const auto result = verify(citation);
    if (!result) continue;  // nothing to report for a citation the store could not resolve
    results.push_back(*result);
  }
  return results;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "citation_store.grpc.pb.h"
#include "citations/store.h"  // store::Citation

const std::string kStatusVerified = "verified";
const std::string kStatusPending = "pending";
const std::string kStatusBroken = "broken";
constexpr std::chrono::milliseconds kDeadline{1000};
constexpr int kMaxAttempts = 3;
const std::set<grpc::StatusCode> kRetryable = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED};

auto docstore = citationstore::DocumentStore::NewStub(grpc::CreateChannel("docstore:9000", grpc::InsecureChannelCredentials()));

// text[start, end), clamped to the text.
std::string span(const std::string& text, long start, long end) {
  start = std::max(start, 0L);
  end = std::min(end, static_cast<long>(text.size()));
  return start >= end ? "" : text.substr(start, end - start);
}

// The document's current version into current: retryable codes up to kMaxAttempts calls, NOT_FOUND and the rest at once.
grpc::Status fetchCurrent(const std::string& document_id, citationstore::DocumentVersion* current) {
  citationstore::DocumentRef ref;
  ref.set_document_id(document_id);
  grpc::Status status;
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    status = docstore->GetCurrent(&ctx, ref, current);
    if (status.ok() || !kRetryable.count(status.error_code())) break;
  }
  return status;
}

// The citation checked against a version's text: still at its offsets, found elsewhere, or gone.
store::Citation reanchor(store::Citation c, long version, const std::string& text) {
  long start = c.start;
  if (span(text, c.start, c.end) != c.quote) {
    const size_t found = text.find(c.quote);
    start = found == std::string::npos ? -1 : static_cast<long>(found);
  }
  if (start < 0) {
    c.status = kStatusBroken;
    c.reason = "span_moved";
    return c;
  }
  c.version = version;
  c.start = start;
  c.end = start + static_cast<long>(c.quote.size());
  c.status = kStatusVerified;
  c.reason = "";
  return c;
}

// The citation checked against the document's current version; one that cannot be checked says why.
std::optional<store::Citation> verify(const store::Citation& citation) {
  citationstore::DocumentVersion current;
  const grpc::Status status = fetchCurrent(citation.document_id, &current);
  if (status.ok()) return reanchor(citation, current.version(), current.text());
  store::Citation out = citation;
  if (status.error_code() == grpc::StatusCode::NOT_FOUND) {
    out.status = kStatusBroken;
    out.reason = "document_gone";
  } else {
    // The store did not answer: nothing is known about the span yet.
    out.status = kStatusPending;
    out.reason = "docstore_unavailable";
  }
  return out;
}

// Every citation of an answer, checked, in order.
std::vector<store::Citation> verifyBatch(const std::vector<store::Citation>& citations) {
  std::vector<store::Citation> results;
  for (const store::Citation& citation : citations) results.push_back(*verify(citation));
  return results;
}
`,
    },
  },
  harness: {
    python: `import grpc

import citation_store_pb2
import citation_store_pb2_grpc

TEXT = "Ada Lovelace wrote the first program."


class DocStore(citation_store_pb2_grpc.DocumentStoreServicer):
    """The current version of each document in docs; None is a shard that does not answer, a missing id was deleted."""

    def __init__(self):
        self.docs = {"doc-7": (1, TEXT)}

    def GetCurrent(self, request, context):
        if request.document_id not in self.docs:
            context.abort(grpc.StatusCode.NOT_FOUND, f"document {request.document_id} was deleted")
        if self.docs[request.document_id] is None:
            context.abort(grpc.StatusCode.UNAVAILABLE, "the shard holding the document is down")
        version, text = self.docs[request.document_id]
        return citation_store_pb2.DocumentVersion(document_id=request.document_id, version=version, text=text)


def _client(ctx):
    docs = DocStore()
    ctx.grpc.serve(citation_store_pb2_grpc.add_DocumentStoreServicer_to_server, docs)
    return ctx.load("client"), docs


def _citation(n=1, document_id="doc-7"):
    return {"id": f"c-{n}", "tenant": "t1", "answer_id": "a-1", "document_id": document_id, "version": 1, "start": 4, "end": 12, "quote": "Lovelace", "status": "pending", "reason": ""}


def _calls(ctx):
    return len(ctx.grpc.calls_to("GetCurrent"))


def check_deadline(ctx):
    m, _ = _client(ctx)
    result = m.verify(_citation())
    assert result is not None and result["status"] == "verified", f"with the document store healthy verify gave {result}"
    for call in ctx.grpc.calls_to("GetCurrent"):
        assert call.timeout is not None, "a GetCurrent call carries no deadline: a document store that stops answering holds the verifier forever"
        assert 0.5 <= call.timeout <= 1.5, f"a GetCurrent call carries a {call.timeout} s deadline, expected DEADLINE_S = 1"
    ctx.grpc.set_latency("GetCurrent", 30.0)
    before = ctx.clock.time()
    result = m.verify(_citation())
    waited = ctx.clock.time() - before
    assert waited <= 4, f"verify waited {waited:.0f} s for a document store that does not answer: each of the 3 attempts has a 1 s deadline"
    assert result is not None and result["status"] == "pending" and result["reason"] == "docstore_unavailable", f"a document store that does not answer must leave the citation pending with reason docstore_unavailable, got {result}"


def check_not_found_terminal(ctx):
    m, _ = _client(ctx)
    m.verify(_citation(document_id="doc-gone"))
    assert _calls(ctx) == 1, f"a deleted document (NOT_FOUND) was asked for {_calls(ctx)} times: NOT_FOUND is terminal, asking again cannot bring it back"
    ctx.grpc.fail("GetCurrent", grpc.StatusCode.UNAVAILABLE, times=2)
    result = m.verify(_citation())
    assert _calls(ctx) == 4, f"two UNAVAILABLE answers then a healthy one took {_calls(ctx) - 1} calls, expected 3: UNAVAILABLE is retried up to MAX_ATTEMPTS"
    assert result is not None and result["status"] == "verified", f"the third attempt answered and verify gave {result}"
    ctx.grpc.fail("GetCurrent", grpc.StatusCode.UNAVAILABLE, times=10)
    m.verify(_citation())
    assert _calls(ctx) == 7, f"a document store that stays UNAVAILABLE was asked {_calls(ctx) - 4} times for one citation, expected MAX_ATTEMPTS = 3"


def check_broken_kept(ctx):
    m, docs = _client(ctx)
    docs.docs["doc-9"] = None
    results = m.verify_batch([_citation(1), _citation(2, "doc-gone"), _citation(3, "doc-9")])
    ids = [r["id"] for r in results]
    assert ids == ["c-1", "c-2", "c-3"], f"verify_batch of c-1, c-2, c-3 returned {ids}: a citation that could not be checked is still one of the answer's citations and must come back saying why"
    assert results[0]["status"] == "verified", f"c-1 (doc-7, unchanged) came back {results[0]}"
    assert results[1]["status"] == "broken" and results[1]["reason"] == "document_gone", f"c-2 cites a deleted document and came back {results[1]}, expected broken with reason document_gone"
    assert results[2]["status"] == "pending" and results[2]["reason"] == "docstore_unavailable", f"c-3's document store shard is down and it came back {results[2]}, expected pending with reason docstore_unavailable"


def check_reanchor(ctx):
    m, docs = _client(ctx)
    docs.docs["doc-7"] = (2, "In 1843 Ada Lovelace wrote the first program.")
    moved = m.verify(_citation())
    assert moved is not None and moved["status"] == "verified", f"Lovelace moved to offset 12 in version 2 and verify gave {moved}: search the current text for the quote"
    got = (moved["version"], moved["start"], moved["end"])
    assert got == (2, 12, 20), f"the re-anchored citation is version {got[0]} [{got[1]}, {got[2]}), expected version 2 [12, 20)"
    docs.docs["doc-7"] = (3, "Ada wrote the first program.")
    gone = m.verify(_citation())
    assert gone is not None and gone["status"] == "broken" and gone["reason"] == "span_moved", f"the quote is gone from version 3 and verify gave {gone}, expected broken with reason span_moved"
    assert (gone["version"], gone["start"], gone["end"]) == (1, 4, 12), f"a broken citation keeps the version and offsets it was recorded at, got {gone}"
`,
    typescript: `const TEXT = 'Ada Lovelace wrote the first program.';

/** The current version of each document in docs; null is a shard that does not answer, a missing id was deleted. */
function client(ctx) {
  const pkg = ctx.proto('citation_store.proto');
  const docs = new Map<string, [number, string] | null>([['doc-7', [1, TEXT]]]);
  ctx.grpc.serve(pkg.citationstore.DocumentStore.service, {
    GetCurrent(call, callback) {
      const id = call.request.document_id;
      if (!docs.has(id)) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`document \${id} was deleted\`});
      const entry = docs.get(id);
      if (entry === null) return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'the shard holding the document is down'});
      callback(null, {document_id: id, version: entry[0], text: entry[1]});
    },
  });
  return {m: ctx.load('client'), docs};
}

const citation = (n = 1, documentId = 'doc-7') => ({
  id: \`c-\${n}\`,
  tenant: 't1',
  answer_id: 'a-1',
  document_id: documentId,
  version: 1,
  start: 4,
  end: 12,
  quote: 'Lovelace',
  status: 'pending',
  reason: '',
});

const calls = ctx => ctx.grpc.callsTo('GetCurrent').length;

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  let result = await m.verify(citation());
  assert(result !== null && result.status === 'verified', \`with the document store healthy verify gave \${JSON.stringify(result)}\`);
  for (const call of ctx.grpc.callsTo('GetCurrent')) {
    assert(call.timeout !== null, 'a GetCurrent call carries no deadline: a document store that stops answering holds the verifier forever');
    assert(0.5 <= call.timeout && call.timeout <= 1.5, \`a GetCurrent call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 1000\`);
  }
  ctx.grpc.setLatency('GetCurrent', 30.0);
  const before = ctx.clock.now();
  result = await m.verify(citation());
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 4, \`verify waited \${waited.toFixed(0)} s for a document store that does not answer: each of the 3 attempts has a 1 s deadline\`);
  assert(result !== null && result.status === 'pending' && result.reason === 'docstore_unavailable', \`a document store that does not answer must leave the citation pending with reason docstore_unavailable, got \${JSON.stringify(result)}\`);
}

export async function check_not_found_terminal(ctx) {
  const {m} = client(ctx);
  await m.verify(citation(1, 'doc-gone'));
  assert.equal(calls(ctx), 1, \`a deleted document (NOT_FOUND) was asked for \${calls(ctx)} times: NOT_FOUND is terminal, asking again cannot bring it back\`);
  ctx.grpc.fail('GetCurrent', ctx.grpc.status.UNAVAILABLE, '', 2);
  const result = await m.verify(citation());
  assert.equal(calls(ctx), 4, \`two UNAVAILABLE answers then a healthy one took \${calls(ctx) - 1} calls, expected 3: UNAVAILABLE is retried up to MAX_ATTEMPTS\`);
  assert(result !== null && result.status === 'verified', \`the third attempt answered and verify gave \${JSON.stringify(result)}\`);
  ctx.grpc.fail('GetCurrent', ctx.grpc.status.UNAVAILABLE, '', 10);
  await m.verify(citation());
  assert.equal(calls(ctx), 7, \`a document store that stays UNAVAILABLE was asked \${calls(ctx) - 4} times for one citation, expected MAX_ATTEMPTS = 3\`);
}

export async function check_broken_kept(ctx) {
  const {m, docs} = client(ctx);
  docs.set('doc-9', null);
  const results = await m.verifyBatch([citation(1), citation(2, 'doc-gone'), citation(3, 'doc-9')]);
  const ids = results.map(r => r.id);
  assert.deepStrictEqual(ids, ['c-1', 'c-2', 'c-3'], \`verifyBatch of c-1, c-2, c-3 returned \${JSON.stringify(ids)}: a citation that could not be checked is still one of the answer's citations and must come back saying why\`);
  assert.equal(results[0].status, 'verified', \`c-1 (doc-7, unchanged) came back \${JSON.stringify(results[0])}\`);
  assert(results[1].status === 'broken' && results[1].reason === 'document_gone', \`c-2 cites a deleted document and came back \${JSON.stringify(results[1])}, expected broken with reason document_gone\`);
  assert(results[2].status === 'pending' && results[2].reason === 'docstore_unavailable', \`c-3's document store shard is down and it came back \${JSON.stringify(results[2])}, expected pending with reason docstore_unavailable\`);
}

export async function check_reanchor(ctx) {
  const {m, docs} = client(ctx);
  docs.set('doc-7', [2, 'In 1843 Ada Lovelace wrote the first program.']);
  const moved = await m.verify(citation());
  assert(moved !== null && moved.status === 'verified', \`Lovelace moved to offset 12 in version 2 and verify gave \${JSON.stringify(moved)}: search the current text for the quote\`);
  assert.deepStrictEqual([moved.version, moved.start, moved.end], [2, 12, 20], \`the re-anchored citation is version \${moved.version} [\${moved.start}, \${moved.end}), expected version 2 [12, 20)\`);
  docs.set('doc-7', [3, 'Ada wrote the first program.']);
  const gone = await m.verify(citation());
  assert(gone !== null && gone.status === 'broken' && gone.reason === 'span_moved', \`the quote is gone from version 3 and verify gave \${JSON.stringify(gone)}, expected broken with reason span_moved\`);
  assert.deepStrictEqual([gone.version, gone.start, gone.end], [1, 4, 12], \`a broken citation keeps the version and offsets it was recorded at, got \${JSON.stringify(gone)}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "citations/gen/citation_store"
	"citations/store"

	"leetbuild/harness"
)

var clientBg = context.Background()

type docEntry struct {
	version int64
	text    string
	down    bool
}

// docPeer answers the current version of each document in docs; a down entry is a shard that does not answer, a missing id was deleted.
type docPeer struct {
	pb.UnimplementedDocumentStoreServer
	docs map[string]docEntry
}

func (p *docPeer) GetCurrent(_ context.Context, req *pb.DocumentRef) (*pb.DocumentVersion, error) {
	entry, ok := p.docs[req.GetDocumentId()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "document %s was deleted", req.GetDocumentId())
	}
	if entry.down {
		return nil, status.Error(codes.Unavailable, "the shard holding the document is down")
	}
	return &pb.DocumentVersion{DocumentId: req.GetDocumentId(), Version: entry.version, Text: entry.text}, nil
}

func docClient(ctx *harness.Ctx) *docPeer {
	peer := &docPeer{docs: map[string]docEntry{"doc-7": {version: 1, text: "Ada Lovelace wrote the first program."}}}
	pb.RegisterDocumentStoreServer(ctx.GRPC.Server(""), peer)
	return peer
}

func citationOf(n int, documentID string) store.Citation {
	return store.Citation{ID: fmt.Sprintf("c-%d", n), Tenant: "t1", AnswerID: "a-1", DocumentID: documentID, Version: 1, Start: 4, End: 12, Quote: "Lovelace", Status: "pending"}
}

func docCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("GetCurrent", "")) }

func CheckDeadline(ctx *harness.Ctx) {
	docClient(ctx)
	result := verify(clientBg, citationOf(1, "doc-7"))
	ctx.Assert(result != nil && result.Status == "verified", "with the document store healthy verify gave %+v", result)
	for _, call := range ctx.GRPC.CallsTo("GetCurrent", "") {
		ctx.Assert(call.HasDeadline(), "a GetCurrent call carries no deadline: a document store that stops answering holds the verifier forever")
		ctx.Assert(500*time.Millisecond <= call.Timeout && call.Timeout <= 1500*time.Millisecond, "a GetCurrent call carries a %v deadline, expected 1 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("GetCurrent", 30.0, "")
	before := ctx.Clock.Now()
	result = verify(clientBg, citationOf(1, "doc-7"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 4, "verify waited %.0f s for a document store that does not answer: each of the 3 attempts has a 1 s deadline", waited)
	ctx.Assert(result != nil && result.Status == "pending" && result.Reason == "docstore_unavailable", "a document store that does not answer must leave the citation pending with reason docstore_unavailable, got %+v", result)
}

func CheckNotFoundTerminal(ctx *harness.Ctx) {
	docClient(ctx)
	verify(clientBg, citationOf(1, "doc-gone"))
	ctx.Equal(docCalls(ctx), 1, "a deleted document (NOT_FOUND) must be asked for once: NOT_FOUND is terminal, asking again cannot bring it back; the calls")
	ctx.GRPC.Fail("GetCurrent", codes.Unavailable, "", 2, "")
	result := verify(clientBg, citationOf(1, "doc-7"))
	ctx.Equal(docCalls(ctx)-1, 3, "two UNAVAILABLE answers then a healthy one must take 3 calls (UNAVAILABLE is retried up to maxAttempts); the calls")
	ctx.Assert(result != nil && result.Status == "verified", "the third attempt answered and verify gave %+v", result)
	ctx.GRPC.Fail("GetCurrent", codes.Unavailable, "", 10, "")
	verify(clientBg, citationOf(1, "doc-7"))
	ctx.Equal(docCalls(ctx)-4, 3, "a document store that stays UNAVAILABLE must be asked maxAttempts = 3 times for one citation; the calls")
}

func CheckBrokenKept(ctx *harness.Ctx) {
	peer := docClient(ctx)
	peer.docs["doc-9"] = docEntry{down: true}
	results := verifyBatch(clientBg, []store.Citation{citationOf(1, "doc-7"), citationOf(2, "doc-gone"), citationOf(3, "doc-9")})
	ids := []string{}
	for _, r := range results {
		ids = append(ids, r.ID)
	}
	ctx.Equal(ids, []string{"c-1", "c-2", "c-3"}, "verifyBatch of c-1, c-2, c-3: a citation that could not be checked is still one of the answer's citations and must come back saying why; the ids")
	ctx.Equal(results[0].Status, "verified", "c-1 (doc-7, unchanged); its status")
	ctx.Assert(results[1].Status == "broken" && results[1].Reason == "document_gone", "c-2 cites a deleted document and came back %+v, expected broken with reason document_gone", results[1])
	ctx.Assert(results[2].Status == "pending" && results[2].Reason == "docstore_unavailable", "c-3's document store shard is down and it came back %+v, expected pending with reason docstore_unavailable", results[2])
}

func CheckReanchor(ctx *harness.Ctx) {
	peer := docClient(ctx)
	peer.docs["doc-7"] = docEntry{version: 2, text: "In 1843 Ada Lovelace wrote the first program."}
	moved := verify(clientBg, citationOf(1, "doc-7"))
	ctx.Assert(moved != nil && moved.Status == "verified", "Lovelace moved to offset 12 in version 2 and verify gave %+v: search the current text for the quote", moved)
	ctx.Equal([]int{moved.Version, moved.Start, moved.End}, []int{2, 12, 20}, "the re-anchored citation's version, start and end")
	peer.docs["doc-7"] = docEntry{version: 3, text: "Ada wrote the first program."}
	gone := verify(clientBg, citationOf(1, "doc-7"))
	ctx.Assert(gone != nil && gone.Status == "broken" && gone.Reason == "span_moved", "the quote is gone from version 3 and verify gave %+v, expected broken with reason span_moved", gone)
	ctx.Equal([]int{gone.Version, gone.Start, gone.End}, []int{1, 4, 12}, "a broken citation keeps the version and offsets it was recorded at; its version, start and end")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

#include "citation_store.grpc.pb.h"
#include "citations/store.h"

namespace {

struct DocEntry {
  long version = 0;
  std::string text;
  bool down = false;
};

// The current version of each document in docs; a down entry is a shard that does not answer, a missing id was deleted.
class DocPeer final : public citationstore::DocumentStore::Service {
 public:
  std::map<std::string, DocEntry> docs;
  grpc::Status GetCurrent(grpc::ServerContext*, const citationstore::DocumentRef* req, citationstore::DocumentVersion* out) override {
    const auto it = docs.find(req->document_id());
    if (it == docs.end()) return grpc::Status(grpc::StatusCode::NOT_FOUND, "document " + req->document_id() + " was deleted");
    if (it->second.down) return grpc::Status(grpc::StatusCode::UNAVAILABLE, "the shard holding the document is down");
    out->set_document_id(req->document_id());
    out->set_version(it->second.version);
    out->set_text(it->second.text);
    return grpc::Status::OK;
  }
};

DocPeer& docClient(harness::Ctx& ctx) {
  static DocPeer* peer = nullptr;
  delete peer;
  peer = new DocPeer;
  peer->docs["doc-7"] = DocEntry{1, "Ada Lovelace wrote the first program.", false};
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

store::Citation citationOf(int n, const std::string& document_id) {
  return store::Citation{"c-" + std::to_string(n), "t1", "a-1", document_id, 1, 4, 12, "Lovelace", "pending", ""};
}

size_t docCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("GetCurrent").size(); }

std::string show(const std::optional<store::Citation>& c) {
  return c ? store::toJson(*c).dump() : std::string("none");
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  docClient(ctx);
  auto result = verify(citationOf(1, "doc-7"));
  ctx.Assert(result && result->status == "verified", "with the document store healthy verify gave %s", show(result));
  for (const auto& call : ctx.GRPC.CallsTo("GetCurrent")) {
    ctx.Assert(call.HasDeadline(), "a GetCurrent call carries no deadline: a document store that stops answering holds the verifier forever");
    ctx.Assert(0.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 1.5, "a GetCurrent call carries a %v s deadline, expected kDeadline = 1 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("GetCurrent", 30.0);
  const int64_t before = ctx.Clock.Now();
  result = verify(citationOf(1, "doc-7"));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 4, "verify waited %.0f s for a document store that does not answer: each of the 3 attempts has a 1 s deadline", waited);
  ctx.Assert(result && result->status == "pending" && result->reason == "docstore_unavailable", "a document store that does not answer must leave the citation pending with reason docstore_unavailable, got %s", show(result));
}

void CheckNotFoundTerminal(harness::Ctx& ctx) {
  docClient(ctx);
  verify(citationOf(1, "doc-gone"));
  ctx.Equal(docCalls(ctx), 1, "a deleted document (NOT_FOUND) must be asked for once: NOT_FOUND is terminal, asking again cannot bring it back; the calls");
  ctx.GRPC.Fail("GetCurrent", grpc::StatusCode::UNAVAILABLE, "", 2);
  const auto result = verify(citationOf(1, "doc-7"));
  ctx.Equal(docCalls(ctx) - 1, 3, "two UNAVAILABLE answers then a healthy one must take 3 calls (UNAVAILABLE is retried up to kMaxAttempts); the calls");
  ctx.Assert(result && result->status == "verified", "the third attempt answered and verify gave %s", show(result));
  ctx.GRPC.Fail("GetCurrent", grpc::StatusCode::UNAVAILABLE, "", 10);
  verify(citationOf(1, "doc-7"));
  ctx.Equal(docCalls(ctx) - 4, 3, "a document store that stays UNAVAILABLE must be asked kMaxAttempts = 3 times for one citation; the calls");
}

void CheckBrokenKept(harness::Ctx& ctx) {
  DocPeer& peer = docClient(ctx);
  peer.docs["doc-9"] = DocEntry{0, "", true};
  const auto results = verifyBatch({citationOf(1, "doc-7"), citationOf(2, "doc-gone"), citationOf(3, "doc-9")});
  std::vector<std::string> ids;
  for (const auto& r : results) ids.push_back(r.id);
  ctx.Equal(ids, {"c-1", "c-2", "c-3"}, "verifyBatch of c-1, c-2, c-3: a citation that could not be checked is still one of the answer's citations and must come back saying why; the ids");
  ctx.Equal(results[0].status, "verified", "c-1 (doc-7, unchanged); its status");
  ctx.Assert(results[1].status == "broken" && results[1].reason == "document_gone", "c-2 cites a deleted document and came back %s, expected broken with reason document_gone", store::toJson(results[1]).dump());
  ctx.Assert(results[2].status == "pending" && results[2].reason == "docstore_unavailable", "c-3's document store shard is down and it came back %s, expected pending with reason docstore_unavailable", store::toJson(results[2]).dump());
}

void CheckReanchor(harness::Ctx& ctx) {
  DocPeer& peer = docClient(ctx);
  peer.docs["doc-7"] = DocEntry{2, "In 1843 Ada Lovelace wrote the first program.", false};
  const auto moved = verify(citationOf(1, "doc-7"));
  ctx.Assert(moved && moved->status == "verified", "Lovelace moved to offset 12 in version 2 and verify gave %s: search the current text for the quote", show(moved));
  ctx.Equal(std::vector<long>{moved->version, moved->start, moved->end}, std::vector<long>{2, 12, 20}, "the re-anchored citation's version, start and end");
  peer.docs["doc-7"] = DocEntry{3, "Ada wrote the first program.", false};
  const auto gone = verify(citationOf(1, "doc-7"));
  ctx.Assert(gone && gone->status == "broken" && gone->reason == "span_moved", "the quote is gone from version 3 and verify gave %s, expected broken with reason span_moved", show(gone));
  ctx.Equal(std::vector<long>{gone->version, gone->start, gone->end}, std::vector<long>{1, 4, 12}, "a broken citation keeps the version and offsets it was recorded at; its version, start and end");
}
`,
  },
  debrief: `The status code already says which failure this is; the fix is to stop throwing that away. \`NOT_FOUND\` describes the document, so asking again is pointless; \`UNAVAILABLE\` describes the call, so a bounded retry under a short deadline is the honest answer, and when it runs out the citation is pending, not broken, because nothing was learned about the span. Re-anchoring keeps a citation alive across edits that only move text, and the old offsets win when they still hold so a repeated quote does not jump. Production verifiers add jittered backoff between attempts, a circuit breaker per document store shard, and fuzzy re-anchoring (surrounding context, edit distance) for quotes that were lightly reworded.`,
};
