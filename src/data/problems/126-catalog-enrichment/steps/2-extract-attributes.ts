import type {Step} from '@/lib/types';

export const extractAttributesStep: Step = {
  id: 'extract-attributes',
  title: 'Extract: retrieval first, a schema, taxonomy validation, confidence gate',
  concept: 'grpc',
  file: 'extract_attributes',
  focus: ['catalogd', 'taxonomy', 'llm'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it sends the title to the
extractor, parses "key: value" lines out of the answer and returns the attributes. On clean titles
the demo looks great. It hides five production flaws — the first of them is the one the source
post is about. Review it like the owner of the catalog, fix it, and prove the fix.

Implement \`extract_attributes(sku)\` for a job from \`sku.extract\`
(\`{"sku_id", "merchant", "content_hash", "title", "description", "images"}\`), calling the
extractor service \`Extractor.Extract(ExtractRequest) → ExtractReply\` at \`extractor:50051\`,
where \`ExtractRequest{title, description, candidate_brands[], schema}\` and
\`ExtractReply{output, confidence}\`:

- **Retrieve before the model.** Ask the taxonomy for the **20** nearest brand names
  (\`BRAND_CANDIDATES = 20\`, \`taxonomy.nearest_brands(text, k)\`) and pass them as
  \`candidate_brands\`. The model chooses among brands that exist; it does not invent one.
- **Ask for structured output.** Send \`ATTRIBUTE_SCHEMA\` — a JSON schema with \`brand\`, \`size\`,
  \`unit\`, \`organic\`, \`category\` — and parse \`reply.output\` as JSON. No line parsing.
- **Deadline and one retry.** Every attempt carries a **5-second** deadline; at most **2** attempts,
  and only \`UNAVAILABLE\` is retried. Any other status is raised to the caller.
- **Validate against the taxonomy.** A brand not in the candidate list, a unit not in
  \`ALLOWED_UNITS\` (\`ml\`, \`l\`, \`g\`, \`kg\`, \`oz\`, \`fl oz\`, \`lb\`, \`ct\`), a non-positive
  size, or a category the taxonomy does not know is dropped to null and recorded as a problem.
- **Gate on confidence.** When there is any problem or \`reply.confidence\` is below **0.85**
  (\`MIN_CONFIDENCE\`), enqueue the SKU for human review with the reason and mark the result
  \`status: "review"\`; otherwise \`status: "accepted"\`. Every result carries the
  \`taxonomy_version\` it was produced under and \`source: "model"\`.

**Failure mode the checks target.** A model asked for free text with no candidates will produce a
brand for every title, including brands that do not exist, and the draft writes them straight into
the catalog. The missing deadline pins a worker on a slow model; the missing retry turns a broker
blip into a failed job; the line parser silently drops every attribute the moment the model changes
its phrasing. The confidence gate is the quiet one: without it, the human reviewers the source post
relies on never see the SKUs that need them.`,
  sequence: {
    participants: ['catalogd', 'taxonomy', 'Extractor', 'review queue'],
    messages: [
      {from: 'catalogd', to: 'taxonomy', label: 'nearest_brands(title + description, 20)', kind: 'sync'},
      {from: 'taxonomy', to: 'catalogd', label: '["Dove", "Dove Men+Care", …]', kind: 'reply'},
      {from: 'catalogd', to: 'Extractor', label: 'Extract(title, description, candidates, schema) · 5 s', kind: 'sync'},
      {from: 'Extractor', to: 'catalogd', label: 'UNAVAILABLE → one retry', kind: 'reply'},
      {from: 'Extractor', to: 'catalogd', label: '{output: json, confidence: 0.91}', kind: 'reply'},
      {from: 'catalogd', to: 'taxonomy', label: 'has_category(category)', kind: 'sync'},
      {
        from: 'catalogd',
        to: 'review queue',
        label: 'enqueue(sku_id, result, reason) when unresolved or < 0.85',
        kind: 'async',
      },
    ],
  },
  hints: [
    'The order inside `extract_attributes` is the fix: retrieval, then the call, then validation, then the gate. `taxonomy.nearest_brands(text, BRAND_CANDIDATES)` goes into `candidate_brands`, and `ATTRIBUTE_SCHEMA` into `schema`, before the model sees anything.',
    'Wrap the stub call in a bounded loop: `for _ in range(MAX_ATTEMPTS)`, `timeout=DEADLINE_S` (or `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`) on every attempt, and `continue` only when the status is `UNAVAILABLE`; re-raise everything else at once.',
    'Validation is set membership: brand in the candidate set, unit in `ALLOWED_UNITS`, `taxonomy.has_category(category)`. Each miss nulls the field and appends a reason; `if problems or confidence < MIN_CONFIDENCE:` is the whole gate, and `review.enqueue` is what it calls.',
  ],
  checks: [
    {
      id: 'retrieve-first',
      title: 'Retrieves 20 candidate brands from the taxonomy before the model call',
      detail:
        '`BRAND_CANDIDATES = 20` nearest brand names come from `taxonomy.nearest_brands` and are passed to the model as `candidate_brands`; the retrieval precedes the call. The draft sends the title alone and lets the model name any brand.',
      match: {
        python: {
          all: [/BRAND_CANDIDATES\s*=\s*20/, /candidate_brands=candidates/],
          order: [/taxonomy\.nearest_brands\(/, /= call_model\(/],
        },
        typescript: {
          all: [/BRAND_CANDIDATES\s*=\s*20/, /candidate_brands:\s*candidates/],
          order: [/taxonomy\.nearestBrands\(/, /= await callModel\(/],
        },
        go: {
          all: [/brandCandidates\s*=\s*20/, /CandidateBrands:\s*candidates/],
          order: [/taxonomy\.NearestBrands\(/, /:= callModel\(/],
        },
        scala: {
          all: [/BrandCandidates\s*=\s*20/, /candidateBrands\s*=\s*candidates/],
          order: [/taxonomy\.nearestBrands\(/, /= callModel\(/],
        },
        cpp: {
          all: [/kBrandCandidates\s*=\s*20/, /add_candidate_brands\(/],
          order: [/taxonomy\.nearestBrands\(/, /= callModel\(/],
        },
      },
    },
    {
      id: 'deadline-retry',
      title: 'Every attempt has a 5 s deadline; at most two, only on UNAVAILABLE',
      detail:
        'The call carries a 5-second deadline, attempts are bounded by `MAX_ATTEMPTS = 2`, and only `UNAVAILABLE` is retried. The draft calls once with no deadline and no retry, so a stuck model pins the worker and a broker blip fails the job.',
      match: {
        python: {
          all: [
            /DEADLINE_S\s*=\s*5\.0/,
            /timeout=DEADLINE_S/,
            /MAX_ATTEMPTS\s*=\s*2/,
            /range\(MAX_ATTEMPTS\)/,
            /StatusCode\.UNAVAILABLE/,
          ],
          none: [/while\s+True/],
        },
        typescript: {
          all: [
            /DEADLINE_MS\s*=\s*5_?000/,
            /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/,
            /MAX_ATTEMPTS\s*=\s*2/,
            /attempt\s*<\s*MAX_ATTEMPTS/,
            /UNAVAILABLE/,
          ],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [
            /deadline\s*=\s*5\s*\*\s*time\.Second/,
            /context\.WithTimeout\(/,
            /maxAttempts\s*=\s*2/,
            /attempt\s*<\s*maxAttempts/,
            /codes\.Unavailable/,
          ],
        },
        scala: {
          all: [
            /DeadlineMs\s*=\s*5000/,
            /withDeadlineAfter\(\s*DeadlineMs/,
            /MaxAttempts\s*=\s*2/,
            /attempt\s*<\s*MaxAttempts/,
            /Status\.Code\.UNAVAILABLE/,
          ],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [
            /kDeadlineMs\s*=\s*5000/,
            /set_deadline\(/,
            /kMaxAttempts\s*=\s*2/,
            /attempt\s*<\s*kMaxAttempts/,
            /StatusCode::UNAVAILABLE/,
          ],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'structured-output',
      title: 'Asks for a schema and parses the reply as JSON',
      detail:
        'The request carries `ATTRIBUTE_SCHEMA` and `reply.output` is parsed as JSON. The draft asks for free text and splits lines on `:` — it silently loses every attribute the moment the model rephrases.',
      match: {
        python: {all: [/ATTRIBUTE_SCHEMA/, /schema=ATTRIBUTE_SCHEMA/, /json\.loads\(\s*reply\.output/]},
        typescript: {all: [/ATTRIBUTE_SCHEMA/, /schema:\s*ATTRIBUTE_SCHEMA/, /JSON\.parse\(\s*reply\.output/]},
        go: {all: [/attributeSchema/, /Schema:\s*attributeSchema/, /json\.Unmarshal\(\s*\[\]byte\(reply\.Output\)/]},
        scala: {all: [/AttributeSchema/, /schema\s*=\s*AttributeSchema/, /reply\.output\.parseJson/]},
        cpp: {all: [/kAttributeSchema/, /set_schema\(\s*kAttributeSchema/, /json::parse\(\s*reply\.output\(\)/]},
      },
    },
    {
      id: 'taxonomy-validate',
      title: 'Validates brand, unit and category against the taxonomy',
      detail:
        'The brand must be one of the retrieved candidates, the unit one of `ALLOWED_UNITS`, and the category known to the taxonomy (`has_category`); anything else is nulled and recorded as a problem. The draft copies whatever the model said.',
      match: {
        python: {all: [/ALLOWED_UNITS/, /not in candidate_names/, /taxonomy\.has_category\(/]},
        typescript: {all: [/ALLOWED_UNITS/, /candidateNames\[/, /taxonomy\.hasCategory\(/]},
        go: {all: [/allowedUnits/, /candidateNames\[/, /taxonomy\.HasCategory\(/]},
        scala: {all: [/AllowedUnits/, /candidateNames\.contains\(/, /taxonomy\.hasCategory\(/]},
        cpp: {all: [/kAllowedUnits/, /candidateNames\.count\(/, /taxonomy\.hasCategory\(/]},
      },
    },
    {
      id: 'confidence-review',
      title: 'Routes unresolved or low-confidence results to human review',
      detail:
        'Any validation problem or a confidence below `MIN_CONFIDENCE = 0.85` sends the SKU to `review.enqueue` with the reason and marks the result `review`. The draft accepts everything the model returns.',
      match: {
        python: {all: [/MIN_CONFIDENCE\s*=\s*0\.85/, /review\.enqueue\(/, /["']review["']/, /taxonomy_version/]},
        typescript: {all: [/MIN_CONFIDENCE\s*=\s*0\.85/, /review\.enqueue\(/, /['"]review['"]/, /taxonomy_version/]},
        go: {all: [/minConfidence\s*=\s*0\.85/, /review\.Enqueue\(/, /"review"/, /TaxonomyVersion/]},
        scala: {all: [/MinConfidence\s*=\s*0\.85/, /review\.enqueue\(/, /"review"/, /taxonomy_version/]},
        cpp: {all: [/kMinConfidence\s*=\s*0\.85/, /review\.enqueue\(/, /"review"/, /taxonomy_version/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import extractor_pb2
import extractor_pb2_grpc

channel = grpc.insecure_channel("extractor:50051")
extractor = extractor_pb2_grpc.ExtractorStub(channel)

FIELDS = ("brand", "size", "unit", "organic", "category")


def extract_attributes(sku: dict) -> dict:
    # TODO: this draft sends the title alone and lets the model name any brand, has no deadline
    # and no retry, parses "key: value" lines, trusts every value, and never routes anything to
    # review. Review all five.
    request = extractor_pb2.ExtractRequest(
        title=sku["title"],
        description=sku.get("description", ""),
        candidate_brands=[],
        schema="",
    )
    reply = extractor.Extract(request)
    attributes: dict = {field: None for field in FIELDS}
    for line in reply.output.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip().lower()
        if key in FIELDS:
            attributes[key] = value.strip()
    attributes["organic"] = str(attributes["organic"]).lower() == "true"
    return {
        "sku_id": sku["sku_id"],
        "attributes": attributes,
        "confidence": reply.confidence,
        "status": "accepted",
        "source": "model",
    }
`,
      solution: `import json

import grpc

import extractor_pb2
import extractor_pb2_grpc

DEADLINE_S = 5.0
MAX_ATTEMPTS = 2
BRAND_CANDIDATES = 20
MIN_CONFIDENCE = 0.85
ALLOWED_UNITS = {"ml", "l", "g", "kg", "oz", "fl oz", "lb", "ct"}
ATTRIBUTE_SCHEMA = json.dumps(
    {
        "type": "object",
        "properties": {
            "brand": {"type": ["string", "null"]},
            "size": {"type": ["number", "null"]},
            "unit": {"type": ["string", "null"]},
            "organic": {"type": "boolean"},
            "category": {"type": ["string", "null"]},
        },
        "required": ["brand", "size", "unit", "organic", "category"],
        "additionalProperties": False,
    }
)

channel = grpc.insecure_channel("extractor:50051")
extractor = extractor_pb2_grpc.ExtractorStub(channel)


class Taxonomy:
    def version(self) -> str:
        """Version of the brand and category taxonomy the result is valid under."""
        raise NotImplementedError

    def nearest_brands(self, text: str, k: int) -> list[str]:
        """The k brand names whose embeddings are nearest to the text."""
        raise NotImplementedError

    def has_category(self, category: str) -> bool:
        raise NotImplementedError


class ReviewQueue:
    def enqueue(self, sku_id: str, result: dict, reason: str) -> None:
        raise NotImplementedError


taxonomy = Taxonomy()
review = ReviewQueue()


def call_model(request: extractor_pb2.ExtractRequest) -> extractor_pb2.ExtractReply:
    last_error: grpc.RpcError | None = None
    for _ in range(MAX_ATTEMPTS):
        try:
            return extractor.Extract(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            last_error = exc
            if exc.code() != grpc.StatusCode.UNAVAILABLE:
                raise
    raise last_error or RuntimeError("extractor unavailable")


def validate(raw: dict, candidate_names: set[str]) -> tuple[dict, list[str]]:
    """Attributes the taxonomy accepts, and why anything was dropped."""
    problems: list[str] = []
    brand = raw.get("brand")
    if brand is not None and brand not in candidate_names:
        problems.append(f"brand {brand!r} is not a taxonomy candidate")
        brand = None
    size = raw.get("size")
    if size is not None and (isinstance(size, bool) or not isinstance(size, (int, float)) or size <= 0):
        problems.append("size must be a positive number")
        size = None
    unit = raw.get("unit")
    if unit is not None and unit not in ALLOWED_UNITS:
        problems.append(f"unit {unit!r} is not allowed")
        unit = None
    category = raw.get("category")
    if category is not None and not taxonomy.has_category(category):
        problems.append(f"category {category!r} is not in the taxonomy")
        category = None
    attributes = {
        "brand": brand,
        "size": size,
        "unit": unit,
        "organic": raw.get("organic") is True,
        "category": category,
    }
    return attributes, problems


def extract_attributes(sku: dict) -> dict:
    text = f"{sku['title']} {sku.get('description', '')}".strip()
    candidates = taxonomy.nearest_brands(text, BRAND_CANDIDATES)
    candidate_names = set(candidates)
    request = extractor_pb2.ExtractRequest(
        title=sku["title"],
        description=sku.get("description", ""),
        candidate_brands=candidates,
        schema=ATTRIBUTE_SCHEMA,
    )
    reply = call_model(request)
    try:
        raw = json.loads(reply.output)
    except ValueError:
        raw = None
    if not isinstance(raw, dict):
        raw = {}
        problems = ["model output is not a JSON object"]
        attributes = {"brand": None, "size": None, "unit": None, "organic": False, "category": None}
    else:
        attributes, problems = validate(raw, candidate_names)
    result = {
        "sku_id": sku["sku_id"],
        "attributes": attributes,
        "confidence": reply.confidence,
        "taxonomy_version": taxonomy.version(),
        "source": "model",
    }
    if problems or reply.confidence < MIN_CONFIDENCE:
        reason = "; ".join(problems) if problems else f"confidence {reply.confidence:.2f} below threshold"
        review.enqueue(sku["sku_id"], result, reason)
        result["status"] = "review"
    else:
        result["status"] = "accepted"
    return result
`,
    },
    typescript: {
      starter: `/** Extract: a model-generated draft that trusts free-text output from the model. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface ExtractRequest {
  title: string;
  description: string;
  candidate_brands: string[];
  schema: string;
}

interface ExtractReply {
  output: string;
  confidence: number;
}

interface ExtractorClient {
  Extract(request: ExtractRequest, callback: (error: grpc.ServiceError | null, reply: ExtractReply) => void): void;
}

const {extractor} = grpc.loadPackageDefinition(protoLoader.loadSync('extractor.proto')) as unknown as {
  extractor: {Extractor: new (target: string, credentials: grpc.ChannelCredentials) => ExtractorClient};
};
const client = new extractor.Extractor('extractor:50051', grpc.credentials.createInsecure());

const FIELDS = ['brand', 'size', 'unit', 'organic', 'category'];

export interface SkuJob {
  sku_id: string;
  merchant: string;
  content_hash: string;
  title: string;
  description?: string;
  images?: string[];
}

export async function extractAttributes(sku: SkuJob): Promise<Record<string, unknown>> {
  // TODO: this draft sends the title alone and lets the model name any brand, has no deadline
  // and no retry, parses "key: value" lines, trusts every value, and never routes anything to
  // review. Review all five.
  const reply = await new Promise<ExtractReply>((resolve, reject) => {
    client.Extract(
      {title: sku.title, description: sku.description ?? '', candidate_brands: [], schema: ''},
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });
  const attributes: Record<string, unknown> = {};
  for (const field of FIELDS) attributes[field] = null;
  for (const line of reply.output.split('\\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (FIELDS.includes(key)) attributes[key] = line.slice(colon + 1).trim();
  }
  attributes.organic = String(attributes.organic).toLowerCase() === 'true';
  return {sku_id: sku.sku_id, attributes, confidence: reply.confidence, status: 'accepted', source: 'model'};
}
`,
      solution: `/** Extract: candidate brands retrieved first, a schema, taxonomy validation, a confidence gate. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {review, taxonomy} from './taxonomy';

const DEADLINE_MS = 5_000;
const MAX_ATTEMPTS = 2;
const BRAND_CANDIDATES = 20;
const MIN_CONFIDENCE = 0.85;
const ALLOWED_UNITS: Record<string, true> = {ml: true, l: true, g: true, kg: true, oz: true, 'fl oz': true, lb: true, ct: true};
const ATTRIBUTE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    brand: {type: ['string', 'null']},
    size: {type: ['number', 'null']},
    unit: {type: ['string', 'null']},
    organic: {type: 'boolean'},
    category: {type: ['string', 'null']},
  },
  required: ['brand', 'size', 'unit', 'organic', 'category'],
  additionalProperties: false,
});

interface ExtractRequest {
  title: string;
  description: string;
  candidate_brands: string[];
  schema: string;
}

interface ExtractReply {
  output: string;
  confidence: number;
}

interface ExtractorClient {
  Extract(
    request: ExtractRequest,
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: ExtractReply) => void,
  ): void;
}

const {extractor} = grpc.loadPackageDefinition(protoLoader.loadSync('extractor.proto')) as unknown as {
  extractor: {Extractor: new (target: string, credentials: grpc.ChannelCredentials) => ExtractorClient};
};
const client = new extractor.Extractor('extractor:50051', grpc.credentials.createInsecure());

export interface SkuJob {
  sku_id: string;
  merchant: string;
  content_hash: string;
  title: string;
  description?: string;
  images?: string[];
}

export interface Attributes {
  brand: string | null;
  size: number | null;
  unit: string | null;
  organic: boolean;
  category: string | null;
}

export interface ExtractionResult {
  sku_id: string;
  attributes: Attributes;
  confidence: number;
  taxonomy_version: string;
  source: 'model';
  status: 'accepted' | 'review';
}

async function callModel(request: ExtractRequest): Promise<ExtractReply> {
  let lastError: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await new Promise<ExtractReply>((resolve, reject) => {
        client.Extract(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS}, (error, reply) =>
          error ? reject(error) : resolve(reply),
        );
      });
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      lastError = serviceError;
      if (serviceError.code !== grpc.status.UNAVAILABLE) throw serviceError;
    }
  }
  throw lastError ?? new Error('extractor unavailable');
}

/** Attributes the taxonomy accepts, and why anything was dropped. */
async function validate(
  raw: Record<string, unknown>,
  candidateNames: Record<string, true>,
): Promise<{attributes: Attributes; problems: string[]}> {
  const problems: string[] = [];
  let brand = typeof raw.brand === 'string' ? raw.brand : null;
  if (brand !== null && candidateNames[brand] !== true) {
    problems.push(\`brand "\${brand}" is not a taxonomy candidate\`);
    brand = null;
  }
  let size = typeof raw.size === 'number' ? raw.size : null;
  if (size !== null && !(size > 0)) {
    problems.push('size must be a positive number');
    size = null;
  }
  let unit = typeof raw.unit === 'string' ? raw.unit : null;
  if (unit !== null && ALLOWED_UNITS[unit] !== true) {
    problems.push(\`unit "\${unit}" is not allowed\`);
    unit = null;
  }
  let category = typeof raw.category === 'string' ? raw.category : null;
  if (category !== null && !(await taxonomy.hasCategory(category))) {
    problems.push(\`category "\${category}" is not in the taxonomy\`);
    category = null;
  }
  return {attributes: {brand, size, unit, organic: raw.organic === true, category}, problems};
}

export async function extractAttributes(sku: SkuJob): Promise<ExtractionResult> {
  const text = \`\${sku.title} \${sku.description ?? ''}\`.trim();
  const candidates = await taxonomy.nearestBrands(text, BRAND_CANDIDATES);
  const candidateNames: Record<string, true> = {};
  for (const name of candidates) candidateNames[name] = true;
  const reply = await callModel({
    title: sku.title,
    description: sku.description ?? '',
    candidate_brands: candidates,
    schema: ATTRIBUTE_SCHEMA,
  });
  let raw: unknown = null;
  try {
    raw = JSON.parse(reply.output);
  } catch {
    raw = null;
  }
  let attributes: Attributes;
  let problems: string[];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    attributes = {brand: null, size: null, unit: null, organic: false, category: null};
    problems = ['model output is not a JSON object'];
  } else {
    ({attributes, problems} = await validate(raw as Record<string, unknown>, candidateNames));
  }
  const result: ExtractionResult = {
    sku_id: sku.sku_id,
    attributes,
    confidence: reply.confidence,
    taxonomy_version: await taxonomy.version(),
    source: 'model',
    status: 'accepted',
  };
  if (problems.length > 0 || reply.confidence < MIN_CONFIDENCE) {
    const reason = problems.length > 0 ? problems.join('; ') : \`confidence \${reply.confidence.toFixed(2)} below threshold\`;
    await review.enqueue(sku.sku_id, result, reason);
    result.status = 'review';
  }
  return result;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strings"

	pb "catalogd/extractorpb"
)

var extractor pb.ExtractorClient

type SkuJob struct {
	SkuID       string   \`json:"sku_id"\`
	Merchant    string   \`json:"merchant"\`
	ContentHash string   \`json:"content_hash"\`
	Title       string   \`json:"title"\`
	Description string   \`json:"description"\`
	Images      []string \`json:"images"\`
}

type Result struct {
	SkuID      string         \`json:"sku_id"\`
	Attributes map[string]any \`json:"attributes"\`
	Confidence float32        \`json:"confidence"\`
	Status     string         \`json:"status"\`
	Source     string         \`json:"source"\`
}

var fields = []string{"brand", "size", "unit", "organic", "category"}

// TODO: this draft sends the title alone and lets the model name any brand, has no deadline and
// no retry, parses "key: value" lines, trusts every value, and never routes anything to review.
// Review all five.
func extractAttributes(ctx context.Context, sku SkuJob) (Result, error) {
	reply, err := extractor.Extract(ctx, &pb.ExtractRequest{
		Title:       sku.Title,
		Description: sku.Description,
	})
	if err != nil {
		return Result{}, err
	}
	attributes := map[string]any{}
	for _, field := range fields {
		attributes[field] = nil
	}
	for _, line := range strings.Split(reply.Output, "\\n") {
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		for _, field := range fields {
			if key == field {
				attributes[field] = strings.TrimSpace(value)
			}
		}
	}
	attributes["organic"] = strings.EqualFold(strings.TrimSpace(strings.ToLower(attributesString(attributes["organic"]))), "true")
	return Result{SkuID: sku.SkuID, Attributes: attributes, Confidence: reply.Confidence, Status: "accepted", Source: "model"}, nil
}

func attributesString(v any) string {
	s, _ := v.(string)
	return s
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "catalogd/extractorpb"
)

const (
	deadline        = 5 * time.Second
	maxAttempts     = 2
	brandCandidates = 20
	minConfidence   = 0.85
)

var allowedUnits = map[string]bool{"ml": true, "l": true, "g": true, "kg": true, "oz": true, "fl oz": true, "lb": true, "ct": true}

const attributeSchema = \`{
  "type": "object",
  "properties": {
    "brand": {"type": ["string", "null"]},
    "size": {"type": ["number", "null"]},
    "unit": {"type": ["string", "null"]},
    "organic": {"type": "boolean"},
    "category": {"type": ["string", "null"]}
  },
  "required": ["brand", "size", "unit", "organic", "category"],
  "additionalProperties": false
}\`

// Taxonomy is the brand and category knowledge graph the model is constrained by.
type Taxonomy interface {
	Version(ctx context.Context) (string, error)
	NearestBrands(ctx context.Context, text string, k int) ([]string, error)
	HasCategory(ctx context.Context, category string) (bool, error)
}

type ReviewQueue interface {
	Enqueue(ctx context.Context, skuID string, result Result, reason string) error
}

var (
	extractor pb.ExtractorClient
	taxonomy  Taxonomy
	review    ReviewQueue
)

type SkuJob struct {
	SkuID       string   \`json:"sku_id"\`
	Merchant    string   \`json:"merchant"\`
	ContentHash string   \`json:"content_hash"\`
	Title       string   \`json:"title"\`
	Description string   \`json:"description"\`
	Images      []string \`json:"images"\`
}

type Attributes struct {
	Brand    *string  \`json:"brand"\`
	Size     *float64 \`json:"size"\`
	Unit     *string  \`json:"unit"\`
	Organic  bool     \`json:"organic"\`
	Category *string  \`json:"category"\`
}

type Result struct {
	SkuID           string     \`json:"sku_id"\`
	Attributes      Attributes \`json:"attributes"\`
	Confidence      float32    \`json:"confidence"\`
	TaxonomyVersion string     \`json:"taxonomy_version"\`
	Source          string     \`json:"source"\`
	Status          string     \`json:"status"\`
}

func callModel(ctx context.Context, request *pb.ExtractRequest) (*pb.ExtractReply, error) {
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := extractor.Extract(attemptCtx, request)
		cancel()
		if err == nil {
			return reply, nil
		}
		lastErr = err
		if status.Code(err) != codes.Unavailable {
			return nil, err
		}
	}
	return nil, lastErr
}

type rawAttributes struct {
	Brand    *string  \`json:"brand"\`
	Size     *float64 \`json:"size"\`
	Unit     *string  \`json:"unit"\`
	Organic  bool     \`json:"organic"\`
	Category *string  \`json:"category"\`
}

// validate returns the attributes the taxonomy accepts and why anything was dropped.
func validate(ctx context.Context, raw rawAttributes, candidateNames map[string]bool) (Attributes, []string, error) {
	var problems []string
	out := Attributes{Brand: raw.Brand, Size: raw.Size, Unit: raw.Unit, Organic: raw.Organic, Category: raw.Category}
	if out.Brand != nil && !candidateNames[*out.Brand] {
		problems = append(problems, fmt.Sprintf("brand %q is not a taxonomy candidate", *out.Brand))
		out.Brand = nil
	}
	if out.Size != nil && *out.Size <= 0 {
		problems = append(problems, "size must be a positive number")
		out.Size = nil
	}
	if out.Unit != nil && !allowedUnits[*out.Unit] {
		problems = append(problems, fmt.Sprintf("unit %q is not allowed", *out.Unit))
		out.Unit = nil
	}
	if out.Category != nil {
		known, err := taxonomy.HasCategory(ctx, *out.Category)
		if err != nil {
			return Attributes{}, nil, err
		}
		if !known {
			problems = append(problems, fmt.Sprintf("category %q is not in the taxonomy", *out.Category))
			out.Category = nil
		}
	}
	return out, problems, nil
}

func extractAttributes(ctx context.Context, sku SkuJob) (Result, error) {
	text := strings.TrimSpace(sku.Title + " " + sku.Description)
	candidates, err := taxonomy.NearestBrands(ctx, text, brandCandidates)
	if err != nil {
		return Result{}, err
	}
	candidateNames := make(map[string]bool, len(candidates))
	for _, name := range candidates {
		candidateNames[name] = true
	}
	reply, err := callModel(ctx, &pb.ExtractRequest{
		Title:           sku.Title,
		Description:     sku.Description,
		CandidateBrands: candidates,
		Schema:          attributeSchema,
	})
	if err != nil {
		return Result{}, err
	}
	var raw rawAttributes
	var attributes Attributes
	var problems []string
	if err := json.Unmarshal([]byte(reply.Output), &raw); err != nil {
		problems = []string{"model output is not a JSON object"}
	} else if attributes, problems, err = validate(ctx, raw, candidateNames); err != nil {
		return Result{}, err
	}
	version, err := taxonomy.Version(ctx)
	if err != nil {
		return Result{}, err
	}
	result := Result{
		SkuID:           sku.SkuID,
		Attributes:      attributes,
		Confidence:      reply.Confidence,
		TaxonomyVersion: version,
		Source:          "model",
		Status:          "accepted",
	}
	if len(problems) > 0 || float64(reply.Confidence) < minConfidence {
		reason := strings.Join(problems, "; ")
		if reason == "" {
			reason = fmt.Sprintf("confidence %.2f below threshold", reply.Confidence)
		}
		if err := review.Enqueue(ctx, sku.SkuID, result, reason); err != nil {
			return Result{}, errors.Join(errors.New("review enqueue failed"), err)
		}
		result.Status = "review"
	}
	return result, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder
import spray.json._

final case class SkuJob(
    sku_id: String,
    merchant: String,
    content_hash: String,
    title: String,
    description: Option[String],
    images: Option[List[String]])

object ExtractAttributes {
  val stub = ExtractorGrpc.blockingStub(ManagedChannelBuilder.forAddress("extractor", 50051).usePlaintext().build())

  val Fields = List("brand", "size", "unit", "organic", "category")

  // TODO: this draft sends the title alone and lets the model name any brand, has no deadline and
  // no retry, parses "key: value" lines, trusts every value, and never routes anything to review.
  // Review all five.
  def extractAttributes(sku: SkuJob): JsObject = {
    val reply = stub.extract(
      ExtractRequest(title = sku.title, description = sku.description.getOrElse(""), candidateBrands = Nil, schema = "")
    )
    val parsed = reply.output.linesIterator.flatMap { line =>
      line.split(":", 2) match {
        case Array(key, value) if Fields.contains(key.trim.toLowerCase) => Some(key.trim.toLowerCase -> value.trim)
        case _ => None
      }
    }.toMap
    val attributes = JsObject(
      "brand" -> parsed.get("brand").map(JsString(_)).getOrElse(JsNull),
      "size" -> parsed.get("size").map(JsString(_)).getOrElse(JsNull),
      "unit" -> parsed.get("unit").map(JsString(_)).getOrElse(JsNull),
      "organic" -> JsBoolean(parsed.get("organic").exists(_.equalsIgnoreCase("true"))),
      "category" -> parsed.get("category").map(JsString(_)).getOrElse(JsNull)
    )
    JsObject(
      "sku_id" -> JsString(sku.sku_id),
      "attributes" -> attributes,
      "confidence" -> JsNumber(reply.confidence.toDouble),
      "status" -> JsString("accepted"),
      "source" -> JsString("model")
    )
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import spray.json._

final case class SkuJob(
    sku_id: String,
    merchant: String,
    content_hash: String,
    title: String,
    description: Option[String],
    images: Option[List[String]])

object ExtractAttributes {
  val DeadlineMs = 5000L
  val MaxAttempts = 2
  val BrandCandidates = 20
  val MinConfidence = 0.85
  val AllowedUnits = Set("ml", "l", "g", "kg", "oz", "fl oz", "lb", "ct")
  val AttributeSchema: String =
    """{
      |  "type": "object",
      |  "properties": {
      |    "brand": {"type": ["string", "null"]},
      |    "size": {"type": ["number", "null"]},
      |    "unit": {"type": ["string", "null"]},
      |    "organic": {"type": "boolean"},
      |    "category": {"type": ["string", "null"]}
      |  },
      |  "required": ["brand", "size", "unit", "organic", "category"],
      |  "additionalProperties": false
      |}""".stripMargin

  val stub = ExtractorGrpc.blockingStub(ManagedChannelBuilder.forAddress("extractor", 50051).usePlaintext().build())
  val taxonomy = Taxonomy.open()
  val review = ReviewQueue.open()

  def callModel(request: ExtractRequest): ExtractReply = {
    var lastError: Option[StatusRuntimeException] = None
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        return stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).extract(request)
      } catch {
        case exc: StatusRuntimeException =>
          lastError = Some(exc)
          if (exc.getStatus.getCode != Status.Code.UNAVAILABLE) throw exc
      }
      attempt += 1
    }
    throw lastError.getOrElse(new RuntimeException("extractor unavailable"))
  }

  /** Attributes the taxonomy accepts, and why anything was dropped. */
  def validate(raw: Map[String, JsValue], candidateNames: Set[String]): (JsObject, List[String]) = {
    val problems = scala.collection.mutable.ListBuffer.empty[String]
    val brand = raw.get("brand").collect { case JsString(b) => b }.filter { b =>
      val ok = candidateNames.contains(b)
      if (!ok) problems += s"brand '$b' is not a taxonomy candidate"
      ok
    }
    val size = raw.get("size").collect { case JsNumber(n) => n }.filter { n =>
      val ok = n > 0
      if (!ok) problems += "size must be a positive number"
      ok
    }
    val unit = raw.get("unit").collect { case JsString(u) => u }.filter { u =>
      val ok = AllowedUnits.contains(u)
      if (!ok) problems += s"unit '$u' is not allowed"
      ok
    }
    val category = raw.get("category").collect { case JsString(c) => c }.filter { c =>
      val ok = taxonomy.hasCategory(c)
      if (!ok) problems += s"category '$c' is not in the taxonomy"
      ok
    }
    val attributes = JsObject(
      "brand" -> brand.map(JsString(_)).getOrElse(JsNull),
      "size" -> size.map(JsNumber(_)).getOrElse(JsNull),
      "unit" -> unit.map(JsString(_)).getOrElse(JsNull),
      "organic" -> JsBoolean(raw.get("organic").contains(JsTrue)),
      "category" -> category.map(JsString(_)).getOrElse(JsNull)
    )
    (attributes, problems.toList)
  }

  def extractAttributes(sku: SkuJob): JsObject = {
    val text = s"\${sku.title} \${sku.description.getOrElse("")}".trim
    val candidates = taxonomy.nearestBrands(text, BrandCandidates)
    val candidateNames = candidates.toSet
    val reply = callModel(
      ExtractRequest(
        title = sku.title,
        description = sku.description.getOrElse(""),
        candidateBrands = candidates,
        schema = AttributeSchema
      )
    )
    val parsed =
      try Some(reply.output.parseJson.asJsObject.fields)
      catch { case _: Exception => None }
    val (attributes, problems) = parsed match {
      case Some(raw) => validate(raw, candidateNames)
      case None =>
        (
          JsObject("brand" -> JsNull, "size" -> JsNull, "unit" -> JsNull, "organic" -> JsFalse, "category" -> JsNull),
          List("model output is not a JSON object")
        )
    }
    val needsReview = problems.nonEmpty || reply.confidence < MinConfidence
    val result = JsObject(
      "sku_id" -> JsString(sku.sku_id),
      "attributes" -> attributes,
      "confidence" -> JsNumber(reply.confidence.toDouble),
      "taxonomy_version" -> JsString(taxonomy.version()),
      "source" -> JsString("model"),
      "status" -> JsString(if (needsReview) "review" else "accepted")
    )
    if (needsReview) {
      val reason =
        if (problems.nonEmpty) problems.mkString("; ") else f"confidence \${reply.confidence}%.2f below threshold"
      review.enqueue(sku.sku_id, result, reason)
    }
    result
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "extractor.grpc.pb.h"

#include <algorithm>
#include <cctype>
#include <memory>
#include <nlohmann/json.hpp>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

std::unique_ptr<Extractor::Stub> stub;

const std::vector<std::string> kFields = {"brand", "size", "unit", "organic", "category"};

std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
  return s;
}

std::string trim(const std::string& s) {
  const auto begin = s.find_first_not_of(" \\t\\r\\n");
  if (begin == std::string::npos) return "";
  const auto end = s.find_last_not_of(" \\t\\r\\n");
  return s.substr(begin, end - begin + 1);
}

// TODO: this draft sends the title alone and lets the model name any brand, has no deadline and
// no retry, parses "key: value" lines, trusts every value, and never routes anything to review.
// Review all five.
json extractAttributes(const json& sku) {
  grpc::ClientContext ctx;
  ExtractRequest request;
  request.set_title(sku["title"].get<std::string>());
  request.set_description(sku.value("description", std::string()));
  ExtractReply reply;
  const grpc::Status status = stub->Extract(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("extract failed: " + status.error_message());

  json attributes;
  for (const auto& field : kFields) attributes[field] = nullptr;
  std::istringstream lines(reply.output());
  std::string line;
  while (std::getline(lines, line)) {
    const auto colon = line.find(':');
    if (colon == std::string::npos) continue;
    const auto key = lower(trim(line.substr(0, colon)));
    if (std::find(kFields.begin(), kFields.end(), key) != kFields.end()) attributes[key] = trim(line.substr(colon + 1));
  }
  attributes["organic"] = attributes["organic"].is_string() && lower(attributes["organic"].get<std::string>()) == "true";
  return json{{"sku_id", sku["sku_id"]},
              {"attributes", attributes},
              {"confidence", reply.confidence()},
              {"status", "accepted"},
              {"source", "model"}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "extractor.grpc.pb.h"

#include <chrono>
#include <memory>
#include <nlohmann/json.hpp>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kDeadlineMs = 5000;
constexpr int kMaxAttempts = 2;
constexpr int kBrandCandidates = 20;
constexpr double kMinConfidence = 0.85;
const std::set<std::string> kAllowedUnits = {"ml", "l", "g", "kg", "oz", "fl oz", "lb", "ct"};
const char* kAttributeSchema = R"SCHEMA({
  "type": "object",
  "properties": {
    "brand": {"type": ["string", "null"]},
    "size": {"type": ["number", "null"]},
    "unit": {"type": ["string", "null"]},
    "organic": {"type": "boolean"},
    "category": {"type": ["string", "null"]}
  },
  "required": ["brand", "size", "unit", "organic", "category"],
  "additionalProperties": false
})SCHEMA";

// The brand and category knowledge graph the model is constrained by.
struct Taxonomy {
  std::string version();
  std::vector<std::string> nearestBrands(const std::string& text, int k);
  bool hasCategory(const std::string& category);
};

struct ReviewQueue {
  void enqueue(const std::string& skuId, const json& result, const std::string& reason);
};

std::unique_ptr<Extractor::Stub> stub;
Taxonomy taxonomy;
ReviewQueue review;

ExtractReply callModel(const ExtractRequest& request) {
  grpc::Status last;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    ExtractReply reply;
    last = stub->Extract(&ctx, request, &reply);
    if (last.ok()) return reply;
    if (last.error_code() != grpc::StatusCode::UNAVAILABLE)
      throw std::runtime_error("extract failed: " + last.error_message());
  }
  throw std::runtime_error("extractor unavailable: " + last.error_message());
}

struct Validated {
  json attributes;
  std::vector<std::string> problems;
};

// Attributes the taxonomy accepts, and why anything was dropped.
Validated validate(const json& raw, const std::set<std::string>& candidateNames) {
  Validated out;
  out.attributes = {{"brand", nullptr}, {"size", nullptr}, {"unit", nullptr}, {"organic", false}, {"category", nullptr}};
  if (raw.contains("brand") && raw["brand"].is_string()) {
    const auto brand = raw["brand"].get<std::string>();
    if (candidateNames.count(brand) > 0) out.attributes["brand"] = brand;
    else out.problems.push_back("brand '" + brand + "' is not a taxonomy candidate");
  }
  if (raw.contains("size") && raw["size"].is_number()) {
    const auto size = raw["size"].get<double>();
    if (size > 0) out.attributes["size"] = size;
    else out.problems.push_back("size must be a positive number");
  }
  if (raw.contains("unit") && raw["unit"].is_string()) {
    const auto unit = raw["unit"].get<std::string>();
    if (kAllowedUnits.count(unit) > 0) out.attributes["unit"] = unit;
    else out.problems.push_back("unit '" + unit + "' is not allowed");
  }
  if (raw.contains("category") && raw["category"].is_string()) {
    const auto category = raw["category"].get<std::string>();
    if (taxonomy.hasCategory(category)) out.attributes["category"] = category;
    else out.problems.push_back("category '" + category + "' is not in the taxonomy");
  }
  out.attributes["organic"] = raw.contains("organic") && raw["organic"].is_boolean() && raw["organic"].get<bool>();
  return out;
}

json extractAttributes(const json& sku) {
  const auto title = sku["title"].get<std::string>();
  const auto description = sku.value("description", std::string());
  const auto candidates = taxonomy.nearestBrands(title + " " + description, kBrandCandidates);
  const std::set<std::string> candidateNames(candidates.begin(), candidates.end());

  ExtractRequest request;
  request.set_title(title);
  request.set_description(description);
  for (const auto& brand : candidates) request.add_candidate_brands(brand);
  request.set_schema(kAttributeSchema);
  const ExtractReply reply = callModel(request);

  const json raw = json::parse(reply.output(), nullptr, false);
  Validated validated;
  if (raw.is_object()) {
    validated = validate(raw, candidateNames);
  } else {
    validated.attributes = {{"brand", nullptr}, {"size", nullptr}, {"unit", nullptr}, {"organic", false}, {"category", nullptr}};
    validated.problems.push_back("model output is not a JSON object");
  }
  const bool needsReview = !validated.problems.empty() || reply.confidence() < kMinConfidence;
  json result = {{"sku_id", sku["sku_id"]},
                 {"attributes", validated.attributes},
                 {"confidence", reply.confidence()},
                 {"taxonomy_version", taxonomy.version()},
                 {"source", "model"},
                 {"status", needsReview ? "review" : "accepted"}};
  if (needsReview) {
    std::string reason;
    for (const auto& problem : validated.problems) reason += (reason.empty() ? "" : "; ") + problem;
    if (reason.empty()) reason = "confidence " + std::to_string(reply.confidence()) + " below threshold";
    review.enqueue(sku["sku_id"].get<std::string>(), result, reason);
  }
  return result;
}
`,
    },
  },
  debrief: `The interviewer is testing whether you know what to put around a model so that its output can be trusted by a system that cannot read it. The source post's answer, which this step reproduces, is constraint from three sides: retrieval before the call (the model picks a brand from candidates that exist in the taxonomy, the way DoorDash's brand pipeline retrieves similar brands from the knowledge graph before deciding), structure in the call (a schema, parsed as JSON — the search post's structured output mapped onto taxonomy categories), and validation after the call (nothing outside the controlled vocabulary survives). The deadline and the single retry on UNAVAILABLE are the ordinary gRPC hygiene a generated client never has. The confidence gate is what makes the human reviewers useful: it is the handoff the posts describe, where SKUs the model cannot tag confidently go to a person instead of into the catalog. Real extractors add per-category attribute sets (a wine has a vintage, a beer does not), an in-house classifier in front of the model so only hard SKUs pay for an LLM call, and image inputs when the title is an abbreviation.`,
};
