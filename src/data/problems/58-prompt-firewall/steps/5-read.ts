import type {Step} from '@/lib/types';

export const ruleReadStep: Step = {
  id: 'read',
  title: 'GET /v1/firewall/rules: rule reads that reviewers can trust',
  concept: 'http',
  file: 'read',
  focus: ['rules', 'firewall', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the read endpoint: it
returns the rule set and the caller's custom rules. It compiles, it serves the reviewer's browser,
and it answers a different question than the one being asked. Review it, fix it, prove it.

Implement \`GET /v1/firewall/rules\`.

- The response is the **active** rule set: \`{"version", "status": "active", "rules", "custom",
  "changelog"}\`. The draft serves the mutable draft rule set with no version and no status, so a
  reviewer reading it cannot tell the set that produced yesterday's blocks from the one someone is
  editing right now.
- \`changelog\` is the history of the active version — who changed what, and when. Without it, the
  only answer to "why did this prompt start being blocked" is a diff in someone's terminal.
- **Custom rules are tenant-scoped.** The caller's tenant comes from \`X-Tenant-Id\` (**401** when
  missing) and only that tenant's custom rules are returned. The draft reads every tenant's custom
  rules with an unparameterised \`all()\`, which is one tenant's private rules in another tenant's
  review screen.
- Every decision names the **\`rule_version\`** that produced it. The draft's decision records carry
  the verdict and the matched ids but no version, so a block cannot be tied back to a rule set.

**Failure mode the checks target.** The read path is where trust is manufactured, so its bugs are
quiet: a reviewer who sees the wrong rule set as "the rules" approves a change against the wrong
baseline, and a decision without a version cannot be explained after the rule set moves on. The
tenant scope is the loud one — an unparameterised read of every tenant's custom rules is a cross-
tenant data path that happens to be triggered by a GET.`,
  sequence: {
    participants: ['Reviewer', 'Prompt Firewall', 'Rule store'],
    messages: [
      {from: 'Reviewer', to: 'Prompt Firewall', label: 'GET /v1/firewall/rules · X-Tenant-Id', kind: 'sync'},
      {
        from: 'Prompt Firewall',
        to: 'Rule store',
        label: 'active version · changelog · custom rules for the tenant',
        kind: 'sync',
      },
      {from: 'Rule store', to: 'Prompt Firewall', label: 'version, rule set, changelog', kind: 'reply'},
      {
        from: 'Prompt Firewall',
        to: 'Reviewer',
        label: '{version, status: "active", rules, custom, changelog}',
        kind: 'reply',
      },
      {from: 'Prompt Firewall', to: 'Prompt Firewall', label: 'stamp rule_version into every decision', kind: 'sync'},
      {from: 'Prompt Firewall', to: 'Reviewer', label: '401 when X-Tenant-Id is absent', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'active-served',
      title: 'Serves the active version, labelled active',
      detail:
        'The endpoint resolves `firewall:rules:active` and answers with that version and `status: "active"`. The draft serves the mutable draft set with no version and no status, so a reviewer cannot tell which set they are reading.',
      match: {
        python: {all: [/ACTIVE_KEY/, /"active"/]},
        typescript: {all: [/ACTIVE_KEY/, /'active'/]},
        go: {all: [/activeKey/, /"active"/]},
        scala: {all: [/ActiveKey/, /"active"/]},
        cpp: {all: [/kActiveKey/, /"active"/]},
      },
    },
    {
      id: 'changelog',
      title: 'Returns the changelog with the rule set',
      detail:
        'The response carries the changelog of the served version, so "why did this start being blocked" is answerable from the API. The draft returns rules and nothing else.',
      match: {
        python: {all: [/changelog/]},
        typescript: {all: [/changelog/]},
        go: {all: [/changelog/]},
        scala: {all: [/changelog/]},
        cpp: {all: [/changelog/]},
      },
    },
    {
      id: 'tenant-scoped',
      title: 'Custom rules are scoped to the caller’s tenant',
      detail:
        'Custom rules are read for the caller’s tenant only — the read passes the tenant. The draft calls an unparameterised `all()` and returns every tenant’s custom rules to whoever asks.',
      match: {
        python: {all: [/for_tenant\(tenant\)/], none: [/all_tenants/, /\.all\(\)/]},
        typescript: {all: [/customRulesFor\(tenant\)/], none: [/allTenants/, /\.all\(\)/]},
        go: {all: [/CustomRulesFor\(r\.Context\(\), tenant\)/], none: [/AllTenants/, /allTenants/]},
        scala: {all: [/forTenant\(tenant\)/], none: [/allTenants/, /all_tenants/]},
        cpp: {all: [/forTenant\(tenant\)/], none: [/allTenants/, /all_tenants/]},
      },
    },
    {
      id: 'decision-version',
      title: 'Every decision names the rule version',
      detail:
        'Decision records carry `rule_version` beside the verdict, so a block can be tied to the rule set that produced it. The draft records the verdict and the ids but no version.',
      match: {
        python: {all: [/rule_version/, /decision/]},
        typescript: {all: [/rule_version/, /decision/]},
        go: {all: [/rule_version/, /[Dd]ecision/]},
        scala: {all: [/rule_version/, /decision/]},
        cpp: {all: [/rule_version/, /decision/]},
      },
    },
    {
      id: 'tenant-required',
      title: 'Requires the tenant header',
      detail:
        'A missing `X-Tenant-Id` is **401**: without it there is no tenant to scope custom rules to, and defaulting to "all tenants" is exactly the draft’s bug. The draft accepts any caller.',
      match: {
        python: {all: [/status_code\s*=\s*401/]},
        typescript: {all: [/code\(\s*401\s*\)/]},
        go: {all: [/StatusUnauthorized/]},
        scala: {all: [/StatusCodes\.Unauthorized/]},
        cpp: {all: [/\b401\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("firewall-rules")

DRAFT_RULES = [
    {"id": "inj-ignore", "pattern": "ignore (all )?previous", "decision": "block"},
]


class CustomStore:
    def all(self) -> list[dict]:
        """Every tenant's custom rules, for the reviewer's convenience."""
        raise NotImplementedError


custom_store = CustomStore()


@app.get("/v1/firewall/rules")
def read_rules() -> JSONResponse:
    # TODO: the draft serves the mutable draft set as if it were active, omits the rule version from
    # decisions, and returns every tenant's custom rules. Serve the active version with its
    # changelog, stamp rule_version into decisions, scope custom rules to the caller's tenant, and
    # answer 401 when X-Tenant-Id is missing.
    return JSONResponse(
        {"rules": DRAFT_RULES, "custom": custom_store.all()},
        status_code=200,
    )
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("firewall-rules")

ACTIVE_KEY = "firewall:rules:active"


class RuleStore:
    def active_version(self) -> str:
        """The version the active pointer names."""
        raise NotImplementedError

    def load_version(self, version: str) -> list[dict]:
        """The complete rule set published as this version."""
        raise NotImplementedError

    def changelog(self, version: str) -> list[dict]:
        """Who changed what, and when, for this version."""
        raise NotImplementedError

    def custom_for_tenant(self, tenant: str) -> list[dict]:
        """Only the custom rules that belong to this tenant."""
        raise NotImplementedError


rules = RuleStore()


@app.get("/v1/firewall/rules")
def read_rules(tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    version = rules.active_version()
    logger.info("rules read tenant=%s version=%s", tenant, version)
    return JSONResponse(
        {
            "version": version,
            "status": "active",
            "rules": rules.load_version(version),
            "custom": rules.custom_for_tenant(tenant),
            "changelog": rules.changelog(version),
        },
        status_code=200,
    )


def decision_record(decision_id: str, version: str, verdict: dict) -> dict:
    """Every recorded decision names the rule version that produced it."""
    return {"decision_id": decision_id, "rule_version": version, **verdict}
`,
    },
    typescript: {
      starter: `/** A model-generated rule read endpoint that serves the mutable draft set. */
import Fastify from 'fastify';

export const app = Fastify();

const DRAFT_RULES = [
  {id: 'inj-ignore', pattern: 'ignore (all )?previous', decision: 'block'},
];

app.get('/v1/firewall/rules', async (request, reply) => {
  // TODO: the draft serves the mutable draft set as if it were active, omits the rule version from
  // decisions, and returns every tenant's custom rules. Serve the active version with its
  // changelog, stamp rule_version into decisions, scope custom rules to the caller's tenant, and
  // answer 401 when X-Tenant-Id is missing.
  return reply.code(200).send({rules: DRAFT_RULES, custom: customStore.all()});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/firewall/rules: the active set, its version and its changelog, scoped to the caller. */
import Fastify from 'fastify';

export const app = Fastify();

export const ACTIVE_KEY = 'firewall:rules:active';

export async function readRules(tenant: string) {
  const version = await rules.activeVersion();
  return {
    version,
    status: 'active',
    rules: await rules.loadVersion(version),
    custom: await customRulesFor(tenant),
    changelog: await rules.changelog(version),
  };
}

app.get('/v1/firewall/rules', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = await readRules(tenant);
  request.log.info({tenant, version: body.version}, 'rules read');
  return reply.code(200).send(body);
});

export function decisionRecord(decisionId: string, version: string, verdict: Verdict) {
  return {decision_id: decisionId, rule_version: version, ...verdict};
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"net/http"
)

type CustomStore struct{}

// All returns every tenant's custom rules, for the reviewer's convenience.
func (s *CustomStore) All(ctx context.Context) ([]Rule, error) {
	return nil, nil
}

var customStore = &CustomStore{}

var draftRules = []Rule{
	{ID: "inj-ignore", Pattern: "ignore (all )?previous", Decision: "block"},
}

type RuleReadResponse struct {
	Rules  []Rule \`json:"rules"\`
	Custom []Rule \`json:"custom"\`
}

// TODO: the draft serves the mutable draft set as if it were active, omits the rule version from
// decisions, and returns every tenant's custom rules. Serve the active version with its changelog,
// stamp rule_version into decisions, scope custom rules to the caller's tenant, and answer 401 when
// X-Tenant-Id is missing.
func readRules(rw http.ResponseWriter, r *http.Request) {
	custom, err := customStore.All(r.Context())
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, RuleReadResponse{Rules: draftRules, Custom: custom})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/firewall/rules", readRules)
	mux.HandleFunc("POST /v1/firewall/screen", screen)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"log"
	"net/http"
)

const activeKey = "firewall:rules:active"

type Change struct {
	Version string \`json:"version"\`
	Note    string \`json:"note"\`
	At      string \`json:"at"\`
}

type RuleReadResponse struct {
	Version   string   \`json:"version"\`
	Status    string   \`json:"status"\`
	Rules     []Rule   \`json:"rules"\`
	Custom    []Rule   \`json:"custom"\`
	Changelog []Change \`json:"changelog"\`
}

func readRules(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	version, err := store.ActiveVersion(r.Context(), activeKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	rules, err := store.LoadVersion(r.Context(), version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	custom, err := store.CustomRulesFor(r.Context(), tenant)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	changelog, err := store.Changelog(r.Context(), version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("rules read tenant=%s version=%s", tenant, version)
	writeJSON(rw, http.StatusOK, RuleReadResponse{
		Version:   version,
		Status:    "active",
		Rules:     rules,
		Custom:    custom,
		Changelog: changelog,
	})
}

func decisionRecord(id, version string, verdict Verdict) map[string]any {
	return map[string]any{
		"decision_id":  id,
		"rule_version": version,
		"decision":     verdict.Decision,
		"rules":        verdict.Rules,
		"spans":        verdict.Spans,
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/firewall/rules", readRules)
	mux.HandleFunc("POST /v1/firewall/screen", screen)
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

object RuleReads {
  implicit val system: ActorSystem = ActorSystem("prompt-firewall")

  val DraftRules: List[Rule] = List(Rule("inj-ignore", "ignore (all )?previous", "block"))

  val route: Route =
    path("v1" / "firewall" / "rules") {
      get {
        // TODO: the draft serves the mutable draft set as if it were active, omits the rule version
        // from decisions, and returns every tenant's custom rules. Serve the active version with
        // its changelog, stamp rule_version into decisions, scope custom rules to the caller's
        // tenant, and answer 401 when X-Tenant-Id is missing.
        val rules = DraftRules.map(rule => s"""{"id":"\${rule.id}","decision":"\${rule.decision}"}""").mkString(",")
        val custom = customStore.all().mkString(",")
        complete(StatusCodes.OK, s"""{"rules":[$rules],"custom":[$custom]}""")
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
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Change(version: String, note: String, at: String)
final case class RuleRead(version: String, status: String, rules: List[Rule], custom: List[Rule], changelog: List[Change])

object RuleReads {
  implicit val system: ActorSystem = ActorSystem("prompt-firewall")
  implicit val changeFormat: RootJsonFormat[Change] = jsonFormat3(Change)
  implicit val readFormat: RootJsonFormat[RuleRead] = jsonFormat5(RuleRead)

  val ActiveKey = "firewall:rules:active"

  def decisionRecord(decisionId: String, version: String, verdict: Verdict): Map[String, Any] =
    Map(
      "decision_id" -> decisionId,
      "rule_version" -> version,
      "decision" -> verdict.decision,
      "rules" -> verdict.rules,
    )

  val route: Route =
    path("v1" / "firewall" / "rules") {
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None => complete(StatusCodes.Unauthorized, "missing X-Tenant-Id")
          case Some(tenant) =>
            val version = store.activeVersion(ActiveKey)
            val read = RuleRead(
              version,
              "active",
              store.loadVersion(version),
              store.forTenant(tenant),
              store.changelog(version),
            )
            system.log.info(s"rules read tenant=$tenant version=$version")
            complete(StatusCodes.OK, read)
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

#include <string>
#include <vector>

using json = nlohmann::json;

const std::vector<Rule> kDraftRules = {
    {"inj-ignore", "ignore (all )?previous", "block"},
};

// TODO: the draft serves the mutable draft set as if it were active, omits the rule version from
// decisions, and returns every tenant's custom rules. Serve the active version with its changelog,
// stamp rule_version into decisions, scope custom rules to the caller's tenant, and answer 401 when
// X-Tenant-Id is missing.
json readRules() {
  return json{{"rules", kDraftRules}, {"custom", customStore.all()}};
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/firewall/rules", [](const httplib::Request& req, httplib::Response& res) {
    res.status = 200;
    res.set_content(readRules().dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kActiveKey = "firewall:rules:active";

// The active set, its version, its changelog, and only the caller's custom rules.
json readRules(const std::string& tenant) {
  const auto version = store.activeVersion(kActiveKey);
  return json{
      {"version", version},
      {"status", "active"},
      {"rules", store.loadVersion(version)},
      {"custom", store.forTenant(tenant)},
      {"changelog", store.changelog(version)},
  };
}

json decision_record(const std::string& decision_id, const std::string& version, const json& verdict) {
  json record = verdict;
  record["decision_id"] = decision_id;
  record["rule_version"] = version;
  return record;
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/firewall/rules", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(readRules(tenant).dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A rule read has to answer "which rules were in force" before it answers "what are the rules". Resolve the active pointer, return its version and its changelog, and label the status from that pointer rather than from whatever is in memory.',
    'Scope at the query, not at the response: take `tenant` from `X-Tenant-Id` (401 when absent) and pass it into the custom-rules read. A read that fetches everything and filters afterwards is one refactor away from leaking, and the unparameterised `all()` is already the leak.',
    'Stamp `rule_version` into the decision record at the moment of the decision. A block without a version is unexplainable once the active set moves on — and the version is the join key that lets the audit read in this step explain the events published in step 4.',
  ],
  debrief: `The interviewer is testing the read path, which is where trust in a rules system is actually manufactured. Three defects: the draft serves the draft set (so a reviewer approves a change against a baseline nobody is running), it omits the version (so no block can be explained after the fact), and it reads every tenant's custom rules (so a GET crosses a tenant boundary). The first two are provenance bugs and the third is an isolation bug, and they share a root cause: the endpoint was written to show the rules rather than to testify to a version. Real systems add signed rule-set snapshots, a diff endpoint between two versions, and an approval record that names the version a reviewer signed off and the eval score it carried.`,
};
