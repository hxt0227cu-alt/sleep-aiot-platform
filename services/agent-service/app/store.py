import json
import os
import sqlite3
from functools import lru_cache
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol
from uuid import UUID

from .models import (
    AgentRun,
    PreferenceMemory,
    RunStatus,
    WorkspaceArtifact,
)


def _decode_payload(payload: object) -> str:
    return payload if isinstance(payload, str) else json.dumps(payload)


class AgentStateStore(Protocol):
    def healthcheck(self) -> bool: ...
    def save(self, run: AgentRun) -> None: ...
    def get(self, run_id: UUID) -> AgentRun | None: ...
    def list_runs(self) -> list[AgentRun]: ...
    def save_memory(self, memory: PreferenceMemory) -> None: ...
    def list_memories(self, tenant_id: UUID, user_id: UUID) -> list[PreferenceMemory]: ...
    def delete_memory(self, memory_id: UUID, tenant_id: UUID, user_id: UUID) -> bool: ...
    def save_artifact(self, artifact: WorkspaceArtifact) -> None: ...
    def get_artifact(self, artifact_id: UUID, tenant_id: UUID) -> WorkspaceArtifact | None: ...
    def delete_artifact(self, artifact_id: UUID, tenant_id: UUID, user_id: UUID) -> bool: ...
    def audit_events(self, tenant_id: UUID, user_id: UUID) -> list[dict[str, str]]: ...
    def purge_expired(self) -> int: ...
    def status_counts(self) -> dict[str, int]: ...


