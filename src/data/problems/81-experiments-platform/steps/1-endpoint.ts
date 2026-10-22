import type {Step} from '@/lib/types';

/**
 * Step 1 — the experiment endpoint. The design of an experiment (variants, split, unit, minimum
 * sample and salt) is a document pinned at creation; a later edit is a new version, not a live
 * mutation, because a user who moved between variants mid-experiment contaminates every number
 * that follows.
 */
export const experimentEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/experiments: assignment frozen at start',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers both routes,
creates experiments, and its 201 looks right for a 50/50 split. It hides the four defects that turn
an experiment into an anecdote — read it like the platform owner, fix it, and prove the fix with the
checks below.

Implement \`POST /v1/experiments\` with body
\`{"variants": [{"key": "control", "weight": 50}, {"key": "treatment", "weight": 50}], "unit": "user", "min_sample": 10000}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing or empty tenant is **401**.
- At least **2** variants, with distinct non-empty \`key\`s; anything else is **400**.
- Every \`weight\` is a non-negative integer and the weights must sum to **exactly 100**: 99 or 101 is
  **400**. Never normalize — a silently reweighted split is a different experiment than the one the
  operator approved, and every assignment that follows is bucketed against numbers nobody signed off.
- \`unit\` is one of \`user\`, \`session\`, \`account\`; anything else is **400**. The unit decides which
  entity is randomized, so a typo is a different experiment, not a detail.
- \`min_sample\` is an integer \`>= 1\` (**400** otherwise) and is pinned together with the rest of the
  design.
- The \`salt\` is pinned at creation: take the caller's if one is supplied, otherwise generate it
  server-side (never derive it from the split, or editing the split re-buckets every user).
- Answer **201** echoing the experiment id, \`version\` starting at **1**, the \`salt\`, the pinned
  split exactly as validated, and \`status: "running"\`.
- \`PATCH /v1/experiments/{id}\` may only touch cosmetic fields (\`name\`, \`description\`). A patch that
  carries \`variants\` (any \`weight\`), \`unit\`, \`min_sample\` or \`salt\` is **409** with
  \`{"error": "…frozen…", "required": "new version"}\` — the live experiment is never mutated; a
  design change is a new version.
- Log the creation with the tenant and the experiment id; never log the request body wholesale.

**Failure mode the checks target.** The draft accepts any split and normalizes it
(\`sum(...) or 1\` reweighting), so a design that sums to 99 or 101 is silently turned into a
different experiment instead of rejected; it accepts any \`unit\` string, so a typo randomizes a
different entity than the report assumes; it never looks at the variant count, so a one-variant
"experiment" runs; and its \`PATCH\` overwrites \`weights\` and \`unit\` in place with no version check,
so one edit moves users between variants mid-flight and every downstream number is contaminated.`,
  sequence: {
    participants: ['Operator', 'Experiment API', 'experiment store'],
    messages: [
      {from: 'Operator', to: 'Experiment API', label: 'POST /v1/experiments · X-Tenant-Id', kind: 'sync'},
      {
        from: 'Experiment API',
        to: 'Experiment API',
        label: '≥2 variants · weights sum exactly 100 · unit ∈ {user, session, account} · min_sample ≥ 1',
        kind: 'sync',
      },
      {
        from: 'Experiment API',
        to: 'experiment store',
        label: 'insert design · version=1 · salt · status=running',
        kind: 'sync',
      },
      {from: 'experiment store', to: 'Experiment API', label: 'experiment {id, version, salt}', kind: 'reply'},
      {
        from: 'Experiment API',
        to: 'Operator',
        label: '201 {id, version: 1, salt, variants, status} · logs tenant + id',
        kind: 'reply',
      },
      {from: 'Operator', to: 'Experiment API', label: 'PATCH /v1/experiments/{id} · {"variants": …}', kind: 'sync'},
      {from: 'Experiment API', to: 'Experiment API', label: 'design field → frozen, never mutated', kind: 'sync'},
      {
        from: 'Experiment API',
        to: 'Operator',
        label: '409 {error: "…frozen…", required: "new version"}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers create and the design-changing update route',
      detail:
        '`POST /v1/experiments` and `PATCH /v1/experiments/{id}` are both registered: an experiment is created through one, and the update route is the one that has to refuse design changes.',
      match: {
        python: {
          all: [
            /@app\.post\(\s*["']\/v1\/experiments["']/,
            /@app\.patch\(\s*["']\/v1\/experiments\/\{experiment_id\}["']/,
          ],
        },
        typescript: {
          all: [/app\.post\(\s*'\/v1\/experiments'/, /app\.patch\(\s*'\/v1\/experiments\/:id'/],
        },
        go: {
          all: [/HandleFunc\(\s*"POST \/v1\/experiments"/, /HandleFunc\(\s*"PATCH \/v1\/experiments\/\{id\}"/],
        },
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"experiments"\s*\)/, /\bpost\s*\{/, /\bpatch\s*\{/, /Segment/],
        },
        cpp: {all: [/svr\.Post\(\s*"\/v1\/experiments"/, /svr\.Patch\(\s*R?"\(\/v1\/experiments/]},
      },
    },
    {
      id: 'variants',
      title: 'Requires at least 2 variants with distinct non-empty keys',
      detail:
        'The create path counts the variants against `MIN_VARIANTS` (2) and rejects duplicate or empty `key`s with **400**. The draft never looks at the count, so a one-variant "experiment" is accepted and its whole traffic lands in a single arm that cannot be compared to anything.',
      match: {
        python: {
          all: [
            /MIN_VARIANTS\s*=\s*2/,
            /def validate_variants\(/,
            /len\(keys\)\s*!=\s*len\(variants\)/,
            /status_code\s*=\s*400/,
          ],
        },
        typescript: {
          all: [
            /MIN_VARIANTS\s*=\s*2/,
            /function validateVariants\(/,
            /keys\.size\s*!==\s*variants\.length/,
            /HttpError\(\s*400\b/,
          ],
        },
        go: {
          all: [/minVariants\s*=\s*2/, /func validateVariants\(/, /duplicate variant keys/, /StatusBadRequest/],
        },
        scala: {
          all: [
            /val MinVariants\s*=\s*2/,
            /def validateVariants\(/,
            /map\(_\.key\)\.distinct\.size\s*!=\s*variants\.size/,
            /StatusCodes\.BadRequest/,
          ],
        },
        cpp: {
          all: [/kMinVariants = 2/, /validate_variants\(/, /duplicate variant keys/, /\b400\b/],
        },
      },
    },
    {
      id: 'split-exact',
      title: 'Weights must sum to exactly 100 — rejected, never normalized',
      detail:
        'The weights are validated as non-negative integers whose sum is compared against `SPLIT_TOTAL` (100) and a split that sums to 99 or 101 answers **400**. The draft divides by `sum(...) or 1` instead, so an unapproved split is silently reweighted and the experiment that runs is not the experiment that was asked for.',
      match: {
        python: {
          all: [
            /SPLIT_TOTAL\s*=\s*100/,
            /def validate_split\(/,
            /sum\(variant\.weight for variant in variants\)\s*!=\s*SPLIT_TOTAL/,
            /status_code\s*=\s*400/,
          ],
          none: [/sum\([^\n]*\)\s*or\s+1/],
        },
        typescript: {
          all: [
            /SPLIT_TOTAL\s*=\s*100/,
            /function validateSplit\(/,
            /total\s*!==\s*SPLIT_TOTAL/,
            /HttpError\(\s*400\b/,
          ],
          none: [/reduce\([^\n]*\)\s*\|\|\s*1/],
        },
        go: {
          all: [/splitTotal\s*=\s*100/, /func validateSplit\(/, /total\s*!=\s*splitTotal/, /StatusBadRequest/],
          none: [/float64\(total\)/],
        },
        scala: {
          all: [
            /val SplitTotal\s*=\s*100/,
            /def validateSplit\(/,
            /map\(_\.weight\)\.sum\s*!=\s*SplitTotal/,
            /StatusCodes\.BadRequest/,
          ],
          none: [/safeTotal/],
        },
        cpp: {
          all: [/kSplitTotal = 100/, /validate_split\(/, /total != kSplitTotal/, /\b400\b/],
          none: [/std::max\(\s*total\s*,\s*1\s*\)/],
        },
      },
    },
    {
      id: 'unit-frozen',
      title: 'Unit is restricted to the allowed set and frozen after launch',
      detail:
        'Create validates `unit` against the allowed set (**400**), and the update path treats a `unit` in the patch body as a design change (**409**). The draft takes any string as the unit and overwrites it in place on `PATCH`, so a typo silently re-randomizes a different entity than the one the analysis assumes.',
      match: {
        python: {
          all: [
            /UNITS\s*=\s*\{/,
            /def validate_unit\(/,
            /status_code\s*=\s*400/,
            /patch\.unit is not None/,
            /status_code\s*=\s*409/,
          ],
        },
        typescript: {
          all: [
            /const UNITS\s*:/,
            /function validateUnit\(/,
            /HttpError\(\s*400\b/,
            /patch\.unit\s*!==\s*undefined/,
            /code\(\s*409\s*\)/,
          ],
        },
        go: {
          all: [
            /var allowedUnits = map\[string\]bool\{/,
            /func validateUnit\(/,
            /StatusBadRequest/,
            /patch\.Unit != nil/,
            /StatusConflict/,
          ],
        },
        scala: {
          all: [
            /val AllowedUnits = Set\(/,
            /def validateUnit\(/,
            /StatusCodes\.BadRequest/,
            /patch\.unit\.isDefined/,
            /StatusCodes\.Conflict/,
          ],
        },
        cpp: {
          all: [/kAllowedUnits = \{/, /validate_unit\(/, /\b400\b/, /body\.contains\("unit"\)/, /\b409\b/],
        },
      },
    },
    {
      id: 'new-version',
      title: 'A design change is 409 and demands a new version',
      detail:
        'A `PATCH` that carries `variants`, `unit`, `min_sample` or `salt` answers **409** with an error naming the frozen design and `required: "new version"`, so the live experiment is never mutated. The draft re-writes `weights` and `unit` of the running experiment and returns 200, which is exactly the incident this step exists for.',
      match: {
        python: {
          all: [
            /SPLIT_FROZEN\s*=\s*"[^"]*frozen[^"]*"/,
            /REQUIRED_NEW_VERSION\s*=\s*"new version"/,
            /status_code\s*=\s*409/,
            /"required":\s*REQUIRED_NEW_VERSION/,
          ],
        },
        typescript: {
          all: [
            /const SPLIT_FROZEN\s*=\s*'[^']*frozen[^']*'/,
            /const REQUIRED_NEW_VERSION\s*=\s*'new version'/,
            /code\(\s*409\s*\)/,
            /required:\s*REQUIRED_NEW_VERSION/,
          ],
        },
        go: {
          all: [
            /splitFrozen\s*=\s*"[^"]*frozen[^"]*"/,
            /requiredNewVersion\s*=\s*"new version"/,
            /StatusConflict/,
            /"required":\s*requiredNewVersion/,
          ],
        },
        scala: {
          all: [
            /val SplitFrozen\s*=\s*"[^"]*frozen[^"]*"/,
            /val RequiredNewVersion\s*=\s*"new version"/,
            /StatusCodes\.Conflict/,
            /"required":"\$RequiredNewVersion"/,
          ],
        },
        cpp: {
          all: [
            /kSplitFrozen = "[^"]*frozen[^"]*"/,
            /kRequiredNewVersion = "new version"/,
            /\b409\b/,
            /\{"required", kRequiredNewVersion\}/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""api.py — a model-generated first draft of the experiment endpoint."""
import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("expd")

EXPERIMENTS: dict[str, dict] = {}


class Variant(BaseModel):
    key: str
    weight: int


class ExperimentDesign(BaseModel):
    variants: list[Variant]
    unit: str
    min_sample: int
    salt: str | None = None


def split_shares(variants: list[Variant]) -> list[dict]:
    total = sum(variant.weight for variant in variants) or 1
    return [{"key": variant.key, "weight": round(variant.weight * 100 / total, 2)} for variant in variants]


# TODO: this draft normalizes whatever split it is handed, validates neither the variant count nor
# the unit, and lets PATCH overwrite weights/unit in place with no version check. Review it.


@app.post("/v1/experiments")
def create_experiment(
    body: ExperimentDesign, tenant: str = Header(alias="X-Tenant-Id")
) -> JSONResponse:
    experiment = {
        "id": uuid.uuid4().hex,
        "tenant_id": tenant,
        "variants": split_shares(body.variants),
        "unit": body.unit,
        "min_sample": body.min_sample,
        "salt": body.salt or uuid.uuid4().hex,
        "version": 1,
        "status": "running",
    }
    EXPERIMENTS[experiment["id"]] = experiment
    logger.info("experiment created: %s", body.model_dump())
    return JSONResponse(experiment, status_code=201)


@app.patch("/v1/experiments/{experiment_id}")
def update_experiment(experiment_id: str, body: ExperimentDesign) -> JSONResponse:
    experiment = EXPERIMENTS[experiment_id]
    experiment["variants"] = split_shares(body.variants)
    experiment["unit"] = body.unit
    return JSONResponse(experiment, status_code=200)
`,
      solution: `"""POST /v1/experiments · PATCH /v1/experiments/{id}.

The design — variants, split, unit, min_sample and the salt — is pinned when the experiment starts.
A later design change is a new version, never a live mutation of the running experiment.
"""

import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("expd")

MIN_VARIANTS = 2
SPLIT_TOTAL = 100
MIN_SAMPLE_FLOOR = 1
INITIAL_VERSION = 1
RUNNING = "running"
UNITS = {"user", "session", "account"}
SPLIT_FROZEN = "the split, unit, min_sample and salt are frozen at start"
REQUIRED_NEW_VERSION = "new version"


class Variant(BaseModel):
    key: str
    weight: int


class ExperimentDesign(BaseModel):
    variants: list[Variant]
    unit: str
    min_sample: int
    salt: str | None = None


class ExperimentPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    variants: list[Variant] | None = None
    unit: str | None = None
    min_sample: int | None = None
    salt: str | None = None


class ExperimentStore:
    """Persistence seam; the state step adds the Redis assignment cache on top of it."""

    def insert(self, experiment: dict) -> dict:
        """Persist the experiment with its pinned design and return it."""
        raise NotImplementedError

    def get(self, tenant: str, experiment_id: str) -> dict | None:
        """The experiment with this id when it belongs to this tenant."""
        raise NotImplementedError

    def save_cosmetic(self, experiment: dict) -> None:
        """Persist a name/description-only update."""
        raise NotImplementedError


store = ExperimentStore()


def require_tenant(tenant: str | None) -> str:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    return tenant


def validate_variants(variants: list[Variant]) -> None:
    if len(variants) < MIN_VARIANTS:
        raise HTTPException(status_code=400, detail=f"at least {MIN_VARIANTS} variants are required")
    keys = {variant.key for variant in variants}
    if len(keys) != len(variants):
        raise HTTPException(status_code=400, detail="duplicate variant keys")
    if any(key == "" for key in keys):
        raise HTTPException(status_code=400, detail="variant keys must be non-empty")


def validate_split(variants: list[Variant]) -> None:
    for variant in variants:
        if isinstance(variant.weight, bool) or not isinstance(variant.weight, int) or variant.weight < 0:
            raise HTTPException(status_code=400, detail="every weight must be a non-negative integer")
    if sum(variant.weight for variant in variants) != SPLIT_TOTAL:
        raise HTTPException(status_code=400, detail=f"weights must sum to exactly {SPLIT_TOTAL}")


def validate_unit(unit: str) -> None:
    if unit not in UNITS:
        raise HTTPException(status_code=400, detail="unit must be one of user, session, account")


def validate_min_sample(min_sample: int) -> None:
    if isinstance(min_sample, bool) or not isinstance(min_sample, int) or min_sample < MIN_SAMPLE_FLOOR:
        raise HTTPException(status_code=400, detail="min_sample must be an integer >= 1")


def validate_design(body: ExperimentDesign) -> None:
    validate_variants(body.variants)
    validate_split(body.variants)
    validate_unit(body.unit)
    validate_min_sample(body.min_sample)


def carries_design(patch: ExperimentPatch) -> bool:
    return (
        patch.variants is not None
        or patch.unit is not None
        or patch.min_sample is not None
        or patch.salt is not None
    )


@app.post("/v1/experiments")
def create_experiment(
    body: ExperimentDesign, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    tenant_id = require_tenant(tenant)
    validate_design(body)
    experiment = {
        "id": uuid.uuid4().hex,
        "tenant_id": tenant_id,
        "name": "",
        "description": "",
        "variants": [{"key": variant.key, "weight": variant.weight} for variant in body.variants],
        "unit": body.unit,
        "min_sample": body.min_sample,
        "salt": body.salt or uuid.uuid4().hex,
        "version": INITIAL_VERSION,
        "status": RUNNING,
    }
    store.insert(experiment)
    logger.info("experiment created tenant=%s id=%s", tenant_id, experiment["id"])
    return JSONResponse(experiment, status_code=201)


@app.patch("/v1/experiments/{experiment_id}")
def update_experiment(
    experiment_id: str,
    body: ExperimentPatch,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    tenant_id = require_tenant(tenant)
    experiment = store.get(tenant_id, experiment_id)
    if experiment is None:
        raise HTTPException(status_code=404, detail="unknown experiment")
    if carries_design(body):
        raise HTTPException(
            status_code=409,
            detail={"error": SPLIT_FROZEN, "required": REQUIRED_NEW_VERSION},
        )
    if body.name is not None:
        experiment["name"] = body.name
    if body.description is not None:
        experiment["description"] = body.description
    store.save_cosmetic(experiment)
    logger.info("experiment updated tenant=%s id=%s", tenant_id, experiment_id)
    return JSONResponse(experiment, status_code=200)
`,
    },
    typescript: {
      starter: `/** api.ts — a model-generated first draft of the experiment endpoint. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface Variant {
  key: string;
  weight: number;
}

interface ExperimentDesign {
  variants: Variant[];
  unit: string;
  min_sample: number;
  salt?: string;
}

interface Experiment extends ExperimentDesign {
  id: string;
  version: number;
  status: string;
}

const experiments = new Map<string, Experiment>();

// TODO: this draft normalizes whatever split it is handed, validates neither the variant count nor
// the unit, and lets PATCH overwrite weights/unit in place with no version check. Review it.

app.post('/v1/experiments', async (request, reply) => {
  const body = request.body as ExperimentDesign;
  const total = body.variants.reduce((sum, variant) => sum + variant.weight, 0) || 1;
  const split = body.variants.map(variant => ({key: variant.key, weight: (variant.weight * 100) / total}));
  const experiment: Experiment = {
    id: randomUUID(),
    variants: split,
    unit: body.unit,
    min_sample: body.min_sample,
    salt: body.salt ?? randomUUID(),
    version: 1,
    status: 'running',
  };
  experiments.set(experiment.id, experiment);
  request.log.info({tenant: request.headers['x-tenant-id'], body}, 'experiment created');
  return reply.code(201).send(experiment);
});

app.patch('/v1/experiments/:id', async (request, reply) => {
  const {id} = request.params as {id: string};
  const body = request.body as Partial<ExperimentDesign>;
  const experiment = experiments.get(id)!;
  if (body.variants !== undefined) experiment.variants = body.variants;
  if (body.unit !== undefined) experiment.unit = body.unit;
  return reply.code(200).send(experiment);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/experiments · PATCH /v1/experiments/:id.

The design — variants, split, unit, min_sample and the salt — is pinned when the experiment starts.
A later design change is a new version, never a live mutation of the running experiment.
 */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MIN_VARIANTS = 2;
const SPLIT_TOTAL = 100;
const MIN_SAMPLE_FLOOR = 1;
const INITIAL_VERSION = 1;
const RUNNING = 'running';
const UNITS: Record<string, true> = {user: true, session: true, account: true};
const SPLIT_FROZEN = 'the split, unit, min_sample and salt are frozen at start';
const REQUIRED_NEW_VERSION = 'new version';

interface Variant {
  key: string;
  weight: number;
}

interface ExperimentDesign {
  variants: Variant[];
  unit: string;
  min_sample: number;
  salt?: string;
}

interface ExperimentPatch {
  name?: string;
  description?: string;
  variants?: Variant[];
  unit?: string;
  min_sample?: number;
  salt?: string;
}

interface Experiment {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  variants: Variant[];
  unit: string;
  min_sample: number;
  salt: string;
  version: number;
  status: string;
}

class ExperimentStore {
  async insert(experiment: Experiment): Promise<Experiment> {
    return experiment;
  }

  async get(_tenant: string, _id: string): Promise<Experiment | null> {
    return null;
  }

  async saveCosmetic(_experiment: Experiment): Promise<void> {}
}

const store = new ExperimentStore();

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requireTenant(tenant: unknown): string {
  if (typeof tenant !== 'string' || tenant === '') throw new HttpError(401, 'missing X-Tenant-Id');
  return tenant;
}

function validateVariants(variants: Variant[]): void {
  if (variants.length < MIN_VARIANTS) throw new HttpError(400, \`at least \${MIN_VARIANTS} variants are required\`);
  const keys = new Set(variants.map(variant => variant.key));
  if (keys.size !== variants.length) throw new HttpError(400, 'duplicate variant keys');
  if ([...keys].some(key => key === '')) throw new HttpError(400, 'variant keys must be non-empty');
}

function validateSplit(variants: Variant[]): void {
  if (variants.some(variant => !Number.isInteger(variant.weight) || variant.weight < 0))
    throw new HttpError(400, 'every weight must be a non-negative integer');
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  if (total !== SPLIT_TOTAL) throw new HttpError(400, \`weights must sum to exactly \${SPLIT_TOTAL}\`);
}

function validateUnit(unit: string): void {
  if (UNITS[unit] !== true) throw new HttpError(400, 'unit must be one of user, session, account');
}

function validateMinSample(minSample: number): void {
  if (!Number.isInteger(minSample) || minSample < MIN_SAMPLE_FLOOR)
    throw new HttpError(400, 'min_sample must be an integer >= 1');
}

function validateDesign(body: ExperimentDesign): void {
  validateVariants(body.variants);
  validateSplit(body.variants);
  validateUnit(body.unit);
  validateMinSample(body.min_sample);
}

function carriesDesign(patch: ExperimentPatch): boolean {
  return (
    patch.variants !== undefined ||
    patch.unit !== undefined ||
    patch.min_sample !== undefined ||
    patch.salt !== undefined
  );
}

app.setErrorHandler((error, request, reply) => {
  if (error instanceof HttpError) return reply.code(error.status).send({error: error.message});
  request.log.error({err: error}, 'experiment request failed');
  return reply.code(500).send({error: 'internal error'});
});

app.post('/v1/experiments', async (request, reply) => {
  const tenant = requireTenant(request.headers['x-tenant-id']);
  const body = (request.body ?? {}) as ExperimentDesign;
  validateDesign(body);
  const experiment: Experiment = {
    id: randomUUID(),
    tenant_id: tenant,
    name: '',
    description: '',
    variants: body.variants.map(variant => ({key: variant.key, weight: variant.weight})),
    unit: body.unit,
    min_sample: body.min_sample,
    salt: body.salt !== undefined && body.salt !== '' ? body.salt : randomUUID(),
    version: INITIAL_VERSION,
    status: RUNNING,
  };
  await store.insert(experiment);
  request.log.info({tenant, id: experiment.id}, 'experiment created');
  return reply.code(201).send(experiment);
});

app.patch('/v1/experiments/:id', async (request, reply) => {
  const tenant = requireTenant(request.headers['x-tenant-id']);
  const {id} = request.params as {id: string};
  const experiment = await store.get(tenant, id);
  if (experiment === null) throw new HttpError(404, 'unknown experiment');
  const body = (request.body ?? {}) as ExperimentPatch;
  if (carriesDesign(body))
    return reply.code(409).send({error: SPLIT_FROZEN, required: REQUIRED_NEW_VERSION});
  if (body.name !== undefined) experiment.name = body.name;
  if (body.description !== undefined) experiment.description = body.description;
  await store.saveCosmetic(experiment);
  request.log.info({tenant, id}, 'experiment updated');
  return reply.code(200).send(experiment);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `// api.go — a model-generated first draft of the experiment endpoint.
package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type Variant struct {
	Key    string \`json:"key"\`
	Weight int    \`json:"weight"\`
}

type Split struct {
	Key    string  \`json:"key"\`
	Weight float64 \`json:"weight"\`
}

type Experiment struct {
	ID        string  \`json:"id"\`
	TenantID  string  \`json:"tenant_id"\`
	Variants  []Split \`json:"variants"\`
	Unit      string  \`json:"unit"\`
	MinSample int     \`json:"min_sample"\`
	Salt      string  \`json:"salt"\`
	Version   int     \`json:"version"\`
	Status    string  \`json:"status"\`
}

var experiments = map[string]Experiment{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// TODO: this draft normalizes whatever split it is handed, validates neither the variant count nor
// the unit, and lets PATCH overwrite weights/unit in place with no version check. Review it.

func createExperiment(rw http.ResponseWriter, r *http.Request) {
	var body struct {
		Variants  []Variant \`json:"variants"\`
		Unit      string    \`json:"unit"\`
		MinSample int       \`json:"min_sample"\`
		Salt      string    \`json:"salt"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	total := 0
	for _, variant := range body.Variants {
		total += variant.Weight
	}
	if total == 0 {
		total = 1
	}
	split := make([]Split, 0, len(body.Variants))
	for _, variant := range body.Variants {
		split = append(split, Split{Key: variant.Key, Weight: float64(variant.Weight) * 100 / float64(total)})
	}
	salt := body.Salt
	if salt == "" {
		salt = uuid.NewString()
	}
	experiment := Experiment{
		ID:        uuid.NewString(),
		TenantID:  r.Header.Get("X-Tenant-Id"),
		Variants:  split,
		Unit:      body.Unit,
		MinSample: body.MinSample,
		Salt:      salt,
		Version:   1,
		Status:    "running",
	}
	experiments[experiment.ID] = experiment
	log.Printf("experiment created: %+v", body)
	writeJSON(rw, http.StatusCreated, experiment)
}

func updateExperiment(rw http.ResponseWriter, r *http.Request) {
	var body struct {
		Variants  []Variant \`json:"variants"\`
		Unit      string    \`json:"unit"\`
		MinSample int       \`json:"min_sample"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	experiment := experiments[r.PathValue("id")]
	experiment.Unit = body.Unit
	experiment.MinSample = body.MinSample
	experiments[experiment.ID] = experiment
	writeJSON(rw, http.StatusOK, experiment)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/experiments", createExperiment)
	mux.HandleFunc("PATCH /v1/experiments/{id}", updateExperiment)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `// POST /v1/experiments · PATCH /v1/experiments/{id}.
//
// The design — variants, split, unit, min_sample and the salt — is pinned when the experiment
// starts. A later design change is a new version, never a live mutation of the running experiment.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const (
	minVariants    = 2
	splitTotal     = 100
	minSampleFloor = 1
	initialVersion = 1
	running        = "running"
)

const (
	splitFrozen        = "the split, unit, min_sample and salt are frozen at start"
	requiredNewVersion = "new version"
)

var allowedUnits = map[string]bool{"user": true, "session": true, "account": true}

type Variant struct {
	Key    string \`json:"key"\`
	Weight int    \`json:"weight"\`
}

type ExperimentDesign struct {
	Variants  []Variant \`json:"variants"\`
	Unit      string    \`json:"unit"\`
	MinSample int       \`json:"min_sample"\`
	Salt      string    \`json:"salt"\`
}

type ExperimentPatch struct {
	Name        *string   \`json:"name"\`
	Description *string   \`json:"description"\`
	Variants    []Variant \`json:"variants"\`
	Unit        *string   \`json:"unit"\`
	MinSample   *int      \`json:"min_sample"\`
	Salt        *string   \`json:"salt"\`
}

type Experiment struct {
	ID          string    \`json:"id"\`
	TenantID    string    \`json:"tenant_id"\`
	Name        string    \`json:"name"\`
	Description string    \`json:"description"\`
	Variants    []Variant \`json:"variants"\`
	Unit        string    \`json:"unit"\`
	MinSample   int       \`json:"min_sample"\`
	Salt        string    \`json:"salt"\`
	Version     int       \`json:"version"\`
	Status      string    \`json:"status"\`
}

// ExperimentStore is implemented by the state step, which adds the Redis assignment cache on top.
type ExperimentStore struct{}

func (s *ExperimentStore) Insert(experiment Experiment) (Experiment, error) {
	return experiment, nil
}

func (s *ExperimentStore) Get(tenant, id string) (Experiment, bool, error) {
	return Experiment{}, false, nil
}

func (s *ExperimentStore) SaveCosmetic(experiment Experiment) error {
	return nil
}

var store = &ExperimentStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func validateVariants(variants []Variant) string {
	if len(variants) < minVariants {
		return fmt.Sprintf("at least %d variants are required", minVariants)
	}
	keys := map[string]bool{}
	for _, variant := range variants {
		if variant.Key == "" {
			return "variant keys must be non-empty"
		}
		if keys[variant.Key] {
			return "duplicate variant keys"
		}
		keys[variant.Key] = true
	}
	return ""
}

func validateSplit(variants []Variant) string {
	total := 0
	for _, variant := range variants {
		if variant.Weight < 0 {
			return "every weight must be a non-negative integer"
		}
		total += variant.Weight
	}
	if total != splitTotal {
		return fmt.Sprintf("weights must sum to exactly %d", splitTotal)
	}
	return ""
}

func validateUnit(unit string) string {
	if !allowedUnits[unit] {
		return "unit must be one of user, session, account"
	}
	return ""
}

func validateMinSample(minSample int) string {
	if minSample < minSampleFloor {
		return "min_sample must be an integer >= 1"
	}
	return ""
}

func validateDesign(design ExperimentDesign) string {
	for _, problem := range []string{
		validateVariants(design.Variants),
		validateSplit(design.Variants),
		validateUnit(design.Unit),
		validateMinSample(design.MinSample),
	} {
		if problem != "" {
			return problem
		}
	}
	return ""
}

func carriesDesign(patch ExperimentPatch) bool {
	return patch.Variants != nil || patch.Unit != nil || patch.MinSample != nil || patch.Salt != nil
}

func createExperiment(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body ExperimentDesign
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if problem := validateDesign(body); problem != "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": problem})
		return
	}
	salt := body.Salt
	if salt == "" {
		salt = uuid.NewString()
	}
	experiment := Experiment{
		ID:        uuid.NewString(),
		TenantID:  tenant,
		Variants:  body.Variants,
		Unit:      body.Unit,
		MinSample: body.MinSample,
		Salt:      salt,
		Version:   initialVersion,
		Status:    running,
	}
	saved, err := store.Insert(experiment)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "store unavailable"})
		return
	}
	log.Printf("experiment created tenant=%s id=%s", tenant, saved.ID)
	writeJSON(rw, http.StatusCreated, saved)
}

func updateExperiment(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body ExperimentPatch
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	experiment, found, err := store.Get(tenant, r.PathValue("id"))
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "store unavailable"})
		return
	}
	if !found {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown experiment"})
		return
	}
	if carriesDesign(body) {
		writeJSON(rw, http.StatusConflict, map[string]string{
			"error":    splitFrozen,
			"required": requiredNewVersion,
		})
		return
	}
	if body.Name != nil {
		experiment.Name = *body.Name
	}
	if body.Description != nil {
		experiment.Description = *body.Description
	}
	if err := store.SaveCosmetic(experiment); err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "store unavailable"})
		return
	}
	log.Printf("experiment updated tenant=%s id=%s", tenant, experiment.ID)
	writeJSON(rw, http.StatusOK, experiment)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/experiments", createExperiment)
	mux.HandleFunc("PATCH /v1/experiments/{id}", updateExperiment)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `// api.scala — a model-generated first draft of the experiment endpoint.
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Variant(key: String, weight: Int)
final case class ExperimentDesign(variants: Seq[Variant], unit: String, min_sample: Int, salt: Option[String])
final case class Experiment(
    id: String,
    variants: Seq[Variant],
    unit: String,
    min_sample: Int,
    salt: String,
    version: Int,
    status: String
)

object ExperimentApi {
  implicit val system: ActorSystem = ActorSystem("expd")
  implicit val variantFormat: RootJsonFormat[Variant] = jsonFormat2(Variant)
  implicit val designFormat: RootJsonFormat[ExperimentDesign] = jsonFormat4(ExperimentDesign)
  implicit val experimentFormat: RootJsonFormat[Experiment] = jsonFormat7(Experiment)

  val experiments = scala.collection.mutable.Map.empty[String, Experiment]

  // TODO: this draft normalizes whatever split it is handed, validates neither the variant count nor
  // the unit, and lets PATCH overwrite weights/unit in place with no version check. Review it.

  val route: Route =
    path("v1" / "experiments") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[ExperimentDesign]) { body =>
            val total = body.variants.map(_.weight).sum
            val safeTotal = if (total == 0) 1 else total
            val split = body.variants.map(variant => Variant(variant.key, variant.weight * 100 / safeTotal))
            val experiment = Experiment(
              UUID.randomUUID().toString,
              split,
              body.unit,
              body.min_sample,
              body.salt.getOrElse(UUID.randomUUID().toString),
              1,
              "running"
            )
            experiments(experiment.id) = experiment
            system.log.info(s"experiment created: $body")
            complete(StatusCodes.Created, experiment)
          }
        }
      }
    } ~
      path("v1" / "experiments" / Segment) { experimentId =>
        patch {
          entity(as[ExperimentDesign]) { body =>
            val experiment = experiments(experimentId)
            val updated = experiment.copy(variants = body.variants, unit = body.unit)
            experiments(experimentId) = updated
            complete(StatusCodes.OK, updated)
          }
        }
      }

  def main(args: Array[String]): Unit = Http().newServerAt("0.0.0.0", 8443).bind(route)
}
`,
      solution: `// POST /v1/experiments · PATCH /v1/experiments/{id}.
//
// The design — variants, split, unit, min_sample and the salt — is pinned when the experiment
// starts. A later design change is a new version, never a live mutation of the running experiment.
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.{ExceptionHandler, Route}
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Variant(key: String, weight: Int)
final case class ExperimentDesign(variants: Seq[Variant], unit: String, min_sample: Int, salt: Option[String])
final case class ExperimentPatch(
    name: Option[String],
    description: Option[String],
    variants: Option[Seq[Variant]],
    unit: Option[String],
    min_sample: Option[Int],
    salt: Option[String]
)
final case class Experiment(
    id: String,
    name: String,
    description: String,
    variants: Seq[Variant],
    unit: String,
    min_sample: Int,
    salt: String,
    version: Int,
    status: String
)

final case class ApiError(status: StatusCode, message: String) extends RuntimeException(message)

// The store is implemented by the state step, which adds the Redis assignment cache on top.
trait ExperimentStore {
  def insert(experiment: Experiment): Experiment
  def get(tenant: String, id: String): Option[Experiment]
  def saveCosmetic(experiment: Experiment): Unit
}

object ExperimentStore {
  def open(): ExperimentStore = new ExperimentStore {
    def insert(experiment: Experiment): Experiment = experiment
    def get(tenant: String, id: String): Option[Experiment] = None
    def saveCosmetic(experiment: Experiment): Unit = ()
  }
}

object ExperimentApi {
  implicit val system: ActorSystem = ActorSystem("expd")
  implicit val variantFormat: RootJsonFormat[Variant] = jsonFormat2(Variant)
  implicit val designFormat: RootJsonFormat[ExperimentDesign] = jsonFormat4(ExperimentDesign)
  implicit val patchFormat: RootJsonFormat[ExperimentPatch] = jsonFormat6(ExperimentPatch)
  implicit val experimentFormat: RootJsonFormat[Experiment] = jsonFormat9(Experiment)

  val MinVariants = 2
  val SplitTotal = 100
  val MinSampleFloor = 1
  val InitialVersion = 1
  val Running = "running"
  val AllowedUnits = Set("user", "session", "account")
  val SplitFrozen = "the split, unit, min_sample and salt are frozen at start"
  val RequiredNewVersion = "new version"

  val store: ExperimentStore = ExperimentStore.open()

  def validateVariants(variants: Seq[Variant]): Unit = {
    if (variants.size < MinVariants)
      throw ApiError(StatusCodes.BadRequest, "at least 2 variants are required")
    if (variants.map(_.key).distinct.size != variants.size)
      throw ApiError(StatusCodes.BadRequest, "duplicate variant keys")
    if (variants.exists(_.key.isEmpty))
      throw ApiError(StatusCodes.BadRequest, "variant keys must be non-empty")
  }

  def validateSplit(variants: Seq[Variant]): Unit = {
    if (variants.exists(_.weight < 0))
      throw ApiError(StatusCodes.BadRequest, "every weight must be a non-negative integer")
    if (variants.map(_.weight).sum != SplitTotal)
      throw ApiError(StatusCodes.BadRequest, "weights must sum to exactly 100")
  }

  def validateUnit(unit: String): Unit =
    if (!AllowedUnits.contains(unit))
      throw ApiError(StatusCodes.BadRequest, "unit must be one of user, session, account")

  def validateMinSample(minSample: Int): Unit =
    if (minSample < MinSampleFloor)
      throw ApiError(StatusCodes.BadRequest, "min_sample must be an integer >= 1")

  def validateDesign(body: ExperimentDesign): Unit = {
    validateVariants(body.variants)
    validateSplit(body.variants)
    validateUnit(body.unit)
    validateMinSample(body.min_sample)
  }

  def carriesDesign(patch: ExperimentPatch): Boolean =
    patch.variants.isDefined || patch.unit.isDefined || patch.min_sample.isDefined || patch.salt.isDefined

  val handler: ExceptionHandler = ExceptionHandler { case ApiError(status, message) =>
    complete(status, s"""{"error":"$message"}""")
  }

  val routes: Route = handleExceptions(handler) {
    path("v1" / "experiments") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[ExperimentDesign]) { body =>
            validateDesign(body)
            val experiment = Experiment(
              UUID.randomUUID().toString,
              "",
              "",
              body.variants,
              body.unit,
              body.min_sample,
              body.salt.filter(_.nonEmpty).getOrElse(UUID.randomUUID().toString),
              InitialVersion,
              Running
            )
            store.insert(experiment)
            system.log.info(s"experiment created tenant=$tenant id=\${experiment.id}")
            complete(StatusCodes.Created, experiment)
          }
        }
      }
    } ~
      path("v1" / "experiments" / Segment) { experimentId =>
        patch {
          headerValueByName("X-Tenant-Id") { tenant =>
            entity(as[ExperimentPatch]) { body =>
              store.get(tenant, experimentId) match {
                case None => complete(StatusCodes.NotFound, """{"error":"unknown experiment"}""")
                case Some(experiment) =>
                  if (carriesDesign(body)) {
                    complete(StatusCodes.Conflict, s"""{"error":"$SplitFrozen","required":"$RequiredNewVersion"}""")
                  } else {
                    val updated = experiment.copy(
                      name = body.name.getOrElse(experiment.name),
                      description = body.description.getOrElse(experiment.description)
                    )
                    store.saveCosmetic(updated)
                    system.log.info(s"experiment updated tenant=$tenant id=$experimentId")
                    complete(StatusCodes.OK, updated)
                  }
              }
            }
          }
        }
      }
  }

  def main(args: Array[String]): Unit = Http().newServerAt("0.0.0.0", 8443).bind(routes)
}
`,
    },
    cpp: {
      starter: `// api.cpp — a model-generated first draft of the experiment endpoint.
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <map>
#include <string>

using json = nlohmann::json;

std::map<std::string, json> experiments;

std::string new_id() {
  static int counter = 0;
  return "exp-" + std::to_string(++counter);
}

// TODO: this draft normalizes whatever split it is handed, validates neither the variant count nor
// the unit, and lets PATCH overwrite weights/unit in place with no version check. Review it.

int main() {
  httplib::Server svr;

  svr.Post("/v1/experiments", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    int total = 0;
    for (const auto& variant : body.value("variants", json::array())) total += variant.value("weight", 0);
    const int safe_total = std::max(total, 1);
    json split = json::array();
    for (const auto& variant : body.value("variants", json::array())) {
      split.push_back(json{{"key", variant.value("key", std::string())},
                           {"weight", variant.value("weight", 0) * 100 / safe_total}});
    }
    json experiment = {
        {"id", new_id()},
        {"tenant_id", req.get_header_value("X-Tenant-Id")},
        {"variants", split},
        {"unit", body.value("unit", std::string())},
        {"min_sample", body.value("min_sample", 0)},
        {"salt", body.value("salt", new_id())},
        {"version", 1},
        {"status", "running"},
    };
    experiments[experiment["id"]] = experiment;
    std::cerr << "experiment created: " << body.dump() << "\\n";
    res.status = 201;
    res.set_content(experiment.dump(), "application/json");
  });

  svr.Patch(R"(/v1/experiments/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto experiment_id = req.matches[1].str();
    json body = json::parse(req.body, nullptr, false);
    json experiment = experiments[experiment_id];
    experiment["variants"] = body.value("variants", json::array());
    experiment["unit"] = body.value("unit", std::string());
    experiments[experiment_id] = experiment;
    res.status = 200;
    res.set_content(experiment.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `// POST /v1/experiments · PATCH /v1/experiments/([^/]+).
//
// The design — variants, split, unit, min_sample and the salt — is pinned when the experiment
// starts. A later design change is a new version, never a live mutation of the running experiment.
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr int kMinVariants = 2;
constexpr int kSplitTotal = 100;
constexpr int kMinSampleFloor = 1;
constexpr int kInitialVersion = 1;
const char* const kRunning = "running";
const std::set<std::string> kAllowedUnits = {"user", "session", "account"};
const char* const kSplitFrozen = "the split, unit, min_sample and salt are frozen at start";
const char* const kRequiredNewVersion = "new version";

// The store is implemented by the state step, which adds the Redis assignment cache on top.
std::map<std::string, json> experiments;

std::string new_id() {
  static int counter = 0;
  return "exp-" + std::to_string(++counter);
}

std::string validate_variants(const json& variants) {
  if (variants.size() < static_cast<std::size_t>(kMinVariants)) return "at least 2 variants are required";
  std::set<std::string> keys;
  for (const auto& variant : variants) {
    const auto key = variant.value("key", std::string());
    if (key.empty()) return "variant keys must be non-empty";
    if (!keys.insert(key).second) return "duplicate variant keys";
  }
  return "";
}

std::string validate_split(const json& variants) {
  long total = 0;
  for (const auto& variant : variants) {
    if (!variant.contains("weight") || !variant["weight"].is_number_integer())
      return "every weight must be a non-negative integer";
    const long weight = variant["weight"].get<long>();
    if (weight < 0) return "every weight must be a non-negative integer";
    total += weight;
  }
  if (total != kSplitTotal) return "weights must sum to exactly 100";
  return "";
}

std::string validate_unit(const std::string& unit) {
  if (kAllowedUnits.count(unit) == 0) return "unit must be one of user, session, account";
  return "";
}

std::string validate_min_sample(const json& body) {
  if (!body.contains("min_sample") || !body["min_sample"].is_number_integer())
    return "min_sample must be an integer >= 1";
  if (body["min_sample"].get<long>() < kMinSampleFloor) return "min_sample must be an integer >= 1";
  return "";
}

std::string validate_design(const json& body) {
  const auto variants = body.value("variants", json::array());
  for (const auto& problem : {validate_variants(variants),
                              validate_split(variants),
                              validate_unit(body.value("unit", std::string())),
                              validate_min_sample(body)}) {
    if (!problem.empty()) return problem;
  }
  return "";
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/experiments", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto problem = validate_design(body);
    if (!problem.empty()) {
      res.status = 400;
      res.set_content(json{{"error", problem}}.dump(), "application/json");
      return;
    }
    const auto caller_salt = body.value("salt", std::string());
    json experiment = {
        {"id", new_id()},
        {"tenant_id", tenant},
        {"name", ""},
        {"description", ""},
        {"variants", body.value("variants", json::array())},
        {"unit", body.value("unit", std::string())},
        {"min_sample", body.value("min_sample", 0)},
        {"salt", caller_salt.empty() ? new_id() : caller_salt},
        {"version", kInitialVersion},
        {"status", kRunning},
    };
    experiments[experiment["id"]] = experiment;
    std::cerr << "experiment created tenant=" << tenant << " id=" << experiment["id"].get<std::string>()
              << "\\n";
    res.status = 201;
    res.set_content(experiment.dump(), "application/json");
  });

  svr.Patch(R"(/v1/experiments/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto experiment_id = req.matches[1].str();
    const auto found = experiments.find(experiment_id);
    if (found == experiments.end()) {
      res.status = 404;
      res.set_content(R"({"error":"unknown experiment"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const bool design_carried =
        body.contains("variants") || body.contains("unit") || body.contains("min_sample") || body.contains("salt");
    if (design_carried) {
      res.status = 409;
      res.set_content(json{{"error", kSplitFrozen}, {"required", kRequiredNewVersion}}.dump(), "application/json");
      return;
    }
    json experiment = found->second;
    if (body.contains("name")) experiment["name"] = body["name"];
    if (body.contains("description")) experiment["description"] = body["description"];
    experiments[experiment_id] = experiment;
    std::cerr << "experiment updated tenant=" << tenant << " id=" << experiment_id << "\\n";
    res.status = 200;
    res.set_content(experiment.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Validate the design as one funnel before the store is touched: `len(variants) >= MIN_VARIANTS` (2) with distinct non-empty keys, every `weight` a non-negative integer whose sum equals `SPLIT_TOTAL` (100), `unit` in the allowed set, `min_sample` an integer `>= 1` — each violation a 400. A split that sums to 99 or 101 is a client mistake; reweighting it silently changes the experiment the operator approved.',
    'Pin the design at insert: the row carries `version` = 1, the split exactly as validated, and the salt sampled once server-side (a caller-supplied salt is taken as-is). Nothing on the create path may normalize, and the log line names the tenant and the id only — never the body.',
    'The `PATCH` path may write only `name`/`description`. If the body carries `variants`, `unit`, `min_sample` or `salt`, answer 409 with `{"error": SPLIT_FROZEN, "required": REQUIRED_NEW_VERSION}`: a new version is a new experiment document copied forward, not an edit of the live one.',
  ],
  debrief: `The interviewer is testing whether you understand that an experiment's design is a document, not a
setting. The draft reads fine because the demo sends a clean 50/50 split and never patches it; the
flaws only surface when a human edits the thing.

Three defects are being checked. Exactness: a split that sums to 99 or 101 must be rejected, because
normalizing it silently changes the design — and later, when the read side checks sample ratio
mismatch, the honest 400 is what keeps a reweighted experiment from being reported as if it had run
as planned. Freezing: the salt and the unit and the minimum sample are pinned at creation, so the
bucket function is a pure function of (experiment, unit, salt) for the life of the experiment; a
typed-in unit or a re-derived salt moves users between variants and contaminates every number that
follows. Versioning: a design change is a 409 that asks for a new version, never a live mutation —
that single rule is what makes the analysis of the running experiment trustworthy, because the
design that was analysed is still the design that ran.

Real platforms go further: designs are immutable rows with a parent link, the salt is generated from
a server-side secret rather than the split, every version is audited, and an operator who wants more
traffic to a variant does it through ramping (step 3) rather than editing the split.`,
};
