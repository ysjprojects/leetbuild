import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Attendee notification calls with change-kind semantics',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'notifier', 'attendee'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: when an event write commits, the
notify path calls the notifier and one invitation leaves per attendee, so the demo looks right. The
draft sends the RPC with no deadline, always declares a full invitation, mints a token inside the retry
loop and cancels removed attendees whose create never left the service. Review it like the service
owner, fix the notify path, and prove the fix with the checks below.

\`notify_attendees(prev, next, removed)\` runs after the event write commits. It must:

- Set a **3 s deadline** on every notification call — \`timeout=3.0\` in Python, a deadline built from
  \`Date.now() + 3000\` in TypeScript, a context with \`3*time.Second\` in Go, \`DeadlineAfter(3, SECONDS)\`
  in Scala, a 3 s channel deadline in C++ — and keep the number in a named constant
  (\`NOTIFY_DEADLINE_S\` and its per-language equivalents). The draft sends the call with no deadline at
  all, so one stuck notifier pins the API worker.
- Declare the change kind on the request: \`CHANGE_KIND_CREATE\`, \`CHANGE_KIND_UPDATE\`,
  \`CHANGE_KIND_CANCEL\` or \`CHANGE_KIND_INSTANCE_EXCEPTION\`, computed from the diff of \`prev\` and
  \`next\` rather than chosen at the call site. The draft sends a full invitation for every write.
- Classify a **content-preserving change** as an update: a timezone-only or title-only correction leaves
  the content fields (\`start\`, \`end\`, \`attendees\`, \`rrule\`) untouched, so \`classify_change\` returns the
  update kind and no attendee re-responds. The draft escalates the correction to a create.
- Derive the **idempotency token from the change**, not from the attempt:
  \`idempotency_token(event_id, revision, kind)\`, or a stored token read before the loop, so a retry
  after a timeout sends the same token. The draft calls the random-uuid generator inside the retry loop.
- Send a \`cancel\` only when the original \`create\` was delivered: keep a \`DELIVERED_CREATES\` record and
  skip the removed attendee whose create never went out. The draft cancels every removed attendee.
- Bound the retries: at most **3** attempts, only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retryable,
  and the kind and the token are computed once, outside the loop.

**Failure mode the checks target.** The token is the subtle one. Computing it inside the retry loop
looks idempotent — the RPC carries a token, so the notifier dedupes — but the first attempt times out,
the retry mints a new token, and the attendee gets a second invitation. The draft hides two more
escalations: a timezone correction arrives as a full invite, and a cancel leaves for an attendee whose
create never reached the mailer.`,
  sequence: {
    participants: ['Calendar API', 'Postgres', 'Notifier', 'Attendee mailer'],
    messages: [
      {from: 'Calendar API', to: 'Postgres', label: 'UPDATE event · revision 41', kind: 'sync'},
      {from: 'Postgres', to: 'Calendar API', label: 'prev + next · committed', kind: 'reply'},
      {
        from: 'Calendar API',
        to: 'Calendar API',
        label: 'classify_change(prev, next) → update · token = idempotency_token(event, revision, kind)',
        kind: 'sync',
      },
      {from: 'Calendar API', to: 'Notifier', label: 'NotifyAttendees(change_kind, token) · deadline 3 s', kind: 'sync'},
      {from: 'Notifier', to: 'Calendar API', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Calendar API', to: 'Notifier', label: 'retry · same kind, same token', kind: 'sync'},
      {from: 'Notifier', to: 'Attendee mailer', label: 'one mail per change', kind: 'async'},
      {from: 'Notifier', to: 'Calendar API', label: 'OK · create delivered', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every notification call carries a 3 s deadline',
      detail:
        'The RPC is issued with a 3 s deadline built from a named constant (`NOTIFY_DEADLINE_S = 3`, `NOTIFY_DEADLINE_MS = 3000`, `notifyDeadlineS = 3`, `NotifyDeadlineS = 3`, `kNotifyDeadlineS = 3`) and passed on the call itself (`timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`). The draft sends the call with no deadline at all, so a notifier that never answers pins the API worker.',
      match: {
        python: {all: [/NOTIFY_DEADLINE_S\s*=\s*3/, /timeout=NOTIFY_DEADLINE_S/]},
        typescript: {all: [/NOTIFY_DEADLINE_MS\s*=\s*3000/, /deadline:\s*Date\.now\(\)\s*\+\s*NOTIFY_DEADLINE_MS/]},
        go: {all: [/notifyDeadlineS\s*=\s*3/, /context\.WithTimeout\(.*notifyDeadlineS/]},
        scala: {all: [/NotifyDeadlineS\s*=\s*3/, /withDeadlineAfter\(NotifyDeadlineS,\s*TimeUnit\.SECONDS\)/]},
        cpp: {all: [/kNotifyDeadlineS\s*=\s*3/, /set_deadline\(/]},
      },
    },
    {
      id: 'change-kind',
      title: 'The request declares the change kind computed from the diff',
      detail:
        'The request carries a change kind — `CHANGE_KIND_CREATE`, `CHANGE_KIND_UPDATE`, `CHANGE_KIND_CANCEL`, `CHANGE_KIND_INSTANCE_EXCEPTION` and their per-language names — set from the diff of `prev` and `next`, not hard-coded at the call site. The draft sends a full invitation for every write.',
      match: {
        python: {
          all: [
            /CHANGE_KIND_CREATE\s*=\s*"create"/,
            /CHANGE_KIND_UPDATE\s*=\s*"update"/,
            /CHANGE_KIND_CANCEL\s*=\s*"cancel"/,
            /CHANGE_KIND_INSTANCE_EXCEPTION\s*=\s*"instance-exception"/,
            /kind=kind/,
          ],
        },
        typescript: {
          all: [
            /CHANGE_KIND_CREATE\s*=\s*'create'/,
            /CHANGE_KIND_UPDATE\s*=\s*'update'/,
            /CHANGE_KIND_CANCEL\s*=\s*'cancel'/,
            /CHANGE_KIND_INSTANCE_EXCEPTION\s*=\s*'instance-exception'/,
            /kind,\s+idempotencyToken/,
          ],
        },
        go: {
          all: [
            /changeKindCreate\s*=\s*"create"/,
            /changeKindUpdate\s*=\s*"update"/,
            /changeKindCancel\s*=\s*"cancel"/,
            /changeKindInstanceException\s*=\s*"instance-exception"/,
            /Kind:\s+kind/,
          ],
        },
        scala: {
          all: [
            /ChangeKindCreate\s*=\s*"create"/,
            /ChangeKindUpdate\s*=\s*"update"/,
            /ChangeKindCancel\s*=\s*"cancel"/,
            /ChangeKindInstanceException\s*=\s*"instance-exception"/,
            /kind = kind/,
          ],
        },
        cpp: {
          all: [
            /kChangeKindCreate\s*(?:\[\])?\s*=\s*"create"/,
            /kChangeKindUpdate\s*(?:\[\])?\s*=\s*"update"/,
            /kChangeKindCancel\s*(?:\[\])?\s*=\s*"cancel"/,
            /kChangeKindInstanceException\s*(?:\[\])?\s*=\s*"instance-exception"/,
            /set_kind\(kind\)/,
          ],
        },
      },
    },
    {
      id: 'preserving-update',
      title: 'A content-preserving change stays an update, not a new invite',
      detail:
        'A timezone-only or title-only correction leaves the content fields (`start`, `end`, `attendees`, `rrule`) untouched, so the diff helper — `classify_change`/`classifyChange` with a `content_unchanged`/`contentUnchanged` notion — returns the update kind instead of escalating to a create. The draft sends `create` for every write.',
      match: {
        python: {all: [/def classify_change\(/, /content_unchanged\(/, /return CHANGE_KIND_UPDATE/]},
        typescript: {all: [/function classifyChange\(prev/, /contentUnchanged\(/, /return CHANGE_KIND_UPDATE/]},
        go: {all: [/func classifyChange\(prev/, /contentUnchanged\(/, /return changeKindUpdate/]},
        scala: {all: [/def classifyChange\(prev/, /contentUnchanged\(/, /ChangeKindUpdate/]},
        cpp: {all: [/classifyChange\(prev/, /contentUnchanged\(/, /kChangeKindUpdate/]},
      },
    },
    {
      id: 'shared-token',
      title: 'Retries reuse one token derived from the change',
      detail:
        'The token is computed once, before the retry loop, from the event id, revision and kind — `idempotency_token(event_id, revision, kind)` and its per-language names, or a token read from a stored record — so every attempt of the same change sends the same token. The draft calls a random-uuid generator inside the loop, so the retry after a timeout invites the attendee twice.',
      match: {
        python: {all: [/idempotency_token\(/, /uuid\.uuid5\(/], none: [/uuid\.uuid4\(\)/]},
        typescript: {all: [/idempotencyToken\(/, /createHash\(/], none: [/randomUUID\(/]},
        go: {all: [/idempotencyToken\(/, /sha256\.Sum256\(/], none: [/uuid\.NewString\(\)/]},
        scala: {all: [/idempotencyToken\(/, /nameUUIDFromBytes\(/], none: [/UUID\.randomUUID\(\)/]},
        cpp: {all: [/idempotencyToken\(/, /std::hash<std::string>/], none: [/random_device/]},
      },
    },
    {
      id: 'delivered-creates',
      title: 'Cancels pair only with delivered creates',
      detail:
        'A `cancel` leaves only when the original `create` was delivered: the notify path keeps a `DELIVERED_CREATES` record — or reads a delivery record — and skips the removed attendee whose create never went out. The draft cancels every removed attendee, so the mailer receives a cancel for an invitation it never sent.',
      match: {
        python: {all: [/DELIVERED_CREATES/, /if event_id not in DELIVERED_CREATES:/, /CHANGE_KIND_CANCEL/]},
        typescript: {
          all: [/DELIVERED_CREATES/, /if \(!DELIVERED_CREATES\.has\(eventId\)\) continue;/, /CHANGE_KIND_CANCEL/],
        },
        go: {all: [/deliveredCreates/, /if !deliveredCreates\[eventID\]/, /changeKindCancel/]},
        scala: {all: [/DeliveredCreates/, /DeliveredCreates\.contains\(eventId\)/, /ChangeKindCancel/]},
        cpp: {all: [/deliveredCreates/, /deliveredCreates\.find\(event_id\)/, /kChangeKindCancel/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

import grpc
import notifications_pb2
import notifications_pb2_grpc

channel = grpc.insecure_channel("notifier:9001")
notifier = notifications_pb2_grpc.NotifierStub(channel)


def notify_attendees(event_id: str, revision: int, prev: dict, next: dict, removed: list[str]) -> None:
    # TODO: this draft sends no deadline, always declares a full invitation, mints a fresh token on
    # every attempt and cancels removed attendees whose create was never delivered. Give each call a
    # 3 s deadline from a named constant, compute the change kind from the diff of prev and next,
    # classify a timezone-only correction as an update, derive the idempotency token from the change
    # so retries share it, and keep a delivered-creates record before cancelling.
    for attendee in removed:
        for _ in range(3):
            request = notifications_pb2.NotifyRequest(
                event_id=event_id,
                revision=revision,
                kind="cancel",
                idempotency_token=str(uuid.uuid4()),
                attendee=attendee,
            )
            try:
                notifier.NotifyAttendees(request)
                break
            except grpc.RpcError:
                continue
    for _ in range(3):
        request = notifications_pb2.NotifyRequest(
            event_id=event_id,
            revision=revision,
            kind="create",
            idempotency_token=str(uuid.uuid4()),
        )
        try:
            notifier.NotifyAttendees(request)
            return
        except grpc.RpcError:
            continue
`,
      solution: `"""Notify path: a 3 s deadline, a change kind from the diff and one token per change."""
import uuid

import grpc
import notifications_pb2
import notifications_pb2_grpc

NOTIFY_DEADLINE_S = 3
MAX_NOTIFY_ATTEMPTS = 3
CHANGE_KIND_CREATE = "create"
CHANGE_KIND_UPDATE = "update"
CHANGE_KIND_CANCEL = "cancel"
CHANGE_KIND_INSTANCE_EXCEPTION = "instance-exception"
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("notifier:9001")
notifier = notifications_pb2_grpc.NotifierStub(channel)

# Events whose create actually reached the mailer, so a cancel can pair with it.
DELIVERED_CREATES: set[str] = set()


def content_unchanged(prev: dict, next: dict) -> bool:
    """True when only presentation fields changed: no new invitation is owed."""
    return all(prev.get(field) == next.get(field) for field in ("start", "end", "attendees", "rrule"))


def classify_change(prev: dict, next: dict) -> str:
    if not prev:
        return CHANGE_KIND_CREATE
    if content_unchanged(prev, next):
        return CHANGE_KIND_UPDATE
    return CHANGE_KIND_INSTANCE_EXCEPTION


def idempotency_token(event_id: str, revision: int, kind: str) -> str:
    """Derived from the change, never minted per attempt: a retry reuses it."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{event_id}:{revision}:{kind}"))


def send(event_id: str, revision: int, kind: str, token: str, attendee: str = "") -> None:
    request = notifications_pb2.NotifyRequest(
        event_id=event_id,
        revision=revision,
        kind=kind,
        idempotency_token=token,
        attendee=attendee,
    )
    notifier.NotifyAttendees(request, timeout=NOTIFY_DEADLINE_S)


def notify_attendees(event_id: str, revision: int, prev: dict, next: dict, removed: list[str]) -> None:
    for attendee in removed:
        if event_id not in DELIVERED_CREATES:
            continue
        token = idempotency_token(event_id, revision, CHANGE_KIND_CANCEL)
        for _ in range(MAX_NOTIFY_ATTEMPTS):
            try:
                send(event_id, revision, CHANGE_KIND_CANCEL, token, attendee)
                break
            except grpc.RpcError as exc:
                if exc.code() not in RETRYABLE:
                    break
    kind = classify_change(prev, next)
    token = idempotency_token(event_id, revision, kind)
    for _ in range(MAX_NOTIFY_ATTEMPTS):
        try:
            send(event_id, revision, kind, token)
            if kind == CHANGE_KIND_CREATE:
                DELIVERED_CREATES.add(event_id)
            return
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                break
`,
    },
    typescript: {
      starter: `/** Notify path: a model-generated draft that invites everyone on every write. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {randomUUID} from 'node:crypto';

interface NotifyRequest {
  eventId: string;
  revision: number;
  kind: string;
  idempotencyToken: string;
  attendee?: string;
}

interface NotifierClient {
  NotifyAttendees(
    request: NotifyRequest,
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null) => void,
  ): grpc.ClientUnaryCall;
}

const {notifications} = grpc.loadPackageDefinition(protoLoader.loadSync('notifications.proto')) as unknown as {
  notifications: {Notifier: new (target: string, credentials: grpc.ChannelCredentials) => NotifierClient};
};
const notifier = new notifications.Notifier('notifier:9001', grpc.credentials.createInsecure());

export async function notifyAttendees(
  eventId: string,
  revision: number,
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  removed: string[],
): Promise<void> {
  // TODO: this draft sends no deadline, always declares a full invitation, mints a fresh token on
  // every attempt and cancels removed attendees whose create was never delivered. Give each call a
  // 3 s deadline from a named constant, compute the change kind from the diff of prev and next,
  // classify a timezone-only correction as an update, derive the idempotency token from the change
  // so retries share it, and keep a delivered-creates record before cancelling.
  for (const attendee of removed) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const request: NotifyRequest = {
        eventId,
        revision,
        kind: 'cancel',
        idempotencyToken: randomUUID(),
        attendee,
      };
      try {
        await call(request);
        break;
      } catch {
        continue;
      }
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const request: NotifyRequest = {
      eventId,
      revision,
      kind: 'create',
      idempotencyToken: randomUUID(),
    };
    try {
      await call(request);
      return;
    } catch {
      continue;
    }
  }
}

function call(request: NotifyRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    notifier.NotifyAttendees(request, new grpc.Metadata(), {}, (error: grpc.ServiceError | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
`,
      solution: `/** Notify path: a 3 s deadline, a change kind from the diff and one token per change. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {createHash} from 'node:crypto';

const NOTIFY_DEADLINE_MS = 3000;
const MAX_NOTIFY_ATTEMPTS = 3;
const CHANGE_KIND_CREATE = 'create';
const CHANGE_KIND_UPDATE = 'update';
const CHANGE_KIND_CANCEL = 'cancel';
const CHANGE_KIND_INSTANCE_EXCEPTION = 'instance-exception';

const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface NotifyRequest {
  eventId: string;
  revision: number;
  kind: string;
  idempotencyToken: string;
  attendee?: string;
}

interface NotifierClient {
  NotifyAttendees(
    request: NotifyRequest,
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null) => void,
  ): grpc.ClientUnaryCall;
}

const {notifications} = grpc.loadPackageDefinition(protoLoader.loadSync('notifications.proto')) as unknown as {
  notifications: {Notifier: new (target: string, credentials: grpc.ChannelCredentials) => NotifierClient};
};
const notifier = new notifications.Notifier('notifier:9001', grpc.credentials.createInsecure());

// Events whose create actually reached the mailer, so a cancel can pair with it.
const DELIVERED_CREATES = new Set<string>();

function contentUnchanged(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return ['start', 'end', 'attendees', 'rrule'].every(field => prev[field] === next[field]);
}

function classifyChange(prev: Record<string, unknown>, next: Record<string, unknown>): string {
  if (Object.keys(prev).length === 0) return CHANGE_KIND_CREATE;
  if (contentUnchanged(prev, next)) return CHANGE_KIND_UPDATE;
  return CHANGE_KIND_INSTANCE_EXCEPTION;
}

function idempotencyToken(eventId: string, revision: number, kind: string): string {
  return createHash('sha256').update([eventId, String(revision), kind].join(':')).digest('hex');
}

function sendNotify(request: NotifyRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    notifier.NotifyAttendees(
      request,
      new grpc.Metadata(),
      {deadline: Date.now() + NOTIFY_DEADLINE_MS},
      (error: grpc.ServiceError | null) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

export async function notifyAttendees(
  eventId: string,
  revision: number,
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  removed: string[],
): Promise<void> {
  for (const attendee of removed) {
    if (!DELIVERED_CREATES.has(eventId)) continue;
    const token = idempotencyToken(eventId, revision, CHANGE_KIND_CANCEL);
    const request: NotifyRequest = {eventId, revision, kind: CHANGE_KIND_CANCEL, idempotencyToken: token, attendee};
    for (let attempt = 0; attempt < MAX_NOTIFY_ATTEMPTS; attempt++) {
      try {
        await sendNotify(request);
        break;
      } catch (error) {
        const serviceError = error as grpc.ServiceError;
        if (RETRYABLE[serviceError.code] !== true) break;
      }
    }
  }
  const kind = classifyChange(prev, next);
  const token = idempotencyToken(eventId, revision, kind);
  const request: NotifyRequest = {eventId, revision, kind, idempotencyToken: token};
  for (let attempt = 0; attempt < MAX_NOTIFY_ATTEMPTS; attempt++) {
    try {
      await sendNotify(request);
      if (kind === CHANGE_KIND_CREATE) DELIVERED_CREATES.add(eventId);
      return;
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      if (RETRYABLE[serviceError.code] !== true) break;
    }
  }
}
`,
    },
    go: {
      starter: `package notify

import (
	"context"

	"github.com/google/uuid"

	pb "calendar/notificationspb"
)

// TODO: this draft sends no deadline, always declares a full invitation, mints a fresh token on
// every attempt and cancels removed attendees whose create was never delivered. Give each call a
// 3 s deadline from a named constant, compute the change kind from the diff of prev and next,
// classify a timezone-only correction as an update, derive the idempotency token from the change
// so retries share it, and keep a delivered-creates record before cancelling.
func notifyAttendees(ctx context.Context, client pb.NotifierClient, eventID string, revision int64,
	prev, next map[string]string, removed []string) {
	for _, attendee := range removed {
		for attempt := 0; attempt < 3; attempt++ {
			_, err := client.NotifyAttendees(ctx, &pb.NotifyRequest{
				EventId:          eventID,
				Revision:         revision,
				Kind:             "cancel",
				IdempotencyToken: uuid.NewString(),
				Attendee:         attendee,
			})
			if err == nil {
				break
			}
		}
	}
	for attempt := 0; attempt < 3; attempt++ {
		_, err := client.NotifyAttendees(ctx, &pb.NotifyRequest{
			EventId:          eventID,
			Revision:         revision,
			Kind:             "create",
			IdempotencyToken: uuid.NewString(),
		})
		if err == nil {
			return
		}
	}
}
`,
      solution: `package notify

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "calendar/notificationspb"
)

const (
	notifyDeadlineS             = 3
	maxNotifyAttempts           = 3
	changeKindCreate            = "create"
	changeKindUpdate            = "update"
	changeKindCancel            = "cancel"
	changeKindInstanceException = "instance-exception"
)

var retryableNotify = map[codes.Code]bool{
	codes.Unavailable:      true,
	codes.DeadlineExceeded: true,
}

// deliveredCreates records the events whose create actually reached the mailer.
var deliveredCreates = map[string]bool{}

func contentUnchanged(prev, next map[string]string) bool {
	for _, field := range []string{"start", "end", "attendees", "rrule"} {
		if prev[field] != next[field] {
			return false
		}
	}
	return true
}

func classifyChange(prev, next map[string]string) string {
	if len(prev) == 0 {
		return changeKindCreate
	}
	if contentUnchanged(prev, next) {
		return changeKindUpdate
	}
	return changeKindInstanceException
}

// idempotencyToken is derived from the change, so every retry of the same change reuses it.
func idempotencyToken(eventID string, revision int64, kind string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%s", eventID, revision, kind)))
	return hex.EncodeToString(sum[:])
}

func sendNotify(ctx context.Context, client pb.NotifierClient, request *pb.NotifyRequest) error {
	callCtx, cancel := context.WithTimeout(ctx, notifyDeadlineS*time.Second)
	defer cancel()
	_, err := client.NotifyAttendees(callCtx, request)
	return err
}

func notifyAttendees(ctx context.Context, client pb.NotifierClient, eventID string, revision int64,
	prev, next map[string]string, removed []string) {
	for _, attendee := range removed {
		if !deliveredCreates[eventID] {
			continue
		}
		request := &pb.NotifyRequest{
			EventId:          eventID,
			Revision:         revision,
			Kind:             changeKindCancel,
			IdempotencyToken: idempotencyToken(eventID, revision, changeKindCancel),
			Attendee:         attendee,
		}
		for attempt := 0; attempt < maxNotifyAttempts; attempt++ {
			if err := sendNotify(ctx, client, request); err == nil || !retryableNotify[status.Code(err)] {
				break
			}
		}
	}
	kind := classifyChange(prev, next)
	request := &pb.NotifyRequest{
		EventId:          eventID,
		Revision:         revision,
		Kind:             kind,
		IdempotencyToken: idempotencyToken(eventID, revision, kind),
	}
	for attempt := 0; attempt < maxNotifyAttempts; attempt++ {
		err := sendNotify(ctx, client, request)
		if err == nil {
			if kind == changeKindCreate {
				deliveredCreates[eventID] = true
			}
			return
		}
		if !retryableNotify[status.Code(err)] {
			break
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

object NotifyClient {
  private val notifier =
    NotifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("notifier", 9001).usePlaintext().build())

  // TODO: this draft sends no deadline, always declares a full invitation, mints a fresh token on
  // every attempt and cancels removed attendees whose create was never delivered. Give each call a
  // 3 s deadline from a named constant, compute the change kind from the diff of prev and next,
  // classify a timezone-only correction as an update, derive the idempotency token from the change
  // so retries share it, and keep a delivered-creates record before cancelling.
  def notifyAttendees(
      eventId: String,
      revision: Long,
      prev: Map[String, String],
      next: Map[String, String],
      removed: Seq[String],
  ): Unit = {
    for (attendee <- removed) {
      var attempt = 0
      var done = false
      while (attempt < 3 && !done) {
        try {
          notifier.notifyAttendees(
            NotifyRequest(
              eventId = eventId,
              revision = revision,
              kind = "cancel",
              idempotencyToken = UUID.randomUUID().toString,
              attendee = attendee,
            )
          )
          done = true
        } catch {
          case _: StatusRuntimeException => ()
        }
        attempt += 1
      }
    }
    var attempt = 0
    var done = false
    while (attempt < 3 && !done) {
      try {
        notifier.notifyAttendees(
          NotifyRequest(
            eventId = eventId,
            revision = revision,
            kind = "create",
            idempotencyToken = UUID.randomUUID().toString,
          )
        )
        done = true
      } catch {
        case _: StatusRuntimeException => ()
      }
      attempt += 1
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object NotifyClient {
  val NotifyDeadlineS = 3
  val MaxNotifyAttempts = 3
  val ChangeKindCreate = "create"
  val ChangeKindUpdate = "update"
  val ChangeKindCancel = "cancel"
  val ChangeKindInstanceException = "instance-exception"

  val Retryable: Set[Status.Code] =
    Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val notifier =
    NotifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("notifier", 9001).usePlaintext().build())

  // Events whose create actually reached the mailer, so a cancel can pair with it.
  private val DeliveredCreates = scala.collection.mutable.Set.empty[String]

  def contentUnchanged(prev: Map[String, String], next: Map[String, String]): Boolean =
    Seq("start", "end", "attendees", "rrule").forall(field => prev.get(field) == next.get(field))

  def classifyChange(prev: Map[String, String], next: Map[String, String]): String =
    if (prev.isEmpty) ChangeKindCreate
    else if (contentUnchanged(prev, next)) ChangeKindUpdate
    else ChangeKindInstanceException

  // Derived from the change, so every retry of the same change reuses the token.
  def idempotencyToken(eventId: String, revision: Long, kind: String): String =
    UUID.nameUUIDFromBytes(s"$eventId:$revision:$kind".getBytes(StandardCharsets.UTF_8)).toString

  private def send(request: NotifyRequest): Unit =
    notifier.withDeadlineAfter(NotifyDeadlineS, TimeUnit.SECONDS).notifyAttendees(request)

  private def attemptLoop(request: NotifyRequest, attempt: Int = 1): Boolean =
    try {
      send(request)
      true
    } catch {
      case exc: StatusRuntimeException =>
        val code = exc.getStatus.getCode
        if (attempt >= MaxNotifyAttempts || !Retryable.contains(code)) false
        else attemptLoop(request, attempt + 1)
    }

  def notifyAttendees(
      eventId: String,
      revision: Long,
      prev: Map[String, String],
      next: Map[String, String],
      removed: Seq[String],
  ): Unit = {
    for (attendee <- removed if DeliveredCreates.contains(eventId)) {
      attemptLoop(
        NotifyRequest(
          eventId = eventId,
          revision = revision,
          kind = ChangeKindCancel,
          idempotencyToken = idempotencyToken(eventId, revision, ChangeKindCancel),
          attendee = attendee,
        )
      )
    }
    val kind = classifyChange(prev, next)
    val delivered = attemptLoop(
      NotifyRequest(
        eventId = eventId,
        revision = revision,
        kind = kind,
        idempotencyToken = idempotencyToken(eventId, revision, kind),
      )
    )
    if (delivered && kind == ChangeKindCreate) DeliveredCreates += eventId
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "notifications.grpc.pb.h"

#include <map>
#include <random>
#include <string>
#include <vector>

std::string makeToken() {
  static std::mt19937 rng{std::random_device{}()};
  return std::to_string(rng());
}

// TODO: this draft sends no deadline, always declares a full invitation, mints a fresh token on
// every attempt and cancels removed attendees whose create was never delivered. Give each call a
// 3 s deadline from a named constant, compute the change kind from the diff of prev and next,
// classify a timezone-only correction as an update, derive the idempotency token from the change
// so retries share it, and keep a delivered-creates record before cancelling.
void notifyAttendees(Notifier::Stub* stub,
                     const std::string& event_id,
                     int revision,
                     const std::map<std::string, std::string>& prev,
                     const std::map<std::string, std::string>& next,
                     const std::vector<std::string>& removed) {
  for (const auto& attendee : removed) {
    for (int attempt = 0; attempt < 3; attempt++) {
      NotifyRequest request;
      request.set_event_id(event_id);
      request.set_revision(revision);
      request.set_kind("cancel");
      request.set_idempotency_token(makeToken());
      request.set_attendee(attendee);
      grpc::ClientContext ctx;
      NotifyReply reply;
      if (stub->NotifyAttendees(&ctx, request, &reply).ok()) break;
    }
  }
  for (int attempt = 0; attempt < 3; attempt++) {
    NotifyRequest request;
    request.set_event_id(event_id);
    request.set_revision(revision);
    request.set_kind("create");
    request.set_idempotency_token(makeToken());
    grpc::ClientContext ctx;
    NotifyReply reply;
    if (stub->NotifyAttendees(&ctx, request, &reply).ok()) return;
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "notifications.grpc.pb.h"

#include <chrono>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <vector>

constexpr int kNotifyDeadlineS = 3;
constexpr int kMaxNotifyAttempts = 3;
constexpr char kChangeKindCreate[] = "create";
constexpr char kChangeKindUpdate[] = "update";
constexpr char kChangeKindCancel[] = "cancel";
constexpr char kChangeKindInstanceException[] = "instance-exception";

const std::set<grpc::StatusCode> kRetryable = {
    grpc::StatusCode::UNAVAILABLE,
    grpc::StatusCode::DEADLINE_EXCEEDED,
};

// Events whose create actually reached the mailer, so a cancel can pair with it.
std::set<std::string> deliveredCreates;

bool contentUnchanged(const std::map<std::string, std::string>& prev,
                      const std::map<std::string, std::string>& next) {
  for (const std::string& field : {"start", "end", "attendees", "rrule"}) {
    const auto lhs = prev.find(field);
    const auto rhs = next.find(field);
    if (lhs == prev.end() || rhs == next.end() || lhs->second != rhs->second) return false;
  }
  return true;
}

std::string classifyChange(const std::map<std::string, std::string>& prev,
                           const std::map<std::string, std::string>& next) {
  if (prev.empty()) return kChangeKindCreate;
  if (contentUnchanged(prev, next)) return kChangeKindUpdate;
  return kChangeKindInstanceException;
}

// Derived from the change, so every retry of the same change reuses the token.
std::string idempotencyToken(const std::string& event_id, int revision, const std::string& kind) {
  const std::string key = event_id + ":" + std::to_string(revision) + ":" + kind;
  return std::to_string(std::hash<std::string>{}(key));
}

grpc::Status sendNotify(Notifier::Stub* stub, const NotifyRequest& request) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kNotifyDeadlineS));
  NotifyReply reply;
  return stub->NotifyAttendees(&ctx, request, &reply);
}

bool retryable(const grpc::Status& status) {
  return kRetryable.count(status.error_code()) > 0;
}

void notifyAttendees(Notifier::Stub* stub,
                     const std::string& event_id,
                     int revision,
                     const std::map<std::string, std::string>& prev,
                     const std::map<std::string, std::string>& next,
                     const std::vector<std::string>& removed) {
  for (const auto& attendee : removed) {
    if (deliveredCreates.find(event_id) == deliveredCreates.end()) continue;
    NotifyRequest request;
    request.set_event_id(event_id);
    request.set_revision(revision);
    request.set_kind(kChangeKindCancel);
    request.set_idempotency_token(idempotencyToken(event_id, revision, kChangeKindCancel));
    request.set_attendee(attendee);
    for (int attempt = 0; attempt < kMaxNotifyAttempts; attempt++) {
      const grpc::Status status = sendNotify(stub, request);
      if (status.ok() || !retryable(status)) break;
    }
  }
  const std::string kind = classifyChange(prev, next);
  NotifyRequest request;
  request.set_event_id(event_id);
  request.set_revision(revision);
  request.set_kind(kind);
  request.set_idempotency_token(idempotencyToken(event_id, revision, kind));
  for (int attempt = 0; attempt < kMaxNotifyAttempts; attempt++) {
    const grpc::Status status = sendNotify(stub, request);
    if (status.ok()) {
      if (kind == kChangeKindCreate) deliveredCreates.insert(event_id);
      return;
    }
    if (!retryable(status)) break;
  }
}
`,
    },
  },
  hints: [
    'The deadline belongs to the call itself — `timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline` — and the number belongs in a constant beside the attempt bound, so both are visible in the notify path. The draft sends the RPC without one, so a notifier that never answers pins the API worker.',
    'The change kind is a property of the diff, not of the call site: compare the content fields first and, when only presentation fields moved, return the update kind. A timezone correction that re-invites everyone is exactly the failure the demo hides.',
    'Compute the token once, before the retry loop, from the event id, revision and kind: a token minted per attempt is a new invitation per attempt. Then keep the delivered-creates record current when a create succeeds, so a later cancel for an attendee who was never invited is skipped.',
  ],
  debrief: `The step treats a notification as a side effect with a contract rather than a fire-and-forget RPC. Four properties are under review: bounded time — a deadline on the call, so a stuck notifier cannot pin the API worker — bounded retries restricted to retryable statuses, an idempotency token derived from the change so a retry dedupes instead of re-inviting, and a change kind computed from the diff so a timezone correction is an update rather than a second invitation. The delivered-creates record is the part candidates miss: a cancel is the consequence of an invite that actually went out, so the notifier needs a delivery record or the pair never holds. Real systems add jittered backoff, a notifier-side dedupe store keyed by the token, and a dead-letter path for a cancel whose create is still in flight.`,
};
