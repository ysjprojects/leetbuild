import type {Step} from '@/lib/types';

export const extractAttributesStep: Step = {
  id: 'extract-attributes',
  title: 'Extract: retrieval first, a schema, taxonomy validation, confidence gate',
  concept: 'grpc',
  guides: ['model-output', 'deadlines-and-retries'],
  file: 'extract_attributes',
  focus: ['catalogd', 'taxonomy', 'llm'],
  task: `## Task

**Starting point.** The starter is \`extract_attributes(job)\` for a job from \`sku.extract\`: it calls
\`Extractor.Extract\` once with the SKU's title and description (no \`candidate_brands\`, no \`schema\`,
no deadline), reads \`key: value\` lines out of \`reply.output\` and returns
\`{sku_id, merchant, attributes, confidence, taxonomy_version, source: "model", status: "accepted"}\`.
It hides 5 flaws.

**Failure mode the checks target.** A model asked for free text with no candidates names brands
that do not exist and the starter accepts them; the line parser finds nothing in a reply the model
phrased differently; a slow model holds the worker with no deadline and a single \`UNAVAILABLE\`
fails the job; and no result ever reaches a reviewer.

- \`candidate_brands\` is \`taxonomy.nearest_brands(title + " " + description, BRAND_CANDIDATES)\`
  (20), retrieved before the call.
- The request carries \`taxonomy.ATTRIBUTE_SCHEMA\`; \`reply.output\` is parsed as one JSON object.
- Every attempt has a 5-second deadline; at most \`MAX_ATTEMPTS\` (2), the second only after
  \`UNAVAILABLE\`. Any other error is raised.
- A brand outside the candidates, a unit outside \`ALLOWED_UNITS\` or a category \`has_category\`
  rejects becomes null and is recorded as a problem.
- Any problem, or a confidence below \`MIN_CONFIDENCE\` (0.85), makes the result \`"review"\` and
  parks it with \`store.enqueue_review(result, reason)\`.`,
  sequence: {
    participants: ['catalogd', 'taxonomy', 'Extractor', 'Redis'],
    messages: [
      {from: 'catalogd', to: 'taxonomy', label: 'nearest_brands(title + description, 20)', kind: 'sync'},
      {from: 'catalogd', to: 'Extractor', label: 'Extract(title, description, candidates, schema) · 5 s', kind: 'sync'},
      {from: 'Extractor', to: 'catalogd', label: 'UNAVAILABLE → one more attempt', kind: 'reply'},
      {from: 'Extractor', to: 'catalogd', label: '{output: JSON, confidence: 0.95}', kind: 'reply'},
      {from: 'catalogd', to: 'taxonomy', label: 'brand ∈ candidates · unit · has_category', kind: 'sync'},
      {from: 'catalogd', to: 'Redis', label: 'problem or < 0.85 → enqueue_review', kind: 'async'},
    ],
  },
  hints: [
    'The catalog shows brands no taxonomy lists, a reworded reply leaves every attribute empty, one UNAVAILABLE fails the job, a slow model holds a worker indefinitely, and the review queue stays empty.',
    'The request has no candidates and no schema, so the model answers freely in prose; the parser expects `key: value` lines; there is one attempt with no deadline; nothing checks the answer or its confidence.',
    'Send `nearest_brands(...)` as `candidate_brands` and `ATTRIBUTE_SCHEMA`; loop `MAX_ATTEMPTS` with `timeout=DEADLINE_S`, retrying only `UNAVAILABLE`; `json.loads(reply.output)`; null what the taxonomy rejects; route problems and low confidence to `store.enqueue_review`.',
  ],
  checks: [
    {
      id: 'retrieve-first',
      title: 'Retrieves 20 candidate brands before the model call',
      detail:
        'The request carries `taxonomy.nearest_brands(title + " " + description, BRAND_CANDIDATES)` as `candidate_brands`, so the model chooses among brands the taxonomy knows. The starter sends none and the model names any brand.',
      match: {
        python: {
          all: [/BRAND_CANDIDATES\s*=\s*20\b/, /candidate_brands\s*=\s*candidates/],
          order: [/taxonomy\.nearest_brands\(/, /call_model\(request\)/],
        },
        typescript: {
          all: [/BRAND_CANDIDATES\s*=\s*20\b/, /candidate_brands:\s*candidates/],
          order: [/nearestBrands\(/, /callModel\(request\)/],
        },
        go: {
          all: [/brandCandidates\s*=\s*20\b/, /CandidateBrands:\s*candidates/],
          order: [/taxonomy\.NearestBrands\(/, /callModel\(ctx,\s*request\)/],
        },
        scala: {
          all: [/BrandCandidates\s*=\s*20\b/, /candidateBrands\s*=\s*candidates/],
          order: [/Taxonomy\.nearestBrands\(/, /callModel\(request\)/],
        },
        cpp: {
          all: [/kBrandCandidates\s*=\s*20\b/, /add_candidate_brands\(/],
          order: [/taxonomy::nearest_brands\(/, /callModel\(request\)/],
        },
      },
    },
    {
      id: 'structured-output',
      title: 'Asks for the schema and parses the reply as JSON',
      detail:
        'The request carries `taxonomy.ATTRIBUTE_SCHEMA` and `reply.output` is parsed as one JSON object. The starter asks for free text and scans it for `key: value` lines, which a reworded answer does not contain.',
      match: {
        python: {
          all: [/schema\s*=\s*taxonomy\.ATTRIBUTE_SCHEMA/, /json\.loads\(\s*reply\.output/],
          none: [/splitlines\(/],
        },
        typescript: {all: [/schema:\s*ATTRIBUTE_SCHEMA/, /JSON\.parse\(\s*reply\.output/], none: [/\.split\(/]},
        go: {
          all: [/Schema:\s*taxonomy\.AttributeSchema/, /json\.Unmarshal\(\s*\[\]byte\(reply\.(GetOutput\(\)|Output)\)/],
          none: [/strings\.Split\(/],
        },
        scala: {
          all: [/schema\s*=\s*Taxonomy\.AttributeSchema/, /ujson\.read\(\s*reply\.output/],
          none: [/\.split\(|linesIterator/],
        },
        cpp: {
          all: [/set_schema\(\s*taxonomy::kAttributeSchema/, /json::parse\(\s*reply\.output\(\)/],
          none: [/std::getline/],
        },
      },
    },
    {
      id: 'deadline-retry',
      title: 'A 5-second deadline per attempt; one retry, only on UNAVAILABLE',
      detail:
        'Every attempt carries a 5-second deadline; a second attempt follows only an `UNAVAILABLE`, and any other error (a deadline, `INVALID_ARGUMENT`) is raised after one call. The starter makes one call with no deadline.',
      match: {
        python: {
          all: [
            /DEADLINE_S\s*=\s*5\b/,
            /timeout\s*=\s*DEADLINE_S/,
            /MAX_ATTEMPTS\s*=\s*2\b/,
            /StatusCode\.UNAVAILABLE/,
          ],
          none: [/while\s+True/],
        },
        typescript: {
          all: [
            /DEADLINE_MS\s*=\s*5_?000\b/,
            /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/,
            /MAX_ATTEMPTS\s*=\s*2\b/,
            /status\.UNAVAILABLE/,
          ],
        },
        go: {
          all: [
            /deadline\s*=\s*5\s*\*\s*time\.Second/,
            /context\.WithTimeout\([^\n]*deadline\)/,
            /maxAttempts\s*=\s*2\b/,
            /codes\.Unavailable/,
          ],
        },
        scala: {
          all: [
            /DeadlineSeconds\s*=\s*5L?\b/,
            /withDeadlineAfter\(\s*DeadlineSeconds/,
            /MaxAttempts\s*=\s*2\b/,
            /UNAVAILABLE/,
          ],
        },
        cpp: {
          all: [
            /kDeadline\{5\}/,
            /set_deadline\([^\n]*kDeadline\)/,
            /kMaxAttempts\s*=\s*2\b/,
            /StatusCode::UNAVAILABLE/,
          ],
        },
      },
    },
    {
      id: 'taxonomy-validate',
      title: 'Nulls a brand, unit or category the taxonomy does not know',
      detail:
        'A brand outside the retrieved candidates, a unit outside `ALLOWED_UNITS` and a category `has_category` rejects become null, and the problem sends the result to review. The starter copies whatever the model said.',
      match: {
        python: {all: [/taxonomy\.ALLOWED_UNITS/, /not in candidates/, /taxonomy\.has_category\(/]},
        typescript: {all: [/ALLOWED_UNITS\.includes\(/, /candidates\.includes\(/, /hasCategory\(/]},
        go: {all: [/taxonomy\.AllowedUnits/, /listed\(candidates,/, /taxonomy\.HasCategory\(/]},
        scala: {all: [/Taxonomy\.AllowedUnits/, /candidates\.contains\(/, /Taxonomy\.hasCategory\(/]},
        cpp: {all: [/taxonomy::kAllowedUnits/, /listed\(candidates,/, /taxonomy::has_category\(/]},
      },
    },
    {
      id: 'confidence-gate',
      title: 'Routes problems and low confidence to human review',
      detail:
        'A result with a problem, or with a confidence below `MIN_CONFIDENCE` (0.85), is marked `review` and parked with `store.enqueue_review(result, reason)`; a clean, confident one is `accepted`. The starter accepts everything.',
      match: {
        python: {all: [/MIN_CONFIDENCE\s*=\s*0\.85/, /store\.enqueue_review\(/, /["']review["']/]},
        typescript: {all: [/MIN_CONFIDENCE\s*=\s*0\.85/, /enqueueReview\(/, /'review'/]},
        go: {all: [/minConfidence\s*=\s*0\.85/, /store\.EnqueueReview\(/, /"review"/]},
        scala: {all: [/MinConfidence\s*=\s*0\.85/, /Store\.enqueueReview\(/, /"review"/]},
        cpp: {all: [/kMinConfidence\s*=\s*0\.85/, /store::enqueue_review\(/, /"review"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import catalog_enrichment_pb2 as pb
import catalog_enrichment_pb2_grpc as pb_grpc
from enrich import store, taxonomy  # store.enqueue_review; taxonomy.VERSION, nearest_brands, ALLOWED_UNITS, has_category, ATTRIBUTE_SCHEMA

FIELDS = ("brand", "size", "unit", "organic", "category")

extractor = pb_grpc.ExtractorStub(grpc.insecure_channel("extractor:50051"))


def extract_attributes(job: dict) -> dict:
    """The attributes of one SKU version: {sku_id, merchant, attributes, confidence, taxonomy_version, source, status}."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    request = pb.ExtractRequest(sku_id=job["sku_id"], title=job["title"], description=job["description"])
    reply = extractor.Extract(request)
    attributes: dict = {field: None for field in FIELDS}
    for line in reply.output.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            if key.strip().lower() in FIELDS:
                attributes[key.strip().lower()] = value.strip()
    attributes["organic"] = attributes["organic"] == "true"
    return {
        "sku_id": job["sku_id"],
        "merchant": job["merchant"],
        "attributes": attributes,
        "confidence": reply.confidence,
        "taxonomy_version": taxonomy.VERSION,
        "source": "model",
        "status": "accepted",
    }
`,
      solution: `import json

import grpc

import catalog_enrichment_pb2 as pb
import catalog_enrichment_pb2_grpc as pb_grpc
from enrich import store, taxonomy  # store.enqueue_review; taxonomy.VERSION, nearest_brands, ALLOWED_UNITS, has_category, ATTRIBUTE_SCHEMA

DEADLINE_S = 5
MAX_ATTEMPTS = 2
BRAND_CANDIDATES = 20
MIN_CONFIDENCE = 0.85

extractor = pb_grpc.ExtractorStub(grpc.insecure_channel("extractor:50051"))


def call_model(request: pb.ExtractRequest) -> pb.ExtractReply:
    """One call per attempt, each under DEADLINE_S; only UNAVAILABLE earns another attempt."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return extractor.Extract(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() != grpc.StatusCode.UNAVAILABLE or attempt == MAX_ATTEMPTS:
                raise


def validate(raw: dict, candidates: list[str]) -> tuple[dict, list[str]]:
    """The attributes the taxonomy accepts, and why anything was dropped."""
    problems: list[str] = []
    brand, unit, category, size = raw.get("brand"), raw.get("unit"), raw.get("category"), raw.get("size")
    if brand is not None and brand not in candidates:
        problems.append(f"brand {brand!r} is not a taxonomy candidate")
        brand = None
    if unit is not None and unit not in taxonomy.ALLOWED_UNITS:
        problems.append(f"unit {unit!r} is not allowed")
        unit = None
    if category is not None and not taxonomy.has_category(category):
        problems.append(f"category {category!r} is not in the taxonomy")
        category = None
    if size is not None and (isinstance(size, bool) or not isinstance(size, (int, float)) or size <= 0):
        problems.append("size is not a positive number")
        size = None
    return {"brand": brand, "size": size, "unit": unit, "organic": raw.get("organic") is True, "category": category}, problems


def extract_attributes(job: dict) -> dict:
    """The attributes of one SKU version: {sku_id, merchant, attributes, confidence, taxonomy_version, source, status}."""
    candidates = taxonomy.nearest_brands(f"{job['title']} {job['description']}", BRAND_CANDIDATES)
    request = pb.ExtractRequest(
        sku_id=job["sku_id"],
        title=job["title"],
        description=job["description"],
        candidate_brands=candidates,
        schema=taxonomy.ATTRIBUTE_SCHEMA,
    )
    reply = call_model(request)
    try:
        raw = json.loads(reply.output)
    except ValueError:
        raw = None
    if isinstance(raw, dict):
        attributes, problems = validate(raw, candidates)
    else:
        attributes = {"brand": None, "size": None, "unit": None, "organic": False, "category": None}
        problems = ["the reply is not a JSON object"]
    if reply.confidence < MIN_CONFIDENCE:
        problems.append(f"confidence {reply.confidence:.2f} is below {MIN_CONFIDENCE}")
    result = {
        "sku_id": job["sku_id"],
        "merchant": job["merchant"],
        "attributes": attributes,
        "confidence": reply.confidence,
        "taxonomy_version": taxonomy.VERSION,
        "source": "model",
        "status": "review" if problems else "accepted",
    }
    if problems:
        store.enqueue_review(result, "; ".join(problems))  # a reviewer decides; the label trains the next model
    return result
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Attributes, Job, Result} from 'enrich/store';
import {VERSION} from 'enrich/taxonomy';

interface ExtractRequest {
  sku_id: string;
  title: string;
  description: string;
  candidate_brands: string[];
  schema: string;
}

interface ExtractReply {
  output: string;
  confidence: number;
}

const FIELDS = ['brand', 'size', 'unit', 'organic', 'category'];

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('catalog_enrichment.proto')) as unknown as {
  catalogenrich: {Extractor: grpc.ServiceClientConstructor};
};
const extractor = new pkg.catalogenrich.Extractor('extractor:50051', grpc.credentials.createInsecure()) as grpc.Client & {
  Extract(request: ExtractRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<ExtractReply>;
};

/** The attributes of one SKU version. */
export async function extractAttributes(job: Job): Promise<Result> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const request = {sku_id: job.sku_id, title: job.title, description: job.description, candidate_brands: [], schema: ''};
  const reply = await extractor.Extract(request, new grpc.Metadata(), {});
  const attributes: Attributes = Object.fromEntries(FIELDS.map(field => [field, null]));
  for (const line of reply.output.split('\\n')) {
    const at = line.indexOf(':');
    const key = line.slice(0, at).trim().toLowerCase();
    if (at >= 0 && FIELDS.includes(key)) attributes[key] = line.slice(at + 1).trim();
  }
  attributes.organic = attributes.organic === 'true';
  return {sku_id: job.sku_id, merchant: job.merchant, attributes, confidence: reply.confidence, taxonomy_version: VERSION, source: 'model', status: 'accepted'};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Attributes, type Job, type Result, enqueueReview} from 'enrich/store';
import {ALLOWED_UNITS, ATTRIBUTE_SCHEMA, VERSION, hasCategory, nearestBrands} from 'enrich/taxonomy';

export const DEADLINE_MS = 5000;
export const MAX_ATTEMPTS = 2;
export const BRAND_CANDIDATES = 20;
export const MIN_CONFIDENCE = 0.85;

interface ExtractRequest {
  sku_id: string;
  title: string;
  description: string;
  candidate_brands: string[];
  schema: string;
}

interface ExtractReply {
  output: string;
  confidence: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('catalog_enrichment.proto')) as unknown as {
  catalogenrich: {Extractor: grpc.ServiceClientConstructor};
};
const extractor = new pkg.catalogenrich.Extractor('extractor:50051', grpc.credentials.createInsecure()) as grpc.Client & {
  Extract(request: ExtractRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<ExtractReply>;
};

/** One call per attempt, each under DEADLINE_MS; only UNAVAILABLE earns another attempt. */
async function callModel(request: ExtractRequest): Promise<ExtractReply> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await extractor.Extract(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      if ((e as grpc.ServiceError).code !== grpc.status.UNAVAILABLE || attempt >= MAX_ATTEMPTS) throw e;
    }
  }
}

/** The attributes the taxonomy accepts, and why anything was dropped. */
function validate(raw: Record<string, unknown>, candidates: string[]): {attributes: Attributes; problems: string[]} {
  const problems: string[] = [];
  const attributes: Attributes = {brand: null, size: null, unit: null, organic: raw.organic === true, category: null};
  const {brand, unit, category, size} = raw;
  if (typeof brand === 'string') {
    if (candidates.includes(brand)) attributes.brand = brand;
    else problems.push(\`brand "\${brand}" is not a taxonomy candidate\`);
  }
  if (typeof unit === 'string') {
    if (ALLOWED_UNITS.includes(unit)) attributes.unit = unit;
    else problems.push(\`unit "\${unit}" is not allowed\`);
  }
  if (typeof category === 'string') {
    if (hasCategory(category)) attributes.category = category;
    else problems.push(\`category "\${category}" is not in the taxonomy\`);
  }
  if (typeof size === 'number' && size > 0) attributes.size = size;
  else if (size !== null && size !== undefined) problems.push('size is not a positive number');
  return {attributes, problems};
}

/** The attributes of one SKU version. */
export async function extractAttributes(job: Job): Promise<Result> {
  const candidates = nearestBrands(\`\${job.title} \${job.description}\`, BRAND_CANDIDATES);
  const request = {sku_id: job.sku_id, title: job.title, description: job.description, candidate_brands: candidates, schema: ATTRIBUTE_SCHEMA};
  const reply = await callModel(request);
  let raw: unknown = null;
  try {
    raw = JSON.parse(reply.output);
  } catch {
    // not JSON: a problem below
  }
  const {attributes, problems} =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? validate(raw as Record<string, unknown>, candidates)
      : {attributes: {brand: null, size: null, unit: null, organic: false, category: null}, problems: ['the reply is not a JSON object']};
  if (reply.confidence < MIN_CONFIDENCE) problems.push(\`confidence \${reply.confidence.toFixed(2)} is below \${MIN_CONFIDENCE}\`);
  const result: Result = {
    sku_id: job.sku_id,
    merchant: job.merchant,
    attributes,
    confidence: reply.confidence,
    taxonomy_version: VERSION,
    source: 'model',
    status: problems.length > 0 ? 'review' : 'accepted',
  };
  if (problems.length > 0) await enqueueReview(result, problems.join('; ')); // a reviewer decides; the label trains the next model
  return result;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "enrich/gen/catalog_enrichment"
	"enrich/store"    // store.Job, Result
	"enrich/taxonomy" // taxonomy.Version
)

var fields = []string{"brand", "size", "unit", "organic", "category"}

var (
	conn, _   = grpc.NewClient("extractor:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	extractor = pb.NewExtractorClient(conn)
)

// extractAttributes is the attributes of one SKU version.
func extractAttributes(ctx context.Context, job store.Job) (store.Result, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	request := &pb.ExtractRequest{SkuId: job.SkuID, Title: job.Title, Description: job.Description}
	reply, err := extractor.Extract(ctx, request)
	if err != nil {
		return store.Result{}, err
	}
	attributes := map[string]any{}
	for _, field := range fields {
		attributes[field] = nil
	}
	for _, line := range strings.Split(reply.GetOutput(), "\\n") {
		key, value, found := strings.Cut(line, ":")
		key = strings.ToLower(strings.TrimSpace(key))
		if _, known := attributes[key]; found && known {
			attributes[key] = strings.TrimSpace(value)
		}
	}
	organic, _ := attributes["organic"].(string)
	attributes["organic"] = organic == "true"
	return store.Result{SkuID: job.SkuID, Merchant: job.Merchant, Attributes: attributes, Confidence: reply.GetConfidence(),
		TaxonomyVersion: taxonomy.Version, Source: "model", Status: "accepted"}, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "enrich/gen/catalog_enrichment"
	"enrich/store"    // store.Job, Result, EnqueueReview
	"enrich/taxonomy" // taxonomy.Version, NearestBrands, AllowedUnits, HasCategory, AttributeSchema
)

const (
	deadline        = 5 * time.Second
	maxAttempts     = 2
	brandCandidates = 20
	minConfidence   = 0.85
)

var (
	conn, _   = grpc.NewClient("extractor:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	extractor = pb.NewExtractorClient(conn)
)

// callModel makes one call per attempt, each under the deadline; only Unavailable earns another attempt.
func callModel(ctx context.Context, request *pb.ExtractRequest) (*pb.ExtractReply, error) {
	var err error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, callErr := extractor.Extract(callCtx, request)
		cancel()
		if callErr == nil {
			return reply, nil
		}
		err = callErr
		if status.Code(callErr) != codes.Unavailable {
			break
		}
	}
	return nil, err
}

func listed(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// validate keeps the attributes the taxonomy accepts and says why anything was dropped.
func validate(raw map[string]any, candidates []string) (map[string]any, []string) {
	var problems []string
	attributes := map[string]any{"brand": nil, "size": nil, "unit": nil, "organic": raw["organic"] == true, "category": nil}
	if brand, ok := raw["brand"].(string); ok {
		if listed(candidates, brand) {
			attributes["brand"] = brand
		} else {
			problems = append(problems, fmt.Sprintf("brand %q is not a taxonomy candidate", brand))
		}
	}
	if unit, ok := raw["unit"].(string); ok {
		if listed(taxonomy.AllowedUnits, unit) {
			attributes["unit"] = unit
		} else {
			problems = append(problems, fmt.Sprintf("unit %q is not allowed", unit))
		}
	}
	if category, ok := raw["category"].(string); ok {
		if taxonomy.HasCategory(category) {
			attributes["category"] = category
		} else {
			problems = append(problems, fmt.Sprintf("category %q is not in the taxonomy", category))
		}
	}
	if size, ok := raw["size"].(float64); ok && size > 0 {
		attributes["size"] = size
	} else if raw["size"] != nil {
		problems = append(problems, "size is not a positive number")
	}
	return attributes, problems
}

// extractAttributes is the attributes of one SKU version.
func extractAttributes(ctx context.Context, job store.Job) (store.Result, error) {
	candidates := taxonomy.NearestBrands(job.Title+" "+job.Description, brandCandidates)
	request := &pb.ExtractRequest{SkuId: job.SkuID, Title: job.Title, Description: job.Description, CandidateBrands: candidates, Schema: taxonomy.AttributeSchema}
	reply, err := callModel(ctx, request)
	if err != nil {
		return store.Result{}, err
	}
	var raw map[string]any
	var attributes map[string]any
	var problems []string
	if json.Unmarshal([]byte(reply.GetOutput()), &raw) == nil && raw != nil {
		attributes, problems = validate(raw, candidates)
	} else {
		attributes = map[string]any{"brand": nil, "size": nil, "unit": nil, "organic": false, "category": nil}
		problems = []string{"the reply is not a JSON object"}
	}
	if reply.GetConfidence() < minConfidence {
		problems = append(problems, fmt.Sprintf("confidence %.2f is below %v", reply.GetConfidence(), minConfidence))
	}
	result := store.Result{SkuID: job.SkuID, Merchant: job.Merchant, Attributes: attributes, Confidence: reply.GetConfidence(),
		TaxonomyVersion: taxonomy.Version, Source: "model", Status: "accepted"}
	if len(problems) > 0 {
		result.Status = "review"
		// A reviewer decides; the label trains the next model.
		if err := store.EnqueueReview(ctx, result, strings.Join(problems, "; ")); err != nil {
			return store.Result{}, err
		}
	}
	return result, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

import catalogenrich.catalog_enrichment.{ExtractRequest, ExtractorGrpc}
import enrich.{Store, Taxonomy} // Store.enqueueReview; Taxonomy.Version, nearestBrands, AllowedUnits, hasCategory, AttributeSchema

object ExtractAttributes {
  val Fields: Seq[String] = Seq("brand", "size", "unit", "organic", "category")

  private val extractor = ExtractorGrpc.blockingStub(ManagedChannelBuilder.forAddress("extractor", 50051).usePlaintext().build())

  /** The attributes of one SKU version: {sku_id, merchant, attributes, confidence, taxonomy_version, source, status}. */
  def extractAttributes(job: ujson.Value): ujson.Obj = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val request = ExtractRequest(skuId = job("sku_id").str, title = job("title").str, description = job("description").str)
    val reply = extractor.extract(request)
    val attributes = ujson.Obj.from(Fields.map(_ -> ujson.Null))
    reply.output.split("\\n").foreach { line =>
      val at = line.indexOf(':')
      if (at >= 0 && Fields.contains(line.take(at).trim.toLowerCase)) attributes(line.take(at).trim.toLowerCase) = line.drop(at + 1).trim
    }
    attributes("organic") = attributes("organic") == ujson.Str("true")
    ujson.Obj(
      "sku_id" -> job("sku_id").str,
      "merchant" -> job("merchant").str,
      "attributes" -> attributes,
      "confidence" -> reply.confidence,
      "taxonomy_version" -> Taxonomy.Version,
      "source" -> "model",
      "status" -> "accepted",
    )
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import scala.collection.mutable
import scala.util.Try

import catalogenrich.catalog_enrichment.{ExtractReply, ExtractRequest, ExtractorGrpc}
import enrich.{Store, Taxonomy} // Store.enqueueReview; Taxonomy.Version, nearestBrands, AllowedUnits, hasCategory, AttributeSchema

object ExtractAttributes {
  val DeadlineSeconds = 5L
  val MaxAttempts = 2
  val BrandCandidates = 20
  val MinConfidence = 0.85

  private val extractor = ExtractorGrpc.blockingStub(ManagedChannelBuilder.forAddress("extractor", 50051).usePlaintext().build())

  /** One call per attempt, each under the deadline; only UNAVAILABLE earns another attempt. */
  def callModel(request: ExtractRequest, attempt: Int = 1): ExtractReply =
    try extractor.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).extract(request)
    catch {
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.UNAVAILABLE && attempt < MaxAttempts =>
        callModel(request, attempt + 1)
    }

  /** The attributes the taxonomy accepts, and why anything was dropped. */
  def validate(raw: ujson.Obj, candidates: Seq[String]): (ujson.Obj, Seq[String]) = {
    val problems = mutable.Buffer.empty[String]
    val attributes = ujson.Obj("brand" -> ujson.Null, "size" -> ujson.Null, "unit" -> ujson.Null, "organic" -> (raw.value.get("organic") == Some(ujson.True)), "category" -> ujson.Null)
    raw.value.get("brand").flatMap(_.strOpt).foreach { brand =>
      if (candidates.contains(brand)) attributes("brand") = brand else problems += s"brand '$brand' is not a taxonomy candidate"
    }
    raw.value.get("unit").flatMap(_.strOpt).foreach { unit =>
      if (Taxonomy.AllowedUnits.contains(unit)) attributes("unit") = unit else problems += s"unit '$unit' is not allowed"
    }
    raw.value.get("category").flatMap(_.strOpt).foreach { category =>
      if (Taxonomy.hasCategory(category)) attributes("category") = category else problems += s"category '$category' is not in the taxonomy"
    }
    raw.value.get("size").filterNot(_ == ujson.Null).foreach { size =>
      if (size.numOpt.exists(_ > 0)) attributes("size") = size else problems += "size is not a positive number"
    }
    (attributes, problems.toSeq)
  }

  /** The attributes of one SKU version: {sku_id, merchant, attributes, confidence, taxonomy_version, source, status}. */
  def extractAttributes(job: ujson.Value): ujson.Obj = {
    val candidates = Taxonomy.nearestBrands(s"\${job("title").str} \${job("description").str}", BrandCandidates)
    val request = ExtractRequest(
      skuId = job("sku_id").str,
      title = job("title").str,
      description = job("description").str,
      candidateBrands = candidates,
      schema = Taxonomy.AttributeSchema,
    )
    val reply = callModel(request)
    val (attributes, problems) = Try(ujson.read(reply.output)).toOption.flatMap(_.objOpt) match {
      case Some(raw) => validate(ujson.Obj.from(raw), candidates)
      case None =>
        (ujson.Obj("brand" -> ujson.Null, "size" -> ujson.Null, "unit" -> ujson.Null, "organic" -> false, "category" -> ujson.Null), Seq("the reply is not a JSON object"))
    }
    val all = if (reply.confidence < MinConfidence) problems :+ f"confidence \${reply.confidence}%.2f is below $MinConfidence" else problems
    val result = ujson.Obj(
      "sku_id" -> job("sku_id").str,
      "merchant" -> job("merchant").str,
      "attributes" -> attributes,
      "confidence" -> reply.confidence,
      "taxonomy_version" -> Taxonomy.Version,
      "source" -> "model",
      "status" -> (if (all.nonEmpty) "review" else "accepted"),
    )
    if (all.nonEmpty) Store.enqueueReview(result, all.mkString("; ")) // a reviewer decides; the label trains the next model
    result
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "catalog_enrichment.grpc.pb.h"
#include "enrich/store.h"     // store::enqueue_review
#include "enrich/taxonomy.h"  // taxonomy::kVersion, nearest_brands, kAllowedUnits, has_category, kAttributeSchema

using json = nlohmann::json;

const std::vector<std::string> kFields = {"brand", "size", "unit", "organic", "category"};

auto extractor = catalogenrich::Extractor::NewStub(grpc::CreateChannel("extractor:50051", grpc::InsecureChannelCredentials()));

// The extractor did not answer.
struct ExtractorFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The attributes of one SKU version: {sku_id, merchant, attributes, confidence, taxonomy_version, source, status}.
json extractAttributes(const json& job) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  catalogenrich::ExtractRequest request;
  request.set_sku_id(job["sku_id"].get<std::string>());
  request.set_title(job["title"].get<std::string>());
  request.set_description(job["description"].get<std::string>());
  grpc::ClientContext ctx;
  catalogenrich::ExtractReply reply;
  const grpc::Status status = extractor->Extract(&ctx, request, &reply);
  if (!status.ok()) throw ExtractorFailed("extractor: " + status.error_message());
  json attributes = {{"brand", nullptr}, {"size", nullptr}, {"unit", nullptr}, {"organic", nullptr}, {"category", nullptr}};
  std::istringstream lines(reply.output());
  std::string line;
  while (std::getline(lines, line)) {
    const size_t at = line.find(':');
    if (at == std::string::npos) continue;
    std::string key = line.substr(0, at);
    key.erase(std::remove(key.begin(), key.end(), ' '), key.end());
    std::transform(key.begin(), key.end(), key.begin(), ::tolower);
    if (std::find(kFields.begin(), kFields.end(), key) != kFields.end()) attributes[key] = line.substr(at + 1);
  }
  attributes["organic"] = attributes["organic"] == json("true");
  return {{"sku_id", job["sku_id"]},   {"merchant", job["merchant"]}, {"attributes", attributes}, {"confidence", reply.confidence()},
          {"taxonomy_version", taxonomy::kVersion}, {"source", "model"}, {"status", "accepted"}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

#include "catalog_enrichment.grpc.pb.h"
#include "enrich/store.h"     // store::enqueue_review
#include "enrich/taxonomy.h"  // taxonomy::kVersion, nearest_brands, kAllowedUnits, has_category, kAttributeSchema

using json = nlohmann::json;

constexpr std::chrono::seconds kDeadline{5};
constexpr int kMaxAttempts = 2;
constexpr size_t kBrandCandidates = 20;
constexpr double kMinConfidence = 0.85;

auto extractor = catalogenrich::Extractor::NewStub(grpc::CreateChannel("extractor:50051", grpc::InsecureChannelCredentials()));

// The extractor did not answer.
struct ExtractorFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// One call per attempt, each under kDeadline; only UNAVAILABLE earns another attempt.
catalogenrich::ExtractReply callModel(const catalogenrich::ExtractRequest& request) {
  grpc::Status status;
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    catalogenrich::ExtractReply reply;
    status = extractor->Extract(&ctx, request, &reply);
    if (status.ok()) return reply;
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE) break;
  }
  throw ExtractorFailed("extractor: " + status.error_message());
}

bool listed(const std::vector<std::string>& list, const std::string& value) {
  return std::find(list.begin(), list.end(), value) != list.end();
}

// The attributes the taxonomy accepts; why anything was dropped goes to problems.
json validate(const json& raw, const std::vector<std::string>& candidates, std::vector<std::string>& problems) {
  const bool organic = raw.contains("organic") && raw["organic"].is_boolean() && raw["organic"].get<bool>();
  json attributes = {{"brand", nullptr}, {"size", nullptr}, {"unit", nullptr}, {"organic", organic}, {"category", nullptr}};
  if (raw.contains("brand") && raw["brand"].is_string()) {
    const std::string brand = raw["brand"];
    if (listed(candidates, brand)) attributes["brand"] = brand;
    else problems.push_back("brand '" + brand + "' is not a taxonomy candidate");
  }
  if (raw.contains("unit") && raw["unit"].is_string()) {
    const std::string unit = raw["unit"];
    if (listed(taxonomy::kAllowedUnits, unit)) attributes["unit"] = unit;
    else problems.push_back("unit '" + unit + "' is not allowed");
  }
  if (raw.contains("category") && raw["category"].is_string()) {
    const std::string category = raw["category"];
    if (taxonomy::has_category(category)) attributes["category"] = category;
    else problems.push_back("category '" + category + "' is not in the taxonomy");
  }
  if (raw.contains("size") && !raw["size"].is_null()) {
    if (raw["size"].is_number() && raw["size"].get<double>() > 0) attributes["size"] = raw["size"];
    else problems.push_back("size is not a positive number");
  }
  return attributes;
}

// The attributes of one SKU version: {sku_id, merchant, attributes, confidence, taxonomy_version, source, status}.
json extractAttributes(const json& job) {
  const std::string title = job["title"], description = job["description"];
  const std::vector<std::string> candidates = taxonomy::nearest_brands(title + " " + description, kBrandCandidates);
  catalogenrich::ExtractRequest request;
  request.set_sku_id(job["sku_id"].get<std::string>());
  request.set_title(title);
  request.set_description(description);
  for (const std::string& brand : candidates) request.add_candidate_brands(brand);
  request.set_schema(taxonomy::kAttributeSchema);
  const catalogenrich::ExtractReply reply = callModel(request);
  std::vector<std::string> problems;
  const json raw = json::parse(reply.output(), nullptr, false);
  json attributes = {{"brand", nullptr}, {"size", nullptr}, {"unit", nullptr}, {"organic", false}, {"category", nullptr}};
  if (raw.is_object()) attributes = validate(raw, candidates, problems);
  else problems.push_back("the reply is not a JSON object");
  if (reply.confidence() < kMinConfidence) {
    char line[64];
    std::snprintf(line, sizeof line, "confidence %.2f is below 0.85", reply.confidence());
    problems.push_back(line);
  }
  json result = {{"sku_id", job["sku_id"]},   {"merchant", job["merchant"]}, {"attributes", attributes}, {"confidence", reply.confidence()},
                 {"taxonomy_version", taxonomy::kVersion}, {"source", "model"}, {"status", "accepted"}};
  if (!problems.empty()) {
    result["status"] = "review";
    std::string reason;
    for (const std::string& p : problems) reason += (reason.empty() ? "" : "; ") + p;
    store::enqueue_review(result, reason);  // a reviewer decides; the label trains the next model
  }
  return result;
}
`,
    },
  },
  harness: {
    python: `import json

import grpc

import catalog_enrichment_pb2 as pb
import catalog_enrichment_pb2_grpc as pb_grpc
from enrich import store, taxonomy

GOOD = {"sku_id": "sku-1", "merchant": "m-1", "title": "DOVE SILK GLOW BODY WASH 500ML", "description": "Nourishing body wash"}
INVENTED = {"sku_id": "sku-2", "merchant": "m-1", "title": "GLOWRA OAT DRINK 1L", "description": "Oat drink"}
BAD_UNIT = {"sku_id": "sku-3", "merchant": "m-1", "title": "BARILLA SPAGHETTI 12PACK", "description": "Durum wheat pasta"}
NO_DESCRIPTION = {"sku_id": "sku-4", "merchant": "m-1", "title": "OATLY OAT MILK 1L", "description": ""}
GOOD_ATTRIBUTES = {"brand": "Dove", "size": 500, "unit": "ml", "organic": False, "category": "body-wash"}


def _size(title):
    for token in title.split():
        digits = token.rstrip("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        if digits and digits != token and digits.replace(".", "").isdigit():
            return float(digits), token[len(digits):].lower()
    return None, None


class Extractor(pb_grpc.ExtractorServicer):
    """The model: picks the first candidate brand in the title, or names the title's first word; prose without a schema."""

    def Extract(self, request, context):
        title = request.title.upper()
        brand = next((c for c in request.candidate_brands if c.lower() in request.title.lower()), None) or request.title.split()[0].capitalize()
        size, unit = _size(title)
        category = "body-wash" if "BODY WASH" in title else "plant-milk" if "OAT" in title else "pasta" if "SPAGHETTI" in title else "grocery"
        confidence = 0.95 if request.description else 0.6
        if not request.schema:
            return pb.ExtractReply(output=f"Looks like {brand} {category}, {size} {unit}.", confidence=confidence)
        attributes = {"brand": brand, "size": size, "unit": unit, "organic": "ORGANIC" in title, "category": category}
        return pb.ExtractReply(output=json.dumps(attributes), confidence=confidence)


def _module(ctx):
    ctx.grpc.serve(pb_grpc.add_ExtractorServicer_to_server, Extractor())
    return ctx.load("extract_attributes")


def _extract(m, job, why):
    try:
        return m.extract_attributes(job)
    except Exception as exc:  # noqa: BLE001 - what it raised is the verdict
        detail = f"{exc.code().name} {exc.details()}" if isinstance(exc, grpc.RpcError) else f"{type(exc).__name__}: {exc}"
        raise AssertionError(f"{why}: extract_attributes raised {detail}") from None


def _raises(m, job, why):
    try:
        result = m.extract_attributes(job)
    except Exception:  # noqa: BLE001 - the error reaches the caller, as it must
        return
    raise AssertionError(f"{why}: extract_attributes returned {result} instead of raising")


def check_retrieve_first(ctx):
    m = _module(ctx)
    _extract(m, GOOD, "with a healthy extractor")
    calls = ctx.grpc.calls_to("Extract")
    assert calls, "no Extract call was made"
    candidates = list(calls[0].request.candidate_brands)
    assert 0 < len(candidates) <= 20, f"the request carried {len(candidates)} candidate brands: retrieve the 20 nearest from the taxonomy before the call"
    assert "Dove" in candidates and all(c in taxonomy.BRANDS for c in candidates), f"the candidates must be taxonomy.nearest_brands of the title and description, got {candidates}"


def check_structured_output(ctx):
    m = _module(ctx)
    result = _extract(m, GOOD, "with a healthy extractor")
    request = ctx.grpc.calls_to("Extract")[0].request
    assert request.schema == taxonomy.ATTRIBUTE_SCHEMA, f"the request carried schema {request.schema[:40]!r}: send taxonomy.ATTRIBUTE_SCHEMA so the model answers one JSON object"
    assert result.get("attributes") == GOOD_ATTRIBUTES, f"the attributes of {GOOD['title']!r} came out as {result.get('attributes')}, expected {GOOD_ATTRIBUTES}"


def check_deadline_retry(ctx):
    m = _module(ctx)
    ctx.grpc.fail("Extract", grpc.StatusCode.UNAVAILABLE, "extractor restarting", 1)
    _extract(m, GOOD, "after one UNAVAILABLE")
    calls = ctx.grpc.calls_to("Extract")
    assert len(calls) == 2, f"one UNAVAILABLE then a healthy extractor took {len(calls)} calls, expected 2"
    for call in calls:
        assert call.timeout is not None and 4.5 <= call.timeout <= 5.5, f"an Extract call carried a {call.timeout} s deadline, expected 5"
    ctx.grpc.set_latency("Extract", 10.0)
    _raises(m, GOOD, "with an extractor slower than the deadline")
    assert len(ctx.grpc.calls_to("Extract")) == 3, f"a deadline must not be retried: {len(ctx.grpc.calls_to('Extract')) - 2} calls after the slow one started"
    ctx.grpc.set_latency("Extract", 0.0)
    ctx.grpc.fail("Extract", grpc.StatusCode.INVALID_ARGUMENT, "title too long", 2)
    _raises(m, GOOD, "with INVALID_ARGUMENT")
    assert len(ctx.grpc.calls_to("Extract")) == 4, "INVALID_ARGUMENT must not be retried"


def check_taxonomy_validate(ctx):
    m = _module(ctx)
    result = _extract(m, INVENTED, "with a brand the taxonomy does not know")
    brand = result.get("attributes", {}).get("brand")
    assert brand is None, f"the model named brand {brand!r}, which is not a taxonomy candidate, and it was kept"
    assert result.get("status") == "review", f"an invented brand must send the SKU to review, status is {result.get('status')!r}"
    assert store.pending("sku-2") is not None, "the SKU with an invented brand was not parked with store.enqueue_review"
    result = _extract(m, BAD_UNIT, "with a unit outside ALLOWED_UNITS")
    unit = result.get("attributes", {}).get("unit")
    assert unit is None and result.get("status") == "review", f"unit {unit!r} is not in ALLOWED_UNITS: it must be nulled and the SKU reviewed, got {result}"
    assert store.pending("sku-3") is not None, "the SKU with an unknown unit was not parked with store.enqueue_review"


def check_confidence_gate(ctx):
    m = _module(ctx)
    result = _extract(m, NO_DESCRIPTION, "with a confidence of 0.6")
    assert result.get("status") == "review", f"a 0.6 confidence must go to review, status is {result.get('status')!r}"
    proposal = store.pending("sku-4")
    assert proposal is not None and proposal["reason"], f"the low-confidence SKU must be parked with a reason, store.pending gives {proposal}"
    assert result.get("taxonomy_version") == taxonomy.VERSION and result.get("source") == "model", f"the result must carry taxonomy_version and source, got {result}"
    result = _extract(m, GOOD, "with a confident, valid answer")
    assert result.get("status") == "accepted", f"a clean answer at 0.95 must be accepted, status is {result.get('status')!r}"
    assert store.pending("sku-1") is None, "a clean, confident answer must not be sent to review"
`,
    typescript: `const GOOD = {sku_id: 'sku-1', merchant: 'm-1', content_hash: 'h1', title: 'DOVE SILK GLOW BODY WASH 500ML', description: 'Nourishing body wash', images: []};
const INVENTED = {...GOOD, sku_id: 'sku-2', title: 'GLOWRA OAT DRINK 1L', description: 'Oat drink'};
const BAD_UNIT = {...GOOD, sku_id: 'sku-3', title: 'BARILLA SPAGHETTI 12PACK', description: 'Durum wheat pasta'};
const NO_DESCRIPTION = {...GOOD, sku_id: 'sku-4', title: 'OATLY OAT MILK 1L', description: ''};
const GOOD_ATTRIBUTES = {brand: 'Dove', size: 500, unit: 'ml', organic: false, category: 'body-wash'};

function sizeOf(title: string): [number | null, string | null] {
  for (const token of title.split(' ')) {
    const digits = token.replace(/[A-Z]+$/, '');
    if (digits !== '' && digits !== token && /^[0-9.]+$/.test(digits)) return [Number(digits), token.slice(digits.length).toLowerCase()];
  }
  return [null, null];
}

/** The model: picks the first candidate brand in the title, or names the title's first word; prose without a schema. */
function module(ctx) {
  const pkg = ctx.proto('catalog_enrichment.proto');
  ctx.grpc.serve(pkg.catalogenrich.Extractor.service, {
    Extract(call, callback) {
      const {title, description, candidate_brands, schema} = call.request;
      const upper = title.toUpperCase();
      const first = title.split(' ')[0];
      const brand = (candidate_brands ?? []).find(c => title.toLowerCase().includes(c.toLowerCase())) ?? first[0].toUpperCase() + first.slice(1).toLowerCase();
      const [size, unit] = sizeOf(upper);
      const category = upper.includes('BODY WASH') ? 'body-wash' : upper.includes('OAT') ? 'plant-milk' : upper.includes('SPAGHETTI') ? 'pasta' : 'grocery';
      const confidence = description ? 0.95 : 0.6;
      if (!schema) return callback(null, {output: \`Looks like \${brand} \${category}, \${size} \${unit}.\`, confidence});
      callback(null, {output: JSON.stringify({brand, size, unit, organic: upper.includes('ORGANIC'), category}), confidence});
    },
  });
  return {m: ctx.load('extract_attributes'), store: ctx.load('/support/enrich/store.ts'), taxonomy: ctx.load('/support/enrich/taxonomy.ts')};
}

async function extract(m, job, why: string) {
  try {
    return await m.extractAttributes(job);
  } catch (e) {
    assert.fail(\`\${why}: extractAttributes threw \${e}\`);
  }
}

async function throws(m, job, why: string): Promise<void> {
  let result;
  try {
    result = await m.extractAttributes(job);
  } catch {
    return;
  }
  assert.fail(\`\${why}: extractAttributes returned \${JSON.stringify(result)} instead of throwing\`);
}

export async function check_retrieve_first(ctx) {
  const {m, taxonomy} = module(ctx);
  await extract(m, GOOD, 'with a healthy extractor');
  const calls = ctx.grpc.callsTo('Extract');
  assert(calls.length > 0, 'no Extract call was made');
  const candidates: string[] = calls[0].request.candidate_brands ?? [];
  assert(candidates.length > 0 && candidates.length <= 20, \`the request carried \${candidates.length} candidate brands: retrieve the 20 nearest from the taxonomy before the call\`);
  assert(candidates.includes('Dove') && candidates.every(c => taxonomy.BRANDS.includes(c)), \`the candidates must be nearestBrands of the title and description, got \${JSON.stringify(candidates)}\`);
}

export async function check_structured_output(ctx) {
  const {m, taxonomy} = module(ctx);
  const result = await extract(m, GOOD, 'with a healthy extractor');
  const request = ctx.grpc.callsTo('Extract')[0].request;
  assert.equal(request.schema, taxonomy.ATTRIBUTE_SCHEMA, 'send ATTRIBUTE_SCHEMA so the model answers one JSON object');
  assert.deepStrictEqual(result.attributes, GOOD_ATTRIBUTES, \`the attributes of \${GOOD.title} came out as \${JSON.stringify(result.attributes)}\`);
}

export async function check_deadline_retry(ctx) {
  const {m} = module(ctx);
  ctx.grpc.fail('Extract', ctx.grpc.status.UNAVAILABLE, 'extractor restarting', 1);
  await extract(m, GOOD, 'after one UNAVAILABLE');
  const calls = ctx.grpc.callsTo('Extract');
  assert.equal(calls.length, 2, \`one UNAVAILABLE then a healthy extractor took \${calls.length} calls, expected 2\`);
  for (const call of calls) assert(call.timeout !== null && call.timeout >= 4.5 && call.timeout <= 5.5, \`an Extract call carried a \${call.timeout} s deadline, expected 5\`);
  ctx.grpc.setLatency('Extract', 10);
  await throws(m, GOOD, 'with an extractor slower than the deadline');
  assert.equal(ctx.grpc.callsTo('Extract').length, 3, 'a deadline must not be retried');
  ctx.grpc.setLatency('Extract', 0);
  ctx.grpc.fail('Extract', ctx.grpc.status.INVALID_ARGUMENT, 'title too long', 2);
  await throws(m, GOOD, 'with INVALID_ARGUMENT');
  assert.equal(ctx.grpc.callsTo('Extract').length, 4, 'INVALID_ARGUMENT must not be retried');
}

export async function check_taxonomy_validate(ctx) {
  const {m, store} = module(ctx);
  let result = await extract(m, INVENTED, 'with a brand the taxonomy does not know');
  assert.equal(result.attributes.brand, null, \`the model named brand \${JSON.stringify(result.attributes.brand)}, which is not a taxonomy candidate, and it was kept\`);
  assert.equal(result.status, 'review', 'an invented brand must send the SKU to review');
  assert.notEqual(await store.pending('sku-2'), null, 'the SKU with an invented brand was not parked with enqueueReview');
  result = await extract(m, BAD_UNIT, 'with a unit outside ALLOWED_UNITS');
  assert(result.attributes.unit === null && result.status === 'review', \`a unit outside ALLOWED_UNITS must be nulled and the SKU reviewed, got \${JSON.stringify(result)}\`);
  assert.notEqual(await store.pending('sku-3'), null, 'the SKU with an unknown unit was not parked with enqueueReview');
}

export async function check_confidence_gate(ctx) {
  const {m, store, taxonomy} = module(ctx);
  let result = await extract(m, NO_DESCRIPTION, 'with a confidence of 0.6');
  assert.equal(result.status, 'review', 'a 0.6 confidence must go to review');
  const proposal = await store.pending('sku-4');
  assert(proposal !== null && proposal.reason !== '', \`the low-confidence SKU must be parked with a reason, pending gives \${JSON.stringify(proposal)}\`);
  assert(result.taxonomy_version === taxonomy.VERSION && result.source === 'model', \`the result must carry taxonomy_version and source, got \${JSON.stringify(result)}\`);
  result = await extract(m, GOOD, 'with a confident, valid answer');
  assert.equal(result.status, 'accepted', 'a clean answer at 0.95 must be accepted');
  assert.equal(await store.pending('sku-1'), null, 'a clean, confident answer must not be sent to review');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc/codes"

	pb "enrich/gen/catalog_enrichment"
	"enrich/store"
	"enrich/taxonomy"

	"leetbuild/harness"
)

var (
	extractBg     = context.Background()
	goodJob       = store.Job{SkuID: "sku-1", Merchant: "m-1", Title: "DOVE SILK GLOW BODY WASH 500ML", Description: "Nourishing body wash"}
	inventedJob   = store.Job{SkuID: "sku-2", Merchant: "m-1", Title: "GLOWRA OAT DRINK 1L", Description: "Oat drink"}
	badUnitJob    = store.Job{SkuID: "sku-3", Merchant: "m-1", Title: "BARILLA SPAGHETTI 12PACK", Description: "Durum wheat pasta"}
	noDescription = store.Job{SkuID: "sku-4", Merchant: "m-1", Title: "OATLY OAT MILK 1L", Description: ""}
)

// extractorPeer is the model: it picks the first candidate brand in the title, or names the title's first word; prose without a schema.
type extractorPeer struct {
	pb.UnimplementedExtractorServer
}

func sizeOf(title string) (any, any) {
	for _, token := range strings.Fields(title) {
		digits := strings.TrimRight(token, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
		if n, err := strconv.ParseFloat(digits, 64); err == nil && digits != token {
			return n, strings.ToLower(token[len(digits):])
		}
	}
	return nil, nil
}

func (extractorPeer) Extract(_ context.Context, req *pb.ExtractRequest) (*pb.ExtractReply, error) {
	upper := strings.ToUpper(req.GetTitle())
	first := strings.Fields(req.GetTitle())[0]
	brand := strings.ToUpper(first[:1]) + strings.ToLower(first[1:])
	for _, c := range req.GetCandidateBrands() {
		if strings.Contains(strings.ToLower(req.GetTitle()), strings.ToLower(c)) {
			brand = c
			break
		}
	}
	size, unit := sizeOf(upper)
	category := "grocery"
	switch {
	case strings.Contains(upper, "BODY WASH"):
		category = "body-wash"
	case strings.Contains(upper, "OAT"):
		category = "plant-milk"
	case strings.Contains(upper, "SPAGHETTI"):
		category = "pasta"
	}
	confidence := 0.95
	if req.GetDescription() == "" {
		confidence = 0.6
	}
	if req.GetSchema() == "" {
		return &pb.ExtractReply{Output: fmt.Sprintf("Looks like %s %s, %v %v.", brand, category, size, unit), Confidence: confidence}, nil
	}
	output, _ := json.Marshal(map[string]any{"brand": brand, "size": size, "unit": unit, "organic": strings.Contains(upper, "ORGANIC"), "category": category})
	return &pb.ExtractReply{Output: string(output), Confidence: confidence}, nil
}

func extractPeer(ctx *harness.Ctx) {
	pb.RegisterExtractorServer(ctx.GRPC.Server(""), extractorPeer{})
}

func mustExtract(ctx *harness.Ctx, job store.Job, why string) store.Result {
	result, err := extractAttributes(extractBg, job)
	ctx.NoError(err, "%s: extractAttributes failed", why)
	return result
}

func mustFail(ctx *harness.Ctx, job store.Job, why string) {
	result, err := extractAttributes(extractBg, job)
	ctx.Assert(err != nil, "%s: extractAttributes returned %+v instead of an error", why, result)
}

func CheckRetrieveFirst(ctx *harness.Ctx) {
	extractPeer(ctx)
	mustExtract(ctx, goodJob, "with a healthy extractor")
	calls := ctx.GRPC.CallsTo("Extract", "")
	ctx.Assert(len(calls) > 0, "no Extract call was made")
	candidates := calls[0].Request.(*pb.ExtractRequest).GetCandidateBrands()
	ctx.Assert(len(candidates) > 0 && len(candidates) <= 20, "the request carried %d candidate brands: retrieve the 20 nearest from the taxonomy before the call", len(candidates))
	known := map[string]bool{}
	for _, b := range taxonomy.Brands {
		known[b] = true
	}
	hasDove := false
	for _, c := range candidates {
		ctx.Assert(known[c], "candidate %q is not a taxonomy brand", c)
		hasDove = hasDove || c == "Dove"
	}
	ctx.Assert(hasDove, "the candidates must be taxonomy.NearestBrands of the title and description, got %v", candidates)
}

func CheckStructuredOutput(ctx *harness.Ctx) {
	extractPeer(ctx)
	result := mustExtract(ctx, goodJob, "with a healthy extractor")
	request := ctx.GRPC.CallsTo("Extract", "")[0].Request.(*pb.ExtractRequest)
	ctx.Equal(request.GetSchema(), taxonomy.AttributeSchema, "send taxonomy.AttributeSchema so the model answers one JSON object; the schema")
	ctx.Equal(result.Attributes, map[string]any{"brand": "Dove", "size": 500.0, "unit": "ml", "organic": false, "category": "body-wash"}, "the attributes of %s", goodJob.Title)
}

func CheckDeadlineRetry(ctx *harness.Ctx) {
	extractPeer(ctx)
	ctx.GRPC.Fail("Extract", codes.Unavailable, "extractor restarting", 1, "")
	mustExtract(ctx, goodJob, "after one UNAVAILABLE")
	calls := ctx.GRPC.CallsTo("Extract", "")
	ctx.Equal(len(calls), 2, "one UNAVAILABLE then a healthy extractor; the calls")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline() && call.Timeout >= 4500*time.Millisecond && call.Timeout <= 5500*time.Millisecond, "an Extract call carried a %v deadline, expected 5 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Extract", 10.0, "")
	mustFail(ctx, goodJob, "with an extractor slower than the deadline")
	ctx.Equal(len(ctx.GRPC.CallsTo("Extract", "")), 3, "a deadline must not be retried; the calls")
	ctx.GRPC.SetLatency("Extract", 0, "")
	ctx.GRPC.Fail("Extract", codes.InvalidArgument, "title too long", 2, "")
	mustFail(ctx, goodJob, "with INVALID_ARGUMENT")
	ctx.Equal(len(ctx.GRPC.CallsTo("Extract", "")), 4, "INVALID_ARGUMENT must not be retried; the calls")
}

func CheckTaxonomyValidate(ctx *harness.Ctx) {
	extractPeer(ctx)
	result := mustExtract(ctx, inventedJob, "with a brand the taxonomy does not know")
	ctx.Assert(result.Attributes["brand"] == nil, "the model named brand %v, which is not a taxonomy candidate, and it was kept", result.Attributes["brand"])
	ctx.Equal(result.Status, "review", "an invented brand must send the SKU to review; the status")
	ctx.Assert(store.Pending(extractBg, "sku-2") != nil, "the SKU with an invented brand was not parked with store.EnqueueReview")
	result = mustExtract(ctx, badUnitJob, "with a unit outside AllowedUnits")
	ctx.Assert(result.Attributes["unit"] == nil && result.Status == "review", "a unit outside AllowedUnits must be nulled and the SKU reviewed, got %+v", result)
	ctx.Assert(store.Pending(extractBg, "sku-3") != nil, "the SKU with an unknown unit was not parked with store.EnqueueReview")
}

func CheckConfidenceGate(ctx *harness.Ctx) {
	extractPeer(ctx)
	result := mustExtract(ctx, noDescription, "with a confidence of 0.6")
	ctx.Equal(result.Status, "review", "a 0.6 confidence must go to review; the status")
	proposal := store.Pending(extractBg, "sku-4")
	ctx.Assert(proposal != nil && proposal.Reason != "", "the low-confidence SKU must be parked with a reason, store.Pending gives %+v", proposal)
	ctx.Assert(result.TaxonomyVersion == taxonomy.Version && result.Source == "model", "the result must carry the taxonomy version and source, got %+v", result)
	result = mustExtract(ctx, goodJob, "with a confident, valid answer")
	ctx.Equal(result.Status, "accepted", "a clean answer at 0.95 must be accepted; the status")
	ctx.Assert(store.Pending(extractBg, "sku-1") == nil, "a clean, confident answer must not be sent to review")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <sstream>
#include <string>
#include <vector>

#include "catalog_enrichment.grpc.pb.h"
#include "enrich/store.h"
#include "enrich/taxonomy.h"

namespace {

nlohmann::json extractJob(const std::string& sku_id, const std::string& title, const std::string& description) {
  return {{"sku_id", sku_id}, {"merchant", "m-1"}, {"content_hash", "h"}, {"title", title}, {"description", description}, {"images", nlohmann::json::array()}};
}

const nlohmann::json kGood = extractJob("sku-1", "DOVE SILK GLOW BODY WASH 500ML", "Nourishing body wash");
const nlohmann::json kInvented = extractJob("sku-2", "GLOWRA OAT DRINK 1L", "Oat drink");
const nlohmann::json kBadUnit = extractJob("sku-3", "BARILLA SPAGHETTI 12PACK", "Durum wheat pasta");
const nlohmann::json kNoDescription = extractJob("sku-4", "OATLY OAT MILK 1L", "");

std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

// The model: picks the first candidate brand in the title, or names the title's first word; prose without a schema.
class ExtractorPeer final : public catalogenrich::Extractor::Service {
 public:
  grpc::Status Extract(grpc::ServerContext*, const catalogenrich::ExtractRequest* req, catalogenrich::ExtractReply* out) override {
    const std::string title = req->title();
    std::istringstream words(title);
    std::string first, token;
    words >> first;
    std::string brand = std::string(1, first[0]) + lower(first.substr(1));
    for (const std::string& c : req->candidate_brands()) {
      if (lower(title).find(lower(c)) != std::string::npos) {
        brand = c;
        break;
      }
    }
    nlohmann::json size = nullptr, unit = nullptr;
    std::istringstream tokens(title);
    while (tokens >> token) {
      size_t digits = 0;
      while (digits < token.size() && (std::isdigit(static_cast<unsigned char>(token[digits])) || token[digits] == '.')) digits++;
      if (digits > 0 && digits < token.size()) {
        size = std::stod(token.substr(0, digits));
        unit = lower(token.substr(digits));
        break;
      }
    }
    const auto has = [&title](const char* word) { return title.find(word) != std::string::npos; };
    const std::string category = has("BODY WASH") ? "body-wash" : has("OAT") ? "plant-milk" : has("SPAGHETTI") ? "pasta" : "grocery";
    out->set_confidence(req->description().empty() ? 0.6 : 0.95);
    if (req->schema().empty()) {
      out->set_output("Looks like " + brand + " " + category + ", " + size.dump() + " " + unit.dump() + ".");
    } else {
      out->set_output(nlohmann::json{{"brand", brand}, {"size", size}, {"unit", unit}, {"organic", has("ORGANIC")}, {"category", category}}.dump());
    }
    return grpc::Status::OK;
  }
};

void extractPeer(harness::Ctx& ctx) {
  static ExtractorPeer* peer = nullptr;
  delete peer;
  peer = new ExtractorPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

nlohmann::json mustExtract(harness::Ctx& ctx, const nlohmann::json& job, const std::string& why) {
  try {
    return extractAttributes(job);
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: extractAttributes threw %s: %s", why, harness::CurrentExceptionType(), e.what());
  }
}

void mustThrow(harness::Ctx& ctx, const nlohmann::json& job, const std::string& why) {
  nlohmann::json result;
  try {
    result = extractAttributes(job);
  } catch (const std::exception&) {
    return;
  }
  ctx.Fatalf("%s: extractAttributes returned %s instead of throwing", why, result.dump());
}

}  // namespace

void CheckRetrieveFirst(harness::Ctx& ctx) {
  extractPeer(ctx);
  mustExtract(ctx, kGood, "with a healthy extractor");
  const auto calls = ctx.GRPC.CallsTo("Extract");
  ctx.Assert(!calls.empty(), "no Extract call was made");
  const auto request = calls[0].Request<catalogenrich::ExtractRequest>();
  const int n = request.candidate_brands_size();
  ctx.Assert(n > 0 && n <= 20, "the request carried %d candidate brands: retrieve the 20 nearest from the taxonomy before the call", n);
  bool dove = false;
  for (const std::string& c : request.candidate_brands()) {
    ctx.Assert(std::find(taxonomy::kBrands.begin(), taxonomy::kBrands.end(), c) != taxonomy::kBrands.end(), "candidate %q is not a taxonomy brand", c);
    dove = dove || c == "Dove";
  }
  ctx.Assert(dove, "the candidates must be taxonomy::nearest_brands of the title and description, and Dove is missing");
}

void CheckStructuredOutput(harness::Ctx& ctx) {
  extractPeer(ctx);
  const auto result = mustExtract(ctx, kGood, "with a healthy extractor");
  const auto request = ctx.GRPC.CallsTo("Extract")[0].Request<catalogenrich::ExtractRequest>();
  ctx.Equal(request.schema(), taxonomy::kAttributeSchema, "send taxonomy::kAttributeSchema so the model answers one JSON object; the schema");
  const nlohmann::json expected = {{"brand", "Dove"}, {"size", 500.0}, {"unit", "ml"}, {"organic", false}, {"category", "body-wash"}};
  ctx.Assert(result.contains("attributes") && result["attributes"] == expected, "the attributes of the Dove body wash came out as %s, expected %s", result.value("attributes", nlohmann::json()).dump(), expected.dump());
}

void CheckDeadlineRetry(harness::Ctx& ctx) {
  extractPeer(ctx);
  ctx.GRPC.Fail("Extract", grpc::StatusCode::UNAVAILABLE, "extractor restarting", 1);
  mustExtract(ctx, kGood, "after one UNAVAILABLE");
  const auto calls = ctx.GRPC.CallsTo("Extract");
  ctx.Equal(calls.size(), 2, "one UNAVAILABLE then a healthy extractor; the calls");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline() && call.TimeoutSeconds() >= 4.5 && call.TimeoutSeconds() <= 5.5, "an Extract call carried a %v s deadline, expected 5", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Extract", 10.0);
  mustThrow(ctx, kGood, "with an extractor slower than the deadline");
  ctx.Equal(ctx.GRPC.CallsTo("Extract").size(), 3, "a deadline must not be retried; the calls");
  ctx.GRPC.SetLatency("Extract", 0);
  ctx.GRPC.Fail("Extract", grpc::StatusCode::INVALID_ARGUMENT, "title too long", 2);
  mustThrow(ctx, kGood, "with INVALID_ARGUMENT");
  ctx.Equal(ctx.GRPC.CallsTo("Extract").size(), 4, "INVALID_ARGUMENT must not be retried; the calls");
}

void CheckTaxonomyValidate(harness::Ctx& ctx) {
  extractPeer(ctx);
  auto result = mustExtract(ctx, kInvented, "with a brand the taxonomy does not know");
  ctx.Assert(result["attributes"]["brand"].is_null(), "the model named brand %s, which is not a taxonomy candidate, and it was kept", result["attributes"]["brand"].dump());
  ctx.Equal(result.value("status", ""), "review", "an invented brand must send the SKU to review; the status");
  ctx.Assert(store::pending("sku-2").has_value(), "the SKU with an invented brand was not parked with store::enqueue_review");
  result = mustExtract(ctx, kBadUnit, "with a unit outside kAllowedUnits");
  ctx.Assert(result["attributes"]["unit"].is_null() && result.value("status", "") == "review", "a unit outside kAllowedUnits must be nulled and the SKU reviewed, got %s", result.dump());
  ctx.Assert(store::pending("sku-3").has_value(), "the SKU with an unknown unit was not parked with store::enqueue_review");
}

void CheckConfidenceGate(harness::Ctx& ctx) {
  extractPeer(ctx);
  auto result = mustExtract(ctx, kNoDescription, "with a confidence of 0.6");
  ctx.Equal(result.value("status", ""), "review", "a 0.6 confidence must go to review; the status");
  const auto proposal = store::pending("sku-4");
  ctx.Assert(proposal && !(*proposal)["reason"].get<std::string>().empty(), "the low-confidence SKU must be parked with a reason");
  ctx.Assert(result.value("taxonomy_version", "") == taxonomy::kVersion && result.value("source", "") == "model", "the result must carry taxonomy_version and source, got %s", result.dump());
  result = mustExtract(ctx, kGood, "with a confident, valid answer");
  ctx.Equal(result.value("status", ""), "accepted", "a clean answer at 0.95 must be accepted; the status");
  ctx.Assert(!store::pending("sku-1").has_value(), "a clean, confident answer must not be sent to review");
}
`,
  },
  debrief: `Each fix narrows what the model is allowed to say. The candidate list turns brand extraction into a choice among brands the knowledge graph already holds, and checking the answer against that list catches the model when it ignores it. The schema makes the reply parseable whatever wording the model prefers. The deadline and the single retry on \`UNAVAILABLE\` bound what one SKU can cost a worker, while a timeout or a rejected request goes back to the caller, because retrying those only spends more. The confidence gate decides who reads the result: a reviewer sees exactly the SKUs the model was unsure about, and each decision becomes a label. A larger system would also retrieve golden annotations as in-context examples, propose genuinely new brands to a taxonomy owner, and track review rates per merchant.`,
};
