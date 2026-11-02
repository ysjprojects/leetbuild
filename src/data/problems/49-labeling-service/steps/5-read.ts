import type {Step} from '@/lib/types';

export const progressReadStep: Step = {
  id: 'read',
  title: 'GET /v1/tasks/{id}/progress: agreement without peer peeking',
  concept: 'http',
  file: 'read',
  focus: ['client', 'service', 'redis', 'quality'],
  task: `## Task

**Starting point.** The starter is \`GET /v1/tasks/{task_id}/progress\`: it loads
\`task:{task_id}\`, walks the \`items:{task_id}\` records, groups each item's \`label\` under its
annotator, and answers \`completed\`, \`total\`, one row per annotator with every label they gave,
and a per-label \`percent\` over the whole annotator pool. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** For the one-annotator demo the numbers add up. With a team
the read crosses three boundaries: visibility (a peer reads labels for items they have not
answered, a copying channel that poisons the metric), fairness (flagged annotators stay in the
denominator), and provenance (numbers from mutable item records change with the queue's in-flight
state and cannot be reproduced by a replay).

- Tenant from \`X-Tenant-Id\` (**401** when absent), caller from \`X-Annotator-Id\`. A missing task
  or another tenant's task is **404**, not 403.
- Keys: \`task:{task_id}\` (tenant, \`total_items\`), \`annotators:{task_id}\`, \`flagged:{task_id}\`
  (quality review's exclusion set), \`label.submitted:{task_id}\` (projection of applied records).
- Body: \`{"task_id", "completed", "total", "annotators": [{"annotator", "submitted", "excluded",
  "labels"}], "agreement": {"<label>": {"annotated", "percent_agreement"}}}\`; \`annotated\` counts
  **included** annotators who used the label, \`percent_agreement\` is \`100 * annotated / included\`
  to one decimal (\`0.0\` with nobody included).
- A row carries \`labels\` only for the caller or an annotator who has submitted; otherwise
  \`null\`, not \`[]\`.
- \`SISMEMBER flagged:{task_id} <annotator>\` drops an annotator from the denominator and marks the
  row \`excluded: true\`.
- \`rebuild_progress(events, total_items)\` is a pure fold over \`label.submitted:{task_id}\`; the
  endpoint serves that fold, not the item records or the consumer's counters.`,
  sequence: {
    participants: ['Client', 'labeld', 'Redis', 'Events consumer'],
    messages: [
      {
        from: 'Client',
        to: 'labeld',
        label: 'GET /v1/tasks/{task_id}/progress · X-Tenant-Id · X-Annotator-Id',
        kind: 'sync',
      },
      {from: 'labeld', to: 'labeld', label: '401 without tenant · 404 for unknown or foreign task', kind: 'sync'},
      {from: 'labeld', to: 'Redis', label: 'GET task:{task_id} · SMEMBERS annotators:{task_id}', kind: 'sync'},
      {from: 'Redis', to: 'labeld', label: 'tenant, total_items · annotator roster', kind: 'reply'},
      {from: 'labeld', to: 'Redis', label: 'LRANGE label.submitted:{task_id} 0 -1', kind: 'sync'},
      {from: 'Redis', to: 'labeld', label: 'the applied label.submitted records', kind: 'reply'},
      {from: 'labeld', to: 'labeld', label: 'rebuild_progress(events, total_items)', kind: 'sync'},
      {from: 'labeld', to: 'Redis', label: 'SISMEMBER flagged:{task_id} per annotator', kind: 'sync'},
      {from: 'Redis', to: 'labeld', label: 'excluded annotators', kind: 'reply'},
      {
        from: 'labeld',
        to: 'Client',
        label: '200 {completed, total, annotators[], agreement{}} · peer labels null',
        kind: 'reply',
      },
      {
        from: 'Events consumer',
        to: 'Redis',
        label: 'append label.submitted:{task_id} before committing',
        kind: 'async',
      },
    ],
  },
  hints: [
    "Annotator B opens the task and already sees A's labels on items B has not reached; when quality review flags C, the agreement percentage does not move; two reads minutes apart disagree although nobody submitted.",
    'Rows are built from `items:{task_id}` and every row carries its full `labels` list; nothing reads `X-Annotator-Id` or `flagged:{task_id}`; the divisor is the whole `submitted` map, and the body has no `excluded` flag.',
    'Fold `LRANGE label.submitted:{task_id} 0 -1` in `rebuild_progress`, compute the included set as submitted minus `SISMEMBER flagged`, divide by it, mark `excluded: true`, and have `visible_labels` return `None` for an unsubmitted peer.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/tasks/{id}/progress',
      detail:
        'Register the progress read on `GET /v1/tasks/{task_id}/progress` with the task id taken from the path. The starter already does this — it is the one contract it keeps — so the failures that matter start below it: tenancy, visibility, fairness and provenance.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/tasks\/\{task_id\}\/progress["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/tasks\/:task_id\/progress['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/tasks\/\{task_id\}\/progress"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"tasks"\s*\/\s*Segment\s*\/\s*"progress"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(R"\(/, /\/v1\/tasks\//, /progress\)"/, /req\.matches\[1\]/]},
      },
    },
    {
      id: 'hidden-until-submitted',
      title: 'Peer labels stay hidden until that peer submits',
      detail:
        'A row carries `labels` only for the caller (from `X-Annotator-Id`) or for an annotator who has already submitted; a peer who has not gets `null`. The starter streams every submitted label to every annotator so they can "align", so a peer can read a label before answering that item and the agreement number is computed over answers that were copied.',
      match: {
        python: {all: [/X-Annotator-Id/, /def visible_labels\(/, /return None/]},
        typescript: {all: [/X-Annotator-Id/i, /function visibleLabels\(/, /return null/]},
        go: {all: [/X-Annotator-Id/, /func visibleLabels\(/, /return nil/]},
        scala: {all: [/X-Annotator-Id/, /def visibleLabels\(/, /Option\[List\[String\]\]/]},
        cpp: {all: [/X-Annotator-Id/, /visible_labels\(/, /std::nullopt/]},
      },
    },
    {
      id: 'agreement-excludes-flagged',
      title: 'Agreement excludes annotators flagged by quality review',
      detail:
        'Every annotator the math touches is checked with `SISMEMBER` against `flagged:{task_id}`, flagged annotators leave the agreement denominator, and their row is marked `excluded: true`. The starter averages over the raw annotator pool, so one reviewer quality review has already removed still moves the percentage for the whole task.',
      match: {
        python: {all: [/sismember\(/, /f"flagged:\{task_id\}"/, /"excluded"/]},
        typescript: {all: [/sismember\(/, /`flagged:\$\{[\w]+\}`/, /excluded/]},
        go: {all: [/SIsMember\(/, /"flagged:%s"/, /Excluded/]},
        scala: {all: [/sismember\(/, /s"flagged:\$taskId"/, /excluded/]},
        cpp: {all: [/sismember\(/, /"flagged:"/, /excluded/]},
      },
    },
    {
      id: 'metrics-from-events',
      title: 'The metrics rebuild from label.submitted events alone',
      detail:
        '`rebuild_progress()` folds the task’s `label.submitted` records into completed, per-annotator and per-label metrics, and the endpoint serves that fold over the per-task projection `label.submitted:{task_id}` rather than over the item records or the consumer’s mutable counters. The starter reads labels off the mutable records, so its numbers depend on what those records happen to say and a replayed event changes nothing at all.',
      match: {
        python: {all: [/def rebuild_progress\(/, /lrange\(/, /f"label\.submitted:\{task_id\}"/]},
        typescript: {all: [/function rebuildProgress\(/, /lrange\(/, /`label\.submitted:\$\{[\w]+\}`/]},
        go: {all: [/func rebuildProgress\(/, /LRange\(/, /"label\.submitted:%s"/]},
        scala: {all: [/def rebuildProgress\(/, /lrange\(/, /s"label\.submitted:\$taskId"/]},
        cpp: {all: [/rebuild_progress\(/, /lrange\(/, /"label\.submitted:"/]},
      },
    },
    {
      id: 'progress-shape',
      title: 'Reports completion and per-label agreement',
      detail:
        'The 200 body carries `task_id`, `completed`, `total`, one `annotators` row per annotator with `annotator`/`submitted`/`excluded`/`labels`, and an `agreement` block per label with `annotated` and `percent_agreement`. The starter has no `excluded` flag and reports a bare `percent`, so a client cannot tell a dropped annotator from a counted one and cannot reconcile the percentage against the roster.',
      match: {
        python: {
          all: [
            /["']task_id["']/,
            /["']completed["']/,
            /["']annotators["']/,
            /["']excluded["']/,
            /["']percent_agreement["']/,
          ],
        },
        typescript: {all: [/task_id/, /completed/, /annotators/, /excluded/, /percent_agreement/]},
        go: {all: [/"task_id"/, /"completed"/, /"annotators"/, /"excluded"/, /"percent_agreement"/]},
        scala: {all: [/task_id/, /completed/, /annotators/, /excluded/, /percent_agreement/]},
        cpp: {all: [/"task_id"/, /"completed"/, /"annotators"/, /"excluded"/, /"percent_agreement"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/tasks/{task_id}/progress")
def progress(task_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    task = json.loads(r.get(f"task:{task_id}") or "{}")
    items = r.hgetall(f"items:{task_id}")
    submitted: dict[str, list[str]] = {}
    for raw in items.values():
        item = json.loads(raw)
        if item["label"] is None:
            continue
        submitted.setdefault(item["annotator"], []).append(item["label"])
    per_label: dict[str, int] = {}
    for labels in submitted.values():
        for label in labels:
            per_label[label] = per_label.get(label, 0) + 1
    rows = [
        {"annotator": ann, "submitted": len(labels), "labels": labels}
        for ann, labels in sorted(submitted.items())
    ]
    return JSONResponse(
        {
            "task_id": task_id,
            "completed": len(submitted),
            "total": task.get("total_items", len(items)),
            "annotators": rows,
            "agreement": {
                label: {"annotated": n, "percent": round(100 * n / max(len(submitted), 1), 1)}
                for label, n in sorted(per_label.items())
            },
        },
        status_code=200,
    )
`,
      solution: `import json

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def rebuild_progress(events: list[dict], total_items: int) -> dict:
    """Fold the task's label.submitted records into completion, annotator and agreement metrics.

    Every record is one accepted submission — label_id, item_id, annotator, values, spec_version,
    ms_spent — and the fold reads only what it needs: the item, the annotator and the values.
    """
    items: set[str] = set()
    per_annotator: dict[str, dict] = {}
    per_label: dict[str, set[str]] = {}
    for event in events:
        items.add(event["item_id"])
        stats = per_annotator.setdefault(event["annotator"], {"submitted": 0, "labels": []})
        stats["submitted"] += 1
        stats["labels"].extend(event["values"])
        for value in event["values"]:
            per_label.setdefault(value, set()).add(event["annotator"])
    return {
        "completed": len(items),
        "total": total_items,
        "annotators": per_annotator,
        "per_label": per_label,
    }


def visible_labels(
    annotator: str, caller: str | None, submitted: set[str], labels: list[str]
) -> list[str] | None:
    """A peer's labels stay hidden until that peer has submitted."""
    if annotator == caller or annotator in submitted:
        return labels
    return None


def agreement(included: set[str], per_label: dict[str, set[str]]) -> dict[str, dict]:
    """Share of the included annotators that used each label at least once."""
    total = len(included)
    return {
        label: {
            "annotated": len(annotators & included),
            "percent_agreement": round(100.0 * len(annotators & included) / total, 1) if total else 0.0,
        }
        for label, annotators in sorted(per_label.items())
    }


@app.get("/v1/tasks/{task_id}/progress")
def progress(
    task_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    annotator: str | None = Header(default=None, alias="X-Annotator-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail={"error": "missing X-Tenant-Id"})
    raw_task = r.get(f"task:{task_id}")
    if raw_task is None:
        raise HTTPException(status_code=404, detail={"error": "not found"})
    task = json.loads(raw_task)
    # 404, not 403: a foreign task must be indistinguishable from one that does not exist.
    if task["tenant"] != tenant:
        raise HTTPException(status_code=404, detail={"error": "not found"})

    # The projection is the input, not the item records: same events in, same metrics out.
    events = [json.loads(raw) for raw in r.lrange(f"label.submitted:{task_id}", 0, -1)]
    metrics = rebuild_progress(events, task["total_items"])

    submitted = set(metrics["annotators"])
    roster = set(r.smembers(f"annotators:{task_id}")) | submitted
    if annotator:
        roster.add(annotator)
    flagged = {ann for ann in roster if r.sismember(f"flagged:{task_id}", ann)}
    included = submitted - flagged

    rows = []
    for ann in sorted(roster):
        stats = metrics["annotators"].get(ann, {"submitted": 0, "labels": []})
        rows.append(
            {
                "annotator": ann,
                "submitted": stats["submitted"],
                "excluded": ann in flagged,
                "labels": visible_labels(ann, annotator, submitted, stats["labels"]),
            }
        )
    return JSONResponse(
        {
            "task_id": task_id,
            "completed": metrics["completed"],
            "total": metrics["total"],
            "annotators": rows,
            "agreement": agreement(included, metrics["per_label"]),
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** A progress read: every submitted label, for everyone who asks. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

app.get('/v1/tasks/:task_id/progress', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {task_id} = request.params as {task_id: string};

  const rawTask = await r.get(\`task:\${task_id}\`);
  if (rawTask === null) return reply.code(404).send({error: 'not found'});
  const task = JSON.parse(rawTask) as {tenant: string; total_items: number};

  const items = await r.hgetall(\`items:\${task_id}\`);
  const submitted: Record<string, string[]> = {};
  for (const raw of Object.values(items)) {
    const item = JSON.parse(raw) as {annotator: string; label: string | null};
    if (item.label === null) continue;
    (submitted[item.annotator] ??= []).push(item.label);
  }
  const perLabel: Record<string, number> = {};
  for (const labels of Object.values(submitted)) for (const label of labels) perLabel[label] = (perLabel[label] ?? 0) + 1;
  const rows = Object.entries(submitted).map(([annotator, labels]) => ({
    annotator,
    submitted: labels.length,
    labels,
  }));
  const agreement: Record<string, {annotated: number; percent: number}> = {};
  for (const [label, annotated] of Object.entries(perLabel)) {
    agreement[label] = {annotated, percent: Math.round((100 * annotated) / Math.max(rows.length, 1) * 10) / 10};
  }
  return reply
    .code(200)
    .send({task_id, completed: rows.length, total: task.total_items, annotators: rows, agreement});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/tasks/{task_id}/progress: completion and agreement without showing a peer's labels. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface LabelEvent {
  label_id: string;
  item_id: string;
  annotator: string;
  values: string[];
}

interface AnnotatorStats {
  submitted: number;
  labels: string[];
}

interface ProgressMetrics {
  completed: number;
  total: number;
  annotators: Map<string, AnnotatorStats>;
  per_label: Map<string, Set<string>>;
}

/** Pure fold: the same label.submitted records always produce the same metrics. */
function rebuildProgress(events: LabelEvent[], totalItems: number): ProgressMetrics {
  const items = new Set<string>();
  const annotators = new Map<string, AnnotatorStats>();
  const perLabel = new Map<string, Set<string>>();
  for (const event of events) {
    items.add(event.item_id);
    const stats = annotators.get(event.annotator) ?? {submitted: 0, labels: []};
    stats.submitted += 1;
    stats.labels.push(...event.values);
    annotators.set(event.annotator, stats);
    for (const value of event.values) {
      const seen = perLabel.get(value) ?? new Set<string>();
      seen.add(event.annotator);
      perLabel.set(value, seen);
    }
  }
  return {completed: items.size, total: totalItems, annotators, per_label: perLabel};
}

/** A peer's labels stay hidden until that peer has submitted. */
function visibleLabels(
  annotator: string,
  caller: string | undefined,
  submitted: Set<string>,
  labels: string[],
): string[] | null {
  if (annotator === caller || submitted.has(annotator)) return labels;
  return null;
}

app.get('/v1/tasks/:task_id/progress', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const rawCaller = request.headers['x-annotator-id'];
  const caller = typeof rawCaller === 'string' && rawCaller !== '' ? rawCaller : undefined;
  const {task_id} = request.params as {task_id: string};

  const rawTask = await r.get(\`task:\${task_id}\`);
  if (rawTask === null) return reply.code(404).send({error: 'not found'});
  const task = JSON.parse(rawTask) as {tenant: string; total_items: number};
  // 404, not 403: a foreign task must be indistinguishable from one that does not exist.
  if (task.tenant !== tenant) return reply.code(404).send({error: 'not found'});

  // The projection is the input, not the item records: same events in, same metrics out.
  const events = (await r.lrange(\`label.submitted:\${task_id}\`, 0, -1)).map(raw => JSON.parse(raw) as LabelEvent);
  const metrics = rebuildProgress(events, task.total_items);

  const submitted = new Set(metrics.annotators.keys());
  const roster = new Set<string>([...(await r.smembers(\`annotators:\${task_id}\`)), ...submitted]);
  if (caller !== undefined) roster.add(caller);
  const flagged = new Set<string>();
  for (const annotator of roster) {
    if (await r.sismember(\`flagged:\${task_id}\`, annotator)) flagged.add(annotator);
  }
  const included = new Set([...submitted].filter(annotator => !flagged.has(annotator)));

  const annotators = [...roster].sort().map(annotator => {
    const stats = metrics.annotators.get(annotator) ?? {submitted: 0, labels: []};
    return {
      annotator,
      submitted: stats.submitted,
      excluded: flagged.has(annotator),
      labels: visibleLabels(annotator, caller, submitted, stats.labels),
    };
  });
  const denominator = included.size;
  const agreement: Record<string, {annotated: number; percent_agreement: number}> = {};
  for (const [label, users] of metrics.per_label) {
    const annotated = [...users].filter(annotator => included.has(annotator)).length;
    agreement[label] = {
      annotated,
      percent_agreement: denominator === 0 ? 0 : Math.round((100 * annotated) / denominator * 10) / 10,
    };
  }
  return reply
    .code(200)
    .send({task_id, completed: metrics.completed, total: metrics.total, annotators, agreement});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
)

func progress(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	taskID := r.PathValue("task_id")
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	rawTask, err := rdb.Get(r.Context(), fmt.Sprintf("task:%s", taskID)).Result()
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	var task struct {
		TotalItems int \`json:"total_items"\`
	}
	_ = json.Unmarshal([]byte(rawTask), &task)

	items, _ := rdb.HGetAll(r.Context(), fmt.Sprintf("items:%s", taskID)).Result()
	submitted := map[string][]string{}
	for _, raw := range items {
		var item struct {
			Annotator string  \`json:"annotator"\`
			Label     *string \`json:"label"\`
		}
		_ = json.Unmarshal([]byte(raw), &item)
		if item.Label == nil {
			continue
		}
		submitted[item.Annotator] = append(submitted[item.Annotator], *item.Label)
	}
	type row struct {
		Annotator string   \`json:"annotator"\`
		Submitted int      \`json:"submitted"\`
		Labels    []string \`json:"labels"\`
	}
	rows := make([]row, 0, len(submitted))
	perLabel := map[string]int{}
	for annotator, labels := range submitted {
		rows = append(rows, row{Annotator: annotator, Submitted: len(labels), Labels: labels})
		for _, label := range labels {
			perLabel[label]++
		}
	}
	agreement := map[string]map[string]any{}
	for label, annotated := range perLabel {
		agreement[label] = map[string]any{
			"annotated": annotated,
			"percent":   100 * float64(annotated) / float64(len(rows)+1),
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"task_id":    taskID,
		"completed":  len(rows),
		"total":      task.TotalItems,
		"annotators": rows,
		"agreement":  agreement,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/tasks/{task_id}/progress", progress)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"sort"

	"github.com/redis/go-redis/v9"
)

type LabelEvent struct {
	LabelID   string   \`json:"label_id"\`
	ItemID    string   \`json:"item_id"\`
	Annotator string   \`json:"annotator"\`
	Values    []string \`json:"values"\`
}

type AnnotatorStats struct {
	Submitted int      \`json:"submitted"\`
	Labels    []string \`json:"labels"\`
}

type ProgressMetrics struct {
	Completed  int
	Total      int
	Annotators map[string]*AnnotatorStats
	PerLabel   map[string]map[string]bool
}

// rebuildProgress folds a task's label.submitted records into completion, annotator and agreement
// metrics: the same records always produce the same numbers.
func rebuildProgress(events []LabelEvent, totalItems int) ProgressMetrics {
	items := map[string]bool{}
	annotators := map[string]*AnnotatorStats{}
	perLabel := map[string]map[string]bool{}
	for _, event := range events {
		items[event.ItemID] = true
		stats, ok := annotators[event.Annotator]
		if !ok {
			stats = &AnnotatorStats{}
			annotators[event.Annotator] = stats
		}
		stats.Submitted++
		stats.Labels = append(stats.Labels, event.Values...)
		for _, value := range event.Values {
			if perLabel[value] == nil {
				perLabel[value] = map[string]bool{}
			}
			perLabel[value][event.Annotator] = true
		}
	}
	return ProgressMetrics{Completed: len(items), Total: totalItems, Annotators: annotators, PerLabel: perLabel}
}

// visibleLabels keeps a peer's labels hidden until that peer has submitted: a nil pointer becomes
// JSON null, which is a different answer from an empty list.
func visibleLabels(annotator, caller string, submitted map[string]bool, labels []string) *[]string {
	if annotator == caller || submitted[annotator] {
		return &labels
	}
	return nil
}

type annotatorRow struct {
	Annotator string    \`json:"annotator"\`
	Submitted int       \`json:"submitted"\`
	Excluded  bool      \`json:"excluded"\`
	Labels    *[]string \`json:"labels"\`
}

func progress(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	caller := r.Header.Get("X-Annotator-Id")
	taskID := r.PathValue("task_id")

	rawTask, err := rdb.Get(r.Context(), fmt.Sprintf("task:%s", taskID)).Result()
	if errors.Is(err, redis.Nil) {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "task store unavailable"})
		return
	}
	var task struct {
		Tenant     string \`json:"tenant"\`
		TotalItems int    \`json:"total_items"\`
	}
	if err := json.Unmarshal([]byte(rawTask), &task); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "corrupt task record"})
		return
	}
	// 404, not 403: a foreign task must be indistinguishable from one that does not exist.
	if task.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}

	// The projection is the input, not the item records: same events in, same metrics out.
	rawEvents, err := rdb.LRange(r.Context(), fmt.Sprintf("label.submitted:%s", taskID), 0, -1).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "event projection unavailable"})
		return
	}
	events := make([]LabelEvent, 0, len(rawEvents))
	for _, raw := range rawEvents {
		var event LabelEvent
		if err := json.Unmarshal([]byte(raw), &event); err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "corrupt event"})
			return
		}
		events = append(events, event)
	}
	metrics := rebuildProgress(events, task.TotalItems)

	names, err := rdb.SMembers(r.Context(), fmt.Sprintf("annotators:%s", taskID)).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "roster unavailable"})
		return
	}
	roster := map[string]bool{}
	for _, annotator := range names {
		roster[annotator] = true
	}
	submitted := map[string]bool{}
	for annotator := range metrics.Annotators {
		roster[annotator] = true
		submitted[annotator] = true
	}
	if caller != "" {
		roster[caller] = true
	}

	flagged := map[string]bool{}
	for annotator := range roster {
		member, err := rdb.SIsMember(r.Context(), fmt.Sprintf("flagged:%s", taskID), annotator).Result()
		if err == nil && member {
			flagged[annotator] = true
		}
	}
	included := map[string]bool{}
	for annotator := range submitted {
		if !flagged[annotator] {
			included[annotator] = true
		}
	}

	ordered := make([]string, 0, len(roster))
	for annotator := range roster {
		ordered = append(ordered, annotator)
	}
	sort.Strings(ordered)
	rows := make([]annotatorRow, 0, len(ordered))
	for _, annotator := range ordered {
		stats := metrics.Annotators[annotator]
		if stats == nil {
			stats = &AnnotatorStats{}
		}
		rows = append(rows, annotatorRow{
			Annotator: annotator,
			Submitted: stats.Submitted,
			Excluded:  flagged[annotator],
			Labels:    visibleLabels(annotator, caller, submitted, stats.Labels),
		})
	}

	agreement := map[string]map[string]any{}
	for label, users := range metrics.PerLabel {
		annotated := 0
		for annotator := range users {
			if included[annotator] {
				annotated++
			}
		}
		percent := 0.0
		if len(included) > 0 {
			percent = math.Round(100*float64(annotated)/float64(len(included))*10) / 10
		}
		agreement[label] = map[string]any{"annotated": annotated, "percent_agreement": percent}
	}

	writeJSON(rw, http.StatusOK, map[string]any{
		"task_id":    taskID,
		"completed":  metrics.Completed,
		"total":      metrics.Total,
		"annotators": rows,
		"agreement":  agreement,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/tasks/{task_id}/progress", progress)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._

import scala.jdk.CollectionConverters._

object ProgressApi {
  implicit val system: ActorSystem = ActorSystem("labeld")

  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "tasks" / Segment / "progress") { taskId =>
      get {
        headerValueByName("X-Tenant-Id") { _ =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          val items = jedis.hgetAll(s"items:$taskId").asScala
          val submitted: Map[String, List[String]] = items.values
            .map(raw => raw.parseJson.asJsObject)
            .filter(item => item.fields("label") != JsNull)
            .groupBy(item => item.fields("annotator").convertTo[String])
            .view
            .mapValues(rows => rows.map(item => item.fields("label").convertTo[String]).toList)
            .toMap
          val perLabel = submitted.values.flatten.groupBy(identity).view.mapValues(_.size).toMap
          val rows = submitted.toList.sortBy(_._1).map { case (annotator, labels) =>
            JsObject(
              "annotator" -> JsString(annotator),
              "submitted" -> JsNumber(labels.size),
              "labels" -> labels.toJson,
            )
          }
          val denominator = if (rows.isEmpty) 1 else rows.size
          val agreement = perLabel.toList.sortBy(_._1).map { case (label, annotated) =>
            label -> JsObject(
              "annotated" -> JsNumber(annotated),
              "percent" -> JsNumber(math.round(1000.0 * annotated / denominator) / 10.0),
            )
          }
          complete(
            StatusCodes.OK,
            JsObject(
              "task_id" -> JsString(taskId),
              "completed" -> JsNumber(rows.size),
              "total" -> JsNumber(items.size),
              "annotators" -> JsArray(rows.toVector),
              "agreement" -> JsObject(agreement.toMap),
            ).compactPrint,
          )
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

import scala.jdk.CollectionConverters._

final case class AnnotatorStats(submitted: Int, labels: List[String])
final case class AnnotatorRow(annotator: String, submitted: Int, excluded: Boolean, labels: Option[List[String]])
final case class LabelAgreement(annotated: Int, percent_agreement: Double)
final case class TaskProgress(
    task_id: String,
    completed: Int,
    total: Int,
    annotators: List[AnnotatorRow],
    agreement: Map[String, LabelAgreement],
)

final case class ProgressMetrics(
    completed: Int,
    total: Int,
    annotators: Map[String, AnnotatorStats],
    per_label: Map[String, Set[String]],
)

object ProgressApi {
  implicit val system: ActorSystem = ActorSystem("labeld")
  implicit val statsFormat: RootJsonFormat[AnnotatorStats] = jsonFormat2(AnnotatorStats)
  implicit val rowFormat: RootJsonFormat[AnnotatorRow] = jsonFormat4(AnnotatorRow)
  implicit val agreementFormat: RootJsonFormat[LabelAgreement] = jsonFormat2(LabelAgreement)
  implicit val progressFormat: RootJsonFormat[TaskProgress] = jsonFormat5(TaskProgress)

  val jedis = new Jedis("redis", 6379)

  /** Pure fold: the same label.submitted records always yield the same metrics. */
  def rebuildProgress(events: List[JsObject], totalItems: Int): ProgressMetrics = {
    val completed = events.flatMap(_.fields.get("item_id")).map(_.convertTo[String]).distinct.size
    val annotators = events
      .groupBy(_.fields("annotator").convertTo[String])
      .view
      .mapValues(records => AnnotatorStats(records.size, records.flatMap(_.fields("values").convertTo[List[String]])))
      .toMap
    val perLabel = events
      .flatMap { record =>
        val annotator = record.fields("annotator").convertTo[String]
        record.fields("values").convertTo[List[String]].map(value => value -> annotator)
      }
      .groupBy(_._1)
      .view
      .mapValues(_.map(_._2).toSet)
      .toMap
    ProgressMetrics(completed, totalItems, annotators, perLabel)
  }

  /** visibleLabels keeps a peer's labels hidden until that peer has submitted. */
  def visibleLabels(
      annotator: String,
      caller: Option[String],
      submitted: Set[String],
      labels: List[String],
  ): Option[List[String]] =
    if (caller.contains(annotator) || submitted.contains(annotator)) Some(labels) else None

  val route: Route =
    path("v1" / "tasks" / Segment / "progress") { taskId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("X-Annotator-Id") { callerOpt =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              val tenant = tenantOpt.get
              val rawTask = Option(jedis.get(s"task:$taskId"))
              rawTask match {
                case None => complete(StatusCodes.NotFound, """{"error":"not found"}""")
                case Some(raw) =>
                  val task = raw.parseJson.asJsObject
                  // 404, not 403: a foreign task must be indistinguishable from one that does not exist.
                  if (task.fields("tenant").convertTo[String] != tenant) {
                    complete(StatusCodes.NotFound, """{"error":"not found"}""")
                  } else {
                    // The projection is the input, not the item records: same events in, same metrics out.
                    val events = jedis.lrange(s"label.submitted:$taskId", 0, -1).asScala.toList.map(_.parseJson.asJsObject)
                    val metrics = rebuildProgress(events, task.fields("total_items").convertTo[Int])
                    val submitted = metrics.annotators.keySet
                    val roster = jedis.smembers(s"annotators:$taskId").asScala.toSet ++ submitted ++ callerOpt.toSet
                    val flagged = roster.filter(annotator => jedis.sismember(s"flagged:$taskId", annotator))
                    val included = submitted -- flagged
                    val rows = roster.toList.sorted.map { annotator =>
                      val stats = metrics.annotators.getOrElse(annotator, AnnotatorStats(0, Nil))
                      AnnotatorRow(
                        annotator,
                        stats.submitted,
                        flagged.contains(annotator),
                        visibleLabels(annotator, callerOpt, submitted, stats.labels),
                      )
                    }
                    val agreement = metrics.per_label.toList.sortBy(_._1).map { case (label, users) =>
                      val annotated = users.count(included.contains)
                      val percent =
                        if (included.isEmpty) 0.0 else math.round(1000.0 * annotated / included.size) / 10.0
                      label -> LabelAgreement(annotated, percent)
                    }.toMap
                    complete(StatusCodes.OK, TaskProgress(taskId, metrics.completed, metrics.total, rows, agreement))
                  }
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <map>
#include <string>
#include <vector>

using json = nlohmann::json;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get(R"(/v1/tasks/([^/]+)/progress)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string task_id = req.matches[1];
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const auto raw_task = redis.get("task:" + task_id);
    if (!raw_task) {
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }
    const auto task = json::parse(*raw_task, nullptr, false);

    const auto items = redis.hgetall("items:" + task_id);
    std::map<std::string, std::vector<std::string>> submitted;
    for (const auto& [item_id, raw] : items) {
      const auto item = json::parse(raw, nullptr, false);
      if (!item.is_object()) continue;
      const auto label = item.value("label", std::string());
      if (label.empty()) continue;
      submitted[item.value("annotator", std::string())].push_back(label);
    }
    json rows = json::array();
    std::map<std::string, int> per_label;
    for (const auto& [annotator, labels] : submitted) {
      rows.push_back(json{{"annotator", annotator}, {"submitted", labels.size()}, {"labels", labels}});
      for (const auto& label : labels) per_label[label] += 1;
    }
    json agreement = json::object();
    for (const auto& [label, annotated] : per_label)
      agreement[label] = json{
          {"annotated", annotated},
          {"percent", 100.0 * annotated / std::max<int>(static_cast<int>(rows.size()), 1)},
      };
    res.status = 200;
    res.set_content(
        json{{"task_id", task_id},
             {"completed", rows.size()},
             {"total", task.value("total_items", static_cast<int>(items.size()))},
             {"annotators", rows},
             {"agreement", agreement}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cmath>
#include <iterator>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

struct LabelEvent {
  std::string label_id;
  std::string item_id;
  std::string annotator;
  std::vector<std::string> values;
};

struct AnnotatorStats {
  int submitted = 0;
  std::vector<std::string> labels;
};

struct ProgressMetrics {
  int completed = 0;
  int total = 0;
  std::map<std::string, AnnotatorStats> annotators;
  std::map<std::string, std::set<std::string>> per_label;
};

// rebuild_progress folds a task's label.submitted records into completion, annotator and agreement
// metrics: the same records always produce the same numbers.
ProgressMetrics rebuild_progress(const std::vector<LabelEvent>& events, int total_items) {
  ProgressMetrics metrics;
  metrics.total = total_items;
  std::set<std::string> items;
  for (const auto& record : events) {
    items.insert(record.item_id);
    auto& stats = metrics.annotators[record.annotator];
    stats.submitted += 1;
    stats.labels.insert(stats.labels.end(), record.values.begin(), record.values.end());
    for (const auto& value : record.values) metrics.per_label[value].insert(record.annotator);
  }
  metrics.completed = static_cast<int>(items.size());
  return metrics;
}

// visible_labels keeps a peer's labels hidden until that peer has submitted: nullopt becomes JSON
// null, which is a different answer from an empty list.
std::optional<std::vector<std::string>> visible_labels(
    const std::string& annotator,
    const std::optional<std::string>& caller,
    const std::set<std::string>& submitted,
    const std::vector<std::string>& labels) {
  if ((caller && *caller == annotator) || submitted.count(annotator) > 0) return labels;
  return std::nullopt;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get(R"(/v1/tasks/([^/]+)/progress)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto raw_caller = req.get_header_value("X-Annotator-Id");
    const std::optional<std::string> caller =
        raw_caller.empty() ? std::nullopt : std::optional<std::string>(raw_caller);
    const std::string task_id = req.matches[1];

    const auto raw_task = redis.get("task:" + task_id);
    if (!raw_task) {
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }
    const auto task = json::parse(*raw_task, nullptr, false);
    // 404, not 403: a foreign task must be indistinguishable from one that does not exist.
    if (!task.is_object() || task.value("tenant", std::string()) != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }

    // The projection is the input, not the item records: same events in, same metrics out.
    std::vector<LabelEvent> events;
    for (const auto& raw : redis.lrange("label.submitted:" + task_id, 0, -1)) {
      const auto record = json::parse(raw, nullptr, false);
      if (!record.is_object()) continue;
      events.push_back(LabelEvent{record.value("label_id", std::string()),
                                  record.value("item_id", std::string()),
                                  record.value("annotator", std::string()),
                                  record.value("values", std::vector<std::string>{})});
    }
    const auto metrics = rebuild_progress(events, task.value("total_items", 0));

    std::set<std::string> roster;
    redis.smembers("annotators:" + task_id, std::inserter(roster, roster.end()));
    std::set<std::string> submitted;
    for (const auto& [annotator, stats] : metrics.annotators) {
      roster.insert(annotator);
      submitted.insert(annotator);
    }
    if (caller) roster.insert(*caller);

    std::set<std::string> flagged;
    for (const auto& annotator : roster)
      if (redis.sismember("flagged:" + task_id, annotator)) flagged.insert(annotator);
    std::set<std::string> included;
    std::set_difference(
        submitted.begin(), submitted.end(), flagged.begin(), flagged.end(), std::inserter(included, included.end()));

    json rows = json::array();
    for (const auto& annotator : roster) {
      const auto stats = metrics.annotators.count(annotator) > 0 ? metrics.annotators.at(annotator) : AnnotatorStats{};
      const auto labels = visible_labels(annotator, caller, submitted, stats.labels);
      rows.push_back(json{{"annotator", annotator},
                          {"submitted", stats.submitted},
                          {"excluded", flagged.count(annotator) > 0},
                          {"labels", labels ? json(*labels) : json(nullptr)}});
    }

    json agreement = json::object();
    for (const auto& [label, users] : metrics.per_label) {
      int annotated = 0;
      for (const auto& annotator : users)
        if (included.count(annotator) > 0) annotated += 1;
      const double percent =
          included.empty() ? 0.0 : std::round(100.0 * annotated / static_cast<double>(included.size()) * 10) / 10;
      agreement[label] = json{{"annotated", annotated}, {"percent_agreement", percent}};
    }

    res.status = 200;
    res.set_content(json{{"task_id", task_id},
                         {"completed", metrics.completed},
                         {"total", metrics.total},
                         {"annotators", rows},
                         {"agreement", agreement}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The progress endpoint is the only place one annotator can see another's judgment, so a peer's labels are \`null\` until that peer has submitted: an empty list would blur "has not answered" into "answered nothing", and a shared label turns the queue into a copying exercise that poisons the number the endpoint reports. The \`flagged:{task_id}\` veto has to reach the denominator, not only the display, and \`excluded: true\` keeps the removal auditable. Provenance is the subtle one: item records change with the in-flight state of the queue, and the consumer's counters freeze in the flags that existed when they moved, while a pure fold over the projection is the same for every reader and every replay. Production systems cache that fold per task, versioned by the last applied record.`,
};
