"""Bounded immutable current-fact reads for Usage publications.

The caller owns the connection and transaction. This module indexes only
immutable publication metadata; mutable capture rows are never consulted.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from skill_hub.infrastructure.usage import usage_source_versions as versions


def install_schema(db: sqlite3.Connection) -> None:
    """Install the additive immutable locator index in the caller transaction."""
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS publication_fact_index (
            publication_id TEXT NOT NULL REFERENCES source_versions(publication_id)
                ON DELETE CASCADE,
            source_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('scope', 'run')),
            physical_id TEXT NOT NULL,
            harness TEXT NOT NULL,
            root_session_id TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            run_id TEXT,
            logical_run_id TEXT,
            parent_logical_run_id TEXT,
            origin TEXT,
            PRIMARY KEY(publication_id, kind, physical_id)
        )
        """
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS publication_fact_index_scope "
        "ON publication_fact_index(harness,root_session_id,source_session_id,publication_id)"
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS publication_fact_index_run "
        "ON publication_fact_index(harness,run_id,logical_run_id,publication_id)"
    )


def index_publication(db: sqlite3.Connection, publication_id: str) -> None:
    """Index immutable scope and run facts already written for one version."""
    version = db.execute("SELECT source_id FROM source_versions WHERE publication_id=?", (publication_id,)).fetchone()
    if version is None:
        raise ValueError("publication does not exist")
    source_id = str(version["source_id"])
    rows = db.execute(
        f"""
        WITH RECURSIVE chain(publication_id,source_id,depth) AS (
            SELECT publication_id,source_id,0 FROM source_versions WHERE publication_id=?
            UNION ALL
            SELECT parent.publication_id,parent.source_id,chain.depth+1
            FROM chain JOIN source_versions child ON child.publication_id=chain.publication_id
            JOIN source_versions parent ON parent.publication_id=child.parent_version_id
            WHERE parent.state='complete' AND parent.source_id=chain.source_id
              AND chain.depth+1 < {versions.MAX_ANCESTRY_DEPTH}
        ), ranked AS (
            SELECT f.kind,f.physical_id,f.metadata_json,
                ROW_NUMBER() OVER (
                    PARTITION BY f.kind,f.physical_id
                    ORDER BY chain.depth,f.source_ordinal DESC
                ) AS occurrence_rank
            FROM chain JOIN version_facts f ON f.publication_id=chain.publication_id
            WHERE f.kind IN ('structural','run')
        )
        SELECT kind,physical_id,metadata_json FROM ranked WHERE occurrence_rank=1
        """,
        (publication_id,),
    ).fetchall()
    indexed: list[tuple[Any, ...]] = []
    for row in rows:
        try:
            metadata = json.loads(str(row["metadata_json"]))
        except ValueError:
            continue
        if not isinstance(metadata, dict):
            continue
        if row["kind"] == "structural":
            if metadata.get("record_type") != "source_scope":
                continue
            kind = "scope"
            run_id = logical = parent = origin = None
        else:
            kind = "run"
            run_id = metadata.get("run_id")
            logical = metadata.get("logical_run_id", run_id)
            parent = metadata.get("parent_logical_run_id", metadata.get("parent_run_id"))
            origin = metadata.get("origin", "source")
        harness = metadata.get("harness")
        root = metadata.get("root_session_id")
        session = metadata.get("source_session_id")
        if not all(isinstance(value, str) and value for value in (harness, root, session)):
            continue
        indexed.append(
            (
                publication_id,
                source_id,
                kind,
                str(row["physical_id"]),
                harness,
                root,
                session,
                str(run_id) if isinstance(run_id, str) else None,
                str(logical) if isinstance(logical, str) else None,
                str(parent) if isinstance(parent, str) else None,
                str(origin) if isinstance(origin, str) else None,
            )
        )
    db.execute("DELETE FROM publication_fact_index WHERE publication_id=?", (publication_id,))
    if indexed:
        db.executemany("INSERT INTO publication_fact_index VALUES (?,?,?,?,?,?,?,?,?,?,?)", indexed)


