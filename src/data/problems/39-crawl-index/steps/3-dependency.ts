import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Fetcher calls: a deadline, bounded retries and a status policy',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['crawler', 'fetcher', 'hosts', 'redis'],
  task: `## Task

**Starting point.** The starter is the crawl worker's \`fetch_one(job_id, host, rate_per_minute)\`:
it reads the head of the host's queue with \`LINDEX\`, calls \`Fetcher.Fetch\` over gRPC up to ten
times, and on a 200 removes the URL with \`LREM\` and records it with \`records.mark_fetched\`; after
ten misses it records \`mark_failed\`. It answers \`{url, outcome, …}\`, or None when there is
nothing to fetch. Against a healthy host it crawls, and it hides five flaws.

**Failure mode the checks target.** A stalled host holds a worker as long as it likes; a host that
is down gets ten requests per URL; a 403 or a 404 is fetched ten times; a 429 is answered with
nine more requests; and two workers fetch the same URL because it never left the queue.

\`\`\`proto
service Fetcher { rpc Fetch(FetchRequest) returns (FetchReply); }  // {status, content_hash, body_ref, retry_after_s}
\`\`\`

- The URL leaves the queue through \`frontier.take\` (the host's bucket) before the call.
- Every call carries \`DEADLINE_S\` = 5 s. At most \`MAX_ATTEMPTS\` = 3, retrying only \`UNAVAILABLE\`
  and \`DEADLINE_EXCEEDED\`; then \`mark_failed\` (outcome \`failed\`).
- 403 is \`mark_refused(job_id, url, "forbidden")\` (\`refused\`), 404 \`mark_gone\` (\`gone\`): one call.
- 429 calls \`frontier.throttle(job_id, host, retry_after_s)\` and \`frontier.requeue\`, records no
  outcome, and answers \`throttled\`.`,
  sequence: {
    participants: ['Crawl worker', 'Redis frontier', 'Fetcher', 'Web host'],
    messages: [
      {from: 'Crawl worker', to: 'Redis frontier', label: 'take(job, host, rate) → url', kind: 'sync'},
      {from: 'Crawl worker', to: 'Fetcher', label: 'Fetch(url) · deadline 5 s · ≤ 3 attempts', kind: 'sync'},
      {from: 'Fetcher', to: 'Web host', label: 'GET /path', kind: 'sync'},
      {
        from: 'Fetcher',
        to: 'Crawl worker',
        label: 'status · or UNAVAILABLE / DEADLINE_EXCEEDED → retry',
        kind: 'reply',
      },
      {
        from: 'Crawl worker',
        to: 'Redis frontier',
        label: '429: throttle(host, Retry-After) · requeue(url)',
        kind: 'sync',
      },
      {
        from: 'Crawl worker',
        to: 'Crawl worker',
        label: '200 fetched · 403 refused · 404 gone · else failed',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every fetch carries a 5-second deadline',
      detail:
        'Each `Fetch` call is made with `DEADLINE_S` (5 s), so a host slower than that ends in `DEADLINE_EXCEEDED` and, after the attempts, a failed page. The starter sets no deadline.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*5\b/, /Fetch\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*5000\b/, /Fetch\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*5\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*5L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{5\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'At most three attempts, only on UNAVAILABLE and DEADLINE_EXCEEDED',
      detail:
        'A URL is tried at most `MAX_ATTEMPTS` (3) times, and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried; any other error fails the page at once. The starter retries every error, ten times.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*3\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/except grpc\.RpcError:\s*\n\s*continue/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/catch\s*(\(\w*\))?\s*\{\s*continue;?\s*\}/],
        },
        go: {
          all: [/maxAttempts\s*=\s*3\b/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/if err != nil \{\s*continue\s*\}/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*3\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/case _: StatusRuntimeException =>/],
        },
        cpp: {
          all: [/kMaxAttempts\s*=\s*3\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/if \(!status\.ok\(\)\) continue;/],
        },
      },
    },
    {
      id: 'terminal-status',
      title: '403 is refused and 404 is gone, after one call',
      detail:
        'A 403 records `mark_refused(job_id, url, "forbidden")` and a 404 `mark_gone`, each after a single call: they are the site\'s answer about that URL. The starter retries both like an outage.',
      match: {
        python: {all: [/==\s*403/, /records\.mark_refused\(/, /==\s*404/, /records\.mark_gone\(/]},
        typescript: {all: [/===\s*403/, /markRefused\(/, /===\s*404/, /markGone\(/]},
        go: {all: [/==\s*403/, /records\.MarkRefused\(/, /==\s*404/, /records\.MarkGone\(/]},
        scala: {all: [/==\s*403/, /Records\.markRefused\(/, /==\s*404/, /Records\.markGone\(/]},
        cpp: {all: [/==\s*403/, /records::markRefused\(/, /==\s*404/, /records::markGone\(/]},
      },
    },
    {
      id: 'throttle-429',
      title: 'A 429 throttles the host and requeues the URL',
      detail:
        "A 429 calls `frontier.throttle` with the reply's `retry_after_s` and `frontier.requeue`s the URL, records no outcome and makes no further call. The starter answers a 429 with more requests.",
      match: {
        python: {all: [/==\s*429/, /frontier\.throttle\(/, /frontier\.requeue\(/, /retry_after_s/]},
        typescript: {all: [/===\s*429/, /throttle\(/, /requeue\(/, /retry_after_s/]},
        go: {all: [/==\s*429/, /frontier\.Throttle\(/, /frontier\.Requeue\(/, /RetryAfterS/]},
        scala: {all: [/==\s*429/, /Frontier\.throttle\(/, /Frontier\.requeue\(/, /retryAfterS/]},
        cpp: {all: [/==\s*429/, /frontier::throttle\(/, /frontier::requeue\(/, /retry_after_s\(\)/]},
      },
    },
    {
      id: 'take-first',
      title: 'Takes the URL through the bucket before fetching it',
      detail:
        "The URL comes from `frontier.take`, which pops it and spends the host's token, before `Fetch` is called. The starter peeks with `LINDEX`, so the URL stays visible to every other worker and the host's pace is never asked.",
      match: {
        python: {order: [/frontier\.take\(/, /\.Fetch\(/], none: [/\.lindex\(/]},
        typescript: {order: [/(?<![.\w])take\(|frontier\.take\(/, /\.Fetch\(/], none: [/\.lindex\(/]},
        go: {order: [/frontier\.Take\(/, /\.Fetch\(/], none: [/\.LIndex\(/]},
        scala: {order: [/Frontier\.take\(/, /\.fetch\(|\bcall\(jobId/], none: [/\.lindex\(/]},
        cpp: {order: [/frontier::take\(/, /->Fetch\(/], none: [/\.lindex\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc
import redis

import fetcher_pb2
import fetcher_pb2_grpc
from crawl import frontier, records  # frontier.take, throttle, requeue, queue_key; records.mark_fetched, mark_refused, mark_gone, mark_failed

r = redis.Redis(host="redis", port=6379, decode_responses=True)
fetcher = fetcher_pb2_grpc.FetcherStub(grpc.insecure_channel("fetcher:9000"))


def fetch_one(job_id: str, host: str, rate_per_minute: int) -> dict | None:
    """Fetch the host's next URL and record what became of it; None when the host has nothing to hand out."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    queue = frontier.queue_key(job_id, host)
    url = r.lindex(queue, 0)
    if url is None:
        return None
    for attempt in range(10):
        try:
            reply = fetcher.Fetch(fetcher_pb2.FetchRequest(job_id=job_id, url=url))
        except grpc.RpcError:
            continue
        if reply.status == 200:
            r.lrem(queue, 1, url)
            records.mark_fetched(job_id, url, reply.content_hash, reply.body_ref)
            return {"url": url, "outcome": "fetched", "content_hash": reply.content_hash, "body_ref": reply.body_ref}
    r.lrem(queue, 1, url)
    records.mark_failed(job_id, url, "gave up after 10 attempts")
    return {"url": url, "outcome": "failed"}
`,
      solution: `import grpc

import fetcher_pb2
import fetcher_pb2_grpc
from crawl import frontier, records  # frontier.take, throttle, requeue, queue_key; records.mark_fetched, mark_refused, mark_gone, mark_failed

DEADLINE_S = 5
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

fetcher = fetcher_pb2_grpc.FetcherStub(grpc.insecure_channel("fetcher:9000"))


def fetch_one(job_id: str, host: str, rate_per_minute: int) -> dict | None:
    """Fetch the host's next URL and record what became of it; None when the host has nothing to hand out."""
    # The URL leaves the queue, through the host's bucket, before anything is fetched.
    url = frontier.take(job_id, host, rate_per_minute)
    if url is None:
        return None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = fetcher.Fetch(fetcher_pb2.FetchRequest(job_id=job_id, url=url), timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            # An outage or a timeout says nothing about the URL: it earns a bounded retry. Anything else fails it.
            if exc.code() in RETRYABLE and attempt < MAX_ATTEMPTS:
                continue
            records.mark_failed(job_id, url, exc.code().name)
            return {"url": url, "outcome": "failed"}
        if reply.status == 429:
            # The host asked for room: the whole host waits, and the URL goes back without an outcome.
            frontier.throttle(job_id, host, reply.retry_after_s)
            frontier.requeue(job_id, host, url)
            return {"url": url, "outcome": "throttled"}
        if reply.status == 403:
            records.mark_refused(job_id, url, "forbidden")
            return {"url": url, "outcome": "refused"}
        if reply.status == 404:
            records.mark_gone(job_id, url)
            return {"url": url, "outcome": "gone"}
        if reply.status != 200:
            records.mark_failed(job_id, url, f"status {reply.status}")
            return {"url": url, "outcome": "failed"}
        records.mark_fetched(job_id, url, reply.content_hash, reply.body_ref)
        return {"url": url, "outcome": "fetched", "content_hash": reply.content_hash, "body_ref": reply.body_ref}
    return None
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {queueKey} from 'crawl/frontier';
import {markFailed, markFetched} from 'crawl/records';

interface FetchRequest {
  job_id: string;
  url: string;
}

interface FetchReply {
  status: number;
  content_hash: string;
  body_ref: string;
  retry_after_s: number;
}

export interface Outcome {
  url: string;
  outcome: string;
  content_hash?: string;
  body_ref?: string;
}

const redis = new Redis({host: 'redis', port: 6379});
const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('fetcher.proto')) as unknown as {crawl: {Fetcher: grpc.ServiceClientConstructor}};
const fetcher = new pkg.crawl.Fetcher('fetcher:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Fetch(request: FetchRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<FetchReply>;
};

/** Fetch the host's next URL and record what became of it; null when the host has nothing to hand out. */
export async function fetchOne(jobId: string, host: string, ratePerMinute: number): Promise<Outcome | null> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const queue = queueKey(jobId, host);
  const url = await redis.lindex(queue, 0);
  if (url === null) return null;
  for (let attempt = 0; attempt < 10; attempt++) {
    let reply: FetchReply;
    try {
      reply = await fetcher.Fetch({job_id: jobId, url}, new grpc.Metadata(), {});
    } catch {
      continue;
    }
    if (reply.status === 200) {
      await redis.lrem(queue, 1, url);
      await markFetched(jobId, url, reply.content_hash, reply.body_ref);
      return {url, outcome: 'fetched', content_hash: reply.content_hash, body_ref: reply.body_ref};
    }
  }
  await redis.lrem(queue, 1, url);
  await markFailed(jobId, url, 'gave up after 10 attempts');
  return {url, outcome: 'failed'};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {requeue, take, throttle} from 'crawl/frontier';
import {markFailed, markFetched, markGone, markRefused} from 'crawl/records';

export const DEADLINE_MS = 5000;
export const MAX_ATTEMPTS = 3;
const RETRYABLE: number[] = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

interface FetchRequest {
  job_id: string;
  url: string;
}

interface FetchReply {
  status: number;
  content_hash: string;
  body_ref: string;
  retry_after_s: number;
}

export interface Outcome {
  url: string;
  outcome: string;
  content_hash?: string;
  body_ref?: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('fetcher.proto')) as unknown as {crawl: {Fetcher: grpc.ServiceClientConstructor}};
const fetcher = new pkg.crawl.Fetcher('fetcher:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Fetch(request: FetchRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<FetchReply>;
};

/** Fetch the host's next URL and record what became of it; null when the host has nothing to hand out. */
export async function fetchOne(jobId: string, host: string, ratePerMinute: number): Promise<Outcome | null> {
  // The URL leaves the queue, through the host's bucket, before anything is fetched.
  const url = await take(jobId, host, ratePerMinute);
  if (url === null) return null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let reply: FetchReply;
    try {
      reply = await fetcher.Fetch({job_id: jobId, url}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      // An outage or a timeout says nothing about the URL: it earns a bounded retry. Anything else fails it.
      const {code} = e as grpc.ServiceError;
      if (RETRYABLE.includes(code) && attempt < MAX_ATTEMPTS) continue;
      await markFailed(jobId, url, grpc.status[code]);
      return {url, outcome: 'failed'};
    }
    if (reply.status === 429) {
      // The host asked for room: the whole host waits, and the URL goes back without an outcome.
      await throttle(jobId, host, reply.retry_after_s);
      await requeue(jobId, host, url);
      return {url, outcome: 'throttled'};
    }
    if (reply.status === 403) {
      await markRefused(jobId, url, 'forbidden');
      return {url, outcome: 'refused'};
    }
    if (reply.status === 404) {
      await markGone(jobId, url);
      return {url, outcome: 'gone'};
    }
    if (reply.status !== 200) {
      await markFailed(jobId, url, \`status \${reply.status}\`);
      return {url, outcome: 'failed'};
    }
    await markFetched(jobId, url, reply.content_hash, reply.body_ref);
    return {url, outcome: 'fetched', content_hash: reply.content_hash, body_ref: reply.body_ref};
  }
  return null;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"crawl/frontier" // frontier.Take, Throttle, Requeue, QueueKey
	"crawl/records"  // records.MarkFetched, MarkRefused, MarkGone, MarkFailed
	pb "crawl/gen/fetcher"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var (
	fetcherConn, _ = grpc.NewClient("fetcher:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	fetcher        = pb.NewFetcherClient(fetcherConn)
)

// Outcome is what became of one URL: fetched, refused, gone, failed or throttled.
type Outcome struct {
	URL         string
	Outcome     string
	ContentHash string
	BodyRef     string
}

// fetchOne fetches the host's next URL and records what became of it; nil when the host has nothing to hand out.
func fetchOne(ctx context.Context, jobID, host string, ratePerMinute int) (*Outcome, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	queue := frontier.QueueKey(jobID, host)
	url, err := rdb.LIndex(ctx, queue, 0).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 10; attempt++ {
		reply, err := fetcher.Fetch(ctx, &pb.FetchRequest{JobId: jobID, Url: url})
		if err != nil {
			continue
		}
		if reply.GetStatus() == 200 {
			rdb.LRem(ctx, queue, 1, url)
			records.MarkFetched(ctx, jobID, url, reply.GetContentHash(), reply.GetBodyRef())
			return &Outcome{URL: url, Outcome: "fetched", ContentHash: reply.GetContentHash(), BodyRef: reply.GetBodyRef()}, nil
		}
	}
	rdb.LRem(ctx, queue, 1, url)
	records.MarkFailed(ctx, jobID, url, "gave up after 10 attempts")
	return &Outcome{URL: url, Outcome: "failed"}, nil
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

	"crawl/frontier" // frontier.Take, Throttle, Requeue, QueueKey
	"crawl/records"  // records.MarkFetched, MarkRefused, MarkGone, MarkFailed
	pb "crawl/gen/fetcher"
)

const (
	deadline    = 5 * time.Second
	maxAttempts = 3
)

var (
	fetcherConn, _ = grpc.NewClient("fetcher:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	fetcher        = pb.NewFetcherClient(fetcherConn)
)

// Outcome is what became of one URL: fetched, refused, gone, failed or throttled.
type Outcome struct {
	URL         string
	Outcome     string
	ContentHash string
	BodyRef     string
}

// fetchOne fetches the host's next URL and records what became of it; nil when the host has nothing to hand out.
func fetchOne(ctx context.Context, jobID, host string, ratePerMinute int) (*Outcome, error) {
	// The URL leaves the queue, through the host's bucket, before anything is fetched.
	url, err := frontier.Take(ctx, jobID, host, ratePerMinute)
	if err != nil || url == "" {
		return nil, err
	}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := fetcher.Fetch(callCtx, &pb.FetchRequest{JobId: jobID, Url: url})
		cancel()
		if err != nil {
			// An outage or a timeout says nothing about the URL: it earns a bounded retry. Anything else fails it.
			code := status.Code(err)
			if (code == codes.Unavailable || code == codes.DeadlineExceeded) && attempt < maxAttempts {
				continue
			}
			records.MarkFailed(ctx, jobID, url, code.String())
			return &Outcome{URL: url, Outcome: "failed"}, nil
		}
		got := reply.GetStatus()
		if got == 429 {
			// The host asked for room: the whole host waits, and the URL goes back without an outcome.
			if err := frontier.Throttle(ctx, jobID, host, int(reply.GetRetryAfterS())); err != nil {
				return nil, err
			}
			return &Outcome{URL: url, Outcome: "throttled"}, frontier.Requeue(ctx, jobID, host, url)
		}
		if got == 403 {
			records.MarkRefused(ctx, jobID, url, "forbidden")
			return &Outcome{URL: url, Outcome: "refused"}, nil
		}
		if got == 404 {
			records.MarkGone(ctx, jobID, url)
			return &Outcome{URL: url, Outcome: "gone"}, nil
		}
		if got != 200 {
			records.MarkFailed(ctx, jobID, url, fmt.Sprintf("status %d", got))
			return &Outcome{URL: url, Outcome: "failed"}, nil
		}
		records.MarkFetched(ctx, jobID, url, reply.GetContentHash(), reply.GetBodyRef())
		return &Outcome{URL: url, Outcome: "fetched", ContentHash: reply.GetContentHash(), BodyRef: reply.GetBodyRef()}, nil
	}
	return nil, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

import crawl.{Frontier, Records} // Frontier.take, throttle, requeue, queueKey; Records.markFetched, markRefused, markGone, markFailed
import crawl.fetcher.{FetchReply, FetchRequest, FetcherGrpc}

/** What became of one URL: fetched, refused, gone, failed or throttled. */
final case class Outcome(url: String, outcome: String, contentHash: String = "", bodyRef: String = "")

object Client {
  val jedis = new JedisPooled("redis", 6379)
  private val fetcher = FetcherGrpc.blockingStub(ManagedChannelBuilder.forAddress("fetcher", 9000).usePlaintext().build())

  /** Fetch the host's next URL and record what became of it; None when the host has nothing to hand out. */
  def fetchOne(jobId: String, host: String, ratePerMinute: Int): Option[Outcome] = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val queue = Frontier.queueKey(jobId, host)
    Option(jedis.lindex(queue, 0)).map { url =>
      val fetched = (1 to 10).iterator.flatMap { _ =>
        try Some(fetcher.fetch(FetchRequest(jobId = jobId, url = url))).filter(_.status == 200)
        catch { case _: StatusRuntimeException => None }
      }.nextOption()
      jedis.lrem(queue, 1, url)
      fetched match {
        case Some(reply: FetchReply) =>
          Records.markFetched(jobId, url, reply.contentHash, reply.bodyRef)
          Outcome(url, "fetched", reply.contentHash, reply.bodyRef)
        case None =>
          Records.markFailed(jobId, url, "gave up after 10 attempts")
          Outcome(url, "failed")
      }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import crawl.{Frontier, Records} // Frontier.take, throttle, requeue, queueKey; Records.markFetched, markRefused, markGone, markFailed
import crawl.fetcher.{FetchReply, FetchRequest, FetcherGrpc}

/** What became of one URL: fetched, refused, gone, failed or throttled. */
final case class Outcome(url: String, outcome: String, contentHash: String = "", bodyRef: String = "")

object Client {
  val DeadlineSeconds = 5L
  val MaxAttempts = 3
  private val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val fetcher = FetcherGrpc.blockingStub(ManagedChannelBuilder.forAddress("fetcher", 9000).usePlaintext().build())

  /** One call: the reply, or the status code it failed with. */
  private def call(jobId: String, url: String): Either[Status.Code, FetchReply] =
    try Right(fetcher.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).fetch(FetchRequest(jobId = jobId, url = url)))
    catch { case e: StatusRuntimeException => Left(e.getStatus.getCode) }

  /** Fetch the host's next URL and record what became of it; None when the host has nothing to hand out. */
  def fetchOne(jobId: String, host: String, ratePerMinute: Int): Option[Outcome] =
    // The URL leaves the queue, through the host's bucket, before anything is fetched.
    Frontier.take(jobId, host, ratePerMinute).map { url =>
      // An outage or a timeout says nothing about the URL: it earns a bounded retry. Anything else fails it.
      var result = call(jobId, url)
      var attempt = 1
      while (result.left.exists(Retryable.contains) && attempt < MaxAttempts) {
        result = call(jobId, url)
        attempt += 1
      }
      result match {
        case Left(code) =>
          Records.markFailed(jobId, url, code.toString)
          Outcome(url, "failed")
        case Right(reply) if reply.status == 429 =>
          // The host asked for room: the whole host waits, and the URL goes back without an outcome.
          Frontier.throttle(jobId, host, reply.retryAfterS)
          Frontier.requeue(jobId, host, url)
          Outcome(url, "throttled")
        case Right(reply) if reply.status == 403 =>
          Records.markRefused(jobId, url, "forbidden")
          Outcome(url, "refused")
        case Right(reply) if reply.status == 404 =>
          Records.markGone(jobId, url)
          Outcome(url, "gone")
        case Right(reply) if reply.status != 200 =>
          Records.markFailed(jobId, url, s"status \${reply.status}")
          Outcome(url, "failed")
        case Right(reply) =>
          Records.markFetched(jobId, url, reply.contentHash, reply.bodyRef)
          Outcome(url, "fetched", reply.contentHash, reply.bodyRef)
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

#include "crawl/frontier.h"  // frontier::take, throttle, requeue, queueKey
#include "crawl/records.h"   // records::markFetched, markRefused, markGone, markFailed
#include "fetcher.grpc.pb.h"

// What became of one URL: fetched, refused, gone, failed or throttled.
struct Outcome {
  std::string url;
  std::string outcome;
  std::string content_hash;
  std::string body_ref;
};

sw::redis::Redis redis("tcp://redis:6379");
auto fetcher = crawl::Fetcher::NewStub(grpc::CreateChannel("fetcher:9000", grpc::InsecureChannelCredentials()));

// Fetch the host's next URL and record what became of it; none when the host has nothing to hand out.
std::optional<Outcome> fetchOne(const std::string& job_id, const std::string& host, long rate_per_minute) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string queue = frontier::queueKey(job_id, host);
  const auto url = redis.lindex(queue, 0);
  if (!url) return std::nullopt;
  crawl::FetchRequest request;
  request.set_job_id(job_id);
  request.set_url(*url);
  for (int attempt = 0; attempt < 10; attempt++) {
    grpc::ClientContext ctx;
    crawl::FetchReply reply;
    const grpc::Status status = fetcher->Fetch(&ctx, request, &reply);
    if (!status.ok()) continue;
    if (reply.status() == 200) {
      redis.lrem(queue, 1, *url);
      records::markFetched(job_id, *url, reply.content_hash(), reply.body_ref());
      return Outcome{*url, "fetched", reply.content_hash(), reply.body_ref()};
    }
  }
  redis.lrem(queue, 1, *url);
  records::markFailed(job_id, *url, "gave up after 10 attempts");
  return Outcome{*url, "failed", "", ""};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <string>

#include "crawl/frontier.h"  // frontier::take, throttle, requeue, queueKey
#include "crawl/records.h"   // records::markFetched, markRefused, markGone, markFailed
#include "fetcher.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{5};
constexpr int kMaxAttempts = 3;

// What became of one URL: fetched, refused, gone, failed or throttled.
struct Outcome {
  std::string url;
  std::string outcome;
  std::string content_hash;
  std::string body_ref;
};

auto fetcher = crawl::Fetcher::NewStub(grpc::CreateChannel("fetcher:9000", grpc::InsecureChannelCredentials()));

// Fetch the host's next URL and record what became of it; none when the host has nothing to hand out.
std::optional<Outcome> fetchOne(const std::string& job_id, const std::string& host, long rate_per_minute) {
  // The URL leaves the queue, through the host's bucket, before anything is fetched.
  const auto url = frontier::take(job_id, host, rate_per_minute);
  if (!url) return std::nullopt;
  crawl::FetchRequest request;
  request.set_job_id(job_id);
  request.set_url(*url);
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    crawl::FetchReply reply;
    const grpc::Status status = fetcher->Fetch(&ctx, request, &reply);
    if (!status.ok()) {
      // An outage or a timeout says nothing about the URL: it earns a bounded retry. Anything else fails it.
      const grpc::StatusCode code = status.error_code();
      const bool retryable = code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
      if (retryable && attempt < kMaxAttempts) continue;
      records::markFailed(job_id, *url, "status code " + std::to_string(static_cast<int>(code)));
      return Outcome{*url, "failed", "", ""};
    }
    if (reply.status() == 429) {
      // The host asked for room: the whole host waits, and the URL goes back without an outcome.
      frontier::throttle(job_id, host, reply.retry_after_s());
      frontier::requeue(job_id, host, *url);
      return Outcome{*url, "throttled", "", ""};
    }
    if (reply.status() == 403) {
      records::markRefused(job_id, *url, "forbidden");
      return Outcome{*url, "refused", "", ""};
    }
    if (reply.status() == 404) {
      records::markGone(job_id, *url);
      return Outcome{*url, "gone", "", ""};
    }
    if (reply.status() != 200) {
      records::markFailed(job_id, *url, "status " + std::to_string(reply.status()));
      return Outcome{*url, "failed", "", ""};
    }
    records::markFetched(job_id, *url, reply.content_hash(), reply.body_ref());
    return Outcome{*url, "fetched", reply.content_hash(), reply.body_ref()};
  }
  return std::nullopt;
}
`,
    },
  },
  harness: {
    python: `import grpc

import fetcher_pb2
import fetcher_pb2_grpc
from crawl import frontier, records

JOB = "nightly"
HOST = "blog.example.com"


def _url(path):
    return f"https://{HOST}{path}"


class Fetcher(fetcher_pb2_grpc.FetcherServicer):
    """The web host behind the fetcher: /forbidden is 403, /gone 404, /busy 429 (Retry-After 30), anything else 200."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.queued_during = []

    def Fetch(self, request, context):
        self.queued_during.append((request.url, self.ctx.redis.lrange(f"frontier:{JOB}:{HOST}", 0, -1)))
        path = request.url[len(_url("")):]
        if path.startswith("/forbidden"):
            return fetcher_pb2.FetchReply(status=403)
        if path.startswith("/gone"):
            return fetcher_pb2.FetchReply(status=404)
        if path.startswith("/busy"):
            return fetcher_pb2.FetchReply(status=429, retry_after_s=30)
        return fetcher_pb2.FetchReply(status=200, content_hash=f"sha256:{path}", body_ref=f"pages{path}")


def _client(ctx, *paths):
    peer = Fetcher(ctx)
    ctx.grpc.serve(fetcher_pb2_grpc.add_FetcherServicer_to_server, peer)
    for path in paths:
        frontier.enqueue(JOB, HOST, _url(path))
    return ctx.load("client"), peer


def _status(path):
    page = records.page_of(JOB, _url(path))
    return None if page is None else page.get("status")


def check_deadline(ctx):
    m, _ = _client(ctx, "/posts/1", "/posts/2")
    out = m.fetch_one(JOB, HOST, 60)
    assert out is not None and out.get("outcome") == "fetched", f"a healthy fetch answered {out}, expected outcome fetched"
    for call in ctx.grpc.calls_to("Fetch"):
        assert call.timeout is not None, "a Fetch call carries no deadline: a host that never answers holds the worker forever"
        assert 4.5 <= call.timeout <= 5.5, f"a Fetch call carries a {call.timeout} s deadline, expected DEADLINE_S = 5"
    ctx.grpc.set_latency("Fetch", 10.0)
    out = m.fetch_one(JOB, HOST, 60)
    assert out is not None and out.get("outcome") == "failed", f"a host slower than the deadline on every attempt answered {out}, expected outcome failed"
    assert _status("/posts/2") == "failed", f"the slow URL is recorded as {_status('/posts/2')!r}, expected failed"


def check_bounded_retry(ctx):
    m, _ = _client(ctx, "/posts/1", "/posts/2", "/posts/3")
    ctx.grpc.fail("Fetch", grpc.StatusCode.UNAVAILABLE, "host down", times=3)
    out = m.fetch_one(JOB, HOST, 60)
    calls = len(ctx.grpc.calls_to("Fetch"))
    assert calls == 3, f"the fetcher answered UNAVAILABLE three times and the URL was tried {calls} times: at most MAX_ATTEMPTS = 3, then the page fails"
    assert out is not None and out.get("outcome") == "failed" and _status("/posts/1") == "failed", f"after three UNAVAILABLE the worker answered {out} and recorded {_status('/posts/1')!r}, expected failed"
    ctx.clock.advance(1)
    ctx.grpc.fail("Fetch", grpc.StatusCode.INVALID_ARGUMENT, "bad url", times=1)
    out = m.fetch_one(JOB, HOST, 60)
    extra = len(ctx.grpc.calls_to("Fetch")) - calls
    assert extra == 1, f"INVALID_ARGUMENT was retried ({extra} calls): only UNAVAILABLE and DEADLINE_EXCEEDED are retried"
    assert out is not None and out.get("outcome") == "failed", f"an INVALID_ARGUMENT answered {out}, expected outcome failed"
    ctx.clock.advance(1)
    ctx.grpc.fail("Fetch", grpc.StatusCode.DEADLINE_EXCEEDED, "slow", times=1)
    out = m.fetch_one(JOB, HOST, 60)
    assert out is not None and out.get("outcome") == "fetched", f"one DEADLINE_EXCEEDED, then a 200: the worker answered {out}, expected a retry that fetched the page"


def check_terminal_status(ctx):
    m, _ = _client(ctx, "/forbidden/a", "/gone/b")
    out = m.fetch_one(JOB, HOST, 60)
    calls = len(ctx.grpc.calls_to("Fetch"))
    assert calls == 1, f"a 403 was fetched {calls} times: it is the site's answer about the URL, recorded after one call"
    assert out is not None and out.get("outcome") == "refused" and _status("/forbidden/a") == "refused", f"a 403 answered {out} and recorded {_status('/forbidden/a')!r}, expected refused"
    ctx.clock.advance(1)
    out = m.fetch_one(JOB, HOST, 60)
    calls = len(ctx.grpc.calls_to("Fetch"))
    assert calls == 2, f"a 404 was fetched {calls - 1} times: one call, then gone"
    assert out is not None and out.get("outcome") == "gone" and _status("/gone/b") == "gone", f"a 404 answered {out} and recorded {_status('/gone/b')!r}, expected gone"


def check_throttle_429(ctx):
    m, _ = _client(ctx, "/busy/a", "/posts/1")
    out = m.fetch_one(JOB, HOST, 60)
    calls = len(ctx.grpc.calls_to("Fetch"))
    assert calls == 1, f"a 429 was answered with {calls - 1} more request(s): the host asked for room"
    assert out is not None and out.get("outcome") == "throttled", f"a 429 answered {out}, expected outcome throttled"
    assert _status("/busy/a") is None, f"a 429 recorded the URL as {_status('/busy/a')!r}: it is not the URL's outcome, the URL goes back"
    queued = ctx.redis.lrange(f"frontier:{JOB}:{HOST}", 0, -1)
    assert queued == [_url("/posts/1"), _url("/busy/a")], f"the host's queue holds {queued}: the throttled URL must go back to its tail"
    again = m.fetch_one(JOB, HOST, 60)
    assert again is None and len(ctx.grpc.calls_to("Fetch")) == 1, f"right after a 429 with Retry-After 30 the worker fetched again ({again}): the whole host must wait"
    ctx.clock.advance(31)
    out = m.fetch_one(JOB, HOST, 60)
    assert out is not None and out.get("url") == _url("/posts/1") and out.get("outcome") == "fetched", f"after Retry-After the host's next URL must be fetched, got {out}"


def check_take_first(ctx):
    m, peer = _client(ctx, "/posts/1", "/posts/2", "/posts/3")
    first = m.fetch_one(JOB, HOST, 60)
    assert first is not None and first.get("outcome") == "fetched", f"a healthy fetch answered {first}"
    url, queued = peer.queued_during[0]
    assert url not in queued, f"while {url} was being fetched the host's queue still held it ({queued}): another worker would fetch it too. Take it off the queue before the call"
    m.fetch_one(JOB, HOST, 60)
    third = m.fetch_one(JOB, HOST, 60)
    calls = len(ctx.grpc.calls_to("Fetch"))
    assert third is None and calls == 2, f"a third fetch in the same instant answered {third} after {calls} calls: the host's bucket holds BURST = 2 tokens, the third URL must wait for frontier.take"
`,
    typescript: `const JOB = 'nightly';
const HOST = 'blog.example.com';
const url = (path: string): string => \`https://\${HOST}\${path}\`;

/** The web host behind the fetcher: /forbidden is 403, /gone 404, /busy 429 (Retry-After 30), anything else 200. */
function client(ctx, ...paths: string[]) {
  const pkg = ctx.proto('fetcher.proto');
  const queuedDuring: [string, string[]][] = [];
  ctx.grpc.serve(pkg.crawl.Fetcher.service, {
    Fetch(call, callback) {
      queuedDuring.push([call.request.url, ctx.redis.lrange(\`frontier:\${JOB}:\${HOST}\`, 0, -1)]);
      const path = call.request.url.slice(url('').length);
      if (path.startsWith('/forbidden')) return callback(null, {status: 403});
      if (path.startsWith('/gone')) return callback(null, {status: 404});
      if (path.startsWith('/busy')) return callback(null, {status: 429, retry_after_s: 30});
      callback(null, {status: 200, content_hash: \`sha256:\${path}\`, body_ref: \`pages\${path}\`});
    },
  });
  const m = ctx.load('client');
  return {m, queuedDuring, frontier: ctx.load('/support/crawl/frontier.ts'), records: ctx.load('/support/crawl/records.ts')};
}

async function setup(ctx, ...paths: string[]) {
  const world = client(ctx);
  for (const path of paths) await world.frontier.enqueue(JOB, HOST, url(path));
  const status = async (path: string) => (await world.records.pageOf(JOB, url(path)))?.status ?? null;
  return {...world, status};
}

export async function check_deadline(ctx) {
  const {m, status} = await setup(ctx, '/posts/1', '/posts/2');
  let out = await m.fetchOne(JOB, HOST, 60);
  assert(out !== null && out.outcome === 'fetched', \`a healthy fetch answered \${JSON.stringify(out)}, expected outcome fetched\`);
  for (const call of ctx.grpc.callsTo('Fetch')) {
    assert(call.timeout !== null, 'a Fetch call carries no deadline: a host that never answers holds the worker forever');
    assert(4.5 <= call.timeout && call.timeout <= 5.5, \`a Fetch call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 5000\`);
  }
  ctx.grpc.setLatency('Fetch', 10.0);
  out = await m.fetchOne(JOB, HOST, 60);
  assert(out !== null && out.outcome === 'failed', \`a host slower than the deadline on every attempt answered \${JSON.stringify(out)}, expected outcome failed\`);
  assert.equal(await status('/posts/2'), 'failed', 'the slow URL must be recorded as failed');
}

export async function check_bounded_retry(ctx) {
  const {m, status} = await setup(ctx, '/posts/1', '/posts/2', '/posts/3');
  ctx.grpc.fail('Fetch', ctx.grpc.status.UNAVAILABLE, 'host down', 3);
  let out = await m.fetchOne(JOB, HOST, 60);
  const calls = ctx.grpc.callsTo('Fetch').length;
  assert.equal(calls, 3, \`the fetcher answered UNAVAILABLE three times and the URL was tried \${calls} times: at most MAX_ATTEMPTS = 3, then the page fails\`);
  assert(out !== null && out.outcome === 'failed' && (await status('/posts/1')) === 'failed', \`after three UNAVAILABLE the worker answered \${JSON.stringify(out)}, expected failed\`);
  ctx.clock.advance(1);
  ctx.grpc.fail('Fetch', ctx.grpc.status.INVALID_ARGUMENT, 'bad url', 1);
  out = await m.fetchOne(JOB, HOST, 60);
  const extra = ctx.grpc.callsTo('Fetch').length - calls;
  assert.equal(extra, 1, \`INVALID_ARGUMENT was retried (\${extra} calls): only UNAVAILABLE and DEADLINE_EXCEEDED are retried\`);
  assert(out !== null && out.outcome === 'failed', \`an INVALID_ARGUMENT answered \${JSON.stringify(out)}, expected outcome failed\`);
  ctx.clock.advance(1);
  ctx.grpc.fail('Fetch', ctx.grpc.status.DEADLINE_EXCEEDED, 'slow', 1);
  out = await m.fetchOne(JOB, HOST, 60);
  assert(out !== null && out.outcome === 'fetched', \`one DEADLINE_EXCEEDED, then a 200: the worker answered \${JSON.stringify(out)}, expected a retry that fetched the page\`);
}

export async function check_terminal_status(ctx) {
  const {m, status} = await setup(ctx, '/forbidden/a', '/gone/b');
  let out = await m.fetchOne(JOB, HOST, 60);
  let calls = ctx.grpc.callsTo('Fetch').length;
  assert.equal(calls, 1, \`a 403 was fetched \${calls} times: it is the site's answer about the URL, recorded after one call\`);
  assert(out !== null && out.outcome === 'refused' && (await status('/forbidden/a')) === 'refused', \`a 403 answered \${JSON.stringify(out)}, expected refused\`);
  ctx.clock.advance(1);
  out = await m.fetchOne(JOB, HOST, 60);
  calls = ctx.grpc.callsTo('Fetch').length;
  assert.equal(calls, 2, \`a 404 was fetched \${calls - 1} times: one call, then gone\`);
  assert(out !== null && out.outcome === 'gone' && (await status('/gone/b')) === 'gone', \`a 404 answered \${JSON.stringify(out)}, expected gone\`);
}

export async function check_throttle_429(ctx) {
  const {m, status} = await setup(ctx, '/busy/a', '/posts/1');
  let out = await m.fetchOne(JOB, HOST, 60);
  const calls = ctx.grpc.callsTo('Fetch').length;
  assert.equal(calls, 1, \`a 429 was answered with \${calls - 1} more request(s): the host asked for room\`);
  assert(out !== null && out.outcome === 'throttled', \`a 429 answered \${JSON.stringify(out)}, expected outcome throttled\`);
  assert.equal(await status('/busy/a'), null, 'a 429 is not the URL\\'s outcome: nothing may be recorded, the URL goes back');
  const queued = ctx.redis.lrange(\`frontier:\${JOB}:\${HOST}\`, 0, -1);
  assert.deepStrictEqual(queued, [url('/posts/1'), url('/busy/a')], \`the host's queue holds \${JSON.stringify(queued)}: the throttled URL must go back to its tail\`);
  const again = await m.fetchOne(JOB, HOST, 60);
  assert(again === null && ctx.grpc.callsTo('Fetch').length === 1, \`right after a 429 with Retry-After 30 the worker fetched again (\${JSON.stringify(again)}): the whole host must wait\`);
  ctx.clock.advance(31);
  out = await m.fetchOne(JOB, HOST, 60);
  assert(out !== null && out.url === url('/posts/1') && out.outcome === 'fetched', \`after Retry-After the host's next URL must be fetched, got \${JSON.stringify(out)}\`);
}

export async function check_take_first(ctx) {
  const {m, queuedDuring} = await setup(ctx, '/posts/1', '/posts/2', '/posts/3');
  const first = await m.fetchOne(JOB, HOST, 60);
  assert(first !== null && first.outcome === 'fetched', \`a healthy fetch answered \${JSON.stringify(first)}\`);
  const [fetched, queued] = queuedDuring[0];
  assert(!queued.includes(fetched), \`while \${fetched} was being fetched the host's queue still held it (\${JSON.stringify(queued)}): another worker would fetch it too. Take it off the queue before the call\`);
  await m.fetchOne(JOB, HOST, 60);
  const third = await m.fetchOne(JOB, HOST, 60);
  const calls = ctx.grpc.callsTo('Fetch').length;
  assert(third === null && calls === 2, \`a third fetch in the same instant answered \${JSON.stringify(third)} after \${calls} calls: the host's bucket holds BURST = 2 tokens, the third URL must wait for take\`);
}
`,
    go: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"

	"crawl/frontier"
	"crawl/records"
	pb "crawl/gen/fetcher"

	"leetbuild/harness"
)

const (
	clientJob  = "nightly"
	clientHost = "blog.example.com"
)

var clientBg = context.Background()

func hostURL(path string) string { return "https://" + clientHost + path }

// fetcherPeer is the web host behind the fetcher: /forbidden is 403, /gone 404, /busy 429
// (Retry-After 30), anything else 200. It notes what the host's queue held during each call.
type fetcherPeer struct {
	pb.UnimplementedFetcherServer
	ctx          *harness.Ctx
	fetchedURLs  []string
	queuedDuring [][]string
}

func (f *fetcherPeer) Fetch(_ context.Context, req *pb.FetchRequest) (*pb.FetchReply, error) {
	f.fetchedURLs = append(f.fetchedURLs, req.GetUrl())
	f.queuedDuring = append(f.queuedDuring, f.ctx.Redis.LRange("frontier:"+clientJob+":"+clientHost, 0, -1))
	path := strings.TrimPrefix(req.GetUrl(), hostURL(""))
	if strings.HasPrefix(path, "/forbidden") {
		return &pb.FetchReply{Status: 403}, nil
	}
	if strings.HasPrefix(path, "/gone") {
		return &pb.FetchReply{Status: 404}, nil
	}
	if strings.HasPrefix(path, "/busy") {
		return &pb.FetchReply{Status: 429, RetryAfterS: 30}, nil
	}
	return &pb.FetchReply{Status: 200, ContentHash: "sha256:" + path, BodyRef: "pages" + path}, nil
}

func clientWorld(ctx *harness.Ctx, paths ...string) *fetcherPeer {
	peer := &fetcherPeer{ctx: ctx}
	pb.RegisterFetcherServer(ctx.GRPC.Server(""), peer)
	for _, path := range paths {
		ctx.NoError(frontier.Enqueue(clientBg, clientJob, clientHost, hostURL(path)), "enqueue %s", path)
	}
	return peer
}

func fetchNext(ctx *harness.Ctx) *Outcome {
	out, err := fetchOne(clientBg, clientJob, clientHost, 60)
	ctx.NoError(err, "fetchOne failed")
	return out
}

func outcomeOf(out *Outcome) string {
	if out == nil {
		return "nil"
	}
	return out.Outcome
}

func recorded(path string) string {
	page := records.PageOf(clientBg, clientJob, hostURL(path))
	if page == nil {
		return ""
	}
	return page["status"]
}

func fetchCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("Fetch", "")) }

func CheckDeadline(ctx *harness.Ctx) {
	clientWorld(ctx, "/posts/1", "/posts/2")
	ctx.Equal(outcomeOf(fetchNext(ctx)), "fetched", "a healthy fetch; the outcome")
	for _, call := range ctx.GRPC.CallsTo("Fetch", "") {
		ctx.Assert(call.HasDeadline(), "a Fetch call carries no deadline: a host that never answers holds the worker forever")
		ctx.Assert(4500*time.Millisecond <= call.Timeout && call.Timeout <= 5500*time.Millisecond, "a Fetch call carries a %v deadline, expected 5 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Fetch", 10.0, "")
	ctx.Equal(outcomeOf(fetchNext(ctx)), "failed", "a host slower than the deadline on every attempt; the outcome")
	ctx.Equal(recorded("/posts/2"), "failed", "the slow URL's record")
}

func CheckBoundedRetry(ctx *harness.Ctx) {
	clientWorld(ctx, "/posts/1", "/posts/2", "/posts/3")
	ctx.GRPC.Fail("Fetch", codes.Unavailable, "host down", 3, "")
	out := fetchNext(ctx)
	calls := fetchCalls(ctx)
	ctx.Equal(calls, 3, "the fetcher answered UNAVAILABLE three times: at most maxAttempts = 3, then the page fails; the calls for one URL")
	ctx.Assert(outcomeOf(out) == "failed" && recorded("/posts/1") == "failed", "after three UNAVAILABLE the worker answered %s and recorded %q, expected failed", outcomeOf(out), recorded("/posts/1"))
	ctx.Clock.Advance(1)
	ctx.GRPC.Fail("Fetch", codes.InvalidArgument, "bad url", 1, "")
	out = fetchNext(ctx)
	ctx.Equal(fetchCalls(ctx)-calls, 1, "only UNAVAILABLE and DEADLINE_EXCEEDED are retried; the calls for an INVALID_ARGUMENT")
	ctx.Equal(outcomeOf(out), "failed", "an INVALID_ARGUMENT; the outcome")
	ctx.Clock.Advance(1)
	ctx.GRPC.Fail("Fetch", codes.DeadlineExceeded, "slow", 1, "")
	ctx.Equal(outcomeOf(fetchNext(ctx)), "fetched", "one DEADLINE_EXCEEDED, then a 200: a retry must fetch the page; the outcome")
}

func CheckTerminalStatus(ctx *harness.Ctx) {
	clientWorld(ctx, "/forbidden/a", "/gone/b")
	out := fetchNext(ctx)
	ctx.Equal(fetchCalls(ctx), 1, "a 403 is the site's answer about the URL, recorded after one call; the calls")
	ctx.Assert(outcomeOf(out) == "refused" && recorded("/forbidden/a") == "refused", "a 403 answered %s and recorded %q, expected refused", outcomeOf(out), recorded("/forbidden/a"))
	ctx.Clock.Advance(1)
	out = fetchNext(ctx)
	ctx.Equal(fetchCalls(ctx), 2, "a 404 is one call, then gone; the calls")
	ctx.Assert(outcomeOf(out) == "gone" && recorded("/gone/b") == "gone", "a 404 answered %s and recorded %q, expected gone", outcomeOf(out), recorded("/gone/b"))
}

func CheckThrottle429(ctx *harness.Ctx) {
	clientWorld(ctx, "/busy/a", "/posts/1")
	out := fetchNext(ctx)
	ctx.Equal(fetchCalls(ctx), 1, "a 429 means the host asked for room: no more requests; the calls")
	ctx.Equal(outcomeOf(out), "throttled", "a 429; the outcome")
	ctx.Equal(recorded("/busy/a"), "", "a 429 is not the URL's outcome: nothing may be recorded, the URL goes back; the record")
	ctx.Equal(ctx.Redis.LRange("frontier:"+clientJob+":"+clientHost, 0, -1), []string{hostURL("/posts/1"), hostURL("/busy/a")}, "the throttled URL must go back to the tail of the host's queue")
	again := fetchNext(ctx)
	ctx.Assert(again == nil && fetchCalls(ctx) == 1, "right after a 429 with Retry-After 30 the worker fetched again (%s): the whole host must wait", outcomeOf(again))
	ctx.Clock.Advance(31)
	out = fetchNext(ctx)
	ctx.Assert(out != nil && out.URL == hostURL("/posts/1") && out.Outcome == "fetched", "after Retry-After the host's next URL must be fetched, got %+v", out)
}

func CheckTakeFirst(ctx *harness.Ctx) {
	peer := clientWorld(ctx, "/posts/1", "/posts/2", "/posts/3")
	ctx.Equal(outcomeOf(fetchNext(ctx)), "fetched", "a healthy fetch; the outcome")
	for _, queued := range peer.queuedDuring[0] {
		ctx.Assert(queued != peer.fetchedURLs[0], "while %s was being fetched the host's queue still held it (%q): another worker would fetch it too. Take it off the queue before the call", peer.fetchedURLs[0], peer.queuedDuring[0])
	}
	fetchNext(ctx)
	third := fetchNext(ctx)
	ctx.Assert(third == nil && fetchCalls(ctx) == 2, "a third fetch in the same instant answered %s after %d calls: the host's bucket holds Burst = 2 tokens, the third URL must wait for frontier.Take", outcomeOf(third), fetchCalls(ctx))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace {

const std::string kJob = "nightly";
const std::string kHost = "blog.example.com";

std::string hostUrl(const std::string& path) { return "https://" + kHost + path; }

// The web host behind the fetcher: /forbidden is 403, /gone 404, /busy 429 (Retry-After 30),
// anything else 200. It notes what the host's queue held during each call.
class FetcherPeer final : public crawl::Fetcher::Service {
 public:
  explicit FetcherPeer(harness::Ctx& ctx) : ctx_(ctx) {}
  std::vector<std::pair<std::string, std::vector<std::string>>> queued_during;

  grpc::Status Fetch(grpc::ServerContext*, const crawl::FetchRequest* req, crawl::FetchReply* out) override {
    queued_during.emplace_back(req->url(), ctx_.Redis.LRange("frontier:" + kJob + ":" + kHost, 0, -1));
    const std::string path = req->url().substr(hostUrl("").size());
    if (path.rfind("/forbidden", 0) == 0) {
      out->set_status(403);
    } else if (path.rfind("/gone", 0) == 0) {
      out->set_status(404);
    } else if (path.rfind("/busy", 0) == 0) {
      out->set_status(429);
      out->set_retry_after_s(30);
    } else {
      out->set_status(200);
      out->set_content_hash("sha256:" + path);
      out->set_body_ref("pages" + path);
    }
    return grpc::Status::OK;
  }

 private:
  harness::Ctx& ctx_;
};

FetcherPeer& world(harness::Ctx& ctx, const std::vector<std::string>& paths) {
  static FetcherPeer* peer = nullptr;
  delete peer;
  peer = new FetcherPeer(ctx);
  ctx.GRPC.Server("")->RegisterService(peer);
  for (const std::string& path : paths) frontier::enqueue(kJob, kHost, hostUrl(path));
  return *peer;
}

std::optional<Outcome> fetchNext(harness::Ctx& ctx) {
  try {
    return fetchOne(kJob, kHost, 60);
  } catch (const std::exception& e) {
    ctx.Fatalf("fetchOne threw %s: %s", harness::CurrentExceptionType(), e.what());
  }
}

std::string outcomeOf(const std::optional<Outcome>& out) { return out ? out->outcome : "none"; }

std::string recorded(const std::string& path) {
  const auto page = records::pageOf(kJob, hostUrl(path));
  return page && page->count("status") ? page->at("status") : "";
}

size_t fetchCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Fetch").size(); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  world(ctx, {"/posts/1", "/posts/2"});
  ctx.Equal(outcomeOf(fetchNext(ctx)), "fetched", "a healthy fetch; the outcome");
  for (const auto& call : ctx.GRPC.CallsTo("Fetch")) {
    ctx.Assert(call.HasDeadline(), "a Fetch call carries no deadline: a host that never answers holds the worker forever");
    ctx.Assert(4.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 5.5, "a Fetch call carries a %v s deadline, expected kDeadline = 5 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Fetch", 10.0);
  ctx.Equal(outcomeOf(fetchNext(ctx)), "failed", "a host slower than the deadline on every attempt; the outcome");
  ctx.Equal(recorded("/posts/2"), "failed", "the slow URL's record");
}

void CheckBoundedRetry(harness::Ctx& ctx) {
  world(ctx, {"/posts/1", "/posts/2", "/posts/3"});
  ctx.GRPC.Fail("Fetch", grpc::StatusCode::UNAVAILABLE, "host down", 3);
  auto out = fetchNext(ctx);
  const size_t calls = fetchCalls(ctx);
  ctx.Equal(calls, 3, "the fetcher answered UNAVAILABLE three times: at most kMaxAttempts = 3, then the page fails; the calls for one URL");
  ctx.Assert(outcomeOf(out) == "failed" && recorded("/posts/1") == "failed", "after three UNAVAILABLE the worker answered %s and recorded %q, expected failed", outcomeOf(out), recorded("/posts/1"));
  ctx.Clock.Advance(1);
  ctx.GRPC.Fail("Fetch", grpc::StatusCode::INVALID_ARGUMENT, "bad url", 1);
  out = fetchNext(ctx);
  ctx.Equal(fetchCalls(ctx) - calls, 1, "only UNAVAILABLE and DEADLINE_EXCEEDED are retried; the calls for an INVALID_ARGUMENT");
  ctx.Equal(outcomeOf(out), "failed", "an INVALID_ARGUMENT; the outcome");
  ctx.Clock.Advance(1);
  ctx.GRPC.Fail("Fetch", grpc::StatusCode::DEADLINE_EXCEEDED, "slow", 1);
  ctx.Equal(outcomeOf(fetchNext(ctx)), "fetched", "one DEADLINE_EXCEEDED, then a 200: a retry must fetch the page; the outcome");
}

void CheckTerminalStatus(harness::Ctx& ctx) {
  world(ctx, {"/forbidden/a", "/gone/b"});
  auto out = fetchNext(ctx);
  ctx.Equal(fetchCalls(ctx), 1, "a 403 is the site's answer about the URL, recorded after one call; the calls");
  ctx.Assert(outcomeOf(out) == "refused" && recorded("/forbidden/a") == "refused", "a 403 answered %s and recorded %q, expected refused", outcomeOf(out), recorded("/forbidden/a"));
  ctx.Clock.Advance(1);
  out = fetchNext(ctx);
  ctx.Equal(fetchCalls(ctx), 2, "a 404 is one call, then gone; the calls");
  ctx.Assert(outcomeOf(out) == "gone" && recorded("/gone/b") == "gone", "a 404 answered %s and recorded %q, expected gone", outcomeOf(out), recorded("/gone/b"));
}

void CheckThrottle429(harness::Ctx& ctx) {
  world(ctx, {"/busy/a", "/posts/1"});
  auto out = fetchNext(ctx);
  ctx.Equal(fetchCalls(ctx), 1, "a 429 means the host asked for room: no more requests; the calls");
  ctx.Equal(outcomeOf(out), "throttled", "a 429; the outcome");
  ctx.Equal(recorded("/busy/a"), "", "a 429 is not the URL's outcome: nothing may be recorded, the URL goes back; the record");
  ctx.Equal(ctx.Redis.LRange("frontier:" + kJob + ":" + kHost, 0, -1), {hostUrl("/posts/1"), hostUrl("/busy/a")}, "the throttled URL must go back to the tail of the host's queue");
  const auto again = fetchNext(ctx);
  ctx.Assert(!again && fetchCalls(ctx) == 1, "right after a 429 with Retry-After 30 the worker fetched again (%s): the whole host must wait", outcomeOf(again));
  ctx.Clock.Advance(31);
  out = fetchNext(ctx);
  ctx.Assert(out && out->url == hostUrl("/posts/1") && out->outcome == "fetched", "after Retry-After the host's next URL must be fetched, got %s", outcomeOf(out));
}

void CheckTakeFirst(harness::Ctx& ctx) {
  FetcherPeer& peer = world(ctx, {"/posts/1", "/posts/2", "/posts/3"});
  ctx.Equal(outcomeOf(fetchNext(ctx)), "fetched", "a healthy fetch; the outcome");
  const auto& [fetched, queued] = peer.queued_during.at(0);
  for (const std::string& u : queued) {
    ctx.Assert(u != fetched, "while %s was being fetched the host's queue still held it (%q): another worker would fetch it too. Take it off the queue before the call", fetched, queued);
  }
  fetchNext(ctx);
  const auto third = fetchNext(ctx);
  ctx.Assert(!third && fetchCalls(ctx) == 2, "a third fetch in the same instant answered %s after %d calls: the host's bucket holds kBurst = 2 tokens, the third URL must wait for frontier::take", outcomeOf(third), fetchCalls(ctx));
}
`,
  },
  hints: [
    'Point the worker at a host that answers 403 and the fetcher is called ten times for one URL; a 429 gets nine more requests. Make the host slow and the worker waits as long as the host does.',
    "The loop retries on every exception and every status that is not 200, with no deadline on the call and ten attempts. The URL is read with `LINDEX`, so it stays in the queue, and the host's bucket is never asked.",
    'Take the URL with `frontier.take`. Call with `timeout=DEADLINE_S`; retry only `UNAVAILABLE`/`DEADLINE_EXCEEDED` up to `MAX_ATTEMPTS`. 429: `frontier.throttle` and `frontier.requeue`. 403: `mark_refused`. 404: `mark_gone`. 200: `mark_fetched`.',
  ],
  debrief: `The status code is a message from the host, and the worker's job is to act on it at the right scope. A 403 is the site's decision about one URL, so it is recorded once and never retried; a 429 is about the whole host, so the host waits and the URL goes back without an outcome; \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` say nothing about the URL, so they earn a bounded retry. The deadline turns a stalled host into a failure the worker can count. Taking the URL through the bucket before the call makes pacing and ownership one operation. Production crawlers also back off with jitter between attempts, read \`Retry-After\` as seconds or an HTTP date, and lease taken URLs so a crashed worker's URL returns to the queue.`,
};
