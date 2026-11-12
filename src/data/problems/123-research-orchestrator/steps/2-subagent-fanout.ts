import type {Step} from '@/lib/types';

export const subagentFanoutStep: Step = {
  id: 'subagent-fanout',
  title: 'Lead agent: subagents in parallel, under the budget, with a deadline',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'lead_agent',
  focus: ['lead', 'subagent'],
  task: `## Task

**Starting point.** The starter is the lead agent's fan-out, \`run_subagents(job_id, plan, budget)\`:
for each task of the plan (\`id\`, \`objective\`, \`output_format\`, \`tools\`, \`boundaries\`) it awaits
\`Subagent.Run\` at \`subagents:9000\` with the job id, the task id and the objective, and appends
\`"[task_id] " + reply.transcript\` to the notes it returns; a failed call becomes
\`"[task_id] no result: CODE"\`. It answers the demo and hides 5 flaws.

**Failure mode the checks target.** A deep job takes ten times as long as it should; a planner that
returns twelve tasks spends twelve subagents on a four-subagent budget; one hung subagent holds the
job for as long as it hangs; subagents without an output format or boundaries repeat each other's
searches; and every page a subagent read lands in the lead's context window.

- Run only the first \`budget.max_subagents\` tasks, **in parallel**, in batches of
  \`min(MAX_PARALLEL_SUBAGENTS, max_subagents)\` with \`MAX_PARALLEL_SUBAGENTS\` = 5.
- Every \`Run\` carries a **120 s** deadline (\`SUBAGENT_DEADLINE_S\`); a call that fails or times
  out is a "no result" note and the batch goes on.
- The request carries the whole task description: objective, output format, tools, boundaries.
- A note carries \`findings\` cut to \`MAX_FINDINGS_CHARS\` = 4000 characters; the transcript stays
  with the subagent. Notes keep the plan's order.`,
  sequence: {
    participants: ['Lead agent', 'Subagent A', 'Subagent B'],
    messages: [
      {
        from: 'Lead agent',
        to: 'Lead agent',
        label: 'plan[:max_subagents] · batches of min(5, max_subagents)',
        kind: 'sync',
      },
      {
        from: 'Lead agent',
        to: 'Subagent A',
        label: 'Run(objective, output_format, tools, boundaries) · 120 s',
        kind: 'sync',
      },
      {from: 'Lead agent', to: 'Subagent B', label: 'Run(…) · 120 s, at the same time', kind: 'sync'},
      {from: 'Subagent A', to: 'Lead agent', label: 'findings ≤ 4000 chars kept · transcript dropped', kind: 'reply'},
      {from: 'Subagent B', to: 'Lead agent', label: 'DEADLINE_EXCEEDED → "[t-2] no result"', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'parallel',
      title: 'Runs a batch of subagents at the same time',
      detail:
        'The tasks of a batch are in flight together (`asyncio.gather`, `Promise.all`, goroutines with a `WaitGroup`, `Future.sequence`, threads), at most `MAX_PARALLEL_SUBAGENTS` = 5 at once.',
      match: {
        python: {all: [/MAX_PARALLEL_SUBAGENTS\s*=\s*5/, /asyncio\.gather\(/]},
        typescript: {all: [/MAX_PARALLEL_SUBAGENTS\s*=\s*5/, /Promise\.all\(/]},
        go: {all: [/maxParallelSubagents\s*=\s*5/, /sync\.WaitGroup/, /\bgo func\(/]},
        scala: {all: [/MaxParallelSubagents\s*=\s*5/, /Future\.(sequence|traverse)\(/]},
        cpp: {all: [/kMaxParallelSubagents\s*=\s*5/, /std::thread|std::async/]},
      },
    },
    {
      id: 'fanout-cap',
      title: 'Runs no more subagents than the budget allows',
      detail:
        'The plan is cut to `max_subagents` before anything runs, and the batch width is `min(MAX_PARALLEL_SUBAGENTS, max_subagents)`.',
      match: {
        python: {all: [/\[\s*:\s*budget\[["']max_subagents["']\]\s*\]/, /min\([^)\n]*max_subagents/]},
        typescript: {all: [/\.slice\(\s*0\s*,\s*budget\.max_subagents\s*\)/, /Math\.min\([^)\n]*max_subagents/]},
        go: {all: [/budget\.MaxSubagents/, /min\([^)\n]*MaxSubagents/]},
        scala: {all: [/\.take\(\s*budget\.maxSubagents\s*\)/, /math\.min\([^)\n]*maxSubagents|maxSubagents\s*min\b/]},
        cpp: {all: [/budget\.max_subagents/, /std::min\([^;\n]*max_subagents/]},
      },
    },
    {
      id: 'deadline',
      title: 'Every Subagent.Run carries a 120 s deadline',
      detail:
        'The call is made with `SUBAGENT_DEADLINE_S` = 120 (a call timeout, a context with a timeout, `withDeadlineAfter`, `set_deadline`); a subagent that does not answer in time is a "no result" note.',
      match: {
        python: {all: [/SUBAGENT_DEADLINE_S\s*=\s*120\b/, /timeout\s*=\s*SUBAGENT_DEADLINE_S/]},
        typescript: {
          all: [/SUBAGENT_DEADLINE_MS\s*=\s*120_?000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*SUBAGENT_DEADLINE_MS/],
        },
        go: {all: [/subagentDeadline\s*=\s*120\s*\*\s*time\.Second/, /context\.WithTimeout\([^)\n]*subagentDeadline/]},
        scala: {all: [/SubagentDeadlineS\s*=\s*120L?\b/, /withDeadlineAfter\(\s*SubagentDeadlineS/]},
        cpp: {all: [/kSubagentDeadlineS\s*=\s*120\b/, /set_deadline\(/]},
      },
    },
    {
      id: 'task-spec',
      title: 'Sends the whole task description',
      detail:
        'Each `Run` request carries the task’s objective, output format, tools and boundaries, not the objective alone.',
      match: {
        python: {all: [/output_format\s*=/, /tools\s*=/, /boundaries\s*=/]},
        typescript: {all: [/output_format:/, /tools:/, /boundaries:/]},
        go: {all: [/OutputFormat:/, /Tools:/, /Boundaries:/]},
        scala: {all: [/outputFormat\s*=/, /tools\s*=/, /boundaries\s*=/]},
        cpp: {all: [/set_output_format\(/, /add_tools\(/, /set_boundaries\(/]},
      },
    },
    {
      id: 'condense',
      title: 'Keeps the condensed findings, not the transcript',
      detail:
        'A note carries the reply’s `findings`, cut to `MAX_FINDINGS_CHARS` = 4000; the `transcript` is never read.',
      match: {
        python: {all: [/MAX_FINDINGS_CHARS\s*=\s*4000\b/, /\.findings\b/], none: [/\.transcript\b/]},
        typescript: {all: [/MAX_FINDINGS_CHARS\s*=\s*4000\b/, /\.findings\b/], none: [/\.transcript\b/]},
        go: {
          all: [/maxFindingsChars\s*=\s*4000\b/, /GetFindings\(\)|\.Findings\b/],
          none: [/GetTranscript\(\)|\.Transcript\b/],
        },
        scala: {all: [/MaxFindingsChars\s*=\s*4000\b/, /\.findings\b/], none: [/\.transcript\b/]},
        cpp: {all: [/kMaxFindingsChars\s*=\s*4000\b/, /\.findings\(\)/], none: [/\.transcript\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import research_orchestrator_pb2 as pb
import research_orchestrator_pb2_grpc as pb_grpc

subagents = pb_grpc.SubagentStub(grpc.aio.insecure_channel("subagents:9000"))


async def run_subagents(job_id: str, plan: list[dict], budget: dict) -> list[str]:
    """Run the plan's tasks on subagents; one note per task run, in the plan's order."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    notes: list[str] = []
    for task in plan:
        try:
            reply = await subagents.Run(pb.RunRequest(job_id=job_id, task_id=task["id"], objective=task["objective"]))
        except grpc.aio.AioRpcError as exc:
            notes.append(f"[{task['id']}] no result: {exc.code().name}")
            continue
        notes.append(f"[{task['id']}] {reply.transcript}")
    return notes
`,
      solution: `import asyncio

import grpc

import research_orchestrator_pb2 as pb
import research_orchestrator_pb2_grpc as pb_grpc

SUBAGENT_DEADLINE_S = 120
MAX_PARALLEL_SUBAGENTS = 5
MAX_FINDINGS_CHARS = 4000

subagents = pb_grpc.SubagentStub(grpc.aio.insecure_channel("subagents:9000"))


async def run_subagent(job_id: str, task: dict) -> str:
    request = pb.RunRequest(
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
    # The condensed answer only: the transcript would fill the lead's context window.
    return f"[{task['id']}] {reply.findings[:MAX_FINDINGS_CHARS]}"


async def run_subagents(job_id: str, plan: list[dict], budget: dict) -> list[str]:
    """Run the plan's tasks on subagents; one note per task run, in the plan's order."""
    tasks = plan[: budget["max_subagents"]]
    width = min(MAX_PARALLEL_SUBAGENTS, budget["max_subagents"])
    notes: list[str] = []
    for start in range(0, len(tasks), width):
        batch = tasks[start : start + width]
        notes.extend(await asyncio.gather(*(run_subagent(job_id, task) for task in batch)))
    return notes
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Budget, Task} from 'research/jobs';

interface RunRequest {
  job_id: string;
  task_id: string;
  objective: string;
  output_format?: string;
  tools?: string[];
  boundaries?: string;
}

interface RunReply {
  findings: string;
  transcript: string;
  tokens: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('research_orchestrator.proto')) as unknown as {
  researchd: {Subagent: grpc.ServiceClientConstructor};
};
const subagents = new pkg.researchd.Subagent('subagents:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Run(request: RunRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<RunReply>;
};

/** Run the plan's tasks on subagents; one note per task run, in the plan's order. */
export async function runSubagents(jobId: string, plan: Task[], budget: Budget): Promise<string[]> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const notes: string[] = [];
  for (const task of plan) {
    try {
      const reply = await subagents.Run({job_id: jobId, task_id: task.id, objective: task.objective}, new grpc.Metadata(), {});
      notes.push(\`[\${task.id}] \${reply.transcript}\`);
    } catch (e) {
      notes.push(\`[\${task.id}] no result: \${grpc.status[(e as grpc.ServiceError).code]}\`);
    }
  }
  return notes;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Budget, Task} from 'research/jobs';

export const SUBAGENT_DEADLINE_MS = 120_000;
export const MAX_PARALLEL_SUBAGENTS = 5;
export const MAX_FINDINGS_CHARS = 4000;

interface RunRequest {
  job_id: string;
  task_id: string;
  objective: string;
  output_format?: string;
  tools?: string[];
  boundaries?: string;
}

interface RunReply {
  findings: string;
  transcript: string;
  tokens: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('research_orchestrator.proto')) as unknown as {
  researchd: {Subagent: grpc.ServiceClientConstructor};
};
const subagents = new pkg.researchd.Subagent('subagents:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Run(request: RunRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<RunReply>;
};

async function runSubagent(jobId: string, task: Task): Promise<string> {
  const request = {
    job_id: jobId,
    task_id: task.id,
    objective: task.objective,
    output_format: task.output_format,
    tools: task.tools,
    boundaries: task.boundaries,
  };
  try {
    const reply = await subagents.Run(request, new grpc.Metadata(), {deadline: Date.now() + SUBAGENT_DEADLINE_MS});
    // The condensed answer only: the transcript would fill the lead's context window.
    return \`[\${task.id}] \${reply.findings.slice(0, MAX_FINDINGS_CHARS)}\`;
  } catch (e) {
    return \`[\${task.id}] no result: \${grpc.status[(e as grpc.ServiceError).code]}\`;
  }
}

/** Run the plan's tasks on subagents; one note per task run, in the plan's order. */
export async function runSubagents(jobId: string, plan: Task[], budget: Budget): Promise<string[]> {
  const tasks = plan.slice(0, budget.max_subagents);
  const width = Math.min(MAX_PARALLEL_SUBAGENTS, budget.max_subagents);
  const notes: string[] = [];
  for (let start = 0; start < tasks.length; start += width) {
    notes.push(...(await Promise.all(tasks.slice(start, start + width).map(task => runSubagent(jobId, task)))));
  }
  return notes;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "research/gen/research_orchestrator"
	"research/jobs" // jobs.Task, jobs.Budget
)

var (
	subagentConn, _ = grpc.NewClient("subagents:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	subagents       = pb.NewSubagentClient(subagentConn)
)

// runSubagents runs the plan's tasks on subagents: one note per task run, in the plan's order.
func runSubagents(ctx context.Context, jobID string, plan []jobs.Task, budget jobs.Budget) []string {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	var notes []string
	for _, task := range plan {
		reply, err := subagents.Run(ctx, &pb.RunRequest{JobId: jobID, TaskId: task.ID, Objective: task.Objective})
		if err != nil {
			notes = append(notes, fmt.Sprintf("[%s] no result: %v", task.ID, status.Code(err)))
			continue
		}
		notes = append(notes, fmt.Sprintf("[%s] %s", task.ID, reply.GetTranscript()))
	}
	return notes
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "research/gen/research_orchestrator"
	"research/jobs" // jobs.Task, jobs.Budget
)

const (
	subagentDeadline     = 120 * time.Second
	maxParallelSubagents = 5
	maxFindingsChars     = 4000
)

var (
	subagentConn, _ = grpc.NewClient("subagents:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	subagents       = pb.NewSubagentClient(subagentConn)
)

func runSubagent(ctx context.Context, jobID string, task jobs.Task) string {
	callCtx, cancel := context.WithTimeout(ctx, subagentDeadline)
	defer cancel()
	reply, err := subagents.Run(callCtx, &pb.RunRequest{
		JobId: jobID, TaskId: task.ID, Objective: task.Objective, OutputFormat: task.OutputFormat, Tools: task.Tools, Boundaries: task.Boundaries,
	})
	if err != nil {
		return fmt.Sprintf("[%s] no result: %v", task.ID, status.Code(err))
	}
	// The condensed answer only: the transcript would fill the lead's context window.
	findings := reply.GetFindings()
	if len(findings) > maxFindingsChars {
		findings = findings[:maxFindingsChars]
	}
	return fmt.Sprintf("[%s] %s", task.ID, findings)
}

// runSubagents runs the plan's tasks on subagents: one note per task run, in the plan's order.
func runSubagents(ctx context.Context, jobID string, plan []jobs.Task, budget jobs.Budget) []string {
	tasks := plan[:min(len(plan), budget.MaxSubagents)]
	width := min(maxParallelSubagents, budget.MaxSubagents)
	notes := make([]string, len(tasks))
	for start := 0; start < len(tasks); start += width {
		var wg sync.WaitGroup
		for i := start; i < min(start+width, len(tasks)); i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				notes[i] = runSubagent(ctx, jobID, tasks[i])
			}(i)
		}
		wg.Wait()
	}
	return notes
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import research.Jobs // Jobs.Task, Jobs.Budget
import researchd.research_orchestrator.{RunRequest, SubagentGrpc}

object LeadAgent {
  private val subagents = SubagentGrpc.blockingStub(ManagedChannelBuilder.forAddress("subagents", 9000).usePlaintext().build())

  /** Run the plan's tasks on subagents; one note per task run, in the plan's order. */
  def runSubagents(jobId: String, plan: Seq[Jobs.Task], budget: Jobs.Budget): Seq[String] = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    plan.map { task =>
      try {
        val reply = subagents.run(RunRequest(jobId = jobId, taskId = task.id, objective = task.objective))
        s"[\${task.id}] \${reply.transcript}"
      } catch {
        case e: StatusRuntimeException => s"[\${task.id}] no result: \${e.getStatus.getCode}"
      }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import scala.concurrent.duration.Duration
import scala.concurrent.{Await, ExecutionContext, Future}

import research.Jobs // Jobs.Task, Jobs.Budget
import researchd.research_orchestrator.{RunRequest, SubagentGrpc}

object LeadAgent {
  val SubagentDeadlineS = 120L
  val MaxParallelSubagents = 5
  val MaxFindingsChars = 4000

  private implicit val ec: ExecutionContext = ExecutionContext.global
  private val subagents = SubagentGrpc.blockingStub(ManagedChannelBuilder.forAddress("subagents", 9000).usePlaintext().build())

  private def runSubagent(jobId: String, task: Jobs.Task): String = {
    val request = RunRequest(jobId = jobId, taskId = task.id, objective = task.objective, outputFormat = task.outputFormat,
      tools = task.tools, boundaries = task.boundaries)
    try {
      val reply = subagents.withDeadlineAfter(SubagentDeadlineS, TimeUnit.SECONDS).run(request)
      // The condensed answer only: the transcript would fill the lead's context window.
      s"[\${task.id}] \${reply.findings.take(MaxFindingsChars)}"
    } catch {
      case e: StatusRuntimeException => s"[\${task.id}] no result: \${e.getStatus.getCode}"
    }
  }

  /** Run the plan's tasks on subagents; one note per task run, in the plan's order. */
  def runSubagents(jobId: String, plan: Seq[Jobs.Task], budget: Jobs.Budget): Seq[String] = {
    val width = math.min(MaxParallelSubagents, budget.maxSubagents)
    plan.take(budget.maxSubagents).grouped(width).toSeq.flatMap { batch =>
      Await.result(Future.sequence(batch.map(task => Future(runSubagent(jobId, task)))), Duration.Inf)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>
#include <vector>

#include "research/jobs.h"  // jobs::Task, jobs::Budget
#include "research_orchestrator.grpc.pb.h"

auto subagents = researchd::Subagent::NewStub(grpc::CreateChannel("subagents:9000", grpc::InsecureChannelCredentials()));

// Run the plan's tasks on subagents; one note per task run, in the plan's order.
std::vector<std::string> runSubagents(const std::string& job_id, const std::vector<jobs::Task>& plan, const jobs::Budget& budget) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  std::vector<std::string> notes;
  for (const jobs::Task& task : plan) {
    grpc::ClientContext ctx;
    researchd::RunRequest request;
    request.set_job_id(job_id);
    request.set_task_id(task.id);
    request.set_objective(task.objective);
    researchd::RunReply reply;
    const grpc::Status status = subagents->Run(&ctx, request, &reply);
    if (!status.ok()) {
      notes.push_back("[" + task.id + "] no result: " + status.error_message());
      continue;
    }
    notes.push_back("[" + task.id + "] " + reply.transcript());
  }
  return notes;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <string>
#include <thread>
#include <vector>

#include "research/jobs.h"  // jobs::Task, jobs::Budget
#include "research_orchestrator.grpc.pb.h"

constexpr int kSubagentDeadlineS = 120;
constexpr size_t kMaxParallelSubagents = 5;
constexpr size_t kMaxFindingsChars = 4000;

auto subagents = researchd::Subagent::NewStub(grpc::CreateChannel("subagents:9000", grpc::InsecureChannelCredentials()));

std::string runSubagent(const std::string& job_id, const jobs::Task& task) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kSubagentDeadlineS));
  researchd::RunRequest request;
  request.set_job_id(job_id);
  request.set_task_id(task.id);
  request.set_objective(task.objective);
  request.set_output_format(task.output_format);
  for (const std::string& tool : task.tools) request.add_tools(tool);
  request.set_boundaries(task.boundaries);
  researchd::RunReply reply;
  const grpc::Status status = subagents->Run(&ctx, request, &reply);
  if (!status.ok()) return "[" + task.id + "] no result: " + status.error_message();
  // The condensed answer only: the transcript would fill the lead's context window.
  return "[" + task.id + "] " + reply.findings().substr(0, kMaxFindingsChars);
}

// Run the plan's tasks on subagents; one note per task run, in the plan's order.
std::vector<std::string> runSubagents(const std::string& job_id, const std::vector<jobs::Task>& plan, const jobs::Budget& budget) {
  const size_t count = std::min(plan.size(), static_cast<size_t>(budget.max_subagents));
  const size_t width = std::min(kMaxParallelSubagents, static_cast<size_t>(budget.max_subagents));
  std::vector<std::string> notes(count);
  for (size_t start = 0; start < count; start += width) {
    std::vector<std::thread> batch;
    for (size_t i = start; i < std::min(start + width, count); i++) {
      batch.emplace_back([&notes, &job_id, &plan, i] { notes[i] = runSubagent(job_id, plan[i]); });
    }
    for (std::thread& t : batch) t.join();
  }
  return notes;
}
`,
    },
  },
  harness: {
    python: `import asyncio

import research_orchestrator_pb2 as pb
import research_orchestrator_pb2_grpc as pb_grpc

FACT = {"max_subagents": 1, "max_tool_calls": 10, "token_budget": 50000}
COMPARE = {"max_subagents": 4, "max_tool_calls": 60, "token_budget": 250000}
DEEP = {"max_subagents": 10, "max_tool_calls": 150, "token_budget": 1000000}
TRANSCRIPT = "PAGE-DUMP annual report 2024, page 1 of 300. " * 1000


def _plan(n):
    return [
        {
            "id": f"t-{i}",
            "objective": f"Find the board members of bank {i}",
            "output_format": "one line per member: name, role, since",
            "tools": ["search", "fetch"],
            "boundaries": "annual reports from 2024 on; skip news coverage",
        }
        for i in range(1, n + 1)
    ]


def _findings(task_id, size=120):
    return (f"{task_id}: chair, CEO and nine non-executive directors; " * 200)[:size]


class Subagents(pb_grpc.SubagentServicer):
    """Answers every task after a second of work; counts how many runs are in flight at once."""

    def __init__(self, findings_size=120):
        self.active = 0
        self.peak = 0
        self.findings_size = findings_size

    async def Run(self, request, context):
        self.active += 1
        self.peak = max(self.peak, self.active)
        await asyncio.sleep(1)
        self.active -= 1
        return pb.RunReply(findings=_findings(request.task_id, self.findings_size), transcript=TRANSCRIPT, tokens=1200)


def _lead(ctx, findings_size=120):
    peer = Subagents(findings_size)
    ctx.grpc.serve(pb_grpc.add_SubagentServicer_to_server, peer)
    return ctx.load("lead_agent"), peer


def _ran(ctx):
    return [c.request.task_id for c in ctx.grpc.calls_to("Run")]


async def check_parallel(ctx):
    m, peer = _lead(ctx)
    notes = await m.run_subagents("job-1", _plan(10), DEEP)
    assert len(notes) == 10, f"a deep job over a plan of 10 tasks returned {len(notes)} notes"
    assert peer.peak == 5, f"at most {peer.peak} subagent(s) ran at the same time on a deep job of 10 tasks: run batches of MAX_PARALLEL_SUBAGENTS = 5 in parallel"
    peer.peak = 0
    await m.run_subagents("job-2", _plan(4), COMPARE)
    assert peer.peak == 4, f"a compare job (max_subagents 4) ran {peer.peak} subagent(s) at once, expected its 4 together"


async def check_fanout_cap(ctx):
    m, peer = _lead(ctx)
    notes = await m.run_subagents("job-1", _plan(12), COMPARE)
    assert _ran(ctx) and sorted(_ran(ctx)) == ["t-1", "t-2", "t-3", "t-4"], f"a planner that returned 12 tasks on a budget of 4 subagents ran {sorted(_ran(ctx))}: run only the first max_subagents tasks"
    assert len(notes) == 4, f"the fan-out returned {len(notes)} notes, expected 4"
    assert peer.peak <= 4, f"{peer.peak} subagents ran at once on a budget of 4"
    await m.run_subagents("job-2", _plan(3), FACT)
    assert len(ctx.grpc.calls_to("Run")) == 5, f"a fact job ran {len(ctx.grpc.calls_to('Run')) - 4} subagents, expected 1"


async def check_deadline(ctx):
    m, _ = _lead(ctx)
    await m.run_subagents("job-1", _plan(3), COMPARE)
    for call in ctx.grpc.calls_to("Run"):
        assert call.timeout is not None, "a Subagent.Run call carries no deadline: one hung subagent holds the whole job"
        assert 119 <= call.timeout <= 121, f"a Subagent.Run call carries a {call.timeout} s deadline, expected SUBAGENT_DEADLINE_S = 120"
    ctx.grpc.set_latency("Run", 600)
    started = ctx.clock.time()
    notes = await m.run_subagents("job-2", _plan(2), COMPARE)
    waited = ctx.clock.time() - started
    assert all("no result" in note for note in notes), f"two subagents that hang for 600 s gave the notes {[n[:60] for n in notes]}: after 120 s each must be a 'no result' note"
    assert waited <= 250, f"the lead waited {waited:.0f} s for two hung subagents, expected about 120 s"


async def check_task_spec(ctx):
    m, _ = _lead(ctx)
    plan = _plan(3)
    await m.run_subagents("job-1", plan, COMPARE)
    sent = {c.request.task_id: c.request for c in ctx.grpc.calls_to("Run")}
    for task in plan:
        request = sent.get(task["id"])
        assert request is not None, f"task {task['id']} was not run"
        got = {"objective": request.objective, "output_format": request.output_format, "tools": list(request.tools), "boundaries": request.boundaries}
        want = {name: task[name] for name in got}
        assert got == want, f"Subagent.Run for {task['id']} carried {got}, expected the whole task description {want}"
        assert request.job_id == "job-1", f"Subagent.Run for {task['id']} carried job_id {request.job_id!r}"


async def check_condense(ctx):
    m, _ = _lead(ctx, findings_size=6000)
    plan = _plan(2)
    notes = await m.run_subagents("job-1", plan, COMPARE)
    for task, note in zip(plan, notes):
        assert "PAGE-DUMP" not in note, f"the note for {task['id']} carries the subagent's transcript ({len(note)} characters): keep only the condensed findings"
        expected = f"[{task['id']}] {_findings(task['id'], 6000)[:4000]}"
        assert note == expected, f"the note for {task['id']} is {len(note)} characters starting {note[:50]!r}, expected '[{task['id']}] ' and the findings cut to MAX_FINDINGS_CHARS = 4000"
`,
    typescript: `const FACT = {max_subagents: 1, max_tool_calls: 10, token_budget: 50000};
const COMPARE = {max_subagents: 4, max_tool_calls: 60, token_budget: 250000};
const DEEP = {max_subagents: 10, max_tool_calls: 150, token_budget: 1000000};
const TRANSCRIPT = 'PAGE-DUMP annual report 2024, page 1 of 300. '.repeat(1000);

const plan = (n: number) =>
  Array.from({length: n}, (_, i) => ({
    id: \`t-\${i + 1}\`,
    objective: \`Find the board members of bank \${i + 1}\`,
    output_format: 'one line per member: name, role, since',
    tools: ['search', 'fetch'],
    boundaries: 'annual reports from 2024 on; skip news coverage',
  }));

const findings = (taskId: string, size = 120): string => \`\${taskId}: chair, CEO and nine non-executive directors; \`.repeat(200).slice(0, size);

/** Every task answered after 10 s of latency; the calls' start times show how many ran together. */
function lead(ctx, findingsSize = 120) {
  const pkg = ctx.proto('research_orchestrator.proto');
  ctx.grpc.serve(pkg.researchd.Subagent.service, {
    Run(call, callback) {
      callback(null, {findings: findings(call.request.task_id, findingsSize), transcript: TRANSCRIPT, tokens: 1200});
    },
  });
  ctx.grpc.setLatency('Run', 10);
  return ctx.load('lead_agent');
}

/** The most calls that started at the same instant. */
function peak(ctx, from = 0): number {
  const counts = new Map<number, number>();
  for (const c of ctx.grpc.callsTo('Run').slice(from)) counts.set(c.started, (counts.get(c.started) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

const ran = (ctx): string[] => ctx.grpc.callsTo('Run').map(c => c.request.task_id).sort();

export async function check_parallel(ctx) {
  const m = lead(ctx);
  const notes = await m.runSubagents('job-1', plan(10), DEEP);
  assert.equal(notes.length, 10, \`a deep job over a plan of 10 tasks returned \${notes.length} notes\`);
  assert.equal(peak(ctx), 5, \`at most \${peak(ctx)} subagent(s) started together on a deep job of 10 tasks: run batches of MAX_PARALLEL_SUBAGENTS = 5 in parallel\`);
  const before = ctx.grpc.callsTo('Run').length;
  await m.runSubagents('job-2', plan(4), COMPARE);
  assert.equal(peak(ctx, before), 4, \`a compare job (max_subagents 4) started \${peak(ctx, before)} subagent(s) together, expected its 4\`);
}

export async function check_fanout_cap(ctx) {
  const m = lead(ctx);
  const notes = await m.runSubagents('job-1', plan(12), COMPARE);
  assert.deepStrictEqual(ran(ctx), ['t-1', 't-2', 't-3', 't-4'], \`a planner that returned 12 tasks on a budget of 4 subagents ran \${JSON.stringify(ran(ctx))}: run only the first max_subagents tasks\`);
  assert.equal(notes.length, 4, \`the fan-out returned \${notes.length} notes, expected 4\`);
  await m.runSubagents('job-2', plan(3), FACT);
  assert.equal(ctx.grpc.callsTo('Run').length, 5, \`a fact job ran \${ctx.grpc.callsTo('Run').length - 4} subagents, expected 1\`);
}

export async function check_deadline(ctx) {
  const m = lead(ctx);
  await m.runSubagents('job-1', plan(3), COMPARE);
  for (const call of ctx.grpc.callsTo('Run')) {
    assert(call.timeout !== null, 'a Subagent.Run call carries no deadline: one hung subagent holds the whole job');
    assert(119 <= call.timeout && call.timeout <= 121, \`a Subagent.Run call carries a \${call.timeout} s deadline, expected SUBAGENT_DEADLINE_MS = 120000\`);
  }
  ctx.grpc.setLatency('Run', 600);
  const started = ctx.clock.now();
  const notes = await m.runSubagents('job-2', plan(2), COMPARE);
  const waited = (ctx.clock.now() - started) / 1000;
  assert(notes.every(n => n.includes('no result')), \`two subagents that hang for 600 s gave the notes \${JSON.stringify(notes.map(n => n.slice(0, 60)))}: after 120 s each must be a 'no result' note\`);
  assert(waited <= 250, \`the lead waited \${waited} s for two hung subagents, expected about 120 s\`);
}

export async function check_task_spec(ctx) {
  const m = lead(ctx);
  const tasks = plan(3);
  await m.runSubagents('job-1', tasks, COMPARE);
  const sent = new Map(ctx.grpc.callsTo('Run').map(c => [c.request.task_id, c.request]));
  for (const task of tasks) {
    const request = sent.get(task.id);
    assert(request !== undefined, \`task \${task.id} was not run\`);
    const got = {objective: request.objective, output_format: request.output_format, tools: [...(request.tools ?? [])], boundaries: request.boundaries};
    const want = {objective: task.objective, output_format: task.output_format, tools: task.tools, boundaries: task.boundaries};
    assert.deepStrictEqual(got, want, \`Subagent.Run for \${task.id} carried \${JSON.stringify(got)}, expected the whole task description\`);
    assert.equal(request.job_id, 'job-1', \`Subagent.Run for \${task.id} carried job_id \${request.job_id}\`);
  }
}

export async function check_condense(ctx) {
  const m = lead(ctx, 6000);
  const tasks = plan(2);
  const notes = await m.runSubagents('job-1', tasks, COMPARE);
  tasks.forEach((task, i) => {
    const note = notes[i] ?? '';
    assert(!note.includes('PAGE-DUMP'), \`the note for \${task.id} carries the subagent's transcript (\${note.length} characters): keep only the condensed findings\`);
    assert.equal(note, \`[\${task.id}] \${findings(task.id, 6000).slice(0, 4000)}\`, \`the note for \${task.id} is \${note.length} characters, expected '[\${task.id}] ' and the findings cut to MAX_FINDINGS_CHARS = 4000\`);
  });
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	pb "research/gen/research_orchestrator"
	"research/jobs"

	"leetbuild/harness"
)

var (
	leadBg        = context.Background()
	factBudget    = jobs.Budget{MaxSubagents: 1, MaxToolCalls: 10, TokenBudget: 50000}
	compareBudget = jobs.Budget{MaxSubagents: 4, MaxToolCalls: 60, TokenBudget: 250000}
	deepBudget    = jobs.Budget{MaxSubagents: 10, MaxToolCalls: 150, TokenBudget: 1000000}
	transcript    = strings.Repeat("PAGE-DUMP annual report 2024, page 1 of 300. ", 1000)
)

func testPlan(n int) []jobs.Task {
	plan := make([]jobs.Task, n)
	for i := range plan {
		plan[i] = jobs.Task{
			ID: fmt.Sprintf("t-%d", i+1), Objective: fmt.Sprintf("Find the board members of bank %d", i+1),
			OutputFormat: "one line per member: name, role, since", Tools: []string{"search", "fetch"},
			Boundaries: "annual reports from 2024 on; skip news coverage",
		}
	}
	return plan
}

func findingsOf(taskID string, size int) string {
	return strings.Repeat(taskID+": chair, CEO and nine non-executive directors; ", 200)[:size]
}

// subagentPeer answers every task; a 10 s latency makes the calls' start times show how many ran together.
type subagentPeer struct {
	pb.UnimplementedSubagentServer
	size int
}

func (p *subagentPeer) Run(_ context.Context, req *pb.RunRequest) (*pb.RunReply, error) {
	return &pb.RunReply{Findings: findingsOf(req.GetTaskId(), p.size), Transcript: transcript, Tokens: 1200}, nil
}

func lead(ctx *harness.Ctx, size int) {
	pb.RegisterSubagentServer(ctx.GRPC.Server(""), &subagentPeer{size: size})
	ctx.GRPC.SetLatency("Run", 10, "")
}

// peak is the most calls (from the n-th on) that started at the same instant.
func peak(ctx *harness.Ctx, from int) int {
	counts := map[time.Time]int{}
	best := 0
	for _, c := range ctx.GRPC.CallsTo("Run", "")[from:] {
		counts[c.Started]++
		best = max(best, counts[c.Started])
	}
	return best
}

func ran(ctx *harness.Ctx) []string {
	var ids []string
	for _, c := range ctx.GRPC.CallsTo("Run", "") {
		ids = append(ids, c.Request.(*pb.RunRequest).GetTaskId())
	}
	sort.Strings(ids)
	return ids
}

func CheckParallel(ctx *harness.Ctx) {
	lead(ctx, 120)
	notes := runSubagents(leadBg, "job-1", testPlan(10), deepBudget)
	ctx.Equal(len(notes), 10, "a deep job over a plan of 10 tasks; the notes")
	ctx.Equal(peak(ctx, 0), 5, "subagents must run in parallel batches of maxParallelSubagents = 5; the most that started together on a deep job of 10 tasks")
	before := len(ctx.GRPC.CallsTo("Run", ""))
	runSubagents(leadBg, "job-2", testPlan(4), compareBudget)
	ctx.Equal(peak(ctx, before), 4, "a compare job (MaxSubagents 4) must run its 4 together; the most that started together")
}

func CheckFanoutCap(ctx *harness.Ctx) {
	lead(ctx, 120)
	notes := runSubagents(leadBg, "job-1", testPlan(12), compareBudget)
	ctx.Equal(ran(ctx), []string{"t-1", "t-2", "t-3", "t-4"}, "a planner that returned 12 tasks on a budget of 4 subagents: run only the first MaxSubagents tasks; the tasks run")
	ctx.Equal(len(notes), 4, "the notes")
	runSubagents(leadBg, "job-2", testPlan(3), factBudget)
	ctx.Equal(len(ctx.GRPC.CallsTo("Run", ""))-4, 1, "a fact job; the subagents run")
}

func CheckDeadline(ctx *harness.Ctx) {
	lead(ctx, 120)
	runSubagents(leadBg, "job-1", testPlan(3), compareBudget)
	for _, call := range ctx.GRPC.CallsTo("Run", "") {
		ctx.Assert(call.HasDeadline(), "a Subagent.Run call carries no deadline: one hung subagent holds the whole job")
		ctx.Assert(119*time.Second <= call.Timeout && call.Timeout <= 121*time.Second, "a Subagent.Run call carries a %v deadline, expected subagentDeadline = 120 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Run", 600, "")
	started := ctx.Clock.Now()
	notes := runSubagents(leadBg, "job-2", testPlan(2), compareBudget)
	waited := float64(ctx.Clock.Now()-started) / 1000
	for _, note := range notes {
		ctx.Assert(strings.Contains(note, "no result"), "a subagent that hangs for 600 s gave the note %.60q: after 120 s it must be a 'no result' note", note)
	}
	ctx.Assert(waited <= 250, "the lead waited %.0f s for two hung subagents, expected about 120 s", waited)
}

func CheckTaskSpec(ctx *harness.Ctx) {
	lead(ctx, 120)
	plan := testPlan(3)
	runSubagents(leadBg, "job-1", plan, compareBudget)
	sent := map[string]*pb.RunRequest{}
	for _, c := range ctx.GRPC.CallsTo("Run", "") {
		req := c.Request.(*pb.RunRequest)
		sent[req.GetTaskId()] = req
	}
	for _, task := range plan {
		req, ok := sent[task.ID]
		ctx.Assert(ok, "task %s was not run", task.ID)
		got := jobs.Task{ID: req.GetTaskId(), Objective: req.GetObjective(), OutputFormat: req.GetOutputFormat(), Tools: req.GetTools(), Boundaries: req.GetBoundaries()}
		ctx.Equal(got, task, "Subagent.Run for %s must carry the whole task description", task.ID)
		ctx.Equal(req.GetJobId(), "job-1", "Subagent.Run for %s; its job_id", task.ID)
	}
}

func CheckCondense(ctx *harness.Ctx) {
	lead(ctx, 6000)
	plan := testPlan(2)
	notes := runSubagents(leadBg, "job-1", plan, compareBudget)
	ctx.Equal(len(notes), 2, "the notes")
	for i, task := range plan {
		ctx.Assert(!strings.Contains(notes[i], "PAGE-DUMP"), "the note for %s carries the subagent's transcript (%d characters): keep only the condensed findings", task.ID, len(notes[i]))
		ctx.Assert(notes[i] == "["+task.ID+"] "+findingsOf(task.ID, 6000)[:4000], "the note for %s is %d characters, expected '[%s] ' and the findings cut to maxFindingsChars = 4000", task.ID, len(notes[i]), task.ID)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <chrono>
#include <map>
#include <string>
#include <vector>

#include "research/jobs.h"
#include "research_orchestrator.grpc.pb.h"

namespace {

const jobs::Budget kFact{1, 10, 50000};
const jobs::Budget kCompare{4, 60, 250000};
const jobs::Budget kDeep{10, 150, 1000000};

std::string repeat(const std::string& s, int n) {
  std::string out;
  for (int i = 0; i < n; i++) out += s;
  return out;
}

const std::string kTranscript = repeat("PAGE-DUMP annual report 2024, page 1 of 300. ", 1000);

std::vector<jobs::Task> testPlan(int n) {
  std::vector<jobs::Task> plan;
  for (int i = 1; i <= n; i++) {
    plan.push_back({"t-" + std::to_string(i), "Find the board members of bank " + std::to_string(i), "one line per member: name, role, since",
                    {"search", "fetch"}, "annual reports from 2024 on; skip news coverage"});
  }
  return plan;
}

std::string findingsOf(const std::string& task_id, size_t size) {
  return repeat(task_id + ": chair, CEO and nine non-executive directors; ", 200).substr(0, size);
}

// Answers every task; a 10 s latency makes the calls' start times show how many ran together.
class SubagentPeer final : public researchd::Subagent::Service {
 public:
  size_t size = 120;
  grpc::Status Run(grpc::ServerContext*, const researchd::RunRequest* req, researchd::RunReply* out) override {
    out->set_findings(findingsOf(req->task_id(), size));
    out->set_transcript(kTranscript);
    out->set_tokens(1200);
    return grpc::Status::OK;
  }
};

void lead(harness::Ctx& ctx, size_t size) {
  static SubagentPeer* peer = nullptr;
  delete peer;
  peer = new SubagentPeer;
  peer->size = size;
  ctx.GRPC.Server("")->RegisterService(peer);
  ctx.GRPC.SetLatency("Run", 10);
}

// The most calls (from the n-th on) that started at the same instant.
int peak(harness::Ctx& ctx, size_t from) {
  std::map<long long, int> counts;
  int best = 0;
  const auto calls = ctx.GRPC.CallsTo("Run");
  for (size_t i = from; i < calls.size(); i++) {
    best = std::max(best, ++counts[std::chrono::duration_cast<std::chrono::milliseconds>(calls[i].Started.time_since_epoch()).count()]);
  }
  return best;
}

std::vector<std::string> ran(harness::Ctx& ctx) {
  std::vector<std::string> ids;
  for (const auto& c : ctx.GRPC.CallsTo("Run")) ids.push_back(c.Request<researchd::RunRequest>().task_id());
  std::sort(ids.begin(), ids.end());
  return ids;
}

}  // namespace

void CheckParallel(harness::Ctx& ctx) {
  lead(ctx, 120);
  const auto notes = runSubagents("job-1", testPlan(10), kDeep);
  ctx.Equal(notes.size(), 10, "a deep job over a plan of 10 tasks; the notes");
  ctx.Equal(peak(ctx, 0), 5, "subagents must run in parallel batches of kMaxParallelSubagents = 5; the most that started together on a deep job of 10 tasks");
  const size_t before = ctx.GRPC.CallsTo("Run").size();
  runSubagents("job-2", testPlan(4), kCompare);
  ctx.Equal(peak(ctx, before), 4, "a compare job (max_subagents 4) must run its 4 together; the most that started together");
}

void CheckFanoutCap(harness::Ctx& ctx) {
  lead(ctx, 120);
  const auto notes = runSubagents("job-1", testPlan(12), kCompare);
  ctx.Equal(ran(ctx), {"t-1", "t-2", "t-3", "t-4"}, "a planner that returned 12 tasks on a budget of 4 subagents: run only the first max_subagents tasks; the tasks run");
  ctx.Equal(notes.size(), 4, "the notes");
  runSubagents("job-2", testPlan(3), kFact);
  ctx.Equal(ctx.GRPC.CallsTo("Run").size() - 4, 1, "a fact job; the subagents run");
}

void CheckDeadline(harness::Ctx& ctx) {
  lead(ctx, 120);
  runSubagents("job-1", testPlan(3), kCompare);
  for (const auto& call : ctx.GRPC.CallsTo("Run")) {
    ctx.Assert(call.HasDeadline(), "a Subagent.Run call carries no deadline: one hung subagent holds the whole job");
    ctx.Assert(119 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 121, "a Subagent.Run call carries a %v s deadline, expected kSubagentDeadlineS = 120", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Run", 600);
  const int64_t started = ctx.Clock.Now();
  const auto notes = runSubagents("job-2", testPlan(2), kCompare);
  const double waited = (ctx.Clock.Now() - started) / 1000.0;
  for (const auto& note : notes) {
    ctx.Assert(note.find("no result") != std::string::npos, "a subagent that hangs for 600 s gave the note %q: after 120 s it must be a 'no result' note", note.substr(0, 60));
  }
  ctx.Assert(waited <= 250, "the lead waited %v s for two hung subagents, expected about 120 s", waited);
}

void CheckTaskSpec(harness::Ctx& ctx) {
  lead(ctx, 120);
  const auto plan = testPlan(3);
  runSubagents("job-1", plan, kCompare);
  std::map<std::string, researchd::RunRequest> sent;
  for (const auto& c : ctx.GRPC.CallsTo("Run")) {
    const auto req = c.Request<researchd::RunRequest>();
    sent[req.task_id()] = req;
  }
  for (const auto& task : plan) {
    ctx.Assert(sent.count(task.id) == 1, "task %s was not run", task.id);
    const auto& req = sent[task.id];
    const std::vector<std::string> tools(req.tools().begin(), req.tools().end());
    ctx.Assert(req.objective() == task.objective && req.output_format() == task.output_format && tools == task.tools && req.boundaries() == task.boundaries,
               "Subagent.Run for %s carried objective %q, output_format %q, tools %q, boundaries %q: send the whole task description", task.id,
               req.objective(), req.output_format(), tools, req.boundaries());
    ctx.Equal(req.job_id(), "job-1", "Subagent.Run for %s; its job_id", task.id);
  }
}

void CheckCondense(harness::Ctx& ctx) {
  lead(ctx, 6000);
  const auto plan = testPlan(2);
  const auto notes = runSubagents("job-1", plan, kCompare);
  ctx.Equal(notes.size(), 2, "the notes");
  for (size_t i = 0; i < plan.size(); i++) {
    ctx.Assert(notes[i].find("PAGE-DUMP") == std::string::npos, "the note for %s carries the subagent's transcript (%d characters): keep only the condensed findings", plan[i].id, notes[i].size());
    ctx.Assert(notes[i] == "[" + plan[i].id + "] " + findingsOf(plan[i].id, 6000).substr(0, 4000),
               "the note for %s is %d characters, expected '[%s] ' and the findings cut to kMaxFindingsChars = 4000", plan[i].id, notes[i].size(), plan[i].id);
  }
}
`,
  },
  hints: [
    'A deep job takes ten times as long as one subagent, a planner that returns twelve tasks spends twelve subagents on a budget of four, and one subagent that hangs holds the whole job.',
    'The loop awaits each `Run` before starting the next, walks the whole plan, passes no timeout, fills only `objective`, and appends `reply.transcript`, everything the subagent read, to the lead’s notes.',
    'Cut the plan to `budget["max_subagents"]`; for each batch of `min(MAX_PARALLEL_SUBAGENTS, max_subagents)` run `asyncio.gather` over `Run(…, timeout=SUBAGENT_DEADLINE_S)` with all four task fields; keep `reply.findings[:MAX_FINDINGS_CHARS]`.',
  ],
  debrief: `Fan-out is where a multi-agent system earns its speed and its bill at once, so the budget's \`max_subagents\` caps the plan before anything runs and the batch width caps how much is in flight. Batching in parallel turns ten subagent latencies into two; the deadline turns a hung subagent into a "no result" note the lead can plan around, instead of a job that never ends. The four-part task description is what keeps subagents from duplicating each other's searches. The findings cap is a context-window budget: the lead synthesises from what subagents condensed, never from what they read. Production orchestrators add per-subagent token accounting, cancel the rest of a batch when the job is cancelled, and let the lead spawn a follow-up subagent for a "no result".`,
};
