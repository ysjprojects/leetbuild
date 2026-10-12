"""
In-memory Kafka: topics with partitions, key hashing, consumer groups with committed offsets,
and a `confluent_kafka`-shaped Producer/Consumer on top (the `confluent_kafka` package in this
runtime re-exports them). One `BROKER` is shared by the learner's clients and the harness, which
seeds topics, reads what was produced and inspects commits.

Faithful where it matters for the courses: delivery callbacks are served by `poll()`/`flush()`,
`auto.offset.reset` decides where a new group starts, `enable.auto.commit` (librdkafka's default)
commits the last delivered offsets on the next poll, and manual `commit(message=…)` records exactly
the offset the learner asked for. Not modelled: rebalances, timeouts, transactions.
"""
from __future__ import annotations

import zlib
from typing import Callable

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

    _NAMES = {
        -191: "_PARTITION_EOF",
        -192: "_MSG_TIMED_OUT",
        -187: "_ALL_BROKERS_DOWN",
        -195: "_TRANSPORT",
        -185: "_TIMED_OUT",
        -150: "_FATAL",
        -184: "_QUEUE_FULL",
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
    def __init__(self, conf: dict | None = None, **kwargs) -> None:
        self.conf = dict(conf or {}, **kwargs)
        self._pending: list[tuple[Callable | None, KafkaError | None, Message]] = []
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
        record = BROKER.produce(topic, key=key, value=value, headers=headers, partition=partition if partition >= 0 else None)
        self._pending.append((cb, None, Message(record)))

    def poll(self, timeout: float = 0) -> int:
        return self._serve()

    def flush(self, timeout: float | None = None) -> int:
        BROKER.flushes += 1
        BROKER.events.append(("flush",))
        self._serve()
        return 0

    def purge(self, *args, **kwargs) -> None:
        self._pending.clear()

    def __len__(self) -> int:
        return len(self._pending)

    def list_topics(self, *args, **kwargs):
        raise NotImplementedError("list_topics is not available in the LeetBuild runtime")

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
        if self._delivered:
            BROKER.commit(self.group, dict(self._delivered))
            BROKER.events.append(("auto-commit", self.group))
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
