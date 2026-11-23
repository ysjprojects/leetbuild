import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Scatter-gather over index shards with deadlines and a quorum',
  concept: 'grpc',
  guides: ['failing-dependencies', 'deadlines-and-retries'],
  file: 'client',
  focus: ['search', 'shards'],
  task: `## Task

**Starting point.** The starter is the shard client the search runs through once the corpus is split
across three \`Shard\` servers (\`SHARDS\`): \`search_shards(tenant, version, query, k)\` sends one
\`Search\` to each shard in turn, retries any error up to five times 50 ms apart, treats a shard that
does not answer as an empty list, concatenates the replies and answers \`{hits, partial: false,
answered: 3, required: 2}\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** A shard stuck in a pause holds every search open for as long as
the pause lasts; a shard that is down costs five calls per search and drops out of the answer without
a trace; with two shards down the service still answers from a third of the corpus; and the best
documents on shard 2 miss the top \`k\`.

\`\`\`proto
service Shard { rpc Search(ShardRequest) returns (ShardReply); }  // UNAVAILABLE: the shard is down
\`\`\`

- Every call carries its own \`DEADLINE_S\` (400 ms) deadline, a retry included.
- At most \`MAX_ATTEMPTS\` (2) calls per shard, the second only after \`UNAVAILABLE\`; any other code
  ends that shard's attempts.
- A shard that did not answer is missing: \`partial\` is true and \`answered\` counts the shards that
  did. A shard that answered with no hits answered.
- Fewer than \`quorum()\` answers (2 of 3) raise \`QuorumLost\`, which the API answers as 503.
- The hits are the global top \`k\` by score, ties by id.`,
  sequence: {
    participants: ['searchd', 'shard-0', 'shard-1', 'shard-2'],
    messages: [
      {from: 'searchd', to: 'shard-0', label: 'Search · deadline 400 ms', kind: 'sync'},
      {from: 'shard-0', to: 'searchd', label: 'top k of its slice', kind: 'reply'},
      {from: 'searchd', to: 'shard-1', label: 'Search · deadline 400 ms', kind: 'sync'},
      {from: 'shard-1', to: 'searchd', label: 'UNAVAILABLE → one retry → missing', kind: 'reply'},
      {from: 'searchd', to: 'shard-2', label: 'Search · deadline 400 ms', kind: 'sync'},
      {from: 'shard-2', to: 'searchd', label: 'top k of its slice', kind: 'reply'},
      {from: 'searchd', to: 'searchd', label: 'answered 2 ≥ quorum 2 · sort by score · keep k · partial', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every shard call carries a 400 ms deadline',
      detail:
        'Each `Search` call carries its own 400 ms deadline (`timeout=DEADLINE_S`, `deadline:`, `context.WithTimeout`, `set_deadline`), a retry after a late `UNAVAILABLE` included, so a stalled shard is missing instead of holding the search open. The starter sets none.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.4\b/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*400\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/400\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^)\n]*deadline\)/]},
        cpp: {all: [/kDeadline\{400\}|milliseconds\(400\)/, /set_deadline\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Two attempts at most, the second only after UNAVAILABLE',
      detail:
        'A shard is called at most `MAX_ATTEMPTS` (2) times, and again only when it answered `UNAVAILABLE`; `DEADLINE_EXCEEDED`, `INTERNAL`, `RESOURCE_EXHAUSTED` or any other code ends its attempts. The starter retries any error five times.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /StatusCode\.UNAVAILABLE/], none: [/range\(\s*5\s*\)/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /status\.UNAVAILABLE/], none: [/attempt\s*<\s*5\b/]},
        go: {all: [/maxAttempts\s*=\s*2\b/, /codes\.Unavailable/], none: [/attempt\s*<\s*5\b/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2\b/, /StatusCode::UNAVAILABLE/], none: [/attempt\s*<\s*5\b/]},
      },
    },
    {
      id: 'partial',
      title: 'A missing shard is reported, not hidden',
      detail:
        'A shard that did not answer is not an empty list, and an empty list is an answer: `answered` counts the shards that answered, hits or not, and `partial` is true when one is missing. The starter returns `partial: false` and `answered: 3` whatever happened.',
      match: {
        python: {all: [/answered\s*\+=\s*1/], none: [/["']partial["']\s*:\s*False/]},
        typescript: {all: [/answered\s*(\+=\s*1|\+\+)/], none: [/partial:\s*false/]},
        go: {all: [/answered\+\+|answered\s*\+=\s*1/], none: [/Partial:\s*false/]},
        cpp: {all: [/\+\+answered|answered\+\+|answered\s*\+=\s*1/], none: [/\.partial\s*=\s*false/]},
      },
    },
    {
      id: 'quorum',
      title: 'Below a quorum of shards the search fails',
      detail:
        'Fewer than `quorum()` answers (a majority of `SHARDS`) raise `QuorumLost`, which the API answers as 503. The starter answers from whatever came back, one shard included.',
      match: {
        python: {all: [/answered\s*<\s*quorum\(\)/, /raise QuorumLost\(/]},
        typescript: {all: [/answered\s*<\s*quorum\(\)/, /throw new QuorumLost\(/]},
        go: {all: [/answered\s*<\s*quorum\(\)/, /return [^\n]*ErrQuorumLost/]},
        cpp: {all: [/answered\s*<\s*quorum\(\)/, /throw QuorumLost\(/]},
      },
    },
    {
      id: 'merge',
      title: 'The hits are the global top k',
      detail:
        "Each shard answers its own top `k`; the merge sorts every reply by score, ties by id, before keeping `k`. The starter concatenates in shard order and cuts, so shard 0's documents crowd out better ones.",
      match: {
        python: {all: [/\.sort\(|sorted\(/]},
        typescript: {all: [/\.sort\(/]},
        go: {all: [/sort\.(Slice|SliceStable)\(/]},
        cpp: {all: [/std::(stable_)?sort\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import shard_pb2
import shard_pb2_grpc

SHARDS = ("shard-0:9000", "shard-1:9000", "shard-2:9000")

stubs = {target: shard_pb2_grpc.ShardStub(grpc.insecure_channel(target)) for target in SHARDS}


class QuorumLost(Exception):
    """Fewer than a majority of the shards answered: the search answers 503."""


def quorum() -> int:
    return len(SHARDS) // 2 + 1


def ask(target: str, request: shard_pb2.ShardRequest) -> list:
    """One shard's hits."""
    for attempt in range(5):
        try:
            return list(stubs[target].Search(request).hits)
        except grpc.RpcError:
            time.sleep(0.05)  # the shard is flaky: try again
    return []


def search_shards(tenant: str, version: str, query: list[float], k: int) -> dict:
    """The tenant's k nearest documents across every shard: {hits, partial, answered, required}."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    request = shard_pb2.ShardRequest(tenant=tenant, index_version=version, query=query, k=k)
    hits = []
    for target in SHARDS:
        hits.extend({"id": h.id, "score": h.score} for h in ask(target, request))
    return {"hits": hits[:k], "partial": False, "answered": len(SHARDS), "required": quorum()}
`,
      solution: `import grpc

import shard_pb2
import shard_pb2_grpc

SHARDS = ("shard-0:9000", "shard-1:9000", "shard-2:9000")
DEADLINE_S = 0.4
MAX_ATTEMPTS = 2

stubs = {target: shard_pb2_grpc.ShardStub(grpc.insecure_channel(target)) for target in SHARDS}


class QuorumLost(Exception):
    """Fewer than a majority of the shards answered: the search answers 503."""


def quorum() -> int:
    return len(SHARDS) // 2 + 1


def ask(target: str, request: shard_pb2.ShardRequest) -> list | None:
    """One shard's hits, or None when it did not answer."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return list(stubs[target].Search(request, timeout=DEADLINE_S).hits)
        except grpc.RpcError as exc:
            # A shard that is down may be back on the next call; a deadline already spent the budget.
            if exc.code() != grpc.StatusCode.UNAVAILABLE:
                return None
    return None


def search_shards(tenant: str, version: str, query: list[float], k: int) -> dict:
    """The tenant's k nearest documents across every shard: {hits, partial, answered, required}."""
    request = shard_pb2.ShardRequest(tenant=tenant, index_version=version, query=query, k=k)
    hits, answered = [], 0
    for target in SHARDS:
        reply = ask(target, request)
        if reply is None:
            continue  # missing, which is not the same as empty
        answered += 1
        hits.extend({"id": h.id, "score": h.score} for h in reply)
    if answered < quorum():
        raise QuorumLost(f"{answered} of {len(SHARDS)} shards answered, {quorum()} required")
    hits.sort(key=lambda h: (-h["score"], h["id"]))
    return {"hits": hits[:k], "partial": answered < len(SHARDS), "answered": answered, "required": quorum()}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Hit} from 'search/corpus';

export const SHARDS = ['shard-0:9000', 'shard-1:9000', 'shard-2:9000'];

interface ShardRequest {
  tenant: string;
  index_version: string;
  query: number[];
  k: number;
}

type ShardClient = grpc.Client & {
  Search(request: ShardRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{hits?: Hit[]}>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('shard.proto')) as unknown as {
  searchd: {Shard: grpc.ServiceClientConstructor};
};
const stubs: Record<string, ShardClient> = Object.fromEntries(
  SHARDS.map(target => [target, new pkg.searchd.Shard(target, grpc.credentials.createInsecure()) as ShardClient]),
);

/** Fewer than a majority of the shards answered: the search answers 503. */
export class QuorumLost extends Error {}

export interface Gathered {
  hits: Hit[];
  partial: boolean;
  answered: number;
  required: number;
}

export const quorum = (): number => Math.floor(SHARDS.length / 2) + 1;

/** One shard's hits. */
async function ask(target: string, request: ShardRequest): Promise<Hit[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const reply = await stubs[target].Search(request, new grpc.Metadata(), {});
      return reply.hits ?? [];
    } catch {
      const {promise, resolve} = Promise.withResolvers<void>();
      setTimeout(resolve, 50); // the shard is flaky: try again
      await promise;
    }
  }
  return [];
}

/** The tenant's k nearest documents across every shard. */
export async function searchShards(tenant: string, version: string, query: number[], k: number): Promise<Gathered> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const request = {tenant, index_version: version, query, k};
  const hits: Hit[] = [];
  for (const target of SHARDS) {
    for (const h of await ask(target, request)) hits.push({id: h.id, score: h.score});
  }
  return {hits: hits.slice(0, k), partial: false, answered: SHARDS.length, required: quorum()};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Hit} from 'search/corpus';

export const SHARDS = ['shard-0:9000', 'shard-1:9000', 'shard-2:9000'];
export const DEADLINE_MS = 400;
export const MAX_ATTEMPTS = 2;

interface ShardRequest {
  tenant: string;
  index_version: string;
  query: number[];
  k: number;
}

type ShardClient = grpc.Client & {
  Search(request: ShardRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{hits?: Hit[]}>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('shard.proto')) as unknown as {
  searchd: {Shard: grpc.ServiceClientConstructor};
};
const stubs: Record<string, ShardClient> = Object.fromEntries(
  SHARDS.map(target => [target, new pkg.searchd.Shard(target, grpc.credentials.createInsecure()) as ShardClient]),
);

/** Fewer than a majority of the shards answered: the search answers 503. */
export class QuorumLost extends Error {}

export interface Gathered {
  hits: Hit[];
  partial: boolean;
  answered: number;
  required: number;
}

export const quorum = (): number => Math.floor(SHARDS.length / 2) + 1;

/** One shard's hits, or null when it did not answer. */
async function ask(target: string, request: ShardRequest): Promise<Hit[] | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await stubs[target].Search(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return reply.hits ?? [];
    } catch (e) {
      // A shard that is down may be back on the next call; a deadline already spent the budget.
      if ((e as grpc.ServiceError).code !== grpc.status.UNAVAILABLE) return null;
    }
  }
  return null;
}

/** The tenant's k nearest documents across every shard. */
export async function searchShards(tenant: string, version: string, query: number[], k: number): Promise<Gathered> {
  const request = {tenant, index_version: version, query, k};
  const hits: Hit[] = [];
  let answered = 0;
  for (const target of SHARDS) {
    const reply = await ask(target, request);
    if (reply === null) continue; // missing, which is not the same as empty
    answered += 1;
    for (const h of reply) hits.push({id: h.id, score: h.score});
  }
  if (answered < quorum()) throw new QuorumLost(\`\${answered} of \${SHARDS.length} shards answered, \${quorum()} required\`);
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {hits: hits.slice(0, k), partial: answered < SHARDS.length, answered, required: quorum()};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"search/corpus" // corpus.Hit
	pb "search/gen/shard"
)

var shards = []string{"shard-0:9000", "shard-1:9000", "shard-2:9000"}

var stubs = func() map[string]pb.ShardClient {
	out := map[string]pb.ShardClient{}
	for _, target := range shards {
		conn, _ := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
		out[target] = pb.NewShardClient(conn)
	}
	return out
}()

// ErrQuorumLost: fewer than a majority of the shards answered; the search answers 503.
var ErrQuorumLost = errors.New("quorum lost")

// Gathered is the merged answer: the hits, whether a shard was missing, how many answered and how many are required.
type Gathered struct {
	Hits     []corpus.Hit
	Partial  bool
	Answered int
	Required int
}

func quorum() int { return len(shards)/2 + 1 }

// ask is one shard's hits.
func ask(ctx context.Context, target string, req *pb.ShardRequest) []*pb.Hit {
	for attempt := 0; attempt < 5; attempt++ {
		reply, err := stubs[target].Search(ctx, req)
		if err == nil {
			return reply.GetHits()
		}
		time.Sleep(50 * time.Millisecond) // the shard is flaky: try again
	}
	return nil
}

// searchShards is the tenant's k nearest documents across every shard.
func searchShards(ctx context.Context, tenant, version string, query []float64, k int) (Gathered, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	req := &pb.ShardRequest{Tenant: tenant, IndexVersion: version, Query: query, K: int32(k)}
	hits := []corpus.Hit{}
	for _, target := range shards {
		for _, h := range ask(ctx, target, req) {
			hits = append(hits, corpus.Hit{ID: h.GetId(), Score: h.GetScore()})
		}
	}
	if len(hits) > k {
		hits = hits[:k]
	}
	return Gathered{Hits: hits, Partial: false, Answered: len(shards), Required: quorum()}, nil
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
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"search/corpus" // corpus.Hit
	pb "search/gen/shard"
)

const (
	deadline    = 400 * time.Millisecond
	maxAttempts = 2
)

var shards = []string{"shard-0:9000", "shard-1:9000", "shard-2:9000"}

var stubs = func() map[string]pb.ShardClient {
	out := map[string]pb.ShardClient{}
	for _, target := range shards {
		conn, _ := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
		out[target] = pb.NewShardClient(conn)
	}
	return out
}()

// ErrQuorumLost: fewer than a majority of the shards answered; the search answers 503.
var ErrQuorumLost = errors.New("quorum lost")

// Gathered is the merged answer: the hits, whether a shard was missing, how many answered and how many are required.
type Gathered struct {
	Hits     []corpus.Hit
	Partial  bool
	Answered int
	Required int
}

func quorum() int { return len(shards)/2 + 1 }

// ask is one shard's hits; ok is false when the shard did not answer.
func ask(ctx context.Context, target string, req *pb.ShardRequest) (hits []*pb.Hit, ok bool) {
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stubs[target].Search(callCtx, req)
		cancel()
		if err == nil {
			return reply.GetHits(), true
		}
		// A shard that is down may be back on the next call; a deadline already spent the budget.
		if status.Code(err) != codes.Unavailable {
			return nil, false
		}
	}
	return nil, false
}

// searchShards is the tenant's k nearest documents across every shard.
func searchShards(ctx context.Context, tenant, version string, query []float64, k int) (Gathered, error) {
	req := &pb.ShardRequest{Tenant: tenant, IndexVersion: version, Query: query, K: int32(k)}
	hits := []corpus.Hit{}
	answered := 0
	for _, target := range shards {
		got, ok := ask(ctx, target, req)
		if !ok {
			continue // missing, which is not the same as empty
		}
		answered++
		for _, h := range got {
			hits = append(hits, corpus.Hit{ID: h.GetId(), Score: h.GetScore()})
		}
	}
	if answered < quorum() {
		return Gathered{}, fmt.Errorf("%w: %d of %d shards answered, %d required", ErrQuorumLost, answered, len(shards), quorum())
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].ID < hits[j].ID
	})
	if len(hits) > k {
		hits = hits[:k]
	}
	return Gathered{Hits: hits, Partial: answered < len(shards), Answered: answered, Required: quorum()}, nil
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "search/corpus.h"  // corpus::Hit
#include "shard.grpc.pb.h"

const std::vector<std::string> kShards = {"shard-0:9000", "shard-1:9000", "shard-2:9000"};

// Fewer than a majority of the shards answered: the search answers 503.
struct QuorumLost : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The merged answer: the hits, whether a shard was missing, how many answered and how many are required.
struct Gathered {
  std::vector<corpus::Hit> hits;
  bool partial = false;
  int answered = 0;
  int required = 0;
};

searchd::Shard::Stub& stub(const std::string& target) {
  static std::map<std::string, std::unique_ptr<searchd::Shard::Stub>> stubs;
  auto& s = stubs[target];
  if (!s) s = searchd::Shard::NewStub(grpc::CreateChannel(target, grpc::InsecureChannelCredentials()));
  return *s;
}

int quorum() { return static_cast<int>(kShards.size()) / 2 + 1; }

// One shard's hits.
std::vector<corpus::Hit> ask(const std::string& target, const searchd::ShardRequest& request) {
  for (int attempt = 0; attempt < 5; ++attempt) {
    grpc::ClientContext ctx;
    searchd::ShardReply reply;
    if (stub(target).Search(&ctx, request, &reply).ok()) {
      std::vector<corpus::Hit> hits;
      for (const auto& h : reply.hits()) hits.push_back(corpus::Hit{h.id(), h.score()});
      return hits;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));  // the shard is flaky: try again
  }
  return {};
}

// The tenant's k nearest documents across every shard.
Gathered searchShards(const std::string& tenant, const std::string& version, const std::vector<double>& query, long k) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  searchd::ShardRequest request;
  request.set_tenant(tenant);
  request.set_index_version(version);
  for (double x : query) request.add_query(x);
  request.set_k(static_cast<int>(k));
  Gathered out;
  for (const std::string& target : kShards) {
    for (const corpus::Hit& h : ask(target, request)) out.hits.push_back(h);
  }
  if (static_cast<long>(out.hits.size()) > k) out.hits.resize(k);
  out.partial = false;
  out.answered = static_cast<int>(kShards.size());
  out.required = quorum();
  return out;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "search/corpus.h"  // corpus::Hit
#include "shard.grpc.pb.h"

const std::vector<std::string> kShards = {"shard-0:9000", "shard-1:9000", "shard-2:9000"};
constexpr std::chrono::milliseconds kDeadline{400};
constexpr int kMaxAttempts = 2;

// Fewer than a majority of the shards answered: the search answers 503.
struct QuorumLost : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The merged answer: the hits, whether a shard was missing, how many answered and how many are required.
struct Gathered {
  std::vector<corpus::Hit> hits;
  bool partial = false;
  int answered = 0;
  int required = 0;
};

searchd::Shard::Stub& stub(const std::string& target) {
  static std::map<std::string, std::unique_ptr<searchd::Shard::Stub>> stubs;
  auto& s = stubs[target];
  if (!s) s = searchd::Shard::NewStub(grpc::CreateChannel(target, grpc::InsecureChannelCredentials()));
  return *s;
}

int quorum() { return static_cast<int>(kShards.size()) / 2 + 1; }

// One shard's hits, or none when it did not answer.
std::optional<std::vector<corpus::Hit>> ask(const std::string& target, const searchd::ShardRequest& request) {
  for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    searchd::ShardReply reply;
    const grpc::Status status = stub(target).Search(&ctx, request, &reply);
    if (status.ok()) {
      std::vector<corpus::Hit> hits;
      for (const auto& h : reply.hits()) hits.push_back(corpus::Hit{h.id(), h.score()});
      return hits;
    }
    // A shard that is down may be back on the next call; a deadline already spent the budget.
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE) return std::nullopt;
  }
  return std::nullopt;
}

// The tenant's k nearest documents across every shard.
Gathered searchShards(const std::string& tenant, const std::string& version, const std::vector<double>& query, long k) {
  searchd::ShardRequest request;
  request.set_tenant(tenant);
  request.set_index_version(version);
  for (double x : query) request.add_query(x);
  request.set_k(static_cast<int>(k));
  Gathered out;
  int answered = 0;
  for (const std::string& target : kShards) {
    const auto reply = ask(target, request);
    if (!reply) continue;  // missing, which is not the same as empty
    ++answered;
    out.hits.insert(out.hits.end(), reply->begin(), reply->end());
  }
  if (answered < quorum()) {
    throw QuorumLost(std::to_string(answered) + " of " + std::to_string(kShards.size()) + " shards answered, " + std::to_string(quorum()) + " required");
  }
  std::sort(out.hits.begin(), out.hits.end(), [](const corpus::Hit& a, const corpus::Hit& b) { return a.score != b.score ? a.score > b.score : a.id < b.id; });
  if (static_cast<long>(out.hits.size()) > k) out.hits.resize(k);
  out.partial = answered < static_cast<int>(kShards.size());
  out.answered = answered;
  out.required = quorum();
  return out;
}
`,
    },
  },
  harness: {
    python: `import grpc

import shard_pb2
import shard_pb2_grpc

SHARDS = ("shard-0:9000", "shard-1:9000", "shard-2:9000")
QUERY = [1.0, 0.0, 0.0, 0.0]
# Each shard's slice of acme's namespace in idx-42, as (id, score): the best documents live on shard-2.
SLICES = {
    "shard-0:9000": [("s0-a", 0.40), ("s0-b", 0.30), ("s0-c", 0.20)],
    "shard-1:9000": [("s1-a", 0.70), ("s1-b", 0.10)],
    "shard-2:9000": [("s2-a", 0.95), ("s2-b", 0.60)],
}


# Tenant ties: one document per shard, every score equal, so only the id orders them.
TIES = {"shard-0:9000": [("t-c", 0.5)], "shard-1:9000": [("t-b", 0.5)], "shard-2:9000": [("t-a", 0.5)]}


class ShardPeer(shard_pb2_grpc.ShardServicer):
    """One shard: its slice's best k for acme (or ties) in idx-42, nothing for anyone else. For tenant
    flaky, shard-1 answers UNAVAILABLE once its latency has passed: a shard that fails late."""

    def __init__(self, target):
        self.target = target

    def Search(self, request, context):
        if request.tenant == "flaky" and self.target == "shard-1:9000":
            context.abort(grpc.StatusCode.UNAVAILABLE, "shard restarting")
        slices = {"acme": SLICES, "ties": TIES}.get(request.tenant)
        if slices is None or request.index_version != "idx-42":
            return shard_pb2.ShardReply()
        best = sorted(slices[self.target], key=lambda h: -h[1])[: request.k]
        return shard_pb2.ShardReply(hits=[shard_pb2.Hit(id=i, score=s) for i, s in best])


def _client(ctx):
    for target in SHARDS:
        ctx.grpc.serve(shard_pb2_grpc.add_ShardServicer_to_server, ShardPeer(target), target=target)
    return ctx.load("client")


def _ids(result):
    return [h["id"] for h in result["hits"]]


def _calls(ctx, target):
    return len(ctx.grpc.calls_to("Search", target=target))


def _search_any(m, tenant="acme"):
    """A search for checks that only count calls: QuorumLost is an outcome too."""
    try:
        m.search_shards(tenant, "idx-42", QUERY, 3)
    except m.QuorumLost:
        pass


def check_deadline(ctx):
    m = _client(ctx)
    ctx.grpc.set_latency("Search", 5.0, target="shard-2:9000")
    result = m.search_shards("acme", "idx-42", QUERY, 3)
    for call in ctx.grpc.calls_to("Search"):
        assert call.timeout is not None, f"a Search call to {call.target} carries no deadline: a stalled shard holds the search open for as long as it stalls"
        assert 0.3 <= call.timeout <= 0.5, f"a Search call carries a {call.timeout} s deadline, expected DEADLINE_S = 0.4"
    assert result["partial"] is True and result["answered"] == 2, f"shard-2 answers after 5 s, past the deadline: it is missing, so partial must be true and answered 2, got {result}"
    assert _ids(result) == ["s1-a", "s0-a", "s0-b"], f"the answer must be the top 3 of shard-0 and shard-1, got {result}"
    # shard-1 now answers UNAVAILABLE only after 300 ms: the retry must still get its own 400 ms.
    ctx.grpc.set_latency("Search", 0.0, target="shard-2:9000")
    ctx.grpc.set_latency("Search", 0.3, target="shard-1:9000")
    before = _calls(ctx, "shard-1:9000")
    _search_any(m, "flaky")
    late = ctx.grpc.calls_to("Search", target="shard-1:9000")[before:]
    assert len(late) == 2, f"shard-1 answered UNAVAILABLE after 300 ms and was called {len(late)} times in one search, expected a first call and one retry"
    assert all(c.timeout is not None and 0.3 <= c.timeout <= 0.5 for c in late), f"after a first call that failed 300 ms in, the calls to shard-1 carried deadlines {[c.timeout for c in late]}: every attempt gets its own full 400 ms, not what is left of the first one"


def check_retry_policy(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Search", grpc.StatusCode.UNAVAILABLE, "shard restarting", times=1, target="shard-1:9000")
    result = m.search_shards("acme", "idx-42", QUERY, 3)
    assert _calls(ctx, "shard-1:9000") == 2 and result["answered"] == 3, f"shard-1 answered UNAVAILABLE once: one more call must reach it, got {_calls(ctx, 'shard-1:9000')} calls and {result}"
    ctx.grpc.stop("shard-2:9000")
    before = _calls(ctx, "shard-2:9000")
    _search_any(m)
    stopped = _calls(ctx, "shard-2:9000") - before
    assert stopped == 2, f"a shard that is down was called {stopped} times in one search, expected MAX_ATTEMPTS = 2"
    for code in (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.INTERNAL, grpc.StatusCode.RESOURCE_EXHAUSTED, grpc.StatusCode.INVALID_ARGUMENT):
        ctx.grpc.fail("Search", code, "terminal", times=1, target="shard-0:9000")
        before = _calls(ctx, "shard-0:9000")
        _search_any(m)
        terminal = _calls(ctx, "shard-0:9000") - before
        assert terminal == 1, f"a shard that answered {code.name} was called {terminal} times in one search: only UNAVAILABLE is retried"


def check_partial(ctx):
    m = _client(ctx)
    try:
        empty = m.search_shards("globex", "idx-42", QUERY, 3)
    except m.QuorumLost:
        raise AssertionError("every shard answered globex with no hits and search_shards raised QuorumLost: an empty answer is an answer, only a shard that did not answer is missing") from None
    assert empty["hits"] == [] and empty["partial"] is False and empty["answered"] == 3, f"every shard answered globex with no hits: the answer is complete and empty (answered 3, partial false), got {empty}"
    ctx.grpc.stop("shard-1:9000")
    result = m.search_shards("acme", "idx-42", QUERY, 3)
    assert result["partial"] is True, f"with shard-1 down the answer must say partial, got {result}: a dead shard is not an empty one"
    assert result["answered"] == 2 and result["required"] == 2, f"answered must count the 2 shards that answered (required 2), got {result}"
    assert _ids(result) == ["s2-a", "s2-b", "s0-a"], f"the answer must be the top 3 of shard-0 and shard-2, got {result}"


def check_quorum(ctx):
    m = _client(ctx)
    ctx.grpc.stop("shard-1:9000")
    ctx.grpc.stop("shard-2:9000")
    try:
        result = m.search_shards("acme", "idx-42", QUERY, 3)
    except m.QuorumLost:
        return
    raise AssertionError(f"with 2 of 3 shards down search_shards answered {result}: below a quorum of 2 it must raise QuorumLost")


def check_merge(ctx):
    m = _client(ctx)
    result = m.search_shards("acme", "idx-42", QUERY, 3)
    for call in ctx.grpc.calls_to("Search"):
        r = call.request
        assert r.tenant == "acme" and r.index_version == "idx-42" and r.k == 3 and list(r.query) == QUERY, f"every shard must be asked for acme's top 3 in idx-42, {call.target} got {r}"
    assert _ids(result) == ["s2-a", "s1-a", "s2-b"], f"the global top 3 by score are s2-a (0.95), s1-a (0.70), s2-b (0.60); the merge answered {_ids(result)}"
    assert result["partial"] is False and result["answered"] == 3, f"with every shard healthy the answer is complete, got {result}"
    ties = m.search_shards("ties", "idx-42", QUERY, 2)
    assert _ids(ties) == ["t-a", "t-b"], f"t-c (shard-0), t-b (shard-1) and t-a (shard-2) all score 0.5, so the top 2 are t-a and t-b by id; the merge answered {_ids(ties)}"
`,
    typescript: `const SHARDS = ['shard-0:9000', 'shard-1:9000', 'shard-2:9000'];
const QUERY = [1, 0, 0, 0];
/** Each shard's slice of acme's namespace in idx-42, as [id, score]: the best documents live on shard-2. */
const SLICES: Record<string, [string, number][]> = {
  'shard-0:9000': [['s0-a', 0.4], ['s0-b', 0.3], ['s0-c', 0.2]],
  'shard-1:9000': [['s1-a', 0.7], ['s1-b', 0.1]],
  'shard-2:9000': [['s2-a', 0.95], ['s2-b', 0.6]],
};
/** Tenant ties: one document per shard, every score equal, so only the id orders them. */
const TIES: Record<string, [string, number][]> = {
  'shard-0:9000': [['t-c', 0.5]],
  'shard-1:9000': [['t-b', 0.5]],
  'shard-2:9000': [['t-a', 0.5]],
};

/** acme (or ties) in idx-42 per SLICES; anyone else gets nothing. For tenant flaky, shard-1 answers UNAVAILABLE once its latency has passed: a shard that fails late. */
function client(ctx) {
  const pkg = ctx.proto('shard.proto');
  for (const target of SHARDS) {
    ctx.grpc.serve(
      pkg.searchd.Shard.service,
      {
        Search(call, callback) {
          const {tenant, index_version, k} = call.request;
          if (tenant === 'flaky' && target === 'shard-1:9000') return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'shard restarting'});
          const slices = tenant === 'acme' ? SLICES : tenant === 'ties' ? TIES : null;
          if (slices === null || index_version !== 'idx-42') return callback(null, {hits: []});
          const best = [...slices[target]].sort((a, b) => b[1] - a[1]).slice(0, Number(k));
          callback(null, {hits: best.map(([id, score]) => ({id, score}))});
        },
      },
      target,
    );
  }
  return ctx.load('client');
}

const ids = result => result.hits.map(h => h.id).join(',');
const calls = (ctx, target: string): number => ctx.grpc.callsTo('Search', target).length;

/** A search for checks that only count calls: QuorumLost is an outcome too. */
async function searchAny(m, tenant = 'acme'): Promise<void> {
  try {
    await m.searchShards(tenant, 'idx-42', QUERY, 3);
  } catch (e) {
    if (!(e instanceof m.QuorumLost)) throw e;
  }
}

export async function check_deadline(ctx) {
  const m = client(ctx);
  ctx.grpc.setLatency('Search', 5, 'shard-2:9000');
  const result = await m.searchShards('acme', 'idx-42', QUERY, 3);
  for (const call of ctx.grpc.callsTo('Search')) {
    assert(call.timeout !== null, \`a Search call to \${call.target} carries no deadline: a stalled shard holds the search open for as long as it stalls\`);
    assert(call.timeout >= 0.3 && call.timeout <= 0.5, \`a Search call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 400\`);
  }
  assert(result.partial === true && result.answered === 2, \`shard-2 answers after 5 s, past the deadline: it is missing, so partial must be true and answered 2, got \${JSON.stringify(result)}\`);
  assert.equal(ids(result), 's1-a,s0-a,s0-b', \`the answer must be the top 3 of shard-0 and shard-1, got \${JSON.stringify(result)}\`);
  // shard-1 now answers UNAVAILABLE only after 300 ms: the retry must still get its own 400 ms.
  ctx.grpc.setLatency('Search', 0, 'shard-2:9000');
  ctx.grpc.setLatency('Search', 0.3, 'shard-1:9000');
  const before = calls(ctx, 'shard-1:9000');
  await searchAny(m, 'flaky');
  const late = ctx.grpc.callsTo('Search', 'shard-1:9000').slice(before);
  assert.equal(late.length, 2, \`shard-1 answered UNAVAILABLE after 300 ms and was called \${late.length} times in one search, expected a first call and one retry\`);
  assert(
    late.every(c => c.timeout !== null && c.timeout >= 0.3 && c.timeout <= 0.5),
    \`after a first call that failed 300 ms in, the calls to shard-1 carried deadlines \${JSON.stringify(late.map(c => c.timeout))}: every attempt gets its own full 400 ms, not what is left of the first one\`,
  );
}

export async function check_retry_policy(ctx) {
  const m = client(ctx);
  ctx.grpc.fail('Search', ctx.grpc.status.UNAVAILABLE, 'shard restarting', 1, 'shard-1:9000');
  const result = await m.searchShards('acme', 'idx-42', QUERY, 3);
  assert(calls(ctx, 'shard-1:9000') === 2 && result.answered === 3, \`shard-1 answered UNAVAILABLE once: one more call must reach it, got \${calls(ctx, 'shard-1:9000')} calls and \${JSON.stringify(result)}\`);
  ctx.grpc.stop('shard-2:9000');
  let before = calls(ctx, 'shard-2:9000');
  await searchAny(m);
  const stopped = calls(ctx, 'shard-2:9000') - before;
  assert.equal(stopped, 2, \`a shard that is down was called \${stopped} times in one search, expected MAX_ATTEMPTS = 2\`);
  for (const code of ['DEADLINE_EXCEEDED', 'INTERNAL', 'RESOURCE_EXHAUSTED', 'INVALID_ARGUMENT']) {
    ctx.grpc.fail('Search', ctx.grpc.status[code], 'terminal', 1, 'shard-0:9000');
    before = calls(ctx, 'shard-0:9000');
    await searchAny(m);
    const terminal = calls(ctx, 'shard-0:9000') - before;
    assert.equal(terminal, 1, \`a shard that answered \${code} was called \${terminal} times in one search: only UNAVAILABLE is retried\`);
  }
}

export async function check_partial(ctx) {
  const m = client(ctx);
  let empty;
  try {
    empty = await m.searchShards('globex', 'idx-42', QUERY, 3);
  } catch (e) {
    if (!(e instanceof m.QuorumLost)) throw e;
    assert.fail('every shard answered globex with no hits and searchShards threw QuorumLost: an empty answer is an answer, only a shard that did not answer is missing');
  }
  assert(
    empty.hits.length === 0 && empty.partial === false && empty.answered === 3,
    \`every shard answered globex with no hits: the answer is complete and empty (answered 3, partial false), got \${JSON.stringify(empty)}\`,
  );
  ctx.grpc.stop('shard-1:9000');
  const result = await m.searchShards('acme', 'idx-42', QUERY, 3);
  assert.equal(result.partial, true, \`with shard-1 down the answer must say partial, got \${JSON.stringify(result)}: a dead shard is not an empty one\`);
  assert(result.answered === 2 && result.required === 2, \`answered must count the 2 shards that answered (required 2), got \${JSON.stringify(result)}\`);
  assert.equal(ids(result), 's2-a,s2-b,s0-a', \`the answer must be the top 3 of shard-0 and shard-2, got \${JSON.stringify(result)}\`);
}

export async function check_quorum(ctx) {
  const m = client(ctx);
  ctx.grpc.stop('shard-1:9000');
  ctx.grpc.stop('shard-2:9000');
  let result;
  try {
    result = await m.searchShards('acme', 'idx-42', QUERY, 3);
  } catch (e) {
    if (e instanceof m.QuorumLost) return;
    throw e;
  }
  assert.fail(\`with 2 of 3 shards down searchShards answered \${JSON.stringify(result)}: below a quorum of 2 it must throw QuorumLost\`);
}

export async function check_merge(ctx) {
  const m = client(ctx);
  const result = await m.searchShards('acme', 'idx-42', QUERY, 3);
  for (const call of ctx.grpc.callsTo('Search')) {
    const r = call.request;
    assert(r.tenant === 'acme' && r.index_version === 'idx-42' && Number(r.k) === 3 && r.query.join() === QUERY.join(), \`every shard must be asked for acme's top 3 in idx-42, \${call.target} got \${JSON.stringify(r)}\`);
  }
  assert.equal(ids(result), 's2-a,s1-a,s2-b', \`the global top 3 by score are s2-a (0.95), s1-a (0.70), s2-b (0.60); the merge answered \${ids(result)}\`);
  assert(result.partial === false && result.answered === 3, \`with every shard healthy the answer is complete, got \${JSON.stringify(result)}\`);
  const ties = await m.searchShards('ties', 'idx-42', QUERY, 2);
  assert.equal(ids(ties), 't-a,t-b', \`t-c (shard-0), t-b (shard-1) and t-a (shard-2) all score 0.5, so the top 2 are t-a and t-b by id; the merge answered \${ids(ties)}\`);
}
`,
    go: `package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "search/gen/shard"

	"leetbuild/harness"
)

var (
	hClientBg     = context.Background()
	hClientQuery  = []float64{1, 0, 0, 0}
	hShardTargets = []string{"shard-0:9000", "shard-1:9000", "shard-2:9000"}
)

type HSliceHit struct {
	id    string
	score float64
}

// hShardSlices is each shard's slice of acme's namespace in idx-42: the best documents live on shard-2.
var hShardSlices = map[string][]HSliceHit{
	"shard-0:9000": {{"s0-a", 0.40}, {"s0-b", 0.30}, {"s0-c", 0.20}},
	"shard-1:9000": {{"s1-a", 0.70}, {"s1-b", 0.10}},
	"shard-2:9000": {{"s2-a", 0.95}, {"s2-b", 0.60}},
}

// hTiedSlices is tenant ties: one document per shard, every score equal, so only the id orders them.
var hTiedSlices = map[string][]HSliceHit{
	"shard-0:9000": {{"t-c", 0.5}},
	"shard-1:9000": {{"t-b", 0.5}},
	"shard-2:9000": {{"t-a", 0.5}},
}

// HShardPeer answers its slice's best k for acme (or ties) in idx-42, nothing for anyone else. For
// tenant flaky, shard-1 answers UNAVAILABLE once its latency has passed: a shard that fails late.
type HShardPeer struct {
	pb.UnimplementedShardServer
	target string
}

func (p *HShardPeer) Search(_ context.Context, req *pb.ShardRequest) (*pb.ShardReply, error) {
	if req.GetTenant() == "flaky" && p.target == "shard-1:9000" {
		return nil, status.Error(codes.Unavailable, "shard restarting")
	}
	slices := map[string]map[string][]HSliceHit{"acme": hShardSlices, "ties": hTiedSlices}[req.GetTenant()]
	if slices == nil || req.GetIndexVersion() != "idx-42" {
		return &pb.ShardReply{}, nil
	}
	best := append([]HSliceHit(nil), slices[p.target]...)
	sort.Slice(best, func(i, j int) bool { return best[i].score > best[j].score })
	if int(req.GetK()) < len(best) {
		best = best[:req.GetK()]
	}
	reply := &pb.ShardReply{}
	for _, h := range best {
		reply.Hits = append(reply.Hits, &pb.Hit{Id: h.id, Score: h.score})
	}
	return reply, nil
}

func hServeShards(ctx *harness.Ctx) {
	for _, target := range hShardTargets {
		// Bound to a variable first: the Go runtime reuses one &T{} literal passed straight to a call in a loop.
		peer := &HShardPeer{target: target}
		pb.RegisterShardServer(ctx.GRPC.Server(target), peer)
	}
}

func hGatheredIDs(g Gathered) string {
	ids := []string{}
	for _, h := range g.Hits {
		ids = append(ids, h.ID)
	}
	return strings.Join(ids, ",")
}

func hMustGather(ctx *harness.Ctx) Gathered {
	g, err := searchShards(hClientBg, "acme", "idx-42", hClientQuery, 3)
	ctx.NoError(err, "searchShards(acme, idx-42, …, 3)")
	return g
}

func hCallCount(ctx *harness.Ctx, target string) int { return len(ctx.GRPC.CallsTo("Search", target)) }

func CheckDeadline(ctx *harness.Ctx) {
	hServeShards(ctx)
	ctx.GRPC.SetLatency("Search", 5, "shard-2:9000")
	g := hMustGather(ctx)
	for _, call := range ctx.GRPC.CallsTo("Search", "") {
		ctx.Assert(call.HasDeadline(), "a Search call to %s carries no deadline: a stalled shard holds the search open for as long as it stalls", call.Target)
		ctx.Assert(call.Timeout >= 300*time.Millisecond && call.Timeout <= 500*time.Millisecond, "a Search call carries a %v deadline, expected 400 ms", call.Timeout)
	}
	ctx.Assert(g.Partial && g.Answered == 2, "shard-2 answers after 5 s, past the deadline: it is missing, so Partial must be true and Answered 2, got %+v", g)
	ctx.Equal(hGatheredIDs(g), "s1-a,s0-a,s0-b", "the answer must be the top 3 of shard-0 and shard-1")
	// shard-1 now answers UNAVAILABLE only after 300 ms: the retry must still get its own 400 ms.
	ctx.GRPC.SetLatency("Search", 0, "shard-2:9000")
	ctx.GRPC.SetLatency("Search", 0.3, "shard-1:9000")
	before := hCallCount(ctx, "shard-1:9000")
	searchShards(hClientBg, "flaky", "idx-42", hClientQuery, 3)
	late := ctx.GRPC.CallsTo("Search", "shard-1:9000")[before:]
	ctx.Equal(len(late), 2, "shard-1 answered UNAVAILABLE after 300 ms: a first call and one retry; calls")
	for _, call := range late {
		ctx.Assert(call.HasDeadline() && call.Timeout >= 300*time.Millisecond && call.Timeout <= 500*time.Millisecond, "after a first call that failed 300 ms in, a call to shard-1 carried a %v deadline: every attempt gets its own full 400 ms, not what is left of the first one", call.Timeout)
	}
}

func CheckRetryPolicy(ctx *harness.Ctx) {
	hServeShards(ctx)
	ctx.GRPC.Fail("Search", codes.Unavailable, "shard restarting", 1, "shard-1:9000")
	g := hMustGather(ctx)
	ctx.Assert(hCallCount(ctx, "shard-1:9000") == 2 && g.Answered == 3, "shard-1 answered UNAVAILABLE once: one more call must reach it, got %d calls and %+v", hCallCount(ctx, "shard-1:9000"), g)
	ctx.GRPC.Stop("shard-2:9000")
	before := hCallCount(ctx, "shard-2:9000")
	searchShards(hClientBg, "acme", "idx-42", hClientQuery, 3)
	ctx.Equal(hCallCount(ctx, "shard-2:9000")-before, 2, "a shard that is down must be called maxAttempts = 2 times in one search; calls")
	for _, code := range []codes.Code{codes.DeadlineExceeded, codes.Internal, codes.ResourceExhausted, codes.InvalidArgument} {
		ctx.GRPC.Fail("Search", code, "terminal", 1, "shard-0:9000")
		before = hCallCount(ctx, "shard-0:9000")
		searchShards(hClientBg, "acme", "idx-42", hClientQuery, 3)
		ctx.Equal(hCallCount(ctx, "shard-0:9000")-before, 1, "a shard that answered %v must not be called again in the same search (only UNAVAILABLE is retried); calls", code)
	}
}

func CheckPartial(ctx *harness.Ctx) {
	hServeShards(ctx)
	empty, err := searchShards(hClientBg, "globex", "idx-42", hClientQuery, 3)
	ctx.Assert(err == nil, "every shard answered globex with no hits and searchShards returned %v: an empty answer is an answer, only a shard that did not answer is missing", err)
	ctx.Assert(len(empty.Hits) == 0 && !empty.Partial && empty.Answered == 3, "every shard answered globex with no hits: the answer is complete and empty (Answered 3, Partial false), got %+v", empty)
	ctx.GRPC.Stop("shard-1:9000")
	g := hMustGather(ctx)
	ctx.Assert(g.Partial, "with shard-1 down the answer must say Partial, got %+v: a dead shard is not an empty one", g)
	ctx.Assert(g.Answered == 2 && g.Required == 2, "Answered must count the 2 shards that answered (Required 2), got %+v", g)
	ctx.Equal(hGatheredIDs(g), "s2-a,s2-b,s0-a", "the answer must be the top 3 of shard-0 and shard-2")
}

func CheckQuorum(ctx *harness.Ctx) {
	hServeShards(ctx)
	ctx.GRPC.Stop("shard-1:9000")
	ctx.GRPC.Stop("shard-2:9000")
	g, err := searchShards(hClientBg, "acme", "idx-42", hClientQuery, 3)
	ctx.Assert(err != nil, "with 2 of 3 shards down searchShards answered %+v: below a quorum of 2 it must return ErrQuorumLost", g)
	ctx.Assert(errors.Is(err, ErrQuorumLost), "searchShards returned %v, expected an error wrapping ErrQuorumLost", err)
}

func CheckMerge(ctx *harness.Ctx) {
	hServeShards(ctx)
	g := hMustGather(ctx)
	for _, call := range ctx.GRPC.CallsTo("Search", "") {
		r, _ := call.Request.(*pb.ShardRequest)
		ctx.Assert(r != nil && r.GetTenant() == "acme" && r.GetIndexVersion() == "idx-42" && r.GetK() == 3 && fmt.Sprint(r.GetQuery()) == fmt.Sprint(hClientQuery), "every shard must be asked for acme's top 3 in idx-42, %s got %v", call.Target, r)
	}
	ctx.Equal(hGatheredIDs(g), "s2-a,s1-a,s2-b", "the global top 3 by score are s2-a (0.95), s1-a (0.70), s2-b (0.60); the merge")
	ctx.Assert(!g.Partial && g.Answered == 3, "with every shard healthy the answer is complete, got %+v", g)
	ties, err := searchShards(hClientBg, "ties", "idx-42", hClientQuery, 2)
	ctx.NoError(err, "searchShards(ties, idx-42, …, 2)")
	ctx.Equal(hGatheredIDs(ties), "t-a,t-b", "t-c (shard-0), t-b (shard-1) and t-a (shard-2) all score 0.5, so the top 2 by id are t-a and t-b; the merge")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace {

const std::vector<std::string> kHTargets = {"shard-0:9000", "shard-1:9000", "shard-2:9000"};
const std::vector<double> kHQuery = {1, 0, 0, 0};

// Each shard's slice of acme's namespace in idx-42: the best documents live on shard-2.
const std::map<std::string, std::vector<std::pair<std::string, double>>> kHSlices = {
    {"shard-0:9000", {{"s0-a", 0.40}, {"s0-b", 0.30}, {"s0-c", 0.20}}},
    {"shard-1:9000", {{"s1-a", 0.70}, {"s1-b", 0.10}}},
    {"shard-2:9000", {{"s2-a", 0.95}, {"s2-b", 0.60}}},
};

// Tenant ties: one document per shard, every score equal, so only the id orders them.
const std::map<std::string, std::vector<std::pair<std::string, double>>> kHTies = {
    {"shard-0:9000", {{"t-c", 0.5}}},
    {"shard-1:9000", {{"t-b", 0.5}}},
    {"shard-2:9000", {{"t-a", 0.5}}},
};

// One shard: its slice's best k for acme (or ties) in idx-42, nothing for anyone else. For tenant
// flaky, shard-1 answers UNAVAILABLE once its latency has passed: a shard that fails late.
class HShardPeer final : public searchd::Shard::Service {
 public:
  explicit HShardPeer(std::string target) : target_(std::move(target)) {}
  grpc::Status Search(grpc::ServerContext*, const searchd::ShardRequest* req, searchd::ShardReply* out) override {
    if (req->tenant() == "flaky" && target_ == "shard-1:9000") return grpc::Status(grpc::StatusCode::UNAVAILABLE, "shard restarting");
    const auto* slices = req->tenant() == "acme" ? &kHSlices : req->tenant() == "ties" ? &kHTies : nullptr;
    if (slices == nullptr || req->index_version() != "idx-42") return grpc::Status::OK;
    auto best = slices->at(target_);
    std::sort(best.begin(), best.end(), [](const auto& a, const auto& b) { return a.second > b.second; });
    if (static_cast<size_t>(req->k()) < best.size()) best.resize(req->k());
    for (const auto& [id, score] : best) {
      auto* hit = out->add_hits();
      hit->set_id(id);
      hit->set_score(score);
    }
    return grpc::Status::OK;
  }

 private:
  std::string target_;
};

void hServeShards(harness::Ctx& ctx) {
  static std::vector<HShardPeer*> peers;
  for (HShardPeer* p : peers) delete p;
  peers.clear();
  for (const std::string& target : kHTargets) {
    peers.push_back(new HShardPeer(target));
    ctx.GRPC.Server(target)->RegisterService(peers.back());
  }
}

std::string hIds(const Gathered& g) {
  std::string out;
  for (const auto& h : g.hits) out += (out.empty() ? "" : ",") + h.id;
  return out;
}

std::string hShow(const Gathered& g) {
  return "{hits: [" + hIds(g) + "], partial: " + (g.partial ? "true" : "false") + ", answered: " + std::to_string(g.answered) + ", required: " + std::to_string(g.required) + "}";
}

int hCalls(harness::Ctx& ctx, const std::string& target) { return static_cast<int>(ctx.GRPC.CallsTo("Search", target).size()); }

Gathered hGather(harness::Ctx& ctx) {
  try {
    return searchShards("acme", "idx-42", kHQuery, 3);
  } catch (const std::exception& e) {
    ctx.Fatalf("searchShards(acme, idx-42, …, 3) threw %s: %s", harness::CurrentExceptionType(), e.what());
  }
  return {};
}

void hQuietly(const std::function<void()>& fn) {
  try {
    fn();
  } catch (const std::exception&) {
  }
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  hServeShards(ctx);
  ctx.GRPC.SetLatency("Search", 5, "shard-2:9000");
  const Gathered g = hGather(ctx);
  for (const auto& call : ctx.GRPC.CallsTo("Search")) {
    ctx.Assert(call.HasDeadline(), "a Search call to %s carries no deadline: a stalled shard holds the search open for as long as it stalls", call.Target);
    ctx.Assert(call.TimeoutSeconds() >= 0.3 && call.TimeoutSeconds() <= 0.5, "a Search call carries a %v s deadline, expected 400 ms", call.TimeoutSeconds());
  }
  ctx.Assert(g.partial && g.answered == 2, "shard-2 answers after 5 s, past the deadline: it is missing, so partial must be true and answered 2, got %s", hShow(g));
  ctx.Equal(hIds(g), "s1-a,s0-a,s0-b", "the answer must be the top 3 of shard-0 and shard-1");
  // shard-1 now answers UNAVAILABLE only after 300 ms: the retry must still get its own 400 ms.
  ctx.GRPC.SetLatency("Search", 0, "shard-2:9000");
  ctx.GRPC.SetLatency("Search", 0.3, "shard-1:9000");
  const int before = hCalls(ctx, "shard-1:9000");
  hQuietly([] { searchShards("flaky", "idx-42", kHQuery, 3); });
  const auto all = ctx.GRPC.CallsTo("Search", "shard-1:9000");
  ctx.Equal(static_cast<int>(all.size()) - before, 2, "shard-1 answered UNAVAILABLE after 300 ms: a first call and one retry; calls");
  for (size_t i = static_cast<size_t>(before); i < all.size(); ++i) {
    ctx.Assert(all[i].HasDeadline() && all[i].TimeoutSeconds() >= 0.3 && all[i].TimeoutSeconds() <= 0.5, "after a first call that failed 300 ms in, a call to shard-1 carried a %v s deadline: every attempt gets its own full 400 ms, not what is left of the first one", all[i].TimeoutSeconds());
  }
}

void CheckRetryPolicy(harness::Ctx& ctx) {
  hServeShards(ctx);
  ctx.GRPC.Fail("Search", grpc::StatusCode::UNAVAILABLE, "shard restarting", 1, "shard-1:9000");
  const Gathered g = hGather(ctx);
  ctx.Assert(hCalls(ctx, "shard-1:9000") == 2 && g.answered == 3, "shard-1 answered UNAVAILABLE once: one more call must reach it, got %d calls and %s", hCalls(ctx, "shard-1:9000"), hShow(g));
  ctx.GRPC.Stop("shard-2:9000");
  int before = hCalls(ctx, "shard-2:9000");
  hQuietly([] { searchShards("acme", "idx-42", kHQuery, 3); });
  ctx.Equal(hCalls(ctx, "shard-2:9000") - before, 2, "a shard that is down must be called kMaxAttempts = 2 times in one search; calls");
  const std::vector<std::pair<grpc::StatusCode, std::string>> terminal = {
      {grpc::StatusCode::DEADLINE_EXCEEDED, "DEADLINE_EXCEEDED"},
      {grpc::StatusCode::INTERNAL, "INTERNAL"},
      {grpc::StatusCode::RESOURCE_EXHAUSTED, "RESOURCE_EXHAUSTED"},
      {grpc::StatusCode::INVALID_ARGUMENT, "INVALID_ARGUMENT"},
  };
  for (const auto& [code, name] : terminal) {
    ctx.GRPC.Fail("Search", code, "terminal", 1, "shard-0:9000");
    before = hCalls(ctx, "shard-0:9000");
    hQuietly([] { searchShards("acme", "idx-42", kHQuery, 3); });
    ctx.Equal(hCalls(ctx, "shard-0:9000") - before, 1, "a shard that answered %s must not be called again in the same search (only UNAVAILABLE is retried); calls", name);
  }
}

void CheckPartial(harness::Ctx& ctx) {
  hServeShards(ctx);
  try {
    const Gathered empty = searchShards("globex", "idx-42", kHQuery, 3);
    ctx.Assert(empty.hits.empty() && !empty.partial && empty.answered == 3, "every shard answered globex with no hits: the answer is complete and empty (answered 3, partial false), got %s", hShow(empty));
  } catch (const QuorumLost&) {
    ctx.Fatalf("every shard answered globex with no hits and searchShards threw QuorumLost: an empty answer is an answer, only a shard that did not answer is missing");
  }
  ctx.GRPC.Stop("shard-1:9000");
  const Gathered g = hGather(ctx);
  ctx.Assert(g.partial, "with shard-1 down the answer must say partial, got %s: a dead shard is not an empty one", hShow(g));
  ctx.Assert(g.answered == 2 && g.required == 2, "answered must count the 2 shards that answered (required 2), got %s", hShow(g));
  ctx.Equal(hIds(g), "s2-a,s2-b,s0-a", "the answer must be the top 3 of shard-0 and shard-2");
}

void CheckQuorum(harness::Ctx& ctx) {
  hServeShards(ctx);
  ctx.GRPC.Stop("shard-1:9000");
  ctx.GRPC.Stop("shard-2:9000");
  try {
    const Gathered g = searchShards("acme", "idx-42", kHQuery, 3);
    ctx.Fatalf("with 2 of 3 shards down searchShards answered %s: below a quorum of 2 it must throw QuorumLost", hShow(g));
  } catch (const QuorumLost&) {
  }
}

void CheckMerge(harness::Ctx& ctx) {
  hServeShards(ctx);
  const Gathered g = hGather(ctx);
  for (const auto& call : ctx.GRPC.CallsTo("Search")) {
    const auto r = call.Request<searchd::ShardRequest>();
    const std::vector<double> query(r.query().begin(), r.query().end());
    ctx.Assert(r.tenant() == "acme" && r.index_version() == "idx-42" && r.k() == 3 && query == kHQuery, "every shard must be asked for acme's top 3 in idx-42, %s got tenant %q version %q k %d", call.Target, r.tenant(), r.index_version(), r.k());
  }
  ctx.Equal(hIds(g), "s2-a,s1-a,s2-b", "the global top 3 by score are s2-a (0.95), s1-a (0.70), s2-b (0.60); the merge");
  ctx.Assert(!g.partial && g.answered == 3, "with every shard healthy the answer is complete, got %s", hShow(g));
  try {
    ctx.Equal(hIds(searchShards("ties", "idx-42", kHQuery, 2)), "t-a,t-b", "t-c (shard-0), t-b (shard-1) and t-a (shard-2) all score 0.5, so the top 2 by id are t-a and t-b; the merge");
  } catch (const QuorumLost&) {
    ctx.Fatalf("with every shard healthy searchShards(ties, idx-42, …, 2) threw QuorumLost");
  }
}
`,
  },
  hints: [
    'Slow one shard down and every search takes as long as it does; stop one and it is called five times per search while `partial` stays false; stop two and the search still answers; the 0.95 document on shard 2 never appears.',
    '`Search` is called with no deadline, every error is retried five times, and the loop returns `[]` when it gives up, so `search_shards` cannot tell a dead shard from an empty one. The replies are concatenated in shard order and cut at `k`.',
    'Pass `timeout=DEADLINE_S`, retry only `UNAVAILABLE` up to `MAX_ATTEMPTS`, return `None` for a missing shard, count `answered`, raise `QuorumLost` below `quorum()`, sort by `(-score, id)`, keep `k`, and set `partial = answered < len(SHARDS)`.',
  ],
  debrief: `A scatter-gather is as slow as its slowest shard unless every call has a deadline: the deadline is what turns a stuck shard into a missing one. Retrying only \`UNAVAILABLE\` matters because a call that hit its deadline already spent the budget, and a second 400 ms call doubles the latency of exactly the searches that are already slow. Counting answers is what makes the quorum and \`partial\` possible; once the error becomes an empty list, a dead shard and an empty one look the same. Each shard ranks only its slice, so the merge sorts across replies before cutting. Production clients call the shards concurrently, hedge a slow shard with a replica, and share one retry budget across requests.`,
};
