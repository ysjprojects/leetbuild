import type {Step} from '@/lib/types';

export const subagentFanoutStep: Step = {
  id: 'subagent-fanout',
  title: 'Lead agent: parallel subagents with task specs and deadlines',
  concept: 'grpc',
  file: 'lead_agent',
  focus: ['lead', 'subagent'],
  task: `## Task

**Starting point.** The starter implements \`run_research(job_id, query, budget)\` for the lead
agent: it asks the planner for subtasks, sends each one through \`Subagent.Run\` with a bare
objective, waits for the reply, appends the transcript to its notes and synthesises. It compiles,
it answers the demo query, and it hides five flaws.

**Failure mode the checks target.** A sequential loop makes a ten-subagent job ten times slower;
an uncapped plan lets the lead spawn as many subagents as the planner invents; a call without a
deadline lets one stuck subagent hold the job open; a bare objective makes subagents duplicate each
other's searches; and the raw transcript fills the lead's context with pages, so the synthesis
degrades without an error.

- The plan is a list of subtasks; take at most \`budget.max_subagents\`. Each \`Subagent.Run\`
  request carries the **objective**, **output format**, **tools** and **boundaries**.
- Run subagents **in parallel**, in batches of at most
  \`min(MAX_PARALLEL_SUBAGENTS, budget.max_subagents)\` with \`MAX_PARALLEL_SUBAGENTS = 5\`.
- Every \`Run\` carries a **120 s** deadline (\`SUBAGENT_DEADLINE_S\`). A subagent that times out
  or fails contributes a one-line "no result" note and does not block the batch.
- Only the condensed \`findings\` reach synthesis, capped at **4 000** characters
  (\`MAX_FINDINGS_CHARS\`). The \`transcript\` stays with the subagent: forwarding it puts the whole
  corpus back into the lead's context window.`,
  sequence: {
    participants: ['Lead agent', 'Planner', 'Subagent A', 'Subagent B'],
    messages: [
      {from: 'Lead agent', to: 'Planner', label: 'plan(query)', kind: 'sync'},
      {from: 'Planner', to: 'Lead agent', label: '[{objective, output_format, tools, boundaries}…]', kind: 'reply'},
      {from: 'Lead agent', to: 'Lead agent', label: 'take ≤ budget.max_subagents · batch ≤ 5', kind: 'sync'},
      {from: 'Lead agent', to: 'Subagent A', label: 'Run(task A) · deadline 120 s', kind: 'sync'},
      {from: 'Lead agent', to: 'Subagent B', label: 'Run(task B) · deadline 120 s', kind: 'sync'},
      {from: 'Subagent A', to: 'Lead agent', label: 'findings (≤ 4 000 chars kept)', kind: 'reply'},
      {from: 'Subagent B', to: 'Lead agent', label: 'DEADLINE_EXCEEDED → "no result" note', kind: 'reply'},
      {from: 'Lead agent', to: 'Lead agent', label: 'synthesize(query, notes)', kind: 'sync'},
    ],
  },
  hints: [
    'A `deep` job takes ten times longer than a `fact` job with the same subagent latency, a simple query shows thirty subagents in the trace, and one hung subagent keeps the job running for hours.',
    'The loop awaits `subagents.Run` one task at a time with no deadline, takes every task the planner returns, fills the request from `task["objective"]` only, and appends `reply.transcript`, so the lead reads whole corpora.',
    'Slice the plan to `budget.max_subagents`, run windows of `min(MAX_PARALLEL_SUBAGENTS, budget.max_subagents)` with `asyncio.gather`, pass `timeout=SUBAGENT_DEADLINE_S` to `Run`, fill `objective`, `output_format`, `tools`, `boundaries`, keep `reply.findings[:MAX_FINDINGS_CHARS]`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every Subagent.Run carries a 120 s deadline',
      detail:
        'The call is created with `SUBAGENT_DEADLINE_S = 120` — a call timeout, a context with timeout, `withDeadlineAfter`, `set_deadline` or `deadline: Date.now() + SUBAGENT_DEADLINE_MS`. Without it one stuck subagent holds the job open indefinitely.',
      match: {
        python: {all: [/SUBAGENT_DEADLINE_S\s*=\s*120/, /timeout=SUBAGENT_DEADLINE_S/, /\.Run\(/]},
        typescript: {
          all: [
            /SUBAGENT_DEADLINE_MS\s*=\s*120_?000/,
            /deadline:\s*Date\.now\(\)\s*\+\s*SUBAGENT_DEADLINE_MS/,
            /\.Run\(/,
          ],
        },
        go: {all: [/subagentDeadlineS\s*=\s*120/, /context\.WithTimeout/, /\.Run\(/]},
        scala: {all: [/SubagentDeadlineS\s*=\s*120/, /withDeadlineAfter/, /\.run\(/]},
        cpp: {all: [/kSubagentDeadlineS\s*=\s*120/, /set_deadline\(/, /->Run\(/]},
      },
    },
    {
      id: 'parallel',
      title: 'Runs subagents in parallel batches of at most five',
      detail:
        'Subagents run concurrently — `asyncio.gather`, `Promise.all`, a `WaitGroup`, `Future.sequence`, `std::async` — in windows of `MAX_PARALLEL_SUBAGENTS = 5`. The starter awaits each subagent before starting the next.',
      match: {
        python: {all: [/MAX_PARALLEL_SUBAGENTS\s*=\s*5/, /asyncio\.gather\(/]},
        typescript: {all: [/MAX_PARALLEL_SUBAGENTS\s*=\s*5/, /Promise\.all\(/]},
        go: {all: [/maxParallelSubagents\s*=\s*5/, /sync\.WaitGroup/, /go func\(/]},
        scala: {all: [/MaxParallelSubagents\s*=\s*5/, /Future\.(sequence|traverse)\(/]},
        cpp: {all: [/kMaxParallelSubagents\s*=\s*5/, /std::async\(/]},
      },
    },
    {
      id: 'fanout-cap',
      title: 'Caps the fan-out by the job budget',
      detail:
        'The number of subagents is bounded by `budget.max_subagents` — the plan is cut to it and the batch width is `min(MAX_PARALLEL_SUBAGENTS, budget.max_subagents)`. The starter runs every task the planner returns.',
      match: {
        python: {all: [/min\([^)]*max_subagents/, /\[\s*:\s*budget\["max_subagents"\]\s*\]/]},
        typescript: {all: [/Math\.min\([^)]*max_subagents/, /\.slice\(\s*0\s*,\s*budget\.max_subagents\s*\)/]},
        go: {all: [/min\([^)]*MaxSubagents/, /\[\s*:\s*budget\.MaxSubagents\s*\]/]},
        scala: {all: [/math\.min\([^)]*maxSubagents/, /\.take\(\s*budget\.maxSubagents\s*\)/]},
        cpp: {all: [/std::min\([^)]*max_subagents/, /\.resize\(/]},
      },
    },
    {
      id: 'task-spec',
      title: 'Each task carries objective, output format, tools and boundaries',
      detail:
        'The `Run` request is built with all four fields of the task description the source prescribes: `objective`, `output_format`, `tools`, `boundaries`. The starter sends only the objective.',
      match: {
        python: {all: [/objective=/, /output_format=/, /tools=/, /boundaries=/]},
        typescript: {all: [/objective:/, /output_format:/, /tools:/, /boundaries:/]},
        go: {all: [/Objective:/, /OutputFormat:/, /Tools:/, /Boundaries:/]},
        scala: {all: [/objective\s*=/, /outputFormat\s*=/, /tools\s*=/, /boundaries\s*=/]},
        cpp: {all: [/set_objective\(/, /set_output_format\(/, /add_tools\(/, /set_boundaries\(/]},
      },
    },
    {
      id: 'condense',
      title: 'Carries the condensed findings, never the transcript',
      detail:
        'Synthesis receives `findings` cut to `MAX_FINDINGS_CHARS = 4000` per subagent; `transcript` is never read. The starter forwards the whole transcript into the lead’s context.',
      match: {
        python: {all: [/MAX_FINDINGS_CHARS\s*=\s*4000/, /\.findings/], none: [/\.transcript/]},
        typescript: {all: [/MAX_FINDINGS_CHARS\s*=\s*4000/, /\.findings/], none: [/\.transcript/]},
        go: {all: [/maxFindingsChars\s*=\s*4000/, /\.Findings/], none: [/\.Transcript/]},
        scala: {all: [/MaxFindingsChars\s*=\s*4000/, /\.findings/], none: [/\.transcript/]},
        cpp: {all: [/kMaxFindingsChars\s*=\s*4000/, /\.findings\(\)/], none: [/\.transcript\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import agents_pb2
import agents_pb2_grpc

channel = grpc.aio.insecure_channel("subagents:9000")
subagents = agents_pb2_grpc.SubagentStub(channel)


def plan(query: str) -> list[dict]:
    """The lead agent's plan: one task per aspect of the query (the model call is elided)."""
    raise NotImplementedError


def synthesize(query: str, notes: list[str]) -> str:
    """The lead agent's synthesis of the subagents' notes (the model call is elided)."""
    raise NotImplementedError


async def run_research(job_id: str, query: str, budget: dict) -> str:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    notes: list[str] = []
    for task in plan(query):
        request = agents_pb2.RunRequest(job_id=job_id, task_id=task["id"], objective=task["objective"])
        reply = await subagents.Run(request)
        notes.append(reply.transcript)
    return synthesize(query, notes)
`,
      solution: `import asyncio

import grpc

import agents_pb2
import agents_pb2_grpc

SUBAGENT_DEADLINE_S = 120
MAX_PARALLEL_SUBAGENTS = 5
MAX_FINDINGS_CHARS = 4000

channel = grpc.aio.insecure_channel("subagents:9000")
subagents = agents_pb2_grpc.SubagentStub(channel)


def plan(query: str) -> list[dict]:
    """The lead agent's plan: one task per aspect of the query (the model call is elided)."""
    raise NotImplementedError


def synthesize(query: str, notes: list[str]) -> str:
    """The lead agent's synthesis of the subagents' notes (the model call is elided)."""
    raise NotImplementedError


async def run_subagent(job_id: str, task: dict) -> str:
    request = agents_pb2.RunRequest(
        job_id=job_id,
        task_id=task["id"],
        objective=task["objective"],
        output_format=task["output_format"],
        tools=task["tools"],
        boundaries=task["boundaries"],
    )
    try:
        reply = await subagents.Run(request, timeout=SUBAGENT_DEADLINE_S)
    except grpc.aio.AioRpcError as exc:
        return f"[{task['id']}] no result: {exc.code().name}"
    return f"[{task['id']}] {reply.findings[:MAX_FINDINGS_CHARS]}"


async def run_research(job_id: str, query: str, budget: dict) -> str:
    tasks = plan(query)[: budget["max_subagents"]]
    width = min(MAX_PARALLEL_SUBAGENTS, budget["max_subagents"])
    notes: list[str] = []
    for start in range(0, len(tasks), width):
        batch = tasks[start : start + width]
        notes.extend(await asyncio.gather(*(run_subagent(job_id, task) for task in batch)))
    return synthesize(query, notes)
`,
    },
    typescript: {
      starter: `/** Lead agent. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {plan, synthesize} from './planner';

interface RunRequest {
  job_id: string;
  task_id: string;
  objective: string;
}

interface RunReply {
  findings: string;
  transcript: string;
}

interface SubagentClient {
  Run(request: RunRequest, callback: (error: grpc.ServiceError | null, reply: RunReply) => void): void;
}

const {agents} = grpc.loadPackageDefinition(protoLoader.loadSync('agents.proto')) as unknown as {
  agents: {Subagent: new (target: string, credentials: grpc.ChannelCredentials) => SubagentClient};
};
const subagents = new agents.Subagent('subagents:9000', grpc.credentials.createInsecure());

export interface Budget {
  max_subagents: number;
  max_tool_calls: number;
  token_budget: number;
}

export async function runResearch(jobId: string, query: string, budget: Budget): Promise<string> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const notes: string[] = [];
  for (const task of plan(query)) {
    const reply = await new Promise<RunReply>((resolve, reject) => {
      subagents.Run({job_id: jobId, task_id: task.id, objective: task.objective}, (error, result) => {
        if (error !== null) reject(error);
        else resolve(result);
      });
    });
    notes.push(reply.transcript);
  }
  return synthesize(query, notes);
}
`,
      solution: `/** Lead agent: capped, parallel subagents under a deadline; only condensed findings reach synthesis. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {plan, synthesize} from './planner';
import type {Task} from './planner';

const SUBAGENT_DEADLINE_MS = 120_000;
const MAX_PARALLEL_SUBAGENTS = 5;
const MAX_FINDINGS_CHARS = 4000;

interface RunRequest {
  job_id: string;
  task_id: string;
  objective: string;
  output_format: string;
  tools: string[];
  boundaries: string;
}

interface RunReply {
  findings: string;
  transcript: string;
}

interface SubagentClient {
  Run(
    request: RunRequest,
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: RunReply) => void,
  ): void;
}

const {agents} = grpc.loadPackageDefinition(protoLoader.loadSync('agents.proto')) as unknown as {
  agents: {Subagent: new (target: string, credentials: grpc.ChannelCredentials) => SubagentClient};
};
const subagents = new agents.Subagent('subagents:9000', grpc.credentials.createInsecure());

export interface Budget {
  max_subagents: number;
  max_tool_calls: number;
  token_budget: number;
}

async function runSubagent(jobId: string, task: Task): Promise<string> {
  const request: RunRequest = {
    job_id: jobId,
    task_id: task.id,
    objective: task.objective,
    output_format: task.output_format,
    tools: task.tools,
    boundaries: task.boundaries,
  };
  try {
    const reply = await new Promise<RunReply>((resolve, reject) => {
      subagents.Run(request, new grpc.Metadata(), {deadline: Date.now() + SUBAGENT_DEADLINE_MS}, (error, result) => {
        if (error !== null) reject(error);
        else resolve(result);
      });
    });
    return \`[\${task.id}] \${reply.findings.slice(0, MAX_FINDINGS_CHARS)}\`;
  } catch (error) {
    const code = (error as grpc.ServiceError).code;
    return \`[\${task.id}] no result: \${grpc.status[code]}\`;
  }
}

export async function runResearch(jobId: string, query: string, budget: Budget): Promise<string> {
  const tasks = plan(query).slice(0, budget.max_subagents);
  const width = Math.min(MAX_PARALLEL_SUBAGENTS, budget.max_subagents);
  const notes: string[] = [];
  for (let start = 0; start < tasks.length; start += width) {
    const batch = tasks.slice(start, start + width);
    notes.push(...(await Promise.all(batch.map(task => runSubagent(jobId, task)))));
  }
  return synthesize(query, notes);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	pb "researchd/agentspb"
)

type Budget struct {
	MaxSubagents int
	MaxToolCalls int
	TokenBudget  int
}

type Task struct {
	ID           string
	Objective    string
	OutputFormat string
	Tools        []string
	Boundaries   string
}

// plan and synthesize wrap the lead agent's model calls; both are elided here.
func plan(ctx context.Context, query string) ([]Task, error)      { return nil, nil }
func synthesize(ctx context.Context, query string, notes []string) (string, error) { return "", nil }

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
func runResearch(ctx context.Context, client pb.SubagentClient, jobID, query string, budget Budget) (string, error) {
	tasks, err := plan(ctx, query)
	if err != nil {
		return "", err
	}
	var notes []string
	for _, task := range tasks {
		reply, err := client.Run(ctx, &pb.RunRequest{JobId: jobID, TaskId: task.ID, Objective: task.Objective})
		if err != nil {
			return "", err
		}
		notes = append(notes, reply.Transcript)
	}
	return synthesize(ctx, query, notes)
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"google.golang.org/grpc/status"

	pb "researchd/agentspb"
)

const (
	subagentDeadlineS    = 120
	maxParallelSubagents = 5
	maxFindingsChars     = 4000
)

type Budget struct {
	MaxSubagents int
	MaxToolCalls int
	TokenBudget  int
}

type Task struct {
	ID           string
	Objective    string
	OutputFormat string
	Tools        []string
	Boundaries   string
}

// plan and synthesize wrap the lead agent's model calls; both are elided here.
func plan(ctx context.Context, query string) ([]Task, error)      { return nil, nil }
func synthesize(ctx context.Context, query string, notes []string) (string, error) { return "", nil }

func runSubagent(ctx context.Context, client pb.SubagentClient, jobID string, task Task) string {
	callCtx, cancel := context.WithTimeout(ctx, subagentDeadlineS*time.Second)
	defer cancel()
	reply, err := client.Run(callCtx, &pb.RunRequest{
		JobId:        jobID,
		TaskId:       task.ID,
		Objective:    task.Objective,
		OutputFormat: task.OutputFormat,
		Tools:        task.Tools,
		Boundaries:   task.Boundaries,
	})
	if err != nil {
		return fmt.Sprintf("[%s] no result: %s", task.ID, status.Code(err))
	}
	findings := reply.Findings
	if len(findings) > maxFindingsChars {
		findings = findings[:maxFindingsChars]
	}
	return fmt.Sprintf("[%s] %s", task.ID, findings)
}

func runResearch(ctx context.Context, client pb.SubagentClient, jobID, query string, budget Budget) (string, error) {
	tasks, err := plan(ctx, query)
	if err != nil {
		return "", err
	}
	if len(tasks) > budget.MaxSubagents {
		tasks = tasks[:budget.MaxSubagents]
	}
	width := min(maxParallelSubagents, budget.MaxSubagents)
	notes := make([]string, len(tasks))
	for start := 0; start < len(tasks); start += width {
		end := min(start+width, len(tasks))
		var wg sync.WaitGroup
		for i := start; i < end; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				notes[i] = runSubagent(ctx, client, jobID, tasks[i])
			}(i)
		}
		wg.Wait()
	}
	return synthesize(ctx, query, notes)
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

final case class Budget(maxSubagents: Int, maxToolCalls: Int, tokenBudget: Int)
final case class Task(id: String, objective: String, outputFormat: String, tools: Seq[String], boundaries: String)

object LeadAgent {
  val subagents =
    SubagentGrpc.blockingStub(ManagedChannelBuilder.forAddress("subagents", 9000).usePlaintext().build())

  /** The lead agent's plan and synthesis wrap model calls; both are elided here. */
  def plan(query: String): List[Task] = ???
  def synthesize(query: String, notes: List[String]): String = ???

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def runResearch(jobId: String, query: String, budget: Budget): String = {
    val notes = plan(query).map { task =>
      val reply = subagents.run(RunRequest(jobId = jobId, taskId = task.id, objective = task.objective))
      reply.transcript
    }
    synthesize(query, notes)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.concurrent.duration.Duration
import scala.concurrent.{Await, ExecutionContext, Future}

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

final case class Budget(maxSubagents: Int, maxToolCalls: Int, tokenBudget: Int)
final case class Task(id: String, objective: String, outputFormat: String, tools: Seq[String], boundaries: String)

object LeadAgent {
  val SubagentDeadlineS = 120
  val MaxParallelSubagents = 5
  val MaxFindingsChars = 4000

  implicit val ec: ExecutionContext = ExecutionContext.global

  val subagents =
    SubagentGrpc.blockingStub(ManagedChannelBuilder.forAddress("subagents", 9000).usePlaintext().build())

  /** The lead agent's plan and synthesis wrap model calls; both are elided here. */
  def plan(query: String): List[Task] = ???
  def synthesize(query: String, notes: List[String]): String = ???

  def runSubagent(jobId: String, task: Task): String = {
    val request = RunRequest(
      jobId = jobId,
      taskId = task.id,
      objective = task.objective,
      outputFormat = task.outputFormat,
      tools = task.tools,
      boundaries = task.boundaries
    )
    try {
      val reply = subagents.withDeadlineAfter(SubagentDeadlineS.toLong, TimeUnit.SECONDS).run(request)
      s"[\${task.id}] \${reply.findings.take(MaxFindingsChars)}"
    } catch {
      case exc: StatusRuntimeException => s"[\${task.id}] no result: \${exc.getStatus.getCode}"
    }
  }

  def runResearch(jobId: String, query: String, budget: Budget): String = {
    val tasks = plan(query).take(budget.maxSubagents)
    val width = math.min(MaxParallelSubagents, budget.maxSubagents)
    val notes = tasks.grouped(width).toList.flatMap { batch =>
      Await.result(Future.traverse(batch)(task => Future(runSubagent(jobId, task))), Duration.Inf)
    }
    synthesize(query, notes)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "agents.grpc.pb.h"

#include <string>
#include <vector>

struct Budget {
  int max_subagents;
  int max_tool_calls;
  int token_budget;
};

struct Task {
  std::string id;
  std::string objective;
  std::string output_format;
  std::vector<std::string> tools;
  std::string boundaries;
};

// The lead agent's plan and synthesis wrap model calls; both are elided here.
std::vector<Task> plan(const std::string& query);
std::string synthesize(const std::string& query, const std::vector<std::string>& notes);

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
std::string runResearch(Subagent::Stub* subagents, const std::string& jobId, const std::string& query, const Budget& budget) {
  std::vector<std::string> notes;
  for (const auto& task : plan(query)) {
    grpc::ClientContext ctx;
    RunRequest request;
    request.set_job_id(jobId);
    request.set_task_id(task.id);
    request.set_objective(task.objective);
    RunReply reply;
    const grpc::Status status = subagents->Run(&ctx, request, &reply);
    if (!status.ok()) throw std::runtime_error("subagent failed: " + status.error_message());
    notes.push_back(reply.transcript());
  }
  return synthesize(query, notes);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "agents.grpc.pb.h"

#include <algorithm>
#include <chrono>
#include <future>
#include <string>
#include <vector>

constexpr int kSubagentDeadlineS = 120;
constexpr int kMaxParallelSubagents = 5;
constexpr std::size_t kMaxFindingsChars = 4000;

struct Budget {
  int max_subagents;
  int max_tool_calls;
  int token_budget;
};

struct Task {
  std::string id;
  std::string objective;
  std::string output_format;
  std::vector<std::string> tools;
  std::string boundaries;
};

// The lead agent's plan and synthesis wrap model calls; both are elided here.
std::vector<Task> plan(const std::string& query);
std::string synthesize(const std::string& query, const std::vector<std::string>& notes);

std::string runSubagent(Subagent::Stub* subagents, const std::string& jobId, const Task& task) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kSubagentDeadlineS));
  RunRequest request;
  request.set_job_id(jobId);
  request.set_task_id(task.id);
  request.set_objective(task.objective);
  request.set_output_format(task.output_format);
  for (const auto& tool : task.tools) request.add_tools(tool);
  request.set_boundaries(task.boundaries);
  RunReply reply;
  const grpc::Status status = subagents->Run(&ctx, request, &reply);
  if (!status.ok()) return "[" + task.id + "] no result: " + status.error_message();
  return "[" + task.id + "] " + reply.findings().substr(0, kMaxFindingsChars);
}

std::string runResearch(Subagent::Stub* subagents, const std::string& jobId, const std::string& query, const Budget& budget) {
  auto tasks = plan(query);
  if (tasks.size() > static_cast<std::size_t>(budget.max_subagents)) tasks.resize(budget.max_subagents);
  const std::size_t width = std::min(kMaxParallelSubagents, budget.max_subagents);
  std::vector<std::string> notes;
  for (std::size_t start = 0; start < tasks.size(); start += width) {
    const std::size_t end = std::min(start + width, tasks.size());
    std::vector<std::future<std::string>> batch;
    for (std::size_t i = start; i < end; i++) {
      batch.push_back(std::async(std::launch::async, runSubagent, subagents, jobId, tasks[i]));
    }
    for (auto& pending : batch) notes.push_back(pending.get());
  }
  return synthesize(query, notes);
}
`,
    },
  },
  debrief: `The fix keeps the lead's context window small and its wall clock short, which is why subagents exist: they spend tokens in parallel in their own windows and hand back a compressed result. Batches of five restore the parallelism the loop threw away; the budget cap bounds how many are spawned; the deadline gives an expensive job an exit when one subagent hangs; and reading \`findings\` instead of \`transcript\` preserves the compression. The task spec is not a code bug: a subagent given only "research X" cannot know what its siblings are doing, so objective, output format, tools and boundaries are part of the request contract. Production leads also run a second round when the synthesis finds gaps and let subagents return references to stored artefacts.`,
};
