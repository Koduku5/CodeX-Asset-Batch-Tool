"""Compatibility facade for pipeline locking and Cache transactions."""

from pipeline_lock_protocol import (
    ProtocolError,
    acquire_pipeline_lock,
    atomic_write_json,
    read_json,
    release_pipeline_lock,
    require_pipeline_lock,
)
from pipeline_transaction_protocol import (
    recover_pending_transaction,
    transactional_commit_json,
)

__all__ = [
    "ProtocolError",
    "acquire_pipeline_lock",
    "atomic_write_json",
    "read_json",
    "recover_pending_transaction",
    "release_pipeline_lock",
    "require_pipeline_lock",
    "transactional_commit_json",
]
