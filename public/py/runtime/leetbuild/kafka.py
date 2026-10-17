"""
In-memory Kafka: topics with partitions, key hashing, consumer groups with committed offsets,
and a `confluent_kafka`-shaped Producer/Consumer on top (the `confluent_kafka` package in this
runtime re-exports them). One `BROKER` is shared by the learner's clients and the harness, which
seeds topics, reads what was produced and inspects commits.

Faithful where it matters for the courses: delivery callbacks are served by `poll()`/`flush()`,
`auto.offset.reset` decides where a new group starts, `enable.auto.commit` (librdkafka's default)
commits the last delivered offsets on the next poll, manual `commit(message=…)` records exactly
the offset the learner asked for, and a stalled broker makes producers wait and time out on the
virtual clock as librdkafka does. Not modelled: rebalances, transactions.
"""
from __future__ import annotations

import math
import zlib
from typing import Callable

from .clock import CLOCK

# How long a record acknowledged by the leader alone (acks 0/1) stays only on the leader.
REPLICATION_LAG = 0.1

OFFSET_BEGINNING = -2
OFFSET_END = -1
OFFSET_STORED = -1000
OFFSET_INVALID = -1001


def _bytes(value) -> bytes | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value.encode()
    return bytes(value)


def _headers(value) -> list[tuple[str, bytes | None]]:
    """Headers as librdkafka hands them to consumers: a list of (name, bytes) whatever the producer passed."""
    if not value:
        return []
    pairs = value.items() if isinstance(value, dict) else value
    return [(str(name), _bytes(v)) for name, v in pairs]


class Record:
    __slots__ = ("topic", "partition", "offset", "key", "value", "headers", "timestamp", "seq")

    def __init__(self, topic, partition, offset, key, value, headers, timestamp, seq):
        self.topic = topic
        self.partition = partition
        self.offset = offset
        self.key = key
        self.value = value
        self.headers = headers
        self.timestamp = timestamp
        self.seq = seq

    def __repr__(self) -> str:
        return f"Record({self.topic}[{self.partition}]@{self.offset} key={self.key!r} value={self.value!r})"


