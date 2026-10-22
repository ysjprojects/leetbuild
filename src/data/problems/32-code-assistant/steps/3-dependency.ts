import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Symbol-index calls with a file-only fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['assistant', 'indexer', 'files', 'inference'],
  task: `## Task

The starter is a plausible model-generated draft: while the symbol index is healthy every completion
gets the repository's symbols and the suggestions look repository-aware. Every failure path is wrong.
Find them, fix them, and prove the fix.

Implement \`build_context(tenant, repo, path, file_context)\`, the retrieval the completion path runs
before it builds a prompt.

- Each symbol-index call carries a **300 ms** deadline — \`DEADLINE_S = 0.3\` / \`DEADLINE_MS = 300\`,
  \`withDeadlineAfter\`, \`context.WithTimeout\`, \`set_deadline\`, \`deadline: Date.now() + …\`. Without
  one, one slow index holds a completion open until the editor gives up.
- On a timeout or \`UNAVAILABLE\` the call **degrades to file-only**: return the caller's own
  \`file_context\` with an empty symbol list and \`degraded: true\`, and let the completion happen. A
  completion from the file the developer is looking at beats a failed request every time.
- An index that reports it is **rebuilding** (\`FAILED_PRECONDITION\`) is **not retried**: return the
  file-only context immediately. Retrying a service that just asked for room is how you keep it
  rebuilding.
- Attempts are bounded (\`MAX_ATTEMPTS = 2\`) and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are
  retryable. Every other code — including \`FAILED_PRECONDITION\` — returns the degraded context.
- Every returned symbol is **scoped to the repository the request named**: a symbol whose \`repo\` is
  not the requested one is dropped, so a monorepo subpath can never surface another repository's
  symbols in a completion.
- Never let the index fail the completion: the caller of \`build_context\` has a prompt to build
  either way, and the \`degraded\` flag is what lets a report notice that most of a session was
  served without symbols.

**Failure mode the checks target.** The draft has no deadline, so a sick index pins every request;
it lets an index error propagate, so one slow call fails a completion that had all the context it
needed; it retries an index that announced it was rebuilding, which is the one call the index asked
you not to make; and it returns whatever symbols came back, so a request against one repository can
be completed with symbols from another.`,
  sequence: {
    participants: ['Completion path', 'Symbol index', 'File context'],
    messages: [
      {
        from: 'Completion path',
        to: 'Symbol index',
        label: 'Symbols(tenant, repo, path) · deadline 300 ms',
        kind: 'sync',
      },
      {
        from: 'Symbol index',
        to: 'Completion path',
        label: 'symbols / DEADLINE_EXCEEDED / FAILED_PRECONDITION',
        kind: 'reply',
      },
      {
        from: 'Completion path',
        to: 'Completion path',
        label: 'retry only UNAVAILABLE / DEADLINE_EXCEEDED, never FAILED_PRECONDITION',
        kind: 'sync',
      },
      {from: 'Completion path', to: 'File context', label: 'fileOnly(file_context) · degraded: true', kind: 'sync'},
      {from: 'File context', to: 'Completion path', label: 'the file the developer already sent', kind: 'reply'},
      {
        from: 'Completion path',
        to: 'Completion path',
        label: 'drop symbols whose repo is not the requested repo',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 300 ms deadline',
      detail:
        'The call is made with a 300 ms deadline (`timeout`, `deadline:`, `withDeadlineAfter`, `context.WithTimeout`, `set_deadline`). The draft calls the index with no deadline, so one slow index holds a completion open until the editor abandons it.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.3/, /timeout=DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*300/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadlineMS\s*=\s*300/, /context\.WithTimeout\(/]},
        scala: {all: [/DeadlineMs\s*=\s*300/, /withDeadlineAfter\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*300/, /set_deadline\(/]},
      },
    },
    {
      id: 'file-fallback',
      title: 'Degrades to the caller’s file context',
      detail:
        'The failure path returns the caller’s `file_context` with `degraded: true` instead of failing the request. The draft has no degraded path at all: an index error becomes a failed completion.',
      match: {
        python: {all: [/file_context/, /degraded/]},
        typescript: {all: [/fileContext/, /degraded/]},
        go: {all: [/fileContext/, /degraded/]},
        scala: {all: [/fileContext/, /degraded/]},
        cpp: {all: [/file_context/, /degraded/]},
      },
    },
    {
      id: 'rebuilding',
      title: 'Never retries an index that is rebuilding',
      detail:
        'A `FAILED_PRECONDITION` reply is recognized (`Rebuilding`/`codeRebuilding`/`REBUILDING`) and returns the degraded context on the first attempt, with bounded `MAX_ATTEMPTS`. The draft has no bounded attempts and keeps calling an index that asked for room.',
      match: {
        python: {all: [/REBUILDING/, /MAX_ATTEMPTS/], none: [/while\s+True/]},
        typescript: {all: [/REBUILDING/, /MAX_ATTEMPTS/], none: [/while\s*\(\s*true\s*\)/]},
        go: {all: [/codeRebuilding/, /maxAttempts/], none: [/for\s*\{\s*\n/]},
        scala: {all: [/Rebuilding/, /MaxAttempts/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/kRebuilding/, /kMaxAttempts/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
    {
      id: 'repo-scope',
      title: 'Scopes symbols to the requested repository',
      detail:
        'Symbols are filtered against the repository the request named, so a monorepo subpath cannot surface another repository’s symbols. The draft returns every symbol the index sent.',
      match: {
        python: {all: [/symbol\.repo == repo/]},
        typescript: {all: [/symbol\.repo === repo/]},
        go: {all: [/symbol\.Repo == repo/]},
        scala: {all: [/symbol\.repo == repo/]},
        cpp: {all: [/symbol\.repo\(\) == repo/]},
      },
    },
    {
      id: 'degrade-on-timeout',
      title: 'A deadline breach ends in the file-only context',
      detail:
        '`DEADLINE_EXCEEDED` is handled explicitly and the method returns the degraded context rather than raising. The draft propagates the timeout, so the caller sees a 500 for a completion that had enough context to answer.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /degraded/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /degraded/]},
        go: {all: [/DeadlineExceeded/, /degraded/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /degraded/]},
        cpp: {all: [/DEADLINE_EXCEEDED/, /degraded/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import index_pb2
import index_pb2_grpc

channel = grpc.insecure_channel("indexer:9000")
symbols = index_pb2_grpc.SymbolIndexStub(channel)


def build_context(tenant: str, repo: str, path: str, file_context: str) -> dict:
    # TODO: this draft fails the whole completion when the index times out, keeps calling an index
    # that reported it is rebuilding, and returns symbols from other repositories when a monorepo
    # subpath is requested.
    reply = symbols.Symbols(index_pb2.SymbolsRequest(tenant=tenant, repo=repo, path=path))
    return {
        "repo": repo,
        "path": path,
        "symbols": [{"name": symbol.name, "file": symbol.file, "repo": symbol.repo} for symbol in reply.symbols],
        "file_context": file_context,
    }
`,
      solution: `import grpc

import index_pb2
import index_pb2_grpc

DEADLINE_S = 0.3
MAX_ATTEMPTS = 2
REBUILDING = grpc.StatusCode.FAILED_PRECONDITION
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("indexer:9000")
symbols = index_pb2_grpc.SymbolIndexStub(channel)


def file_only(repo: str, path: str, file_context: str) -> dict:
    """Degraded retrieval: the file the developer already sent, marked so a report can see it."""
    return {"repo": repo, "path": path, "symbols": [], "file_context": file_context, "degraded": True}


def build_context(tenant: str, repo: str, path: str, file_context: str) -> dict:
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = symbols.Symbols(
                index_pb2.SymbolsRequest(tenant=tenant, repo=repo, path=path),
                timeout=DEADLINE_S,
            )
        except grpc.RpcError as exc:
            if exc.code() == REBUILDING:
                # the index asked for room: retrying now would keep it rebuilding
                return file_only(repo, path, file_context)
            if exc.code() not in RETRYABLE:
                return file_only(repo, path, file_context)
            continue
        scoped = [
            {"name": symbol.name, "file": symbol.file, "repo": symbol.repo}
            for symbol in reply.symbols
            if symbol.repo == repo
        ]
        return {"repo": repo, "path": path, "symbols": scoped, "file_context": file_context, "degraded": False}
    return file_only(repo, path, file_context)
`,
    },
    typescript: {
      starter: `/** buildContext: a model-generated draft that fails the completion when the index is slow. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface Symbol {
  name: string;
  file: string;
  repo: string;
}

interface IndexClient {
  Symbols(
    request: {tenant: string; repo: string; path: string},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: {symbols: Symbol[]}) => void,
  ): grpc.ClientUnaryCall;
}

const {index} = grpc.loadPackageDefinition(protoLoader.loadSync('index.proto')) as unknown as {
  index: {SymbolIndex: new (target: string, credentials: grpc.ChannelCredentials) => IndexClient};
};
const client = new index.SymbolIndex('indexer:9000', grpc.credentials.createInsecure());

export async function buildContext(
  tenant: string,
  repo: string,
  path: string,
  fileContext: string,
): Promise<{repo: string; path: string; symbols: Symbol[]; file_context: string}> {
  // TODO: this draft fails the whole completion when the index times out, keeps calling an index
  // that reported it is rebuilding, and returns symbols from other repositories when a monorepo
  // subpath is requested.
  const reply = await new Promise<{symbols: Symbol[]}>((resolve, reject) => {
    client.Symbols({tenant, repo, path}, {}, (error, value) => (error === null ? resolve(value) : reject(error)));
  });
  return {repo, path, symbols: reply.symbols, file_context: fileContext};
}
`,
      solution: `/** buildContext: a 300 ms symbol-index call that degrades to the caller's file context. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 300;
const MAX_ATTEMPTS = 2;
const REBUILDING = grpc.status.FAILED_PRECONDITION;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface Symbol {
  name: string;
  file: string;
  repo: string;
}

interface BuiltContext {
  repo: string;
  path: string;
  symbols: Symbol[];
  file_context: string;
  degraded: boolean;
}

interface IndexClient {
  Symbols(
    request: {tenant: string; repo: string; path: string},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: {symbols: Symbol[]}) => void,
  ): grpc.ClientUnaryCall;
}

const {index} = grpc.loadPackageDefinition(protoLoader.loadSync('index.proto')) as unknown as {
  index: {SymbolIndex: new (target: string, credentials: grpc.ChannelCredentials) => IndexClient};
};
const client = new index.SymbolIndex('indexer:9000', grpc.credentials.createInsecure());

function fileOnly(repo: string, path: string, fileContext: string): BuiltContext {
  return {repo, path, symbols: [], file_context: fileContext, degraded: true};
}

export async function buildContext(
  tenant: string,
  repo: string,
  path: string,
  fileContext: string,
): Promise<BuiltContext> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await new Promise<{symbols: Symbol[]}>((resolve, reject) => {
        client.Symbols(
          {tenant, repo, path},
          {deadline: Date.now() + DEADLINE_MS},
          (error, value) => (error === null ? resolve(value) : reject(error)),
        );
      });
      // the repository boundary holds for monorepo subpaths too
      const scoped = reply.symbols.filter(symbol => symbol.repo === repo);
      return {repo, path, symbols: scoped, file_context: fileContext, degraded: false};
    } catch (error) {
      const code = (error as grpc.ServiceError).code;
      if (code === REBUILDING || RETRYABLE[code] !== true) return fileOnly(repo, path, fileContext);
    }
  }
  return fileOnly(repo, path, fileContext);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
)

var symbolIndex pb.SymbolIndexClient

type Symbol struct {
	Name string \`json:"name"\`
	File string \`json:"file"\`
	Repo string \`json:"repo"\`
}

type BuiltContext struct {
	Repo        string   \`json:"repo"\`
	Path        string   \`json:"path"\`
	Symbols     []Symbol \`json:"symbols"\`
	FileContext string   \`json:"file_context"\`
}

func buildContext(ctx context.Context, tenant, repo, path, fileContext string) (BuiltContext, error) {
	// TODO: this draft fails the whole completion when the index times out, keeps calling an index
	// that reported it is rebuilding, and returns symbols from other repositories when a monorepo
	// subpath is requested.
	reply, err := symbolIndex.Symbols(ctx, &pb.SymbolsRequest{Tenant: tenant, Repo: repo, Path: path})
	if err != nil {
		return BuiltContext{}, err
	}
	return BuiltContext{Repo: repo, Path: path, Symbols: reply.Symbols, FileContext: fileContext}, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	deadlineMS  = 300
	maxAttempts = 2
)

const codeRebuilding = codes.FailedPrecondition

var symbolIndex pb.SymbolIndexClient

type Symbol struct {
	Name string \`json:"name"\`
	File string \`json:"file"\`
	Repo string \`json:"repo"\`
}

type BuiltContext struct {
	Repo        string   \`json:"repo"\`
	Path        string   \`json:"path"\`
	Symbols     []Symbol \`json:"symbols"\`
	FileContext string   \`json:"file_context"\`
	Degraded    bool     \`json:"degraded"\`
}

func retryableCode(code codes.Code) bool {
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

func fileOnly(repo, path, fileContext string) BuiltContext {
	return BuiltContext{Repo: repo, Path: path, Symbols: []Symbol{}, FileContext: fileContext, Degraded: true}
}

func buildContext(ctx context.Context, tenant, repo, path, fileContext string) (BuiltContext, error) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		reply, err := symbolIndex.Symbols(callCtx, &pb.SymbolsRequest{Tenant: tenant, Repo: repo, Path: path})
		cancel()
		if err == nil {
			scoped := make([]Symbol, 0, len(reply.Symbols))
			for _, symbol := range reply.Symbols {
				// the repository boundary holds for monorepo subpaths too
				if symbol.Repo == repo {
					scoped = append(scoped, Symbol{Name: symbol.Name, File: symbol.File, Repo: symbol.Repo})
				}
			}
			return BuiltContext{Repo: repo, Path: path, Symbols: scoped, FileContext: fileContext, Degraded: false}, nil
		}
		// a rebuilding index asked for room: do not retry it
		if status.Code(err) == codeRebuilding || !retryableCode(status.Code(err)) {
			return fileOnly(repo, path, fileContext), nil
		}
	}
	return fileOnly(repo, path, fileContext), nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

final case class Symbol(name: String, file: String, repo: String)
final case class BuiltContext(
    repo: String,
    path: String,
    symbols: List[Symbol],
    fileContext: String
)

object ContextBuilder {
  val symbolIndex = SymbolIndexGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("indexer", 9000).usePlaintext().build()
  )

  def buildContext(tenant: String, repo: String, path: String, fileContext: String): BuiltContext = {
    // TODO: this draft fails the whole completion when the index times out, keeps calling an index
    // that reported it is rebuilding, and returns symbols from other repositories when a monorepo
    // subpath is requested.
    val reply = symbolIndex.symbols(SymbolsRequest(tenant = tenant, repo = repo, path = path))
    BuiltContext(repo, path, reply.symbols, fileContext)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

final case class Symbol(name: String, file: String, repo: String)
final case class BuiltContext(
    repo: String,
    path: String,
    symbols: List[Symbol],
    fileContext: String,
    degraded: Boolean
)

object ContextBuilder {
  val DeadlineMs = 300L
  val MaxAttempts = 2
  val Rebuilding = Status.Code.FAILED_PRECONDITION

  val symbolIndex = SymbolIndexGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("indexer", 9000).usePlaintext().build()
  )

  def retryable(code: Status.Code): Boolean =
    code == Status.Code.UNAVAILABLE || code == Status.Code.DEADLINE_EXCEEDED

  def fileOnly(repo: String, path: String, fileContext: String): BuiltContext =
    BuiltContext(repo, path, List.empty, fileContext, degraded = true)

  def buildContext(tenant: String, repo: String, path: String, fileContext: String): BuiltContext = {
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        val reply = symbolIndex
          .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
          .symbols(SymbolsRequest(tenant = tenant, repo = repo, path = path))
        // the repository boundary holds for monorepo subpaths too
        val scoped = reply.symbols.filter(symbol => symbol.repo == repo)
        return BuiltContext(repo, path, scoped, fileContext, degraded = false)
      } catch {
        case e: StatusRuntimeException =>
          // a rebuilding index asked for room: do not retry it
          if (e.getStatus.getCode == Rebuilding || !retryable(e.getStatus.getCode)) {
            return fileOnly(repo, path, fileContext)
          }
      }
      attempt += 1
    }
    fileOnly(repo, path, fileContext)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "index.grpc.pb.h"

#include <string>
#include <vector>

std::unique_ptr<SymbolIndex::Stub> symbolIndex;

struct Symbol {
  std::string name;
  std::string file;
  std::string repo;
};

struct BuiltContext {
  std::string repo;
  std::string path;
  std::vector<Symbol> symbols;
  std::string file_context;
};

BuiltContext build_context(const std::string& tenant, const std::string& repo, const std::string& path,
                           const std::string& fileContext) {
  // TODO: this draft fails the whole completion when the index times out, keeps calling an index
  // that reported it is rebuilding, and returns symbols from other repositories when a monorepo
  // subpath is requested.
  grpc::ClientContext ctx;
  SymbolsRequest request;
  request.set_tenant(tenant);
  request.set_repo(repo);
  request.set_path(path);
  SymbolsReply reply;
  const grpc::Status status = symbolIndex->Symbols(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error(status.error_message());
  std::vector<Symbol> symbols;
  for (const auto& symbol : reply.symbols()) {
    symbols.push_back(Symbol{symbol.name(), symbol.file(), symbol.repo()});
  }
  return BuiltContext{repo, path, symbols, fileContext};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "index.grpc.pb.h"

#include <chrono>
#include <string>
#include <vector>

constexpr int kDeadlineMs = 300;
constexpr int kMaxAttempts = 2;
constexpr grpc::StatusCode kRebuilding = grpc::StatusCode::FAILED_PRECONDITION;

std::unique_ptr<SymbolIndex::Stub> symbolIndex;

struct Symbol {
  std::string name;
  std::string file;
  std::string repo;
};

struct BuiltContext {
  std::string repo;
  std::string path;
  std::vector<Symbol> symbols;
  std::string file_context;
  bool degraded;
};

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

BuiltContext file_only(const std::string& repo, const std::string& path, const std::string& fileContext) {
  return BuiltContext{repo, path, {}, fileContext, true};
}

BuiltContext build_context(const std::string& tenant, const std::string& repo, const std::string& path,
                           const std::string& fileContext) {
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    SymbolsRequest request;
    request.set_tenant(tenant);
    request.set_repo(repo);
    request.set_path(path);
    SymbolsReply reply;
    const grpc::Status status = symbolIndex->Symbols(&ctx, request, &reply);
    if (status.ok()) {
      std::vector<Symbol> scoped;
      for (const auto& symbol : reply.symbols()) {
        // the repository boundary holds for monorepo subpaths too
        if (symbol.repo() == repo) scoped.push_back(Symbol{symbol.name(), symbol.file(), symbol.repo()});
      }
      return BuiltContext{repo, path, scoped, fileContext, false};
    }
    // a rebuilding index asked for room: do not retry it
    if (status.error_code() == kRebuilding || !retryable(status.error_code())) {
      return file_only(repo, path, fileContext);
    }
  }
  return file_only(repo, path, fileContext);
}
`,
    },
  },
  hints: [
    'The deadline belongs on the call, not around it: `timeout=DEADLINE_S`, `{deadline: Date.now() + DEADLINE_MS}`, a context from `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`. Bounded attempts go with it — a counted loop over `MAX_ATTEMPTS`, never `while True`.',
    'Retryability is a property of the status: `UNAVAILABLE` and `DEADLINE_EXCEEDED` are worth one more attempt because the index may have moved; `FAILED_PRECONDITION` means it is rebuilding and an immediate retry is the last thing it needs. Every other code ends in the degraded context on the first attempt.',
    'The degraded context is the caller’s own `file_context` plus `degraded: true` and an empty symbol list, so the completion still happens and the report can see how often it did. And filter the reply by `repo`: a monorepo subpath is still one repository, and another repository’s symbols are a correctness bug, not a nicety.',
  ],
  debrief: `The interview question is the failure policy of a dependency you do not own, judged by what the caller of this function experiences. The draft is fine while the index is healthy and wrong in three independent ways: no deadline (one slow index stalls every completion), no fallback (an index outage becomes a completion outage, even though the caller already sent the file), and no retry policy (a rebuilding index gets hammered exactly when it asked for room). The fourth defect is the quiet correctness one — returning symbols from the wrong repository — which no amount of retry logic fixes and which a demo with one repository never exposes. Real assistants add a hedge against the long tail (a second attempt after 100 ms rather than a full deadline), cache the index reply per commit next to the summary, and record a per-session fallback rate so a degrading index shows up as a trend instead of an incident.`,
};
