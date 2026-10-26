import type {Step} from '@/lib/types';

export const outlierEjectionStep: Step = {
  id: 'outlier-ejection',
  title: 'Round robin over three instances, ejecting the ones that fail at the transport',
  concept: 'grpc',
  file: 'balancer',
  focus: ['client', 'grpc'],
  task: `## Task

\`Inventory.GetStock(StockRequest{sku}) returns Stock{sku, count}\` (package \`inventory.v1\`) runs at three
instances: \`inv-a:50051\`, \`inv-b:50051\`, \`inv-c:50051\`. Implement \`Balancer.get_stock(sku)\` (TypeScript:
\`getStock\`), which returns \`count\`. The constructor is provided:
\`Balancer(targets, deadline=0.2, eject_for=30.0)\` (TypeScript: \`deadlineS\`, \`ejectForS\`) builds one stub per
target in \`stubs\`, a cursor \`_next = 0\` and \`_ejected_until = {}\` (target to the \`time.time()\` at which it
rejoins). \`AllEjected\`, a \`grpc.RpcError\` whose \`code()\` is \`UNAVAILABLE\`, is provided too.

- **Round robin.** Each attempt takes the target under the cursor and moves the cursor one place on, so the
  next pick continues after the last target used. A target whose \`_ejected_until\` is still in the future is
  skipped without a call.
- **Deadline.** Every attempt carries its own \`timeout=self.deadline\` (0.2 s).
- **Eject on \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\`.** Set \`_ejected_until[target] = time.time() + eject_for\`
  and try the next healthy target **in the same call**. One call tries each target at most once.
- **Application errors pass straight through.** \`NOT_FOUND\`, \`INVALID_ARGUMENT\` or any other code
  means the instance answered: raise it at once, no retry on another target, no ejection.
- **Nothing left to try.** When every target is ejected (or failed in this call), raise \`AllEjected()\`:
  \`UNAVAILABLE\`, and no RPC is sent for a target already ejected.
- **Readmission.** Once \`time.time()\` reaches \`_ejected_until[target]\` the target is back in the rotation.

> An instance that times out costs every call that lands on it 200 ms. Ejecting it turns that into one
> slow call per 30 s, and keeping \`NOT_FOUND\` out of the rule stops one bad SKU from emptying the pool.`,
  sequence: {
    participants: ['balancer', 'inv-a:50051', 'inv-b:50051', 'inv-c:50051'],
    messages: [
      {from: 'balancer', to: 'inv-a:50051', label: 'GetStock(sku-1)  timeout 0.2', kind: 'sync'},
      {from: 'inv-a:50051', to: 'balancer', label: 'Stock{count: 7}', kind: 'reply'},
      {from: 'balancer', to: 'inv-b:50051', label: 'GetStock(sku-1)  timeout 0.2', kind: 'sync'},
      {from: 'inv-b:50051', to: 'balancer', label: 'DEADLINE_EXCEEDED after 0.2 s', kind: 'reply'},
      {from: 'balancer', to: 'balancer', label: 'eject inv-b until now + 30 s', kind: 'sync'},
      {from: 'balancer', to: 'inv-c:50051', label: 'same call: GetStock(sku-1)', kind: 'sync'},
      {from: 'inv-c:50051', to: 'balancer', label: 'Stock{count: 7}', kind: 'reply'},
      {from: 'balancer', to: 'inv-a:50051', label: 'next call: inv-a (inv-b skipped, no RPC)', kind: 'sync'},
      {from: 'inv-a:50051', to: 'balancer', label: 'NOT_FOUND: raised, nothing ejected', kind: 'reply'},
    ],
  },
  hints: [
    'Loop `for _ in range(len(self.targets))`: read `self.targets[self._next]`, then `self._next = (self._next + 1) % len(self.targets)`. Advancing the cursor before the attempt is what makes the next call continue after the target just used, and the loop bound is what keeps one call to one try per target.',
    'Skip when `self._ejected_until.get(target, 0.0) > time.time()`. Otherwise `await self.stubs[target].GetStock(inventory_pb2.StockRequest(sku=sku), timeout=self.deadline)` and return `reply.count`.',
    'In `except grpc.RpcError as e`: if `e.code()` is neither `UNAVAILABLE` nor `DEADLINE_EXCEEDED`, a bare `raise`. Otherwise record `time.time() + self.eject_for` and let the loop go on. After the loop, `raise AllEjected()`.',
  ],
  checks: [
    {
      id: 'even-rotation',
      title: 'Healthy targets are called in turn, one attempt per call',
      detail:
        '9 calls over three healthy instances make exactly one RPC each, in list order from wherever the rotation starts (3 per target), carry the `sku` and return its `count`; a balancer over two targets alternates between them.',
      match: {
        python: {all: [/%\s*len\(\s*self\.targets\s*\)/]},
        typescript: {all: [/%\s*this\.targets\.length/]},
        go: {all: [/%\s*len\(\s*b\.targets\s*\)/]},
        scala: {all: [/%\s*targets\.(size|length)/]},
        cpp: {all: [/%\s*targets_\.size\(\)/]},
      },
    },
    {
      id: 'stopped-instance',
      title: 'A stopped instance fails over within the call and gets no further calls',
      detail:
        'With the next instance stopped, the call that lands on it gets `UNAVAILABLE`, tries the following target and still returns the count; the 6 calls after it alternate between the two survivors and never reach the stopped one.',
      match: {
        python: {
          all: [/except grpc\.RpcError/, /for \w+ in (range\(\s*len\(\s*self\.targets\s*\)\s*\)|self\.targets)\s*:/],
        },
        typescript: {
          all: [/catch\s*\(\s*\w+/, /for \((let \w+ = 0; \w+ < this\.targets\.length|const \w+ of this\.targets\))/],
        },
        go: {
          all: [/case [^\n]*codes\.Unavailable|==\s*codes\.Unavailable/, /for \w+ := 0; \w+ < len\(\s*b\.targets\s*\)/],
        },
        scala: {all: [/Status\.Code\.UNAVAILABLE/, /while \(\w+ < targets\.(size|length)\)/]},
        cpp: {all: [/grpc::StatusCode::UNAVAILABLE\b(?!\s*,\s*")/, /for \(size_t \w+ = 0; \w+ < targets_\.size\(\)/]},
      },
    },
    {
      id: 'readmission',
      title: 'An ejected target rejoins the rotation after 30 s',
      detail:
        'One injected `UNAVAILABLE` ejects a target: 10 calls spread over the next 29 s never reach it, and 30.5 s after the ejection the next 3 calls reach each target once.',
      match: {
        python: {all: [/time\.time\(\)\s*\+\s*self\.eject_for/, /[<>]=?\s*time\.time\(\)|time\.time\(\)\s*[<>]/]},
        typescript: {
          all: [/Date\.now\(\)\s*\+\s*this\.ejectForS\s*\*\s*1000/, /[<>]=?\s*Date\.now\(\)|Date\.now\(\)\s*[<>]/],
        },
        go: {
          all: [
            /time\.Now\(\)\.Add\(\s*ejectFor\s*\)/,
            /time\.Now\(\)\.(Before|After)\(|\.(Before|After)\(\s*time\.Now\(\)\s*\)/,
          ],
        },
        scala: {
          all: [
            /System\.currentTimeMillis\(\)\s*\+\s*ejectForMillis/,
            /[<>]=?\s*System\.currentTimeMillis\(\)|System\.currentTimeMillis\(\)\s*[<>]/,
          ],
        },
        cpp: {all: [/Clock::now\(\)\s*\+\s*kEjectFor/, /Clock::now\(\)\s*[<>]|[<>]=?\s*Clock::now\(\)/]},
      },
    },
    {
      id: 'attempt-deadline',
      title: 'Each attempt has a 0.2 s deadline; a slow instance is ejected and the next one serves',
      detail:
        'An instance with 1 s of latency fails that attempt with `DEADLINE_EXCEEDED` after 0.2 s (the recorded timeout is 0.2, the call takes at most 0.25 s) and the next target answers; it gets no calls afterwards, while an instance at 0.15 s keeps its turn.',
      match: {
        python: {all: [/\.GetStock\([^\n]*timeout\s*=\s*self\.deadline/, /StatusCode\.DEADLINE_EXCEEDED/]},
        typescript: {
          all: [
            /GetStock\([^\n]*deadline:\s*(new Date\()?Date\.now\(\)\s*\+\s*this\.deadlineS\s*\*\s*1000/,
            /status\.DEADLINE_EXCEEDED/,
          ],
        },
        go: {
          all: [
            /context\.WithTimeout\(\s*ctx\s*,\s*deadline\s*\)/,
            /case [^\n]*codes\.DeadlineExceeded|==\s*codes\.DeadlineExceeded/,
          ],
        },
        scala: {
          all: [
            /withDeadlineAfter\(\s*deadlineMillis\s*,\s*TimeUnit\.MILLISECONDS\s*\)/,
            /Status\.Code\.DEADLINE_EXCEEDED/,
          ],
        },
        cpp: {all: [/set_deadline\([^\n]*kDeadline/, /grpc::StatusCode::DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'application-errors',
      title: 'Application errors are raised at once: no retry, no ejection',
      detail:
        '`NOT_FOUND` (unknown SKU), `INVALID_ARGUMENT` (empty SKU) and an injected `PERMISSION_DENIED` each surface with their own code after exactly one RPC; afterwards 6 calls still reach every target twice, in rotation.',
      match: {
        python: {all: [/^\s+raise(\s+(e|err|exc|error))?\s*$/m]},
        typescript: {all: [/throw\s+(e|err|error)\s*;/]},
        go: {all: [/return 0, err\b/]},
        scala: {all: [/case \w+: StatusRuntimeException if /]},
        cpp: {all: [/throw RpcError\(\s*status\s*\)/]},
      },
    },
    {
      id: 'all-ejected',
      title: 'With every target ejected, fail fast with UNAVAILABLE and zero calls',
      detail:
        'All three stopped: one call tries each target once and raises `UNAVAILABLE`; the next 5 calls (and one 10 s later) raise `UNAVAILABLE` with no RPC and no time spent; once the instances are back and 30 s have passed, a call succeeds.',
      match: {
        python: {all: [/raise AllEjected\(/]},
        typescript: {all: [/throw new AllEjected\(/]},
        go: {all: [/status\.Error\(\s*codes\.Unavailable/]},
        scala: {all: [/throw Status\.UNAVAILABLE/]},
        cpp: {all: [/throw RpcError\(\s*grpc::Status\(\s*grpc::StatusCode::UNAVAILABLE/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Client-side round robin over Inventory instances, with outlier ejection."""
import time

import grpc

import inventory_pb2
import inventory_pb2_grpc

TARGETS = ["inv-a:50051", "inv-b:50051", "inv-c:50051"]


class AllEjected(grpc.RpcError):
    """No target is left to try: UNAVAILABLE, raised without a call."""

    def code(self):
        return grpc.StatusCode.UNAVAILABLE

    def details(self):
        return "every target is ejected"


class Balancer:
    def __init__(self, targets: list[str], deadline: float = 0.2, eject_for: float = 30.0):
        self.targets = list(targets)
        self.deadline = deadline  # seconds per attempt
        self.eject_for = eject_for  # seconds an ejected target stays out
        self.stubs = {t: inventory_pb2_grpc.InventoryStub(grpc.aio.insecure_channel(t)) for t in self.targets}
        self._next = 0  # index of the target the next pick starts from
        self._ejected_until: dict[str, float] = {}  # target: time.time() at which it rejoins

    async def get_stock(self, sku: str) -> int:
        """The count from one healthy instance."""
        # TODO: at most len(self.targets) attempts; take self.targets[self._next], advance the cursor
        # TODO: skip a target whose _ejected_until is in the future (no call)
        # TODO: GetStock with timeout=self.deadline; UNAVAILABLE / DEADLINE_EXCEEDED: eject for eject_for, try the next
        # TODO: any other code: raise it as is; nothing left to try: raise AllEjected()
        raise NotImplementedError
`,
      solution: `"""Client-side round robin over Inventory instances, with outlier ejection."""
import time

import grpc

import inventory_pb2
import inventory_pb2_grpc

TARGETS = ["inv-a:50051", "inv-b:50051", "inv-c:50051"]
EJECT_ON = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)  # the transport failed, not the request


class AllEjected(grpc.RpcError):
    """No target is left to try: UNAVAILABLE, raised without a call."""

    def code(self):
        return grpc.StatusCode.UNAVAILABLE

    def details(self):
        return "every target is ejected"


class Balancer:
    def __init__(self, targets: list[str], deadline: float = 0.2, eject_for: float = 30.0):
        self.targets = list(targets)
        self.deadline = deadline  # seconds per attempt
        self.eject_for = eject_for  # seconds an ejected target stays out
        self.stubs = {t: inventory_pb2_grpc.InventoryStub(grpc.aio.insecure_channel(t)) for t in self.targets}
        self._next = 0  # index of the target the next pick starts from
        self._ejected_until: dict[str, float] = {}  # target: time.time() at which it rejoins

    async def get_stock(self, sku: str) -> int:
        """The count from one healthy instance."""
        for _ in range(len(self.targets)):  # each target at most once per call
            target = self.targets[self._next]
            self._next = (self._next + 1) % len(self.targets)
            if self._ejected_until.get(target, 0.0) > time.time():
                continue  # ejected: no call
            try:
                reply = await self.stubs[target].GetStock(inventory_pb2.StockRequest(sku=sku), timeout=self.deadline)
            except grpc.RpcError as e:
                if e.code() not in EJECT_ON:
                    raise  # the instance answered; the request is what failed
                self._ejected_until[target] = time.time() + self.eject_for
                continue
            return reply.count
        raise AllEjected()
`,
    },
    typescript: {
      starter: `/** Client-side round robin over Inventory instances, with outlier ejection. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const TARGETS = ['inv-a:50051', 'inv-b:50051', 'inv-c:50051'];

interface Stock {
  sku: string;
  count: number;
}

interface InventoryClient {
  GetStock(request: {sku: string}, options: grpc.CallOptions): Promise<Stock>;
}

const proto = grpc.loadPackageDefinition(protoLoader.loadSync('inventory.proto')) as unknown as {
  inventory: {v1: {Inventory: grpc.ServiceClientConstructor}};
};

/** No target is left to try: UNAVAILABLE, thrown without a call. */
export class AllEjected extends Error {
  readonly code = grpc.status.UNAVAILABLE;
  readonly details = 'every target is ejected';
  constructor() {
    super('14 UNAVAILABLE: every target is ejected');
  }
}

export class Balancer {
  readonly targets: string[];
  readonly deadlineS: number; // seconds per attempt
  readonly ejectForS: number; // seconds an ejected target stays out
  readonly stubs: Record<string, InventoryClient>;
  private next = 0; // index of the target the next pick starts from
  private readonly ejectedUntil = new Map<string, number>(); // target: Date.now() at which it rejoins

  constructor(targets: string[], deadlineS = 0.2, ejectForS = 30) {
    this.targets = [...targets];
    this.deadlineS = deadlineS;
    this.ejectForS = ejectForS;
    this.stubs = Object.fromEntries(
      this.targets.map(t => [
        t,
        new proto.inventory.v1.Inventory(t, grpc.credentials.createInsecure()) as unknown as InventoryClient,
      ]),
    );
  }

  /** The count from one healthy instance. */
  async getStock(sku: string): Promise<number> {
    // TODO: at most this.targets.length attempts; take this.targets[this.next], advance the cursor
    // TODO: skip a target whose ejectedUntil is in the future (no call)
    // TODO: GetStock with {deadline: Date.now() + this.deadlineS * 1000}; UNAVAILABLE / DEADLINE_EXCEEDED: eject, try the next
    // TODO: any other code: throw it as is; nothing left to try: throw new AllEjected()
    throw new Error(\`not implemented: getStock(\${sku})\`);
  }
}
`,
      solution: `/** Client-side round robin over Inventory instances, with outlier ejection. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const TARGETS = ['inv-a:50051', 'inv-b:50051', 'inv-c:50051'];
const EJECT_ON = new Set<number>([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]); // the transport failed

interface Stock {
  sku: string;
  count: number;
}

interface InventoryClient {
  GetStock(request: {sku: string}, options: grpc.CallOptions): Promise<Stock>;
}

const proto = grpc.loadPackageDefinition(protoLoader.loadSync('inventory.proto')) as unknown as {
  inventory: {v1: {Inventory: grpc.ServiceClientConstructor}};
};

/** No target is left to try: UNAVAILABLE, thrown without a call. */
export class AllEjected extends Error {
  readonly code = grpc.status.UNAVAILABLE;
  readonly details = 'every target is ejected';
  constructor() {
    super('14 UNAVAILABLE: every target is ejected');
  }
}

export class Balancer {
  readonly targets: string[];
  readonly deadlineS: number; // seconds per attempt
  readonly ejectForS: number; // seconds an ejected target stays out
  readonly stubs: Record<string, InventoryClient>;
  private next = 0; // index of the target the next pick starts from
  private readonly ejectedUntil = new Map<string, number>(); // target: Date.now() at which it rejoins

  constructor(targets: string[], deadlineS = 0.2, ejectForS = 30) {
    this.targets = [...targets];
    this.deadlineS = deadlineS;
    this.ejectForS = ejectForS;
    this.stubs = Object.fromEntries(
      this.targets.map(t => [
        t,
        new proto.inventory.v1.Inventory(t, grpc.credentials.createInsecure()) as unknown as InventoryClient,
      ]),
    );
  }

  /** The count from one healthy instance. */
  async getStock(sku: string): Promise<number> {
    for (let tried = 0; tried < this.targets.length; tried++) {
      const target = this.targets[this.next];
      this.next = (this.next + 1) % this.targets.length;
      if ((this.ejectedUntil.get(target) ?? 0) > Date.now()) continue; // ejected: no call
      try {
        const reply = await this.stubs[target].GetStock({sku}, {deadline: Date.now() + this.deadlineS * 1000});
        return reply.count;
      } catch (err) {
        if (!EJECT_ON.has((err as {code?: number}).code ?? -1)) throw err; // the instance answered
        this.ejectedUntil.set(target, Date.now() + this.ejectForS * 1000);
      }
    }
    throw new AllEjected();
  }
}
`,
    },
    go: {
      starter: `// Client-side round robin over Inventory instances, with outlier ejection.
package main

import (
	"context"
	"errors"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "inventory/gen/inventory"
)

var targets = []string{"inv-a:50051", "inv-b:50051", "inv-c:50051"}

const (
	deadline = 200 * time.Millisecond // per attempt
	ejectFor = 30 * time.Second       // how long an ejected target stays out
)

// Balancer picks Inventory instances round robin and ejects the ones that fail at the transport.
type Balancer struct {
	mu           sync.Mutex
	targets      []string
	stubs        map[string]pb.InventoryClient
	next         int                  // index of the target the next pick starts from
	ejectedUntil map[string]time.Time // target: when it rejoins the rotation
}

func NewBalancer(targets []string) *Balancer {
	b := &Balancer{targets: targets, stubs: map[string]pb.InventoryClient{}, ejectedUntil: map[string]time.Time{}}
	for _, t := range targets {
		conn, _ := grpc.NewClient(t, grpc.WithTransportCredentials(insecure.NewCredentials()))
		b.stubs[t] = pb.NewInventoryClient(conn)
	}
	return b
}

// GetStock is the count from one healthy instance.
func (b *Balancer) GetStock(ctx context.Context, sku string) (int32, error) {
	// TODO: at most len(b.targets) attempts; take b.targets[b.next] under b.mu, advance the cursor
	// TODO: skip a target whose ejectedUntil is after time.Now() (no call)
	// TODO: GetStock with context.WithTimeout(ctx, deadline); Unavailable / DeadlineExceeded: eject for ejectFor, try the next
	// TODO: any other code: return it as is; nothing left to try: an Unavailable status error
	_, _, _ = context.Background, codes.OK, status.Code
	return 0, errors.New("not implemented")
}
`,
      solution: `// Client-side round robin over Inventory instances, with outlier ejection.
package main

import (
	"context"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "inventory/gen/inventory"
)

var targets = []string{"inv-a:50051", "inv-b:50051", "inv-c:50051"}

const (
	deadline = 200 * time.Millisecond // per attempt
	ejectFor = 30 * time.Second       // how long an ejected target stays out
)

// Balancer picks Inventory instances round robin and ejects the ones that fail at the transport.
type Balancer struct {
	mu           sync.Mutex
	targets      []string
	stubs        map[string]pb.InventoryClient
	next         int                  // index of the target the next pick starts from
	ejectedUntil map[string]time.Time // target: when it rejoins the rotation
}

func NewBalancer(targets []string) *Balancer {
	b := &Balancer{targets: targets, stubs: map[string]pb.InventoryClient{}, ejectedUntil: map[string]time.Time{}}
	for _, t := range targets {
		conn, _ := grpc.NewClient(t, grpc.WithTransportCredentials(insecure.NewCredentials()))
		b.stubs[t] = pb.NewInventoryClient(conn)
	}
	return b
}

// pick moves the cursor one place on and reports the target it passed and whether it is in the rotation.
func (b *Balancer) pick() (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	target := b.targets[b.next]
	b.next = (b.next + 1) % len(b.targets)
	return target, !time.Now().Before(b.ejectedUntil[target]) // the zero time: never ejected
}

func (b *Balancer) eject(target string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.ejectedUntil[target] = time.Now().Add(ejectFor)
}

// GetStock is the count from one healthy instance.
func (b *Balancer) GetStock(ctx context.Context, sku string) (int32, error) {
	for tried := 0; tried < len(b.targets); tried++ { // each target at most once per call
		target, healthy := b.pick()
		if !healthy {
			continue // ejected: no call
		}
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := b.stubs[target].GetStock(callCtx, &pb.StockRequest{Sku: sku})
		cancel()
		if err == nil {
			return reply.GetCount(), nil
		}
		switch status.Code(err) {
		case codes.Unavailable, codes.DeadlineExceeded:
			b.eject(target) // the transport failed: take the instance out, try the next
		default:
			return 0, err // the instance answered; the request is what failed
		}
	}
	return 0, status.Error(codes.Unavailable, "every target is ejected")
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import scala.collection.mutable

import inventory.v1.inventory.{InventoryGrpc, StockRequest}
import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

/** Client-side round robin over Inventory instances, with outlier ejection. */
final class Balancer(targets: Seq[String], deadlineMillis: Long = 200L, ejectForMillis: Long = 30000L) {
  private val stubs: Map[String, InventoryGrpc.InventoryBlockingStub] = targets.map { t =>
    t -> InventoryGrpc.blockingStub(ManagedChannelBuilder.forTarget(t).usePlaintext().build())
  }.toMap
  private var next = 0 // index of the target the next pick starts from
  private val ejectedUntil = mutable.Map.empty[String, Long] // target: epoch ms at which it rejoins

  /** The count from one healthy instance. */
  def getStock(sku: String): Int = {
    // TODO: at most targets.size attempts; take targets(next) (synchronized), advance the cursor
    // TODO: skip a target whose ejectedUntil is in the future (no call)
    // TODO: withDeadlineAfter(deadlineMillis, MILLISECONDS).getStock; UNAVAILABLE / DEADLINE_EXCEEDED: eject, try the next
    // TODO: any other StatusRuntimeException propagates; nothing left to try: throw Status.UNAVAILABLE as an exception
    ???
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.collection.mutable

import inventory.v1.inventory.{InventoryGrpc, StockRequest}
import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

/** Client-side round robin over Inventory instances, with outlier ejection. */
final class Balancer(targets: Seq[String], deadlineMillis: Long = 200L, ejectForMillis: Long = 30000L) {
  private val stubs: Map[String, InventoryGrpc.InventoryBlockingStub] = targets.map { t =>
    t -> InventoryGrpc.blockingStub(ManagedChannelBuilder.forTarget(t).usePlaintext().build())
  }.toMap
  private var next = 0 // index of the target the next pick starts from
  private val ejectedUntil = mutable.Map.empty[String, Long] // target: epoch ms at which it rejoins
  private val Ejectable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED) // the transport failed

  /** Moves the cursor one place on: the target it passed, and whether it is in the rotation. */
  private def pick(): (String, Boolean) = synchronized {
    val target = targets(next)
    next = (next + 1) % targets.size
    (target, ejectedUntil.getOrElse(target, 0L) <= System.currentTimeMillis())
  }

  /** The count from one healthy instance. */
  def getStock(sku: String): Int = {
    var tried = 0
    while (tried < targets.size) { // each target at most once per call
      tried += 1
      val (target, healthy) = pick()
      if (healthy) {
        try {
          return stubs(target)
            .withDeadlineAfter(deadlineMillis, TimeUnit.MILLISECONDS)
            .getStock(StockRequest(sku = sku))
            .count
        } catch {
          case e: StatusRuntimeException if Ejectable(e.getStatus.getCode) =>
            synchronized { ejectedUntil(target) = System.currentTimeMillis() + ejectForMillis }
        }
      }
    }
    throw Status.UNAVAILABLE.withDescription("every target is ejected").asRuntimeException()
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "inventory.grpc.pb.h"

using inventory::v1::Inventory;
using inventory::v1::Stock;
using inventory::v1::StockRequest;
using Clock = std::chrono::steady_clock;

const std::vector<std::string> kTargets = {"inv-a:50051", "inv-b:50051", "inv-c:50051"};
constexpr std::chrono::milliseconds kDeadline{200};  // per attempt
constexpr std::chrono::seconds kEjectFor{30};        // how long an ejected target stays out

// A failed GetStock, with the status the caller sees.
struct RpcError : std::runtime_error {
  explicit RpcError(grpc::Status s) : std::runtime_error(s.error_message()), status(std::move(s)) {}
  grpc::Status status;
};

// Client-side round robin over Inventory instances, with outlier ejection.
class Balancer {
 public:
  explicit Balancer(std::vector<std::string> targets) : targets_(std::move(targets)) {
    for (const auto& t : targets_)
      stubs_[t] = Inventory::NewStub(grpc::CreateChannel(t, grpc::InsecureChannelCredentials()));
  }

  // The count from one healthy instance.
  int32_t get_stock(const std::string& sku) {
    // TODO: at most targets_.size() attempts; take targets_[next_] under mu_, advance the cursor
    // TODO: skip a target whose ejected_until_ is after Clock::now() (no call)
    // TODO: GetStock with set_deadline(now + kDeadline); UNAVAILABLE / DEADLINE_EXCEEDED: eject, try the next
    // TODO: any other code: throw RpcError(status); nothing left to try: throw an UNAVAILABLE RpcError
    throw std::logic_error("not implemented: get_stock(" + sku + ")");
  }

 private:
  std::mutex mu_;
  std::vector<std::string> targets_;
  std::map<std::string, std::unique_ptr<Inventory::Stub>> stubs_;
  size_t next_ = 0;                                         // index of the target the next pick starts from
  std::map<std::string, Clock::time_point> ejected_until_;  // target: when it rejoins the rotation
};
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "inventory.grpc.pb.h"

using inventory::v1::Inventory;
using inventory::v1::Stock;
using inventory::v1::StockRequest;
using Clock = std::chrono::steady_clock;

const std::vector<std::string> kTargets = {"inv-a:50051", "inv-b:50051", "inv-c:50051"};
constexpr std::chrono::milliseconds kDeadline{200};  // per attempt
constexpr std::chrono::seconds kEjectFor{30};        // how long an ejected target stays out

// A failed GetStock, with the status the caller sees.
struct RpcError : std::runtime_error {
  explicit RpcError(grpc::Status s) : std::runtime_error(s.error_message()), status(std::move(s)) {}
  grpc::Status status;
};

// Client-side round robin over Inventory instances, with outlier ejection.
class Balancer {
 public:
  explicit Balancer(std::vector<std::string> targets) : targets_(std::move(targets)) {
    for (const auto& t : targets_)
      stubs_[t] = Inventory::NewStub(grpc::CreateChannel(t, grpc::InsecureChannelCredentials()));
  }

  // The count from one healthy instance.
  int32_t get_stock(const std::string& sku) {
    for (size_t tried = 0; tried < targets_.size(); ++tried) {  // each target at most once per call
      const std::string target = pick();
      if (target.empty()) continue;  // ejected: no call
      StockRequest request;
      request.set_sku(sku);
      Stock reply;
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
      const grpc::Status status = stubs_.at(target)->GetStock(&ctx, request, &reply);
      if (status.ok()) return reply.count();
      const grpc::StatusCode code = status.error_code();
      if (code != grpc::StatusCode::UNAVAILABLE && code != grpc::StatusCode::DEADLINE_EXCEEDED)
        throw RpcError(status);  // the instance answered; the request is what failed
      eject(target);
    }
    throw RpcError(grpc::Status(grpc::StatusCode::UNAVAILABLE, "every target is ejected"));
  }

 private:
  // Moves the cursor one place on: the target it passed, or "" when that target is ejected.
  std::string pick() {
    std::lock_guard<std::mutex> guard(mu_);
    const std::string target = targets_[next_];
    next_ = (next_ + 1) % targets_.size();
    return Clock::now() < ejected_until_[target] ? "" : target;
  }

  void eject(const std::string& target) {
    std::lock_guard<std::mutex> guard(mu_);
    ejected_until_[target] = Clock::now() + kEjectFor;
  }

  std::mutex mu_;
  std::vector<std::string> targets_;
  std::map<std::string, std::unique_ptr<Inventory::Stub>> stubs_;
  size_t next_ = 0;                                         // index of the target the next pick starts from
  std::map<std::string, Clock::time_point> ejected_until_;  // target: when it rejoins the rotation
};
`,
    },
  },
  harness: {
    python: `from collections import Counter

import grpc

import inventory_pb2
import inventory_pb2_grpc

TARGETS = ["inv-a:50051", "inv-b:50051", "inv-c:50051"]
STOCK = {"sku-1": 7, "sku-2": 42, "sku-3": 0}
SKUS = list(STOCK)


class FakeInventory(inventory_pb2_grpc.InventoryServicer):
    async def GetStock(self, request, context):
        if request.sku == "":
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "sku is required")
        if request.sku not in STOCK:
            await context.abort(grpc.StatusCode.NOT_FOUND, f"no sku {request.sku}")
        return inventory_pb2.Stock(sku=request.sku, count=STOCK[request.sku])


def _serve(ctx, targets=TARGETS):
    for t in targets:
        ctx.grpc.serve(inventory_pb2_grpc.add_InventoryServicer_to_server, FakeInventory(), target=t)


def _balancer(ctx, targets=TARGETS):
    """Three Inventory instances up, and a fresh Balancer over \`targets\`."""
    _serve(ctx)
    return ctx.load("balancer").Balancer(list(targets))


def _after(target, steps=1):
    return TARGETS[(TARGETS.index(target) + steps) % len(TARGETS)]


async def _get(ctx, lb, sku="sku-1"):
    """One get_stock: the count it returned and the GetStock calls it made, in order."""
    n = len(ctx.grpc.calls_to("GetStock"))
    try:
        count = await lb.get_stock(sku)
    except grpc.RpcError as e:
        made = [c.target for c in ctx.grpc.calls_to("GetStock")[n:]]
        raise AssertionError(f"get_stock({sku!r}) raised {e.code()} after calls to {made}, expected the count from a healthy instance")
    return count, ctx.grpc.calls_to("GetStock")[n:]


async def _fails(ctx, lb, sku="sku-1"):
    """One get_stock that must raise a gRPC error: the error and the calls it made."""
    n = len(ctx.grpc.calls_to("GetStock"))
    try:
        got = await lb.get_stock(sku)
    except grpc.RpcError as e:
        return e, ctx.grpc.calls_to("GetStock")[n:]
    made = [c.target for c in ctx.grpc.calls_to("GetStock")[n:]]
    raise AssertionError(f"get_stock({sku!r}) returned {got!r} after calls to {made}, expected a gRPC error")


async def _one(ctx, lb, sku="sku-1"):
    """A get_stock that makes exactly one call: the target it reached."""
    count, calls = await _get(ctx, lb, sku)
    assert len(calls) == 1, f"one get_stock over healthy instances made {len(calls)} calls ({[c.target for c in calls]}), expected one"
    assert count == STOCK[sku], f"get_stock({sku!r}) returned {count!r}, the instance answered count={STOCK[sku]}"
    return calls[0].target


async def check_even_rotation(ctx):
    lb = _balancer(ctx)
    seq = []
    for i in range(9):
        sku = SKUS[i % 3]
        count, calls = await _get(ctx, lb, sku)
        assert len(calls) == 1, f"call {i + 1} over three healthy instances made {len(calls)} GetStock calls ({[c.target for c in calls]}), expected one"
        assert calls[0].request.sku == sku, f"the request must carry sku={sku!r}, the instance received {calls[0].request.sku!r}"
        assert count == STOCK[sku], f"get_stock({sku!r}) returned {count!r}, the instance answered count={STOCK[sku]}"
        seq.append(calls[0].target)
    assert seq[0] in TARGETS, f"the first call reached {seq[0]}, which is not one of the targets {TARGETS}"
    start = TARGETS.index(seq[0])
    want = [TARGETS[(start + i) % 3] for i in range(9)]
    assert seq == want, f"9 calls reached {seq}; round robin continues after the last target used, in list order: {want}"
    assert Counter(seq) == Counter({t: 3 for t in TARGETS}), f"9 calls over 3 healthy instances must give each 3, got {dict(Counter(seq))}"
    pair = ctx.load("balancer").Balancer([TARGETS[0], TARGETS[2]])
    two = [await _one(ctx, pair) for _ in range(4)]
    assert TARGETS[1] not in two and two[0] != two[1] and two[0::2] == [two[0]] * 2 and two[1::2] == [two[1]] * 2, f"a Balancer over {[TARGETS[0], TARGETS[2]]} must alternate between exactly those, it reached {two}"


async def check_stopped_instance(ctx):
    lb = _balancer(ctx)
    seq = [await _one(ctx, lb) for _ in range(3)]
    down, survivor = seq[0], seq[1]  # down is next in the rotation
    ctx.grpc.stop(down)
    count, calls = await _get(ctx, lb, "sku-2")
    made = [c.target for c in calls]
    assert made == [down, survivor], f"with {down} stopped, the call that lands on it must try it once and then {survivor} in the same call; it called {made}"
    assert count == 42, f"the failover call must return the count from {survivor} (42), got {count!r}"
    before = len(ctx.grpc.calls_to("GetStock", target=down))
    rest = [await _one(ctx, lb) for _ in range(6)]
    assert down not in rest, f"{down} is down and was ejected, yet the next 6 calls reached {rest}"
    assert len(ctx.grpc.calls_to("GetStock", target=down)) == before, f"{down} received calls after it failed: an ejected target gets none"
    assert all(a != b for a, b in zip(rest, rest[1:])) and Counter(rest) == Counter({t: 3 for t in TARGETS if t != down}), f"the 6 calls after the failover must alternate between the two survivors, they reached {rest}"


async def check_readmission(ctx):
    lb = _balancer(ctx)
    first = await _one(ctx, lb)
    out = _after(first)
    ctx.grpc.fail("GetStock", grpc.StatusCode.UNAVAILABLE, times=1, target=out)
    count, calls = await _get(ctx, lb)
    made = [c.target for c in calls]
    assert made == [out, _after(out)], f"{out} answered UNAVAILABLE: the call must go on to {_after(out)}; it called {made}"
    assert count == STOCK["sku-1"], f"the failover call must return the count, got {count!r}"
    for i in range(10):
        ctx.clock.advance(2.9)
        target = await _one(ctx, lb)
        assert target != out, f"{out} was ejected {2.9 * (i + 1):.1f} s ago and was called again: ejection lasts 30 s"
    ctx.clock.advance(1.5)  # 30.5 s since the ejection
    back = [await _one(ctx, lb) for _ in range(3)]
    assert sorted(back) == sorted(TARGETS), f"30.5 s after the ejection {out} is back: the next 3 calls must reach each target once, they reached {back}"


async def check_attempt_deadline(ctx):
    lb = _balancer(ctx)
    first = await _one(ctx, lb)
    slow, after = _after(first), _after(first, 2)
    ctx.grpc.set_latency("GetStock", 1.0, target=slow)
    t0 = ctx.clock.time()
    count, calls = await _get(ctx, lb, "sku-2")
    took = ctx.clock.time() - t0
    made = [c.target for c in calls]
    assert made == [slow, after], f"{slow} takes 1 s: its attempt must time out and {after} serve the same call; it called {made}"
    assert count == 42, f"the call must return the count from {after} (42), got {count!r}"
    for c in calls:
        assert c.timeout is not None, f"the attempt to {c.target} carries no deadline: a stalled instance would hold the call forever"
        assert 0.19 <= c.timeout <= 0.21, f"each attempt carries a 0.2 s deadline, the attempt to {c.target} carried {c.timeout} s"
    assert calls[0].code == grpc.StatusCode.DEADLINE_EXCEEDED, f"the attempt to {slow} ended {calls[0].code}, expected DEADLINE_EXCEEDED"
    assert took <= 0.25, f"the call took {took:.2f} s: one attempt waits at most 0.2 s, not the instance's 1 s"
    rest = [await _one(ctx, lb) for _ in range(4)]
    assert slow not in rest, f"{slow} timed out and must be ejected, yet the next 4 calls reached {rest}"
    keeper = _after(slow, 2)  # the one that is neither slow nor the last used
    ctx.grpc.set_latency("GetStock", 0.15, target=keeper)
    more = [await _one(ctx, lb) for _ in range(4)]
    assert more.count(keeper) == 2, f"{keeper} answers in 0.15 s, inside the deadline: it keeps its turn (2 of the next 4 calls), it got {more}"


async def check_application_errors(ctx):
    lb = _balancer(ctx)
    for sku, code in (("ghost", grpc.StatusCode.NOT_FOUND), ("", grpc.StatusCode.INVALID_ARGUMENT)):
        for _ in range(3):
            e, calls = await _fails(ctx, lb, sku)
            made = [c.target for c in calls]
            assert e.code() == code, f"get_stock({sku!r}) raised {e.code()}, the instance answered {code}: an application error is raised as is"
            assert len(calls) == 1, f"get_stock({sku!r}) made {len(calls)} calls ({made}): {code} is the same answer from every instance, so no retry"
    ctx.grpc.fail("GetStock", grpc.StatusCode.PERMISSION_DENIED, times=1)
    e, calls = await _fails(ctx, lb, "sku-1")
    assert e.code() == grpc.StatusCode.PERMISSION_DENIED and len(calls) == 1, f"an injected PERMISSION_DENIED must surface after one call, got {e.code()} after {[c.target for c in calls]}"
    seq = [await _one(ctx, lb) for _ in range(6)]
    assert Counter(seq) == Counter({t: 2 for t in TARGETS}) and seq[3:] == seq[:3], f"application errors eject nothing: the next 6 calls must reach every target twice, in rotation, they reached {seq}"


async def check_all_ejected(ctx):
    lb = _balancer(ctx)
    for t in TARGETS:
        ctx.grpc.stop(t)
    e, calls = await _fails(ctx, lb)
    made = [c.target for c in calls]
    assert sorted(made) == sorted(TARGETS), f"with all three down, one call tries each target exactly once, it called {made}"
    assert e.code() == grpc.StatusCode.UNAVAILABLE, f"with nothing left to try the call raises UNAVAILABLE, got {e.code()}"
    t0 = ctx.clock.time()
    for _ in range(5):
        e, calls = await _fails(ctx, lb)
        assert e.code() == grpc.StatusCode.UNAVAILABLE, f"with every target ejected the call raises UNAVAILABLE, got {e.code()}"
        assert not calls, f"every target is ejected, yet the call reached {[c.target for c in calls]}: fail fast, no RPC"
    assert ctx.clock.time() - t0 <= 0.05, f"failing fast spends no time; the 5 calls took {ctx.clock.time() - t0:.2f} s"
    ctx.clock.advance(10)
    e, calls = await _fails(ctx, lb)
    assert e.code() == grpc.StatusCode.UNAVAILABLE and not calls, f"10 s later every target is still ejected: UNAVAILABLE with no RPC, got {e.code()} after {[c.target for c in calls]}"
    _serve(ctx)  # the instances come back
    ctx.clock.advance(20.5)
    target = await _one(ctx, lb)
    assert target in TARGETS
`,
    typescript: `const TARGETS = ['inv-a:50051', 'inv-b:50051', 'inv-c:50051'];
const STOCK: Record<string, number> = {'sku-1': 7, 'sku-2': 42, 'sku-3': 0};
const SKUS = Object.keys(STOCK);

type Call = {target: string; timeout: number | null; code: number | null; request: {sku: string}};
type RpcErr = {code?: number};

function serve(ctx): void {
  const service = ctx.proto('inventory.proto').inventory.v1.Inventory.service;
  for (const t of TARGETS) {
    ctx.grpc.serve(
      service,
      {
        GetStock: (call, callback) => {
          const {sku} = call.request as {sku: string};
          if (sku === '') return callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: 'sku is required'});
          if (!(sku in STOCK)) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`no sku \${sku}\`});
          callback(null, {sku, count: STOCK[sku]});
        },
      },
      t,
    );
  }
}

/** Three Inventory instances up, and a fresh Balancer over \`targets\`. */
function balancer(ctx, targets: string[] = TARGETS) {
  serve(ctx);
  return new (ctx.load('balancer').Balancer)([...targets]);
}

const after = (target: string, steps = 1): string => TARGETS[(TARGETS.indexOf(target) + steps) % TARGETS.length];
const statusName = (ctx, code: number | undefined) =>
  Object.keys(ctx.grpc.status).find(k => ctx.grpc.status[k] === code) ?? String(code);
const calls = (ctx, from: number): Call[] => ctx.grpc.callsTo('GetStock').slice(from);
const counts = (xs: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
};

/** One getStock: the count it returned and the GetStock calls it made, in order. */
async function get(ctx, lb, sku = 'sku-1'): Promise<{count: number; made: Call[]}> {
  const n = ctx.grpc.callsTo('GetStock').length;
  let count: number;
  try {
    count = await lb.getStock(sku);
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    assert.fail(\`getStock(\${JSON.stringify(sku)}) threw \${statusName(ctx, (e as RpcErr).code)} (\${String(e)}) after calls to \${JSON.stringify(calls(ctx, n).map(c => c.target))}, expected the count from a healthy instance\`);
  }
  return {count, made: calls(ctx, n)};
}

/** One getStock that must throw a gRPC error: the error and the calls it made. */
async function fails(ctx, lb, sku = 'sku-1'): Promise<{err: RpcErr; made: Call[]}> {
  const n = ctx.grpc.callsTo('GetStock').length;
  let got: unknown;
  try {
    got = await lb.getStock(sku);
  } catch (e) {
    return {err: e as RpcErr, made: calls(ctx, n)};
  }
  assert.fail(\`getStock(\${JSON.stringify(sku)}) returned \${JSON.stringify(got)} after calls to \${JSON.stringify(calls(ctx, n).map(c => c.target))}, expected a gRPC error\`);
}

/** A getStock that makes exactly one call: the target it reached. */
async function one(ctx, lb, sku = 'sku-1'): Promise<string> {
  const {count, made} = await get(ctx, lb, sku);
  assert.equal(made.length, 1, \`one getStock over healthy instances made \${made.length} calls (\${JSON.stringify(made.map(c => c.target))}), expected one\`);
  assert.equal(count, STOCK[sku], \`getStock(\${JSON.stringify(sku)}) returned \${JSON.stringify(count)}, the instance answered count=\${STOCK[sku]}\`);
  return made[0].target;
}

async function many(ctx, lb, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await one(ctx, lb));
  return out;
}

export async function check_even_rotation(ctx) {
  const lb = balancer(ctx);
  const seq: string[] = [];
  for (let i = 0; i < 9; i++) {
    const sku = SKUS[i % 3];
    const {count, made} = await get(ctx, lb, sku);
    assert.equal(made.length, 1, \`call \${i + 1} over three healthy instances made \${made.length} GetStock calls (\${JSON.stringify(made.map(c => c.target))}), expected one\`);
    assert.equal(made[0].request.sku, sku, \`the request must carry sku=\${JSON.stringify(sku)}, the instance received \${JSON.stringify(made[0].request.sku)}\`);
    assert.equal(count, STOCK[sku], \`getStock(\${JSON.stringify(sku)}) returned \${JSON.stringify(count)}, the instance answered count=\${STOCK[sku]}\`);
    seq.push(made[0].target);
  }
  assert(TARGETS.includes(seq[0]), \`the first call reached \${seq[0]}, which is not one of the targets\`);
  const start = TARGETS.indexOf(seq[0]);
  const want = Array.from({length: 9}, (_, i) => TARGETS[(start + i) % 3]);
  assert.deepEqual(seq, want, \`9 calls reached \${JSON.stringify(seq)}; round robin continues after the last target used, in list order: \${JSON.stringify(want)}\`);
  const pair = new (ctx.load('balancer').Balancer)([TARGETS[0], TARGETS[2]]);
  const two = await many(ctx, pair, 4);
  assert(
    !two.includes(TARGETS[1]) && two[0] !== two[1] && two[2] === two[0] && two[3] === two[1],
    \`a Balancer over \${JSON.stringify([TARGETS[0], TARGETS[2]])} must alternate between exactly those, it reached \${JSON.stringify(two)}\`,
  );
}

export async function check_stopped_instance(ctx) {
  const lb = balancer(ctx);
  const seq = await many(ctx, lb, 3);
  const [down, survivor] = seq; // down is next in the rotation
  ctx.grpc.stop(down);
  const {count, made} = await get(ctx, lb, 'sku-2');
  const targets = made.map(c => c.target);
  assert.deepEqual(targets, [down, survivor], \`with \${down} stopped, the call that lands on it must try it once and then \${survivor} in the same call; it called \${JSON.stringify(targets)}\`);
  assert.equal(count, 42, \`the failover call must return the count from \${survivor} (42), got \${JSON.stringify(count)}\`);
  const before = ctx.grpc.callsTo('GetStock', down).length;
  const rest = await many(ctx, lb, 6);
  assert(!rest.includes(down), \`\${down} is down and was ejected, yet the next 6 calls reached \${JSON.stringify(rest)}\`);
  assert.equal(ctx.grpc.callsTo('GetStock', down).length, before, \`\${down} received calls after it failed: an ejected target gets none\`);
  const c = counts(rest);
  assert(
    rest.every((t, i) => i === 0 || t !== rest[i - 1]) && Object.keys(c).length === 2 && Object.values(c).every(n => n === 3),
    \`the 6 calls after the failover must alternate between the two survivors, they reached \${JSON.stringify(rest)}\`,
  );
}

export async function check_readmission(ctx) {
  const lb = balancer(ctx);
  const first = await one(ctx, lb);
  const out = after(first);
  ctx.grpc.fail('GetStock', ctx.grpc.status.UNAVAILABLE, '', 1, out);
  const {count, made} = await get(ctx, lb);
  const targets = made.map(c => c.target);
  assert.deepEqual(targets, [out, after(out)], \`\${out} answered UNAVAILABLE: the call must go on to \${after(out)}; it called \${JSON.stringify(targets)}\`);
  assert.equal(count, STOCK['sku-1'], \`the failover call must return the count, got \${JSON.stringify(count)}\`);
  for (let i = 0; i < 10; i++) {
    ctx.clock.advance(2.9);
    const target = await one(ctx, lb);
    assert.notEqual(target, out, \`\${out} was ejected \${(2.9 * (i + 1)).toFixed(1)} s ago and was called again: ejection lasts 30 s\`);
  }
  ctx.clock.advance(1.5); // 30.5 s since the ejection
  const back = await many(ctx, lb, 3);
  assert.deepEqual([...back].sort(), [...TARGETS].sort(), \`30.5 s after the ejection \${out} is back: the next 3 calls must reach each target once, they reached \${JSON.stringify(back)}\`);
}

export async function check_attempt_deadline(ctx) {
  const lb = balancer(ctx);
  const first = await one(ctx, lb);
  const slow = after(first);
  const next = after(first, 2);
  ctx.grpc.setLatency('GetStock', 1.0, slow);
  const t0 = ctx.clock.now();
  const {count, made} = await get(ctx, lb, 'sku-2');
  const took = (ctx.clock.now() - t0) / 1000;
  const targets = made.map(c => c.target);
  assert.deepEqual(targets, [slow, next], \`\${slow} takes 1 s: its attempt must time out and \${next} serve the same call; it called \${JSON.stringify(targets)}\`);
  assert.equal(count, 42, \`the call must return the count from \${next} (42), got \${JSON.stringify(count)}\`);
  for (const c of made) {
    assert(c.timeout !== null && c.timeout !== undefined, \`the attempt to \${c.target} carries no deadline: a stalled instance would hold the call forever\`);
    assert(0.19 <= c.timeout && c.timeout <= 0.21, \`each attempt carries a 0.2 s deadline, the attempt to \${c.target} carried \${c.timeout} s\`);
  }
  assert.equal(made[0].code, ctx.grpc.status.DEADLINE_EXCEEDED, \`the attempt to \${slow} ended \${statusName(ctx, made[0].code ?? undefined)}, expected DEADLINE_EXCEEDED\`);
  assert(took <= 0.25, \`the call took \${took.toFixed(2)} s: one attempt waits at most 0.2 s, not the instance's 1 s\`);
  const rest = await many(ctx, lb, 4);
  assert(!rest.includes(slow), \`\${slow} timed out and must be ejected, yet the next 4 calls reached \${JSON.stringify(rest)}\`);
  const keeper = after(slow, 2); // the one that is neither slow nor the last used
  ctx.grpc.setLatency('GetStock', 0.15, keeper);
  const more = await many(ctx, lb, 4);
  assert.equal(more.filter(t => t === keeper).length, 2, \`\${keeper} answers in 0.15 s, inside the deadline: it keeps its turn (2 of the next 4 calls), it got \${JSON.stringify(more)}\`);
}

export async function check_application_errors(ctx) {
  const lb = balancer(ctx);
  for (const [sku, code] of [
    ['ghost', ctx.grpc.status.NOT_FOUND],
    ['', ctx.grpc.status.INVALID_ARGUMENT],
  ] as [string, number][]) {
    for (let i = 0; i < 3; i++) {
      const {err, made} = await fails(ctx, lb, sku);
      assert.equal(err.code, code, \`getStock(\${JSON.stringify(sku)}) threw \${statusName(ctx, err.code)}, the instance answered \${statusName(ctx, code)}: an application error is thrown as is\`);
      assert.equal(made.length, 1, \`getStock(\${JSON.stringify(sku)}) made \${made.length} calls (\${JSON.stringify(made.map(c => c.target))}): \${statusName(ctx, code)} is the same answer from every instance, so no retry\`);
    }
  }
  ctx.grpc.fail('GetStock', ctx.grpc.status.PERMISSION_DENIED, '', 1);
  const {err, made} = await fails(ctx, lb, 'sku-1');
  assert(err.code === ctx.grpc.status.PERMISSION_DENIED && made.length === 1, \`an injected PERMISSION_DENIED must surface after one call, got \${statusName(ctx, err.code)} after \${JSON.stringify(made.map(c => c.target))}\`);
  const seq = await many(ctx, lb, 6);
  const c = counts(seq);
  assert(
    TARGETS.every(t => c[t] === 2) && seq.slice(3).every((t, i) => t === seq[i]),
    \`application errors eject nothing: the next 6 calls must reach every target twice, in rotation, they reached \${JSON.stringify(seq)}\`,
  );
}

export async function check_all_ejected(ctx) {
  const lb = balancer(ctx);
  for (const t of TARGETS) ctx.grpc.stop(t);
  let {err, made} = await fails(ctx, lb);
  const targets = made.map(c => c.target);
  assert.deepEqual([...targets].sort(), [...TARGETS].sort(), \`with all three down, one call tries each target exactly once, it called \${JSON.stringify(targets)}\`);
  assert.equal(err.code, ctx.grpc.status.UNAVAILABLE, \`with nothing left to try the call throws UNAVAILABLE, got \${statusName(ctx, err.code)}\`);
  const t0 = ctx.clock.now();
  for (let i = 0; i < 5; i++) {
    ({err, made} = await fails(ctx, lb));
    assert.equal(err.code, ctx.grpc.status.UNAVAILABLE, \`with every target ejected the call throws UNAVAILABLE, got \${statusName(ctx, err.code)}\`);
    assert.equal(made.length, 0, \`every target is ejected, yet the call reached \${JSON.stringify(made.map(c => c.target))}: fail fast, no RPC\`);
  }
  assert(ctx.clock.now() - t0 <= 50, \`failing fast spends no time; the 5 calls took \${(ctx.clock.now() - t0) / 1000} s\`);
  ctx.clock.advance(10);
  ({err, made} = await fails(ctx, lb));
  assert(err.code === ctx.grpc.status.UNAVAILABLE && made.length === 0, \`10 s later every target is still ejected: UNAVAILABLE with no RPC, got \${statusName(ctx, err.code)} after \${JSON.stringify(made.map(c => c.target))}\`);
  serve(ctx); // the instances come back
  ctx.clock.advance(20.5);
  await one(ctx, lb);
}
`,
    go: `package main

import (
	"context"
	"sort"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"leetbuild/harness"

	pb "inventory/gen/inventory"
)

var (
	invTargets = []string{"inv-a:50051", "inv-b:50051", "inv-c:50051"}
	invStock   = map[string]int32{"sku-1": 7, "sku-2": 42, "sku-3": 0}
	invSkus    = []string{"sku-1", "sku-2", "sku-3"}
)

// invPeer is one Inventory instance.
type invPeer struct {
	pb.UnimplementedInventoryServer
}

func (invPeer) GetStock(ctx context.Context, req *pb.StockRequest) (*pb.Stock, error) {
	sku := req.GetSku()
	if sku == "" {
		return nil, status.Error(codes.InvalidArgument, "sku is required")
	}
	count, ok := invStock[sku]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "no sku %s", sku)
	}
	return &pb.Stock{Sku: sku, Count: count}, nil
}

func invServe(ctx *harness.Ctx) {
	for _, t := range invTargets {
		pb.RegisterInventoryServer(ctx.GRPC.Server(t), invPeer{})
	}
}

// invBalancer is three Inventory instances up, and a fresh Balancer over all of them.
func invBalancer(ctx *harness.Ctx) *Balancer {
	invServe(ctx)
	return NewBalancer(append([]string(nil), invTargets...))
}

// invAfter is the target steps places after target in the list.
func invAfter(target string, steps int) string {
	for i, t := range invTargets {
		if t == target {
			return invTargets[(i+steps)%len(invTargets)]
		}
	}
	return ""
}

func invTargetsOf(calls []harness.Call) []string {
	out := []string{}
	for _, c := range calls {
		out = append(out, c.Target)
	}
	return out
}

func invCount(xs []string) map[string]int {
	out := map[string]int{}
	for _, x := range xs {
		out[x]++
	}
	return out
}

// invGet is one GetStock that must succeed: the count it returned and the GetStock calls it made, in order.
func invGet(ctx *harness.Ctx, lb *Balancer, sku string) (int32, []harness.Call) {
	n := len(ctx.GRPC.CallsTo("GetStock", ""))
	count, err := lb.GetStock(context.Background(), sku)
	made := ctx.GRPC.CallsTo("GetStock", "")[n:]
	if err != nil {
		ctx.Fatalf("GetStock(%q) returned %v (%v) after calls to %v, expected the count from a healthy instance", sku, status.Code(err), err, invTargetsOf(made))
	}
	return count, made
}

// invFails is one GetStock that must return a gRPC error: the error and the calls it made.
func invFails(ctx *harness.Ctx, lb *Balancer, sku string) (error, []harness.Call) {
	n := len(ctx.GRPC.CallsTo("GetStock", ""))
	count, err := lb.GetStock(context.Background(), sku)
	made := ctx.GRPC.CallsTo("GetStock", "")[n:]
	if err == nil {
		ctx.Fatalf("GetStock(%q) returned %d after calls to %v, expected a gRPC error", sku, count, invTargetsOf(made))
	}
	return err, made
}

// invOne is a GetStock("sku-1") that makes exactly one call: the target it reached.
func invOne(ctx *harness.Ctx, lb *Balancer) string {
	count, made := invGet(ctx, lb, "sku-1")
	ctx.Equal(len(made), 1, "one GetStock over healthy instances made calls to %v, expected one: calls", invTargetsOf(made))
	ctx.Equal(count, invStock["sku-1"], "GetStock(%q) must return the count the instance answered", "sku-1")
	return made[0].Target
}

func invMany(ctx *harness.Ctx, lb *Balancer, n int) []string {
	var out []string
	for range n {
		out = append(out, invOne(ctx, lb))
	}
	return out
}

func CheckEvenRotation(ctx *harness.Ctx) {
	lb := invBalancer(ctx)
	var seq []string
	for i := range 9 {
		sku := invSkus[i%3]
		count, made := invGet(ctx, lb, sku)
		ctx.Equal(len(made), 1, "call %d over three healthy instances made GetStock calls to %v, expected one: calls", i+1, invTargetsOf(made))
		request, _ := made[0].Request.(*pb.StockRequest)
		ctx.Equal(request.GetSku(), sku, "the request must carry the sku: the instance received")
		ctx.Equal(count, invStock[sku], "GetStock(%q) must return the count the instance answered", sku)
		seq = append(seq, made[0].Target)
	}
	start := -1
	for i, t := range invTargets {
		if t == seq[0] {
			start = i
		}
	}
	ctx.Assert(start >= 0, "the first call reached %s, which is not one of the targets", seq[0])
	var want []string
	for i := range 9 {
		want = append(want, invTargets[(start+i)%3])
	}
	ctx.Equal(seq, want, "9 calls: round robin continues after the last target used, in list order")
	pair := NewBalancer([]string{invTargets[0], invTargets[2]})
	two := invMany(ctx, pair, 4)
	ctx.Assert(
		invCount(two)[invTargets[1]] == 0 && two[0] != two[1] && two[2] == two[0] && two[3] == two[1],
		"a Balancer over %v must alternate between exactly those, it reached %v", []string{invTargets[0], invTargets[2]}, two,
	)
}

func CheckStoppedInstance(ctx *harness.Ctx) {
	lb := invBalancer(ctx)
	seq := invMany(ctx, lb, 3)
	down, survivor := seq[0], seq[1] // down is next in the rotation
	ctx.GRPC.Stop(down)
	count, made := invGet(ctx, lb, "sku-2")
	ctx.Equal(invTargetsOf(made), []string{down, survivor}, "with %s stopped, the call that lands on it must try it once and then %s in the same call: calls", down, survivor)
	ctx.Equal(count, 42, "the failover call must return the count from %s", survivor)
	before := len(ctx.GRPC.CallsTo("GetStock", down))
	rest := invMany(ctx, lb, 6)
	ctx.Assert(invCount(rest)[down] == 0, "%s is down and was ejected, yet the next 6 calls reached %v", down, rest)
	ctx.Equal(len(ctx.GRPC.CallsTo("GetStock", down)), before, "%s received calls after it failed (an ejected target gets none): calls to it", down)
	alternates := true
	for i := 1; i < len(rest); i++ {
		alternates = alternates && rest[i] != rest[i-1]
	}
	c := invCount(rest)
	evenly := len(c) == 2
	for _, n := range c {
		evenly = evenly && n == 3
	}
	ctx.Assert(alternates && evenly, "the 6 calls after the failover must alternate between the two survivors, they reached %v", rest)
}

func CheckReadmission(ctx *harness.Ctx) {
	lb := invBalancer(ctx)
	first := invOne(ctx, lb)
	out := invAfter(first, 1)
	ctx.GRPC.Fail("GetStock", codes.Unavailable, "", 1, out)
	count, made := invGet(ctx, lb, "sku-1")
	ctx.Equal(invTargetsOf(made), []string{out, invAfter(out, 1)}, "%s answered UNAVAILABLE: the call must go on to %s; calls", out, invAfter(out, 1))
	ctx.Equal(count, invStock["sku-1"], "the failover call must return the count")
	for i := range 10 {
		ctx.Clock.Advance(2.9)
		target := invOne(ctx, lb)
		ctx.Assert(target != out, "%s was ejected %.1f s ago and was called again: ejection lasts 30 s", out, 2.9*float64(i+1))
	}
	ctx.Clock.Advance(1.5) // 30.5 s since the ejection
	back := invMany(ctx, lb, 3)
	sorted := append([]string(nil), back...)
	sort.Strings(sorted)
	ctx.Equal(sorted, invTargets, "30.5 s after the ejection %s is back: the next 3 calls (%v) must reach each target once", out, back)
}

func CheckAttemptDeadline(ctx *harness.Ctx) {
	lb := invBalancer(ctx)
	first := invOne(ctx, lb)
	slow := invAfter(first, 1)
	next := invAfter(first, 2)
	ctx.GRPC.SetLatency("GetStock", 1.0, slow)
	t0 := ctx.Clock.Now()
	count, made := invGet(ctx, lb, "sku-2")
	took := float64(ctx.Clock.Now()-t0) / 1000
	ctx.Equal(invTargetsOf(made), []string{slow, next}, "%s takes 1 s: its attempt must time out and %s serve the same call; calls", slow, next)
	ctx.Equal(count, 42, "the call must return the count from %s", next)
	for _, c := range made {
		ctx.Assert(c.HasDeadline(), "the attempt to %s carries no deadline: a stalled instance would hold the call forever", c.Target)
		timeout := c.Timeout.Seconds()
		ctx.Assert(0.19 <= timeout && timeout <= 0.21, "each attempt carries a 0.2 s deadline, the attempt to %s carried %v s", c.Target, timeout)
	}
	ctx.Equal(made[0].Code, codes.DeadlineExceeded, "the attempt to %s must end DEADLINE_EXCEEDED", slow)
	ctx.Assert(took <= 0.25, "the call took %.2f s: one attempt waits at most 0.2 s, not the instance's 1 s", took)
	rest := invMany(ctx, lb, 4)
	ctx.Assert(invCount(rest)[slow] == 0, "%s timed out and must be ejected, yet the next 4 calls reached %v", slow, rest)
	keeper := invAfter(slow, 2) // the one that is neither slow nor the last used
	ctx.GRPC.SetLatency("GetStock", 0.15, keeper)
	more := invMany(ctx, lb, 4)
	ctx.Equal(invCount(more)[keeper], 2, "%s answers in 0.15 s, inside the deadline: it keeps its turn (the next 4 calls reached %v); its calls", keeper, more)
}

func CheckApplicationErrors(ctx *harness.Ctx) {
	lb := invBalancer(ctx)
	cases := []struct {
		sku  string
		code codes.Code
	}{{"ghost", codes.NotFound}, {"", codes.InvalidArgument}}
	for _, tc := range cases {
		for range 3 {
			err, made := invFails(ctx, lb, tc.sku)
			ctx.Equal(status.Code(err), tc.code, "GetStock(%q) failed (%v): an application error is returned as is", tc.sku, err)
			ctx.Equal(len(made), 1, "GetStock(%q) made calls to %v: %v is the same answer from every instance, so no retry; calls", tc.sku, invTargetsOf(made), tc.code)
		}
	}
	ctx.GRPC.Fail("GetStock", codes.PermissionDenied, "", 1, "")
	err, made := invFails(ctx, lb, "sku-1")
	ctx.Assert(status.Code(err) == codes.PermissionDenied && len(made) == 1, "an injected PERMISSION_DENIED must surface after one call, got %v after %v", status.Code(err), invTargetsOf(made))
	seq := invMany(ctx, lb, 6)
	c := invCount(seq)
	inRotation := true
	for i, t := range seq[3:] {
		inRotation = inRotation && t == seq[i]
	}
	for _, t := range invTargets {
		inRotation = inRotation && c[t] == 2
	}
	ctx.Assert(inRotation, "application errors eject nothing: the next 6 calls must reach every target twice, in rotation, they reached %v", seq)
}

func CheckAllEjected(ctx *harness.Ctx) {
	lb := invBalancer(ctx)
	for _, t := range invTargets {
		ctx.GRPC.Stop(t)
	}
	err, made := invFails(ctx, lb, "sku-1")
	targets := invTargetsOf(made)
	sort.Strings(targets)
	ctx.Equal(targets, invTargets, "with all three down, one call tries each target exactly once (it called %v)", invTargetsOf(made))
	ctx.Equal(status.Code(err), codes.Unavailable, "with nothing left to try the call returns UNAVAILABLE")
	t0 := ctx.Clock.Now()
	for range 5 {
		err, made = invFails(ctx, lb, "sku-1")
		ctx.Equal(status.Code(err), codes.Unavailable, "with every target ejected the call returns UNAVAILABLE")
		ctx.Equal(len(made), 0, "every target is ejected, yet the call reached %v (fail fast, no RPC): calls", invTargetsOf(made))
	}
	ctx.Assert(ctx.Clock.Now()-t0 <= 50, "failing fast spends no time; the 5 calls took %v s", float64(ctx.Clock.Now()-t0)/1000)
	ctx.Clock.Advance(10)
	err, made = invFails(ctx, lb, "sku-1")
	ctx.Assert(status.Code(err) == codes.Unavailable && len(made) == 0, "10 s later every target is still ejected: UNAVAILABLE with no RPC, got %v after %v", status.Code(err), invTargetsOf(made))
	invServe(ctx) // the instances come back
	ctx.Clock.Advance(20.5)
	invOne(ctx, lb)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

const std::vector<std::string> kInvTargets = {"inv-a:50051", "inv-b:50051", "inv-c:50051"};
const std::map<std::string, int32_t> kInvStock = {{"sku-1", 7}, {"sku-2", 42}, {"sku-3", 0}};
const std::vector<std::string> kInvSkus = {"sku-1", "sku-2", "sku-3"};

// One Inventory instance.
class InvPeer final : public inventory::v1::Inventory::Service {
 public:
  grpc::Status GetStock(grpc::ServerContext*, const inventory::v1::StockRequest* request, inventory::v1::Stock* reply) override {
    const std::string& sku = request->sku();
    if (sku.empty()) return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "sku is required");
    const auto count = kInvStock.find(sku);
    if (count == kInvStock.end()) return grpc::Status(grpc::StatusCode::NOT_FOUND, "no sku " + sku);
    reply->set_sku(sku);
    reply->set_count(count->second);
    return grpc::Status::OK;
  }
};

void InvServe(harness::Ctx& ctx) {
  for (const auto& t : kInvTargets) ctx.GRPC.Server(t)->RegisterService(new InvPeer());
}

// Three Inventory instances up, and a fresh Balancer over all of them.
std::unique_ptr<Balancer> InvBalancer(harness::Ctx& ctx) {
  InvServe(ctx);
  return std::make_unique<Balancer>(kInvTargets);
}

// The target steps places after target in the list.
std::string InvAfter(const std::string& target, int steps) {
  for (size_t i = 0; i < kInvTargets.size(); ++i) {
    if (kInvTargets[i] == target) return kInvTargets[(i + static_cast<size_t>(steps)) % kInvTargets.size()];
  }
  return "";
}

std::vector<std::string> InvTargetsOf(const std::vector<harness::Call>& calls) {
  std::vector<std::string> out;
  for (const auto& c : calls) out.push_back(c.Target);
  return out;
}

std::map<std::string, int> InvCount(const std::vector<std::string>& xs) {
  std::map<std::string, int> out;
  for (const auto& x : xs) out[x]++;
  return out;
}

// How one get_stock ended: the count, or the error it threw (its gRPC status, when an RpcError).
struct InvResult {
  bool failed = false;
  int32_t count = 0;
  grpc::StatusCode code = grpc::StatusCode::OK;
  std::string error;
  std::vector<harness::Call> made;  // the GetStock calls it made, in order
};

InvResult InvRun(harness::Ctx& ctx, Balancer& bal, const std::string& sku) {
  const size_t n = ctx.GRPC.CallsTo("GetStock").size();
  InvResult r;
  try {
    r.count = bal.get_stock(sku);
  } catch (const RpcError& e) {
    r.failed = true;
    r.code = e.status.error_code();
    r.error = e.status.error_message();
  } catch (const std::exception& e) {
    r.failed = true;
    r.code = grpc::StatusCode::UNKNOWN;
    r.error = e.what();
  }
  const auto calls = ctx.GRPC.CallsTo("GetStock");
  r.made.assign(calls.begin() + static_cast<long>(n), calls.end());
  return r;
}

// One get_stock that must succeed.
InvResult InvGet(harness::Ctx& ctx, Balancer& bal, const std::string& sku) {
  InvResult r = InvRun(ctx, bal, sku);
  if (r.failed)
    ctx.Fatalf("get_stock(%q) threw %v (%s) after calls to %v, expected the count from a healthy instance", sku, r.code, r.error,
               InvTargetsOf(r.made));
  return r;
}

// One get_stock that must throw a gRPC error (an RpcError).
InvResult InvFails(harness::Ctx& ctx, Balancer& bal, const std::string& sku) {
  InvResult r = InvRun(ctx, bal, sku);
  if (!r.failed) ctx.Fatalf("get_stock(%q) returned %d after calls to %v, expected an RpcError", sku, r.count, InvTargetsOf(r.made));
  return r;
}

// A get_stock("sku-1") that makes exactly one call: the target it reached.
std::string InvOne(harness::Ctx& ctx, Balancer& bal) {
  const InvResult r = InvGet(ctx, bal, "sku-1");
  ctx.Equal(r.made.size(), 1, "one get_stock over healthy instances made calls to %v, expected one: calls", InvTargetsOf(r.made));
  ctx.Equal(r.count, kInvStock.at("sku-1"), "get_stock(%q) must return the count the instance answered", "sku-1");
  return r.made[0].Target;
}

std::vector<std::string> InvMany(harness::Ctx& ctx, Balancer& bal, int n) {
  std::vector<std::string> out;
  for (int i = 0; i < n; ++i) out.push_back(InvOne(ctx, bal));
  return out;
}

}  // namespace

void CheckEvenRotation(harness::Ctx& ctx) {
  auto bal = InvBalancer(ctx);
  std::vector<std::string> seq;
  for (int i = 0; i < 9; ++i) {
    const std::string& sku = kInvSkus[static_cast<size_t>(i % 3)];
    const InvResult r = InvGet(ctx, *bal, sku);
    ctx.Equal(r.made.size(), 1, "call %d over three healthy instances made GetStock calls to %v, expected one: calls", i + 1,
              InvTargetsOf(r.made));
    ctx.Equal(r.made[0].Request<inventory::v1::StockRequest>().sku(), sku, "the request must carry the sku: the instance received");
    ctx.Equal(r.count, kInvStock.at(sku), "get_stock(%q) must return the count the instance answered", sku);
    seq.push_back(r.made[0].Target);
  }
  int start = -1;
  for (size_t i = 0; i < kInvTargets.size(); ++i) {
    if (kInvTargets[i] == seq[0]) start = static_cast<int>(i);
  }
  ctx.Assert(start >= 0, "the first call reached %s, which is not one of the targets", seq[0]);
  std::vector<std::string> want;
  for (int i = 0; i < 9; ++i) want.push_back(kInvTargets[static_cast<size_t>((start + i) % 3)]);
  ctx.Equal(seq, want, "9 calls: round robin continues after the last target used, in list order");
  Balancer pair({kInvTargets[0], kInvTargets[2]});
  const auto two = InvMany(ctx, pair, 4);
  ctx.Assert(InvCount(two)[kInvTargets[1]] == 0 && two[0] != two[1] && two[2] == two[0] && two[3] == two[1],
             "a Balancer over %v must alternate between exactly those, it reached %v",
             std::vector<std::string>{kInvTargets[0], kInvTargets[2]}, two);
}

void CheckStoppedInstance(harness::Ctx& ctx) {
  auto bal = InvBalancer(ctx);
  const auto seq = InvMany(ctx, *bal, 3);
  const std::string down = seq[0], survivor = seq[1];  // down is next in the rotation
  ctx.GRPC.Stop(down);
  const InvResult r = InvGet(ctx, *bal, "sku-2");
  ctx.Equal(InvTargetsOf(r.made), {down, survivor},
            "with %s stopped, the call that lands on it must try it once and then %s in the same call: calls", down, survivor);
  ctx.Equal(r.count, 42, "the failover call must return the count from %s", survivor);
  const size_t before = ctx.GRPC.CallsTo("GetStock", down).size();
  const auto rest = InvMany(ctx, *bal, 6);
  ctx.Assert(InvCount(rest)[down] == 0, "%s is down and was ejected, yet the next 6 calls reached %v", down, rest);
  ctx.Equal(ctx.GRPC.CallsTo("GetStock", down).size(), before, "%s received calls after it failed (an ejected target gets none): calls to it",
            down);
  bool alternates = true;
  for (size_t i = 1; i < rest.size(); ++i) alternates = alternates && rest[i] != rest[i - 1];
  const auto c = InvCount(rest);
  bool evenly = c.size() == 2;
  for (const auto& [target, n] : c) evenly = evenly && n == 3;
  ctx.Assert(alternates && evenly, "the 6 calls after the failover must alternate between the two survivors, they reached %v", rest);
}

void CheckReadmission(harness::Ctx& ctx) {
  auto bal = InvBalancer(ctx);
  const std::string first = InvOne(ctx, *bal);
  const std::string out = InvAfter(first, 1);
  ctx.GRPC.Fail("GetStock", grpc::StatusCode::UNAVAILABLE, "", 1, out);
  const InvResult r = InvGet(ctx, *bal, "sku-1");
  ctx.Equal(InvTargetsOf(r.made), {out, InvAfter(out, 1)}, "%s answered UNAVAILABLE: the call must go on to %s; calls", out,
            InvAfter(out, 1));
  ctx.Equal(r.count, kInvStock.at("sku-1"), "the failover call must return the count");
  for (int i = 0; i < 10; ++i) {
    ctx.Clock.Advance(2.9);
    const std::string target = InvOne(ctx, *bal);
    ctx.Assert(target != out, "%s was ejected %.1f s ago and was called again: ejection lasts 30 s", out, 2.9 * (i + 1));
  }
  ctx.Clock.Advance(1.5);  // 30.5 s since the ejection
  const auto back = InvMany(ctx, *bal, 3);
  auto sorted = back;
  std::sort(sorted.begin(), sorted.end());
  ctx.Equal(sorted, kInvTargets, "30.5 s after the ejection %s is back: the next 3 calls (%v) must reach each target once", out, back);
}

void CheckAttemptDeadline(harness::Ctx& ctx) {
  auto bal = InvBalancer(ctx);
  const std::string first = InvOne(ctx, *bal);
  const std::string slow = InvAfter(first, 1);
  const std::string next = InvAfter(first, 2);
  ctx.GRPC.SetLatency("GetStock", 1.0, slow);
  const int64_t t0 = ctx.Clock.Now();
  const InvResult r = InvGet(ctx, *bal, "sku-2");
  const double took = static_cast<double>(ctx.Clock.Now() - t0) / 1000;
  ctx.Equal(InvTargetsOf(r.made), {slow, next}, "%s takes 1 s: its attempt must time out and %s serve the same call; calls", slow, next);
  ctx.Equal(r.count, 42, "the call must return the count from %s", next);
  for (const auto& c : r.made) {
    ctx.Assert(c.HasDeadline(), "the attempt to %s carries no deadline: a stalled instance would hold the call forever", c.Target);
    const double timeout = c.TimeoutSeconds();
    ctx.Assert(0.19 <= timeout && timeout <= 0.21, "each attempt carries a 0.2 s deadline, the attempt to %s carried %v s", c.Target, timeout);
  }
  ctx.Equal(r.made[0].Code, grpc::StatusCode::DEADLINE_EXCEEDED, "the attempt to %s must end DEADLINE_EXCEEDED", slow);
  ctx.Assert(took <= 0.25, "the call took %.2f s: one attempt waits at most 0.2 s, not the instance's 1 s", took);
  const auto rest = InvMany(ctx, *bal, 4);
  ctx.Assert(InvCount(rest)[slow] == 0, "%s timed out and must be ejected, yet the next 4 calls reached %v", slow, rest);
  const std::string keeper = InvAfter(slow, 2);  // the one that is neither slow nor the last used
  ctx.GRPC.SetLatency("GetStock", 0.15, keeper);
  const auto more = InvMany(ctx, *bal, 4);
  ctx.Equal(InvCount(more)[keeper], 2, "%s answers in 0.15 s, inside the deadline: it keeps its turn (the next 4 calls reached %v); its calls",
            keeper, more);
}

void CheckApplicationErrors(harness::Ctx& ctx) {
  auto bal = InvBalancer(ctx);
  for (const auto& [sku, code] : std::vector<std::pair<std::string, grpc::StatusCode>>{
           {"ghost", grpc::StatusCode::NOT_FOUND}, {"", grpc::StatusCode::INVALID_ARGUMENT}}) {
    for (int i = 0; i < 3; ++i) {
      const InvResult r = InvFails(ctx, *bal, sku);
      ctx.Equal(r.code, code, "get_stock(%q) failed (%s): an application error is thrown as is", sku, r.error);
      ctx.Equal(r.made.size(), 1, "get_stock(%q) made calls to %v: %v is the same answer from every instance, so no retry; calls", sku,
                InvTargetsOf(r.made), code);
    }
  }
  ctx.GRPC.Fail("GetStock", grpc::StatusCode::PERMISSION_DENIED, "", 1, "");
  const InvResult r = InvFails(ctx, *bal, "sku-1");
  ctx.Assert(r.code == grpc::StatusCode::PERMISSION_DENIED && r.made.size() == 1,
             "an injected PERMISSION_DENIED must surface after one call, got %v after %v", r.code, InvTargetsOf(r.made));
  const auto seq = InvMany(ctx, *bal, 6);
  auto c = InvCount(seq);
  bool in_rotation = true;
  for (size_t i = 3; i < seq.size(); ++i) in_rotation = in_rotation && seq[i] == seq[i - 3];
  for (const auto& t : kInvTargets) in_rotation = in_rotation && c[t] == 2;
  ctx.Assert(in_rotation, "application errors eject nothing: the next 6 calls must reach every target twice, in rotation, they reached %v", seq);
}

void CheckAllEjected(harness::Ctx& ctx) {
  auto bal = InvBalancer(ctx);
  for (const auto& t : kInvTargets) ctx.GRPC.Stop(t);
  InvResult r = InvFails(ctx, *bal, "sku-1");
  auto targets = InvTargetsOf(r.made);
  std::sort(targets.begin(), targets.end());
  ctx.Equal(targets, kInvTargets, "with all three down, one call tries each target exactly once (it called %v)", InvTargetsOf(r.made));
  ctx.Equal(r.code, grpc::StatusCode::UNAVAILABLE, "with nothing left to try the call throws UNAVAILABLE");
  const int64_t t0 = ctx.Clock.Now();
  for (int i = 0; i < 5; ++i) {
    r = InvFails(ctx, *bal, "sku-1");
    ctx.Equal(r.code, grpc::StatusCode::UNAVAILABLE, "with every target ejected the call throws UNAVAILABLE");
    ctx.Equal(r.made.size(), 0, "every target is ejected, yet the call reached %v (fail fast, no RPC): calls", InvTargetsOf(r.made));
  }
  ctx.Assert(ctx.Clock.Now() - t0 <= 50, "failing fast spends no time; the 5 calls took %v s", static_cast<double>(ctx.Clock.Now() - t0) / 1000);
  ctx.Clock.Advance(10);
  r = InvFails(ctx, *bal, "sku-1");
  ctx.Assert(r.code == grpc::StatusCode::UNAVAILABLE && r.made.empty(),
             "10 s later every target is still ejected: UNAVAILABLE with no RPC, got %v after %v", r.code, InvTargetsOf(r.made));
  InvServe(ctx);  // the instances come back
  ctx.Clock.Advance(20.5);
  InvOne(ctx, *bal);
}
`,
  },
  debrief: `The balancer is three pieces of state (a cursor, a map of ejection deadlines, one stub per target) and one rule about status codes. The cursor moves before the attempt, so the next call starts after the target just used whether that attempt succeeded or not, and the loop runs at most once per target, which bounds the worst call at three attempts of 0.2 s each instead of a retry loop that never ends. Ejection is keyed on what the failure says about the instance: \`UNAVAILABLE\` (connection refused, no route) and \`DEADLINE_EXCEEDED\` (it did not answer in time) mean the instance is the problem and another one may do better; \`NOT_FOUND\` or \`INVALID_ARGUMENT\` mean the instance answered correctly about a bad request, every other instance would give the same answer, and ejecting on them would let a single client sending unknown SKUs drain the pool. When nothing is left, failing at once with \`UNAVAILABLE\` is the point: the caller learns the truth in microseconds instead of three timeouts later, and the instances get no load while they recover. This is the shape of gRPC's own \`round_robin\` policy plus the outlier detection Envoy and gRPC's \`outlier_detection\` balancer add on top. Production versions eject after N consecutive failures or on a success-rate statistic rather than one error, grow the ejection time with each repeat, cap the share of the pool that may be ejected at once (Envoy's \`max_ejection_percent\`, 10% by default), and learn about instances from DNS or xDS rather than a fixed list.`,
};
