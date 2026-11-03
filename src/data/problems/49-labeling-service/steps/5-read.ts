import type {Step} from '@/lib/types';

export const progressReadStep: Step = {
  id: 'read',
  title: 'GET /v1/tasks/{id}/progress: agreement without peer peeking',
  concept: 'http',
  file: 'read',
  focus: ['client', 'service', 'redis', 'quality'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/tasks/{task_id}/progress\` for a task step 1 created:
401 without \`X-Tenant-Id\`, 404 for an unknown task; it folds \`store.labels_of(task_id)\` per
annotator and per item and answers \`{task_id, total, completed, agreement, annotators: [{annotator,
submitted, labels}]}\`. An item is completed once \`overlap\` annotators labeled it; \`agreement\` is
the mean share of the majority value over the items labeled at least twice. It serves the demo and
hides three flaws.

**Failure mode the checks target.** Another tenant reads a task by guessing its id; an annotator
sees what peers answered before labeling and copies it, so agreement measures copying; and an
annotator quality review flagged as a spammer still counts, dragging agreement and completion along.

- A task of another tenant is **404**, as an unknown one.
- \`labels\` (item id → value) is filled on the caller's own row only (\`X-Annotator-Id\`); every
  other row has \`labels: null\`.
- Annotators in \`store.flagged(task_id)\` stay listed with \`excluded: true\` (everyone else
  \`false\`) and count toward neither \`completed\` nor \`agreement\` (3 decimal places; \`null\` when no
  item has two labels).`,
  sequence: {
    participants: ['Annotator', 'labeld', 'task store'],
    messages: [
      {
        from: 'Annotator',
        to: 'labeld',
        label: 'GET /v1/tasks/{id}/progress · X-Tenant-Id · X-Annotator-Id',
        kind: 'sync',
      },
      {from: 'labeld', to: 'task store', label: 'get_task(id) → 404 when missing or another tenant’s', kind: 'sync'},
      {from: 'labeld', to: 'task store', label: 'labels_of(id) · flagged(id)', kind: 'sync'},
      {from: 'labeld', to: 'labeld', label: 'completed and agreement over the included annotators', kind: 'sync'},
      {from: 'labeld', to: 'Annotator', label: '200 · own labels only · flagged rows excluded', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/tasks/{id}/progress',
      detail: 'Register the progress read on `GET /v1/tasks/{task_id}/progress`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/tasks\/\{\w+\}\/progress["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/tasks\/:\w+\/progress['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/tasks\/\{\w+\}\/progress"/]},
        scala: {all: [/"tasks"\s*\/\s*Segment\s*\/\s*"progress"/]},
        cpp: {all: [/svr\.Get\([^\n]*\/progress/]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Another tenant's task is 404",
      detail:
        "The task's tenant is compared with `X-Tenant-Id` and a mismatch answers **404**, as an unknown id does, so a guessed id reveals nothing. The starter serves any tenant's task.",
      match: {
        python: {all: [/task\[["']tenant["']\]\s*!=|!=\s*task\[["']tenant["']\]/]},
        typescript: {all: [/task\.tenant\s*!==|!==\s*task\.tenant/]},
        go: {all: [/task\.Tenant\s*!=|!=\s*task\.Tenant/]},
        scala: {all: [/\.tenant\s*[!=]=\s*tenant\b|\btenant\s*[!=]=\s*\w+\.tenant/]},
        cpp: {all: [/task->tenant\s*!=|!=\s*task->tenant/]},
      },
    },
    {
      id: 'blind-peers',
      title: "Shows the caller's own labels only",
      detail:
        "`labels` is filled for the row of the caller (`X-Annotator-Id`) and `null` on every other row, so nobody can copy a peer's answer before giving their own. The starter shows every annotator's labels to everyone.",
      match: {
        python: {all: [/x-annotator-id/i, /==\s*caller\b|\bcaller\s*==/]},
        typescript: {all: [/x-annotator-id/i, /===\s*caller\b|\bcaller\s*===/]},
        go: {all: [/X-Annotator-Id/i, /==\s*caller\b|\bcaller\s*==/]},
        scala: {all: [/X-Annotator-Id/i, /==\s*caller\b|\bcaller\s*==/]},
        cpp: {all: [/X-Annotator-Id/i, /==\s*caller\b|\bcaller\s*==/]},
      },
    },
    {
      id: 'flagged-excluded',
      title: 'Leaves flagged annotators out of the math',
      detail:
        'Annotators in `flagged(task_id)` keep their row with `excluded: true` but count toward neither `completed` nor `agreement`. The starter never reads the flag, so a spammer drags agreement down and marks items complete.',
      match: {
        python: {all: [/store\.flagged\(/, /["']excluded["']/]},
        typescript: {all: [/flagged\(/, /excluded/]},
        go: {all: [/store\.Flagged\(/, /"excluded"/]},
        scala: {all: [/Store\.flagged\(/, /"excluded"/]},
        cpp: {all: [/store::flagged\(/, /"excluded"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from labeling import store  # get_task, labels_of, flagged

app = FastAPI()


def majority_share(values: list[str]) -> float:
    """The share of the most common value: 1.0 when everybody agrees."""
    return max(values.count(v) for v in set(values)) / len(values)


@app.get("/v1/tasks/{task_id}/progress")
def progress(task_id: str, request: Request) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    if not request.headers.get("x-tenant-id", ""):
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    task = store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="no such task")
    by_annotator: dict[str, dict[str, str]] = {}
    for label in store.labels_of(task_id):
        by_annotator.setdefault(label["annotator"], {})[label["item_id"]] = label["value"]
    by_item: dict[str, list[str]] = {}
    for labels in by_annotator.values():
        for item_id, value in labels.items():
            by_item.setdefault(item_id, []).append(value)
    shares = [majority_share(values) for values in by_item.values() if len(values) >= 2]
    return {
        "task_id": task_id,
        "total": task["total_items"],
        "completed": sum(1 for values in by_item.values() if len(values) >= task["overlap"]),
        "agreement": round(sum(shares) / len(shares), 3) if shares else None,
        "annotators": [
            {"annotator": annotator, "submitted": len(labels), "labels": labels}
            for annotator, labels in sorted(by_annotator.items())
        ],
    }
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from labeling import store  # get_task, labels_of, flagged

app = FastAPI()


def majority_share(values: list[str]) -> float:
    """The share of the most common value: 1.0 when everybody agrees."""
    return max(values.count(v) for v in set(values)) / len(values)


@app.get("/v1/tasks/{task_id}/progress")
def progress(task_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    caller = request.headers.get("x-annotator-id", "")
    task = store.get_task(task_id)
    if task is None or task["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such task")  # another tenant's task does not exist for this caller
    excluded = store.flagged(task_id)
    by_annotator: dict[str, dict[str, str]] = {}
    for label in store.labels_of(task_id):
        by_annotator.setdefault(label["annotator"], {})[label["item_id"]] = label["value"]
    by_item: dict[str, list[str]] = {}
    for annotator, labels in by_annotator.items():
        if annotator in excluded:
            continue  # quality review took this annotator out of the numbers
        for item_id, value in labels.items():
            by_item.setdefault(item_id, []).append(value)
    shares = [majority_share(values) for values in by_item.values() if len(values) >= 2]
    return {
        "task_id": task_id,
        "total": task["total_items"],
        "completed": sum(1 for values in by_item.values() if len(values) >= task["overlap"]),
        "agreement": round(sum(shares) / len(shares), 3) if shares else None,
        "annotators": [
            {
                "annotator": annotator,
                "submitted": len(labels),
                "excluded": annotator in excluded,
                "labels": labels if annotator == caller else None,  # a peer's answers would anchor the caller's
            }
            for annotator, labels in sorted(by_annotator.items())
        ],
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {flagged, getTask, labelsOf} from 'labeling/store';

export const app = Fastify();

/** The share of the most common value: 1 when everybody agrees. */
function majorityShare(values: string[]): number {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Math.max(...counts.values()) / values.length;
}

app.get('/v1/tasks/:taskId/progress', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {taskId} = request.params as {taskId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const task = await getTask(taskId);
  if (task === null) return reply.code(404).send({error: 'no such task'});
  const byAnnotator = new Map<string, Record<string, string>>();
  for (const label of await labelsOf(taskId)) {
    const labels = byAnnotator.get(label.annotator) ?? {};
    labels[label.item_id] = label.value;
    byAnnotator.set(label.annotator, labels);
  }
  const byItem = new Map<string, string[]>();
  for (const labels of byAnnotator.values()) {
    for (const [itemId, value] of Object.entries(labels)) byItem.set(itemId, [...(byItem.get(itemId) ?? []), value]);
  }
  const shares = [...byItem.values()].filter(values => values.length >= 2).map(majorityShare);
  return {
    task_id: taskId,
    total: task.total_items,
    completed: [...byItem.values()].filter(values => values.length >= task.overlap).length,
    agreement: shares.length === 0 ? null : Math.round((shares.reduce((a, b) => a + b, 0) / shares.length) * 1000) / 1000,
    annotators: [...byAnnotator.keys()].sort().map(annotator => {
      const labels = byAnnotator.get(annotator) ?? {};
      return {annotator, submitted: Object.keys(labels).length, labels};
    }),
  };
});
`,
      solution: `import Fastify from 'fastify';

import {flagged, getTask, labelsOf} from 'labeling/store';

export const app = Fastify();

/** The share of the most common value: 1 when everybody agrees. */
function majorityShare(values: string[]): number {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Math.max(...counts.values()) / values.length;
}

app.get('/v1/tasks/:taskId/progress', async (request, reply) => {
  const {taskId} = request.params as {taskId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const caller = request.headers['x-annotator-id'] ?? '';
  const task = await getTask(taskId);
  // Another tenant's task does not exist for this caller.
  if (task === null || task.tenant !== tenant) return reply.code(404).send({error: 'no such task'});
  const excluded = await flagged(taskId);
  const byAnnotator = new Map<string, Record<string, string>>();
  for (const label of await labelsOf(taskId)) {
    const labels = byAnnotator.get(label.annotator) ?? {};
    labels[label.item_id] = label.value;
    byAnnotator.set(label.annotator, labels);
  }
  const byItem = new Map<string, string[]>();
  for (const [annotator, labels] of byAnnotator) {
    if (excluded.has(annotator)) continue; // quality review took this annotator out of the numbers
    for (const [itemId, value] of Object.entries(labels)) byItem.set(itemId, [...(byItem.get(itemId) ?? []), value]);
  }
  const shares = [...byItem.values()].filter(values => values.length >= 2).map(majorityShare);
  return {
    task_id: taskId,
    total: task.total_items,
    completed: [...byItem.values()].filter(values => values.length >= task.overlap).length,
    agreement: shares.length === 0 ? null : Math.round((shares.reduce((a, b) => a + b, 0) / shares.length) * 1000) / 1000,
    annotators: [...byAnnotator.keys()].sort().map(annotator => {
      const labels = byAnnotator.get(annotator) ?? {};
      return {
        annotator,
        submitted: Object.keys(labels).length,
        excluded: excluded.has(annotator),
        labels: annotator === caller ? labels : null, // a peer's answers would anchor the caller's
      };
    }),
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"

	"labeling/store" // store.GetTask, LabelsOf, Flagged
)

type annotatorRow struct {
	Annotator string            \`json:"annotator"\`
	Submitted int               \`json:"submitted"\`
	Labels    map[string]string \`json:"labels"\`
}

type progressBody struct {
	TaskID     string         \`json:"task_id"\`
	Total      int            \`json:"total"\`
	Completed  int            \`json:"completed"\`
	Agreement  *float64       \`json:"agreement"\`
	Annotators []annotatorRow \`json:"annotators"\`
}

// majorityShare is the share of the most common value: 1 when everybody agrees.
func majorityShare(values []string) float64 {
	counts := map[string]int{}
	top := 0
	for _, v := range values {
		counts[v]++
		if counts[v] > top {
			top = counts[v]
		}
	}
	return float64(top) / float64(len(values))
}

func progress(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	taskID := r.PathValue("id")
	if r.Header.Get("X-Tenant-Id") == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	task := store.GetTask(r.Context(), taskID)
	if task == nil {
		http.Error(rw, "no such task", http.StatusNotFound)
		return
	}
	byAnnotator := map[string]map[string]string{}
	for _, label := range store.LabelsOf(r.Context(), taskID) {
		if byAnnotator[label.Annotator] == nil {
			byAnnotator[label.Annotator] = map[string]string{}
		}
		byAnnotator[label.Annotator][label.ItemID] = label.Value
	}
	byItem := map[string][]string{}
	for _, labels := range byAnnotator {
		for itemID, value := range labels {
			byItem[itemID] = append(byItem[itemID], value)
		}
	}
	body := progressBody{TaskID: taskID, Total: task.TotalItems, Annotators: []annotatorRow{}}
	sum, n := 0.0, 0
	for _, values := range byItem {
		if len(values) >= task.Overlap {
			body.Completed++
		}
		if len(values) >= 2 {
			sum += majorityShare(values)
			n++
		}
	}
	if n > 0 {
		agreement := math.Round(sum/float64(n)*1000) / 1000
		body.Agreement = &agreement
	}
	names := make([]string, 0, len(byAnnotator))
	for name := range byAnnotator {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		body.Annotators = append(body.Annotators, annotatorRow{Annotator: name, Submitted: len(byAnnotator[name]), Labels: byAnnotator[name]})
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(body)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/tasks/{id}/progress", progress)
}
`,
      solution: `package main

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"

	"labeling/store" // store.GetTask, LabelsOf, Flagged
)

type annotatorRow struct {
	Annotator string            \`json:"annotator"\`
	Submitted int               \`json:"submitted"\`
	Excluded  bool              \`json:"excluded"\`
	Labels    map[string]string \`json:"labels"\`
}

type progressBody struct {
	TaskID     string         \`json:"task_id"\`
	Total      int            \`json:"total"\`
	Completed  int            \`json:"completed"\`
	Agreement  *float64       \`json:"agreement"\`
	Annotators []annotatorRow \`json:"annotators"\`
}

// majorityShare is the share of the most common value: 1 when everybody agrees.
func majorityShare(values []string) float64 {
	counts := map[string]int{}
	top := 0
	for _, v := range values {
		counts[v]++
		if counts[v] > top {
			top = counts[v]
		}
	}
	return float64(top) / float64(len(values))
}

func progress(rw http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("id")
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	caller := r.Header.Get("X-Annotator-Id")
	task := store.GetTask(r.Context(), taskID)
	if task == nil || task.Tenant != tenant {
		http.Error(rw, "no such task", http.StatusNotFound) // another tenant's task does not exist for this caller
		return
	}
	excluded := store.Flagged(r.Context(), taskID)
	byAnnotator := map[string]map[string]string{}
	for _, label := range store.LabelsOf(r.Context(), taskID) {
		if byAnnotator[label.Annotator] == nil {
			byAnnotator[label.Annotator] = map[string]string{}
		}
		byAnnotator[label.Annotator][label.ItemID] = label.Value
	}
	byItem := map[string][]string{}
	for annotator, labels := range byAnnotator {
		if excluded[annotator] {
			continue // quality review took this annotator out of the numbers
		}
		for itemID, value := range labels {
			byItem[itemID] = append(byItem[itemID], value)
		}
	}
	body := progressBody{TaskID: taskID, Total: task.TotalItems, Annotators: []annotatorRow{}}
	sum, n := 0.0, 0
	for _, values := range byItem {
		if len(values) >= task.Overlap {
			body.Completed++
		}
		if len(values) >= 2 {
			sum += majorityShare(values)
			n++
		}
	}
	if n > 0 {
		agreement := math.Round(sum/float64(n)*1000) / 1000
		body.Agreement = &agreement
	}
	names := make([]string, 0, len(byAnnotator))
	for name := range byAnnotator {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		row := annotatorRow{Annotator: name, Submitted: len(byAnnotator[name]), Excluded: excluded[name]}
		if name == caller {
			row.Labels = byAnnotator[name] // a peer's answers would anchor the caller's
		}
		body.Annotators = append(body.Annotators, row)
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(body)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/tasks/{id}/progress", progress)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import labeling.Store // Store.getTask, labelsOf, flagged

object Read {
  /** The share of the most common value: 1 when everybody agrees. */
  def majorityShare(values: Seq[String]): Double = values.groupBy(identity).values.map(_.size).max.toDouble / values.size

  val route: Route =
    path("v1" / "tasks" / Segment / "progress") { taskId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(_) =>
            // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
            Store.getTask(taskId) match {
              case None => complete(StatusCodes.NotFound -> "no such task")
              case Some(task) =>
                val byAnnotator = Store.labelsOf(taskId).groupBy(_.annotator).view.mapValues(ls => ls.map(l => l.itemId -> l.value).toMap).toMap
                val byItem = byAnnotator.values.flatten.groupBy(_._1).view.mapValues(_.map(_._2).toSeq).toMap
                val shares = byItem.values.filter(_.size >= 2).map(majorityShare)
                val agreement = if (shares.isEmpty) JsNull else JsNumber(math.round(shares.sum / shares.size * 1000) / 1000.0)
                val rows = byAnnotator.keys.toSeq.sorted.map { annotator =>
                  JsObject(
                    "annotator" -> JsString(annotator),
                    "submitted" -> JsNumber(byAnnotator(annotator).size),
                    "labels" -> JsObject(byAnnotator(annotator).map { case (item, value) => item -> JsString(value) }))
                }
                val body = JsObject(
                  "task_id" -> JsString(taskId), "total" -> JsNumber(task.totalItems),
                  "completed" -> JsNumber(byItem.values.count(_.size >= task.overlap)),
                  "agreement" -> agreement, "annotators" -> JsArray(rows.toVector))
                complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
            }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import labeling.Store // Store.getTask, labelsOf, flagged

object Read {
  /** The share of the most common value: 1 when everybody agrees. */
  def majorityShare(values: Seq[String]): Double = values.groupBy(identity).values.map(_.size).max.toDouble / values.size

  private def progress(taskId: String, task: Store.Task, caller: String): JsObject = {
    val excluded = Store.flagged(taskId)
    val byAnnotator = Store.labelsOf(taskId).groupBy(_.annotator).view.mapValues(ls => ls.map(l => l.itemId -> l.value).toMap).toMap
    // Quality review took the flagged annotators out of the numbers.
    val byItem = byAnnotator.filter { case (annotator, _) => !excluded.contains(annotator) }.values.flatten
      .groupBy(_._1).view.mapValues(_.map(_._2).toSeq).toMap
    val shares = byItem.values.filter(_.size >= 2).map(majorityShare)
    val agreement = if (shares.isEmpty) JsNull else JsNumber(math.round(shares.sum / shares.size * 1000) / 1000.0)
    val rows = byAnnotator.keys.toSeq.sorted.map { annotator =>
      val labels = JsObject(byAnnotator(annotator).map { case (item, value) => item -> JsString(value) })
      JsObject(
        "annotator" -> JsString(annotator),
        "submitted" -> JsNumber(byAnnotator(annotator).size),
        "excluded" -> JsBoolean(excluded.contains(annotator)),
        "labels" -> (if (annotator == caller) labels else JsNull)) // a peer's answers would anchor the caller's
    }
    JsObject(
      "task_id" -> JsString(taskId), "total" -> JsNumber(task.totalItems),
      "completed" -> JsNumber(byItem.values.count(_.size >= task.overlap)),
      "agreement" -> agreement, "annotators" -> JsArray(rows.toVector))
  }

  val route: Route =
    path("v1" / "tasks" / Segment / "progress") { taskId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            optionalHeaderValueByName("X-Annotator-Id") { caller =>
              Store.getTask(taskId) match {
                // Another tenant's task does not exist for this caller.
                case Some(task) if task.tenant == tenant =>
                  val body = progress(taskId, task, caller.getOrElse(""))
                  complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
                case _ => complete(StatusCodes.NotFound -> "no such task")
              }
            }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <map>
#include <string>
#include <vector>

#include "labeling/store.h"  // store::getTask, labelsOf, flagged

using json = nlohmann::json;

// The share of the most common value: 1 when everybody agrees.
double majorityShare(const std::vector<std::string>& values) {
  std::map<std::string, int> counts;
  int top = 0;
  for (const auto& v : values) top = std::max(top, ++counts[v]);
  return static_cast<double>(top) / static_cast<double>(values.size());
}

void progress(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string task_id = req.matches[1];
  if (req.get_header_value("X-Tenant-Id").empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const auto task = store::getTask(task_id);
  if (!task) {
    res.status = 404;
    res.set_content("no such task", "text/plain");
    return;
  }
  std::map<std::string, std::map<std::string, std::string>> by_annotator;
  for (const auto& label : store::labelsOf(task_id)) by_annotator[label.annotator][label.item_id] = label.value;
  std::map<std::string, std::vector<std::string>> by_item;
  for (const auto& [annotator, labels] : by_annotator) {
    for (const auto& [item_id, value] : labels) by_item[item_id].push_back(value);
  }
  long completed = 0;
  double sum = 0;
  int n = 0;
  for (const auto& [item_id, values] : by_item) {
    if (static_cast<long>(values.size()) >= task->overlap) completed++;
    if (values.size() >= 2) {
      sum += majorityShare(values);
      n++;
    }
  }
  json rows = json::array();
  for (const auto& [annotator, labels] : by_annotator) {
    rows.push_back(json{{"annotator", annotator}, {"submitted", labels.size()}, {"labels", labels}});
  }
  const json body = {{"task_id", task_id},     {"total", task->total_items},
                     {"completed", completed}, {"agreement", n == 0 ? json() : json(std::round(sum / n * 1000) / 1000)},
                     {"annotators", rows}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/tasks/([\\w-]+)/progress)", progress); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "labeling/store.h"  // store::getTask, labelsOf, flagged

using json = nlohmann::json;

// The share of the most common value: 1 when everybody agrees.
double majorityShare(const std::vector<std::string>& values) {
  std::map<std::string, int> counts;
  int top = 0;
  for (const auto& v : values) top = std::max(top, ++counts[v]);
  return static_cast<double>(top) / static_cast<double>(values.size());
}

void progress(const httplib::Request& req, httplib::Response& res) {
  const std::string task_id = req.matches[1];
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const std::string caller = req.get_header_value("X-Annotator-Id");
  const auto task = store::getTask(task_id);
  if (!task || task->tenant != tenant) {
    res.status = 404;  // another tenant's task does not exist for this caller
    res.set_content("no such task", "text/plain");
    return;
  }
  const std::set<std::string> excluded = store::flagged(task_id);
  std::map<std::string, std::map<std::string, std::string>> by_annotator;
  for (const auto& label : store::labelsOf(task_id)) by_annotator[label.annotator][label.item_id] = label.value;
  std::map<std::string, std::vector<std::string>> by_item;
  for (const auto& [annotator, labels] : by_annotator) {
    if (excluded.count(annotator)) continue;  // quality review took this annotator out of the numbers
    for (const auto& [item_id, value] : labels) by_item[item_id].push_back(value);
  }
  long completed = 0;
  double sum = 0;
  int n = 0;
  for (const auto& [item_id, values] : by_item) {
    if (static_cast<long>(values.size()) >= task->overlap) completed++;
    if (values.size() >= 2) {
      sum += majorityShare(values);
      n++;
    }
  }
  json rows = json::array();
  for (const auto& [annotator, labels] : by_annotator) {
    rows.push_back(json{{"annotator", annotator},
                        {"submitted", labels.size()},
                        {"excluded", excluded.count(annotator) > 0},
                        {"labels", annotator == caller ? json(labels) : json()}});  // a peer's answers would anchor the caller's
  }
  const json body = {{"task_id", task_id},     {"total", task->total_items},
                     {"completed", completed}, {"agreement", n == 0 ? json() : json(std::round(sum / n * 1000) / 1000)},
                     {"annotators", rows}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/tasks/([\\w-]+)/progress)", progress); }
`,
    },
  },
  harness: {
    python: `from labeling import store

# Three items, overlap 3: ana, bo and cy label honestly, spam (flagged by quality review) disagrees on purpose.
LABELS = [
    ("ana", "i-1", "cat"), ("ana", "i-2", "dog"), ("ana", "i-3", "cat"),
    ("bo", "i-1", "cat"), ("bo", "i-2", "cat"), ("bo", "i-3", "cat"),
    ("cy", "i-1", "cat"), ("cy", "i-2", "dog"),
    ("spam", "i-1", "dog"), ("spam", "i-2", "cat"), ("spam", "i-3", "dog"),
]


def _task(ctx):
    task_id = store.create_task("t1", "2026-10", 3, ["a cat on a mat", "a dog in the fog", "a cat in a hat"])["task_id"]
    for n, (annotator, item_id, value) in enumerate(LABELS, start=1):
        store.save_label({"label_id": f"l-{n}", "task_id": task_id, "item_id": item_id, "annotator": annotator, "spec_version": "2026-10", "value": value})
    ctx.redis.sadd(f"flagged:{task_id}", "spam")
    return ctx.client(ctx.load("read").app), task_id


async def _get(c, task_id, tenant="t1", annotator="ana"):
    return await c.get(f"/v1/tasks/{task_id}/progress", headers={"X-Tenant-Id": tenant, "X-Annotator-Id": annotator})


def _rows(body):
    return {row.get("annotator"): row for row in body.get("annotators", [])}


async def check_route(ctx):
    c, task_id = _task(ctx)
    async with c:
        r = await _get(c, task_id)
    assert r.status_code == 200, f"GET /v1/tasks/{task_id}/progress answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("task_id") == task_id and body.get("total") == 3, f"the progress of {task_id} answered {body}, expected task_id {task_id} and total 3"
    assert sorted(_rows(body)) == ["ana", "bo", "cy", "spam"], f"the progress lists {sorted(_rows(body))}, expected every annotator who labeled"


async def check_tenant_scope(ctx):
    c, task_id = _task(ctx)
    async with c:
        foreign = await _get(c, task_id, tenant="t2")
        unknown = await _get(c, "t-99")
        none = await c.get(f"/v1/tasks/{task_id}/progress", headers={"X-Annotator-Id": "ana"})
    assert foreign.status_code == 404, f"tenant t2 read tenant t1's task {task_id}: {foreign.status_code} {foreign.text}. Another tenant's task must be 404, as an unknown one"
    assert unknown.status_code == 404, f"an unknown task answered {unknown.status_code}, expected 404"
    assert none.status_code == 401, f"a read without X-Tenant-Id answered {none.status_code}, expected 401"


async def check_blind_peers(ctx):
    c, task_id = _task(ctx)
    async with c:
        as_ana = (await _get(c, task_id, annotator="ana")).json()
        as_bo = (await _get(c, task_id, annotator="bo")).json()
    rows = _rows(as_ana)
    assert rows["ana"].get("labels") == {"i-1": "cat", "i-2": "dog", "i-3": "cat"}, f"ana's own row carries labels {rows['ana'].get('labels')!r}, expected her three labels"
    peeked = {a: row.get("labels") for a, row in rows.items() if a != "ana" and row.get("labels") is not None}
    assert not peeked, f"ana can read her peers' answers {peeked}: before she labels an item she can copy them, and agreement measures copying. A peer's row has labels null"
    rows = _rows(as_bo)
    assert rows["bo"].get("labels") == {"i-1": "cat", "i-2": "cat", "i-3": "cat"} and rows["ana"].get("labels") is None, f"asking as bo, bo's labels are {rows['bo'].get('labels')!r} and ana's {rows['ana'].get('labels')!r}: the caller sees only their own"
    assert rows["ana"].get("submitted") == 3, f"a peer's row must still count what they submitted, ana's row is {rows['ana']}"


async def check_flagged_excluded(ctx):
    c, task_id = _task(ctx)
    async with c:
        body = (await _get(c, task_id)).json()
    rows = _rows(body)
    assert rows["spam"].get("excluded") is True, f"spam is flagged by quality review and its row is {rows['spam']}, expected excluded: true"
    assert all(rows[a].get("excluded") is False for a in ("ana", "bo", "cy")), f"only spam is flagged, the rows are {rows}"
    assert body.get("agreement") == 0.889, f"agreement is {body.get('agreement')}: without the flagged annotator ana, bo and cy agree on i-1 and i-3 and 2 of 3 on i-2, which is 0.889. The flagged annotator must not count"
    assert body.get("completed") == 2, f"completed is {body.get('completed')}: only i-1 and i-2 have three labels from annotators who count (overlap 3)"
`,
    typescript: `// Three items, overlap 3: ana, bo and cy label honestly, spam (flagged by quality review) disagrees on purpose.
const LABELS: [string, string, string][] = [
  ['ana', 'i-1', 'cat'], ['ana', 'i-2', 'dog'], ['ana', 'i-3', 'cat'],
  ['bo', 'i-1', 'cat'], ['bo', 'i-2', 'cat'], ['bo', 'i-3', 'cat'],
  ['cy', 'i-1', 'cat'], ['cy', 'i-2', 'dog'],
  ['spam', 'i-1', 'dog'], ['spam', 'i-2', 'cat'], ['spam', 'i-3', 'dog'],
];

async function setup(ctx) {
  const store = ctx.load('/support/labeling/store.ts');
  const task = await store.createTask('t1', '2026-10', 3, ['a cat on a mat', 'a dog in the fog', 'a cat in a hat']);
  for (const [n, [annotator, item_id, value]] of LABELS.entries()) {
    await store.saveLabel({label_id: \`l-\${n + 1}\`, task_id: task.task_id, item_id, annotator, spec_version: '2026-10', value});
  }
  ctx.redis.sadd(\`flagged:\${task.task_id}\`, 'spam');
  return {c: ctx.client(ctx.load('read').app), taskId: task.task_id as string};
}

const get = (c, taskId: string, tenant = 't1', annotator = 'ana') =>
  c.get(\`/v1/tasks/\${taskId}/progress\`, {headers: {'X-Tenant-Id': tenant, 'X-Annotator-Id': annotator}});

const rowsOf = body => Object.fromEntries((body.annotators ?? []).map(row => [row.annotator, row]));

export async function check_route(ctx) {
  const {c, taskId} = await setup(ctx);
  const r = await get(c, taskId);
  assert.equal(r.status, 200, \`GET /v1/tasks/\${taskId}/progress answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.task_id === taskId && body.total === 3, \`the progress of \${taskId} answered \${r.text}, expected task_id \${taskId} and total 3\`);
  assert.deepEqual(Object.keys(rowsOf(body)).sort(), ['ana', 'bo', 'cy', 'spam'], 'the progress must list every annotator who labeled');
}

export async function check_tenant_scope(ctx) {
  const {c, taskId} = await setup(ctx);
  const foreign = await get(c, taskId, 't2');
  const unknown = await get(c, 't-99');
  const none = await c.get(\`/v1/tasks/\${taskId}/progress\`, {headers: {'X-Annotator-Id': 'ana'}});
  assert.equal(foreign.status, 404, \`tenant t2 read tenant t1's task \${taskId}: \${foreign.status} \${foreign.text}. Another tenant's task must be 404, as an unknown one\`);
  assert.equal(unknown.status, 404, \`an unknown task answered \${unknown.status}, expected 404\`);
  assert.equal(none.status, 401, \`a read without X-Tenant-Id answered \${none.status}, expected 401\`);
}

export async function check_blind_peers(ctx) {
  const {c, taskId} = await setup(ctx);
  let rows = rowsOf((await get(c, taskId, 't1', 'ana')).json());
  assert.deepEqual(rows.ana.labels, {'i-1': 'cat', 'i-2': 'dog', 'i-3': 'cat'}, "ana's own row must carry her three labels");
  const peeked = Object.entries(rows).filter(([a, row]) => a !== 'ana' && (row as {labels: unknown}).labels !== null);
  assert.equal(peeked.length, 0, \`ana can read her peers' answers \${JSON.stringify(peeked)}: before she labels an item she can copy them, and agreement measures copying. A peer's row has labels null\`);
  rows = rowsOf((await get(c, taskId, 't1', 'bo')).json());
  assert(JSON.stringify(rows.bo.labels) === JSON.stringify({'i-1': 'cat', 'i-2': 'cat', 'i-3': 'cat'}) && rows.ana.labels === null, \`asking as bo, bo's labels are \${JSON.stringify(rows.bo.labels)} and ana's \${JSON.stringify(rows.ana.labels)}: the caller sees only their own\`);
  assert.equal(rows.ana.submitted, 3, "a peer's row must still count what they submitted");
}

export async function check_flagged_excluded(ctx) {
  const {c, taskId} = await setup(ctx);
  const body = (await get(c, taskId)).json();
  const rows = rowsOf(body);
  assert.equal(rows.spam.excluded, true, \`spam is flagged by quality review and its row is \${JSON.stringify(rows.spam)}, expected excluded: true\`);
  assert(['ana', 'bo', 'cy'].every(a => rows[a].excluded === false), \`only spam is flagged, the rows are \${JSON.stringify(rows)}\`);
  assert.equal(body.agreement, 0.889, \`agreement is \${body.agreement}: without the flagged annotator ana, bo and cy agree on i-1 and i-3 and 2 of 3 on i-2, which is 0.889. The flagged annotator must not count\`);
  assert.equal(body.completed, 2, \`completed is \${body.completed}: only i-1 and i-2 have three labels from annotators who count (overlap 3)\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"

	"labeling/store"

	"leetbuild/harness"
)

// Three items, overlap 3: ana, bo and cy label honestly, spam (flagged by quality review) disagrees on purpose.
var readLabels = [][3]string{
	{"ana", "i-1", "cat"}, {"ana", "i-2", "dog"}, {"ana", "i-3", "cat"},
	{"bo", "i-1", "cat"}, {"bo", "i-2", "cat"}, {"bo", "i-3", "cat"},
	{"cy", "i-1", "cat"}, {"cy", "i-2", "dog"},
	{"spam", "i-1", "dog"}, {"spam", "i-2", "cat"}, {"spam", "i-3", "dog"},
}

func readTask(ctx *harness.Ctx) (*harness.HTTP, string) {
	bg := context.Background()
	taskID := store.CreateTask(bg, "t1", "2026-10", 3, []string{"a cat on a mat", "a dog in the fog", "a cat in a hat"}).TaskID
	for n, l := range readLabels {
		store.SaveLabel(bg, store.Label{LabelID: fmt.Sprintf("l-%d", n+1), TaskID: taskID, ItemID: l[1], Annotator: l[0], SpecVersion: "2026-10", Value: l[2]})
	}
	ctx.Redis.Do("SADD", "flagged:"+taskID, "spam")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux), taskID
}

func readGet(c *harness.HTTP, taskID, tenant, annotator string) *harness.Response {
	return c.Get("/v1/tasks/"+taskID+"/progress", "X-Tenant-Id", tenant, "X-Annotator-Id", annotator)
}

func readBody(ctx *harness.Ctx, r *harness.Response) (map[string]any, map[string]map[string]any) {
	body, _ := r.JSON().(map[string]any)
	ctx.Assert(body != nil, "the response body is not a JSON object: %s", r.Text())
	rows := map[string]map[string]any{}
	list, _ := body["annotators"].([]any)
	for _, item := range list {
		if row, ok := item.(map[string]any); ok {
			name, _ := row["annotator"].(string)
			rows[name] = row
		}
	}
	return body, rows
}

func CheckRoute(ctx *harness.Ctx) {
	c, taskID := readTask(ctx)
	r := readGet(c, taskID, "t1", "ana")
	ctx.Equal(r.Status, 200, "GET /v1/tasks/%s/progress (%s)", taskID, r.Text())
	body, rows := readBody(ctx, r)
	ctx.Assert(body["task_id"] == taskID && body["total"] == float64(3), "the progress of %s answered %s, expected task_id %s and total 3", taskID, r.Text(), taskID)
	names := make([]string, 0, len(rows))
	for name := range rows {
		names = append(names, name)
	}
	sort.Strings(names)
	ctx.Equal(names, []string{"ana", "bo", "cy", "spam"}, "the progress must list every annotator who labeled")
}

func CheckTenantScope(ctx *harness.Ctx) {
	c, taskID := readTask(ctx)
	foreign := readGet(c, taskID, "t2", "ana")
	ctx.Equal(foreign.Status, 404, "tenant t2 read tenant t1's task %s (%s). Another tenant's task must be 404, as an unknown one; the status", taskID, foreign.Text())
	ctx.Equal(readGet(c, "t-99", "t1", "ana").Status, 404, "an unknown task")
	ctx.Equal(c.Get("/v1/tasks/"+taskID+"/progress", "X-Annotator-Id", "ana").Status, 401, "a read without X-Tenant-Id")
}

func CheckBlindPeers(ctx *harness.Ctx) {
	c, taskID := readTask(ctx)
	_, rows := readBody(ctx, readGet(c, taskID, "t1", "ana"))
	ctx.Equal(rows["ana"]["labels"], map[string]any{"i-1": "cat", "i-2": "dog", "i-3": "cat"}, "ana's own row must carry her three labels")
	for name, row := range rows {
		if name != "ana" {
			ctx.Assert(row["labels"] == nil, "ana can read %s's answers %v: before she labels an item she can copy them, and agreement measures copying. A peer's row has labels null", name, row["labels"])
		}
	}
	_, rows = readBody(ctx, readGet(c, taskID, "t1", "bo"))
	ctx.Equal(rows["bo"]["labels"], map[string]any{"i-1": "cat", "i-2": "cat", "i-3": "cat"}, "asking as bo, bo's own labels")
	ctx.Assert(rows["ana"]["labels"] == nil, "asking as bo, ana's labels are %v: the caller sees only their own", rows["ana"]["labels"])
	ctx.Equal(rows["ana"]["submitted"], float64(3), "a peer's row must still count what they submitted; ana's submitted")
}

func CheckFlaggedExcluded(ctx *harness.Ctx) {
	c, taskID := readTask(ctx)
	body, rows := readBody(ctx, readGet(c, taskID, "t1", "ana"))
	ctx.Equal(rows["spam"]["excluded"], true, "spam is flagged by quality review: its row's excluded")
	for _, name := range []string{"ana", "bo", "cy"} {
		ctx.Equal(rows[name]["excluded"], false, "only spam is flagged: %s's excluded", name)
	}
	ctx.Equal(body["agreement"], 0.889, "without the flagged annotator ana, bo and cy agree on i-1 and i-3 and 2 of 3 on i-2, which is 0.889; the flagged annotator must not count. agreement")
	ctx.Equal(body["completed"], float64(2), "only i-1 and i-2 have three labels from annotators who count (overlap 3); completed")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <tuple>
#include <vector>

using json = nlohmann::json;

namespace {

// Three items, overlap 3: ana, bo and cy label honestly, spam (flagged by quality review) disagrees on purpose.
const std::vector<std::tuple<std::string, std::string, std::string>> kLabels = {
    {"ana", "i-1", "cat"}, {"ana", "i-2", "dog"}, {"ana", "i-3", "cat"},  {"bo", "i-1", "cat"},
    {"bo", "i-2", "cat"},  {"bo", "i-3", "cat"},  {"cy", "i-1", "cat"},   {"cy", "i-2", "dog"},
    {"spam", "i-1", "dog"}, {"spam", "i-2", "cat"}, {"spam", "i-3", "dog"},
};

struct Fixture {
  harness::HTTP c;
  std::string task_id;
};

Fixture readTask(harness::Ctx& ctx) {
  const std::string task_id = store::createTask("t1", "2026-10", 3, {"a cat on a mat", "a dog in the fog", "a cat in a hat"}).task_id;
  int n = 0;
  for (const auto& [annotator, item_id, value] : kLabels) {
    store::saveLabel(store::Label{"l-" + std::to_string(++n), task_id, item_id, annotator, "2026-10", value});
  }
  ctx.Redis.Do("SADD", "flagged:" + task_id, "spam");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return {ctx.HTTP(*svr), task_id};
}

harness::Response readGet(harness::HTTP& c, const std::string& task_id, const std::string& tenant = "t1", const std::string& annotator = "ana") {
  return c.Get("/v1/tasks/" + task_id + "/progress", "X-Tenant-Id", tenant, "X-Annotator-Id", annotator);
}

json rowsOf(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && body.contains("annotators"), "the response body is not a progress object: %s", r.Text());
  json rows = json::object();
  for (const auto& row : body["annotators"]) rows[row.value("annotator", "")] = row;
  return rows;
}

json field(const json& j, const std::string& name) { return j.is_object() && j.contains(name) ? j[name] : json(); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto [c, task_id] = readTask(ctx);
  const auto r = readGet(c, task_id);
  ctx.Equal(r.Status, 200, "GET /v1/tasks/%s/progress (%s)", task_id, r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(field(body, "task_id") == task_id && field(body, "total") == 3, "the progress of %s answered %s, expected task_id %s and total 3", task_id, r.Text(), task_id);
  std::vector<std::string> names;
  const json rows = rowsOf(ctx, r);
  for (const auto& [name, row] : rows.items()) names.push_back(name);
  ctx.Equal(names, {"ana", "bo", "cy", "spam"}, "the progress must list every annotator who labeled");
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto [c, task_id] = readTask(ctx);
  const auto foreign = readGet(c, task_id, "t2");
  ctx.Equal(foreign.Status, 404, "tenant t2 read tenant t1's task %s (%s). Another tenant's task must be 404, as an unknown one; the status", task_id, foreign.Text());
  ctx.Equal(readGet(c, "t-99").Status, 404, "an unknown task");
  ctx.Equal(c.Get("/v1/tasks/" + task_id + "/progress", "X-Annotator-Id", "ana").Status, 401, "a read without X-Tenant-Id");
}

void CheckBlindPeers(harness::Ctx& ctx) {
  auto [c, task_id] = readTask(ctx);
  json rows = rowsOf(ctx, readGet(c, task_id, "t1", "ana"));
  ctx.Equal(field(rows["ana"], "labels"), json{{"i-1", "cat"}, {"i-2", "dog"}, {"i-3", "cat"}}, "ana's own row must carry her three labels");
  for (const auto& [name, row] : rows.items()) {
    if (name == "ana") continue;
    ctx.Assert(field(row, "labels").is_null(), "ana can read %s's answers %s: before she labels an item she can copy them, and agreement measures copying. A peer's row has labels null", name, field(row, "labels").dump());
  }
  rows = rowsOf(ctx, readGet(c, task_id, "t1", "bo"));
  ctx.Equal(field(rows["bo"], "labels"), json{{"i-1", "cat"}, {"i-2", "cat"}, {"i-3", "cat"}}, "asking as bo, bo's own labels");
  ctx.Assert(field(rows["ana"], "labels").is_null(), "asking as bo, ana's labels are %s: the caller sees only their own", field(rows["ana"], "labels").dump());
  ctx.Equal(field(rows["ana"], "submitted"), json(3), "a peer's row must still count what they submitted; ana's submitted");
}

void CheckFlaggedExcluded(harness::Ctx& ctx) {
  auto [c, task_id] = readTask(ctx);
  const auto r = readGet(c, task_id);
  const json body = json::parse(r.Text(), nullptr, false);
  json rows = rowsOf(ctx, r);
  ctx.Equal(field(rows["spam"], "excluded"), json(true), "spam is flagged by quality review: its row's excluded");
  for (const std::string name : {"ana", "bo", "cy"}) ctx.Equal(field(rows[name], "excluded"), json(false), "only spam is flagged: %s's excluded", name);
  ctx.Equal(field(body, "agreement"), json(0.889), "without the flagged annotator ana, bo and cy agree on i-1 and i-3 and 2 of 3 on i-2, which is 0.889; the flagged annotator must not count. agreement");
  ctx.Equal(field(body, "completed"), json(2), "only i-1 and i-2 have three labels from annotators who count (overlap 3); completed");
}
`,
  },
  hints: [
    "Read the progress of another tenant's task by its id and it answers; read your own as one annotator and every peer's answer is on the page; flag a spammer and agreement does not move.",
    'The handler checks that the task exists but not whose it is, builds one labels map per annotator and returns all of them, and folds every annotator into the item counts without asking quality review.',
    "404 when `task['tenant'] != tenant`; put `labels` on the row whose annotator equals `X-Annotator-Id` and `None` elsewhere; skip `store.flagged(task_id)` annotators when grouping per item, and mark their rows `excluded`.",
  ],
  debrief: `The three fixes are about who may see and who may count. A foreign task answers 404 rather than 403 so a guessed id reveals nothing; hiding peer labels keeps each answer independent, which is the only thing that makes agreement a measure of the data and not of copying; and excluding flagged annotators from both numerators and the overlap count keeps one spammer from marking items complete. The read folds the stored labels on every request, so it always matches what was submitted. Production systems compute chance-corrected agreement (Cohen's or Krippendorff's alpha) rather than a majority share, keep the fold as a projection updated from the label events, and show reviewers the agreement per item while annotators see only their own work.`,
};
