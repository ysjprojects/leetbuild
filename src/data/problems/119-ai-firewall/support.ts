/**
 * The support module the AI firewall's steps import but no step builds: `aifw/upstream`, the one
 * call into the LLM application the firewall fronts. In this course the application is a gRPC
 * service (`Assistant.Chat`, firewall.proto) the harness serves at llm-app:9001; `forward` makes
 * that call with the request id, so the application's logs can be joined with the firewall's.
 */
import {CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

/** Python: `from aifw.upstream import forward`. */
export const supportModules: Record<string, string> = {
  'aifw/__init__.py': '',
  'aifw/upstream.py': `"""The LLM application the firewall fronts (provided): one gRPC call, Assistant.Chat at llm-app:9001."""
import grpc.aio

import firewall_pb2
import firewall_pb2_grpc

UPSTREAM = "llm-app:9001"
UPSTREAM_DEADLINE_S = 30.0

_channel = grpc.aio.insecure_channel(UPSTREAM)
_assistant = firewall_pb2_grpc.AssistantStub(_channel)


async def forward(prompt: str, request_id: str) -> str:
    """The application's answer to an allowed prompt; the request id travels with it."""
    reply = await _assistant.Chat(
        firewall_pb2.ChatRequest(prompt=prompt, request_id=request_id), timeout=UPSTREAM_DEADLINE_S
    )
    return reply.text
`,
};

/** TypeScript: `import {forward} from 'aifw/upstream'`. */
export const supportModulesTs: Record<string, string> = {
  'aifw/upstream.ts': `/** The LLM application the firewall fronts (provided): one gRPC call, Assistant.Chat at llm-app:9001. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const UPSTREAM = 'llm-app:9001';
export const UPSTREAM_DEADLINE_MS = 30_000;

interface AssistantClient {
  Chat(
    request: {prompt: string; request_id: string},
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: {text: string}) => void,
  ): void;
}

const {firewall} = grpc.loadPackageDefinition(protoLoader.loadSync('firewall.proto')) as unknown as {
  firewall: {Assistant: new (target: string, credentials: grpc.ChannelCredentials) => AssistantClient};
};
const assistant = new firewall.Assistant(UPSTREAM, grpc.credentials.createInsecure());

/** The application's answer to an allowed prompt; the request id travels with it. */
export function forward(prompt: string, requestId: string): Promise<string> {
  const {promise, resolve, reject} = Promise.withResolvers<string>();
  assistant.Chat({prompt, request_id: requestId}, {deadline: Date.now() + UPSTREAM_DEADLINE_MS}, (error, reply) =>
    error ? reject(error) : resolve(reply.text),
  );
  return promise;
}
`,
};

/** Go: `import "aifw/upstream"`; `upstream.Forward(ctx, prompt, requestID)`. */
export const supportModulesGo: Record<string, string> = {
  'aifw/upstream/upstream.go': `// Package upstream is the LLM application the firewall fronts (provided): one gRPC call,
// Assistant.Chat at llm-app:9001.
package upstream

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "aifw/gen/firewall"
)

const (
	Target   = "llm-app:9001"
	Deadline = 30 * time.Second
)

var conn, _ = grpc.NewClient(Target, grpc.WithTransportCredentials(insecure.NewCredentials()))
var assistant = pb.NewAssistantClient(conn)

// Forward is the application's answer to an allowed prompt; the request id travels with it.
func Forward(ctx context.Context, prompt, requestID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, Deadline)
	defer cancel()
	reply, err := assistant.Chat(ctx, &pb.ChatRequest{Prompt: prompt, RequestId: requestID})
	if err != nil {
		return "", err
	}
	return reply.GetText(), nil
}
`,
};

/** C++: `#include "aifw/upstream.h"`; `aifw::forward(prompt, request_id)`; `ids.h` for the request id's UUID. */
export const supportModulesCpp: Record<string, string> = {
  'ids.h': CPP_IDS_H,
  'aifw/upstream.h': `// The LLM application the firewall fronts (provided): one gRPC call, Assistant.Chat at llm-app:9001.
#pragma once

#include <grpcpp/grpcpp.h>

#include <chrono>
#include <memory>
#include <optional>
#include <string>

#include "firewall.grpc.pb.h"

namespace aifw {

inline constexpr const char* kUpstream = "llm-app:9001";
inline constexpr std::chrono::seconds kUpstreamDeadline{30};

inline firewall::Assistant::Stub& assistant() {
  static std::unique_ptr<firewall::Assistant::Stub> stub =
      firewall::Assistant::NewStub(grpc::CreateChannel(kUpstream, grpc::InsecureChannelCredentials()));
  return *stub;
}

// The application's answer to an allowed prompt (nullopt when the application did not answer); the
// request id travels with it.
inline std::optional<std::string> forward(const std::string& prompt, const std::string& request_id) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kUpstreamDeadline);
  firewall::ChatRequest request;
  request.set_prompt(prompt);
  request.set_request_id(request_id);
  firewall::ChatReply reply;
  if (!assistant().Chat(&ctx, request, &reply).ok()) return std::nullopt;
  return reply.text();
}

}  // namespace aifw
`,
};

/** Scala: `aifw.Upstream.forward(prompt, requestId)`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('aifw', 'Upstream')]: `package aifw

import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import firewall.firewall.{AssistantGrpc, ChatRequest}

/** The LLM application the firewall fronts (provided): one gRPC call, Assistant.Chat at llm-app:9001. */
object Upstream {
  val Target = "llm-app:9001"
  val DeadlineMs = 30000L

  private val assistant = AssistantGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("llm-app", 9001).usePlaintext().build()
  )

  /** The application's answer to an allowed prompt; the request id travels with it. */
  def forward(prompt: String, requestId: String): String =
    assistant
      .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
      .chat(ChatRequest(prompt = prompt, requestId = requestId))
      .text
}
`,
};
