import {CPP_IDS_H} from '../cpp-support';

/**
 * Runtime support modules the Python starters import but no step builds: the preferences
 * database (`import db`) and the device registry (`import devices`). Both keep their state in
 * module attributes so a harness can seed rows and observe calls through the learner module's
 * own import (`m.db.calls`, `m.devices.disabled`).
 */
export const supportModules: Record<string, string> = {
  'db.py': `"""The preferences database: one row per user, provided."""

DEFAULT_PREFS = {"push": True, "quiet_start": 22, "quiet_end": 7}

rows: dict = {}
calls: list = []  # ("load", user_id) / ("save", user_id, prefs) in call order


def load_prefs(user_id: str) -> dict:
    """The user's preferences row (a default row for users who never saved one)."""
    calls.append(("load", user_id))
    return dict(rows.get(user_id, DEFAULT_PREFS))


def save_prefs(user_id: str, prefs: dict) -> None:
    calls.append(("save", user_id, dict(prefs)))
    rows[user_id] = dict(prefs)
`,
  'devices.py': `"""The device registry: marks tokens the push gateway rejected as stale, provided."""

disabled: list = []


def disable(token: str) -> None:
    """No further sends go to this token."""
    disabled.append(token)
`,
};

/**
 * The same two modules for the TypeScript starters (`import {db} from 'notify/db'`,
 * `import {devices} from 'notify/devices'`): each is one exported object so a harness can seed rows,
 * read the call log and swap a function through the instance the learner module imported
 * (`ctx.load('/support/notify/db.ts').db`).
 */
export const supportModulesTs: Record<string, string> = {
  'notify/db.ts': `/** The preferences database: one row per user, provided. */
export interface Prefs {
  push: boolean;
  quiet_start: number;
  quiet_end: number;
}

export type DbCall = ['load', string] | ['save', string, Prefs];

export const DEFAULT_PREFS: Prefs = {push: true, quiet_start: 22, quiet_end: 7};

export const db = {
  rows: {} as Record<string, Prefs>,
  calls: [] as DbCall[], // ['load', userId] / ['save', userId, prefs] in call order

  /** The user's preferences row (a default row for users who never saved one). */
  loadPrefs(userId: string): Prefs {
    db.calls.push(['load', userId]);
    return {...(db.rows[userId] ?? DEFAULT_PREFS)};
  },

  savePrefs(userId: string, prefs: Prefs): void {
    db.calls.push(['save', userId, {...prefs}]);
    db.rows[userId] = {...prefs};
  },
};
`,
  'notify/devices.ts': `/** The device registry: marks tokens the push gateway rejected as stale, provided. */
export const devices = {
  disabled: [] as string[],

  /** No further sends go to this token. */
  disable(token: string): void {
    devices.disabled.push(token);
  },
};
`,
};

/**
 * The same two modules for the Go starters (`"notify/db"`, `"notify/devices"`). Their state lives in
 * package variables, and the database's two calls are function variables, so a harness can seed rows,
 * read the call log and wrap a call through the package the learner's code imported.
 */
export const supportModulesGo: Record<string, string> = {
  'notify/db/db.go': `// Package db is the preferences database: one row per user, provided.
package db

import "context"

// Prefs is a user's preferences row.
type Prefs struct {
	Push       bool \`json:"push"\`
	QuietStart int  \`json:"quiet_start"\`
	QuietEnd   int  \`json:"quiet_end"\`
}

// Call is one database call: Op is "load" or "save"; Prefs is the row a save wrote.
type Call struct {
	Op     string
	UserID string
	Prefs  Prefs
}

// DefaultPrefs is the row of a user who never saved one.
var DefaultPrefs = Prefs{Push: true, QuietStart: 22, QuietEnd: 7}

var (
	Rows  = map[string]Prefs{} // the table, by user id
	Calls []Call               // every LoadPrefs and SavePrefs, in call order
)

// LoadPrefs returns the user's preferences row (DefaultPrefs for users who never saved one).
var LoadPrefs = func(ctx context.Context, userID string) (Prefs, error) {
	Calls = append(Calls, Call{Op: "load", UserID: userID})
	if p, ok := Rows[userID]; ok {
		return p, nil
	}
	return DefaultPrefs, nil
}

// SavePrefs writes the user's preferences row.
var SavePrefs = func(ctx context.Context, userID string, p Prefs) error {
	Calls = append(Calls, Call{Op: "save", UserID: userID, Prefs: p})
	Rows[userID] = p
	return nil
}
`,
  'notify/devices/devices.go': `// Package devices is the device registry: it marks tokens the push gateway rejected as stale, provided.
package devices

import "context"

// Disabled lists the disabled tokens, in the order they were disabled.
var Disabled []string

// Disable stops further sends to this token.
func Disable(ctx context.Context, token string) {
	Disabled = append(Disabled, token)
}
`,
};

/**
 * The C++ course headers: the notification record (`notification.h`), ids (`ids.h`), the preferences
 * row (`prefs.h`), the preferences database (`db.h`: state in inline variables, the two calls as
 * replaceable function objects so a harness can seed rows, read the call log and wrap a call), the
 * device registry (`devices.h`), and what step 6 calls of the steps before it (`rate_limit.h`,
 * `preferences.h`, `push_client.h`: declarations; a program compiles only its step's file, so the
 * harness defines them).
 */
