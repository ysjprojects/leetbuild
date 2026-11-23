import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Attendee notifications: one token per change, one kind per attendee',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'idempotent-requests'],
  file: 'client',
  focus: ['api', 'notifier'],
  task: `## Task

**Starting point.** The starter is \`notify_change(before, after)\`, called after an event write
commits (\`before\` is \`None\` for a create). It calls \`Notifier.NotifyAttendees\` at \`notifier:9000\`
through \`send_notice(event, kind, attendees)\`, which retries \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`
up to 3 attempts, and it sends every attendee of \`after\` a \`create\`. It serves the demo and hides
four flaws.

**Failure mode the checks target.** A notifier that answers in two seconds, one that mailed the
attendees but whose reply never came back, a title fix on an event its attendees already accepted,
and an attendee removed from the meeting.

\`\`\`proto
service Notifier {
  rpc NotifyAttendees(NotifyRequest) returns (NotifyReply);  // mails once per idempotency_token
}
\`\`\`

- Every attempt carries a **3 s** deadline.
- The token is \`{event_id}:{revision}:{kind}\`, the same on every attempt: the notifier mails once
  per token.
- A create invites everyone. A change sends \`update\` to the attendees of both versions, \`create\` to
  the added ones and \`cancel\` to the removed ones; an empty group gets no call.`,
  sequence: {
    participants: ['Calendar API', 'Notifier'],
    messages: [
      {from: 'Calendar API', to: 'Calendar API', label: 'diff before/after → update · create · cancel', kind: 'sync'},
      {
        from: 'Calendar API',
        to: 'Notifier',
        label: 'NotifyAttendees(kind, token = event:revision:kind) · 3 s',
        kind: 'sync',
      },
      {from: 'Notifier', to: 'Calendar API', label: 'mailed · or UNAVAILABLE after the mail went out', kind: 'reply'},
      {from: 'Calendar API', to: 'Notifier', label: 'retry with the same token: mails nobody twice', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Bounds every attempt with a 3 s deadline',
      detail:
        'A notifier that answers in two seconds is notified, and every attempt carries its own deadline of about 3 s: after a 2 s attempt whose reply was lost, the retry still gets 3 s and the notice is delivered. The starter sends the call with no deadline, so a notifier that hangs holds the request worker with it.',
      match: {
        python: {all: [/NotifyAttendees\([\s\S]{0,200}?timeout\s*=\s*(NOTIFY_DEADLINE_S|3(\.0)?)\b/]},
        typescript: {
          all: [/\.NotifyAttendees\([\s\S]{0,200}?deadline:\s*Date\.now\(\)\s*\+\s*(NOTIFY_DEADLINE_MS|3000)\b/],
        },
        go: {all: [/context\.WithTimeout\([^\n]*(notifyDeadline|3\s*\*\s*time\.Second|3000\s*\*\s*time\.Millisecond)/]},
        cpp: {
          all: [
            /set_deadline\([^\n]*(kNotifyDeadline|std::chrono::seconds[({]\s*3\s*[)}]|std::chrono::milliseconds[({]\s*3000\s*[)}])/,
          ],
        },
      },
    },
    {
      id: 'one-token',
      title: 'Retries a notification with the token of the change',
      detail:
        'When the first call mails the attendees and its reply is lost, the retry carries the same `{event_id}:{revision}:{kind}` token and every attendee is mailed once. Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried, up to 3 attempts: `INVALID_ARGUMENT` and `PERMISSION_DENIED` get one call. The starter draws a new token for every attempt, so the notifier mails everyone again.',
      match: {
        python: {
          all: [/f["']\{[^}]*event_id[^}]*\}:\{[^}]*revision[^}]*\}:\{kind\}["']/],
          none: [/idempotency_token\s*=\s*(new_id|str\(\s*uuid)/],
        },
        typescript: {
          all: [/`\$\{[^}]*event_id\}:\$\{[^}]*revision\}:\$\{kind\}`/],
          none: [/idempotency_token:\s*(newId|randomUUID)\(/],
        },
        go: {
          all: [/Sprintf\(\s*"%s:%d:%s"\s*,\s*\w+\.EventID\s*,\s*\w+\.Revision\s*,\s*kind\s*\)/],
          none: [/IdempotencyToken:\s*store\.NewID\(\)/],
        },
        cpp: {
          all: [/event_id\s*\+\s*":"\s*\+\s*std::to_string\(\s*\w+\.revision\s*\)\s*\+\s*":"\s*\+\s*kind/],
          none: [/set_idempotency_token\(\s*calendard::NewId\(\)\s*\)/],
        },
      },
    },
    {
      id: 'change-kind',
      title: 'Sends an update, not a new invitation, to attendees who stay',
      detail:
        'After the invitations of revision 1, a title fix in revision 2 that keeps two attendees and adds one sends `update` to the two and `create` to the new one, with tokens of revision 2. The starter sends `create` to everyone, so people who already accepted are asked again.',
      match: {
        python: {all: [/["']update["']/, /in before\[["']attendees["']\]/]},
        typescript: {all: [/['"]update['"]/, /before\.attendees\.includes\(/]},
        go: {all: [/"update"/, /before\.Attendees/]},
        cpp: {all: [/"update"/, /before->attendees/]},
      },
    },
    {
      id: 'removed-cancel',
      title: 'Sends a cancel to attendees taken off the event',
      detail:
        'An attendee in `before` but not in `after` receives `cancel`, and a group with nobody in it gets no call. The starter only writes to the attendees of `after`, so a removed colleague keeps the meeting in their calendar.',
      match: {
        python: {all: [/["']cancel["']/, /not in after\[["']attendees["']\]/]},
        typescript: {all: [/['"]cancel['"]/, /!after\.attendees\.includes\(/]},
        go: {all: [/"cancel"/, /range before\.Attendees/]},
        cpp: {all: [/"cancel"/, /:\s*before->attendees/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import calendar_service_pb2
import calendar_service_pb2_grpc
from calendard.store import new_id

MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE)

channel = grpc.insecure_channel("notifier:9000")
stub = calendar_service_pb2_grpc.NotifierStub(channel)


def send_notice(event: dict, kind: str, attendees: list[str]) -> None:
    """One notification, retried while the notifier times out or is unavailable."""
    for attempt in range(MAX_ATTEMPTS):
        request = calendar_service_pb2.NotifyRequest(
            event_id=event["event_id"],
            revision=event["revision"],
            kind=kind,
            attendees=attendees,
            idempotency_token=new_id(),
            title=event["title"],
            dtstart=event["dtstart"],
        )
        try:
            stub.NotifyAttendees(request)
            return
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE or attempt == MAX_ATTEMPTS - 1:
                raise


def notify_change(before: dict | None, after: dict) -> int:
    """Tell the attendees about a committed change; the number of notifications sent."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    send_notice(after, "create", after["attendees"])
    return 1
`,
      solution: `import grpc

import calendar_service_pb2
import calendar_service_pb2_grpc

NOTIFY_DEADLINE_S = 3
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE)

channel = grpc.insecure_channel("notifier:9000")
stub = calendar_service_pb2_grpc.NotifierStub(channel)


def send_notice(event: dict, kind: str, attendees: list[str]) -> None:
    """One notification, retried while the notifier times out or is unavailable."""
    # The token names the change, not the attempt: a retry after a lost reply is the same mail.
    token = f"{event['event_id']}:{event['revision']}:{kind}"
    request = calendar_service_pb2.NotifyRequest(
        event_id=event["event_id"],
        revision=event["revision"],
        kind=kind,
        attendees=attendees,
        idempotency_token=token,
        title=event["title"],
        dtstart=event["dtstart"],
    )
    for attempt in range(MAX_ATTEMPTS):
        try:
            stub.NotifyAttendees(request, timeout=NOTIFY_DEADLINE_S)
            return
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE or attempt == MAX_ATTEMPTS - 1:
                raise


def change_plan(before: dict | None, after: dict) -> list[tuple[str, list[str]]]:
    """Who hears what: an invitation for a new attendee, an update for one who stays, a cancel for one removed."""
    if before is None:
        return [("create", list(after["attendees"]))]
    kept = [a for a in after["attendees"] if a in before["attendees"]]
    added = [a for a in after["attendees"] if a not in before["attendees"]]
    removed = [a for a in before["attendees"] if a not in after["attendees"]]
    return [(kind, people) for kind, people in (("update", kept), ("create", added), ("cancel", removed)) if people]


def notify_change(before: dict | None, after: dict) -> int:
    """Tell the attendees about a committed change; the number of notifications sent."""
    plan = change_plan(before, after)
    for kind, attendees in plan:
        send_notice(after, kind, attendees)
    return len(plan)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Event, newId} from 'calendard/store';

export const MAX_ATTEMPTS = 3;
const RETRYABLE = [grpc.status.DEADLINE_EXCEEDED, grpc.status.UNAVAILABLE];

interface NotifyRequest {
  event_id: string;
  revision: number;
  kind: string;
  attendees: string[];
  idempotency_token: string;
  title: string;
  dtstart: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('calendar_service.proto')) as unknown as {
  calnotify: {Notifier: grpc.ServiceClientConstructor};
};
const stub = new pkg.calnotify.Notifier('notifier:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  NotifyAttendees(request: NotifyRequest, options: grpc.CallOptions): Promise<{mailed: number}>;
};

/** One notification, retried while the notifier times out or is unavailable. */
export async function sendNotice(event: Event, kind: string, attendees: string[]): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const request: NotifyRequest = {
      event_id: event.event_id,
      revision: event.revision,
      kind,
      attendees,
      idempotency_token: newId(),
      title: event.title,
      dtstart: event.dtstart,
    };
    try {
      await stub.NotifyAttendees(request, {});
      return;
    } catch (err) {
      if (!RETRYABLE.includes((err as grpc.ServiceError).code) || attempt === MAX_ATTEMPTS - 1) throw err;
    }
  }
}

/** Tell the attendees about a committed change; resolves to the number of notifications sent. */
export async function notifyChange(before: Event | null, after: Event): Promise<number> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  await sendNotice(after, 'create', after.attendees);
  return 1;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Event} from 'calendard/store';

export const NOTIFY_DEADLINE_MS = 3000;
export const MAX_ATTEMPTS = 3;
const RETRYABLE = [grpc.status.DEADLINE_EXCEEDED, grpc.status.UNAVAILABLE];

interface NotifyRequest {
  event_id: string;
  revision: number;
  kind: string;
  attendees: string[];
  idempotency_token: string;
  title: string;
  dtstart: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('calendar_service.proto')) as unknown as {
  calnotify: {Notifier: grpc.ServiceClientConstructor};
};
const stub = new pkg.calnotify.Notifier('notifier:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  NotifyAttendees(request: NotifyRequest, options: grpc.CallOptions): Promise<{mailed: number}>;
};

/** One notification, retried while the notifier times out or is unavailable. */
export async function sendNotice(event: Event, kind: string, attendees: string[]): Promise<void> {
  // The token names the change, not the attempt: a retry after a lost reply is the same mail.
  const request: NotifyRequest = {
    event_id: event.event_id,
    revision: event.revision,
    kind,
    attendees,
    idempotency_token: \`\${event.event_id}:\${event.revision}:\${kind}\`,
    title: event.title,
    dtstart: event.dtstart,
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await stub.NotifyAttendees(request, {deadline: Date.now() + NOTIFY_DEADLINE_MS});
      return;
    } catch (err) {
      if (!RETRYABLE.includes((err as grpc.ServiceError).code) || attempt === MAX_ATTEMPTS - 1) throw err;
    }
  }
}

/** Who hears what: an invitation for a new attendee, an update for one who stays, a cancel for one removed. */
export function changePlan(before: Event | null, after: Event): [string, string[]][] {
  if (before === null) return [['create', [...after.attendees]]];
  const kept = after.attendees.filter(a => before.attendees.includes(a));
  const added = after.attendees.filter(a => !before.attendees.includes(a));
  const removed = before.attendees.filter(a => !after.attendees.includes(a));
  const plan: [string, string[]][] = [
    ['update', kept],
    ['create', added],
    ['cancel', removed],
  ];
  return plan.filter(([, people]) => people.length > 0);
}

/** Tell the attendees about a committed change; resolves to the number of notifications sent. */
export async function notifyChange(before: Event | null, after: Event): Promise<number> {
  const plan = changePlan(before, after);
  for (const [kind, attendees] of plan) await sendNotice(after, kind, attendees);
  return plan.length;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "calendard/gen/calendar_service"
	"calendard/store"
)

const maxAttempts = 3

var conn, _ = grpc.NewClient("notifier:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewNotifierClient(conn)

func retryable(code codes.Code) bool { return code == codes.DeadlineExceeded || code == codes.Unavailable }

// sendNotice is one notification, retried while the notifier times out or is unavailable.
func sendNotice(ctx context.Context, e store.Event, kind string, attendees []string) error {
	var err error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		req := &pb.NotifyRequest{
			EventId: e.EventID, Revision: int64(e.Revision), Kind: kind, Attendees: attendees,
			IdempotencyToken: store.NewID(), Title: e.Title, Dtstart: e.Dtstart,
		}
		if _, err = stub.NotifyAttendees(ctx, req); err == nil || !retryable(status.Code(err)) {
			return err
		}
	}
	return err
}

// notifyChange tells the attendees about a committed change (before is nil for a create) and returns
// the number of notifications sent.
func notifyChange(ctx context.Context, before *store.Event, after store.Event) (int, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if err := sendNotice(ctx, after, "create", after.Attendees); err != nil {
		return 0, err
	}
	return 1, nil
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

	pb "calendard/gen/calendar_service"
	"calendard/store"
)

const (
	notifyDeadline = 3 * time.Second
	maxAttempts    = 3
)

var conn, _ = grpc.NewClient("notifier:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewNotifierClient(conn)

func retryable(code codes.Code) bool { return code == codes.DeadlineExceeded || code == codes.Unavailable }

// sendNotice is one notification, retried while the notifier times out or is unavailable.
func sendNotice(ctx context.Context, e store.Event, kind string, attendees []string) error {
	// The token names the change, not the attempt: a retry after a lost reply is the same mail.
	req := &pb.NotifyRequest{
		EventId: e.EventID, Revision: int64(e.Revision), Kind: kind, Attendees: attendees,
		IdempotencyToken: fmt.Sprintf("%s:%d:%s", e.EventID, e.Revision, kind), Title: e.Title, Dtstart: e.Dtstart,
	}
	var err error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, notifyDeadline)
		_, err = stub.NotifyAttendees(callCtx, req)
		cancel()
		if err == nil || !retryable(status.Code(err)) {
			return err
		}
	}
	return err
}

func contains(list []string, item string) bool {
	for _, x := range list {
		if x == item {
			return true
		}
	}
	return false
}

type notice struct {
	kind      string
	attendees []string
}

// changePlan is who hears what: an invitation for a new attendee, an update for one who stays, a
// cancel for one removed.
func changePlan(before *store.Event, after store.Event) []notice {
	if before == nil {
		return []notice{{"create", after.Attendees}}
	}
	var kept, added, removed []string
	for _, a := range after.Attendees {
		if contains(before.Attendees, a) {
			kept = append(kept, a)
		} else {
			added = append(added, a)
		}
	}
	for _, a := range before.Attendees {
		if !contains(after.Attendees, a) {
			removed = append(removed, a)
		}
	}
	var plan []notice
	for _, n := range []notice{{"update", kept}, {"create", added}, {"cancel", removed}} {
		if len(n.attendees) > 0 {
			plan = append(plan, n)
		}
	}
	return plan
}

// notifyChange tells the attendees about a committed change (before is nil for a create) and returns
// the number of notifications sent.
func notifyChange(ctx context.Context, before *store.Event, after store.Event) (int, error) {
	plan := changePlan(before, after)
	for _, n := range plan {
		if err := sendNotice(ctx, after, n.kind, n.attendees); err != nil {
			return 0, err
		}
	}
	return len(plan), nil
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "calendar_service.grpc.pb.h"
#include "calendard/store.h"

constexpr int kMaxAttempts = 3;

auto channel = grpc::CreateChannel("notifier:9000", grpc::InsecureChannelCredentials());
auto stub = calnotify::Notifier::NewStub(channel);

static bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::DEADLINE_EXCEEDED || code == grpc::StatusCode::UNAVAILABLE;
}

// One notification, retried while the notifier times out or is unavailable.
grpc::Status sendNotice(const calendard::Event& e, const std::string& kind, const std::vector<std::string>& attendees) {
  grpc::Status status;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    calnotify::NotifyRequest request;
    request.set_event_id(e.event_id);
    request.set_revision(e.revision);
    request.set_kind(kind);
    for (const auto& a : attendees) request.add_attendees(a);
    request.set_idempotency_token(calendard::NewId());
    request.set_title(e.title);
    request.set_dtstart(e.dtstart);
    grpc::ClientContext ctx;
    calnotify::NotifyReply reply;
    status = stub->NotifyAttendees(&ctx, request, &reply);
    if (status.ok() || !retryable(status.error_code())) return status;
  }
  return status;
}

// Tell the attendees about a committed change (before is empty for a create); the number of notifications sent.
int notifyChange(const std::optional<calendard::Event>& before, const calendard::Event& after) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const grpc::Status status = sendNotice(after, "create", after.attendees);
  if (!status.ok()) throw std::runtime_error(status.error_message());
  return 1;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "calendar_service.grpc.pb.h"
#include "calendard/store.h"

constexpr std::chrono::seconds kNotifyDeadline{3};
constexpr int kMaxAttempts = 3;

auto channel = grpc::CreateChannel("notifier:9000", grpc::InsecureChannelCredentials());
auto stub = calnotify::Notifier::NewStub(channel);

static bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::DEADLINE_EXCEEDED || code == grpc::StatusCode::UNAVAILABLE;
}

// One notification, retried while the notifier times out or is unavailable.
grpc::Status sendNotice(const calendard::Event& e, const std::string& kind, const std::vector<std::string>& attendees) {
  // The token names the change, not the attempt: a retry after a lost reply is the same mail.
  calnotify::NotifyRequest request;
  request.set_event_id(e.event_id);
  request.set_revision(e.revision);
  request.set_kind(kind);
  for (const auto& a : attendees) request.add_attendees(a);
  request.set_idempotency_token(e.event_id + ":" + std::to_string(e.revision) + ":" + kind);
  request.set_title(e.title);
  request.set_dtstart(e.dtstart);
  grpc::Status status;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kNotifyDeadline);
    calnotify::NotifyReply reply;
    status = stub->NotifyAttendees(&ctx, request, &reply);
    if (status.ok() || !retryable(status.error_code())) return status;
  }
  return status;
}

static bool hasAttendee(const std::vector<std::string>& list, const std::string& item) {
  return std::find(list.begin(), list.end(), item) != list.end();
}

// Who hears what: an invitation for a new attendee, an update for one who stays, a cancel for one removed.
std::vector<std::pair<std::string, std::vector<std::string>>> changePlan(const std::optional<calendard::Event>& before,
                                                                         const calendard::Event& after) {
  if (!before) return {{"create", after.attendees}};
  std::vector<std::string> kept, added, removed;
  for (const auto& a : after.attendees) (hasAttendee(before->attendees, a) ? kept : added).push_back(a);
  for (const auto& a : before->attendees) {
    if (!hasAttendee(after.attendees, a)) removed.push_back(a);
  }
  std::vector<std::pair<std::string, std::vector<std::string>>> plan;
  for (auto& [kind, people] : std::vector<std::pair<std::string, std::vector<std::string>>>{{"update", kept}, {"create", added}, {"cancel", removed}}) {
    if (!people.empty()) plan.emplace_back(kind, people);
  }
  return plan;
}

// Tell the attendees about a committed change (before is empty for a create); the number of notifications sent.
int notifyChange(const std::optional<calendard::Event>& before, const calendard::Event& after) {
  const auto plan = changePlan(before, after);
  for (const auto& [kind, attendees] : plan) {
    const grpc::Status status = sendNotice(after, kind, attendees);
    if (!status.ok()) throw std::runtime_error(status.error_message());
  }
  return static_cast<int>(plan.size());
}
`,
    },
  },
  harness: {
    python: `import grpc

import calendar_service_pb2
import calendar_service_pb2_grpc

EVENT = {
    "event_id": "e-1",
    "calendar_id": "c1",
    "tenant": "t1",
    "title": "Standup",
    "rrule": "FREQ=WEEKLY;COUNT=4",
    "dtstart": "2026-03-02T09:00:00Z",
    "dtend": "2026-03-02T09:30:00Z",
    "revision": 1,
    "attendees": ["ana@example.com", "bo@example.com"],
}


class FakeNotifier(calendar_service_pb2_grpc.NotifierServicer):
    """Mails every attendee of a request once per token; drop_replies loses the reply after the mail went out."""

    def __init__(self):
        self.mails = []
        self.tokens = set()
        self.drop_replies = 0

    def NotifyAttendees(self, request, context):
        mailed = 0
        if request.idempotency_token == "" or request.idempotency_token not in self.tokens:
            self.tokens.add(request.idempotency_token)
            for attendee in request.attendees:
                self.mails.append((attendee, request.kind))
                mailed += 1
        if self.drop_replies > 0:
            self.drop_replies -= 1
            context.abort(grpc.StatusCode.UNAVAILABLE, "connection reset after the mail went out")
        return calendar_service_pb2.NotifyReply(mailed=mailed)


def _world(ctx):
    notifier = FakeNotifier()
    ctx.grpc.serve(calendar_service_pb2_grpc.add_NotifierServicer_to_server, notifier)
    return ctx.load("client"), notifier


def _revision(**changes):
    return {**EVENT, "revision": 2, **changes}


def _calls_for(ctx, event_id):
    return [c for c in ctx.grpc.calls_to("NotifyAttendees") if c.request.event_id == event_id]


def check_deadline(ctx):
    m, notifier = _world(ctx)
    ctx.grpc.set_latency("NotifyAttendees", 2.0)
    m.notify_change(None, dict(EVENT))
    assert sorted(notifier.mails) == [("ana@example.com", "create"), ("bo@example.com", "create")], f"a notifier that answers in 2 s mailed {notifier.mails}, expected one invitation each"
    call = ctx.grpc.calls_to("NotifyAttendees")[0]
    assert call.timeout is not None, "the NotifyAttendees call carries no deadline: a notifier that hangs holds the request worker with it"
    assert 2.5 <= call.timeout <= 3.5, f"the NotifyAttendees deadline is {call.timeout} s, expected about 3 s"
    # The first attempt takes 2 s and its reply is lost: the retry gets 3 s of its own.
    notifier.drop_replies = 1
    error = None
    try:
        m.notify_change(None, {**EVENT, "event_id": "e-2"})
    except Exception as exc:
        error = exc
    timeouts = [c.timeout for c in _calls_for(ctx, "e-2")]
    assert error is None and len(timeouts) == 2 and all(t is not None and 2.5 <= t <= 3.5 for t in timeouts), f"after a 2 s attempt whose reply was lost the attempts carried the deadlines {timeouts} and notify_change {'raised ' + type(error).__name__ if error else 'returned'}, expected about 3 s on each of 2 attempts and the notice delivered: every attempt gets its own deadline"


def check_one_token(ctx):
    m, notifier = _world(ctx)
    notifier.drop_replies = 1  # the attendees were mailed, the reply never came back
    m.notify_change(None, dict(EVENT))
    calls = ctx.grpc.calls_to("NotifyAttendees")
    assert len(calls) == 2, f"a lost reply should be retried once, got {len(calls)} calls"
    tokens = [c.request.idempotency_token for c in calls]
    assert tokens == ["e-1:1:create", "e-1:1:create"], f"the attempts carried the tokens {tokens}, expected e-1:1:create on both: the retry is the same notification"
    assert sorted(notifier.mails) == [("ana@example.com", "create"), ("bo@example.com", "create")], f"the attendees were mailed {sorted(notifier.mails)}: a retry after a lost reply mailed them again"
    # Only UNAVAILABLE and DEADLINE_EXCEEDED are retried, at most 3 attempts in all.
    for n, (code, expected) in enumerate(((grpc.StatusCode.INVALID_ARGUMENT, 1), (grpc.StatusCode.PERMISSION_DENIED, 1), (grpc.StatusCode.UNAVAILABLE, 3))):
        event_id = f"e-{n + 2}"
        ctx.grpc.fail("NotifyAttendees", code, times=expected)
        try:
            m.notify_change(None, {**EVENT, "event_id": event_id})
        except Exception:
            pass  # whether the failure reaches the caller is not this check's question
        made = len(_calls_for(ctx, event_id))
        assert made == expected, f"a notifier failing {code.name} got {made} calls, expected {expected}: only UNAVAILABLE and DEADLINE_EXCEEDED are retried, up to 3 attempts"


def check_change_kind(ctx):
    m, notifier = _world(ctx)
    m.notify_change(None, dict(EVENT))  # revision 1 invited ana and bo
    notifier.mails.clear()
    after = _revision(title="Standup (moved to room 4)", attendees=["ana@example.com", "bo@example.com", "cy@example.com"])
    sent = m.notify_change(dict(EVENT), after)
    assert ("ana@example.com", "create") not in notifier.mails, f"ana, who already has the invitation, got a new one for a title fix: {sorted(notifier.mails)}"
    assert sorted(notifier.mails) == [("ana@example.com", "update"), ("bo@example.com", "update"), ("cy@example.com", "create")], f"after the invitations of revision 1, the change to revision 2 mailed {sorted(notifier.mails)}, expected an update to ana and bo and an invitation to cy (each notification's token names revision 2)"
    assert sent == 2, f"notify_change returned {sent}, expected 2 notifications (update, create)"


def check_removed_cancel(ctx):
    m, notifier = _world(ctx)
    before = {**EVENT, "attendees": ["ana@example.com", "bo@example.com", "cy@example.com"]}
    sent = m.notify_change(before, _revision(attendees=["ana@example.com", "bo@example.com"]))
    assert ("cy@example.com", "cancel") in notifier.mails, f"cy was taken off the event and was mailed {[k for a, k in notifier.mails if a == 'cy@example.com']}: without a cancel the meeting stays in cy's calendar"
    assert sorted(notifier.mails) == [("ana@example.com", "update"), ("bo@example.com", "update"), ("cy@example.com", "cancel")], f"the change mailed {sorted(notifier.mails)}, expected updates to ana and bo and a cancel to cy"
    kinds = [c.request.kind for c in ctx.grpc.calls_to("NotifyAttendees")]
    assert sorted(kinds) == ["cancel", "update"] and sent == 2, f"the change made calls of kinds {kinds} and returned {sent}, expected one update and one cancel: an empty group gets no call"
`,
    typescript: `const EVENT = {
  event_id: 'e-1',
  calendar_id: 'c1',
  tenant: 't1',
  title: 'Standup',
  rrule: 'FREQ=WEEKLY;COUNT=4',
  dtstart: '2026-03-02T09:00:00Z',
  dtend: '2026-03-02T09:30:00Z',
  revision: 1,
  attendees: ['ana@example.com', 'bo@example.com'],
};

/** Mails every attendee of a request once per token; dropReplies loses the reply after the mail went out. */
function world(ctx) {
  const notifier = {mails: [] as string[], tokens: new Set<string>(), dropReplies: 0};
  const pkg = ctx.proto('calendar_service.proto');
  ctx.grpc.serve(pkg.calnotify.Notifier.service, {
    NotifyAttendees(call, callback) {
      const request = call.request;
      let mailed = 0;
      if (request.idempotency_token === '' || !notifier.tokens.has(request.idempotency_token)) {
        notifier.tokens.add(request.idempotency_token);
        for (const attendee of request.attendees) {
          notifier.mails.push(\`\${attendee} \${request.kind}\`);
          mailed += 1;
        }
      }
      if (notifier.dropReplies > 0) {
        notifier.dropReplies -= 1;
        return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'connection reset after the mail went out'});
      }
      callback(null, {mailed});
    },
  });
  return {m: ctx.load('client'), notifier};
}

const revision2 = (changes: Record<string, unknown>) => ({...EVENT, revision: 2, ...changes});

export async function check_deadline(ctx) {
  const {m, notifier} = world(ctx);
  ctx.grpc.setLatency('NotifyAttendees', 2.0);
  await m.notifyChange(null, {...EVENT});
  assert.deepEqual([...notifier.mails].sort(), ['ana@example.com create', 'bo@example.com create'], \`a notifier that answers in 2 s mailed \${JSON.stringify(notifier.mails)}, expected one invitation each\`);
  const call = ctx.grpc.callsTo('NotifyAttendees')[0];
  assert(call.timeout !== null, 'the NotifyAttendees call carries no deadline: a notifier that hangs holds the request worker with it');
  assert(2.5 <= call.timeout && call.timeout <= 3.5, \`the NotifyAttendees deadline is \${call.timeout} s, expected about 3 s\`);
  // The first attempt takes 2 s and its reply is lost: the retry gets 3 s of its own.
  notifier.dropReplies = 1;
  let error: unknown = null;
  try {
    await m.notifyChange(null, {...EVENT, event_id: 'e-2'});
  } catch (err) {
    error = err;
  }
  const timeouts = ctx.grpc.callsTo('NotifyAttendees').filter(c => c.request.event_id === 'e-2').map(c => c.timeout);
  assert(
    error === null && timeouts.length === 2 && timeouts.every(t => t !== null && 2.5 <= t && t <= 3.5),
    \`after a 2 s attempt whose reply was lost the attempts carried the deadlines \${JSON.stringify(timeouts)} and notifyChange \${error === null ? 'resolved' : 'rejected'}, expected about 3 s on each of 2 attempts and the notice delivered: every attempt gets its own deadline\`,
  );
}

export async function check_one_token(ctx) {
  const {m, notifier} = world(ctx);
  notifier.dropReplies = 1; // the attendees were mailed, the reply never came back
  await m.notifyChange(null, {...EVENT});
  const calls = ctx.grpc.callsTo('NotifyAttendees');
  assert.equal(calls.length, 2, \`a lost reply should be retried once, got \${calls.length} calls\`);
  const tokens = calls.map(c => c.request.idempotency_token);
  assert.deepEqual(tokens, ['e-1:1:create', 'e-1:1:create'], \`the attempts carried the tokens \${JSON.stringify(tokens)}, expected e-1:1:create on both: the retry is the same notification\`);
  assert.deepEqual([...notifier.mails].sort(), ['ana@example.com create', 'bo@example.com create'], \`the attendees were mailed \${JSON.stringify(notifier.mails)}: a retry after a lost reply mailed them again\`);
  // Only UNAVAILABLE and DEADLINE_EXCEEDED are retried, at most 3 attempts in all.
  const cases: [string, number][] = [['INVALID_ARGUMENT', 1], ['PERMISSION_DENIED', 1], ['UNAVAILABLE', 3]];
  for (const [n, [name, expected]] of cases.entries()) {
    const eventId = \`e-\${n + 2}\`;
    ctx.grpc.fail('NotifyAttendees', ctx.grpc.status[name], '', expected);
    try {
      await m.notifyChange(null, {...EVENT, event_id: eventId});
    } catch {
      // whether the failure reaches the caller is not this check's question
    }
    const made = ctx.grpc.callsTo('NotifyAttendees').filter(c => c.request.event_id === eventId).length;
    assert.equal(made, expected, \`a notifier failing \${name} got \${made} calls, expected \${expected}: only UNAVAILABLE and DEADLINE_EXCEEDED are retried, up to 3 attempts\`);
  }
}

export async function check_change_kind(ctx) {
  const {m, notifier} = world(ctx);
  await m.notifyChange(null, {...EVENT}); // revision 1 invited ana and bo
  notifier.mails.length = 0;
  const after = revision2({title: 'Standup (moved to room 4)', attendees: ['ana@example.com', 'bo@example.com', 'cy@example.com']});
  const sent = await m.notifyChange({...EVENT}, after);
  assert(!notifier.mails.includes('ana@example.com create'), \`ana, who already has the invitation, got a new one for a title fix: \${JSON.stringify(notifier.mails)}\`);
  assert.deepEqual([...notifier.mails].sort(), ['ana@example.com update', 'bo@example.com update', 'cy@example.com create'], \`after the invitations of revision 1, the change to revision 2 mailed \${JSON.stringify(notifier.mails)}, expected an update to ana and bo and an invitation to cy (each notification's token names revision 2)\`);
  assert.equal(sent, 2, \`notifyChange resolved \${sent}, expected 2 notifications (update, create)\`);
}

export async function check_removed_cancel(ctx) {
  const {m, notifier} = world(ctx);
  const before = {...EVENT, attendees: ['ana@example.com', 'bo@example.com', 'cy@example.com']};
  const sent = await m.notifyChange(before, revision2({attendees: ['ana@example.com', 'bo@example.com']}));
  assert(notifier.mails.includes('cy@example.com cancel'), \`cy was taken off the event and was mailed \${JSON.stringify(notifier.mails.filter(x => x.startsWith('cy@')))}: without a cancel the meeting stays in cy's calendar\`);
  assert.deepEqual([...notifier.mails].sort(), ['ana@example.com update', 'bo@example.com update', 'cy@example.com cancel'], \`the change mailed \${JSON.stringify(notifier.mails)}, expected updates to ana and bo and a cancel to cy\`);
  const kinds = ctx.grpc.callsTo('NotifyAttendees').map(c => c.request.kind);
  assert(JSON.stringify([...kinds].sort()) === '["cancel","update"]' && sent === 2, \`the change made calls of kinds \${JSON.stringify(kinds)} and resolved \${sent}, expected one update and one cancel: an empty group gets no call\`);
}
`,
    go: `package main

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"leetbuild/harness"

	pb "calendard/gen/calendar_service"
	"calendard/store"
)

// notifierPeer mails every attendee of a request once per token; dropReplies loses the reply after the mail went out.
type HNotifierPeer struct {
	pb.UnimplementedNotifierServer
	mails       []string
	tokens      map[string]bool
	dropReplies int
}

func (n *HNotifierPeer) NotifyAttendees(_ context.Context, req *pb.NotifyRequest) (*pb.NotifyReply, error) {
	mailed := int32(0)
	if req.GetIdempotencyToken() == "" || !n.tokens[req.GetIdempotencyToken()] {
		n.tokens[req.GetIdempotencyToken()] = true
		for _, a := range req.GetAttendees() {
			n.mails = append(n.mails, a+" "+req.GetKind())
			mailed++
		}
	}
	if n.dropReplies > 0 {
		n.dropReplies--
		return nil, status.Error(codes.Unavailable, "connection reset after the mail went out")
	}
	return &pb.NotifyReply{Mailed: mailed}, nil
}

func hNtWorld(ctx *harness.Ctx) *HNotifierPeer {
	notifier := &HNotifierPeer{tokens: map[string]bool{}}
	pb.RegisterNotifierServer(ctx.GRPC.Server(""), notifier)
	return notifier
}

func hNtEvent(revision int, title string, attendees ...string) store.Event {
	return store.Event{
		EventID: "e-1", CalendarID: "c1", Tenant: "t1", Title: title, Rrule: "FREQ=WEEKLY;COUNT=4",
		Dtstart: "2026-03-02T09:00:00Z", Dtend: "2026-03-02T09:30:00Z", Revision: revision, Attendees: attendees,
	}
}

func hNtNotify(ctx *harness.Ctx, before *store.Event, after store.Event) int {
	sent, err := notifyChange(context.Background(), before, after)
	ctx.NoError(err, "notifyChange")
	return sent
}

func hNtMails(n *HNotifierPeer) []string {
	mails := append([]string{}, n.mails...)
	sort.Strings(mails)
	return mails
}

func hNtCallsFor(ctx *harness.Ctx, eventID string) []harness.Call {
	var calls []harness.Call
	for _, c := range ctx.GRPC.CallsTo("NotifyAttendees", "") {
		if req, _ := c.Request.(*pb.NotifyRequest); req.GetEventId() == eventID {
			calls = append(calls, c)
		}
	}
	return calls
}

func hNtEventWithID(eventID string) store.Event {
	e := hNtEvent(1, "Standup", "ana@example.com", "bo@example.com")
	e.EventID = eventID
	return e
}

func CheckDeadline(ctx *harness.Ctx) {
	notifier := hNtWorld(ctx)
	ctx.GRPC.SetLatency("NotifyAttendees", 2.0, "")
	hNtNotify(ctx, nil, hNtEvent(1, "Standup", "ana@example.com", "bo@example.com"))
	ctx.Equal(hNtMails(notifier), []string{"ana@example.com create", "bo@example.com create"}, "a notifier that answers in 2 s must send one invitation each; the mails")
	call := ctx.GRPC.CallsTo("NotifyAttendees", "")[0]
	ctx.Assert(call.HasDeadline(), "the NotifyAttendees call carries no deadline: a notifier that hangs holds the request worker with it")
	ctx.Assert(2500*time.Millisecond <= call.Timeout && call.Timeout <= 3500*time.Millisecond, "the NotifyAttendees deadline is %v, expected about 3 s", call.Timeout)
	// The first attempt takes 2 s and its reply is lost: the retry gets 3 s of its own.
	notifier.dropReplies = 1
	_, err := notifyChange(context.Background(), nil, hNtEventWithID("e-2"))
	var timeouts []time.Duration
	ok := err == nil
	for _, c := range hNtCallsFor(ctx, "e-2") {
		timeouts = append(timeouts, c.Timeout)
		ok = ok && c.HasDeadline() && 2500*time.Millisecond <= c.Timeout && c.Timeout <= 3500*time.Millisecond
	}
	ctx.Assert(ok && len(timeouts) == 2, "after a 2 s attempt whose reply was lost the attempts carried the deadlines %v and notifyChange returned %v, expected about 3 s on each of 2 attempts and the notice delivered: every attempt gets its own deadline", timeouts, err)
}

func CheckOneToken(ctx *harness.Ctx) {
	notifier := hNtWorld(ctx)
	notifier.dropReplies = 1 // the attendees were mailed, the reply never came back
	hNtNotify(ctx, nil, hNtEvent(1, "Standup", "ana@example.com", "bo@example.com"))
	calls := ctx.GRPC.CallsTo("NotifyAttendees", "")
	ctx.Equal(len(calls), 2, "a lost reply is retried once; the calls")
	var tokens []string
	for _, c := range calls {
		req, _ := c.Request.(*pb.NotifyRequest)
		tokens = append(tokens, req.GetIdempotencyToken())
	}
	ctx.Equal(tokens, []string{"e-1:1:create", "e-1:1:create"}, "the attempts' tokens (the retry is the same notification)")
	ctx.Equal(hNtMails(notifier), []string{"ana@example.com create", "bo@example.com create"}, "the mails after a lost reply (a retry must not mail the attendees again)")
	// Only UNAVAILABLE and DEADLINE_EXCEEDED are retried, at most 3 attempts in all.
	cases := []struct {
		code     codes.Code
		expected int
	}{{codes.InvalidArgument, 1}, {codes.PermissionDenied, 1}, {codes.Unavailable, 3}}
	for n, tc := range cases {
		eventID := "e-" + strconv.Itoa(n+2)
		ctx.GRPC.Fail("NotifyAttendees", tc.code, "", tc.expected, "")
		_, _ = notifyChange(context.Background(), nil, hNtEventWithID(eventID)) // whether the failure reaches the caller is not this check's question
		made := len(hNtCallsFor(ctx, eventID))
		ctx.Assert(made == tc.expected, "a notifier failing %v got %d calls, expected %d: only UNAVAILABLE and DEADLINE_EXCEEDED are retried, up to 3 attempts", tc.code, made, tc.expected)
	}
}

func CheckChangeKind(ctx *harness.Ctx) {
	notifier := hNtWorld(ctx)
	before := hNtEvent(1, "Standup", "ana@example.com", "bo@example.com")
	hNtNotify(ctx, nil, before) // revision 1 invited ana and bo
	notifier.mails = nil
	sent := hNtNotify(ctx, &before, hNtEvent(2, "Standup (moved to room 4)", "ana@example.com", "bo@example.com", "cy@example.com"))
	for _, mail := range notifier.mails {
		ctx.Assert(mail != "ana@example.com create", "ana, who already has the invitation, got a new one for a title fix: %v", notifier.mails)
	}
	ctx.Equal(hNtMails(notifier), []string{"ana@example.com update", "bo@example.com update", "cy@example.com create"}, "after the invitations of revision 1, an update to ana and bo and an invitation to cy (each notification's token names revision 2); the mails")
	ctx.Equal(sent, 2, "notifyChange's count of notifications (update, create)")
}

func CheckRemovedCancel(ctx *harness.Ctx) {
	notifier := hNtWorld(ctx)
	before := hNtEvent(1, "Standup", "ana@example.com", "bo@example.com", "cy@example.com")
	sent := hNtNotify(ctx, &before, hNtEvent(2, "Standup", "ana@example.com", "bo@example.com"))
	var cy []string
	for _, mail := range notifier.mails {
		if strings.HasPrefix(mail, "cy@") {
			cy = append(cy, mail)
		}
	}
	ctx.Equal(cy, []string{"cy@example.com cancel"}, "cy was taken off the event: without a cancel the meeting stays in cy's calendar; cy's mails")
	ctx.Equal(hNtMails(notifier), []string{"ana@example.com update", "bo@example.com update", "cy@example.com cancel"}, "updates to ana and bo and a cancel to cy; the mails")
	var kinds []string
	for _, c := range ctx.GRPC.CallsTo("NotifyAttendees", "") {
		req, _ := c.Request.(*pb.NotifyRequest)
		kinds = append(kinds, req.GetKind())
	}
	sort.Strings(kinds)
	ctx.Assert(strings.Join(kinds, ",") == "cancel,update" && sent == 2, "the change made calls of kinds %v and returned %d, expected one update and one cancel: an empty group gets no call", kinds, sent)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <optional>
#include <set>
#include <string>
#include <tuple>
#include <vector>

namespace {

// Mails every attendee of a request once per token; drop_replies loses the reply after the mail went out.
class HNotifierPeer final : public calnotify::Notifier::Service {
 public:
  std::vector<std::string> mails;
  std::set<std::string> tokens;
  int drop_replies = 0;

  grpc::Status NotifyAttendees(grpc::ServerContext*, const calnotify::NotifyRequest* req, calnotify::NotifyReply* reply) override {
    int mailed = 0;
    if (req->idempotency_token().empty() || !tokens.count(req->idempotency_token())) {
      tokens.insert(req->idempotency_token());
      for (const auto& a : req->attendees()) {
        mails.push_back(a + " " + req->kind());
        mailed++;
      }
    }
    if (drop_replies > 0) {
      drop_replies--;
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, "connection reset after the mail went out");
    }
    reply->set_mailed(mailed);
    return grpc::Status::OK;
  }
};

HNotifierPeer* hNtWorld(harness::Ctx& ctx) {
  static HNotifierPeer* notifier = nullptr;
  delete notifier;
  notifier = new HNotifierPeer;
  ctx.GRPC.Server("")->RegisterService(notifier);
  return notifier;
}

calendard::Event hNtEvent(int64_t revision, const std::string& title, const std::vector<std::string>& attendees) {
  return calendard::Event{"e-1", "c1", "t1", title, "FREQ=WEEKLY;COUNT=4", "2026-03-02T09:00:00Z", "2026-03-02T09:30:00Z", revision, attendees};
}

std::vector<std::string> hNtMails(const HNotifierPeer* n) {
  std::vector<std::string> mails = n->mails;
  std::sort(mails.begin(), mails.end());
  return mails;
}

calendard::Event hNtEventWithId(const std::string& event_id) {
  auto e = hNtEvent(1, "Standup", {"ana@example.com", "bo@example.com"});
  e.event_id = event_id;
  return e;
}

std::vector<harness::Call> hNtCallsFor(harness::Ctx& ctx, const std::string& event_id) {
  std::vector<harness::Call> calls;
  for (const auto& c : ctx.GRPC.CallsTo("NotifyAttendees")) {
    if (c.Request<calnotify::NotifyRequest>().event_id() == event_id) calls.push_back(c);
  }
  return calls;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  auto* notifier = hNtWorld(ctx);
  ctx.GRPC.SetLatency("NotifyAttendees", 2.0);
  notifyChange(std::nullopt, hNtEvent(1, "Standup", {"ana@example.com", "bo@example.com"}));
  ctx.Equal(hNtMails(notifier), {"ana@example.com create", "bo@example.com create"}, "a notifier that answers in 2 s must send one invitation each; the mails");
  const auto call = ctx.GRPC.CallsTo("NotifyAttendees")[0];
  ctx.Assert(call.HasDeadline(), "the NotifyAttendees call carries no deadline: a notifier that hangs holds the request worker with it");
  ctx.Assert(2.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 3.5, "the NotifyAttendees deadline is %vs, expected about 3 s", call.TimeoutSeconds());
  // The first attempt takes 2 s and its reply is lost: the retry gets 3 s of its own.
  notifier->drop_replies = 1;
  std::string error;
  try {
    notifyChange(std::nullopt, hNtEventWithId("e-2"));
  } catch (const std::exception& e) {
    error = e.what();
  }
  std::vector<double> timeouts;
  bool ok = error.empty();
  for (const auto& c : hNtCallsFor(ctx, "e-2")) {
    timeouts.push_back(c.TimeoutSeconds());
    ok = ok && c.HasDeadline() && 2.5 <= c.TimeoutSeconds() && c.TimeoutSeconds() <= 3.5;
  }
  ctx.Assert(ok && timeouts.size() == 2,
             "after a 2 s attempt whose reply was lost the attempts carried the deadlines %v and notifyChange threw %q, expected about 3 s on each of 2 "
             "attempts and the notice delivered: every attempt gets its own deadline",
             timeouts, error);
}

void CheckOneToken(harness::Ctx& ctx) {
  auto* notifier = hNtWorld(ctx);
  notifier->drop_replies = 1;  // the attendees were mailed, the reply never came back
  notifyChange(std::nullopt, hNtEvent(1, "Standup", {"ana@example.com", "bo@example.com"}));
  const auto calls = ctx.GRPC.CallsTo("NotifyAttendees");
  ctx.Equal(calls.size(), 2, "a lost reply is retried once; the calls");
  std::vector<std::string> tokens;
  for (const auto& c : calls) tokens.push_back(c.Request<calnotify::NotifyRequest>().idempotency_token());
  ctx.Equal(tokens, {"e-1:1:create", "e-1:1:create"}, "the attempts' tokens (the retry is the same notification)");
  ctx.Equal(hNtMails(notifier), {"ana@example.com create", "bo@example.com create"}, "the mails after a lost reply (a retry must not mail the attendees again)");
  // Only UNAVAILABLE and DEADLINE_EXCEEDED are retried, at most 3 attempts in all.
  const std::vector<std::tuple<grpc::StatusCode, std::string, int>> cases = {
      {grpc::StatusCode::INVALID_ARGUMENT, "INVALID_ARGUMENT", 1}, {grpc::StatusCode::PERMISSION_DENIED, "PERMISSION_DENIED", 1}, {grpc::StatusCode::UNAVAILABLE, "UNAVAILABLE", 3}};
  for (size_t n = 0; n < cases.size(); n++) {
    const auto& [code, name, expected] = cases[n];
    const std::string event_id = "e-" + std::to_string(n + 2);
    ctx.GRPC.Fail("NotifyAttendees", code, "", expected);
    try {
      notifyChange(std::nullopt, hNtEventWithId(event_id));
    } catch (...) {
      // whether the failure reaches the caller is not this check's question
    }
    const int made = static_cast<int>(hNtCallsFor(ctx, event_id).size());
    ctx.Assert(made == expected, "a notifier failing %s got %d calls, expected %d: only UNAVAILABLE and DEADLINE_EXCEEDED are retried, up to 3 attempts", name, made, expected);
  }
}

void CheckChangeKind(harness::Ctx& ctx) {
  auto* notifier = hNtWorld(ctx);
  const auto before = hNtEvent(1, "Standup", {"ana@example.com", "bo@example.com"});
  notifyChange(std::nullopt, before);  // revision 1 invited ana and bo
  notifier->mails.clear();
  const int sent = notifyChange(before, hNtEvent(2, "Standup (moved to room 4)", {"ana@example.com", "bo@example.com", "cy@example.com"}));
  for (const auto& mail : notifier->mails) {
    ctx.Assert(mail != "ana@example.com create", "ana, who already has the invitation, got a new one for a title fix: %v", notifier->mails);
  }
  ctx.Equal(hNtMails(notifier), {"ana@example.com update", "bo@example.com update", "cy@example.com create"},
            "after the invitations of revision 1, an update to ana and bo and an invitation to cy (each notification's token names revision 2); the mails");
  ctx.Equal(sent, 2, "notifyChange's count of notifications (update, create)");
}

void CheckRemovedCancel(harness::Ctx& ctx) {
  auto* notifier = hNtWorld(ctx);
  const int sent = notifyChange(hNtEvent(1, "Standup", {"ana@example.com", "bo@example.com", "cy@example.com"}),
                                hNtEvent(2, "Standup", {"ana@example.com", "bo@example.com"}));
  std::vector<std::string> cy;
  for (const auto& mail : notifier->mails) {
    if (mail.rfind("cy@", 0) == 0) cy.push_back(mail);
  }
  ctx.Equal(cy, {"cy@example.com cancel"}, "cy was taken off the event: without a cancel the meeting stays in cy's calendar; cy's mails");
  ctx.Equal(hNtMails(notifier), {"ana@example.com update", "bo@example.com update", "cy@example.com cancel"}, "updates to ana and bo and a cancel to cy; the mails");
  std::vector<std::string> kinds;
  for (const auto& c : ctx.GRPC.CallsTo("NotifyAttendees")) kinds.push_back(c.Request<calnotify::NotifyRequest>().kind());
  std::sort(kinds.begin(), kinds.end());
  ctx.Assert(kinds == std::vector<std::string>{"cancel", "update"} && sent == 2,
             "the change made calls of kinds %v and returned %d, expected one update and one cancel: an empty group gets no call", kinds, sent);
}
`,
  },
  hints: [
    'Attendees whose first notice timed out get two copies, people who accepted get a fresh invitation for a typo fix, a removed colleague keeps the meeting, and a slow notifier pins a request worker.',
    'A token drawn per attempt makes the retry a new notification as far as the notifier can tell; sending `create` to the attendees of `after` ignores what `before` already told them; without a deadline the call waits as long as the notifier does.',
    'In `send_notice`, build the token `{event_id}:{revision}:{kind}` once before the loop and pass `timeout=NOTIFY_DEADLINE_S`; in `notify_change`, diff `before` and `after`: `update` to kept, `create` to added, `cancel` to removed, skipping empty groups.',
  ],
  debrief: `The token is derived from what the notification is about, not from the attempt, which is what lets the notifier recognize a retry after a lost reply as the mail it already sent: a timeout says nothing about whether the work happened. The kind is a diff per attendee because people act on it: an invitation asks for an answer, an update does not, and only a cancel takes the meeting out of a removed person's calendar. The deadline bounds how long one slow dependency can hold a request. Production calendars queue these notices behind the commit and send them from a worker, and they coalesce a burst of quick edits into one update.`,
};