class Broker:
    def __init__(self, partitions: int = 3) -> None:
        self.default_partitions = partitions
        self.reset()

    def reset(self) -> None:
        self.topics: dict[str, list[list[Record]]] = {}
        self.committed: dict[tuple[str, str, int], int] = {}
        self.events: list[tuple] = []
        self.flushes = 0
        self.seq = 0
        self.failing: dict[str, int] = {}
        # Topic (None: every topic) → virtual time the broker acknowledges produces again (inf: until resumed).
        self.stalls: dict[str | None, float] = {}
        # Written but not yet acknowledged to the producer (lost ack → retry), and records only the leader has.
        self.ack_losses: dict[str, int] = {}
        self.unreplicated: list[tuple[Record, float]] = []
        self.commit_hooks: list[Callable[[str, dict[tuple[str, int], int]], None]] = []
        self.subscribe_hooks: list[Callable[[str, list[str]], None]] = []
        self.stop_when_drained = True
        self.consumers: list[Consumer] = []

    # ---- topics ---------------------------------------------------------------------------------
    def create_topic(self, topic: str, partitions: int | None = None) -> None:
        if topic not in self.topics:
            self.topics[topic] = [[] for _ in range(partitions or self.default_partitions)]

    def partition_for(self, topic: str, key: bytes | None) -> int:
        self.create_topic(topic)
        n = len(self.topics[topic])
        if key is None:
            return self.seq % n
        return zlib.crc32(key) % n

    def produce(self, topic: str, key=None, value=None, headers=None, partition: int | None = None) -> Record:
        key, value = _bytes(key), _bytes(value)
        self.create_topic(topic)
        if partition is None or partition < 0:
            partition = self.partition_for(topic, key)
        log = self.topics[topic][partition]
        self.seq += 1
        record = Record(topic, partition, len(log), key, value, _headers(headers), self.seq, self.seq)
        log.append(record)
        self.events.append(("produce", topic, partition, record.offset))
        return record

    seed = produce

    def fail_next(self, topic: str, times: int = 1) -> None:
        """The next `times` produces to `topic` fail with a delivery error (served through the callback)."""
        self.failing[topic] = self.failing.get(topic, 0) + times

    def stall(self, topic: str | None = None, seconds: float | None = None) -> None:
        """
        The broker stops acknowledging produces — to `topic`, or to every topic — as a dead or
        partitioned cluster does: records stay in the producer's queue and time out after
        `message.timeout.ms`. With `seconds` it answers again after that much virtual time.
        """
        self.stalls[topic] = math.inf if seconds is None else CLOCK.time() + seconds

    def resume(self, topic: str | None = None) -> None:
        """End a stall (every stall when no topic is given); in-flight records deliver on the next poll/flush."""
        if topic is None:
            self.stalls.clear()
        else:
            self.stalls.pop(topic, None)

    def stalled_until(self, topic: str) -> float | None:
        """When the broker answers produces to `topic` again (inf: not until resumed); None if it answers now."""
        now = CLOCK.time()
        until = max((t for key, t in self.stalls.items() if key is None or key == topic), default=None)
        return until if until is not None and until > now else None

    def lose_acks(self, topic: str, times: int = 1) -> None:
        """
        The next `times` produce requests to `topic` are written but their acknowledgement never reaches
        the producer, which retries (librdkafka does, transparently): without `enable.idempotence` the
        retry is written again — a duplicate on the topic; with it the broker recognises the producer's
        sequence number and writes it once. The delivery report says success either way.
        """
        self.ack_losses[topic] = self.ack_losses.get(topic, 0) + times

    def failover(self, topic: str | None = None) -> None:
        """
        The partition leader fails and a follower takes over: records acknowledged by the leader alone
        (`acks` 0 or 1) that had not reached the followers yet — written in the last REPLICATION_LAG
        seconds — are gone; records written with `acks=all` survive.
        """
        now = CLOCK.time()
        lost = [r for r, at in self.unreplicated if (topic is None or r.topic == topic) and now - at < REPLICATION_LAG]
        for record in lost:
            log = self.topics[record.topic][record.partition]
            if record in log:
                log.remove(record)
        for name in {r.topic for r in lost}:
            for log in self.topics[name]:
                for i, r in enumerate(log):
                    r.offset = i
        self.unreplicated = [(r, at) for r, at in self.unreplicated if r not in lost]
        self.events.append(("failover", topic, len(lost)))

    def records(self, topic: str) -> list[Record]:
        """Everything produced to `topic`, in production order."""
        logs = self.topics.get(topic, [])
        return sorted((r for log in logs for r in log), key=lambda r: r.seq)

    def values(self, topic: str) -> list[bytes | None]:
        return [r.value for r in self.records(topic)]

    def keys(self, topic: str) -> list[bytes | None]:
        return [r.key for r in self.records(topic)]

    def end_offset(self, topic: str, partition: int) -> int:
        self.create_topic(topic)
        return len(self.topics[topic][partition])

    # ---- groups ---------------------------------------------------------------------------------
    def commit(self, group: str, offsets: dict[tuple[str, int], int]) -> None:
        for (topic, partition), offset in offsets.items():
            self.committed[(group, topic, partition)] = offset
        self.events.append(("commit", group, dict(offsets)))
        for hook in self.commit_hooks:
            hook(group, offsets)

    def committed_offset(self, group: str, topic: str, partition: int) -> int | None:
        return self.committed.get((group, topic, partition))

    def commits(self, group: str | None = None) -> list[dict[tuple[str, int], int]]:
        return [e[2] for e in self.events if e[0] == "commit" and (group is None or e[1] == group)]

    def lag(self, group: str, topic: str) -> int:
        """Records of `topic` the group has not committed."""
        self.create_topic(topic)
        return sum(
            len(log) - self.committed.get((group, topic, p), 0) for p, log in enumerate(self.topics[topic])
        )

    def on_commit(self, hook: Callable[[str, dict[tuple[str, int], int]], None]) -> None:
        """Observe commits as they happen: snapshot other state to prove the commit came after the work."""
        self.commit_hooks.append(hook)

    def on_subscribe(self, hook: Callable[[str, list[str]], None]) -> None:
        """Runs when a consumer subscribes (group, topics): the moment to seed a `latest` group."""
        self.subscribe_hooks.append(hook)


BROKER = Broker()


# ---- confluent_kafka surface ---------------------------------------------------------------------


