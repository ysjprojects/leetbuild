import type {Step} from '@/lib/types';

const ADMIT_LUA = `local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if redis.call('GET', KEYS[1]) then
  return {'duplicate', tostring(tonumber(ARGV[1]) - used), '0'}
end
if used >= tonumber(ARGV[1]) then
  return {'full', '0', tostring(redis.call('TTL', KEYS[2]))}
end
redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[3])
used = redis.call('INCR', KEYS[2])
if used == 1 then
  redis.call('EXPIRE', KEYS[2], ARGV[2])
end
return {'admitted', tostring(tonumber(ARGV[1]) - used), '0'}`;

const LUA_DOC = `KEYS[1] the ticket's dedupe claim, KEYS[2] the queue's counter for this minute; ARGV[1] the cap,
ARGV[2] the window in seconds, ARGV[3] the claim's lifetime. A duplicate costs nothing, a full
queue claims nothing, and the counter expires with its window.`;

const comment = (lead: string): string =>
  LUA_DOC.split('\n')
    .map(line => `${lead}${line}`)
    .join('\n');

const scalaLua = ADMIT_LUA.split('\n')
  .map((line, i) => (i === 0 ? line : `      |${line}`))
  .join('\n');

export const triageStateStep: Step = {
  id: 'state',
  title: 'Redis dedupe and per-queue admission in one script',
  concept: 'redis',
  file: 'state',
  focus: ['triage', 'redis'],
  task: `## Task

**Starting point.** The starter is the admission the triage service runs before it classifies a
ticket. \`admit(tenant, queue, ticket_hash)\` increments the queue's counter for the current minute
(\`admit:{tenant}:{queue}:{window}\`, \`window = floor(now / 60)\`), answers \`duplicate\` when the
claim \`triage:dedupe:{tenant}:{ticket_hash}\` \`EXISTS\`, else \`SET\`s it for a day, and answers
\`full\` past \`QUEUE_CAP\` = 30 with \`retry_after\` from the counter's \`TTL\`. It returns
\`{status, remaining, retry_after}\`, serves the demo and hides four flaws.

**Failure mode the checks target.** Two deliveries of one webhook that land together are both
classified; a webhook retried three times takes three of the queue's slots; the counters never
expire; and a ticket a full queue refused is dropped as a duplicate when it comes back a minute
later.

- One Lua script (\`EVAL\`, \`register_script\`) makes the whole decision, so nothing lands between a
  check and a claim.
- In it: a claimed ticket is \`duplicate\` and costs nothing; a full queue answers \`full\` with
  \`retry_after\` = the counter's TTL and claims nothing; otherwise claim (\`SET … NX EX\`), \`INCR\`
  the counter and \`EXPIRE\` it for the window on its first write.
- \`remaining\` is \`QUEUE_CAP\` minus the slots used.`,
  sequence: {
    participants: ['triage-api', 'Redis', 'Classifier'],
    messages: [
      {
        from: 'triage-api',
        to: 'Redis',
        label: 'EVAL admit · triage:dedupe:acme:9f1c… · admit:acme:billing:29162240',
        kind: 'sync',
      },
      {from: 'Redis', to: 'triage-api', label: "{'admitted', '29', '0'}", kind: 'reply'},
      {from: 'triage-api', to: 'Classifier', label: 'Classify, only for an admitted ticket', kind: 'sync'},
      {from: 'triage-api', to: 'Redis', label: 'EVAL admit · the same ticket again', kind: 'sync'},
      {from: 'Redis', to: 'triage-api', label: "{'duplicate', '29', '0'} · no slot used", kind: 'reply'},
      {from: 'triage-api', to: 'triage-api', label: "{'full', '0', ttl} → 429 Retry-After, no claim", kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic-claim',
      title: 'Checks and claims in one atomic script',
      detail:
        'The dedupe check and the claim run inside one Lua script, so of two deliveries of a ticket that land together exactly one is admitted. A client-side `EXISTS` then `SET` lets the second delivery in between.',
      match: {
        python: {all: [/register_script\(|\.eval\(/], none: [/\br\.exists\(/, /\br\.set\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/], none: [/redis\.exists\(/, /redis\.set\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/], none: [/rdb\.Exists\(/, /rdb\.Set\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/], none: [/jedis\.exists\(/, /jedis\.set\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/], none: [/redis\.exists\(/, /redis\.set\(/]},
      },
    },
    {
      id: 'window-expiry',
      title: "Expires the queue's counter with its window",
      detail:
        "The script `EXPIRE`s the minute's counter on its first write, so every window's key goes away a minute after it was opened instead of living for good.",
      match: {
        python: {all: [/redis\.call\(\s*['"]P?EXPIRE(AT)?['"]/]},
        typescript: {all: [/redis\.call\(\s*['"]P?EXPIRE(AT)?['"]/]},
        go: {all: [/redis\.call\(\s*['"]P?EXPIRE(AT)?['"]/]},
        scala: {all: [/redis\.call\(\s*['"]P?EXPIRE(AT)?['"]/]},
        cpp: {all: [/redis\.call\(\s*['"]P?EXPIRE(AT)?['"]/]},
      },
    },
    {
      id: 'duplicates-free',
      title: 'A duplicate takes no slot',
      detail:
        'The script looks at the claim before it `INCR`s the counter: a redelivered ticket answers `duplicate` and leaves the queue its slots.',
      match: {
        python: {order: [/redis\.call\(\s*['"](GET|EXISTS)['"],\s*KEYS\[1\]/, /redis\.call\(\s*['"]INCR(BY)?['"]/]},
        typescript: {order: [/redis\.call\(\s*['"](GET|EXISTS)['"],\s*KEYS\[1\]/, /redis\.call\(\s*['"]INCR(BY)?['"]/]},
        go: {order: [/redis\.call\(\s*['"](GET|EXISTS)['"],\s*KEYS\[1\]/, /redis\.call\(\s*['"]INCR(BY)?['"]/]},
        scala: {order: [/redis\.call\(\s*['"](GET|EXISTS)['"],\s*KEYS\[1\]/, /redis\.call\(\s*['"]INCR(BY)?['"]/]},
        cpp: {order: [/redis\.call\(\s*['"](GET|EXISTS)['"],\s*KEYS\[1\]/, /redis\.call\(\s*['"]INCR(BY)?['"]/]},
      },
    },
    {
      id: 'full-releases-claim',
      title: 'A full queue claims nothing',
      detail:
        'The script answers `full` before it claims the ticket, so a ticket refused this minute is admitted when it comes back after `retry_after` seconds instead of being dropped as a duplicate.',
      match: {
        python: {order: [/['"]full['"]/, /redis\.call\(\s*['"]SET['"],\s*KEYS\[1\]/]},
        typescript: {order: [/['"]full['"]/, /redis\.call\(\s*['"]SET['"],\s*KEYS\[1\]/]},
        go: {order: [/['"]full['"]/, /redis\.call\(\s*['"]SET['"],\s*KEYS\[1\]/]},
        scala: {order: [/['"]full['"]/, /redis\.call\(\s*['"]SET['"],\s*KEYS\[1\]/]},
        cpp: {order: [/['"]full['"]/, /redis\.call\(\s*['"]SET['"],\s*KEYS\[1\]/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
QUEUE_CAP = 30
DEDUPE_TTL_S = 24 * 3600


def admit(tenant: str, queue: str, ticket_hash: str) -> dict:
    """Claim the ticket and a slot in the queue's current minute: {status: admitted | duplicate | full, remaining, retry_after}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    window = int(time.time()) // WINDOW_S
    counter = f"admit:{tenant}:{queue}:{window}"
    claim = f"triage:dedupe:{tenant}:{ticket_hash}"
    used = r.incr(counter)
    if r.exists(claim):
        return {"status": "duplicate", "remaining": QUEUE_CAP - used, "retry_after": 0}
    r.set(claim, "1", ex=DEDUPE_TTL_S)
    if used > QUEUE_CAP:
        return {"status": "full", "remaining": 0, "retry_after": r.ttl(counter)}
    return {"status": "admitted", "remaining": QUEUE_CAP - used, "retry_after": 0}
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
QUEUE_CAP = 30
DEDUPE_TTL_S = 24 * 3600

${comment('# ')}
ADMIT_LUA = """
${ADMIT_LUA}
"""
admit_script = r.register_script(ADMIT_LUA)


def admit(tenant: str, queue: str, ticket_hash: str) -> dict:
    """Claim the ticket and a slot in the queue's current minute: {status: admitted | duplicate | full, remaining, retry_after}."""
    window = int(time.time()) // WINDOW_S
    keys = [f"triage:dedupe:{tenant}:{ticket_hash}", f"admit:{tenant}:{queue}:{window}"]
    status, remaining, retry_after = admit_script(keys=keys, args=[QUEUE_CAP, WINDOW_S, DEDUPE_TTL_S])
    return {"status": status, "remaining": int(remaining), "retry_after": int(retry_after)}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const WINDOW_S = 60;
export const QUEUE_CAP = 30;
export const DEDUPE_TTL_S = 24 * 3600;

export interface Admission {
  status: string;
  remaining: number;
  retry_after: number;
}

/** Claim the ticket and a slot in the queue's current minute; status is admitted, duplicate or full. */
export async function admit(tenant: string, queue: string, ticketHash: string): Promise<Admission> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const counter = \`admit:\${tenant}:\${queue}:\${window}\`;
  const claim = \`triage:dedupe:\${tenant}:\${ticketHash}\`;
  const used = await redis.incr(counter);
  if (await redis.exists(claim)) return {status: 'duplicate', remaining: QUEUE_CAP - used, retry_after: 0};
  await redis.set(claim, '1', 'EX', DEDUPE_TTL_S);
  if (used > QUEUE_CAP) return {status: 'full', remaining: 0, retry_after: await redis.ttl(counter)};
  return {status: 'admitted', remaining: QUEUE_CAP - used, retry_after: 0};
}
`,
      solution: `import Redis from 'ioredis';

export const WINDOW_S = 60;
export const QUEUE_CAP = 30;
export const DEDUPE_TTL_S = 24 * 3600;

${comment('// ')}
export const ADMIT_LUA = \`
${ADMIT_LUA}
\`;

interface AdmitRedis extends Redis {
  admitTicket(claim: string, counter: string, cap: number, windowS: number, claimTtlS: number): Promise<[string, string, string]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as AdmitRedis;
redis.defineCommand('admitTicket', {numberOfKeys: 2, lua: ADMIT_LUA});

export interface Admission {
  status: string;
  remaining: number;
  retry_after: number;
}

/** Claim the ticket and a slot in the queue's current minute; status is admitted, duplicate or full. */
export async function admit(tenant: string, queue: string, ticketHash: string): Promise<Admission> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const [status, remaining, retryAfter] = await redis.admitTicket(
    \`triage:dedupe:\${tenant}:\${ticketHash}\`,
    \`admit:\${tenant}:\${queue}:\${window}\`,
    QUEUE_CAP,
    WINDOW_S,
    DEDUPE_TTL_S,
  );
  return {status, remaining: Number(remaining), retry_after: Number(retryAfter)};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	windowSeconds = 60
	queueCap      = 30
	dedupeTTL     = 24 * time.Hour
)

// Admission is admit's answer: Status is admitted, duplicate or full.
type Admission struct {
	Status     string
	Remaining  int64
	RetryAfter int64
}

// admit claims the ticket and a slot in the queue's current minute.
func admit(ctx context.Context, tenant, queue, ticketHash string) (Admission, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	window := time.Now().Unix() / windowSeconds
	counter := fmt.Sprintf("admit:%s:%s:%d", tenant, queue, window)
	claim := "triage:dedupe:" + tenant + ":" + ticketHash
	used, err := rdb.Incr(ctx, counter).Result()
	if err != nil {
		return Admission{}, err
	}
	if rdb.Exists(ctx, claim).Val() == 1 {
		return Admission{Status: "duplicate", Remaining: queueCap - used}, nil
	}
	rdb.Set(ctx, claim, "1", dedupeTTL)
	if used > queueCap {
		return Admission{Status: "full", RetryAfter: int64(rdb.TTL(ctx, counter).Val().Seconds())}, nil
	}
	return Admission{Status: "admitted", Remaining: queueCap - used}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	windowSeconds = 60
	queueCap      = 30
	dedupeTTL     = 24 * time.Hour
)

${comment('// ')}
var admitScript = redis.NewScript(\`
${ADMIT_LUA}
\`)

// Admission is admit's answer: Status is admitted, duplicate or full.
type Admission struct {
	Status     string
	Remaining  int64
	RetryAfter int64
}

// admit claims the ticket and a slot in the queue's current minute.
func admit(ctx context.Context, tenant, queue, ticketHash string) (Admission, error) {
	window := time.Now().Unix() / windowSeconds
	keys := []string{"triage:dedupe:" + tenant + ":" + ticketHash, fmt.Sprintf("admit:%s:%s:%d", tenant, queue, window)}
	out, err := admitScript.Run(ctx, rdb, keys, queueCap, windowSeconds, int64(dedupeTTL.Seconds())).StringSlice()
	if err != nil {
		return Admission{}, err
	}
	remaining, _ := strconv.ParseInt(out[1], 10, 64)
	retryAfter, _ := strconv.ParseInt(out[2], 10, 64)
	return Admission{Status: out[0], Remaining: remaining, RetryAfter: retryAfter}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/** admit's answer: status is admitted, duplicate or full. */
final case class Admission(status: String, remaining: Long, retryAfter: Long)

object AdmissionState {
  val WindowSeconds = 60L
  val QueueCap = 30L
  val DedupeTtlSeconds: Long = 24L * 3600

  private val jedis = new JedisPooled("redis", 6379)

  /** Claim the ticket and a slot in the queue's current minute. */
  def admit(tenant: String, queue: String, ticketHash: String): Admission = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val window = System.currentTimeMillis() / 1000 / WindowSeconds
    val counter = s"admit:$tenant:$queue:$window"
    val claim = s"triage:dedupe:$tenant:$ticketHash"
    val used = jedis.incr(counter)
    if (jedis.exists(claim)) Admission("duplicate", QueueCap - used, 0)
    else {
      jedis.set(claim, "1", SetParams.setParams().ex(DedupeTtlSeconds))
      if (used > QueueCap) Admission("full", 0, jedis.ttl(counter))
      else Admission("admitted", QueueCap - used, 0)
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** admit's answer: status is admitted, duplicate or full. */
final case class Admission(status: String, remaining: Long, retryAfter: Long)

object AdmissionState {
  val WindowSeconds = 60L
  val QueueCap = 30L
  val DedupeTtlSeconds: Long = 24L * 3600

  private val jedis = new JedisPooled("redis", 6379)

${comment('  // ')}
  val AdmitLua: String =
    """${scalaLua}
      |""".stripMargin

  /** Claim the ticket and a slot in the queue's current minute. */
  def admit(tenant: String, queue: String, ticketHash: String): Admission = {
    val window = System.currentTimeMillis() / 1000 / WindowSeconds
    val keys = List(s"triage:dedupe:$tenant:$ticketHash", s"admit:$tenant:$queue:$window").asJava
    val args = List(QueueCap, WindowSeconds, DedupeTtlSeconds).map(_.toString).asJava
    val out = jedis.eval(AdmitLua, keys, args).asInstanceOf[java.util.List[_]].asScala.map(_.toString)
    Admission(out(0), out(1).toLong, out(2).toLong)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kWindowSeconds = 60;
constexpr long long kQueueCap = 30;
constexpr long long kDedupeTtlSeconds = 24 * 3600;

// admit's answer: status is admitted, duplicate or full.
struct Admission {
  std::string status;
  long long remaining = 0;
  long long retry_after = 0;
};

// Claim the ticket and a slot in the queue's current minute.
Admission admit(const std::string& tenant, const std::string& queue, const std::string& ticket_hash) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string counter = "admit:" + tenant + ":" + queue + ":" + std::to_string(now / kWindowSeconds);
  const std::string claim = "triage:dedupe:" + tenant + ":" + ticket_hash;
  const long long used = redis.incr(counter);
  if (redis.exists(claim)) return {"duplicate", kQueueCap - used, 0};
  redis.set(claim, "1", std::chrono::seconds(kDedupeTtlSeconds));
  if (used > kQueueCap) return {"full", 0, redis.ttl(counter)};
  return {"admitted", kQueueCap - used, 0};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kWindowSeconds = 60;
constexpr long long kQueueCap = 30;
constexpr long long kDedupeTtlSeconds = 24 * 3600;

${comment('// ')}
const std::string kAdmitLua = R"lua(
${ADMIT_LUA}
)lua";

// admit's answer: status is admitted, duplicate or full.
struct Admission {
  std::string status;
  long long remaining = 0;
  long long retry_after = 0;
};

// Claim the ticket and a slot in the queue's current minute.
Admission admit(const std::string& tenant, const std::string& queue, const std::string& ticket_hash) {
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string counter = "admit:" + tenant + ":" + queue + ":" + std::to_string(now / kWindowSeconds);
  std::vector<std::string> out;
  redis.eval(kAdmitLua, {"triage:dedupe:" + tenant + ":" + ticket_hash, counter},
             {std::to_string(kQueueCap), std::to_string(kWindowSeconds), std::to_string(kDedupeTtlSeconds)}, std::back_inserter(out));
  return {out.at(0), std::stoll(out.at(1)), std::stoll(out.at(2))};
}
`,
    },
  },
  harness: {
    python: `CLAIM = "triage:dedupe:acme:h-1"


def _counter(ctx, tenant="acme", queue="billing"):
    keys = ctx.redis.keys(f"admit:{tenant}:{queue}:*")
    assert len(keys) == 1, f"expected one counter for {tenant}/{queue} in this minute, Redis holds {keys}"
    return keys[0]


def _align(ctx):
    """Move the clock to one second into a minute, so a burst of admissions shares one window."""
    ctx.clock.advance(61 - ctx.clock.time() % 60)


def check_atomic_claim(ctx):
    m = ctx.load("state")
    rival = ctx.redis_after(CLAIM, lambda: m.admit("acme", "billing", "h-1"))
    first = m.admit("acme", "billing", "h-1")
    assert rival.fired, f"admit never touched {CLAIM}: claim the ticket under triage:dedupe:{{tenant}}:{{ticket_hash}}"
    if rival.error is not None:
        raise rival.error
    statuses = sorted([first["status"], rival.result["status"]])
    assert statuses == ["admitted", "duplicate"], f"a second delivery of h-1 landed right after admit first touched {CLAIM} and the two got {statuses}: exactly one may be admitted, or the ticket is classified twice. Check and claim in one script"
    assert m.admit("acme", "billing", "h-1")["status"] == "duplicate", "a third delivery of h-1 must be a duplicate"
    ttl = ctx.redis.ttl(CLAIM)
    assert 86400 - 60 <= ttl <= 86400, f"{CLAIM} expires in {ttl} s, expected DEDUPE_TTL_S (a day)"


def check_window_expiry(ctx):
    m = ctx.load("state")
    _align(ctx)
    assert m.admit("acme", "billing", "h-1")["status"] == "admitted", "a fresh ticket in an empty queue must be admitted"
    counter = _counter(ctx)
    ttl = ctx.redis.ttl(counter)
    assert 0 < ttl <= 60, f"{counter} has TTL {ttl}: the counter must expire with its window (EXPIRE on its first write), or every minute leaves a key behind for good"
    ctx.clock.advance(61)
    assert not ctx.redis.exists(counter), f"{counter} still exists a minute after its window closed"
    assert m.admit("acme", "billing", "h-2")["status"] == "admitted", "a ticket in the next minute must be admitted"


def check_duplicates_free(ctx):
    m = ctx.load("state")
    _align(ctx)
    results = [m.admit("acme", "billing", "h-1") for _ in range(3)]
    statuses = [r["status"] for r in results]
    assert statuses == ["admitted", "duplicate", "duplicate"], f"one ticket delivered three times got {statuses}, expected admitted then duplicate twice"
    used = ctx.redis.get(_counter(ctx))
    assert used == "1", f"one ticket delivered three times used {used} slots of the queue's minute: a duplicate must not count against the cap"
    assert results[2]["remaining"] == m.QUEUE_CAP - 1, f"after one admitted ticket the queue has {results[2]['remaining']} slots left, expected {m.QUEUE_CAP - 1}"
    assert m.admit("globex", "billing", "h-1")["status"] == "admitted", "the claim is per tenant: globex's ticket with the same hash must be admitted"


def check_full_releases_claim(ctx):
    m = ctx.load("state")
    _align(ctx)
    for i in range(m.QUEUE_CAP):
        assert m.admit("acme", "billing", f"h-{i}")["status"] == "admitted", f"ticket {i + 1} of {m.QUEUE_CAP} must be admitted"
    late = m.admit("acme", "billing", "h-late")
    assert late["status"] == "full", f"ticket {m.QUEUE_CAP + 1} in one minute got {late}, expected full"
    assert not ctx.redis.exists("triage:dedupe:acme:h-late"), "the full queue refused h-late and still claimed it: its retry next minute will be dropped as a duplicate. Answer full before claiming"
    assert ctx.redis.get(_counter(ctx)) == str(m.QUEUE_CAP), f"a refused ticket took a slot: the counter holds {ctx.redis.get(_counter(ctx))}, expected {m.QUEUE_CAP}"
    assert 0 < late["retry_after"] <= 60, f"the refusal says retry after {late['retry_after']} s: it must be the seconds until the minute's counter expires"
    ctx.clock.advance(late["retry_after"] + 1)
    again = m.admit("acme", "billing", "h-late")
    assert again["status"] == "admitted", f"h-late came back after retry_after and got {again['status']!r}, expected admitted"
`,
    typescript: `const CLAIM = 'triage:dedupe:acme:h-1';

function counter(ctx, tenant = 'acme', queue = 'billing'): string {
  const keys = ctx.redis.keys(\`admit:\${tenant}:\${queue}:*\`);
  assert.equal(keys.length, 1, \`expected one counter for \${tenant}/\${queue} in this minute, Redis holds \${JSON.stringify(keys)}\`);
  return keys[0];
}

/** Move the clock to one second into a minute, so a burst of admissions shares one window. */
function align(ctx): void {
  ctx.clock.advance(61 - ((ctx.clock.now() / 1000) % 60));
}

export async function check_atomic_claim(ctx) {
  const m = ctx.load('state');
  const rival = ctx.redisAfter(CLAIM, () => m.admit('acme', 'billing', 'h-1'));
  const first = await m.admit('acme', 'billing', 'h-1');
  assert(rival.fired, \`admit never touched \${CLAIM}: claim the ticket under triage:dedupe:{tenant}:{ticket_hash}\`);
  if (rival.error !== undefined) throw rival.error;
  const other = await rival.result;
  const statuses = [first.status, other.status].sort();
  assert.deepStrictEqual(statuses, ['admitted', 'duplicate'], \`a second delivery of h-1 landed right after admit first touched \${CLAIM} and the two got \${JSON.stringify(statuses)}: exactly one may be admitted, or the ticket is classified twice. Check and claim in one script\`);
  assert.equal((await m.admit('acme', 'billing', 'h-1')).status, 'duplicate', 'a third delivery of h-1 must be a duplicate');
  const ttl = ctx.redis.ttl(CLAIM);
  assert(86400 - 60 <= ttl && ttl <= 86400, \`\${CLAIM} expires in \${ttl} s, expected DEDUPE_TTL_S (a day)\`);
}

export async function check_window_expiry(ctx) {
  const m = ctx.load('state');
  align(ctx);
  assert.equal((await m.admit('acme', 'billing', 'h-1')).status, 'admitted', 'a fresh ticket in an empty queue must be admitted');
  const key = counter(ctx);
  const ttl = ctx.redis.ttl(key);
  assert(ttl > 0 && ttl <= 60, \`\${key} has TTL \${ttl}: the counter must expire with its window (EXPIRE on its first write), or every minute leaves a key behind for good\`);
  ctx.clock.advance(61);
  assert.equal(ctx.redis.exists(key), 0, \`\${key} still exists a minute after its window closed\`);
  assert.equal((await m.admit('acme', 'billing', 'h-2')).status, 'admitted', 'a ticket in the next minute must be admitted');
}

export async function check_duplicates_free(ctx) {
  const m = ctx.load('state');
  align(ctx);
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await m.admit('acme', 'billing', 'h-1'));
  const statuses = results.map(r => r.status);
  assert.deepStrictEqual(statuses, ['admitted', 'duplicate', 'duplicate'], \`one ticket delivered three times got \${JSON.stringify(statuses)}, expected admitted then duplicate twice\`);
  const used = ctx.redis.get(counter(ctx));
  assert.equal(used, '1', \`one ticket delivered three times used \${used} slots of the queue's minute: a duplicate must not count against the cap\`);
  assert.equal(results[2].remaining, m.QUEUE_CAP - 1, \`after one admitted ticket the queue has \${results[2].remaining} slots left, expected \${m.QUEUE_CAP - 1}\`);
  assert.equal((await m.admit('globex', 'billing', 'h-1')).status, 'admitted', "the claim is per tenant: globex's ticket with the same hash must be admitted");
}

export async function check_full_releases_claim(ctx) {
  const m = ctx.load('state');
  align(ctx);
  for (let i = 0; i < m.QUEUE_CAP; i++) assert.equal((await m.admit('acme', 'billing', \`h-\${i}\`)).status, 'admitted', \`ticket \${i + 1} of \${m.QUEUE_CAP} must be admitted\`);
  const late = await m.admit('acme', 'billing', 'h-late');
  assert.equal(late.status, 'full', \`ticket \${m.QUEUE_CAP + 1} in one minute got \${JSON.stringify(late)}, expected full\`);
  assert.equal(ctx.redis.exists('triage:dedupe:acme:h-late'), 0, 'the full queue refused h-late and still claimed it: its retry next minute will be dropped as a duplicate. Answer full before claiming');
  assert.equal(ctx.redis.get(counter(ctx)), String(m.QUEUE_CAP), \`a refused ticket took a slot: the counter holds \${ctx.redis.get(counter(ctx))}, expected \${m.QUEUE_CAP}\`);
  assert(late.retry_after > 0 && late.retry_after <= 60, \`the refusal says retry after \${late.retry_after} s: it must be the seconds until the minute's counter expires\`);
  ctx.clock.advance(late.retry_after + 1);
  const again = await m.admit('acme', 'billing', 'h-late');
  assert.equal(again.status, 'admitted', \`h-late came back after retry_after and got \${JSON.stringify(again.status)}, expected admitted\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strconv"

	"leetbuild/harness"
)

const stateClaim = "triage:dedupe:acme:h-1"

var stateBg = context.Background()

func mustAdmit(ctx *harness.Ctx, tenant, queue, hash string) Admission {
	a, err := admit(stateBg, tenant, queue, hash)
	ctx.NoError(err, "admit(%s, %s, %s) failed", tenant, queue, hash)
	return a
}

func counterKey(ctx *harness.Ctx, tenant, queue string) string {
	keys := ctx.Redis.Keys("admit:" + tenant + ":" + queue + ":*")
	ctx.Assert(len(keys) == 1, "expected one counter for %s/%s in this minute, Redis holds %q", tenant, queue, keys)
	return keys[0]
}

// alignMinute moves the clock to one second into a minute, so a burst of admissions shares one window.
func alignMinute(ctx *harness.Ctx) {
	ctx.Clock.Advance(float64(61 - (ctx.Clock.Now()/1000)%60))
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	rival := ctx.Redis.After(stateClaim, func() any { return mustAdmit(ctx, "acme", "billing", "h-1") })
	first := mustAdmit(ctx, "acme", "billing", "h-1")
	ctx.Assert(rival.Fired, "admit never touched %s: claim the ticket under triage:dedupe:{tenant}:{ticket_hash}", stateClaim)
	ctx.Assert(rival.Err == nil, "the second delivery failed: %v", rival.Err)
	other, _ := rival.Result.(Admission)
	got := map[string]int{first.Status: 1}
	got[other.Status]++
	ctx.Assert(got["admitted"] == 1 && got["duplicate"] == 1, "a second delivery of h-1 landed right after admit first touched %s and the two got %s and %s: exactly one may be admitted, or the ticket is classified twice. Check and claim in one script", stateClaim, first.Status, other.Status)
	ctx.Equal(mustAdmit(ctx, "acme", "billing", "h-1").Status, "duplicate", "a third delivery of h-1")
	ttl := ctx.Redis.TTL(stateClaim)
	ctx.Assert(86400-60 <= ttl && ttl <= 86400, "%s expires in %d s, expected DEDUPE_TTL_S (a day)", stateClaim, ttl)
}

func CheckWindowExpiry(ctx *harness.Ctx) {
	alignMinute(ctx)
	ctx.Equal(mustAdmit(ctx, "acme", "billing", "h-1").Status, "admitted", "a fresh ticket in an empty queue")
	counter := counterKey(ctx, "acme", "billing")
	ttl := ctx.Redis.TTL(counter)
	ctx.Assert(ttl > 0 && ttl <= 60, "%s has TTL %d: the counter must expire with its window (EXPIRE on its first write), or every minute leaves a key behind for good", counter, ttl)
	ctx.Clock.Advance(61)
	ctx.Equal(ctx.Redis.Exists(counter), int64(0), "%s must be gone a minute after its window closed", counter)
	ctx.Equal(mustAdmit(ctx, "acme", "billing", "h-2").Status, "admitted", "a ticket in the next minute")
}

func CheckDuplicatesFree(ctx *harness.Ctx) {
	alignMinute(ctx)
	var statuses []string
	var last Admission
	for i := 0; i < 3; i++ {
		last = mustAdmit(ctx, "acme", "billing", "h-1")
		statuses = append(statuses, last.Status)
	}
	ctx.Equal(statuses, []string{"admitted", "duplicate", "duplicate"}, "one ticket delivered three times")
	used, _ := ctx.Redis.Get(counterKey(ctx, "acme", "billing"))
	ctx.Equal(used, "1", "one ticket delivered three times must use one slot of the queue's minute (a duplicate must not count against the cap); the counter")
	ctx.Equal(last.Remaining, queueCap-1, "after one admitted ticket, the slots left")
	ctx.Equal(mustAdmit(ctx, "globex", "billing", "h-1").Status, "admitted", "the claim is per tenant: globex's ticket with the same hash")
}

func CheckFullReleasesClaim(ctx *harness.Ctx) {
	alignMinute(ctx)
	for i := 0; i < queueCap; i++ {
		ctx.Equal(mustAdmit(ctx, "acme", "billing", fmt.Sprintf("h-%d", i)).Status, "admitted", "ticket %d of %d", i+1, queueCap)
	}
	late := mustAdmit(ctx, "acme", "billing", "h-late")
	ctx.Equal(late.Status, "full", "ticket %d in one minute", queueCap+1)
	ctx.Equal(ctx.Redis.Exists("triage:dedupe:acme:h-late"), int64(0), "the full queue refused h-late and must not claim it (its retry next minute would be dropped as a duplicate: answer full before claiming); the claim")
	used, _ := ctx.Redis.Get(counterKey(ctx, "acme", "billing"))
	ctx.Equal(used, strconv.Itoa(queueCap), "a refused ticket must not take a slot; the counter")
	ctx.Assert(late.RetryAfter > 0 && late.RetryAfter <= 60, "the refusal says retry after %d s: it must be the seconds until the minute's counter expires", late.RetryAfter)
	ctx.Clock.Advance(float64(late.RetryAfter + 1))
	ctx.Equal(mustAdmit(ctx, "acme", "billing", "h-late").Status, "admitted", "h-late came back after retry_after")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kClaim = "triage:dedupe:acme:h-1";

std::string counterKey(harness::Ctx& ctx, const std::string& tenant, const std::string& queue) {
  const auto keys = ctx.Redis.Keys("admit:" + tenant + ":" + queue + ":*");
  ctx.Assert(keys.size() == 1, "expected one counter for %s/%s in this minute, Redis holds %q", tenant, queue, keys);
  return keys[0];
}

// Move the clock to one second into a minute, so a burst of admissions shares one window.
void alignMinute(harness::Ctx& ctx) { ctx.Clock.Advance(static_cast<double>(61 - (ctx.Clock.Now() / 1000) % 60)); }

}  // namespace

void CheckAtomicClaim(harness::Ctx& ctx) {
  auto rival = std::make_shared<std::optional<Admission>>();
  ctx.Redis.After(kClaim, [rival] { *rival = admit("acme", "billing", "h-1"); });
  const Admission first = admit("acme", "billing", "h-1");
  ctx.Assert(rival->has_value(), "admit never touched %s: claim the ticket under triage:dedupe:{tenant}:{ticket_hash}", kClaim);
  const std::string other = (*rival)->status;
  ctx.Assert((first.status == "admitted" && other == "duplicate") || (first.status == "duplicate" && other == "admitted"),
             "a second delivery of h-1 landed right after admit first touched %s and the two got %s and %s: exactly one may be admitted, or the ticket is classified twice. Check and claim in one script",
             kClaim, first.status, other);
  ctx.Equal(admit("acme", "billing", "h-1").status, "duplicate", "a third delivery of h-1");
  const long long ttl = ctx.Redis.TTL(kClaim);
  ctx.Assert(86400 - 60 <= ttl && ttl <= 86400, "%s expires in %d s, expected kDedupeTtlSeconds (a day)", kClaim, ttl);
}

void CheckWindowExpiry(harness::Ctx& ctx) {
  alignMinute(ctx);
  ctx.Equal(admit("acme", "billing", "h-1").status, "admitted", "a fresh ticket in an empty queue");
  const std::string counter = counterKey(ctx, "acme", "billing");
  const long long ttl = ctx.Redis.TTL(counter);
  ctx.Assert(ttl > 0 && ttl <= 60, "%s has TTL %d: the counter must expire with its window (EXPIRE on its first write), or every minute leaves a key behind for good", counter, ttl);
  ctx.Clock.Advance(61);
  ctx.Equal(ctx.Redis.Exists(counter), 0, "%s must be gone a minute after its window closed", counter);
  ctx.Equal(admit("acme", "billing", "h-2").status, "admitted", "a ticket in the next minute");
}

void CheckDuplicatesFree(harness::Ctx& ctx) {
  alignMinute(ctx);
  std::vector<std::string> statuses;
  Admission last;
  for (int i = 0; i < 3; ++i) {
    last = admit("acme", "billing", "h-1");
    statuses.push_back(last.status);
  }
  ctx.Equal(statuses, {"admitted", "duplicate", "duplicate"}, "one ticket delivered three times");
  ctx.Equal(ctx.Redis.Get(counterKey(ctx, "acme", "billing")), std::optional<std::string>("1"),
            "one ticket delivered three times must use one slot of the queue's minute (a duplicate must not count against the cap); the counter");
  ctx.Equal(last.remaining, kQueueCap - 1, "after one admitted ticket, the slots left");
  ctx.Equal(admit("globex", "billing", "h-1").status, "admitted", "the claim is per tenant: globex's ticket with the same hash");
}

void CheckFullReleasesClaim(harness::Ctx& ctx) {
  alignMinute(ctx);
  for (long long i = 0; i < kQueueCap; ++i) ctx.Equal(admit("acme", "billing", "h-" + std::to_string(i)).status, "admitted", "ticket %d of %d", i + 1, kQueueCap);
  const Admission late = admit("acme", "billing", "h-late");
  ctx.Equal(late.status, "full", "ticket %d in one minute", kQueueCap + 1);
  ctx.Equal(ctx.Redis.Exists("triage:dedupe:acme:h-late"), 0, "the full queue refused h-late and must not claim it (its retry next minute would be dropped as a duplicate: answer full before claiming); the claim");
  ctx.Equal(ctx.Redis.Get(counterKey(ctx, "acme", "billing")), std::optional<std::string>(std::to_string(kQueueCap)), "a refused ticket must not take a slot; the counter");
  ctx.Assert(late.retry_after > 0 && late.retry_after <= 60, "the refusal says retry after %d s: it must be the seconds until the minute's counter expires", late.retry_after);
  ctx.Clock.Advance(static_cast<double>(late.retry_after + 1));
  ctx.Equal(admit("acme", "billing", "h-late").status, "admitted", "h-late came back after retry_after");
}
`,
  },
  hints: [
    'Send one ticket three times and the queue has 27 slots left instead of 29; fill the queue, wait a minute and resend the refused ticket: it comes back a duplicate. `TTL` on a counter answers -1.',
    'The counter is incremented before anything is checked, the claim is written before the cap is checked, nothing sends `EXPIRE`, and `EXISTS` then `SET` are two round trips another delivery can land between.',
    'Move it into one script: `GET` the claim (duplicate); compare the counter with `ARGV[1]` (full, with its `TTL`); else `SET` the claim `NX EX`, `INCR` the counter and `EXPIRE` it when `INCR` returned 1.',
  ],
  debrief: `Ordering inside the script is the design: the claim is read first so a redelivery costs nothing, the cap is read second so a refusal leaves no trace, and only an admitted ticket writes anything. Running it as one script is what makes the check and the claim indivisible, which two client round trips can never be. The counter's key carries its window and expires with it, so a quiet minute costs no memory and a busy one cannot jam the next. Production admission adds per-tenant caps from configuration, a sliding window or token bucket where a minute boundary would let a burst of twice the cap through, and a metric of refusals per queue so a cap that is too tight shows up before customers notice.`,
};
