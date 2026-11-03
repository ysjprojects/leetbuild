/**
 * Hand-written support modules the crawl-index steps import but no step builds: the `crawl`
 * package. `crawl.web` is the web as crawld sees it (robots rules and pages the harness seeds in
 * Redis, every fetch logged) plus the URL parser every step shares; `crawl.registry` the target
 * registry; `crawl.frontier` the per-host frontier of step 2 as later steps use it; `crawl.records`
 * the outcome of every URL and the job's counters; `crawl.search` the search index. The five
 * languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'crawl/__init__.py': '',
  'crawl/web.py': `"""
The web as crawld sees it (provided; the harness stands in for the hosts): fetch_robots(host)
answers the Disallow path prefixes of the host's robots.txt (the list web:robots:{host}) and
fetch_page(url) the page's body (web:page:{url}, "" when there is none). Every fetch is logged on
the list web:fetches, as a proxy log would show it. split_url is the URL parser every step shares.
"""
from urllib.parse import urlsplit

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def split_url(url: str) -> dict | None:
    """{scheme, host, path} of an absolute URL (scheme and host lower-cased, path "/" when empty); None without a scheme or a host."""
    try:
        parts = urlsplit(url.strip())
        host = parts.hostname
    except ValueError:
        return None
    if not parts.scheme or not host:
        return None
    return {"scheme": parts.scheme.lower(), "host": host.lower(), "path": parts.path or "/"}


def fetch_robots(host: str) -> list[str]:
    """GET https://{host}/robots.txt: the host's Disallow path prefixes."""
    r.rpush("web:fetches", f"https://{host}/robots.txt")
    return r.lrange(f"web:robots:{host}", 0, -1)


def fetch_page(url: str) -> str:
    """GET url: the page's body."""
    r.rpush("web:fetches", url)
    return r.get(f"web:page:{url}") or ""
`,
  'crawl/registry.py': `"""
The target registry (provided): targets:{job_id} maps every registered URL of a job to its target
id, target:{target_id} holds the target (target_id, job_id, url, host, tenant), and job:{job_id}
the job's tenant, set by the job's first target.
"""
import redis

from crawl.web import split_url

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def find(job_id: str, url: str) -> dict | None:
    """The target registered for (job_id, url), or None."""
    target_id = r.hget(f"targets:{job_id}", url)
    if target_id is None:
        return None
    return r.hgetall(f"target:{target_id}") or None


def insert(job_id: str, url: str, tenant: str) -> dict:
    """Register url under the job and return the target; every call registers a new target."""
    target_id = f"t-{r.incr('target:seq')}"
    target = {"target_id": target_id, "job_id": job_id, "url": url, "host": split_url(url)["host"], "tenant": tenant}
    r.hset(f"target:{target_id}", mapping=target)
    r.hset(f"targets:{job_id}", url, target_id)
    r.hsetnx(f"job:{job_id}", "tenant", tenant)
    return target


def job_of(job_id: str) -> dict | None:
    """{job_id, tenant} of a job with at least one target, or None."""
    tenant = r.hget(f"job:{job_id}", "tenant")
    return None if tenant is None else {"job_id": job_id, "tenant": tenant}
`,
  'crawl/frontier.py': `"""
The crawl frontier (provided; step 2 builds the same functions). frontier:{job_id}:{host} is the
host's queue of URLs; pending:{job_id} scores every URL still owed an outcome with the time it was
first enqueued; bucket:{job_id}:{host} is the host's token bucket (tokens, ts), refilled at the
host's rate up to BURST and spent by take in one Lua script that also pops the URL; and
throttle:{job_id}:{host} holds the time (ms) before which take hands out nothing for the host.
"""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BURST = 2
BUCKET_TTL_MS = 3_600_000

TAKE_LUA = """
local now = tonumber(ARGV[1])
if now < tonumber(redis.call('GET', KEYS[3]) or '0') then return false end
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or burst
local ts = tonumber(state[2]) or now
tokens = math.min(burst, tokens + (now - ts) * rate / 60000)
local url = false
if tokens >= 1 then
  url = redis.call('LPOP', KEYS[2])
  if url then tokens = tokens - 1 end
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return url
"""
take_script = r.register_script(TAKE_LUA)


def queue_key(job_id: str, host: str) -> str:
    return f"frontier:{job_id}:{host}"


def bucket_key(job_id: str, host: str) -> str:
    return f"bucket:{job_id}:{host}"


def throttle_key(job_id: str, host: str) -> str:
    return f"throttle:{job_id}:{host}"


def pending_key(job_id: str) -> str:
    return f"pending:{job_id}"


def enqueue(job_id: str, host: str, url: str) -> None:
    """Queue url on its host; it is pending from now until an outcome is recorded."""
    r.rpush(queue_key(job_id, host), url)
    r.zadd(pending_key(job_id), {url: time.time()}, nx=True)


def take(job_id: str, host: str, rate_per_minute: int) -> str | None:
    """The next URL of the host if the host is not throttled and its bucket holds a token, else None."""
    now_ms = int(time.time() * 1000)
    keys = [bucket_key(job_id, host), queue_key(job_id, host), throttle_key(job_id, host)]
    return take_script(keys=keys, args=[now_ms, rate_per_minute, BURST, BUCKET_TTL_MS])


def throttle(job_id: str, host: str, retry_after_s: int) -> None:
    """The host answered 429: take hands out nothing for it for retry_after_s seconds."""
    wait_ms = max(int(retry_after_s), 1) * 1000
    r.set(throttle_key(job_id, host), int(time.time() * 1000) + wait_ms, px=wait_ms)


def requeue(job_id: str, host: str, url: str) -> None:
    """Put a taken URL back at the tail of its host's queue."""
    r.rpush(queue_key(job_id, host), url)
`,
  'crawl/records.py': `"""
What became of every URL (provided): page:{job_id}:{url} holds its status (fetched, refused, gone,
failed, then indexed) with content_hash, body_ref or reason, and counts:{job_id} counts the
outcomes (indexed pages were fetched first, so fetched counts them too). An outcome takes the URL
off pending:{job_id}: it is no longer owed anything.
"""
import redis

from crawl.frontier import pending_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTCOMES = ("fetched", "refused", "gone", "failed", "indexed")


def page_key(job_id: str, url: str) -> str:
    return f"page:{job_id}:{url}"


def _settle(job_id: str, url: str, status: str, fields: dict) -> None:
    r.hset(page_key(job_id, url), mapping={"status": status, **fields})
    r.hincrby(f"counts:{job_id}", status, 1)
    r.zrem(pending_key(job_id), url)


def mark_fetched(job_id: str, url: str, content_hash: str, body_ref: str) -> None:
    _settle(job_id, url, "fetched", {"content_hash": content_hash, "body_ref": body_ref})


def mark_refused(job_id: str, url: str, reason: str) -> None:
    _settle(job_id, url, "refused", {"reason": reason})


def mark_gone(job_id: str, url: str) -> None:
    _settle(job_id, url, "gone", {})


def mark_failed(job_id: str, url: str, reason: str) -> None:
    _settle(job_id, url, "failed", {"reason": reason})


def mark_indexed(job_id: str, url: str) -> None:
    r.hset(page_key(job_id, url), "status", "indexed")
    r.hincrby(f"counts:{job_id}", "indexed", 1)


def page_of(job_id: str, url: str) -> dict | None:
    """The page's record (status and its fields), or None when it has no outcome yet."""
    return r.hgetall(page_key(job_id, url)) or None


def counts(job_id: str) -> dict:
    """{fetched, refused, gone, failed, indexed} of the job, 0 for an outcome it has none of."""
    raw = r.hgetall(f"counts:{job_id}")
    return {name: int(raw.get(name, 0)) for name in OUTCOMES}
`,
  'crawl/search.py': `"""
The search index (provided): index:{url} holds the indexed page (url, content_hash, words). put
refuses a page with an empty body, which has nothing to index, with a ValueError.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def put(url: str, content_hash: str, body: str) -> None:
    """Index the page; raises ValueError when the body is empty."""
    if not body.strip():
        raise ValueError(f"nothing to index for {url}")
    r.hset(f"index:{url}", mapping={"url": url, "content_hash": content_hash, "words": len(body.split())})


def get(url: str) -> dict | None:
    """The indexed page, or None."""
    return r.hgetall(f"index:{url}") or None
`,
};

export const supportModulesTs: Record<string, string> = {
  'crawl/web.ts': `/**
 * The web as crawld sees it (provided; the harness stands in for the hosts): fetchRobots(host)
 * answers the Disallow path prefixes of the host's robots.txt (the list web:robots:{host}) and
 * fetchPage(url) the page's body (web:page:{url}, '' when there is none). Every fetch is logged on
 * the list web:fetches, as a proxy log would show it. splitUrl is the URL parser every step shares.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Url {
  scheme: string;
  host: string;
  path: string;
}

/** {scheme, host, path} of an absolute URL (scheme and host lower-cased, path '/' when empty); null without a scheme or a host. */
export function splitUrl(url: string): Url | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.hostname === '') return null;
  return {scheme: parsed.protocol.replace(/:$/, '').toLowerCase(), host: parsed.hostname.toLowerCase(), path: parsed.pathname || '/'};
}

