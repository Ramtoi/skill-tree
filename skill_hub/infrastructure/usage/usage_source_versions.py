"""Immutable, source-owned publication storage for Usage facts.

The caller owns the SQLite connection and transaction. This module neither
opens a database nor discovers a data home.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
import uuid
from dataclasses import dataclass
from typing import Any, Mapping, Optional

METADATA_LIMIT = 16 * 1024
DEFAULT_CHECKPOINT_THRESHOLD = 16
MAX_METADATA_DEPTH = 32
MAX_ANCESTRY_DEPTH = 64

FACT_KINDS = frozenset(
    {
        "run",
        "token",
        "call",
        "part",
        "event",
        "relationship",
        "change",
        "pr",
        "structural",
        "message",
    }
)

_DIGEST_RE = re.compile(r"binding:[0-9a-f]{64}\Z")
_FORBIDDEN_METADATA_KEYS = frozenset(
    {"body", "raw_body", "content", "raw_content", "text", "payload", "bytes"}
)


@dataclass(frozen=True)
class VersionFact:
    kind: str
    physical_id: str
    source_ordinal: int
    metadata: Mapping[str, Any]


@dataclass(frozen=True)
class ResolvedFact:
    kind: str
    physical_id: str
    source_ordinal: int
    metadata: dict[str, Any]
    origin_version_id: str
    lineage: tuple[str, ...]


def install_schema(db: sqlite3.Connection) -> None:
    """Install only the additive immutable-publication tables."""
    statements = (
        """
        CREATE TABLE IF NOT EXISTS source_versions (
            publication_id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            binding_digest TEXT NOT NULL,
            mode TEXT NOT NULL CHECK(mode IN ('replacement', 'append', 'checkpoint')),
            parent_version_id TEXT REFERENCES source_versions(publication_id),
            expected_head TEXT,
            state TEXT NOT NULL CHECK(state IN ('staged', 'complete', 'failed')),
            failure_reason TEXT,
            last_source_ordinal INTEGER NOT NULL DEFAULT -1
        )
        """,
        "CREATE INDEX IF NOT EXISTS source_versions_source_state ON source_versions(source_id, state)",
        """
        CREATE TABLE IF NOT EXISTS source_heads (
            source_id TEXT PRIMARY KEY,
            publication_id TEXT NOT NULL REFERENCES source_versions(publication_id)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS version_facts (
            publication_id TEXT NOT NULL REFERENCES source_versions(publication_id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            physical_id TEXT NOT NULL,
            source_ordinal INTEGER NOT NULL,
            metadata_json TEXT NOT NULL,
            origin_version_id TEXT NOT NULL REFERENCES source_versions(publication_id),
            lineage_json TEXT NOT NULL,
            PRIMARY KEY(publication_id, kind, physical_id)
        )
        """,
        (
            "CREATE INDEX IF NOT EXISTS version_facts_publication_ordinal "
            "ON version_facts(publication_id, source_ordinal, kind, physical_id)"
        ),
    )
    for statement in statements:
        db.execute(statement)
    db.execute(
        f"""
        CREATE VIEW IF NOT EXISTS current_source_facts AS
        WITH RECURSIVE chain(source_id,publication_id,depth) AS (
            SELECT h.source_id,h.publication_id,0
            FROM source_heads h JOIN source_versions v ON v.publication_id=h.publication_id
            WHERE v.state='complete' AND v.source_id=h.source_id
            UNION ALL
            SELECT c.source_id,p.publication_id,c.depth+1
            FROM chain c JOIN source_versions v ON v.publication_id=c.publication_id
            JOIN source_versions p ON p.publication_id=v.parent_version_id
            WHERE p.state='complete' AND p.source_id=c.source_id
              AND c.depth+1 < {MAX_ANCESTRY_DEPTH}
        ), ranked AS (
            SELECT c.source_id,f.*,
                ROW_NUMBER() OVER (
                    PARTITION BY c.source_id,f.kind,f.physical_id
                    ORDER BY c.depth,f.source_ordinal DESC
                ) AS occurrence_rank
            FROM chain c JOIN version_facts f ON f.publication_id=c.publication_id
        )
        SELECT source_id,publication_id,kind,physical_id,source_ordinal,
               metadata_json,origin_version_id,lineage_json
        FROM ranked WHERE occurrence_rank=1
        """
    )


def begin_replacement(
    db: sqlite3.Connection,
    source_id: str,
    generation_id: str,
    binding_digest: str,
    expected_head: Optional[str],
) -> str:
    """Stage an empty immutable replacement against an expected current head."""
    return _begin_publication(
        db, source_id, generation_id, binding_digest, expected_head, "replacement", None
    )


def begin_append(
    db: sqlite3.Connection,
    source_id: str,
    generation_id: str,
    binding_digest: str,
    expected_head: str,
) -> str:
    """Stage a suffix publication whose parent is the expected source head."""
    _require_transaction(db)
    _validate_identifier(expected_head, "expected head")
    parent = _publication(db, expected_head)
    if parent is None:
        raise ValueError("expected head does not exist")
    if parent["source_id"] != source_id:
        raise ValueError("expected head belongs to another source")
    if parent["state"] != "complete":
        raise ValueError("expected head is not complete")
    if len(_ancestry(db, expected_head)) >= MAX_ANCESTRY_DEPTH:
        raise ValueError("append ancestry requires checkpoint")
    if parent["generation_id"] != generation_id:
        raise ValueError("append generation must match its parent")
    if parent["binding_digest"] != binding_digest:
        raise ValueError("append binding digest must match its parent")
    return _begin_publication(
        db, source_id, generation_id, binding_digest, expected_head, "append", expected_head
    )


def append_facts(
    db: sqlite3.Connection, publication_id: str, facts: list[VersionFact]
) -> None:
    """Append immutable, body-free facts to a staged publication."""
    _require_transaction(db)
    publication = _staged_publication(db, publication_id)
    inserts, updates = _validated_fact_operations(db, publication_id, facts)
    if publication["mode"] == "append":
        parent = _publication(db, str(publication["parent_version_id"]))
        assert parent is not None
        boundary = int(parent["last_source_ordinal"])
        if any(fact.source_ordinal <= boundary for fact in facts):
            raise ValueError("append fact precedes inherited suffix boundary")
    if not inserts and not updates:
        return

    def apply() -> None:
        if inserts:
            db.executemany(
                """
                INSERT INTO version_facts(
                    publication_id, kind, physical_id, source_ordinal, metadata_json,
                    origin_version_id, lineage_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                inserts,
            )
        if updates:
            db.executemany(
                """
                UPDATE version_facts
                SET source_ordinal = ?, metadata_json = ?
                WHERE publication_id = ? AND kind = ? AND physical_id = ?
                """,
                updates,
            )

        db.execute(
            "UPDATE source_versions SET last_source_ordinal=MAX(last_source_ordinal,?) WHERE publication_id=?",
            (max(fact.source_ordinal for fact in facts), publication_id),
        )

    _savepoint(db, "append_facts", apply)


def complete_publication(db: sqlite3.Connection, publication_id: str) -> bool:
    """Compare-and-swap one staged publication onto its source head."""
    _require_transaction(db)

    def publish() -> bool:
        publication = _staged_publication(db, publication_id)
        if publication["mode"] == "append":
            count = db.execute(
                "SELECT COUNT(*) FROM version_facts WHERE publication_id = ?", (publication_id,)
            ).fetchone()[0]
            if count == 0:
                raise ValueError("append publication must add at least one fact")
        expected_head = publication["expected_head"]
        if expected_head is None:
            changed = db.execute(
                "INSERT OR IGNORE INTO source_heads(source_id, publication_id) VALUES (?, ?)",
                (publication["source_id"], publication_id),
            ).rowcount
            if changed != 1:
                return False
        else:
            changed = db.execute(
                """
                UPDATE source_heads SET publication_id = ?
                WHERE source_id = ? AND publication_id = ?
                """,
                (publication_id, publication["source_id"], expected_head),
            ).rowcount
            if changed != 1:
                return False
        changed = db.execute(
            "UPDATE source_versions SET state = 'complete' WHERE publication_id = ? AND state = 'staged'",
            (publication_id,),
        ).rowcount
        if changed != 1:
            raise RuntimeError("publication completion lost its staged state")
        return True

    return _savepoint(db, "complete_publication", publish)


def fail_publication(db: sqlite3.Connection, publication_id: str, reason: str) -> bool:
    """Mark an unfinished publication failed without changing its source head."""
    _require_transaction(db)
    _validate_identifier(reason, "failure reason")
    return _savepoint(db, "fail_publication", lambda: db.execute(
        """
        UPDATE source_versions SET state = 'failed', failure_reason = ?
        WHERE publication_id = ? AND state = 'staged'
        """,
        (reason, publication_id),
    ).rowcount == 1)


def resolve_facts(
    db: sqlite3.Connection, source_id: str, *, publication_id: Optional[str] = None
) -> list[ResolvedFact]:
    """Resolve latest fact occurrences through one source's version ancestry."""
    _validate_identifier(source_id, "source id")
    if publication_id is None:
        head = db.execute(
            "SELECT publication_id FROM source_heads WHERE source_id = ?", (source_id,)
        ).fetchone()
        if head is None:
            return []
        publication_id = str(head[0])
    publication = _publication(db, publication_id)
    if publication is None or publication["source_id"] != source_id:
        raise ValueError("publication does not belong to source")
    if publication["state"] != "complete":
        raise ValueError("publication is not complete")

    resolved: dict[tuple[str, str], ResolvedFact] = {}
    for version_id in _ancestry(db, publication_id):
        for row in db.execute(
            """
            SELECT kind, physical_id, source_ordinal, metadata_json, origin_version_id, lineage_json
            FROM version_facts WHERE publication_id = ?
            """,
            (version_id,),
        ):
            key = (str(row["kind"]), str(row["physical_id"]))
            if key not in resolved:
                resolved[key] = ResolvedFact(
                    kind=key[0],
                    physical_id=key[1],
                    source_ordinal=int(row["source_ordinal"]),
                    metadata=json.loads(str(row["metadata_json"])),
                    origin_version_id=str(row["origin_version_id"]),
                    lineage=tuple(json.loads(str(row["lineage_json"]))),
                )
    return sorted(resolved.values(), key=lambda fact: (fact.source_ordinal, fact.kind, fact.physical_id))


def checkpoint_ancestry(
    db: sqlite3.Connection, source_id: str, *, threshold: int = DEFAULT_CHECKPOINT_THRESHOLD
) -> Optional[str]:
    """Bound an append chain by materializing its resolved metadata once."""
    if not isinstance(threshold, int) or isinstance(threshold, bool) or threshold < 1:
        raise ValueError("checkpoint threshold must be a positive integer")
    _require_transaction(db)
    head = db.execute(
        "SELECT publication_id FROM source_heads WHERE source_id = ?", (source_id,)
    ).fetchone()
    if head is None:
        return None
    head_id = str(head[0])
    ancestry = _ancestry(db, head_id)
    append_count = sum(
        _publication(db, version_id)["mode"] == "append"  # type: ignore[index]
        for version_id in ancestry
    )
    if append_count < threshold:
        return None
    head_version = _publication(db, head_id)
    assert head_version is not None
    def materialize() -> str:
        checkpoint_id = _begin_publication(
            db,
            source_id,
            str(head_version["generation_id"]),
            str(head_version["binding_digest"]),
            head_id,
            "checkpoint",
            None,
        )
        for fact in resolve_facts(db, source_id, publication_id=head_id):
            db.execute(
                """
                INSERT INTO version_facts(
                    publication_id, kind, physical_id, source_ordinal, metadata_json,
                    origin_version_id, lineage_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    checkpoint_id,
                    fact.kind,
                    fact.physical_id,
                    fact.source_ordinal,
                    _metadata_json(fact.metadata),
                    fact.origin_version_id,
                    json.dumps([fact.origin_version_id, checkpoint_id], separators=(",", ":")),
                ),
            )
        if not complete_publication(db, checkpoint_id):
            raise _CheckpointStale
        return checkpoint_id

    try:
        return _savepoint(db, "checkpoint_ancestry", materialize)
    except _CheckpointStale:
        return None


def _begin_publication(
    db: sqlite3.Connection,
    source_id: str,
    generation_id: str,
    binding_digest: str,
    expected_head: Optional[str],
    mode: str,
    parent_version_id: Optional[str],
) -> str:
    _require_transaction(db)
    _validate_identifier(source_id, "source id")
    _validate_identifier(generation_id, "generation id")
    if not isinstance(binding_digest, str) or not _DIGEST_RE.fullmatch(binding_digest):
        raise ValueError("binding digest must be a lowercase SHA-256 digest")
    if expected_head is not None:
        _validate_identifier(expected_head, "expected head")
    inherited_ordinal = -1
    if mode in {"append", "checkpoint"} and expected_head is not None:
        previous = _publication(db, expected_head)
        assert previous is not None
        inherited_ordinal = int(previous["last_source_ordinal"])
    publication_id = f"sv_{uuid.uuid4().hex}"
    db.execute(
        """
        INSERT INTO source_versions(
            publication_id, source_id, generation_id, binding_digest, mode,
            parent_version_id, expected_head, state, last_source_ordinal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'staged', ?)
        """,
        (
            publication_id,
            source_id,
            generation_id,
            binding_digest,
            mode,
            parent_version_id,
            expected_head,
            inherited_ordinal,
        ),
    )
    return publication_id


def _publication(db: sqlite3.Connection, publication_id: str) -> Optional[sqlite3.Row]:
    return db.execute("SELECT * FROM source_versions WHERE publication_id = ?", (publication_id,)).fetchone()


def _staged_publication(db: sqlite3.Connection, publication_id: str) -> sqlite3.Row:
    publication = _publication(db, publication_id)
    if publication is None or publication["state"] != "staged":
        raise ValueError("publication is not staged")
    return publication


class _CheckpointStale(Exception):
    pass


def _require_transaction(db: sqlite3.Connection) -> None:
    if not db.in_transaction:
        raise ValueError("a caller-owned transaction is required")


def _savepoint(db: sqlite3.Connection, name: str, action: Any) -> Any:
    db.execute(f"SAVEPOINT {name}")
    try:
        result = action()
    except BaseException:
        db.execute(f"ROLLBACK TO {name}")
        db.execute(f"RELEASE {name}")
        raise
    db.execute(f"RELEASE {name}")
    return result


def _validated_fact_operations(
    db: sqlite3.Connection, publication_id: str, facts: list[VersionFact]
) -> tuple[list[tuple[object, ...]], list[tuple[object, ...]]]:
    """Validate a chunk before changing its staged facts.

    A later ordinal may refine a staged physical fact. Equal payloads replay
    harmlessly; conflicting or backward updates are rejected before mutation.
    """
    inserts: list[tuple[object, ...]] = []
    updates: list[tuple[object, ...]] = []
    pending: dict[tuple[str, str], tuple[int, str]] = {}
    for fact in facts:
        if not isinstance(fact, VersionFact):
            raise ValueError("facts must be VersionFact values")
        if fact.kind not in FACT_KINDS:
            raise ValueError("fact kind is not allowlisted")
        _validate_identifier(fact.physical_id, "physical id")
        if not isinstance(fact.source_ordinal, int) or isinstance(fact.source_ordinal, bool) or fact.source_ordinal < 0:
            raise ValueError("source ordinal must be a non-negative integer")
        metadata_json = _metadata_json(fact.metadata)
        key = (fact.kind, fact.physical_id)
        existing = pending.get(key)
        if existing is None:
            row = db.execute(
                """
                SELECT source_ordinal, metadata_json FROM version_facts
                WHERE publication_id = ? AND kind = ? AND physical_id = ?
                """,
                (publication_id, fact.kind, fact.physical_id),
            ).fetchone()
            if row is not None:
                existing = (int(row["source_ordinal"]), str(row["metadata_json"]))
        if existing is None:
            inserts.append(
                (
                    publication_id,
                    fact.kind,
                    fact.physical_id,
                    fact.source_ordinal,
                    metadata_json,
                    publication_id,
                    json.dumps([publication_id], separators=(",", ":")),
                )
            )
            pending[key] = (fact.source_ordinal, metadata_json)
        elif fact.source_ordinal == existing[0] and metadata_json == existing[1]:
            continue
        elif fact.source_ordinal <= existing[0]:
            raise ValueError("staged fact update must advance its source ordinal")
        else:
            updates.append(
                (
                    fact.source_ordinal,
                    metadata_json,
                    publication_id,
                    fact.kind,
                    fact.physical_id,
                )
            )
            pending[key] = (fact.source_ordinal, metadata_json)
    return inserts, updates


def _ancestry(db: sqlite3.Connection, publication_id: str) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    current: Optional[str] = publication_id
    while current is not None:
        if len(result) >= MAX_ANCESTRY_DEPTH:
            raise ValueError("publication ancestry exceeds the bounded limit")
        if current in seen:
            raise ValueError("publication ancestry contains a cycle")
        seen.add(current)
        publication = _publication(db, current)
        if publication is None:
            raise ValueError("publication ancestry is missing a parent")
        result.append(current)
        parent = publication["parent_version_id"]
        current = str(parent) if parent is not None else None
    return result


def _validate_identifier(value: object, label: str) -> None:
    if not isinstance(value, str) or not value or len(value) > 512 or any(ord(char) < 32 for char in value):
        raise ValueError(f"{label} is malformed")


def _metadata_json(metadata: Mapping[str, Any]) -> str:
    if not isinstance(metadata, Mapping):
        raise ValueError("fact metadata must be an object")
    _validate_metadata_value(metadata)
    encoded = json.dumps(metadata, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if len(encoded.encode("utf-8")) > METADATA_LIMIT:
        raise ValueError("fact metadata exceeds the bounded limit")
    return encoded


def _validate_metadata_value(value: Any) -> None:
    _validate_metadata_value_at_depth(value, 0)


def _validate_metadata_value_at_depth(value: Any, depth: int) -> None:
    if depth > MAX_METADATA_DEPTH:
        raise ValueError("fact metadata exceeds the bounded depth")
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if math.isfinite(value):
            return
        raise ValueError("fact metadata must be JSON")
    if isinstance(value, bytes):
        raise ValueError("fact metadata cannot contain body bytes")
    if isinstance(value, Mapping):
        for key, child in value.items():
            if not isinstance(key, str):
                raise ValueError("fact metadata keys must be strings")
            if key.casefold() in _FORBIDDEN_METADATA_KEYS:
                raise ValueError("fact metadata cannot contain a body")
            _validate_metadata_value_at_depth(child, depth + 1)
        return
    if isinstance(value, (list, tuple)):
        for child in value:
            _validate_metadata_value_at_depth(child, depth + 1)
        return
    raise ValueError("fact metadata must be JSON")