export const supportModulesCpp: Record<string, string> = {
  'ids.h': `${CPP_IDS_H}
// new_id() is a fresh notification id: a random UUID.
inline std::string new_id() { return new_uuid(); }
`,
  'notification.h': `// The notification (provided): what the API accepts and the bus carries, as a JSON object.
#pragma once

#include <nlohmann/json.hpp>

#include <string>

struct Notification {
  std::string id, user_id, channel, title, body, priority;
};

// {"body":…,"channel":…,"id":…,"priority":…,"title":…,"user_id":…}
inline std::string to_json(const Notification& n) {
  return nlohmann::json{{"id", n.id},       {"user_id", n.user_id}, {"channel", n.channel},
                        {"title", n.title}, {"body", n.body},       {"priority", n.priority}}
      .dump();
}

// The notification a record's value holds; missing fields are empty (priority: "normal").
inline Notification parse_notification(const std::string& text) {
  const nlohmann::json j = nlohmann::json::parse(text);
  return {j.value("id", ""),    j.value("user_id", ""), j.value("channel", ""),
          j.value("title", ""), j.value("body", ""),    j.value("priority", "normal")};
}
`,
  'prefs.h': `// A user's preferences row (provided), as JSON {"push":true,"quiet_start":22,"quiet_end":7}.
#pragma once

#include <nlohmann/json.hpp>

#include <ostream>

struct Prefs {
  bool push = true;
  int quiet_start = 22;
  int quiet_end = 7;
  bool operator==(const Prefs&) const = default;
};

inline void to_json(nlohmann::json& j, const Prefs& p) {
  j = nlohmann::json{{"push", p.push}, {"quiet_start", p.quiet_start}, {"quiet_end", p.quiet_end}};
}

inline void from_json(const nlohmann::json& j, Prefs& p) {
  j.at("push").get_to(p.push);
  j.at("quiet_start").get_to(p.quiet_start);
  j.at("quiet_end").get_to(p.quiet_end);
}

inline std::ostream& operator<<(std::ostream& out, const Prefs& p) {
  return out << "{push:" << (p.push ? "true" : "false") << " quiet_start:" << p.quiet_start
             << " quiet_end:" << p.quiet_end << "}";
}
`,
  'db.h': `// The preferences database (provided): one row per user. rows is the table, calls logs every
// load_prefs and save_prefs in call order.
#pragma once

#include <functional>
#include <map>
#include <string>
#include <vector>

#include "prefs.h"

namespace db {

// One database call: op is "load" or "save"; prefs is the row a save wrote.
struct Call {
  std::string op;
  std::string user_id;
  Prefs prefs;
};

// The row of a user who never saved one.
inline const Prefs default_prefs{true, 22, 7};

inline std::map<std::string, Prefs> rows;  // the table, by user id
inline std::vector<Call> calls;            // every load_prefs and save_prefs, in call order

// The user's preferences row (default_prefs for users who never saved one).
inline std::function<Prefs(const std::string& user_id)> load_prefs = [](const std::string& user_id) {
  calls.push_back({"load", user_id, {}});
  const auto it = rows.find(user_id);
  return it == rows.end() ? default_prefs : it->second;
};

// Writes the user's preferences row.
inline std::function<void(const std::string& user_id, const Prefs& prefs)> save_prefs =
    [](const std::string& user_id, const Prefs& prefs) {
      calls.push_back({"save", user_id, prefs});
      rows[user_id] = prefs;
    };

}  // namespace db
`,
  'devices.h': `// The device registry (provided): marks tokens the push gateway rejected as stale.
#pragma once

#include <string>
#include <vector>

namespace devices {

// The disabled tokens, in the order they were disabled.
inline std::vector<std::string> disabled;

// No further sends go to this token.
inline void disable(const std::string& token) { disabled.push_back(token); }

}  // namespace devices
`,
  'rate_limit.h': `// Step 3's rate limit: true when this notification fits the user's hourly budget of 20.
#pragma once

#include <string>

bool allowed(const std::string& user_id, const std::string& notification_id);
`,
  'preferences.h': `// Step 4's preferences: get_prefs reads through the prefs:{user} cache; quiet tells whether an
// hour (0-23) falls in the user's quiet window.
#pragma once

#include <string>

#include "prefs.h"

Prefs get_prefs(const std::string& user_id);

inline bool quiet(const Prefs& p, int hour) {
  if (p.quiet_start <= p.quiet_end) return hour >= p.quiet_start && hour < p.quiet_end;
  return hour >= p.quiet_start || hour < p.quiet_end;
}
`,
  'push_client.h': `// Step 5's push client: send_push delivers to the user's device (the token is the user id, the
// collapse key the notification id) with a 3 s deadline and jittered retries; it throws Retryable
// when the gateway timed out or stayed unavailable.
#pragma once

#include <stdexcept>

#include "notification.h"

// The consumer re-queues the notification on the retry topic.
struct Retryable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

void send_push(const Notification& n);
`,
};
