"""
Counters for what the learner's code did during a check, kept by the clients it uses — the patched
`redis` classes count their round trips and commands, the Postgres cursor its statements. The
harness's own clients are the unpatched ones, so its calls never land here. Informational only:
the verdict never depends on these; `harness.run_checks` reports them beside each check.
"""


class Counters:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.redis_trips = 0
        self.redis_commands = 0
        self.sql_statements = 0

    def redis_trip(self, commands: int) -> None:
        """One round trip carrying `commands` commands: a single command, or a pipeline's whole stack."""
        self.redis_trips += 1
        self.redis_commands += commands


METRICS = Counters()
