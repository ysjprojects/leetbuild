import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Sticky assignments in Redis, one per experiment and unit',
  concept: 'redis',
  guides: ['atomic-state'],
  file: 'state',
  focus: ['api', 'redis', 'store'],
  task: `## Task

**Starting point.** The starter's \`assign(experiment_id, unit_id)\` loads the experiment
(\`expd.store\`), picks the variant with \`bucket_of(experiment_id, unit_id, salt)\` and
\`variant_for(variants, bucket)\` (\`expd.bucket\`, provided), caches it under \`assign:{unit}\` with a
90-day TTL and returns it; a \`stopped\` experiment answers control. It serves the demo and hides
four flaws.

**Failure mode the checks target.** A user sees treatment on Monday and control on Tuesday: a bulk
edit of the split or salt re-buckets every unit on its next request, two experiments share one
cached row, two replicas answer one new unit differently, and stopping an experiment flips everyone
to control.

- Cache under \`exp:{experiment_id}:assign:{unit_id}\` and read it **first**: a cached variant is the
  answer, whatever the design says now.
- On a miss, write with \`SET NX\` (keeping the TTL); a lost write answers the variant that won.
- A \`stopped\` experiment serves the cached variant and assigns nothing new (\`None\`).`,
  sequence: {
    participants: ['Experiment API', 'Redis', 'experiment store'],
    messages: [
      {from: 'Experiment API', to: 'experiment store', label: 'get(experiment_id) → split, salt, status', kind: 'sync'},
      {from: 'Experiment API', to: 'Redis', label: 'GET exp:{id}:assign:{unit}', kind: 'sync'},
      {from: 'Redis', to: 'Experiment API', label: 'variant → answer it · nil → assign', kind: 'reply'},
      {
        from: 'Experiment API',
        to: 'Experiment API',
        label: 'bucket_of · variant_for (none when stopped)',
        kind: 'sync',
      },
      {from: 'Experiment API', to: 'Redis', label: 'SET exp:{id}:assign:{unit} variant NX EX 7776000', kind: 'sync'},
      {from: 'Redis', to: 'Experiment API', label: 'nil → another replica won: GET its variant', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'experiment-key',
      title: 'One cached assignment per experiment and unit',
      detail:
        'The assignment is cached under `exp:{experiment_id}:assign:{unit_id}`, so a unit in two experiments has two rows; the starter keys by the unit alone.',
      match: {
        python: {all: [/exp:\{experiment_id\}:assign:\{unit_id\}/], none: [/["']assign:\{unit_id\}/]},
        typescript: {all: [/exp:\$\{experimentId\}:assign:\$\{unitId\}/], none: [/`assign:\$\{/]},
        go: {all: [/"exp:"\s*\+\s*experimentID\s*\+\s*":assign:"\s*\+\s*unitID/], none: [/"assign:"\s*\+/]},
        scala: {all: [/exp:\$\{?experimentId\}?:assign:\$\{?unitId/], none: [/s"assign:/]},
        cpp: {all: [/"exp:"\s*\+\s*experiment_id\s*\+\s*":assign:"\s*\+\s*unit_id/], none: [/"assign:"\s*\+/]},
      },
    },
    {
      id: 'sticky',
      title: 'Reads the cached assignment before hashing',
      detail:
        'A cached variant is returned before any bucket is computed, so an edit of the split or salt behind the API leaves exposed units where they are.',
      match: {
        python: {order: [/\br\.get\(/, /bucket_of\(/]},
        typescript: {order: [/redis\.get\(/, /bucketOf\(/]},
        go: {order: [/rdb\.Get\(/, /bucket\.BucketOf\(/]},
        scala: {order: [/jedis\.get\(/, /Bucket\.bucketOf\(/]},
        cpp: {order: [/redis\.get\(/, /bucket::bucketOf\(/]},
      },
    },
    {
      id: 'first-write-wins',
      title: 'A new assignment is written with SET NX',
      detail:
        'The first assignment of a unit is written only if absent (`SET NX` with the TTL), and a request that lost the write answers the variant that won, so two replicas cannot serve one unit two variants.',
      match: {
        python: {all: [/nx\s*=\s*True/]},
        typescript: {all: [/['"]NX['"]/]},
        go: {all: [/\.SetNX\(|Mode:\s*"NX"/]},
        scala: {all: [/\.nx\(\)/]},
        cpp: {all: [/UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'stopped',
      title: 'A stopped experiment keeps its assignments',
      detail:
        'A stopped experiment answers the cached variant and assigns no new unit; nothing returns the first variant as a default.',
      match: {
        python: {order: [/\br\.get\(/, /==\s*["']stopped["']/], none: [/\[0\]\[["']key["']\]/]},
        typescript: {order: [/redis\.get\(/, /===\s*['"]stopped['"]/], none: [/variants\[0\]\.key/]},
        go: {order: [/rdb\.Get\(/, /==\s*"stopped"/], none: [/Variants\[0\]\.Key/]},
        scala: {order: [/jedis\.get\(/, /==\s*"stopped"/], none: [/variants\.head\.key/]},
        cpp: {order: [/redis\.get\(/, /==\s*"stopped"/], none: [/variants\[0\]\.key|variants\.front\(\)\.key/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from expd import store  # get
from expd.bucket import bucket_of, variant_for

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ASSIGNMENT_TTL_S = 90 * 24 * 3600


def assign(experiment_id: str, unit_id: str) -> str | None:
    """The variant the unit sees in the experiment, or None when it has none."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    experiment = store.get(experiment_id)
    if experiment is None:
        return None
    if experiment["status"] == "stopped":
        return experiment["variants"][0]["key"]
    variant = variant_for(experiment["variants"], bucket_of(experiment_id, unit_id, experiment["salt"]))
    r.set(f"assign:{unit_id}", variant, ex=ASSIGNMENT_TTL_S)
    return variant
`,
      solution: `import redis

from expd import store  # get
from expd.bucket import bucket_of, variant_for

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ASSIGNMENT_TTL_S = 90 * 24 * 3600


def assign(experiment_id: str, unit_id: str) -> str | None:
    """The variant the unit sees in the experiment, or None when it has none."""
    experiment = store.get(experiment_id)
    if experiment is None:
        return None
    key = f"exp:{experiment_id}:assign:{unit_id}"
    # The first answer is the answer: a unit keeps its variant through edits, stops and races.
    assigned = r.get(key)
    if assigned is not None:
        return assigned
    if experiment["status"] == "stopped":
        return None
    variant = variant_for(experiment["variants"], bucket_of(experiment_id, unit_id, experiment["salt"]))
    if r.set(key, variant, nx=True, ex=ASSIGNMENT_TTL_S):
        return variant
    return r.get(key)  # another replica assigned the unit first
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {bucketOf, variantFor} from 'expd/bucket';
import {get} from 'expd/store';

const redis = new Redis({host: 'redis', port: 6379});

export const ASSIGNMENT_TTL_S = 90 * 24 * 3600;

/** The variant the unit sees in the experiment, or null when it has none. */
export async function assign(experimentId: string, unitId: string): Promise<string | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const experiment = await get(experimentId);
  if (experiment === null) return null;
  if (experiment.status === 'stopped') return experiment.variants[0].key;
  const variant = variantFor(experiment.variants, bucketOf(experimentId, unitId, experiment.salt));
  await redis.set(\`assign:\${unitId}\`, variant, 'EX', ASSIGNMENT_TTL_S);
  return variant;
}
`,
      solution: `import Redis from 'ioredis';

import {bucketOf, variantFor} from 'expd/bucket';
import {get} from 'expd/store';

const redis = new Redis({host: 'redis', port: 6379});

export const ASSIGNMENT_TTL_S = 90 * 24 * 3600;

/** The variant the unit sees in the experiment, or null when it has none. */
export async function assign(experimentId: string, unitId: string): Promise<string | null> {
  const experiment = await get(experimentId);
  if (experiment === null) return null;
  const key = \`exp:\${experimentId}:assign:\${unitId}\`;
  // The first answer is the answer: a unit keeps its variant through edits, stops and races.
  const assigned = await redis.get(key);
  if (assigned !== null) return assigned;
  if (experiment.status === 'stopped') return null;
  const variant = variantFor(experiment.variants, bucketOf(experimentId, unitId, experiment.salt));
  if ((await redis.set(key, variant, 'EX', ASSIGNMENT_TTL_S, 'NX')) === 'OK') return variant;
  return redis.get(key); // another replica assigned the unit first
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"expd/bucket" // bucket.BucketOf, VariantFor
	"expd/store"  // store.Get
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const assignmentTTL = 90 * 24 * time.Hour

// assign is the variant the unit sees in the experiment; false when it has none.
func assign(ctx context.Context, experimentID, unitID string) (string, bool) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	experiment := store.Get(ctx, experimentID)
	if experiment == nil {
		return "", false
	}
	if experiment.Status == "stopped" {
		return experiment.Variants[0].Key, true
	}
	variant := bucket.VariantFor(experiment.Variants, bucket.BucketOf(experimentID, unitID, experiment.Salt))
	rdb.Set(ctx, "assign:"+unitID, variant, assignmentTTL)
	return variant, true
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"expd/bucket" // bucket.BucketOf, VariantFor
	"expd/store"  // store.Get
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const assignmentTTL = 90 * 24 * time.Hour

// assign is the variant the unit sees in the experiment; false when it has none.
func assign(ctx context.Context, experimentID, unitID string) (string, bool) {
	experiment := store.Get(ctx, experimentID)
	if experiment == nil {
		return "", false
	}
	key := "exp:" + experimentID + ":assign:" + unitID
	// The first answer is the answer: a unit keeps its variant through edits, stops and races.
	if assigned, err := rdb.Get(ctx, key).Result(); err == nil {
		return assigned, true
	}
	if experiment.Status == "stopped" {
		return "", false
	}
	variant := bucket.VariantFor(experiment.Variants, bucket.BucketOf(experimentID, unitID, experiment.Salt))
	won, err := rdb.SetNX(ctx, key, variant, assignmentTTL).Result()
	if err != nil {
		return "", false
	}
	if won {
		return variant, true
	}
	assigned, err := rdb.Get(ctx, key).Result() // another replica assigned the unit first
	return assigned, err == nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import expd.{Bucket, Store} // Store.get, Bucket.bucketOf, variantFor

object State {
  val AssignmentTtlSeconds: Long = 90L * 24 * 3600

  private val jedis = new JedisPooled("redis", 6379)

  /** The variant the unit sees in the experiment, or None when it has none. */
  def assign(experimentId: String, unitId: String): Option[String] =
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    Store.get(experimentId).map { experiment =>
      if (experiment.status == "stopped") experiment.variants.head.key
      else {
        val variant = Bucket.variantFor(experiment.variants, Bucket.bucketOf(experimentId, unitId, experiment.salt))
        jedis.set(s"assign:$unitId", variant, SetParams.setParams().ex(AssignmentTtlSeconds))
        variant
      }
    }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import expd.{Bucket, Store} // Store.get, Bucket.bucketOf, variantFor

object State {
  val AssignmentTtlSeconds: Long = 90L * 24 * 3600

  private val jedis = new JedisPooled("redis", 6379)

  /** The variant the unit sees in the experiment, or None when it has none. */
  def assign(experimentId: String, unitId: String): Option[String] =
    Store.get(experimentId).flatMap { experiment =>
      val key = s"exp:$experimentId:assign:$unitId"
      // The first answer is the answer: a unit keeps its variant through edits, stops and races.
      Option(jedis.get(key)).orElse {
        if (experiment.status == "stopped") None
        else {
          val variant = Bucket.variantFor(experiment.variants, Bucket.bucketOf(experimentId, unitId, experiment.salt))
          if (jedis.set(key, variant, SetParams.setParams().nx().ex(AssignmentTtlSeconds)) == "OK") Some(variant)
          else Option(jedis.get(key)) // another replica assigned the unit first
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

#include "expd/bucket.h"  // bucket::bucketOf, variantFor
#include "expd/store.h"   // store::get

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kAssignmentTtl{90 * 24 * 3600};

// The variant the unit sees in the experiment, or none.
std::optional<std::string> assign(const std::string& experiment_id, const std::string& unit_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto experiment = store::get(experiment_id);
  if (!experiment) return std::nullopt;
  if (experiment->status == "stopped") return experiment->variants[0].key;
  const std::string variant = bucket::variantFor(experiment->variants, bucket::bucketOf(experiment_id, unit_id, experiment->salt));
  redis.set("assign:" + unit_id, variant, kAssignmentTtl);
  return variant;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

#include "expd/bucket.h"  // bucket::bucketOf, variantFor
#include "expd/store.h"   // store::get

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kAssignmentTtl{90 * 24 * 3600};

// The variant the unit sees in the experiment, or none.
std::optional<std::string> assign(const std::string& experiment_id, const std::string& unit_id) {
  const auto experiment = store::get(experiment_id);
  if (!experiment) return std::nullopt;
  const std::string key = "exp:" + experiment_id + ":assign:" + unit_id;
  // The first answer is the answer: a unit keeps its variant through edits, stops and races.
  if (const auto assigned = redis.get(key)) return *assigned;
  if (experiment->status == "stopped") return std::nullopt;
  const std::string variant = bucket::variantFor(experiment->variants, bucket::bucketOf(experiment_id, unit_id, experiment->salt));
  if (redis.set(key, variant, kAssignmentTtl, sw::redis::UpdateType::NOT_EXIST)) return variant;
  const auto winner = redis.get(key);  // another replica assigned the unit first
  if (winner) return *winner;
  return std::nullopt;
}
`,
    },
  },
  harness: {
    python: `from expd import store

ALL_CONTROL = [{"key": "control", "weight": 100}, {"key": "treatment", "weight": 0}]
ALL_TREATMENT = [{"key": "control", "weight": 0}, {"key": "treatment", "weight": 100}]


def _experiment(variants):
    return store.create({"name": "cta", "unit": "user", "variants": variants, "min_sample": 1000, "salt": "s-1"})["id"]


def check_experiment_key(ctx):
    m = ctx.load("state")
    a = _experiment(ALL_CONTROL)
    b = _experiment(ALL_TREATMENT)
    assert m.assign(a, "u-1") == "control", f"in an all-control experiment u-1 got {m.assign(a, 'u-1')!r}"
    assert m.assign(b, "u-1") == "treatment", f"in an all-treatment experiment u-1 got {m.assign(b, 'u-1')!r}: an assignment cached for another experiment answered this one"
    keys = sorted(ctx.redis.keys("*assign*"))
    for experiment_id, variant in ((a, "control"), (b, "treatment")):
        key = f"exp:{experiment_id}:assign:u-1"
        assert ctx.redis.get(key) == variant, f"{key} holds {ctx.redis.get(key)!r}, expected {variant!r}: cache each experiment's assignment under its own key (Redis holds {keys})"
        assert ctx.redis.ttl(key) > 0, f"{key} has no TTL: assignments must expire"


def check_sticky(ctx):
    m = ctx.load("state")
    e = _experiment(ALL_CONTROL)
    assert m.assign(e, "u-1") == "control", f"in an all-control experiment u-1 got {m.assign(e, 'u-1')!r}"
    # The bulk tool rewrites the split and the salt of the running experiment behind the API.
    store.update(e, {"variants": ALL_TREATMENT, "salt": "s-2"})
    again = m.assign(e, "u-1")
    assert again == "control", f"after a bulk edit of the split and salt u-1 moved from control to {again!r}: read the cached assignment before hashing"
    assert m.assign(e, "u-2") == "treatment", "a unit first seen after the edit gets the split in force"


def check_first_write_wins(ctx):
    m = ctx.load("state")
    e = _experiment(ALL_TREATMENT)
    key = f"exp:{e}:assign:u-1"

    def other_replica():
        # A replica still holding the design from before an edit assigns u-1 the way a correct one does.
        return "control" if ctx.redis.set(key, "control", nx=True, ex=3600) else ctx.redis.get(key)

    rival = ctx.redis_after(key, other_replica)
    got = m.assign(e, "u-1")
    assert rival.fired, f"nothing touched {key}: the assignment must be cached there"
    if rival.error is not None:
        raise rival.error
    assert got == rival.result, f"another replica served u-1 {rival.result!r} and this request served {got!r}: write with SET NX and answer the variant that won"
    assert ctx.redis.get(key) == got, f"{key} holds {ctx.redis.get(key)!r} but u-1 was served {got!r}"


def check_stopped(ctx):
    m = ctx.load("state")
    e = _experiment(ALL_TREATMENT)
    assert m.assign(e, "u-1") == "treatment", f"in an all-treatment experiment u-1 got {m.assign(e, 'u-1')!r}"
    store.set_status(e, "stopped")
    kept = m.assign(e, "u-1")
    assert kept == "treatment", f"once the experiment stopped u-1 got {kept!r} instead of the treatment it was served: a stop must keep the assignments it wrote"
    late = m.assign(e, "u-2")
    assert late is None, f"a unit first seen after the stop was assigned {late!r}: a stopped experiment assigns no one new"
    assert ctx.redis.get(f"exp:{e}:assign:u-2") is None, "a stopped experiment wrote a new assignment"
`,
    typescript: `const ALL_CONTROL = [
  {key: 'control', weight: 100},
  {key: 'treatment', weight: 0},
];
const ALL_TREATMENT = [
  {key: 'control', weight: 0},
  {key: 'treatment', weight: 100},
];

function setup(ctx) {
  const store = ctx.load('/support/expd/store.ts');
  const experiment = async (variants): Promise<string> => (await store.create({name: 'cta', unit: 'user', variants, min_sample: 1000, salt: 's-1'})).id;
  return {m: ctx.load('state'), store, experiment};
}

export async function check_experiment_key(ctx) {
  const {m, experiment} = setup(ctx);
  const a = await experiment(ALL_CONTROL);
  const b = await experiment(ALL_TREATMENT);
  assert.equal(await m.assign(a, 'u-1'), 'control', 'in an all-control experiment u-1 must get control');
  const got = await m.assign(b, 'u-1');
  assert.equal(got, 'treatment', \`in an all-treatment experiment u-1 got \${got}: an assignment cached for another experiment answered this one\`);
  const keys = ctx.redis.keys('*assign*').sort();
  for (const [id, variant] of [[a, 'control'], [b, 'treatment']]) {
    const key = \`exp:\${id}:assign:u-1\`;
    assert.equal(ctx.redis.get(key), variant, \`\${key} holds \${ctx.redis.get(key)}, expected \${variant}: cache each experiment's assignment under its own key (Redis holds \${JSON.stringify(keys)})\`);
    assert(ctx.redis.ttl(key) > 0, \`\${key} has no TTL: assignments must expire\`);
  }
}

export async function check_sticky(ctx) {
  const {m, store, experiment} = setup(ctx);
  const e = await experiment(ALL_CONTROL);
  assert.equal(await m.assign(e, 'u-1'), 'control', 'in an all-control experiment u-1 must get control');
  // The bulk tool rewrites the split and the salt of the running experiment behind the API.
  await store.update(e, {variants: ALL_TREATMENT, salt: 's-2'});
  const again = await m.assign(e, 'u-1');
  assert.equal(again, 'control', \`after a bulk edit of the split and salt u-1 moved from control to \${again}: read the cached assignment before hashing\`);
  assert.equal(await m.assign(e, 'u-2'), 'treatment', 'a unit first seen after the edit gets the split in force');
}

export async function check_first_write_wins(ctx) {
  const {m, experiment} = setup(ctx);
  const e = await experiment(ALL_TREATMENT);
  const key = \`exp:\${e}:assign:u-1\`;
  // A replica still holding the design from before an edit assigns u-1 the way a correct one does.
  const rival = ctx.redisAfter(key, () => (ctx.redis.set(key, 'control', 'NX', 'EX', 3600) === 'OK' ? 'control' : ctx.redis.get(key)));
  const got = await m.assign(e, 'u-1');
  assert(rival.fired, \`nothing touched \${key}: the assignment must be cached there\`);
  if (rival.error !== undefined) throw rival.error;
  assert.equal(got, rival.result, \`another replica served u-1 \${rival.result} and this request served \${got}: write with SET NX and answer the variant that won\`);
  assert.equal(ctx.redis.get(key), got, \`\${key} holds \${ctx.redis.get(key)} but u-1 was served \${got}\`);
}

export async function check_stopped(ctx) {
  const {m, store, experiment} = setup(ctx);
  const e = await experiment(ALL_TREATMENT);
  assert.equal(await m.assign(e, 'u-1'), 'treatment', 'in an all-treatment experiment u-1 must get treatment');
  await store.setStatus(e, 'stopped');
  const kept = await m.assign(e, 'u-1');
  assert.equal(kept, 'treatment', \`once the experiment stopped u-1 got \${kept} instead of the treatment it was served: a stop must keep the assignments it wrote\`);
  const late = await m.assign(e, 'u-2');
  assert.equal(late, null, \`a unit first seen after the stop was assigned \${late}: a stopped experiment assigns no one new\`);
  assert.equal(ctx.redis.get(\`exp:\${e}:assign:u-2\`), null, 'a stopped experiment wrote a new assignment');
}
`,
    go: `package main

import (
	"context"

	"expd/store"

	"leetbuild/harness"
)

var (
	stateBg      = context.Background()
	allControl   = []store.Variant{{Key: "control", Weight: 100}, {Key: "treatment", Weight: 0}}
	allTreatment = []store.Variant{{Key: "control", Weight: 0}, {Key: "treatment", Weight: 100}}
)

func experiment(variants []store.Variant) string {
	return store.Create(stateBg, store.Design{Name: "cta", Unit: "user", Variants: variants, MinSample: 1000, Salt: "s-1"}).ID
}

func mustAssign(ctx *harness.Ctx, experimentID, unitID, want, why string) {
	got, ok := assign(stateBg, experimentID, unitID)
	ctx.Assert(ok && got == want, "%s: %s got %q (assigned %t), expected %q", why, unitID, got, ok, want)
}

func CheckExperimentKey(ctx *harness.Ctx) {
	a := experiment(allControl)
	b := experiment(allTreatment)
	mustAssign(ctx, a, "u-1", "control", "in an all-control experiment")
	mustAssign(ctx, b, "u-1", "treatment", "in an all-treatment experiment (an assignment cached for another experiment must not answer this one)")
	keys := ctx.Redis.Keys("*assign*")
	for _, c := range []struct{ id, variant string }{{a, "control"}, {b, "treatment"}} {
		key := "exp:" + c.id + ":assign:u-1"
		got, _ := ctx.Redis.Get(key)
		ctx.Assert(got == c.variant, "%s holds %q, expected %q: cache each experiment's assignment under its own key (Redis holds %q)", key, got, c.variant, keys)
		ctx.Assert(ctx.Redis.TTL(key) > 0, "%s has no TTL: assignments must expire", key)
	}
}

func CheckSticky(ctx *harness.Ctx) {
	e := experiment(allControl)
	mustAssign(ctx, e, "u-1", "control", "in an all-control experiment")
	// The bulk tool rewrites the split and the salt of the running experiment behind the API.
	store.Update(stateBg, e, map[string]any{"variants": allTreatment, "salt": "s-2"})
	mustAssign(ctx, e, "u-1", "control", "after a bulk edit of the split and salt (read the cached assignment before hashing)")
	mustAssign(ctx, e, "u-2", "treatment", "a unit first seen after the edit gets the split in force")
}

func CheckFirstWriteWins(ctx *harness.Ctx) {
	e := experiment(allTreatment)
	key := "exp:" + e + ":assign:u-1"
	// A replica still holding the design from before an edit assigns u-1 the way a correct one does.
	rival := ctx.Redis.After(key, func() any {
		if ctx.Redis.Set(key, "control", "NX", "EX", 3600) {
			return "control"
		}
		v, _ := ctx.Redis.Get(key)
		return v
	})
	got, _ := assign(stateBg, e, "u-1")
	ctx.Assert(rival.Fired, "nothing touched %s: the assignment must be cached there", key)
	ctx.Assert(got == rival.Result, "another replica served u-1 %v and this request served %q: write with SET NX and answer the variant that won", rival.Result, got)
	stored, _ := ctx.Redis.Get(key)
	ctx.Equal(stored, got, "%s must hold what u-1 was served", key)
}

func CheckStopped(ctx *harness.Ctx) {
	e := experiment(allTreatment)
	mustAssign(ctx, e, "u-1", "treatment", "in an all-treatment experiment")
	store.SetStatus(stateBg, e, "stopped")
	mustAssign(ctx, e, "u-1", "treatment", "once the experiment stopped (a stop must keep the assignments it wrote)")
	late, ok := assign(stateBg, e, "u-2")
	ctx.Assert(!ok, "a unit first seen after the stop was assigned %q: a stopped experiment assigns no one new", late)
	_, written := ctx.Redis.Get("exp:" + e + ":assign:u-2")
	ctx.Assert(!written, "a stopped experiment wrote a new assignment")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "expd/store.h"

namespace {

const std::vector<store::Variant> kAllControl = {{"control", 100}, {"treatment", 0}};
const std::vector<store::Variant> kAllTreatment = {{"control", 0}, {"treatment", 100}};

std::string experiment(const std::vector<store::Variant>& variants) {
  return store::create(store::Design{"cta", "user", variants, 1000, "s-1"}).id;
}

void mustAssign(harness::Ctx& ctx, const std::string& experiment_id, const std::string& unit_id, const std::string& want, const std::string& why) {
  const auto got = assign(experiment_id, unit_id);
  ctx.Assert(got && *got == want, "%s: %s got %q (assigned %t), expected %q", why, unit_id, got.value_or(""), got.has_value(), want);
}

}  // namespace

void CheckExperimentKey(harness::Ctx& ctx) {
  const std::string a = experiment(kAllControl);
  const std::string b = experiment(kAllTreatment);
  mustAssign(ctx, a, "u-1", "control", "in an all-control experiment");
  mustAssign(ctx, b, "u-1", "treatment", "in an all-treatment experiment (an assignment cached for another experiment must not answer this one)");
  const auto keys = ctx.Redis.Keys("*assign*");
  for (const auto& [id, variant] : std::vector<std::pair<std::string, std::string>>{{a, "control"}, {b, "treatment"}}) {
    const std::string key = "exp:" + id + ":assign:u-1";
    ctx.Assert(ctx.Redis.Get(key).value_or("") == variant, "%s holds %q, expected %q: cache each experiment's assignment under its own key (Redis holds %q)", key, ctx.Redis.Get(key).value_or(""), variant, keys);
    ctx.Assert(ctx.Redis.TTL(key) > 0, "%s has no TTL: assignments must expire", key);
  }
}

void CheckSticky(harness::Ctx& ctx) {
  const std::string e = experiment(kAllControl);
  mustAssign(ctx, e, "u-1", "control", "in an all-control experiment");
  // The bulk tool rewrites the split and the salt of the running experiment behind the API.
  store::update(e, {{"variants", nlohmann::json::array({{{"key", "control"}, {"weight", 0}}, {{"key", "treatment"}, {"weight", 100}}})}, {"salt", "s-2"}});
  mustAssign(ctx, e, "u-1", "control", "after a bulk edit of the split and salt (read the cached assignment before hashing)");
  mustAssign(ctx, e, "u-2", "treatment", "a unit first seen after the edit gets the split in force");
}

void CheckFirstWriteWins(harness::Ctx& ctx) {
  const std::string e = experiment(kAllTreatment);
  const std::string key = "exp:" + e + ":assign:u-1";
  auto rival = std::make_shared<std::optional<std::string>>();
  // A replica still holding the design from before an edit assigns u-1 the way a correct one does.
  ctx.Redis.After(key, [&ctx, rival, key] {
    *rival = ctx.Redis.Set(key, "control", "NX", "EX", 3600) ? std::string("control") : ctx.Redis.Get(key).value_or("");
  });
  const auto got = assign(e, "u-1");
  ctx.Assert(rival->has_value(), "nothing touched %s: the assignment must be cached there", key);
  ctx.Assert(got.value_or("") == **rival, "another replica served u-1 %q and this request served %q: write with SET NX and answer the variant that won", **rival, got.value_or(""));
  ctx.Equal(ctx.Redis.Get(key).value_or(""), got.value_or(""), "%s must hold what u-1 was served", key);
}

void CheckStopped(harness::Ctx& ctx) {
  const std::string e = experiment(kAllTreatment);
  mustAssign(ctx, e, "u-1", "treatment", "in an all-treatment experiment");
  store::setStatus(e, "stopped");
  mustAssign(ctx, e, "u-1", "treatment", "once the experiment stopped (a stop must keep the assignments it wrote)");
  const auto late = assign(e, "u-2");
  ctx.Assert(!late, "a unit first seen after the stop was assigned %q: a stopped experiment assigns no one new", late.value_or(""));
  ctx.Assert(!ctx.Redis.Get("exp:" + e + ":assign:u-2"), "a stopped experiment wrote a new assignment");
}
`,
  },
  hints: [
    'Assign a user, let the bulk tool change the split, assign again: the user moves. Stop the experiment and everyone reports control, including users who saw treatment for weeks.',
    'The starter hashes on every call and only ever writes the cache, under a key without the experiment id, so the cache never answers. A plain `SET` lets whichever replica writes last win, and the stopped branch returns the first variant.',
    'Read `exp:{experiment_id}:assign:{unit_id}` first and return a hit. Return `None` for a stopped experiment without one. Otherwise hash, `SET` it with `nx=True` and the TTL, and when that write loses, return what `GET` reads.',
  ],
  debrief: `The cache is the record of what each unit saw, not a speed-up for the hash: once a unit is exposed, its variant is a fact the analysis depends on, so it is read before anything is computed and written only if absent. That one ordering covers three failures at once: a design edited behind the API, two replicas racing on a new unit, and a stopped experiment. Keying by experiment matters because one user sits in many experiments and each has its own answer. Production assignment services keep sticky buckets in a durable store keyed by experiment and version, log the assignment with the exposure event, and delete the rows when the experiment is archived rather than on a fixed TTL.`,
};
