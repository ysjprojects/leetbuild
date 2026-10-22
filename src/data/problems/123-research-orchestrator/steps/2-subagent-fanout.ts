import type {Step} from '@/lib/types';

export const subagentFanoutStep: Step = {
  id: 'subagent-fanout',
  title: 'Lead agent: parallel subagents with task specs and deadlines',
  concept: 'grpc',
  file: 'lead_agent',
  focus: ['lead', 'subagent'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it asks the planner for
subtasks, runs each through \`Subagent.Run\` and synthesises the replies. It compiles, it answers the
demo query, and it hides four production flaws — the four the source names when it describes what
went wrong with its early lead agents. Review it, fix it, and prove the fix.

Implement \`run_research(job_id, query, budget)\` for the lead agent:

- The plan is a list of subtasks; take at most \`budget.max_subagents\` of them. Each
  \`Subagent.Run\` request carries the **objective**, the **output format**, the **tools** the
  subagent may use and its **boundaries** — the source found that a bare "research X" makes
  subagents duplicate each other's searches and leave gaps.
- Run subagents **in parallel**, in batches of at most \`min(MAX_PARALLEL_SUBAGENTS, budget.max_subagents)\`
  where \`MAX_PARALLEL_SUBAGENTS = 5\`. The source's lead agent spins up 3–5 subagents at once
  instead of serially; that change alone cut research time by up to 90%.
- Every \`Run\` carries a **120 s** deadline (\`SUBAGENT_DEADLINE_S\`). A subagent that times out
  or fails contributes a one-line "no result" note for its task; it never blocks the batch.
- Only the subagent's condensed \`findings\` reach synthesis, capped at **4 000** characters
  (\`MAX_FINDINGS_CHARS\`). The reply's \`transcript\` — every search and every page it read — stays
  with the subagent. Subagents exist to compress; forwarding the transcript puts the whole corpus
  back into the lead's context window.

**Failure mode the checks target.** A sequential loop makes a ten-subagent job ten times slower
than it needs to be; an uncapped plan lets the lead spawn as many subagents as the planner invents
(the source's early agents spawned fifty for a simple query); a call without a deadline lets one
stuck subagent hold the job open indefinitely; and the raw transcript is the quiet one: the lead's
context fills with pages instead of findings, the plan it wrote at the top is truncated away, and
the synthesis degrades without any error being raised.`,
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
    'The deadline is an argument on the call itself (`timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`). Put one subagent call in its own function that returns a string either way — findings or a "no result" note — so a failure never rejects the batch.',
    'Parallelism is a batch, not a free-for-all: slice the plan into windows of `min(MAX_PARALLEL_SUBAGENTS, budget.max_subagents)` and run each window with `asyncio.gather` / `Promise.all` / a `WaitGroup` / `Future.sequence` / `std::async`. Cap the plan at `budget.max_subagents` before the first window.',
    'Compression is the point: read `reply.findings`, slice it to `MAX_FINDINGS_CHARS`, and never touch `reply.transcript`. The request needs all four task fields — `objective`, `output_format`, `tools`, `boundaries` — straight from the planner’s task.',
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
        'Subagents run concurrently — `asyncio.gather`, `Promise.all`, a `WaitGroup`, `Future.sequence`, `std::async` — in windows of `MAX_PARALLEL_SUBAGENTS = 5`. The draft awaits each subagent before starting the next.',
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
        'The number of subagents is bounded by `budget.max_subagents` — the plan is cut to it and the batch width is `min(MAX_PARALLEL_SUBAGENTS, budget.max_subagents)`. The draft runs every task the planner returns.',
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
        'The `Run` request is built with all four fields of the task description the source prescribes: `objective`, `output_format`, `tools`, `boundaries`. The draft sends only the objective.',
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
        'Synthesis receives `findings` cut to `MAX_FINDINGS_CHARS = 4000` per subagent; `transcript` is never read. The draft forwards the whole transcript into the lead’s context.',
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
    # TODO: this draft runs subagents one after another with no deadline, lets the planner decide
    # how many to spawn, sends a bare objective, and forwards each transcript. Review all four.
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
      starter: `/** Lead agent: a model-generated draft that runs subagents one at a time and keeps their transcripts. */
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
  // TODO: this draft runs subagents one after another with no deadline, lets the planner decide
  // how many to spawn, sends a bare objective, and forwards each transcript. Review all four.
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

// TODO: this draft runs subagents one after another with no deadline, lets the planner decide
// how many to spawn, sends a bare objective, and forwards each transcript. Review all four.
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

  // TODO: this draft runs subagents one after another with no deadline, lets the planner decide
  // how many to spawn, sends a bare objective, and forwards each transcript. Review all four.
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

// TODO: this draft runs subagents one after another with no deadline, lets the planner decide
// how many to spawn, sends a bare objective, and forwards each transcript. Review all four.
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
  debrief: `The interviewer is testing whether you understand why the source's architecture works at all: subagents exist to spend tokens in parallel, in their own context windows, and hand back a compressed result. Four defects break that. The sequential loop throws away the parallelism (the source measured up to 90% of the time saved by running 3–5 subagents at once); the uncapped plan is the fifty-subagents-for-a-simple-query failure the source names, and the budget from step 1 is what bounds it; the missing deadline lets one subagent hold a stateful, expensive job open with no exit; and forwarding the transcript undoes the compression — the lead's context fills with pages, its plan is truncated away, and the synthesis quietly degrades. The task spec is the fourth, and the one that is not a bug in the code: the source found that subagents given only "research X" duplicate each other's searches, so objective, output format, tools and boundaries are part of the request contract. Real leads add a second round — spawn more subagents when the synthesis finds gaps — write the plan to external memory before the first fan-out, and let subagents write large artefacts to a store and return references instead of text.`,
};
