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
