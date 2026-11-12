import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Moderation first, under a deadline, one request id per comment',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['api', 'moderation', 'notifier', 'review'],
  task: `## Task

**Starting point.** The starter is \`fanout(tenant, comment)\`, which the write path runs for each new
comment: it calls \`Notifier.NotifyAuthor\`, then \`Moderation.CheckComment\`, records \`allowed\`
or \`blocked\` with \`store.set_status\` and returns it; when the notification fails it calls
\`store.enqueue_notify_retry\` and returns \`allowed\`. Every request carries a fresh random
\`request_id\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A slow moderation service holds the comment's POST open; a
redelivered job notifies the thread twice because each attempt looks new; a notifier outage
publishes comments moderation never saw, and blocked comments still ping the thread; a moderation
timeout fails the write.

\`\`\`proto
service Moderation { rpc CheckComment(CheckRequest) returns (Verdict); }   // allowed or not
service Notifier   { rpc NotifyAuthor(NotifyRequest) returns (NotifyAck); }
\`\`\`

- Both calls run under \`FANOUT_DEADLINE_S\` = 0.5 s.
- \`request_id\` is the comment id, on every call and on the \`notify:retry\` entry.
- Moderation runs first. Only an \`allowed\` comment is announced; a failed announcement goes to
  \`store.enqueue_notify_retry\`.
- \`DEADLINE_EXCEEDED\` from moderation means \`pending_review\`: \`store.set_status\`,
  \`store.enqueue_review\`, return it. Any other moderation error raises.`,
  sequence: {
    participants: ['Comments API', 'Moderation', 'Notifier', 'Redis queues'],
    messages: [
      {from: 'Comments API', to: 'Moderation', label: 'CheckComment · request_id = comment id · 500 ms', kind: 'sync'},
      {from: 'Moderation', to: 'Comments API', label: 'allowed / blocked', kind: 'reply'},
      {from: 'Moderation', to: 'Comments API', label: 'DEADLINE_EXCEEDED → pending_review', kind: 'reply'},
      {from: 'Comments API', to: 'Redis queues', label: 'enqueue_review(tenant, id)', kind: 'async'},
      {
        from: 'Comments API',
        to: 'Notifier',
        label: 'NotifyAuthor (allowed only) · same request_id · 500 ms',
        kind: 'sync',
      },
      {
        from: 'Comments API',
        to: 'Redis queues',
        label: 'on failure: enqueue_notify_retry(tenant, id, request_id)',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Both fan-out calls carry a 500 ms deadline',
      detail:
        '`CheckComment` and `NotifyAuthor` are made with `FANOUT_DEADLINE_S` (0.5 s), so a stalled dependency costs the write at most half a second. The starter sets no deadline at all.',
      match: {
        python: {all: [/FANOUT_DEADLINE_S\s*=\s*0\.5\b/, /timeout\s*=\s*FANOUT_DEADLINE_S/]},
        typescript: {all: [/FANOUT_DEADLINE_MS\s*=\s*500\b/, /deadline:\s*Date\.now\(\)\s*\+\s*FANOUT_DEADLINE_MS/]},
        go: {
          all: [/fanoutDeadline\s*=\s*500\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*fanoutDeadline\)/],
        },
        scala: {all: [/FanoutDeadlineMs\s*=\s*500L?\b/, /withDeadlineAfter\(\s*FanoutDeadlineMs/]},
        cpp: {all: [/kFanoutDeadline\{500\}|kFanoutDeadline\(500\)/, /set_deadline\([^\n]*kFanoutDeadline\)/]},
      },
    },
    {
      id: 'request-id',
      title: 'Every attempt about one comment carries its id',
      detail:
        '`request_id` is the comment id on both calls and on the `notify:retry` entry, so moderation and the notifier recognise a redelivered job; the starter generates a random id per call, so every retry is a new request.',
      match: {
        python: {all: [/request_id\s*=\s*comment\[["']id["']\]/], none: [/uuid/]},
        typescript: {all: [/requestId\s*=\s*comment\.id|request_id:\s*comment\.id/], none: [/randomUUID/]},
        go: {all: [/requestID\s*:?=\s*c\.ID|RequestId:\s*c\.ID/], none: [/uuid\./]},
        scala: {all: [/requestId\s*=\s*comment\.id/], none: [/randomUUID/]},
        cpp: {all: [/request_id\s*=\s*c\.id|set_request_id\(\s*c\.id\s*\)/], none: [/uuid_generate/]},
      },
    },
    {
      id: 'moderation-first',
      title: 'Moderation decides before anything is announced',
      detail:
        '`CheckComment` runs before `NotifyAuthor`, a notifier failure only queues a retry, and a blocked comment is never announced. The starter notifies first and returns `allowed` when the notifier fails, so the comment ships unmoderated.',
      match: {
        python: {order: [/moderation\.CheckComment\(/, /notifier\.NotifyAuthor\(/]},
        typescript: {order: [/moderation\.CheckComment\(/, /notifier\.NotifyAuthor\(/]},
        go: {order: [/moderation\.CheckComment\(/, /notifier\.NotifyAuthor\(/]},
        scala: {order: [/\.checkComment\(/, /\.notifyAuthor\(/]},
        cpp: {order: [/moderation->CheckComment\(/, /notifier->NotifyAuthor\(/]},
      },
    },
    {
      id: 'timeout-review',
      title: 'A moderation timeout becomes a review, not a failed post',
      detail:
        '`DEADLINE_EXCEEDED` from moderation sets `pending_review`, queues the comment with `store.enqueue_review` and returns the status; any other moderation failure still raises. The starter lets the timeout escape.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /["']pending_review["']/, /store\.enqueue_review\(/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /['"]pending_review['"]/, /enqueueReview\(/]},
        go: {all: [/codes\.DeadlineExceeded/, /"pending_review"/, /store\.EnqueueReview\(/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /"pending_review"/, /Store\.enqueueReview\(/]},
        cpp: {all: [/DEADLINE_EXCEEDED/, /"pending_review"/, /store::enqueueReview\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

import grpc

import comments_service_pb2 as pb
import comments_service_pb2_grpc as pb_grpc
from comments import store  # store.set_status, enqueue_review, enqueue_notify_retry

moderation = pb_grpc.ModerationStub(grpc.insecure_channel("moderation:9000"))
notifier = pb_grpc.NotifierStub(grpc.insecure_channel("notifier:9000"))


def fanout(tenant: str, comment: dict) -> str:
    """Moderate a new comment and tell the thread about it; returns the comment's status."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    try:
        notifier.NotifyAuthor(
            pb.NotifyRequest(
                tenant=tenant,
                comment_id=comment["id"],
                thread_id=comment["thread_id"],
                parent_id=comment["parent_id"],
                request_id=uuid.uuid4().hex,
            )
        )
    except grpc.RpcError:
        store.enqueue_notify_retry(tenant, comment["id"], uuid.uuid4().hex)
        return "allowed"
    verdict = moderation.CheckComment(
        pb.CheckRequest(tenant=tenant, comment_id=comment["id"], thread_id=comment["thread_id"], text=comment["text"], request_id=uuid.uuid4().hex)
    )
    status = "allowed" if verdict.allowed else "blocked"
    store.set_status(tenant, comment["id"], status)
    return status
`,
      solution: `import grpc

import comments_service_pb2 as pb
import comments_service_pb2_grpc as pb_grpc
from comments import store  # store.set_status, enqueue_review, enqueue_notify_retry

moderation = pb_grpc.ModerationStub(grpc.insecure_channel("moderation:9000"))
notifier = pb_grpc.NotifierStub(grpc.insecure_channel("notifier:9000"))

FANOUT_DEADLINE_S = 0.5


def fanout(tenant: str, comment: dict) -> str:
    """Moderate a new comment and tell the thread about it; returns the comment's status."""
    request_id = comment["id"]  # the same on every attempt about this comment
    try:
        verdict = moderation.CheckComment(
            pb.CheckRequest(tenant=tenant, comment_id=comment["id"], thread_id=comment["thread_id"], text=comment["text"], request_id=request_id),
            timeout=FANOUT_DEADLINE_S,
        )
        status = "allowed" if verdict.allowed else "blocked"
    except grpc.RpcError as err:
        if err.code() != grpc.StatusCode.DEADLINE_EXCEEDED:
            raise
        # Moderation did not decide in time: a human does, and the post still succeeds.
        status = "pending_review"
        store.enqueue_review(tenant, comment["id"])
    store.set_status(tenant, comment["id"], status)
    if status == "allowed":
        try:
            notifier.NotifyAuthor(
                pb.NotifyRequest(
                    tenant=tenant,
                    comment_id=comment["id"],
                    thread_id=comment["thread_id"],
                    parent_id=comment["parent_id"],
                    request_id=request_id,
                ),
                timeout=FANOUT_DEADLINE_S,
            )
        except grpc.RpcError:
            store.enqueue_notify_retry(tenant, comment["id"], request_id)  # best effort: retried later, same id
    return status
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {randomUUID} from 'node:crypto';

import {type Comment, enqueueNotifyRetry, enqueueReview, setStatus} from 'comments/store';

interface CheckRequest {
  tenant: string;
  comment_id: string;
  thread_id: string;
  text: string;
  request_id: string;
}

interface NotifyRequest {
  tenant: string;
  comment_id: string;
  thread_id: string;
  parent_id: string;
  request_id: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('comments_service.proto')) as unknown as {
  commentsd: {Moderation: grpc.ServiceClientConstructor; Notifier: grpc.ServiceClientConstructor};
};
const moderation = new pkg.commentsd.Moderation('moderation:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  CheckComment(request: CheckRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{allowed: boolean; reason: string}>;
};
const notifier = new pkg.commentsd.Notifier('notifier:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  NotifyAuthor(request: NotifyRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{queued: boolean}>;
};

/** Moderate a new comment and tell the thread about it; resolves the comment's status. */
export async function fanout(tenant: string, comment: Comment): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  try {
    await notifier.NotifyAuthor(
      {tenant, comment_id: comment.id, thread_id: comment.thread_id, parent_id: comment.parent_id, request_id: randomUUID()},
      new grpc.Metadata(),
      {},
    );
  } catch {
    await enqueueNotifyRetry(tenant, comment.id, randomUUID());
    return 'allowed';
  }
  const verdict = await moderation.CheckComment(
    {tenant, comment_id: comment.id, thread_id: comment.thread_id, text: comment.text, request_id: randomUUID()},
    new grpc.Metadata(),
    {},
  );
  const status = verdict.allowed ? 'allowed' : 'blocked';
  await setStatus(tenant, comment.id, status);
  return status;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Comment, enqueueNotifyRetry, enqueueReview, setStatus} from 'comments/store';

export const FANOUT_DEADLINE_MS = 500;

interface CheckRequest {
  tenant: string;
  comment_id: string;
  thread_id: string;
  text: string;
  request_id: string;
}

interface NotifyRequest {
  tenant: string;
  comment_id: string;
  thread_id: string;
  parent_id: string;
  request_id: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('comments_service.proto')) as unknown as {
  commentsd: {Moderation: grpc.ServiceClientConstructor; Notifier: grpc.ServiceClientConstructor};
};
const moderation = new pkg.commentsd.Moderation('moderation:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  CheckComment(request: CheckRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{allowed: boolean; reason: string}>;
};
const notifier = new pkg.commentsd.Notifier('notifier:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  NotifyAuthor(request: NotifyRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{queued: boolean}>;
};

/** Moderate a new comment and tell the thread about it; resolves the comment's status. */
export async function fanout(tenant: string, comment: Comment): Promise<string> {
  const requestId = comment.id; // the same on every attempt about this comment
  let status: string;
  try {
    const verdict = await moderation.CheckComment(
      {tenant, comment_id: comment.id, thread_id: comment.thread_id, text: comment.text, request_id: requestId},
      new grpc.Metadata(),
      {deadline: Date.now() + FANOUT_DEADLINE_MS},
    );
    status = verdict.allowed ? 'allowed' : 'blocked';
  } catch (e) {
    if ((e as grpc.ServiceError).code !== grpc.status.DEADLINE_EXCEEDED) throw e;
    // Moderation did not decide in time: a human does, and the post still succeeds.
    status = 'pending_review';
    await enqueueReview(tenant, comment.id);
  }
  await setStatus(tenant, comment.id, status);
  if (status === 'allowed') {
    try {
      await notifier.NotifyAuthor(
        {tenant, comment_id: comment.id, thread_id: comment.thread_id, parent_id: comment.parent_id, request_id: requestId},
        new grpc.Metadata(),
        {deadline: Date.now() + FANOUT_DEADLINE_MS},
      );
    } catch {
      await enqueueNotifyRetry(tenant, comment.id, requestId); // best effort: retried later, same id
    }
  }
  return status;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "comments/gen/comments_service"
	"comments/store" // store.Comment, SetStatus, EnqueueReview, EnqueueNotifyRetry
)

var (
	moderationConn, _ = grpc.NewClient("moderation:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	notifierConn, _   = grpc.NewClient("notifier:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	moderation        = pb.NewModerationClient(moderationConn)
	notifier          = pb.NewNotifierClient(notifierConn)
)

// fanout moderates a new comment and tells the thread about it; it returns the comment's status.
func fanout(ctx context.Context, tenant string, c store.Comment) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	_, err := notifier.NotifyAuthor(ctx, &pb.NotifyRequest{Tenant: tenant, CommentId: c.ID, ThreadId: c.ThreadID, ParentId: c.ParentID, RequestId: uuid.NewString()})
	if err != nil {
		store.EnqueueNotifyRetry(ctx, tenant, c.ID, uuid.NewString())
		return "allowed", nil
	}
	verdict, err := moderation.CheckComment(ctx, &pb.CheckRequest{Tenant: tenant, CommentId: c.ID, ThreadId: c.ThreadID, Text: c.Text, RequestId: uuid.NewString()})
	if err != nil {
		return "", err
	}
	outcome := "blocked"
	if verdict.GetAllowed() {
		outcome = "allowed"
	}
	store.SetStatus(ctx, tenant, c.ID, outcome)
	return outcome, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "comments/gen/comments_service"
	"comments/store" // store.Comment, SetStatus, EnqueueReview, EnqueueNotifyRetry
)

const fanoutDeadline = 500 * time.Millisecond

var (
	moderationConn, _ = grpc.NewClient("moderation:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	notifierConn, _   = grpc.NewClient("notifier:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	moderation        = pb.NewModerationClient(moderationConn)
	notifier          = pb.NewNotifierClient(notifierConn)
)

// fanout moderates a new comment and tells the thread about it; it returns the comment's status.
func fanout(ctx context.Context, tenant string, c store.Comment) (string, error) {
	requestID := c.ID // the same on every attempt about this comment
	checkCtx, cancel := context.WithTimeout(ctx, fanoutDeadline)
	verdict, err := moderation.CheckComment(checkCtx, &pb.CheckRequest{Tenant: tenant, CommentId: c.ID, ThreadId: c.ThreadID, Text: c.Text, RequestId: requestID})
	cancel()
	outcome := "blocked"
	switch {
	case err == nil && verdict.GetAllowed():
		outcome = "allowed"
	case err == nil:
	case status.Code(err) == codes.DeadlineExceeded:
		// Moderation did not decide in time: a human does, and the post still succeeds.
		outcome = "pending_review"
		store.EnqueueReview(ctx, tenant, c.ID)
	default:
		return "", err
	}
	store.SetStatus(ctx, tenant, c.ID, outcome)
	if outcome == "allowed" {
		notifyCtx, cancel := context.WithTimeout(ctx, fanoutDeadline)
		_, err := notifier.NotifyAuthor(notifyCtx, &pb.NotifyRequest{Tenant: tenant, CommentId: c.ID, ThreadId: c.ThreadID, ParentId: c.ParentID, RequestId: requestID})
		cancel()
		if err != nil {
			store.EnqueueNotifyRetry(ctx, tenant, c.ID, requestID) // best effort: retried later, same id
		}
	}
	return outcome, nil
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import scala.util.Try

import io.grpc.ManagedChannelBuilder

import comments.Store // Store.Comment, setStatus, enqueueReview, enqueueNotifyRetry
import commentsd.comments_service.{CheckRequest, ModerationGrpc, NotifierGrpc, NotifyRequest}

object Client {
  private val moderation = ModerationGrpc.blockingStub(ManagedChannelBuilder.forAddress("moderation", 9000).usePlaintext().build())
  private val notifier = NotifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("notifier", 9000).usePlaintext().build())

  /** Moderate a new comment and tell the thread about it; returns the comment's status. */
  def fanout(tenant: String, comment: Store.Comment): String = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val notified = Try(notifier.notifyAuthor(NotifyRequest(tenant = tenant, commentId = comment.id, threadId = comment.threadId, parentId = comment.parentId, requestId = UUID.randomUUID().toString)))
    if (notified.isFailure) {
      Store.enqueueNotifyRetry(tenant, comment.id, UUID.randomUUID().toString)
      "allowed"
    } else {
      val verdict = moderation.checkComment(CheckRequest(tenant = tenant, commentId = comment.id, threadId = comment.threadId, text = comment.text, requestId = UUID.randomUUID().toString))
      val status = if (verdict.allowed) "allowed" else "blocked"
      Store.setStatus(tenant, comment.id, status)
      status
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.util.Try

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import comments.Store // Store.Comment, setStatus, enqueueReview, enqueueNotifyRetry
import commentsd.comments_service.{CheckRequest, ModerationGrpc, NotifierGrpc, NotifyRequest}

object Client {
  val FanoutDeadlineMs = 500L

  private val moderation = ModerationGrpc.blockingStub(ManagedChannelBuilder.forAddress("moderation", 9000).usePlaintext().build())
  private val notifier = NotifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("notifier", 9000).usePlaintext().build())

  /** Moderate a new comment and tell the thread about it; returns the comment's status. */
  def fanout(tenant: String, comment: Store.Comment): String = {
    val requestId = comment.id // the same on every attempt about this comment
    val status =
      try {
        val verdict = moderation
          .withDeadlineAfter(FanoutDeadlineMs, TimeUnit.MILLISECONDS)
          .checkComment(CheckRequest(tenant = tenant, commentId = comment.id, threadId = comment.threadId, text = comment.text, requestId = requestId))
        if (verdict.allowed) "allowed" else "blocked"
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
          // Moderation did not decide in time: a human does, and the post still succeeds.
          Store.enqueueReview(tenant, comment.id)
          "pending_review"
      }
    Store.setStatus(tenant, comment.id, status)
    if (status == "allowed") {
      val notified = Try(
        notifier
          .withDeadlineAfter(FanoutDeadlineMs, TimeUnit.MILLISECONDS)
          .notifyAuthor(NotifyRequest(tenant = tenant, commentId = comment.id, threadId = comment.threadId, parentId = comment.parentId, requestId = requestId)))
      if (notified.isFailure) Store.enqueueNotifyRetry(tenant, comment.id, requestId) // best effort: retried later, same id
    }
    status
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <uuid/uuid.h>

#include <stdexcept>
#include <string>

#include "comments/store.h"  // store::Comment, setStatus, enqueueReview, enqueueNotifyRetry
#include "comments_service.grpc.pb.h"

auto moderation = commentsd::Moderation::NewStub(grpc::CreateChannel("moderation:9000", grpc::InsecureChannelCredentials()));
auto notifier = commentsd::Notifier::NewStub(grpc::CreateChannel("notifier:9000", grpc::InsecureChannelCredentials()));

// Moderation failed for another reason than its deadline.
struct ModerationFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string newRequestId() {
  uuid_t id;
  uuid_generate_random(id);
  char text[37];
  uuid_unparse_lower(id, text);
  return text;
}

// Moderate a new comment and tell the thread about it; returns the comment's status.
std::string fanout(const std::string& tenant, const store::Comment& c) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  commentsd::NotifyRequest notify;
  notify.set_tenant(tenant);
  notify.set_comment_id(c.id);
  notify.set_thread_id(c.thread_id);
  notify.set_parent_id(c.parent_id);
  notify.set_request_id(newRequestId());
  commentsd::NotifyAck ack;
  grpc::ClientContext notifyCtx;
  if (!notifier->NotifyAuthor(&notifyCtx, notify, &ack).ok()) {
    store::enqueueNotifyRetry(tenant, c.id, newRequestId());
    return "allowed";
  }
  commentsd::CheckRequest check;
  check.set_tenant(tenant);
  check.set_comment_id(c.id);
  check.set_thread_id(c.thread_id);
  check.set_text(c.text);
  check.set_request_id(newRequestId());
  commentsd::Verdict verdict;
  grpc::ClientContext checkCtx;
  const grpc::Status status = moderation->CheckComment(&checkCtx, check, &verdict);
  if (!status.ok()) throw ModerationFailed(status.error_message());
  const std::string outcome = verdict.allowed() ? "allowed" : "blocked";
  store::setStatus(tenant, c.id, outcome);
  return outcome;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "comments/store.h"  // store::Comment, setStatus, enqueueReview, enqueueNotifyRetry
#include "comments_service.grpc.pb.h"

constexpr std::chrono::milliseconds kFanoutDeadline{500};

auto moderation = commentsd::Moderation::NewStub(grpc::CreateChannel("moderation:9000", grpc::InsecureChannelCredentials()));
auto notifier = commentsd::Notifier::NewStub(grpc::CreateChannel("notifier:9000", grpc::InsecureChannelCredentials()));

// Moderation failed for another reason than its deadline.
struct ModerationFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Moderate a new comment and tell the thread about it; returns the comment's status.
std::string fanout(const std::string& tenant, const store::Comment& c) {
  const std::string request_id = c.id;  // the same on every attempt about this comment
  commentsd::CheckRequest check;
  check.set_tenant(tenant);
  check.set_comment_id(c.id);
  check.set_thread_id(c.thread_id);
  check.set_text(c.text);
  check.set_request_id(request_id);
  commentsd::Verdict verdict;
  grpc::ClientContext checkCtx;
  checkCtx.set_deadline(std::chrono::system_clock::now() + kFanoutDeadline);
  const grpc::Status status = moderation->CheckComment(&checkCtx, check, &verdict);
  std::string outcome;
  if (status.ok()) {
    outcome = verdict.allowed() ? "allowed" : "blocked";
  } else if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
    // Moderation did not decide in time: a human does, and the post still succeeds.
    outcome = "pending_review";
    store::enqueueReview(tenant, c.id);
  } else {
    throw ModerationFailed(status.error_message());
  }
  store::setStatus(tenant, c.id, outcome);
  if (outcome == "allowed") {
    commentsd::NotifyRequest notify;
    notify.set_tenant(tenant);
    notify.set_comment_id(c.id);
    notify.set_thread_id(c.thread_id);
    notify.set_parent_id(c.parent_id);
    notify.set_request_id(request_id);
    commentsd::NotifyAck ack;
    grpc::ClientContext notifyCtx;
    notifyCtx.set_deadline(std::chrono::system_clock::now() + kFanoutDeadline);
    if (!notifier->NotifyAuthor(&notifyCtx, notify, &ack).ok()) {
      store::enqueueNotifyRetry(tenant, c.id, request_id);  // best effort: retried later, same id
    }
  }
  return outcome;
}
`,
    },
  },
  harness: {
    python: `import json

import grpc

import comments_service_pb2 as pb
import comments_service_pb2_grpc as pb_grpc
from comments import store


class Moderation(pb_grpc.ModerationServicer):
    """Allows every comment that does not mention spam."""

    def CheckComment(self, request, context):
        spam = "spam" in request.text
        return pb.Verdict(allowed=not spam, reason="spam" if spam else "")


class Notifier(pb_grpc.NotifierServicer):
    def NotifyAuthor(self, request, context):
        return pb.NotifyAck(queued=True)


def _client(ctx):
    ctx.grpc.serve(pb_grpc.add_ModerationServicer_to_server, Moderation())
    ctx.grpc.serve(pb_grpc.add_NotifierServicer_to_server, Notifier())
    return ctx.load("client")


def _comment(text="Great write-up"):
    comment = store.new_comment("t-1", "", "u-1", text, text)
    store.insert("acme", comment)
    return comment


def _status(comment):
    return store.get("acme", comment["id"])["status"]


def _notified(ctx):
    return [call.request.comment_id for call in ctx.grpc.calls_to("NotifyAuthor")]


def check_deadline(ctx):
    m = _client(ctx)
    assert m.fanout("acme", _comment()) == "allowed", "a comment moderation allows must come back allowed"
    for method in ("CheckComment", "NotifyAuthor"):
        calls = ctx.grpc.calls_to(method)
        assert calls, f"no {method} call was made for an allowed comment"
        for call in calls:
            assert call.timeout is not None, f"a {method} call carries no deadline: a stalled service holds the comment's POST open for as long as it stalls"
            assert 0.4 <= call.timeout <= 0.6, f"a {method} call carries a {call.timeout} s deadline, expected FANOUT_DEADLINE_S = 0.5"


def check_request_id(ctx):
    m = _client(ctx)
    comment = _comment()
    m.fanout("acme", comment)
    m.fanout("acme", comment)  # the job is redelivered: the same comment fans out again
    calls = ctx.grpc.calls_to("CheckComment") + ctx.grpc.calls_to("NotifyAuthor")
    ids = [call.request.request_id for call in calls]
    assert ids and set(ids) == {comment["id"]}, f"the calls about {comment['id']} carried request_id {ids}: every attempt about one comment must carry its id, or a redelivered job looks like a new comment"
    ctx.grpc.fail("NotifyAuthor", grpc.StatusCode.UNAVAILABLE)
    other = _comment("Second thought")
    m.fanout("acme", other)
    retries = [json.loads(entry) for entry in ctx.redis.lrange("notify:retry", 0, -1)]
    assert retries == [{"tenant": "acme", "comment_id": other["id"], "request_id": other["id"]}], f"after a failed notification notify:retry holds {retries}: the retry must carry the request_id of the attempt it repeats ({other['id']})"


def check_moderation_first(ctx):
    m = _client(ctx)
    ctx.grpc.fail("NotifyAuthor", grpc.StatusCode.UNAVAILABLE)
    comment = _comment()
    status = m.fanout("acme", comment)
    assert ctx.grpc.calls_to("CheckComment"), "the notifier failed and moderation was never asked: the comment went live unmoderated. Moderate first; the notification is best effort"
    assert status == "allowed" and _status(comment) == "allowed", f"with moderation allowing it, the comment must be allowed despite the notifier failing; fanout returned {status!r}, the store holds {_status(comment)!r}"
    assert ctx.redis.llen("notify:retry") == 1, f"the failed notification must be queued once on notify:retry, the queue holds {ctx.redis.llen('notify:retry')}"
    spam = _comment("Buy spam now")
    assert m.fanout("acme", spam) == "blocked", "a comment moderation rejects must come back blocked"
    assert _status(spam) == "blocked", f"the blocked comment's status is {_status(spam)!r}"
    assert spam["id"] not in _notified(ctx), f"the thread was notified about {spam['id']}, a comment moderation blocked"


def check_timeout_review(ctx):
    m = _client(ctx)
    ctx.grpc.fail("CheckComment", grpc.StatusCode.DEADLINE_EXCEEDED)
    comment = _comment()
    try:
        status = m.fanout("acme", comment)
    except Exception as exc:
        code = exc.code() if isinstance(exc, grpc.RpcError) else exc
        raise AssertionError(f"moderation ran out of time and fanout raised {type(exc).__name__} ({code}). A moderation timeout is not a failed post: flag the comment pending_review and queue it for review")
    assert status == "pending_review" and _status(comment) == "pending_review", f"after a moderation timeout fanout returned {status!r} and the store holds {_status(comment)!r}, expected pending_review"
    queued = ctx.redis.lrange("review:queue", 0, -1)
    assert queued == [f"acme:{comment['id']}"], f"review:queue holds {queued}, expected the comment waiting for a moderator"
    assert comment["id"] not in _notified(ctx), "a comment waiting for review must not be announced yet"
    ctx.grpc.fail("CheckComment", grpc.StatusCode.UNAVAILABLE)
    try:
        m.fanout("acme", _comment("Another"))
    except Exception:
        return
    raise AssertionError("moderation answered UNAVAILABLE and fanout returned a status: only a deadline becomes a review, other failures must reach the caller")
`,
    typescript: `function client(ctx) {
  const pkg = ctx.proto('comments_service.proto');
  ctx.grpc.serve(pkg.commentsd.Moderation.service, {
    CheckComment(call, callback) {
      const spam = String(call.request.text).includes('spam');
      callback(null, {allowed: !spam, reason: spam ? 'spam' : ''});
    },
  });
  ctx.grpc.serve(pkg.commentsd.Notifier.service, {
    NotifyAuthor(_call, callback) {
      callback(null, {queued: true});
    },
  });
  return {m: ctx.load('client'), store: ctx.load('/support/comments/store.ts')};
}

async function comment(store, text = 'Great write-up') {
  const c = await store.newComment('t-1', '', 'u-1', text, text);
  await store.insert('acme', c);
  return c;
}

const statusOf = async (store, c) => (await store.get('acme', c.id)).status;
const notified = ctx => ctx.grpc.callsTo('NotifyAuthor').map(call => call.request.comment_id);

export async function check_deadline(ctx) {
  const {m, store} = client(ctx);
  assert.equal(await m.fanout('acme', await comment(store)), 'allowed', 'a comment moderation allows must come back allowed');
  for (const method of ['CheckComment', 'NotifyAuthor']) {
    const calls = ctx.grpc.callsTo(method);
    assert(calls.length > 0, \`no \${method} call was made for an allowed comment\`);
    for (const call of calls) {
      assert(call.timeout !== null && call.timeout !== undefined, \`a \${method} call carries no deadline: a stalled service holds the comment's POST open for as long as it stalls\`);
      assert(call.timeout >= 0.4 && call.timeout <= 0.6, \`a \${method} call carries a \${call.timeout} s deadline, expected FANOUT_DEADLINE_MS = 500\`);
    }
  }
}

export async function check_request_id(ctx) {
  const {m, store} = client(ctx);
  const c = await comment(store);
  await m.fanout('acme', c);
  await m.fanout('acme', c); // the job is redelivered: the same comment fans out again
  const ids = [...ctx.grpc.callsTo('CheckComment'), ...ctx.grpc.callsTo('NotifyAuthor')].map(call => call.request.request_id);
  assert(ids.length > 0 && ids.every(id => id === c.id), \`the calls about \${c.id} carried request_id \${JSON.stringify(ids)}: every attempt about one comment must carry its id, or a redelivered job looks like a new comment\`);
  ctx.grpc.fail('NotifyAuthor', ctx.grpc.status.UNAVAILABLE);
  const other = await comment(store, 'Second thought');
  await m.fanout('acme', other);
  const retries = (ctx.redis.lrange('notify:retry', 0, -1) as string[]).map(entry => JSON.parse(entry));
  assert.deepStrictEqual(retries, [{tenant: 'acme', comment_id: other.id, request_id: other.id}], \`after a failed notification notify:retry holds \${JSON.stringify(retries)}: the retry must carry the request_id of the attempt it repeats (\${other.id})\`);
}

export async function check_moderation_first(ctx) {
  const {m, store} = client(ctx);
  ctx.grpc.fail('NotifyAuthor', ctx.grpc.status.UNAVAILABLE);
  const c = await comment(store);
  const status = await m.fanout('acme', c);
  assert(ctx.grpc.callsTo('CheckComment').length > 0, 'the notifier failed and moderation was never asked: the comment went live unmoderated. Moderate first; the notification is best effort');
  const stored = await statusOf(store, c);
  assert(status === 'allowed' && stored === 'allowed', \`with moderation allowing it, the comment must be allowed despite the notifier failing; fanout resolved \${status}, the store holds \${stored}\`);
  assert.equal(Number(ctx.redis.llen('notify:retry')), 1, 'the failed notification must be queued once on notify:retry');
  const spam = await comment(store, 'Buy spam now');
  assert.equal(await m.fanout('acme', spam), 'blocked', 'a comment moderation rejects must come back blocked');
  assert.equal(await statusOf(store, spam), 'blocked', "the blocked comment's status");
  assert(!notified(ctx).includes(spam.id), \`the thread was notified about \${spam.id}, a comment moderation blocked\`);
}

export async function check_timeout_review(ctx) {
  const {m, store} = client(ctx);
  ctx.grpc.fail('CheckComment', ctx.grpc.status.DEADLINE_EXCEEDED);
  const c = await comment(store);
  let status;
  try {
    status = await m.fanout('acme', c);
  } catch (e) {
    assert.fail(\`moderation ran out of time and fanout threw \${(e as Error).message}. A moderation timeout is not a failed post: flag the comment pending_review and queue it for review\`);
  }
  const stored = await statusOf(store, c);
  assert(status === 'pending_review' && stored === 'pending_review', \`after a moderation timeout fanout resolved \${status} and the store holds \${stored}, expected pending_review\`);
  const queued = ctx.redis.lrange('review:queue', 0, -1);
  assert.deepStrictEqual(queued, [\`acme:\${c.id}\`], \`review:queue holds \${JSON.stringify(queued)}, expected the comment waiting for a moderator\`);
  assert(!notified(ctx).includes(c.id), 'a comment waiting for review must not be announced yet');
  ctx.grpc.fail('CheckComment', ctx.grpc.status.UNAVAILABLE);
  await assert.rejects(m.fanout('acme', await comment(store, 'Another')), 'moderation answered UNAVAILABLE and fanout resolved a status: only a deadline becomes a review, other failures must reach the caller');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"google.golang.org/grpc/codes"

	pb "comments/gen/comments_service"
	"comments/store"

	"leetbuild/harness"
)

var fanoutBg = context.Background()

// moderationPeer allows every comment that does not mention spam.
type moderationPeer struct {
	pb.UnimplementedModerationServer
}

func (moderationPeer) CheckComment(_ context.Context, req *pb.CheckRequest) (*pb.Verdict, error) {
	spam := strings.Contains(req.GetText(), "spam")
	return &pb.Verdict{Allowed: !spam}, nil
}

type notifierPeer struct {
	pb.UnimplementedNotifierServer
}

func (notifierPeer) NotifyAuthor(context.Context, *pb.NotifyRequest) (*pb.NotifyAck, error) {
	return &pb.NotifyAck{Queued: true}, nil
}

func peers(ctx *harness.Ctx) {
	pb.RegisterModerationServer(ctx.GRPC.Server("moderation:9000"), moderationPeer{})
	pb.RegisterNotifierServer(ctx.GRPC.Server("notifier:9000"), notifierPeer{})
}

func storedComment(ctx *harness.Ctx, text string) store.Comment {
	c, err := store.NewComment(fanoutBg, "t-1", "", "u-1", text, text)
	ctx.NoError(err, "store.NewComment failed")
	ctx.NoError(store.Insert(fanoutBg, "acme", c), "store.Insert failed")
	return c
}

func statusOf(c store.Comment) string { return store.Get(fanoutBg, "acme", c.ID).Status }

func notifiedIDs(ctx *harness.Ctx) []string {
	var ids []string
	for _, call := range ctx.GRPC.CallsTo("NotifyAuthor", "") {
		ids = append(ids, call.Request.(*pb.NotifyRequest).GetCommentId())
	}
	return ids
}

func contains(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func mustFanout(ctx *harness.Ctx, c store.Comment) string {
	outcome, err := fanout(fanoutBg, "acme", c)
	ctx.NoError(err, "fanout(%s) failed", c.ID)
	return outcome
}

func CheckDeadline(ctx *harness.Ctx) {
	peers(ctx)
	ctx.Equal(mustFanout(ctx, storedComment(ctx, "Great write-up")), "allowed", "a comment moderation allows")
	for _, method := range []string{"CheckComment", "NotifyAuthor"} {
		calls := ctx.GRPC.CallsTo(method, "")
		ctx.Assert(len(calls) > 0, "no %s call was made for an allowed comment", method)
		for _, call := range calls {
			ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a stalled service holds the comment's POST open for as long as it stalls", method)
			ctx.Assert(400*time.Millisecond <= call.Timeout && call.Timeout <= 600*time.Millisecond, "a %s call carries a %v deadline, expected fanoutDeadline = 500 ms", method, call.Timeout)
		}
	}
}

func CheckRequestId(ctx *harness.Ctx) {
	peers(ctx)
	c := storedComment(ctx, "Great write-up")
	mustFanout(ctx, c)
	mustFanout(ctx, c) // the job is redelivered: the same comment fans out again
	var ids []string
	for _, call := range ctx.GRPC.CallsTo("CheckComment", "") {
		ids = append(ids, call.Request.(*pb.CheckRequest).GetRequestId())
	}
	for _, call := range ctx.GRPC.CallsTo("NotifyAuthor", "") {
		ids = append(ids, call.Request.(*pb.NotifyRequest).GetRequestId())
	}
	same := len(ids) > 0
	for _, id := range ids {
		same = same && id == c.ID
	}
	ctx.Assert(same, "the calls about %s carried request_id %q: every attempt about one comment must carry its id, or a redelivered job looks like a new comment", c.ID, ids)
	ctx.GRPC.Fail("NotifyAuthor", codes.Unavailable, "", 1, "")
	other := storedComment(ctx, "Second thought")
	mustFanout(ctx, other)
	var retries []map[string]string
	for _, entry := range ctx.Redis.LRange("notify:retry", 0, -1) {
		var e map[string]string
		json.Unmarshal([]byte(entry), &e)
		retries = append(retries, e)
	}
	ctx.Equal(retries, []map[string]string{{"tenant": "acme", "comment_id": other.ID, "request_id": other.ID}}, "after a failed notification, notify:retry (the retry must carry the request_id of the attempt it repeats)")
}

func CheckModerationFirst(ctx *harness.Ctx) {
	peers(ctx)
	ctx.GRPC.Fail("NotifyAuthor", codes.Unavailable, "", 1, "")
	c := storedComment(ctx, "Great write-up")
	outcome := mustFanout(ctx, c)
	ctx.Assert(len(ctx.GRPC.CallsTo("CheckComment", "")) > 0, "the notifier failed and moderation was never asked: the comment went live unmoderated. Moderate first; the notification is best effort")
	ctx.Assert(outcome == "allowed" && statusOf(c) == "allowed", "with moderation allowing it, the comment must be allowed despite the notifier failing; fanout returned %q, the store holds %q", outcome, statusOf(c))
	ctx.Equal(ctx.Redis.LLen("notify:retry"), 1, "the failed notification must be queued once on notify:retry; the entries")
	spam := storedComment(ctx, "Buy spam now")
	ctx.Equal(mustFanout(ctx, spam), "blocked", "a comment moderation rejects")
	ctx.Equal(statusOf(spam), "blocked", "the blocked comment's status")
	ctx.Assert(!contains(notifiedIDs(ctx), spam.ID), "the thread was notified about %s, a comment moderation blocked", spam.ID)
}

func CheckTimeoutReview(ctx *harness.Ctx) {
	peers(ctx)
	ctx.GRPC.Fail("CheckComment", codes.DeadlineExceeded, "", 1, "")
	c := storedComment(ctx, "Great write-up")
	outcome, err := fanout(fanoutBg, "acme", c)
	ctx.Assert(err == nil, "moderation ran out of time and fanout failed: %v. A moderation timeout is not a failed post: flag the comment pending_review and queue it for review", err)
	ctx.Assert(outcome == "pending_review" && statusOf(c) == "pending_review", "after a moderation timeout fanout returned %q and the store holds %q, expected pending_review", outcome, statusOf(c))
	ctx.Equal(ctx.Redis.LRange("review:queue", 0, -1), []string{"acme:" + c.ID}, "review:queue must hold the comment waiting for a moderator")
	ctx.Assert(!contains(notifiedIDs(ctx), c.ID), "a comment waiting for review must not be announced yet")
	ctx.GRPC.Fail("CheckComment", codes.Unavailable, "", 1, "")
	_, err = fanout(fanoutBg, "acme", storedComment(ctx, "Another"))
	ctx.Assert(err != nil, "moderation answered UNAVAILABLE and fanout returned a status: only a deadline becomes a review, other failures must reach the caller")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "comments/store.h"
#include "comments_service.grpc.pb.h"

namespace {

// Allows every comment that does not mention spam.
class ModerationPeer final : public commentsd::Moderation::Service {
 public:
  grpc::Status CheckComment(grpc::ServerContext*, const commentsd::CheckRequest* req, commentsd::Verdict* out) override {
    out->set_allowed(req->text().find("spam") == std::string::npos);
    return grpc::Status::OK;
  }
};

class NotifierPeer final : public commentsd::Notifier::Service {
 public:
  grpc::Status NotifyAuthor(grpc::ServerContext*, const commentsd::NotifyRequest*, commentsd::NotifyAck* out) override {
    out->set_queued(true);
    return grpc::Status::OK;
  }
};

struct Peers {
  ModerationPeer moderation;
  NotifierPeer notifier;
};

void peers(harness::Ctx& ctx) {
  static Peers* p = nullptr;
  delete p;
  p = new Peers;
  ctx.GRPC.Server("moderation:9000")->RegisterService(&p->moderation);
  ctx.GRPC.Server("notifier:9000")->RegisterService(&p->notifier);
}

store::Comment storedComment(const std::string& text) {
  return store::insert("acme", store::newComment("t-1", "", "u-1", text, text));
}

std::string statusOf(const store::Comment& c) { return store::get("acme", c.id)->status; }

bool notified(harness::Ctx& ctx, const std::string& id) {
  for (const auto& call : ctx.GRPC.CallsTo("NotifyAuthor")) {
    if (call.Request<commentsd::NotifyRequest>().comment_id() == id) return true;
  }
  return false;
}

std::string mustFanout(harness::Ctx& ctx, const store::Comment& c) {
  try {
    return fanout("acme", c);
  } catch (const std::exception& e) {
    ctx.Fatalf("fanout(%s) threw %s: %s", c.id, harness::CurrentExceptionType(), e.what());
  }
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  peers(ctx);
  ctx.Equal(mustFanout(ctx, storedComment("Great write-up")), "allowed", "a comment moderation allows");
  for (const std::string method : {"CheckComment", "NotifyAuthor"}) {
    const auto calls = ctx.GRPC.CallsTo(method);
    ctx.Assert(!calls.empty(), "no %s call was made for an allowed comment", method);
    for (const auto& call : calls) {
      ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a stalled service holds the comment's POST open for as long as it stalls", method);
      ctx.Assert(0.4 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 0.6, "a %s call carries a %v s deadline, expected kFanoutDeadline = 500 ms", method, call.TimeoutSeconds());
    }
  }
}

void CheckRequestId(harness::Ctx& ctx) {
  peers(ctx);
  const store::Comment c = storedComment("Great write-up");
  mustFanout(ctx, c);
  mustFanout(ctx, c);  // the job is redelivered: the same comment fans out again
  std::vector<std::string> ids;
  for (const auto& call : ctx.GRPC.CallsTo("CheckComment")) ids.push_back(call.Request<commentsd::CheckRequest>().request_id());
  for (const auto& call : ctx.GRPC.CallsTo("NotifyAuthor")) ids.push_back(call.Request<commentsd::NotifyRequest>().request_id());
  const bool same = !ids.empty() && std::all_of(ids.begin(), ids.end(), [&](const std::string& id) { return id == c.id; });
  ctx.Assert(same, "the calls about %s carried request_id %q: every attempt about one comment must carry its id, or a redelivered job looks like a new comment", c.id, ids);
  ctx.GRPC.Fail("NotifyAuthor", grpc::StatusCode::UNAVAILABLE);
  const store::Comment other = storedComment("Second thought");
  mustFanout(ctx, other);
  const auto entries = ctx.Redis.LRange("notify:retry", 0, -1);
  ctx.Equal(entries.size(), 1, "after a failed notification, the entries on notify:retry");
  const auto entry = nlohmann::json::parse(entries[0], nullptr, false);
  ctx.Assert(entry == nlohmann::json{{"tenant", "acme"}, {"comment_id", other.id}, {"request_id", other.id}},
             "after a failed notification notify:retry holds %s: the retry must carry the request_id of the attempt it repeats (%s)", entries[0], other.id);
}

void CheckModerationFirst(harness::Ctx& ctx) {
  peers(ctx);
  ctx.GRPC.Fail("NotifyAuthor", grpc::StatusCode::UNAVAILABLE);
  const store::Comment c = storedComment("Great write-up");
  const std::string outcome = mustFanout(ctx, c);
  ctx.Assert(!ctx.GRPC.CallsTo("CheckComment").empty(), "the notifier failed and moderation was never asked: the comment went live unmoderated. Moderate first; the notification is best effort");
  ctx.Assert(outcome == "allowed" && statusOf(c) == "allowed", "with moderation allowing it, the comment must be allowed despite the notifier failing; fanout returned %q, the store holds %q", outcome, statusOf(c));
  ctx.Equal(ctx.Redis.LLen("notify:retry"), 1, "the failed notification must be queued once on notify:retry; the entries");
  const store::Comment spam = storedComment("Buy spam now");
  ctx.Equal(mustFanout(ctx, spam), "blocked", "a comment moderation rejects");
  ctx.Equal(statusOf(spam), "blocked", "the blocked comment's status");
  ctx.Assert(!notified(ctx, spam.id), "the thread was notified about %s, a comment moderation blocked", spam.id);
}

void CheckTimeoutReview(harness::Ctx& ctx) {
  peers(ctx);
  ctx.GRPC.Fail("CheckComment", grpc::StatusCode::DEADLINE_EXCEEDED);
  const store::Comment c = storedComment("Great write-up");
  std::string outcome;
  try {
    outcome = fanout("acme", c);
  } catch (const std::exception& e) {
    ctx.Fatalf("moderation ran out of time and fanout threw %s: %s. A moderation timeout is not a failed post: flag the comment pending_review and queue it for review", harness::CurrentExceptionType(), e.what());
  }
  ctx.Assert(outcome == "pending_review" && statusOf(c) == "pending_review", "after a moderation timeout fanout returned %q and the store holds %q, expected pending_review", outcome, statusOf(c));
  ctx.Equal(ctx.Redis.LRange("review:queue", 0, -1), std::vector<std::string>{"acme:" + c.id}, "review:queue must hold the comment waiting for a moderator");
  ctx.Assert(!notified(ctx, c.id), "a comment waiting for review must not be announced yet");
  ctx.GRPC.Fail("CheckComment", grpc::StatusCode::UNAVAILABLE);
  bool threw = false;
  try {
    fanout("acme", storedComment("Another"));
  } catch (const std::exception&) {
    threw = true;
  }
  ctx.Assert(threw, "moderation answered UNAVAILABLE and fanout returned a status: only a deadline becomes a review, other failures must reach the caller");
}
`,
  },
  hints: [
    'Slow moderation down and a POST waits as long as it does. Stop the notifier and comments go live that moderation never saw. Redeliver one job and the thread is notified twice.',
    'Neither call has a deadline; each attempt mints its own `request_id`; the notifier runs first and its `except` returns, so moderation is skipped when it fails. A moderation timeout is an `RpcError` nobody catches.',
    'Call `CheckComment` first with `timeout=FANOUT_DEADLINE_S` and `request_id=comment["id"]`; on `DEADLINE_EXCEEDED` set `pending_review` and `store.enqueue_review`; notify only `allowed` comments, same id, and queue that id when it fails.',
  ],
  debrief: `The order is the decision: moderation says whether a comment may be seen, the notification only advertises it, so the call that decides runs first and nothing the advertiser does can skip it. The deadline turns a slow dependency into a known outcome, and for moderation that outcome is a human review rather than a failed post, because the author did nothing wrong. Using the comment id as \`request_id\` (the request-identification pattern of Google's AIP-155) is what lets a redelivered job reach the same moderation decision and the same notification instead of new ones. This step still fans out inside the request; a production service moves the fan-out to a queue after the commit, where redelivery is routine and the request id earns its keep.`,
};
