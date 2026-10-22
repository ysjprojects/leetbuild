import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Shard queries with explicit partial results',
  concept: 'grpc',
  file: 'client',
  focus: ['search', 'shard-a', 'shard-b'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it walks the shard list, calls
\`Search\` on each, collects the products, and returns them. It compiles, it answers the demo with
every shard healthy, and it hides four production flaws. Review it like the service owner, fix it,
and prove the fix with the checks below.

Implement the gRPC fan-out used by \`GET /v1/search\`.

- Every shard call runs under a **350 ms deadline** (\`SHARD_DEADLINE_MS = 350\`): the stub carries
  \`timeout=\` / a deadline / \`WithTimeout\` / \`deadlineAfter\`, and the merge never waits for the
  slowest shard. The draft has no deadline, so one hung shard holds the request forever.
- The fan-out answers when **all shards reply or a majority do** (\`majority = len(shards) // 2 + 1\`).
  A reply count below the quorum fails the query rather than returning an empty page.
- The merge **dedupes by product id** (\`seen\` set / map), because a product can be indexed on more
  than one shard and the draft concatenates the duplicates.
- The response is marked **partial** whenever a shard missed: \`partial = missed > 0\`. Answering with
  a silently truncated page is the bug that makes a shopper think a product does not exist.
- Retries are **bounded by the deadline budget**: compute \`remaining = deadline - now\` before each
  attempt, stop when it is exhausted, and only the shard that failed is retried. The draft retries
  every shard on timeout, healthy ones included.

**Failure mode the checks target.** A fan-out is a distributed system wearing a function call: with
no deadline it inherits the slowest shard's latency, and with no partial flag it hides the failure.
The draft's three flaws compound — an unbounded wait amplifies load, blind retries multiply it, and
duplicate merges inflate the page so the caller cannot tell a re-indexed product from two products.
The fix is a deadline shared by the whole fan-out, a quorum, a per-id dedupe, and an honest
\`partial\` flag.`,
  sequence: {
    participants: ['Search API', 'Shard A', 'Shard B', 'Merger'],
    messages: [
      {from: 'Search API', to: 'Shard A', label: 'Search(q, filters, page) · deadline 350 ms', kind: 'sync'},
      {from: 'Search API', to: 'Shard B', label: 'Search(q, filters, page) · deadline 350 ms', kind: 'sync'},
      {from: 'Shard A', to: 'Search API', label: 'SearchReply · products', kind: 'reply'},
      {from: 'Shard B', to: 'Search API', label: 'no reply before the deadline', kind: 'async'},
      {from: 'Search API', to: 'Merger', label: 'merge · dedupe by product id · quorum', kind: 'sync'},
      {from: 'Merger', to: 'Search API', label: 'page · partial = true', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Runs every shard call under a 350 ms deadline',
      detail:
        'The fan-out carries a 350 ms deadline into every shard call (`SHARD_DEADLINE_MS = 350` with `timeout=` / a deadline / `WithTimeout` / `deadlineAfter`). The draft has no deadline, so a stuck shard blocks the request indefinitely.',
      match: {
        python: {all: [/SHARD_DEADLINE_MS\s*=\s*350/, /timeout=/]},
        typescript: {all: [/SHARD_DEADLINE_MS\s*=\s*350/, /deadline/]},
        go: {all: [/shardDeadlineMs\s*=\s*350/, /WithTimeout/]},
        scala: {all: [/ShardDeadlineMs\s*=\s*350/, /[Dd]eadlineAfter/]},
        cpp: {all: [/kShardDeadlineMs\s*=\s*350/, /deadline/]},
      },
    },
    {
      id: 'partial-result',
      title: 'Marks the response partial when a shard missed',
      detail:
        'The result carries `partial = missed > 0`, so a page that lost a shard says so. The draft returns a silently truncated page, and an absent shard looks like an absent product.',
      match: {
        python: {all: [/\bpartial\b/, /\bmissed\b/]},
        typescript: {all: [/\bpartial\b/, /\bmissed\b/]},
        go: {all: [/\bPartial\b/, /\bMissed\b/]},
        scala: {all: [/\bpartial\b/, /\bmissed\b/]},
        cpp: {all: [/\bpartial\b/, /\bmissed\b/]},
      },
    },
    {
      id: 'dedupe',
      title: 'Dedupes merged products by id',
      detail:
        'The merge keeps a `seen` set of product ids and skips a product that arrives from a second shard. The draft concatenates shard pages, so a re-indexed product appears twice.',
      match: {
        python: {all: [/\bseen\b/, /\bid\b/]},
        typescript: {all: [/\bseen\b/, /\bid\b/]},
        go: {all: [/\bseen\b/, /\.Id\b/]},
        scala: {all: [/\bseen\b/, /\.id\b/]},
        cpp: {all: [/\bseen\b/, /\.id\b/]},
      },
    },
    {
      id: 'quorum',
      title: 'Answers on all replies or a majority',
      detail:
        'The fan-out requires a majority of shards (`majority = len(shards) // 2 + 1`) or every shard to answer; below that it fails instead of returning a partial page as if it were complete. The draft ignores how many shards answered.',
      match: {
        python: {all: [/majority/, /len\(shards\)\s*\/\/\s*2/]},
        typescript: {all: [/majority/, /shards\.length\s*\/\s*2/]},
        go: {all: [/majority/, /len\(shards\)\s*\/\s*2/]},
        scala: {all: [/majority/, /shards\.size\s*\/\s*2/]},
        cpp: {all: [/majority/, /shards\.size\(\)\s*\/\s*2/]},
      },
    },
    {
      id: 'retry-budget',
      title: 'Stops retrying when the deadline budget is gone',
      detail:
        'Each attempt computes `remaining = deadline - now` and the shard is retried only while budget remains and only when it failed. The draft retries every shard — including the healthy ones — with no bound.',
      match: {
        python: {all: [/deadline/, /\bremaining\b/]},
        typescript: {all: [/deadline/, /\bremaining\b/]},
        go: {all: [/deadline/, /\bremaining\b/]},
        scala: {all: [/deadline/, /\bremaining\b/]},
        cpp: {all: [/deadline/, /\bremaining\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

logger = logging.getLogger("search-shards")

MAX_ATTEMPTS = 3


async def search_shards(shards: list[str], make_stub, request) -> dict:
    # TODO: this draft waits for the slowest shard with no deadline, retries every shard on timeout
    # including healthy ones, and merges duplicate shard results without dedupe by product id.
    # Review all three.
    merged = []
    for shard in shards:
        for attempt in range(MAX_ATTEMPTS):
            try:
                reply = await make_stub(shard).Search(request)
                merged.extend({"id": product.id, "title": product.title} for product in reply.products)
                break
            except Exception:
                logger.warning("shard failed shard=%s attempt=%d", shard, attempt)
    return {"results": merged, "page": request.page}
`,
      solution: `import asyncio
import logging
import time
from dataclasses import dataclass

import grpc

logger = logging.getLogger("search-shards")

SHARD_DEADLINE_MS = 350
MAX_ATTEMPTS = 2
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}


@dataclass
class SearchPage:
    products: list[dict]
    partial: bool


async def query_shard(shard: str, make_stub, request, deadline: float):
    attempt = 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"deadline budget exhausted for {shard}")
        try:
            return await make_stub(shard).Search(request, timeout=remaining)
        except grpc.aio.AioRpcError as error:
            attempt += 1
            if attempt >= MAX_ATTEMPTS or error.code() not in RETRYABLE:
                raise


async def search_shards(shards: list[str], make_stub, request) -> SearchPage:
    deadline = time.monotonic() + SHARD_DEADLINE_MS / 1000
    majority = len(shards) // 2 + 1
    replies = {}
    missed = 0
    for shard in shards:
        try:
            budget = max(0.0, deadline - time.monotonic())
            replies[shard] = await asyncio.wait_for(query_shard(shard, make_stub, request, deadline), timeout=budget)
        except Exception as error:
            missed += 1
            logger.warning("shard missed shard=%s error=%s", shard, type(error).__name__)

    if missed > 0 and len(replies) < majority:
        raise RuntimeError(f"quorum not met: {len(replies)}/{len(shards)} shards replied")

    products = []
    seen = set()
    for reply in replies.values():
        for product in reply.products:
            if product["id"] in seen:
                continue
            seen.add(product["id"])
            products.append({"id": product["id"], "title": product["title"]})
    return SearchPage(products=products[: request.page_size], partial=missed > 0)
`,
    },
    typescript: {
      starter: `/** Shard fan-out: a model-generated draft that waits for the slowest shard. */
import * as grpc from '@grpc/grpc-js';

interface ShardReply {
  products: Array<{id: string; title: string}>;
}

interface ShardClient {
  Search(request: {q: string; page: number}, callback: (error: grpc.ServiceError | null, reply: ShardReply) => void): void;
}

const MAX_ATTEMPTS = 3;

export async function searchShards(
  shards: string[],
  makeClient: (address: string) => ShardClient,
  request: {q: string; page: number; page_size: number},
): Promise<{results: Array<{id: string; title: string}>; page: number}> {
  // TODO: this draft waits for the slowest shard with no deadline, retries every shard on timeout
  // including healthy ones, and merges duplicate shard results without dedupe by product id.
  // Review all three.
  const merged: Array<{id: string; title: string}> = [];
  for (const shard of shards) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const reply = await new Promise<ShardReply>((resolve, reject) => {
          makeClient(shard).Search(request, (error, response) => (error ? reject(error) : resolve(response)));
        });
        merged.push(...reply.products.map(product => ({id: product.id, title: product.title})));
        break;
      } catch {
        continue;
      }
    }
  }
  return {results: merged, page: request.page};
}
`,
      solution: `/** Shard fan-out: a shared deadline, a quorum, a per-id dedupe and an honest partial flag. */
import * as grpc from '@grpc/grpc-js';

interface ShardReply {
  products: Array<{id: string; title: string}>;
}

interface ShardClient {
  Search(
    request: {q: string; page: number},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: ShardReply) => void,
  ): void;
}

const SHARD_DEADLINE_MS = 350;
const MAX_ATTEMPTS = 2;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

async function queryShard(
  shard: string,
  makeClient: (address: string) => ShardClient,
  request: {q: string; page: number},
  deadline: number,
): Promise<ShardReply> {
  let attempt = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(\`deadline budget exhausted for \${shard}\`);
    try {
      return await new Promise<ShardReply>((resolve, reject) => {
        makeClient(shard).Search(request, new grpc.Metadata(), {deadline}, (error, reply) =>
          error ? reject(error) : resolve(reply),
        );
      });
    } catch (error) {
      attempt += 1;
      const code = (error as grpc.ServiceError).code;
      if (attempt >= MAX_ATTEMPTS || RETRYABLE[code] !== true) throw error;
    }
  }
}

export async function searchShards(
  shards: string[],
  makeClient: (address: string) => ShardClient,
  request: {q: string; page: number; page_size: number},
): Promise<{results: Array<{id: string; title: string}>; partial: boolean}> {
  const deadline = Date.now() + SHARD_DEADLINE_MS;
  const majority = Math.floor(shards.length / 2) + 1;
  const replies = new Map<string, ShardReply>();
  let missed = 0;
  for (const shard of shards) {
    try {
      const remaining = Math.max(0, deadline - Date.now());
      replies.set(
        shard,
        await Promise.race([
          queryShard(shard, makeClient, request, deadline),
          new Promise<ShardReply>((_, reject) => setTimeout(() => reject(new Error('shard timeout')), remaining)),
        ]),
      );
    } catch {
      missed += 1;
    }
  }
  if (missed > 0 && replies.size < majority)
    throw new Error(\`quorum not met: \${replies.size}/\${shards.length} shards replied\`);

  const results: Array<{id: string; title: string}> = [];
  const seen = new Set<string>();
  for (const reply of replies.values()) {
    for (const product of reply.products) {
      if (seen.has(product.id)) continue;
      seen.add(product.id);
      results.push({id: product.id, title: product.title});
    }
  }
  return {results: results.slice(0, request.page_size), partial: missed > 0};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"

	pb "search/shardpb"
)

const maxAttempts = 3

func searchShards(ctx context.Context, shards []string, dial func(string) pb.ShardClient, req *pb.SearchRequest) map[string]any {
	// TODO: this draft waits for the slowest shard with no deadline, retries every shard on timeout
	// including healthy ones, and merges duplicate shard results without dedupe by product id.
	// Review all three.
	results := make([]map[string]any, 0)
	for _, shard := range shards {
		client := dial(shard)
		for attempt := 0; attempt < maxAttempts; attempt++ {
			reply, err := client.Search(ctx, req)
			if err != nil {
				continue
			}
			for _, product := range reply.Products {
				results = append(results, map[string]any{"id": product.Id, "title": product.Title})
			}
			break
		}
	}
	log.Printf("merged %d products from %d shards", len(results), len(shards))
	return map[string]any{"results": results, "page": req.Page}
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"log"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "search/shardpb"
)

const (
	shardDeadlineMs = 350
	maxAttempts     = 2
)

type SearchPage struct {
	Products []map[string]any
	Partial  bool
	Missed   int
}

func retryable(err error) bool {
	code := status.Code(err)
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

func queryShard(ctx context.Context, shard string, dial func(string) pb.ShardClient, req *pb.SearchRequest, deadline time.Time) (*pb.SearchReply, error) {
	client := dial(shard)
	attempt := 0
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, errors.New("deadline budget exhausted for " + shard)
		}
		callCtx, cancel := context.WithTimeout(ctx, remaining)
		reply, err := client.Search(callCtx, req)
		cancel()
		if err == nil {
			return reply, nil
		}
		attempt++
		if attempt >= maxAttempts || !retryable(err) {
			return nil, err
		}
	}
}

func searchShards(ctx context.Context, shards []string, dial func(string) pb.ShardClient, req *pb.SearchRequest) (SearchPage, error) {
	deadline := time.Now().Add(shardDeadlineMs * time.Millisecond)
	majority := len(shards)/2 + 1
	replies := make(map[string]*pb.SearchReply)
	missed := 0
	for _, shard := range shards {
		reply, err := queryShard(ctx, shard, dial, req, deadline)
		if err != nil {
			missed++
			log.Printf("shard missed shard=%s err=%v", shard, err)
			continue
		}
		replies[shard] = reply
	}
	if missed > 0 && len(replies) < majority {
		return SearchPage{}, errors.New("quorum not met")
	}

	products := make([]map[string]any, 0)
	seen := make(map[string]bool)
	for _, reply := range replies {
		for _, product := range reply.Products {
			if seen[product.Id] {
				continue
			}
			seen[product.Id] = true
			products = append(products, map[string]any{"id": product.Id, "title": product.Title})
		}
	}
	if len(products) > int(req.PageSize) {
		products = products[:req.PageSize]
	}
	return SearchPage{Products: products, Partial: missed > 0, Missed: missed}, nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import scala.collection.mutable

import io.grpc.ManagedChannel

import search.shardpb.{SearchReply, SearchRequest, ShardGrpc}

object ShardFanout {
  val MaxAttempts = 3

  def searchShards(shards: Seq[String], dial: String => ManagedChannel, request: SearchRequest): Map[String, Any] = {
    // TODO: this draft waits for the slowest shard with no deadline, retries every shard on timeout
    // including healthy ones, and merges duplicate shard results without dedupe by product id.
    // Review all three.
    val merged = mutable.ArrayBuffer.empty[Map[String, Any]]
    for (shard <- shards) {
      val stub = ShardGrpc.blockingStub(dial(shard))
      var attempt = 0
      var done = false
      while (attempt < MaxAttempts && !done) {
        try {
          val reply: SearchReply = stub.search(request)
          reply.products.foreach { product =>
            merged += Map("id" -> product.id, "title" -> product.title)
          }
          done = true
        } catch {
          case _: Exception => attempt += 1
        }
      }
    }
    Map("results" -> merged.toSeq, "page" -> request.page)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.collection.mutable

import io.grpc.ManagedChannel
import io.grpc.Status
import io.grpc.StatusRuntimeException

import search.shardpb.{SearchReply, SearchRequest, ShardGrpc}

object ShardFanout {
  val ShardDeadlineMs = 350
  val MaxAttempts = 2
  val retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  def queryShard(shard: String, dial: String => ManagedChannel, request: SearchRequest, deadline: Long): SearchReply = {
    val stub = ShardGrpc.blockingStub(dial(shard)).withDeadlineAfter(ShardDeadlineMs, TimeUnit.MILLISECONDS)
    var attempt = 0
    while (true) {
      val remaining = deadline - System.currentTimeMillis()
      if (remaining <= 0) throw new RuntimeException(s"deadline budget exhausted for $shard")
      try {
        return stub.search(request)
      } catch {
        case error: StatusRuntimeException =>
          attempt += 1
          if (attempt >= MaxAttempts || !retryable.contains(error.getStatus.getCode)) throw error
      }
    }
    throw new IllegalStateException("unreachable")
  }

  def searchShards(shards: Seq[String], dial: String => ManagedChannel, request: SearchRequest): Map[String, Any] = {
    val deadline = System.currentTimeMillis() + ShardDeadlineMs
    val majority = shards.size / 2 + 1
    val replies = mutable.LinkedHashMap.empty[String, SearchReply]
    var missed = 0
    for (shard <- shards) {
      try {
        replies += shard -> queryShard(shard, dial, request, deadline)
      } catch {
        case _: Exception => missed += 1
      }
    }
    if (missed > 0 && replies.size < majority) throw new RuntimeException("quorum not met")

    val products = mutable.ArrayBuffer.empty[Map[String, Any]]
    val seen = mutable.Set.empty[String]
    for (reply <- replies.values; product <- reply.products) {
      if (!seen.contains(product.id)) {
        seen += product.id
        products += Map("id" -> product.id, "title" -> product.title)
      }
    }
    Map("results" -> products.take(request.pageSize).toSeq, "partial" -> (missed > 0))
  }
}
`,
    },
    cpp: {
      starter: `#include <memory>
#include <string>
#include <vector>

#include <grpcpp/grpcpp.h>

#include "shard.grpc.pb.h"

using grpc::Channel;

constexpr int kMaxAttempts = 3;

std::vector<std::string> searchShards(const std::vector<std::string>& shards, const shard::SearchRequest& request) {
  // TODO: this draft waits for the slowest shard with no deadline, retries every shard on timeout
  // including healthy ones, and merges duplicate shard results without dedupe by product id.
  // Review all three.
  std::vector<std::string> results;
  for (const auto& shard : shards) {
    auto stub = shard::Shard::NewStub(grpc::CreateChannel(shard, grpc::InsecureChannelCredentials()));
    for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
      grpc::ClientContext context;
      shard::SearchReply reply;
      if (!stub->Search(&context, request, &reply).ok()) continue;
      for (const auto& product : reply.products()) results.push_back(product.id());
      break;
    }
  }
  return results;
}
`,
      solution: `#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <grpcpp/grpcpp.h>

#include "shard.grpc.pb.h"

constexpr int kShardDeadlineMs = 350;
constexpr int kMaxAttempts = 2;

struct SearchPage {
  std::vector<std::string> products;
  bool partial = false;
  int missed = 0;
};

std::string queryShard(const std::string& shard, const shard::SearchRequest& request, std::chrono::system_clock::time_point deadline,
                       const std::shared_ptr<shard::Shard::Stub>& stub) {
  int attempt = 0;
  while (true) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::system_clock::now());
    if (remaining.count() <= 0) throw std::runtime_error("deadline budget exhausted for " + shard);
    grpc::ClientContext context;
    context.set_deadline(deadline);
    shard::SearchReply reply;
    const auto status = stub->Search(&context, request, &reply);
    if (status.ok()) {
      std::string joined;
      for (const auto& product : reply.products()) joined += product.id() + ",";
      return joined;
    }
    ++attempt;
    if (attempt >= kMaxAttempts) throw std::runtime_error(status.error_message());
  }
}

SearchPage searchShards(const std::vector<std::string>& shards, const shard::SearchRequest& request) {
  const auto deadline = std::chrono::system_clock::now() + std::chrono::milliseconds(kShardDeadlineMs);
  const std::size_t majority = shards.size() / 2 + 1;
  std::unordered_map<std::string, std::string> replies;
  int missed = 0;
  for (const auto& shard : shards) {
    auto stub = shard::Shard::NewStub(grpc::CreateChannel(shard, grpc::InsecureChannelCredentials()));
    try {
      replies.emplace(shard, queryShard(shard, request, deadline, stub));
    } catch (const std::exception&) {
      ++missed;
    }
  }
  if (missed > 0 && replies.size() < majority) throw std::runtime_error("quorum not met");

  SearchPage page;
  std::unordered_set<std::string> seen;
  for (const auto& [shard, ids] : replies) {
    std::size_t start = 0;
    while (start < ids.size()) {
      const auto end = ids.find(',', start);
      const auto id = ids.substr(start, end == std::string::npos ? std::string::npos : end - start);
      start = end == std::string::npos ? ids.size() : end + 1;
      if (id.empty() || seen.count(id) != 0) continue;
      seen.insert(id);
      page.products.push_back(id);
    }
  }
  page.partial = missed > 0;
  page.missed = missed;
  return page;
}
`,
    },
  },
  hints: [
    "One deadline for the whole fan-out, not one per call: compute `deadline = now + 350ms` before the loop, hand it to every shard, and derive each attempt's budget as `deadline - now`. A per-call timeout lets N stuck shards each spend 350 ms and still adds up.",
    'Dedupe belongs in the merge, keyed by product id: a `seen` set (or a map) checked before the product is appended. Concatenating shard pages is how the same product that got re-indexed on two shards shows up twice in one page.',
    'The partial flag is the honesty of the whole design: `missed` counts the shards you gave up on and `partial = missed > 0` rides back to the caller. Without it a truncated page is indistinguishable from a complete one, which is the difference between "not in stock" and "we could not ask shard B".',
  ],
  debrief: `The interviewer is probing whether you can write a fan-out that fails honestly. The draft is the shape everyone writes first: iterate, call, retry forever, concatenate. Each simplification is a production defect — no deadline means the p99 of the slowest shard is your p99, unbounded retries double the load on shards that are already struggling, and an undeduped merge inflates pages. The fix is one deadline shared by the fan-out, a quorum so a single survivor does not masquerade as a full answer, per-id dedupe, and a partial flag the caller can surface. Real systems go further: hedged requests against the tail, per-shard circuit breakers, and a merge that keeps relevance scores stable so a partial page is not silently reordered.`,
};
