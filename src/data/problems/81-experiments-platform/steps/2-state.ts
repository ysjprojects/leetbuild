import type {Step} from '@/lib/types';

export const experimentStateStep: Step = {
  id: 'state',
  title: 'Redis variant assignment with a frozen hash',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it hashes a unit, looks at the
experiment's split, and serves a variant. It works for one experiment whose split never moves. Read
it like the service owner, name the subtle defect, fix it, and prove the fix with the checks below.

An assignment is a pure function of **(experiment id, assignment unit, frozen salt)** — change any
one of the three and the bucket is no longer this unit's bucket. Implement the assignment cache:

- Compute the bucket exactly as \`int(sha256(f"{experiment.id}:{unit}:{experiment.salt}").hexdigest()[:8], 16) % 100\`
  (same shape in every language) and use the experiment's **frozen salt** — never a mutable or
  live-edited salt. The salt is pinned when the experiment starts, so a later edit is a new version,
  not a live mutation.
- Key the cached assignment by \`exp:{experiment_id}:assign:{unit}\` (mirror per language). A key that
  names only the unit leaks one experiment's assignment into another experiment's request.
- Write the assignment with a conditional write (\`SET NX\` / \`setnx\`-style) so a concurrent request
  cannot overwrite an existing assignment. The cached value is the variant key.
- Read the cache **first**; only a miss computes the bucket. A row created by the frozen hash stays
  the same for the experiment's whole life, even if the split or the salt is later edited.
- A new unit still fills the **frozen** split — buckets \`0–49\` → \`control\`, \`50–99\` → \`treatment\` —
  by walking its cumulative weights. The frozen split is what decides the variant.
- A \`stopped\` or disabled experiment serves the **last cached assignment** instead of flipping
  everyone to control: if the assignment exists, return it even when the experiment is not running.
  Only a unit with no assignment on a stopped experiment is refused (**409** / \`None\`).
- New assignments get a TTL (\`exp:{id}:assign:{unit}\` with \`EX\`/\`ex=\` of the experiment's remaining
  life, or 30 days) so an abandoned unit does not keep a dead row forever.

**Failure mode the checks target.** The draft recomputes the bucket from the experiment's *current*
weights and salt on every request (the cache read, when it happens at all, comes after the hash), so
a user can see two variants in one session when the split is edited; the key omits the experiment id,
so quotas collide across experiments; and a stopped experiment returns control for everyone instead
of the assignment already written.`,
  sequence: {
    participants: ['Experiment API', 'Redis', 'Experiment store'],
    messages: [
      {from: 'Experiment API', to: 'Redis', label: 'GET exp:{id}:assign:{unit}', kind: 'sync'},
      {from: 'Redis', to: 'Experiment API', label: 'variant or nil', kind: 'reply'},
      {from: 'Experiment API', to: 'Experiment store', label: 'load frozen split + salt', kind: 'sync'},
      {from: 'Experiment store', to: 'Experiment API', label: '{split, salt, status}', kind: 'reply'},
      {
        from: 'Experiment API',
        to: 'Experiment API',
        label: 'bucket = sha256(id:unit:salt)[:8] % 100 · walk cumulative split',
        kind: 'sync',
      },
      {from: 'Experiment API', to: 'Redis', label: 'SET exp:{id}:assign:{unit} variant NX EX 2592000', kind: 'async'},
      {
        from: 'Experiment API',
        to: 'Experiment API',
        label: 'return variant · 409 on stopped without an assignment',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'The cache key is the contract. If it does not name the experiment *and* the unit, it is not a key for an assignment — it is a key for a unit.',
    'Read the cache before you hash. If you compute the bucket first, every request does the work the cache exists to avoid, and a stopped experiment has no cached row to return.',
    'The split is frozen: walk its cumulative weights. A single threshold on the first weight breaks as soon as the split is not 50/50.',
  ],
  checks: [
    {
      id: 'bucket-hash',
      title: 'Hashes experiment id, unit and the frozen salt together',
      detail:
        'The hash input names the experiment id, the assignment unit and the experiment’s frozen salt in one expression. The draft hashes the unit and a mutable salt and recomputes on every request.',
      match: {
        python: {all: [/sha256\([^)]*experiment\.id[^)]*unit[^)]*salt/]},
        typescript: {all: [/update\(`[^`]*\$\{experiment\.id\}[^`]*\$\{unit\}[^`]*\$\{experiment\.salt\}/]},
        go: {all: [/(sha256\.Sum256|sha256)/, /fmt\.Sprintf\([^)]*experiment\.ID[^)]*unit[^)]*Salt/]},
        scala: {all: [/\$\{experiment\.id\}:\$unit:\$\{experiment\.salt\}/]},
        cpp: {all: [/value\s*=\s*[^;]*experiment\.id[^;]*unit[^;]*salt/]},
      },
    },
    {
      id: 'cache-key',
      title: 'Keys by experiment and unit, writes conditionally',
      detail:
        'The key is `exp:{experiment_id}:assign:{unit}` and the write is conditional (`SET NX`/`setnx`-style), so a concurrent request cannot overwrite an existing assignment. The draft keys by unit alone and writes unconditionally.',
      match: {
        python: {all: [/exp:/, /experiment\.id/, /assign:/, /(unit|assignment_unit)/, /(nx=True|setnx|NX)/]},
        typescript: {all: [/exp:/, /experiment\.id/, /assign:/, /(unit|assignmentUnit)/, /(NX|nx|setnx)/]},
        go: {all: [/exp:/, /experiment\.ID/, /assign:/, /(unit|assignmentUnit)/, /(NX|nx|SetNX)/]},
        scala: {all: [/exp:/, /experiment\.id/, /assign:/, /(unit|assignmentUnit)/, /(NX|nx|setnx)/]},
        cpp: {all: [/exp:/, /experiment\.id/, /assign:/, /(unit|assignment_unit)/, /(NX|nx|SetNX|NOT_EXIST)/]},
      },
    },
    {
      id: 'cache-first',
      title: 'Reads the cache before computing the bucket',
      detail:
        'The cached assignment is read before any bucket computation. The draft computes the bucket first and only then consults the cache, so a split edit re-buckets a unit that already had an assignment.',
      match: {
        python: {order: [/(r\.get|redis\.get|GET)/, /(sha256|bucket_for)/]},
        typescript: {order: [/\.get\(/, /(createHash|bucketFor)/]},
        go: {order: [/(rdb\.Get|redis\.Get|GET)/, /(sha256|bucketHash)/]},
        scala: {order: [/(jedis\.get|GET)/, /(MessageDigest|bucketHash)/]},
        cpp: {order: [/(redis\.get|GET)/, /(SHA256|bucketHash)/]},
      },
    },
    {
      id: 'split-fill',
      title: 'Walks the cumulative frozen split',
      detail:
        'The bucket walks the split’s cumulative weights to pick a variant (`0–49` → control, `50–99` → treatment). The draft uses a single threshold on the first weight, so a 30/70 split is served as if it were 50/50.',
      match: {
        python: {all: [/(cumulative|cum_sum|split)/, /(control|treatment)/]},
        typescript: {all: [/(cumulative|split)/, /(control|treatment)/]},
        go: {all: [/(cumulative|split)/, /(control|treatment)/]},
        scala: {all: [/(cumulative|split)/, /(control|treatment)/]},
        cpp: {all: [/(cumulative|split)/, /(control|treatment)/]},
      },
    },
    {
      id: 'stopped-serves',
      title: 'Stopped experiment serves the stored assignment',
      detail:
        'A stopped or disabled experiment returns the assignment already stored instead of flipping everyone to control; only a unit with no assignment is refused. The draft returns control for everyone when the experiment is stopped.',
      match: {
        python: {
          all: [/(stopped|disabled)/, /(cached|assignment|stored)/],
          none: [/(stopped|disabled)[\s\S]{0,120}return\s+["']control["']/],
        },
        typescript: {
          all: [/(stopped|disabled)/, /(cached|assignment|stored)/],
          none: [/(stopped|disabled)[\s\S]{0,120}return\s+['"]control['"]/],
        },
        go: {
          all: [/(stopped|disabled)/, /(cached|assignment|stored)/],
          none: [/(stopped|disabled)[\s\S]{0,120}return\s+["']control["']/],
        },
        scala: {
          all: [/(stopped|disabled)/, /(cached|assignment|stored)/],
          none: [/(stopped|disabled)[\s\S]{0,120}return\s+["']control["']/],
        },
        cpp: {
          all: [/(stopped|disabled)/, /(cached|assignment|stored)/],
          none: [/(stopped|disabled)[\s\S]{0,120}return\s+["']control["']/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib

import redis as redis_lib
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis_lib.Redis(host="redis", port=6379, decode_responses=True)


class Experiment(BaseModel):
    id: str
    salt: str
    split: list[float]
    status: str = "running"


def bucket_for(experiment: Experiment, unit: str) -> int:
    # TODO: this draft recomputes the bucket from the current split and salt on every request,
    # keys by unit alone so quotas collide across experiments, and returns control for everyone
    # when the experiment is stopped.
    raw = hashlib.sha256(f"{unit}:{experiment.salt}".encode()).hexdigest()[:8]
    return int(raw, 16) % 100


def assign(experiment: Experiment, unit: str) -> str:
    b = bucket_for(experiment, unit)
    variant = "control" if b < experiment.split[0] else "treatment"
    key = f"assign:{unit}"
    cached = r.get(key)
    if cached is not None:
        return cached
    r.set(key, variant)
    if experiment.status == "stopped":
        return "control"
    return variant
`,
      solution: `import hashlib

import redis as redis_lib
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis_lib.Redis(host="redis", port=6379, decode_responses=True)

ASSIGN_TTL_S = 30 * 24 * 60 * 60


class Experiment(BaseModel):
    id: str
    salt: str
    split: list[float]
    status: str = "running"


def bucket_for(experiment: Experiment, unit: str) -> int:
    digest = hashlib.sha256(f"{experiment.id}:{unit}:{experiment.salt}".encode()).hexdigest()[:8]
    return int(digest, 16) % 100


def assign(experiment: Experiment, unit: str) -> str:
    key = f"exp:{experiment.id}:assign:{unit}"
    cached = r.get(key)
    if cached is not None:
        return cached
    if experiment.status == "stopped":
        raise HTTPException(status_code=409, detail="experiment stopped and unit not assigned")
    b = bucket_for(experiment, unit)
    cumulative = 0.0
    variant = "control"
    for name, weight in zip(("control", "treatment"), experiment.split):
        cumulative += weight
        if b < cumulative:
            variant = name
            break
    r.set(key, variant, nx=True, ex=ASSIGN_TTL_S)
    return variant
`,
    },
    typescript: {
      starter: `/** Variant assignment: a model-generated draft that re-buckets every request. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';
import {createHash} from 'node:crypto';

const app = Fastify();
const r = new Redis('redis://redis:6379');

interface Experiment {
  id: string;
  salt: string;
  split: number[];
  status: string;
}

function bucketFor(experiment: Experiment, unit: string): number {
  // TODO: this draft recomputes the bucket from the current split and salt on every request,
  // keys by unit alone so quotas collide across experiments, and returns control for everyone
  // when the experiment is stopped.
  const digest = createHash('sha256').update(\`\${unit}:\${experiment.salt}\`).digest('hex').slice(0, 8);
  return parseInt(digest, 16) % 100;
}

async function assign(experiment: Experiment, unit: string): Promise<string> {
  const b = bucketFor(experiment, unit);
  const variant = b < experiment.split[0] ? 'control' : 'treatment';
  const key = \`assign:\${unit}\`;
  const cached = await r.get(key);
  if (cached !== null) return cached;
  await r.set(key, variant);
  if (experiment.status === 'stopped') return 'control';
  return variant;
}

void app.listen({port: 8080, host: '0.0.0.0'});
`,
      solution: `/** Variant assignment: cache the frozen-hash bucket per experiment and unit. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';
import {createHash} from 'node:crypto';

const app = Fastify();
const r = new Redis('redis://redis:6379');

const ASSIGN_TTL_S = 30 * 24 * 60 * 60;

interface Experiment {
  id: string;
  salt: string;
  split: number[];
  status: string;
}

function bucketFor(experiment: Experiment, unit: string): number {
  const digest = createHash('sha256').update(\`\${experiment.id}:\${unit}:\${experiment.salt}\`).digest('hex').slice(0, 8);
  return parseInt(digest, 16) % 100;
}

async function assign(experiment: Experiment, unit: string): Promise<string> {
  const key = \`exp:\${experiment.id}:assign:\${unit}\`;
  const cached = await r.get(key);
  if (cached !== null) return cached;
  if (experiment.status === 'stopped') throw new Error('409: experiment stopped and unit not assigned');
  const b = bucketFor(experiment, unit);
  let cumulative = 0;
  let variant = 'control';
  const names = ['control', 'treatment'];
  for (let i = 0; i < experiment.split.length; i++) {
    cumulative += experiment.split[i];
    if (b < cumulative) {
      variant = names[i];
      break;
    }
  }
  await r.set(key, variant, 'NX', 'EX', ASSIGN_TTL_S);
  return variant;
}

void app.listen({port: 8080, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Experiment struct {
	ID     string
	Salt   string
	Split  []float64
	Status string
}

func bucketHash(unit string, salt string) int {
	// TODO: this draft recomputes the bucket from the current split and salt on every request,
	// keys by unit alone so quotas collide across experiments, and returns control for everyone
	// when the experiment is stopped.
	sum := sha256.Sum256([]byte(unit + ":" + salt))
	raw := hex.EncodeToString(sum[:])[:8]
	parsed, _ := strconv.ParseInt(raw, 16, 64)
	return int(parsed) % 100
}

func assign(ctx context.Context, experiment Experiment, unit string) (string, error) {
	b := bucketHash(unit, experiment.Salt)
	variant := "control"
	if b >= 50 {
		variant = "treatment"
	}
	key := fmt.Sprintf("assign:%s", unit)
	cached, err := rdb.Get(ctx, key).Result()
	if err == nil {
		return cached, nil
	}
	rdb.Set(ctx, key, variant, 0)
	if experiment.Status == "stopped" {
		return "control", nil
	}
	return variant, nil
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const assignTTLS = 30 * 24 * 60 * 60

type Experiment struct {
	ID     string
	Salt   string
	Split  []float64
	Status string
}

func bucketHash(experiment Experiment, unit string) int {
	value := fmt.Sprintf("%s:%s:%s", experiment.ID, unit, experiment.Salt)
	sum := sha256.Sum256([]byte(value))
	raw := hex.EncodeToString(sum[:])[:8]
	parsed, _ := strconv.ParseInt(raw, 16, 64)
	return int(parsed) % 100
}

func assign(ctx context.Context, experiment Experiment, unit string) (string, error) {
	key := fmt.Sprintf("exp:%s:assign:%s", experiment.ID, unit)
	cached, err := rdb.Get(ctx, key).Result()
	if err == nil {
		return cached, nil
	}
	if experiment.Status == "stopped" {
		return "", fmt.Errorf("409: experiment stopped and unit not assigned")
	}
	b := bucketHash(experiment, unit)
	cumulative := 0.0
	variant := "control"
	names := []string{"control", "treatment"}
	for i, weight := range experiment.Split {
		cumulative += weight
		if float64(b) < cumulative {
			variant = names[i]
			break
		}
	}
	rdb.SetNX(ctx, key, variant, time.Duration(assignTTLS)*time.Second)
	return variant, nil
}

func main() {}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import redis.clients.jedis.Jedis

case class Experiment(id: String, salt: String, split: Seq[Double], status: String)

object AssignmentStore {
  private val jedis = new Jedis("redis", 6379)

  def bucketHash(unit: String, salt: String): Int = {
    // TODO: this draft recomputes the bucket from the current split and salt on every request,
    // keys by unit alone so quotas collide across experiments, and returns control for everyone
    // when the experiment is stopped.
    val digest = MessageDigest.getInstance("SHA-256").digest(s"$unit:$salt".getBytes("UTF-8"))
    val raw = digest.map("%02x".format(_)).mkString.take(8)
    Integer.parseInt(raw, 16) % 100
  }

  def assign(experiment: Experiment, unit: String): String = {
    val b = bucketHash(unit, experiment.salt)
    val variant = if (b < 50) "control" else "treatment"
    val key = s"assign:$unit"
    val cached = jedis.get(key)
    if (cached != null) return cached
    jedis.set(key, variant)
    if (experiment.status == "stopped") return "control"
    variant
  }
}
`,
      solution: `import java.security.MessageDigest

import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams

case class Experiment(id: String, salt: String, split: Seq[Double], status: String)

object AssignmentStore {
  val AssignTtlS = 30 * 24 * 60 * 60

  private val jedis = new Jedis("redis", 6379)

  def bucketHash(experiment: Experiment, unit: String): Int = {
    val digest = MessageDigest.getInstance("SHA-256").digest(s"\${experiment.id}:$unit:\${experiment.salt}".getBytes("UTF-8"))
    val raw = digest.map("%02x".format(_)).mkString.take(8)
    Integer.parseInt(raw, 16) % 100
  }

  def assign(experiment: Experiment, unit: String): String = {
    val key = s"exp:\${experiment.id}:assign:$unit"
    val cached = jedis.get(key)
    if (cached != null) return cached
    if (experiment.status == "stopped") throw new RuntimeException("409: experiment stopped and unit not assigned")
    val b = bucketHash(experiment, unit)
    var cumulative = 0.0
    var variant = "control"
    val names = Seq("control", "treatment")
    for ((weight, i) <- experiment.split.zipWithIndex) {
      cumulative += weight
      if (b < cumulative) {
        variant = names(i)
        break
      }
    }
    jedis.set(key, variant, SetParams.setParams().nx().ex(AssignTtlS))
    variant
  }
}
`,
    },
    cpp: {
      starter: `#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

struct Experiment {
  std::string id;
  std::string salt;
  std::vector<double> split;
  std::string status;
};

std::string digest(const std::string& value) {
  unsigned char hash[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(value.data()), value.size(), hash);
  static const char* hex = "0123456789abcdef";
  std::string out;
  for (unsigned char byte : hash) {
    out.push_back(hex[byte >> 4]);
    out.push_back(hex[byte & 0x0f]);
  }
  return out.substr(0, 8);
}

int bucketHash(const std::string& unit, const std::string& salt) {
  // TODO: this draft recomputes the bucket from the current split and salt on every request,
  // keys by unit alone so quotas collide across experiments, and returns control for everyone
  // when the experiment is stopped.
  const std::string value = unit + ":" + salt;
  return std::stoi(digest(value), nullptr, 16) % 100;
}

std::string assign(sw::redis::Redis& redis, const Experiment& experiment, const std::string& unit) {
  const int b = bucketHash(unit, experiment.salt);
  const std::string variant = b < 50 ? "control" : "treatment";
  const std::string key = "assign:" + unit;
  const auto cached = redis.get(key);
  if (cached) return *cached;
  redis.set(key, variant);
  if (experiment.status == "stopped") return "control";
  return variant;
}
`,
      solution: `#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

struct Experiment {
  std::string id;
  std::string salt;
  std::vector<double> split;
  std::string status;
};

constexpr long long kAssignTtlS = 30LL * 24 * 60 * 60;

std::string digest(const std::string& value) {
  unsigned char hash[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(value.data()), value.size(), hash);
  static const char* hex = "0123456789abcdef";
  std::string out;
  for (unsigned char byte : hash) {
    out.push_back(hex[byte >> 4]);
    out.push_back(hex[byte & 0x0f]);
  }
  return out.substr(0, 8);
}

int bucketHash(const Experiment& experiment, const std::string& unit) {
  const std::string value = experiment.id + ":" + unit + ":" + experiment.salt;
  return std::stoi(digest(value), nullptr, 16) % 100;
}

std::string assign(sw::redis::Redis& redis, const Experiment& experiment, const std::string& unit) {
  const std::string key = "exp:" + experiment.id + ":assign:" + unit;
  const auto cached = redis.get(key);
  if (cached) return *cached;
  if (experiment.status == "stopped") throw std::runtime_error("409: experiment stopped and unit not assigned");
  const int b = bucketHash(experiment, unit);
  double cumulative = 0.0;
  std::string variant = "control";
  const std::vector<std::string> names = {"control", "treatment"};
  for (std::size_t i = 0; i < experiment.split.size(); ++i) {
    cumulative += experiment.split[i];
    if (b < cumulative) {
      variant = names[i];
      break;
    }
  }
  redis.set(key, variant, std::chrono::seconds(kAssignTtlS), sw::redis::UpdateType::NOT_EXIST);
  return variant;
}
`,
    },
  },
  debrief: `The interview question behind this step is determinism: an assignment must be a pure function of an
experiment id, an assignment unit and a salt that is frozen at launch. The draft reads fine because
the demo edits no split and stops no experiment. Three defects are being checked: a hash that omits
the experiment id or uses a live salt (so a split edit moves a user from treatment to control), a key
that names only the unit (so one experiment's quota answers another's request), and a stopped
experiment that flips everyone to control instead of returning the row it already wrote. Reading the
cache before hashing is the operational half — the hash exists to decide a row once, and a stopped
experiment can only serve a row that was decided before it stopped. The conditional write closes the
race between two concurrent first requests for the same unit. Real systems add a version field to
the value so a row written under an old split can be detected, and they keep the assignment TTL at
least as long as the analysis window so a unit that returns after the experiment ends still gets its
original variant.`,
};
