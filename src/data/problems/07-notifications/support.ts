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
