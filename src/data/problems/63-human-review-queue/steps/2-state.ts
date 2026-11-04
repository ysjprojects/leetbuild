import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis take: one reviewer per item, leases that end, an SLA that does not reset',
  concept: 'redis',
  file: 'state',
  focus: ['queue', 'redis', 'items'],
  task: `## Task

**Starting point.** The starter hands out work on the store's keys (\`review.store\`, provided).
\`take_next(tenant, reviewer)\` first runs \`reclaim_expired(tenant)\`, then walks \`PRIORITY_ORDER\`:
it reads the head of \`review:queue:{tenant}:{p}\` with \`LINDEX\`, removes it with \`LREM\`, writes
\`review:lease:{id}\`, adds the id to \`review:assigned:{tenant}\` and stamps the item assigned with
\`sla_deadline\` = now + \`SLA_SECONDS[p]\`. \`reclaim_expired\` pushes every assigned item whose lease
is gone to the back of its queue. One reviewer at a time gets work; it hides 4 flaws.

**Failure mode the checks target.** Two reviewers open the same item; a reviewer closes the tab and
the item stays assigned forever; every reassignment restarts the SLA, so nothing ever breaches; and
an item that did breach goes to the back of the line, unmarked.

- Take the item in one atomic command (\`LPOP\`, or a Lua script).
- The lease expires after \`LEASE_SECONDS\` (120): \`SET … EX\`.
- The SLA clock started at the enqueue: \`take_next\` keeps the item's \`sla_deadline\`.
- \`reclaim_expired\` puts an item past its \`sla_deadline\` at the **front** of its queue with
  \`breached\` = \`"1"\`; one inside its SLA goes to the back.`,
  sequence: {
    participants: ['Reviewer', 'Review Queue', 'Redis'],
    messages: [
      {from: 'Reviewer', to: 'Review Queue', label: 'take_next(tenant, reviewer)', kind: 'sync'},
      {from: 'Review Queue', to: 'Redis', label: 'reclaim_expired: lease gone? LPUSH breached · RPUSH', kind: 'sync'},
      {from: 'Review Queue', to: 'Redis', label: 'LPOP review:queue:{tenant}:p1 … p3', kind: 'sync'},
      {from: 'Redis', to: 'Review Queue', label: 'item id', kind: 'reply'},
      {from: 'Review Queue', to: 'Redis', label: 'SET review:lease:{id} reviewer EX 120 · SADD assigned', kind: 'sync'},
      {from: 'Review Queue', to: 'Reviewer', label: 'item · sla_deadline from the enqueue', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-take',
      title: 'One atomic take per item',
      detail:
        'The item leaves the queue in one command (`LPOP` or a script); the starter reads the head with `LINDEX` and removes it with `LREM`, so a second reviewer landing between the two gets the same item.',
      match: {
        python: {all: [/\.lpop\(|register_script\(|\.eval\(/], none: [/\.lindex\(/, /\.lrem\(/]},
        typescript: {all: [/\.lpop\(|defineCommand\(|\.eval\(/], none: [/\.lindex\(/, /\.lrem\(/]},
        go: {all: [/\.LPop\(|redis\.NewScript\(|\.Eval\(/], none: [/\.LIndex\(/, /\.LRem\(/]},
        scala: {all: [/\.lpop\(|\.eval\(/], none: [/\.lindex\(/, /\.lrem\(/]},
        cpp: {all: [/\.lpop\(|\.eval</], none: [/\.lindex\(/, /\.lrem\(/]},
      },
    },
    {
      id: 'lease-ttl',
      title: 'A lease expires after LEASE_SECONDS',
      detail:
        'The lease key is written with an expiry of `LEASE_SECONDS`, so an abandoned item comes back through `reclaim_expired`; the starter writes it with no TTL.',
      match: {
        python: {all: [/\b(ex|px)\s*=\s*(LEASE_SECONDS|int\(LEASE_SECONDS)/]},
        typescript: {all: [/['"](EX|PX)['"],\s*LEASE_SECONDS/i]},
        go: {all: [/\.Set(NX)?\([^\n]*leaseTTL\)/]},
        scala: {all: [/setex\([^\n]*LeaseSeconds|\.(ex|px)\(\s*LeaseSeconds/]},
        cpp: {all: [/\.set\([^\n]*kLeaseSeconds/]},
      },
    },
    {
      id: 'sla-clock',
      title: 'The SLA clock starts at the enqueue',
      detail:
        'A take keeps the `sla_deadline` the store set at the enqueue; the starter writes now + `SLA_SECONDS` on every assignment, so a reassigned item never breaches.',
      match: {
        python: {all: [/sla_deadline/], none: [/["']sla_deadline["']\s*:/]},
        typescript: {all: [/sla_deadline/], none: [/sla_deadline:/]},
        go: {all: [/sla_deadline/], none: [/"sla_deadline":/]},
        scala: {all: [/sla_deadline/], none: [/"sla_deadline"\s*->/]},
        cpp: {all: [/sla_deadline/], none: [/\{\s*"sla_deadline",/]},
      },
    },
    {
      id: 'breach-requeue',
      title: 'A breached item comes back first, marked',
      detail:
        '`reclaim_expired` pushes an item past its `sla_deadline` to the front of its queue (`LPUSH`) with `breached` = `"1"`, and one inside its SLA to the back; the starter sends every item to the back.',
      match: {
        python: {all: [/["']breached["']\s*[:,]\s*["']1["']/, /\.lpush\(/, /\.rpush\(/]},
        typescript: {all: [/breached:\s*['"]1['"]|['"]breached['"],\s*['"]1['"]/, /\.lpush\(/, /\.rpush\(/]},
        go: {all: [/"breached"\s*[:,]\s*"1"/, /\.LPush\(/, /\.RPush\(/]},
        scala: {all: [/"breached"\s*(->|,)\s*"1"/, /\.lpush\(/, /\.rpush\(/]},
        cpp: {all: [/"breached",\s*"1"/, /\.lpush\(/, /\.rpush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

from review import store  # item_key, queue_key, lease_key, assigned_key, get_item, SLA_SECONDS

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_SECONDS = 120
PRIORITY_ORDER = ("p1", "p2", "p3")


def take_next(tenant: str, reviewer: str) -> dict | None:
    """Assign the tenant's next queued item, most urgent priority first, to reviewer; None when the queue is empty."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    reclaim_expired(tenant)
    for priority in PRIORITY_ORDER:
        queue = store.queue_key(tenant, priority)
        item_id = r.lindex(queue, 0)
        if item_id is None:
            continue
        r.lrem(queue, 1, item_id)
        r.set(store.lease_key(item_id), reviewer)
        r.sadd(store.assigned_key(tenant), item_id)
        deadline = int(time.time()) + store.SLA_SECONDS[priority]
        r.hset(store.item_key(item_id), mapping={"state": "assigned", "reviewer": reviewer, "sla_deadline": deadline})
        return store.get_item(item_id)
    return None


def reclaim_expired(tenant: str) -> list[str]:
    """Return every assigned item whose lease is gone to its queue; the ids returned."""
    returned = []
    for item_id in sorted(r.smembers(store.assigned_key(tenant))):
        if r.exists(store.lease_key(item_id)):
            continue
        r.srem(store.assigned_key(tenant), item_id)
        item = store.get_item(item_id)
        if item is None:
            continue
        r.hset(store.item_key(item_id), "state", "queued")
        r.rpush(store.queue_key(tenant, item["priority"]), item_id)
        returned.append(item_id)
    return returned
`,
      solution: `import time

import redis

from review import store  # item_key, queue_key, lease_key, assigned_key, get_item, SLA_SECONDS

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_SECONDS = 120
PRIORITY_ORDER = ("p1", "p2", "p3")


def take_next(tenant: str, reviewer: str) -> dict | None:
    """Assign the tenant's next queued item, most urgent priority first, to reviewer; None when the queue is empty."""
    reclaim_expired(tenant)
    for priority in PRIORITY_ORDER:
        # One command takes the item: no second reviewer can read it between a read and a remove.
        item_id = r.lpop(store.queue_key(tenant, priority))
        if item_id is None:
            continue
        # The lease ends by itself when the reviewer walks away.
        r.set(store.lease_key(item_id), reviewer, ex=LEASE_SECONDS)
        r.sadd(store.assigned_key(tenant), item_id)
        # The SLA clock started at the enqueue: the item keeps its sla_deadline.
        r.hset(store.item_key(item_id), mapping={"state": "assigned", "reviewer": reviewer})
        return store.get_item(item_id)
    return None


def reclaim_expired(tenant: str) -> list[str]:
    """Return every assigned item whose lease is gone to its queue; the ids returned."""
    returned = []
    now = int(time.time())
    for item_id in sorted(r.smembers(store.assigned_key(tenant))):
        if r.exists(store.lease_key(item_id)):
            continue
        r.srem(store.assigned_key(tenant), item_id)
        item = store.get_item(item_id)
        if item is None:
            continue
        queue = store.queue_key(tenant, item["priority"])
        if now >= int(item["sla_deadline"]):
            # Past its SLA: it goes first, and says so.
            r.hset(store.item_key(item_id), mapping={"state": "queued", "breached": "1"})
            r.lpush(queue, item_id)
        else:
            r.hset(store.item_key(item_id), "state", "queued")
            r.rpush(queue, item_id)
        returned.append(item_id)
    return returned
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {type Item, SLA_SECONDS, assignedKey, getItem, itemKey, leaseKey, queueKey} from 'review/store';

const redis = new Redis({host: 'redis', port: 6379});

export const LEASE_SECONDS = 120;
export const PRIORITY_ORDER = ['p1', 'p2', 'p3'];

/** Assign the tenant's next queued item, most urgent priority first, to reviewer; null when the queue is empty. */
export async function takeNext(tenant: string, reviewer: string): Promise<Item | null> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  await reclaimExpired(tenant);
  for (const priority of PRIORITY_ORDER) {
    const queue = queueKey(tenant, priority);
    const itemId = await redis.lindex(queue, 0);
    if (itemId === null) continue;
    await redis.lrem(queue, 1, itemId);
    await redis.set(leaseKey(itemId), reviewer);
    await redis.sadd(assignedKey(tenant), itemId);
    const deadline = Math.floor(Date.now() / 1000) + SLA_SECONDS[priority];
    await redis.hset(itemKey(itemId), {state: 'assigned', reviewer, sla_deadline: String(deadline)});
    return getItem(itemId);
  }
  return null;
}

/** Return every assigned item whose lease is gone to its queue; the ids returned. */
export async function reclaimExpired(tenant: string): Promise<string[]> {
  const returned: string[] = [];
  for (const itemId of (await redis.smembers(assignedKey(tenant))).sort()) {
    if ((await redis.exists(leaseKey(itemId))) === 1) continue;
    await redis.srem(assignedKey(tenant), itemId);
    const item = await getItem(itemId);
    if (item === null) continue;
    await redis.hset(itemKey(itemId), {state: 'queued'});
    await redis.rpush(queueKey(tenant, item.priority), itemId);
    returned.push(itemId);
  }
  return returned;
}
`,
      solution: `import Redis from 'ioredis';

import {type Item, assignedKey, getItem, itemKey, leaseKey, queueKey} from 'review/store';

const redis = new Redis({host: 'redis', port: 6379});

export const LEASE_SECONDS = 120;
export const PRIORITY_ORDER = ['p1', 'p2', 'p3'];

/** Assign the tenant's next queued item, most urgent priority first, to reviewer; null when the queue is empty. */
export async function takeNext(tenant: string, reviewer: string): Promise<Item | null> {
  await reclaimExpired(tenant);
  for (const priority of PRIORITY_ORDER) {
    // One command takes the item: no second reviewer can read it between a read and a remove.
    const itemId = await redis.lpop(queueKey(tenant, priority));
    if (itemId === null) continue;
    // The lease ends by itself when the reviewer walks away.
    await redis.set(leaseKey(itemId), reviewer, 'EX', LEASE_SECONDS);
    await redis.sadd(assignedKey(tenant), itemId);
    // The SLA clock started at the enqueue: the item keeps its sla_deadline.
    await redis.hset(itemKey(itemId), {state: 'assigned', reviewer});
    return getItem(itemId);
  }
  return null;
}

/** Return every assigned item whose lease is gone to its queue; the ids returned. */
export async function reclaimExpired(tenant: string): Promise<string[]> {
  const returned: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const itemId of (await redis.smembers(assignedKey(tenant))).sort()) {
    if ((await redis.exists(leaseKey(itemId))) === 1) continue;
    await redis.srem(assignedKey(tenant), itemId);
    const item = await getItem(itemId);
    if (item === null) continue;
    const queue = queueKey(tenant, item.priority);
    if (now >= Number(item.sla_deadline)) {
      // Past its SLA: it goes first, and says so.
      await redis.hset(itemKey(itemId), {state: 'queued', breached: '1'});
      await redis.lpush(queue, itemId);
    } else {
      await redis.hset(itemKey(itemId), {state: 'queued'});
      await redis.rpush(queue, itemId);
    }
    returned.push(itemId);
  }
  return returned;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"review/store" // store.ItemKey, QueueKey, LeaseKey, AssignedKey, GetItem, SLASeconds
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const leaseTTL = 120 * time.Second

var priorityOrder = []string{"p1", "p2", "p3"}

// takeNext assigns the tenant's next queued item, most urgent priority first, to reviewer; nil when
// the queue is empty.
func takeNext(ctx context.Context, tenant, reviewer string) (map[string]string, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	if _, err := reclaimExpired(ctx, tenant); err != nil {
		return nil, err
	}
	for _, priority := range priorityOrder {
		queue := store.QueueKey(tenant, priority)
		itemID, err := rdb.LIndex(ctx, queue, 0).Result()
		if err == redis.Nil {
			continue
		}
		if err != nil {
			return nil, err
		}
		rdb.LRem(ctx, queue, 1, itemID)
		rdb.Set(ctx, store.LeaseKey(itemID), reviewer, 0)
		rdb.SAdd(ctx, store.AssignedKey(tenant), itemID)
		deadline := time.Now().Unix() + store.SLASeconds[priority]
		rdb.HSet(ctx, store.ItemKey(itemID), map[string]any{"state": "assigned", "reviewer": reviewer, "sla_deadline": strconv.FormatInt(deadline, 10)})
		return store.GetItem(ctx, itemID), nil
	}
	return nil, nil
}

// reclaimExpired returns every assigned item whose lease is gone to its queue; the ids returned.
func reclaimExpired(ctx context.Context, tenant string) ([]string, error) {
	ids, err := rdb.SMembers(ctx, store.AssignedKey(tenant)).Result()
	if err != nil {
		return nil, err
	}
	sort.Strings(ids)
	returned := []string{}
	for _, itemID := range ids {
		if rdb.Exists(ctx, store.LeaseKey(itemID)).Val() == 1 {
			continue
		}
		rdb.SRem(ctx, store.AssignedKey(tenant), itemID)
		item := store.GetItem(ctx, itemID)
		if item == nil {
			continue
		}
		rdb.HSet(ctx, store.ItemKey(itemID), "state", "queued")
		rdb.RPush(ctx, store.QueueKey(tenant, item["priority"]), itemID)
		returned = append(returned, itemID)
	}
	return returned, nil
}
`,
      solution: `package main

import (
	"context"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"review/store" // store.ItemKey, QueueKey, LeaseKey, AssignedKey, GetItem, SLASeconds
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const leaseTTL = 120 * time.Second

var priorityOrder = []string{"p1", "p2", "p3"}

// takeNext assigns the tenant's next queued item, most urgent priority first, to reviewer; nil when
// the queue is empty.
func takeNext(ctx context.Context, tenant, reviewer string) (map[string]string, error) {
	if _, err := reclaimExpired(ctx, tenant); err != nil {
		return nil, err
	}
	for _, priority := range priorityOrder {
		// One command takes the item: no second reviewer can read it between a read and a remove.
		itemID, err := rdb.LPop(ctx, store.QueueKey(tenant, priority)).Result()
		if err == redis.Nil {
			continue
		}
		if err != nil {
			return nil, err
		}
		// The lease ends by itself when the reviewer walks away.
		rdb.Set(ctx, store.LeaseKey(itemID), reviewer, leaseTTL)
		rdb.SAdd(ctx, store.AssignedKey(tenant), itemID)
		// The SLA clock started at the enqueue: the item keeps its sla_deadline.
		rdb.HSet(ctx, store.ItemKey(itemID), map[string]any{"state": "assigned", "reviewer": reviewer})
		return store.GetItem(ctx, itemID), nil
	}
	return nil, nil
}

// reclaimExpired returns every assigned item whose lease is gone to its queue; the ids returned.
func reclaimExpired(ctx context.Context, tenant string) ([]string, error) {
	ids, err := rdb.SMembers(ctx, store.AssignedKey(tenant)).Result()
	if err != nil {
		return nil, err
	}
	sort.Strings(ids)
	now := time.Now().Unix()
	returned := []string{}
	for _, itemID := range ids {
		if rdb.Exists(ctx, store.LeaseKey(itemID)).Val() == 1 {
			continue
		}
		rdb.SRem(ctx, store.AssignedKey(tenant), itemID)
		item := store.GetItem(ctx, itemID)
		if item == nil {
			continue
		}
		queue := store.QueueKey(tenant, item["priority"])
		deadline, _ := strconv.ParseInt(item["sla_deadline"], 10, 64)
		if now >= deadline {
			// Past its SLA: it goes first, and says so.
			rdb.HSet(ctx, store.ItemKey(itemID), map[string]any{"state": "queued", "breached": "1"})
			rdb.LPush(ctx, queue, itemID)
		} else {
			rdb.HSet(ctx, store.ItemKey(itemID), "state", "queued")
			rdb.RPush(ctx, queue, itemID)
		}
		returned = append(returned, itemID)
	}
	return returned, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import review.Store // Store.itemKey, queueKey, leaseKey, assignedKey, getItem, SlaSeconds

object State {
  val jedis = new JedisPooled("redis", 6379)

  val LeaseSeconds = 120L
  val PriorityOrder: Seq[String] = Seq("p1", "p2", "p3")

  /** Assign the tenant's next queued item, most urgent priority first, to reviewer; None when the queue is empty. */
  def takeNext(tenant: String, reviewer: String): Option[Store.Item] = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    reclaimExpired(tenant)
    PriorityOrder.iterator
      .map(priority => priority -> Option(jedis.lindex(Store.queueKey(tenant, priority), 0)))
      .collectFirst { case (priority, Some(itemId)) =>
        jedis.lrem(Store.queueKey(tenant, priority), 1, itemId)
        jedis.set(Store.leaseKey(itemId), reviewer)
        jedis.sadd(Store.assignedKey(tenant), itemId)
        val deadline = java.time.Instant.now.getEpochSecond + Store.SlaSeconds(priority)
        jedis.hset(Store.itemKey(itemId), Map("state" -> "assigned", "reviewer" -> reviewer, "sla_deadline" -> deadline.toString).asJava)
        itemId
      }
      .flatMap(Store.getItem)
  }

  /** Return every assigned item whose lease is gone to its queue; the ids returned. */
  def reclaimExpired(tenant: String): Seq[String] =
    jedis.smembers(Store.assignedKey(tenant)).asScala.toSeq.sorted.filterNot(itemId => jedis.exists(Store.leaseKey(itemId))).flatMap { itemId =>
      jedis.srem(Store.assignedKey(tenant), itemId)
      Store.getItem(itemId).map { item =>
        jedis.hset(Store.itemKey(itemId), "state", "queued")
        jedis.rpush(Store.queueKey(tenant, item("priority")), itemId)
        itemId
      }
    }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

import review.Store // Store.itemKey, queueKey, leaseKey, assignedKey, getItem, SlaSeconds

object State {
  val jedis = new JedisPooled("redis", 6379)

  val LeaseSeconds = 120L
  val PriorityOrder: Seq[String] = Seq("p1", "p2", "p3")

  /** Assign the tenant's next queued item, most urgent priority first, to reviewer; None when the queue is empty. */
  def takeNext(tenant: String, reviewer: String): Option[Store.Item] = {
    reclaimExpired(tenant)
    // One command takes the item: no second reviewer can read it between a read and a remove.
    PriorityOrder.iterator
      .flatMap(priority => Option(jedis.lpop(Store.queueKey(tenant, priority))))
      .nextOption()
      .flatMap { itemId =>
        // The lease ends by itself when the reviewer walks away.
        jedis.set(Store.leaseKey(itemId), reviewer, SetParams.setParams().ex(LeaseSeconds))
        jedis.sadd(Store.assignedKey(tenant), itemId)
        // The SLA clock started at the enqueue: the item keeps its sla_deadline.
        jedis.hset(Store.itemKey(itemId), Map("state" -> "assigned", "reviewer" -> reviewer).asJava)
        Store.getItem(itemId)
      }
  }

  /** Return every assigned item whose lease is gone to its queue; the ids returned. */
  def reclaimExpired(tenant: String): Seq[String] = {
    val now = java.time.Instant.now.getEpochSecond
    jedis.smembers(Store.assignedKey(tenant)).asScala.toSeq.sorted.filterNot(itemId => jedis.exists(Store.leaseKey(itemId))).flatMap { itemId =>
      jedis.srem(Store.assignedKey(tenant), itemId)
      Store.getItem(itemId).map { item =>
        val queue = Store.queueKey(tenant, item("priority"))
        if (now >= item("sla_deadline").toLong) {
          // Past its SLA: it goes first, and says so.
          jedis.hset(Store.itemKey(itemId), Map("state" -> "queued", "breached" -> "1").asJava)
          jedis.lpush(queue, itemId)
        } else {
          jedis.hset(Store.itemKey(itemId), "state", "queued")
          jedis.rpush(queue, itemId)
        }
        itemId
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "review/store.h"  // store::itemKey, queueKey, leaseKey, assignedKey, getItem, kSlaSeconds, nowSeconds

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kLeaseSeconds = 120;
const std::vector<std::string> kPriorityOrder = {"p1", "p2", "p3"};

std::vector<std::string> reclaimExpired(const std::string& tenant);

// Assign the tenant's next queued item, most urgent priority first, to reviewer; none when the
// queue is empty.
std::optional<store::Item> takeNext(const std::string& tenant, const std::string& reviewer) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  reclaimExpired(tenant);
  for (const std::string& priority : kPriorityOrder) {
    const std::string queue = store::queueKey(tenant, priority);
    const auto item_id = redis.lindex(queue, 0);
    if (!item_id) continue;
    redis.lrem(queue, 1, *item_id);
    redis.set(store::leaseKey(*item_id), reviewer);
    redis.sadd(store::assignedKey(tenant), *item_id);
    const long long deadline = store::nowSeconds() + store::kSlaSeconds.at(priority);
    const std::map<std::string, std::string> fields = {{"state", "assigned"}, {"reviewer", reviewer}, {"sla_deadline", std::to_string(deadline)}};
    redis.hset(store::itemKey(*item_id), fields.begin(), fields.end());
    return store::getItem(*item_id);
  }
  return std::nullopt;
}

// Return every assigned item whose lease is gone to its queue; the ids returned.
std::vector<std::string> reclaimExpired(const std::string& tenant) {
  std::vector<std::string> ids;
  redis.smembers(store::assignedKey(tenant), std::back_inserter(ids));
  std::sort(ids.begin(), ids.end());
  std::vector<std::string> returned;
  for (const std::string& item_id : ids) {
    if (redis.exists(store::leaseKey(item_id)) == 1) continue;
    redis.srem(store::assignedKey(tenant), item_id);
    const auto item = store::getItem(item_id);
    if (!item) continue;
    redis.hset(store::itemKey(item_id), "state", "queued");
    redis.rpush(store::queueKey(tenant, item->at("priority")), item_id);
    returned.push_back(item_id);
  }
  return returned;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "review/store.h"  // store::itemKey, queueKey, leaseKey, assignedKey, getItem, kSlaSeconds, nowSeconds

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kLeaseSeconds = 120;
const std::vector<std::string> kPriorityOrder = {"p1", "p2", "p3"};

std::vector<std::string> reclaimExpired(const std::string& tenant);

// Assign the tenant's next queued item, most urgent priority first, to reviewer; none when the
// queue is empty.
std::optional<store::Item> takeNext(const std::string& tenant, const std::string& reviewer) {
  reclaimExpired(tenant);
  for (const std::string& priority : kPriorityOrder) {
    // One command takes the item: no second reviewer can read it between a read and a remove.
    const auto item_id = redis.lpop(store::queueKey(tenant, priority));
    if (!item_id) continue;
    // The lease ends by itself when the reviewer walks away.
    redis.set(store::leaseKey(*item_id), reviewer, std::chrono::seconds(kLeaseSeconds));
    redis.sadd(store::assignedKey(tenant), *item_id);
    // The SLA clock started at the enqueue: the item keeps its deadline.
    const std::map<std::string, std::string> fields = {{"state", "assigned"}, {"reviewer", reviewer}};
    redis.hset(store::itemKey(*item_id), fields.begin(), fields.end());
    return store::getItem(*item_id);
  }
  return std::nullopt;
}

// Return every assigned item whose lease is gone to its queue; the ids returned.
std::vector<std::string> reclaimExpired(const std::string& tenant) {
  std::vector<std::string> ids;
  redis.smembers(store::assignedKey(tenant), std::back_inserter(ids));
  std::sort(ids.begin(), ids.end());
  const long long now = store::nowSeconds();
  std::vector<std::string> returned;
  for (const std::string& item_id : ids) {
    if (redis.exists(store::leaseKey(item_id)) == 1) continue;
    redis.srem(store::assignedKey(tenant), item_id);
    const auto item = store::getItem(item_id);
    if (!item) continue;
    const std::string queue = store::queueKey(tenant, item->at("priority"));
    if (now >= std::stoll(item->at("sla_deadline"))) {
      // Past its SLA: it goes first, and says so.
      const std::map<std::string, std::string> fields = {{"state", "queued"}, {"breached", "1"}};
      redis.hset(store::itemKey(item_id), fields.begin(), fields.end());
      redis.lpush(queue, item_id);
    } else {
      redis.hset(store::itemKey(item_id), "state", "queued");
      redis.rpush(queue, item_id);
    }
    returned.push_back(item_id);
  }
  return returned;
}
`,
    },
  },
  harness: {
    python: `from review import store


def _enqueue(tenant, n, priority="p1"):
    return store.create_item({"item_id": f"r-{n}", "tenant": tenant, "source_type": "guardrail_block", "source_id": f"s-{n}", "priority": priority, "payload_ref": f"blob://{n}"})


def _id(item):
    return None if item is None else item.get("item_id")


def check_atomic_take(ctx):
    m = ctx.load("state")
    _enqueue("t1", 1)
    _enqueue("t1", 2)
    # Another reviewer's take lands right after take_next's first command on the queue.
    rival = ctx.redis_after("review:queue:t1:p1", lambda: ctx.redis.lpop("review:queue:t1:p1"))
    got = m.take_next("t1", "alice")
    assert rival.fired, "take_next never touched review:queue:t1:p1"
    assert got is not None, "with two items queued take_next answered None"
    assert _id(got) != rival.result, f"another reviewer took {rival.result} between take_next's read of the queue and its remove, and alice was handed {rival.result} too: two reviewers on one item. Take the item out in one command"
    assert ctx.redis.get(f"review:lease:{_id(got)}") == "alice", f"the lease on {_id(got)} names {ctx.redis.get(f'review:lease:{_id(got)}')!r}, expected alice"
    _enqueue("t1", 3, "p3")
    _enqueue("t1", 4, "p2")
    assert _id(m.take_next("t1", "bob")) == "r-4", "with a p3 and a p2 item queued the p2 item comes first"


def check_lease_ttl(ctx):
    m = ctx.load("state")
    _enqueue("t1", 1)
    assert _id(m.take_next("t1", "alice")) == "r-1", "alice must be handed r-1"
    ttl = ctx.redis.ttl("review:lease:r-1")
    assert 0 < ttl <= m.LEASE_SECONDS, f"the lease review:lease:r-1 has TTL {ttl}: a reviewer who closes the tab holds the item forever. Write it with an expiry of LEASE_SECONDS"
    assert m.take_next("t1", "bob") is None, "while alice's lease holds, r-1 must not be handed out again"
    ctx.clock.advance(m.LEASE_SECONDS + 1)
    again = m.take_next("t1", "bob")
    assert _id(again) == "r-1", f"alice's lease on r-1 ran out, yet bob was handed {_id(again)}: an abandoned item must come back"
    assert ctx.redis.get("review:lease:r-1") == "bob", f"the lease on r-1 names {ctx.redis.get('review:lease:r-1')!r}, expected bob"


def check_sla_clock(ctx):
    m = ctx.load("state")
    created = _enqueue("t1", 1)
    ctx.clock.advance(200)
    got = m.take_next("t1", "alice")
    assert got is not None and got["sla_deadline"] == created["sla_deadline"], f"r-1 was enqueued with sla_deadline {created['sla_deadline']} and the take moved it to {got and got['sla_deadline']}: the SLA clock started at the enqueue, an assignment must not restart it"
    assert store.get_item("r-1")["sla_deadline"] == created["sla_deadline"], f"the store holds sla_deadline {store.get_item('r-1')['sla_deadline']} for r-1, expected {created['sla_deadline']}"


def check_breach_requeue(ctx):
    m = ctx.load("state")
    _enqueue("t1", 1)
    assert _id(m.take_next("t1", "alice")) == "r-1", "alice must be handed r-1"
    ctx.clock.advance(10)
    _enqueue("t1", 2)
    ctx.clock.advance(400)  # alice's lease is gone, and r-1 is past its 300 s SLA
    got = m.take_next("t1", "bob")
    assert _id(got) == "r-1", f"bob was handed {_id(got)}: r-1 came back after its SLA ran out and must go first, ahead of r-2"
    assert store.get_item("r-1")["breached"] == "1", f"r-1 came back past its SLA and is not marked: breached is {store.get_item('r-1')['breached']!r}, expected '1'"
    _enqueue("t2", 3, "p2")
    assert _id(m.take_next("t2", "dave")) == "r-3", "dave must be handed r-3"
    _enqueue("t2", 4, "p2")
    ctx.clock.advance(130)  # dave's lease is gone; r-3 is well inside its 1800 s SLA
    got = m.take_next("t2", "erin")
    assert _id(got) == "r-4", f"erin was handed {_id(got)}: an item reclaimed inside its SLA waits behind r-4, queued before it came back"
    assert store.get_item("r-3")["breached"] == "0", "r-3 is inside its SLA and must not be marked breached"
`,
    typescript: `function state(ctx) {
  return {m: ctx.load('state'), store: ctx.load('/support/review/store.ts')};
}

const enqueue = (store, tenant: string, n: number, priority = 'p1') =>
  store.createItem({item_id: \`r-\${n}\`, tenant, source_type: 'guardrail_block', source_id: \`s-\${n}\`, priority, payload_ref: \`blob://\${n}\`});

const idOf = item => (item === null || item === undefined ? null : item.item_id);

export async function check_atomic_take(ctx) {
  const {m, store} = state(ctx);
  await enqueue(store, 't1', 1);
  await enqueue(store, 't1', 2);
  // Another reviewer's take lands right after takeNext's first command on the queue.
  const rival = ctx.redisAfter('review:queue:t1:p1', () => ctx.redis.lpop('review:queue:t1:p1'));
  const got = await m.takeNext('t1', 'alice');
  assert(rival.fired, 'takeNext never touched review:queue:t1:p1');
  assert(got !== null, 'with two items queued takeNext answered null');
  assert.notEqual(idOf(got), rival.result, \`another reviewer took \${rival.result} between takeNext's read of the queue and its remove, and alice was handed \${rival.result} too: two reviewers on one item. Take the item out in one command\`);
  assert.equal(ctx.redis.get(\`review:lease:\${idOf(got)}\`), 'alice', \`the lease on \${idOf(got)} must name alice\`);
  await enqueue(store, 't1', 3, 'p3');
  await enqueue(store, 't1', 4, 'p2');
  assert.equal(idOf(await m.takeNext('t1', 'bob')), 'r-4', 'with a p3 and a p2 item queued the p2 item comes first');
}

export async function check_lease_ttl(ctx) {
  const {m, store} = state(ctx);
  await enqueue(store, 't1', 1);
  assert.equal(idOf(await m.takeNext('t1', 'alice')), 'r-1', 'alice must be handed r-1');
  const ttl = ctx.redis.ttl('review:lease:r-1');
  assert(ttl > 0 && ttl <= m.LEASE_SECONDS, \`the lease review:lease:r-1 has TTL \${ttl}: a reviewer who closes the tab holds the item forever. Write it with an expiry of LEASE_SECONDS\`);
  assert.equal(await m.takeNext('t1', 'bob'), null, "while alice's lease holds, r-1 must not be handed out again");
  ctx.clock.advance(m.LEASE_SECONDS + 1);
  const again = await m.takeNext('t1', 'bob');
  assert.equal(idOf(again), 'r-1', \`alice's lease on r-1 ran out, yet bob was handed \${idOf(again)}: an abandoned item must come back\`);
  assert.equal(ctx.redis.get('review:lease:r-1'), 'bob', 'the lease on r-1 must name bob');
}

export async function check_sla_clock(ctx) {
  const {m, store} = state(ctx);
  const created = await enqueue(store, 't1', 1);
  ctx.clock.advance(200);
  const got = await m.takeNext('t1', 'alice');
  assert(got !== null && got.sla_deadline === created.sla_deadline, \`r-1 was enqueued with sla_deadline \${created.sla_deadline} and the take moved it to \${got?.sla_deadline}: the SLA clock started at the enqueue, an assignment must not restart it\`);
  assert.equal((await store.getItem('r-1')).sla_deadline, created.sla_deadline, 'the stored sla_deadline of r-1');
}

export async function check_breach_requeue(ctx) {
  const {m, store} = state(ctx);
  await enqueue(store, 't1', 1);
  assert.equal(idOf(await m.takeNext('t1', 'alice')), 'r-1', 'alice must be handed r-1');
  ctx.clock.advance(10);
  await enqueue(store, 't1', 2);
  ctx.clock.advance(400); // alice's lease is gone, and r-1 is past its 300 s SLA
  let got = await m.takeNext('t1', 'bob');
  assert.equal(idOf(got), 'r-1', \`bob was handed \${idOf(got)}: r-1 came back after its SLA ran out and must go first, ahead of r-2\`);
  assert.equal((await store.getItem('r-1')).breached, '1', 'r-1 came back past its SLA and must be marked breached');
  await enqueue(store, 't2', 3, 'p2');
  assert.equal(idOf(await m.takeNext('t2', 'dave')), 'r-3', 'dave must be handed r-3');
  await enqueue(store, 't2', 4, 'p2');
  ctx.clock.advance(130); // dave's lease is gone; r-3 is well inside its 1800 s SLA
  got = await m.takeNext('t2', 'erin');
  assert.equal(idOf(got), 'r-4', \`erin was handed \${idOf(got)}: an item reclaimed inside its SLA waits behind r-4, queued before it came back\`);
  assert.equal((await store.getItem('r-3')).breached, '0', 'r-3 is inside its SLA and must not be marked breached');
}
`,
    go: `package main

import (
	"context"
	"fmt"

	"review/store"

	"leetbuild/harness"
)

var stateBg = context.Background()

func enqueueItem(tenant string, n int, priority string) map[string]string {
	return store.CreateItem(stateBg, map[string]string{
		"item_id": fmt.Sprintf("r-%d", n), "tenant": tenant, "source_type": "guardrail_block",
		"source_id": fmt.Sprintf("s-%d", n), "priority": priority, "payload_ref": fmt.Sprintf("blob://%d", n),
	})
}

func take(ctx *harness.Ctx, tenant, reviewer string) string {
	item, err := takeNext(stateBg, tenant, reviewer)
	ctx.NoError(err, "takeNext(%s, %s) failed", tenant, reviewer)
	return item["item_id"]
}

func CheckAtomicTake(ctx *harness.Ctx) {
	enqueueItem("t1", 1, "p1")
	enqueueItem("t1", 2, "p1")
	// Another reviewer's take lands right after takeNext's first command on the queue.
	rival := ""
	fired := false
	ctx.Redis.After("review:queue:t1:p1", func() any {
		fired = true
		rival = fmt.Sprint(ctx.Redis.Do("LPOP", "review:queue:t1:p1"))
		return nil
	})
	got := take(ctx, "t1", "alice")
	ctx.Assert(fired, "takeNext never touched review:queue:t1:p1")
	ctx.Assert(got != "", "with two items queued takeNext answered nothing")
	ctx.Assert(got != rival, "another reviewer took %s between takeNext's read of the queue and its remove, and alice was handed %s too: two reviewers on one item. Take the item out in one command", rival, got)
	lease, _ := ctx.Redis.Get("review:lease:" + got)
	ctx.Equal(lease, "alice", "the lease on %s", got)
	enqueueItem("t1", 3, "p3")
	enqueueItem("t1", 4, "p2")
	ctx.Equal(take(ctx, "t1", "bob"), "r-4", "with a p3 and a p2 item queued the p2 item comes first; bob's item")
}

func CheckLeaseTtl(ctx *harness.Ctx) {
	enqueueItem("t1", 1, "p1")
	ctx.Equal(take(ctx, "t1", "alice"), "r-1", "alice's item")
	ttl := ctx.Redis.TTL("review:lease:r-1")
	ctx.Assert(ttl > 0 && ttl <= int64(leaseTTL.Seconds()), "the lease review:lease:r-1 has TTL %d: a reviewer who closes the tab holds the item forever. Write it with an expiry of leaseTTL", ttl)
	ctx.Equal(take(ctx, "t1", "bob"), "", "while alice's lease holds, r-1 must not be handed out again; bob's item")
	ctx.Clock.Advance(leaseTTL.Seconds() + 1)
	ctx.Equal(take(ctx, "t1", "bob"), "r-1", "alice's lease on r-1 ran out: an abandoned item must come back; bob's item")
	lease, _ := ctx.Redis.Get("review:lease:r-1")
	ctx.Equal(lease, "bob", "the lease on r-1")
}

func CheckSlaClock(ctx *harness.Ctx) {
	created := enqueueItem("t1", 1, "p1")
	ctx.Clock.Advance(200)
	got, err := takeNext(stateBg, "t1", "alice")
	ctx.NoError(err, "takeNext failed")
	ctx.Equal(got["sla_deadline"], created["sla_deadline"], "the SLA clock started at the enqueue, an assignment must not restart it; r-1's sla_deadline after the take")
	ctx.Equal(store.GetItem(stateBg, "r-1")["sla_deadline"], created["sla_deadline"], "the stored sla_deadline of r-1")
}

func CheckBreachRequeue(ctx *harness.Ctx) {
	enqueueItem("t1", 1, "p1")
	ctx.Equal(take(ctx, "t1", "alice"), "r-1", "alice's item")
	ctx.Clock.Advance(10)
	enqueueItem("t1", 2, "p1")
	ctx.Clock.Advance(400) // alice's lease is gone, and r-1 is past its 300 s SLA
	ctx.Equal(take(ctx, "t1", "bob"), "r-1", "r-1 came back after its SLA ran out and must go first, ahead of r-2; bob's item")
	ctx.Equal(store.GetItem(stateBg, "r-1")["breached"], "1", "r-1 came back past its SLA and must be marked; its breached field")
	enqueueItem("t2", 3, "p2")
	ctx.Equal(take(ctx, "t2", "dave"), "r-3", "dave's item")
	enqueueItem("t2", 4, "p2")
	ctx.Clock.Advance(130) // dave's lease is gone; r-3 is well inside its 1800 s SLA
	ctx.Equal(take(ctx, "t2", "erin"), "r-4", "an item reclaimed inside its SLA waits behind r-4, queued before it came back; erin's item")
	ctx.Equal(store.GetItem(stateBg, "r-3")["breached"], "0", "r-3 is inside its SLA; its breached field")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

#include "review/store.h"

namespace {

store::Item enqueueItem(const std::string& tenant, int n, const std::string& priority = "p1") {
  const std::string id = std::to_string(n);
  return store::createItem({{"item_id", "r-" + id}, {"tenant", tenant}, {"source_type", "guardrail_block"}, {"source_id", "s-" + id},
                            {"priority", priority}, {"payload_ref", "blob://" + id}});
}

std::string take(const std::string& tenant, const std::string& reviewer) {
  const auto item = takeNext(tenant, reviewer);
  return item && item->count("item_id") ? item->at("item_id") : "";
}

std::string field(const std::string& item_id, const std::string& name) {
  const auto item = store::getItem(item_id);
  return item && item->count(name) ? item->at(name) : "";
}

}  // namespace

void CheckAtomicTake(harness::Ctx& ctx) {
  enqueueItem("t1", 1);
  enqueueItem("t1", 2);
  // Another reviewer's take lands right after takeNext's first command on the queue.
  bool fired = false;
  std::string rival;
  ctx.Redis.After("review:queue:t1:p1", [&] {
    fired = true;
    rival = ctx.Redis.Do("LPOP", "review:queue:t1:p1").String();
  });
  const std::string got = take("t1", "alice");
  ctx.Assert(fired, "takeNext never touched review:queue:t1:p1");
  ctx.Assert(!got.empty(), "with two items queued takeNext answered nothing");
  ctx.Assert(got != rival, "another reviewer took %s between takeNext's read of the queue and its remove, and alice was handed %s too: two reviewers on one item. Take the item out in one command", rival, got);
  ctx.Equal(ctx.Redis.Get("review:lease:" + got).value_or(""), "alice", "the lease on %s", got);
  enqueueItem("t1", 3, "p3");
  enqueueItem("t1", 4, "p2");
  ctx.Equal(take("t1", "bob"), "r-4", "with a p3 and a p2 item queued the p2 item comes first; bob's item");
}

void CheckLeaseTtl(harness::Ctx& ctx) {
  enqueueItem("t1", 1);
  ctx.Equal(take("t1", "alice"), "r-1", "alice's item");
  const long long ttl = ctx.Redis.TTL("review:lease:r-1");
  ctx.Assert(ttl > 0 && ttl <= kLeaseSeconds, "the lease review:lease:r-1 has TTL %d: a reviewer who closes the tab holds the item forever. Write it with an expiry of kLeaseSeconds", ttl);
  ctx.Equal(take("t1", "bob"), "", "while alice's lease holds, r-1 must not be handed out again; bob's item");
  ctx.Clock.Advance(static_cast<double>(kLeaseSeconds) + 1);
  ctx.Equal(take("t1", "bob"), "r-1", "alice's lease on r-1 ran out: an abandoned item must come back; bob's item");
  ctx.Equal(ctx.Redis.Get("review:lease:r-1").value_or(""), "bob", "the lease on r-1");
}

void CheckSlaClock(harness::Ctx& ctx) {
  const store::Item created = enqueueItem("t1", 1);
  ctx.Clock.Advance(200);
  const auto got = takeNext("t1", "alice");
  ctx.Equal(got && got->count("sla_deadline") ? got->at("sla_deadline") : "", created.at("sla_deadline"),
            "the SLA clock started at the enqueue, an assignment must not restart it; r-1's sla_deadline after the take");
  ctx.Equal(field("r-1", "sla_deadline"), created.at("sla_deadline"), "the stored sla_deadline of r-1");
}

void CheckBreachRequeue(harness::Ctx& ctx) {
  enqueueItem("t1", 1);
  ctx.Equal(take("t1", "alice"), "r-1", "alice's item");
  ctx.Clock.Advance(10);
  enqueueItem("t1", 2);
  ctx.Clock.Advance(400);  // alice's lease is gone, and r-1 is past its 300 s SLA
  ctx.Equal(take("t1", "bob"), "r-1", "r-1 came back after its SLA ran out and must go first, ahead of r-2; bob's item");
  ctx.Equal(field("r-1", "breached"), "1", "r-1 came back past its SLA and must be marked; its breached field");
  enqueueItem("t2", 3, "p2");
  ctx.Equal(take("t2", "dave"), "r-3", "dave's item");
  enqueueItem("t2", 4, "p2");
  ctx.Clock.Advance(130);  // dave's lease is gone; r-3 is well inside its 1800 s SLA
  ctx.Equal(take("t2", "erin"), "r-4", "an item reclaimed inside its SLA waits behind r-4, queued before it came back; erin's item");
  ctx.Equal(field("r-3", "breached"), "0", "r-3 is inside its SLA; its breached field");
}
`,
  },
  hints: [
    'Open the same queue in two tabs: both reviewers can get one item. Close a tab mid-item and it never comes back; an item reassigned three times never shows as late.',
    '`LINDEX` and `LREM` are two commands, so a second take can read the same head between them. The lease has no expiry, and every take rewrites `sla_deadline` from now.',
    'Use `LPOP` for the take, `SET lease reviewer EX LEASE_SECONDS`, drop the `sla_deadline` write, and in `reclaim_expired` `LPUSH` with `breached` "1" when now is past `sla_deadline`, else `RPUSH`.',
  ],
  debrief: `Every part of the fix leans on Redis doing the coordination: one \`LPOP\` is the only moment an item changes hands, and the lease's TTL is the only clock deciding a reviewer is gone, so no process has to notice anything. The SLA belongs to the item, not to the assignment, which is why the deadline is written once at the enqueue and only read afterwards; a breach then stays visible however often the item moves. Production queues keep a separate set of leased items scored by expiry so the sweep reads only what expired, and let a reviewer extend a lease while the item is open.`,
};
