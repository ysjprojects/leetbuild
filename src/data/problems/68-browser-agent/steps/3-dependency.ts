import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Step calls to the driver with timeouts and no blind retries',
  concept: 'grpc',
  file: 'client',
  focus: ['worker', 'driver', 'profile'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it sends every action to the
driver through one \`for\` loop with a single \`RETRIES = 3\` constant and no deadline on any call, and
the demo passes because the first click lands on a page that is already open. It hides a
double-submitted form, a hung page that keeps receiving actions, and a retry policy that replays
whatever side effect it is handed. Review it like the owner of the worker’s driver client, fix it,
and prove the fix with the checks below.

Every action the step loop runs goes out over **gRPC** through the worker’s \`BrowserDriver\` stub
(\`Navigate\`, \`Act\`, \`Snapshot\`, \`ClosePage\`):

- Every driver call carries an explicit **15 s** deadline — \`DEADLINE_MS = 15_000\` — passed as the
  call’s own timeout, and the returned status is checked. A call without one lets a stuck driver pin
  a worker for the rest of the session.
- Retryability is **per action**, never one global flag: a \`RETRYABLE_ACTIONS\` table names only the
  repeatable actions (\`navigate\`, \`snapshot\`, \`wait\`); \`click\`, \`submit\` and \`type\` get exactly one
  attempt, because a replay clicks a button that was already clicked and submits a form twice.
- A retry is gated on the gRPC **status**, not on “it threw”: only \`UNAVAILABLE\` and
  \`DEADLINE_EXCEEDED\` are retryable, and every other status (\`INVALID_ARGUMENT\`,
  \`FAILED_PRECONDITION\`) goes straight back to the caller.
- A \`click\` that times out is **verified against page state before any retry decision**: the worker
  reads \`Snapshot\` and compares the page digest against the action’s target. The order matters —
  snapshot/verify first, and only if the page proves the first click did not land may the action run
  again. A blind replay is exactly how the form gets submitted twice.
- A **hung page** is closed with \`ClosePage\` before the next action is started on that session, and
  until the page is closed the next action on it is refused rather than queued behind a dead page.
- The action loop charges the session budget **once per accepted action**, after the driver accepts
  it, so a retried attempt cannot silently double the side effect — the budget and resume contract
  the state step keeps in \`session:{id}\` stays true.

**Failure mode the checks target.** The draft loops \`click\` and \`submit\` through the same
three-attempt retry it uses for a \`navigate\`, sends every call with no deadline, and its \`RETRIES\`
constant is the only policy it has. So a click whose deadline expired after the page already handled
it is sent again — the form is submitted twice — a permanent \`INVALID_ARGUMENT\` is attempted three
times, and a page that never answers is left open while the loop starts the next action on it. None
of it shows up in a demo where the first attempt lands in milliseconds; all of it is
customer-visible in production.`,
  sequence: {
    participants: ['Worker', 'Browser driver', 'Session state'],
    messages: [
      {from: 'Worker', to: 'Browser driver', label: 'Act(click, #submit) · deadline 15 s', kind: 'sync'},
      {from: 'Browser driver', to: 'Worker', label: 'DEADLINE_EXCEEDED · the click may have landed', kind: 'reply'},
      {
        from: 'Worker',
        to: 'Worker',
        label: 'navigate · snapshot · wait → retry ≤ 3 · click/submit/type → never',
        kind: 'sync',
      },
      {from: 'Worker', to: 'Browser driver', label: 'Snapshot() · read the page digest before any retry', kind: 'sync'},
      {
        from: 'Browser driver',
        to: 'Worker',
        label: 'digest == target · the click landed, do not replay',
        kind: 'reply',
      },
      {from: 'Worker', to: 'Browser driver', label: 'ClosePage() before the next action on a hung page', kind: 'sync'},
      {from: 'Worker', to: 'Session state', label: 'charge one step, once per accepted action', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every driver call carries the 15 s deadline',
      detail:
        'Each `Act`, `Snapshot`, `ClosePage` and `Navigate` goes out with the call’s own deadline taken from one constant — `DEADLINE_MS = 15_000` — and the returned status is checked. The draft sends every call with no deadline at all, so one stuck driver pins a worker for the rest of the session.',
      match: {
        python: {all: [/DEADLINE_MS = 15_000/, /timeout=DEADLINE_MS \/ 1000/]},
        typescript: {all: [/DEADLINE_MS = 15_000/, /deadline: Date\.now\(\) \+ DEADLINE_MS/]},
        go: {
          all: [
            /deadlineMS\s*=\s*15000/,
            /context\.WithTimeout\(ctx, time\.Duration\(deadlineMS\)\*time\.Millisecond\)/,
          ],
        },
        scala: {all: [/DeadlineMs = 15000/, /withDeadlineAfter\(DeadlineMs, TimeUnit\.MILLISECONDS\)/]},
        cpp: {
          all: [
            /kDeadlineMs = 15000/,
            /set_deadline\(std::chrono::system_clock::now\(\) \+ std::chrono::milliseconds\(kDeadlineMs\)\)/,
          ],
        },
      },
    },
    {
      id: 'retry-policy',
      title: 'Retries are per action, never for a side effect',
      detail:
        'The attempt bound comes from a per-action table, not a global flag: `RETRYABLE_ACTIONS` (`navigate`, `snapshot`, `wait`) gets up to 3 attempts while `click`, `submit` and `type` — named in `SIDE_EFFECTING_ACTIONS` — get exactly one. The draft’s single `RETRIES` constant loops every action three times, so a click and a submit are replayed like a navigate.',
      match: {
        python: {
          all: [
            /RETRYABLE_ACTIONS = \{"navigate", "snapshot", "wait"\}/,
            /SIDE_EFFECTING_ACTIONS = \{"click", "submit", "type"\}/,
            /attempts = MAX_ATTEMPTS if retryable else 1/,
          ],
        },
        typescript: {
          all: [
            /RETRYABLE_ACTIONS = new Set\(\['navigate', 'snapshot', 'wait'\]\)/,
            /SIDE_EFFECTING_ACTIONS = new Set\(\['click', 'submit', 'type'\]\)/,
            /attempts = retryable \? MAX_ATTEMPTS : 1/,
          ],
        },
        go: {
          all: [
            /retryableActions = map\[string\]bool\{"navigate": true, "snapshot": true, "wait": true\}/,
            /sideEffectingActions = map\[string\]bool\{"click": true, "submit": true, "type": true\}/,
            /attempts := 1/,
            /attempts = maxAttempts/,
          ],
        },
        scala: {
          all: [
            /RetryableActions = Set\("navigate", "snapshot", "wait"\)/,
            /SideEffectingActions = Set\("click", "submit", "type"\)/,
            /attempts = if \(RetryableActions\.contains\(action\)\) MaxAttempts else 1/,
          ],
        },
        cpp: {
          all: [
            /kRetryableActions = \{"navigate", "snapshot", "wait"\}/,
            /kSideEffectingActions = \{"click", "submit", "type"\}/,
            /attempts = retryable \? kMaxAttempts : 1/,
          ],
        },
      },
    },
    {
      id: 'verify-before-retry',
      title: 'Reads page state before retrying a timed-out click',
      detail:
        'A timed-out side-effecting `Act` is followed by a `Snapshot` reading the page digest, and the `Act` is only sent again if the page proves the first click did not land — snapshot first, then maybe the retry. The draft goes straight back into `Act`, so a click the page already handled is sent a second time and the form is submitted twice.',
      match: {
        python: {order: [/stub\.Snapshot\(/, /stub\.Act\(/], all: [/state\.digest/]},
        typescript: {order: [/stub\.snapshot\(/, /stub\.act\(/], all: [/state\.digest/]},
        go: {order: [/stub\.Snapshot\(/, /stub\.Act\(/], all: [/state\.Digest/]},
        scala: {order: [/\.snapshot\(/, /\.act\(/], all: [/state\.digest/]},
        cpp: {order: [/stub->Snapshot\(/, /stub->Act\(/], all: [/state\.digest\(\)/]},
      },
    },
    {
      id: 'close-hung-page',
      title: 'Closes a hung page before the next action',
      detail:
        'When the session is `hung`, `ClosePage` is called before any other action is started on it and the page-closed flag is set, so the next action runs on a fresh page instead of a socket that stopped answering. The draft leaves the hung page open and queues the next action on it anyway.',
      match: {
        python: {order: [/stub\.ClosePage\(/, /stub\.Act\(/], all: [/session\.hung/]},
        typescript: {order: [/stub\.closePage\(/, /stub\.act\(/], all: [/session\.hung/]},
        go: {order: [/stub\.ClosePage\(/, /stub\.Act\(/], all: [/session\.Hung/]},
        scala: {order: [/\.closePage\(/, /\.act\(/], all: [/session\.hung/]},
        cpp: {order: [/stub->ClosePage\(/, /stub->Act\(/], all: [/session\.hung/]},
      },
    },
    {
      id: 'status-retryable',
      title: 'Retries only UNAVAILABLE and DEADLINE_EXCEEDED',
      detail:
        'Retryability is a property of the returned status, not of “it threw”: a `RETRYABLE_STATUS` set names `UNAVAILABLE` and `DEADLINE_EXCEEDED`, every other code is returned to the caller immediately, and the retry branch matches the status against that set. The draft catches every error and continues, so a permanent `INVALID_ARGUMENT` is attempted three times.',
      match: {
        python: {
          all: [
            /RETRYABLE_STATUS = \{grpc\.StatusCode\.UNAVAILABLE, grpc\.StatusCode\.DEADLINE_EXCEEDED\}/,
            /status not in RETRYABLE_STATUS/,
          ],
        },
        typescript: {
          all: [
            /\[grpc\.status\.UNAVAILABLE\]: true/,
            /\[grpc\.status\.DEADLINE_EXCEEDED\]: true/,
            /RETRYABLE_STATUS\[code\] !== true/,
          ],
        },
        go: {all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/, /retryableStatus\[status\.Code\(err\)\]/]},
        scala: {
          all: [/Status\.Code\.UNAVAILABLE/, /Status\.Code\.DEADLINE_EXCEEDED/, /RetryableStatus\.contains\(status\)/],
        },
        cpp: {
          all: [
            /grpc::StatusCode::UNAVAILABLE/,
            /grpc::StatusCode::DEADLINE_EXCEEDED/,
            /kRetryableStatus\.count\(status\.error_code\(\)\)/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

logger = logging.getLogger("browser.worker")

RETRIES = 3
ACTIONS = ("navigate", "click", "type", "submit", "snapshot", "wait")


class ActRequest:
    def __init__(self, session_id: str, action: str, target: str) -> None:
        self.session_id = session_id
        self.action = action
        self.target = target


class ActReply:
    outcome: str


class BrowserDriverStub:
    """The worker's gRPC client for the browser driver."""

    def Navigate(self, request):
        raise NotImplementedError

    def Act(self, request: ActRequest) -> ActReply:
        raise NotImplementedError

    def Snapshot(self, request):
        raise NotImplementedError

    def ClosePage(self, request):
        raise NotImplementedError


class Budget:
    """The session's remaining steps: one step buys one accepted action."""

    def charge(self) -> None:
        raise NotImplementedError


def execute_action(session, action: str, target: str, stub: BrowserDriverStub, budget: Budget) -> str:
    # TODO: one global retry count and no deadline on any driver call, and a timed-out click is sent
    # again three times; a hung page is left open and the next action runs on it. Put a 15 s deadline
    # on every call from DEADLINE_MS, keep a per-action retry table so click/submit/type get one
    # attempt, read page state with Snapshot before any retry, close a hung page with ClosePage
    # before the next action, gate retries on UNAVAILABLE / DEADLINE_EXCEEDED and charge the budget
    # once per accepted action.
    if action not in ACTIONS:
        raise KeyError(action)
    for _ in range(RETRIES):
        try:
            reply = stub.Act(ActRequest(session_id=session.id, action=action, target=target))
            budget.charge()
            return reply.outcome
        except grpc.RpcError:
            logger.warning("action %s attempt failed", action)
    raise RuntimeError("action %s failed" % action)
`,
      solution: `import grpc

DEADLINE_MS = 15_000
MAX_ATTEMPTS = 3
RETRYABLE_STATUS = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

# Only repeatable actions may be attempted again: replaying a click, a submit or a type acts twice
# on a page that already moved.
RETRYABLE_ACTIONS = {"navigate", "snapshot", "wait"}
SIDE_EFFECTING_ACTIONS = {"click", "submit", "type"}


class ActRequest:
    def __init__(self, session_id: str, action: str, target: str) -> None:
        self.session_id = session_id
        self.action = action
        self.target = target


class ActReply:
    outcome: str


class PageState:
    digest: str
    outcome: str


class BrowserDriverStub:
    """The worker's gRPC client for the browser driver."""

    def Navigate(self, request, timeout: float):
        raise NotImplementedError

    def Act(self, request: ActRequest, timeout: float) -> ActReply:
        raise NotImplementedError

    def Snapshot(self, request, timeout: float) -> PageState:
        raise NotImplementedError

    def ClosePage(self, request, timeout: float):
        raise NotImplementedError


class Budget:
    """The session's remaining steps: one step buys one accepted action."""

    def charge(self) -> None:
        raise NotImplementedError


def execute_action(session, action: str, target: str, stub: BrowserDriverStub, budget: Budget) -> str:
    if action not in RETRYABLE_ACTIONS | SIDE_EFFECTING_ACTIONS:
        raise KeyError(action)
    if session.hung and not session.page_closed:
        # A hung page is closed before anything else is started on this session.
        stub.ClosePage(ClosePageRequest(session_id=session.id), timeout=DEADLINE_MS / 1000)
        session.page_closed = True
    request = ActRequest(session_id=session.id, action=action, target=target)
    retryable = action in RETRYABLE_ACTIONS
    attempts = MAX_ATTEMPTS if retryable else 1
    for attempt in range(attempts):
        try:
            reply = stub.Act(request, timeout=DEADLINE_MS / 1000)
        except grpc.RpcError as error:
            status = error.code()
            if status is grpc.StatusCode.DEADLINE_EXCEEDED and action in SIDE_EFFECTING_ACTIONS:
                # The click may have landed before the socket died: read the page state before
                # deciding anything, because a blind replay submits the form twice.
                state = stub.Snapshot(SnapshotRequest(session_id=session.id), timeout=DEADLINE_MS / 1000)
                if state.digest == target:
                    budget.charge()  # the side effect landed exactly once
                    return state.outcome
                # The page proves the action did not land: only now may it be replayed, once.
                reply = stub.Act(request, timeout=DEADLINE_MS / 1000)
                budget.charge()
                return reply.outcome
            if status not in RETRYABLE_STATUS or not retryable or attempt + 1 >= attempts:
                raise
        else:
            # Charged once, after the driver accepted the action: a refused or retried attempt burns nothing.
            budget.charge()
            return reply.outcome
    raise RuntimeError("action %s exhausted %d attempts" % (action, attempts))
`,
    },
    typescript: {
      starter: `/** Browser driver client: a model-generated draft that retries every action under one constant. */
const RETRIES = 3;
const ACTIONS = ['navigate', 'click', 'type', 'submit', 'snapshot', 'wait'];

interface ActRequest {
  sessionId: string;
  action: string;
  target: string;
}

interface ActReply {
  outcome: string;
}

export interface DriverClient {
  act(request: ActRequest): Promise<ActReply>;
}

export interface Session {
  id: string;
}

export interface Budget {
  charge(): void;
}

export async function executeAction(
  session: Session,
  action: string,
  target: string,
  stub: DriverClient,
  budget: Budget,
): Promise<string> {
  // TODO: one global retry count and no deadline on any driver call, and a timed-out click is sent
  // again three times; a hung page is left open and the next action runs on it. Put a 15 s deadline
  // on every call from DEADLINE_MS, keep a per-action retry table so click/submit/type get one
  // attempt, read page state with snapshot before any retry, close a hung page with closePage before
  // the next action, gate retries on UNAVAILABLE / DEADLINE_EXCEEDED and charge the budget once per
  // accepted action.
  if (!ACTIONS.includes(action)) throw new Error(\`unknown action \${action}\`);
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const reply = await stub.act({sessionId: session.id, action, target});
      budget.charge();
      return reply.outcome;
    } catch {
      continue;
    }
  }
  throw new Error(\`action \${action} failed\`);
}
`,
      solution: `/** Browser driver client: a 15 s deadline on every call, retries only where a replay is safe. */
import * as grpc from '@grpc/grpc-js';

const DEADLINE_MS = 15_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

// Only repeatable actions may be attempted again: replaying a click, a submit or a type acts twice.
const RETRYABLE_ACTIONS = new Set(['navigate', 'snapshot', 'wait']);
const SIDE_EFFECTING_ACTIONS = new Set(['click', 'submit', 'type']);

interface ActRequest {
  sessionId: string;
  action: string;
  target: string;
}

interface ActReply {
  outcome: string;
}

interface PageState {
  digest: string;
  outcome: string;
}

export interface DriverClient {
  navigate(request: {sessionId: string}, options: {deadline: number}): Promise<unknown>;
  act(request: ActRequest, options: {deadline: number}): Promise<ActReply>;
  snapshot(request: {sessionId: string}, options: {deadline: number}): Promise<PageState>;
  closePage(request: {sessionId: string}, options: {deadline: number}): Promise<unknown>;
}

export interface Session {
  id: string;
  hung: boolean;
  pageClosed: boolean;
}

export interface Budget {
  charge(): void;
}

export async function executeAction(
  session: Session,
  action: string,
  target: string,
  stub: DriverClient,
  budget: Budget,
): Promise<string> {
  if (!RETRYABLE_ACTIONS.has(action) && !SIDE_EFFECTING_ACTIONS.has(action)) throw new Error(\`unknown action \${action}\`);
  if (session.hung && !session.pageClosed) {
    // A hung page is closed before anything else is started on this session.
    await stub.closePage({sessionId: session.id}, {deadline: Date.now() + DEADLINE_MS});
    session.pageClosed = true;
  }
  const request = {sessionId: session.id, action, target};
  const retryable = RETRYABLE_ACTIONS.has(action);
  const attempts = retryable ? MAX_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const reply = await stub.act(request, {deadline: Date.now() + DEADLINE_MS});
      budget.charge(); // Once per accepted action: a refused or retried attempt burns nothing.
      return reply.outcome;
    } catch (error) {
      const code = (error as grpc.ServiceError).code;
      if (code === grpc.status.DEADLINE_EXCEEDED && SIDE_EFFECTING_ACTIONS.has(action)) {
        // The click may have landed before the socket died: read page state before deciding,
        // because a blind replay submits the form twice.
        const state = await stub.snapshot({sessionId: session.id}, {deadline: Date.now() + DEADLINE_MS});
        if (state.digest === target) {
          budget.charge();
          return state.outcome;
        }
        // The page proves the action did not land: only now may it be replayed, once.
        const reply = await stub.act(request, {deadline: Date.now() + DEADLINE_MS});
        budget.charge();
        return reply.outcome;
      }
      if (RETRYABLE_STATUS[code] !== true || !retryable || attempt + 1 >= attempts) throw error;
    }
  }
  throw new Error(\`action \${action} exhausted \${attempts} attempts\`);
}
`,
    },
    go: {
      starter: `package worker

import (
	"context"
	"fmt"
	"log"
)

const retries = 3

var actions = map[string]bool{
	"navigate": true,
	"click":    true,
	"type":     true,
	"submit":   true,
	"snapshot": true,
	"wait":     true,
}

type ActRequest struct {
	SessionID string
	Action    string
	Target    string
}

type ActReply struct {
	Outcome string
}

type DriverClient interface {
	Act(ctx context.Context, req *ActRequest) (*ActReply, error)
}

type Session struct {
	ID string
}

type Budget struct {
	remaining int
}

func (b *Budget) Charge() {
	b.remaining--
}

// TODO: one global retry count and no deadline on any driver call, and a timed-out click is sent
// again three times; a hung page is left open and the next action runs on it. Put a 15 s deadline on
// every call from deadlineMS, keep a per-action retry table so click/submit/type get one attempt,
// read page state with Snapshot before any retry, close a hung page with ClosePage before the next
// action, gate retries on UNAVAILABLE / DEADLINE_EXCEEDED and charge the budget once per accepted
// action.
func executeAction(ctx context.Context, session *Session, action, target string, stub DriverClient, budget *Budget) (string, error) {
	if !actions[action] {
		return "", fmt.Errorf("unknown action %s", action)
	}
	for attempt := 0; attempt < retries; attempt++ {
		reply, err := stub.Act(ctx, &ActRequest{SessionID: session.ID, Action: action, Target: target})
		if err == nil {
			budget.Charge()
			return reply.Outcome, nil
		}
		log.Printf("action %s attempt failed: %v", action, err)
	}
	return "", fmt.Errorf("action %s failed", action)
}
`,
      solution: `package worker

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	deadlineMS  = 15000
	maxAttempts = 3
)

var retryableStatus = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

// Only repeatable actions may be attempted again: replaying a click, a submit or a type acts twice.
var retryableActions = map[string]bool{"navigate": true, "snapshot": true, "wait": true}
var sideEffectingActions = map[string]bool{"click": true, "submit": true, "type": true}

type ActRequest struct {
	SessionID string
	Action    string
	Target    string
}

type ActReply struct {
	Outcome string
}

type PageState struct {
	Digest  string
	Outcome string
}

type DriverClient interface {
	Navigate(ctx context.Context, req *ActRequest) (*ActReply, error)
	Act(ctx context.Context, req *ActRequest) (*ActReply, error)
	Snapshot(ctx context.Context, req *ActRequest) (*PageState, error)
	ClosePage(ctx context.Context, req *ActRequest) (*ActReply, error)
}

type Session struct {
	ID         string
	Hung       bool
	PageClosed bool
}

type Budget struct {
	remaining int
}

func (b *Budget) Charge() {
	b.remaining--
}

func executeAction(ctx context.Context, session *Session, action, target string, stub DriverClient, budget *Budget) (string, error) {
	if !retryableActions[action] && !sideEffectingActions[action] {
		return "", fmt.Errorf("unknown action %s", action)
	}
	if session.Hung && !session.PageClosed {
		// A hung page is closed before anything else is started on this session.
		closeCtx, cancel := context.WithTimeout(ctx, time.Duration(deadlineMS)*time.Millisecond)
		_, err := stub.ClosePage(closeCtx, &ActRequest{SessionID: session.ID})
		cancel()
		if err != nil {
			return "", err
		}
		session.PageClosed = true
	}
	req := &ActRequest{SessionID: session.ID, Action: action, Target: target}
	attempts := 1
	if retryableActions[action] {
		attempts = maxAttempts
	}
	for attempt := 0; attempt < attempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, time.Duration(deadlineMS)*time.Millisecond)
		reply, err := stub.Act(callCtx, req)
		cancel()
		if err == nil {
			// Charged once, after the driver accepted the action: a refused or retried attempt burns nothing.
			budget.Charge()
			return reply.Outcome, nil
		}
		if status.Code(err) == codes.DeadlineExceeded && sideEffectingActions[action] {
			// The click may have landed before the deadline: read page state before deciding.
			stateCtx, cancelState := context.WithTimeout(ctx, time.Duration(deadlineMS)*time.Millisecond)
			state, stateErr := stub.Snapshot(stateCtx, req)
			cancelState()
			if stateErr != nil {
				return "", stateErr
			}
			if state.Digest == target {
				budget.Charge()
				return state.Outcome, nil
			}
			// The page proves the action did not land: only now may it be replayed, once.
			retryCtx, cancelRetry := context.WithTimeout(ctx, time.Duration(deadlineMS)*time.Millisecond)
			retryReply, retryErr := stub.Act(retryCtx, req)
			cancelRetry()
			if retryErr != nil {
				return "", retryErr
			}
			budget.Charge()
			return retryReply.Outcome, nil
		}
		if !retryableStatus[status.Code(err)] || !retryableActions[action] || attempt+1 >= attempts {
			return "", err
		}
	}
	return "", errors.New("action " + action + " exhausted attempts")
}
`,
    },
    scala: {
      starter: `import io.grpc.StatusRuntimeException

object DriverClient {
  val Retries = 3
  val Actions = Set("navigate", "click", "type", "submit", "snapshot", "wait")

  final case class ActRequest(sessionId: String, action: String, target: String)
  final case class ActReply(outcome: String)

  trait Session {
    def id: String
  }

  trait Budget {
    def charge(): Unit
  }

  // TODO: one global retry count and no deadline on any driver call, and a timed-out click is sent
  // again three times; a hung page is left open and the next action runs on it. Put a 15 s deadline
  // on every call from DeadlineMs, keep a per-action retry table so click/submit/type get one
  // attempt, read page state with snapshot before any retry, close a hung page with closePage
  // before the next action, gate retries on UNAVAILABLE / DEADLINE_EXCEEDED and charge the budget
  // once per accepted action.
  def executeAction(session: Session, action: String, target: String, stub: BrowserDriverStub, budget: Budget): String = {
    if (!Actions.contains(action)) throw new IllegalArgumentException(action)
    var attempt = 0
    while (attempt < Retries) {
      try {
        val reply = stub.act(ActRequest(sessionId = session.id, action = action, target = target))
        budget.charge()
        return reply.outcome
      } catch {
        case _: StatusRuntimeException => ()
      }
      attempt += 1
    }
    throw new RuntimeException("action " + action + " failed")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{Status, StatusRuntimeException}

object DriverClient {
  val DeadlineMs = 15000
  val MaxAttempts = 3
  val RetryableStatus: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  // Only repeatable actions may be attempted again: replaying a click, a submit or a type acts twice.
  val RetryableActions = Set("navigate", "snapshot", "wait")
  val SideEffectingActions = Set("click", "submit", "type")

  final case class ActRequest(sessionId: String, action: String, target: String)
  final case class ActReply(outcome: String)
  final case class PageState(digest: String, outcome: String)

  trait Session {
    def id: String
    def hung: Boolean
    def pageClosed: Boolean
    def markPageClosed(): Unit
  }

  trait Budget {
    def charge(): Unit
  }

  def executeAction(session: Session, action: String, target: String, stub: BrowserDriverStub, budget: Budget): String = {
    if (!RetryableActions.contains(action) && !SideEffectingActions.contains(action)) {
      throw new IllegalArgumentException(action)
    }
    if (session.hung && !session.pageClosed) {
      // A hung page is closed before anything else is started on this session.
      stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).closePage(ClosePageRequest(session.id))
      session.markPageClosed()
    }
    val request = ActRequest(sessionId = session.id, action = action, target = target)
    val attempts = if (RetryableActions.contains(action)) MaxAttempts else 1
    var attempt = 0
    while (attempt < attempts) {
      try {
        val reply = stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).act(request)
        budget.charge() // Once per accepted action: a refused or retried attempt burns nothing.
        return reply.outcome
      } catch {
        case exc: StatusRuntimeException =>
          val status = exc.getStatus.getCode
          if (status == Status.Code.DEADLINE_EXCEEDED && SideEffectingActions.contains(action)) {
            // The click may have landed before the socket died: read page state before deciding.
            val state = stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).snapshot(SnapshotRequest(session.id))
            if (state.digest == target) {
              budget.charge()
              return state.outcome
            }
            // The page proves the action did not land: only now may it be replayed, once.
            val reply = stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).act(request)
            budget.charge()
            return reply.outcome
          }
          if (!RetryableStatus.contains(status) || attempt + 1 >= attempts) throw exc
      }
      attempt += 1
    }
    throw new RuntimeException("action " + action + " exhausted " + attempts + " attempts")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>

constexpr int kRetries = 3;

struct ActRequest {
  std::string session_id;
  std::string action;
  std::string target;
};

struct ActReply {
  std::string outcome;
};

struct Budget {
  int remaining = 0;
  void charge() { remaining -= 1; }
};

// TODO: one global retry count and no deadline on any driver call, and a timed-out click is sent
// again three times; a hung page is left open and the next action runs on it. Put a 15 s deadline on
// every call from kDeadlineMs, keep a per-action retry table so click/submit/type get one attempt,
// read page state with Snapshot before any retry, close a hung page with ClosePage before the next
// action, gate retries on UNAVAILABLE / DEADLINE_EXCEEDED and charge the budget once per accepted
// action.
std::string execute_action(
    BrowserDriver::Stub* stub,
    Session& session,
    const std::string& action,
    const std::string& target,
    Budget& budget) {
  for (int attempt = 0; attempt < kRetries; ++attempt) {
    grpc::ClientContext ctx;
    ActRequest request;
    request.set_session_id(session.id);
    request.set_action(action);
    request.set_target(target);
    ActReply reply;
    if (stub->Act(&ctx, request, &reply).ok()) {
      budget.charge();
      return reply.outcome();
    }
  }
  return "";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <set>
#include <stdexcept>
#include <string>

constexpr int kDeadlineMs = 15000;
constexpr int kMaxAttempts = 3;

const std::set<grpc::StatusCode> kRetryableStatus = {
    grpc::StatusCode::UNAVAILABLE,
    grpc::StatusCode::DEADLINE_EXCEEDED,
};

// Only repeatable actions may be attempted again: replaying a click, a submit or a type acts twice.
const std::set<std::string> kRetryableActions = {"navigate", "snapshot", "wait"};
const std::set<std::string> kSideEffectingActions = {"click", "submit", "type"};

struct ActRequest {
  std::string session_id;
  std::string action;
  std::string target;
};

struct ActReply {
  std::string outcome;
};

struct PageState {
  std::string digest;
  std::string outcome;
};

struct Budget {
  int remaining = 0;
  void charge() { remaining -= 1; }
};

std::string execute_action(
    BrowserDriver::Stub* stub,
    Session& session,
    const std::string& action,
    const std::string& target,
    Budget& budget) {
  if (kRetryableActions.count(action) == 0 && kSideEffectingActions.count(action) == 0) {
    throw std::runtime_error("unknown action " + action);
  }
  if (session.hung && !session.page_closed) {
    // A hung page is closed before anything else is started on this session.
    grpc::ClientContext close_ctx;
    close_ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    ActRequest close_request;
    close_request.set_session_id(session.id);
    ActReply close_reply;
    if (!stub->ClosePage(&close_ctx, close_request, &close_reply).ok()) return "";
    session.page_closed = true;
  }
  ActRequest request;
  request.set_session_id(session.id);
  request.set_action(action);
  request.set_target(target);
  const bool retryable = kRetryableActions.count(action) > 0;
  const int attempts = retryable ? kMaxAttempts : 1;
  for (int attempt = 0; attempt < attempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    ActReply reply;
    const grpc::Status status = stub->Act(&ctx, request, &reply);
    if (status.ok()) {
      budget.charge();  // Once per accepted action: a refused or retried attempt burns nothing.
      return reply.outcome();
    }
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED && kSideEffectingActions.count(action) > 0) {
      // The click may have landed before the socket died: read page state before deciding.
      grpc::ClientContext state_ctx;
      state_ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
      ActRequest state_request;
      state_request.set_session_id(session.id);
      PageState state;
      const grpc::Status state_status = stub->Snapshot(&state_ctx, state_request, &state);
      if (state_status.ok() && state.digest() == target) {
        budget.charge();
        return state.outcome();
      }
      // The page proves the action did not land: only now may it be replayed, once.
      grpc::ClientContext retry_ctx;
      retry_ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
      ActReply retry_reply;
      const grpc::Status retry_status = stub->Act(&retry_ctx, request, &retry_reply);
      if (retry_status.ok()) {
        budget.charge();
        return retry_reply.outcome();
      }
      throw std::runtime_error("action " + action + " failed after verification");
    }
    if (kRetryableStatus.count(status.error_code()) == 0 || !retryable || attempt + 1 >= attempts) {
      throw std::runtime_error("action " + action + " failed: " + status.error_message());
    }
  }
  throw std::runtime_error("action " + action + " exhausted attempts");
}
`,
    },
  },
  hints: [
    'The deadline is an argument on the call itself (`timeout=`, `deadline: Date.now() + ms`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`) and it comes from one constant — `DEADLINE_MS = 15_000`. One loop that sends every call with no timeout is the flaw: a driver that stops answering pins the worker.',
    'Two gates make a retry legal: the action and the status. Keep a per-action table — `RETRYABLE_ACTIONS` = `navigate`, `snapshot`, `wait`, and `click`, `submit`, `type` get exactly one attempt — and treat only `UNAVAILABLE` and `DEADLINE_EXCEEDED` as retryable; a global `RETRIES = 3` applied to every action is what double-submits the form.',
    'A timed-out side effect may already have run: `Snapshot` the page and compare the digest against the target before deciding anything — snapshot first, retry only if the page proves the click did not land — and `ClosePage` a hung session before the next action, charging the budget once per accepted action.',
  ],
  debrief: `The interviewer is testing whether you can read a retry policy as a statement about side effects: which actions may be attempted twice, under whose clock, and what the first attempt may already have done when the deadline expires. The draft looks fine because the driver answers on the first attempt in every demo — nothing about the deadline, the per-action table or the hung page shows up until a click is slow, a status is permanent, or a page stops answering. The fix has three data-driven decisions: one deadline constant applied to every call, a per-action retry table so a click and a submit are never replayed, and a status gate that revisits only UNAVAILABLE and DEADLINE_EXCEEDED. The subtle one is the timed-out side effect: a gRPC deadline says the socket gave up, not that the click did not land, so the worker reads page state with Snapshot and only replays once the page proves the action never happened — and closes a hung page before it starts anything else on that session. Real workers add jittered backoff between attempts, a per-action idempotency key so the driver can dedupe a verified replay, a screenshot before and after each side effect as evidence, and a session-level breaker so a driver that keeps hanging is taken out of rotation instead of retried.`,
};
