"""A fully synthetic, in-memory, server-owned conversation store for
evaluating Milestone 4's real multi-turn restriction persistence
(2026-10-24 correction) -- Arm B previously passed ``conversation_id=None``
to ``interpret_turn_authoritatively``, which made every turn history-free
and could not exercise the exact mechanism that distinguishes Milestone 4
from the legacy path: ``semantic_intent_orchestrator._reconstruct_
persisted_target_actions`` reconstructing a prior turn's compiled
restriction from ``ai_tutor_requests.request_snapshot["policyByTarget"]``
(written by ``policy_compiler.extract_persistable_restrictions``).

This is NOT client-supplied history standing in for verified history --
it plays the same ROLE the real Supabase-backed ``conversation_store.py``
plays (an authenticated server owns the rows; ``validate_ownership``
checks the real caller's ``user_id`` against them; ``get_messages`` never
trusts anything the client sent) using an in-memory dict instead of a
database, so the eval harness can exercise the SAME persistence contract
``interpret_turn_authoritatively`` actually calls, without a live Supabase
dependency. Every row's ``request_snapshot`` is populated from a REAL
``ExecutionPolicy`` this harness itself just compiled for an earlier
turn -- never fabricated, never gold-derived.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.services.policy_compiler import ExecutionPolicy, extract_persistable_restrictions


@dataclass
class FakeConversationStore:
    """One store instance per eval run (not per scenario) -- each
    scenario gets its OWN conversation_id via ``create_conversation``, so
    scenarios never see each other's history, matching real production's
    per-conversation isolation."""

    _rows_by_conversation: dict[str, list[dict]] = field(default_factory=dict)
    _owner_by_conversation: dict[str, str] = field(default_factory=dict)
    _next_id: int = 0

    def create_conversation(self, *, user_id: str) -> str:
        self._next_id += 1
        conversation_id = f"eval-conv-{self._next_id:04d}"
        self._rows_by_conversation[conversation_id] = []
        self._owner_by_conversation[conversation_id] = user_id
        return conversation_id

    def validate_ownership(self, *, user_id: str, conversation_id: str) -> bool:
        """Matches conversation_store.validate_durable_conversation's real
        contract: True only if this conversation exists AND is owned by
        this exact user_id -- never True for an unknown id, never True
        for a real id owned by someone else."""
        return self._owner_by_conversation.get(conversation_id) == user_id

    def get_messages(self, *, user_id: str, conversation_id: str) -> list[dict]:
        """Returns [] for an unowned/unknown conversation rather than
        raising -- matches real production's get_durable_conversation_
        messages, which the orchestrator's own try/except around it
        already treats as "unavailable", not "history_free" (see
        diagnostic_policy.build_turn_ledger_from_durable_store)."""
        if not self.validate_ownership(user_id=user_id, conversation_id=conversation_id):
            return []
        return list(self._rows_by_conversation[conversation_id])

    def append_turn(self, *, conversation_id: str, turn_n: int, execution_policy: ExecutionPolicy) -> None:
        """Call once per turn, AFTER interpret_turn_authoritatively has
        compiled this turn's real ExecutionPolicy -- persists exactly
        what stream.py's own comment says production writes: extract_
        persistable_restrictions(execution_policy) into this turn's
        request_snapshot, nothing fabricated."""
        self._rows_by_conversation[conversation_id].append({
            "client_message_id": f"turn-{turn_n}",
            "request_snapshot": {"policyByTarget": extract_persistable_restrictions(execution_policy)},
        })

    def missing_history_conversation_id(self) -> str:
        """A conversation_id that looks durable (non-empty, well-formed)
        but was never created here -- for testing the "missing-history"
        degrade path (build_authoritative_turn_ledger's validate_
        ownership returning False, never a client-history fallback)."""
        return "eval-conv-never-created"
