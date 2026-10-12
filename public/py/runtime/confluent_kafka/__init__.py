"""`confluent_kafka` in the LeetBuild runtime: the in-memory broker's clients (see leetbuild.kafka)."""
from leetbuild.kafka import (
    OFFSET_BEGINNING,
    OFFSET_END,
    OFFSET_INVALID,
    OFFSET_STORED,
    Consumer,
    KafkaError,
    KafkaException,
    Message,
    Producer,
    TopicPartition,
)

__version__ = "2.6.0"
version = lambda: (__version__, 0x020600)  # noqa: E731
libversion = lambda: ("2.6.0", 0x020600ff)  # noqa: E731

__all__ = [
    "Consumer",
    "KafkaError",
    "KafkaException",
    "Message",
    "Producer",
    "TopicPartition",
    "OFFSET_BEGINNING",
    "OFFSET_END",
    "OFFSET_INVALID",
    "OFFSET_STORED",
]
