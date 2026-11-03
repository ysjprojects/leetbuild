import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/users/{id}: profiles scoped to their owner',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'db', 'support'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/users/{id}\`, the read behind the profile page and
the support console: it requires \`X-User-Id\`, loads the account, answers **404** for an unknown id
and returns one profile payload to every authenticated caller. It serves the demo (one user viewing
their own profile) and hides 4 flaws.

**Failure mode the checks target.** One payload for every viewer hands contact data to anyone with
a token. A support read without an audit record is indistinguishable from exfiltration, and a
projection without the verification state lets the platform treat an unverified account as verified.

- \`X-User-Id\` is required (**401**); \`X-Role\` defaults to \`member\`; an unknown id is **404**.
- The owner (\`is_owner(caller_id, user_id)\`) gets \`owner_view(account)\`.
- Everyone else gets \`public_projection(account)\` from \`PUBLIC_FIELDS\` (\`user_id\`, \`handle\`,
  \`created_at\`): no email, phone or name.
- Both payloads carry \`verification_state(account)\`, normalised against \`VERIFICATION_STATES\`
  (\`pending\`, \`verified\`, \`suppressed\`), default \`pending\`.
- A caller in \`SUPPORT_ROLES\` reads only through \`audit_lookup(caller_id, user_id, reason)\`, which
  writes the lookup before the record is returned; \`X-Support-Reason\` is required (**400**).`,
  sequence: {
    participants: ['Member', 'Support agent', 'identityd', 'accounts', 'audit log'],
    messages: [
      {from: 'Member', to: 'identityd', label: 'GET /v1/users/usr_42 · X-User-Id: usr_42', kind: 'sync'},
      {from: 'identityd', to: 'accounts', label: 'get(usr_42)', kind: 'sync'},
      {from: 'accounts', to: 'identityd', label: 'the stored row', kind: 'reply'},
      {from: 'identityd', to: 'identityd', label: 'is_owner(caller, id) → owner_view(account)', kind: 'sync'},
      {from: 'identityd', to: 'Member', label: '200 {view: "owner", user: {…, verification_state}}', kind: 'reply'},
      {from: 'Support agent', to: 'identityd', label: 'GET /v1/users/usr_42 · X-Role: support · reason', kind: 'sync'},
      {from: 'identityd', to: 'audit log', label: 'audit_lookup(agent, usr_42, reason)', kind: 'sync'},
      {
        from: 'identityd',
        to: 'Support agent',
        label: '200 {view: "support", user: owner_view(account)}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    "Any member with a token can fetch another member's email and phone, an unverified account looks identical to a verified one, and nobody can say which support agent looked at whose record.",
    'One `profilePayload` serves every caller, it is built from the row rather than an allowlist, no field reports verification, and there is no support branch or audit write.',
    'Branch on `is_owner(caller_id, user_id)` to `owner_view`; build `public_projection` from `PUBLIC_FIELDS`; add `verification_state(account)` to both; gate `SUPPORT_ROLES` on `X-Support-Reason` and `audit_lookup` before returning.',
  ],
  checks: [
    {
      id: 'read-route',
      title: 'Registers GET /v1/users/{id}',
      detail:
        'The profile read exists on `GET /v1/users/{id}` and its response carries the projection the console renders. The starter already answers this route, so this check passes on it; the four below are where it fails.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/users\/\{user_id\}["']/, /"user"/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/users\/:userId['"]/, /user:/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/users\/\{id\}"/, /"user"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"users"\s*\/\s*Segment\s*\)/, /\bget\s*\{/, /"user"/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/users\//, /"user"/]},
      },
    },
    {
      id: 'owner-scope',
      title: 'Returns the full record only to its owner',
      detail:
        'The caller id is compared to the path id in `is_owner(caller_id, user_id)` and the owner’s copy comes from `owner_view(account)`; every other caller gets `public_projection(account)`. The starter answers the same payload for both, so the owner’s contact data goes to anyone with a token.',
      match: {
        python: {all: [/def is_owner\(/, /caller_id\s*==\s*user_id/, /owner_view\(/]},
        typescript: {all: [/function isOwner\(/, /callerId\s*===\s*userId/, /ownerView\(/]},
        go: {all: [/func isOwner\(/, /callerID\s*==\s*userID/, /ownerView\(/]},
        scala: {all: [/def isOwner\(/, /callerId\s*==\s*userId/, /ownerView\(/]},
        cpp: {all: [/isOwner\(/, /caller_id\s*==\s*user_id/, /ownerView\(/]},
      },
    },
    {
      id: 'public-projection',
      title: 'The public projection carries no contact data',
      detail:
        'The public view is built by `public_projection(account)` from the allowlist `PUBLIC_FIELDS`, so no email, phone or name key can appear in it. The starter ships the owner’s contact data in the projection every caller receives.',
      match: {
        python: {
          all: [/def public_projection\(/, /PUBLIC_FIELDS/],
          none: [/["']email["']/, /["']phone["']/, /["']name["']/],
        },
        typescript: {
          all: [/function publicProjection\(/, /PUBLIC_FIELDS/],
          none: [/['"]email['"]/, /['"]phone['"]/, /['"]name['"]/],
        },
        go: {
          all: [/func publicProjection\(/, /publicFields/],
          none: [/["']email["']/, /["']phone["']/, /["']name["']/],
        },
        scala: {
          all: [/def publicProjection\(/, /PublicFields/],
          none: [/["']email["']/, /["']phone["']/, /["']name["']/],
        },
        cpp: {all: [/publicProjection\(/, /kPublicFields/], none: [/["']email["']/, /["']phone["']/, /["']name["']/]},
      },
    },
    {
      id: 'verification-state',
      title: 'Every projection carries the verification state',
      detail:
        '`verification_state(account)` normalises the stored value against `VERIFICATION_STATES`, and both `owner_view` and `public_projection` add it, so an unverified account never reads as complete. The starter omits it entirely.',
      match: {
        python: {all: [/def verification_state\(/, /VERIFICATION_STATES/, /"verification_state"/]},
        typescript: {all: [/function verificationState\(/, /VERIFICATION_STATES/, /verification_state/]},
        go: {all: [/func verificationState\(/, /verificationStates/, /"verification_state"/]},
        scala: {all: [/def verificationState\(/, /VerificationStates/, /"verification_state"/]},
        cpp: {all: [/verificationState\(/, /kVerificationStates/, /"verification_state"/]},
      },
    },
    {
      id: 'support-audit',
      title: 'Support reads go through an audited tool',
      detail:
        'A caller whose `X-Role` is in `SUPPORT_ROLES` reaches the record only through `audit_lookup(caller_id, user_id, reason)`, which writes the lookup **before** the record is returned; `X-Support-Reason` is required. The starter has no support path and no audit at all.',
      match: {
        python: {
          all: [/SUPPORT_ROLES/, /def audit_lookup\(/, /X-Role/, /audit_lookup\(caller_id/],
          order: [/if role in SUPPORT_ROLES/, /audit_lookup\(caller_id/],
        },
        typescript: {
          all: [/SUPPORT_ROLES/, /function auditLookup\(/, /x-role/, /auditLookup\(callerId/],
          order: [/SUPPORT_ROLES\.includes\(role\)/, /auditLookup\(callerId/],
        },
        go: {
          all: [/supportRoles/, /func auditLookup\(/, /X-Role/, /auditLookup\(r\.Context/],
          order: [/slices\.Contains\(supportRoles, role\)/, /auditLookup\(r\.Context/],
        },
        scala: {
          all: [/SupportRoles/, /def auditLookup\(/, /X-Role/, /auditLookup\(callerId/],
          order: [/SupportRoles\.contains\(role\)/, /auditLookup\(callerId/],
        },
        cpp: {
          all: [/kSupportRoles/, /void auditLookup\(/, /X-Role/, /kSupportRoles\.count\(role\)/],
          order: [/kSupportRoles\.count\(role\)/, /auditLookup\(caller_id/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

PROFILE_FIELDS = ("user_id", "email", "phone", "name", "created_at")


class AccountStore:
    def get_user(self, user_id: str) -> dict | None:
        """The stored account row for the id, or None."""
        raise NotImplementedError


store = AccountStore()


def profile_payload(account: dict) -> dict:
    """The profile payload the console renders."""
    return {key: account.get(key) for key in PROFILE_FIELDS}


@app.get("/v1/users/{user_id}")
def read_user(user_id: str, caller_id: str = Header(default="", alias="X-User-Id")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if not caller_id:
        raise HTTPException(status_code=401, detail="missing X-User-Id")
    account = store.get_user(user_id)
    if account is None:
        raise HTTPException(status_code=404, detail="no such user")
    return JSONResponse({"user": profile_payload(account)}, status_code=200)
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

PUBLIC_FIELDS = ("user_id", "handle", "created_at")
VERIFICATION_STATES = ("pending", "verified", "suppressed")
SUPPORT_ROLES = ("support", "support_admin")


class AccountStore:
    def get_user(self, user_id: str) -> dict | None:
        """The stored account row for the id, or None."""
        raise NotImplementedError


class AuditLog:
    def write(self, record: dict) -> None:
        """Append one lookup record to the audit trail."""
        raise NotImplementedError


store = AccountStore()
audit = AuditLog()


def verification_state(account: dict) -> str:
    """The state to report: the stored value when it is known, else pending."""
    state = account.get("verification_state")
    return state if state in VERIFICATION_STATES else "pending"


def owner_view(account: dict) -> dict:
    """The owner's own record: every stored field, plus the verification state."""
    return {**account, "verification_state": verification_state(account)}


def public_projection(account: dict) -> dict:
    """The public view: allowlisted fields only, never contact data."""
    view = {key: account.get(key) for key in PUBLIC_FIELDS}
    view["verification_state"] = verification_state(account)
    return view


def audit_lookup(actor: str, user_id: str, reason: str) -> None:
    """Write the lookup before the record leaves the service."""
    audit.write({"actor": actor, "user_id": user_id, "reason": reason})


def is_owner(caller_id: str, user_id: str) -> bool:
    """True when the authenticated caller is the profile's owner."""
    return caller_id == user_id


@app.get("/v1/users/{user_id}")
def read_user(
    user_id: str,
    caller_id: str = Header(default="", alias="X-User-Id"),
    role: str = Header(default="member", alias="X-Role"),
    reason: str = Header(default="", alias="X-Support-Reason"),
) -> JSONResponse:
    if not caller_id:
        raise HTTPException(status_code=401, detail="missing X-User-Id")
    account = store.get_user(user_id)
    if account is None:
        raise HTTPException(status_code=404, detail="no such user")
    if is_owner(caller_id, user_id):
        return JSONResponse({"view": "owner", "user": owner_view(account)}, status_code=200)
    if role in SUPPORT_ROLES:
        if not reason:
            raise HTTPException(status_code=400, detail="support lookups need a reason")
        audit_lookup(caller_id, user_id, reason)
        return JSONResponse({"view": "support", "user": owner_view(account)}, status_code=200)
    return JSONResponse({"view": "public", "user": public_projection(account)}, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/users/:userId. */
import Fastify from 'fastify';

import {store} from './account_store';

export const app = Fastify();

const PROFILE_FIELDS = ['user_id', 'email', 'phone', 'name', 'created_at'];

function profilePayload(account: Record<string, unknown>): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const key of PROFILE_FIELDS) view[key] = account[key];
  return view;
}

app.get('/v1/users/:userId', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {userId} = request.params as {userId: string};
  const callerId = (request.headers['x-user-id'] as string | undefined) ?? '';
  if (callerId === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const account = await store.getUser(userId);
  if (account === null) return reply.code(404).send({error: 'no such user'});
  return reply.code(200).send({user: profilePayload(account)});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/users/:userId: the owner's full record, a minimal projection for everyone else. */
import Fastify from 'fastify';

import {audit, store} from './account_store';

export const app = Fastify();

const PUBLIC_FIELDS = ['user_id', 'handle', 'created_at'];
const VERIFICATION_STATES = ['pending', 'verified', 'suppressed'];
const SUPPORT_ROLES = ['support', 'support_admin'];

function verificationState(account: Record<string, unknown>): string {
  const state = account['verification_state'];
  return typeof state === 'string' && VERIFICATION_STATES.includes(state) ? state : 'pending';
}

function ownerView(account: Record<string, unknown>): Record<string, unknown> {
  return {...account, verification_state: verificationState(account)};
}

function publicProjection(account: Record<string, unknown>): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const key of PUBLIC_FIELDS) view[key] = account[key];
  view['verification_state'] = verificationState(account);
  return view;
}

function isOwner(callerId: string, userId: string): boolean {
  return callerId === userId;
}

async function auditLookup(actor: string, userId: string, reason: string): Promise<void> {
  await audit.write({actor, user_id: userId, reason});
}

app.get('/v1/users/:userId', async (request, reply) => {
  const {userId} = request.params as {userId: string};
  const callerId = (request.headers['x-user-id'] as string | undefined) ?? '';
  const role = (request.headers['x-role'] as string | undefined) ?? 'member';
  const reason = (request.headers['x-support-reason'] as string | undefined) ?? '';
  if (callerId === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const account = await store.getUser(userId);
  if (account === null) return reply.code(404).send({error: 'no such user'});
  if (isOwner(callerId, userId)) return reply.code(200).send({view: 'owner', user: ownerView(account)});
  if (SUPPORT_ROLES.includes(role)) {
    if (reason === '') return reply.code(400).send({error: 'support lookups need a reason'});
    await auditLookup(callerId, userId, reason);
    return reply.code(200).send({view: 'support', user: ownerView(account)});
  }
  return reply.code(200).send({view: 'public', user: publicProjection(account)});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `// GET /v1/users/{id}.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

var profileFields = []string{"user_id", "email", "phone", "name", "created_at"}

type AccountStore interface {
	Get(ctx context.Context, userID string) (map[string]any, error)
}

var store AccountStore

func profilePayload(account map[string]any) map[string]any {
	view := make(map[string]any, len(profileFields))
	for _, key := range profileFields {
		view[key] = account[key]
	}
	return view
}

func readUser(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	userID := r.PathValue("id")
	callerID := r.Header.Get("X-User-Id")
	if callerID == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]any{"error": "missing X-User-Id"})
		return
	}
	account, err := store.Get(r.Context(), userID)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]any{"error": "no such user"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"user": profilePayload(account)})
}

func writeJSON(rw http.ResponseWriter, status int, payload any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(payload)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/users/{id}", readUser)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `// GET /v1/users/{id}: the owner's full record, a minimal projection for everyone else.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"slices"
)

var publicFields = []string{"user_id", "handle", "created_at"}

var verificationStates = []string{"pending", "verified", "suppressed"}

var supportRoles = []string{"support", "support_admin"}

type AccountStore interface {
	Get(ctx context.Context, userID string) (map[string]any, error)
}

type AuditLog interface {
	Write(ctx context.Context, record map[string]any) error
}

var (
	store AccountStore
	audit AuditLog
)

func verificationState(account map[string]any) string {
	state, _ := account["verification_state"].(string)
	if slices.Contains(verificationStates, state) {
		return state
	}
	return "pending"
}

func ownerView(account map[string]any) map[string]any {
	view := make(map[string]any, len(account)+1)
	for key, value := range account {
		view[key] = value
	}
	view["verification_state"] = verificationState(account)
	return view
}

func publicProjection(account map[string]any) map[string]any {
	view := make(map[string]any, len(publicFields)+1)
	for _, key := range publicFields {
		if value, ok := account[key]; ok {
			view[key] = value
		}
	}
	view["verification_state"] = verificationState(account)
	return view
}

func isOwner(callerID, userID string) bool {
	return callerID == userID
}

func auditLookup(ctx context.Context, actor, userID, reason string) error {
	return audit.Write(ctx, map[string]any{"actor": actor, "user_id": userID, "reason": reason})
}

func readUser(rw http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	callerID := r.Header.Get("X-User-Id")
	role := r.Header.Get("X-Role")
	reason := r.Header.Get("X-Support-Reason")
	if callerID == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]any{"error": "missing X-User-Id"})
		return
	}
	if role == "" {
		role = "member"
	}
	account, err := store.Get(r.Context(), userID)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]any{"error": "no such user"})
		return
	}
	if isOwner(callerID, userID) {
		writeJSON(rw, http.StatusOK, map[string]any{"view": "owner", "user": ownerView(account)})
		return
	}
	if slices.Contains(supportRoles, role) {
		if reason == "" {
			writeJSON(rw, http.StatusBadRequest, map[string]any{"error": "support lookups need a reason"})
			return
		}
		if err := auditLookup(r.Context(), callerID, userID, reason); err != nil {
			writeJSON(rw, http.StatusInternalServerError, map[string]any{"error": "audit unavailable"})
			return
		}
		writeJSON(rw, http.StatusOK, map[string]any{"view": "support", "user": ownerView(account)})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"view": "public", "user": publicProjection(account)})
}

func writeJSON(rw http.ResponseWriter, status int, payload any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(payload)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/users/{id}", readUser)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object UserReadApi {
  implicit val system: ActorSystem = ActorSystem("identityd")

  val ProfileFields: Vector[String] = Vector("user_id", "email", "phone", "name", "created_at")

  trait AccountStore {
    def get(userId: String): Option[JsObject]
  }

  val store: AccountStore = AccountStore.open()

  def profilePayload(account: JsObject): JsObject =
    JsObject(ProfileFields.flatMap(key => account.fields.get(key).map(key -> _)).toMap)

  val route: Route =
    path("v1" / "users" / Segment) { userId =>
      get {
        headerValueByName("X-User-Id") { _ =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          store.get(userId) match {
            case Some(account) => complete(StatusCodes.OK, JsObject("user" -> profilePayload(account)))
            case None          => complete(StatusCodes.NotFound, """{"error":"no such user"}""")
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
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object UserReadApi {
  implicit val system: ActorSystem = ActorSystem("identityd")

  val PublicFields: Vector[String] = Vector("user_id", "handle", "created_at")
  val VerificationStates: Set[String] = Set("pending", "verified", "suppressed")
  val SupportRoles: Set[String] = Set("support", "support_admin")

  trait AccountStore {
    def get(userId: String): Option[JsObject]
  }

  trait AuditLog {
    def write(record: JsObject): Unit
  }

  val store: AccountStore = AccountStore.open()
  val audit: AuditLog = AuditLog.open()

  def verificationState(account: JsObject): String =
    account.fields.get("verification_state") match {
      case Some(JsString(state)) if VerificationStates.contains(state) => state
      case _                                                           => "pending"
    }

  def ownerView(account: JsObject): JsObject =
    JsObject(account.fields + ("verification_state" -> JsString(verificationState(account))))

  def publicProjection(account: JsObject): JsObject =
    JsObject(
      PublicFields.flatMap(key => account.fields.get(key).map(key -> _)).toMap
        + ("verification_state" -> JsString(verificationState(account)))
    )

  def isOwner(callerId: String, userId: String): Boolean = callerId == userId

  def auditLookup(actor: String, userId: String, reason: String): Unit =
    audit.write(JsObject("actor" -> JsString(actor), "user_id" -> JsString(userId), "reason" -> JsString(reason)))

  val route: Route =
    path("v1" / "users" / Segment) { userId =>
      get {
        headerValueByName("X-User-Id") { callerId =>
          optionalHeaderValueByName("X-Role") { roleHeader =>
            optionalHeaderValueByName("X-Support-Reason") { reasonHeader =>
              val role = roleHeader.getOrElse("member")
              store.get(userId) match {
                case None =>
                  complete(StatusCodes.NotFound, """{"error":"no such user"}""")
                case Some(account) if isOwner(callerId, userId) =>
                  complete(StatusCodes.OK, JsObject("view" -> JsString("owner"), "user" -> ownerView(account)))
                case Some(account) if SupportRoles.contains(role) =>
                  reasonHeader match {
                    case Some(reason) if reason.nonEmpty =>
                      auditLookup(callerId, userId, reason)
                      complete(StatusCodes.OK, JsObject("view" -> JsString("support"), "user" -> ownerView(account)))
                    case _ =>
                      complete(StatusCodes.BadRequest, """{"error":"support lookups need a reason"}""")
                  }
                case Some(account) =>
                  complete(StatusCodes.OK, JsObject("view" -> JsString("public"), "user" -> publicProjection(account)))
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

#include <string>
#include <vector>

using json = nlohmann::json;

const std::vector<std::string> kProfileFields = {"user_id", "email", "phone", "name", "created_at"};

struct AccountStore {
  json get(const std::string& user_id);
};

AccountStore store;

json profilePayload(const json& account) {
  json view = json::object();
  for (const auto& key : kProfileFields) {
    if (account.contains(key)) view[key] = account.at(key);
  }
  return view;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/users/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const auto user_id = req.matches[1].str();
    const auto caller_id = req.get_header_value("X-User-Id");
    if (caller_id.empty()) {
      res.status = 401;
      res.set_content("{\\"error\\":\\"missing X-User-Id\\"}", "application/json");
      return;
    }
    const auto account = store.get(user_id);
    if (account.is_null()) {
      res.status = 404;
      res.set_content("{\\"error\\":\\"no such user\\"}", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"user", profilePayload(account)}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::vector<std::string> kPublicFields = {"user_id", "handle", "created_at"};
const std::set<std::string> kVerificationStates = {"pending", "verified", "suppressed"};
const std::set<std::string> kSupportRoles = {"support", "support_admin"};

struct AccountStore {
  json get(const std::string& user_id);
};

struct AuditLog {
  void write(const json& record);
};

AccountStore store;
AuditLog audit;

std::string verificationState(const json& account) {
  const auto state = account.value("verification_state", std::string("pending"));
  return kVerificationStates.count(state) > 0 ? state : "pending";
}

json ownerView(const json& account) {
  json view = account;
  view["verification_state"] = verificationState(account);
  return view;
}

json publicProjection(const json& account) {
  json view = json::object();
  for (const auto& key : kPublicFields) {
    if (account.contains(key)) view[key] = account.at(key);
  }
  view["verification_state"] = verificationState(account);
  return view;
}

bool isOwner(const std::string& caller_id, const std::string& user_id) {
  return caller_id == user_id;
}

void auditLookup(const std::string& actor, const std::string& user_id, const std::string& reason) {
  audit.write(json{{"actor", actor}, {"user_id", user_id}, {"reason", reason}});
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/users/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto user_id = req.matches[1].str();
    const auto caller_id = req.get_header_value("X-User-Id");
    const auto role = req.get_header_value("X-Role");
    const auto reason = req.get_header_value("X-Support-Reason");
    if (caller_id.empty()) {
      res.status = 401;
      res.set_content("{\\"error\\":\\"missing X-User-Id\\"}", "application/json");
      return;
    }
    const auto account = store.get(user_id);
    if (account.is_null()) {
      res.status = 404;
      res.set_content("{\\"error\\":\\"no such user\\"}", "application/json");
      return;
    }
    if (isOwner(caller_id, user_id)) {
      res.status = 200;
      res.set_content(json{{"view", "owner"}, {"user", ownerView(account)}}.dump(), "application/json");
      return;
    }
    if (kSupportRoles.count(role) > 0) {
      if (reason.empty()) {
        res.status = 400;
        res.set_content("{\\"error\\":\\"support lookups need a reason\\"}", "application/json");
        return;
      }
      auditLookup(caller_id, user_id, reason);
      res.status = 200;
      res.set_content(json{{"view", "support"}, {"user", ownerView(account)}}.dump(), "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"view", "public"}, {"user", publicProjection(account)}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The fix has the shape of a disclosure decision rather than a lookup. \`is_owner(caller_id, user_id)\` decides the one caller who may see the stored row; everyone else gets \`public_projection\`, built from the \`PUBLIC_FIELDS\` allowlist, because a projection built by subtraction grows a field the day someone adds one to the row. \`verification_state\` goes into both payloads because the rest of the platform keys its decisions on it. The support branch writes \`audit_lookup\` *before* the record leaves the service, so every support read is attributable.

Production systems add field-level access rules keyed to scopes, per-viewer rate limits so enumeration is visible, and audit records in an append-only store with the request id.`,
};