class CurrentReadSet:
    """One bounded snapshot of current publication facts for a requested scope."""

    def __init__(
        self,
        db: sqlite3.Connection,
        *,
        harness: str | None = None,
        session_id: str | None = None,
        run_ids: set[str] | None = None,
    ) -> None:
        self._db = db
        self._harness = harness
        self._session_id = session_id
        self._run_ids = frozenset(run_ids or ())
        self._members: list[dict[str, Any]] | None = None
        self._facts: dict[str, list[dict[str, Any]]] = {}
        self._source_ids: set[str] | None = None

    def members(self) -> list[dict[str, Any]]:
        if self._members is not None:
            return self._members
        candidates = self._run_candidates()
        winners: dict[tuple[str, str, str], dict[str, Any]] = {}
        for candidate in candidates:
            # Codex thread UUIDs retain one identity when a grandchild header
            # names its immediate parent but an inline mirror names the root.
            # Other harnesses can reuse child IDs across unrelated roots.
            key = (
                str(candidate["harness"]),
                "" if candidate["harness"] == "codex" else str(candidate["root_session_id"]),
                str(candidate.get("logical_run_id", candidate["run_id"])),
            )
            rank = (
                candidate.get("origin") != "source",
                str(candidate["_source_id"]),
                str(candidate["run_id"]),
            )
            prior = winners.get(key)
            if prior is None or rank < (
                prior.get("origin") != "source",
                str(prior["_source_id"]),
                str(prior["run_id"]),
            ):
                winners[key] = candidate
        result = list(winners.values())
        logical_to_physical = {
            (item["harness"], item["root_session_id"], item.get("logical_run_id", item["run_id"])): item["run_id"]
            for item in result
        }
        for item in result:
            parent = item.get("parent_logical_run_id", item.get("parent_run_id"))
            item["parent_run_id"] = logical_to_physical.get((item["harness"], item["root_session_id"], parent), parent)
            if not item["_published"]:
                item["native_facts"] = {"tool_capture_complete": False}
        self._members = result
        return result

    def facts(self, kind: str) -> list[dict[str, Any]]:
        if kind == "run":
            return self.members()
        if kind not in self._facts:
            selected = {(item["_source_id"], item["run_id"]) for item in self.members() if item["_published"]}
            rows = self._fact_rows(kind, {source_id for source_id, _ in selected})
            filtered = [
                fact
                for fact in rows
                if (fact.get("run_id") or fact.get("from_run_id")) is None
                or (fact["_source_id"], fact.get("run_id") or fact.get("from_run_id")) in selected
            ]
            if kind == "structural":
                filtered = [fact for fact in filtered if fact.get("record_type") != "source_scope"]
                filtered.extend(self.scopes())
            self._facts[kind] = filtered
        return self._facts[kind]

    def scopes(self) -> list[dict[str, Any]]:
        """Return only immutable source-scope facts for this bounded read set."""
        if "__scopes__" not in self._facts:
            members = self.members()
            source_ids = self._source_ids_for_scope()
            published_members = {item["_source_id"] for item in members if item["_published"]}
            staged_members = {item["_source_id"] for item in members if not item["_published"]}
            source_runs = self._indexed_head_run_sources(source_ids)
            head_scopes = [
                scope
                for scope in self._scope_rows(source_ids)
                if scope["_source_id"] in published_members or scope["_source_id"] not in source_runs
            ]
            self._facts["__scopes__"] = head_scopes + self._staged_scope_rows(staged_members)
        return self._facts["__scopes__"]

    def _indexed_head_run_sources(self, source_ids: set[str]) -> set[str]:
        if not source_ids:
            return set()
        marks = ",".join("?" for _ in source_ids)
        rows = self._db.execute(
            "SELECT DISTINCT i.source_id FROM publication_fact_index i "
            "JOIN source_heads h ON h.source_id=i.source_id AND h.publication_id=i.publication_id "
            f"WHERE i.source_id IN ({marks}) AND i.kind='run'",
            tuple(source_ids),
        ).fetchall()
        return {str(row[0]) for row in rows}

    def _source_ids_for_scope(self) -> set[str]:
        if self._source_ids is not None:
            return self._source_ids
        logical_run_ids = self._resolved_logical_run_ids()
        if self._run_ids and not logical_run_ids:
            self._source_ids = set()
            return self._source_ids
        where = ["v.state='complete'"]
        args: list[Any] = []
        if self._harness is not None:
            where.append("i.harness=?")
            args.append(self._harness)
        if self._session_id is not None:
            where.append("(i.root_session_id=? OR i.source_session_id=?)")
            args.extend((self._session_id, self._session_id))
        if logical_run_ids:
            marks = ",".join("?" for _ in logical_run_ids)
            where.append(
                "EXISTS(SELECT 1 FROM publication_fact_index peer "
                "WHERE peer.publication_id=i.publication_id AND peer.kind='run' "
                f"AND peer.logical_run_id IN ({marks}))"
            )
            args.extend(logical_run_ids)
        rows = self._db.execute(
            "SELECT DISTINCT i.source_id FROM publication_fact_index i "
            "JOIN source_heads h ON h.source_id=i.source_id AND h.publication_id=i.publication_id "
            "JOIN source_versions v ON v.publication_id=h.publication_id WHERE " + " AND ".join(where),
            args,
        ).fetchall()
        source_ids = {str(row[0]) for row in rows}
        # An initial staged source is visible only when it has no complete head.
        staged_where = [
            "v.state='staged'",
            "NOT EXISTS(SELECT 1 FROM source_heads h WHERE h.source_id=v.source_id)",
            "v.rowid=(SELECT MAX(newest.rowid) FROM source_versions newest "
            "WHERE newest.source_id=v.source_id AND newest.state='staged')",
        ]
        if self._harness is not None:
            staged_where.append("i.harness=?")
        if self._session_id is not None:
            staged_where.append("(i.root_session_id=? OR i.source_session_id=?)")
        if logical_run_ids:
            marks = ",".join("?" for _ in logical_run_ids)
            staged_where.append(
                "EXISTS(SELECT 1 FROM publication_fact_index peer "
                "WHERE peer.publication_id=i.publication_id AND peer.kind='run' "
                f"AND peer.logical_run_id IN ({marks}))"
            )
        staged_args = args[: (1 if self._harness is not None else 0)]
        if self._session_id is not None:
            staged_args.extend((self._session_id, self._session_id))
        staged_args.extend(logical_run_ids)
        for row in self._db.execute(
            "SELECT DISTINCT i.source_id FROM publication_fact_index i JOIN source_versions v "
            "ON v.publication_id=i.publication_id WHERE " + " AND ".join(staged_where),
            staged_args,
        ):
            source_ids.add(str(row[0]))
        # A later child source can retain only its immediate parent logical
        # reference. Follow that immutable edge so it remains in the root
        # family even when its captured root was not yet repaired.
        while source_ids:
            marks = ",".join("?" for _ in source_ids)
            logical_rows = self._db.execute(
                f"""
                SELECT DISTINCT i.logical_run_id FROM publication_fact_index i
                LEFT JOIN source_heads h ON h.source_id=i.source_id
                    AND h.publication_id=i.publication_id
                JOIN source_versions v ON v.publication_id=i.publication_id
                WHERE i.source_id IN ({marks}) AND i.kind='run' AND i.logical_run_id IS NOT NULL
                  AND (h.publication_id IS NOT NULL OR (
                    v.state='staged' AND NOT EXISTS(
                      SELECT 1 FROM source_heads current WHERE current.source_id=v.source_id
                    ) AND v.rowid=(
                      SELECT MAX(newest.rowid) FROM source_versions newest
                      WHERE newest.source_id=v.source_id AND newest.state='staged'
                    )
                  ))
                """,
                tuple(source_ids),
            ).fetchall()
            logical_ids = {str(row[0]) for row in logical_rows}
            if not logical_ids:
                break
            logical_marks = ",".join("?" for _ in logical_ids)
            clauses = [f"i.parent_logical_run_id IN ({logical_marks})", "v.state='complete'"]
            closure_args: list[Any] = [*logical_ids]
            if self._harness is not None:
                clauses.append("i.harness=?")
                closure_args.append(self._harness)
            rows = self._db.execute(
                "SELECT DISTINCT i.source_id FROM publication_fact_index i "
                "JOIN source_heads h ON h.source_id=i.source_id AND h.publication_id=i.publication_id "
                "JOIN source_versions v ON v.publication_id=h.publication_id WHERE " + " AND ".join(clauses),
                closure_args,
            ).fetchall()
            additions = {str(row[0]) for row in rows} - source_ids
            if not additions:
                break
            source_ids.update(additions)
        self._source_ids = source_ids
        return source_ids

    def _resolved_logical_run_ids(self) -> tuple[str, ...]:
        if not self._run_ids:
            return ()
        marks = ",".join("?" for _ in self._run_ids)
        where = [f"(i.run_id IN ({marks}) OR i.logical_run_id IN ({marks}))"]
        args: list[Any] = [*self._run_ids, *self._run_ids]
        if self._harness is not None:
            where.append("i.harness=?")
            args.append(self._harness)
        rows = self._db.execute(
            "SELECT DISTINCT i.logical_run_id FROM publication_fact_index i "
            "LEFT JOIN source_heads h ON h.source_id=i.source_id AND h.publication_id=i.publication_id "
            "JOIN source_versions v ON v.publication_id=i.publication_id WHERE "
            + " AND ".join(where)
            + " AND (h.publication_id IS NOT NULL OR (v.state='staged' "
            "AND NOT EXISTS(SELECT 1 FROM source_heads current WHERE current.source_id=v.source_id) "
            "AND v.rowid=(SELECT MAX(newest.rowid) FROM source_versions newest "
            "WHERE newest.source_id=v.source_id AND newest.state='staged')))",
            args,
        ).fetchall()
        return tuple(sorted(str(row[0]) for row in rows if row[0] is not None))

    def _run_candidates(self) -> list[dict[str, Any]]:
        source_ids = self._source_ids_for_scope()
        published = self._fact_rows("run", source_ids)
        staged = self._staged_run_rows(source_ids)
        return published + staged

    def _fact_rows(self, kind: str, source_ids: set[str]) -> list[dict[str, Any]]:
        if not source_ids:
            return []
        marks = ",".join("?" for _ in source_ids)
        query = f"""
            WITH RECURSIVE chain(source_id,publication_id,depth) AS (
                SELECT h.source_id,h.publication_id,0
                FROM source_heads h JOIN source_versions v ON v.publication_id=h.publication_id
                WHERE h.source_id IN ({marks}) AND v.state='complete'
                UNION ALL
                SELECT c.source_id,p.publication_id,c.depth+1
                FROM chain c JOIN source_versions v ON v.publication_id=c.publication_id
                JOIN source_versions p ON p.publication_id=v.parent_version_id
                WHERE p.state='complete' AND p.source_id=c.source_id
                  AND c.depth+1 < {versions.MAX_ANCESTRY_DEPTH}
            ), ranked AS (
                SELECT c.source_id,f.physical_id,f.source_ordinal,f.metadata_json,
                    ROW_NUMBER() OVER (
                        PARTITION BY c.source_id,f.kind,f.physical_id
                        ORDER BY c.depth,f.source_ordinal DESC
                    ) AS rank
                FROM chain c JOIN version_facts f ON f.publication_id=c.publication_id
                WHERE f.kind=?
            )
            SELECT source_id,physical_id,source_ordinal,metadata_json FROM ranked WHERE rank=1
        """
        return _decode(self._db.execute(query, (*source_ids, kind)).fetchall(), published=True)

    def _scope_rows(self, source_ids: set[str]) -> list[dict[str, Any]]:
        if not source_ids:
            return []
        marks = ",".join("?" for _ in source_ids)
        query = f"""
            WITH RECURSIVE chain(source_id,publication_id,depth) AS (
                SELECT h.source_id,h.publication_id,0
                FROM source_heads h JOIN source_versions v ON v.publication_id=h.publication_id
                WHERE h.source_id IN ({marks}) AND v.state='complete'
                UNION ALL
                SELECT c.source_id,p.publication_id,c.depth+1
                FROM chain c JOIN source_versions v ON v.publication_id=c.publication_id
                JOIN source_versions p ON p.publication_id=v.parent_version_id
                WHERE p.state='complete' AND p.source_id=c.source_id
                  AND c.depth+1 < {versions.MAX_ANCESTRY_DEPTH}
            ), ranked AS (
                SELECT c.source_id,f.physical_id,f.source_ordinal,f.metadata_json,
                    ROW_NUMBER() OVER (
                        PARTITION BY c.source_id,f.physical_id
                        ORDER BY c.depth,f.source_ordinal DESC
                    ) AS rank
                FROM chain c JOIN version_facts f ON f.publication_id=c.publication_id
                WHERE f.kind='structural'
                  AND json_extract(f.metadata_json,'$.record_type')='source_scope'
            )
            SELECT source_id,physical_id,source_ordinal,metadata_json FROM ranked WHERE rank=1
        """
        return _decode(self._db.execute(query, tuple(source_ids)).fetchall(), published=True)

    def _staged_scope_rows(self, source_ids: set[str]) -> list[dict[str, Any]]:
        if not source_ids:
            return []
        marks = ",".join("?" for _ in source_ids)
        rows = self._db.execute(
            f"""
            SELECT v.source_id,f.physical_id,f.source_ordinal,f.metadata_json
            FROM source_versions v JOIN version_facts f ON f.publication_id=v.publication_id
            WHERE v.source_id IN ({marks}) AND v.state='staged' AND f.kind='structural'
              AND json_extract(f.metadata_json,'$.record_type')='source_scope'
              AND NOT EXISTS(SELECT 1 FROM source_heads h WHERE h.source_id=v.source_id)
              AND v.rowid=(SELECT MAX(newest.rowid) FROM source_versions newest
                           WHERE newest.source_id=v.source_id AND newest.state='staged')
            """,
            tuple(source_ids),
        ).fetchall()
        return _decode(rows, published=False)

    def _staged_run_rows(self, source_ids: set[str]) -> list[dict[str, Any]]:
        if not source_ids:
            return []
        marks = ",".join("?" for _ in source_ids)
        rows = self._db.execute(
            f"""
            SELECT v.source_id,f.physical_id,f.source_ordinal,f.metadata_json
            FROM source_versions v JOIN version_facts f ON f.publication_id=v.publication_id
            WHERE v.source_id IN ({marks}) AND f.kind='run' AND v.state='staged'
              AND NOT EXISTS(SELECT 1 FROM source_heads h WHERE h.source_id=v.source_id)
              AND v.rowid=(SELECT MAX(newest.rowid) FROM source_versions newest
                           WHERE newest.source_id=v.source_id AND newest.state='staged')
            """,
            tuple(source_ids),
        ).fetchall()
        return _decode(rows, published=False)


def _decode(rows: Any, *, published: bool) -> list[dict[str, Any]]:
    result = []
    for row in rows:
        metadata = json.loads(str(row["metadata_json"]))
        if isinstance(metadata, dict):
            metadata["_source_id"] = str(row["source_id"])
            metadata["_physical_id"] = str(row["physical_id"])
            metadata["_source_ordinal"] = int(row["source_ordinal"])
            metadata["_published"] = published
            result.append(metadata)
    return result


def current_scopes(db: sqlite3.Connection) -> list[dict[str, Any]]:
    """Inventory completed source scopes without decoding structural seeds."""
    return CurrentReadSet(db).scopes()