class RunStore:
    """Single-process development store. Production uses PostgresRunStore."""

    def __init__(self, path: str) -> None:
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS agent_runs (
                    run_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
                    payload TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_preference_memories (
                    memory_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
                    user_id TEXT NOT NULL, payload TEXT NOT NULL,
                    expires_at TEXT NOT NULL, deleted_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_agent_memory_scope
                    ON agent_preference_memories(tenant_id, user_id, expires_at);
                CREATE TABLE IF NOT EXISTS agent_workspace_artifacts (
                    artifact_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
                    user_id TEXT NOT NULL, session_id TEXT NOT NULL,
                    payload TEXT NOT NULL, expires_at TEXT NOT NULL, deleted_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_agent_workspace_scope
                    ON agent_workspace_artifacts(tenant_id, user_id, session_id, expires_at);
                CREATE TABLE IF NOT EXISTS agent_memory_audit (
                    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
                    action TEXT NOT NULL, resource_type TEXT NOT NULL,
                    resource_id TEXT NOT NULL, created_at TEXT NOT NULL
                );
                """
            )
            columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(agent_runs)").fetchall()
            }
            if "tenant_id" not in columns:
                connection.execute("ALTER TABLE agent_runs ADD COLUMN tenant_id TEXT")
                connection.execute(
                    "UPDATE agent_runs SET tenant_id = json_extract(payload, '$.tenant_id') WHERE tenant_id IS NULL"
                )

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path)

    def healthcheck(self) -> bool:
        with self._connect() as connection:
            return connection.execute("SELECT 1").fetchone() == (1,)

    def save(self, run: AgentRun) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO agent_runs(run_id, tenant_id, payload, updated_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(run_id) DO UPDATE SET tenant_id=excluded.tenant_id, "
                "payload=excluded.payload, updated_at=excluded.updated_at",
                (str(run.run_id), str(run.tenant_id), run.model_dump_json(), run.updated_at.isoformat()),
            )

    def get(self, run_id: UUID) -> AgentRun | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM agent_runs WHERE run_id = ?", (str(run_id),)
            ).fetchone()
        return AgentRun.model_validate_json(row[0]) if row else None

    def list_runs(self) -> list[AgentRun]:
        with self._connect() as connection:
            rows = connection.execute("SELECT payload FROM agent_runs").fetchall()
        return [AgentRun.model_validate_json(payload) for (payload,) in rows]

    def load_all(self) -> dict[UUID, AgentRun]:
        return {run.run_id: run for run in self.list_runs()}

    def recoverable(self) -> list[AgentRun]:
        return [
            run
            for run in self.list_runs()
            if run.status in {RunStatus.QUEUED, RunStatus.RUNNING}
        ]

    def status_counts(self) -> dict[str, int]:
        counts = {status.value: 0 for status in RunStatus}
        for run in self.list_runs():
            counts[run.status.value] += 1
        return counts

    def save_memory(self, memory: PreferenceMemory) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO agent_preference_memories(memory_id, tenant_id, user_id, payload, expires_at, deleted_at) "
                "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET payload=excluded.payload, "
                "expires_at=excluded.expires_at, deleted_at=excluded.deleted_at",
                (str(memory.memory_id), str(memory.tenant_id), str(memory.user_id), memory.model_dump_json(),
                 memory.expires_at.isoformat(), memory.deleted_at.isoformat() if memory.deleted_at else None),
            )
            self._audit(connection, memory.tenant_id, memory.user_id, "upsert", "preference_memory", memory.memory_id)

    def list_memories(self, tenant_id: UUID, user_id: UUID) -> list[PreferenceMemory]:
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT payload FROM agent_preference_memories WHERE tenant_id = ? AND user_id = ? "
                "AND deleted_at IS NULL AND expires_at > ? ORDER BY expires_at",
                (str(tenant_id), str(user_id), now),
            ).fetchall()
        return [PreferenceMemory.model_validate_json(payload) for (payload,) in rows]

    def delete_memory(self, memory_id: UUID, tenant_id: UUID, user_id: UUID) -> bool:
        deleted_at = datetime.now(timezone.utc)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM agent_preference_memories WHERE memory_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL",
                (str(memory_id), str(tenant_id), str(user_id)),
            ).fetchone()
            if not row:
                return False
            memory = PreferenceMemory.model_validate_json(row[0])
            memory.deleted_at = deleted_at
            memory.updated_at = deleted_at
            memory.value = {}
            memory.source = "deleted"
            memory.purpose = "deleted"
            memory.consent_id = "deleted"
            connection.execute(
                "UPDATE agent_preference_memories SET payload = ?, deleted_at = ? WHERE memory_id = ?",
                (memory.model_dump_json(), deleted_at.isoformat(), str(memory_id)),
            )
            self._audit(connection, tenant_id, user_id, "delete", "preference_memory", memory_id)
        return True

    def save_artifact(self, artifact: WorkspaceArtifact) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO agent_workspace_artifacts(artifact_id, tenant_id, user_id, session_id, payload, expires_at, deleted_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(artifact_id) DO UPDATE SET payload=excluded.payload, "
                "expires_at=excluded.expires_at, deleted_at=excluded.deleted_at",
                (str(artifact.artifact_id), str(artifact.tenant_id), str(artifact.user_id), str(artifact.session_id),
                 artifact.model_dump_json(), artifact.expires_at.isoformat(), artifact.deleted_at.isoformat() if artifact.deleted_at else None),
            )
            self._audit(connection, artifact.tenant_id, artifact.user_id, "upsert", "workspace_artifact", artifact.artifact_id)

    def get_artifact(self, artifact_id: UUID, tenant_id: UUID) -> WorkspaceArtifact | None:
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM agent_workspace_artifacts WHERE artifact_id = ? AND tenant_id = ? "
                "AND deleted_at IS NULL AND expires_at > ?",
                (str(artifact_id), str(tenant_id), now),
            ).fetchone()
        return WorkspaceArtifact.model_validate_json(row[0]) if row else None

    def delete_artifact(self, artifact_id: UUID, tenant_id: UUID, user_id: UUID) -> bool:
        deleted_at = datetime.now(timezone.utc)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM agent_workspace_artifacts WHERE artifact_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL",
                (str(artifact_id), str(tenant_id), str(user_id)),
            ).fetchone()
            if not row:
                return False
            artifact = WorkspaceArtifact.model_validate_json(row[0])
            artifact.deleted_at = deleted_at
            artifact.updated_at = deleted_at
            artifact.content = {}
            artifact.source = "deleted"
            artifact.purpose = "deleted"
            connection.execute(
                "UPDATE agent_workspace_artifacts SET payload = ?, deleted_at = ? WHERE artifact_id = ?",
                (artifact.model_dump_json(), deleted_at.isoformat(), str(artifact_id)),
            )
            self._audit(connection, tenant_id, user_id, "delete", "workspace_artifact", artifact_id)
        return True

    @staticmethod
    def _audit(connection: sqlite3.Connection, tenant_id: UUID, user_id: UUID, action: str, resource_type: str, resource_id: UUID) -> None:
        connection.execute(
            "INSERT INTO agent_memory_audit(tenant_id, user_id, action, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (str(tenant_id), str(user_id), action, resource_type, str(resource_id), datetime.now(timezone.utc).isoformat()),
        )

    def audit_events(self, tenant_id: UUID, user_id: UUID) -> list[dict[str, str]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT action, resource_type, resource_id, created_at FROM agent_memory_audit "
                "WHERE tenant_id = ? AND user_id = ? ORDER BY audit_id",
                (str(tenant_id), str(user_id)),
            ).fetchall()
        return [
            {"action": action, "resource_type": resource_type, "resource_id": resource_id, "created_at": created_at}
            for action, resource_type, resource_id, created_at in rows
        ]

    def purge_expired(self) -> int:
        now = datetime.now(timezone.utc)
        purged = 0
        with self._connect() as connection:
            memory_rows = connection.execute(
                "SELECT memory_id, tenant_id, user_id, payload FROM agent_preference_memories WHERE deleted_at IS NULL AND expires_at <= ?",
                (now.isoformat(),),
            ).fetchall()
            for memory_id, tenant_id, user_id, payload in memory_rows:
                memory = PreferenceMemory.model_validate_json(payload)
                memory.deleted_at = now
                memory.updated_at = now
                memory.value = {}
                memory.source = memory.purpose = memory.consent_id = "expired"
                connection.execute(
                    "UPDATE agent_preference_memories SET payload=?, deleted_at=? WHERE memory_id=?",
                    (memory.model_dump_json(), now.isoformat(), memory_id),
                )
                self._audit(connection, UUID(tenant_id), UUID(user_id), "expire", "preference_memory", UUID(memory_id))
                purged += 1
            artifact_rows = connection.execute(
                "SELECT artifact_id, tenant_id, user_id, payload FROM agent_workspace_artifacts WHERE deleted_at IS NULL AND expires_at <= ?",
                (now.isoformat(),),
            ).fetchall()
            for artifact_id, tenant_id, user_id, payload in artifact_rows:
                artifact = WorkspaceArtifact.model_validate_json(payload)
                artifact.deleted_at = now
                artifact.updated_at = now
                artifact.content = {}
                artifact.source = artifact.purpose = "expired"
                connection.execute(
                    "UPDATE agent_workspace_artifacts SET payload=?, deleted_at=? WHERE artifact_id=?",
                    (artifact.model_dump_json(), now.isoformat(), artifact_id),
                )
                self._audit(connection, UUID(tenant_id), UUID(user_id), "expire", "workspace_artifact", UUID(artifact_id))
                purged += 1
        return purged


class PostgresRunStore:
    """Shared production state store. Schema is managed by the backend migration."""

    def __init__(self, database_url: str) -> None:
        if not database_url:
            raise ValueError("AGENT_STATE_DATABASE_URL or DATABASE_URL is required")
        try:
            from psycopg_pool import ConnectionPool
        except ImportError as error:
            raise RuntimeError("psycopg-pool is required for the postgres state backend") from error
        self.database_url = database_url
        pool_max = int(os.getenv("AGENT_STATE_POOL_MAX", "10"))
        if pool_max < 1:
            raise ValueError("AGENT_STATE_POOL_MAX must be at least 1")
        self.pool = ConnectionPool(
            database_url,
            min_size=1,
            max_size=pool_max,
            timeout=5,
            open=True,
        )

    def _connect(self):
        return self.pool.connection()

    def healthcheck(self) -> bool:
        with self._connect() as connection:
            return connection.execute("SELECT 1").fetchone() == (1,)

    def save(self, run: AgentRun) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO agent_runtime_runs(run_id, tenant_id, user_id, status, payload, updated_at) "
                "VALUES (%s, %s, %s, %s, %s::jsonb, %s) ON CONFLICT(run_id) DO UPDATE SET "
                "status=excluded.status, payload=excluded.payload, updated_at=excluded.updated_at",
                (run.run_id, str(run.tenant_id), str(run.user_id), run.status.value, run.model_dump_json(), run.updated_at),
            )

    def get(self, run_id: UUID) -> AgentRun | None:
        with self._connect() as connection:
            row = connection.execute("SELECT payload FROM agent_runtime_runs WHERE run_id = %s", (run_id,)).fetchone()
        return AgentRun.model_validate_json(_decode_payload(row[0])) if row else None

    def list_runs(self) -> list[AgentRun]:
        with self._connect() as connection:
            rows = connection.execute("SELECT payload FROM agent_runtime_runs ORDER BY updated_at DESC").fetchall()
        return [AgentRun.model_validate_json(_decode_payload(payload)) for (payload,) in rows]

    def recoverable(self) -> list[AgentRun]:
        return []

    def status_counts(self) -> dict[str, int]:
        counts = {status.value: 0 for status in RunStatus}
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT status, count(*) FROM agent_runtime_runs GROUP BY status"
            ).fetchall()
        for status, count in rows:
            counts[str(status)] = int(count)
        return counts

    def save_memory(self, memory: PreferenceMemory) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO agent_preference_memories(memory_id, tenant_id, user_id, preference_key, payload, source, purpose, consent_id, expires_at) "
                "VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s) ON CONFLICT(memory_id) DO UPDATE SET payload=excluded.payload, "
                "source=excluded.source, purpose=excluded.purpose, consent_id=excluded.consent_id, expires_at=excluded.expires_at, updated_at=now()",
                (memory.memory_id, str(memory.tenant_id), str(memory.user_id), memory.preference_key, memory.model_dump_json(), memory.source, memory.purpose, memory.consent_id, memory.expires_at),
            )
            self._audit(connection, memory.tenant_id, memory.user_id, "upsert", "preference_memory", memory.memory_id)

    def list_memories(self, tenant_id: UUID, user_id: UUID) -> list[PreferenceMemory]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT payload FROM agent_preference_memories WHERE tenant_id=%s AND user_id=%s AND deleted_at IS NULL AND expires_at > now() ORDER BY expires_at",
                (str(tenant_id), str(user_id)),
            ).fetchall()
        return [PreferenceMemory.model_validate_json(_decode_payload(payload)) for (payload,) in rows]

    def delete_memory(self, memory_id: UUID, tenant_id: UUID, user_id: UUID) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM agent_preference_memories WHERE memory_id=%s AND tenant_id=%s AND user_id=%s AND deleted_at IS NULL FOR UPDATE",
                (memory_id, str(tenant_id), str(user_id)),
            ).fetchone()
            if row:
                deleted_at = datetime.now(timezone.utc)
                memory = PreferenceMemory.model_validate_json(_decode_payload(row[0]))
                memory.deleted_at = deleted_at
                memory.updated_at = deleted_at
                memory.value = {}
                memory.source = memory.purpose = memory.consent_id = "deleted"
                connection.execute(
                    "UPDATE agent_preference_memories SET payload=%s::jsonb, deleted_at=%s, updated_at=%s WHERE memory_id=%s",
                    (memory.model_dump_json(), deleted_at, deleted_at, memory_id),
                )
                self._audit(connection, tenant_id, user_id, "delete", "preference_memory", memory_id)
        return row is not None

    def save_artifact(self, artifact: WorkspaceArtifact) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO agent_workspace_artifacts(artifact_id, tenant_id, user_id, session_id, artifact_key, artifact_type, payload, source, purpose, expires_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s) ON CONFLICT(artifact_id) DO UPDATE SET payload=excluded.payload, "
                "source=excluded.source, purpose=excluded.purpose, expires_at=excluded.expires_at, updated_at=now()",
                (artifact.artifact_id, str(artifact.tenant_id), str(artifact.user_id), artifact.session_id, artifact.artifact_key,
                 artifact.artifact_type, artifact.model_dump_json(), artifact.source, artifact.purpose, artifact.expires_at),
            )
            self._audit(connection, artifact.tenant_id, artifact.user_id, "upsert", "workspace_artifact", artifact.artifact_id)

    def get_artifact(self, artifact_id: UUID, tenant_id: UUID) -> WorkspaceArtifact | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM agent_workspace_artifacts WHERE artifact_id=%s AND tenant_id=%s AND deleted_at IS NULL AND expires_at > now()",
                (artifact_id, str(tenant_id)),
            ).fetchone()
        return WorkspaceArtifact.model_validate_json(_decode_payload(row[0])) if row else None

    def delete_artifact(self, artifact_id: UUID, tenant_id: UUID, user_id: UUID) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM agent_workspace_artifacts WHERE artifact_id=%s AND tenant_id=%s AND user_id=%s AND deleted_at IS NULL FOR UPDATE",
                (artifact_id, str(tenant_id), str(user_id)),
            ).fetchone()
            if row:
                deleted_at = datetime.now(timezone.utc)
                artifact = WorkspaceArtifact.model_validate_json(_decode_payload(row[0]))
                artifact.deleted_at = deleted_at
                artifact.updated_at = deleted_at
                artifact.content = {}
                artifact.source = artifact.purpose = "deleted"
                connection.execute(
                    "UPDATE agent_workspace_artifacts SET payload=%s::jsonb, deleted_at=%s, updated_at=%s WHERE artifact_id=%s",
                    (artifact.model_dump_json(), deleted_at, deleted_at, artifact_id),
                )
                self._audit(connection, tenant_id, user_id, "delete", "workspace_artifact", artifact_id)
        return row is not None

    @staticmethod
    def _audit(connection, tenant_id: UUID, user_id: UUID, action: str, resource_type: str, resource_id: UUID) -> None:
        connection.execute(
            "INSERT INTO agent_memory_audit(tenant_id, user_id, action, resource_type, resource_id) VALUES (%s,%s,%s,%s,%s)",
            (str(tenant_id), str(user_id), action, resource_type, resource_id),
        )

    def audit_events(self, tenant_id: UUID, user_id: UUID) -> list[dict[str, str]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT action, resource_type, resource_id::text, created_at::text FROM agent_memory_audit "
                "WHERE tenant_id=%s AND user_id=%s ORDER BY audit_id",
                (str(tenant_id), str(user_id)),
            ).fetchall()
        return [
            {"action": action, "resource_type": resource_type, "resource_id": resource_id, "created_at": created_at}
            for action, resource_type, resource_id, created_at in rows
        ]

    def purge_expired(self) -> int:
        purged = 0
        with self._connect() as connection:
            memories = connection.execute(
                "SELECT memory_id, tenant_id, user_id, payload FROM agent_preference_memories WHERE deleted_at IS NULL AND expires_at <= now() FOR UPDATE"
            ).fetchall()
            for memory_id, tenant_id, user_id, payload in memories:
                memory = PreferenceMemory.model_validate_json(_decode_payload(payload))
                deleted_at = datetime.now(timezone.utc)
                memory.deleted_at = deleted_at
                memory.updated_at = deleted_at
                memory.value = {}
                memory.source = memory.purpose = memory.consent_id = "expired"
                connection.execute(
                    "UPDATE agent_preference_memories SET payload=%s::jsonb, deleted_at=%s, updated_at=%s WHERE memory_id=%s",
                    (memory.model_dump_json(), deleted_at, deleted_at, memory_id),
                )
                self._audit(connection, tenant_id, user_id, "expire", "preference_memory", memory_id)
                purged += 1
            artifacts = connection.execute(
                "SELECT artifact_id, tenant_id, user_id, payload FROM agent_workspace_artifacts WHERE deleted_at IS NULL AND expires_at <= now() FOR UPDATE"
            ).fetchall()
            for artifact_id, tenant_id, user_id, payload in artifacts:
                artifact = WorkspaceArtifact.model_validate_json(_decode_payload(payload))
                deleted_at = datetime.now(timezone.utc)
                artifact.deleted_at = deleted_at
                artifact.updated_at = deleted_at
                artifact.content = {}
                artifact.source = artifact.purpose = "expired"
                connection.execute(
                    "UPDATE agent_workspace_artifacts SET payload=%s::jsonb, deleted_at=%s, updated_at=%s WHERE artifact_id=%s",
                    (artifact.model_dump_json(), deleted_at, deleted_at, artifact_id),
                )
                self._audit(connection, tenant_id, user_id, "expire", "workspace_artifact", artifact_id)
                purged += 1
        return purged


@lru_cache(maxsize=8)
def _cached_state_store(backend: str, database_url: str, sqlite_path: str) -> AgentStateStore:
    if backend == "sqlite":
        return RunStore(sqlite_path)
    if backend == "postgres":
        return PostgresRunStore(database_url)
    raise ValueError("AGENT_STATE_BACKEND must be sqlite or postgres")


def create_state_store() -> AgentStateStore:
    backend = os.getenv("AGENT_STATE_BACKEND", "sqlite").strip().lower()
    return _cached_state_store(
        backend,
        os.getenv("AGENT_STATE_DATABASE_URL") or os.getenv("DATABASE_URL", ""),
        os.getenv("AGENT_RUN_DB", "data/agent-runs.sqlite3"),
    )
