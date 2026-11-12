import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'A shard fan-out that says when a page is partial',
  concept: 'grpc',
  guides: ['failing-dependencies', 'deadlines-and-retries'],
  file: 'shards',
  focus: ['api', 'shards'],
  task: `## Task

**Starting point.** The starter is the fan-out across the index shards: \`fan_out(tenant, q,
page_size)\` calls \`Shard.Search\` on each of \`SHARDS\` (\`shard-0:9000\`, \`shard-1:9000\`,
\`shard-2:9000\`) in turn, skips a shard whose call fails, and answers \`{hits, partial, missed}\`
with the shards' hits concatenated and cut to \`page_size\`. With every shard healthy it answers, and
it hides four flaws.

**Failure mode the checks target.** One slow shard holds every search for as long as it takes; a
page that lost a shard says \`partial: false\`, so a missing product looks like no product; with two
shards down, a third of the index answers as if it were all of it; and a product indexed on two
shards (a replica) appears twice.

\`\`\`proto
service Shard { rpc Search(ShardQuery) returns (ShardPage); }  // ShardPage.hits: product_id, title, score
\`\`\`

- Every call carries \`SHARD_DEADLINE_S\` = 0.35 s.
- A shard whose call fails or misses the deadline goes into \`missed\` and the page is \`partial\`.
- Fewer than a majority answering (\`len(SHARDS) // 2 + 1\`) raises \`SearchUnavailable\`.
- Hits are deduplicated by \`product_id\`, keeping the highest score, ordered by score (highest
  first, ties by id), then cut to \`page_size\`.`,
  sequence: {
    participants: ['searchd', 'shard-0', 'shard-1', 'shard-2'],
    messages: [
      {from: 'searchd', to: 'shard-0', label: 'Search · deadline 350 ms', kind: 'sync'},
      {from: 'shard-0', to: 'searchd', label: 'hits p-1 0.9 · p-2 0.7', kind: 'reply'},
      {from: 'searchd', to: 'shard-1', label: 'Search · deadline 350 ms', kind: 'sync'},
      {from: 'shard-1', to: 'searchd', label: 'hits p-1 0.8 (replica) · p-3 0.4', kind: 'reply'},
      {from: 'searchd', to: 'shard-2', label: 'Search · deadline 350 ms', kind: 'sync'},
      {from: 'shard-2', to: 'searchd', label: 'DEADLINE_EXCEEDED → missed', kind: 'reply'},
      {from: 'searchd', to: 'searchd', label: '2 of 3 ≥ majority · dedupe by id · partial: true', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every shard call carries a 350 ms deadline',
      detail:
        'Each `Search` call is made with `SHARD_DEADLINE_S` (350 ms), so a slow shard misses its deadline instead of holding the search; the starter calls without one.',
      match: {
        python: {all: [/SHARD_DEADLINE_S\s*=\s*0\.35\b/, /\.Search\([\s\S]{0,200}?timeout\s*=\s*SHARD_DEADLINE_S/]},
        typescript: {all: [/SHARD_DEADLINE_MS\s*=\s*350\b/, /deadline:\s*Date\.now\(\)\s*\+\s*SHARD_DEADLINE_MS/]},
        go: {all: [/shardDeadline\s*=\s*350\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*shardDeadline\)/]},
        scala: {
          all: [
            /ShardDeadlineMillis\s*=\s*350L?\b/,
            /withDeadlineAfter\(\s*ShardDeadlineMillis,\s*TimeUnit\.MILLISECONDS/,
          ],
        },
        cpp: {all: [/kShardDeadline\{350\}/, /set_deadline\([^\n]*kShardDeadline\)/]},
      },
    },
    {
      id: 'partial',
      title: 'A page that lost a shard says so',
      detail:
        'A shard whose call failed is recorded in `missed` and the page is `partial`; the starter skips it and answers `partial: false`, so a shopper reads a short page as the whole catalog.',
      match: {
        python: {
          all: [/missed\.append\(/, /["']partial["']:\s*(bool\(missed\)|len\(missed\)\s*>\s*0)/],
          none: [/["']partial["']:\s*False/],
        },
        typescript: {all: [/missed\.push\(/, /partial:\s*missed\.length\s*>\s*0/], none: [/partial:\s*false/]},
        go: {all: [/missed = append\(missed/, /Partial:\s*len\(missed\)\s*>\s*0/], none: [/Partial:\s*false/]},
        scala: {all: [/missed\s*\+=/, /partial\s*=\s*missed\.nonEmpty/], none: [/partial\s*=\s*false/]},
        cpp: {all: [/missed\.push_back\(/, /\.partial\s*=\s*!\s*\w+\.missed\.empty\(\)/]},
      },
    },
    {
      id: 'quorum',
      title: 'Below a majority, the search is unavailable',
      detail:
        'When fewer than `len(SHARDS) // 2 + 1` shards answered, `fan_out` raises `SearchUnavailable` rather than presenting a third of the index as the result.',
      match: {
        python: {all: [/len\(SHARDS\)\s*\/\/\s*2\s*\+\s*1/, /raise SearchUnavailable/]},
        typescript: {all: [/Math\.floor\(\s*SHARDS\.length\s*\/\s*2\s*\)\s*\+\s*1/, /throw new SearchUnavailable/]},
        go: {all: [/len\(shards\)\s*\/\s*2\s*\+\s*1/, /return nil, (fmt\.Errorf\("%w[^\n]*)?ErrSearchUnavailable/]},
        scala: {all: [/Shards\.size\s*\/\s*2\s*\+\s*1/, /throw new SearchUnavailable/]},
        cpp: {all: [/kShards\.size\(\)\s*\/\s*2\s*\+\s*1/, /throw SearchUnavailable/]},
      },
    },
    {
      id: 'dedupe',
      title: 'One product once, at its best score',
      detail:
        'Hits are merged by `product_id`, keeping the highest score, and ordered by score before the page is cut; the starter concatenates the shards’ pages, so a replicated product appears twice and the cut keeps the wrong ones.',
      match: {
        python: {all: [/not in best|best\.get\(/, /-\s*\w+\[["']score["']\]|reverse\s*=\s*True/]},
        typescript: {all: [/best\.get\(/, /b\.score\s*-\s*a\.score/]},
        go: {all: [/best\[\s*h\.GetProductId\(\)\s*\]/, /sort\.Slice\(/]},
        scala: {all: [/groupBy\(\s*_\.productId\s*\)/, /-\s*\w+\.score/]},
        cpp: {all: [/best\.find\(/, /std::sort\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import product_search_pb2
import product_search_pb2_grpc

SHARDS = ("shard-0:9000", "shard-1:9000", "shard-2:9000")
stubs = {target: product_search_pb2_grpc.ShardStub(grpc.insecure_channel(target)) for target in SHARDS}


class SearchUnavailable(Exception):
    """Fewer than a majority of shards answered: there is no page worth showing."""


def fan_out(tenant: str, q: str, page_size: int) -> dict:
    """Ask every shard and merge: {"hits": [{product_id, title, score}], "partial": bool, "missed": [target]}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    hits = []
    for target in SHARDS:
        try:
            page = stubs[target].Search(product_search_pb2.ShardQuery(tenant=tenant, q=q, page_size=page_size))
        except grpc.RpcError:
            continue
        hits.extend({"product_id": h.product_id, "title": h.title, "score": h.score} for h in page.hits)
    return {"hits": hits[:page_size], "partial": False, "missed": []}
`,
      solution: `import grpc

import product_search_pb2
import product_search_pb2_grpc

SHARDS = ("shard-0:9000", "shard-1:9000", "shard-2:9000")
SHARD_DEADLINE_S = 0.35
stubs = {target: product_search_pb2_grpc.ShardStub(grpc.insecure_channel(target)) for target in SHARDS}


class SearchUnavailable(Exception):
    """Fewer than a majority of shards answered: there is no page worth showing."""


def fan_out(tenant: str, q: str, page_size: int) -> dict:
    """Ask every shard and merge: {"hits": [{product_id, title, score}], "partial": bool, "missed": [target]}."""
    best: dict[str, dict] = {}
    missed = []
    for target in SHARDS:
        try:
            page = stubs[target].Search(
                product_search_pb2.ShardQuery(tenant=tenant, q=q, page_size=page_size), timeout=SHARD_DEADLINE_S
            )
        except grpc.RpcError:
            missed.append(target)  # slow or down: the page goes out without it, and says so
            continue
        for h in page.hits:
            if h.product_id not in best or h.score > best[h.product_id]["score"]:
                best[h.product_id] = {"product_id": h.product_id, "title": h.title, "score": h.score}
    if len(SHARDS) - len(missed) < len(SHARDS) // 2 + 1:
        raise SearchUnavailable(f"{len(missed)} of {len(SHARDS)} shards did not answer")
    hits = sorted(best.values(), key=lambda hit: (-hit["score"], hit["product_id"]))
    return {"hits": hits[:page_size], "partial": bool(missed), "missed": missed}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const SHARDS = ['shard-0:9000', 'shard-1:9000', 'shard-2:9000'];

export interface ShardHit {
  product_id: string;
  title: string;
  score: number;
}

export interface Page {
  hits: ShardHit[];
  partial: boolean;
  missed: string[];
}

interface ShardQuery {
  tenant: string;
  q: string;
  page_size: number;
}

type ShardClient = grpc.Client & {
  Search(
    request: ShardQuery,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (err: grpc.ServiceError | null, page?: {hits: ShardHit[]}) => void,
  ): void;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('product_search.proto')) as unknown as {
  productsearch: {Shard: grpc.ServiceClientConstructor};
};
const stubs = new Map(SHARDS.map(target => [target, new pkg.productsearch.Shard(target, grpc.credentials.createInsecure()) as ShardClient]));

/** Fewer than a majority of shards answered: there is no page worth showing. */
export class SearchUnavailable extends Error {}

function search(target: string, query: ShardQuery): Promise<ShardHit[]> {
  return new Promise((resolve, reject) => {
    stubs.get(target)!.Search(query, new grpc.Metadata(), {}, (err, page) => (err ? reject(err) : resolve(page?.hits ?? [])));
  });
}

/** Ask every shard and merge the pages. */
export async function fanOut(tenant: string, q: string, pageSize: number): Promise<Page> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const hits: ShardHit[] = [];
  for (const target of SHARDS) {
    try {
      hits.push(...(await search(target, {tenant, q, page_size: pageSize})));
    } catch {
      continue;
    }
  }
  return {hits: hits.slice(0, pageSize), partial: false, missed: []};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const SHARDS = ['shard-0:9000', 'shard-1:9000', 'shard-2:9000'];
export const SHARD_DEADLINE_MS = 350;

export interface ShardHit {
  product_id: string;
  title: string;
  score: number;
}

export interface Page {
  hits: ShardHit[];
  partial: boolean;
  missed: string[];
}

interface ShardQuery {
  tenant: string;
  q: string;
  page_size: number;
}

type ShardClient = grpc.Client & {
  Search(
    request: ShardQuery,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (err: grpc.ServiceError | null, page?: {hits: ShardHit[]}) => void,
  ): void;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('product_search.proto')) as unknown as {
  productsearch: {Shard: grpc.ServiceClientConstructor};
};
const stubs = new Map(SHARDS.map(target => [target, new pkg.productsearch.Shard(target, grpc.credentials.createInsecure()) as ShardClient]));

/** Fewer than a majority of shards answered: there is no page worth showing. */
export class SearchUnavailable extends Error {}

function search(target: string, query: ShardQuery): Promise<ShardHit[]> {
  return new Promise((resolve, reject) => {
    const options = {deadline: Date.now() + SHARD_DEADLINE_MS};
    stubs.get(target)!.Search(query, new grpc.Metadata(), options, (err, page) => (err ? reject(err) : resolve(page?.hits ?? [])));
  });
}

/** Ask every shard and merge the pages. */
export async function fanOut(tenant: string, q: string, pageSize: number): Promise<Page> {
  const best = new Map<string, ShardHit>();
  const missed: string[] = [];
  for (const target of SHARDS) {
    let hits: ShardHit[];
    try {
      hits = await search(target, {tenant, q, page_size: pageSize});
    } catch {
      missed.push(target); // slow or down: the page goes out without it, and says so
      continue;
    }
    for (const hit of hits) {
      const seen = best.get(hit.product_id);
      if (seen === undefined || hit.score > seen.score) best.set(hit.product_id, {product_id: hit.product_id, title: hit.title, score: hit.score});
    }
  }
  if (SHARDS.length - missed.length < Math.floor(SHARDS.length / 2) + 1)
    throw new SearchUnavailable(\`\${missed.length} of \${SHARDS.length} shards did not answer\`);
  const hits = [...best.values()].sort((a, b) => b.score - a.score || (a.product_id < b.product_id ? -1 : 1));
  return {hits: hits.slice(0, pageSize), partial: missed.length > 0, missed};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "search/gen/product_search"
)

var shards = []string{"shard-0:9000", "shard-1:9000", "shard-2:9000"}

var stubs = dialShards()

func dialShards() map[string]pb.ShardClient {
	out := map[string]pb.ShardClient{}
	for _, target := range shards {
		conn, _ := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
		out[target] = pb.NewShardClient(conn)
	}
	return out
}

// ErrSearchUnavailable: fewer than a majority of shards answered, there is no page worth showing.
var ErrSearchUnavailable = errors.New("search unavailable: fewer than a majority of shards answered")

// Page is a merged page: the hits, whether a shard is missing from it, and which.
type Page struct {
	Hits    []*pb.Hit
	Partial bool
	Missed  []string
}

// fanOut asks every shard and merges the pages.
func fanOut(ctx context.Context, tenant, q string, pageSize int) (*Page, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var hits []*pb.Hit
	for _, target := range shards {
		page, err := stubs[target].Search(ctx, &pb.ShardQuery{Tenant: tenant, Q: q, PageSize: int32(pageSize)})
		if err != nil {
			continue
		}
		hits = append(hits, page.GetHits()...)
	}
	if len(hits) > pageSize {
		hits = hits[:pageSize]
	}
	return &Page{Hits: hits, Partial: false}, nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "search/gen/product_search"
)

const shardDeadline = 350 * time.Millisecond

var shards = []string{"shard-0:9000", "shard-1:9000", "shard-2:9000"}

var stubs = dialShards()

func dialShards() map[string]pb.ShardClient {
	out := map[string]pb.ShardClient{}
	for _, target := range shards {
		conn, _ := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
		out[target] = pb.NewShardClient(conn)
	}
	return out
}

// ErrSearchUnavailable: fewer than a majority of shards answered, there is no page worth showing.
var ErrSearchUnavailable = errors.New("search unavailable: fewer than a majority of shards answered")

// Page is a merged page: the hits, whether a shard is missing from it, and which.
type Page struct {
	Hits    []*pb.Hit
	Partial bool
	Missed  []string
}

// fanOut asks every shard and merges the pages.
func fanOut(ctx context.Context, tenant, q string, pageSize int) (*Page, error) {
	best := map[string]*pb.Hit{}
	var missed []string
	for _, target := range shards {
		callCtx, cancel := context.WithTimeout(ctx, shardDeadline)
		page, err := stubs[target].Search(callCtx, &pb.ShardQuery{Tenant: tenant, Q: q, PageSize: int32(pageSize)})
		cancel()
		if err != nil {
			missed = append(missed, target) // slow or down: the page goes out without it, and says so
			continue
		}
		for _, h := range page.GetHits() {
			if seen, ok := best[h.GetProductId()]; !ok || h.GetScore() > seen.GetScore() {
				best[h.GetProductId()] = h
			}
		}
	}
	if len(shards)-len(missed) < len(shards)/2+1 {
		return nil, fmt.Errorf("%w: %d of %d shards did not answer", ErrSearchUnavailable, len(missed), len(shards))
	}
	hits := make([]*pb.Hit, 0, len(best))
	for _, h := range best {
		hits = append(hits, h)
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].GetScore() != hits[j].GetScore() {
			return hits[i].GetScore() > hits[j].GetScore()
		}
		return hits[i].GetProductId() < hits[j].GetProductId()
	})
	if len(hits) > pageSize {
		hits = hits[:pageSize]
	}
	return &Page{Hits: hits, Partial: len(missed) > 0, Missed: missed}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import productsearch.product_search.{Hit, ShardGrpc, ShardQuery}

/** Fewer than a majority of shards answered: there is no page worth showing. */
final class SearchUnavailable(message: String) extends Exception(message)

object ShardFanOut {
  final case class Page(hits: Seq[Hit], partial: Boolean, missed: Seq[String])

  val Shards: Seq[String] = Seq("shard-0:9000", "shard-1:9000", "shard-2:9000")

  private val stubs = Shards.map(target => target -> ShardGrpc.blockingStub(ManagedChannelBuilder.forTarget(target).usePlaintext().build())).toMap

  /** Ask every shard and merge the pages. */
  def fanOut(tenant: String, q: String, pageSize: Int): Page = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val hits = Shards.flatMap { target =>
      try stubs(target).search(ShardQuery(tenant, q, pageSize)).hits
      catch { case _: StatusRuntimeException => Seq.empty }
    }
    Page(hits.take(pageSize), partial = false, Seq.empty)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import productsearch.product_search.{Hit, ShardGrpc, ShardQuery}

/** Fewer than a majority of shards answered: there is no page worth showing. */
final class SearchUnavailable(message: String) extends Exception(message)

object ShardFanOut {
  final case class Page(hits: Seq[Hit], partial: Boolean, missed: Seq[String])

  val Shards: Seq[String] = Seq("shard-0:9000", "shard-1:9000", "shard-2:9000")
  val ShardDeadlineMillis = 350L

  private val stubs = Shards.map(target => target -> ShardGrpc.blockingStub(ManagedChannelBuilder.forTarget(target).usePlaintext().build())).toMap

  /** Ask every shard and merge the pages. */
  def fanOut(tenant: String, q: String, pageSize: Int): Page = {
    val missed = scala.collection.mutable.ListBuffer.empty[String]
    val answered = Shards.flatMap { target =>
      try stubs(target).withDeadlineAfter(ShardDeadlineMillis, TimeUnit.MILLISECONDS).search(ShardQuery(tenant, q, pageSize)).hits
      catch {
        case _: StatusRuntimeException =>
          missed += target // slow or down: the page goes out without it, and says so
          Seq.empty
      }
    }
    if (Shards.size - missed.size < Shards.size / 2 + 1) throw new SearchUnavailable(s"\${missed.size} of \${Shards.size} shards did not answer")
    val hits = answered.groupBy(_.productId).values.map(_.maxBy(_.score)).toSeq.sortBy(hit => (-hit.score, hit.productId))
    Page(hits.take(pageSize), partial = missed.nonEmpty, missed.toSeq)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "product_search.grpc.pb.h"

const std::vector<std::string> kShards = {"shard-0:9000", "shard-1:9000", "shard-2:9000"};

std::map<std::string, std::unique_ptr<productsearch::Shard::Stub>> dialShards() {
  std::map<std::string, std::unique_ptr<productsearch::Shard::Stub>> out;
  for (const std::string& target : kShards) out[target] = productsearch::Shard::NewStub(grpc::CreateChannel(target, grpc::InsecureChannelCredentials()));
  return out;
}

auto stubs = dialShards();

// Fewer than a majority of shards answered: there is no page worth showing.
struct SearchUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// A merged page: the hits, whether a shard is missing from it, and which.
struct Page {
  std::vector<productsearch::Hit> hits;
  bool partial = false;
  std::vector<std::string> missed;
};

// Ask every shard and merge the pages.
Page fanOut(const std::string& tenant, const std::string& q, int page_size) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  Page page;
  for (const std::string& target : kShards) {
    grpc::ClientContext context;
    productsearch::ShardQuery query;
    query.set_tenant(tenant);
    query.set_q(q);
    query.set_page_size(page_size);
    productsearch::ShardPage reply;
    if (!stubs.at(target)->Search(&context, query, &reply).ok()) continue;
    for (const auto& hit : reply.hits()) page.hits.push_back(hit);
  }
  if (page.hits.size() > static_cast<size_t>(page_size)) page.hits.resize(page_size);
  return page;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "product_search.grpc.pb.h"

const std::vector<std::string> kShards = {"shard-0:9000", "shard-1:9000", "shard-2:9000"};
const std::chrono::milliseconds kShardDeadline{350};

std::map<std::string, std::unique_ptr<productsearch::Shard::Stub>> dialShards() {
  std::map<std::string, std::unique_ptr<productsearch::Shard::Stub>> out;
  for (const std::string& target : kShards) out[target] = productsearch::Shard::NewStub(grpc::CreateChannel(target, grpc::InsecureChannelCredentials()));
  return out;
}

auto stubs = dialShards();

// Fewer than a majority of shards answered: there is no page worth showing.
struct SearchUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// A merged page: the hits, whether a shard is missing from it, and which.
struct Page {
  std::vector<productsearch::Hit> hits;
  bool partial = false;
  std::vector<std::string> missed;
};

// Ask every shard and merge the pages.
Page fanOut(const std::string& tenant, const std::string& q, int page_size) {
  Page page;
  std::map<std::string, productsearch::Hit> best;
  for (const std::string& target : kShards) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + kShardDeadline);
    productsearch::ShardQuery query;
    query.set_tenant(tenant);
    query.set_q(q);
    query.set_page_size(page_size);
    productsearch::ShardPage reply;
    if (!stubs.at(target)->Search(&context, query, &reply).ok()) {
      page.missed.push_back(target);  // slow or down: the page goes out without it, and says so
      continue;
    }
    for (const auto& hit : reply.hits()) {
      const auto seen = best.find(hit.product_id());
      if (seen == best.end() || hit.score() > seen->second.score()) best[hit.product_id()] = hit;
    }
  }
  if (kShards.size() - page.missed.size() < kShards.size() / 2 + 1) {
    throw SearchUnavailable(std::to_string(page.missed.size()) + " of " + std::to_string(kShards.size()) + " shards did not answer");
  }
  for (const auto& entry : best) page.hits.push_back(entry.second);
  std::sort(page.hits.begin(), page.hits.end(), [](const productsearch::Hit& a, const productsearch::Hit& b) {
    return a.score() != b.score() ? a.score() > b.score() : a.product_id() < b.product_id();
  });
  if (page.hits.size() > static_cast<size_t>(page_size)) page.hits.resize(page_size);
  page.partial = !page.missed.empty();
  return page;
}
`,
    },
  },
  harness: {
    python: `import product_search_pb2
import product_search_pb2_grpc

PAGES = {
    "shard-0:9000": [("p-1", "Steel Kettle", 0.9), ("p-2", "Glass Kettle", 0.7)],
    "shard-1:9000": [("p-1", "Steel Kettle", 0.8), ("p-3", "Kettle Descaler", 0.4)],
    "shard-2:9000": [("p-4", "Travel Kettle", 0.6)],
}


class ShardPeer(product_search_pb2_grpc.ShardServicer):
    """One shard: its fixed page for any query, cut to the requested size."""

    def __init__(self, hits):
        self.hits = hits

    def Search(self, request, context):
        return product_search_pb2.ShardPage(
            hits=[product_search_pb2.Hit(product_id=p, title=t, score=s) for p, t, s in self.hits[: request.page_size]]
        )


def _shards(ctx):
    for target, hits in PAGES.items():
        ctx.grpc.serve(product_search_pb2_grpc.add_ShardServicer_to_server, ShardPeer(hits), target=target)
    return ctx.load("shards")


def _ids(page):
    return [hit["product_id"] for hit in page["hits"]]


def check_deadline(ctx):
    m = _shards(ctx)
    m.fan_out("t-1", "kettle", 10)
    calls = ctx.grpc.calls_to("Search")
    assert len(calls) == 3, f"fan_out made {len(calls)} Search calls, expected one per shard"
    for call in calls:
        assert call.timeout is not None, f"the Search call to {call.target} carries no deadline: one slow shard holds every search"
        assert 0.3 <= call.timeout <= 0.4, f"the Search call to {call.target} carries a {call.timeout} s deadline, expected SHARD_DEADLINE_S = 0.35"
    ctx.grpc.set_latency("Search", 5.0, target="shard-2:9000")
    page = m.fan_out("t-1", "kettle", 10)
    assert "p-4" not in _ids(page), f"the search waited for a shard 5 s slow and answered {_ids(page)}: shard-2 must miss the 350 ms deadline"


def check_partial(ctx):
    m = _shards(ctx)
    page = m.fan_out("t-1", "kettle", 10)
    assert page["partial"] is False and page["missed"] == [], f"with every shard healthy the page must not be partial, got partial={page['partial']!r} missed={page['missed']!r}"
    ctx.grpc.stop("shard-2:9000")
    page = m.fan_out("t-1", "kettle", 10)
    assert page["partial"] is True, f"a page that lost shard-2 answered partial={page['partial']!r} with {_ids(page)}: a shopper reads a short page as the whole catalog"
    assert page["missed"] == ["shard-2:9000"], f"missed is {page['missed']!r}, expected ['shard-2:9000']"
    assert "p-1" in _ids(page) and "p-4" not in _ids(page), f"the partial page holds {_ids(page)}"


def check_quorum(ctx):
    m = _shards(ctx)
    ctx.grpc.stop("shard-2:9000")
    page = m.fan_out("t-1", "kettle", 10)
    assert _ids(page), "with two of three shards answering the search must answer a page"
    ctx.grpc.stop("shard-1:9000")
    try:
        page = m.fan_out("t-1", "kettle", 10)
    except m.SearchUnavailable:
        return
    raise AssertionError(f"with one shard of three answering fan_out returned {_ids(page)} (partial={page['partial']!r}): below a majority it must raise SearchUnavailable")


def check_dedupe(ctx):
    m = _shards(ctx)
    page = m.fan_out("t-1", "kettle", 10)
    assert _ids(page) == ["p-1", "p-2", "p-4", "p-3"], f"the merged page is {_ids(page)}, expected [p-1, p-2, p-4, p-3]: one entry per product, highest score first"
    assert abs(page["hits"][0]["score"] - 0.9) < 1e-9, f"p-1 kept score {page['hits'][0]['score']}, expected its best, 0.9"
    page = m.fan_out("t-1", "kettle", 2)
    assert _ids(page) == ["p-1", "p-2"], f"page_size 2 answered {_ids(page)}, expected the two best: [p-1, p-2]"
`,
    typescript: `const PAGES: Record<string, [string, string, number][]> = {
  'shard-0:9000': [['p-1', 'Steel Kettle', 0.9], ['p-2', 'Glass Kettle', 0.7]],
  'shard-1:9000': [['p-1', 'Steel Kettle', 0.8], ['p-3', 'Kettle Descaler', 0.4]],
  'shard-2:9000': [['p-4', 'Travel Kettle', 0.6]],
};

function shards(ctx) {
  const pkg = ctx.proto('product_search.proto');
  for (const [target, hits] of Object.entries(PAGES)) {
    ctx.grpc.serve(
      pkg.productsearch.Shard.service,
      {
        Search(call, callback) {
          const page = hits.slice(0, Number(call.request.page_size)).map(([product_id, title, score]) => ({product_id, title, score}));
          callback(null, {hits: page});
        },
      },
      target,
    );
  }
  return ctx.load('shards');
}

const ids = (page): string => JSON.stringify(page.hits.map(hit => hit.product_id));

export async function check_deadline(ctx) {
  const m = shards(ctx);
  await m.fanOut('t-1', 'kettle', 10);
  const calls = ctx.grpc.callsTo('Search');
  assert.equal(calls.length, 3, \`fanOut made \${calls.length} Search calls, expected one per shard\`);
  for (const call of calls) {
    assert(call.timeout !== null && call.timeout !== undefined, \`the Search call to \${call.target} carries no deadline: one slow shard holds every search\`);
    assert(call.timeout >= 0.3 && call.timeout <= 0.4, \`the Search call to \${call.target} carries a \${call.timeout} s deadline, expected SHARD_DEADLINE_MS = 350\`);
  }
  ctx.grpc.setLatency('Search', 5.0, 'shard-2:9000');
  const page = await m.fanOut('t-1', 'kettle', 10);
  assert(!ids(page).includes('p-4'), \`the search waited for a shard 5 s slow and answered \${ids(page)}: shard-2 must miss the 350 ms deadline\`);
}

export async function check_partial(ctx) {
  const m = shards(ctx);
  let page = await m.fanOut('t-1', 'kettle', 10);
  assert(page.partial === false && page.missed.length === 0, \`with every shard healthy the page must not be partial, got partial=\${page.partial} missed=\${JSON.stringify(page.missed)}\`);
  ctx.grpc.stop('shard-2:9000');
  page = await m.fanOut('t-1', 'kettle', 10);
  assert.equal(page.partial, true, \`a page that lost shard-2 answered partial=\${page.partial} with \${ids(page)}: a shopper reads a short page as the whole catalog\`);
  assert.deepStrictEqual(page.missed, ['shard-2:9000'], \`missed is \${JSON.stringify(page.missed)}, expected ["shard-2:9000"]\`);
  assert(ids(page).includes('p-1') && !ids(page).includes('p-4'), \`the partial page holds \${ids(page)}\`);
}

export async function check_quorum(ctx) {
  const m = shards(ctx);
  ctx.grpc.stop('shard-2:9000');
  let page = await m.fanOut('t-1', 'kettle', 10);
  assert(page.hits.length > 0, 'with two of three shards answering the search must answer a page');
  ctx.grpc.stop('shard-1:9000');
  try {
    page = await m.fanOut('t-1', 'kettle', 10);
  } catch (e) {
    assert(e instanceof m.SearchUnavailable, \`below a majority fanOut threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected SearchUnavailable\`);
    return;
  }
  assert.fail(\`with one shard of three answering fanOut returned \${ids(page)} (partial=\${page.partial}): below a majority it must throw SearchUnavailable\`);
}

export async function check_dedupe(ctx) {
  const m = shards(ctx);
  let page = await m.fanOut('t-1', 'kettle', 10);
  assert.equal(ids(page), '["p-1","p-2","p-4","p-3"]', \`the merged page is \${ids(page)}, expected [p-1, p-2, p-4, p-3]: one entry per product, highest score first\`);
  assert(Math.abs(page.hits[0].score - 0.9) < 1e-9, \`p-1 kept score \${page.hits[0].score}, expected its best, 0.9\`);
  page = await m.fanOut('t-1', 'kettle', 2);
  assert.equal(ids(page), '["p-1","p-2"]', \`page size 2 answered \${ids(page)}, expected the two best: [p-1, p-2]\`);
}
`,
    go: `package main

import (
	"context"
	"math"
	"strings"
	"time"

	pb "search/gen/product_search"

	"leetbuild/harness"
)

var shardBg = context.Background()

// shardPeer is one shard: its fixed page for any query, cut to the requested size.
type shardPeer struct {
	pb.UnimplementedShardServer
	hits []*pb.Hit
}

func (s *shardPeer) Search(_ context.Context, req *pb.ShardQuery) (*pb.ShardPage, error) {
	hits := s.hits
	if int(req.GetPageSize()) < len(hits) {
		hits = hits[:req.GetPageSize()]
	}
	return &pb.ShardPage{Hits: hits}, nil
}

func serveShards(ctx *harness.Ctx) {
	// One peer per literal target: the harness keys a stand-in by the target string it is given here.
	pb.RegisterShardServer(ctx.GRPC.Server("shard-0:9000"), &shardPeer{hits: []*pb.Hit{{ProductId: "p-1", Title: "Steel Kettle", Score: 0.9}, {ProductId: "p-2", Title: "Glass Kettle", Score: 0.7}}})
	pb.RegisterShardServer(ctx.GRPC.Server("shard-1:9000"), &shardPeer{hits: []*pb.Hit{{ProductId: "p-1", Title: "Steel Kettle", Score: 0.8}, {ProductId: "p-3", Title: "Kettle Descaler", Score: 0.4}}})
	pb.RegisterShardServer(ctx.GRPC.Server("shard-2:9000"), &shardPeer{hits: []*pb.Hit{{ProductId: "p-4", Title: "Travel Kettle", Score: 0.6}}})
}

func merged(ctx *harness.Ctx, pageSize int) *Page {
	page, err := fanOut(shardBg, "t-1", "kettle", pageSize)
	ctx.NoError(err, "fanOut failed")
	return page
}

func pageIDs(page *Page) string {
	ids := []string{}
	for _, h := range page.Hits {
		ids = append(ids, h.GetProductId())
	}
	return strings.Join(ids, ",")
}

func CheckDeadline(ctx *harness.Ctx) {
	serveShards(ctx)
	merged(ctx, 10)
	calls := ctx.GRPC.CallsTo("Search", "")
	ctx.Equal(len(calls), 3, "fanOut must make one Search call per shard; the calls")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a Search call carries no deadline: one slow shard holds every search")
		ctx.Assert(300*time.Millisecond <= call.Timeout && call.Timeout <= 400*time.Millisecond, "a Search call carries a %v deadline, expected shardDeadline = 350 ms", call.Timeout)
	}
	ctx.GRPC.SetLatency("Search", 5.0, "shard-2:9000")
	page := merged(ctx, 10)
	ctx.Assert(!strings.Contains(pageIDs(page), "p-4"), "the search waited for a shard 5 s slow and answered [%s]: shard-2 must miss the 350 ms deadline", pageIDs(page))
}

func CheckPartial(ctx *harness.Ctx) {
	serveShards(ctx)
	page := merged(ctx, 10)
	ctx.Assert(!page.Partial && len(page.Missed) == 0, "with every shard healthy the page must not be partial, got Partial=%v Missed=%q", page.Partial, page.Missed)
	ctx.GRPC.Stop("shard-2:9000")
	page = merged(ctx, 10)
	ctx.Assert(page.Partial, "a page that lost shard-2 answered Partial=false with [%s]: a shopper reads a short page as the whole catalog", pageIDs(page))
	ctx.Equal(page.Missed, []string{"shard-2:9000"}, "the missed shards")
	ctx.Assert(strings.Contains(pageIDs(page), "p-1") && !strings.Contains(pageIDs(page), "p-4"), "the partial page holds [%s]", pageIDs(page))
}

func CheckQuorum(ctx *harness.Ctx) {
	serveShards(ctx)
	ctx.GRPC.Stop("shard-2:9000")
	ctx.Assert(pageIDs(merged(ctx, 10)) != "", "with two of three shards answering the search must answer a page")
	ctx.GRPC.Stop("shard-1:9000")
	page, err := fanOut(shardBg, "t-1", "kettle", 10)
	if err == nil {
		ctx.Fatalf("with one shard of three answering fanOut returned [%s] (Partial=%v): below a majority it must return ErrSearchUnavailable", pageIDs(page), page.Partial)
	}
	ctx.ErrorIs(err, ErrSearchUnavailable, "below a majority fanOut returned %v", err)
}

func CheckDedupe(ctx *harness.Ctx) {
	serveShards(ctx)
	page := merged(ctx, 10)
	ctx.Equal(pageIDs(page), "p-1,p-2,p-4,p-3", "the merged page must hold one entry per product, highest score first")
	ctx.Assert(math.Abs(page.Hits[0].GetScore()-0.9) < 1e-9, "p-1 kept score %v, expected its best, 0.9", page.Hits[0].GetScore())
	ctx.Equal(pageIDs(merged(ctx, 2)), "p-1,p-2", "page size 2 must keep the two best")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <map>
#include <string>
#include <tuple>
#include <vector>

namespace {

// One shard: its fixed page for any query, cut to the requested size.
class ShardPeer final : public productsearch::Shard::Service {
 public:
  std::vector<std::tuple<std::string, std::string, double>> hits;
  grpc::Status Search(grpc::ServerContext*, const productsearch::ShardQuery* req, productsearch::ShardPage* out) override {
    for (size_t i = 0; i < hits.size() && static_cast<int>(i) < req->page_size(); ++i) {
      auto* hit = out->add_hits();
      hit->set_product_id(std::get<0>(hits[i]));
      hit->set_title(std::get<1>(hits[i]));
      hit->set_score(std::get<2>(hits[i]));
    }
    return grpc::Status::OK;
  }
};

void serveShards(harness::Ctx& ctx) {
  static std::map<std::string, ShardPeer>* peers = nullptr;
  delete peers;
  peers = new std::map<std::string, ShardPeer>;
  (*peers)["shard-0:9000"].hits = {{"p-1", "Steel Kettle", 0.9}, {"p-2", "Glass Kettle", 0.7}};
  (*peers)["shard-1:9000"].hits = {{"p-1", "Steel Kettle", 0.8}, {"p-3", "Kettle Descaler", 0.4}};
  (*peers)["shard-2:9000"].hits = {{"p-4", "Travel Kettle", 0.6}};
  for (auto& [target, peer] : *peers) ctx.GRPC.Server(target)->RegisterService(&peer);
}

std::string pageIDs(const Page& page) {
  std::string ids;
  for (const auto& hit : page.hits) ids += (ids.empty() ? "" : ",") + hit.product_id();
  return ids;
}

Page merged(harness::Ctx& ctx, int page_size) {
  try {
    return fanOut("t-1", "kettle", page_size);
  } catch (const std::exception& e) {
    ctx.Fatalf("fanOut threw %s: %s", harness::CurrentExceptionType(), e.what());
  }
  return Page{};
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  serveShards(ctx);
  merged(ctx, 10);
  const auto calls = ctx.GRPC.CallsTo("Search");
  ctx.Equal(calls.size(), 3, "fanOut must make one Search call per shard; the calls");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a Search call carries no deadline: one slow shard holds every search");
    ctx.Assert(0.3 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 0.4, "a Search call carries a %v s deadline, expected kShardDeadline = 350 ms", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Search", 5.0, "shard-2:9000");
  const Page page = merged(ctx, 10);
  ctx.Assert(pageIDs(page).find("p-4") == std::string::npos, "the search waited for a shard 5 s slow and answered [%s]: shard-2 must miss the 350 ms deadline", pageIDs(page));
}

void CheckPartial(harness::Ctx& ctx) {
  serveShards(ctx);
  Page page = merged(ctx, 10);
  ctx.Assert(!page.partial && page.missed.empty(), "with every shard healthy the page must not be partial, got partial=%t missed=%q", page.partial, page.missed);
  ctx.GRPC.Stop("shard-2:9000");
  page = merged(ctx, 10);
  ctx.Assert(page.partial, "a page that lost shard-2 answered partial=false with [%s]: a shopper reads a short page as the whole catalog", pageIDs(page));
  ctx.Equal(page.missed, {"shard-2:9000"}, "the missed shards");
  ctx.Assert(pageIDs(page).find("p-1") != std::string::npos && pageIDs(page).find("p-4") == std::string::npos, "the partial page holds [%s]", pageIDs(page));
}

void CheckQuorum(harness::Ctx& ctx) {
  serveShards(ctx);
  ctx.GRPC.Stop("shard-2:9000");
  ctx.Assert(!pageIDs(merged(ctx, 10)).empty(), "with two of three shards answering the search must answer a page");
  ctx.GRPC.Stop("shard-1:9000");
  Page page;
  try {
    page = fanOut("t-1", "kettle", 10);
  } catch (const SearchUnavailable&) {
    return;
  } catch (const std::exception& e) {
    ctx.Fatalf("below a majority fanOut threw %s: %s, expected SearchUnavailable", harness::CurrentExceptionType(), e.what());
  }
  ctx.Fatalf("with one shard of three answering fanOut returned [%s] (partial=%t): below a majority it must throw SearchUnavailable", pageIDs(page), page.partial);
}

void CheckDedupe(harness::Ctx& ctx) {
  serveShards(ctx);
  const Page page = merged(ctx, 10);
  ctx.Equal(pageIDs(page), "p-1,p-2,p-4,p-3", "the merged page must hold one entry per product, highest score first");
  ctx.Assert(!page.hits.empty() && std::fabs(page.hits.front().score() - 0.9) < 1e-9, "p-1 kept score %v, expected its best, 0.9", page.hits.empty() ? 0.0 : page.hits.front().score());
  ctx.Equal(pageIDs(merged(ctx, 2)), "p-1,p-2", "page size 2 must keep the two best");
}
`,
  },
  hints: [
    'Stop one shard and search: the page comes back shorter and still says `partial: false`. Make a shard slow and the whole search waits for it; search with every shard up and the replicated kettle shows twice.',
    'The calls carry no deadline, the `except` branch drops the failed shard without recording it, nothing counts how many shards answered, and the merge appends every shard’s hits as they came.',
    'Pass `timeout=SHARD_DEADLINE_S`; on an error append the target to `missed`; raise `SearchUnavailable` when fewer than `len(SHARDS) // 2 + 1` answered; keep the best hit per `product_id`, sort by `-score`, cut, and set `partial = bool(missed)`.',
  ],
  debrief: `A fan-out is only as fast as its slowest shard unless each call has a deadline, and once calls can be cut short the response has to say which ones were: \`partial\` and \`missed\` are what let the storefront show "some results may be missing" instead of a confident short page. The majority rule draws the line between a page that is mostly right and one that is mostly absent. Deduplicating before the cut matters because replicas exist for availability, and the duplicate would otherwise push a real hit off the page. A production fan-out sends the calls in parallel under one shared budget, hedges a slow shard with a request to its replica, and tracks per-shard latency so the deadline follows the observed tail.`,
};
