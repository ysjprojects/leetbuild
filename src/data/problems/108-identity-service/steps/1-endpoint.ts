import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/users: one person, one account',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/users\` with body \`{email, phone, name}\`: it trims
the email and the phone, takes a fresh id from \`accounts.new_user_id\`, claims both handles with
\`claim_handles\` (step 2, provided as \`identityd.handles\`), writes the row with
\`accounts.create_account\` and answers **201** \`{user_id, status: "unverified"}\`. A refused claim
answers **409** naming the address and the account that holds it. It serves the demo and hides
three flaws.

**Failure mode the checks target.** \`Ada.Lovelace+news@Gmail.com\` and \`adalovelace@gmail.com\`
become two accounts, as do \`+44 20 7946 0958\` and \`0044-20-7946-0958\`; a client that times out
and retries is told its own address is taken; and a stranger who posts an address learns which
account owns it.

- \`normalize_email\` lowercases; for a domain in \`FOLD_ALIAS_DOMAINS\` (\`gmail.com\`,
  \`googlemail.com\`) it also drops the dots and the \`+tag\` of the local part. \`normalize_phone\`
  drops spaces, dashes, dots and parentheses, reads a leading \`00\` as \`+\` and requires \`+\` and 8
  to 15 digits. Claims and the row use the canonical forms; a malformed one is **422**.
- \`Idempotency-Key\` is required (**400**). \`accounts.signup_result(key)\` is read before any claim
  and answered as is when recorded; a new account is recorded with \`accounts.record_signup\`.
- Every refused claim answers **409** with \`SIGNUP_CONFLICT\`, \`{"error": "signup_conflict"}\`.`,
  sequence: {
    participants: ['Client', 'identityd', 'Redis claims', 'accounts store'],
    messages: [
      {from: 'Client', to: 'identityd', label: 'POST /v1/users · Idempotency-Key · {email, phone, name}', kind: 'sync'},
      {from: 'identityd', to: 'accounts store', label: 'signup_result(key) → recorded / none', kind: 'sync'},
      {from: 'identityd', to: 'identityd', label: 'normalize_email · normalize_phone · 422', kind: 'sync'},
      {from: 'identityd', to: 'Redis claims', label: 'claim_handles(user_id, {email, phone})', kind: 'sync'},
      {from: 'Redis claims', to: 'identityd', label: 'refused → 409 signup_conflict', kind: 'reply'},
      {from: 'identityd', to: 'accounts store', label: 'create_account · record_signup(key, result)', kind: 'sync'},
      {from: 'identityd', to: 'Client', label: '201 {user_id, status: "unverified"}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/users',
      detail: 'Register `POST /v1/users`; a new signup answers **201** with the `user_id` and `status: "unverified"`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/users["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/users['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/users"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"users"\s*\)/, /\bpost\b/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/users"/]},
      },
    },
    {
      id: 'canonical-handles',
      title: 'Claims the canonical email and phone',
      detail:
        '`normalize_email`/`normalizeEmail` lowercases and, for `FOLD_ALIAS_DOMAINS`, drops the dots and the `+tag`; `normalize_phone`/`normalizePhone` produces E.164 or rejects the number (**422**); both run before the claim, which takes the canonical forms. The starter claims the trimmed strings the client sent.',
      match: {
        python: {
          all: [/def normalize_email\(/, /def normalize_phone\(/, /FOLD_ALIAS_DOMAINS/, /\b422\b/],
          order: [/=\s*normalize_email\(/, /claim_handles\(/],
        },
        typescript: {
          all: [/function normalizeEmail\(/, /function normalizePhone\(/, /FOLD_ALIAS_DOMAINS/, /\b422\b/],
          order: [/=\s*normalizeEmail\(/, /claimHandles\(/],
        },
        go: {
          all: [
            /func normalizeEmail\(/,
            /func normalizePhone\(/,
            /foldAliasDomains/,
            /StatusUnprocessableEntity|\b422\b/,
          ],
          order: [/=\s*normalizeEmail\(/, /handles\.ClaimHandles\(/],
        },
        scala: {
          all: [/def normalizeEmail\(/, /def normalizePhone\(/, /FoldAliasDomains/, /UnprocessableEntity|\b422\b/],
          order: [/normalizeEmail\(field/, /Handles\.claimHandles\(/],
        },
        cpp: {
          all: [
            /normalizeEmail\(const std::string&/,
            /normalizePhone\(const std::string&/,
            /kFoldAliasDomains/,
            /\b422\b/,
          ],
          order: [/=\s*normalizeEmail\(/, /handles::claimHandles\(/],
        },
      },
    },
    {
      id: 'idempotency-key',
      title: 'A retried signup answers the first attempt',
      detail:
        '`Idempotency-Key` is required (**400**); the recorded result (`signup_result`/`signupResult`) is read before any claim and answered on a retry, and a new account records its result. The starter ignores the header, so the retry finds its own claims and answers 409.',
      match: {
        python: {
          all: [/idempotency-key/i, /accounts\.record_signup\(/, /\b400\b/],
          order: [/accounts\.signup_result\(/, /claim_handles\(/, /accounts\.record_signup\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /recordSignup\(/, /\b400\b/],
          order: [/signupResult\(/, /claimHandles\(/, /recordSignup\(/],
        },
        go: {
          all: [/Idempotency-Key/, /accounts\.RecordSignup\(/, /StatusBadRequest|\b400\b/],
          order: [/accounts\.SignupResult\(/, /handles\.ClaimHandles\(/, /accounts\.RecordSignup\(/],
        },
        scala: {
          all: [/Idempotency-Key/, /Accounts\.recordSignup\(/, /BadRequest|\b400\b/],
          order: [/Accounts\.signupResult\(/, /Handles\.claimHandles\(/, /Accounts\.recordSignup\(/],
        },
        cpp: {
          all: [/Idempotency-Key/, /accounts::recordSignup\(/, /\b400\b/],
          order: [/accounts::signupResult\(/, /handles::claimHandles\(/, /accounts::recordSignup\(/],
        },
      },
    },
    {
      id: 'neutral-conflict',
      title: 'One neutral 409 for every collision',
      detail:
        'A refused claim answers **409** with `SIGNUP_CONFLICT` (`{"error": "signup_conflict"}`) whichever handle collided; the body names no address, no field and no account. The starter looks up the owner and puts the address and its user id in the body.',
      match: {
        python: {
          all: [/SIGNUP_CONFLICT\s*=/, /SIGNUP_CONFLICT,\s*status_code=409/],
          none: [/already registered/i, /owner_of\(/],
        },
        typescript: {
          all: [/SIGNUP_CONFLICT\s*=/, /code\(409\)\.send\(SIGNUP_CONFLICT\)/],
          none: [/already registered/i, /ownerOf\(/],
        },
        go: {
          all: [/signupConflict\s*=/, /StatusConflict,\s*signupConflict/],
          none: [/already registered/i, /handles\.OwnerOf\(/],
        },
        scala: {
          all: [/SignupConflict\s*[:=]/, /StatusCodes\.Conflict,\s*SignupConflict/],
          none: [/already registered/i, /Handles\.ownerOf\(/],
        },
        cpp: {
          all: [/kSignupConflict\s*=/, /kSignupConflict\.dump\(\)/],
          none: [/already registered/i, /handles::ownerOf\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from identityd import accounts  # new_user_id, create_account, get_account, signup_result, record_signup
from identityd.handles import claim_handles, owner_of

app = FastAPI()


class Signup(BaseModel):
    email: str
    phone: str
    name: str


@app.post("/v1/users")
def signup(body: Signup, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    email = body.email.strip()
    phone = body.phone.strip()
    user_id = accounts.new_user_id()
    if not claim_handles(user_id, {"email": email, "phone": phone}):
        owner = owner_of("email", email) or owner_of("phone", phone)
        # Tell the client which account holds the address, so the app can offer "log in instead".
        return JSONResponse({"error": f"{email} is already registered", "user_id": owner}, status_code=409)
    accounts.create_account(user_id, email, phone, body.name)
    return JSONResponse({"user_id": user_id, "status": "unverified"}, status_code=201)
`,
      solution: `import re

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from identityd import accounts  # new_user_id, create_account, get_account, signup_result, record_signup
from identityd.handles import claim_handles, owner_of

app = FastAPI()

FOLD_ALIAS_DOMAINS = ("gmail.com", "googlemail.com")
SIGNUP_CONFLICT = {"error": "signup_conflict"}


class Signup(BaseModel):
    email: str
    phone: str
    name: str


def normalize_email(raw: str) -> str | None:
    """Lowercase; for a domain in FOLD_ALIAS_DOMAINS also drop the dots and the +tag of the local part."""
    local, at, domain = raw.strip().lower().rpartition("@")
    if not at or not local or "." not in domain:
        return None
    if domain in FOLD_ALIAS_DOMAINS:
        local = local.split("+", 1)[0].replace(".", "")
    return f"{local}@{domain}"


def normalize_phone(raw: str) -> str | None:
    """E.164: + and 8 to 15 digits. Spaces, dashes, dots and parentheses go; a leading 00 is +."""
    compact = re.sub(r"[\\s\\-.()]", "", raw)
    if compact.startswith("00"):
        compact = "+" + compact[2:]
    return compact if re.fullmatch(r"\\+\\d{8,15}", compact) else None


@app.post("/v1/users")
def signup(body: Signup, request: Request) -> JSONResponse:
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    recorded = accounts.signup_result(key)
    if recorded is not None:
        return JSONResponse(recorded, status_code=201)  # a retry answers what the first attempt answered
    email = normalize_email(body.email)
    phone = normalize_phone(body.phone)
    if email is None or phone is None:
        raise HTTPException(status_code=422, detail="email or phone is not valid")
    user_id = accounts.new_user_id()
    if not claim_handles(user_id, {"email": email, "phone": phone}):
        # One body for every collision: it names no address, no field and no account.
        return JSONResponse(SIGNUP_CONFLICT, status_code=409)
    accounts.create_account(user_id, email, phone, body.name)
    result = {"user_id": user_id, "status": "unverified"}
    accounts.record_signup(key, result)
    return JSONResponse(result, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {createAccount, newUserId, recordSignup, signupResult} from 'identityd/accounts';
import {claimHandles, ownerOf} from 'identityd/handles';

export const app = Fastify();

interface Signup {
  email: string;
  phone: string;
  name: string;
}

app.post('/v1/users', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const body = request.body as Signup;
  const email = body.email.trim();
  const phone = body.phone.trim();
  const userId = await newUserId();
  if (!(await claimHandles(userId, {email, phone}))) {
    const owner = (await ownerOf('email', email)) ?? (await ownerOf('phone', phone));
    // Tell the client which account holds the address, so the app can offer "log in instead".
    return reply.code(409).send({error: \`\${email} is already registered\`, user_id: owner});
  }
  await createAccount(userId, email, phone, body.name);
  return reply.code(201).send({user_id: userId, status: 'unverified'});
});
`,
      solution: `import Fastify from 'fastify';

import {createAccount, newUserId, recordSignup, signupResult} from 'identityd/accounts';
import {claimHandles, ownerOf} from 'identityd/handles';

export const app = Fastify();

export const FOLD_ALIAS_DOMAINS = ['gmail.com', 'googlemail.com'];
export const SIGNUP_CONFLICT = {error: 'signup_conflict'};

interface Signup {
  email: string;
  phone: string;
  name: string;
}

/** Lowercase; for a domain in FOLD_ALIAS_DOMAINS also drop the dots and the +tag of the local part. */
export function normalizeEmail(raw: string): string | null {
  const address = raw.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  const domain = address.slice(at + 1);
  if (at <= 0 || !domain.includes('.')) return null;
  let local = address.slice(0, at);
  if (FOLD_ALIAS_DOMAINS.includes(domain)) local = local.split('+')[0].replaceAll('.', '');
  return \`\${local}@\${domain}\`;
}

/** E.164: + and 8 to 15 digits. Spaces, dashes, dots and parentheses go; a leading 00 is +. */
export function normalizePhone(raw: string): string | null {
  let compact = raw.replace(/[\\s\\-.()]/g, '');
  if (compact.startsWith('00')) compact = \`+\${compact.slice(2)}\`;
  return /^\\+\\d{8,15}$/.test(compact) ? compact : null;
}

app.post('/v1/users', async (request, reply) => {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const recorded = await signupResult(key);
  if (recorded !== null) return reply.code(201).send(recorded); // a retry answers what the first attempt answered
  const body = request.body as Signup;
  const email = normalizeEmail(body.email);
  const phone = normalizePhone(body.phone);
  if (email === null || phone === null) return reply.code(422).send({error: 'email or phone is not valid'});
  const userId = await newUserId();
  // One body for every collision: it names no address, no field and no account.
  if (!(await claimHandles(userId, {email, phone}))) return reply.code(409).send(SIGNUP_CONFLICT);
  await createAccount(userId, email, phone, body.name);
  const result = {user_id: userId, status: 'unverified'};
  await recordSignup(key, result);
  return reply.code(201).send(result);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"identityd/accounts" // accounts.NewUserID, CreateAccount, GetAccount, SignupResult, RecordSignup
	"identityd/handles"  // handles.ClaimHandles, OwnerOf
)

type signupBody struct {
	Email string \`json:"email"\`
	Phone string \`json:"phone"\`
	Name  string \`json:"name"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func signup(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	var body signupBody
	json.NewDecoder(r.Body).Decode(&body)
	email := strings.TrimSpace(body.Email)
	phone := strings.TrimSpace(body.Phone)
	userID := accounts.NewUserID(r.Context())
	won, err := handles.ClaimHandles(r.Context(), userID, map[string]string{"email": email, "phone": phone})
	if err != nil {
		http.Error(rw, err.Error(), http.StatusServiceUnavailable)
		return
	}
	if !won {
		owner := handles.OwnerOf(r.Context(), "email", email)
		if owner == "" {
			owner = handles.OwnerOf(r.Context(), "phone", phone)
		}
		// Tell the client which account holds the address, so the app can offer "log in instead".
		writeJSON(rw, http.StatusConflict, map[string]string{"error": email + " is already registered", "user_id": owner})
		return
	}
	if _, err := accounts.CreateAccount(r.Context(), userID, email, phone, body.Name); err != nil {
		http.Error(rw, err.Error(), http.StatusServiceUnavailable)
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]string{"user_id": userID, "status": "unverified"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/users", signup)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"identityd/accounts" // accounts.NewUserID, CreateAccount, GetAccount, SignupResult, RecordSignup
	"identityd/handles"  // handles.ClaimHandles, OwnerOf
)

var foldAliasDomains = map[string]bool{"gmail.com": true, "googlemail.com": true}

var signupConflict = map[string]string{"error": "signup_conflict"}

type signupBody struct {
	Email string \`json:"email"\`
	Phone string \`json:"phone"\`
	Name  string \`json:"name"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// normalizeEmail lowercases; for a domain in foldAliasDomains it also drops the dots and the +tag of the local part.
func normalizeEmail(raw string) (string, bool) {
	address := strings.ToLower(strings.TrimSpace(raw))
	at := strings.LastIndex(address, "@")
	if at <= 0 || !strings.Contains(address[at+1:], ".") {
		return "", false
	}
	local, domain := address[:at], address[at+1:]
	if foldAliasDomains[domain] {
		local, _, _ = strings.Cut(local, "+")
		local = strings.ReplaceAll(local, ".", "")
	}
	return local + "@" + domain, true
}

// normalizePhone gives E.164: + and 8 to 15 digits. Spaces, dashes, dots and parentheses go; a leading 00 is +.
func normalizePhone(raw string) (string, bool) {
	compact := strings.NewReplacer(" ", "", "-", "", ".", "", "(", "", ")", "").Replace(strings.TrimSpace(raw))
	if strings.HasPrefix(compact, "00") {
		compact = "+" + compact[2:]
	}
	digits := strings.TrimPrefix(compact, "+")
	if digits == compact || len(digits) < 8 || len(digits) > 15 {
		return "", false
	}
	for _, ch := range digits {
		if ch < '0' || ch > '9' {
			return "", false
		}
	}
	return compact, true
}

func signup(rw http.ResponseWriter, r *http.Request) {
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		http.Error(rw, "Idempotency-Key is required", http.StatusBadRequest)
		return
	}
	recorded, err := accounts.SignupResult(r.Context(), key)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusServiceUnavailable)
		return
	}
	if recorded != nil {
		writeJSON(rw, http.StatusCreated, recorded) // a retry answers what the first attempt answered
		return
	}
	var body signupBody
	json.NewDecoder(r.Body).Decode(&body)
	email, emailOK := normalizeEmail(body.Email)
	phone, phoneOK := normalizePhone(body.Phone)
	if !emailOK || !phoneOK {
		http.Error(rw, "email or phone is not valid", http.StatusUnprocessableEntity)
		return
	}
	userID := accounts.NewUserID(r.Context())
	won, err := handles.ClaimHandles(r.Context(), userID, map[string]string{"email": email, "phone": phone})
	if err != nil {
		http.Error(rw, err.Error(), http.StatusServiceUnavailable)
		return
	}
	if !won {
		// One body for every collision: it names no address, no field and no account.
		writeJSON(rw, http.StatusConflict, signupConflict)
		return
	}
	if _, err := accounts.CreateAccount(r.Context(), userID, email, phone, body.Name); err != nil {
		http.Error(rw, err.Error(), http.StatusServiceUnavailable)
		return
	}
	result := map[string]any{"user_id": userID, "status": "unverified"}
	if err := accounts.RecordSignup(r.Context(), key, result); err != nil {
		http.Error(rw, err.Error(), http.StatusServiceUnavailable)
		return
	}
	writeJSON(rw, http.StatusCreated, result)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/users", signup)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import identityd.{Accounts, Handles} // Accounts.newUserId, createAccount, signupResult, recordSignup; Handles.claimHandles, ownerOf

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def field(body: JsObject, name: String): String = body.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  val route: Route = path("v1" / "users") {
    post {
      entity(as[String]) { raw =>
        // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
        val body = raw.parseJson.asJsObject
        val email = field(body, "email").trim
        val phone = field(body, "phone").trim
        val userId = Accounts.newUserId()
        if (!Handles.claimHandles(userId, Map("email" -> email, "phone" -> phone))) {
          val owner = Handles.ownerOf("email", email).orElse(Handles.ownerOf("phone", phone)).getOrElse("")
          // Tell the client which account holds the address, so the app can offer "log in instead".
          complete(json(StatusCodes.Conflict, JsObject("error" -> JsString(s"$email is already registered"), "user_id" -> JsString(owner))))
        } else {
          Accounts.createAccount(userId, email, phone, field(body, "name"))
          complete(json(StatusCodes.Created, JsObject("user_id" -> JsString(userId), "status" -> JsString("unverified"))))
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

import identityd.{Accounts, Handles} // Accounts.newUserId, createAccount, signupResult, recordSignup; Handles.claimHandles, ownerOf

object Api {
  val FoldAliasDomains: Set[String] = Set("gmail.com", "googlemail.com")
  val SignupConflict: JsObject = JsObject("error" -> JsString("signup_conflict"))

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def field(body: JsObject, name: String): String = body.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  /** Lowercase; for a domain in FoldAliasDomains also drop the dots and the +tag of the local part. */
  def normalizeEmail(raw: String): Option[String] = {
    val address = raw.trim.toLowerCase
    val at = address.lastIndexOf('@')
    val domain = address.substring(at + 1)
    if (at <= 0 || !domain.contains('.')) None
    else {
      val local = address.substring(0, at)
      Some((if (FoldAliasDomains.contains(domain)) local.takeWhile(_ != '+').replace(".", "") else local) + "@" + domain)
    }
  }

  /** E.164: + and 8 to 15 digits. Spaces, dashes, dots and parentheses go; a leading 00 is +. */
  def normalizePhone(raw: String): Option[String] = {
    val compact = raw.replaceAll("""[\\s\\-.()]""", "")
    Some(if (compact.startsWith("00")) "+" + compact.substring(2) else compact).filter(_.matches("""\\+\\d{8,15}"""))
  }

  val route: Route = path("v1" / "users") {
    post {
      optionalHeaderValueByName("Idempotency-Key") {
        case None | Some("") => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
        case Some(key) =>
          entity(as[String]) { raw =>
            Accounts.signupResult(key) match {
              case Some(recorded) => complete(json(StatusCodes.Created, recorded)) // a retry answers what the first attempt answered
              case None =>
                val body = raw.parseJson.asJsObject
                (normalizeEmail(field(body, "email")), normalizePhone(field(body, "phone"))) match {
                  case (Some(email), Some(phone)) =>
                    val userId = Accounts.newUserId()
                    // One body for every collision: it names no address, no field and no account.
                    if (!Handles.claimHandles(userId, Map("email" -> email, "phone" -> phone))) complete(json(StatusCodes.Conflict, SignupConflict))
                    else {
                      Accounts.createAccount(userId, email, phone, field(body, "name"))
                      val result = JsObject("user_id" -> JsString(userId), "status" -> JsString("unverified"))
                      Accounts.recordSignup(key, result)
                      complete(json(StatusCodes.Created, result))
                    }
                  case _ => complete(StatusCodes.UnprocessableEntity -> "email or phone is not valid")
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

#include "identityd/accounts.h"  // accounts::newUserId, createAccount, getAccount, signupResult, recordSignup
#include "identityd/handles.h"   // handles::claimHandles, ownerOf

using json = nlohmann::json;

std::string trim(const std::string& s) {
  const auto begin = s.find_first_not_of(" \\t\\n");
  if (begin == std::string::npos) return "";
  return s.substr(begin, s.find_last_not_of(" \\t\\n") - begin + 1);
}

void signup(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body);
  const std::string email = trim(body.value("email", ""));
  const std::string phone = trim(body.value("phone", ""));
  const std::string user_id = accounts::newUserId();
  if (!handles::claimHandles(user_id, {{"email", email}, {"phone", phone}})) {
    const auto owner = handles::ownerOf("email", email);
    // Tell the client which account holds the address, so the app can offer "log in instead".
    res.status = 409;
    res.set_content(json{{"error", email + " is already registered"}, {"user_id", owner ? *owner : handles::ownerOf("phone", phone).value_or("")}}.dump(),
                    "application/json");
    return;
  }
  accounts::createAccount(user_id, email, phone, body.value("name", ""));
  res.status = 201;
  res.set_content(json{{"user_id", user_id}, {"status", "unverified"}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/users", signup); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <optional>
#include <set>
#include <string>

#include "identityd/accounts.h"  // accounts::newUserId, createAccount, getAccount, signupResult, recordSignup
#include "identityd/handles.h"   // handles::claimHandles, ownerOf

using json = nlohmann::json;

const std::set<std::string> kFoldAliasDomains = {"gmail.com", "googlemail.com"};
const json kSignupConflict = {{"error", "signup_conflict"}};

std::string trim(const std::string& s) {
  const auto begin = s.find_first_not_of(" \\t\\n");
  if (begin == std::string::npos) return "";
  return s.substr(begin, s.find_last_not_of(" \\t\\n") - begin + 1);
}

// Lowercase; for a domain in kFoldAliasDomains also drop the dots and the +tag of the local part.
std::optional<std::string> normalizeEmail(const std::string& raw) {
  std::string address = trim(raw);
  std::transform(address.begin(), address.end(), address.begin(), [](unsigned char c) { return std::tolower(c); });
  const auto at = address.rfind('@');
  if (at == std::string::npos || at == 0) return std::nullopt;
  std::string local = address.substr(0, at);
  const std::string domain = address.substr(at + 1);
  if (domain.find('.') == std::string::npos) return std::nullopt;
  if (kFoldAliasDomains.count(domain)) {
    local = local.substr(0, local.find('+'));
    local.erase(std::remove(local.begin(), local.end(), '.'), local.end());
  }
  return local + "@" + domain;
}

// E.164: + and 8 to 15 digits. Spaces, dashes, dots and parentheses go; a leading 00 is +.
std::optional<std::string> normalizePhone(const std::string& raw) {
  std::string compact;
  for (const char ch : raw) {
    if (ch != ' ' && ch != '-' && ch != '.' && ch != '(' && ch != ')') compact += ch;
  }
  if (compact.rfind("00", 0) == 0) compact = "+" + compact.substr(2);
  if (compact.size() < 9 || compact.size() > 16 || compact[0] != '+') return std::nullopt;
  for (size_t i = 1; i < compact.size(); i++) {
    if (!std::isdigit(static_cast<unsigned char>(compact[i]))) return std::nullopt;
  }
  return compact;
}

void signup(const httplib::Request& req, httplib::Response& res) {
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) {
    res.status = 400;
    res.set_content("Idempotency-Key is required", "text/plain");
    return;
  }
  if (const auto recorded = accounts::signupResult(key)) {
    res.status = 201;  // a retry answers what the first attempt answered
    res.set_content(recorded->dump(), "application/json");
    return;
  }
  const json body = json::parse(req.body);
  const auto email = normalizeEmail(body.value("email", ""));
  const auto phone = normalizePhone(body.value("phone", ""));
  if (!email || !phone) {
    res.status = 422;
    res.set_content("email or phone is not valid", "text/plain");
    return;
  }
  const std::string user_id = accounts::newUserId();
  if (!handles::claimHandles(user_id, {{"email", *email}, {"phone", *phone}})) {
    // One body for every collision: it names no address, no field and no account.
    res.status = 409;
    res.set_content(kSignupConflict.dump(), "application/json");
    return;
  }
  accounts::createAccount(user_id, *email, *phone, body.value("name", ""));
  const json result = {{"user_id", user_id}, {"status", "unverified"}};
  accounts::recordSignup(key, result);
  res.status = 201;
  res.set_content(result.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/users", signup); }
`,
    },
  },
  harness: {
    python: `from identityd import accounts
from identityd.handles import owner_of

ADA = {"email": "ada@example.com", "phone": "+44 20 7946 0958", "name": "Ada"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _signup(c, body, key):
    return await c.post("/v1/users", json=body, headers={"Idempotency-Key": key})


def _accounts(ctx):
    return sorted(ctx.redis.keys("account:u-*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _signup(c, {"email": "grace@example.com", "phone": "+15550100200", "name": "Grace"}, "k-1")
    assert r.status_code == 201, f"POST /v1/users answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("status") == "unverified" and body.get("user_id"), f"a signup must answer the new user_id with status unverified, got {body}"
    account = accounts.get_account(body["user_id"])
    assert account is not None and account["name"] == "Grace", f"the store holds {account} for {body['user_id']}"
    assert owner_of("email", account["email"]) == body["user_id"], f"the account's address {account['email']} is not claimed by {body['user_id']}"


async def check_canonical_handles(ctx):
    async with _api(ctx) as c:
        first = await _signup(c, {"email": "Ada.Lovelace+news@Gmail.com", "phone": "+44 20 7946 0958", "name": "Ada"}, "k-1")
        assert first.status_code == 201, f"the first signup answered {first.status_code}: {first.text}"
        account = accounts.get_account(first.json()["user_id"]) or {}
        assert account.get("email") == "adalovelace@gmail.com", f"the account stores the email {account.get('email')!r}: case, the dots and the +tag of a Gmail address must fold to adalovelace@gmail.com"
        assert account.get("phone") == "+442079460958", f"the account stores the phone {account.get('phone')!r}, expected the E.164 form +442079460958"
        again = await _signup(c, {"email": "adalovelace@gmail.com", "phone": "+15550100300", "name": "Ada"}, "k-2")
        assert again.status_code == 409, f"a second signup as adalovelace@gmail.com answered {again.status_code}: one person now has two accounts"
        same_phone = await _signup(c, {"email": "ada@example.com", "phone": "0044-20-7946-0958", "name": "Ada"}, "k-3")
        assert same_phone.status_code == 409, f"a signup with 0044-20-7946-0958 (the number +442079460958 already holds) answered {same_phone.status_code}"
        dotted = await _signup(c, {"email": "a.b@example.com", "phone": "+15550100400", "name": "A"}, "k-4")
        plain = await _signup(c, {"email": "ab@example.com", "phone": "+15550100500", "name": "B"}, "k-5")
        assert dotted.status_code == 201 and plain.status_code == 201, f"a.b@example.com and ab@example.com answered {dotted.status_code} and {plain.status_code}: outside FOLD_ALIAS_DOMAINS the dots are part of the address"
        bad = await _signup(c, {"email": "zoe@example.com", "phone": "12", "name": "Zoe"}, "k-6")
        assert bad.status_code == 422, f"a phone of two digits answered {bad.status_code}, expected 422"
        no_at = await _signup(c, {"email": "zoe.example.com", "phone": "+15550100700", "name": "Zoe"}, "k-7")
    assert no_at.status_code == 422, f"an email without @ answered {no_at.status_code}, expected 422"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        first = await _signup(c, ADA, "k-1")
        assert first.status_code == 201, f"the first signup answered {first.status_code}: {first.text}"
        retry = await _signup(c, ADA, "k-1")
        assert retry.status_code == first.status_code and retry.json() == first.json(), f"a retry with the same Idempotency-Key must answer what the first attempt answered: first {first.status_code} {first.text}, retry {retry.status_code} {retry.text}"
        assert _accounts(ctx) == [f"account:{first.json()['user_id']}"], f"one signup and its retry left the accounts {_accounts(ctx)}"
        missing = await c.post("/v1/users", json={"email": "bo@example.com", "phone": "+15550100800", "name": "Bo"})
    assert missing.status_code == 400, f"a signup without Idempotency-Key answered {missing.status_code}, expected 400"


async def check_neutral_conflict(ctx):
    async with _api(ctx) as c:
        first = await _signup(c, ADA, "k-1")
        assert first.status_code == 201, f"the first signup answered {first.status_code}: {first.text}"
        owner = first.json()["user_id"]
        by_email = await _signup(c, {**ADA, "phone": "+15550100600", "name": "Eve"}, "k-2")
        by_phone = await _signup(c, {**ADA, "email": "eve@example.com", "name": "Eve"}, "k-3")
    for what, r in (("email", by_email), ("phone", by_phone)):
        assert r.status_code == 409, f"a signup with a taken {what} answered {r.status_code}: {r.text}"
        assert owner not in r.text, f"the 409 for a taken {what} names the account {owner}: {r.text}. A stranger learns who owns the address"
        assert "ada@example.com" not in r.text and "7946" not in r.text, f"the 409 for a taken {what} echoes the handle: {r.text}"
        assert r.json() == {"error": "signup_conflict"}, f"the 409 for a taken {what} is {r.text}, expected {{\\"error\\": \\"signup_conflict\\"}}"
    assert owner_of("email", "eve@example.com") is None, "the refused signup kept its claim on eve@example.com"
`,
    typescript: `const ADA = {email: 'ada@example.com', phone: '+44 20 7946 0958', name: 'Ada'};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), accounts: ctx.load('/support/identityd/accounts.ts'), handles: ctx.load('/support/identityd/handles.ts')};
}

const signup = (c, body, key: string) => c.post('/v1/users', {json: body, headers: {'Idempotency-Key': key}});

export async function check_route(ctx) {
  const {c, accounts, handles} = api(ctx);
  const r = await signup(c, {email: 'grace@example.com', phone: '+15550100200', name: 'Grace'}, 'k-1');
  assert.equal(r.status, 201, \`POST /v1/users answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.status === 'unverified' && body.user_id, \`a signup must answer the new user_id with status unverified, got \${r.text}\`);
  const account = await accounts.getAccount(body.user_id);
  assert(account !== null && account.name === 'Grace', \`the store holds \${JSON.stringify(account)} for \${body.user_id}\`);
  assert.equal(await handles.ownerOf('email', account.email), body.user_id, \`the account's address \${account.email} is not claimed by \${body.user_id}\`);
}

export async function check_canonical_handles(ctx) {
  const {c, accounts} = api(ctx);
  const first = await signup(c, {email: 'Ada.Lovelace+news@Gmail.com', phone: '+44 20 7946 0958', name: 'Ada'}, 'k-1');
  assert.equal(first.status, 201, \`the first signup answered \${first.status}: \${first.text}\`);
  const account = (await accounts.getAccount(first.json().user_id)) ?? {};
  assert.equal(account.email, 'adalovelace@gmail.com', \`the account stores the email \${JSON.stringify(account.email)}: case, the dots and the +tag of a Gmail address must fold to adalovelace@gmail.com\`);
  assert.equal(account.phone, '+442079460958', \`the account stores the phone \${JSON.stringify(account.phone)}, expected the E.164 form +442079460958\`);
  const again = await signup(c, {email: 'adalovelace@gmail.com', phone: '+15550100300', name: 'Ada'}, 'k-2');
  assert.equal(again.status, 409, \`a second signup as adalovelace@gmail.com answered \${again.status}: one person now has two accounts\`);
  const samePhone = await signup(c, {email: 'ada@example.com', phone: '0044-20-7946-0958', name: 'Ada'}, 'k-3');
  assert.equal(samePhone.status, 409, \`a signup with 0044-20-7946-0958 (the number +442079460958 already holds) answered \${samePhone.status}\`);
  const dotted = await signup(c, {email: 'a.b@example.com', phone: '+15550100400', name: 'A'}, 'k-4');
  const plain = await signup(c, {email: 'ab@example.com', phone: '+15550100500', name: 'B'}, 'k-5');
  assert(dotted.status === 201 && plain.status === 201, \`a.b@example.com and ab@example.com answered \${dotted.status} and \${plain.status}: outside FOLD_ALIAS_DOMAINS the dots are part of the address\`);
  const bad = await signup(c, {email: 'zoe@example.com', phone: '12', name: 'Zoe'}, 'k-6');
  assert.equal(bad.status, 422, \`a phone of two digits answered \${bad.status}, expected 422\`);
  const noAt = await signup(c, {email: 'zoe.example.com', phone: '+15550100700', name: 'Zoe'}, 'k-7');
  assert.equal(noAt.status, 422, \`an email without @ answered \${noAt.status}, expected 422\`);
}

export async function check_idempotency_key(ctx) {
  const {c} = api(ctx);
  const first = await signup(c, ADA, 'k-1');
  assert.equal(first.status, 201, \`the first signup answered \${first.status}: \${first.text}\`);
  const retry = await signup(c, ADA, 'k-1');
  assert(retry.status === first.status && retry.text === first.text, \`a retry with the same Idempotency-Key must answer what the first attempt answered: first \${first.status} \${first.text}, retry \${retry.status} \${retry.text}\`);
  const keys = ctx.redis.keys('account:u-*').sort();
  assert.deepStrictEqual(keys, [\`account:\${first.json().user_id}\`], \`one signup and its retry left the accounts \${JSON.stringify(keys)}\`);
  const missing = await c.post('/v1/users', {json: {email: 'bo@example.com', phone: '+15550100800', name: 'Bo'}});
  assert.equal(missing.status, 400, \`a signup without Idempotency-Key answered \${missing.status}, expected 400\`);
}

export async function check_neutral_conflict(ctx) {
  const {c, handles} = api(ctx);
  const first = await signup(c, ADA, 'k-1');
  assert.equal(first.status, 201, \`the first signup answered \${first.status}: \${first.text}\`);
  const owner = first.json().user_id;
  const byEmail = await signup(c, {...ADA, phone: '+15550100600', name: 'Eve'}, 'k-2');
  const byPhone = await signup(c, {...ADA, email: 'eve@example.com', name: 'Eve'}, 'k-3');
  for (const [what, r] of [['email', byEmail], ['phone', byPhone]] as const) {
    assert.equal(r.status, 409, \`a signup with a taken \${what} answered \${r.status}: \${r.text}\`);
    assert(!r.text.includes(owner), \`the 409 for a taken \${what} names the account \${owner}: \${r.text}. A stranger learns who owns the address\`);
    assert(!r.text.includes('ada@example.com') && !r.text.includes('7946'), \`the 409 for a taken \${what} echoes the handle: \${r.text}\`);
    assert.deepStrictEqual(r.json(), {error: 'signup_conflict'}, \`the 409 for a taken \${what} is \${r.text}, expected {"error": "signup_conflict"}\`);
  }
  assert.equal(await handles.ownerOf('email', 'eve@example.com'), null, 'the refused signup kept its claim on eve@example.com');
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"identityd/accounts"
	"identityd/handles"

	"leetbuild/harness"
)

var (
	apiBg = context.Background()
	ada   = map[string]string{"email": "ada@example.com", "phone": "+44 20 7946 0958", "name": "Ada"}
)

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func person(email, phone, name string) map[string]string {
	return map[string]string{"email": email, "phone": phone, "name": name}
}

func signupAs(c *harness.HTTP, body map[string]string, key string) *harness.Response {
	return c.Post("/v1/users", body, "Idempotency-Key", key)
}

func userIDOf(ctx *harness.Ctx, r *harness.Response) string {
	var body struct {
		UserID string \`json:"user_id"\`
		Status string \`json:"status"\`
	}
	r.Decode(&body)
	return body.UserID
}

func account(ctx *harness.Ctx, userID string) *accounts.Account {
	a, err := accounts.GetAccount(apiBg, userID)
	ctx.NoError(err, "GetAccount(%s) failed", userID)
	return a
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := signupAs(c, person("grace@example.com", "+15550100200", "Grace"), "k-1")
	ctx.Equal(r.Status, 201, "POST /v1/users (%s)", r.Text())
	ctx.Assert(strings.Contains(r.Text(), \`"unverified"\`), "a signup must answer the new user_id with status unverified, got %s", r.Text())
	userID := userIDOf(ctx, r)
	a := account(ctx, userID)
	ctx.Assert(a != nil && a.Name == "Grace", "the store holds %+v for %s", a, userID)
	ctx.Equal(handles.OwnerOf(apiBg, "email", a.Email), userID, "the owner of the account's address %s", a.Email)
}

func CheckCanonicalHandles(ctx *harness.Ctx) {
	c := api(ctx)
	first := signupAs(c, person("Ada.Lovelace+news@Gmail.com", "+44 20 7946 0958", "Ada"), "k-1")
	ctx.Equal(first.Status, 201, "the first signup (%s)", first.Text())
	a := account(ctx, userIDOf(ctx, first))
	ctx.Assert(a != nil, "the first signup wrote no account")
	ctx.Equal(a.Email, "adalovelace@gmail.com", "the account's email: case, the dots and the +tag of a Gmail address must fold to adalovelace@gmail.com")
	ctx.Equal(a.Phone, "+442079460958", "the account's phone, in E.164")
	again := signupAs(c, person("adalovelace@gmail.com", "+15550100300", "Ada"), "k-2")
	ctx.Equal(again.Status, 409, "a second signup as adalovelace@gmail.com must be refused, or one person has two accounts")
	samePhone := signupAs(c, person("ada@example.com", "0044-20-7946-0958", "Ada"), "k-3")
	ctx.Equal(samePhone.Status, 409, "a signup with 0044-20-7946-0958 (the number +442079460958 already holds)")
	dotted := signupAs(c, person("a.b@example.com", "+15550100400", "A"), "k-4")
	plain := signupAs(c, person("ab@example.com", "+15550100500", "B"), "k-5")
	ctx.Assert(dotted.Status == 201 && plain.Status == 201, "a.b@example.com and ab@example.com answered %d and %d: outside foldAliasDomains the dots are part of the address", dotted.Status, plain.Status)
	bad := signupAs(c, person("zoe@example.com", "12", "Zoe"), "k-6")
	ctx.Equal(bad.Status, 422, "a phone of two digits")
	noAt := signupAs(c, person("zoe.example.com", "+15550100700", "Zoe"), "k-7")
	ctx.Equal(noAt.Status, 422, "an email without @")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := api(ctx)
	first := signupAs(c, ada, "k-1")
	ctx.Equal(first.Status, 201, "the first signup (%s)", first.Text())
	retry := signupAs(c, ada, "k-1")
	ctx.Assert(retry.Status == first.Status && strings.TrimSpace(retry.Text()) == strings.TrimSpace(first.Text()), "a retry with the same Idempotency-Key must answer what the first attempt answered: first %d %s, retry %d %s", first.Status, first.Text(), retry.Status, retry.Text())
	ctx.Equal(ctx.Redis.Keys("account:u-*"), []string{"account:" + userIDOf(ctx, first)}, "one signup and its retry; the accounts")
	missing := c.Post("/v1/users", person("bo@example.com", "+15550100800", "Bo"))
	ctx.Equal(missing.Status, 400, "a signup without Idempotency-Key")
}

func CheckNeutralConflict(ctx *harness.Ctx) {
	c := api(ctx)
	first := signupAs(c, ada, "k-1")
	ctx.Equal(first.Status, 201, "the first signup (%s)", first.Text())
	owner := userIDOf(ctx, first)
	byEmail := signupAs(c, person("ada@example.com", "+15550100600", "Eve"), "k-2")
	byPhone := signupAs(c, person("eve@example.com", "+44 20 7946 0958", "Eve"), "k-3")
	for what, r := range map[string]*harness.Response{"email": byEmail, "phone": byPhone} {
		ctx.Equal(r.Status, 409, "a signup with a taken %s (%s)", what, r.Text())
		ctx.Assert(!strings.Contains(r.Text(), owner), "the 409 for a taken %s names the account %s: %s. A stranger learns who owns the address", what, owner, r.Text())
		ctx.Assert(!strings.Contains(r.Text(), "ada@example.com") && !strings.Contains(r.Text(), "7946"), "the 409 for a taken %s echoes the handle: %s", what, r.Text())
		ctx.Equal(r.JSON(), map[string]any{"error": "signup_conflict"}, "the 409 for a taken %s", what)
	}
	ctx.Equal(handles.OwnerOf(apiBg, "email", "eve@example.com"), "", "the refused signup must not keep its claim on eve@example.com; the owner")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <utility>
#include <vector>

#include "identityd/accounts.h"
#include "identityd/handles.h"

using json = nlohmann::json;

namespace {

const json kAda = {{"email", "ada@example.com"}, {"phone", "+44 20 7946 0958"}, {"name", "Ada"}};

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json person(const std::string& email, const std::string& phone, const std::string& name) {
  return json{{"email", email}, {"phone", phone}, {"name", name}};
}

harness::Response signupAs(harness::HTTP& c, const json& body, const std::string& key) {
  return c.Post("/v1/users", body.dump(), "Content-Type", "application/json", "Idempotency-Key", key);
}

std::string userIdOf(const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body.value("user_id", "") : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = signupAs(c, person("grace@example.com", "+15550100200", "Grace"), "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/users (%s)", r.Text());
  ctx.Assert(r.Text().find("\\"unverified\\"") != std::string::npos, "a signup must answer the new user_id with status unverified, got %s", r.Text());
  const std::string user_id = userIdOf(r);
  const auto account = accounts::getAccount(user_id);
  ctx.Assert(account && account->name == "Grace", "the store holds no account named Grace for %s", user_id);
  ctx.Equal(handles::ownerOf("email", account->email).value_or(""), user_id, "the owner of the account's address %s", account->email);
}

void CheckCanonicalHandles(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = signupAs(c, person("Ada.Lovelace+news@Gmail.com", "+44 20 7946 0958", "Ada"), "k-1");
  ctx.Equal(first.Status, 201, "the first signup (%s)", first.Text());
  const auto account = accounts::getAccount(userIdOf(first));
  ctx.Assert(account.has_value(), "the first signup wrote no account");
  ctx.Equal(account->email, "adalovelace@gmail.com", "the account's email: case, the dots and the +tag of a Gmail address must fold to adalovelace@gmail.com");
  ctx.Equal(account->phone, "+442079460958", "the account's phone, in E.164");
  const auto again = signupAs(c, person("adalovelace@gmail.com", "+15550100300", "Ada"), "k-2");
  ctx.Equal(again.Status, 409, "a second signup as adalovelace@gmail.com must be refused, or one person has two accounts");
  const auto same_phone = signupAs(c, person("ada@example.com", "0044-20-7946-0958", "Ada"), "k-3");
  ctx.Equal(same_phone.Status, 409, "a signup with 0044-20-7946-0958 (the number +442079460958 already holds)");
  const auto dotted = signupAs(c, person("a.b@example.com", "+15550100400", "A"), "k-4");
  const auto plain = signupAs(c, person("ab@example.com", "+15550100500", "B"), "k-5");
  ctx.Assert(dotted.Status == 201 && plain.Status == 201, "a.b@example.com and ab@example.com answered %d and %d: outside kFoldAliasDomains the dots are part of the address", dotted.Status, plain.Status);
  const auto bad = signupAs(c, person("zoe@example.com", "12", "Zoe"), "k-6");
  ctx.Equal(bad.Status, 422, "a phone of two digits");
  const auto no_at = signupAs(c, person("zoe.example.com", "+15550100700", "Zoe"), "k-7");
  ctx.Equal(no_at.Status, 422, "an email without @");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = signupAs(c, kAda, "k-1");
  ctx.Equal(first.Status, 201, "the first signup (%s)", first.Text());
  const auto retry = signupAs(c, kAda, "k-1");
  ctx.Assert(retry.Status == first.Status && retry.Text() == first.Text(), "a retry with the same Idempotency-Key must answer what the first attempt answered: first %d %s, retry %d %s", first.Status, first.Text(), retry.Status, retry.Text());
  ctx.Equal(ctx.Redis.Keys("account:u-*"), std::vector<std::string>{"account:" + userIdOf(first)}, "one signup and its retry; the accounts");
  const auto missing = c.Post("/v1/users", person("bo@example.com", "+15550100800", "Bo").dump(), "Content-Type", "application/json");
  ctx.Equal(missing.Status, 400, "a signup without Idempotency-Key");
}

void CheckNeutralConflict(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = signupAs(c, kAda, "k-1");
  ctx.Equal(first.Status, 201, "the first signup (%s)", first.Text());
  const std::string owner = userIdOf(first);
  const auto by_email = signupAs(c, person("ada@example.com", "+15550100600", "Eve"), "k-2");
  const auto by_phone = signupAs(c, person("eve@example.com", "+44 20 7946 0958", "Eve"), "k-3");
  for (const auto& [what, r] : std::vector<std::pair<std::string, harness::Response>>{{"email", by_email}, {"phone", by_phone}}) {
    ctx.Equal(r.Status, 409, "a signup with a taken %s (%s)", what, r.Text());
    ctx.Assert(r.Text().find(owner) == std::string::npos, "the 409 for a taken %s names the account %s: %s. A stranger learns who owns the address", what, owner, r.Text());
    ctx.Assert(r.Text().find("ada@example.com") == std::string::npos && r.Text().find("7946") == std::string::npos, "the 409 for a taken %s echoes the handle: %s", what, r.Text());
    ctx.Equal(json::parse(r.Text(), nullptr, false), json{{"error", "signup_conflict"}}, "the 409 for a taken %s", what);
  }
  ctx.Assert(!handles::ownerOf("email", "eve@example.com"), "the refused signup kept its claim on eve@example.com");
}
`,
  },
  hints: [
    'Sign up as `Ada.Lovelace+news@Gmail.com`, then as `adalovelace@gmail.com`: two accounts. Retry the first signup after a timeout: 409. Post a taken address: the body names its owner.',
    'The claim keys are the strings the client typed, so every spelling is a new handle. Nothing reads `Idempotency-Key`, so a retry claims again and loses to its own first attempt, and the 409 is built from `owner_of`.',
    'Add `normalize_email` (lowercase; dots and `+tag` only for `FOLD_ALIAS_DOMAINS`) and `normalize_phone` (E.164, else 422) before `claim_handles`; require the key, answer `signup_result(key)` first and `record_signup` after the write; return `SIGNUP_CONFLICT` with 409.',
  ],
  debrief: `Identity is a canonical form, so normalization runs before the claim and the row, and the fold rules are per domain because only the mailbox provider decides that \`a.b\` and \`ab\` are one inbox. The idempotency record turns a retry into a read of the first answer; without it the retry meets its own claims and tells the user their address is taken. One constant 409 stops the endpoint from naming owners, though a 409 still says that some account holds the handle. Services that must not reveal even that answer every signup with the same 202 and mail the existing owner instead, and they keep the raw input beside the canonical one for support and audit.`,
};