class KafkaError(Exception):
    NO_ERROR = 0
    _PARTITION_EOF = -191
    _MSG_TIMED_OUT = -192
    _ALL_BROKERS_DOWN = -187
    _TRANSPORT = -195
    _TIMED_OUT = -185
    _FATAL = -150
    _QUEUE_FULL = -184
    UNKNOWN_TOPIC_OR_PART = 3
    REQUEST_TIMED_OUT = 7
    NOT_LEADER_FOR_PARTITION = 6
    _INVALID_ARG = -186

    _NAMES = {
        -191: "_PARTITION_EOF",
        -192: "_MSG_TIMED_OUT",
        -187: "_ALL_BROKERS_DOWN",
        -195: "_TRANSPORT",
        -185: "_TIMED_OUT",
        -150: "_FATAL",
        -184: "_QUEUE_FULL",
        -186: "_INVALID_ARG",
        3: "UNKNOWN_TOPIC_OR_PART",
        7: "REQUEST_TIMED_OUT",
        6: "NOT_LEADER_FOR_PARTITION",
    }

    def __init__(self, code: int, reason: str = "", fatal: bool = False, retriable: bool = False) -> None:
        super().__init__(reason or self._NAMES.get(code, str(code)))
        self._code = code
        self._reason = reason or self._NAMES.get(code, str(code))
        self._fatal = fatal
        self._retriable = retriable

    def code(self) -> int:
        return self._code

    def name(self) -> str:
        return self._NAMES.get(self._code, str(self._code))

    def str(self) -> str:
        return self._reason

    def fatal(self) -> bool:
        return self._fatal

    def retriable(self) -> bool:
        return self._retriable

    def txn_requires_abort(self) -> bool:
        return False

    def __repr__(self) -> str:
        return f"KafkaError{{code={self.name()},val={self._code},str=\"{self._reason}\"}}"


class KafkaException(Exception):
    def __init__(self, error: KafkaError | None = None) -> None:
        super().__init__(error)


class TopicPartition:
    def __init__(self, topic: str, partition: int = -1, offset: int = OFFSET_INVALID, metadata=None, leader_epoch=None):
        self.topic = topic
        self.partition = partition
        self.offset = offset
        self.metadata = metadata
        self.leader_epoch = leader_epoch
        self.error = None

    def __eq__(self, other) -> bool:
        return isinstance(other, TopicPartition) and (self.topic, self.partition) == (other.topic, other.partition)

    def __hash__(self) -> int:
        return hash((self.topic, self.partition))

    def __repr__(self) -> str:
        return f"TopicPartition{{topic={self.topic},partition={self.partition},offset={self.offset}}}"


class Message:
    def __init__(self, record: Record, error: KafkaError | None = None) -> None:
        self._record = record
        self._error = error

    def topic(self) -> str:
        return self._record.topic

    def partition(self) -> int:
        return self._record.partition

    def offset(self) -> int:
        return self._record.offset

    def key(self) -> bytes | None:
        return self._record.key

    def value(self) -> bytes | None:
        return self._record.value

    def headers(self):
        return self._record.headers or None

    def timestamp(self):
        return (1, self._record.timestamp)

    def error(self) -> KafkaError | None:
        return self._error

    def latency(self):
        return None

    def leader_epoch(self):
        return None

    def set_key(self, key) -> None:
        self._record.key = _bytes(key)

    def set_value(self, value) -> None:
        self._record.value = _bytes(value)

    def __len__(self) -> int:
        return len(self._record.value or b"")


