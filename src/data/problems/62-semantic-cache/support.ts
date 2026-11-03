import {CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

/**
 * Support modules of the semantic cache, the `semcache` package: `vectors`, the cosine similarity
 * every step and every harness measure a hit by (the same arithmetic in the five languages), and for
 * C++ the headers that declare what one step defines and the others call (`state.h`: the store of
 * step 2; `events.h`: the result stream of step 4), so each step compiles alone and the harness
 * stands in for its neighbours.
 */
const COSINE_DOC =
  'Cosine similarity of two embeddings: 1 for the same direction, 0 for orthogonal vectors, 0 when either is all zeros or the lengths differ.';

export const supportModules: Record<string, string> = {
  'semcache/__init__.py': '',
  'semcache/vectors.py': `"""${COSINE_DOC}"""
import math


def cosine(a: list[float], b: list[float]) -> float:
    if len(a) != len(b) or not a:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm > 0 else 0.0
`,
};

export const supportModulesTs: Record<string, string> = {
  'semcache/vectors.ts': `/** ${COSINE_DOC} */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm > 0 ? dot / norm : 0;
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'semcache/vectors/vectors.go': `// Package vectors measures embeddings: Cosine is the similarity every step and every check agree on.
package vectors

import "math"

// Cosine is the cosine similarity of two embeddings: 1 for the same direction, 0 for orthogonal
// vectors, 0 when either is all zeros or the lengths differ.
func Cosine(a, b []float64) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	norm := math.Sqrt(na) * math.Sqrt(nb)
	if norm == 0 {
		return 0
	}
	return dot / norm
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'ids.h': CPP_IDS_H,
  'semcache/vectors.h': `// ${COSINE_DOC}
#pragma once

#include <cmath>
#include <vector>

namespace semcache {

inline double cosine(const std::vector<double>& a, const std::vector<double>& b) {
  if (a.size() != b.size() || a.empty()) return 0.0;
  double dot = 0, na = 0, nb = 0;
  for (size_t i = 0; i < a.size(); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const double norm = std::sqrt(na) * std::sqrt(nb);
  return norm > 0 ? dot / norm : 0.0;
}

}  // namespace semcache
`,
  'state.h': `// The cache store (step 2) as the other steps call it. Entries live in Redis: the hash
// entry:{tenant}:{model_version}:{entry_id} with the fields embedding (a JSON array), answer,
// created_at, expires_at (unix seconds), policy_version; the set semantic:{tenant}:{model_version}
// lists the tenant's entry keys.
#pragma once

#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

// One stored answer as a lookup sees it: similarity is the cosine to the query (0 from get_entry).
struct Entry {
  std::string entry_id;
  std::string answer;
  double similarity = 0;
  double created_at = 0;
  double expires_at = 0;
  std::string policy_version;
};

// A hash that exists but has no answer: an interrupted write, not an entry.
struct IncompleteEntry : std::runtime_error {
  using std::runtime_error::runtime_error;
};

constexpr long kEntryTtlSeconds = 86400;

std::string entry_key(const std::string& tenant, const std::string& model_version, const std::string& entry_id);
std::string index_name(const std::string& tenant, const std::string& model_version);

// Write the entry (embedding, answer, created_at, expires_at, policy_version) and list it in the
// tenant's index.
void put_entry(const std::string& tenant, const std::string& model_version, const std::string& entry_id,
               const std::vector<double>& embedding, const std::string& answer, const std::string& policy_version);

// The entry nearest to embedding in the tenant's index with similarity >= threshold, or nullopt.
// Serving it is the endpoint's decision: an entry past its expires_at is still returned.
std::optional<Entry> search_entries(const std::string& tenant, const std::string& model_version,
                                    const std::vector<double>& embedding, double threshold);

// One entry by id (nullopt when there is none); throws IncompleteEntry when the hash has no answer.
std::optional<Entry> get_entry(const std::string& tenant, const std::string& model_version, const std::string& entry_id);
`,
  'events.h': `// The result stream (step 4) as the lookup endpoint calls it: one semantic-cache.result event per
// lookup, keyed by tenant; the stats consumer folds the events into stats:{tenant}:{model_version}.
#pragma once

#include <optional>
#include <stdexcept>
#include <string>

// What the lookup knows when it answers. On the wire the event is {outcome, entry_id, similarity,
// policy_version, model_version, client_class, entry_age_seconds}.
struct ResultEvent {
  std::string outcome;  // "hit" or "miss"
  std::string entry_id;  // "" on a miss
  std::optional<double> similarity;  // nullopt on a miss
  std::string policy_version;  // the entry's; "" on a miss
  std::string model_version;
  std::string client_class;  // "human" or "automated", from X-Client-Class
  long entry_age_seconds = 0;  // 0 on a miss
};

// The broker rejected the produce: the event is in the outbox, not on the topic.
struct ProduceRejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Publish one event keyed by tenant; throws ProduceRejected after writing the outbox row.
void publish_result(const std::string& tenant, const ResultEvent& result);
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('semcache', 'Vectors')]: `package semcache

/** ${COSINE_DOC} */
object Vectors {
  def cosine(a: Seq[Double], b: Seq[Double]): Double = {
    if (a.length != b.length || a.isEmpty) return 0.0
    val dot = a.zip(b).map { case (x, y) => x * y }.sum
    val norm = math.sqrt(a.map(x => x * x).sum) * math.sqrt(b.map(y => y * y).sum)
    if (norm > 0) dot / norm else 0.0
  }
}
`,
};
