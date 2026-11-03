import type {Step} from '@/lib/types';

export const experimentReadStep: Step = {
  id: 'read',
  title: 'GET /v1/experiments/{id}/report: no peeked winners',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'store', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/experiments/{id}/report\`: it checks the tenant,
reads the per-variant counters, computes a p-value and names a winner the moment that number is
below 0.05. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** The report calls winners it has not earned: a peek at any
sample size mints one, a split that drifted from the frozen design stays hidden, and a lift is
printed as one number so a two-point effect and noise look identical.

- **Totals from the analysis state.** Per-variant \`exposures\` and conversions come from the Redis
  counters the exposure consumer writes, not from a total cached beside them.
- **Minimum sample first.** Below the pinned \`min_sample\`, answer **200** with
  \`{"winner": null, "status": "inconclusive", "reason": "minimum sample not reached", ...}\`,
  regardless of the p-value.
- **SRM is a blocking caveat.** A deviation above **2 %** from the frozen split
  (\`abs(observed - expected) / expected > 0.02\`) is reported as
  \`{"caveat": {"kind": "srm", "blocking": true, "observed": ..., "expected": ...}}\` and prevents
  a winner even when \`p < 0.05\`.
- **Every lift carries its interval**: \`{"lift": 0.12, "ci_low": 0.03, "ci_high": 0.21}\`, a 95 %
  interval from the two proportions, on every branch.
- A winner is named only when the sample is reached, no blocking caveat is present, and
  \`p_value < 0.05\`; otherwise \`winner: null\` with status \`inconclusive\` or \`blocked\`.
- Missing \`X-Tenant-Id\` is **401**; an unknown experiment (or one of another tenant) is **404**.
- The sample guard and the SRM check run **before** the p-value comparison.`,
  sequence: {
    participants: ['Client', 'expd report', 'analysis state'],
    messages: [
      {from: 'Client', to: 'expd report', label: 'GET /v1/experiments/exp_42/report · X-Tenant-Id: acme', kind: 'sync'},
      {from: 'expd report', to: 'analysis state', label: 'design(exp_42) → {variants, min_sample}', kind: 'sync'},
      {
        from: 'analysis state',
        to: 'expd report',
        label: 'totals per (experiment, variant) → exposures, conversions',
        kind: 'reply',
      },
      {
        from: 'expd report',
        to: 'expd report',
        label: 'sample < min_sample → 200 {inconclusive, winner: null}',
        kind: 'sync',
      },
      {from: 'expd report', to: 'expd report', label: 'SRM > 2% → blocking caveat, before the p-value', kind: 'sync'},
      {from: 'expd report', to: 'Client', label: '200 {winner|null, lift, ci_low, ci_high, p_value}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/experiments/{id}/report',
      detail:
        'Register the report route on `GET /v1/experiments/{id}/report`, with the experiment id as a path parameter in every router.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/experiments\/\{experiment_id\}\/report["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/experiments\/:experimentId\/report['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/experiments\/\{id\}\/report"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"experiments"\s*\/\s*Segment\s*\/\s*"report"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/experiments\//]},
      },
    },
    {
      id: 'min-sample',
      title: 'Refuses a winner below the pinned minimum sample',
      detail:
        'Below `min_sample` the report is **200** with `status: "inconclusive"`, `winner: null` and `reason: "minimum sample not reached"`, with no winner however small the p-value. The starter names a winner at any sample size.',
      match: {
        python: {all: [/min_sample/, /inconclusive/, /minimum sample not reached/, /winner["']?\s*:\s*None/]},
        typescript: {all: [/min_sample/, /inconclusive/, /minimum sample not reached/, /winner:\s*null/]},
        go: {all: [/MinSample/, /inconclusive/, /minimum sample not reached/, /Winner\s*=\s*nil/]},
        scala: {all: [/min_sample/, /inconclusive/, /minimum sample not reached/, /"winner":\s*null/]},
        cpp: {all: [/min_sample/, /inconclusive/, /minimum sample not reached/, /"winner",\s*nullptr/]},
      },
    },
    {
      id: 'srm-caveat',
      title: 'Reports a sample ratio mismatch as a blocking caveat',
      detail:
        'A deviation of the observed variant share from the frozen split above **2 %** becomes `{"caveat": {"kind": "srm", "blocking": true, "observed": ..., "expected": ...}}` and prevents the winner call even when `p < 0.05`. The starter does not compute SRM.',
      match: {
        python: {all: [/SRM_THRESHOLD/, /"kind":\s*"srm"/, /"blocking":\s*True/, /caveat/]},
        typescript: {all: [/SRM_THRESHOLD/, /kind:\s*'srm'/, /blocking:\s*true/, /caveat/]},
        go: {all: [/SRMThreshold/, /"srm"/, /Blocking:\s*true/, /Caveat/]},
        scala: {all: [/SrmThreshold/, /"kind":\s*"srm"/, /"blocking":\s*true/, /caveat/]},
        cpp: {all: [/kSrmThreshold/, /"srm"/, /"blocking",\s*true/, /"caveat"/]},
      },
    },
    {
      id: 'intervals',
      title: 'Reports every lift with a 95 % confidence interval',
      detail:
        'A lift is always returned with `ci_low` and `ci_high`, the 95 % interval computed from the two proportions, including on a significant result. The starter reports a bare `lift`.',
      match: {
        python: {all: [/ci_low/, /ci_high/, /lift/]},
        typescript: {all: [/ci_low/, /ci_high/, /lift/]},
        go: {all: [/"ci_low"/, /"ci_high"/, /Lift/]},
        scala: {all: [/ci_low/, /ci_high/, /lift/]},
        cpp: {all: [/"ci_low"/, /"ci_high"/, /"lift"/]},
      },
    },
    {
      id: 'no-peek',
      title: 'The sample guard and the SRM check run before the p-value',
      detail:
        'The sample guard runs first, then the blocking SRM check, and only then is `p_value < 0.05` consulted for a winner. The starter compares the p-value before either guard.',
      match: {
        python: {
          order: [
            /sample\s*<\s*experiment\[["']min_sample["']\]/,
            /abs\(observed\s*-\s*expected\)\s*\/\s*expected\s*>\s*SRM_THRESHOLD/,
            /p_value\s*<\s*0\.05/,
          ],
        },
        typescript: {
          order: [
            /sample\s*<\s*experiment\.min_sample/,
            /Math\.abs\(observed\s*-\s*expected\)\s*\/\s*expected\s*>\s*SRM_THRESHOLD/,
            /pValue\s*<\s*0\.05/,
          ],
        },
        go: {
          order: [
            /sample\s*<\s*experiment\.MinSample/,
            /math\.Abs\(observed\s*-\s*expected\)\s*\/\s*expected\s*>\s*SRMThreshold/,
            /pValue\s*<\s*0\.05/,
          ],
        },
        scala: {
          order: [
            /sample\s*<\s*experiment\.min_sample/,
            /math\.abs\(observed\s*-\s*expected\)\s*\/\s*expected\s*>\s*SrmThreshold/,
            /pValue\s*<\s*0\.05/,
          ],
        },
        cpp: {
          order: [
            /sample\s*<\s*experiment->min_sample/,
            /std::abs\(observed\s*-\s*expected\)\s*\/\s*expected\s*>\s*kSrmThreshold/,
            /pValue\s*<\s*0\.05/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()


class ExperimentStore:
    def get(self, tenant: str, experiment_id: str) -> dict | None:
        """The pinned design for the tenant's experiment, or None when it does not exist."""
        raise NotImplementedError

    def totals(self, experiment_id: str) -> dict:
        """Per-variant exposures and conversions from the analysis state."""
        raise NotImplementedError


store = ExperimentStore()


def compute_p_value(control: dict, treatment: dict) -> float:
    raise NotImplementedError


@app.get("/v1/experiments/{experiment_id}/report")
def report(
    experiment_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    experiment = store.get(tenant, experiment_id)
    if experiment is None:
        raise HTTPException(status_code=404, detail="unknown experiment")

    totals = store.totals(experiment_id)
    control = totals["control"]
    treatment = totals["treatment"]
    p_value = compute_p_value(control, treatment)
    winner = "treatment" if p_value < 0.05 else "control"
    lift = treatment["conversions"] / treatment["exposures"] - control["conversions"] / control["exposures"]
    return JSONResponse(
        {"experiment_id": experiment_id, "winner": winner, "lift": lift, "p_value": p_value},
        status_code=200,
    )
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

SRM_THRESHOLD = 0.02


class ExperimentStore:
    def get(self, tenant: str, experiment_id: str) -> dict | None:
        """The pinned design for the tenant's experiment, or None when it does not exist."""
        raise NotImplementedError

    def totals(self, experiment_id: str) -> dict:
        """Per-variant exposures and conversions from the analysis state."""
        raise NotImplementedError


store = ExperimentStore()


def compute_p_value(control: dict, treatment: dict) -> float:
    """Two-proportion z-test p-value; the stats library owns the real implementation."""
    raise NotImplementedError


def lift_interval(control: dict, treatment: dict) -> tuple[float, float, float]:
    """Lift and its 95% interval, computed from the two proportions."""
    raise NotImplementedError


@app.get("/v1/experiments/{experiment_id}/report")
def report(
    experiment_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    experiment = store.get(tenant, experiment_id)
    if experiment is None:
        raise HTTPException(status_code=404, detail="unknown experiment")

    totals = store.totals(experiment_id)
    control = totals["control"]
    treatment = totals["treatment"]
    sample = control["exposures"] + treatment["exposures"]
    lift, ci_low, ci_high = lift_interval(control, treatment)
    p_value = compute_p_value(control, treatment)

    if sample < experiment["min_sample"]:
        return JSONResponse(
            {
                "experiment_id": experiment_id,
                "status": "inconclusive",
                "winner": None,
                "reason": "minimum sample not reached",
                "lift": lift,
                "ci_low": ci_low,
                "ci_high": ci_high,
                "p_value": p_value,
            },
            status_code=200,
        )

    expected_share = {variant["key"]: variant["weight"] / 100 for variant in experiment["variants"]}
    expected = expected_share["treatment"]
    observed = treatment["exposures"] / sample
    if abs(observed - expected) / expected > SRM_THRESHOLD:
        return JSONResponse(
            {
                "experiment_id": experiment_id,
                "status": "blocked",
                "winner": None,
                "caveat": {
                    "kind": "srm",
                    "blocking": True,
                    "observed": observed,
                    "expected": expected,
                },
                "lift": lift,
                "ci_low": ci_low,
                "ci_high": ci_high,
                "p_value": p_value,
            },
            status_code=200,
        )

    if p_value < 0.05:
        return JSONResponse(
            {
                "experiment_id": experiment_id,
                "status": "significant",
                "winner": "treatment" if lift > 0 else "control",
                "lift": lift,
                "ci_low": ci_low,
                "ci_high": ci_high,
                "p_value": p_value,
            },
            status_code=200,
        )

    return JSONResponse(
        {
            "experiment_id": experiment_id,
            "status": "inconclusive",
            "winner": None,
            "lift": lift,
            "ci_low": ci_low,
            "ci_high": ci_high,
            "p_value": p_value,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** Experiment report. */
import Fastify from 'fastify';

export const app = Fastify();

interface Variant {
  key: string;
  weight: number;
}

interface Experiment {
  id: string;
  tenant_id: string;
  variants: Variant[];
  min_sample: number;
}

interface VariantTotals {
  exposures: number;
  conversions: number;
}

class ExperimentStore {
  async get(_tenant: string, _id: string): Promise<Experiment | null> {
    return null;
  }

  async totals(_experimentId: string): Promise<Record<string, VariantTotals>> {
    return {};
  }
}

function computePValue(control: VariantTotals, treatment: VariantTotals): number {
  return 1;
}

export function routes(store: ExperimentStore): void {
  app.get('/v1/experiments/:experimentId/report', async (request, reply) => {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const tenant = request.headers['x-tenant-id'];
    if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
    const {experimentId} = request.params as {experimentId: string};
    const experiment = await store.get(tenant, experimentId);
    if (experiment === null) return reply.code(404).send({error: 'unknown experiment'});

    const totals = await store.totals(experimentId);
    const control = totals['control'];
    const treatment = totals['treatment'];
    const pValue = computePValue(control, treatment);
    const winner = pValue < 0.05 ? 'treatment' : 'control';
    const lift = treatment.conversions / treatment.exposures - control.conversions / control.exposures;
    return reply.code(200).send({experiment_id: experimentId, winner, lift, p_value: pValue});
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Experiment report: no peeked winners, SRM as a blocking caveat, every lift with its interval. */
import Fastify from 'fastify';

export const app = Fastify();

const SRM_THRESHOLD = 0.02;

interface Variant {
  key: string;
  weight: number;
}

interface Experiment {
  id: string;
  tenant_id: string;
  variants: Variant[];
  min_sample: number;
}

interface VariantTotals {
  exposures: number;
  conversions: number;
}

class ExperimentStore {
  async get(_tenant: string, _id: string): Promise<Experiment | null> {
    return null;
  }

  async totals(_experimentId: string): Promise<Record<string, VariantTotals>> {
    return {};
  }
}

function computePValue(control: VariantTotals, treatment: VariantTotals): number {
  /** Two-proportion z-test p-value; the stats library owns the real implementation. */
  return 1;
}

function liftInterval(
  control: VariantTotals,
  treatment: VariantTotals,
): {lift: number; ciLow: number; ciHigh: number} {
  /** Lift and its 95 % interval, computed from the two proportions. */
  return {lift: 0, ciLow: 0, ciHigh: 0};
}

export function routes(store: ExperimentStore): void {
  app.get('/v1/experiments/:experimentId/report', async (request, reply) => {
    const tenant = request.headers['x-tenant-id'];
    if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
    const {experimentId} = request.params as {experimentId: string};
    const experiment = await store.get(tenant, experimentId);
    if (experiment === null) return reply.code(404).send({error: 'unknown experiment'});

    const totals = await store.totals(experimentId);
    const control = totals['control'];
    const treatment = totals['treatment'];
    const sample = control.exposures + treatment.exposures;
    const {lift, ciLow, ciHigh} = liftInterval(control, treatment);
    const pValue = computePValue(control, treatment);

    if (sample < experiment.min_sample) {
      return reply.code(200).send({
        experiment_id: experimentId,
        status: 'inconclusive',
        winner: null,
        reason: 'minimum sample not reached',
        lift,
        ci_low: ciLow,
        ci_high: ciHigh,
        p_value: pValue,
      });
    }

    const expected = experiment.variants.find(variant => variant.key === 'treatment')!.weight / 100;
    const observed = treatment.exposures / sample;
    if (Math.abs(observed - expected) / expected > SRM_THRESHOLD) {
      return reply.code(200).send({
        experiment_id: experimentId,
        status: 'blocked',
        winner: null,
        caveat: {kind: 'srm', blocking: true, observed, expected},
        lift,
        ci_low: ciLow,
        ci_high: ciHigh,
        p_value: pValue,
      });
    }

    if (pValue < 0.05) {
      return reply.code(200).send({
        experiment_id: experimentId,
        status: 'significant',
        winner: lift > 0 ? 'treatment' : 'control',
        lift,
        ci_low: ciLow,
        ci_high: ciHigh,
        p_value: pValue,
      });
    }

    return reply.code(200).send({
      experiment_id: experimentId,
      status: 'inconclusive',
      winner: null,
      lift,
      ci_low: ciLow,
      ci_high: ciHigh,
      p_value: pValue,
    });
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

type Variant struct {
	Key    string \`json:"key"\`
	Weight int    \`json:"weight"\`
}

type Experiment struct {
	ID        string    \`json:"id"\`
	TenantID  string    \`json:"tenant_id"\`
	Variants  []Variant \`json:"variants"\`
	MinSample int       \`json:"min_sample"\`
}

type VariantTotals struct {
	Exposures   int \`json:"exposures"\`
	Conversions int \`json:"conversions"\`
}

type ExperimentStore struct{}

func (s *ExperimentStore) Get(ctx context.Context, tenant, experimentID string) (*Experiment, error) {
	return nil, nil
}

func (s *ExperimentStore) Totals(ctx context.Context, experimentID string) (map[string]VariantTotals, error) {
	return nil, nil
}

var store = &ExperimentStore{}

func ComputePValue(control, treatment VariantTotals) float64 {
	return 1
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func report(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	experimentID := r.PathValue("id")
	experiment, err := store.Get(r.Context(), tenant, experimentID)
	if err != nil || experiment == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown experiment"})
		return
	}
	totals, err := store.Totals(r.Context(), experimentID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	control := totals["control"]
	treatment := totals["treatment"]
	pValue := ComputePValue(control, treatment)
	winner := "control"
	if pValue < 0.05 {
		winner = "treatment"
	}
	lift := float64(treatment.Conversions)/float64(treatment.Exposures) - float64(control.Conversions)/float64(control.Exposures)
	writeJSON(rw, http.StatusOK, map[string]any{"experiment_id": experimentID, "winner": winner, "lift": lift, "p_value": pValue})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/experiments/{id}/report", report)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"net/http"
)

const SRMThreshold = 0.02

type Variant struct {
	Key    string \`json:"key"\`
	Weight int    \`json:"weight"\`
}

type Experiment struct {
	ID        string    \`json:"id"\`
	TenantID  string    \`json:"tenant_id"\`
	Variants  []Variant \`json:"variants"\`
	MinSample int       \`json:"min_sample"\`
}

type VariantTotals struct {
	Exposures   int \`json:"exposures"\`
	Conversions int \`json:"conversions"\`
}

type Caveat struct {
	Kind     string  \`json:"kind"\`
	Blocking bool    \`json:"blocking"\`
	Observed float64 \`json:"observed"\`
	Expected float64 \`json:"expected"\`
}

type Report struct {
	ExperimentID string   \`json:"experiment_id"\`
	Status       string   \`json:"status"\`
	Winner       *string  \`json:"winner"\`
	Reason       string   \`json:"reason,omitempty"\`
	Caveat       *Caveat  \`json:"caveat,omitempty"\`
	Lift         float64  \`json:"lift"\`
	CILow        float64  \`json:"ci_low"\`
	CIHigh       float64  \`json:"ci_high"\`
	PValue       float64  \`json:"p_value"\`
}

type ExperimentStore struct{}

func (s *ExperimentStore) Get(ctx context.Context, tenant, experimentID string) (*Experiment, error) {
	return nil, nil
}

func (s *ExperimentStore) Totals(ctx context.Context, experimentID string) (map[string]VariantTotals, error) {
	return nil, nil
}

var store = &ExperimentStore{}

func ComputePValue(control, treatment VariantTotals) float64 {
	return 1
}

func LiftInterval(control, treatment VariantTotals) (lift, ciLow, ciHigh float64) {
	return 0, 0, 0
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func report(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	experimentID := r.PathValue("id")
	experiment, err := store.Get(r.Context(), tenant, experimentID)
	if err != nil || experiment == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown experiment"})
		return
	}
	totals, err := store.Totals(r.Context(), experimentID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	control := totals["control"]
	treatment := totals["treatment"]
	sample := control.Exposures + treatment.Exposures
	lift, ciLow, ciHigh := LiftInterval(control, treatment)
	pValue := ComputePValue(control, treatment)
	body := Report{ExperimentID: experimentID, Lift: lift, CILow: ciLow, CIHigh: ciHigh, PValue: pValue}

	if sample < experiment.MinSample {
		body.Status = "inconclusive"
		body.Winner = nil
		body.Reason = "minimum sample not reached"
		writeJSON(rw, http.StatusOK, body)
		return
	}

	expectedShare := make(map[string]float64, len(experiment.Variants))
	for _, variant := range experiment.Variants {
		expectedShare[variant.Key] = float64(variant.Weight) / 100
	}
	expected := expectedShare["treatment"]
	observed := float64(treatment.Exposures) / float64(sample)
	if math.Abs(observed - expected) / expected > SRMThreshold {
		body.Status = "blocked"
		body.Winner = nil
		body.Caveat = &Caveat{Kind: "srm", Blocking: true, Observed: observed, Expected: expected}
		writeJSON(rw, http.StatusOK, body)
		return
	}

	if pValue < 0.05 {
		winner := "control"
		if lift > 0 {
			winner = "treatment"
		}
		body.Status = "significant"
		body.Winner = &winner
		writeJSON(rw, http.StatusOK, body)
		return
	}

	body.Status = "inconclusive"
	body.Winner = nil
	writeJSON(rw, http.StatusOK, body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/experiments/{id}/report", report)
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

final case class Variant(key: String, weight: Int)
final case class Experiment(id: String, tenant_id: String, variants: Seq[Variant], min_sample: Int)
final case class VariantTotals(exposures: Long, conversions: Long)

trait ExperimentStore {
  def get(tenant: String, id: String): Option[Experiment]
  def totals(experimentId: String): Map[String, VariantTotals]
}

object ExperimentReport {
  implicit val system: ActorSystem = ActorSystem("expd")

  val store: ExperimentStore = new ExperimentStore {
    def get(tenant: String, id: String): Option[Experiment] = None
    def totals(experimentId: String): Map[String, VariantTotals] = Map.empty
  }

  def computePValue(control: VariantTotals, treatment: VariantTotals): Double = 1.0

  val route: Route =
    path("v1" / "experiments" / Segment / "report") { experimentId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          val tenant = tenantOpt.filter(_.nonEmpty)
          if (tenant.isEmpty) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            store.get(tenant.get, experimentId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown experiment"}""")
              case Some(_) =>
                val totals = store.totals(experimentId)
                val control = totals("control")
                val treatment = totals("treatment")
                val pValue = computePValue(control, treatment)
                val winner = if (pValue < 0.05) "treatment" else "control"
                val lift = treatment.conversions.toDouble / treatment.exposures - control.conversions.toDouble / control.exposures
                complete(
                  StatusCodes.OK,
                  s"""{"experiment_id":"$experimentId","winner":"$winner","lift":$lift,"p_value":$pValue}"""
                )
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
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

final case class Variant(key: String, weight: Int)
final case class Experiment(id: String, tenant_id: String, variants: Seq[Variant], min_sample: Int)
final case class VariantTotals(exposures: Long, conversions: Long)

trait ExperimentStore {
  def get(tenant: String, id: String): Option[Experiment]
  def totals(experimentId: String): Map[String, VariantTotals]
}

object ExperimentReport {
  val SrmThreshold = 0.02

  implicit val system: ActorSystem = ActorSystem("expd")

  val store: ExperimentStore = new ExperimentStore {
    def get(tenant: String, id: String): Option[Experiment] = None
    def totals(experimentId: String): Map[String, VariantTotals] = Map.empty
  }

  def computePValue(control: VariantTotals, treatment: VariantTotals): Double = 1.0

  def liftInterval(control: VariantTotals, treatment: VariantTotals): (Double, Double, Double) = (0.0, 0.0, 0.0)

  val route: Route =
    path("v1" / "experiments" / Segment / "report") { experimentId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          val tenant = tenantOpt.filter(_.nonEmpty)
          if (tenant.isEmpty) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            store.get(tenant.get, experimentId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown experiment"}""")
              case Some(experiment) =>
                val totals = store.totals(experimentId)
                val control = totals("control")
                val treatment = totals("treatment")
                val sample = control.exposures + treatment.exposures
                val (lift, ciLow, ciHigh) = liftInterval(control, treatment)
                val pValue = computePValue(control, treatment)

                if (sample < experiment.min_sample) {
                  complete(
                    StatusCodes.OK,
                    s"""{"experiment_id":"$experimentId","status":"inconclusive","winner":null,""" +
                      s""""reason":"minimum sample not reached","lift":$lift,"ci_low":$ciLow,""" +
                      s""""ci_high":$ciHigh,"p_value":$pValue}"""
                  )
                } else {
                  val expectedShare = experiment.variants.map(variant => variant.key -> variant.weight.toDouble / 100).toMap
                  val expected = expectedShare("treatment")
                  val observed = treatment.exposures.toDouble / sample
                  if (math.abs(observed - expected) / expected > SrmThreshold) {
                    complete(
                      StatusCodes.OK,
                      s"""{"experiment_id":"$experimentId","status":"blocked","winner":null,""" +
                        s""""caveat":{"kind":"srm","blocking":true,"observed":$observed,"expected":$expected},""" +
                        s""""lift":$lift,"ci_low":$ciLow,"ci_high":$ciHigh,"p_value":$pValue}"""
                    )
                  } else if (pValue < 0.05) {
                    val winner = if (lift > 0) "treatment" else "control"
                    complete(
                      StatusCodes.OK,
                      s"""{"experiment_id":"$experimentId","status":"significant","winner":"$winner",""" +
                        s""""lift":$lift,"ci_low":$ciLow,"ci_high":$ciHigh,"p_value":$pValue}"""
                    )
                  } else {
                    complete(
                      StatusCodes.OK,
                      s"""{"experiment_id":"$experimentId","status":"inconclusive","winner":null,""" +
                        s""""lift":$lift,"ci_low":$ciLow,"ci_high":$ciHigh,"p_value":$pValue}"""
                    )
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

#include <map>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

struct Variant {
  std::string key;
  int weight;
};

struct Experiment {
  std::string id;
  std::string tenant_id;
  std::vector<Variant> variants;
  long long min_sample;
};

struct VariantTotals {
  long long exposures;
  long long conversions;
};

struct ExperimentStore {
  std::optional<Experiment> get(const std::string& tenant, const std::string& experimentId);
  std::map<std::string, VariantTotals> totals(const std::string& experimentId);
};

ExperimentStore store;

double computePValue(const VariantTotals& control, const VariantTotals& treatment) { return 1.0; }

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/experiments/([^/]+)/report)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string experimentId = req.matches[1];
    const auto experiment = store.get(tenant, experimentId);
    if (!experiment) {
      res.status = 404;
      res.set_content(R"({"error":"unknown experiment"})", "application/json");
      return;
    }
    const auto totals = store.totals(experimentId);
    const auto control = totals.at("control");
    const auto treatment = totals.at("treatment");
    const double pValue = computePValue(control, treatment);
    const std::string winner = pValue < 0.05 ? "treatment" : "control";
    const double lift = static_cast<double>(treatment.conversions) / treatment.exposures -
                        static_cast<double>(control.conversions) / control.exposures;
    res.status = 200;
    res.set_content(json{{"experiment_id", experimentId}, {"winner", winner}, {"lift", lift}, {"p_value", pValue}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <map>
#include <optional>
#include <string>
#include <tuple>
#include <vector>

using json = nlohmann::json;

constexpr double kSrmThreshold = 0.02;

struct Variant {
  std::string key;
  int weight;
};

struct Experiment {
  std::string id;
  std::string tenant_id;
  std::vector<Variant> variants;
  long long min_sample;
};

struct VariantTotals {
  long long exposures;
  long long conversions;
};

struct ExperimentStore {
  std::optional<Experiment> get(const std::string& tenant, const std::string& experimentId);
  std::map<std::string, VariantTotals> totals(const std::string& experimentId);
};

ExperimentStore store;

double computePValue(const VariantTotals& control, const VariantTotals& treatment) {
  // Two-proportion z-test p-value; the stats library owns the real implementation.
  return 1.0;
}

std::tuple<double, double, double> liftInterval(const VariantTotals& control, const VariantTotals& treatment) {
  // Lift and its 95 % interval, computed from the two proportions.
  return {0.0, 0.0, 0.0};
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/experiments/([^/]+)/report)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string experimentId = req.matches[1];
    const auto experiment = store.get(tenant, experimentId);
    if (!experiment) {
      res.status = 404;
      res.set_content(R"({"error":"unknown experiment"})", "application/json");
      return;
    }

    const auto totals = store.totals(experimentId);
    const auto control = totals.at("control");
    const auto treatment = totals.at("treatment");
    const long long sample = control.exposures + treatment.exposures;
    const auto [lift, ciLow, ciHigh] = liftInterval(control, treatment);
    const double pValue = computePValue(control, treatment);

    if (sample < experiment->min_sample) {
      res.status = 200;
      res.set_content(
          json{{"experiment_id", experimentId},
               {"status", "inconclusive"},
               {"winner", nullptr},
               {"reason", "minimum sample not reached"},
               {"lift", lift},
               {"ci_low", ciLow},
               {"ci_high", ciHigh},
               {"p_value", pValue}}
              .dump(),
          "application/json");
      return;
    }

    std::map<std::string, double> expectedShare;
    for (const auto& variant : experiment->variants) expectedShare[variant.key] = variant.weight / 100.0;
    const double expected = expectedShare.at("treatment");
    const double observed = static_cast<double>(treatment.exposures) / static_cast<double>(sample);
    if (std::abs(observed - expected) / expected > kSrmThreshold) {
      res.status = 200;
      res.set_content(
          json{{"experiment_id", experimentId},
               {"status", "blocked"},
               {"winner", nullptr},
               {"caveat", json{{"kind", "srm"}, {"blocking", true}, {"observed", observed}, {"expected", expected}}},
               {"lift", lift},
               {"ci_low", ciLow},
               {"ci_high", ciHigh},
               {"p_value", pValue}}
              .dump(),
          "application/json");
      return;
    }

    if (pValue < 0.05) {
      res.status = 200;
      res.set_content(
          json{{"experiment_id", experimentId},
               {"status", "significant"},
               {"winner", lift > 0 ? "treatment" : "control"},
               {"lift", lift},
               {"ci_low", ciLow},
               {"ci_high", ciHigh},
               {"p_value", pValue}}
              .dump(),
          "application/json");
      return;
    }

    res.status = 200;
    res.set_content(
        json{{"experiment_id", experimentId},
             {"status", "inconclusive"},
             {"winner", nullptr},
             {"lift", lift},
             {"ci_low", ciLow},
             {"ci_high", ciHigh},
             {"p_value", pValue}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A product manager refreshes the report on day two, sees `winner: treatment` with a 2 % lift, ships it, and the lift is gone a week later; nobody noticed the arms were 46/54.',
    'The starter computes `p_value` from whatever counts exist and sets the winner from `p < 0.05` alone; it has no `min_sample` branch, no share comparison against the split, and returns `lift` with no interval.',
    'Order the guards: `sample < min_sample` answers `inconclusive`; `abs(observed - expected) / expected > SRM_THRESHOLD` adds a blocking `caveat`; only then compare `p_value < 0.05`. Return `ci_low`/`ci_high` with every `lift`.',
  ],
  debrief: `The fix is ordering plus disclosure. The sample guard runs first because a p-value computed on
whatever data exists turns a 5 % false-positive rate into a coin flip for anyone who refreshes the
dashboard every morning. The SRM check runs next because a split that drifted from the frozen design
invalidates the comparison itself, so it has to block rather than annotate. Only then is the p-value
consulted, and every lift travels with its 95 % interval so a reader can tell a two-point move from
noise.

Production platforms add sequential tests that make repeated looks valid, record the design version
the report was computed against, and raise the SRM alarm on the consumer side before anyone opens a
report.`,
};
