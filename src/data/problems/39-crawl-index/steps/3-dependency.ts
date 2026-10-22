import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Fetcher calls with robots-aware retries',
  concept: 'grpc',
  file: 'client',
  focus: ['crawler', 'fetcher', 'hosts'],
  task: `## Task

The starter is a plausible model-generated draft: against a healthy host it fetches pages and stores
them, so the demo crawls. Every failure path is wrong. Find them, fix them, and prove the fix.

Implement \`fetch_one(job_id, host, queue, records)\` — one URL of one host, fetched through the
**Fetcher** gRPC service:

- Every attempt carries a **5-second deadline**. A call without one lets one stuck host pin a crawl
  worker until its process restarts.
- At most **3 attempts per URL**, and only transport failures that are worth retrying are retried:
  \`UNAVAILABLE\` (5xx) and \`DEADLINE_EXCEEDED\` (timeout). Everything else is handled once.
- **403 and 404 are never retried.** A 403 is recorded as **permanently refused**
  (\`mark_refused(url, "robots")\`) and a 404 as **gone**; the draft treats a 403 as “the page must
  exist” and spins on it forever.
- A **429** reschedules the whole host: call \`records.throttle(job_id, host, reply.retry_after_s, attempt)\`
  so the host's next fetch waits out \`Retry-After\` with exponential backoff, and put the URL back
  without counting the 429 as an attempt against it. The draft ignores \`Retry-After\` entirely.
- The URL **leaves the queue before the fetch** (\`queue.take(...)\`) and is only returned to the
  tail through \`queue.requeue(..., attempts)\` when a retry is still allowed. Peeking at the head
  and fetching it in place means one dead host holds the shard's head forever.

**Failure mode the checks target.** An unbounded retry loop turns a permission error into a hot loop;
treating 403 as transient means a robots-disallowed URL is fetched thousands of times; keeping the
URL at the head means a host that is down stalls every other host behind it in the same shard; and
ignoring \`Retry-After\` means the crawler answers a polite 429 by knocking harder.`,
  sequence: {
    participants: ['Crawl service', 'Fetcher', 'Web host', 'Redis frontier'],
    messages: [
      {
        from: 'Crawl service',
        to: 'Redis frontier',
        label: 'take(job, host) — the URL leaves the queue first',
        kind: 'sync',
      },
      {from: 'Crawl service', to: 'Fetcher', label: 'Fetch(url) · deadline 5 s · attempt 1…3', kind: 'sync'},
      {from: 'Fetcher', to: 'Web host', label: 'GET path', kind: 'sync'},
      {from: 'Web host', to: 'Fetcher', label: '200 / 403 / 404 / 429 / 503', kind: 'reply'},
      {
        from: 'Fetcher',
        to: 'Crawl service',
        label: 'FetchReply{status, body_ref, content_hash, retry_after_s}',
        kind: 'reply',
      },
      {
        from: 'Crawl service',
        to: 'Crawl service',
        label: '403 → mark_refused · 404 → gone · 5xx → retry',
        kind: 'sync',
      },
      {from: 'Crawl service', to: 'Redis frontier', label: 'requeue tail or throttle host on 429', kind: 'async'},
    ],
  },
  hints: [
    'A gRPC deadline is an argument on the RPC (`timeout=`, `deadline: Date.now() + …`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`) — wrapping the call changes nothing. Two different clocks are in play: the 5-second deadline bounds one attempt, while the attempt budget bounds the URL.',
    'Retryability is a property of the failure, not of “it threw”: transport codes `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retryable, an HTTP status in the reply is data. That split is why 403/404 must be read out of `reply.status` and turned into terminal records (`mark_refused`, `mark_gone`) instead of being thrown back into the retry loop.',
    'Take the URL before the network call and hand it back only through `requeue` with an incremented attempt count. The queue is the crawl’s only source of truth about what is left to do, so a URL that is neither taken nor dropped is a URL the shard can never get past.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 5-second deadline',
      detail:
        'The call is created with a 5-second deadline — `timeout=DEADLINE_S`, `deadline: Date.now() + DEADLINE_MS`, a context with timeout, `withDeadlineAfter` or `set_deadline`. Without it a stuck host holds the worker forever.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*5/, /timeout=DEADLINE_S/, /\.Fetch\(/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*5000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.Fetch\(/]},
        go: {all: [/deadlineMS\s*=\s*5000/, /context\.WithTimeout/, /\.Fetch\(/]},
        scala: {all: [/DeadlineMs\s*=\s*5000/, /withDeadlineAfter/, /\.fetch\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*5000/, /set_deadline\(/, /->Fetch\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'At most three attempts, only the retryable failures',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS = 3` and only `UNAVAILABLE`/`DEADLINE_EXCEEDED` are retried; there is no unbounded loop. The draft retries everything — including the 403 it can never satisfy.',
      match: {
        python: {
          all: [
            /MAX_ATTEMPTS\s*=\s*3/,
            /range\(MAX_ATTEMPTS\)/,
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
          ],
          none: [/while\s+True/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /attempt\s*<\s*MAX_ATTEMPTS/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [/maxAttempts\s*=\s*3/, /attempt\s*<\s*maxAttempts/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/for\s+attempt\s*:=\s*0;\s*;\s*attempt\+\+/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*3/, /attempt\s*<\s*MaxAttempts/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [
            /kMaxAttempts\s*=\s*3/,
            /attempt\s*<\s*kMaxAttempts/,
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
          ],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'refused-terminal',
      title: '403 and 404 are terminal, never retried',
      detail:
        'A 403 is recorded as permanently refused and a 404 as gone; neither re-enters the retry loop. The draft treats a 403 as transient and replays it forever.',
      match: {
        python: {all: [/mark_refused\(/, /reply\.status\s*==\s*403/, /reply\.status\s*==\s*404/]},
        typescript: {all: [/markRefused\(/, /reply\.status\s*===\s*403/, /reply\.status\s*===\s*404/]},
        go: {all: [/MarkRefused\(/, /reply\.Status\s*==\s*403/, /reply\.Status\s*==\s*404/]},
        scala: {all: [/markRefused\(/, /reply\.status\s*==\s*403/, /reply\.status\s*==\s*404/]},
        cpp: {all: [/markRefused\(/, /reply\.status\(\)\s*==\s*403/, /reply\.status\(\)\s*==\s*404/]},
      },
    },
    {
      id: 'no-head-block',
      title: 'The URL leaves the queue before the fetch',
      detail:
        'Work is taken with `queue.take(...)` before the RPC and handed back with `requeue(..., attempts)` — never inspected at the head. The draft peeks at the head, so one dead host blocks the shard.',
      match: {
        python: {all: [/queue\.take\(/, /requeue\(/], none: [/queue\.head\(/]},
        typescript: {all: [/queue\.take\(/, /requeue\(/], none: [/queue\.head\(/]},
        go: {all: [/queue\.Take\(/, /Requeue\(/], none: [/queue\.Head\(/]},
        scala: {all: [/queue\.take\(/, /requeue\(/], none: [/queue\.head\(/]},
        cpp: {all: [/queue\.take\(/, /requeue\(/], none: [/queue\.head\(/]},
      },
    },
    {
      id: 'retry-after',
      title: 'A 429 throttles the host by Retry-After',
      detail:
        'A 429 calls `records.throttle(job_id, host, reply.retry_after_s, attempt)` so the host waits out `Retry-After` with exponential backoff, and the URL is given back so it is crawled later. The draft ignores the header.',
      match: {
        python: {all: [/reply\.status\s*==\s*429/, /retry_after/, /throttle\(/]},
        typescript: {all: [/reply\.status\s*===\s*429/, /retry_after/, /throttle\(/]},
        go: {all: [/reply\.Status\s*==\s*429/, /RetryAfter/, /Throttle\(/]},
        scala: {all: [/reply\.status\s*==\s*429/, /retryAfter/, /throttle\(/]},
        cpp: {all: [/reply\.status\(\)\s*==\s*429/, /retry_after/, /throttle\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import fetcher_pb2
import fetcher_pb2_grpc

channel = grpc.insecure_channel("fetcher:9000")
fetcher = fetcher_pb2_grpc.FetcherStub(channel)


def fetch_one(job_id: str, host: str, queue, records) -> str | None:
    """Fetch one URL for the host and store the page, or return the next one later."""
    # TODO: add the 5-second deadline, bound the attempts to 3 and retry only UNAVAILABLE and
    # DEADLINE_EXCEEDED, record a 403 as permanently refused instead of retrying the page that
    # "must exist", take the URL off the queue before fetching so a dead host cannot block the
    # shard, and honour a 429 Retry-After for the whole host.
    url = queue.head(job_id, host)
    if url is None:
        return None
    while True:
        try:
            reply = fetcher.Fetch(fetcher_pb2.FetchRequest(url=url))
            if reply.status == 403:
                continue
            records.store_page(url, reply.body_ref, reply.content_hash)
            return reply.body_ref
        except Exception:
            continue
`,
      solution: `import grpc

import fetcher_pb2
import fetcher_pb2_grpc

DEADLINE_S = 5.0
MAX_ATTEMPTS = 3
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("fetcher:9000")
fetcher = fetcher_pb2_grpc.FetcherStub(channel)


def fetch_one(job_id: str, host: str, queue, records) -> str | None:
    """One URL of one host, fetched with a deadline, bounded retries and a host-level backoff."""
    url = queue.take(job_id, host)
    if url is None:
        return None
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = fetcher.Fetch(fetcher_pb2.FetchRequest(url=url), timeout=DEADLINE_S)
        except grpc.RpcError as error:
            if error.code() in RETRYABLE and attempt + 1 < MAX_ATTEMPTS:
                continue
            queue.requeue(job_id, host, url, attempt + 1)
            return None
        if reply.status == 429:
            records.throttle(job_id, host, reply.retry_after_s, attempt + 1)
            queue.requeue(job_id, host, url, 0)
            return None
        if reply.status == 403:
            records.mark_refused(url, "robots")
            return None
        if reply.status == 404:
            records.mark_gone(url)
            return None
        if reply.status >= 500 and attempt + 1 < MAX_ATTEMPTS:
            continue
        records.store_page(url, reply.body_ref, reply.content_hash)
        return reply.body_ref
    queue.requeue(job_id, host, url, MAX_ATTEMPTS)
    return None
`,
    },
    typescript: {
      starter: `/** Fetcher calls: a model-generated draft that retries a 403 forever. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface FetchReply {
  status: number;
  body_ref: string;
  content_hash: string;
  retry_after_s: number;
}

interface FetcherClient {
  Fetch(
    request: {url: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply?: FetchReply) => void,
  ): grpc.ClientUnaryCall;
}

const {crawl} = grpc.loadPackageDefinition(protoLoader.loadSync('fetcher.proto')) as unknown as {
  crawl: {Fetcher: new (target: string, credentials: grpc.ChannelCredentials) => FetcherClient};
};
const fetcher = new crawl.Fetcher('fetcher:9000', grpc.credentials.createInsecure());

function callFetch(url: string): Promise<FetchReply> {
  const {promise, resolve, reject} = Promise.withResolvers<FetchReply>();
  fetcher.Fetch({url}, new grpc.Metadata(), {}, (error, reply) => {
    if (error !== null) reject(error);
    else resolve(reply as FetchReply);
  });
  return promise;
}

export interface Frontier {
  head(job_id: string, host: string): Promise<string | null>;
  requeue(job_id: string, host: string, url: string, attempts: number): Promise<void>;
}

export interface PageRecords {
  markRefused(url: string, reason: string): Promise<void>;
  markGone(url: string): Promise<void>;
  throttle(job_id: string, host: string, retry_after_s: number, attempts: number): Promise<void>;
  storePage(url: string, body_ref: string, content_hash: string): Promise<void>;
}

export async function fetchOne(jobId: string, host: string, queue: Frontier, records: PageRecords): Promise<string | null> {
  // TODO: add the 5-second deadline, bound the attempts to 3 and retry only UNAVAILABLE and
  // DEADLINE_EXCEEDED, record a 403 as permanently refused instead of retrying the page that
  // "must exist", take the URL off the queue before fetching so a dead host cannot block the
  // shard, and honour a 429 Retry-After for the whole host.
  const url = await queue.head(jobId, host);
  if (url === null) return null;
  for (;;) {
    try {
      const reply = await callFetch(url);
      if (reply.status === 403) continue;
      await records.storePage(url, reply.body_ref, reply.content_hash);
      return reply.body_ref;
    } catch {
      continue;
    }
  }
}
`,
      solution: `/** Fetcher calls: 5 s deadline, three bounded attempts, terminal 403/404, host backoff. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 5000;
const MAX_ATTEMPTS = 3;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface FetchReply {
  status: number;
  body_ref: string;
  content_hash: string;
  retry_after_s: number;
}

interface FetcherClient {
  Fetch(
    request: {url: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply?: FetchReply) => void,
  ): grpc.ClientUnaryCall;
}

const {crawl} = grpc.loadPackageDefinition(protoLoader.loadSync('fetcher.proto')) as unknown as {
  crawl: {Fetcher: new (target: string, credentials: grpc.ChannelCredentials) => FetcherClient};
};
const fetcher = new crawl.Fetcher('fetcher:9000', grpc.credentials.createInsecure());

function callFetch(url: string): Promise<FetchReply> {
  const {promise, resolve, reject} = Promise.withResolvers<FetchReply>();
  fetcher.Fetch({url}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS}, (error, reply) => {
    if (error !== null) reject(error);
    else resolve(reply as FetchReply);
  });
  return promise;
}

export interface Frontier {
  take(job_id: string, host: string): Promise<string | null>;
  requeue(job_id: string, host: string, url: string, attempts: number): Promise<void>;
}

export interface PageRecords {
  markRefused(url: string, reason: string): Promise<void>;
  markGone(url: string): Promise<void>;
  throttle(job_id: string, host: string, retry_after_s: number, attempts: number): Promise<void>;
  storePage(url: string, body_ref: string, content_hash: string): Promise<void>;
}

export async function fetchOne(jobId: string, host: string, queue: Frontier, records: PageRecords): Promise<string | null> {
  const url = await queue.take(jobId, host);
  if (url === null) return null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let reply: FetchReply;
    try {
      reply = await callFetch(url);
    } catch (error) {
      if (RETRYABLE[(error as grpc.ServiceError).code] === true && attempt + 1 < MAX_ATTEMPTS) continue;
      await queue.requeue(jobId, host, url, attempt + 1);
      return null;
    }
    if (reply.status === 429) {
      await records.throttle(jobId, host, reply.retry_after_s, attempt + 1);
      await queue.requeue(jobId, host, url, 0);
      return null;
    }
    if (reply.status === 403) {
      await records.markRefused(url, 'robots');
      return null;
    }
    if (reply.status === 404) {
      await records.markGone(url);
      return null;
    }
    if (reply.status >= 500 && attempt + 1 < MAX_ATTEMPTS) continue;
    await records.storePage(url, reply.body_ref, reply.content_hash);
    return reply.body_ref;
  }
  await queue.requeue(jobId, host, url, MAX_ATTEMPTS);
  return null;
}
`,
    },
    go: {
      starter: `package client

import (
	"context"
	"log"

	"google.golang.org/grpc"

	fetchpb "github.com/leetbuild/crawl/gen/fetch"
)

var fetcher = fetchpb.NewFetcherClient(dial("fetcher:9000"))

type Frontier interface {
	Head(ctx context.Context, jobID, host string) (string, bool, error)
	Requeue(ctx context.Context, jobID, host, url string, attempts int) error
}

type PageRecords interface {
	MarkRefused(ctx context.Context, url, reason string) error
	MarkGone(ctx context.Context, url string) error
	Throttle(ctx context.Context, jobID, host string, retryAfterS, attempts int) error
	StorePage(ctx context.Context, url, bodyRef, contentHash string) error
}

func FetchOne(ctx context.Context, jobID, host string, queue Frontier, records PageRecords) (string, error) {
	// TODO: add the 5-second deadline, bound the attempts to 3 and retry only UNAVAILABLE and
	// DEADLINE_EXCEEDED, record a 403 as permanently refused instead of retrying the page that
	// "must exist", take the URL off the queue before fetching so a dead host cannot block the
	// shard, and honour a 429 Retry-After for the whole host.
	url, ok, err := queue.Head(ctx, jobID, host)
	if err != nil || !ok {
		return "", err
	}
	for {
		reply, err := fetcher.Fetch(ctx, &fetchpb.FetchRequest{Url: url})
		if err != nil {
			continue
		}
		if reply.Status == 403 {
			continue
		}
		if err := records.StorePage(ctx, url, reply.BodyRef, reply.ContentHash); err != nil {
			log.Printf("store %s: %v", url, err)
		}
		return reply.BodyRef, nil
	}
}
`,
      solution: `package client

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	fetchpb "github.com/leetbuild/crawl/gen/fetch"
)

const (
	deadlineMS  = 5000
	maxAttempts = 3
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var fetcher = fetchpb.NewFetcherClient(dial("fetcher:9000"))

type Frontier interface {
	Take(ctx context.Context, jobID, host string) (string, bool, error)
	Requeue(ctx context.Context, jobID, host, url string, attempts int) error
}

type PageRecords interface {
	MarkRefused(ctx context.Context, url, reason string) error
	MarkGone(ctx context.Context, url string) error
	Throttle(ctx context.Context, jobID, host string, retryAfterS, attempts int) error
	StorePage(ctx context.Context, url, bodyRef, contentHash string) error
}

func FetchOne(ctx context.Context, jobID, host string, queue Frontier, records PageRecords) (string, error) {
	url, ok, err := queue.Take(ctx, jobID, host)
	if err != nil || !ok {
		return "", err
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		reply, err := fetcher.Fetch(callCtx, &fetchpb.FetchRequest{Url: url})
		cancel()
		if err != nil {
			if retryable[status.Code(err)] && attempt+1 < maxAttempts {
				continue
			}
			if requeueErr := queue.Requeue(ctx, jobID, host, url, attempt+1); requeueErr != nil {
				return "", requeueErr
			}
			return "", err
		}
		if reply.Status == 429 {
			if err := records.Throttle(ctx, jobID, host, reply.RetryAfterS, attempt+1); err != nil {
				return "", err
			}
			return "", queue.Requeue(ctx, jobID, host, url, 0)
		}
		if reply.Status == 403 {
			return "", records.MarkRefused(ctx, url, "robots")
		}
		if reply.Status == 404 {
			return "", records.MarkGone(ctx, url)
		}
		if reply.Status >= 500 && attempt+1 < maxAttempts {
			continue
		}
		return reply.BodyRef, records.StorePage(ctx, url, reply.BodyRef, reply.ContentHash)
	}
	return "", queue.Requeue(ctx, jobID, host, url, maxAttempts)
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

object FetchClient {
  val fetcher = FetcherGrpc.blockingStub(ManagedChannelBuilder.forAddress("fetcher", 9000).usePlaintext().build())

  // TODO: add the 5-second deadline, bound the attempts to 3 and retry only UNAVAILABLE and
  // DEADLINE_EXCEEDED, record a 403 as permanently refused instead of retrying the page that
  // "must exist", take the URL off the queue before fetching so a dead host cannot block the
  // shard, and honour a 429 Retry-After for the whole host.
  def fetchOne(jobId: String, host: String, queue: Frontier, records: PageRecords): Option[String] = {
    val url = queue.head(jobId, host).getOrElse(return None)
    var done = false
    while (!done) {
      try {
        val reply = fetcher.fetch(FetchRequest(url = url))
        if (reply.status == 403) {
          ()
        } else {
          records.storePage(url, reply.bodyRef, reply.contentHash)
          return Some(reply.bodyRef)
        }
      } catch {
        case _: Exception => ()
      }
    }
    None
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object FetchClient {
  val DeadlineMs = 5000
  val MaxAttempts = 3
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val fetcher = FetcherGrpc.blockingStub(ManagedChannelBuilder.forAddress("fetcher", 9000).usePlaintext().build())

  def fetchOne(jobId: String, host: String, queue: Frontier, records: PageRecords): Option[String] = {
    val url = queue.take(jobId, host).getOrElse(return None)
    var attempt = 0
    var stop = false
    while (attempt < MaxAttempts && !stop) {
      try {
        val reply = fetcher.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).fetch(FetchRequest(url = url))
        if (reply.status == 429) {
          records.throttle(jobId, host, reply.retryAfterS, attempt + 1)
          queue.requeue(jobId, host, url, 0)
          return None
        }
        if (reply.status == 403) {
          records.markRefused(url, "robots")
          return None
        }
        if (reply.status == 404) {
          records.markGone(url)
          return None
        }
        if (reply.status >= 500 && attempt + 1 < MaxAttempts) {
          attempt += 1
        } else {
          records.storePage(url, reply.bodyRef, reply.contentHash)
          return Some(reply.bodyRef)
        }
      } catch {
        case exc: StatusRuntimeException =>
          if (Retryable.contains(exc.getStatus.getCode) && attempt + 1 < MaxAttempts) attempt += 1
          else stop = true
      }
    }
    queue.requeue(jobId, host, url, MaxAttempts)
    None
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <memory>
#include <optional>
#include <string>

#include "fetcher.grpc.pb.h"

std::unique_ptr<Fetcher::Stub> fetcher = Fetcher::NewStub(grpc::CreateChannel("fetcher:9000", grpc::InsecureChannelCredentials()));

std::optional<std::string> fetchOne(const std::string& jobId, const std::string& host, Frontier& queue, PageRecords& records) {
  // TODO: add the 5-second deadline, bound the attempts to 3 and retry only UNAVAILABLE and
  // DEADLINE_EXCEEDED, record a 403 as permanently refused instead of retrying the page that
  // "must exist", take the URL off the queue before fetching so a dead host cannot block the
  // shard, and honour a 429 Retry-After for the whole host.
  const auto url = queue.head(jobId, host);
  if (!url) return std::nullopt;
  while (true) {
    grpc::ClientContext context;
    FetchReply reply;
    const auto status = fetcher->Fetch(&context, FetchRequest(*url), &reply);
    if (!status.ok() || reply.status() == 403) continue;
    records.storePage(*url, reply.body_ref(), reply.content_hash());
    return reply.body_ref();
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <optional>
#include <string>

#include "fetcher.grpc.pb.h"

constexpr int kDeadlineMs = 5000;
constexpr int kMaxAttempts = 3;

std::unique_ptr<Fetcher::Stub> fetcher = Fetcher::NewStub(grpc::CreateChannel("fetcher:9000", grpc::InsecureChannelCredentials()));

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

std::optional<std::string> fetchOne(const std::string& jobId, const std::string& host, Frontier& queue, PageRecords& records) {
  const auto url = queue.take(jobId, host);
  if (!url) return std::nullopt;
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    FetchReply reply;
    const auto status = fetcher->Fetch(&context, FetchRequest(*url), &reply);
    if (!status.ok()) {
      if (retryable(status.error_code()) && attempt + 1 < kMaxAttempts) continue;
      queue.requeue(jobId, host, *url, attempt + 1);
      return std::nullopt;
    }
    if (reply.status() == 429) {
      records.throttle(jobId, host, reply.retry_after_s(), attempt + 1);
      queue.requeue(jobId, host, *url, 0);
      return std::nullopt;
    }
    if (reply.status() == 403) {
      records.markRefused(*url, "robots");
      return std::nullopt;
    }
    if (reply.status() == 404) {
      records.markGone(*url);
      return std::nullopt;
    }
    if (reply.status() >= 500 && attempt + 1 < kMaxAttempts) continue;
    records.storePage(*url, reply.body_ref(), reply.content_hash());
    return reply.body_ref();
  }
  queue.requeue(jobId, host, *url, kMaxAttempts);
  return std::nullopt;
}
`,
    },
  },
  debrief: `The interviewer is testing the failure policy of a remote call, which is where crawlers die in production. The draft looks fine against a healthy host: it fetches, it stores, it moves on. Four defects are being checked: the missing deadline (one stuck host pins a worker), the unbounded retry loop (a permission error becomes a hot loop), the head-of-queue fetch (one dead host blocks every other host in the shard), and the ignored \`Retry-After\` (a polite 429 is answered with another request). Real crawlers add a per-host concurrency cap, a global request-rate governor across workers, and a dead-letter record so an operator can see what was dropped after the attempt budget ran out.`,
};