class Producer:
    """
    librdkafka's producer as the courses meet it: `produce` enqueues, delivery reports are served by
    `poll`/`flush`. While the broker is stalled records stay in flight: `poll(t)` and `flush(t)` wait
    `t` seconds of virtual time and return, `flush()` waits until every record is delivered or has
    been unacknowledged for `message.timeout.ms` (librdkafka's default: 300 s), when it fails with
    _MSG_TIMED_OUT through its delivery callback — so an unbounded flush on a dead broker costs
    exactly what it costs in production.
    """

    def __init__(self, conf: dict | None = None, **kwargs) -> None:
        self.conf = dict(conf or {}, **kwargs)
        # librdkafka's defaults: acks=all (-1), idempotence off.
        acks = self.conf.get("acks", self.conf.get("request.required.acks", -1))
        acks = -1 if str(acks).strip().lower() == "all" else int(acks)
        self._acks = -1 if acks < 0 else acks
        self._idempotent = _truthy(self.conf.get("enable.idempotence", False))
        if self._idempotent and self._acks != -1:
            raise KafkaException(
                KafkaError(KafkaError._INVALID_ARG, "Failed to create producer: `acks` must be set to `all` when `enable.idempotence` is true")
            )
        # Delivery reports ready to serve, and records the broker has not acknowledged (topic args, enqueued at).
        self._pending: list[tuple[Callable | None, KafkaError | None, Message]] = []
        self._inflight: list[tuple[Callable | None, dict, float]] = []
        BROKER.events.append(("producer", self.conf.get("bootstrap.servers")))

    def produce(self, topic, value=None, key=None, partition=-1, on_delivery=None, callback=None, timestamp=0, headers=None):
        cb = on_delivery or callback
        if BROKER.failing.get(topic, 0) > 0:
            BROKER.failing[topic] -= 1
            record = Record(topic, 0, -1, _bytes(key), _bytes(value), _headers(headers), 0, 0)
            error = KafkaError(KafkaError._MSG_TIMED_OUT, "Local: Message timed out", retriable=True)
            BROKER.events.append(("produce-failed", topic))
            self._pending.append((cb, error, Message(record, error)))
            return
        args = {"topic": topic, "key": key, "value": value, "headers": headers, "partition": partition if partition >= 0 else None}
        if BROKER.stalled_until(topic) is not None:
            if self._acks == 0:
                # acks=0: nobody waits for the broker — the report says delivered and the record is gone.
                record = Record(topic, 0, -1, _bytes(key), _bytes(value), _headers(headers), 0, 0)
                BROKER.events.append(("produce-lost", topic))
                self._pending.append((cb, None, Message(record)))
                return
            self._inflight.append((cb, args, CLOCK.time()))
            BROKER.events.append(("produce-stalled", topic))
            return
        self._pending.append((cb, None, Message(self._write(args))))

    def _write(self, args: dict) -> Record:
        """The broker writes the record: what `acks` and idempotence mean when the cluster misbehaves."""
        record = BROKER.produce(**args)
        if self._acks != -1:
            BROKER.unreplicated.append((record, CLOCK.time()))
        topic = args["topic"]
        if BROKER.ack_losses.get(topic, 0) > 0:
            BROKER.ack_losses[topic] -= 1
            BROKER.events.append(("ack-lost", topic))
            if not self._idempotent:
                # The retry of a write whose ack was lost is written again; the report carries the retry.
                record = BROKER.produce(**args)
                if self._acks != -1:
                    BROKER.unreplicated.append((record, CLOCK.time()))
        return record

    def poll(self, timeout: float = 0) -> int:
        self._settle()
        if not self._pending and self._inflight and timeout and timeout > 0:
            self._wait(timeout)
        return self._serve()

    def flush(self, timeout: float | None = None) -> int:
        """Serve every delivery report, waiting for in-flight records; returns how many are still in flight."""
        BROKER.flushes += 1
        BROKER.events.append(("flush",))
        self._settle()
        self._wait(None if timeout is None or timeout < 0 else float(timeout))
        self._serve()
        return len(self._inflight)

    def purge(self, *args, **kwargs) -> None:
        self._pending.clear()
        self._inflight.clear()

    def __len__(self) -> int:
        return len(self._pending) + len(self._inflight)

    def list_topics(self, *args, **kwargs):
        raise NotImplementedError("list_topics is not available in the LeetBuild runtime")

    def _message_timeout(self) -> float:
        for key in ("message.timeout.ms", "delivery.timeout.ms"):
            if key in self.conf:
                return max(0.0, float(self.conf[key]) / 1000)
        return 300.0

    def _settle(self) -> None:
        """Deliver what the broker accepts again; fail what has waited past the message timeout."""
        now = CLOCK.time()
        still = []
        for cb, args, at in self._inflight:
            if BROKER.stalled_until(args["topic"]) is None:
                self._pending.append((cb, None, Message(self._write(args))))
            elif now - at >= self._message_timeout():
                record = Record(args["topic"], 0, -1, _bytes(args["key"]), _bytes(args["value"]), _headers(args["headers"]), 0, 0)
                error = KafkaError(KafkaError._MSG_TIMED_OUT, "Local: Message timed out", retriable=True)
                BROKER.events.append(("produce-timed-out", args["topic"]))
                self._pending.append((cb, error, Message(record, error)))
            else:
                still.append((cb, args, at))
        self._inflight = still

    def _wait(self, timeout: float | None) -> None:
        """Block on the virtual clock until nothing is in flight, or for `timeout` seconds."""
        deadline = None if timeout is None else CLOCK.time() + timeout
        while self._inflight:
            moments = [at + self._message_timeout() for _cb, _args, at in self._inflight]
            moments += [u for u in (BROKER.stalled_until(a["topic"]) for _cb, a, _at in self._inflight) if u is not None and u != math.inf]
            if deadline is not None:
                moments.append(deadline)
            now = CLOCK.time()
            if min(moments) > now:
                CLOCK.advance(min(moments) - now)
            self._settle()
            if deadline is not None and CLOCK.time() >= deadline:
                return

    def _serve(self) -> int:
        served = 0
        while self._pending:
            cb, error, message = self._pending.pop(0)
            served += 1
            if cb is not None:
                cb(error, message)
        return served


