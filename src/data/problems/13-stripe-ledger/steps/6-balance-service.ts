import type {Step} from '@/lib/types';

// ---- 6. GetBalance over gRPC, behind a five-second cache --------------------------------------
export const balanceServiceStep: Step = {
  id: 'balance-service',
  title: 'GetBalance over gRPC',
  concept: 'grpc',
  file: 'balance_service',
  focus: ['reports', 'balance', 'redis', 'db'],
  task: `## Task

Reporting, reconciliation and the clearing dashboards all ask the same question: what is the balance
of an account? Serve it over gRPC:

\`\`\`proto
service LedgerService {
  rpc GetBalance(BalanceRequest) returns (Balance);
}
message BalanceRequest { string account = 1; string currency = 2; int64 as_of = 3; }  // as_of 0 = now
message Balance        { string account = 1; string currency = 2; int64 amount = 3; int64 as_of = 4; }
\`\`\`

A balance is the **sum of the account's entries** in that currency with \`posted_at <= as_of\`
(\`db.execute(sql, params)\` runs one statement and returns dict rows). Implement \`GetBalance\` and
\`invalidate(account, currency)\`, which the journal writer calls after every commit:

- An empty account, or a currency that does not match \`^[A-Z]{3}$\` → **\`INVALID_ARGUMENT\`**, before
  any lookup.
- An account with **no entries at all** → **\`NOT_FOUND\`**; a known account with no entries in the asked
  currency has a balance of 0.
- The **current** balance (\`as_of\` = 0) is served through Redis: \`GET bal:{account}:{currency}\` first; on
  a miss sum the entries up to now and \`SET … EX 5\`. \`invalidate\` is a \`DEL\` of that key, so a write
  is visible on the next read and the five seconds only bound how long a *missed* invalidation lasts.
- A **point-in-time** balance (\`as_of\` > 0) sums \`posted_at <= as_of\` and bypasses the cache in both
  directions: never read from it, never written to it. The reply's \`as_of\` is the time the balance is for.

:::widget grpc-streams {"mode": "unary"}

:::widget cache-aside {}

> One query answers both "balance" and "does this account exist": sum the matching entries and count all
> of them. Two queries would let the account be created between them.`,
  sequence: {
    participants: ['Reporting', 'LedgerService', 'Redis', 'Postgres'],
    messages: [
      {from: 'Reporting', to: 'LedgerService', label: 'GetBalance(cash:acquirer, EUR, as_of = 0)', kind: 'sync'},
      {from: 'LedgerService', to: 'Redis', label: 'GET bal:cash:acquirer:EUR → nil', kind: 'sync'},
      {
        from: 'LedgerService',
        to: 'Postgres',
        label: 'SELECT SUM(amount) FILTER (currency, posted_at ≤ now), COUNT(*) WHERE account = …',
        kind: 'sync',
      },
      {from: 'Postgres', to: 'LedgerService', label: '3499 · 4 entries', kind: 'reply'},
      {from: 'LedgerService', to: 'Redis', label: 'SET bal:cash:acquirer:EUR 3499 EX 5', kind: 'sync'},
      {from: 'LedgerService', to: 'Reporting', label: 'Balance{amount: 3499, as_of: now}', kind: 'reply'},
      {from: 'Reporting', to: 'LedgerService', label: 'GetBalance(cash:acquirer, EUR, as_of = T0)', kind: 'sync'},
      {from: 'LedgerService', to: 'Postgres', label: 'SELECT … posted_at ≤ T0 (cache bypassed)', kind: 'sync'},
      {from: 'LedgerService', to: 'Reporting', label: 'Balance{amount: 4999, as_of: T0}', kind: 'reply'},
    ],
  },
  hints: [
    'Validate, then branch on `as_of == 0`: only that branch touches Redis (GET before the query, SET after it). The historical branch is the query with the given `as_of` and nothing else.',
    'One row answers everything: `COALESCE(SUM(amount) FILTER (WHERE currency = %s AND posted_at <= %s), 0)::bigint AS amount, COUNT(*) AS n` over `WHERE account = %s`. `n == 0` is NOT_FOUND; the sum is the balance.',
    'In `grpc.aio` the abort is awaited: `await context.abort(grpc.StatusCode.NOT_FOUND, …)`. Cast the cached string back to an int before putting it in the reply.',
  ],
  checks: [
    {
      id: 'serves-balance',
      title: "Serves GetBalance as the sum of the account's entries",
      detail:
        'A `LedgerServiceServicer` registered on the server answers `GetBalance` with `SUM(amount)` of the entries in the requested currency; `as_of` 0 means now.',
      match: {
        python: {all: [/class \w+\(\s*ledger_pb2_grpc\.LedgerServiceServicer\s*\)/, /SUM\(amount\)/]},
        go: {all: [/pb\.UnimplementedLedgerServiceServer/, /SUM\(amount\)/]},
        scala: {all: [/LedgerServiceGrpc\.LedgerService/, /SUM\(amount\)/]},
        cpp: {all: [/ledger::LedgerService::Service/, /SUM\(amount\)/]},
      },
    },
    {
      id: 'invalid-argument',
      title: 'Rejects a bad currency or an empty account with INVALID_ARGUMENT',
      detail:
        'The currency must match `^[A-Z]{3}$` and the account must be non-empty; otherwise `INVALID_ARGUMENT` before Redis or Postgres is touched.',
      match: {
        python: {all: [/StatusCode\.INVALID_ARGUMENT/, /CURRENCY_RE\.(fullmatch|match)\(/]},
        go: {all: [/codes\.InvalidArgument/, /currencyRe\.MatchString\(/]},
        scala: {all: [/Status\.INVALID_ARGUMENT/, /CurrencyRe\.matches\(/]},
        cpp: {all: [/StatusCode::INVALID_ARGUMENT/, /std::regex_match\([^\n]*kCurrencyRe/]},
      },
    },
    {
      id: 'not-found',
      title: 'Answers NOT_FOUND for an account with no entries',
      detail:
        "Count the account's entries in the same query as the sum: zero entries in any currency is `NOT_FOUND`; entries in another currency only means a balance of 0.",
      match: {
        python: {all: [/StatusCode\.NOT_FOUND/, /COUNT\(\*\)/]},
        go: {all: [/codes\.NotFound/, /COUNT\(\*\)/]},
        scala: {all: [/Status\.NOT_FOUND/, /COUNT\(\*\)/]},
        cpp: {all: [/StatusCode::NOT_FOUND/, /COUNT\(\*\)/]},
      },
    },
    {
      id: 'cache',
      title: 'Serves the current balance through bal:{account}:{currency} with a 5 s TTL, invalidated on write',
      detail:
        'GET the key before the query, SET it with `EX 5` after; `invalidate` DELs it so the next read after a write hits the database.',
      match: {
        python: {all: [/f["']bal:\{/, /\br\.get\(/, /\.set\([^\n]*ex\s*=\s*BALANCE_TTL_S/, /\.delete\(/]},
        go: {all: [/"bal:"\s*\+/, /rdb\.Get\(/, /rdb\.Set\([^\n]*balanceTTL\s*\)/, /rdb\.Del\(/]},
        scala: {all: [/s"bal:\$/, /jedis\.get\(/, /jedis\.setex\([^\n]*BalanceTtlSeconds/, /jedis\.del\(/]},
        cpp: {all: [/"bal:"\s*\+/, /redis\.get\(/, /redis\.set\([^\n]*kBalanceTtl/, /redis\.del\(/]},
      },
    },
    {
      id: 'as-of',
      title: 'A point-in-time balance sums entries up to as_of and bypasses the cache',
      detail:
        'With `as_of` > 0 the query is bounded by `posted_at <= as_of` and neither reads nor writes Redis; the reply carries that `as_of`.',
      match: {
        python: {all: [/posted_at <= %s/, /request\.as_of\s*==\s*0|not request\.as_of/]},
        go: {all: [/posted_at <= \$\d/, /req\.(GetAsOf\(\)|AsOf)\s*==\s*0/]},
        scala: {all: [/posted_at <= \?/, /req(uest)?\.asOf\s*==\s*0/]},
        cpp: {all: [/posted_at <= \$\d/, /req(uest)?->as_of\(\)\s*==\s*0/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio
import re
import time

import grpc
import redis

import ledger_pb2
import ledger_pb2_grpc
from ledger.db import db  # await db.execute(sql, params) runs one statement and returns dict rows

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
BALANCE_TTL_S = 5


def now_ms() -> int:
    return int(time.time() * 1000)


def invalidate(account: str, currency: str) -> None:
    """Called by the journal writer after every commit: the cached current balance is stale."""
    # TODO: DEL bal:{account}:{currency}
    raise NotImplementedError


class LedgerService(ledger_pb2_grpc.LedgerServiceServicer):
    async def GetBalance(self, request: ledger_pb2.BalanceRequest, context: grpc.aio.ServicerContext) -> ledger_pb2.Balance:
        # TODO: empty account or currency not matching CURRENCY_RE → INVALID_ARGUMENT
        # TODO: as_of == 0 → GET bal:{account}:{currency}; hit → reply from the cache
        # TODO: one query: SUM(amount) FILTER (WHERE currency = … AND posted_at <= as_of) and COUNT(*) WHERE account = …; n == 0 → NOT_FOUND
        # TODO: as_of == 0 → SET the key EX BALANCE_TTL_S; reply Balance(account, currency, amount, as_of)
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "not implemented")


async def serve() -> None:
    server = grpc.aio.server()
    ledger_pb2_grpc.add_LedgerServiceServicer_to_server(LedgerService(), server)
    server.add_insecure_port("[::]:9100")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
`,
      solution: `import asyncio
import re
import time

import grpc
import redis

import ledger_pb2
import ledger_pb2_grpc
from ledger.db import db  # await db.execute(sql, params) runs one statement and returns dict rows

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
BALANCE_TTL_S = 5


def now_ms() -> int:
    return int(time.time() * 1000)


def cache_key(account: str, currency: str) -> str:
    return f"bal:{account}:{currency}"


def invalidate(account: str, currency: str) -> None:
    """Called by the journal writer after every commit: the cached current balance is stale."""
    r.delete(cache_key(account, currency))


async def sum_entries(account: str, currency: str, as_of: int) -> tuple[int, int]:
    """(balance in \`currency\` up to \`as_of\`, number of entries the account has at all)."""
    rows = await db.execute(
        "SELECT COALESCE(SUM(amount) FILTER (WHERE currency = %s AND posted_at <= %s), 0)::bigint AS amount, COUNT(*) AS n"
        " FROM entries WHERE account = %s",
        (currency, as_of, account),
    )
    return int(rows[0]["amount"]), int(rows[0]["n"])


class LedgerService(ledger_pb2_grpc.LedgerServiceServicer):
    async def GetBalance(self, request: ledger_pb2.BalanceRequest, context: grpc.aio.ServicerContext) -> ledger_pb2.Balance:
        if not request.account or not CURRENCY_RE.fullmatch(request.currency):
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "account is required and currency must match ^[A-Z]{3}$")
        key = cache_key(request.account, request.currency)
        current = request.as_of == 0
        if current:
            cached = r.get(key)
            if cached is not None:
                return ledger_pb2.Balance(account=request.account, currency=request.currency, amount=int(cached), as_of=now_ms())
        as_of = now_ms() if current else request.as_of
        amount, n = await sum_entries(request.account, request.currency, as_of)
        if n == 0:
            await context.abort(grpc.StatusCode.NOT_FOUND, f"no entries for account {request.account}")
        if current:
            r.set(key, amount, ex=BALANCE_TTL_S)  # a point-in-time balance is never cached: it is cheap to recompute and never changes
        return ledger_pb2.Balance(account=request.account, currency=request.currency, amount=amount, as_of=as_of)


async def serve() -> None:
    server = grpc.aio.server()
    ledger_pb2_grpc.add_LedgerServiceServicer_to_server(LedgerService(), server)
    server.add_insecure_port("[::]:9100")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"net"
	"regexp"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "ledger/gen/ledger"
	"ledger/db" // db.QueryRow(ctx, sql, args...) *sql.Row — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var currencyRe = regexp.MustCompile(\`^[A-Z]{3}$\`)

const balanceTTL = 5 * time.Second

func nowMs() int64 { return time.Now().UnixMilli() }

func cacheKey(account, currency string) string { return "bal:" + account + ":" + currency }

// invalidate is called by the journal writer after every commit: the cached current balance is stale.
func invalidate(ctx context.Context, account, currency string) {
	// TODO: Del cacheKey(account, currency)
}

type ledgerServer struct {
	pb.UnimplementedLedgerServiceServer
}

func (s *ledgerServer) GetBalance(ctx context.Context, req *pb.BalanceRequest) (*pb.Balance, error) {
	// TODO: empty account or currency not matching currencyRe → codes.InvalidArgument
	// TODO: AsOf == 0 → Get cacheKey; hit → reply from the cache
	// TODO: one query: SUM(amount) FILTER (WHERE currency = $1 AND posted_at <= $2) and COUNT(*) WHERE account = $3; n == 0 → codes.NotFound
	// TODO: AsOf == 0 → Set the key with balanceTTL; reply Balance{Account, Currency, Amount, AsOf}
	_ = db.QueryRow
	return nil, status.Error(codes.Unimplemented, "not implemented")
}

func main() {
	lis, _ := net.Listen("tcp", ":9100")
	srv := grpc.NewServer()
	pb.RegisterLedgerServiceServer(srv, &ledgerServer{})
	log.Fatal(srv.Serve(lis))
}
`,
      solution: `package main

import (
	"context"
	"log"
	"net"
	"regexp"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "ledger/gen/ledger"
	"ledger/db" // db.QueryRow(ctx, sql, args...) *sql.Row — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var currencyRe = regexp.MustCompile(\`^[A-Z]{3}$\`)

const balanceTTL = 5 * time.Second

func nowMs() int64 { return time.Now().UnixMilli() }

func cacheKey(account, currency string) string { return "bal:" + account + ":" + currency }

// invalidate is called by the journal writer after every commit: the cached current balance is stale.
func invalidate(ctx context.Context, account, currency string) {
	rdb.Del(ctx, cacheKey(account, currency))
}

// sumEntries returns the balance in currency up to asOf and the number of entries the account has at all.
func sumEntries(ctx context.Context, account, currency string, asOf int64) (int64, int64, error) {
	var amount, n int64
	err := db.QueryRow(ctx,
		"SELECT COALESCE(SUM(amount) FILTER (WHERE currency = $1 AND posted_at <= $2), 0)::bigint, COUNT(*) FROM entries WHERE account = $3",
		currency, asOf, account).Scan(&amount, &n)
	return amount, n, err
}

type ledgerServer struct {
	pb.UnimplementedLedgerServiceServer
}

func (s *ledgerServer) GetBalance(ctx context.Context, req *pb.BalanceRequest) (*pb.Balance, error) {
	if req.GetAccount() == "" || !currencyRe.MatchString(req.GetCurrency()) {
		return nil, status.Error(codes.InvalidArgument, "account is required and currency must match ^[A-Z]{3}$")
	}
	key := cacheKey(req.GetAccount(), req.GetCurrency())
	current := req.GetAsOf() == 0
	if current {
		if cached, err := rdb.Get(ctx, key).Result(); err == nil {
			amount, _ := strconv.ParseInt(cached, 10, 64)
			return &pb.Balance{Account: req.GetAccount(), Currency: req.GetCurrency(), Amount: amount, AsOf: nowMs()}, nil
		}
	}
	asOf := req.GetAsOf()
	if current {
		asOf = nowMs()
	}
	amount, n, err := sumEntries(ctx, req.GetAccount(), req.GetCurrency(), asOf)
	if err != nil {
		return nil, status.Error(codes.Unavailable, "ledger database unavailable")
	}
	if n == 0 {
		return nil, status.Errorf(codes.NotFound, "no entries for account %s", req.GetAccount())
	}
	if current {
		rdb.Set(ctx, key, amount, balanceTTL) // a point-in-time balance is never cached
	}
	return &pb.Balance{Account: req.GetAccount(), Currency: req.GetCurrency(), Amount: amount, AsOf: asOf}, nil
}

func main() {
	lis, _ := net.Listen("tcp", ":9100")
	srv := grpc.NewServer()
	pb.RegisterLedgerServiceServer(srv, &ledgerServer{})
	log.Fatal(srv.Serve(lis))
}
`,
    },
    scala: {
      starter: `import io.grpc.{ServerBuilder, Status}
import ledger.Db // Db.withConnection { conn => ... } — provided
import ledger.ledger.{Balance, BalanceRequest, LedgerServiceGrpc}
import redis.clients.jedis.JedisPooled
import scala.concurrent.{ExecutionContext, Future}

object BalanceService extends LedgerServiceGrpc.LedgerService {
  val jedis = new JedisPooled("redis", 6379)
  val CurrencyRe = "^[A-Z]{3}$".r
  val BalanceTtlSeconds = 5L

  def nowMs(): Long = System.currentTimeMillis()

  def cacheKey(account: String, currency: String): String = s"bal:$account:$currency"

  /** Called by the journal writer after every commit: the cached current balance is stale. */
  def invalidate(account: String, currency: String): Unit = {
    // TODO: del cacheKey(account, currency)
  }

  override def getBalance(req: BalanceRequest): Future[Balance] = {
    // TODO: empty account or currency not matching CurrencyRe → Status.INVALID_ARGUMENT
    // TODO: asOf == 0 → get cacheKey; hit → reply from the cache
    // TODO: one query: SUM(amount) FILTER (WHERE currency = ? AND posted_at <= ?) and COUNT(*) WHERE account = ?; n == 0 → Status.NOT_FOUND
    // TODO: asOf == 0 → setex the key BalanceTtlSeconds; reply Balance(account, currency, amount, asOf)
    Future.failed(Status.UNIMPLEMENTED.asRuntimeException())
  }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9100).addService(LedgerServiceGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
      solution: `import io.grpc.{ServerBuilder, Status}
import ledger.Db // Db.withConnection { conn => ... } — provided
import ledger.ledger.{Balance, BalanceRequest, LedgerServiceGrpc}
import redis.clients.jedis.JedisPooled
import scala.concurrent.{ExecutionContext, Future}

object BalanceService extends LedgerServiceGrpc.LedgerService {
  val jedis = new JedisPooled("redis", 6379)
  val CurrencyRe = "^[A-Z]{3}$".r
  val BalanceTtlSeconds = 5L

  def nowMs(): Long = System.currentTimeMillis()

  def cacheKey(account: String, currency: String): String = s"bal:$account:$currency"

  /** Called by the journal writer after every commit: the cached current balance is stale. */
  def invalidate(account: String, currency: String): Unit = jedis.del(cacheKey(account, currency))

  /** (balance in \`currency\` up to \`asOf\`, number of entries the account has at all). */
  private def sumEntries(account: String, currency: String, asOf: Long): (Long, Long) =
    Db.withConnection { conn =>
      val st = conn.prepareStatement(
        "SELECT COALESCE(SUM(amount) FILTER (WHERE currency = ? AND posted_at <= ?), 0)::bigint AS amount, COUNT(*) AS n FROM entries WHERE account = ?")
      st.setString(1, currency); st.setLong(2, asOf); st.setString(3, account)
      val rs = st.executeQuery()
      rs.next()
      (rs.getLong("amount"), rs.getLong("n"))
    }

  override def getBalance(req: BalanceRequest): Future[Balance] = {
    if (req.account.isEmpty || !CurrencyRe.matches(req.currency))
      return Future.failed(Status.INVALID_ARGUMENT.withDescription("account is required and currency must match ^[A-Z]{3}$").asRuntimeException())
    val key = cacheKey(req.account, req.currency)
    val current = req.asOf == 0
    val cached = if (current) Option(jedis.get(key)) else None
    cached match {
      case Some(amount) => Future.successful(Balance(req.account, req.currency, amount.toLong, nowMs()))
      case None =>
        val asOf = if (current) nowMs() else req.asOf
        val (amount, n) = sumEntries(req.account, req.currency, asOf)
        if (n == 0) Future.failed(Status.NOT_FOUND.withDescription(s"no entries for account \${req.account}").asRuntimeException())
        else {
          if (current) jedis.setex(key, BalanceTtlSeconds, amount.toString) // a point-in-time balance is never cached
          Future.successful(Balance(req.account, req.currency, amount, asOf))
        }
    }
  }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9100).addService(LedgerServiceGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <pqxx/pqxx>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdint>
#include <regex>
#include <string>

#include "db.h"  // db::transaction(fn): begins, runs fn(pqxx::work&), commits
#include "ledger.grpc.pb.h"

using ledger::Balance;
using ledger::BalanceRequest;

sw::redis::Redis redis("tcp://redis:6379");

const std::regex kCurrencyRe(R"(^[A-Z]{3}$)");
constexpr std::chrono::seconds kBalanceTtl{5};

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string cache_key(const std::string& account, const std::string& currency) { return "bal:" + account + ":" + currency; }

// Called by the journal writer after every commit: the cached current balance is stale.
void invalidate(const std::string& account, const std::string& currency) {
  // TODO: del cache_key(account, currency)
}

class LedgerServiceImpl final : public ledger::LedgerService::Service {
 public:
  grpc::Status GetBalance(grpc::ServerContext*, const BalanceRequest* request, Balance* reply) override {
    // TODO: empty account or currency not matching kCurrencyRe → INVALID_ARGUMENT
    // TODO: as_of() == 0 → get cache_key; hit → reply from the cache
    // TODO: one query: SUM(amount) FILTER (WHERE currency = $1 AND posted_at <= $2) and COUNT(*) WHERE account = $3; n == 0 → NOT_FOUND
    // TODO: as_of() == 0 → set the key with kBalanceTtl; fill reply (account, currency, amount, as_of)
    return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
  }
};

int main() {
  LedgerServiceImpl service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9100", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <pqxx/pqxx>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdint>
#include <regex>
#include <string>

#include "db.h"  // db::transaction(fn): begins, runs fn(pqxx::work&), commits
#include "ledger.grpc.pb.h"

using ledger::Balance;
using ledger::BalanceRequest;

sw::redis::Redis redis("tcp://redis:6379");

const std::regex kCurrencyRe(R"(^[A-Z]{3}$)");
constexpr std::chrono::seconds kBalanceTtl{5};

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string cache_key(const std::string& account, const std::string& currency) { return "bal:" + account + ":" + currency; }

// Called by the journal writer after every commit: the cached current balance is stale.
void invalidate(const std::string& account, const std::string& currency) { redis.del(cache_key(account, currency)); }

// {balance in currency up to as_of, number of entries the account has at all}.
std::pair<int64_t, int64_t> sum_entries(const std::string& account, const std::string& currency, int64_t as_of) {
  std::pair<int64_t, int64_t> out;
  db::transaction([&](pqxx::work& tx) {
    const auto row = tx.exec_params1(
        "SELECT COALESCE(SUM(amount) FILTER (WHERE currency = $1 AND posted_at <= $2), 0)::bigint, COUNT(*) FROM entries WHERE account = $3",
        currency, as_of, account);
    out = {row[0].as<int64_t>(), row[1].as<int64_t>()};
  });
  return out;
}

class LedgerServiceImpl final : public ledger::LedgerService::Service {
 public:
  grpc::Status GetBalance(grpc::ServerContext*, const BalanceRequest* request, Balance* reply) override {
    if (request->account().empty() || !std::regex_match(request->currency(), kCurrencyRe))
      return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "account is required and currency must match ^[A-Z]{3}$");
    const std::string key = cache_key(request->account(), request->currency());
    const bool current = request->as_of() == 0;
    if (current) {
      if (const auto cached = redis.get(key)) {
        fill(reply, request, std::stoll(*cached), now_ms());
        return grpc::Status::OK;
      }
    }
    const int64_t as_of = current ? now_ms() : request->as_of();
    const auto [amount, n] = sum_entries(request->account(), request->currency(), as_of);
    if (n == 0) return grpc::Status(grpc::StatusCode::NOT_FOUND, "no entries for account " + request->account());
    if (current) redis.set(key, std::to_string(amount), kBalanceTtl);  // a point-in-time balance is never cached
    fill(reply, request, amount, as_of);
    return grpc::Status::OK;
  }

 private:
  static void fill(Balance* reply, const BalanceRequest* request, int64_t amount, int64_t as_of) {
    reply->set_account(request->account());
    reply->set_currency(request->currency());
    reply->set_amount(amount);
    reply->set_as_of(as_of);
  }
};

int main() {
  LedgerServiceImpl service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9100", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
    },
  },
  harness: {
    python: `import asyncio
import time

import grpc

import ledger_pb2
import ledger_pb2_grpc

SCHEMA = """
CREATE TABLE transactions (
    id text PRIMARY KEY,
    event_id text UNIQUE,
    description text NOT NULL,
    settles text,
    posted_at bigint NOT NULL
);
CREATE TABLE entries (
    transaction_id text NOT NULL REFERENCES transactions (id),
    account text NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL CHECK (amount <> 0),
    posted_at bigint NOT NULL
);
"""

T0 = 1700000000000
KEY = "bal:cash:acquirer:EUR"


def _pair(debit, credit, currency, amount):
    return [{"account": debit, "currency": currency, "amount": amount}, {"account": credit, "currency": currency, "amount": -amount}]


# (event id, entries, posted_at): a capture, a partial refund a second later, a USD capture.
JOURNAL = [
    ("evt-capture", _pair("cash:acquirer", "clearing:payments", "EUR", 4999), T0),
    ("evt-refund", _pair("clearing:payments", "cash:acquirer", "EUR", 1500), T0 + 1000),
    ("evt-usd", _pair("cash:acquirer", "clearing:payments", "USD", 700), T0 + 2000),
]


async def _start(ctx):
    """The journal filled through the real writer (step 4), the learner's server running as a task, and a stub on it."""
    await ctx.db.reset(SCHEMA)
    writer = ctx.load("ledger_writer")
    for event_id, entries, posted_at in JOURNAL:
        await writer.write_transaction(entries, "seed", event_id=event_id, posted_at=posted_at)
    import balance_service

    asyncio.create_task(balance_service.serve())
    await asyncio.sleep(0)
    stub = ledger_pb2_grpc.LedgerServiceStub(grpc.aio.insecure_channel("ledger:9100"))
    return writer, stub


async def _correct_in_sql(ctx, name, account, amount, posted_at):
    """A correction applied straight in SQL by an operator, outside the writer: nothing invalidates the cache."""
    await ctx.db.execute("INSERT INTO transactions (id, description, posted_at) VALUES (%s, 'correction', %s)", (name, posted_at))
    await ctx.db.execute("INSERT INTO entries (transaction_id, account, currency, amount, posted_at) VALUES (%s, %s, 'EUR', %s, %s)", (name, account, amount, posted_at))
    await ctx.db.execute("INSERT INTO entries (transaction_id, account, currency, amount, posted_at) VALUES (%s, 'revenue:adjustments', 'EUR', %s, %s)", (name, -amount, posted_at))


def _reads(ctx):
    """Reads of the entries table in the database's query log."""
    return len([sql for sql, _ in ctx.db.queries if sql.lstrip().lower().startswith("select") and "entries" in sql.lower()])


def _call(stub, account="cash:acquirer", currency="EUR", as_of=0):
    return stub.GetBalance(ledger_pb2.BalanceRequest(account=account, currency=currency, as_of=as_of), timeout=2.0)


async def _balance(stub, account="cash:acquirer", currency="EUR", as_of=0):
    try:
        return await _call(stub, account, currency, as_of)
    except grpc.RpcError as e:
        raise AssertionError(f"GetBalance({account}, {currency}, as_of={as_of}) failed with {e.code()}: {e.details()}")


async def _code(call):
    try:
        await call
    except grpc.RpcError as e:
        return e.code()
    return grpc.StatusCode.OK


async def check_serves_balance(ctx):
    _, stub = await _start(ctx)
    reply = await _balance(stub)
    assert isinstance(reply, ledger_pb2.Balance), f"GetBalance must answer a Balance, got {type(reply).__name__}"
    assert reply.amount == 3499, f"cash:acquirer EUR is 4999 - 1500 = 3499, got {reply.amount}"
    assert (reply.account, reply.currency) == ("cash:acquirer", "EUR"), f"the reply must echo account and currency, got {reply!r}"
    now = int(time.time() * 1000)
    assert abs(reply.as_of - now) < 5000, f"for as_of 0 the reply's as_of is now ({now}), got {reply.as_of}"
    usd = await _balance(stub, currency="USD")
    assert usd.amount == 700, f"cash:acquirer USD is 700, got {usd.amount}"
    clearing = await _balance(stub, account="clearing:payments")
    assert clearing.amount == -3499, f"clearing:payments EUR is -4999 + 1500 = -3499, got {clearing.amount}"


async def check_invalid_argument(ctx):
    _, stub = await _start(ctx)
    reads = _reads(ctx)
    for account, currency in (("cash:acquirer", "eur"), ("cash:acquirer", "EURO"), ("cash:acquirer", ""), ("", "EUR")):
        code = await _code(_call(stub, account=account, currency=currency))
        assert code == grpc.StatusCode.INVALID_ARGUMENT, f"account {account!r} currency {currency!r} answered {code}, expected INVALID_ARGUMENT"
    assert _reads(ctx) == reads, "a request rejected as INVALID_ARGUMENT must not query the database"
    assert not ctx.redis.keys("bal:*"), f"a request rejected as INVALID_ARGUMENT must not touch the cache, found {ctx.redis.keys('bal:*')}"


async def check_not_found(ctx):
    _, stub = await _start(ctx)
    code = await _code(_call(stub, account="cash:nowhere"))
    assert code == grpc.StatusCode.NOT_FOUND, f"an account with no entries answered {code}, expected NOT_FOUND"
    assert ctx.redis.get("bal:cash:nowhere:EUR") is None, "a NOT_FOUND must not be cached as a balance"
    gbp = await _balance(stub, currency="GBP")
    assert gbp.amount == 0, f"a known account with no GBP entries has a GBP balance of 0, got {gbp.amount} (not NOT_FOUND)"
    code = await _code(_call(stub, account="cash:nowhere", as_of=T0))
    assert code == grpc.StatusCode.NOT_FOUND, f"an unknown account is NOT_FOUND at any as_of, got {code}"


async def check_cache(ctx):
    writer, stub = await _start(ctx)
    reads = _reads(ctx)
    first = await _balance(stub)
    assert first.amount == 3499, f"cash:acquirer EUR is 3499, got {first.amount}"
    assert _reads(ctx) == reads + 1, f"the first current balance is a cache miss: expected one query, saw {_reads(ctx) - reads}"
    cached = ctx.redis.get(KEY)
    assert cached is not None, f"after a miss the balance must be stored under {KEY}"
    assert str(cached) == "3499", f"{KEY} holds {cached!r}, expected '3499'"
    ttl = ctx.redis.ttl(KEY)
    assert 1 <= ttl <= 5, f"{KEY} has TTL {ttl}, expected 5 s"
    # An operator books +100 straight in SQL: no invalidation, so for up to 5 s the cache still answers.
    await _correct_in_sql(ctx, "fix-1", "cash:acquirer", 100, T0 + 3000)
    second = await _balance(stub)
    assert second.amount == 3499, f"within 5 s the current balance must come from the cache (3499), but the service answered {second.amount} from the database"
    assert _reads(ctx) == reads + 1, "the second current balance within 5 s must come from Redis, but the database was queried"
    ctx.clock.advance(6)
    third = await _balance(stub)
    assert third.amount == 3599, f"after the 5 s TTL the cached balance must have expired and be recomputed (3599), got {third.amount}"
    # A write through the journal writer invalidates: the very next read sees it.
    await writer.write_transaction(_pair("cash:acquirer", "revenue:fees", "EUR", 1), "fee", event_id="evt-fee", posted_at=T0 + 4000)
    assert ctx.redis.get(KEY) is None, f"after a write to cash:acquirer EUR, invalidate(account, currency) must have deleted {KEY}"
    fourth = await _balance(stub)
    assert fourth.amount == 3600, f"right after a write the next read must hit the database (3600), got {fourth.amount}"


async def check_as_of(ctx):
    _, stub = await _start(ctx)
    at_t0 = await _balance(stub, as_of=T0)
    assert at_t0.amount == 4999, f"as of T0 only the capture is posted: expected 4999, got {at_t0.amount}"
    assert at_t0.as_of == T0, f"the reply's as_of must be the requested time {T0}, got {at_t0.as_of}"
    before = await _balance(stub, as_of=T0 - 1)
    assert before.amount == 0, f"as of T0 - 1 nothing is posted yet: expected 0, got {before.amount}"
    later = await _balance(stub, as_of=T0 + 1000)
    assert later.amount == 3499, f"as of T0 + 1 s the refund is posted too: expected 3499, got {later.amount}"
    assert not ctx.redis.keys("bal:*"), f"a point-in-time balance must not be cached, found {ctx.redis.keys('bal:*')}"
    current = await _balance(stub)
    assert current.amount == 3499 and ctx.redis.get(KEY) is not None, "the current balance must be cached"
    # A backdated correction straight in SQL: the history changes, the cached current balance does not know.
    await _correct_in_sql(ctx, "fix-1", "cash:acquirer", 100, T0 - 500)
    historical = await _balance(stub, as_of=T0)
    assert historical.amount == 5099, f"a point-in-time balance must come from the database (5099 as of T0 after the correction), got {historical.amount}"
    assert str(ctx.redis.get(KEY)) == "3499", "a point-in-time balance must not overwrite the cached current balance"
`,
  },
  debrief: `The balance is a fold over the journal, which is why the read side can be cached so aggressively and so briefly: the five-second TTL only matters when an invalidation is lost, because every committed write deletes the key itself. The point-in-time branch bypasses the cache because its answer never changes — the journal is immutable, so "the balance as of Tuesday" is the same number whenever you ask, and caching it under the current key would poison the current balance. Returning NOT_FOUND from the same query that computes the sum avoids a second round trip and a race between them. Real balance services keep running balances per account as a materialised view updated by the writer, snapshot them nightly so a historical query folds a day of entries instead of years, and serve the gRPC streams of balance changes that dashboards subscribe to.`,
};
