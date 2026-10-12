import type {Step} from '@/lib/types';

export const keyServiceStep: Step = {
  id: 'key-service',
  title: 'Key generation: blocks of counters over gRPC',
  concept: 'grpc',
  file: 'key_client',
  focus: ['api', 'keys'],
  task: `## Task

Short codes are base62 counters. A central **key service** owns the counter and hands out blocks of
it, so every API replica can mint codes locally without coordination:

\`\`\`proto
service KeyService {
  rpc ReserveBlock(ReserveRequest) returns (ReserveReply);
}
message ReserveRequest { uint32 size = 1; }
message ReserveReply   { uint64 start = 1; uint32 size = 2; }
\`\`\`

Implement \`reserve_block()\` and \`next_code()\` on top of the generated stub. \`base62(n)\` and the
lock are provided.

- Keep a local block as **(start, remaining)**. \`next_code()\` returns \`base62(start)\` and advances:
  \`start + 1\`, \`remaining - 1\`.
- When \`remaining\` is **0**, refill by calling \`ReserveBlock(size = BLOCK_SIZE)\` with a **500 ms**
  deadline. Retry **once** on \`UNAVAILABLE\`; any other status propagates.
- The block is shared by every request thread: take the provided lock around the check-refill-advance
  sequence, or two requests will hand out the same code.

:::widget grpc-streams {"mode": "unary"}

:::widget deadline-retry {"base": 100, "deadline": 500, "attempts": 2}`,
  sequence: {
    participants: ['sho.rt', 'Key service'],
    messages: [
      {from: 'sho.rt', to: 'sho.rt', label: 'next_code(): remaining == 0', kind: 'sync'},
      {from: 'sho.rt', to: 'Key service', label: 'ReserveBlock(size 1000) · deadline 500 ms', kind: 'sync'},
      {from: 'Key service', to: 'sho.rt', label: 'ReserveReply{start 3 842 000, size 1000}', kind: 'reply'},
      {from: 'sho.rt', to: 'sho.rt', label: 'base62(3842000) → "g9Xc" · start++ · remaining--', kind: 'sync'},
      {from: 'sho.rt', to: 'sho.rt', label: 'next_code() ×999 without an RPC', kind: 'sync'},
    ],
  },
  hints: [
    'The deadline is set on the call itself (a timeout argument, a context with timeout, or a stub option), not with a sleep around it; a loop of at most two attempts with the status check inside keeps the retry bounded.',
    'Refill *inside* the lock, only when `remaining == 0`: the lock makes check, refill and advance one atomic step, so two threads can never both see an empty block and both reserve.',
    'Hand out `base62(start)` and only then increment `start` and decrement `remaining`; the counter the key service gave you is the first code of the block.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Sets a 500 ms deadline on ReserveBlock',
      detail: 'Every RPC carries a deadline so a slow key service cannot stall every shorten request behind it.',
      match: {
        python: {all: [/stub\.ReserveBlock\([^\n]*timeout\s*=/]},
        go: {all: [/context\.WithTimeout\(/, /stub\.ReserveBlock\(/]},
        scala: {all: [/withDeadlineAfter\(/, /\.reserveBlock\(/]},
        cpp: {all: [/set_deadline\(/, /stub->ReserveBlock\(/]},
      },
    },
    {
      id: 'retry-unavailable',
      title: 'Retries UNAVAILABLE once, nothing else, never forever',
      detail:
        'Only `UNAVAILABLE` is worth a second attempt; the loop is bounded to two attempts so a key service that is down cannot pin every request thread.',
      match: {
        python: {
          all: [/StatusCode\.UNAVAILABLE/, /for \w+ in range\(\s*2\s*\)/],
          none: [/def reserve_block(?:(?!\ndef )[\s\S])*?while True/],
        },
        go: {
          all: [/codes\.Unavailable/, /for \w+ := 0; \w+ < 2; \w+\+\+/],
          none: [/func reserveBlock(?:(?!\n\})[\s\S])*?for \{/],
        },
        scala: {
          all: [/Code\.UNAVAILABLE/, /\w+ <- 0 until 2|\w+ < 2|\w+ <= 1/],
          none: [/def reserveBlock(?:(?!\n {2}def )[\s\S])*?while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [/StatusCode::UNAVAILABLE/, /for \(int \w+ = 0; \w+ < 2; (\+\+\w+|\w+\+\+)\)/],
          none: [/reserve_block\(\) \{(?:(?!\n\})[\s\S])*?(while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\))/],
        },
      },
    },
    {
      id: 'refill-when-empty',
      title: 'Refills only when the block is empty',
      detail:
        'A new block is reserved when `remaining` reaches 0 — not on every call, and not before the current block is used up.',
      match: {
        python: {all: [/block_remaining\s*(==|<=)\s*0|not block_remaining/, /=\s*reserve_block\(\)/]},
        go: {all: [/remaining\s*(==|<=)\s*0/, /=\s*reserveBlock\(/]},
        scala: {all: [/remaining\s*(==|<=)\s*0/, /=\s*reserveBlock\(\)/]},
        cpp: {all: [/remaining\s*(==|<=)\s*0|!remaining/, /=\s*reserve_block\(\)/]},
      },
    },
    {
      id: 'base62-advance',
      title: 'Hands out base62(start) and advances the block',
      detail:
        'The code is the base62 encoding of the block counter; each call moves `start` up by one and `remaining` down by one.',
      match: {
        python: {all: [/(?<!def )base62\(\s*block_start\s*\)/, /block_start\s*\+=\s*1/, /block_remaining\s*-=\s*1/]},
        go: {all: [/(?<!func )base62\(\s*start\s*\)/, /start\+\+|start\s*\+=\s*1/, /remaining--|remaining\s*-=\s*1/]},
        scala: {all: [/(?<!def )base62\(\s*start\s*\)/, /start\s*\+=\s*1/, /remaining\s*-=\s*1/]},
        cpp: {
          all: [
            /(?<!string )base62\(\s*start\s*\)/,
            /start\+\+|\+\+start|start\s*\+=\s*1/,
            /remaining--|--remaining|remaining\s*-=\s*1/,
          ],
        },
      },
    },
    {
      id: 'locked',
      title: 'Serialises next_code with the provided lock',
      detail:
        'Check, refill and advance happen under the lock; without it two threads can hand out the same code or both reserve a block.',
      match: {
        python: {all: [/with lock:/]},
        go: {all: [/mu\.Lock\(\)/, /mu\.Unlock\(\)/]},
        scala: {all: [/lock\.synchronized\s*\{|synchronized\s*\{/]},
        cpp: {all: [/std::(lock_guard|scoped_lock|unique_lock)[^\n]*\bmu\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import threading

import grpc

import keys_pb2
import keys_pb2_grpc

BLOCK_SIZE = 1000
DEADLINE_S = 0.5
ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

channel = grpc.insecure_channel("keys:9000")
stub = keys_pb2_grpc.KeyServiceStub(channel)

lock = threading.Lock()
block_start = 0
block_remaining = 0


def base62(n: int) -> str:
    """Encodes a counter as a short code (provided)."""
    out = ""
    while True:
        n, rem = divmod(n, 62)
        out = ALPHABET[rem] + out
        if n == 0:
            return out


def reserve_block() -> tuple[int, int]:
    request = keys_pb2.ReserveRequest(size=BLOCK_SIZE)
    # TODO: stub.ReserveBlock with a deadline of DEADLINE_S → (reply.start, reply.size)
    # TODO: UNAVAILABLE → retry once; anything else → raise
    raise NotImplementedError


def next_code() -> str:
    global block_start, block_remaining
    # TODO: under lock: refill from reserve_block() when block_remaining == 0
    # TODO: hand out base62(block_start), then advance block_start / block_remaining
    raise NotImplementedError
`,
      solution: `import threading

import grpc

import keys_pb2
import keys_pb2_grpc

BLOCK_SIZE = 1000
DEADLINE_S = 0.5
ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

channel = grpc.insecure_channel("keys:9000")
stub = keys_pb2_grpc.KeyServiceStub(channel)

lock = threading.Lock()
block_start = 0
block_remaining = 0


def base62(n: int) -> str:
    """Encodes a counter as a short code (provided)."""
    out = ""
    while True:
        n, rem = divmod(n, 62)
        out = ALPHABET[rem] + out
        if n == 0:
            return out


def reserve_block() -> tuple[int, int]:
    request = keys_pb2.ReserveRequest(size=BLOCK_SIZE)
    for attempt in range(2):
        try:
            reply = stub.ReserveBlock(request, timeout=DEADLINE_S)
            return reply.start, reply.size
        except grpc.RpcError as e:
            if e.code() == grpc.StatusCode.UNAVAILABLE and attempt == 0:
                continue
            raise
    raise RuntimeError("key service unavailable")


def next_code() -> str:
    global block_start, block_remaining
    with lock:
        if block_remaining == 0:
            block_start, block_remaining = reserve_block()
        code = base62(block_start)
        block_start += 1
        block_remaining -= 1
        return code
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "shortener/gen/keys"
)

const (
	blockSize = 1000
	deadline  = 500 * time.Millisecond
	alphabet  = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
)

var conn, _ = grpc.NewClient("keys:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewKeyServiceClient(conn)

var (
	mu        sync.Mutex
	start     uint64
	remaining uint32
)

// base62 encodes a counter as a short code (provided).
func base62(n uint64) string {
	var buf []byte
	for {
		buf = append([]byte{alphabet[n%62]}, buf...)
		if n /= 62; n == 0 {
			return string(buf)
		}
	}
}

func reserveBlock(ctx context.Context) (uint64, uint32, error) {
	req := &pb.ReserveRequest{Size: blockSize}
	// TODO: stub.ReserveBlock with a context that expires after \`deadline\` → reply.Start, reply.Size
	// TODO: codes.Unavailable → retry once; anything else → return the error
	_ = req
	_ = codes.OK
	_ = status.Code
	return 0, 0, errors.New("not implemented")
}

func nextCode(ctx context.Context) (string, error) {
	// TODO: under mu: refill from reserveBlock when remaining == 0
	// TODO: hand out base62(start), then advance start / remaining
	return "", errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "shortener/gen/keys"
)

const (
	blockSize = 1000
	deadline  = 500 * time.Millisecond
	alphabet  = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
)

var conn, _ = grpc.NewClient("keys:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewKeyServiceClient(conn)

var (
	mu        sync.Mutex
	start     uint64
	remaining uint32
)

// base62 encodes a counter as a short code (provided).
func base62(n uint64) string {
	var buf []byte
	for {
		buf = append([]byte{alphabet[n%62]}, buf...)
		if n /= 62; n == 0 {
			return string(buf)
		}
	}
}

func reserveBlock(ctx context.Context) (uint64, uint32, error) {
	req := &pb.ReserveRequest{Size: blockSize}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.ReserveBlock(callCtx, req)
		cancel()
		if err == nil {
			return reply.GetStart(), reply.GetSize(), nil
		}
		if status.Code(err) != codes.Unavailable {
			return 0, 0, err
		}
		lastErr = err
	}
	return 0, 0, lastErr
}

func nextCode(ctx context.Context) (string, error) {
	mu.Lock()
	defer mu.Unlock()
	if remaining == 0 {
		var err error
		if start, remaining, err = reserveBlock(ctx); err != nil {
			return "", err
		}
	}
	code := base62(start)
	start++
	remaining--
	return code, nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import shortener.keys.{KeyServiceGrpc, ReserveRequest}

object KeyClient {
  val BlockSize = 1000
  val DeadlineMillis = 500L
  val Alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

  private val channel = ManagedChannelBuilder.forAddress("keys", 9000).usePlaintext().build()
  private val stub = KeyServiceGrpc.blockingStub(channel)

  private val lock = new Object
  private var start = 0L
  private var remaining = 0

  /** Encodes a counter as a short code (provided). */
  def base62(n: Long): String = {
    val sb = new StringBuilder
    var v = n
    while (v > 0 || sb.isEmpty) {
      sb.insert(0, Alphabet((v % 62).toInt))
      v /= 62
    }
    sb.toString
  }

  def reserveBlock(): (Long, Int) = {
    val request = ReserveRequest(size = BlockSize)
    // TODO: call reserveBlock with a deadline of DeadlineMillis → (reply.start, reply.size)
    // TODO: UNAVAILABLE → retry once; anything else → rethrow
    ???
  }

  def nextCode(): String = {
    // TODO: under lock.synchronized: refill from reserveBlock() when remaining == 0
    // TODO: hand out base62(start), then advance start / remaining
    ???
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import shortener.keys.{KeyServiceGrpc, ReserveRequest}

object KeyClient {
  val BlockSize = 1000
  val DeadlineMillis = 500L
  val Alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

  private val channel = ManagedChannelBuilder.forAddress("keys", 9000).usePlaintext().build()
  private val stub = KeyServiceGrpc.blockingStub(channel)

  private val lock = new Object
  private var start = 0L
  private var remaining = 0

  /** Encodes a counter as a short code (provided). */
  def base62(n: Long): String = {
    val sb = new StringBuilder
    var v = n
    while (v > 0 || sb.isEmpty) {
      sb.insert(0, Alphabet((v % 62).toInt))
      v /= 62
    }
    sb.toString
  }

  def reserveBlock(): (Long, Int) = {
    val request = ReserveRequest(size = BlockSize)
    var attempt = 0
    while (attempt < 2) {
      try {
        val reply = stub.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).reserveBlock(request)
        return (reply.start, reply.size)
      } catch {
        case e: StatusRuntimeException =>
          if (e.getStatus.getCode != Status.Code.UNAVAILABLE || attempt == 1) throw e
          attempt += 1
      }
    }
    throw new IllegalStateException("key service unavailable")
  }

  def nextCode(): String = lock.synchronized {
    if (remaining == 0) {
      val (s, n) = reserveBlock()
      start = s
      remaining = n
    }
    val code = base62(start)
    start += 1
    remaining -= 1
    code
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstdint>
#include <mutex>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>

#include "keys.grpc.pb.h"

constexpr uint32_t kBlockSize = 1000;
constexpr std::chrono::milliseconds kDeadline{500};
const std::string kAlphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

auto channel = grpc::CreateChannel("keys:9000", grpc::InsecureChannelCredentials());
auto stub = shortener::KeyService::NewStub(channel);

std::mutex mu;
uint64_t start = 0;
uint32_t remaining = 0;

// Encodes a counter as a short code (provided).
std::string base62(uint64_t n) {
  std::string out;
  do {
    out.insert(out.begin(), kAlphabet[n % 62]);
    n /= 62;
  } while (n > 0);
  return out;
}

std::pair<uint64_t, uint32_t> reserve_block() {
  shortener::ReserveRequest request;
  request.set_size(kBlockSize);
  // TODO: call stub->ReserveBlock with a ClientContext whose deadline is now + kDeadline → {start, size}
  // TODO: UNAVAILABLE → retry once; anything else → throw
  return {0, 0};
}

std::string next_code() {
  // TODO: under a lock on mu: refill from reserve_block() when remaining == 0
  // TODO: hand out base62(start), then advance start / remaining
  return "";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstdint>
#include <mutex>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>

#include "keys.grpc.pb.h"

constexpr uint32_t kBlockSize = 1000;
constexpr std::chrono::milliseconds kDeadline{500};
const std::string kAlphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

auto channel = grpc::CreateChannel("keys:9000", grpc::InsecureChannelCredentials());
auto stub = shortener::KeyService::NewStub(channel);

std::mutex mu;
uint64_t start = 0;
uint32_t remaining = 0;

// Encodes a counter as a short code (provided).
std::string base62(uint64_t n) {
  std::string out;
  do {
    out.insert(out.begin(), kAlphabet[n % 62]);
    n /= 62;
  } while (n > 0);
  return out;
}

std::pair<uint64_t, uint32_t> reserve_block() {
  shortener::ReserveRequest request;
  request.set_size(kBlockSize);
  for (int attempt = 0; attempt < 2; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    shortener::ReserveReply reply;
    const grpc::Status status = stub->ReserveBlock(&ctx, request, &reply);
    if (status.ok()) return {reply.start(), reply.size()};
    if (status.error_code() == grpc::StatusCode::UNAVAILABLE && attempt == 0) continue;
    throw std::runtime_error("key service: " + status.error_message());
  }
  throw std::runtime_error("key service unavailable");
}

std::string next_code() {
  std::lock_guard<std::mutex> guard(mu);
  if (remaining == 0) std::tie(start, remaining) = reserve_block();
  const std::string code = base62(start);
  ++start;
  --remaining;
  return code;
}
`,
    },
  },
  harness: {
    python: `import grpc

import keys_pb2
import keys_pb2_grpc


class FakeKeyService(keys_pb2_grpc.KeyServiceServicer):
    """Hands out blocks of 'block' counters; successive blocks start 1000 apart, so a client that
    keeps minting past the end of a block produces a code the service never issued."""

    def __init__(self, block, first=3842000):
        self.block = block
        self.next = first
        self.sizes = []
        self.lock = None
        self.locked_during_call = []

    def ReserveBlock(self, request, context):
        self.sizes.append(request.size)
        if self.lock is not None:
            self.locked_during_call.append(self.lock.locked())
        start = self.next
        self.next += 1000
        return keys_pb2.ReserveReply(start=start, size=min(request.size, self.block))


def _client(ctx, block):
    peer = FakeKeyService(block)
    ctx.grpc.serve(keys_pb2_grpc.add_KeyServiceServicer_to_server, peer)
    m = ctx.load("key_client")
    peer.lock = m.lock
    return m, peer


def _rpcs(ctx):
    return len(ctx.grpc.calls_to("ReserveBlock"))


def check_deadline(ctx):
    m, peer = _client(ctx, block=1)
    assert m.next_code() == m.base62(3842000), "next_code must hand out the first counter of the reserved block"
    call = ctx.grpc.calls_to("ReserveBlock")[-1]
    assert call.timeout is not None, "ReserveBlock carries no deadline: a slow key service would stall every shorten request"
    assert 0.4 <= call.timeout <= 0.6, f"the deadline must be 500 ms, got {call.timeout} s"
    ctx.grpc.set_latency("ReserveBlock", 3.0)
    try:
        m.next_code()
        raise AssertionError("a key service slower than the deadline must surface DEADLINE_EXCEEDED")
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.DEADLINE_EXCEEDED, f"a slow key service raised {e.code()}, expected DEADLINE_EXCEEDED"
    assert _rpcs(ctx) == 2, "DEADLINE_EXCEEDED is not UNAVAILABLE: it must not be retried"


def check_retry_unavailable(ctx):
    m, peer = _client(ctx, block=1)
    ctx.grpc.fail("ReserveBlock", grpc.StatusCode.UNAVAILABLE, "key service restarting", times=1)
    assert m.next_code() == m.base62(3842000), "one UNAVAILABLE must be retried and the second attempt's block used"
    assert _rpcs(ctx) == 2, f"expected exactly one retry after UNAVAILABLE, saw {_rpcs(ctx)} calls"
    ctx.grpc.fail("ReserveBlock", grpc.StatusCode.RESOURCE_EXHAUSTED, "quota", times=1)
    try:
        m.next_code()
        raise AssertionError("RESOURCE_EXHAUSTED must propagate, not be retried or swallowed")
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.RESOURCE_EXHAUSTED, f"expected RESOURCE_EXHAUSTED to propagate, got {e.code()}"
    assert _rpcs(ctx) == 3, "only UNAVAILABLE is worth a second attempt"
    ctx.grpc.fail("ReserveBlock", grpc.StatusCode.UNAVAILABLE, "down", times=50)
    try:
        m.next_code()
        raise AssertionError("a key service that stays UNAVAILABLE must raise, not return a code")
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.UNAVAILABLE, f"expected UNAVAILABLE after the retries, got {e.code()}"
    attempts = _rpcs(ctx) - 3
    assert attempts == 2, f"made {attempts} attempts against a down key service; retries must stop after the second"


def check_refill_when_empty(ctx):
    m, peer = _client(ctx, block=3)
    assert _rpcs(ctx) == 0, "no block is reserved before the first code is needed"
    for i in range(3):
        m.next_code()
        assert _rpcs(ctx) == 1, f"code {i + 1} of a block of 3 reserved another block: refill only when remaining is 0"
    m.next_code()
    assert _rpcs(ctx) == 2, "the 4th code needs a new block: expected a second ReserveBlock"
    m.next_code()
    m.next_code()
    assert _rpcs(ctx) == 2, "codes 5 and 6 come from the second block without an RPC"
    m.next_code()
    assert _rpcs(ctx) == 3, "the 7th code needs a third block"
    assert peer.sizes == [m.BLOCK_SIZE] * 3, f"ReserveBlock must ask for BLOCK_SIZE ({m.BLOCK_SIZE}) counters, asked for {peer.sizes}"


def check_base62_advance(ctx):
    m, peer = _client(ctx, block=3)
    codes = [m.next_code() for _ in range(5)]
    expected = [m.base62(n) for n in (3842000, 3842001, 3842002, 3843000, 3843001)]
    assert codes == expected, f"handed out {codes}, expected base62 of 3842000, 3842001, 3842002 then the next block 3843000, 3843001"
    assert len(set(codes)) == 5, f"codes must be unique, got {codes}"


def check_locked(ctx):
    m, peer = _client(ctx, block=2)
    m.next_code()
    assert peer.locked_during_call == [True], "the refill must happen under the lock: another thread could reserve a second block meanwhile"
    assert not m.lock.locked(), "the lock must be released once the code is handed out"
    m.next_code()
    m.next_code()
    assert peer.locked_during_call == [True, True], "every refill, not only the first, happens under the lock"
    ctx.grpc.fail("ReserveBlock", grpc.StatusCode.UNAVAILABLE, "down", times=50)
    m.next_code()
    try:
        m.next_code()
    except grpc.RpcError:
        pass
    assert not m.lock.locked(), "a failed refill must release the lock, or every later request deadlocks"
`,
  },
  debrief: `Reserving a block turns a coordination problem into a local one: one RPC per thousand codes, and a key service outage only matters when the block runs dry. The codes are sequential, which is fine for a shortener (and is what a database sequence would give you) — a counter is unguessable only if you need it to be, and then you add a random prefix or encrypt it. Real key services pre-fetch the next block before the current one is empty, so the refill never sits on a request path, and survive their own restarts by persisting the high-water mark.`,
};