/** GET https://{host}/robots.txt: the host's Disallow path prefixes. */
export async function fetchRobots(host: string): Promise<string[]> {
  await redis.rpush('web:fetches', \`https://\${host}/robots.txt\`);
  return redis.lrange(\`web:robots:\${host}\`, 0, -1);
}

/** GET url: the page's body. */
export async function fetchPage(url: string): Promise<string> {
  await redis.rpush('web:fetches', url);
  return (await redis.get(\`web:page:\${url}\`)) ?? '';
}
`,
  'crawl/registry.ts': `/**
 * The target registry (provided): targets:{job_id} maps every registered URL of a job to its target
 * id, target:{target_id} holds the target (target_id, job_id, url, host, tenant), and job:{job_id}
 * the job's tenant, set by the job's first target.
 */
import Redis from 'ioredis';

import {splitUrl} from './web';

const redis = new Redis({host: 'redis', port: 6379});

export interface Target {
  target_id: string;
  job_id: string;
  url: string;
  host: string;
  tenant: string;
}

export interface Job {
  job_id: string;
  tenant: string;
}

/** The target registered for (jobId, url), or null. */
export async function find(jobId: string, url: string): Promise<Target | null> {
  const targetId = await redis.hget(\`targets:\${jobId}\`, url);
  if (targetId === null) return null;
  const target = await redis.hgetall(\`target:\${targetId}\`);
  return Object.keys(target).length === 0 ? null : (target as unknown as Target);
}

/** Register url under the job and return the target; every call registers a new target. */
export async function insert(jobId: string, url: string, tenant: string): Promise<Target> {
  const targetId = \`t-\${await redis.incr('target:seq')}\`;
  const target: Target = {target_id: targetId, job_id: jobId, url, host: splitUrl(url)?.host ?? '', tenant};
  await redis.hset(\`target:\${targetId}\`, {...target});
  await redis.hset(\`targets:\${jobId}\`, url, targetId);
  await redis.hsetnx(\`job:\${jobId}\`, 'tenant', tenant);
  return target;
}

/** {job_id, tenant} of a job with at least one target, or null. */
export async function jobOf(jobId: string): Promise<Job | null> {
  const tenant = await redis.hget(\`job:\${jobId}\`, 'tenant');
  return tenant === null ? null : {job_id: jobId, tenant};
}
`,
  'crawl/frontier.ts': `/**
 * The crawl frontier (provided; step 2 builds the same functions). frontier:{job_id}:{host} is the
 * host's queue of URLs; pending:{job_id} scores every URL still owed an outcome with the time it was
 * first enqueued; bucket:{job_id}:{host} is the host's token bucket (tokens, ts), refilled at the
 * host's rate up to BURST and spent by take in one Lua script that also pops the URL; and
 * throttle:{job_id}:{host} holds the time (ms) before which take hands out nothing for the host.
 */
import Redis from 'ioredis';

export const BURST = 2;
export const BUCKET_TTL_MS = 3_600_000;

export const TAKE_LUA = \`
local now = tonumber(ARGV[1])
if now < tonumber(redis.call('GET', KEYS[3]) or '0') then return false end
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or burst
local ts = tonumber(state[2]) or now
tokens = math.min(burst, tokens + (now - ts) * rate / 60000)
local url = false
if tokens >= 1 then
  url = redis.call('LPOP', KEYS[2])
  if url then tokens = tokens - 1 end
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return url
\`;

interface FrontierRedis extends Redis {
  takeUrl(bucket: string, queue: string, throttle: string, now: number, rate: number, burst: number, ttl: number): Promise<string | null>;
}

const redis = new Redis({host: 'redis', port: 6379}) as FrontierRedis;
redis.defineCommand('takeUrl', {numberOfKeys: 3, lua: TAKE_LUA});

export const queueKey = (jobId: string, host: string): string => \`frontier:\${jobId}:\${host}\`;
export const bucketKey = (jobId: string, host: string): string => \`bucket:\${jobId}:\${host}\`;
export const throttleKey = (jobId: string, host: string): string => \`throttle:\${jobId}:\${host}\`;
export const pendingKey = (jobId: string): string => \`pending:\${jobId}\`;

/** Queue url on its host; it is pending from now until an outcome is recorded. */
export async function enqueue(jobId: string, host: string, url: string): Promise<void> {
  await redis.rpush(queueKey(jobId, host), url);
  await redis.zadd(pendingKey(jobId), 'NX', Date.now() / 1000, url);
}

/** The next URL of the host if the host is not throttled and its bucket holds a token, else null. */
export async function take(jobId: string, host: string, ratePerMinute: number): Promise<string | null> {
  return redis.takeUrl(bucketKey(jobId, host), queueKey(jobId, host), throttleKey(jobId, host), Date.now(), ratePerMinute, BURST, BUCKET_TTL_MS);
}

/** The host answered 429: take hands out nothing for it for retryAfterS seconds. */
export async function throttle(jobId: string, host: string, retryAfterS: number): Promise<void> {
  const waitMs = Math.max(Math.floor(retryAfterS), 1) * 1000;
  await redis.set(throttleKey(jobId, host), String(Date.now() + waitMs), 'PX', waitMs);
}

/** Put a taken URL back at the tail of its host's queue. */
export async function requeue(jobId: string, host: string, url: string): Promise<void> {
  await redis.rpush(queueKey(jobId, host), url);
}
`,
  'crawl/records.ts': `/**
 * What became of every URL (provided): page:{job_id}:{url} holds its status (fetched, refused, gone,
 * failed, then indexed) with content_hash, body_ref or reason, and counts:{job_id} counts the
 * outcomes (indexed pages were fetched first, so fetched counts them too). An outcome takes the URL
 * off pending:{job_id}: it is no longer owed anything.
 */
import Redis from 'ioredis';

import {pendingKey} from './frontier';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTCOMES = ['fetched', 'refused', 'gone', 'failed', 'indexed'] as const;
export type Counts = Record<(typeof OUTCOMES)[number], number>;

export const pageKey = (jobId: string, url: string): string => \`page:\${jobId}:\${url}\`;

async function settle(jobId: string, url: string, status: string, fields: Record<string, string>): Promise<void> {
  await redis.hset(pageKey(jobId, url), {status, ...fields});
  await redis.hincrby(\`counts:\${jobId}\`, status, 1);
  await redis.zrem(pendingKey(jobId), url);
}

export const markFetched = (jobId: string, url: string, contentHash: string, bodyRef: string): Promise<void> =>
  settle(jobId, url, 'fetched', {content_hash: contentHash, body_ref: bodyRef});
export const markRefused = (jobId: string, url: string, reason: string): Promise<void> => settle(jobId, url, 'refused', {reason});
export const markGone = (jobId: string, url: string): Promise<void> => settle(jobId, url, 'gone', {});
export const markFailed = (jobId: string, url: string, reason: string): Promise<void> => settle(jobId, url, 'failed', {reason});

export async function markIndexed(jobId: string, url: string): Promise<void> {
  await redis.hset(pageKey(jobId, url), 'status', 'indexed');
  await redis.hincrby(\`counts:\${jobId}\`, 'indexed', 1);
}

/** The page's record (status and its fields), or null when it has no outcome yet. */
export async function pageOf(jobId: string, url: string): Promise<Record<string, string> | null> {
  const page = await redis.hgetall(pageKey(jobId, url));
  return Object.keys(page).length === 0 ? null : page;
}

/** {fetched, refused, gone, failed, indexed} of the job, 0 for an outcome it has none of. */
export async function counts(jobId: string): Promise<Counts> {
  const raw = await redis.hgetall(\`counts:\${jobId}\`);
  return Object.fromEntries(OUTCOMES.map(name => [name, Number(raw[name] ?? 0)])) as Counts;
}
`,
  'crawl/search.ts': `/**
 * The search index (provided): index:{url} holds the indexed page (url, content_hash, words). put
 * refuses a page with an empty body, which has nothing to index, by throwing.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Index the page; throws when the body is empty. */
export async function put(url: string, contentHash: string, body: string): Promise<void> {
  if (body.trim() === '') throw new Error(\`nothing to index for \${url}\`);
  await redis.hset(\`index:\${url}\`, {url, content_hash: contentHash, words: String(body.trim().split(/\\s+/).length)});
}

/** The indexed page, or null. */
export async function get(url: string): Promise<Record<string, string> | null> {
  const page = await redis.hgetall(\`index:\${url}\`);
  return Object.keys(page).length === 0 ? null : page;
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'crawl/web/web.go': `// Package web is the web as crawld sees it (provided; the harness stands in for the hosts):
// FetchRobots(host) answers the Disallow path prefixes of the host's robots.txt (the list
// web:robots:{host}) and FetchPage(url) the page's body (web:page:{url}, "" when there is none).
// Every fetch is logged on the list web:fetches, as a proxy log would show it. SplitURL is the URL
// parser every step shares.
package web

import (
	"context"
	"net/url"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// URL is an absolute URL's scheme and host (lower-cased) and path ("/" when empty).
type URL struct {
	Scheme string
	Host   string
	Path   string
}

// SplitURL parses an absolute URL; nil without a scheme or a host.
func SplitURL(raw string) *URL {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Hostname() == "" {
		return nil
	}
	path := u.Path
	if path == "" {
		path = "/"
	}
	return &URL{Scheme: strings.ToLower(u.Scheme), Host: strings.ToLower(u.Hostname()), Path: path}
}

// FetchRobots is GET https://{host}/robots.txt: the host's Disallow path prefixes.
func FetchRobots(ctx context.Context, host string) []string {
	rdb.RPush(ctx, "web:fetches", "https://"+host+"/robots.txt")
	return rdb.LRange(ctx, "web:robots:"+host, 0, -1).Val()
}

// FetchPage is GET url: the page's body.
func FetchPage(ctx context.Context, url string) string {
	rdb.RPush(ctx, "web:fetches", url)
	return rdb.Get(ctx, "web:page:"+url).Val()
}
`,
  'crawl/registry/registry.go': `// Package registry is the target registry (provided): targets:{job_id} maps every registered URL of
// a job to its target id, target:{target_id} holds the target (target_id, job_id, url, host,
// tenant), and job:{job_id} the job's tenant, set by the job's first target.
package registry

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"

	"crawl/web"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Target is one registered URL of a job.
type Target struct {
	TargetID string \`json:"target_id"\`
	JobID    string \`json:"job_id"\`
	URL      string \`json:"url"\`
	Host     string \`json:"host"\`
	Tenant   string \`json:"tenant"\`
}

// Job is a job and the tenant it belongs to.
type Job struct {
	JobID  string \`json:"job_id"\`
	Tenant string \`json:"tenant"\`
}

// Find is the target registered for (jobID, url), or nil.
func Find(ctx context.Context, jobID, url string) *Target {
	targetID, err := rdb.HGet(ctx, "targets:"+jobID, url).Result()
	if err != nil {
		return nil
	}
	raw := rdb.HGetAll(ctx, "target:"+targetID).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Target{TargetID: raw["target_id"], JobID: raw["job_id"], URL: raw["url"], Host: raw["host"], Tenant: raw["tenant"]}
}

// Insert registers url under the job and returns the target; every call registers a new target.
func Insert(ctx context.Context, jobID, url, tenant string) *Target {
	target := &Target{TargetID: fmt.Sprintf("t-%d", rdb.Incr(ctx, "target:seq").Val()), JobID: jobID, URL: url, Tenant: tenant}
	if u := web.SplitURL(url); u != nil {
		target.Host = u.Host
	}
	rdb.HSet(ctx, "target:"+target.TargetID, map[string]any{"target_id": target.TargetID, "job_id": jobID, "url": url, "host": target.Host, "tenant": tenant})
	rdb.HSet(ctx, "targets:"+jobID, url, target.TargetID)
	rdb.HSetNX(ctx, "job:"+jobID, "tenant", tenant)
	return target
}

// JobOf is the job with its tenant, or nil when the job has no target.
func JobOf(ctx context.Context, jobID string) *Job {
	tenant, err := rdb.HGet(ctx, "job:"+jobID, "tenant").Result()
	if err != nil {
		return nil
	}
	return &Job{JobID: jobID, Tenant: tenant}
}
`,
  'crawl/frontier/frontier.go': `// Package frontier is the crawl frontier (provided; step 2 builds the same functions).
// frontier:{job_id}:{host} is the host's queue of URLs; pending:{job_id} scores every URL still owed
// an outcome with the time it was first enqueued; bucket:{job_id}:{host} is the host's token bucket
// (tokens, ts), refilled at the host's rate up to Burst and spent by Take in one Lua script that
// also pops the URL; and throttle:{job_id}:{host} holds the time (ms) before which Take hands out
// nothing for the host.
package frontier

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	Burst       = 2
	BucketTTLMs = 3600000
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var takeScript = redis.NewScript(\`
local now = tonumber(ARGV[1])
if now < tonumber(redis.call('GET', KEYS[3]) or '0') then return false end
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or burst
local ts = tonumber(state[2]) or now
tokens = math.min(burst, tokens + (now - ts) * rate / 60000)
local url = false
if tokens >= 1 then
  url = redis.call('LPOP', KEYS[2])
  if url then tokens = tokens - 1 end
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return url
\`)

func QueueKey(jobID, host string) string    { return "frontier:" + jobID + ":" + host }
func BucketKey(jobID, host string) string   { return "bucket:" + jobID + ":" + host }
func ThrottleKey(jobID, host string) string { return "throttle:" + jobID + ":" + host }
func PendingKey(jobID string) string        { return "pending:" + jobID }

// Enqueue queues url on its host; it is pending from now until an outcome is recorded.
func Enqueue(ctx context.Context, jobID, host, url string) error {
	if err := rdb.RPush(ctx, QueueKey(jobID, host), url).Err(); err != nil {
		return err
	}
	return rdb.ZAddNX(ctx, PendingKey(jobID), redis.Z{Score: float64(time.Now().UnixMilli()) / 1000, Member: url}).Err()
}

// Take is the next URL of the host if the host is not throttled and its bucket holds a token, else "".
func Take(ctx context.Context, jobID, host string, ratePerMinute int) (string, error) {
	keys := []string{BucketKey(jobID, host), QueueKey(jobID, host), ThrottleKey(jobID, host)}
	url, err := takeScript.Run(ctx, rdb, keys, time.Now().UnixMilli(), ratePerMinute, Burst, BucketTTLMs).Text()
	if err == redis.Nil {
		return "", nil
	}
	return url, err
}

// Throttle: the host answered 429, Take hands out nothing for it for retryAfterS seconds.
func Throttle(ctx context.Context, jobID, host string, retryAfterS int) error {
	if retryAfterS < 1 {
		retryAfterS = 1
	}
	wait := time.Duration(retryAfterS) * time.Second
	return rdb.Set(ctx, ThrottleKey(jobID, host), time.Now().UnixMilli()+wait.Milliseconds(), wait).Err()
}

// Requeue puts a taken URL back at the tail of its host's queue.
func Requeue(ctx context.Context, jobID, host, url string) error {
	return rdb.RPush(ctx, QueueKey(jobID, host), url).Err()
}
`,
  'crawl/records/records.go': `// Package records is what became of every URL (provided): page:{job_id}:{url} holds its status
// (fetched, refused, gone, failed, then indexed) with content_hash, body_ref or reason, and
// counts:{job_id} counts the outcomes (indexed pages were fetched first, so fetched counts them
// too). An outcome takes the URL off pending:{job_id}: it is no longer owed anything.
package records

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"crawl/frontier"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Outcomes are the counters of a job.
var Outcomes = []string{"fetched", "refused", "gone", "failed", "indexed"}

func PageKey(jobID, url string) string { return "page:" + jobID + ":" + url }

func settle(ctx context.Context, jobID, url, status string, fields map[string]any) {
	fields["status"] = status
	rdb.HSet(ctx, PageKey(jobID, url), fields)
	rdb.HIncrBy(ctx, "counts:"+jobID, status, 1)
	rdb.ZRem(ctx, frontier.PendingKey(jobID), url)
}

func MarkFetched(ctx context.Context, jobID, url, contentHash, bodyRef string) {
	settle(ctx, jobID, url, "fetched", map[string]any{"content_hash": contentHash, "body_ref": bodyRef})
}

func MarkRefused(ctx context.Context, jobID, url, reason string) {
	settle(ctx, jobID, url, "refused", map[string]any{"reason": reason})
}

func MarkGone(ctx context.Context, jobID, url string) {
	settle(ctx, jobID, url, "gone", map[string]any{})
}

func MarkFailed(ctx context.Context, jobID, url, reason string) {
	settle(ctx, jobID, url, "failed", map[string]any{"reason": reason})
}

func MarkIndexed(ctx context.Context, jobID, url string) {
	rdb.HSet(ctx, PageKey(jobID, url), "status", "indexed")
	rdb.HIncrBy(ctx, "counts:"+jobID, "indexed", 1)
}

// PageOf is the page's record (status and its fields), or nil when it has no outcome yet.
func PageOf(ctx context.Context, jobID, url string) map[string]string {
	page := rdb.HGetAll(ctx, PageKey(jobID, url)).Val()
	if len(page) == 0 {
		return nil
	}
	return page
}

// Counts is {fetched, refused, gone, failed, indexed} of the job, 0 for an outcome it has none of.
func Counts(ctx context.Context, jobID string) map[string]int64 {
	raw := rdb.HGetAll(ctx, "counts:"+jobID).Val()
	out := map[string]int64{}
	for _, name := range Outcomes {
		n, _ := strconv.ParseInt(raw[name], 10, 64)
		out[name] = n
	}
	return out
}
`,
  'crawl/search/search.go': `// Package search is the search index (provided): index:{url} holds the indexed page (url,
// content_hash, words). Put refuses a page with an empty body, which has nothing to index.
package search

import (
	"context"
	"fmt"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Put indexes the page; an error when the body is empty.
func Put(ctx context.Context, url, contentHash, body string) error {
	words := strings.Fields(body)
	if len(words) == 0 {
		return fmt.Errorf("nothing to index for %s", url)
	}
	return rdb.HSet(ctx, "index:"+url, map[string]any{"url": url, "content_hash": contentHash, "words": len(words)}).Err()
}

// Get is the indexed page, or nil.
func Get(ctx context.Context, url string) map[string]string {
	page := rdb.HGetAll(ctx, "index:"+url).Val()
	if len(page) == 0 {
		return nil
	}
	return page
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'crawl/web.h': `// The web as crawld sees it (provided; the harness stands in for the hosts): fetchRobots(host)
// answers the Disallow path prefixes of the host's robots.txt (the list web:robots:{host}) and
// fetchPage(url) the page's body (web:page:{url}, "" when there is none). Every fetch is logged on
// the list web:fetches, as a proxy log would show it. splitUrl is the URL parser every step shares.
#pragma once

#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cctype>
#include <optional>
#include <string>
#include <vector>

namespace web {

struct Url {
  std::string scheme;
  std::string host;
  std::string path;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

// {scheme, host, path} of an absolute URL (scheme and host lower-cased, path "/" when empty); none
// without a scheme or a host.
inline std::optional<Url> splitUrl(const std::string& url) {
  const auto sep = url.find("://");
  if (sep == std::string::npos || sep == 0) return std::nullopt;
  const auto end = url.find_first_of("/?#", sep + 3);
  std::string authority = url.substr(sep + 3, end == std::string::npos ? std::string::npos : end - sep - 3);
  if (const auto at = authority.rfind('@'); at != std::string::npos) authority = authority.substr(at + 1);
  if (const auto colon = authority.find(':'); colon != std::string::npos) authority = authority.substr(0, colon);
  if (authority.empty()) return std::nullopt;
  std::string path = end == std::string::npos || url[end] != '/' ? "/" : url.substr(end, url.find_first_of("?#", end) - end);
  return Url{lower(url.substr(0, sep)), lower(authority), path};
}

// GET https://{host}/robots.txt: the host's Disallow path prefixes.
inline std::vector<std::string> fetchRobots(const std::string& host) {
  redis().rpush("web:fetches", "https://" + host + "/robots.txt");
  return redis().lrange("web:robots:" + host, 0, -1);
}

// GET url: the page's body.
inline std::string fetchPage(const std::string& url) {
  redis().rpush("web:fetches", url);
  return redis().get("web:page:" + url).value_or("");
}

}  // namespace web
`,
  'crawl/registry.h': `// The target registry (provided): targets:{job_id} maps every registered URL of a job to its target
// id, target:{target_id} holds the target (target_id, job_id, url, host, tenant), and job:{job_id}
// the job's tenant, set by the job's first target.
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>

#include "crawl/web.h"

namespace registry {

struct Target {
  std::string target_id;
  std::string job_id;
  std::string url;
  std::string host;
  std::string tenant;
};

struct Job {
  std::string job_id;
  std::string tenant;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The target registered for (job_id, url), or none.
inline std::optional<Target> find(const std::string& job_id, const std::string& url) {
  const auto target_id = redis().hget("targets:" + job_id, url);
  if (!target_id) return std::nullopt;
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("target:" + *target_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return Target{text("target_id"), text("job_id"), text("url"), text("host"), text("tenant")};
}

// Register url under the job and return the target; every call registers a new target.
inline Target insert(const std::string& job_id, const std::string& url, const std::string& tenant) {
  const auto parsed = web::splitUrl(url);
  const Target target{"t-" + std::to_string(redis().incr("target:seq")), job_id, url, parsed ? parsed->host : "", tenant};
  redis().hset("target:" + target.target_id,
               {{"target_id", target.target_id}, {"job_id", job_id}, {"url", url}, {"host", target.host}, {"tenant", tenant}});
  redis().hset("targets:" + job_id, url, target.target_id);
  redis().hsetnx("job:" + job_id, "tenant", tenant);
  return target;
}

// The job with its tenant, or none when the job has no target.
inline std::optional<Job> jobOf(const std::string& job_id) {
  const auto tenant = redis().hget("job:" + job_id, "tenant");
  if (!tenant) return std::nullopt;
  return Job{job_id, *tenant};
}

}  // namespace registry
`,
  'crawl/frontier.h': `// The crawl frontier (provided; step 2 builds the same functions). frontier:{job_id}:{host} is the
// host's queue of URLs; pending:{job_id} scores every URL still owed an outcome with the time it was
// first enqueued; bucket:{job_id}:{host} is the host's token bucket (tokens, ts), refilled at the
// host's rate up to kBurst and spent by take in one Lua script that also pops the URL; and
// throttle:{job_id}:{host} holds the time (ms) before which take hands out nothing for the host.
#pragma once

#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <optional>
#include <string>

namespace frontier {

constexpr long kBurst = 2;
constexpr long long kBucketTtlMs = 3600000;

inline const std::string kTakeLua = R"lua(
local now = tonumber(ARGV[1])
if now < tonumber(redis.call('GET', KEYS[3]) or '0') then return false end
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or burst
local ts = tonumber(state[2]) or now
tokens = math.min(burst, tokens + (now - ts) * rate / 60000)
local url = false
if tokens >= 1 then
  url = redis.call('LPOP', KEYS[2])
  if url then tokens = tokens - 1 end
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return url
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

inline std::string queueKey(const std::string& job_id, const std::string& host) { return "frontier:" + job_id + ":" + host; }
inline std::string bucketKey(const std::string& job_id, const std::string& host) { return "bucket:" + job_id + ":" + host; }
inline std::string throttleKey(const std::string& job_id, const std::string& host) { return "throttle:" + job_id + ":" + host; }
inline std::string pendingKey(const std::string& job_id) { return "pending:" + job_id; }

// Queue url on its host; it is pending from now until an outcome is recorded.
inline void enqueue(const std::string& job_id, const std::string& host, const std::string& url) {
  redis().rpush(queueKey(job_id, host), url);
  redis().zadd(pendingKey(job_id), url, static_cast<double>(nowMs()) / 1000, sw::redis::UpdateType::NOT_EXIST);
}

// The next URL of the host if the host is not throttled and its bucket holds a token, else none.
inline std::optional<std::string> take(const std::string& job_id, const std::string& host, long rate_per_minute) {
  return redis().eval<sw::redis::OptionalString>(
      kTakeLua, {bucketKey(job_id, host), queueKey(job_id, host), throttleKey(job_id, host)},
      {std::to_string(nowMs()), std::to_string(rate_per_minute), std::to_string(kBurst), std::to_string(kBucketTtlMs)});
}

// The host answered 429: take hands out nothing for it for retry_after_s seconds.
inline void throttle(const std::string& job_id, const std::string& host, long retry_after_s) {
  const std::chrono::milliseconds wait{std::max(retry_after_s, 1L) * 1000};
  redis().set(throttleKey(job_id, host), std::to_string(nowMs() + wait.count()), wait);
}

// Put a taken URL back at the tail of its host's queue.
inline void requeue(const std::string& job_id, const std::string& host, const std::string& url) {
  redis().rpush(queueKey(job_id, host), url);
}

}  // namespace frontier
`,
  'crawl/records.h': `// What became of every URL (provided): page:{job_id}:{url} holds its status (fetched, refused,
// gone, failed, then indexed) with content_hash, body_ref or reason, and counts:{job_id} counts the
// outcomes (indexed pages were fetched first, so fetched counts them too). An outcome takes the URL
// off pending:{job_id}: it is no longer owed anything.
#pragma once

#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "crawl/frontier.h"

namespace records {

inline const std::vector<std::string> kOutcomes = {"fetched", "refused", "gone", "failed", "indexed"};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string pageKey(const std::string& job_id, const std::string& url) { return "page:" + job_id + ":" + url; }

inline void settle(const std::string& job_id, const std::string& url, const std::string& status,
                   std::map<std::string, std::string> fields) {
  fields["status"] = status;
  redis().hset(pageKey(job_id, url), fields.begin(), fields.end());
  redis().hincrby("counts:" + job_id, status, 1);
  redis().zrem(frontier::pendingKey(job_id), url);
}

inline void markFetched(const std::string& job_id, const std::string& url, const std::string& content_hash, const std::string& body_ref) {
  settle(job_id, url, "fetched", {{"content_hash", content_hash}, {"body_ref", body_ref}});
}
inline void markRefused(const std::string& job_id, const std::string& url, const std::string& reason) {
  settle(job_id, url, "refused", {{"reason", reason}});
}
inline void markGone(const std::string& job_id, const std::string& url) { settle(job_id, url, "gone", {}); }
inline void markFailed(const std::string& job_id, const std::string& url, const std::string& reason) {
  settle(job_id, url, "failed", {{"reason", reason}});
}
inline void markIndexed(const std::string& job_id, const std::string& url) {
  redis().hset(pageKey(job_id, url), "status", "indexed");
  redis().hincrby("counts:" + job_id, "indexed", 1);
}

// The page's record (status and its fields), or none when it has no outcome yet.
inline std::optional<std::map<std::string, std::string>> pageOf(const std::string& job_id, const std::string& url) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(pageKey(job_id, url));
  if (raw.empty()) return std::nullopt;
  return std::map<std::string, std::string>(raw.begin(), raw.end());
}

// {fetched, refused, gone, failed, indexed} of the job, 0 for an outcome it has none of.
inline std::map<std::string, long long> counts(const std::string& job_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("counts:" + job_id);
  std::map<std::string, long long> out;
  for (const std::string& name : kOutcomes) out[name] = raw.count(name) ? std::stoll(raw.at(name)) : 0;
  return out;
}

}  // namespace records
`,
  'crawl/search.h': `// The search index (provided): index:{url} holds the indexed page (url, content_hash, words). put
// refuses a page with an empty body, which has nothing to index, by throwing std::invalid_argument.
#pragma once

#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>

namespace search {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Index the page; throws std::invalid_argument when the body is empty.
inline void put(const std::string& url, const std::string& content_hash, const std::string& body) {
  std::istringstream in(body);
  long words = 0;
  for (std::string word; in >> word;) words++;
  if (words == 0) throw std::invalid_argument("nothing to index for " + url);
  redis().hset("index:" + url, {{"url", url}, {"content_hash", content_hash}, {"words", std::to_string(words)}});
}

// The indexed page, or none.
inline std::optional<std::map<std::string, std::string>> get(const std::string& url) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("index:" + url);
  if (raw.empty()) return std::nullopt;
  return std::map<std::string, std::string>(raw.begin(), raw.end());
}

}  // namespace search
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('crawl', 'Web')]: `package crawl

import java.net.URI

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._
import scala.util.Try

/**
 * The web as crawld sees it (provided; the harness stands in for the hosts): fetchRobots(host)
 * answers the Disallow path prefixes of the host's robots.txt (the list web:robots:{host}) and
 * fetchPage(url) the page's body (web:page:{url}, "" when there is none). Every fetch is logged on
 * the list web:fetches, as a proxy log would show it. splitUrl is the URL parser every step shares.
 */
object Web {
  final case class Url(scheme: String, host: String, path: String)

  val jedis = new JedisPooled("redis", 6379)

  /** Scheme, host (both lower-cased) and path ("/" when empty) of an absolute URL; None without a scheme or a host. */
  def splitUrl(url: String): Option[Url] =
    Try(new URI(url.trim)).toOption.flatMap { uri =>
      for {
        scheme <- Option(uri.getScheme)
        host <- Option(uri.getHost).filter(_.nonEmpty)
      } yield Url(scheme.toLowerCase, host.toLowerCase, Option(uri.getRawPath).filter(_.nonEmpty).getOrElse("/"))
    }

  /** GET https://{host}/robots.txt: the host's Disallow path prefixes. */
  def fetchRobots(host: String): Seq[String] = {
    jedis.rpush("web:fetches", s"https://$host/robots.txt")
    jedis.lrange(s"web:robots:$host", 0, -1).asScala.toSeq
  }

  /** GET url: the page's body. */
  def fetchPage(url: String): String = {
    jedis.rpush("web:fetches", url)
    Option(jedis.get(s"web:page:$url")).getOrElse("")
  }
}
`,
  [scalaPath('crawl', 'Registry')]: `package crawl

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The target registry (provided): targets:{job_id} maps every registered URL of a job to its target
 * id, target:{target_id} holds the target (target_id, job_id, url, host, tenant), and job:{job_id}
 * the job's tenant, set by the job's first target.
 */
object Registry {
  final case class Target(targetId: String, jobId: String, url: String, host: String, tenant: String)
  final case class Job(jobId: String, tenant: String)

  val jedis = new JedisPooled("redis", 6379)

  /** The target registered for (jobId, url), or None. */
  def find(jobId: String, url: String): Option[Target] =
    Option(jedis.hget(s"targets:$jobId", url)).flatMap { targetId =>
      val raw = jedis.hgetAll(s"target:$targetId").asScala.toMap
      if (raw.isEmpty) None
      else Some(Target(raw("target_id"), raw("job_id"), raw("url"), raw("host"), raw("tenant")))
    }

  /** Register url under the job and return the target; every call registers a new target. */
  def insert(jobId: String, url: String, tenant: String): Target = {
    val target = Target(s"t-\${jedis.incr("target:seq")}", jobId, url, Web.splitUrl(url).map(_.host).getOrElse(""), tenant)
    jedis.hset(s"target:\${target.targetId}", Map("target_id" -> target.targetId, "job_id" -> jobId, "url" -> url, "host" -> target.host, "tenant" -> tenant).asJava)
    jedis.hset(s"targets:$jobId", url, target.targetId)
    jedis.hsetnx(s"job:$jobId", "tenant", tenant)
    target
  }

  /** The job with its tenant, or None when the job has no target. */
  def jobOf(jobId: String): Option[Job] = Option(jedis.hget(s"job:$jobId", "tenant")).map(Job(jobId, _))
}
`,
  [scalaPath('crawl', 'Frontier')]: `package crawl

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.{SetParams, ZAddParams}

import scala.jdk.CollectionConverters._

/**
 * The crawl frontier (provided; step 2 builds the same functions). frontier:{job_id}:{host} is the
 * host's queue of URLs; pending:{job_id} scores every URL still owed an outcome with the time it was
 * first enqueued; bucket:{job_id}:{host} is the host's token bucket (tokens, ts), refilled at the
 * host's rate up to Burst and spent by take in one Lua script that also pops the URL; and
 * throttle:{job_id}:{host} holds the time (ms) before which take hands out nothing for the host.
 */
object Frontier {
  val Burst = 2L
  val BucketTtlMs = 3600000L

  val TakeLua: String =
    """local now = tonumber(ARGV[1])
      |if now < tonumber(redis.call('GET', KEYS[3]) or '0') then return false end
      |local rate = tonumber(ARGV[2])
      |local burst = tonumber(ARGV[3])
      |local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
      |local tokens = tonumber(state[1]) or burst
      |local ts = tonumber(state[2]) or now
      |tokens = math.min(burst, tokens + (now - ts) * rate / 60000)
      |local url = false
      |if tokens >= 1 then
      |  url = redis.call('LPOP', KEYS[2])
      |  if url then tokens = tokens - 1 end
      |end
      |redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', ARGV[1])
      |redis.call('PEXPIRE', KEYS[1], ARGV[4])
      |return url
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  def queueKey(jobId: String, host: String): String = s"frontier:$jobId:$host"
  def bucketKey(jobId: String, host: String): String = s"bucket:$jobId:$host"
  def throttleKey(jobId: String, host: String): String = s"throttle:$jobId:$host"
  def pendingKey(jobId: String): String = s"pending:$jobId"

  /** Queue url on its host; it is pending from now until an outcome is recorded. */
  def enqueue(jobId: String, host: String, url: String): Unit = {
    jedis.rpush(queueKey(jobId, host), url)
    jedis.zadd(pendingKey(jobId), System.currentTimeMillis / 1000.0, url, ZAddParams.zAddParams().nx())
  }

  /** The next URL of the host if the host is not throttled and its bucket holds a token, else None. */
  def take(jobId: String, host: String, ratePerMinute: Int): Option[String] = {
    val keys = List(bucketKey(jobId, host), queueKey(jobId, host), throttleKey(jobId, host)).asJava
    val args = List(System.currentTimeMillis.toString, ratePerMinute.toString, Burst.toString, BucketTtlMs.toString).asJava
    Option(jedis.eval(TakeLua, keys, args)).map(_.toString)
  }

  /** The host answered 429: take hands out nothing for it for retryAfterS seconds. */
  def throttle(jobId: String, host: String, retryAfterS: Int): Unit = {
    val waitMs = math.max(retryAfterS, 1) * 1000L
    jedis.set(throttleKey(jobId, host), (System.currentTimeMillis + waitMs).toString, SetParams.setParams().px(waitMs))
  }

  /** Put a taken URL back at the tail of its host's queue. */
  def requeue(jobId: String, host: String, url: String): Unit = jedis.rpush(queueKey(jobId, host), url)
}
`,
  [scalaPath('crawl', 'Records')]: `package crawl

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * What became of every URL (provided): page:{job_id}:{url} holds its status (fetched, refused, gone,
 * failed, then indexed) with content_hash, body_ref or reason, and counts:{job_id} counts the
 * outcomes (indexed pages were fetched first, so fetched counts them too). An outcome takes the URL
 * off pending:{job_id}: it is no longer owed anything.
 */
object Records {
  val Outcomes: Seq[String] = Seq("fetched", "refused", "gone", "failed", "indexed")

  val jedis = new JedisPooled("redis", 6379)

  def pageKey(jobId: String, url: String): String = s"page:$jobId:$url"

  private def settle(jobId: String, url: String, status: String, fields: Map[String, String]): Unit = {
    jedis.hset(pageKey(jobId, url), (fields + ("status" -> status)).asJava)
    jedis.hincrBy(s"counts:$jobId", status, 1)
    jedis.zrem(Frontier.pendingKey(jobId), url)
  }

  def markFetched(jobId: String, url: String, contentHash: String, bodyRef: String): Unit =
    settle(jobId, url, "fetched", Map("content_hash" -> contentHash, "body_ref" -> bodyRef))
  def markRefused(jobId: String, url: String, reason: String): Unit = settle(jobId, url, "refused", Map("reason" -> reason))
  def markGone(jobId: String, url: String): Unit = settle(jobId, url, "gone", Map.empty)
  def markFailed(jobId: String, url: String, reason: String): Unit = settle(jobId, url, "failed", Map("reason" -> reason))

  def markIndexed(jobId: String, url: String): Unit = {
    jedis.hset(pageKey(jobId, url), "status", "indexed")
    jedis.hincrBy(s"counts:$jobId", "indexed", 1)
  }

  /** The page's record (status and its fields), or None when it has no outcome yet. */
  def pageOf(jobId: String, url: String): Option[Map[String, String]] =
    Some(jedis.hgetAll(pageKey(jobId, url)).asScala.toMap).filter(_.nonEmpty)

  /** fetched, refused, gone, failed and indexed of the job, 0 for an outcome it has none of. */
  def counts(jobId: String): Map[String, Long] = {
    val raw = jedis.hgetAll(s"counts:$jobId").asScala
    Outcomes.map(name => name -> raw.get(name).map(_.toLong).getOrElse(0L)).toMap
  }
}
`,
  [scalaPath('crawl', 'Search')]: `package crawl

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The search index (provided): index:{url} holds the indexed page (url, content_hash, words). put
 * refuses a page with an empty body, which has nothing to index, with an IllegalArgumentException.
 */
object Search {
  val jedis = new JedisPooled("redis", 6379)

  /** Index the page; throws IllegalArgumentException when the body is empty. */
  def put(url: String, contentHash: String, body: String): Unit = {
    val words = body.trim.split("\\\\s+").count(_.nonEmpty)
    if (words == 0) throw new IllegalArgumentException(s"nothing to index for $url")
    jedis.hset(s"index:$url", Map("url" -> url, "content_hash" -> contentHash, "words" -> words.toString).asJava)
  }

  /** The indexed page, or None. */
  def get(url: String): Option[Map[String, String]] = Some(jedis.hgetAll(s"index:$url").asScala.toMap).filter(_.nonEmpty)
}
`,
};
