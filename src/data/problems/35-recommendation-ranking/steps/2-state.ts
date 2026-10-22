import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis feature cache with a single-flight refresh',
  concept: 'redis',
  file: 'state',
  focus: ['recsvc', 'redis', 'features'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it reads the cached vector,
returns it on a hit, and on a miss asks the feature service once and writes the result back. It
serves the demo, and it hides four production failures. Review it like the owner of the ranking
path, fix it, and prove the fix with the checks below.

Implement \`load_features(tenant, user)\`, the call the ranking path makes before it scores a
request:

- The vector is cached **per \`(tenant, user)\`** under \`features:{tenant}:{user}\`. The draft keys by
  the user id alone, so two tenants that happen to share a user id read each other's vector — a
  wrong ranking for one of them, served by both. The endpoint's **401** on a missing tenant and its
  **400** on a malformed body cannot see this: both requests are perfectly well-formed.
- The fresh copy is written with a **TTL of 300 s** (\`TTL_S = 300\`, passed to the client as
  \`ex=\`/\`EX\`/\`Expire\`/\`setex\`), so a catalog change reaches the ranking within the TTL instead of
  living in Redis until someone flushes it.
- A miss is refreshed by **exactly one caller**: take
  \`SET lock:features:{tenant}:{user} 1 NX EX LOCK_TTL_S\` (5 s) before calling the feature service.
  Every other caller **waits on the same published value** — sleep 50 ms, re-read
  \`features:{tenant}:{user}\`, repeat until it appears or the lock TTL passes — instead of calling
  the feature service itself. The draft calls the service on every miss, so one slow second there
  becomes a thundering herd of identical calls.
- Keep a **longer-lived stale copy** at \`features:stale:{tenant}:{user}\` (\`STALE_TTL_S = 86_400\`),
  written on every successful refresh. When the refresh fails, return that copy with \`stale=True\`
  rather than empty features that would rank on nothing. A blip at the feature service is not the
  API's **404** for something that does not exist — the vector exists, it is just old — so serve the
  previous copy degraded instead of failing the request.
- Release the lock in a \`finally\`/\`defer\`/scope guard — **on the failure path too** — and let a
  follower that outlives the lock TTL take over the refresh. One failed refresh must not wedge the
  key until the fresh copy expires.

This step owns only the feature cache: the surface config cache (\`surface:{surface}:config\`, TTL
5 s) and the request endpoint belong to the previous step.

**Failure mode the checks target.** The tenant collision is the silent one: it fires only when two
tenants share a user id, and then one tenant's ranking is computed from another tenant's data. The
herd is the loud one: at every TTL expiry, all concurrent requests miss at once, so a feature
service that takes 200 ms suddenly answers hundreds of identical calls and the ranking path's whole
budget is gone. The missing TTL is the slow leak; the missing stale copy is why a restarted feature
service turns into empty rankings; and a lock that is never released turns one failed refresh into a
permanently stale key.`,
  sequence: {
    participants: ['Ranking path', 'Concurrent request', 'Redis', 'Feature service'],
    messages: [
      {from: 'Ranking path', to: 'Redis', label: 'GET features:acme:u-42 → (nil)', kind: 'sync'},
      {from: 'Concurrent request', to: 'Redis', label: 'GET features:acme:u-42 → (nil)', kind: 'sync'},
      {from: 'Ranking path', to: 'Redis', label: 'SET lock:features:acme:u-42 1 NX EX 5 → OK', kind: 'sync'},
      {
        from: 'Concurrent request',
        to: 'Redis',
        label: 'SET lock:features:acme:u-42 1 NX → (nil): it waits instead of refreshing',
        kind: 'sync',
      },
      {from: 'Ranking path', to: 'Feature service', label: 'Get(acme, u-42)', kind: 'sync'},
      {from: 'Concurrent request', to: 'Redis', label: 'GET features:acme:u-42 every 50 ms', kind: 'sync'},
      {from: 'Feature service', to: 'Ranking path', label: 'vector', kind: 'reply'},
      {
        from: 'Ranking path',
        to: 'Redis',
        label: 'SET features:acme:u-42 EX 300 · SET features:stale:acme:u-42 EX 86400 · DEL lock',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Concurrent request', label: 'vector (one refresh served both)', kind: 'reply'},
      {from: 'Feature service', to: 'Ranking path', label: 'unavailable on a later refresh', kind: 'reply'},
      {
        from: 'Ranking path',
        to: 'Redis',
        label: 'GET features:stale:acme:u-42 → previous vector, stale=True',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'ttl',
      title: 'Caches the vector with a 300 s TTL',
      detail:
        'The fresh copy is written with `TTL_S = 300` (`ex=`/`EX`/`Expire`/`setex`), so a catalog change reaches the ranking within five minutes. The draft writes the vector with no expiry at all, so the first value a user ever gets is the one they keep.',
      match: {
        python: {all: [/\bTTL_S = 300/, /r\.set\(key, blob, ex=TTL_S\)/]},
        typescript: {all: [/\bTTL_S = 300/, /r\.set\(key, blob, 'EX', TTL_S\)/]},
        go: {all: [/ttlS\s*=\s*300/, /rdb\.Set\(ctx, key, blob, ttlS\*time\.Second\)/]},
        scala: {all: [/\bTtlS = 300L/, /jedis\.setex\(key, TtlS, blob\)/]},
        cpp: {all: [/\bkTtlS = 300/, /redis\.set\(key, blob, std::chrono::seconds\{kTtlS\}\)/]},
      },
    },
    {
      id: 'tenant-key',
      title: 'Keys the cache by (tenant, user)',
      detail:
        'The key is `features:{tenant}:{user}`: both ids are part of it. The draft keys by the user id alone, so two tenants that share a user id collide — the first writer wins and the second tenant is ranked from the first tenant’s vector.',
      match: {
        python: {all: [/features:\{tenant\}:\{user\}/], none: [/features:\{user\}/]},
        typescript: {all: [/features:\$\{tenant\}:\$\{user\}/], none: [/features:\$\{user\}/]},
        go: {all: [/"features:" \+ tenant \+ ":" \+ user/], none: [/"features:" \+ user/]},
        scala: {all: [/s"features:\$tenant:\$user"/], none: [/s"features:\$user"/]},
        cpp: {all: [/"features:" \+ tenant \+ ":" \+ user/], none: [/"features:" \+ user/]},
      },
    },
    {
      id: 'single-flight',
      title: 'Refreshes once per miss under concurrency',
      detail:
        'The caller that wins `SET lock:features:{tenant}:{user} 1 NX EX LOCK_TTL_S` calls the feature service; every concurrent miss sleeps, re-reads the fresh key and waits for the value the winner publishes instead of calling the service too. The draft has no lock, so a cold key with N concurrent requests makes N identical calls.',
      match: {
        python: {
          all: [/nx=True/, /ex=LOCK_TTL_S/, /time\.sleep\(POLL_S\)/],
          order: [/nx=True/, /features\.get\(/],
        },
        typescript: {
          all: [/'NX'/, /'EX', LOCK_TTL_S/, /deadline/],
          order: [/'NX'/, /featureService\.get\(/],
        },
        go: {
          all: [/SetNX\(ctx, lock, "1", lockTtlS\)/, /time\.Sleep\(pollS\)/, /deadline/],
          order: [/SetNX\(/, /features\.Get\(/],
        },
        scala: {
          all: [/SetParams\.setParams\(\)\.nx\(\)\.ex\(LockTtlS\)/, /Thread\.sleep\(PollMillis\)/, /deadline/],
          order: [/\.nx\(\)/, /fetchFeatures\(/],
        },
        cpp: {
          all: [/UpdateType::NOT_EXIST/, /sleep_for\(kPoll\)/, /deadline/],
          order: [/UpdateType::NOT_EXIST/, /fetchFeatures\(/],
        },
      },
    },
    {
      id: 'stale-fallback',
      title: 'Serves the stale copy when the refresh fails',
      detail:
        'A longer-lived stale copy `features:stale:{tenant}:{user}` (`STALE_TTL_S = 86_400`) is written on every successful refresh, and when the refresh fails the previous features are returned marked `stale=True` instead of empty ones. The draft has no stale copy at all and degrades to an empty vector.',
      match: {
        python: {all: [/STALE_TTL_S/, /features:stale:\{tenant\}:\{user\}/, /"stale": True/]},
        typescript: {all: [/STALE_TTL_S/, /features:stale:/, /stale: true/]},
        go: {all: [/features:stale:/, /staleTtlS\*time\.Second/, /Stale: true/]},
        scala: {all: [/features:stale:/, /setex\(staleKey\(tenant, user\), StaleTtlS, blob\)/, /stale = true/]},
        cpp: {all: [/features:stale:/, /std::chrono::seconds\{kStaleTtlS\}/, /stale = true/]},
      },
    },
    {
      id: 'lock-release',
      title: 'Releases the lock on every path',
      detail:
        'The lock is released after the refresh — a `finally`/`defer`/scope guard, so the failure path releases it too, with `EX` as the crash net — and a follower that outlives the lock TTL takes over the refresh. A lock left behind wedges the key at its first failed refresh.',
      match: {
        python: {all: [/finally:/, /r\.delete\(lock\)/]},
        typescript: {all: [/finally/, /r\.del\(lock\)/]},
        go: {
          all: [/defer rdb\.Del\(ctx, lock\)/],
          order: [/SetNX\(ctx, lock/, /rdb\.Del\(ctx, lock\)/],
        },
        scala: {all: [/finally/, /jedis\.del\(lock\)/]},
        cpp: {all: [/~Release\(\)/, /redis\.del\(lock\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""load_features: the ranking path's read of the per-(tenant, user) feature vector."""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class FeatureService:
    def get(self, tenant: str, user: str) -> dict[str, float]:
        """The feature service's vector for one (tenant, user)."""
        raise NotImplementedError


features = FeatureService()


def load_features(tenant: str, user: str) -> dict:
    # TODO: this draft caches under the user id alone, writes the vector with no TTL, calls the
    # feature service on every miss with no single-flight lock, and degrades to empty features
    # when the refresh fails. Review all four.
    key = f"features:{user}"
    cached = r.get(key)
    if cached is not None:
        return {"features": json.loads(cached), "stale": False}
    try:
        vector = features.get(tenant, user)
    except Exception:
        return {"features": {}, "stale": False}
    r.set(key, json.dumps(vector))
    return {"features": vector, "stale": False}
`,
      solution: `"""load_features: one refresh per miss, with the stale copy served when that refresh fails."""
import json
import time
from typing import Any

import redis
from fastapi import HTTPException

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 300
STALE_TTL_S = 86_400
LOCK_TTL_S = 5
POLL_S = 0.05


class FeatureService:
    def get(self, tenant: str, user: str) -> dict[str, float]:
        """The feature service's vector for one (tenant, user)."""
        raise NotImplementedError


features = FeatureService()


def features_key(tenant: str, user: str) -> str:
    """The fresh copy the ranking path reads: one key per (tenant, user)."""
    return f"features:{tenant}:{user}"


def stale_key(tenant: str, user: str) -> str:
    """The last known good copy: written with a longer TTL so a failed refresh can still serve it."""
    return f"features:stale:{tenant}:{user}"


def lock_key(tenant: str, user: str) -> str:
    """The single-flight lock: one refresher per miss."""
    return f"lock:features:{tenant}:{user}"


def serve_stale(tenant: str, user: str) -> dict[str, Any]:
    """The previous features, marked degraded; 503 when this key was never refreshed."""
    cached = r.get(stale_key(tenant, user))
    if cached is None:
        raise HTTPException(status_code=503, detail="features unavailable")
    return {"features": json.loads(cached), "stale": True}


def load_features(tenant: str, user: str) -> dict[str, Any]:
    """One refresh per miss; concurrent callers wait on the value the leader publishes."""
    key = features_key(tenant, user)
    cached = r.get(key)
    if cached is not None:
        return {"features": json.loads(cached), "stale": False}

    lock = lock_key(tenant, user)
    if not r.set(lock, "1", nx=True, ex=LOCK_TTL_S):
        # Someone else is refreshing: wait for their value instead of calling the service too.
        deadline = time.monotonic() + LOCK_TTL_S
        while time.monotonic() < deadline:
            time.sleep(POLL_S)
            cached = r.get(key)
            if cached is not None:
                return {"features": json.loads(cached), "stale": False}
        if not r.set(lock, "1", nx=True, ex=LOCK_TTL_S):
            return serve_stale(tenant, user)  # the leader died: waiters take the fallback

    try:
        vector = features.get(tenant, user)
        blob = json.dumps(vector)
        r.set(key, blob, ex=TTL_S)
        r.set(stale_key(tenant, user), blob, ex=STALE_TTL_S)
        return {"features": vector, "stale": False}
    except Exception:
        return serve_stale(tenant, user)
    finally:
        r.delete(lock)
`,
    },
    typescript: {
      starter: `/** loadFeatures: the ranking path's read of the per-(tenant, user) feature vector. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

interface Features {
  [name: string]: number;
}

/** The feature service's vector for one (tenant, user). */
const featureService = {
  async get(tenant: string, user: string): Promise<Features> {
    throw new Error('feature service not implemented');
  },
};

export async function loadFeatures(tenant: string, user: string): Promise<{features: Features; stale: boolean}> {
  // TODO: this draft caches under the user id alone, writes the vector with no TTL, calls the
  // feature service on every miss with no single-flight lock, and degrades to empty features
  // when the refresh fails. Review all four.
  const key = \`features:\${user}\`;
  const cached = await r.get(key);
  if (cached !== null) return {features: JSON.parse(cached) as Features, stale: false};
  try {
    const vector = await featureService.get(tenant, user);
    await r.set(key, JSON.stringify(vector));
    return {features: vector, stale: false};
  } catch {
    return {features: {}, stale: false};
  }
}
`,
      solution: `/** loadFeatures: one refresh per miss, with the stale copy served when that refresh fails. */
import {setTimeout as sleep} from 'node:timers/promises';

import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const TTL_S = 300;
const STALE_TTL_S = 86_400;
const LOCK_TTL_S = 5;
const POLL_MS = 50;

interface Features {
  [name: string]: number;
}

interface FeatureResult {
  features: Features;
  stale: boolean;
}

/** The feature service's vector for one (tenant, user). */
const featureService = {
  async get(tenant: string, user: string): Promise<Features> {
    throw new Error('feature service not implemented');
  },
};

function freshKey(tenant: string, user: string): string {
  return \`features:\${tenant}:\${user}\`;
}

function staleKey(tenant: string, user: string): string {
  return \`features:stale:\${tenant}:\${user}\`;
}

function lockKey(tenant: string, user: string): string {
  return \`lock:features:\${tenant}:\${user}\`;
}

/** The previous features, marked degraded; throws when this key was never refreshed. */
async function serveStale(tenant: string, user: string): Promise<FeatureResult> {
  const cached = await r.get(staleKey(tenant, user));
  if (cached === null) throw new Error('features unavailable');
  return {features: JSON.parse(cached) as Features, stale: true};
}

/** One refresh per miss; concurrent callers wait on the value the leader publishes. */
export async function loadFeatures(tenant: string, user: string): Promise<FeatureResult> {
  const key = freshKey(tenant, user);
  const cached = await r.get(key);
  if (cached !== null) return {features: JSON.parse(cached) as Features, stale: false};

  const lock = lockKey(tenant, user);
  const won = (await r.set(lock, '1', 'EX', LOCK_TTL_S, 'NX')) === 'OK';
  if (!won) {
    // Someone else is refreshing: wait for their value instead of calling the service too.
    const deadline = Date.now() + LOCK_TTL_S * 1000;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const seen = await r.get(key);
      if (seen !== null) return {features: JSON.parse(seen) as Features, stale: false};
    }
    if ((await r.set(lock, '1', 'EX', LOCK_TTL_S, 'NX')) !== 'OK') return serveStale(tenant, user);
  }
  try {
    const vector = await featureService.get(tenant, user);
    const blob = JSON.stringify(vector);
    await r.set(key, blob, 'EX', TTL_S);
    await r.set(staleKey(tenant, user), blob, 'EX', STALE_TTL_S);
    return {features: vector, stale: false};
  } catch {
    return serveStale(tenant, user);
  } finally {
    await r.del(lock);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// FeatureVector is the feature service's per-(tenant, user) vector.
type FeatureVector map[string]float64

type featureService struct{}

func (featureService) Get(ctx context.Context, tenant, user string) (FeatureVector, error) {
	return nil, errors.New("feature service not implemented")
}

var features = featureService{}

// loadFeatures: the ranking path's read of the per-(tenant, user) feature vector.
func loadFeatures(ctx context.Context, tenant, user string) (FeatureVector, bool, error) {
	// TODO: this draft caches under the user id alone, writes the vector with no TTL, calls the
	// feature service on every miss with no single-flight lock, and degrades to empty features
	// when the refresh fails. Review all four.
	key := "features:" + user
	if blob, err := rdb.Get(ctx, key).Bytes(); err == nil {
		var vector FeatureVector
		if err := json.Unmarshal(blob, &vector); err != nil {
			return nil, false, err
		}
		return vector, false, nil
	}
	vector, err := features.Get(ctx, tenant, user)
	if err != nil {
		return FeatureVector{}, false, nil
	}
	blob, err := json.Marshal(vector)
	if err != nil {
		return nil, false, err
	}
	rdb.Set(ctx, key, blob, 0)
	return vector, false, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	ttlS      = 300
	staleTtlS = 86_400
	lockTtlS  = 5 * time.Second
	pollS     = 50 * time.Millisecond
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// FeatureVector is the feature service's per-(tenant, user) vector.
type FeatureVector map[string]float64

// FeatureResult is what the ranking path reads: the vector and whether it is the degraded copy.
type FeatureResult struct {
	Vector FeatureVector
	Stale  bool
}

type featureService struct{}

func (featureService) Get(ctx context.Context, tenant, user string) (FeatureVector, error) {
	return nil, errors.New("feature service not implemented")
}

var features = featureService{}

func freshKey(tenant, user string) string {
	return "features:" + tenant + ":" + user
}

func staleKey(tenant, user string) string {
	return "features:stale:" + tenant + ":" + user
}

func lockKey(tenant, user string) string {
	return "lock:features:" + tenant + ":" + user
}

// serveStale: the previous features, marked degraded; an error when this key was never refreshed.
func serveStale(ctx context.Context, tenant, user string) (FeatureResult, error) {
	blob, err := rdb.Get(ctx, staleKey(tenant, user)).Bytes()
	if err != nil {
		return FeatureResult{}, errors.New("features unavailable")
	}
	var vector FeatureVector
	if err := json.Unmarshal(blob, &vector); err != nil {
		return FeatureResult{}, err
	}
	return FeatureResult{Vector: vector, Stale: true}, nil
}

// loadFeatures: one refresh per miss; concurrent callers wait on the value the leader publishes.
func loadFeatures(ctx context.Context, tenant, user string) (FeatureResult, error) {
	key := freshKey(tenant, user)
	if blob, err := rdb.Get(ctx, key).Bytes(); err == nil {
		var vector FeatureVector
		if err := json.Unmarshal(blob, &vector); err != nil {
			return FeatureResult{}, err
		}
		return FeatureResult{Vector: vector, Stale: false}, nil
	}

	lock := lockKey(tenant, user)
	won, err := rdb.SetNX(ctx, lock, "1", lockTtlS).Result()
	if err != nil {
		return FeatureResult{}, err
	}
	if !won {
		// Someone else is refreshing: wait for their value instead of calling the service too.
		deadline := time.Now().Add(lockTtlS)
		for time.Now().Before(deadline) {
			time.Sleep(pollS)
			if blob, err := rdb.Get(ctx, key).Bytes(); err == nil {
				var vector FeatureVector
				if err := json.Unmarshal(blob, &vector); err != nil {
					return FeatureResult{}, err
				}
				return FeatureResult{Vector: vector, Stale: false}, nil
			}
		}
		if won, err = rdb.SetNX(ctx, lock, "1", lockTtlS).Result(); err != nil {
			return FeatureResult{}, err
		}
		if !won {
			// The leader died holding the lock: take the refresh over, or serve the stale copy.
			return serveStale(ctx, tenant, user)
		}
	}
	// The deferred release covers the failure path too: one failed refresh cannot wedge the key.
	defer rdb.Del(ctx, lock)
	vector, err := features.Get(ctx, tenant, user)
	if err != nil {
		return serveStale(ctx, tenant, user)
	}
	blob, err := json.Marshal(vector)
	if err != nil {
		return FeatureResult{}, err
	}
	rdb.Set(ctx, key, blob, ttlS*time.Second)
	rdb.Set(ctx, staleKey(tenant, user), blob, staleTtlS*time.Second)
	return FeatureResult{Vector: vector, Stale: false}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class FeatureResult(features: Map[String, Double], stale: Boolean)

object FeatureCache {
  val jedis = new Jedis("redis", 6379)

  /** The feature service's vector for one (tenant, user). */
  def fetchFeatures(tenant: String, user: String): Map[String, Double] = ???

  def encode(vector: Map[String, Double]): String =
    JsObject(vector.map { case (name, value) => name -> JsNumber(value) }).compactPrint

  def decode(blob: String): Map[String, Double] =
    blob.parseJson.asJsObject.fields.map { case (name, value) => name -> value.convertTo[Double] }

  /** The ranking path's read of the per-(tenant, user) feature vector. */
  def loadFeatures(tenant: String, user: String): FeatureResult = {
    // TODO: this draft caches under the user id alone, writes the vector with no TTL, calls the
    // feature service on every miss with no single-flight lock, and degrades to empty features
    // when the refresh fails. Review all four.
    val key = s"features:$user"
    Option(jedis.get(key)) match {
      case Some(blob) => FeatureResult(decode(blob), stale = false)
      case None =>
        val vector =
          try fetchFeatures(tenant, user)
          catch { case _: Exception => Map.empty[String, Double] }
        jedis.set(key, encode(vector))
        FeatureResult(vector, stale = false)
    }
  }
}
`,
      solution: `import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class FeatureResult(features: Map[String, Double], stale: Boolean)

object FeatureCache {
  val TtlS = 300L
  val StaleTtlS = 86400L
  val LockTtlS = 5L
  val PollMillis = 50L

  val jedis = new Jedis("redis", 6379)

  /** The feature service's vector for one (tenant, user). */
  def fetchFeatures(tenant: String, user: String): Map[String, Double] = ???

  def freshKey(tenant: String, user: String): String = s"features:$tenant:$user"

  def staleKey(tenant: String, user: String): String = s"features:stale:$tenant:$user"

  def lockKey(tenant: String, user: String): String = s"lock:features:$tenant:$user"

  def encode(vector: Map[String, Double]): String =
    JsObject(vector.map { case (name, value) => name -> JsNumber(value) }).compactPrint

  def decode(blob: String): Map[String, Double] =
    blob.parseJson.asJsObject.fields.map { case (name, value) => name -> value.convertTo[Double] }

  /** The previous features, marked degraded; throws when this key was never refreshed. */
  def serveStale(tenant: String, user: String): FeatureResult =
    Option(jedis.get(staleKey(tenant, user))) match {
      case Some(blob) => FeatureResult(decode(blob), stale = true)
      case None => throw new RuntimeException("features unavailable")
    }

  /** One refresh per miss; concurrent callers wait on the value the leader publishes. */
  def loadFeatures(tenant: String, user: String): FeatureResult = {
    val key = freshKey(tenant, user)
    Option(jedis.get(key)) match {
      case Some(blob) => FeatureResult(decode(blob), stale = false)
      case None => refresh(tenant, user, key)
    }
  }

  /** Tries to become the single refresher; a follower waits, then takes over when the lock lapses. */
  private def refresh(tenant: String, user: String, key: String): FeatureResult = {
    val lock = lockKey(tenant, user)
    val params = SetParams.setParams().nx().ex(LockTtlS)
    if (jedis.set(lock, "1", params) != null) {
      refreshUnderLock(tenant, user, lock, key)
    } else {
      val deadline = System.nanoTime() + LockTtlS * 1000000000L
      var seen: Option[String] = None
      while (seen.isEmpty && System.nanoTime() < deadline) {
        Thread.sleep(PollMillis)
        seen = Option(jedis.get(key))
      }
      seen match {
        case Some(blob) => FeatureResult(decode(blob), stale = false)
        case None =>
          if (jedis.set(lock, "1", params) != null) refreshUnderLock(tenant, user, lock, key)
          else serveStale(tenant, user)
      }
    }
  }

  /** The call the lock holder makes: fetch, publish the fresh and stale copies, then release. */
  private def refreshUnderLock(tenant: String, user: String, lock: String, key: String): FeatureResult =
    try {
      val vector = fetchFeatures(tenant, user)
      val blob = encode(vector)
      jedis.setex(key, TtlS, blob)
      jedis.setex(staleKey(tenant, user), StaleTtlS, blob)
      FeatureResult(vector, stale = false)
    } catch {
      case _: Exception => serveStale(tenant, user)
    } finally {
      jedis.del(lock)
    }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <stdexcept>
#include <string>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

struct FeatureResult {
  json features;
  bool stale = false;
};

/** The feature service's vector for one (tenant, user). */
json fetchFeatures(const std::string& tenant, const std::string& user) {
  throw std::runtime_error("feature service not implemented");
}

// loadFeatures: the ranking path's read of the per-(tenant, user) feature vector.
FeatureResult loadFeatures(const std::string& tenant, const std::string& user) {
  // TODO: this draft caches under the user id alone, writes the vector with no TTL, calls the
  // feature service on every miss with no single-flight lock, and degrades to empty features
  // when the refresh fails. Review all four.
  const auto key = "features:" + user;
  if (const auto cached = redis.get(key)) {
    FeatureResult fresh;
    fresh.features = json::parse(*cached);
    fresh.stale = false;
    return fresh;
  }
  json vector = json::object();
  try {
    vector = fetchFeatures(tenant, user);
  } catch (const std::exception&) {
    return FeatureResult{json::object(), false};
  }
  redis.set(key, vector.dump());
  FeatureResult fresh;
  fresh.features = vector;
  fresh.stale = false;
  return fresh;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

using json = nlohmann::json;

constexpr long long kTtlS = 300;
constexpr long long kStaleTtlS = 86400;
constexpr long long kLockTtlS = 5;
constexpr auto kPoll = std::chrono::milliseconds{50};

sw::redis::Redis redis("tcp://redis:6379");

struct FeatureResult {
  json features;
  bool stale = false;
};

/** The feature service's vector for one (tenant, user). */
json fetchFeatures(const std::string& tenant, const std::string& user) {
  throw std::runtime_error("feature service not implemented");
}

std::string freshKey(const std::string& tenant, const std::string& user) {
  return "features:" + tenant + ":" + user;
}

std::string staleKey(const std::string& tenant, const std::string& user) {
  return "features:stale:" + tenant + ":" + user;
}

std::string lockKey(const std::string& tenant, const std::string& user) {
  return "lock:features:" + tenant + ":" + user;
}

FeatureResult makeFresh(const json& vector) {
  FeatureResult result;
  result.features = vector;
  result.stale = false;
  return result;
}

/** The previous features, marked degraded; throws when this key was never refreshed. */
FeatureResult serveStale(const std::string& tenant, const std::string& user) {
  const auto blob = redis.get(staleKey(tenant, user));
  if (!blob) throw std::runtime_error("features unavailable");
  FeatureResult result;
  result.features = json::parse(*blob);
  result.stale = true;
  return result;
}

/** One refresh per miss; concurrent callers wait on the value the leader publishes. */
FeatureResult loadFeatures(const std::string& tenant, const std::string& user) {
  const auto key = freshKey(tenant, user);
  if (const auto cached = redis.get(key)) return makeFresh(json::parse(*cached));

  const auto lock = lockKey(tenant, user);
  bool won = redis.set(lock, "1", std::chrono::seconds{kLockTtlS}, sw::redis::UpdateType::NOT_EXIST);
  if (!won) {
    // Someone else is refreshing: wait for their value instead of calling the service too.
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{kLockTtlS};
    while (std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(kPoll);
      if (const auto seen = redis.get(key)) return makeFresh(json::parse(*seen));
    }
    won = redis.set(lock, "1", std::chrono::seconds{kLockTtlS}, sw::redis::UpdateType::NOT_EXIST);
    if (!won) return serveStale(tenant, user);
  }
  // The scope guard releases the lock on every path, the failure path included.
  struct Release {
    const std::string& lock;
    ~Release() { redis.del(lock); }
  } release{lock};
  try {
    const auto vector = fetchFeatures(tenant, user);
    const auto blob = vector.dump();
    redis.set(key, blob, std::chrono::seconds{kTtlS});
    redis.set(staleKey(tenant, user), blob, std::chrono::seconds{kStaleTtlS});
    return makeFresh(vector);
  } catch (const std::exception&) {
    return serveStale(tenant, user);
  }
}
`,
    },
  },
  hints: [
    'Elect one refresher before touching the feature service: `SET lock:features:{tenant}:{user} 1 NX EX LOCK_TTL_S` tells you whether you won. The winner does the work; every other caller sleeps and re-reads the fresh key, so a cold key costs one call no matter how many requests arrive together.',
    'Write two copies on success: `features:{tenant}:{user}` with `TTL_S = 300` (what a hit reads, short because the catalog moves) and `features:stale:{tenant}:{user}` with a much longer TTL (what a failed refresh falls back to). The stale copy has to outlive the fresh one, otherwise the first failure after expiry has nothing to serve.',
    'Release the lock on the way out of every branch — `finally`, `defer`, or a destructor — and let the `EX` cover a crashed leader. A follower whose wait runs past the lock TTL takes over the refresh instead of waiting forever, and it serves `stale=True` rather than empty features when the service is still down.',
  ],
  debrief: `Cache-aside plus two additions that only matter under load and under failure. The lock is a
per-key mutex: \`NX\` elects one refresher, \`EX\` makes a crashed one harmless, and the waiters read the
value the winner publishes — the single-flight pattern, which turns "one key, N concurrent misses"
into one feature-service call per TTL. The stale copy is the second half: the fresh key expires after
300 s because a catalog change must become visible, but the previous value is still far better than
none, so a longer-lived copy is kept and served marked degraded. The tenant in the key is not
optional — a user id is only unique inside a tenant, and the endpoint's authentication has already
promised it. Production caches add in-process single-flight so one machine never makes two calls for
the same key, jittered TTLs so entries written together do not expire together, a lock token so a
slow refresher cannot delete a successor's lock, and background revalidation so nobody waits at all.`,
};
