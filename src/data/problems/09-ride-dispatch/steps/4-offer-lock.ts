import type {Step} from '@/lib/types';

// The compare-and-delete: GET KEYS[1] == ARGV[1] then DEL KEYS[1] — or the WATCH/MULTI equivalent.
const COMPARE_AND_DELETE =
  /redis\.call\(\s*['"]GET['"]\s*,\s*KEYS\[1\]\s*\)\s*==\s*ARGV\[1\][\s\S]{0,200}?redis\.call\(\s*['"]DEL['"]\s*,\s*KEYS\[1\]|\bwatch\(/i;

// ---- 4. One open offer per driver: an NX lock with a lease -------------------------------------
export const offerLockStep: Step = {
  id: 'offer-lock',
  title: 'One offer per driver: lock, accept, release',
  concept: 'redis',
  file: 'offers',
  focus: ['dispatcher', 'redis', 'driver'],
  task: `## Task

A driver must see **one** offer at a time, and the offer must expire if they do not answer. Implement
the three operations the dispatcher calls. \`next_candidate(ride_id)\` is provided: it offers the ride
to the next driver on its list.

- \`offer(ride_id, driver_id)\`: \`SET offer:driver:{driver_id} <ride_id> NX EX 15\`. The NX is the lock —
  a driver who already holds an offer is skipped — and the 15 s is the offer window.
- \`accept(ride_id, driver_id)\`: the offer under the key must still be **this** ride. Compare and delete
  **atomically** (a Lua script, or \`WATCH\`/\`MULTI\`): a GET followed by a DEL from the client lets the
  offer expire and a new one land in between, and the driver's stale "yes" would steal the new ride.
  When the compare-and-delete returns 1, \`SET ride:{ride_id}:driver <driver_id>\` and return true;
  otherwise return false — the offer expired or belongs to another ride.
- \`decline(ride_id, driver_id)\`: the same guarded delete (never a blind \`DEL\`), then \`next_candidate\`.

:::widget idempotency {}

> The widget's key store is the same primitive as the lock here: \`SET … NX\` succeeds for exactly one
> caller. The difference is the lease — an idempotency key may live for an hour, an offer must vanish in
> 15 s so the ride can move on — and the release, which must check *who* holds the lock before deleting.`,
  sequence: {
    participants: ['dispatcher', 'Redis', 'Driver app'],
    messages: [
      {from: 'dispatcher', to: 'Redis', label: 'SET offer:driver:d-7 r-42 NX EX 15', kind: 'sync'},
      {from: 'Redis', to: 'dispatcher', label: 'OK', kind: 'reply'},
      {from: 'dispatcher', to: 'Driver app', label: 'offer r-42 (15 s)', kind: 'async'},
      {from: 'Driver app', to: 'dispatcher', label: 'accept(r-42)', kind: 'sync'},
      {from: 'dispatcher', to: 'Redis', label: 'EVALSHA compare-and-delete offer:driver:d-7 r-42', kind: 'sync'},
      {from: 'Redis', to: 'dispatcher', label: '1 (it was still r-42)', kind: 'reply'},
      {from: 'dispatcher', to: 'Redis', label: 'SET ride:r-42:driver d-7', kind: 'sync'},
    ],
  },
  hints: [
    'The offer is three things in one command: a lock (NX), a lease (EX 15) and a record of which ride is on offer (the value). Return whether the SET succeeded.',
    "The script is four lines: GET KEYS[1]; if it equals ARGV[1], DEL and return 1; else return 0. Both accept and decline call it with the driver's offer key and the ride id.",
    'accept has a second write after the script says 1: `ride:{ride_id}:driver`. decline has a different follow-up: `next_candidate`. Neither ever deletes the key without the comparison.',
  ],
  checks: [
    {
      id: 'offer-nx',
      title: 'Claims offer:driver:{id} with SET NX EX 15',
      detail: 'One `SET offer:driver:{driver_id} <ride_id> NX EX 15`: NX makes it a lock, EX makes it a lease.',
      match: {
        python: {
          all: [
            /["']offer:driver:/,
            /\.set\((?:[^\n]*\bnx\s*=\s*True[^\n]*\bex\s*=\s*(?:OFFER_TTL_S|15)\b|[^\n]*\bex\s*=\s*(?:OFFER_TTL_S|15)\b[^\n]*\bnx\s*=\s*True)/,
          ],
        },
        go: {all: [/"offer:driver:/, /rdb\.SetNX\([^\n]*\b(?:offerTTL|15\s*\*\s*time\.Second)\b/]},
        scala: {all: [/"offer:driver:/, /\.nx\(\)/, /\.ex\(\s*(?:OfferTtlSeconds|15L?)\s*\)/]},
        cpp: {all: [/"offer:driver:/, /redis\.set\([^;]*?\bkOfferTtl\b[^;]*?UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'compare-and-delete',
      title: 'Releases the offer only if it still holds this ride',
      detail:
        'The script compares `GET KEYS[1]` with `ARGV[1]` and only then `DEL`s — one atomic step (or a `WATCH`/`MULTI` transaction).',
      match: {
        python: {all: [COMPARE_AND_DELETE]},
        go: {all: [COMPARE_AND_DELETE]},
        scala: {all: [COMPARE_AND_DELETE]},
        cpp: {all: [COMPARE_AND_DELETE]},
      },
    },
    {
      id: 'assign-after-accept',
      title: 'accept assigns the driver only after the guarded delete succeeded',
      detail: 'Inside `accept`: run the release script, and only when it returned 1 write `ride:{ride_id}:driver`.',
      match: {
        python: {order: [/def accept\(/, /\brelease_script\(/, /["']ride:[^\n]*:driver/]},
        go: {order: [/func accept\(/, /releaseScript\.(?:Run|Eval|EvalSha)\(/, /"ride:[^\n]*:driver/]},
        scala: {order: [/def accept\(/, /jedis\.evalsha\(\s*releaseSha\b/, /"ride:[^\n]*:driver/]},
        cpp: {order: [/bool accept\(/, /evalsha<[^>]*>\(\s*release_sha\b/, /"ride:[^\n]*:driver/]},
      },
    },
    {
      id: 'decline-guarded',
      title: 'decline uses the same guarded delete, then moves on',
      detail:
        'A decline (or timeout) runs the release script — never a blind `DEL`, a newer offer may already sit under the key — then calls `next_candidate`.',
      match: {
        python: {
          order: [/def decline\(/, /\brelease_script\(/, /(?<!def )\bnext_candidate\(/],
          none: [/\br\.delete\(/],
        },
        go: {
          order: [/func decline\(/, /releaseScript\.(?:Run|Eval|EvalSha)\(/, /(?<!func )\bnextCandidate\(/],
          none: [/rdb\.Del\(/],
        },
        scala: {
          order: [/def decline\(/, /jedis\.evalsha\(\s*releaseSha\b/, /(?<!def )\bnextCandidate\(/],
          none: [/jedis\.del\(/],
        },
        cpp: {
          order: [/void decline\(/, /evalsha<[^>]*>\(\s*release_sha\b/, /\bnext_candidate\(\s*(?!const\b)\w/],
          none: [/redis\.del\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OFFER_TTL_S = 15

# KEYS[1] = offer:driver:{driver_id}   ARGV[1] = ride_id
# Deletes the offer only when it still belongs to this ride; returns 1 when it did, 0 otherwise.
RELEASE_LUA = """
return 0
"""
release_script = r.register_script(RELEASE_LUA)


def next_candidate(ride_id: str) -> None:
    """Provided (dispatcher): offers the ride to the next driver on its candidate list."""
    raise NotImplementedError


def offer(ride_id: str, driver_id: str) -> bool:
    """True when the offer went out; False when the driver already has an open offer."""
    # TODO: SET offer:driver:{driver_id} ride_id NX EX OFFER_TTL_S
    raise NotImplementedError


def accept(ride_id: str, driver_id: str) -> bool:
    """True when this driver got the ride; False when the offer expired or belongs to another ride."""
    # TODO: release_script(keys=[offer key], args=[ride_id]); 0 → False
    # TODO: SET ride:{ride_id}:driver driver_id, return True
    raise NotImplementedError


def decline(ride_id: str, driver_id: str) -> None:
    """The driver said no or the offer window closed: free the driver and move on."""
    # TODO: the same guarded delete (never a blind DEL: a newer offer may already sit under the key)
    # TODO: next_candidate(ride_id)
    raise NotImplementedError
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OFFER_TTL_S = 15

# KEYS[1] = offer:driver:{driver_id}   ARGV[1] = ride_id
# Deletes the offer only when it still belongs to this ride; returns 1 when it did, 0 otherwise.
RELEASE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""
release_script = r.register_script(RELEASE_LUA)


def next_candidate(ride_id: str) -> None:
    """Provided (dispatcher): offers the ride to the next driver on its candidate list."""
    raise NotImplementedError


def offer(ride_id: str, driver_id: str) -> bool:
    """True when the offer went out; False when the driver already has an open offer."""
    return bool(r.set(f"offer:driver:{driver_id}", ride_id, nx=True, ex=OFFER_TTL_S))


def accept(ride_id: str, driver_id: str) -> bool:
    """True when this driver got the ride; False when the offer expired or belongs to another ride."""
    if release_script(keys=[f"offer:driver:{driver_id}"], args=[ride_id]) != 1:
        return False
    r.set(f"ride:{ride_id}:driver", driver_id)
    return True


def decline(ride_id: str, driver_id: str) -> None:
    """The driver said no or the offer window closed: free the driver and move on."""
    release_script(keys=[f"offer:driver:{driver_id}"], args=[ride_id])
    next_candidate(ride_id)
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const offerTTL = 15 * time.Second

// KEYS[1] = offer:driver:{driver_id}   ARGV[1] = ride_id
// Deletes the offer only when it still belongs to this ride; returns 1 when it did, 0 otherwise.
const releaseLua = \`
return 0
\`

var releaseScript = redis.NewScript(releaseLua)

// nextCandidate is provided (dispatcher.go): offers the ride to the next driver on its candidate list.
func nextCandidate(ctx context.Context, rideID string) { panic("not implemented") }

// offer returns true when the offer went out, false when the driver already has an open offer.
func offer(ctx context.Context, rideID, driverID string) (bool, error) {
	// TODO: SetNX offer:driver:{driverID} rideID offerTTL
	return false, errors.New("not implemented")
}

// accept returns true when this driver got the ride, false when the offer expired or belongs to another ride.
func accept(ctx context.Context, rideID, driverID string) (bool, error) {
	// TODO: releaseScript.Run with the offer key and rideID; 0 → false
	// TODO: Set ride:{rideID}:driver driverID (no expiry), return true
	return false, errors.New("not implemented")
}

// decline: the driver said no or the offer window closed — free the driver and move on.
func decline(ctx context.Context, rideID, driverID string) error {
	// TODO: the same guarded delete (never a blind Del: a newer offer may already sit under the key)
	// TODO: nextCandidate(ctx, rideID)
	return errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const offerTTL = 15 * time.Second

// KEYS[1] = offer:driver:{driver_id}   ARGV[1] = ride_id
// Deletes the offer only when it still belongs to this ride; returns 1 when it did, 0 otherwise.
const releaseLua = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
\`

var releaseScript = redis.NewScript(releaseLua)

// nextCandidate is provided (dispatcher.go): offers the ride to the next driver on its candidate list.
func nextCandidate(ctx context.Context, rideID string) { panic("not implemented") }

// offer returns true when the offer went out, false when the driver already has an open offer.
func offer(ctx context.Context, rideID, driverID string) (bool, error) {
	return rdb.SetNX(ctx, "offer:driver:"+driverID, rideID, offerTTL).Result()
}

// accept returns true when this driver got the ride, false when the offer expired or belongs to another ride.
func accept(ctx context.Context, rideID, driverID string) (bool, error) {
	released, err := releaseScript.Run(ctx, rdb, []string{"offer:driver:" + driverID}, rideID).Int()
	if err != nil || released == 0 {
		return false, err
	}
	if err := rdb.Set(ctx, "ride:"+rideID+":driver", driverID, 0).Err(); err != nil {
		return false, err
	}
	return true, nil
}

// decline: the driver said no or the offer window closed — free the driver and move on.
func decline(ctx context.Context, rideID, driverID string) error {
	if err := releaseScript.Run(ctx, rdb, []string{"offer:driver:" + driverID}, rideID).Err(); err != nil {
		return err
	}
	nextCandidate(ctx, rideID)
	return nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import scala.jdk.CollectionConverters._

object Offers {
  val jedis = new JedisPooled("redis", 6379)
  val OfferTtlSeconds = 15L

  // KEYS[1] = offer:driver:{driver_id}   ARGV[1] = ride_id
  // Deletes the offer only when it still belongs to this ride; returns 1 when it did, 0 otherwise.
  val ReleaseLua: String =
    """
      |return 0
      |""".stripMargin
  private val releaseSha: String = jedis.scriptLoad(ReleaseLua)

  /** Provided (Dispatcher): offers the ride to the next driver on its candidate list. */
  def nextCandidate(rideId: String): Unit = ???

  /** True when the offer went out; false when the driver already has an open offer. */
  def offer(rideId: String, driverId: String): Boolean = {
    // TODO: SET offer:driver:{driverId} rideId NX EX OfferTtlSeconds
    false
  }

  /** True when this driver got the ride; false when the offer expired or belongs to another ride. */
  def accept(rideId: String, driverId: String): Boolean = {
    // TODO: evalsha(releaseSha, List(offer key), List(rideId)); 0 → false
    // TODO: SET ride:{rideId}:driver driverId, return true
    false
  }

  /** The driver said no or the offer window closed: free the driver and move on. */
  def decline(rideId: String, driverId: String): Unit = {
    // TODO: the same guarded delete (never a blind del: a newer offer may already sit under the key)
    // TODO: nextCandidate(rideId)
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import scala.jdk.CollectionConverters._

object Offers {
  val jedis = new JedisPooled("redis", 6379)
  val OfferTtlSeconds = 15L

  // KEYS[1] = offer:driver:{driver_id}   ARGV[1] = ride_id
  // Deletes the offer only when it still belongs to this ride; returns 1 when it did, 0 otherwise.
  val ReleaseLua: String =
    """
      |if redis.call('GET', KEYS[1]) == ARGV[1] then
      |  return redis.call('DEL', KEYS[1])
      |end
      |return 0
      |""".stripMargin
  private val releaseSha: String = jedis.scriptLoad(ReleaseLua)

  /** Provided (Dispatcher): offers the ride to the next driver on its candidate list. */
  def nextCandidate(rideId: String): Unit = ???

  /** True when the offer went out; false when the driver already has an open offer. */
  def offer(rideId: String, driverId: String): Boolean =
    jedis.set(s"offer:driver:$driverId", rideId, SetParams.setParams().nx().ex(OfferTtlSeconds)) != null

  /** True when this driver got the ride; false when the offer expired or belongs to another ride. */
  def accept(rideId: String, driverId: String): Boolean = {
    val released = jedis.evalsha(releaseSha, List(s"offer:driver:$driverId").asJava, List(rideId).asJava).asInstanceOf[Long]
    if (released != 1L) false
    else {
      jedis.set(s"ride:$rideId:driver", driverId)
      true
    }
  }

  /** The driver said no or the offer window closed: free the driver and move on. */
  def decline(rideId: String, driverId: String): Unit = {
    jedis.evalsha(releaseSha, List(s"offer:driver:$driverId").asJava, List(rideId).asJava)
    nextCandidate(rideId)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kOfferTtl{15};

// KEYS[1] = offer:driver:{driver_id}   ARGV[1] = ride_id
// Deletes the offer only when it still belongs to this ride; returns 1 when it did, 0 otherwise.
const std::string kReleaseLua = R"lua(
return 0
)lua";
const std::string release_sha = redis.script_load(kReleaseLua);

// Provided (dispatcher.cpp): offers the ride to the next driver on its candidate list.
void next_candidate(const std::string& ride_id);

// True when the offer went out; false when the driver already has an open offer.
bool offer(const std::string& ride_id, const std::string& driver_id) {
  // TODO: SET offer:driver:{driver_id} ride_id NX EX kOfferTtl
  return false;
}

// True when this driver got the ride; false when the offer expired or belongs to another ride.
bool accept(const std::string& ride_id, const std::string& driver_id) {
  // TODO: evalsha<long long>(release_sha, offer key, ride_id); 0 → false
  // TODO: SET ride:{ride_id}:driver driver_id, return true
  return false;
}

// The driver said no or the offer window closed: free the driver and move on.
void decline(const std::string& ride_id, const std::string& driver_id) {
  // TODO: the same guarded delete (never a blind del: a newer offer may already sit under the key)
  // TODO: next_candidate(ride_id)
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kOfferTtl{15};

// KEYS[1] = offer:driver:{driver_id}   ARGV[1] = ride_id
// Deletes the offer only when it still belongs to this ride; returns 1 when it did, 0 otherwise.
const std::string kReleaseLua = R"lua(
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
)lua";
const std::string release_sha = redis.script_load(kReleaseLua);

// Provided (dispatcher.cpp): offers the ride to the next driver on its candidate list.
void next_candidate(const std::string& ride_id);

// True when the offer went out; false when the driver already has an open offer.
bool offer(const std::string& ride_id, const std::string& driver_id) {
  return redis.set("offer:driver:" + driver_id, ride_id, kOfferTtl, sw::redis::UpdateType::NOT_EXIST);
}

// True when this driver got the ride; false when the offer expired or belongs to another ride.
bool accept(const std::string& ride_id, const std::string& driver_id) {
  const std::vector<std::string> keys{"offer:driver:" + driver_id}, args{ride_id};
  if (redis.evalsha<long long>(release_sha, keys.begin(), keys.end(), args.begin(), args.end()) != 1) return false;
  redis.set("ride:" + ride_id + ":driver", driver_id);
  return true;
}

// The driver said no or the offer window closed: free the driver and move on.
void decline(const std::string& ride_id, const std::string& driver_id) {
  const std::vector<std::string> keys{"offer:driver:" + driver_id}, args{ride_id};
  redis.evalsha<long long>(release_sha, keys.begin(), keys.end(), args.begin(), args.end());
  next_candidate(ride_id);
}
`,
    },
  },
  harness: {
    python: `def _offers(ctx):
    m = ctx.load("offers")
    m.moved_on = []
    m.next_candidate = m.moved_on.append
    return m


def _race(ctx, m, key, newer):
    """A GET of the offer key from the client (outside a script/transaction) is answered, then the
    offer is replaced by a newer ride before the learner can act on it. Returns the list of swaps."""
    swaps = []
    real_get = m.r.get

    def get(name, *args, **kwargs):
        value = real_get(name, *args, **kwargs)
        if name == key and value is not None and not swaps:
            ctx.redis.set(key, newer, ex=15)
            swaps.append(value)
        return value

    m.r.get = get
    return swaps


def check_offer_nx(ctx):
    m = _offers(ctx)
    assert m.offer("r-42", "d-7") is True, "the first offer to a free driver must return True"
    assert ctx.redis.get("offer:driver:d-7") == "r-42", f"offer:driver:d-7 holds {ctx.redis.get('offer:driver:d-7')!r}, expected the ride id r-42"
    ttl = ctx.redis.ttl("offer:driver:d-7")
    assert 0 < ttl <= 15, f"offer:driver:d-7 has TTL {ttl}, expected EX 15"
    assert m.offer("r-43", "d-7") is False, "a driver with an open offer must be skipped: the second offer must return False"
    assert ctx.redis.get("offer:driver:d-7") == "r-42", "the second offer overwrote the first: the SET must be NX"
    assert m.offer("r-43", "d-8") is True, "another driver is free and must get the offer"
    ctx.clock.advance(16)
    assert m.offer("r-44", "d-7") is True, "after the 15 s window the driver is free again"
    assert ctx.redis.get("offer:driver:d-7") == "r-44"


def check_compare_and_delete(ctx):
    m = _offers(ctx)
    m.offer("r-42", "d-7")
    assert m.accept("r-99", "d-7") is False, "accepting a ride that is not the one on offer must return False"
    assert ctx.redis.get("offer:driver:d-7") == "r-42", "a mismatched accept must leave the offer in place"
    assert m.accept("r-42", "d-7") is True, "accepting the ride on offer must return True"
    assert ctx.redis.get("offer:driver:d-7") is None, "a successful accept must release the offer key"
    assert m.accept("r-42", "d-7") is False, "the offer is gone: a second accept must return False"
    m.offer("r-50", "d-8")
    ctx.clock.advance(16)  # the offer expired unanswered ...
    m.offer("r-51", "d-8")  # ... and a newer ride landed under the key
    assert m.accept("r-50", "d-8") is False, "a stale accept after the offer expired must return False"
    assert ctx.redis.get("offer:driver:d-8") == "r-51", "the stale accept deleted the newer offer r-51: compare and delete must be one atomic step"
    # The race itself: a GET-then-DEL from the client lets the key change in between.
    m.offer("r-60", "d-9")
    swaps = _race(ctx, m, "offer:driver:d-9", "r-61")
    got = m.accept("r-60", "d-9")
    if swaps:
        assert got is False and ctx.redis.get("offer:driver:d-9") == "r-61", "the offer changed to r-61 between the GET and the DEL and the stale accept still won: the compare and the delete must run atomically (a Lua script or WATCH/MULTI)"
    else:
        assert got is True and ctx.redis.get("offer:driver:d-9") is None, "accept of the ride on offer must succeed and release the key"


def check_assign_after_accept(ctx):
    m = _offers(ctx)
    m.offer("r-42", "d-7")
    assert m.accept("r-42", "d-7") is True
    assert ctx.redis.get("ride:r-42:driver") == "d-7", f"after a successful accept ride:r-42:driver must be d-7, got {ctx.redis.get('ride:r-42:driver')!r}"
    m.offer("r-50", "d-8")
    assert m.accept("r-51", "d-8") is False
    assert ctx.redis.get("ride:r-51:driver") is None, "the guarded delete returned 0 but ride:r-51:driver was written: assign only after the release succeeded"
    assert ctx.redis.get("offer:driver:d-8") == "r-50", "a failed accept must not touch the offer"
    assert m.accept("r-42", "d-9") is False, "d-9 holds no offer: accept must return False"
    assert ctx.redis.get("ride:r-42:driver") == "d-7", "a failed accept must not reassign the ride"


def check_decline_guarded(ctx):
    m = _offers(ctx)
    m.offer("r-42", "d-7")
    m.decline("r-42", "d-7")
    assert ctx.redis.get("offer:driver:d-7") is None, "declining the ride on offer must release the key"
    assert m.moved_on == ["r-42"], f"decline must hand the ride to next_candidate; next_candidate saw {m.moved_on}"
    m.offer("r-50", "d-8")
    ctx.clock.advance(16)
    m.offer("r-51", "d-8")
    m.decline("r-50", "d-8")
    assert ctx.redis.get("offer:driver:d-8") == "r-51", "a late decline of r-50 deleted the newer offer r-51: the release must be the guarded delete, never a blind DEL"
    assert m.moved_on == ["r-42", "r-50"], f"a late decline still moves the ride on; next_candidate saw {m.moved_on}"
    m.offer("r-60", "d-9")
    swaps = _race(ctx, m, "offer:driver:d-9", "r-61")
    m.decline("r-60", "d-9")
    if swaps:
        assert ctx.redis.get("offer:driver:d-9") == "r-61", "the offer changed to r-61 between the GET and the DEL and decline deleted it anyway: compare and delete atomically"
    else:
        assert ctx.redis.get("offer:driver:d-9") is None, "declining the ride on offer must release the key"
    assert m.moved_on[-1] == "r-60", "decline must call next_candidate with the declined ride"
`,
  },
  debrief: `This is the Redis lock pattern in its honest form: \`SET NX EX\` to acquire with a lease, a value that identifies the holder, and a compare-and-delete to release — the only way a release cannot remove someone else's lock after yours expired. The lease is also the product rule (an offer lasts 15 s), so expiry and business logic coincide. Real dispatchers offer one ride to several drivers at once and let the first accept win (the same compare-and-delete, keyed by ride), add a per-ride lock so two dispatcher instances do not offer the same ride, and record every offer and answer for the matching model.`,
};
