import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Driver calls with deadlines, verified clicks and every hop authorized',
  concept: 'grpc',
  file: 'client',
  focus: ['worker', 'driver', 'profile'],
  task: `## Task

**Starting point.** The starter is what a driver worker runs for one action:
\`run_action(session_id, worker, action)\` takes a step with \`lease.begin_step\`, sends a \`navigate\`
to the driver's \`Navigate\` (following each 3xx \`location\` up to \`MAX_REDIRECTS\`) or a
\`click\`/\`type\` to \`Act\`, both through \`with_retries\` (three attempts on \`UNAVAILABLE\` or
\`DEADLINE_EXCEEDED\`), records the page with \`sessions.record_page\` and returns the step. It
serves the demo and hides three flaws.

**Failure mode the checks target.** A hung page holds the worker for as long as it hangs; a click
whose reply was lost is sent again and the form submits twice; a \`302\` from an allowed page to
\`http://169.254.169.254/\` is followed, because only the action's own URL is authorized.

\`\`\`proto
service BrowserDriver { rpc Navigate(NavigateRequest) returns (Page);   // a 3xx answers status + location
                        rpc Act(ActRequest) returns (Page); rpc Snapshot(SnapshotRequest) returns (Page); }
\`\`\`

- Every driver call carries a **\`DEADLINE_S\` = 15 s** deadline.
- \`Act\` is sent once. On \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\`, read \`Snapshot\`: a digest that
  differs from the session's \`page_digest\` means the action landed, so answer that page; an
  unchanged one makes a single further \`Act\` safe.
- \`profiles.authorize_navigation\` runs on **every hop**, the first URL and each \`location\`; a
  refused hop ends the action \`blocked\` with the reason before the browser goes there.`,
  sequence: {
    participants: ['Worker', 'Egress profiles', 'Browser driver'],
    messages: [
      {from: 'Worker', to: 'Egress profiles', label: 'authorize_navigation(profile, /login)', kind: 'sync'},
      {from: 'Worker', to: 'Browser driver', label: 'Navigate /login · deadline 15 s', kind: 'sync'},
      {from: 'Browser driver', to: 'Worker', label: '302 · location http://169.254.169.254/', kind: 'reply'},
      {from: 'Worker', to: 'Egress profiles', label: 'authorize_navigation(profile, location) → blocked', kind: 'sync'},
      {from: 'Worker', to: 'Browser driver', label: 'Act click #buy · deadline 15 s', kind: 'sync'},
      {from: 'Browser driver', to: 'Worker', label: 'DEADLINE_EXCEEDED (reply lost)', kind: 'reply'},
      {from: 'Worker', to: 'Browser driver', label: 'Snapshot → digest changed: landed, no replay', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every driver call carries a 15-second deadline',
      detail:
        'Navigate, Act and Snapshot are each made with `DEADLINE_S` (15 s), so a hung page ends the action as failed; the starter sets no deadline and waits as long as the page does.',
      match: {
        python: {
          all: [
            /DEADLINE_S\s*=\s*15\b/,
            /Navigate\([^\n]*timeout\s*=\s*DEADLINE_S/,
            /Act\([^\n]*timeout\s*=\s*DEADLINE_S/,
          ],
        },
        typescript: {
          all: [
            /DEADLINE_MS\s*=\s*15_?000\b/,
            /Navigate\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/,
            /Act\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/,
          ],
        },
        go: {all: [/deadline\s*=\s*15\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*15L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{15\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'verify-before-retry',
      title: 'A click whose reply was lost is checked against the page',
      detail:
        '`Act` is sent once; after `UNAVAILABLE` or `DEADLINE_EXCEEDED` the page is read with `Snapshot` and the action is sent again only if the digest still matches the session’s `page_digest`. The starter replays `Act` through the retry loop.',
      match: {
        python: {all: [/driver\.Snapshot\(/], order: [/driver\.Act\(/, /driver\.Snapshot\(/]},
        typescript: {all: [/driver\.Snapshot\(/], order: [/driver\.Act\(/, /driver\.Snapshot\(/]},
        go: {all: [/driver\.Snapshot\(/], order: [/driver\.Act\(/, /driver\.Snapshot\(/]},
        scala: {
          all: [/\.snapshot\(\s*SnapshotRequest/],
          order: [/\.act\(\s*request/, /\.snapshot\(\s*SnapshotRequest/],
        },
        cpp: {all: [/driver->Snapshot\(/], order: [/driver->Act\(/, /driver->Snapshot\(/]},
      },
    },
    {
      id: 'redirect-hops',
      title: 'Authorizes every redirect hop before following it',
      detail:
        '`authorize_navigation`/`authorizeNavigation` runs inside the redirect loop, ahead of each `Navigate`, so a `location` outside the profile ends the action blocked; the starter authorizes the first URL only.',
      match: {
        python: {order: [/for _ in range\(MAX_REDIRECTS/, /profiles\.authorize_navigation\(/]},
        typescript: {order: [/for \(let hop = 0; hop <= MAX_REDIRECTS/, /authorizeNavigation\(/]},
        go: {order: [/for hop := 0; hop <= maxRedirects/, /profiles\.AuthorizeNavigation\(/]},
        scala: {
          order: [/def navigate\(/, /Profiles\.authorizeNavigation\(/, /navigate\(sessionId, profile, page\.location/],
        },
        cpp: {order: [/for \(int hop = 0; hop <= kMaxRedirects/, /profiles::authorizeNavigation\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import browser_agent_pb2 as pb
import browser_agent_pb2_grpc
from browser import lease  # begin_step
from browser import profiles  # get_profile, authorize_navigation
from browser import sessions  # load_session, record_page

MAX_REDIRECTS = 5
ATTEMPTS = 3
REDIRECTS = (301, 302, 303, 307, 308)
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

driver = browser_agent_pb2_grpc.BrowserDriverStub(grpc.insecure_channel("driver:9000"))


def with_retries(send):
    """send(), again on UNAVAILABLE or DEADLINE_EXCEEDED, up to ATTEMPTS times."""
    for attempt in range(ATTEMPTS):
        try:
            return send()
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE or attempt == ATTEMPTS - 1:
                raise


def navigate(session_id: str, profile: dict, url: str):
    """(the page the navigation ends on, "") or (None, why it was refused)."""
    reason = profiles.authorize_navigation(profile, url)
    if reason:
        return None, reason
    for _ in range(MAX_REDIRECTS + 1):
        page = with_retries(lambda: driver.Navigate(pb.NavigateRequest(session_id=session_id, url=url)))
        if page.status not in REDIRECTS:
            return page, ""
        url = page.location
    return None, "too many redirects"


def act(session_id: str, action: dict, before_digest: str):
    """The page after a click or type on the session's current page."""
    request = pb.ActRequest(session_id=session_id, action=action["type"], selector=action["target"], text=action.get("text", ""))
    return with_retries(lambda: driver.Act(request))


def run_action(session_id: str, worker: str, action: dict) -> dict:
    """Run one action (type navigate, click or type; target a URL or a selector; text) and return the step it made."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    index = lease.begin_step(session_id, worker)
    step = {"session_id": session_id, "step_index": index, "action": action["type"], "target": action["target"],
            "text": action.get("text", ""), "outcome": "ok", "url": "", "digest": "", "reason": ""}
    if index < 0:
        return {**step, "outcome": "refused", "reason": f"begin_step answered {index}"}
    session = sessions.load_session(session_id)
    try:
        if action["type"] == "navigate":
            page, reason = navigate(session_id, profiles.get_profile(session["profile"]), action["target"])
        else:
            page, reason = act(session_id, action, session["page_digest"]), ""
    except grpc.RpcError as exc:
        return {**step, "outcome": "failed", "reason": exc.code().name}
    if page is None:
        return {**step, "outcome": "blocked", "reason": reason}
    sessions.record_page(session_id, page.url, page.digest)
    return {**step, "url": page.url, "digest": page.digest}
`,
      solution: `import grpc

import browser_agent_pb2 as pb
import browser_agent_pb2_grpc
from browser import lease  # begin_step
from browser import profiles  # get_profile, authorize_navigation
from browser import sessions  # load_session, record_page

DEADLINE_S = 15
MAX_REDIRECTS = 5
ATTEMPTS = 3
REDIRECTS = (301, 302, 303, 307, 308)
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

driver = browser_agent_pb2_grpc.BrowserDriverStub(grpc.insecure_channel("driver:9000"))


def with_retries(send):
    """send(), again on UNAVAILABLE or DEADLINE_EXCEEDED, up to ATTEMPTS times."""
    for attempt in range(ATTEMPTS):
        try:
            return send()
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE or attempt == ATTEMPTS - 1:
                raise


def navigate(session_id: str, profile: dict, url: str):
    """(the page the navigation ends on, "") or (None, why it was refused)."""
    for _ in range(MAX_REDIRECTS + 1):
        # Every hop is a new navigation: a redirect may point anywhere.
        reason = profiles.authorize_navigation(profile, url)
        if reason:
            return None, reason
        page = with_retries(lambda: driver.Navigate(pb.NavigateRequest(session_id=session_id, url=url), timeout=DEADLINE_S))
        if page.status not in REDIRECTS:
            return page, ""
        url = page.location
    return None, "too many redirects"


def act(session_id: str, action: dict, before_digest: str):
    """The page after a click or type on the session's current page."""
    request = pb.ActRequest(session_id=session_id, action=action["type"], selector=action["target"], text=action.get("text", ""))
    try:
        return driver.Act(request, timeout=DEADLINE_S)
    except grpc.RpcError as exc:
        if exc.code() not in RETRYABLE:
            raise
    # The reply is lost, not necessarily the action: the page tells whether it landed.
    page = with_retries(lambda: driver.Snapshot(pb.SnapshotRequest(session_id=session_id), timeout=DEADLINE_S))
    if page.digest != before_digest:
        return page
    return driver.Act(request, timeout=DEADLINE_S)


def run_action(session_id: str, worker: str, action: dict) -> dict:
    """Run one action (type navigate, click or type; target a URL or a selector; text) and return the step it made."""
    index = lease.begin_step(session_id, worker)
    step = {"session_id": session_id, "step_index": index, "action": action["type"], "target": action["target"],
            "text": action.get("text", ""), "outcome": "ok", "url": "", "digest": "", "reason": ""}
    if index < 0:
        return {**step, "outcome": "refused", "reason": f"begin_step answered {index}"}
    session = sessions.load_session(session_id)
    try:
        if action["type"] == "navigate":
            page, reason = navigate(session_id, profiles.get_profile(session["profile"]), action["target"])
        else:
            page, reason = act(session_id, action, session["page_digest"]), ""
    except grpc.RpcError as exc:
        return {**step, "outcome": "failed", "reason": exc.code().name}
    if page is None:
        return {**step, "outcome": "blocked", "reason": reason}
    sessions.record_page(session_id, page.url, page.digest)
    return {**step, "url": page.url, "digest": page.digest}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {beginStep} from 'browser/lease';
import {type Profile, authorizeNavigation, getProfile} from 'browser/profiles';
import {loadSession, recordPage} from 'browser/sessions';
import type {Step} from 'browser/trace';

export const MAX_REDIRECTS = 5;
export const ATTEMPTS = 3;
const REDIRECTS = [301, 302, 303, 307, 308];
const RETRYABLE: number[] = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

interface Page {
  url: string;
  status: number;
  location: string;
  digest: string;
}
type Call<R> = (request: R, metadata: grpc.Metadata, options: grpc.CallOptions) => Promise<Page>;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('browser_agent.proto')) as unknown as {
  browseragent: {BrowserDriver: grpc.ServiceClientConstructor};
};
const driver = new pkg.browseragent.BrowserDriver('driver:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Navigate: Call<{session_id: string; url: string}>;
  Act: Call<{session_id: string; action: string; selector: string; text: string}>;
  Snapshot: Call<{session_id: string}>;
};

/** One thing the agent asks the browser to do: navigate (target a URL), click or type (target a selector). */
export interface Action {
  type: string;
  target: string;
  text?: string;
}

/** send(), again on UNAVAILABLE or DEADLINE_EXCEEDED, up to ATTEMPTS times. */
async function withRetries(send: () => Promise<Page>): Promise<Page> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (e) {
      if (!RETRYABLE.includes((e as grpc.ServiceError).code) || attempt === ATTEMPTS) throw e;
    }
  }
}

/** [the page the navigation ends on, ''] or [null, why it was refused]. */
async function navigate(sessionId: string, profile: Profile, start: string): Promise<[Page | null, string]> {
  const reason = authorizeNavigation(profile, start);
  if (reason !== '') return [null, reason];
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = url;
    const page = await withRetries(() => driver.Navigate({session_id: sessionId, url: target}, new grpc.Metadata(), {}));
    if (!REDIRECTS.includes(page.status)) return [page, ''];
    url = page.location;
  }
  return [null, 'too many redirects'];
}

/** The page after a click or type on the session's current page. */
async function act(sessionId: string, action: Action, beforeDigest: string): Promise<Page> {
  const request = {session_id: sessionId, action: action.type, selector: action.target, text: action.text ?? ''};
  return withRetries(() => driver.Act(request, new grpc.Metadata(), {}));
}

/** Run one action and return the step it made. */
export async function runAction(sessionId: string, worker: string, action: Action): Promise<Step> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const index = await beginStep(sessionId, worker);
  const step: Step = {
    session_id: sessionId,
    step_index: index,
    action: action.type,
    target: action.target,
    text: action.text ?? '',
    outcome: 'ok',
    url: '',
    digest: '',
    reason: '',
  };
  if (index < 0) return {...step, outcome: 'refused', reason: \`beginStep answered \${index}\`};
  const session = (await loadSession(sessionId))!;
  try {
    const [page, reason] =
      action.type === 'navigate'
        ? await navigate(sessionId, getProfile(session.profile)!, action.target)
        : [await act(sessionId, action, session.page_digest), ''];
    if (page === null) return {...step, outcome: 'blocked', reason};
    await recordPage(sessionId, page.url, page.digest);
    return {...step, url: page.url, digest: page.digest};
  } catch (e) {
    return {...step, outcome: 'failed', reason: String(grpc.status[(e as grpc.ServiceError).code])};
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {beginStep} from 'browser/lease';
import {type Profile, authorizeNavigation, getProfile} from 'browser/profiles';
import {loadSession, recordPage} from 'browser/sessions';
import type {Step} from 'browser/trace';

export const DEADLINE_MS = 15_000;
export const MAX_REDIRECTS = 5;
export const ATTEMPTS = 3;
const REDIRECTS = [301, 302, 303, 307, 308];
const RETRYABLE: number[] = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

interface Page {
  url: string;
  status: number;
  location: string;
  digest: string;
}
type Call<R> = (request: R, metadata: grpc.Metadata, options: grpc.CallOptions) => Promise<Page>;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('browser_agent.proto')) as unknown as {
  browseragent: {BrowserDriver: grpc.ServiceClientConstructor};
};
const driver = new pkg.browseragent.BrowserDriver('driver:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Navigate: Call<{session_id: string; url: string}>;
  Act: Call<{session_id: string; action: string; selector: string; text: string}>;
  Snapshot: Call<{session_id: string}>;
};

/** One thing the agent asks the browser to do: navigate (target a URL), click or type (target a selector). */
export interface Action {
  type: string;
  target: string;
  text?: string;
}

/** send(), again on UNAVAILABLE or DEADLINE_EXCEEDED, up to ATTEMPTS times. */
async function withRetries(send: () => Promise<Page>): Promise<Page> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (e) {
      if (!RETRYABLE.includes((e as grpc.ServiceError).code) || attempt === ATTEMPTS) throw e;
    }
  }
}

/** [the page the navigation ends on, ''] or [null, why it was refused]. */
async function navigate(sessionId: string, profile: Profile, start: string): Promise<[Page | null, string]> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Every hop is a new navigation: a redirect may point anywhere.
    const reason = authorizeNavigation(profile, url);
    if (reason !== '') return [null, reason];
    const target = url;
    const page = await withRetries(() =>
      driver.Navigate({session_id: sessionId, url: target}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS}),
    );
    if (!REDIRECTS.includes(page.status)) return [page, ''];
    url = page.location;
  }
  return [null, 'too many redirects'];
}

/** The page after a click or type on the session's current page. */
async function act(sessionId: string, action: Action, beforeDigest: string): Promise<Page> {
  const request = {session_id: sessionId, action: action.type, selector: action.target, text: action.text ?? ''};
  try {
    return await driver.Act(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
  } catch (e) {
    if (!RETRYABLE.includes((e as grpc.ServiceError).code)) throw e;
  }
  // The reply is lost, not necessarily the action: the page tells whether it landed.
  const page = await withRetries(() =>
    driver.Snapshot({session_id: sessionId}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS}),
  );
  if (page.digest !== beforeDigest) return page;
  return driver.Act(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
}

/** Run one action and return the step it made. */
export async function runAction(sessionId: string, worker: string, action: Action): Promise<Step> {
  const index = await beginStep(sessionId, worker);
  const step: Step = {
    session_id: sessionId,
    step_index: index,
    action: action.type,
    target: action.target,
    text: action.text ?? '',
    outcome: 'ok',
    url: '',
    digest: '',
    reason: '',
  };
  if (index < 0) return {...step, outcome: 'refused', reason: \`beginStep answered \${index}\`};
  const session = (await loadSession(sessionId))!;
  try {
    const [page, reason] =
      action.type === 'navigate'
        ? await navigate(sessionId, getProfile(session.profile)!, action.target)
        : [await act(sessionId, action, session.page_digest), ''];
    if (page === null) return {...step, outcome: 'blocked', reason};
    await recordPage(sessionId, page.url, page.digest);
    return {...step, url: page.url, digest: page.digest};
  } catch (e) {
    return {...step, outcome: 'failed', reason: String(grpc.status[(e as grpc.ServiceError).code])};
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "browser/gen/browser_agent"
	"browser/lease"    // lease.BeginStep
	"browser/profiles" // profiles.GetProfile, AuthorizeNavigation
	"browser/sessions" // sessions.LoadSession, RecordPage
	"browser/trace"    // trace.Step
)

const (
	maxRedirects = 5
	attempts     = 3
)

var redirects = map[int32]bool{301: true, 302: true, 303: true, 307: true, 308: true}

var (
	driverConn, _ = grpc.NewClient("driver:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	driver        = pb.NewBrowserDriverClient(driverConn)
)

// Action is one thing the agent asks the browser to do: navigate (Target a URL), click or type
// (Target a selector, Text what to type).
type Action struct {
	Type   string
	Target string
	Text   string
}

func retryable(err error) bool {
	code := status.Code(err)
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

// withRetries calls send, again on Unavailable or DeadlineExceeded, up to attempts times.
func withRetries(send func() (*pb.Page, error)) (*pb.Page, error) {
	page, err := send()
	for attempt := 1; attempt < attempts && err != nil && retryable(err); attempt++ {
		page, err = send()
	}
	return page, err
}

// navigate is the page the navigation ends on, or nil and why it was refused.
func navigate(ctx context.Context, sessionID string, profile *profiles.Profile, url string) (*pb.Page, string, error) {
	if reason := profiles.AuthorizeNavigation(profile, url); reason != "" {
		return nil, reason, nil
	}
	for hop := 0; hop <= maxRedirects; hop++ {
		target := url
		page, err := withRetries(func() (*pb.Page, error) {
			return driver.Navigate(ctx, &pb.NavigateRequest{SessionId: sessionID, Url: target})
		})
		if err != nil {
			return nil, "", err
		}
		if !redirects[page.GetStatus()] {
			return page, "", nil
		}
		url = page.GetLocation()
	}
	return nil, "too many redirects", nil
}

// act is the page after a click or type on the session's current page.
func act(ctx context.Context, sessionID string, action Action, beforeDigest string) (*pb.Page, error) {
	request := &pb.ActRequest{SessionId: sessionID, Action: action.Type, Selector: action.Target, Text: action.Text}
	return withRetries(func() (*pb.Page, error) {
		return driver.Act(ctx, request)
	})
}

// runAction runs one action and returns the step it made.
func runAction(ctx context.Context, sessionID, worker string, action Action) trace.Step {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	step := trace.Step{SessionID: sessionID, Action: action.Type, Target: action.Target, Text: action.Text, Outcome: "ok"}
	index, err := lease.BeginStep(ctx, sessionID, worker)
	if err != nil {
		step.Outcome, step.Reason = "failed", err.Error()
		return step
	}
	step.StepIndex = index
	if index < 0 {
		step.Outcome, step.Reason = "refused", fmt.Sprintf("BeginStep answered %d", index)
		return step
	}
	session := sessions.LoadSession(ctx, sessionID)
	var page *pb.Page
	reason := ""
	if action.Type == "navigate" {
		page, reason, err = navigate(ctx, sessionID, profiles.GetProfile(session.Profile), action.Target)
	} else {
		page, err = act(ctx, sessionID, action, session.PageDigest)
	}
	if err != nil {
		step.Outcome, step.Reason = "failed", status.Code(err).String()
		return step
	}
	if page == nil {
		step.Outcome, step.Reason = "blocked", reason
		return step
	}
	sessions.RecordPage(ctx, sessionID, page.GetUrl(), page.GetDigest())
	step.URL, step.Digest = page.GetUrl(), page.GetDigest()
	return step
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

	pb "browser/gen/browser_agent"
	"browser/lease"    // lease.BeginStep
	"browser/profiles" // profiles.GetProfile, AuthorizeNavigation
	"browser/sessions" // sessions.LoadSession, RecordPage
	"browser/trace"    // trace.Step
)

const (
	deadline     = 15 * time.Second
	maxRedirects = 5
	attempts     = 3
)

var redirects = map[int32]bool{301: true, 302: true, 303: true, 307: true, 308: true}

var (
	driverConn, _ = grpc.NewClient("driver:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	driver        = pb.NewBrowserDriverClient(driverConn)
)

// Action is one thing the agent asks the browser to do: navigate (Target a URL), click or type
// (Target a selector, Text what to type).
type Action struct {
	Type   string
	Target string
	Text   string
}

func retryable(err error) bool {
	code := status.Code(err)
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

// withRetries calls send, again on Unavailable or DeadlineExceeded, up to attempts times.
func withRetries(send func() (*pb.Page, error)) (*pb.Page, error) {
	page, err := send()
	for attempt := 1; attempt < attempts && err != nil && retryable(err); attempt++ {
		page, err = send()
	}
	return page, err
}

// navigate is the page the navigation ends on, or nil and why it was refused.
func navigate(ctx context.Context, sessionID string, profile *profiles.Profile, url string) (*pb.Page, string, error) {
	for hop := 0; hop <= maxRedirects; hop++ {
		// Every hop is a new navigation: a redirect may point anywhere.
		if reason := profiles.AuthorizeNavigation(profile, url); reason != "" {
			return nil, reason, nil
		}
		target := url
		page, err := withRetries(func() (*pb.Page, error) {
			callCtx, cancel := context.WithTimeout(ctx, deadline)
			defer cancel()
			return driver.Navigate(callCtx, &pb.NavigateRequest{SessionId: sessionID, Url: target})
		})
		if err != nil {
			return nil, "", err
		}
		if !redirects[page.GetStatus()] {
			return page, "", nil
		}
		url = page.GetLocation()
	}
	return nil, "too many redirects", nil
}

// act is the page after a click or type on the session's current page.
func act(ctx context.Context, sessionID string, action Action, beforeDigest string) (*pb.Page, error) {
	request := &pb.ActRequest{SessionId: sessionID, Action: action.Type, Selector: action.Target, Text: action.Text}
	send := func() (*pb.Page, error) {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		defer cancel()
		return driver.Act(callCtx, request)
	}
	page, err := send()
	if err == nil || !retryable(err) {
		return page, err
	}
	// The reply is lost, not necessarily the action: the page tells whether it landed.
	current, err := withRetries(func() (*pb.Page, error) {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		defer cancel()
		return driver.Snapshot(callCtx, &pb.SnapshotRequest{SessionId: sessionID})
	})
	if err != nil {
		return nil, err
	}
	if current.GetDigest() != beforeDigest {
		return current, nil
	}
	return send()
}

// runAction runs one action and returns the step it made.
func runAction(ctx context.Context, sessionID, worker string, action Action) trace.Step {
	step := trace.Step{SessionID: sessionID, Action: action.Type, Target: action.Target, Text: action.Text, Outcome: "ok"}
	index, err := lease.BeginStep(ctx, sessionID, worker)
	if err != nil {
		step.Outcome, step.Reason = "failed", err.Error()
		return step
	}
	step.StepIndex = index
	if index < 0 {
		step.Outcome, step.Reason = "refused", fmt.Sprintf("BeginStep answered %d", index)
		return step
	}
	session := sessions.LoadSession(ctx, sessionID)
	var page *pb.Page
	reason := ""
	if action.Type == "navigate" {
		page, reason, err = navigate(ctx, sessionID, profiles.GetProfile(session.Profile), action.Target)
	} else {
		page, err = act(ctx, sessionID, action, session.PageDigest)
	}
	if err != nil {
		step.Outcome, step.Reason = "failed", status.Code(err).String()
		return step
	}
	if page == nil {
		step.Outcome, step.Reason = "blocked", reason
		return step
	}
	sessions.RecordPage(ctx, sessionID, page.GetUrl(), page.GetDigest())
	step.URL, step.Digest = page.GetUrl(), page.GetDigest()
	return step
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import browser.Lease    // Lease.beginStep
import browser.Profiles // Profiles.getProfile, authorizeNavigation
import browser.Sessions // Sessions.loadSession, recordPage
import browser.Trace    // Trace.Step
import browseragent.browser_agent.{ActRequest, BrowserDriverGrpc, NavigateRequest, Page, SnapshotRequest}

/** One thing the agent asks the browser to do: navigate (target a URL), click or type (target a selector). */
final case class Action(kind: String, target: String, text: String = "")

object Client {
  val MaxRedirects = 5
  val Attempts = 3
  val Redirects: Set[Int] = Set(301, 302, 303, 307, 308)

  private val driver = BrowserDriverGrpc.blockingStub(ManagedChannelBuilder.forAddress("driver", 9000).usePlaintext().build())

  private def retryable(e: StatusRuntimeException): Boolean =
    e.getStatus.getCode == Status.Code.UNAVAILABLE || e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED

  /** send(), again on UNAVAILABLE or DEADLINE_EXCEEDED, up to Attempts times. */
  def withRetries(send: () => Page, attempt: Int = 1): Page =
    try send()
    catch { case e: StatusRuntimeException if retryable(e) && attempt < Attempts => withRetries(send, attempt + 1) }

  /** The page the navigation ends on, or why a hop was refused. */
  def navigate(sessionId: String, profile: Profiles.Profile, url: String, hop: Int = 0): Either[String, Page] =
    if (hop > MaxRedirects) Left("too many redirects")
    else {
      val page = withRetries(() => driver.navigate(NavigateRequest(sessionId, url)))
      if (Redirects.contains(page.status)) navigate(sessionId, profile, page.location, hop + 1) else Right(page)
    }

  /** The page after a click or type on the session's current page. */
  def act(sessionId: String, action: Action, beforeDigest: String): Page = {
    val request = ActRequest(sessionId, action.kind, action.target, action.text)
    withRetries(() => driver.act(request))
  }

  /** Run one action and return the step it made. */
  def runAction(sessionId: String, worker: String, action: Action): Trace.Step = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val index = Lease.beginStep(sessionId, worker)
    val step = Trace.Step(sessionId, index, action.kind, action.target, action.text, "ok", "", "", "")
    if (index < 0) step.copy(outcome = "refused", reason = s"beginStep answered $index")
    else {
      val session = Sessions.loadSession(sessionId).get
      val profile = Profiles.getProfile(session.profile).get
      try {
        val reason = if (action.kind == "navigate") Profiles.authorizeNavigation(profile, action.target) else ""
        val result =
          if (reason.nonEmpty) Left(reason)
          else if (action.kind == "navigate") navigate(sessionId, profile, action.target)
          else Right(act(sessionId, action, session.pageDigest))
        result match {
          case Left(why) => step.copy(outcome = "blocked", reason = why)
          case Right(page) =>
            Sessions.recordPage(sessionId, page.url, page.digest)
            step.copy(url = page.url, digest = page.digest)
        }
      } catch { case e: StatusRuntimeException => step.copy(outcome = "failed", reason = e.getStatus.getCode.toString) }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import browser.Lease    // Lease.beginStep
import browser.Profiles // Profiles.getProfile, authorizeNavigation
import browser.Sessions // Sessions.loadSession, recordPage
import browser.Trace    // Trace.Step
import browseragent.browser_agent.{ActRequest, BrowserDriverGrpc, NavigateRequest, Page, SnapshotRequest}

/** One thing the agent asks the browser to do: navigate (target a URL), click or type (target a selector). */
final case class Action(kind: String, target: String, text: String = "")

object Client {
  val DeadlineSeconds = 15L
  val MaxRedirects = 5
  val Attempts = 3
  val Redirects: Set[Int] = Set(301, 302, 303, 307, 308)

  private val driver = BrowserDriverGrpc.blockingStub(ManagedChannelBuilder.forAddress("driver", 9000).usePlaintext().build())

  private def retryable(e: StatusRuntimeException): Boolean =
    e.getStatus.getCode == Status.Code.UNAVAILABLE || e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED

  /** send(), again on UNAVAILABLE or DEADLINE_EXCEEDED, up to Attempts times. */
  def withRetries(send: () => Page, attempt: Int = 1): Page =
    try send()
    catch { case e: StatusRuntimeException if retryable(e) && attempt < Attempts => withRetries(send, attempt + 1) }

  /** The page the navigation ends on, or why a hop was refused. */
  def navigate(sessionId: String, profile: Profiles.Profile, url: String, hop: Int = 0): Either[String, Page] = {
    // Every hop is a new navigation: a redirect may point anywhere.
    val reason = Profiles.authorizeNavigation(profile, url)
    if (reason.nonEmpty) Left(reason)
    else if (hop > MaxRedirects) Left("too many redirects")
    else {
      val page = withRetries(() => driver.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).navigate(NavigateRequest(sessionId, url)))
      if (Redirects.contains(page.status)) navigate(sessionId, profile, page.location, hop + 1) else Right(page)
    }
  }

  /** The page after a click or type on the session's current page. */
  def act(sessionId: String, action: Action, beforeDigest: String): Page = {
    val request = ActRequest(sessionId, action.kind, action.target, action.text)
    def send(): Page = driver.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).act(request)
    try send()
    catch {
      case e: StatusRuntimeException if retryable(e) =>
        // The reply is lost, not necessarily the action: the page tells whether it landed.
        val page = withRetries(() => driver.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).snapshot(SnapshotRequest(sessionId)))
        if (page.digest != beforeDigest) page else send()
    }
  }

  /** Run one action and return the step it made. */
  def runAction(sessionId: String, worker: String, action: Action): Trace.Step = {
    val index = Lease.beginStep(sessionId, worker)
    val step = Trace.Step(sessionId, index, action.kind, action.target, action.text, "ok", "", "", "")
    if (index < 0) step.copy(outcome = "refused", reason = s"beginStep answered $index")
    else {
      val session = Sessions.loadSession(sessionId).get
      val profile = Profiles.getProfile(session.profile).get
      try {
        val result =
          if (action.kind == "navigate") navigate(sessionId, profile, action.target)
          else Right(act(sessionId, action, session.pageDigest))
        result match {
          case Left(why) => step.copy(outcome = "blocked", reason = why)
          case Right(page) =>
            Sessions.recordPage(sessionId, page.url, page.digest)
            step.copy(url = page.url, digest = page.digest)
        }
      } catch { case e: StatusRuntimeException => step.copy(outcome = "failed", reason = e.getStatus.getCode.toString) }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <functional>
#include <set>
#include <string>

#include "browser/lease.h"     // lease::beginStep
#include "browser/profiles.h"  // profiles::getProfile, authorizeNavigation
#include "browser/sessions.h"  // sessions::loadSession, recordPage
#include "browser/trace.h"     // trace::Step
#include "browser_agent.grpc.pb.h"

constexpr int kMaxRedirects = 5;
constexpr int kAttempts = 3;
const std::set<int> kRedirects = {301, 302, 303, 307, 308};

auto driver = browseragent::BrowserDriver::NewStub(grpc::CreateChannel("driver:9000", grpc::InsecureChannelCredentials()));

// One thing the agent asks the browser to do: navigate (target a URL), click or type (target a
// selector, text what to type).
struct Action {
  std::string type;
  std::string target;
  std::string text;
};

bool retryable(const grpc::Status& s) {
  return s.error_code() == grpc::StatusCode::UNAVAILABLE || s.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
}

// send(), again on UNAVAILABLE or DEADLINE_EXCEEDED, up to kAttempts times.
grpc::Status withRetries(const std::function<grpc::Status()>& send) {
  grpc::Status status = send();
  for (int attempt = 1; attempt < kAttempts && !status.ok() && retryable(status); attempt++) status = send();
  return status;
}

// Fills page with where the navigation ends, or reason with why it was refused.
grpc::Status navigate(const std::string& session_id, const profiles::Profile& profile, std::string url, browseragent::Page& page,
                      std::string& reason) {
  reason = profiles::authorizeNavigation(profile, url);
  if (!reason.empty()) return grpc::Status::OK;
  for (int hop = 0; hop <= kMaxRedirects; hop++) {
    browseragent::NavigateRequest request;
    request.set_session_id(session_id);
    request.set_url(url);
    const grpc::Status status = withRetries([&] {
      grpc::ClientContext ctx;
      return driver->Navigate(&ctx, request, &page);
    });
    if (!status.ok() || kRedirects.find(page.status()) == kRedirects.end()) return status;
    url = page.location();
  }
  reason = "too many redirects";
  return grpc::Status::OK;
}

// Fills page with the page after a click or type on the session's current page.
grpc::Status act(const std::string& session_id, const Action& action, const std::string& before_digest, browseragent::Page& page) {
  browseragent::ActRequest request;
  request.set_session_id(session_id);
  request.set_action(action.type);
  request.set_selector(action.target);
  request.set_text(action.text);
  return withRetries([&] {
    grpc::ClientContext ctx;
    return driver->Act(&ctx, request, &page);
  });
}

// Run one action and return the step it made.
trace::Step runAction(const std::string& session_id, const std::string& worker, const Action& action) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  trace::Step step{session_id, lease::beginStep(session_id, worker), action.type, action.target, action.text, "ok", "", "", ""};
  if (step.step_index < 0) {
    step.outcome = "refused";
    step.reason = "beginStep answered " + std::to_string(step.step_index);
    return step;
  }
  const auto session = sessions::loadSession(session_id);
  browseragent::Page page;
  std::string reason;
  const grpc::Status status = action.type == "navigate" ? navigate(session_id, *profiles::getProfile(session->profile), action.target, page, reason)
                                                       : act(session_id, action, session->page_digest, page);
  if (!status.ok()) {
    step.outcome = "failed";
    step.reason = status.error_message();
  } else if (!reason.empty()) {
    step.outcome = "blocked";
    step.reason = reason;
  } else {
    sessions::recordPage(session_id, page.url(), page.digest());
    step.url = page.url();
    step.digest = page.digest();
  }
  return step;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <functional>
#include <set>
#include <string>

#include "browser/lease.h"     // lease::beginStep
#include "browser/profiles.h"  // profiles::getProfile, authorizeNavigation
#include "browser/sessions.h"  // sessions::loadSession, recordPage
#include "browser/trace.h"     // trace::Step
#include "browser_agent.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{15};
constexpr int kMaxRedirects = 5;
constexpr int kAttempts = 3;
const std::set<int> kRedirects = {301, 302, 303, 307, 308};

auto driver = browseragent::BrowserDriver::NewStub(grpc::CreateChannel("driver:9000", grpc::InsecureChannelCredentials()));

// One thing the agent asks the browser to do: navigate (target a URL), click or type (target a
// selector, text what to type).
struct Action {
  std::string type;
  std::string target;
  std::string text;
};

bool retryable(const grpc::Status& s) {
  return s.error_code() == grpc::StatusCode::UNAVAILABLE || s.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
}

// send(), again on UNAVAILABLE or DEADLINE_EXCEEDED, up to kAttempts times.
grpc::Status withRetries(const std::function<grpc::Status()>& send) {
  grpc::Status status = send();
  for (int attempt = 1; attempt < kAttempts && !status.ok() && retryable(status); attempt++) status = send();
  return status;
}

// Fills page with where the navigation ends, or reason with why it was refused.
grpc::Status navigate(const std::string& session_id, const profiles::Profile& profile, std::string url, browseragent::Page& page,
                      std::string& reason) {
  for (int hop = 0; hop <= kMaxRedirects; hop++) {
    // Every hop is a new navigation: a redirect may point anywhere.
    reason = profiles::authorizeNavigation(profile, url);
    if (!reason.empty()) return grpc::Status::OK;
    browseragent::NavigateRequest request;
    request.set_session_id(session_id);
    request.set_url(url);
    const grpc::Status status = withRetries([&] {
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
      return driver->Navigate(&ctx, request, &page);
    });
    if (!status.ok() || kRedirects.find(page.status()) == kRedirects.end()) return status;
    url = page.location();
  }
  reason = "too many redirects";
  return grpc::Status::OK;
}

// Fills page with the page after a click or type on the session's current page.
grpc::Status act(const std::string& session_id, const Action& action, const std::string& before_digest, browseragent::Page& page) {
  browseragent::ActRequest request;
  request.set_session_id(session_id);
  request.set_action(action.type);
  request.set_selector(action.target);
  request.set_text(action.text);
  const auto send = [&] {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    return driver->Act(&ctx, request, &page);
  };
  const grpc::Status status = send();
  if (status.ok() || !retryable(status)) return status;
  // The reply is lost, not necessarily the action: the page tells whether it landed.
  browseragent::SnapshotRequest snapshot;
  snapshot.set_session_id(session_id);
  const grpc::Status read = withRetries([&] {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    return driver->Snapshot(&ctx, snapshot, &page);
  });
  if (!read.ok() || page.digest() != before_digest) return read;
  return send();
}

// Run one action and return the step it made.
trace::Step runAction(const std::string& session_id, const std::string& worker, const Action& action) {
  trace::Step step{session_id, lease::beginStep(session_id, worker), action.type, action.target, action.text, "ok", "", "", ""};
  if (step.step_index < 0) {
    step.outcome = "refused";
    step.reason = "beginStep answered " + std::to_string(step.step_index);
    return step;
  }
  const auto session = sessions::loadSession(session_id);
  browseragent::Page page;
  std::string reason;
  const grpc::Status status = action.type == "navigate" ? navigate(session_id, *profiles::getProfile(session->profile), action.target, page, reason)
                                                       : act(session_id, action, session->page_digest, page);
  if (!status.ok()) {
    step.outcome = "failed";
    step.reason = status.error_message();
  } else if (!reason.empty()) {
    step.outcome = "blocked";
    step.reason = reason;
  } else {
    sessions::recordPage(session_id, page.url(), page.digest());
    step.url = page.url();
    step.digest = page.digest();
  }
  return step;
}
`,
    },
  },
  harness: {
    python: `import grpc

import browser_agent_pb2 as pb
import browser_agent_pb2_grpc
from browser import sessions

ENTRY = "https://www.example.com/"
KETTLES = "https://www.example.com/kettles"
METADATA = "http://169.254.169.254/latest/meta-data/"
WIKI = "https://en.wikipedia.org/wiki/Kettle"


class Driver(browser_agent_pb2_grpc.BrowserDriverServicer):
    """One browser: Navigate answers redirects[url] as a 302, Act applies the action (drop: refused
    before the page sees it; lose_reply: applied, then the reply is lost), the digest counts actions."""

    def __init__(self):
        self.url = ENTRY
        self.applied = 0
        self.drop = 0
        self.lose_reply = 0
        self.redirects = {}

    def _page(self):
        return pb.Page(url=self.url, status=200, digest=f"{self.url}#{self.applied}")

    def Navigate(self, request, context):
        if request.url in self.redirects:
            return pb.Page(url=request.url, status=302, location=self.redirects[request.url])
        self.url = request.url
        return self._page()

    def Act(self, request, context):
        if self.drop:
            self.drop -= 1
            context.abort(grpc.StatusCode.UNAVAILABLE, "driver restarting")
        self.applied += 1
        if self.lose_reply:
            self.lose_reply -= 1
            context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, "reply lost")
        return self._page()

    def Snapshot(self, request, context):
        return self._page()


def _world(ctx):
    driver = Driver()
    ctx.grpc.serve(browser_agent_pb2_grpc.add_BrowserDriverServicer_to_server, driver)
    sid = sessions.create_session("acme", "public-web", "buy a kettle", 20, ENTRY)["session_id"]
    return ctx.load("client"), driver, sid


def check_deadline(ctx):
    m, driver, sid = _world(ctx)
    step = m.run_action(sid, "w-1", {"type": "navigate", "target": KETTLES})
    assert step["outcome"] == "ok", f"a navigation with a healthy driver ended {step}"
    step = m.run_action(sid, "w-1", {"type": "click", "target": "#add-to-cart"})
    assert step["outcome"] == "ok", f"a click with a healthy driver ended {step}"
    for method in ("Navigate", "Act"):
        for call in ctx.grpc.calls_to(method):
            assert call.timeout is not None, f"a {method} call carries no deadline: a hung page holds the worker as long as it hangs"
            assert 14.5 <= call.timeout <= 15.5, f"a {method} call carries a {call.timeout} s deadline, expected DEADLINE_S = 15"
    ctx.grpc.set_latency("Navigate", 60.0)
    step = m.run_action(sid, "w-1", {"type": "navigate", "target": ENTRY})
    assert step["outcome"] == "failed", f"with a page that hangs for 60 s the navigation ended {step['outcome']!r}: under a 15 s deadline it must end failed"


def check_verify_before_retry(ctx):
    m, driver, sid = _world(ctx)
    m.run_action(sid, "w-1", {"type": "navigate", "target": KETTLES})
    driver.lose_reply = 1
    step = m.run_action(sid, "w-1", {"type": "click", "target": "#buy"})
    assert driver.applied == 1, f"the click was applied {driver.applied} times: its reply was lost after the page handled it, and the retry clicked again. Read Snapshot and compare the digest before sending it again"
    assert ctx.grpc.calls_to("Snapshot"), "a click whose reply was lost must be checked against the page (Snapshot)"
    assert step["outcome"] == "ok" and step["digest"] == f"{KETTLES}#1", f"the click landed, so the step must end ok on the page it left: {step}"
    driver.drop = 1
    step = m.run_action(sid, "w-1", {"type": "click", "target": "#confirm"})
    assert driver.applied == 2 and step["outcome"] == "ok", f"a click the driver refused before touching the page left {driver.applied} applied actions and outcome {step['outcome']!r}: the digest is unchanged, so one more Act is safe"


def check_redirect_hops(ctx):
    m, driver, sid = _world(ctx)
    driver.redirects["https://www.example.com/login"] = METADATA
    driver.redirects["https://www.example.com/old-kettles"] = WIKI
    step = m.run_action(sid, "w-1", {"type": "navigate", "target": "https://www.example.com/login"})
    sent = [c.request.url for c in ctx.grpc.calls_to("Navigate")]
    assert METADATA not in sent, f"the browser was sent to {sent}: /login redirected to the metadata address and nothing authorized that hop"
    assert step["outcome"] == "blocked" and step["reason"], f"a redirect outside the profile must end the action blocked with a reason, got {step}"
    assert sessions.load_session(sid)["current_url"] == ENTRY, "a blocked navigation must leave the session on its page"
    step = m.run_action(sid, "w-1", {"type": "navigate", "target": "https://www.example.com/old-kettles"})
    assert step["outcome"] == "ok" and step["url"] == WIKI, f"a redirect to a host the profile allows must be followed, got {step}"
    assert sessions.load_session(sid)["current_url"] == WIKI, "the session must record the page the redirect ended on"
`,
    typescript: `const ENTRY = 'https://www.example.com/';
const KETTLES = 'https://www.example.com/kettles';
const METADATA = 'http://169.254.169.254/latest/meta-data/';
const WIKI = 'https://en.wikipedia.org/wiki/Kettle';

/** One browser: Navigate answers redirects as a 302, Act applies the action (drop: refused before the page sees it; loseReply: applied, then the reply is lost), the digest counts actions. */
async function world(ctx) {
  const pkg = ctx.proto('browser_agent.proto');
  const driver = {url: ENTRY, applied: 0, drop: 0, loseReply: 0, redirects: new Map<string, string>()};
  const page = () => ({url: driver.url, status: 200, location: '', digest: \`\${driver.url}#\${driver.applied}\`});
  ctx.grpc.serve(pkg.browseragent.BrowserDriver.service, {
    Navigate(call, callback) {
      const {url} = call.request;
      const location = driver.redirects.get(url);
      if (location !== undefined) return callback(null, {url, status: 302, location, digest: ''});
      driver.url = url;
      callback(null, page());
    },
    Act(_call, callback) {
      if (driver.drop > 0) {
        driver.drop--;
        return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'driver restarting'});
      }
      driver.applied++;
      if (driver.loseReply > 0) {
        driver.loseReply--;
        return callback({code: ctx.grpc.status.DEADLINE_EXCEEDED, details: 'reply lost'});
      }
      callback(null, page());
    },
    Snapshot(_call, callback) {
      callback(null, page());
    },
  });
  const sessions = ctx.load('/support/browser/sessions.ts');
  const sid = (await sessions.createSession('acme', 'public-web', 'buy a kettle', 20, ENTRY)).session_id;
  return {m: ctx.load('client'), driver, sid, sessions};
}

export async function check_deadline(ctx) {
  const {m, sid} = await world(ctx);
  let step = await m.runAction(sid, 'w-1', {type: 'navigate', target: KETTLES});
  assert.equal(step.outcome, 'ok', \`a navigation with a healthy driver ended \${JSON.stringify(step)}\`);
  step = await m.runAction(sid, 'w-1', {type: 'click', target: '#add-to-cart'});
  assert.equal(step.outcome, 'ok', \`a click with a healthy driver ended \${JSON.stringify(step)}\`);
  for (const method of ['Navigate', 'Act']) {
    for (const call of ctx.grpc.callsTo(method)) {
      assert(call.timeout !== null, \`a \${method} call carries no deadline: a hung page holds the worker as long as it hangs\`);
      assert(call.timeout >= 14.5 && call.timeout <= 15.5, \`a \${method} call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 15000\`);
    }
  }
  ctx.grpc.setLatency('Navigate', 60);
  step = await m.runAction(sid, 'w-1', {type: 'navigate', target: ENTRY});
  assert.equal(step.outcome, 'failed', \`with a page that hangs for 60 s the navigation ended \${step.outcome}: under a 15 s deadline it must end failed\`);
}

export async function check_verify_before_retry(ctx) {
  const {m, driver, sid} = await world(ctx);
  await m.runAction(sid, 'w-1', {type: 'navigate', target: KETTLES});
  driver.loseReply = 1;
  let step = await m.runAction(sid, 'w-1', {type: 'click', target: '#buy'});
  assert.equal(driver.applied, 1, \`the click was applied \${driver.applied} times: its reply was lost after the page handled it, and the retry clicked again. Read Snapshot and compare the digest before sending it again\`);
  assert(ctx.grpc.callsTo('Snapshot').length > 0, 'a click whose reply was lost must be checked against the page (Snapshot)');
  assert(step.outcome === 'ok' && step.digest === \`\${KETTLES}#1\`, \`the click landed, so the step must end ok on the page it left: \${JSON.stringify(step)}\`);
  driver.drop = 1;
  step = await m.runAction(sid, 'w-1', {type: 'click', target: '#confirm'});
  assert(driver.applied === 2 && step.outcome === 'ok', \`a click the driver refused before touching the page left \${driver.applied} applied actions and outcome \${step.outcome}: the digest is unchanged, so one more Act is safe\`);
}

export async function check_redirect_hops(ctx) {
  const {m, driver, sid, sessions} = await world(ctx);
  driver.redirects.set('https://www.example.com/login', METADATA);
  driver.redirects.set('https://www.example.com/old-kettles', WIKI);
  let step = await m.runAction(sid, 'w-1', {type: 'navigate', target: 'https://www.example.com/login'});
  const sent = ctx.grpc.callsTo('Navigate').map(c => c.request.url);
  assert(!sent.includes(METADATA), \`the browser was sent to \${JSON.stringify(sent)}: /login redirected to the metadata address and nothing authorized that hop\`);
  assert(step.outcome === 'blocked' && step.reason !== '', \`a redirect outside the profile must end the action blocked with a reason, got \${JSON.stringify(step)}\`);
  assert.equal((await sessions.loadSession(sid)).current_url, ENTRY, 'a blocked navigation must leave the session on its page');
  step = await m.runAction(sid, 'w-1', {type: 'navigate', target: 'https://www.example.com/old-kettles'});
  assert(step.outcome === 'ok' && step.url === WIKI, \`a redirect to a host the profile allows must be followed, got \${JSON.stringify(step)}\`);
  assert.equal((await sessions.loadSession(sid)).current_url, WIKI, 'the session must record the page the redirect ended on');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "browser/gen/browser_agent"
	"browser/sessions"

	"leetbuild/harness"
)

const (
	entryURL   = "https://www.example.com/"
	kettlesURL = "https://www.example.com/kettles"
	metadata   = "http://169.254.169.254/latest/meta-data/"
	wikiURL    = "https://en.wikipedia.org/wiki/Kettle"
)

var clientBg = context.Background()

// driverPeer is one browser: Navigate answers redirects as a 302, Act applies the action (drop:
// refused before the page sees it; loseReply: applied, then the reply is lost), the digest counts
// actions.
type driverPeer struct {
	pb.UnimplementedBrowserDriverServer
	url       string
	applied   int
	drop      int
	loseReply int
	redirects map[string]string
}

func (d *driverPeer) page() *pb.Page {
	return &pb.Page{Url: d.url, Status: 200, Digest: fmt.Sprintf("%s#%d", d.url, d.applied)}
}

func (d *driverPeer) Navigate(_ context.Context, req *pb.NavigateRequest) (*pb.Page, error) {
	if location, ok := d.redirects[req.GetUrl()]; ok {
		return &pb.Page{Url: req.GetUrl(), Status: 302, Location: location}, nil
	}
	d.url = req.GetUrl()
	return d.page(), nil
}

func (d *driverPeer) Act(_ context.Context, _ *pb.ActRequest) (*pb.Page, error) {
	if d.drop > 0 {
		d.drop--
		return nil, status.Error(codes.Unavailable, "driver restarting")
	}
	d.applied++
	if d.loseReply > 0 {
		d.loseReply--
		return nil, status.Error(codes.DeadlineExceeded, "reply lost")
	}
	return d.page(), nil
}

func (d *driverPeer) Snapshot(_ context.Context, _ *pb.SnapshotRequest) (*pb.Page, error) {
	return d.page(), nil
}

func world(ctx *harness.Ctx) (*driverPeer, string) {
	driver := &driverPeer{url: entryURL, redirects: map[string]string{}}
	pb.RegisterBrowserDriverServer(ctx.GRPC.Server(""), driver)
	return driver, sessions.CreateSession(clientBg, "acme", "public-web", "buy a kettle", 20, entryURL).ID
}

func CheckDeadline(ctx *harness.Ctx) {
	_, sid := world(ctx)
	step := runAction(clientBg, sid, "w-1", Action{Type: "navigate", Target: kettlesURL})
	ctx.Equal(step.Outcome, "ok", "a navigation with a healthy driver (%+v)", step)
	step = runAction(clientBg, sid, "w-1", Action{Type: "click", Target: "#add-to-cart"})
	ctx.Equal(step.Outcome, "ok", "a click with a healthy driver (%+v)", step)
	for _, method := range []string{"Navigate", "Act"} {
		for _, call := range ctx.GRPC.CallsTo(method, "") {
			ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a hung page holds the worker as long as it hangs", method)
			ctx.Assert(call.Timeout >= 14500*time.Millisecond && call.Timeout <= 15500*time.Millisecond, "a %s call carries a %v deadline, expected 15 s", method, call.Timeout)
		}
	}
	ctx.GRPC.SetLatency("Navigate", 60, "")
	step = runAction(clientBg, sid, "w-1", Action{Type: "navigate", Target: entryURL})
	ctx.Equal(step.Outcome, "failed", "with a page that hangs for 60 s, under a 15 s deadline the navigation must end failed; outcome")
}

func CheckVerifyBeforeRetry(ctx *harness.Ctx) {
	driver, sid := world(ctx)
	runAction(clientBg, sid, "w-1", Action{Type: "navigate", Target: kettlesURL})
	driver.loseReply = 1
	step := runAction(clientBg, sid, "w-1", Action{Type: "click", Target: "#buy"})
	ctx.Equal(driver.applied, 1, "the click's reply was lost after the page handled it, and a retry clicks again. Read Snapshot and compare the digest before sending it again; times applied")
	ctx.Assert(len(ctx.GRPC.CallsTo("Snapshot", "")) > 0, "a click whose reply was lost must be checked against the page (Snapshot)")
	ctx.Assert(step.Outcome == "ok" && step.Digest == kettlesURL+"#1", "the click landed, so the step must end ok on the page it left: %+v", step)
	driver.drop = 1
	step = runAction(clientBg, sid, "w-1", Action{Type: "click", Target: "#confirm"})
	ctx.Assert(driver.applied == 2 && step.Outcome == "ok", "a click the driver refused before touching the page left %d applied actions and outcome %q: the digest is unchanged, so one more Act is safe", driver.applied, step.Outcome)
}

func CheckRedirectHops(ctx *harness.Ctx) {
	driver, sid := world(ctx)
	driver.redirects["https://www.example.com/login"] = metadata
	driver.redirects["https://www.example.com/old-kettles"] = wikiURL
	step := runAction(clientBg, sid, "w-1", Action{Type: "navigate", Target: "https://www.example.com/login"})
	var sent []string
	for _, c := range ctx.GRPC.CallsTo("Navigate", "") {
		sent = append(sent, c.Request.(*pb.NavigateRequest).GetUrl())
		ctx.Assert(sent[len(sent)-1] != metadata, "the browser was sent to %q: /login redirected to the metadata address and nothing authorized that hop", sent)
	}
	ctx.Assert(step.Outcome == "blocked" && step.Reason != "", "a redirect outside the profile must end the action blocked with a reason, got %+v", step)
	ctx.Equal(sessions.LoadSession(clientBg, sid).CurrentURL, entryURL, "a blocked navigation must leave the session on its page; current_url")
	step = runAction(clientBg, sid, "w-1", Action{Type: "navigate", Target: "https://www.example.com/old-kettles"})
	ctx.Assert(step.Outcome == "ok" && step.URL == wikiURL, "a redirect to a host the profile allows must be followed, got %+v", step)
	ctx.Equal(sessions.LoadSession(clientBg, sid).CurrentURL, wikiURL, "the session must record the page the redirect ended on; current_url")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

#include "browser/sessions.h"

namespace {

const std::string kEntry = "https://www.example.com/";
const std::string kKettles = "https://www.example.com/kettles";
const std::string kMetadata = "http://169.254.169.254/latest/meta-data/";
const std::string kWiki = "https://en.wikipedia.org/wiki/Kettle";

// One browser: Navigate answers redirects as a 302, Act applies the action (drop: refused before
// the page sees it; lose_reply: applied, then the reply is lost), the digest counts actions.
class DriverPeer final : public browseragent::BrowserDriver::Service {
 public:
  std::string url = kEntry;
  int applied = 0;
  int drop = 0;
  int lose_reply = 0;
  std::map<std::string, std::string> redirects;

  void fill(browseragent::Page* out) {
    out->set_url(url);
    out->set_status(200);
    out->set_digest(url + "#" + std::to_string(applied));
  }

  grpc::Status Navigate(grpc::ServerContext*, const browseragent::NavigateRequest* req, browseragent::Page* out) override {
    const auto it = redirects.find(req->url());
    if (it != redirects.end()) {
      out->set_url(req->url());
      out->set_status(302);
      out->set_location(it->second);
      return grpc::Status::OK;
    }
    url = req->url();
    fill(out);
    return grpc::Status::OK;
  }

  grpc::Status Act(grpc::ServerContext*, const browseragent::ActRequest*, browseragent::Page* out) override {
    if (drop > 0) {
      drop--;
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, "driver restarting");
    }
    applied++;
    if (lose_reply > 0) {
      lose_reply--;
      return grpc::Status(grpc::StatusCode::DEADLINE_EXCEEDED, "reply lost");
    }
    fill(out);
    return grpc::Status::OK;
  }

  grpc::Status Snapshot(grpc::ServerContext*, const browseragent::SnapshotRequest*, browseragent::Page* out) override {
    fill(out);
    return grpc::Status::OK;
  }
};

DriverPeer& world(harness::Ctx& ctx, std::string& sid) {
  static DriverPeer* driver = nullptr;
  delete driver;
  driver = new DriverPeer;
  ctx.GRPC.Server("")->RegisterService(driver);
  sid = sessions::createSession("acme", "public-web", "buy a kettle", 20, kEntry).session_id;
  return *driver;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  std::string sid;
  world(ctx, sid);
  auto step = runAction(sid, "w-1", Action{"navigate", kKettles, ""});
  ctx.Equal(step.outcome, "ok", "a navigation with a healthy driver (%s)", step.reason);
  step = runAction(sid, "w-1", Action{"click", "#add-to-cart", ""});
  ctx.Equal(step.outcome, "ok", "a click with a healthy driver (%s)", step.reason);
  for (const std::string method : {"Navigate", "Act"}) {
    for (const auto& call : ctx.GRPC.CallsTo(method)) {
      ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a hung page holds the worker as long as it hangs", method);
      ctx.Assert(call.TimeoutSeconds() >= 14.5 && call.TimeoutSeconds() <= 15.5, "a %s call carries a %v s deadline, expected 15 s", method, call.TimeoutSeconds());
    }
  }
  ctx.GRPC.SetLatency("Navigate", 60);
  step = runAction(sid, "w-1", Action{"navigate", kEntry, ""});
  ctx.Equal(step.outcome, "failed", "with a page that hangs for 60 s, under a 15 s deadline the navigation must end failed; outcome");
}

void CheckVerifyBeforeRetry(harness::Ctx& ctx) {
  std::string sid;
  DriverPeer& driver = world(ctx, sid);
  runAction(sid, "w-1", Action{"navigate", kKettles, ""});
  driver.lose_reply = 1;
  auto step = runAction(sid, "w-1", Action{"click", "#buy", ""});
  ctx.Equal(driver.applied, 1, "the click's reply was lost after the page handled it, and a retry clicks again. Read Snapshot and compare the digest before sending it again; times applied");
  ctx.Assert(!ctx.GRPC.CallsTo("Snapshot").empty(), "a click whose reply was lost must be checked against the page (Snapshot)");
  ctx.Assert(step.outcome == "ok" && step.digest == kKettles + "#1", "the click landed, so the step must end ok on the page it left: outcome %q digest %q", step.outcome, step.digest);
  driver.drop = 1;
  step = runAction(sid, "w-1", Action{"click", "#confirm", ""});
  ctx.Assert(driver.applied == 2 && step.outcome == "ok", "a click the driver refused before touching the page left %d applied actions and outcome %q: the digest is unchanged, so one more Act is safe", driver.applied, step.outcome);
}

void CheckRedirectHops(harness::Ctx& ctx) {
  std::string sid;
  DriverPeer& driver = world(ctx, sid);
  driver.redirects["https://www.example.com/login"] = kMetadata;
  driver.redirects["https://www.example.com/old-kettles"] = kWiki;
  auto step = runAction(sid, "w-1", Action{"navigate", "https://www.example.com/login", ""});
  std::vector<std::string> sent;
  for (const auto& c : ctx.GRPC.CallsTo("Navigate")) sent.push_back(c.Request<browseragent::NavigateRequest>().url());
  for (const auto& url : sent) ctx.Assert(url != kMetadata, "the browser was sent to %q: /login redirected to the metadata address and nothing authorized that hop", sent);
  ctx.Assert(step.outcome == "blocked" && !step.reason.empty(), "a redirect outside the profile must end the action blocked with a reason, got outcome %q", step.outcome);
  ctx.Equal(sessions::loadSession(sid)->current_url, kEntry, "a blocked navigation must leave the session on its page; current_url");
  step = runAction(sid, "w-1", Action{"navigate", "https://www.example.com/old-kettles", ""});
  ctx.Assert(step.outcome == "ok" && step.url == kWiki, "a redirect to a host the profile allows must be followed, got outcome %q url %q", step.outcome, step.url);
  ctx.Equal(sessions::loadSession(sid)->current_url, kWiki, "the session must record the page the redirect ended on; current_url");
}
`,
  },
  hints: [
    'Hang the driver’s page: the action waits as long as the page does. Lose a click’s reply: the click lands twice. Redirect an allowed page to the metadata address: the browser follows it there.',
    'No call sets a deadline; `with_retries` replays an `Act` it cannot know failed; and `authorize_navigation` runs once before the redirect loop, so every `location` the loop follows is unchecked.',
    'Pass `timeout=DEADLINE_S` on every call; send `Act` once and, on a retryable error, compare `Snapshot`’s digest with `page_digest` before one replay; move `authorize_navigation` inside the redirect loop, ahead of each `Navigate`.',
  ],
  debrief: `The retry policy follows from what an action does to the world. Loading a page twice changes nothing, so Navigate retries freely; a click may have submitted a form, so after a lost reply the only safe question is the page's own state, and the digest answers it without guessing. The deadline is what turns a hung tab into an error the worker can act on instead of a pinned thread. Authorizing each hop matters because the page, not the agent, chooses where a redirect goes. Production agents also route subresource and WebSocket traffic through an egress proxy that applies the same profile, and record each redirect chain in the trace.`,
};