class Consumer:
    def __init__(self, conf: dict | None = None, **kwargs) -> None:
        self.conf = dict(conf or {}, **kwargs)
        self.group = self.conf.get("group.id")
        self.auto_commit = _truthy(self.conf.get("enable.auto.commit", True))
        # librdkafka's defaults: poll() stores each delivered offset (enable.auto.offset.store) and a
        # background timer commits the stored offsets every auto.commit.interval.ms — also while the
        # application is still processing the record it just got.
        self.auto_store = _truthy(self.conf.get("enable.auto.offset.store", True))
        self.auto_commit_interval = float(self.conf.get("auto.commit.interval.ms", 5000)) / 1000
        self._last_auto_commit = CLOCK.time()
        self.reset_policy = str(self.conf.get("auto.offset.reset", "latest")).lower()
        self._assignment: list[TopicPartition] = []
        self._positions: dict[tuple[str, int], int] = {}
        self._delivered: dict[tuple[str, int], int] = {}
        self._stored: dict[tuple[str, int], int] = {}
        self._closed = False
        self._rr = 0
        BROKER.consumers.append(self)
        BROKER.events.append(("consumer", self.group))

    # ---- subscription ---------------------------------------------------------------------------
    def subscribe(self, topics: list[str], on_assign=None, on_revoke=None, on_lost=None) -> None:
        if not self.group:
            raise KafkaException(KafkaError(KafkaError._FATAL, "Local: subscribe requires group.id"))
        self._assignment = []
        for topic in topics:
            BROKER.create_topic(topic)
            for p in range(len(BROKER.topics[topic])):
                tp = TopicPartition(topic, p)
                self._assignment.append(tp)
                self._positions[(topic, p)] = self._start_offset(topic, p)
        BROKER.events.append(("subscribe", self.group, list(topics)))
        for hook in BROKER.subscribe_hooks:
            hook(self.group, list(topics))
        if on_assign is not None:
            on_assign(self, list(self._assignment))

    def assign(self, partitions: list[TopicPartition]) -> None:
        self._assignment = list(partitions)
        for tp in partitions:
            BROKER.create_topic(tp.topic)
            if tp.offset == OFFSET_BEGINNING:
                self._positions[(tp.topic, tp.partition)] = 0
            elif tp.offset == OFFSET_END:
                self._positions[(tp.topic, tp.partition)] = BROKER.end_offset(tp.topic, tp.partition)
            elif tp.offset >= 0:
                self._positions[(tp.topic, tp.partition)] = tp.offset
            else:
                self._positions[(tp.topic, tp.partition)] = self._start_offset(tp.topic, tp.partition)

    def unsubscribe(self) -> None:
        self._assignment = []

    def assignment(self) -> list[TopicPartition]:
        return list(self._assignment)

    def _start_offset(self, topic: str, partition: int) -> int:
        committed = BROKER.committed_offset(self.group, topic, partition) if self.group else None
        if committed is not None:
            return committed
        if self.reset_policy == "earliest":
            return 0
        return BROKER.end_offset(topic, partition)

    # ---- consuming ------------------------------------------------------------------------------
    def poll(self, timeout: float | None = None) -> Message | None:
        self._check_open()
        if self.auto_commit:
            self._auto_commit()
        n = len(self._assignment)
        for i in range(n):
            tp = self._assignment[(self._rr + i) % n]
            key = (tp.topic, tp.partition)
            pos = self._positions.get(key, 0)
            log = BROKER.topics[tp.topic][tp.partition]
            if pos < len(log):
                self._rr = (self._rr + i + 1) % n
                record = log[pos]
                self._positions[key] = pos + 1
                self._delivered[key] = pos + 1
                BROKER.events.append(("deliver", self.group, tp.topic, tp.partition, pos))
                return Message(record)
        if BROKER.stop_when_drained:
            raise KeyboardInterrupt("every seeded message was delivered")
        if timeout:
            from .clock import CLOCK

            CLOCK.advance(timeout)
        return None

    def consume(self, num_messages: int = 1, timeout: float | None = None) -> list[Message]:
        out = []
        for _ in range(num_messages):
            msg = self.poll(timeout)
            if msg is None:
                break
            out.append(msg)
        return out

    def _auto_commit(self) -> None:
        """Commit what librdkafka would: the offsets stored so far — at delivery, unless the learner stores them."""
        self._last_auto_commit = CLOCK.time()
        offsets = self._delivered if self.auto_store else self._stored
        due = {k: v for k, v in offsets.items() if BROKER.committed_offset(self.group, k[0], k[1]) != v}
        if due:
            BROKER.commit(self.group, due)
            BROKER.events.append(("auto-commit", self.group))
        if self.auto_store:
            self._delivered = {}

    # ---- offsets --------------------------------------------------------------------------------
    def commit(self, message: Message | None = None, offsets: list[TopicPartition] | None = None, asynchronous: bool = True):
        self._check_open()
        if message is not None:
            target = {(message.topic(), message.partition()): message.offset() + 1}
        elif offsets is not None:
            target = {(tp.topic, tp.partition): tp.offset for tp in offsets}
        elif self._stored:
            target = dict(self._stored)
        else:
            target = {k: v for k, v in self._positions.items()}
        BROKER.commit(self.group, target)
        self._delivered = {k: v for k, v in self._delivered.items() if target.get(k, -1) < v}
        BROKER.events.append(("manual-commit", self.group, asynchronous))
        return [TopicPartition(t, p, o) for (t, p), o in target.items()] if not asynchronous else None

    def store_offsets(self, message: Message | None = None, offsets: list[TopicPartition] | None = None) -> None:
        if message is not None:
            self._stored[(message.topic(), message.partition())] = message.offset() + 1
        elif offsets is not None:
            for tp in offsets:
                self._stored[(tp.topic, tp.partition)] = tp.offset

    def committed(self, partitions: list[TopicPartition], timeout=None) -> list[TopicPartition]:
        out = []
        for tp in partitions:
            offset = BROKER.committed_offset(self.group, tp.topic, tp.partition)
            out.append(TopicPartition(tp.topic, tp.partition, OFFSET_INVALID if offset is None else offset))
        return out

    def position(self, partitions: list[TopicPartition]) -> list[TopicPartition]:
        return [TopicPartition(tp.topic, tp.partition, self._positions.get((tp.topic, tp.partition), OFFSET_INVALID)) for tp in partitions]

    def seek(self, partition: TopicPartition) -> None:
        self._positions[(partition.topic, partition.partition)] = partition.offset

    def pause(self, partitions) -> None:
        pass

    def resume(self, partitions) -> None:
        pass

    def close(self) -> None:
        if self._closed:
            return
        if self.auto_commit:
            self._auto_commit()
        self._closed = True
        BROKER.events.append(("close", self.group))

    def _check_open(self) -> None:
        if self._closed:
            raise RuntimeError("Consumer closed")


def _truthy(value) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _auto_commit_timer() -> None:
    """librdkafka's background thread: every auto.commit.interval.ms each auto-committing consumer commits its stored offsets."""
    now = CLOCK.time()
    for consumer in BROKER.consumers:
        if consumer.auto_commit and not consumer._closed and now - consumer._last_auto_commit >= consumer.auto_commit_interval:
            consumer._auto_commit()


CLOCK.on_advance(_auto_commit_timer)
