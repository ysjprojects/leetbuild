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
