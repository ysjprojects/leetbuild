import type {Step} from '@/lib/types';

export const propagateDeadlineStep: Step = {
  id: 'propagate-deadline',
  title: "Spend the caller's deadline on the pricing call",
  concept: 'grpc',
  file: 'quote_server',
  focus: ['quotes', 'pricing'],
  task: `## Task

\`Quotes.GetQuote\` prices a line item by calling \`Pricing.GetPrice\` downstream. The checkout that calls
you has a deadline; the pricing call must fit inside it.

\`\`\`proto
package quotes.v1;

service Quotes  { rpc GetQuote(QuoteRequest) returns (Quote); }
service Pricing { rpc GetPrice(PriceRequest) returns (Price); }

message QuoteRequest { string sku = 1; int32 qty = 2; }
message Quote        { string sku = 1; int32 qty = 2; int32 total_cents = 3; }
message PriceRequest { string sku = 1; }
message Price        { int32 unit_cents = 1; }
\`\`\`

Constants: \`PRICING_TARGET = "pricing:50051"\`, \`DEFAULT_BUDGET = 1.0\` s, \`RESERVE = 0.05\` s.

- **Validate first.** An empty \`sku\` or \`qty <= 0\` → **\`INVALID_ARGUMENT\`**. Pricing is never called.
- **The budget** is the time the caller still waits: Python \`context.time_remaining()\`; TypeScript
  \`call.getDeadline()\` minus \`Date.now()\`, in seconds, clamped at 0. A call with **no deadline** has a
  budget of \`DEFAULT_BUDGET\`. No deadline is not the same as a deadline of zero.
- **Spent budget.** If \`budget - RESERVE <= 0\`, answer **\`DEADLINE_EXCEEDED\`** without calling pricing.
- **Otherwise** call \`GetPrice\` at \`PRICING_TARGET\` **once**, with timeout \`budget - RESERVE\`
  (TypeScript: \`{deadline: Date.now() + timeout * 1000}\`). Never retry: the budget is already spent.
- **Map pricing errors:** \`DEADLINE_EXCEEDED\` → \`DEADLINE_EXCEEDED\`, \`NOT_FOUND\` → \`NOT_FOUND\`,
  \`UNAVAILABLE\` → \`UNAVAILABLE\`, anything else → **\`INTERNAL\`**.
- **Success:** \`Quote{sku, qty, total_cents = unit_cents * qty}\`.

> A deadline belongs to the request, not to the server. Every hop subtracts what it has used and
> passes the rest on, keeping back \`RESERVE\` to say why it failed.`,
  sequence: {
    participants: ['Checkout', 'Quotes', 'Pricing'],
    messages: [
      {from: 'Checkout', to: 'Quotes', label: 'GetQuote{kettle, 2} · deadline 0.8 s', kind: 'sync'},
      {from: 'Quotes', to: 'Quotes', label: 'budget 0.8 s · minus RESERVE 0.05 s', kind: 'sync'},
      {from: 'Quotes', to: 'Pricing', label: 'GetPrice{kettle} · timeout 0.75 s', kind: 'sync'},
      {from: 'Pricing', to: 'Quotes', label: 'Price{unit_cents: 3499}', kind: 'reply'},
      {from: 'Quotes', to: 'Checkout', label: 'Quote{kettle, 2, total_cents: 6998}', kind: 'reply'},
      {from: 'Checkout', to: 'Quotes', label: 'GetQuote{kettle, 2} · deadline 0.04 s', kind: 'sync'},
      {from: 'Quotes', to: 'Checkout', label: 'DEADLINE_EXCEEDED · pricing never called', kind: 'reply'},
    ],
  },
  hints: [
    'Two numbers decide the call: how long the caller still waits (`context.time_remaining()`, `call.getDeadline()`) and `RESERVE`. Test "no deadline" explicitly (`is None`, a non-finite deadline): `time_remaining() or DEFAULT_BUDGET` turns a spent budget of 0 into a fresh second.',
    'The order is validate, compute `budget - RESERVE`, answer DEADLINE_EXCEEDED at `<= 0`, then make one GetPrice call with that timeout. In TypeScript the deadline option is absolute: `Date.now() + timeout * 1000`.',
    "Map in one place: a set of the three codes that pass through unchanged, INTERNAL for the rest. A downstream INVALID_ARGUMENT is not the caller's fault, so it must not reach the caller as INVALID_ARGUMENT.",
  ],
  checks: [
    {
      id: 'propagates-deadline',
      title: "The pricing timeout is the caller's remaining time minus RESERVE",
      detail:
        'With an incoming deadline of 0.8 s the one GetPrice call to pricing:50051 carries a timeout of 0.75 s (± 0.01 s); with 0.3 s, 0.25 s. The quote is `unit_cents * qty`.',
      match: {
        python: {all: [/context\.time_remaining\(\)/, /pricing\.GetPrice\([\s\S]{0,200}?timeout\s*=/]},
        typescript: {all: [/call\.getDeadline\(\)/, /pricing\.GetPrice\([\s\S]{0,200}?deadline:/]},
        go: {all: [/ctx\.Deadline\(\)/, /context\.WithTimeout\(\s*ctx\s*,/]},
        scala: {all: [/Context\.current\(\)\.getDeadline/, /withDeadlineAfter\(/]},
        cpp: {all: [/context->deadline\(\)/, /set_deadline\(/]},
      },
    },
    {
      id: 'default-budget',
      title: 'Without an incoming deadline the budget is DEFAULT_BUDGET',
      detail:
        'A GetQuote with no deadline calls pricing with a timeout of 0.95 s (± 0.01 s), on every request: the default is computed per call, not once at start-up.',
      match: {
        python: {
          all: [/DEFAULT_BUDGET\s*=\s*1(\.0)?\b/, /\bis None\b|\bis not None\b/],
          none: [/time_remaining\(\)\s*or\b/],
        },
        typescript: {all: [/DEFAULT_BUDGET\s*=\s*1(\.0)?\b/, /isFinite\(|\bInfinity\b/]},
        go: {all: [/defaultBudget\s*=\s*[^\n]*time\.(Second|Millisecond)/, /,\s*ok\s*:=\s*ctx\.Deadline\(\)/]},
        scala: {all: [/DefaultBudgetMillis\s*=\s*1000L?/, /Option\(\s*Context\.current\(\)\.getDeadline\s*\)/]},
        cpp: {all: [/kDefaultBudget\{1000\}/, /time_point::max\(\)/]},
      },
    },
    {
      id: 'budget-exhausted',
      title: 'A budget at or under RESERVE answers DEADLINE_EXCEEDED without calling pricing',
      detail:
        'Incoming deadlines of 0.04 s and 0 s both answer `DEADLINE_EXCEEDED` with zero GetPrice calls; 0.1 s still calls pricing, with about 0.05 s.',
      match: {
        python: {all: [/RESERVE\s*=\s*0?\.05\b/, /StatusCode\.DEADLINE_EXCEEDED/, /<=\s*0\b/]},
        typescript: {all: [/RESERVE\s*=\s*0?\.05\b/, /status\.DEADLINE_EXCEEDED/, /<=\s*0\b/]},
        go: {all: [/reserve\s*=\s*50\s*\*\s*time\.Millisecond/, /codes\.DeadlineExceeded/, /<=\s*0\b/]},
        scala: {all: [/ReserveMillis\s*=\s*50L?/, /Status\.DEADLINE_EXCEEDED/, /<=\s*0\b/]},
        cpp: {
          all: [/kReserve\{50\}/, /StatusCode::DEADLINE_EXCEEDED/, /<=\s*(std::chrono::milliseconds::zero\(\)|0\b)/],
        },
      },
    },
    {
      id: 'slow-pricing',
      title: "A pricing call slower than the propagated timeout fails once, inside the caller's deadline",
      detail:
        'Pricing takes 0.9 s and the caller allows 0.8 s: exactly one GetPrice call, `DEADLINE_EXCEEDED` after 0.75 s, no retry. With no incoming deadline the same 0.9 s fits the 0.95 s default.',
      match: {
        python: {all: [/pricing\.GetPrice\(/], none: [/for \w+ in range\(/, /while /]},
        typescript: {all: [/pricing\.GetPrice\(/], none: [/\bfor\s*\(/, /while\s*\(/]},
        go: {all: [/pricing\.GetPrice\(/], none: [/\bfor\b/]},
        scala: {all: [/\.getPrice\(/], none: [/while\s*\(/, /\bfor\s*\(/]},
        cpp: {all: [/pricing->GetPrice\(/], none: [/\bfor\s*\(/, /while\s*\(/]},
      },
    },
    {
      id: 'status-mapping',
      title: 'Pricing errors map to DEADLINE_EXCEEDED, NOT_FOUND, UNAVAILABLE, else INTERNAL',
      detail:
        'NOT_FOUND, UNAVAILABLE and DEADLINE_EXCEEDED pass through; INVALID_ARGUMENT, PERMISSION_DENIED and RESOURCE_EXHAUSTED from pricing become `INTERNAL`. Six failures, six GetPrice calls.',
      match: {
        python: {
          all: [/StatusCode\.NOT_FOUND/, /StatusCode\.UNAVAILABLE/, /StatusCode\.INTERNAL/, /except grpc\.RpcError/],
        },
        typescript: {all: [/status\.NOT_FOUND/, /status\.UNAVAILABLE/, /status\.INTERNAL/, /catch\s*\(/]},
        go: {all: [/codes\.NotFound/, /codes\.Unavailable/, /codes\.Internal/, /status\.Code\(err\)/]},
        scala: {
          all: [/Status\.Code\.NOT_FOUND/, /Status\.Code\.UNAVAILABLE/, /Status\.INTERNAL/, /StatusRuntimeException/],
        },
        cpp: {all: [/StatusCode::NOT_FOUND/, /StatusCode::UNAVAILABLE/, /StatusCode::INTERNAL/, /error_code\(\)/]},
      },
    },
    {
      id: 'validates-first',
      title: 'An empty sku or qty <= 0 is INVALID_ARGUMENT before any pricing call',
      detail:
        'Empty sku, qty 0 and qty -3 answer `INVALID_ARGUMENT` with zero GetPrice calls, even when the deadline is already spent (validation comes before the budget).',
      match: {
        python: {
          all: [/StatusCode\.INVALID_ARGUMENT/, /qty\s*<=\s*0|qty\s*<\s*1/],
          order: [/StatusCode\.INVALID_ARGUMENT/, /pricing\.GetPrice\(/],
        },
        typescript: {
          all: [/status\.INVALID_ARGUMENT/, /qty\s*<=\s*0|qty\s*<\s*1/],
          order: [/status\.INVALID_ARGUMENT/, /pricing\.GetPrice\(/],
        },
        go: {
          all: [/codes\.InvalidArgument/, /Qty\(\)\s*<=\s*0/],
          order: [/codes\.InvalidArgument/, /pricing\.GetPrice\(/],
        },
        scala: {
          all: [/Status\.INVALID_ARGUMENT/, /qty\s*<=\s*0/],
          order: [/Status\.INVALID_ARGUMENT/, /\.getPrice\(/],
        },
        cpp: {
          all: [/StatusCode::INVALID_ARGUMENT/, /qty\(\)\s*<=\s*0/],
          order: [/StatusCode::INVALID_ARGUMENT/, /pricing->GetPrice\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio

import grpc

import quotes_pb2
import quotes_pb2_grpc

PRICING_TARGET = "pricing:50051"
DEFAULT_BUDGET = 1.0  # seconds, when the caller sent no deadline
RESERVE = 0.05  # seconds kept back to answer the caller

pricing = quotes_pb2_grpc.PricingStub(grpc.aio.insecure_channel(PRICING_TARGET))


class QuoteService(quotes_pb2_grpc.QuotesServicer):
    async def GetQuote(self, request: quotes_pb2.QuoteRequest, context: grpc.aio.ServicerContext) -> quotes_pb2.Quote:
        # TODO: empty sku or qty <= 0 → INVALID_ARGUMENT
        # TODO: budget = context.time_remaining(), or DEFAULT_BUDGET when the caller sent no deadline
        # TODO: budget - RESERVE <= 0 → DEADLINE_EXCEEDED without calling pricing
        # TODO: one GetPrice with timeout budget - RESERVE; map DEADLINE_EXCEEDED, NOT_FOUND, UNAVAILABLE through, else INTERNAL
        # TODO: Quote(sku, qty, total_cents = unit_cents * qty)
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "not implemented")


async def serve() -> None:
    server = grpc.aio.server()
    quotes_pb2_grpc.add_QuotesServicer_to_server(QuoteService(), server)
    server.add_insecure_port("[::]:50050")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
`,
      solution: `import asyncio

import grpc

import quotes_pb2
import quotes_pb2_grpc

PRICING_TARGET = "pricing:50051"
DEFAULT_BUDGET = 1.0  # seconds, when the caller sent no deadline
RESERVE = 0.05  # seconds kept back to answer the caller

pricing = quotes_pb2_grpc.PricingStub(grpc.aio.insecure_channel(PRICING_TARGET))

# Pricing statuses the caller can act on; anything else is our failure, not theirs.
PASS_THROUGH = {grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.NOT_FOUND, grpc.StatusCode.UNAVAILABLE}


def budget(context: grpc.aio.ServicerContext) -> float:
    """Seconds the caller still waits. None means no deadline, which is not the same as 0."""
    remaining = context.time_remaining()
    return DEFAULT_BUDGET if remaining is None else remaining


class QuoteService(quotes_pb2_grpc.QuotesServicer):
    async def GetQuote(self, request: quotes_pb2.QuoteRequest, context: grpc.aio.ServicerContext) -> quotes_pb2.Quote:
        if not request.sku or request.qty <= 0:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "sku is required and qty must be positive")
        timeout = budget(context) - RESERVE
        if timeout <= 0:
            await context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, "the caller's deadline leaves no time to price")
        try:
            price = await pricing.GetPrice(quotes_pb2.PriceRequest(sku=request.sku), timeout=timeout)
        except grpc.RpcError as e:
            code = e.code() if e.code() in PASS_THROUGH else grpc.StatusCode.INTERNAL
            await context.abort(code, f"pricing: {e.details()}")
        return quotes_pb2.Quote(sku=request.sku, qty=request.qty, total_cents=price.unit_cents * request.qty)


async def serve() -> None:
    server = grpc.aio.server()
    quotes_pb2_grpc.add_QuotesServicer_to_server(QuoteService(), server)
    server.add_insecure_port("[::]:50050")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface QuoteRequest {
  sku: string;
  qty: number;
}
interface Quote {
  sku: string;
  qty: number;
  total_cents: number;
}
interface Price {
  unit_cents: number;
}
interface PricingClient {
  GetPrice(request: {sku: string}, options: {deadline: number}): Promise<Price>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('quotes.proto')) as unknown as {
  quotes: {
    v1: {
      Quotes: grpc.ServiceClientConstructor;
      Pricing: new (target: string, credentials: grpc.ChannelCredentials) => PricingClient;
    };
  };
};

export const PRICING_TARGET = 'pricing:50051';
export const DEFAULT_BUDGET = 1.0; // seconds, when the caller sent no deadline
export const RESERVE = 0.05; // seconds kept back to answer the caller

const pricing = new pkg.quotes.v1.Pricing(PRICING_TARGET, grpc.credentials.createInsecure());

export const quoteService = {
  async GetQuote(call: grpc.ServerUnaryCall<QuoteRequest, Quote>, callback: grpc.sendUnaryData<Quote>): Promise<void> {
    // TODO: empty sku or qty <= 0 → INVALID_ARGUMENT
    // TODO: budget = (call.getDeadline() - Date.now()) / 1000 clamped at 0, or DEFAULT_BUDGET when there is no deadline (Infinity)
    // TODO: budget - RESERVE <= 0 → DEADLINE_EXCEEDED without calling pricing
    // TODO: one GetPrice with {deadline: Date.now() + timeout * 1000}; map DEADLINE_EXCEEDED, NOT_FOUND, UNAVAILABLE through, else INTERNAL
    // TODO: {sku, qty, total_cents: unit_cents * qty}
    callback({code: grpc.status.UNIMPLEMENTED, details: 'not implemented'});
  },
};

export const server = new grpc.Server();
server.addService(pkg.quotes.v1.Quotes.service, quoteService);

export function serve(): void {
  server.bindAsync('0.0.0.0:50050', grpc.ServerCredentials.createInsecure(), () => server.start());
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface QuoteRequest {
  sku: string;
  qty: number;
}
interface Quote {
  sku: string;
  qty: number;
  total_cents: number;
}
interface Price {
  unit_cents: number;
}
interface PricingClient {
  GetPrice(request: {sku: string}, options: {deadline: number}): Promise<Price>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('quotes.proto')) as unknown as {
  quotes: {
    v1: {
      Quotes: grpc.ServiceClientConstructor;
      Pricing: new (target: string, credentials: grpc.ChannelCredentials) => PricingClient;
    };
  };
};

export const PRICING_TARGET = 'pricing:50051';
export const DEFAULT_BUDGET = 1.0; // seconds, when the caller sent no deadline
export const RESERVE = 0.05; // seconds kept back to answer the caller

const pricing = new pkg.quotes.v1.Pricing(PRICING_TARGET, grpc.credentials.createInsecure());

// Pricing statuses the caller can act on; anything else is our failure, not theirs.
const PASS_THROUGH = new Set<number>([grpc.status.DEADLINE_EXCEEDED, grpc.status.NOT_FOUND, grpc.status.UNAVAILABLE]);

/** Seconds the caller still waits. No deadline (Infinity) is not the same as 0. */
function budget(call: grpc.ServerUnaryCall<QuoteRequest, Quote>): number {
  const deadline = Number(call.getDeadline());
  if (!Number.isFinite(deadline)) return DEFAULT_BUDGET;
  return Math.max(0, (deadline - Date.now()) / 1000);
}

export const quoteService = {
  async GetQuote(call: grpc.ServerUnaryCall<QuoteRequest, Quote>, callback: grpc.sendUnaryData<Quote>): Promise<void> {
    const {sku, qty} = call.request;
    if (!sku || qty <= 0) {
      callback({code: grpc.status.INVALID_ARGUMENT, details: 'sku is required and qty must be positive'});
      return;
    }
    const timeout = budget(call) - RESERVE;
    if (timeout <= 0) {
      callback({code: grpc.status.DEADLINE_EXCEEDED, details: "the caller's deadline leaves no time to price"});
      return;
    }
    try {
      const price = await pricing.GetPrice({sku}, {deadline: Date.now() + timeout * 1000});
      callback(null, {sku, qty, total_cents: price.unit_cents * qty});
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      callback({code: PASS_THROUGH.has(code) ? code : grpc.status.INTERNAL, details: \`pricing: \${details}\`});
    }
  },
};

export const server = new grpc.Server();
server.addService(pkg.quotes.v1.Quotes.service, quoteService);

export function serve(): void {
  server.bindAsync('0.0.0.0:50050', grpc.ServerCredentials.createInsecure(), () => server.start());
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"net"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "quotes/gen/quotes"
)

const (
	pricingTarget = "pricing:50051"
	defaultBudget = 1 * time.Second // when the caller sent no deadline
	reserve       = 50 * time.Millisecond // kept back to answer the caller
)

var conn, _ = grpc.NewClient(pricingTarget, grpc.WithTransportCredentials(insecure.NewCredentials()))
var pricing = pb.NewPricingClient(conn)

type quoteServer struct {
	pb.UnimplementedQuotesServer
}

func (s *quoteServer) GetQuote(ctx context.Context, req *pb.QuoteRequest) (*pb.Quote, error) {
	// TODO: empty sku or qty <= 0 → codes.InvalidArgument
	// TODO: budget = time until the incoming deadline, or defaultBudget when there is none
	// TODO: budget - reserve <= 0 → codes.DeadlineExceeded without calling pricing
	// TODO: one GetPrice under a context with timeout budget - reserve; map DeadlineExceeded, NotFound, Unavailable through, else Internal
	// TODO: Quote{Sku, Qty, TotalCents = UnitCents * Qty}
	return nil, status.Error(codes.Unimplemented, "not implemented")
}

func main() {
	lis, err := net.Listen("tcp", ":50050")
	if err != nil {
		log.Fatal(err)
	}
	srv := grpc.NewServer()
	pb.RegisterQuotesServer(srv, &quoteServer{})
	log.Fatal(srv.Serve(lis))
}
`,
      solution: `package main

import (
	"context"
	"log"
	"net"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "quotes/gen/quotes"
)

const (
	pricingTarget = "pricing:50051"
	defaultBudget = 1 * time.Second // when the caller sent no deadline
	reserve       = 50 * time.Millisecond // kept back to answer the caller
)

var conn, _ = grpc.NewClient(pricingTarget, grpc.WithTransportCredentials(insecure.NewCredentials()))
var pricing = pb.NewPricingClient(conn)

type quoteServer struct {
	pb.UnimplementedQuotesServer
}

func (s *quoteServer) GetQuote(ctx context.Context, req *pb.QuoteRequest) (*pb.Quote, error) {
	if req.GetSku() == "" || req.GetQty() <= 0 {
		return nil, status.Error(codes.InvalidArgument, "sku is required and qty must be positive")
	}
	budget := defaultBudget
	if deadline, ok := ctx.Deadline(); ok {
		budget = time.Until(deadline)
	}
	timeout := budget - reserve
	if timeout <= 0 {
		return nil, status.Error(codes.DeadlineExceeded, "the caller's deadline leaves no time to price")
	}
	// Derived from ctx: if the caller cancels, the pricing call is cancelled with it.
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	price, err := pricing.GetPrice(callCtx, &pb.PriceRequest{Sku: req.GetSku()})
	if err != nil {
		switch code := status.Code(err); code {
		case codes.DeadlineExceeded, codes.NotFound, codes.Unavailable:
			return nil, status.Error(code, "pricing: "+status.Convert(err).Message())
		default:
			return nil, status.Error(codes.Internal, "pricing: "+status.Convert(err).Message())
		}
	}
	return &pb.Quote{Sku: req.GetSku(), Qty: req.GetQty(), TotalCents: price.GetUnitCents() * req.GetQty()}, nil
}

func main() {
	lis, err := net.Listen("tcp", ":50050")
	if err != nil {
		log.Fatal(err)
	}
	srv := grpc.NewServer()
	pb.RegisterQuotesServer(srv, &quoteServer{})
	log.Fatal(srv.Serve(lis))
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, ServerBuilder, Status}
import quotes.v1.quotes.{PricingGrpc, Quote, QuoteRequest, QuotesGrpc}
import scala.concurrent.{ExecutionContext, Future}

object QuoteServer extends QuotesGrpc.Quotes {
  val DefaultBudgetMillis = 1000L // when the caller sent no deadline
  val ReserveMillis = 50L // kept back to answer the caller

  private val channel = ManagedChannelBuilder.forAddress("pricing", 50051).usePlaintext().build()
  private val pricing = PricingGrpc.blockingStub(channel)

  override def getQuote(req: QuoteRequest): Future[Quote] = {
    // TODO: empty sku or qty <= 0 → Status.INVALID_ARGUMENT
    // TODO: budget = Context.current().getDeadline remaining, or DefaultBudgetMillis when there is none
    // TODO: budget - ReserveMillis <= 0 → Status.DEADLINE_EXCEEDED without calling pricing
    // TODO: one getPrice withDeadlineAfter(budget - ReserveMillis); map DEADLINE_EXCEEDED, NOT_FOUND, UNAVAILABLE through, else INTERNAL
    // TODO: Quote(sku, qty, totalCents = unitCents * qty)
    Future.failed(Status.UNIMPLEMENTED.asRuntimeException())
  }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(50050).addService(QuotesGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{Context, ManagedChannelBuilder, ServerBuilder, Status, StatusRuntimeException}
import quotes.v1.quotes.{PriceRequest, PricingGrpc, Quote, QuoteRequest, QuotesGrpc}
import scala.concurrent.{ExecutionContext, Future}

object QuoteServer extends QuotesGrpc.Quotes {
  val DefaultBudgetMillis = 1000L // when the caller sent no deadline
  val ReserveMillis = 50L // kept back to answer the caller

  private val channel = ManagedChannelBuilder.forAddress("pricing", 50051).usePlaintext().build()
  private val pricing = PricingGrpc.blockingStub(channel)

  /** Milliseconds the caller still waits; a null deadline means none, which is not the same as 0. */
  private def budgetMillis(): Long =
    Option(Context.current().getDeadline).map(_.timeRemaining(TimeUnit.MILLISECONDS)).getOrElse(DefaultBudgetMillis)

  private def fail(status: Status, message: String): Future[Quote] =
    Future.failed(status.withDescription(message).asRuntimeException())

  override def getQuote(req: QuoteRequest): Future[Quote] = {
    if (req.sku.isEmpty || req.qty <= 0) return fail(Status.INVALID_ARGUMENT, "sku is required and qty must be positive")
    val timeoutMillis = budgetMillis() - ReserveMillis
    if (timeoutMillis <= 0) return fail(Status.DEADLINE_EXCEEDED, "the caller's deadline leaves no time to price")
    try {
      val price = pricing.withDeadlineAfter(timeoutMillis, TimeUnit.MILLISECONDS).getPrice(PriceRequest(sku = req.sku))
      Future.successful(Quote(sku = req.sku, qty = req.qty, totalCents = price.unitCents * req.qty))
    } catch {
      case e: StatusRuntimeException =>
        val mapped = e.getStatus.getCode match {
          case Status.Code.DEADLINE_EXCEEDED => Status.DEADLINE_EXCEEDED
          case Status.Code.NOT_FOUND         => Status.NOT_FOUND
          case Status.Code.UNAVAILABLE       => Status.UNAVAILABLE
          case _                             => Status.INTERNAL
        }
        fail(mapped, s"pricing: \${e.getStatus.getDescription}")
    }
  }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(50050).addService(QuotesGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

#include "quotes.grpc.pb.h"

using quotes::v1::Price;
using quotes::v1::PriceRequest;
using quotes::v1::Quote;
using quotes::v1::QuoteRequest;

constexpr std::chrono::milliseconds kDefaultBudget{1000};  // when the caller sent no deadline
constexpr std::chrono::milliseconds kReserve{50};          // kept back to answer the caller

auto channel = grpc::CreateChannel("pricing:50051", grpc::InsecureChannelCredentials());
auto pricing = quotes::v1::Pricing::NewStub(channel);

class QuotesImpl final : public quotes::v1::Quotes::Service {
 public:
  grpc::Status GetQuote(grpc::ServerContext* context, const QuoteRequest* request, Quote* reply) override {
    // TODO: empty sku or qty <= 0 → INVALID_ARGUMENT
    // TODO: budget = context's deadline minus now, or kDefaultBudget when there is none
    // TODO: budget - kReserve <= 0 → DEADLINE_EXCEEDED without calling pricing
    // TODO: one GetPrice with set_deadline(now + budget - kReserve); map DEADLINE_EXCEEDED, NOT_FOUND, UNAVAILABLE through, else INTERNAL
    // TODO: fill reply (sku, qty, total_cents = unit_cents * qty)
    return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
  }
};

int main() {
  QuotesImpl service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:50050", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

#include "quotes.grpc.pb.h"

using quotes::v1::Price;
using quotes::v1::PriceRequest;
using quotes::v1::Quote;
using quotes::v1::QuoteRequest;

constexpr std::chrono::milliseconds kDefaultBudget{1000};  // when the caller sent no deadline
constexpr std::chrono::milliseconds kReserve{50};          // kept back to answer the caller

auto channel = grpc::CreateChannel("pricing:50051", grpc::InsecureChannelCredentials());
auto pricing = quotes::v1::Pricing::NewStub(channel);

// Pricing statuses the caller can act on pass through; anything else is our failure, not theirs.
grpc::StatusCode mapped(grpc::StatusCode code) {
  switch (code) {
    case grpc::StatusCode::DEADLINE_EXCEEDED:
    case grpc::StatusCode::NOT_FOUND:
    case grpc::StatusCode::UNAVAILABLE:
      return code;
    default:
      return grpc::StatusCode::INTERNAL;
  }
}

class QuotesImpl final : public quotes::v1::Quotes::Service {
 public:
  grpc::Status GetQuote(grpc::ServerContext* context, const QuoteRequest* request, Quote* reply) override {
    if (request->sku().empty() || request->qty() <= 0)
      return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "sku is required and qty must be positive");
    const auto now = std::chrono::system_clock::now();
    const auto deadline = context->deadline();  // time_point::max() when the caller sent none
    const auto budget = deadline == std::chrono::system_clock::time_point::max()
                            ? kDefaultBudget
                            : std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
    const auto timeout = budget - kReserve;
    if (timeout <= std::chrono::milliseconds::zero())
      return grpc::Status(grpc::StatusCode::DEADLINE_EXCEEDED, "the caller's deadline leaves no time to price");

    grpc::ClientContext call;
    call.set_deadline(now + timeout);
    PriceRequest price_request;
    price_request.set_sku(request->sku());
    Price price;
    const grpc::Status status = pricing->GetPrice(&call, price_request, &price);
    if (!status.ok()) return grpc::Status(mapped(status.error_code()), "pricing: " + status.error_message());

    reply->set_sku(request->sku());
    reply->set_qty(request->qty());
    reply->set_total_cents(price.unit_cents() * request->qty());
    return grpc::Status::OK;
  }
};

int main() {
  QuotesImpl service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:50050", grpc::InsecureServerCredentials());
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

import quotes_pb2
import quotes_pb2_grpc

PRICING = "pricing:50051"
PRICES = {"kettle": 3499, "mug": 799}
TOL = 0.01  # seconds of slack on every recorded timeout


class FakePricing(quotes_pb2_grpc.PricingServicer):
    async def GetPrice(self, request, context):
        if request.sku not in PRICES:
            await context.abort(grpc.StatusCode.NOT_FOUND, f"no price for {request.sku}")
        return quotes_pb2.Price(unit_cents=PRICES[request.sku])


async def _start(ctx):
    """Pricing served at pricing:50051, the learner's server running as a task, and a Quotes stub."""
    ctx.grpc.serve(quotes_pb2_grpc.add_PricingServicer_to_server, FakePricing(), target=PRICING)
    m = ctx.load("quote_server")
    asyncio.create_task(m.serve())
    await asyncio.sleep(0)
    assert ctx.grpc.find("/quotes.v1.Quotes/GetQuote") is not None, "serve() must register the Quotes service on a gRPC server"
    return quotes_pb2_grpc.QuotesStub(grpc.aio.insecure_channel("quotes:50050"))


def _call(stub, sku="kettle", qty=2, deadline=0.8):
    """GetQuote with an incoming deadline of \`deadline\` seconds (None: no deadline at all)."""
    return stub.GetQuote(quotes_pb2.QuoteRequest(sku=sku, qty=qty), timeout=deadline)


async def _quote(stub, sku="kettle", qty=2, deadline=0.8):
    try:
        return await _call(stub, sku, qty, deadline)
    except grpc.RpcError as e:
        raise AssertionError(f"GetQuote({sku}, {qty}) with deadline {deadline} failed with {e.code()}: {e.details()}")


async def _code(call):
    try:
        await call
    except grpc.RpcError as e:
        return e.code()
    return grpc.StatusCode.OK


def _prices(ctx):
    return ctx.grpc.calls_to("GetPrice")


def _assert_timeout(call, expected, why):
    assert call.timeout is not None, f"the GetPrice call carries no deadline ({why}): pricing could outlive the caller"
    assert abs(call.timeout - expected) <= TOL, f"the GetPrice timeout was {call.timeout:.3f} s, expected {expected} s ± {TOL} ({why})"


async def check_propagates_deadline(ctx):
    stub = await _start(ctx)
    quote = await _quote(stub, "kettle", 2, 0.8)
    assert (quote.sku, quote.qty, quote.total_cents) == ("kettle", 2, 6998), f"GetQuote(kettle, 2) answered {quote!r}, expected sku kettle, qty 2, total_cents 3499 * 2 = 6998"
    calls = _prices(ctx)
    assert len(calls) == 1, f"one quote made {len(calls)} GetPrice calls, expected exactly one"
    assert calls[0].target == PRICING, f"GetPrice went to {calls[0].target!r}, expected {PRICING}"
    assert calls[0].request.sku == "kettle", f"GetPrice was asked for {calls[0].request.sku!r}, expected kettle"
    _assert_timeout(calls[0], 0.75, "0.8 s incoming minus RESERVE 0.05 s")
    quote = await _quote(stub, "mug", 3, 0.3)
    assert quote.total_cents == 2397, f"GetQuote(mug, 3) answered total_cents {quote.total_cents}, expected 799 * 3 = 2397"
    _assert_timeout(_prices(ctx)[-1], 0.25, "0.3 s incoming minus RESERVE 0.05 s: the timeout follows the caller, it is not a constant")


async def check_default_budget(ctx):
    stub = await _start(ctx)
    await _quote(stub, deadline=None)
    calls = _prices(ctx)
    assert len(calls) == 1, f"one quote made {len(calls)} GetPrice calls, expected exactly one"
    _assert_timeout(calls[0], 0.95, "no incoming deadline: DEFAULT_BUDGET 1.0 s minus RESERVE 0.05 s")
    ctx.clock.advance(30)
    await _quote(stub, deadline=None)
    _assert_timeout(_prices(ctx)[-1], 0.95, "a second call 30 s later: the default is per request, not a deadline fixed at start-up")


async def check_budget_exhausted(ctx):
    stub = await _start(ctx)
    for deadline in (0.04, 0.0):
        code = await _code(_call(stub, deadline=deadline))
        assert code == grpc.StatusCode.DEADLINE_EXCEEDED, f"an incoming deadline of {deadline} s answered {code}, expected DEADLINE_EXCEEDED (the budget is under RESERVE 0.05 s)"
        assert not _prices(ctx), f"with {deadline} s left pricing was called {len(_prices(ctx))} time(s): a call that cannot finish must not be started"
    await _quote(stub, deadline=0.1)
    calls = _prices(ctx)
    assert len(calls) == 1, f"an incoming deadline of 0.1 s must still call pricing once, saw {len(calls)} calls"
    _assert_timeout(calls[0], 0.05, "0.1 s incoming minus RESERVE 0.05 s")


async def check_slow_pricing(ctx):
    stub = await _start(ctx)
    ctx.grpc.set_latency("GetPrice", 0.9, target=PRICING)
    started = time.time()
    code = await _code(_call(stub, deadline=0.8))
    elapsed = time.time() - started
    assert code == grpc.StatusCode.DEADLINE_EXCEEDED, f"pricing takes 0.9 s and the caller allows 0.8 s: GetQuote answered {code}, expected DEADLINE_EXCEEDED"
    calls = _prices(ctx)
    assert len(calls) == 1, f"a timed-out pricing call was made {len(calls)} times, expected exactly one: the budget is spent, never retry"
    _assert_timeout(calls[0], 0.75, "0.8 s incoming minus RESERVE 0.05 s")
    assert elapsed <= 0.8 + TOL, f"the failure took {elapsed:.3f} s, after the caller's 0.8 s deadline: nobody was waiting for it"
    quote = await _quote(stub, deadline=None)
    assert quote.total_cents == 6998, f"with no incoming deadline the 0.9 s pricing call fits the 0.95 s default, got total_cents {quote.total_cents}"
    assert len(_prices(ctx)) == 2, f"expected 2 GetPrice calls in total, saw {len(_prices(ctx))}"


async def check_status_mapping(ctx):
    stub = await _start(ctx)
    code = await _code(_call(stub, sku="ghost"))
    assert code == grpc.StatusCode.NOT_FOUND, f"pricing answered NOT_FOUND for ghost, GetQuote answered {code}, expected NOT_FOUND"
    cases = [
        (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.UNAVAILABLE),
        (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.DEADLINE_EXCEEDED),
        (grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.INTERNAL),
        (grpc.StatusCode.PERMISSION_DENIED, grpc.StatusCode.INTERNAL),
        (grpc.StatusCode.RESOURCE_EXHAUSTED, grpc.StatusCode.INTERNAL),
    ]
    for failure, expected in cases:
        ctx.grpc.fail("GetPrice", failure, "pricing broke", times=1)
        code = await _code(_call(stub))
        assert code == expected, f"pricing failed with {failure.name}, GetQuote answered {code}, expected {expected.name}"
    calls = len(_prices(ctx))
    assert calls == 6, f"six failing quotes made {calls} GetPrice calls, expected six: never retry, not even UNAVAILABLE"
    quote = await _quote(stub)
    assert quote.total_cents == 6998, f"after the failures a healthy pricing must give total_cents 6998, got {quote.total_cents}"


async def check_validates_first(ctx):
    stub = await _start(ctx)
    for sku, qty, deadline in (("", 2, 0.8), ("kettle", 0, 0.8), ("kettle", -3, 0.8), ("", 2, 0.04)):
        code = await _code(_call(stub, sku, qty, deadline))
        assert code == grpc.StatusCode.INVALID_ARGUMENT, f"GetQuote(sku={sku!r}, qty={qty}) with deadline {deadline} s answered {code}, expected INVALID_ARGUMENT (validation comes first)"
    assert not _prices(ctx), f"invalid requests made {len(_prices(ctx))} GetPrice calls, expected none"
    quote = await _quote(stub, "kettle", 1)
    assert quote.total_cents == 3499, f"GetQuote(kettle, 1) must still succeed with 3499, got {quote.total_cents}"
`,
    typescript: `import * as grpc from '@grpc/grpc-js';

const PRICING = 'pricing:50051';
const PRICES: Record<string, number> = {kettle: 3499, mug: 799};
const TOL = 0.01; // seconds of slack on every recorded timeout

const STATUS_NAME = Object.fromEntries(Object.entries(grpc.status).map(([k, v]) => [v, k]));

/** Pricing served at pricing:50051, the learner's server up, and a Quotes client on it. */
function start(ctx) {
  const pkg = ctx.proto('quotes.proto');
  ctx.grpc.serve(
    pkg.quotes.v1.Pricing.service,
    {
      GetPrice(call, callback) {
        const unit = PRICES[call.request.sku];
        if (unit === undefined) return callback({code: grpc.status.NOT_FOUND, details: \`no price for \${call.request.sku}\`});
        callback(null, {unit_cents: unit});
      },
    },
    PRICING,
  );
  const m = ctx.load('quote_server');
  m.serve();
  return new pkg.quotes.v1.Quotes('quotes:50050', grpc.credentials.createInsecure());
}

/** GetQuote with an incoming deadline of \`deadline\` seconds (null: no deadline at all). */
const call = (client, sku = 'kettle', qty = 2, deadline: number | null = 0.8) =>
  deadline === null ? client.GetQuote({sku, qty}) : client.GetQuote({sku, qty}, {deadline: Date.now() + deadline * 1000});

async function quote(client, sku = 'kettle', qty = 2, deadline: number | null = 0.8) {
  try {
    return await call(client, sku, qty, deadline);
  } catch (e) {
    assert.fail(\`GetQuote(\${sku}, \${qty}) with deadline \${deadline} failed with \${STATUS_NAME[e?.code] ?? e?.code}: \${e?.details ?? e?.message ?? e}\`);
  }
}

async function code(promise): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return STATUS_NAME[e?.code] ?? String(e?.code);
  }
  return 'OK';
}

const prices = ctx => ctx.grpc.callsTo('GetPrice');

function assertTimeout(c, expected: number, why: string) {
  assert(c.timeout !== null, \`the GetPrice call carries no deadline (\${why}): pricing could outlive the caller\`);
  assert(Math.abs(c.timeout - expected) <= TOL, \`the GetPrice timeout was \${c.timeout.toFixed(3)} s, expected \${expected} s ± \${TOL} (\${why})\`);
}

export async function check_propagates_deadline(ctx) {
  const client = start(ctx);
  const q = await quote(client, 'kettle', 2, 0.8);
  assert.deepEqual([q.sku, q.qty, q.total_cents], ['kettle', 2, 6998], \`GetQuote(kettle, 2) answered \${JSON.stringify(q)}, expected sku kettle, qty 2, total_cents 3499 * 2 = 6998\`);
  const calls = prices(ctx);
  assert.equal(calls.length, 1, \`one quote made \${calls.length} GetPrice calls, expected exactly one\`);
  assert.equal(calls[0].target, PRICING, \`GetPrice went to \${JSON.stringify(calls[0].target)}, expected \${PRICING}\`);
  assert.equal(calls[0].request.sku, 'kettle', \`GetPrice was asked for \${JSON.stringify(calls[0].request.sku)}, expected kettle\`);
  assertTimeout(calls[0], 0.75, '0.8 s incoming minus RESERVE 0.05 s');
  const mug = await quote(client, 'mug', 3, 0.3);
  assert.equal(mug.total_cents, 2397, \`GetQuote(mug, 3) answered total_cents \${mug.total_cents}, expected 799 * 3 = 2397\`);
  assertTimeout(prices(ctx).at(-1), 0.25, '0.3 s incoming minus RESERVE 0.05 s: the timeout follows the caller, it is not a constant');
}

export async function check_default_budget(ctx) {
  const client = start(ctx);
  await quote(client, 'kettle', 2, null);
  const calls = prices(ctx);
  assert.equal(calls.length, 1, \`one quote made \${calls.length} GetPrice calls, expected exactly one\`);
  assertTimeout(calls[0], 0.95, 'no incoming deadline: DEFAULT_BUDGET 1.0 s minus RESERVE 0.05 s');
  ctx.clock.advance(30);
  await quote(client, 'kettle', 2, null);
  assertTimeout(prices(ctx).at(-1), 0.95, 'a second call 30 s later: the default is per request, not a deadline fixed at start-up');
}

export async function check_budget_exhausted(ctx) {
  const client = start(ctx);
  for (const deadline of [0.04, 0]) {
    const got = await code(call(client, 'kettle', 2, deadline));
    assert.equal(got, 'DEADLINE_EXCEEDED', \`an incoming deadline of \${deadline} s answered \${got}, expected DEADLINE_EXCEEDED (the budget is under RESERVE 0.05 s)\`);
    assert.equal(prices(ctx).length, 0, \`with \${deadline} s left pricing was called \${prices(ctx).length} time(s): a call that cannot finish must not be started\`);
  }
  await quote(client, 'kettle', 2, 0.1);
  const calls = prices(ctx);
  assert.equal(calls.length, 1, \`an incoming deadline of 0.1 s must still call pricing once, saw \${calls.length} calls\`);
  assertTimeout(calls[0], 0.05, '0.1 s incoming minus RESERVE 0.05 s');
}

export async function check_slow_pricing(ctx) {
  const client = start(ctx);
  ctx.grpc.setLatency('GetPrice', 0.9, PRICING);
  const started = Date.now();
  const got = await code(call(client, 'kettle', 2, 0.8));
  const elapsed = (Date.now() - started) / 1000;
  assert.equal(got, 'DEADLINE_EXCEEDED', \`pricing takes 0.9 s and the caller allows 0.8 s: GetQuote answered \${got}, expected DEADLINE_EXCEEDED\`);
  const calls = prices(ctx);
  assert.equal(calls.length, 1, \`a timed-out pricing call was made \${calls.length} times, expected exactly one: the budget is spent, never retry\`);
  assertTimeout(calls[0], 0.75, '0.8 s incoming minus RESERVE 0.05 s');
  assert(elapsed <= 0.8 + TOL, \`the failure took \${elapsed.toFixed(3)} s, after the caller's 0.8 s deadline: nobody was waiting for it\`);
  const q = await quote(client, 'kettle', 2, null);
  assert.equal(q.total_cents, 6998, \`with no incoming deadline the 0.9 s pricing call fits the 0.95 s default, got total_cents \${q.total_cents}\`);
  assert.equal(prices(ctx).length, 2, \`expected 2 GetPrice calls in total, saw \${prices(ctx).length}\`);
}

export async function check_status_mapping(ctx) {
  const client = start(ctx);
  let got = await code(call(client, 'ghost'));
  assert.equal(got, 'NOT_FOUND', \`pricing answered NOT_FOUND for ghost, GetQuote answered \${got}, expected NOT_FOUND\`);
  const cases: [string, string][] = [
    ['UNAVAILABLE', 'UNAVAILABLE'],
    ['DEADLINE_EXCEEDED', 'DEADLINE_EXCEEDED'],
    ['INVALID_ARGUMENT', 'INTERNAL'],
    ['PERMISSION_DENIED', 'INTERNAL'],
    ['RESOURCE_EXHAUSTED', 'INTERNAL'],
  ];
  for (const [failure, expected] of cases) {
    ctx.grpc.fail('GetPrice', grpc.status[failure], 'pricing broke', 1);
    got = await code(call(client));
    assert.equal(got, expected, \`pricing failed with \${failure}, GetQuote answered \${got}, expected \${expected}\`);
  }
  const calls = prices(ctx).length;
  assert.equal(calls, 6, \`six failing quotes made \${calls} GetPrice calls, expected six: never retry, not even UNAVAILABLE\`);
  const q = await quote(client);
  assert.equal(q.total_cents, 6998, \`after the failures a healthy pricing must give total_cents 6998, got \${q.total_cents}\`);
}

export async function check_validates_first(ctx) {
  const client = start(ctx);
  const cases: [string, number, number][] = [
    ['', 2, 0.8],
    ['kettle', 0, 0.8],
    ['kettle', -3, 0.8],
    ['', 2, 0.04],
  ];
  for (const [sku, qty, deadline] of cases) {
    const got = await code(call(client, sku, qty, deadline));
    assert.equal(got, 'INVALID_ARGUMENT', \`GetQuote(sku=\${JSON.stringify(sku)}, qty=\${qty}) with deadline \${deadline} s answered \${got}, expected INVALID_ARGUMENT (validation comes first)\`);
  }
  assert.equal(prices(ctx).length, 0, \`invalid requests made \${prices(ctx).length} GetPrice calls, expected none\`);
  const q = await quote(client, 'kettle', 1);
  assert.equal(q.total_cents, 3499, \`GetQuote(kettle, 1) must still succeed with 3499, got \${q.total_cents}\`);
}
`,
  },
  debrief: `A deadline is a property of the request: the moment after which the original caller stops caring. Each hop reads what is left, keeps a little back, and hands the rest down, so the whole tree of calls gives up together instead of the leaves working on for a caller that has already timed out. The reserve exists because a server that spends its entire budget downstream has no time left to report the failure; with 50 ms held back it answers DEADLINE_EXCEEDED itself, inside the caller's window, rather than having the caller's own timer fire on a silent connection. "No deadline" and "zero left" are opposites, which is why the test is \`is None\` and not truthiness. The call is never retried because a retry inside a spent budget only adds load at the moment a dependency is slowest. Statuses are translated rather than relayed: NOT_FOUND, UNAVAILABLE and DEADLINE_EXCEEDED mean something the caller can act on, while a downstream INVALID_ARGUMENT or PERMISSION_DENIED is this server's bug and becomes INTERNAL. Go and grpc-java do most of this implicitly (an outgoing call made with the incoming \`ctx\` or \`Context\` inherits its deadline, and grpc-js has the \`parent\` call option); production servers add the reserve on top, propagate cancellation as well as the deadline, export the remaining budget as a metric, and shed work early when the budget left is smaller than the dependency's p99.`,
};
