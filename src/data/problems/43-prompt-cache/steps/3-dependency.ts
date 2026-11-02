import type {Step} from '@/lib/types';

export const cacheDependencyStep: Step = {
  id: 'dependency',
  title: 'Miss path with a deadline and a cacheable-result rule',
  concept: 'grpc',
  file: 'client',
  focus: ['cache', 'model'],
  task: `## Task

**Starting point.** The starter is the miss path: \`complete_and_cache\` calls the model over gRPC
in a three-attempt loop, retries a \`content_filter\` reply, and stores whatever comes back,
including the error branch. It serves the demo and hides five flaws.

**Failure mode the checks target.** The starter caches *a response* where it must cache *the
completion the request asked for*. A sampled response, a truncated one, an error string and a refusal
are all "a response", and all are permanently wrong under a key whose contract is "this exact prefix
at this exact version".

- **Every call carries a 3-second deadline**, so "the provider is slow" is a bounded failure rather
  than a held request thread.
- **Only a deterministic completion is cacheable**: \`temperature == 0\` **and**
  \`finish_reason == "stop"\`. Caching one sample hands it to every later caller for the version's
  lifetime.
- **A transport error is returned uncached.** On \`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\` or anything
  else, return nothing to store; \`"upstream error"\` in the entry makes one blip everyone's answer
  for six hours.
- **A content-policy refusal is terminal.** Answer \`{"status": "refused"}\`, store nothing, do not
  retry an answer policy already declined.
- **A cached answer goes through \`fill_if_absent\`** from the state step, not a direct \`SET\`.`,
  sequence: {
    participants: ['Prompt Cache', 'Model server', 'Redis'],
    messages: [
      {from: 'Prompt Cache', to: 'Redis', label: 'GET pc:{tenant}:{version}:{digest} → nil', kind: 'sync'},
      {
        from: 'Prompt Cache',
        to: 'Model server',
        label: 'Complete(prefix, version, temperature) · deadline 3 s',
        kind: 'sync',
      },
      {
        from: 'Model server',
        to: 'Prompt Cache',
        label: 'reply{completion, finish_reason} | UNAVAILABLE',
        kind: 'reply',
      },
      {
        from: 'Prompt Cache',
        to: 'Prompt Cache',
        label: 'cacheable = temperature == 0 and finish_reason == "stop"',
        kind: 'sync',
      },
      {
        from: 'Prompt Cache',
        to: 'Redis',
        label: 'fill_if_absent(key, payload) — only for a cacheable answer',
        kind: 'async',
      },
      {from: 'Prompt Cache', to: 'Redis', label: 'an error and a refusal write nothing', kind: 'async'},
    ],
  },
  hints: [
    'After one provider blip, every caller of a popular prompt gets "upstream error" for six hours; a request with temperature 0.9 freezes one random sample as everyone\'s answer; a refused prompt costs three provider calls.',
    'The loop calls `stub.Complete` with no deadline, `continue`s on `content_filter`, and reaches `fill_if_absent` from both the success path and the `except` branch, with no look at `temperature` or `finish_reason`.',
    'Make one call with `timeout=3.0`; return `None` from the error branch; answer `content_filter` as `refused` without storing; store only when `temperature == 0 and finish_reason == "stop"`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'The model call carries a 3-second deadline',
      detail:
        'The RPC is bounded to three seconds per call (`timeout=3.0`, a `deadline` of `Date.now() + 3000`, `WithTimeout(ctx, 3*time.Second)`, `withDeadlineAfter(3, SECONDS)`, `set_deadline(now + 3s)`). The starter calls the model without any bound, so a slow provider holds the request open.',
      match: {
        python: {all: [/timeout=3\.0/, /\.Complete\(/]},
        typescript: {all: [/Date\.now\(\) \+ 3000/, /\.Complete\(/]},
        go: {all: [/context\.WithTimeout\(ctx, 3\*time\.Second\)/, /\.Complete\(/]},
        scala: {all: [/withDeadlineAfter\(DeadlineSeconds, SECONDS\)/, /\.complete\(/]},
        cpp: {
          all: [/set_deadline\(std::chrono::system_clock::now\(\) \+ std::chrono::seconds\(3\)\)/, /->Complete\(/],
        },
      },
    },
    {
      id: 'temperature-gate',
      title: 'Only temperature 0 is cacheable',
      detail:
        'The cacheability rule tests `temperature == 0`, so a sampled answer is returned to its own caller and stored for nobody. The starter stores every reply, so the first caller’s sample becomes the answer for the whole prompt version.',
      match: {
        python: {all: [/temperature == 0/]},
        typescript: {all: [/temperature === 0/]},
        go: {all: [/temperature == 0/]},
        scala: {all: [/temperature == 0/]},
        cpp: {all: [/temperature == 0/]},
      },
    },
    {
      id: 'stop-only',
      title: 'Only a normally finished reply is stored',
      detail:
        'The reply must finish with `finish_reason == "stop"` before it is cached — a truncated answer is a property of that call, not of the prefix. The starter checks nothing about how the reply ended.',
      match: {
        python: {all: [/finish_reason == "stop"/]},
        typescript: {all: [/finish_reason === 'stop'/]},
        go: {all: [/FinishReason == "stop"/]},
        scala: {all: [/finishReason == "stop"/]},
        cpp: {all: [/finish_reason\(\) == "stop"/]},
      },
    },
    {
      id: 'no-cache-on-error',
      title: 'A transport error returns nothing and writes nothing',
      detail:
        'The error branch answers "no result" — `return None`, `null`, `nil`, `std::nullopt` — and never reaches the fill. The starter stores an error string, so a transient failure is served to every caller for the version’s lifetime.',
      match: {
        python: {all: [/except grpc\.RpcError as error/, /return None/]},
        typescript: {all: [/catch \(error\)/, /return null/]},
        go: {all: [/if err != nil/, /return nil, nil/]},
        scala: {all: [/case error: StatusRuntimeException/, /\bNone\b/]},
        cpp: {all: [/!status\.ok\(\)/, /return std::nullopt/]},
      },
    },
    {
      id: 'refusal-terminal',
      title: 'A content-policy refusal is terminal and uncached',
      detail:
        'A `content_filter` reply is answered as `refused` and never stored, and there is no retry loop around the call. The starter retries the refusal up to three times and then caches the reply anyway, spending a provider call per attempt on an answer policy already declined.',
      match: {
        python: {all: [/"refused"/, /"content_filter"/], none: [/for attempt/, /max_attempts/]},
        typescript: {all: [/'refused'/, /'content_filter'/], none: [/for \(let attempt/, /maxAttempts/]},
        go: {all: [/"refused"/, /"content_filter"/], none: [/for attempt/, /maxAttempts/]},
        scala: {all: [/"refused"/, /"content_filter"/], none: [/for \(attempt/, /maxAttempts/]},
        cpp: {all: [/"refused"/, /"content_filter"/], none: [/for \(int attempt/, /kMaxAttempts/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc
import logging

log = logging.getLogger("prompt-cache")


async def complete_and_cache(stub, key: str, tenant: str, version: int, prefix: str, temperature: float) -> dict:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    for attempt in range(3):
        try:
            request = CompletionRequest(prefix=prefix, version=version, temperature=temperature)
            reply = await stub.Complete(request)
        except grpc.RpcError:
            await fill_if_absent(key, tenant, version, "upstream error")
            return {"status": "stored", "completion": "upstream error"}
        if reply.finish_reason == "content_filter":
            continue
        await fill_if_absent(key, tenant, version, reply.completion)
        return {"status": "stored", "completion": reply.completion}
    return {"status": "stored", "completion": reply.completion}
`,
      solution: `import grpc
import logging

log = logging.getLogger("prompt-cache")


async def complete_or_none(
    stub, key: str, tenant: str, version: int, prefix: str, temperature: float
) -> dict | None:
    """A miss calls the model once, under a deadline; only a deterministic answer is cacheable."""
    request = CompletionRequest(prefix=prefix, version=version, temperature=temperature)
    try:
        reply = await stub.Complete(request, timeout=3.0)
    except grpc.RpcError as error:
        log.warning("model call failed key=%s code=%s", key, error.code())
        return None  # a failed call is never a cacheable result
    if reply.finish_reason == "content_filter":
        # Policy, not a transient condition: answer it and store nothing.
        return {"status": "refused", "completion": None}
    cacheable = temperature == 0 and reply.finish_reason == "stop"
    if not cacheable:
        return {"status": "uncached", "completion": reply.completion}
    stored = await fill_if_absent(key, tenant, version, reply.completion)
    return {"status": "stored", "completion": stored}
`,
    },
    typescript: {
      starter: `/** A miss path that retries refusals and caches every reply. */
export async function completeAndCache(
  client: CompletionClient,
  key: string,
  tenant: string,
  version: number,
  prefix: string,
  temperature: number,
): Promise<{status: string; completion: string | null}> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const reply = await client.Complete({prefix, version, temperature});
      if (reply.finish_reason === 'content_filter') continue;
      await fillIfAbsent(key, tenant, version, reply.completion);
      return {status: 'stored', completion: reply.completion};
    } catch (error) {
      await fillIfAbsent(key, tenant, version, 'upstream error');
      return {status: 'stored', completion: 'upstream error'};
    }
  }
  return {status: 'stored', completion: null};
}
`,
      solution: `/** The miss path: one bounded model call, and only a deterministic answer becomes cacheable. */
export async function completeOrNull(
  client: CompletionClient,
  key: string,
  tenant: string,
  version: number,
  prefix: string,
  temperature: number,
): Promise<{status: string; completion: string | null} | null> {
  const deadline = Date.now() + 3000;
  try {
    const reply = await client.Complete({prefix, version, temperature}, {deadline});
    if (reply.finish_reason === 'content_filter') {
      // Policy, not a transient condition: answer it and store nothing.
      return {status: 'refused', completion: null};
    }
    const cacheable = temperature === 0 && reply.finish_reason === 'stop';
    if (!cacheable) return {status: 'uncached', completion: reply.completion};
    const stored = await fillIfAbsent(key, tenant, version, reply.completion);
    return {status: 'stored', completion: stored};
  } catch (error) {
    console.warn(\`model call failed key=\${key} reason=\${error instanceof Error ? error.message : 'unavailable'}\`);
    return null; // a failed call is never a cacheable result
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"

	"google.golang.org/grpc"
	"google.golang.org/grpc/status"
)

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
func completeAndCache(ctx context.Context, stub CompletionClient, key, tenant string, version int, prefix string, temperature float64) (*Result, error) {
	for attempt := 0; attempt < 3; attempt++ {
		reply, err := stub.Complete(ctx, &CompletionRequest{Prefix: prefix, Version: int32(version), Temperature: temperature})
		if err != nil {
			log.Printf("model call failed code=%s", status.Code(err))
			if _, writeErr := fillIfAbsent(ctx, key, tenant, version, "upstream error"); writeErr != nil {
				return nil, writeErr
			}
			return &Result{Status: "stored", Completion: "upstream error"}, nil
		}
		if reply.FinishReason == "content_filter" {
			continue
		}
		stored, err := fillIfAbsent(ctx, key, tenant, version, reply.Completion)
		if err != nil {
			return nil, err
		}
		return &Result{Status: "stored", Completion: stored}, nil
	}
	return &Result{Status: "stored"}, nil
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc/status"
)

// completeOrNone calls the model once under a 3-second deadline; only a deterministic answer is cacheable.
func completeOrNone(ctx context.Context, stub CompletionClient, key, tenant string, version int, prefix string, temperature float64) (*Result, error) {
	callCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	reply, err := stub.Complete(callCtx, &CompletionRequest{Prefix: prefix, Version: int32(version), Temperature: temperature})
	if err != nil {
		log.Printf("model call failed key=%s code=%s", key, status.Code(err))
		return nil, nil // a failed call is never a cacheable result
	}
	if reply.FinishReason == "content_filter" {
		// Policy, not a transient condition: answer it and store nothing.
		return &Result{Status: "refused"}, nil
	}
	if temperature == 0 && reply.FinishReason == "stop" {
		stored, err := fillIfAbsent(ctx, key, tenant, version, reply.Completion)
		if err != nil {
			return nil, err
		}
		return &Result{Status: "stored", Completion: stored}, nil
	}
	return &Result{Status: "uncached", Completion: reply.Completion}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.StatusRuntimeException
import scala.concurrent.{ExecutionContext, Future}

object MissPath {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def completeAndCache(stub: CompletionServiceGrpc.CompletionServiceStub, jedis: Jedis, key: String, tenant: String,
                       version: Int, prefix: String, temperature: Double)(implicit ec: ExecutionContext): Future[Result] = {
    val request = CompletionRequest(prefix = prefix, version = version, temperature = temperature)
    stub.complete(request).recoverWith { case _: StatusRuntimeException =>
      CacheStore.fillIfAbsent(jedis, key, tenant, version, "upstream error")
      Future.successful(Result("stored", Some("upstream error")))
    }.map { reply =>
      if (reply.finishReason == "content_filter") Result("stored", Some(reply.completion))
      else Result("stored", Some(CacheStore.fillIfAbsent(jedis, key, tenant, version, reply.completion)))
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit.SECONDS

import io.grpc.StatusRuntimeException
import org.slf4j.LoggerFactory
import scala.concurrent.{ExecutionContext, Future}

object MissPath {
  private val logger = LoggerFactory.getLogger("prompt-cache")
  private val DeadlineSeconds = 3

  /** One bounded model call per miss; only a deterministic answer is cacheable. */
  def completeOrNone(stub: CompletionServiceGrpc.CompletionServiceStub, jedis: Jedis, key: String, tenant: String,
                     version: Int, prefix: String, temperature: Double)(implicit ec: ExecutionContext): Future[Option[Result]] = {
    val request = CompletionRequest(prefix = prefix, version = version, temperature = temperature)
    stub.withDeadlineAfter(DeadlineSeconds, SECONDS).complete(request).map { reply =>
      if (reply.finishReason == "content_filter") {
        // Policy, not a transient condition: answer it and store nothing.
        Some(Result("refused", None))
      } else if (temperature == 0 && reply.finishReason == "stop") {
        Some(Result("stored", Some(CacheStore.fillIfAbsent(jedis, key, tenant, version, reply.completion))))
      } else {
        Some(Result("uncached", Some(reply.completion)))
      }
    }.recover { case error: StatusRuntimeException =>
      logger.warn(s"model call failed key=$key code=\${error.getStatus.getCode}")
      None // a failed call is never a cacheable result
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <iostream>
#include <string>

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
Result complete_and_cache(Completion::StubInterface* stub, sw::redis::Redis& cache, const std::string& key,
                          const std::string& tenant, int version, const std::string& prefix, double temperature) {
  CompletionRequest request;
  request.set_prefix(prefix);
  request.set_version(version);
  request.set_temperature(temperature);
  grpc::ClientContext context;
  CompletionReply reply;
  const grpc::Status status = stub->Complete(&context, request, &reply);
  if (!status.ok()) {
    fill_if_absent(cache, key, tenant, version, "upstream error");
    return {"stored", "upstream error"};
  }
  return {"stored", fill_if_absent(cache, key, tenant, version, reply.completion())};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <optional>
#include <string>

// complete_or_none makes one bounded model call per miss; only a deterministic answer is cacheable.
std::optional<Result> complete_or_none(Completion::StubInterface* stub, sw::redis::Redis& cache, const std::string& key,
                                       const std::string& tenant, int version, const std::string& prefix, double temperature) {
  CompletionRequest request;
  request.set_prefix(prefix);
  request.set_version(version);
  request.set_temperature(temperature);
  grpc::ClientContext context;
  context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(3));
  CompletionReply reply;
  const grpc::Status status = stub->Complete(&context, request, &reply);
  if (!status.ok()) {
    std::cerr << "model call failed key=" << key << " code=" << status.error_code() << std::endl;
    return std::nullopt; // a failed call is never a cacheable result
  }
  if (reply.finish_reason() == "content_filter") {
    // Policy, not a transient condition: answer it and store nothing.
    return Result{"refused", std::nullopt};
  }
  if (temperature == 0 && reply.finish_reason() == "stop") {
    return Result{"stored", fill_if_absent(cache, key, tenant, version, reply.completion())};
  }
  return Result{"uncached", reply.completion()};
}
`,
    },
  },
  debrief: `The fix is one explicit cacheability decision placed between the call and the write. A sampled completion is one instance of a distribution, a truncated completion is one instance of a stream, and an error string is not a completion at all, so none of them may be stored under a key that promises "this exact prefix, at this exact version, has this answer". The deadline belongs to the same discipline: without it a slow provider turns a cache miss into an unbounded wait, and the retry loop makes a deterministic refusal cost three calls instead of one. What a production service adds is a counter per outcome (cacheable, uncached, refused) beside the hit ratio, so on-call can tell a provider problem from a policy problem without reading a single completion.`,
};
