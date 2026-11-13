import type {Step} from '@/lib/types';

export const mergeClientStep: Step = {
  id: 'dependency',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  title: 'Three-way merges over gRPC that keep both edits when they fail',
  focus: ['sync', 'merger', 'redis'],
  task: `## Task

**Starting point.** The starter's \`resolve_conflict(doc_id, base_revision, body, device)\` runs for
each conflict a push answered: it reads the head and the body at \`base_revision\`, asks
\`Merger.ThreeWayMerge(doc_id, base_revision, base, local, remote)\` at \`merger:9000\`, applies the
merged body against the head's revision and answers \`{"status": "merged", "revision"}\`. On any
error it sleeps a second and asks again, five times, then applies the device's body. It merges the
demo edits and hides four flaws.

**Failure mode the checks target.** The merger hangs and the push behind it stays open. The merger
refuses two edits of the same line and is asked four more times. It restarts for a minute, and the
laptop's edit is written over the phone's while both users are told the document merged.

- Every call carries its own **2-second deadline** (\`MERGE_DEADLINE_S\`).
- At most **\`MAX_MERGE_ATTEMPTS\` (2)** calls, and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`
  are retried.
- Any other error, \`FAILED_PRECONDITION\` included, is final: no retry, no sleep.
- When the merge fails the head stays as it is: keep the device's edit with
  \`store.mark_conflicted(doc_id, device, base_revision, body)\` and answer
  \`{"status": "conflicted", "revision"}\` with the head's revision. A merged body whose apply is a
  \`conflict\` (the head moved while the merger ran) is a failed merge too.`,
  sequence: {
    participants: ['syncd', 'Redis', 'Merger'],
    messages: [
      {from: 'syncd', to: 'Redis', label: 'head(doc) · body_at(doc, base)', kind: 'sync'},
      {from: 'syncd', to: 'Merger', label: 'ThreeWayMerge(base, local, remote) · 2 s', kind: 'sync'},
      {from: 'Merger', to: 'syncd', label: 'body · UNAVAILABLE (retry once) · FAILED_PRECONDITION', kind: 'reply'},
      {from: 'syncd', to: 'Redis', label: 'apply_change(merged, head revision) → merged', kind: 'sync'},
      {from: 'syncd', to: 'Redis', label: 'failed: mark_conflicted(doc, device, base, body)', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every merge call carries a 2-second deadline',
      detail:
        'Each `ThreeWayMerge` call carries `MERGE_DEADLINE_S` (2 s) as its own deadline, the retry included, so a merger that hangs costs the push two seconds per attempt instead of holding it open.',
      match: {
        python: {all: [/timeout\s*=\s*MERGE_DEADLINE_S/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+\s*MERGE_DEADLINE_MS/]},
        go: {all: [/context\.WithTimeout\([^)]*mergeDeadline/]},
        scala: {all: [/withDeadlineAfter\(\s*MergeDeadlineMs/]},
        cpp: {all: [/set_deadline\([^;]*kMergeDeadline/]},
      },
    },
    {
      id: 'retry-transient',
      title: 'Retries UNAVAILABLE and DEADLINE_EXCEEDED, at most twice in all',
      detail:
        'A merger that did not answer is asked again, up to `MAX_MERGE_ATTEMPTS` (2) calls in all; one that stays down is given up on after the second.',
      match: {
        python: {all: [/MAX_MERGE_ATTEMPTS/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        typescript: {all: [/MAX_MERGE_ATTEMPTS/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        go: {all: [/maxMergeAttempts/, /codes\.Unavailable/, /codes\.DeadlineExceeded/]},
        scala: {all: [/MaxMergeAttempts/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        cpp: {all: [/kMaxMergeAttempts/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'rejection-terminal',
      title: 'A refused merge is final',
      detail:
        'The status code decides: `FAILED_PRECONDITION` (edits that overlap) and every code other than the two transient ones end the merge at once, with no sleep and no second call.',
      match: {
        python: {all: [/\.code\(\)/], none: [/time\.sleep\(/]},
        typescript: {all: [/ServiceError/], none: [/setTimeout\(/]},
        go: {all: [/status\.Code\(/], none: [/time\.Sleep\(/]},
        scala: {all: [/getStatus\.getCode/], none: [/Thread\.sleep\(/]},
        cpp: {all: [/error_code\(\)/], none: [/sleep_for\(/]},
      },
    },
    {
      id: 'keep-both',
      title: 'A failed merge keeps the head and the device’s edit',
      detail:
        'When the merge fails, or its merged body meets a head that moved meanwhile, the head is left as it is, the device’s edit is kept with `mark_conflicted`/`markConflicted` and the answer is `conflicted` at the head’s revision; nothing applies the device’s body over the head.',
      match: {
        python: {all: [/store\.mark_conflicted\(/], none: [/store\.content_hash\(body\)/]},
        typescript: {all: [/markConflicted\(/], none: [/contentHash\(body\)/]},
        go: {all: [/store\.MarkConflicted\(/], none: [/store\.ContentHash\(body\)/]},
        scala: {all: [/Store\.markConflicted\(/], none: [/Store\.contentHash\(body\)/]},
        cpp: {all: [/store::markConflicted\(/], none: [/store::contentHash\(body\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import sync_engine_pb2
import sync_engine_pb2_grpc
from docsync import store  # head, body_at, content_hash, mark_conflicted
from docsync.revisions import apply_change

merger = sync_engine_pb2_grpc.MergerStub(grpc.insecure_channel("merger:9000"))


def resolve_conflict(doc_id: str, base_revision: int, body: str, device: str) -> dict:
    """Merge the device's edit of base_revision into the head: {"status": "merged" | "conflicted", "revision"}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    head = store.head(doc_id)
    request = sync_engine_pb2.MergeRequest(
        doc_id=doc_id, base_revision=base_revision, base=store.body_at(doc_id, base_revision) or "", local=body, remote=head["body"]
    )
    for attempt in range(5):
        try:
            merged = merger.ThreeWayMerge(request)
            outcome = apply_change(doc_id, head["revision"], store.content_hash(merged.body), merged.body, device)
            return {"status": "merged", "revision": outcome["revision"]}
        except grpc.RpcError:
            time.sleep(1.0)  # the merger is busy: give it a moment
    # The merger is down: the device's edit is the newest, keep it.
    outcome = apply_change(doc_id, head["revision"], store.content_hash(body), body, device)
    return {"status": "merged", "revision": outcome["revision"]}
`,
      solution: `import grpc

import sync_engine_pb2
import sync_engine_pb2_grpc
from docsync import store  # head, body_at, content_hash, mark_conflicted
from docsync.revisions import apply_change

MERGE_DEADLINE_S = 2
MAX_MERGE_ATTEMPTS = 2
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

merger = sync_engine_pb2_grpc.MergerStub(grpc.insecure_channel("merger:9000"))


def resolve_conflict(doc_id: str, base_revision: int, body: str, device: str) -> dict:
    """Merge the device's edit of base_revision into the head: {"status": "merged" | "conflicted", "revision"}."""
    head = store.head(doc_id)
    request = sync_engine_pb2.MergeRequest(
        doc_id=doc_id, base_revision=base_revision, base=store.body_at(doc_id, base_revision) or "", local=body, remote=head["body"]
    )
    for attempt in range(1, MAX_MERGE_ATTEMPTS + 1):
        try:
            merged = merger.ThreeWayMerge(request, timeout=MERGE_DEADLINE_S)
            break
        except grpc.RpcError as exc:
            # Only a merger that did not answer may answer differently next time; a refusal is final.
            if exc.code() in RETRYABLE and attempt < MAX_MERGE_ATTEMPTS:
                continue
            store.mark_conflicted(doc_id, device, base_revision, body)
            return {"status": "conflicted", "revision": head["revision"]}
    outcome = apply_change(doc_id, head["revision"], store.content_hash(merged.body), merged.body, device)
    if outcome["status"] == "conflict":
        # The head moved while the merge ran: keep the edit rather than merge against a stale remote.
        store.mark_conflicted(doc_id, device, base_revision, body)
        return {"status": "conflicted", "revision": outcome["revision"]}
    return {"status": "merged", "revision": outcome["revision"]}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {applyChange} from 'docsync/revisions';
import {type Outcome, bodyAt, contentHash, head, markConflicted} from 'docsync/store';

interface MergeRequest {
  doc_id: string;
  base_revision: number;
  base: string;
  local: string;
  remote: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('sync_engine.proto')) as unknown as {
  syncd: {Merger: grpc.ServiceClientConstructor};
};
const merger = new pkg.syncd.Merger('merger:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ThreeWayMerge(request: MergeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{body: string}>;
};

/** Merge the device's edit of baseRevision into the head. */
export async function resolveConflict(docId: string, baseRevision: number, body: string, device: string): Promise<Outcome> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const current = await head(docId);
  if (current === null) throw new Error(\`no document \${docId}\`);
  const request = {doc_id: docId, base_revision: baseRevision, base: (await bodyAt(docId, baseRevision)) ?? '', local: body, remote: current.body};
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const merged = await merger.ThreeWayMerge(request, new grpc.Metadata(), {});
      const outcome = await applyChange(docId, current.revision, contentHash(merged.body), merged.body, device);
      return {status: 'merged', revision: outcome.revision};
    } catch {
      const {promise, resolve} = Promise.withResolvers<void>();
      setTimeout(resolve, 1000); // the merger is busy: give it a moment
      await promise;
    }
  }
  // The merger is down: the device's edit is the newest, keep it.
  const outcome = await applyChange(docId, current.revision, contentHash(body), body, device);
  return {status: 'merged', revision: outcome.revision};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {applyChange} from 'docsync/revisions';
import {type Outcome, bodyAt, contentHash, head, markConflicted} from 'docsync/store';

export const MERGE_DEADLINE_MS = 2000;
export const MAX_MERGE_ATTEMPTS = 2;
const RETRYABLE = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

interface MergeRequest {
  doc_id: string;
  base_revision: number;
  base: string;
  local: string;
  remote: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('sync_engine.proto')) as unknown as {
  syncd: {Merger: grpc.ServiceClientConstructor};
};
const merger = new pkg.syncd.Merger('merger:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ThreeWayMerge(request: MergeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{body: string}>;
};

/** Merge the device's edit of baseRevision into the head. */
export async function resolveConflict(docId: string, baseRevision: number, body: string, device: string): Promise<Outcome> {
  const current = await head(docId);
  if (current === null) throw new Error(\`no document \${docId}\`);
  const request = {doc_id: docId, base_revision: baseRevision, base: (await bodyAt(docId, baseRevision)) ?? '', local: body, remote: current.body};
  let merged = '';
  for (let attempt = 1; ; attempt++) {
    try {
      merged = (await merger.ThreeWayMerge(request, new grpc.Metadata(), {deadline: Date.now() + MERGE_DEADLINE_MS})).body;
      break;
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      // Only a merger that did not answer may answer differently next time; a refusal is final.
      if (RETRYABLE.has(code) && attempt < MAX_MERGE_ATTEMPTS) continue;
      await markConflicted(docId, device, baseRevision, body);
      return {status: 'conflicted', revision: current.revision};
    }
  }
  const outcome = await applyChange(docId, current.revision, contentHash(merged), merged, device);
  if (outcome.status === 'conflict') {
    // The head moved while the merge ran: keep the edit rather than merge against a stale remote.
    await markConflicted(docId, device, baseRevision, body);
    return {status: 'conflicted', revision: outcome.revision};
  }
  return {status: 'merged', revision: outcome.revision};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"docsync/revisions"        // revisions.ApplyChange
	"docsync/store"            // store.Head, BodyAt, ContentHash, MarkConflicted, Outcome
	pb "docsync/gen/sync_engine"
)

var (
	mergerConn, _ = grpc.NewClient("merger:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	merger        = pb.NewMergerClient(mergerConn)
)

// resolveConflict merges the device's edit of baseRevision into the head.
func resolveConflict(ctx context.Context, docID string, baseRevision int64, body, device string) (store.Outcome, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	head := store.Head(ctx, docID)
	if head == nil {
		return store.Outcome{}, fmt.Errorf("no document %s", docID)
	}
	base, _ := store.BodyAt(ctx, docID, baseRevision)
	request := &pb.MergeRequest{DocId: docID, BaseRevision: baseRevision, Base: base, Local: body, Remote: head.Body}
	for attempt := 0; attempt < 5; attempt++ {
		merged, err := merger.ThreeWayMerge(ctx, request)
		if err == nil {
			outcome, err := revisions.ApplyChange(ctx, docID, head.Revision, store.ContentHash(merged.GetBody()), merged.GetBody(), device)
			if err != nil {
				return store.Outcome{}, err
			}
			return store.Outcome{Status: "merged", Revision: outcome.Revision}, nil
		}
		time.Sleep(time.Second) // the merger is busy: give it a moment
	}
	// The merger is down: the device's edit is the newest, keep it.
	outcome, err := revisions.ApplyChange(ctx, docID, head.Revision, store.ContentHash(body), body, device)
	if err != nil {
		return store.Outcome{}, err
	}
	return store.Outcome{Status: "merged", Revision: outcome.Revision}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"docsync/revisions"        // revisions.ApplyChange
	"docsync/store"            // store.Head, BodyAt, ContentHash, MarkConflicted, Outcome
	pb "docsync/gen/sync_engine"
)

const (
	mergeDeadline    = 2 * time.Second
	maxMergeAttempts = 2
)

var (
	mergerConn, _ = grpc.NewClient("merger:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	merger        = pb.NewMergerClient(mergerConn)
)

// resolveConflict merges the device's edit of baseRevision into the head.
func resolveConflict(ctx context.Context, docID string, baseRevision int64, body, device string) (store.Outcome, error) {
	head := store.Head(ctx, docID)
	if head == nil {
		return store.Outcome{}, fmt.Errorf("no document %s", docID)
	}
	base, _ := store.BodyAt(ctx, docID, baseRevision)
	request := &pb.MergeRequest{DocId: docID, BaseRevision: baseRevision, Base: base, Local: body, Remote: head.Body}
	var merged string
	for attempt := 1; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, mergeDeadline)
		result, err := merger.ThreeWayMerge(callCtx, request)
		cancel()
		if err == nil {
			merged = result.GetBody()
			break
		}
		// Only a merger that did not answer may answer differently next time; a refusal is final.
		code := status.Code(err)
		if (code == codes.Unavailable || code == codes.DeadlineExceeded) && attempt < maxMergeAttempts {
			continue
		}
		store.MarkConflicted(ctx, docID, device, baseRevision, body)
		return store.Outcome{Status: "conflicted", Revision: head.Revision}, nil
	}
	outcome, err := revisions.ApplyChange(ctx, docID, head.Revision, store.ContentHash(merged), merged, device)
	if err != nil {
		return store.Outcome{}, err
	}
	if outcome.Status == "conflict" {
		// The head moved while the merge ran: keep the edit rather than merge against a stale remote.
		store.MarkConflicted(ctx, docID, device, baseRevision, body)
		return store.Outcome{Status: "conflicted", Revision: outcome.Revision}, nil
	}
	return store.Outcome{Status: "merged", Revision: outcome.Revision}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import docsync.{Revisions, Store} // Store.head, bodyAt, contentHash, markConflicted, Outcome; Revisions.applyChange
import syncd.sync_engine.{MergeRequest, MergerGrpc}

object Client {
  private val merger = MergerGrpc.blockingStub(ManagedChannelBuilder.forAddress("merger", 9000).usePlaintext().build())

  /** Merge the device's edit of baseRevision into the head. */
  def resolveConflict(docId: String, baseRevision: Long, body: String, device: String): Store.Outcome = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val head = Store.head(docId).getOrElse(throw new NoSuchElementException(s"no document $docId"))
    val request = MergeRequest(docId = docId, baseRevision = baseRevision, base = Store.bodyAt(docId, baseRevision).getOrElse(""), local = body, remote = head.body)
    var attempt = 0
    var outcome: Option[Store.Outcome] = None
    while (attempt < 5 && outcome.isEmpty) {
      try {
        val merged = merger.threeWayMerge(request).body
        outcome = Some(Store.Outcome("merged", Revisions.applyChange(docId, head.revision, Store.contentHash(merged), merged, device).revision))
      } catch {
        case _: StatusRuntimeException =>
          Thread.sleep(1000) // the merger is busy: give it a moment
          attempt += 1
      }
    }
    outcome.getOrElse {
      // The merger is down: the device's edit is the newest, keep it.
      Store.Outcome("merged", Revisions.applyChange(docId, head.revision, Store.contentHash(body), body, device).revision)
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import docsync.{Revisions, Store} // Store.head, bodyAt, contentHash, markConflicted, Outcome; Revisions.applyChange
import syncd.sync_engine.{MergeRequest, MergerGrpc}

object Client {
  val MergeDeadlineMs = 2000L
  val MaxMergeAttempts = 2
  private val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val merger = MergerGrpc.blockingStub(ManagedChannelBuilder.forAddress("merger", 9000).usePlaintext().build())

  /** Merge the device's edit of baseRevision into the head. */
  def resolveConflict(docId: String, baseRevision: Long, body: String, device: String): Store.Outcome = {
    val head = Store.head(docId).getOrElse(throw new NoSuchElementException(s"no document $docId"))
    val request = MergeRequest(docId = docId, baseRevision = baseRevision, base = Store.bodyAt(docId, baseRevision).getOrElse(""), local = body, remote = head.body)
    def attempt(n: Int): Option[String] =
      try Some(merger.withDeadlineAfter(MergeDeadlineMs, TimeUnit.MILLISECONDS).threeWayMerge(request).body)
      catch {
        // Only a merger that did not answer may answer differently next time; a refusal is final.
        case e: StatusRuntimeException if Retryable(e.getStatus.getCode) && n < MaxMergeAttempts => attempt(n + 1)
        case _: StatusRuntimeException => None
      }
    attempt(1) match {
      case None =>
        Store.markConflicted(docId, device, baseRevision, body)
        Store.Outcome("conflicted", head.revision)
      case Some(merged) =>
        val outcome = Revisions.applyChange(docId, head.revision, Store.contentHash(merged), merged, device)
        if (outcome.status == "conflict") {
          // The head moved while the merge ran: keep the edit rather than merge against a stale remote.
          Store.markConflicted(docId, device, baseRevision, body)
          Store.Outcome("conflicted", outcome.revision)
        } else Store.Outcome("merged", outcome.revision)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

#include "docsync/revisions.h"  // revisions::applyChange
#include "docsync/store.h"      // store::head, bodyAt, contentHash, markConflicted, Outcome
#include "sync_engine.grpc.pb.h"

auto merger = syncd::Merger::NewStub(grpc::CreateChannel("merger:9000", grpc::InsecureChannelCredentials()));

// Merge the device's edit of base_revision into the head.
store::Outcome resolveConflict(const std::string& doc_id, long long base_revision, const std::string& body, const std::string& device) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto head = store::head(doc_id);
  if (!head) throw std::runtime_error("no document " + doc_id);
  syncd::MergeRequest request;
  request.set_doc_id(doc_id);
  request.set_base_revision(base_revision);
  request.set_base(store::bodyAt(doc_id, base_revision).value_or(""));
  request.set_local(body);
  request.set_remote(head->body);
  for (int attempt = 0; attempt < 5; attempt++) {
    grpc::ClientContext ctx;
    syncd::MergeResult merged;
    if (merger->ThreeWayMerge(&ctx, request, &merged).ok()) {
      const store::Outcome outcome = revisions::applyChange(doc_id, head->revision, store::contentHash(merged.body()), merged.body(), device);
      return store::Outcome{"merged", outcome.revision};
    }
    std::this_thread::sleep_for(std::chrono::seconds{1});  // the merger is busy: give it a moment
  }
  // The merger is down: the device's edit is the newest, keep it.
  const store::Outcome outcome = revisions::applyChange(doc_id, head->revision, store::contentHash(body), body, device);
  return store::Outcome{"merged", outcome.revision};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "docsync/revisions.h"  // revisions::applyChange
#include "docsync/store.h"      // store::head, bodyAt, contentHash, markConflicted, Outcome
#include "sync_engine.grpc.pb.h"

constexpr auto kMergeDeadline = std::chrono::seconds{2};
constexpr int kMaxMergeAttempts = 2;

auto merger = syncd::Merger::NewStub(grpc::CreateChannel("merger:9000", grpc::InsecureChannelCredentials()));

// Merge the device's edit of base_revision into the head.
store::Outcome resolveConflict(const std::string& doc_id, long long base_revision, const std::string& body, const std::string& device) {
  const auto head = store::head(doc_id);
  if (!head) throw std::runtime_error("no document " + doc_id);
  syncd::MergeRequest request;
  request.set_doc_id(doc_id);
  request.set_base_revision(base_revision);
  request.set_base(store::bodyAt(doc_id, base_revision).value_or(""));
  request.set_local(body);
  request.set_remote(head->body);
  syncd::MergeResult merged;
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kMergeDeadline);
    const grpc::Status status = merger->ThreeWayMerge(&ctx, request, &merged);
    if (status.ok()) break;
    // Only a merger that did not answer may answer differently next time; a refusal is final.
    const bool retryable = status.error_code() == grpc::StatusCode::UNAVAILABLE || status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
    if (retryable && attempt < kMaxMergeAttempts) continue;
    store::markConflicted(doc_id, device, base_revision, body);
    return store::Outcome{"conflicted", head->revision};
  }
  const store::Outcome outcome = revisions::applyChange(doc_id, head->revision, store::contentHash(merged.body()), merged.body(), device);
  if (outcome.status == "conflict") {
    // The head moved while the merge ran: keep the edit rather than merge against a stale remote.
    store::markConflicted(doc_id, device, base_revision, body);
    return store::Outcome{"conflicted", outcome.revision};
  }
  return store::Outcome{"merged", outcome.revision};
}
`,
    },
  },
  harness: {
    python: `import grpc

import sync_engine_pb2
import sync_engine_pb2_grpc
from docsync import store
from docsync.revisions import apply_change

BASE = "milk\\neggs\\nbread"
PHONE = "milk\\neggs\\nsourdough"  # the phone's edit of line 3, now the head
LAPTOP = "oat milk\\neggs\\nbread"  # the laptop's edit of line 1, made offline against BASE
MERGED = "oat milk\\neggs\\nsourdough"
OVERLAP = "milk\\neggs\\nrye"  # the laptop's edit of line 3 too
LATER = "milk\\neggs\\nsourdough loaf"  # the phone's next edit, landing while the laptop's edit is merged


class Merger(sync_engine_pb2_grpc.MergerServicer):
    """A line-by-line three-way merge: edits of different lines combine, two edits of one line are FAILED_PRECONDITION."""

    def ThreeWayMerge(self, request, context):
        base, local, remote = request.base.split("\\n"), request.local.split("\\n"), request.remote.split("\\n")
        if not len(base) == len(local) == len(remote):
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, "the edits change the number of lines")
        merged = []
        for number, (b, l, r) in enumerate(zip(base, local, remote), 1):
            if l != b and r != b and l != r:
                context.abort(grpc.StatusCode.FAILED_PRECONDITION, f"line {number} was edited on both sides")
            merged.append(l if l != b else r)
        return sync_engine_pb2.MergeResult(body="\\n".join(merged))


def _client(ctx):
    ctx.grpc.serve(sync_engine_pb2_grpc.add_MergerServicer_to_server, Merger())
    return ctx.load("client")


def _seed(doc_id):
    """BASE as the laptop last pulled it, then the phone's edit of it as the head: (base revision, head revision)."""
    base = apply_change(doc_id, 0, store.content_hash(BASE), BASE, "laptop")["revision"]
    head = apply_change(doc_id, base, store.content_hash(PHONE), PHONE, "phone")["revision"]
    return base, head


def _calls(ctx):
    return len(ctx.grpc.calls_to("ThreeWayMerge"))


def check_deadline(ctx):
    m = _client(ctx)
    base, _ = _seed("d-1")
    out = m.resolve_conflict("d-1", base, LAPTOP, "laptop")
    assert out.get("status") == "merged", f"with a healthy merger the edits of lines 1 and 3 must merge, got {out}"
    for call in ctx.grpc.calls_to("ThreeWayMerge"):
        assert call.timeout is not None, "a ThreeWayMerge call carries no deadline: a merger that hangs holds the push open"
        assert 1.5 <= call.timeout <= 2.5, f"a ThreeWayMerge call carries a {call.timeout} s deadline, expected MERGE_DEADLINE_S = 2"
    base, head = _seed("d-2")
    ctx.grpc.set_latency("ThreeWayMerge", 10.0)
    before, start = ctx.clock.time(), _calls(ctx)
    out = m.resolve_conflict("d-2", base, LAPTOP, "laptop")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"resolve_conflict waited {waited:.0f} s for a merger that answers in 10 s: two attempts of 2 s each, then give up"
    assert out == {"status": "conflicted", "revision": head}, f"a merger that never answered in time must leave the document conflicted at its head revision {head}, got {out}"
    slow = ctx.grpc.calls_to("ThreeWayMerge")[start:]
    assert len(slow) == 2, f"a merger that answers in 10 s was asked {len(slow)} times for one conflict, expected MAX_MERGE_ATTEMPTS (2) attempts"
    timeouts = [call.timeout for call in slow]
    assert all(t is not None and 1.5 <= t <= 2.5 for t in timeouts), f"the two attempts carried deadlines of {timeouts} s: each attempt gets its own MERGE_DEADLINE_S, and a deadline shared by both leaves the retry no time"


def check_retry_transient(ctx):
    m = _client(ctx)
    base, _ = _seed("d-1")
    ctx.grpc.fail("ThreeWayMerge", grpc.StatusCode.UNAVAILABLE, "merger restarting", times=1)
    out = m.resolve_conflict("d-1", base, LAPTOP, "laptop")
    assert _calls(ctx) == 2, f"one UNAVAILABLE, then a healthy merger: expected 2 calls, got {_calls(ctx)}"
    assert out.get("status") == "merged" and store.head("d-1")["body"] == MERGED, f"the second attempt must merge, got {out} and a head of {store.head('d-1')['body']!r}"
    base, head = _seed("d-2")
    ctx.grpc.fail("ThreeWayMerge", grpc.StatusCode.UNAVAILABLE, "merger down", times=10)
    before = _calls(ctx)
    out = m.resolve_conflict("d-2", base, LAPTOP, "laptop")
    asked = _calls(ctx) - before
    assert asked == 2, f"a merger that stays UNAVAILABLE was asked {asked} times for one conflict: at most MAX_MERGE_ATTEMPTS (2)"
    assert out == {"status": "conflicted", "revision": head}, f"after the last attempt the document must be conflicted at its head revision {head}, got {out}"


def check_rejection_terminal(ctx):
    m = _client(ctx)
    base, head = _seed("d-1")
    out = m.resolve_conflict("d-1", base, OVERLAP, "laptop")
    assert _calls(ctx) == 1, f"the merger refused two edits of line 3 (FAILED_PRECONDITION) and was asked {_calls(ctx)} times: a refusal is final"
    assert ctx.clock.sleeps == 0, "a refused merge must not be slept on and asked again"
    assert out == {"status": "conflicted", "revision": head}, f"a refused merge must leave the document conflicted at its head revision {head}, got {out}"
    base, head = _seed("d-2")
    ctx.grpc.fail("ThreeWayMerge", grpc.StatusCode.INVALID_ARGUMENT, "the request is malformed", times=1)
    before = _calls(ctx)
    out = m.resolve_conflict("d-2", base, LAPTOP, "laptop")
    asked = _calls(ctx) - before
    assert asked == 1, f"the merger answered INVALID_ARGUMENT and was asked {asked} times: only UNAVAILABLE and DEADLINE_EXCEEDED are asked again"
    assert out == {"status": "conflicted", "revision": head}, f"a merge that failed with INVALID_ARGUMENT must leave the document conflicted at its head revision {head}, got {out}"
    assert ctx.clock.sleeps == 0, "a failed merge that is not retried must not be slept on"


def check_keep_both(ctx):
    m = _client(ctx)
    base, head = _seed("d-1")
    out = m.resolve_conflict("d-1", base, OVERLAP, "laptop")
    now = store.head("d-1")
    assert now["body"] == PHONE and now["revision"] == head, f"a failed merge replaced the phone's edit: the head reads {now['body']!r} at revision {now['revision']}. Leave the head as it is"
    kept = store.conflict_of("d-1")
    assert kept is not None and kept.get("body") == OVERLAP and kept.get("base_revision") == base and kept.get("device") == "laptop", f"the laptop's edit must be kept for the user with mark_conflicted (its body, base revision {base} and device), the store holds {kept}"
    assert out.get("status") == "conflicted", f"the answer must say conflicted, got {out}"
    # The phone edits d-2 again while the laptop's edit of it is being merged.
    base, head = _seed("d-2")
    rival = ctx.redis_after("doc:d-2", lambda: apply_change("d-2", head, store.content_hash(LATER), LATER, "phone"))
    out = m.resolve_conflict("d-2", base, LAPTOP, "laptop")
    assert rival.fired, "resolve_conflict never read d-2's head"
    if rival.error is not None:
        raise rival.error
    moved = rival.result["revision"]
    now = store.head("d-2")
    assert now["body"] == LATER and now["revision"] == moved, f"the phone's edit that landed during the merge was replaced: the head reads {now['body']!r} at revision {now['revision']}"
    assert out == {"status": "conflicted", "revision": moved}, f"the head moved to revision {moved} while the merge ran, so the merged body was not applied: answer conflicted at revision {moved}, got {out}"
    kept = store.conflict_of("d-2")
    assert kept is not None and kept.get("body") == LAPTOP and kept.get("base_revision") == base and kept.get("device") == "laptop", f"the merged body did not apply, so the laptop's edit must be kept with mark_conflicted (its body, base revision {base} and device), the store holds {kept}"
`,
    typescript: `const BASE = 'milk\\neggs\\nbread';
const PHONE = 'milk\\neggs\\nsourdough'; // the phone's edit of line 3, now the head
const LAPTOP = 'oat milk\\neggs\\nbread'; // the laptop's edit of line 1, made offline against BASE
const MERGED = 'oat milk\\neggs\\nsourdough';
const OVERLAP = 'milk\\neggs\\nrye'; // the laptop's edit of line 3 too
const LATER = 'milk\\neggs\\nsourdough loaf'; // the phone's next edit, landing while the laptop's edit is merged

/** A line-by-line three-way merge: edits of different lines combine, two edits of one line are FAILED_PRECONDITION. */
function client(ctx) {
  const pkg = ctx.proto('sync_engine.proto');
  ctx.grpc.serve(pkg.syncd.Merger.service, {
    ThreeWayMerge(call, callback) {
      const [base, local, remote] = [call.request.base, call.request.local, call.request.remote].map(s => s.split('\\n'));
      if (base.length !== local.length || base.length !== remote.length) {
        return callback({code: ctx.grpc.status.FAILED_PRECONDITION, details: 'the edits change the number of lines'});
      }
      const merged: string[] = [];
      for (let i = 0; i < base.length; i++) {
        if (local[i] !== base[i] && remote[i] !== base[i] && local[i] !== remote[i]) {
          return callback({code: ctx.grpc.status.FAILED_PRECONDITION, details: \`line \${i + 1} was edited on both sides\`});
        }
        merged.push(local[i] !== base[i] ? local[i] : remote[i]);
      }
      callback(null, {body: merged.join('\\n')});
    },
  });
  return {m: ctx.load('client'), store: ctx.load('/support/docsync/store.ts'), revisions: ctx.load('/support/docsync/revisions.ts')};
}

/** BASE as the laptop last pulled it, then the phone's edit of it as the head: [base revision, head revision]. */
async function seed(store, revisions, docId: string): Promise<[number, number]> {
  const base = (await revisions.applyChange(docId, 0, store.contentHash(BASE), BASE, 'laptop')).revision;
  const head = (await revisions.applyChange(docId, base, store.contentHash(PHONE), PHONE, 'phone')).revision;
  return [base, head];
}

const calls = ctx => ctx.grpc.callsTo('ThreeWayMerge').length;

export async function check_deadline(ctx) {
  const {m, store, revisions} = client(ctx);
  let [base, head] = await seed(store, revisions, 'd-1');
  let out = await m.resolveConflict('d-1', base, LAPTOP, 'laptop');
  assert.equal(out.status, 'merged', \`with a healthy merger the edits of lines 1 and 3 must merge, got \${JSON.stringify(out)}\`);
  for (const call of ctx.grpc.callsTo('ThreeWayMerge')) {
    assert(call.timeout !== null, 'a ThreeWayMerge call carries no deadline: a merger that hangs holds the push open');
    assert(1.5 <= call.timeout && call.timeout <= 2.5, \`a ThreeWayMerge call carries a \${call.timeout} s deadline, expected MERGE_DEADLINE_MS = 2000\`);
  }
  [base, head] = await seed(store, revisions, 'd-2');
  ctx.grpc.setLatency('ThreeWayMerge', 10.0);
  const before = ctx.clock.now();
  const start = calls(ctx);
  out = await m.resolveConflict('d-2', base, LAPTOP, 'laptop');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`resolveConflict waited \${waited.toFixed(0)} s for a merger that answers in 10 s: two attempts of 2 s each, then give up\`);
  assert.deepStrictEqual(out, {status: 'conflicted', revision: head}, \`a merger that never answered in time must leave the document conflicted at its head revision \${head}, got \${JSON.stringify(out)}\`);
  const slow = ctx.grpc.callsTo('ThreeWayMerge').slice(start);
  assert.equal(slow.length, 2, \`a merger that answers in 10 s was asked \${slow.length} times for one conflict, expected MAX_MERGE_ATTEMPTS (2) attempts\`);
  const timeouts = slow.map(call => call.timeout);
  assert(timeouts.every(t => t !== null && 1.5 <= t && t <= 2.5), \`the two attempts carried deadlines of \${JSON.stringify(timeouts)} s: each attempt gets its own MERGE_DEADLINE_MS, and a deadline shared by both leaves the retry no time\`);
}

export async function check_retry_transient(ctx) {
  const {m, store, revisions} = client(ctx);
  let [base, head] = await seed(store, revisions, 'd-1');
  ctx.grpc.fail('ThreeWayMerge', ctx.grpc.status.UNAVAILABLE, 'merger restarting', 1);
  let out = await m.resolveConflict('d-1', base, LAPTOP, 'laptop');
  assert.equal(calls(ctx), 2, \`one UNAVAILABLE, then a healthy merger: expected 2 calls, got \${calls(ctx)}\`);
  const merged = await store.head('d-1');
  assert(out.status === 'merged' && merged.body === MERGED, \`the second attempt must merge, got \${JSON.stringify(out)} and a head of \${JSON.stringify(merged.body)}\`);
  [base, head] = await seed(store, revisions, 'd-2');
  ctx.grpc.fail('ThreeWayMerge', ctx.grpc.status.UNAVAILABLE, 'merger down', 10);
  const before = calls(ctx);
  out = await m.resolveConflict('d-2', base, LAPTOP, 'laptop');
  const asked = calls(ctx) - before;
  assert.equal(asked, 2, \`a merger that stays UNAVAILABLE was asked \${asked} times for one conflict: at most MAX_MERGE_ATTEMPTS (2)\`);
  assert.deepStrictEqual(out, {status: 'conflicted', revision: head}, \`after the last attempt the document must be conflicted at its head revision \${head}, got \${JSON.stringify(out)}\`);
}

export async function check_rejection_terminal(ctx) {
  const {m, store, revisions} = client(ctx);
  const [base, head] = await seed(store, revisions, 'd-1');
  const out = await m.resolveConflict('d-1', base, OVERLAP, 'laptop');
  assert.equal(calls(ctx), 1, \`the merger refused two edits of line 3 (FAILED_PRECONDITION) and was asked \${calls(ctx)} times: a refusal is final\`);
  assert.equal(ctx.clock.sleeps, 0, 'a refused merge must not be slept on and asked again');
  assert.deepStrictEqual(out, {status: 'conflicted', revision: head}, \`a refused merge must leave the document conflicted at its head revision \${head}, got \${JSON.stringify(out)}\`);
  const [base2, head2] = await seed(store, revisions, 'd-2');
  ctx.grpc.fail('ThreeWayMerge', ctx.grpc.status.INVALID_ARGUMENT, 'the request is malformed', 1);
  const before = calls(ctx);
  const out2 = await m.resolveConflict('d-2', base2, LAPTOP, 'laptop');
  const asked = calls(ctx) - before;
  assert.equal(asked, 1, \`the merger answered INVALID_ARGUMENT and was asked \${asked} times: only UNAVAILABLE and DEADLINE_EXCEEDED are asked again\`);
  assert.deepStrictEqual(out2, {status: 'conflicted', revision: head2}, \`a merge that failed with INVALID_ARGUMENT must leave the document conflicted at its head revision \${head2}, got \${JSON.stringify(out2)}\`);
  assert.equal(ctx.clock.sleeps, 0, 'a failed merge that is not retried must not be slept on');
}

export async function check_keep_both(ctx) {
  const {m, store, revisions} = client(ctx);
  const [base, head] = await seed(store, revisions, 'd-1');
  const out = await m.resolveConflict('d-1', base, OVERLAP, 'laptop');
  const now = await store.head('d-1');
  assert(now.body === PHONE && now.revision === head, \`a failed merge replaced the phone's edit: the head reads \${JSON.stringify(now.body)} at revision \${now.revision}. Leave the head as it is\`);
  const kept = await store.conflictOf('d-1');
  assert(kept !== null && kept.body === OVERLAP && kept.base_revision === base && kept.device === 'laptop', \`the laptop's edit must be kept for the user with markConflicted (its body, base revision \${base} and device), the store holds \${JSON.stringify(kept)}\`);
  assert.equal(out.status, 'conflicted', \`the answer must say conflicted, got \${JSON.stringify(out)}\`);
  // The phone edits d-2 again while the laptop's edit of it is being merged.
  const [base2, head2] = await seed(store, revisions, 'd-2');
  const rival = ctx.redisAfter('doc:d-2', () => revisions.applyChange('d-2', head2, store.contentHash(LATER), LATER, 'phone'));
  const out2 = await m.resolveConflict('d-2', base2, LAPTOP, 'laptop');
  assert(rival.fired, "resolveConflict never read d-2's head");
  if (rival.error !== undefined) throw rival.error;
  const moved = (await rival.result).revision;
  const now2 = await store.head('d-2');
  assert(now2.body === LATER && now2.revision === moved, \`the phone's edit that landed during the merge was replaced: the head reads \${JSON.stringify(now2.body)} at revision \${now2.revision}\`);
  assert.deepStrictEqual(out2, {status: 'conflicted', revision: moved}, \`the head moved to revision \${moved} while the merge ran, so the merged body was not applied: answer conflicted at revision \${moved}, got \${JSON.stringify(out2)}\`);
  const kept2 = await store.conflictOf('d-2');
  assert(kept2 !== null && kept2.body === LAPTOP && kept2.base_revision === base2 && kept2.device === 'laptop', \`the merged body did not apply, so the laptop's edit must be kept with markConflicted (its body, base revision \${base2} and device), the store holds \${JSON.stringify(kept2)}\`);
}
`,
    go: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"docsync/revisions"
	"docsync/store"
	pb "docsync/gen/sync_engine"

	"leetbuild/harness"
)

const (
	clientBase    = "milk\\neggs\\nbread"
	clientPhone   = "milk\\neggs\\nsourdough" // the phone's edit of line 3, now the head
	clientLaptop  = "oat milk\\neggs\\nbread" // the laptop's edit of line 1, made offline against the base
	clientMerged  = "oat milk\\neggs\\nsourdough"
	clientOverlap = "milk\\neggs\\nrye" // the laptop's edit of line 3 too
	clientLater   = "milk\\neggs\\nsourdough loaf" // the phone's next edit, landing while the laptop's edit is merged
)

var clientBg = context.Background()

// mergerPeer is a line-by-line three-way merge: edits of different lines combine, two edits of one line are FailedPrecondition.
type mergerPeer struct {
	pb.UnimplementedMergerServer
}

func (mergerPeer) ThreeWayMerge(_ context.Context, req *pb.MergeRequest) (*pb.MergeResult, error) {
	base, local, remote := strings.Split(req.GetBase(), "\\n"), strings.Split(req.GetLocal(), "\\n"), strings.Split(req.GetRemote(), "\\n")
	if len(base) != len(local) || len(base) != len(remote) {
		return nil, status.Error(codes.FailedPrecondition, "the edits change the number of lines")
	}
	merged := make([]string, len(base))
	for i := range base {
		if local[i] != base[i] && remote[i] != base[i] && local[i] != remote[i] {
			return nil, status.Errorf(codes.FailedPrecondition, "line %d was edited on both sides", i+1)
		}
		merged[i] = remote[i]
		if local[i] != base[i] {
			merged[i] = local[i]
		}
	}
	return &pb.MergeResult{Body: strings.Join(merged, "\\n")}, nil
}

func clientServe(ctx *harness.Ctx) {
	pb.RegisterMergerServer(ctx.GRPC.Server(""), mergerPeer{})
}

// clientSeed writes the base as the laptop last pulled it, then the phone's edit of it as the head.
func clientSeed(ctx *harness.Ctx, docID string) (base, head int64) {
	b, err := revisions.ApplyChange(clientBg, docID, 0, store.ContentHash(clientBase), clientBase, "laptop")
	ctx.NoError(err, "seeding %s", docID)
	h, err := revisions.ApplyChange(clientBg, docID, b.Revision, store.ContentHash(clientPhone), clientPhone, "phone")
	ctx.NoError(err, "seeding %s", docID)
	return b.Revision, h.Revision
}

func clientResolve(ctx *harness.Ctx, docID string, base int64, body string) store.Outcome {
	out, err := resolveConflict(clientBg, docID, base, body, "laptop")
	ctx.NoError(err, "resolveConflict(%s) failed", docID)
	return out
}

func clientCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("ThreeWayMerge", "")) }

func CheckDeadline(ctx *harness.Ctx) {
	clientServe(ctx)
	base, _ := clientSeed(ctx, "d-1")
	out := clientResolve(ctx, "d-1", base, clientLaptop)
	ctx.Equal(out.Status, "merged", "with a healthy merger the edits of lines 1 and 3 must merge; the status")
	for _, call := range ctx.GRPC.CallsTo("ThreeWayMerge", "") {
		ctx.Assert(call.HasDeadline(), "a ThreeWayMerge call carries no deadline: a merger that hangs holds the push open")
		ctx.Assert(1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "a ThreeWayMerge call carries a %v deadline, expected mergeDeadline = 2 s", call.Timeout)
	}
	base, head := clientSeed(ctx, "d-2")
	ctx.GRPC.SetLatency("ThreeWayMerge", 10.0, "")
	before, start := ctx.Clock.Now(), clientCalls(ctx)
	out = clientResolve(ctx, "d-2", base, clientLaptop)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "resolveConflict waited %.0f s for a merger that answers in 10 s: two attempts of 2 s each, then give up", waited)
	ctx.Equal(out, store.Outcome{Status: "conflicted", Revision: head}, "a merger that never answered in time must leave the document conflicted at its head revision")
	slow := ctx.GRPC.CallsTo("ThreeWayMerge", "")[start:]
	ctx.Equal(len(slow), 2, "a merger that answers in 10 s must be asked maxMergeAttempts (2) times for one conflict; the calls")
	for _, call := range slow {
		ctx.Assert(call.HasDeadline() && 1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond,
			"an attempt carried a %v deadline: each attempt gets its own mergeDeadline (2 s), and a deadline shared by both leaves the retry no time", call.Timeout)
	}
}

func CheckRetryTransient(ctx *harness.Ctx) {
	clientServe(ctx)
	base, _ := clientSeed(ctx, "d-1")
	ctx.GRPC.Fail("ThreeWayMerge", codes.Unavailable, "merger restarting", 1, "")
	out := clientResolve(ctx, "d-1", base, clientLaptop)
	ctx.Equal(clientCalls(ctx), 2, "one Unavailable, then a healthy merger; the calls")
	ctx.Assert(out.Status == "merged" && store.Head(clientBg, "d-1").Body == clientMerged, "the second attempt must merge, got %+v and a head of %q", out, store.Head(clientBg, "d-1").Body)
	base, head := clientSeed(ctx, "d-2")
	ctx.GRPC.Fail("ThreeWayMerge", codes.Unavailable, "merger down", 10, "")
	before := clientCalls(ctx)
	out = clientResolve(ctx, "d-2", base, clientLaptop)
	ctx.Equal(clientCalls(ctx)-before, 2, "a merger that stays Unavailable must be asked at most maxMergeAttempts (2) times for one conflict; the calls")
	ctx.Equal(out, store.Outcome{Status: "conflicted", Revision: head}, "after the last attempt the document must be conflicted at its head revision")
}

func CheckRejectionTerminal(ctx *harness.Ctx) {
	clientServe(ctx)
	base, head := clientSeed(ctx, "d-1")
	out := clientResolve(ctx, "d-1", base, clientOverlap)
	ctx.Equal(clientCalls(ctx), 1, "the merger refused two edits of line 3 (FailedPrecondition): a refusal is final; the calls")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a refused merge must not be slept on and asked again; the sleeps")
	ctx.Equal(out, store.Outcome{Status: "conflicted", Revision: head}, "a refused merge must leave the document conflicted at its head revision")
	base, head = clientSeed(ctx, "d-2")
	ctx.GRPC.Fail("ThreeWayMerge", codes.InvalidArgument, "the request is malformed", 1, "")
	before := clientCalls(ctx)
	out = clientResolve(ctx, "d-2", base, clientLaptop)
	ctx.Equal(clientCalls(ctx)-before, 1, "the merger answered InvalidArgument: only Unavailable and DeadlineExceeded are asked again; the calls")
	ctx.Equal(out, store.Outcome{Status: "conflicted", Revision: head}, "a merge that failed with InvalidArgument must leave the document conflicted at its head revision")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a failed merge that is not retried must not be slept on; the sleeps")
}

func CheckKeepBoth(ctx *harness.Ctx) {
	clientServe(ctx)
	base, head := clientSeed(ctx, "d-1")
	out := clientResolve(ctx, "d-1", base, clientOverlap)
	now := store.Head(clientBg, "d-1")
	ctx.Assert(now.Body == clientPhone && now.Revision == head, "a failed merge replaced the phone's edit: the head reads %q at revision %d. Leave the head as it is", now.Body, now.Revision)
	kept := store.ConflictOf(clientBg, "d-1")
	ctx.Assert(kept != nil && kept.Body == clientOverlap && kept.BaseRevision == base && kept.Device == "laptop", "the laptop's edit must be kept for the user with MarkConflicted (its body, base revision %d and device), the store holds %+v", base, kept)
	ctx.Equal(out.Status, "conflicted", "the answer's status")
	// The phone edits d-2 again while the laptop's edit of it is being merged.
	base2, head2 := clientSeed(ctx, "d-2")
	rival := ctx.Redis.After("doc:d-2", func() any {
		outcome, err := revisions.ApplyChange(clientBg, "d-2", head2, store.ContentHash(clientLater), clientLater, "phone")
		if err != nil {
			panic(err)
		}
		return outcome
	})
	out = clientResolve(ctx, "d-2", base2, clientLaptop)
	ctx.Assert(rival.Fired, "resolveConflict never read d-2's head")
	ctx.Assert(rival.Err == nil, "the phone's apply failed: %v", rival.Err)
	moved := rival.Result.(store.Outcome).Revision
	now2 := store.Head(clientBg, "d-2")
	ctx.Assert(now2.Body == clientLater && now2.Revision == moved, "the phone's edit that landed during the merge was replaced: the head reads %q at revision %d", now2.Body, now2.Revision)
	ctx.Equal(out, store.Outcome{Status: "conflicted", Revision: moved}, "the head moved while the merge ran, so the merged body was not applied: the answer must be conflicted at the new head revision")
	kept2 := store.ConflictOf(clientBg, "d-2")
	ctx.Assert(kept2 != nil && kept2.Body == clientLaptop && kept2.BaseRevision == base2 && kept2.Device == "laptop", "the merged body did not apply, so the laptop's edit must be kept with MarkConflicted (its body, base revision %d and device), the store holds %+v", base2, kept2)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <optional>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "docsync/revisions.h"
#include "docsync/store.h"
#include "sync_engine.grpc.pb.h"

namespace {

const std::string kClientBase = "milk\\neggs\\nbread";
const std::string kClientPhone = "milk\\neggs\\nsourdough";   // the phone's edit of line 3, now the head
const std::string kClientLaptop = "oat milk\\neggs\\nbread";  // the laptop's edit of line 1, made offline against the base
const std::string kClientMerged = "oat milk\\neggs\\nsourdough";
const std::string kClientOverlap = "milk\\neggs\\nrye";  // the laptop's edit of line 3 too
const std::string kClientLater = "milk\\neggs\\nsourdough loaf";  // the phone's next edit, landing while the laptop's edit is merged

std::vector<std::string> lines(const std::string& text) {
  std::vector<std::string> out;
  std::stringstream in(text);
  std::string line;
  while (std::getline(in, line)) out.push_back(line);
  return out;
}

// A line-by-line three-way merge: edits of different lines combine, two edits of one line are FAILED_PRECONDITION.
class MergerPeer final : public syncd::Merger::Service {
 public:
  grpc::Status ThreeWayMerge(grpc::ServerContext*, const syncd::MergeRequest* req, syncd::MergeResult* out) override {
    const auto base = lines(req->base()), local = lines(req->local()), remote = lines(req->remote());
    if (base.size() != local.size() || base.size() != remote.size()) {
      return grpc::Status(grpc::StatusCode::FAILED_PRECONDITION, "the edits change the number of lines");
    }
    std::string merged;
    for (size_t i = 0; i < base.size(); i++) {
      if (local[i] != base[i] && remote[i] != base[i] && local[i] != remote[i]) {
        return grpc::Status(grpc::StatusCode::FAILED_PRECONDITION, "line " + std::to_string(i + 1) + " was edited on both sides");
      }
      merged += (i ? "\\n" : "") + (local[i] != base[i] ? local[i] : remote[i]);
    }
    out->set_body(merged);
    return grpc::Status::OK;
  }
};

void clientServe(harness::Ctx& ctx) {
  static MergerPeer* peer = nullptr;
  delete peer;
  peer = new MergerPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

// The base as the laptop last pulled it, then the phone's edit of it as the head: {base revision, head revision}.
std::pair<long long, long long> clientSeed(const std::string& doc_id) {
  const long long base = revisions::applyChange(doc_id, 0, store::contentHash(kClientBase), kClientBase, "laptop").revision;
  const long long head = revisions::applyChange(doc_id, base, store::contentHash(kClientPhone), kClientPhone, "phone").revision;
  return {base, head};
}

size_t clientCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("ThreeWayMerge").size(); }

std::string outcomeText(const store::Outcome& o) { return o.status + " at " + std::to_string(o.revision); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  clientServe(ctx);
  auto [base, head] = clientSeed("d-1");
  store::Outcome out = resolveConflict("d-1", base, kClientLaptop, "laptop");
  ctx.Equal(out.status, "merged", "with a healthy merger the edits of lines 1 and 3 must merge; the status");
  for (const auto& call : ctx.GRPC.CallsTo("ThreeWayMerge")) {
    ctx.Assert(call.HasDeadline(), "a ThreeWayMerge call carries no deadline: a merger that hangs holds the push open");
    ctx.Assert(1.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 2.5, "a ThreeWayMerge call carries a %v s deadline, expected kMergeDeadline = 2 s", call.TimeoutSeconds());
  }
  std::tie(base, head) = clientSeed("d-2");
  ctx.GRPC.SetLatency("ThreeWayMerge", 10.0);
  const int64_t before = ctx.Clock.Now();
  const size_t start = clientCalls(ctx);
  out = resolveConflict("d-2", base, kClientLaptop, "laptop");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "resolveConflict waited %.0f s for a merger that answers in 10 s: two attempts of 2 s each, then give up", waited);
  ctx.Assert(out.status == "conflicted" && out.revision == head, "a merger that never answered in time must leave the document conflicted at its head revision %d, got %s", head, outcomeText(out));
  const auto all = ctx.GRPC.CallsTo("ThreeWayMerge");
  ctx.Equal(all.size() - start, size_t{2}, "a merger that answers in 10 s must be asked kMaxMergeAttempts (2) times for one conflict; the calls");
  for (size_t i = start; i < all.size(); i++) {
    ctx.Assert(all[i].HasDeadline() && 1.5 <= all[i].TimeoutSeconds() && all[i].TimeoutSeconds() <= 2.5,
               "an attempt carried a %v s deadline: each attempt gets its own kMergeDeadline (2 s), and a deadline shared by both leaves the retry no time", all[i].TimeoutSeconds());
  }
}

void CheckRetryTransient(harness::Ctx& ctx) {
  clientServe(ctx);
  auto [base, head] = clientSeed("d-1");
  ctx.GRPC.Fail("ThreeWayMerge", grpc::StatusCode::UNAVAILABLE, "merger restarting", 1);
  store::Outcome out = resolveConflict("d-1", base, kClientLaptop, "laptop");
  ctx.Equal(clientCalls(ctx), size_t{2}, "one UNAVAILABLE, then a healthy merger; the calls");
  ctx.Assert(out.status == "merged" && store::head("d-1")->body == kClientMerged, "the second attempt must merge, got %s and a head of %q", outcomeText(out), store::head("d-1")->body);
  std::tie(base, head) = clientSeed("d-2");
  ctx.GRPC.Fail("ThreeWayMerge", grpc::StatusCode::UNAVAILABLE, "merger down", 10);
  const size_t before = clientCalls(ctx);
  out = resolveConflict("d-2", base, kClientLaptop, "laptop");
  ctx.Equal(clientCalls(ctx) - before, size_t{2}, "a merger that stays UNAVAILABLE must be asked at most kMaxMergeAttempts (2) times for one conflict; the calls");
  ctx.Assert(out.status == "conflicted" && out.revision == head, "after the last attempt the document must be conflicted at its head revision %d, got %s", head, outcomeText(out));
}

void CheckRejectionTerminal(harness::Ctx& ctx) {
  clientServe(ctx);
  const auto [base, head] = clientSeed("d-1");
  const store::Outcome out = resolveConflict("d-1", base, kClientOverlap, "laptop");
  ctx.Equal(clientCalls(ctx), size_t{1}, "the merger refused two edits of line 3 (FAILED_PRECONDITION): a refusal is final; the calls");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a refused merge must not be slept on and asked again; the sleeps");
  ctx.Assert(out.status == "conflicted" && out.revision == head, "a refused merge must leave the document conflicted at its head revision %d, got %s", head, outcomeText(out));
  const auto [base2, head2] = clientSeed("d-2");
  ctx.GRPC.Fail("ThreeWayMerge", grpc::StatusCode::INVALID_ARGUMENT, "the request is malformed", 1);
  const size_t before = clientCalls(ctx);
  const store::Outcome out2 = resolveConflict("d-2", base2, kClientLaptop, "laptop");
  ctx.Equal(clientCalls(ctx) - before, size_t{1}, "the merger answered INVALID_ARGUMENT: only UNAVAILABLE and DEADLINE_EXCEEDED are asked again; the calls");
  ctx.Assert(out2.status == "conflicted" && out2.revision == head2, "a merge that failed with INVALID_ARGUMENT must leave the document conflicted at its head revision %d, got %s", head2, outcomeText(out2));
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a failed merge that is not retried must not be slept on; the sleeps");
}

void CheckKeepBoth(harness::Ctx& ctx) {
  clientServe(ctx);
  const auto [base, head] = clientSeed("d-1");
  const store::Outcome out = resolveConflict("d-1", base, kClientOverlap, "laptop");
  const auto now = store::head("d-1");
  ctx.Assert(now->body == kClientPhone && now->revision == head, "a failed merge replaced the phone's edit: the head reads %q at revision %d. Leave the head as it is", now->body, now->revision);
  const auto kept = store::conflictOf("d-1");
  ctx.Assert(kept && kept->body == kClientOverlap && kept->base_revision == base && kept->device == "laptop",
             "the laptop's edit must be kept for the user with markConflicted (its body, base revision %d and device), the store holds %s", base, kept ? kept->body : "nothing");
  ctx.Equal(out.status, "conflicted", "the answer's status");
  // The phone edits d-2 again while the laptop's edit of it is being merged.
  const auto [base2, head2] = clientSeed("d-2");
  std::optional<store::Outcome> rival;
  std::optional<std::string> failed;
  ctx.Redis.After("doc:d-2", [&, head2 = head2] {
    try {
      rival = revisions::applyChange("d-2", head2, store::contentHash(kClientLater), kClientLater, "phone");
    } catch (const std::exception& e) {
      failed = e.what();
    }
  });
  const store::Outcome out2 = resolveConflict("d-2", base2, kClientLaptop, "laptop");
  ctx.Assert(!failed, "the phone's apply failed: %s", failed.value_or(""));
  ctx.Assert(rival.has_value(), "resolveConflict never read d-2's head");
  const long long moved = rival->revision;
  const auto now2 = store::head("d-2");
  ctx.Assert(now2->body == kClientLater && now2->revision == moved, "the phone's edit that landed during the merge was replaced: the head reads %q at revision %d", now2->body, now2->revision);
  ctx.Assert(out2.status == "conflicted" && out2.revision == moved, "the head moved to revision %d while the merge ran, so the merged body was not applied: answer conflicted at revision %d, got %s", moved, moved, outcomeText(out2));
  const auto kept2 = store::conflictOf("d-2");
  ctx.Assert(kept2 && kept2->body == kClientLaptop && kept2->base_revision == base2 && kept2->device == "laptop",
             "the merged body did not apply, so the laptop's edit must be kept with markConflicted (its body, base revision %d and device), the store holds %s", base2, kept2 ? kept2->body : "nothing");
}
`,
  },
  hints: [
    'Make the merger hang: the push waits as long as it does. Have it refuse two edits of one line: it is asked five times. Keep it down: the phone’s edit disappears and the answer says merged.',
    'The call has no deadline, the loop treats every error as a busy merger and sleeps on it, and the fallback after the loop applies the device’s body over the head as if newer meant right.',
    'Pass `timeout=MERGE_DEADLINE_S`; retry only `UNAVAILABLE`/`DEADLINE_EXCEEDED` while `attempt < MAX_MERGE_ATTEMPTS`; on any other failure call `store.mark_conflicted(...)` and answer `conflicted` at the head’s revision.',
  ],
  debrief: `A merge is a request for an opinion, and the code around it decides what to do when the opinion is late, unavailable or a refusal. The deadline bounds the first, one quick retry covers a merger that was restarting, and a refusal is taken as the answer it is. The fallback is where the step matters most: picking the newer upload turns a failed merge into silent data loss, while keeping the device's edit beside the head turns it into a visible conflict a person can resolve. A production merger would also cap the size of the documents it takes, merge structured formats with an algorithm that knows them instead of lines, and back off with jitter so a restarted merger is not met by every device at once.`,
};
