import type {Step} from '@/lib/types';

export const verifyEndpointStep: Step = {
  id: 'verify-endpoint',
  title: 'POST /v1/entities/{id}/verify: owner only, tier derived on the server, audited',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'verify_api',
  focus: ['owner', 'metasense', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/entities/{entity_id}/verify\` with body
\`{"action": "ack" | "edit", "tags": {"passport_no": "Personal.ID"}, "tier": 4}\`. It answers 401
without \`X-User-Id\` and 404 when \`store.pending(entity_id)\` (\`metasense.store\`) has nothing; on
\`edit\` the body's tags replace the pending ones. It stores the tags with the body's \`tier\` through
\`store.record_verification\` and answers \`{entity, tier, tags, version}\`. It serves the demo and
hides 4 flaws.

**Failure mode the checks target.** Any caller with a user id can verify any table; a tier copied
from the body lets a producer mark a passport table Tier 4 and open it to the company; a tag outside
the library is a tier nobody defined; and a verification with no audit entry cannot be defended.

- Only the owner of the pending verification may verify: anyone else is **403**.
- The tier is derived from the tags over \`PRIVACY_RULES\`: any \`Personal.ID\` is Tier 1, else
  \`Personal.Name\` or \`Personal.Contact_Info\` Tier 2, else \`Geo.Geohash\` Tier 3, else Tier 4.
  A \`tier\` in the body is ignored.
- An \`action\` other than \`ack\`/\`edit\`, or an edited tag that \`taxonomy.known\` rejects, is **400**.
- Call \`store.audit(entity_id, user, action)\` and answer \`verified_by\` too.`,
  sequence: {
    participants: ['Data owner', 'metasense', 'Redis'],
    messages: [
      {from: 'Data owner', to: 'metasense', label: 'POST /v1/entities/deliveries/verify · X-User-Id', kind: 'sync'},
      {from: 'metasense', to: 'Redis', label: 'pending(deliveries) → owner, tags', kind: 'sync'},
      {
        from: 'metasense',
        to: 'metasense',
        label: 'owner? 403 · action, tags known? 400 · derive_tier(tags)',
        kind: 'sync',
      },
      {from: 'metasense', to: 'Redis', label: 'record_verification · audit(entity, user, action)', kind: 'sync'},
      {from: 'metasense', to: 'Data owner', label: '200 {entity, tier, tags, verified_by, version}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves POST /v1/entities/{entity_id}/verify',
      detail:
        'The owner acknowledging the pending tags gets 200 with the entity, its tags and version 1, and the classification is stored.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/entities\/\{entity_id\}\/verify["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/entities\/:entityId\/verify['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/entities\/\{entity_id\}\/verify"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"entities"\s*\/\s*Segment\s*\/\s*"verify"\s*\)/]},
        cpp: {all: [/svr\.Post\(\s*R"\(\/v1\/entities\/\(\[\^\/\]\+\)\/verify\)"/]},
      },
    },
    {
      id: 'owner-only',
      title: 'Lets only the owner verify',
      detail:
        'A caller who is not the owner in the pending verification gets 403 and nothing is stored. The starter lets any caller with a user id verify any table.',
      match: {
        python: {all: [/\b403\b/, /\[["']owner["']\]/]},
        typescript: {all: [/\b403\b/, /\.owner\b/]},
        go: {all: [/StatusForbidden/, /\.Owner\b/]},
        scala: {all: [/StatusCodes\.Forbidden/, /\.owner\b/]},
        cpp: {all: [/\b403\b/, /->owner\b/]},
      },
    },
    {
      id: 'tier-server-side',
      title: 'Derives the tier from the tags, never from the body',
      detail:
        'An edit that tags `passport_no` as `Personal.ID` while sending `"tier": 4` is stored and answered as Tier 1; acknowledged contact data is Tier 2 whatever the body says. The starter stores the tier the caller sent.',
      match: {
        python: {all: [/PRIVACY_RULES/, /derive_tier\(/], none: [/body\.get\(\s*["']tier["']/, /body\[["']tier["']\]/]},
        typescript: {all: [/PRIVACY_RULES/, /deriveTier\(/], none: [/body\.tier\b/, /\[['"]tier['"]\]/]},
        go: {all: [/privacyRules/, /deriveTier\(/], none: [/body\.Tier\b/]},
        scala: {all: [/PrivacyRules/, /deriveTier\(/], none: [/body\.get\("tier"\)/, /body\("tier"\)/]},
        cpp: {all: [/kPrivacyRules/, /deriveTier\(/], none: [/value\("tier"/, /body\["tier"\]/]},
      },
    },
    {
      id: 'tag-whitelist',
      title: 'Rejects unknown actions and tags outside the library with 400',
      detail:
        'An edit that tags a column `Public` and an action `approve` both answer 400 and store nothing. The starter stores any string as a tag and treats any action as an acknowledgement.',
      match: {
        python: {all: [/taxonomy\.known\(/, /\b400\b/]},
        typescript: {all: [/\bknown\(/, /\b400\b/]},
        go: {all: [/taxonomy\.Known\(/, /StatusBadRequest/]},
        scala: {all: [/Taxonomy\.known\b/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/taxonomy::known\(/, /\b400\b/]},
      },
    },
    {
      id: 'audit',
      title: 'Audits who verified, and answers verified_by',
      detail:
        'Each verification appends `{user, action}` to `audit:{entity}` and the response names `verified_by`. The starter keeps no record of who confirmed the tags.',
      match: {
        python: {all: [/store\.audit\(/, /["']verified_by["']/]},
        typescript: {all: [/\baudit\(/, /verified_by/]},
        go: {all: [/store\.Audit\(/, /"verified_by"/]},
        scala: {all: [/Store\.audit\(/, /"verified_by"/]},
        cpp: {all: [/store::audit\(/, /"verified_by"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from metasense import store, taxonomy  # store.pending, record_verification, audit; taxonomy.known

app = FastAPI()


@app.post("/v1/entities/{entity_id}/verify")
async def verify(entity_id: str, request: Request) -> dict:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    user = request.headers.get("x-user-id", "")
    if not user:
        raise HTTPException(status_code=401, detail="X-User-Id is required")
    pending = store.pending(entity_id)
    if pending is None:
        raise HTTPException(status_code=404, detail="nothing waits for verification")
    body = await request.json()
    tags = dict(pending["tags"])
    if body.get("action") == "edit":
        tags.update(body.get("tags", {}))
    tier = int(body.get("tier", 4))
    version = store.record_verification(entity_id, tags, tier, user)
    return {"entity": entity_id, "tier": tier, "tags": tags, "version": version}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from metasense import store, taxonomy  # store.pending, record_verification, audit; taxonomy.known

app = FastAPI()

# The privacy office's rules, most sensitive first: the first tier whose tags appear wins.
PRIVACY_RULES = (
    (1, {"Personal.ID"}),
    (2, {"Personal.Name", "Personal.Contact_Info"}),
    (3, {"Geo.Geohash"}),
)
LEAST_SENSITIVE_TIER = 4
ACTIONS = ("ack", "edit")


def derive_tier(tags: dict[str, str]) -> int:
    present = set(tags.values())
    for tier, sensitive in PRIVACY_RULES:
        if present & sensitive:
            return tier
    return LEAST_SENSITIVE_TIER


@app.post("/v1/entities/{entity_id}/verify")
async def verify(entity_id: str, request: Request) -> dict:
    user = request.headers.get("x-user-id", "")
    if not user:
        raise HTTPException(status_code=401, detail="X-User-Id is required")
    pending = store.pending(entity_id)
    if pending is None:
        raise HTTPException(status_code=404, detail="nothing waits for verification")
    if pending["owner"] != user:
        raise HTTPException(status_code=403, detail="only the owner verifies an entity")
    body = await request.json()
    action = body.get("action")
    if action not in ACTIONS:
        raise HTTPException(status_code=400, detail="action is ack or edit")
    tags = dict(pending["tags"])
    if action == "edit":
        edits = body.get("tags", {})
        if not isinstance(edits, dict) or not all(taxonomy.known(tag) for tag in edits.values()):
            raise HTTPException(status_code=400, detail="every tag must be in the tag library")
        tags.update(edits)
    tier = derive_tier(tags)  # access control reads the tier: it is computed, never taken from the caller
    version = store.record_verification(entity_id, tags, tier, user)
    store.audit(entity_id, user, action)
    return {"entity": entity_id, "tier": tier, "tags": tags, "verified_by": user, "version": version}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {audit, pending, recordVerification} from 'metasense/store';
import {known} from 'metasense/taxonomy';

export const app = Fastify();

interface VerifyBody {
  action?: string;
  tags?: Record<string, string>;
  tier?: number;
}

app.post('/v1/entities/:entityId/verify', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {entityId} = request.params as {entityId: string};
  const user = request.headers['x-user-id'];
  if (typeof user !== 'string' || user === '') return reply.code(401).send({error: 'X-User-Id is required'});
  const open = await pending(entityId);
  if (open === null) return reply.code(404).send({error: 'nothing waits for verification'});
  const body = (request.body ?? {}) as VerifyBody;
  const tags = body.action === 'edit' ? {...open.tags, ...body.tags} : {...open.tags};
  const tier = body.tier ?? 4;
  const version = await recordVerification(entityId, tags, tier, user);
  return {entity: entityId, tier, tags, version};
});
`,
      solution: `import Fastify from 'fastify';

import {audit, pending, recordVerification} from 'metasense/store';
import {known} from 'metasense/taxonomy';

export const app = Fastify();

// The privacy office's rules, most sensitive first: the first tier whose tags appear wins.
export const PRIVACY_RULES: readonly [number, readonly string[]][] = [
  [1, ['Personal.ID']],
  [2, ['Personal.Name', 'Personal.Contact_Info']],
  [3, ['Geo.Geohash']],
];
export const LEAST_SENSITIVE_TIER = 4;
const ACTIONS = ['ack', 'edit'];

interface VerifyBody {
  action?: string;
  tags?: Record<string, unknown>;
}

export function deriveTier(tags: Record<string, string>): number {
  const present = new Set(Object.values(tags));
  return PRIVACY_RULES.find(([, sensitive]) => sensitive.some(tag => present.has(tag)))?.[0] ?? LEAST_SENSITIVE_TIER;
}

app.post('/v1/entities/:entityId/verify', async (request, reply) => {
  const {entityId} = request.params as {entityId: string};
  const user = request.headers['x-user-id'];
  if (typeof user !== 'string' || user === '') return reply.code(401).send({error: 'X-User-Id is required'});
  const open = await pending(entityId);
  if (open === null) return reply.code(404).send({error: 'nothing waits for verification'});
  if (open.owner !== user) return reply.code(403).send({error: 'only the owner verifies an entity'});
  const body = (request.body ?? {}) as VerifyBody;
  const action = body.action ?? '';
  if (!ACTIONS.includes(action)) return reply.code(400).send({error: 'action is ack or edit'});
  const tags: Record<string, string> = {...open.tags};
  if (action === 'edit') {
    const edits = body.tags ?? {};
    if (!Object.values(edits).every(tag => known(tag))) return reply.code(400).send({error: 'every tag must be in the tag library'});
    Object.assign(tags, edits);
  }
  const tier = deriveTier(tags); // access control reads the tier: it is computed, never taken from the caller
  const version = await recordVerification(entityId, tags, tier, user);
  await audit(entityId, user, action);
  return {entity: entityId, tier, tags, verified_by: user, version};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"metasense/store" // store.Pending, RecordVerification, Audit
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func verifyEntity(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	entityID := r.PathValue("entity_id")
	user := r.Header.Get("X-User-Id")
	if user == "" {
		http.Error(rw, "X-User-Id is required", http.StatusUnauthorized)
		return
	}
	open, err := store.Pending(r.Context(), entityID)
	if err != nil || open == nil {
		http.Error(rw, "nothing waits for verification", http.StatusNotFound)
		return
	}
	var body struct {
		Action string            \`json:"action"\`
		Tags   map[string]string \`json:"tags"\`
		Tier   int               \`json:"tier"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	tags := map[string]string{}
	for column, tag := range open.Tags {
		tags[column] = tag
	}
	if body.Action == "edit" {
		for column, tag := range body.Tags {
			tags[column] = tag
		}
	}
	tier := body.Tier
	if tier == 0 {
		tier = 4
	}
	version, err := store.RecordVerification(r.Context(), entityID, tags, tier, user)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"entity": entityID, "tier": tier, "tags": tags, "version": version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/entities/{entity_id}/verify", verifyEntity)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"metasense/store" // store.Pending, RecordVerification, Audit
	"metasense/taxonomy"
)

// privacyRules are the privacy office's rules, most sensitive first: the first tier whose tags appear wins.
var privacyRules = []struct {
	tier int
	tags []string
}{
	{1, []string{"Personal.ID"}},
	{2, []string{"Personal.Name", "Personal.Contact_Info"}},
	{3, []string{"Geo.Geohash"}},
}

const leastSensitiveTier = 4

func deriveTier(tags map[string]string) int {
	present := map[string]bool{}
	for _, tag := range tags {
		present[tag] = true
	}
	for _, rule := range privacyRules {
		for _, tag := range rule.tags {
			if present[tag] {
				return rule.tier
			}
		}
	}
	return leastSensitiveTier
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func verifyEntity(rw http.ResponseWriter, r *http.Request) {
	entityID := r.PathValue("entity_id")
	user := r.Header.Get("X-User-Id")
	if user == "" {
		http.Error(rw, "X-User-Id is required", http.StatusUnauthorized)
		return
	}
	open, err := store.Pending(r.Context(), entityID)
	if err != nil || open == nil {
		http.Error(rw, "nothing waits for verification", http.StatusNotFound)
		return
	}
	if open.Owner != user {
		http.Error(rw, "only the owner verifies an entity", http.StatusForbidden)
		return
	}
	var body struct {
		Action string            \`json:"action"\`
		Tags   map[string]string \`json:"tags"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || (body.Action != "ack" && body.Action != "edit") {
		http.Error(rw, "action is ack or edit", http.StatusBadRequest)
		return
	}
	tags := map[string]string{}
	for column, tag := range open.Tags {
		tags[column] = tag
	}
	if body.Action == "edit" {
		for column, tag := range body.Tags {
			if !taxonomy.Known(tag) {
				http.Error(rw, "every tag must be in the tag library", http.StatusBadRequest)
				return
			}
			tags[column] = tag
		}
	}
	tier := deriveTier(tags) // access control reads the tier: it is computed, never taken from the caller
	version, err := store.RecordVerification(r.Context(), entityID, tags, tier, user)
	if err == nil {
		err = store.Audit(r.Context(), entityID, user, body.Action)
	}
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"entity": entityID, "tier": tier, "tags": tags, "verified_by": user, "version": version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/entities/{entity_id}/verify", verifyEntity)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import metasense.{Store, Taxonomy} // Store.pending, recordVerification, audit; Taxonomy.known

object VerifyApi {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def tagsOf(value: Option[JsValue]): Map[String, String] = value match {
    case Some(JsObject(fields)) => fields.collect { case (c, JsString(t)) => c -> t }
    case _                      => Map.empty
  }

  val route: Route = path("v1" / "entities" / Segment / "verify") { entityId =>
    post {
      optionalHeaderValueByName("X-User-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-User-Id is required")
        case Some(user) =>
          entity(as[String]) { raw =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            Store.pending(entityId) match {
              case None => complete(StatusCodes.NotFound -> "nothing waits for verification")
              case Some(open) =>
                val body = raw.parseJson.asJsObject.fields
                val tags = if (body.get("action").contains(JsString("edit"))) open.tags ++ tagsOf(body.get("tags")) else open.tags
                val tier = body.get("tier").collect { case JsNumber(n) => n.toInt }.getOrElse(4)
                val version = Store.recordVerification(entityId, tags, tier, user)
                val answer = JsObject(
                  "entity" -> JsString(entityId),
                  "tier" -> JsNumber(tier),
                  "tags" -> JsObject(tags.map { case (c, t) => c -> JsString(t) }),
                  "version" -> JsNumber(version)
                )
                complete(json(StatusCodes.OK, answer))
            }
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import metasense.{Store, Taxonomy} // Store.pending, recordVerification, audit; Taxonomy.known

object VerifyApi {
  /** The privacy office's rules, most sensitive first: the first tier whose tags appear wins. */
  val PrivacyRules: Seq[(Int, Set[String])] = Seq(
    1 -> Set("Personal.ID"),
    2 -> Set("Personal.Name", "Personal.Contact_Info"),
    3 -> Set("Geo.Geohash")
  )
  val LeastSensitiveTier = 4
  val Actions = Set("ack", "edit")

  def deriveTier(tags: Map[String, String]): Int =
    PrivacyRules.collectFirst { case (tier, sensitive) if tags.values.exists(sensitive.contains) => tier }.getOrElse(LeastSensitiveTier)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "entities" / Segment / "verify") { entityId =>
    post {
      optionalHeaderValueByName("X-User-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-User-Id is required")
        case Some(user) =>
          entity(as[String]) { raw =>
            Store.pending(entityId) match {
              case None                             => complete(StatusCodes.NotFound -> "nothing waits for verification")
              case Some(open) if open.owner != user => complete(StatusCodes.Forbidden -> "only the owner verifies an entity")
              case Some(open) =>
                val body = raw.parseJson.asJsObject.fields
                val action = body.get("action").collect { case JsString(a) => a }.getOrElse("")
                val edits = body.get("tags") match {
                  case Some(JsObject(fields)) if action == "edit" => fields.toSeq.map { case (c, t) => c -> t }
                  case _                                          => Seq.empty
                }
                val known = edits.collect { case (c, JsString(t)) if Taxonomy.known(t) => c -> t }
                if (!Actions.contains(action)) complete(StatusCodes.BadRequest -> "action is ack or edit")
                else if (known.size != edits.size) complete(StatusCodes.BadRequest -> "every tag must be in the tag library")
                else {
                  val tags = open.tags ++ known
                  val tier = deriveTier(tags) // access control reads the tier: it is computed, never taken from the caller
                  val version = Store.recordVerification(entityId, tags, tier, user)
                  Store.audit(entityId, user, action)
                  val answer = JsObject(
                    "entity" -> JsString(entityId),
                    "tier" -> JsNumber(tier),
                    "tags" -> JsObject(tags.map { case (c, t) => c -> JsString(t) }),
                    "verified_by" -> JsString(user),
                    "version" -> JsNumber(version)
                  )
                  complete(json(StatusCodes.OK, answer))
                }
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

#include <string>

#include "metasense/store.h"     // store::pending, recordVerification, audit
#include "metasense/taxonomy.h"  // taxonomy::known

using json = nlohmann::json;

void verify_entity(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string entity_id = req.matches[1];
  const std::string user = req.get_header_value("X-User-Id");
  if (user.empty()) {
    res.status = 401;
    res.set_content("X-User-Id is required", "text/plain");
    return;
  }
  const auto open = store::pending(entity_id);
  if (!open) {
    res.status = 404;
    res.set_content("nothing waits for verification", "text/plain");
    return;
  }
  const json body = json::parse(req.body);
  auto tags = open->tags;
  if (body.value("action", "") == "edit" && body.contains("tags")) {
    for (const auto& [column, tag] : body["tags"].items()) tags[column] = tag.get<std::string>();
  }
  const int tier = body.value("tier", 4);
  const long long version = store::recordVerification(entity_id, tags, tier, user);
  res.set_content(json{{"entity", entity_id}, {"tier", tier}, {"tags", tags}, {"version", version}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post(R"(/v1/entities/([^/]+)/verify)", verify_entity); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "metasense/store.h"     // store::pending, recordVerification, audit
#include "metasense/taxonomy.h"  // taxonomy::known

using json = nlohmann::json;

// The privacy office's rules, most sensitive first: the first tier whose tags appear wins.
const std::vector<std::pair<int, std::set<std::string>>> kPrivacyRules = {
    {1, {"Personal.ID"}},
    {2, {"Personal.Name", "Personal.Contact_Info"}},
    {3, {"Geo.Geohash"}},
};
constexpr int kLeastSensitiveTier = 4;

int deriveTier(const std::map<std::string, std::string>& tags) {
  for (const auto& [tier, sensitive] : kPrivacyRules) {
    for (const auto& [column, tag] : tags) {
      if (sensitive.count(tag)) return tier;
    }
  }
  return kLeastSensitiveTier;
}

void reject(httplib::Response& res, int status, const std::string& why) {
  res.status = status;
  res.set_content(why, "text/plain");
}

void verify_entity(const httplib::Request& req, httplib::Response& res) {
  const std::string entity_id = req.matches[1];
  const std::string user = req.get_header_value("X-User-Id");
  if (user.empty()) return reject(res, 401, "X-User-Id is required");
  const auto open = store::pending(entity_id);
  if (!open) return reject(res, 404, "nothing waits for verification");
  if (open->owner != user) return reject(res, 403, "only the owner verifies an entity");
  const json body = json::parse(req.body, nullptr, false);
  const std::string action = body.is_object() && body.contains("action") && body["action"].is_string() ? body["action"].get<std::string>() : "";
  if (action != "ack" && action != "edit") return reject(res, 400, "action is ack or edit");
  auto tags = open->tags;
  if (action == "edit" && body.contains("tags") && body["tags"].is_object()) {
    for (const auto& [column, tag] : body["tags"].items()) {
      if (!tag.is_string() || !taxonomy::known(tag.get<std::string>())) return reject(res, 400, "every tag must be in the tag library");
      tags[column] = tag.get<std::string>();
    }
  }
  const int tier = deriveTier(tags);  // access control reads the tier: it is computed, never taken from the caller
  const long long version = store::recordVerification(entity_id, tags, tier, user);
  store::audit(entity_id, user, action);
  res.set_content(json{{"entity", entity_id}, {"tier", tier}, {"tags", tags}, {"verified_by", user}, {"version", version}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post(R"(/v1/entities/([^/]+)/verify)", verify_entity); }
`,
    },
  },
  harness: {
    python: `import json

OWNER = "team-logistics"
HASH = "4f2a"
PENDING = {"merchant_id": "None", "passport_no": "None", "customer_email": "Personal.Contact_Info"}


def _api(ctx):
    ctx.redis.hset("verify:deliveries", mapping={"owner": OWNER, "schema_hash": HASH, "state": "pending"})
    ctx.redis.set(f"classify:deliveries:{HASH}", json.dumps(PENDING))
    return ctx.client(ctx.load("verify_api").app)


async def _verify(c, body, user=OWNER):
    headers = {"X-User-Id": user} if user else {}
    return await c.post("/v1/entities/deliveries/verify", json=body, headers=headers)


def _stored(ctx):
    return ctx.redis.hgetall("entity:deliveries")


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _verify(c, {"action": "ack"})
    assert r.status_code == 200, f"the owner's ack answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("entity") == "deliveries" and body.get("tags") == PENDING and body.get("version") == 1, f"the ack answered {body}, expected the entity, the pending tags and version 1"
    assert _stored(ctx).get("version") == "1", f"entity:deliveries holds {_stored(ctx)} after the ack"


async def check_owner_only(ctx):
    async with _api(ctx) as c:
        r = await _verify(c, {"action": "edit", "tags": {"passport_no": "None"}}, user="team-growth")
        assert r.status_code == 403, f"team-growth verified team-logistics' table and got {r.status_code}, expected 403: only the owner verifies"
        assert _stored(ctx) == {}, f"a refused verification stored {_stored(ctx)}"
        r = await _verify(c, {"action": "ack"}, user="")
        assert r.status_code == 401, f"a verification without X-User-Id answered {r.status_code}, expected 401"
        r = await _verify(c, {"action": "ack"})
    assert r.status_code == 200, f"the owner's own ack answered {r.status_code}: {r.text}"


async def check_tier_server_side(ctx):
    async with _api(ctx) as c:
        r = await _verify(c, {"action": "ack", "tier": 4})
        assert r.status_code == 200, f"the owner's ack answered {r.status_code}: {r.text}"
        assert r.json().get("tier") == 2, f"acknowledged tags with Personal.Contact_Info answered tier {r.json().get('tier')}, expected 2: the tier comes from the tags, not the body"
        r = await _verify(c, {"action": "edit", "tags": {"passport_no": "Personal.ID"}, "tier": 4})
    assert r.status_code == 200, f"the owner's edit answered {r.status_code}: {r.text}"
    assert r.json().get("tier") == 1, f"passport_no tagged Personal.ID with \\"tier\\": 4 in the body answered tier {r.json().get('tier')}, expected 1"
    assert _stored(ctx).get("tier") == "1", f"entity:deliveries stores tier {_stored(ctx).get('tier')!r}, expected 1: access control reads this"


async def check_tag_whitelist(ctx):
    async with _api(ctx) as c:
        r = await _verify(c, {"action": "edit", "tags": {"passport_no": "Public"}})
        assert r.status_code == 400, f"an edit with the tag Public answered {r.status_code}, expected 400: Public is not in the tag library"
        r = await _verify(c, {"action": "approve"})
        assert r.status_code == 400, f"the action approve answered {r.status_code}, expected 400: actions are ack and edit"
    assert _stored(ctx) == {}, f"refused verifications stored {_stored(ctx)}"


async def check_audit(ctx):
    async with _api(ctx) as c:
        r = await _verify(c, {"action": "edit", "tags": {"passport_no": "Personal.ID"}})
    assert r.status_code == 200, f"the owner's edit answered {r.status_code}: {r.text}"
    assert r.json().get("verified_by") == OWNER, f"the response names verified_by {r.json().get('verified_by')!r}, expected {OWNER}"
    entries = [json.loads(e) for e in ctx.redis.lrange("audit:deliveries", 0, -1)]
    assert [(e.get("user"), e.get("action")) for e in entries] == [(OWNER, "edit")], f"audit:deliveries holds {entries}, expected one entry for {OWNER}'s edit"
`,
    typescript: `const OWNER = 'team-logistics';
const HASH = '4f2a';
const PENDING = {merchant_id: 'None', passport_no: 'None', customer_email: 'Personal.Contact_Info'};

function api(ctx) {
  ctx.redis.hset('verify:deliveries', {owner: OWNER, schema_hash: HASH, state: 'pending'});
  ctx.redis.set(\`classify:deliveries:\${HASH}\`, JSON.stringify(PENDING));
  return ctx.client(ctx.load('verify_api').app);
}

const verify = (c, body, user = OWNER) => c.post('/v1/entities/deliveries/verify', {json: body, headers: user ? {'X-User-Id': user} : {}});
const stored = ctx => ({...ctx.redis.hgetall('entity:deliveries')});

export async function check_route(ctx) {
  const c = api(ctx);
  const r = await verify(c, {action: 'ack'});
  assert.equal(r.status, 200, \`the owner's ack answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.entity === 'deliveries' && body.version === 1, \`the ack answered \${r.text}, expected the entity and version 1\`);
  assert.deepEqual(body.tags, PENDING, \`the ack answered tags \${JSON.stringify(body.tags)}, expected the pending tags\`);
  assert.equal(stored(ctx).version, '1', \`entity:deliveries holds \${JSON.stringify(stored(ctx))} after the ack\`);
}

export async function check_owner_only(ctx) {
  const c = api(ctx);
  let r = await verify(c, {action: 'edit', tags: {passport_no: 'None'}}, 'team-growth');
  assert.equal(r.status, 403, \`team-growth verified team-logistics' table and got \${r.status}, expected 403: only the owner verifies\`);
  assert.deepEqual(stored(ctx), {}, \`a refused verification stored \${JSON.stringify(stored(ctx))}\`);
  r = await verify(c, {action: 'ack'}, '');
  assert.equal(r.status, 401, \`a verification without X-User-Id answered \${r.status}, expected 401\`);
  r = await verify(c, {action: 'ack'});
  assert.equal(r.status, 200, \`the owner's own ack answered \${r.status}: \${r.text}\`);
}

export async function check_tier_server_side(ctx) {
  const c = api(ctx);
  let r = await verify(c, {action: 'ack', tier: 4});
  assert.equal(r.status, 200, \`the owner's ack answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().tier, 2, \`acknowledged tags with Personal.Contact_Info answered tier \${r.json().tier}, expected 2: the tier comes from the tags, not the body\`);
  r = await verify(c, {action: 'edit', tags: {passport_no: 'Personal.ID'}, tier: 4});
  assert.equal(r.status, 200, \`the owner's edit answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().tier, 1, \`passport_no tagged Personal.ID with "tier": 4 in the body answered tier \${r.json().tier}, expected 1\`);
  assert.equal(stored(ctx).tier, '1', \`entity:deliveries stores tier \${stored(ctx).tier}, expected 1: access control reads this\`);
}

export async function check_tag_whitelist(ctx) {
  const c = api(ctx);
  let r = await verify(c, {action: 'edit', tags: {passport_no: 'Public'}});
  assert.equal(r.status, 400, \`an edit with the tag Public answered \${r.status}, expected 400: Public is not in the tag library\`);
  r = await verify(c, {action: 'approve'});
  assert.equal(r.status, 400, \`the action approve answered \${r.status}, expected 400: actions are ack and edit\`);
  assert.deepEqual(stored(ctx), {}, \`refused verifications stored \${JSON.stringify(stored(ctx))}\`);
}

export async function check_audit(ctx) {
  const c = api(ctx);
  const r = await verify(c, {action: 'edit', tags: {passport_no: 'Personal.ID'}});
  assert.equal(r.status, 200, \`the owner's edit answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().verified_by, OWNER, \`the response names verified_by \${r.json().verified_by}, expected \${OWNER}\`);
  const entries = (ctx.redis.lrange('audit:deliveries', 0, -1) as string[]).map(e => JSON.parse(e));
  assert.deepEqual(entries.map(e => [e.user, e.action]), [[OWNER, 'edit']], \`audit:deliveries holds \${JSON.stringify(entries)}, expected one entry for \${OWNER}'s edit\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"net/http"

	"leetbuild/harness"
)

const (
	verifyOwner = "team-logistics"
	verifyHash  = "4f2a"
)

var verifyPending = map[string]string{"merchant_id": "None", "passport_no": "None", "customer_email": "Personal.Contact_Info"}

func verifyAPI(ctx *harness.Ctx) *harness.HTTP {
	ctx.Redis.Do("HSET", "verify:deliveries", "owner", verifyOwner, "schema_hash", verifyHash, "state", "pending")
	raw, _ := json.Marshal(verifyPending)
	ctx.Redis.Set("classify:deliveries:"+verifyHash, string(raw))
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func verifyAs(c *harness.HTTP, body any, user string) *harness.Response {
	if user == "" {
		return c.Post("/v1/entities/deliveries/verify", body)
	}
	return c.Post("/v1/entities/deliveries/verify", body, "X-User-Id", user)
}

type verifyAnswer struct {
	Entity     string            \`json:"entity"\`
	Tier       int               \`json:"tier"\`
	Tags       map[string]string \`json:"tags"\`
	VerifiedBy string            \`json:"verified_by"\`
	Version    int               \`json:"version"\`
}

func verifyDecode(r *harness.Response) verifyAnswer {
	var answer verifyAnswer
	r.Decode(&answer)
	return answer
}

func CheckRoute(ctx *harness.Ctx) {
	c := verifyAPI(ctx)
	r := verifyAs(c, map[string]any{"action": "ack"}, verifyOwner)
	ctx.Equal(r.Status, 200, "the owner's ack (%s)", r.Text())
	answer := verifyDecode(r)
	ctx.Assert(answer.Entity == "deliveries" && answer.Version == 1, "the ack answered %s, expected the entity and version 1", r.Text())
	ctx.Equal(answer.Tags, verifyPending, "the ack must answer the pending tags")
	ctx.Equal(ctx.Redis.HGetAll("entity:deliveries")["version"], "1", "entity:deliveries version after the ack")
}

func CheckOwnerOnly(ctx *harness.Ctx) {
	c := verifyAPI(ctx)
	r := verifyAs(c, map[string]any{"action": "edit", "tags": map[string]string{"passport_no": "None"}}, "team-growth")
	ctx.Equal(r.Status, 403, "team-growth verifying team-logistics' table (only the owner verifies)")
	ctx.Equal(len(ctx.Redis.HGetAll("entity:deliveries")), 0, "a refused verification must store nothing; fields stored")
	r = verifyAs(c, map[string]any{"action": "ack"}, "")
	ctx.Equal(r.Status, 401, "a verification without X-User-Id")
	r = verifyAs(c, map[string]any{"action": "ack"}, verifyOwner)
	ctx.Equal(r.Status, 200, "the owner's own ack (%s)", r.Text())
}

func CheckTierServerSide(ctx *harness.Ctx) {
	c := verifyAPI(ctx)
	r := verifyAs(c, map[string]any{"action": "ack", "tier": 4}, verifyOwner)
	ctx.Equal(r.Status, 200, "the owner's ack (%s)", r.Text())
	ctx.Equal(verifyDecode(r).Tier, 2, "acknowledged tags with Personal.Contact_Info: the tier comes from the tags, not the body; tier")
	r = verifyAs(c, map[string]any{"action": "edit", "tags": map[string]string{"passport_no": "Personal.ID"}, "tier": 4}, verifyOwner)
	ctx.Equal(r.Status, 200, "the owner's edit (%s)", r.Text())
	ctx.Equal(verifyDecode(r).Tier, 1, "passport_no tagged Personal.ID with \\"tier\\": 4 in the body; tier")
	ctx.Equal(ctx.Redis.HGetAll("entity:deliveries")["tier"], "1", "the stored tier access control reads")
}

func CheckTagWhitelist(ctx *harness.Ctx) {
	c := verifyAPI(ctx)
	r := verifyAs(c, map[string]any{"action": "edit", "tags": map[string]string{"passport_no": "Public"}}, verifyOwner)
	ctx.Equal(r.Status, 400, "an edit with the tag Public (not in the tag library)")
	r = verifyAs(c, map[string]any{"action": "approve"}, verifyOwner)
	ctx.Equal(r.Status, 400, "the action approve (actions are ack and edit)")
	ctx.Equal(len(ctx.Redis.HGetAll("entity:deliveries")), 0, "refused verifications must store nothing; fields stored")
}

func CheckAudit(ctx *harness.Ctx) {
	c := verifyAPI(ctx)
	r := verifyAs(c, map[string]any{"action": "edit", "tags": map[string]string{"passport_no": "Personal.ID"}}, verifyOwner)
	ctx.Equal(r.Status, 200, "the owner's edit (%s)", r.Text())
	ctx.Equal(verifyDecode(r).VerifiedBy, verifyOwner, "the response's verified_by")
	var entries [][2]string
	for _, raw := range ctx.Redis.LRange("audit:deliveries", 0, -1) {
		var entry struct{ User, Action string }
		json.Unmarshal([]byte(raw), &entry)
		entries = append(entries, [2]string{entry.User, entry.Action})
	}
	ctx.Equal(entries, [][2]string{{verifyOwner, "edit"}}, "audit:deliveries must hold one entry for the owner's edit")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <utility>
#include <vector>

namespace {

const std::string kOwner = "team-logistics";
const std::map<std::string, std::string> kPending = {{"merchant_id", "None"}, {"passport_no", "None"}, {"customer_email", "Personal.Contact_Info"}};

harness::HTTP api(harness::Ctx& ctx) {
  ctx.Redis.Do("HSET", "verify:deliveries", "owner", kOwner, "schema_hash", "4f2a", "state", "pending");
  ctx.Redis.Set("classify:deliveries:4f2a", nlohmann::json(kPending).dump());
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response verify(harness::HTTP& c, const nlohmann::json& body, const std::string& user = kOwner) {
  if (user.empty()) return c.Post("/v1/entities/deliveries/verify", body.dump(), "Content-Type", "application/json");
  return c.Post("/v1/entities/deliveries/verify", body.dump(), "Content-Type", "application/json", "X-User-Id", user);
}

nlohmann::json answer(const harness::Response& r) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_object() ? j : nlohmann::json::object();
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = verify(c, {{"action", "ack"}});
  ctx.Equal(r.Status, 200, "the owner's ack (%s)", r.Text());
  const auto body = answer(r);
  ctx.Assert(body.value("entity", "") == "deliveries" && body.value("version", 0) == 1, "the ack answered %s, expected the entity and version 1", r.Text());
  ctx.Equal(body.contains("tags") ? body["tags"] : nlohmann::json(), nlohmann::json(kPending), "the ack must answer the pending tags");
  ctx.Equal(ctx.Redis.HGet("entity:deliveries", "version").value_or(""), "1", "entity:deliveries version after the ack");
}

void CheckOwnerOnly(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = verify(c, {{"action", "edit"}, {"tags", {{"passport_no", "None"}}}}, "team-growth");
  ctx.Equal(r.Status, 403, "team-growth verifying team-logistics' table (only the owner verifies)");
  ctx.Equal(ctx.Redis.HGetAll("entity:deliveries").size(), 0, "a refused verification must store nothing; fields stored");
  r = verify(c, {{"action", "ack"}}, "");
  ctx.Equal(r.Status, 401, "a verification without X-User-Id");
  r = verify(c, {{"action", "ack"}});
  ctx.Equal(r.Status, 200, "the owner's own ack (%s)", r.Text());
}

void CheckTierServerSide(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = verify(c, {{"action", "ack"}, {"tier", 4}});
  ctx.Equal(r.Status, 200, "the owner's ack (%s)", r.Text());
  ctx.Equal(answer(r).value("tier", 0), 2, "acknowledged tags with Personal.Contact_Info: the tier comes from the tags, not the body; tier");
  r = verify(c, {{"action", "edit"}, {"tags", {{"passport_no", "Personal.ID"}}}, {"tier", 4}});
  ctx.Equal(r.Status, 200, "the owner's edit (%s)", r.Text());
  ctx.Equal(answer(r).value("tier", 0), 1, "passport_no tagged Personal.ID with \\"tier\\": 4 in the body; tier");
  ctx.Equal(ctx.Redis.HGet("entity:deliveries", "tier").value_or(""), "1", "the stored tier access control reads");
}

void CheckTagWhitelist(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = verify(c, {{"action", "edit"}, {"tags", {{"passport_no", "Public"}}}});
  ctx.Equal(r.Status, 400, "an edit with the tag Public (not in the tag library)");
  r = verify(c, {{"action", "approve"}});
  ctx.Equal(r.Status, 400, "the action approve (actions are ack and edit)");
  ctx.Equal(ctx.Redis.HGetAll("entity:deliveries").size(), 0, "refused verifications must store nothing; fields stored");
}

void CheckAudit(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = verify(c, {{"action", "edit"}, {"tags", {{"passport_no", "Personal.ID"}}}});
  ctx.Equal(r.Status, 200, "the owner's edit (%s)", r.Text());
  ctx.Equal(answer(r).value("verified_by", ""), kOwner, "the response's verified_by");
  std::vector<std::pair<std::string, std::string>> entries;
  for (const auto& raw : ctx.Redis.LRange("audit:deliveries", 0, -1)) {
    const auto e = nlohmann::json::parse(raw, nullptr, false);
    entries.emplace_back(e.value("user", ""), e.value("action", ""));
  }
  ctx.Equal(entries, std::vector<std::pair<std::string, std::string>>{{kOwner, "edit"}}, "audit:deliveries must hold one entry for the owner's edit");
}
`,
  },
  hints: [
    'A producer on another team posts `{"action": "edit", "tags": {"passport_no": "Public"}, "tier": 4}` against a table they do not own, gets 200, and the table opens to the company with nobody named.',
    'The handler checks who is calling but not whether they own the entity, takes the tier as an input when access control treats it as a result, accepts any string as a tag or action, and writes no audit entry.',
    '403 when `pending["owner"] != user`; 400 unless `action in ("ack", "edit")` and every edited tag passes `taxonomy.known`; `tier = derive_tier(tags)` over `PRIVACY_RULES`; then `store.audit(entity_id, user, action)` and `verified_by` in the answer.',
  ],
  debrief: `The tier is what access control and masking read, so it is computed from the tags and the privacy office's rules, never taken from whoever calls; once that holds, the tags are the only input that matters, and the tag check and the owner check guard exactly that input. The audit entry is the record an incident review starts from: who confirmed which tags, and when. Grab feeds owner edits back into the evaluation set for the next prompt version, which this endpoint would do by keeping the model's tags beside the verified ones. A production version would also need a second approver for an edit that lowers the tier, and an owner that is a team with a directory lookup rather than one user id.`,
};
