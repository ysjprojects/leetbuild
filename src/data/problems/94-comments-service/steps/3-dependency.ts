import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Moderation and notification calls that apply once',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'moderation', 'notifier', 'review'],
  task: `## Task

**Starting point.** The starter's \`fanout\` calls the notifier first with a fresh \`uuid4\` as its
\`idempotency-token\`, queues a retry entry with another fresh UUID when that call raises, and
otherwise calls moderation with no deadline and returns \`allowed\` or \`blocked\`. It compiles, the
happy path answers correctly, and it hides five flaws.

**Failure mode the checks target.** A single comment eventually rings the author twice, because the
retry carries a token neither service has seen; a slow moderation service holds the write open
instead of flagging the comment for review; and a notifier exception returns before moderation runs,
so a failed ping ships an unchecked comment.

- Both calls run under a **500 ms deadline** (\`FANOUT_DEADLINE_MS = 500\`, applied as the call
  timeout / \`withDeadlineAfter\` / \`set_deadline\`).
- Every attempt of one comment's fan-out carries the **same idempotency token**, derived from the
  comment id by one function (\`idempotency_token(comment_id)\` → \`comment:{id}\`) and sent as the
  \`idempotency-token\` metadata on the moderation call, the notification call and any retry.
- **Moderation runs first**; a notification failure cannot cancel it. Moderation is the decision
  the product depends on; the ping is best-effort.
- A moderation call that hits the deadline is **not** a failed post: flag the comment
  \`pending_review\`, enqueue it on the review queue, and answer the write successfully. Other
  moderation failures still surface as errors.
- When the notification call fails, enqueue a retry entry that carries the **same token**
  (\`token: idempotency_token(comment_id)\` / \`Token: idempotencyToken(commentID)\`).
- Return the moderation outcome (\`allowed\` / \`blocked\` / \`pending_review\`) to the caller.`,
  sequence: {
    participants: ['Comments API', 'Moderation', 'Notifier', 'Review queue'],
    messages: [
      {
        from: 'Comments API',
        to: 'Moderation',
        label: 'CheckComment · metadata idempotency-token = comment:{id} · deadline 500 ms',
        kind: 'sync',
      },
      {from: 'Moderation', to: 'Comments API', label: 'allowed / blocked', kind: 'reply'},
      {from: 'Moderation', to: 'Comments API', label: 'DEADLINE_EXCEEDED → pending_review', kind: 'reply'},
      {from: 'Comments API', to: 'Review queue', label: 'enqueue(comment_id)', kind: 'async'},
      {
        from: 'Comments API',
        to: 'Notifier',
        label: 'NotifyAuthor · same idempotency-token · deadline 500 ms',
        kind: 'sync',
      },
      {from: 'Comments API', to: 'Comments API', label: 'retry entry carries the same token', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Bounds every fan-out call with a 500 ms deadline',
      detail:
        'Both calls run under `FANOUT_DEADLINE_MS = 500`, applied as the call deadline. The starter calls moderation with no deadline at all, so a slow moderation service holds the write open.',
      match: {
        python: {all: [/FANOUT_DEADLINE_MS = 500/, /timeout=FANOUT_DEADLINE_S/]},
        typescript: {all: [/FANOUT_DEADLINE_MS = 500/, /deadline: Date\.now\(\) \+ FANOUT_DEADLINE_MS/]},
        go: {all: [/fanoutDeadlineMS = 500/, /context\.WithTimeout\(/]},
        scala: {all: [/FanoutDeadlineMs = 500/, /withDeadlineAfter\(/]},
        cpp: {all: [/kFanoutDeadlineMs = 500/, /set_deadline\(/]},
      },
    },
    {
      id: 'shared-token',
      title: 'Derives one token from the comment id and reuses it',
      detail:
        '`idempotency_token(comment_id)` returns `comment:{id}` and that same value is sent as the `idempotency-token` metadata on every attempt, including retries. The starter mints a fresh UUID per attempt.',
      match: {
        python: {
          all: [/def idempotency_token\(/, /"idempotency-token"/, /idempotency_token\(comment_id\)/],
          none: [/uuid\.uuid4\(\)/],
        },
        typescript: {
          all: [/function idempotencyToken\(/, /'idempotency-token'/, /idempotencyToken\(commentId\)/],
          none: [/randomUUID\(\)/],
        },
        go: {
          all: [/func idempotencyToken\(/, /"idempotency-token"/, /idempotencyToken\(commentID\)/],
          none: [/uuid\.NewString\(\)/],
        },
        scala: {
          all: [/def idempotencyToken\(/, /"idempotency-token"/, /idempotencyToken\(commentId\)/],
          none: [/UUID\.randomUUID\(\)/],
        },
        cpp: {
          all: [/idempotencyToken\(/, /"idempotency-token"/, /idempotencyToken\(commentId\)/],
          none: [/uuidString\(\)/],
        },
      },
    },
    {
      id: 'timeout-review',
      title: 'Flags a moderation timeout for asynchronous review',
      detail:
        'A `DEADLINE_EXCEEDED` from moderation sets the status to `pending_review` and enqueues the comment on `review_queue` instead of failing the write. The starter lets the timeout surface as a failed post.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /pending_review/, /review_queue\.enqueue\(/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /pending_review/, /reviewQueue\.enqueue\(/]},
        go: {all: [/codes\.DeadlineExceeded/, /pending_review/, /reviewQueue\.Enqueue\(/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /pending_review/, /reviewQueue\.enqueue\(/]},
        cpp: {all: [/DEADLINE_EXCEEDED/, /pending_review/, /review_queue\.enqueue\(/]},
      },
    },
    {
      id: 'isolate',
      title: 'Moderation survives a notification failure',
      detail:
        'Moderation is called before the notification, so a notifier exception cannot skip it. The starter notifies first and returns from the catch block, shipping an unchecked comment.',
      match: {
        python: {order: [/moderation\.Check\(/, /notifier\.Notify\(/]},
        typescript: {order: [/moderation\.Check\(/, /notifier\.Notify\(/]},
        go: {order: [/moderation\.Check\(/, /notifier\.Notify\(/]},
        scala: {order: [/\.check\(/, /\.notify\(/]},
        cpp: {order: [/moderation->Check\(/, /notifier->Notify\(/]},
      },
    },
    {
      id: 'retry-token',
      title: 'Queues the retry with the same token',
      detail:
        'The retry entry written when the notification fails carries `idempotency_token(comment_id)`, the same token as the attempt that failed, so the replay pings the author once.',
      match: {
        python: {all: [/retry_queue\.put\(/, /"token": idempotency_token\(comment_id\)/]},
        typescript: {all: [/retryQueue\.put\(/, /token: idempotencyToken\(commentId\)/]},
        go: {all: [/retryQueue\.Put\(/, /Token: idempotencyToken\(commentID\)/]},
        scala: {all: [/retryQueue\.put\(/, /"token" -> idempotencyToken\(commentId\)/]},
        cpp: {all: [/retryQueue\.put\(/, /RetryEntry\{[^}]*idempotencyToken\(commentId\)[^}]*\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

import grpc
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import moderation_pb2
import notification_pb2

app = FastAPI()


class CommentRequest(BaseModel):
    comment_id: str
    thread_id: str
    author_id: str


class ReviewQueue:
    def enqueue(self, comment_id: str) -> None:
        raise NotImplementedError


class RetryQueue:
    def put(self, entry: dict) -> None:
        raise NotImplementedError


review_queue = ReviewQueue()
retry_queue = RetryQueue()
moderation = moderation_pb2.ModerationStub()
notifier = notification_pb2.NotifierStub()


def fanout(comment_id: str, thread_id: str, author_id: str) -> str:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    try:
        notifier.Notify(
            notification_pb2.NotifyRequest(comment_id=comment_id, author_id=author_id),
            metadata=(("idempotency-token", str(uuid.uuid4())),),
        )
    except grpc.RpcError:
        retry_queue.put({"comment_id": comment_id, "token": str(uuid.uuid4())})
        return "pending"
    reply = moderation.Check(moderation_pb2.CheckRequest(comment_id=comment_id, thread_id=thread_id))
    return "allowed" if reply.allowed else "blocked"


@app.post("/v1/comments")
def create_comment(body: CommentRequest, tenant: str = Header(default="", alias="X-Tenant-Id")) -> JSONResponse:
    return JSONResponse({"id": body.comment_id, "moderation": fanout(body.comment_id, body.thread_id, body.author_id)})
`,
      solution: `import grpc
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import moderation_pb2
import notification_pb2

app = FastAPI()

FANOUT_DEADLINE_MS = 500
FANOUT_DEADLINE_S = FANOUT_DEADLINE_MS / 1000


class CommentRequest(BaseModel):
    comment_id: str
    thread_id: str
    author_id: str


class ReviewQueue:
    def enqueue(self, comment_id: str) -> None:
        raise NotImplementedError


class RetryQueue:
    def put(self, entry: dict) -> None:
        raise NotImplementedError


review_queue = ReviewQueue()
retry_queue = RetryQueue()
moderation = moderation_pb2.ModerationStub()
notifier = notification_pb2.NotifierStub()


def idempotency_token(comment_id: str) -> str:
    """The token every attempt of one comment's fan-out carries: derived from the comment id."""
    return f"comment:{comment_id}"


def fanout(comment_id: str, thread_id: str, author_id: str) -> str:
    """Moderation first, notification after: a ping that fails must never cancel moderation."""
    status = "allowed"
    try:
        reply = moderation.Check(
            moderation_pb2.CheckRequest(comment_id=comment_id, thread_id=thread_id),
            timeout=FANOUT_DEADLINE_S,
            metadata=(("idempotency-token", idempotency_token(comment_id)),),
        )
        status = "allowed" if reply.allowed else "blocked"
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
            status = "pending_review"
            review_queue.enqueue(comment_id)
        else:
            raise
    try:
        notifier.Notify(
            notification_pb2.NotifyRequest(comment_id=comment_id, author_id=author_id),
            timeout=FANOUT_DEADLINE_S,
            metadata=(("idempotency-token", idempotency_token(comment_id)),),
        )
    except grpc.RpcError:
        retry_queue.put(
            {"comment_id": comment_id, "author_id": author_id, "token": idempotency_token(comment_id)}
        )
    return status


@app.post("/v1/comments")
def create_comment(body: CommentRequest, tenant: str = Header(default="", alias="X-Tenant-Id")) -> JSONResponse:
    return JSONResponse({"id": body.comment_id, "moderation": fanout(body.comment_id, body.thread_id, body.author_id)})
`,
    },
    typescript: {
      starter: `/** Comment fan-out: flawed code that pings twice and skips moderation. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {randomUUID} from 'node:crypto';

const {comments} = grpc.loadPackageDefinition(protoLoader.loadSync('comments.proto')) as unknown as {
  comments: {
    Moderation: new (target: string, credentials: grpc.ChannelCredentials) => ModerationClient;
    Notifier: new (target: string, credentials: grpc.ChannelCredentials) => NotifierClient;
  };
};

interface ModerationClient {
  Check(request: {comment_id: string; thread_id: string}, metadata: grpc.Metadata): Promise<{allowed: boolean}>;
}

interface NotifierClient {
  Notify(request: {comment_id: string; author_id: string}, metadata: grpc.Metadata): Promise<unknown>;
}

export const moderation = new comments.Moderation('moderation:9000', grpc.credentials.createInsecure());
export const notifier = new comments.Notifier('notifier:9000', grpc.credentials.createInsecure());

export const reviewQueue = {enqueue: async (_commentId: string): Promise<void> => {}};
export const retryQueue = {put: async (_entry: {comment_id: string; author_id: string; token: string}): Promise<void> => {}};

export async function fanout(commentId: string, threadId: string, authorId: string): Promise<string> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const meta = new grpc.Metadata();
  meta.set('idempotency-token', randomUUID());
  try {
    await notifier.Notify({comment_id: commentId, author_id: authorId}, meta);
  } catch {
    await retryQueue.put({comment_id: commentId, author_id: authorId, token: randomUUID()});
    return 'pending';
  }
  const reply = await moderation.Check({comment_id: commentId, thread_id: threadId}, meta);
  return reply.allowed ? 'allowed' : 'blocked';
}
`,
      solution: `/** Comment fan-out: one token per comment, a deadline on every call, moderation first. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const FANOUT_DEADLINE_MS = 500;

const {comments} = grpc.loadPackageDefinition(protoLoader.loadSync('comments.proto')) as unknown as {
  comments: {
    Moderation: new (target: string, credentials: grpc.ChannelCredentials) => ModerationClient;
    Notifier: new (target: string, credentials: grpc.ChannelCredentials) => NotifierClient;
  };
};

interface ModerationClient {
  Check(
    request: {comment_id: string; thread_id: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
  ): Promise<{allowed: boolean}>;
}

interface NotifierClient {
  Notify(
    request: {comment_id: string; author_id: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
  ): Promise<unknown>;
}

export const moderation = new comments.Moderation('moderation:9000', grpc.credentials.createInsecure());
export const notifier = new comments.Notifier('notifier:9000', grpc.credentials.createInsecure());

export const reviewQueue = {enqueue: async (_commentId: string): Promise<void> => {}};
export const retryQueue = {
  put: async (_entry: {comment_id: string; author_id: string; token: string}): Promise<void> => {},
};

/** The token every attempt of one comment's fan-out carries: derived from the comment id. */
function idempotencyToken(commentId: string): string {
  return \`comment:\${commentId}\`;
}

function metadataFor(commentId: string): grpc.Metadata {
  const meta = new grpc.Metadata();
  meta.set('idempotency-token', idempotencyToken(commentId));
  return meta;
}

/** Moderation first, notification after: a ping that fails must never cancel moderation. */
export async function fanout(commentId: string, threadId: string, authorId: string): Promise<string> {
  let status = 'allowed';
  try {
    const reply = await moderation.Check({comment_id: commentId, thread_id: threadId}, metadataFor(commentId), {
      deadline: Date.now() + FANOUT_DEADLINE_MS,
    });
    status = reply.allowed ? 'allowed' : 'blocked';
  } catch (error) {
    const serviceError = error as grpc.ServiceError;
    if (serviceError.code !== grpc.status.DEADLINE_EXCEEDED) throw serviceError;
    status = 'pending_review';
    await reviewQueue.enqueue(commentId);
  }
  try {
    await notifier.Notify({comment_id: commentId, author_id: authorId}, metadataFor(commentId), {
      deadline: Date.now() + FANOUT_DEADLINE_MS,
    });
  } catch {
    await retryQueue.put({comment_id: commentId, author_id: authorId, token: idempotencyToken(commentId)});
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
	"google.golang.org/grpc/metadata"
)

type RetryEntry struct {
	CommentID string
	AuthorID  string
	Token     string
}

var (
	moderation ModerationClient
	notifier   NotifierClient
	retryQueue RetryQueue
)

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
func Fanout(ctx context.Context, commentID, threadID, authorID string) (string, error) {
	ctx = metadata.AppendToOutgoingContext(ctx, "idempotency-token", uuid.NewString())
	if _, err := notifier.Notify(ctx, &NotifyRequest{CommentId: commentID, AuthorId: authorID}); err != nil {
		retryQueue.Put(ctx, RetryEntry{CommentID: commentID, AuthorID: authorID, Token: uuid.NewString()})
		return "pending", nil
	}
	reply, err := moderation.Check(ctx, &CheckRequest{CommentId: commentID, ThreadId: threadID})
	if err != nil {
		return "", err
	}
	if reply.Allowed {
		return "allowed", nil
	}
	return "blocked", nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const fanoutDeadlineMS = 500

type RetryEntry struct {
	CommentID string
	AuthorID  string
	Token     string
}

var (
	moderation  ModerationClient
	notifier    NotifierClient
	retryQueue  RetryQueue
	reviewQueue ReviewQueue
)

// idempotencyToken is the token every attempt of one comment's fan-out carries.
func idempotencyToken(commentID string) string {
	return "comment:" + commentID
}

func tokenContext(ctx context.Context, commentID string) context.Context {
	return metadata.AppendToOutgoingContext(ctx, "idempotency-token", idempotencyToken(commentID))
}

// Fanout calls moderation first and the notifier after: a ping that fails must never cancel
// moderation, and a retry reuses the token of the attempt that failed.
func Fanout(ctx context.Context, commentID, threadID, authorID string) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, fanoutDeadlineMS*time.Millisecond)
	defer cancel()
	callCtx = tokenContext(callCtx, commentID)

	verdict := "allowed"
	reply, err := moderation.Check(callCtx, &CheckRequest{CommentId: commentID, ThreadId: threadID})
	switch status.Code(err) {
	case codes.OK:
		if reply.Allowed {
			verdict = "allowed"
		} else {
			verdict = "blocked"
		}
	case codes.DeadlineExceeded:
		verdict = "pending_review"
		reviewQueue.Enqueue(callCtx, commentID)
	default:
		return "", err
	}
	if _, err := notifier.Notify(callCtx, &NotifyRequest{CommentId: commentID, AuthorId: authorID}); err != nil {
		retryQueue.Put(callCtx, RetryEntry{CommentID: commentID, AuthorID: authorID, Token: idempotencyToken(commentID)})
	}
	return verdict, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException, Metadata}

object CommentFanout {
  val moderation = ModerationGrpc.blockingStub(ManagedChannelBuilder.forAddress("moderation", 9000).usePlaintext().build())
  val notifier = NotifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("notifier", 9000).usePlaintext().build())
  val reviewQueue = ReviewQueue()
  val retryQueue = RetryQueue()

  def metadataWith(token: String): Metadata = {
    val meta = new Metadata()
    meta.put(Metadata.Key.of("idempotency-token", Metadata.ASCII_STRING_MARSHALLER), token)
    meta
  }

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def fanout(commentId: String, threadId: String, authorId: String): String = {
    try {
      notifier.notify(
        NotifyRequest(commentId = commentId, authorId = authorId),
        metadataWith(java.util.UUID.randomUUID().toString)
      )
    } catch {
      case _: StatusRuntimeException =>
        retryQueue.put(Map("comment_id" -> commentId, "token" -> java.util.UUID.randomUUID().toString))
        return "pending"
    }
    val reply = moderation.check(CheckRequest(commentId = commentId, threadId = threadId))
    if (reply.allowed) "allowed" else "blocked"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Metadata, Status, StatusRuntimeException}

object CommentFanout {
  val FanoutDeadlineMs = 500L

  val moderation = ModerationGrpc.blockingStub(ManagedChannelBuilder.forAddress("moderation", 9000).usePlaintext().build())
  val notifier = NotifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("notifier", 9000).usePlaintext().build())
  val reviewQueue = ReviewQueue()
  val retryQueue = RetryQueue()

  /** The token every attempt of one comment's fan-out carries: derived from the comment id. */
  def idempotencyToken(commentId: String): String = s"comment:$commentId"

  def metadataFor(commentId: String): Metadata = {
    val meta = new Metadata()
    meta.put(Metadata.Key.of("idempotency-token", Metadata.ASCII_STRING_MARSHALLER), idempotencyToken(commentId))
    meta
  }

  /** Moderation first, notification after: a ping that fails must never cancel moderation. */
  def fanout(commentId: String, threadId: String, authorId: String): String = {
    var verdict = "allowed"
    try {
      val reply = moderation
        .withDeadlineAfter(FanoutDeadlineMs, TimeUnit.MILLISECONDS)
        .check(CheckRequest(commentId = commentId, threadId = threadId), metadataFor(commentId))
      verdict = if (reply.allowed) "allowed" else "blocked"
    } catch {
      case exc: StatusRuntimeException if exc.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
        verdict = "pending_review"
        reviewQueue.enqueue(commentId)
    }
    try {
      notifier
        .withDeadlineAfter(FanoutDeadlineMs, TimeUnit.MILLISECONDS)
        .notify(NotifyRequest(commentId = commentId, authorId = authorId), metadataFor(commentId))
    } catch {
      case _: StatusRuntimeException =>
        retryQueue.put(Map("comment_id" -> commentId, "author_id" -> authorId, "token" -> idempotencyToken(commentId)))
    }
    verdict
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "comments.grpc.pb.h"

#include <map>
#include <memory>
#include <string>

struct RetryEntry {
  std::string commentId;
  std::string authorId;
  std::string token;
};

std::unique_ptr<Moderation::Stub> moderation;
std::unique_ptr<Notifier::Stub> notifier;
RetryQueue retryQueue;
std::string uuidString();

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
std::string fanout(const std::string& commentId, const std::string& threadId, const std::string& authorId) {
  NotifyRequest notifyRequest;
  notifyRequest.set_comment_id(commentId);
  notifyRequest.set_author_id(authorId);
  NotifyReply notifyReply;
  grpc::ClientContext notifyContext;
  notifyContext.AddMetadata("idempotency-token", uuidString());
  if (!notifier->Notify(&notifyContext, notifyRequest, &notifyReply).ok()) {
    retryQueue.put(RetryEntry{commentId, authorId, uuidString()});
    return "pending";
  }
  CheckRequest checkRequest;
  checkRequest.set_comment_id(commentId);
  checkRequest.set_thread_id(threadId);
  CheckReply checkReply;
  grpc::ClientContext checkContext;
  if (moderation->Check(&checkContext, checkRequest, &checkReply).ok() && checkReply.allowed()) {
    return "allowed";
  }
  return "blocked";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "comments.grpc.pb.h"

#include <chrono>
#include <memory>
#include <string>

constexpr int kFanoutDeadlineMs = 500;

struct RetryEntry {
  std::string commentId;
  std::string authorId;
  std::string token;
};

std::unique_ptr<Moderation::Stub> moderation;
std::unique_ptr<Notifier::Stub> notifier;
ReviewQueue review_queue;
RetryQueue retryQueue;

// idempotencyToken is the token every attempt of one comment's fan-out carries.
static std::string idempotencyToken(const std::string& commentId) { return "comment:" + commentId; }

static void attachToken(grpc::ClientContext& ctx, const std::string& commentId) {
  ctx.AddMetadata("idempotency-token", idempotencyToken(commentId));
}

// fanout calls moderation first and the notifier after: a ping that fails must never cancel
// moderation, and a retry reuses the token of the attempt that failed.
std::string fanout(const std::string& commentId, const std::string& threadId, const std::string& authorId) {
  std::string verdict = "allowed";
  {
    grpc::ClientContext ctx;
    attachToken(ctx, commentId);
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kFanoutDeadlineMs));
    CheckRequest request;
    request.set_comment_id(commentId);
    request.set_thread_id(threadId);
    CheckReply reply;
    const grpc::Status status = moderation->Check(&ctx, request, &reply);
    if (status.ok()) {
      verdict = reply.allowed() ? "allowed" : "blocked";
    } else if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      verdict = "pending_review";
      review_queue.enqueue(commentId);
    } else {
      return "";
    }
  }
  {
    grpc::ClientContext ctx;
    attachToken(ctx, commentId);
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kFanoutDeadlineMs));
    NotifyRequest request;
    request.set_comment_id(commentId);
    request.set_author_id(authorId);
    NotifyReply reply;
    if (!notifier->Notify(&ctx, request, &reply).ok()) {
      retryQueue.put(RetryEntry{commentId, authorId, idempotencyToken(commentId)});
    }
  }
  return verdict;
}
`,
    },
  },
  hints: [
    'An author gets two pings for one reply after a notifier blip; a post hangs for as long as moderation takes; when the notifier is down, comments go live that moderation never saw.',
    'Each `uuid.uuid4()` is a new identity, so the retry looks like a new comment to the notifier. Moderation has no `timeout`, and the `except` returns before `moderation.Check` is ever reached.',
    '`moderation.Check` first, with `timeout=FANOUT_DEADLINE_S`; `DEADLINE_EXCEEDED` becomes `pending_review` plus `review_queue.enqueue`. Then `notifier.Notify` in its own `try`, with `idempotency_token(comment_id)` on the call and in the `retry_queue.put` entry.',
  ],
  debrief: `The fix has the shape of three answers. Who decides the outcome? Moderation, so it runs first and a best-effort side effect cannot cancel it; the starter reversed that and shipped an unchecked comment whenever the notifier hiccupped. What is the unit of identity? The comment, not the attempt: one token derived from the comment id means the retry the queue eventually performs lands on the same moderation check and the same notification instead of creating two of each. What does a timeout mean? Not failure but "unknown", so the comment is accepted and flagged for asynchronous review, which keeps the write path's latency bounded. Production platforms give the review queue a deadline of its own, put a circuit breaker in front of each dependency, and have the notification service deduplicate on the token server-side as a second line of defence.`,
};
