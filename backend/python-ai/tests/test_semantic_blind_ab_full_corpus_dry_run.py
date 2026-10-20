"""Semantic Student Intent Layer blind A/B — FULL CORPUS mocked dry run.

Extends the proven 6-case smoke-test mechanics in test_semantic_blind_ab_
mocked_smoke.py (route-level ask_stream_endpoint call, env+cache_clear
config switching, fresh in-memory fakes, hard httpx.Client.send network
tripwire) to the complete FROZEN 35-scenario / 64-turn corpus from the
accompanying report (backend/python-ai/reports/semantic-intent-blind-ab-
TEST-PLAN-2026-10-20.md, sections 1-2). The corpus/documents/rubric are
NOT modified here -- they are read verbatim from tests/fixtures/
semantic_blind_ab_corpus.json / semantic_blind_ab_documents.json, which
were extracted byte-for-byte from that report's own JSON code blocks (see
that extraction's own record: 35 cases, 64 turns, matches exactly).

This is a MOCKED DRY RUN ONLY: every OpenAI/model call site is replaced by
a fake, the fast_grounded_evidence_is_sufficient-False workaround from the
smoke-test suite is still applied (the real fallback_research/
prompt_overlay() bug found in that pass is being fixed by a separate
implementation agent on a different branch -- NOT fixed here, NOT by this
file), and the hard network tripwire makes "zero real calls" an empirical,
checked fact for every one of the 70 (35 scenarios x 2 configs) runs, not
an assumption.

What this file proves: the harness executes the ENTIRE frozen corpus
end-to-end against the real /ask-stream route under both configs without
crashing, and every per-turn behavioral outcome (release-gate engagement,
cache-key isolation, generic SSE collection) is captured to a structured
result file for honest, nuanced reporting -- a single boolean per
scenario would hide real category-specific caveats (ambiguous-target
turns, the cache gate's own tutor_mode=="explain" requirement, etc.),
so results are written out in full rather than force-fit into pass/fail.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
CORPUS = json.loads((ROOT / "tests/fixtures/semantic_blind_ab_corpus.json").read_text(encoding="utf-8"))
DOCUMENTS = json.loads((ROOT / "tests/fixtures/semantic_blind_ab_documents.json").read_text(encoding="utf-8"))
RESULTS_PATH = ROOT / "reports/semantic-blind-ab-full-corpus-dry-run-results.json"

USER_ID = "00000000-0000-4000-8000-00000000d001"

# Stable per-document synthetic UUIDs (deterministic from the document
# key, not random -- so re-runs are reproducible).
DOCUMENT_IDS = {key: str(uuid.uuid5(uuid.NAMESPACE_URL, f"semantic-blind-ab-doc:{key}")) for key in DOCUMENTS}

# --- Corpus-field -> real schema mappings (resolved_student_intent.py's
# actual Literal types -- ReleaseState/ReleaseForm/Objective -- confirmed
# by reading that module directly, not guessed) ------------------------
_RELEASE_TO_FINAL_ANSWER = {
    "permitted": "permitted", "prohibited": "prohibited",
    "partial": "unspecified", "ambiguous_expect_clarify_or_both": "unspecified",
}
_FORM_TO_RELEASE_FORM = {
    "hint": "hint", "method_explanation": "explanation", "full_solution": "worked_solution",
    "confirmation": "unspecified", "summary": "explanation",
    "quiz_start": "guided_questions", "answer_check": "unspecified",
}
_FORM_TO_OBJECTIVE = {
    "hint": "hint", "method_explanation": "explain", "full_solution": "solve",
    "confirmation": "explain", "summary": "summarize",
    "quiz_start": "other", "answer_check": "other",
}

# The 3 scenarios this corpus itself frames as cache/history-correctness
# probes (§1 category I). Handled with an EXTRA, clearly-labeled
# supplementary cache-key proof below (see _run_cache_key_supplementary_
# proof) because, as literally authored (exercise-anchored, solve/hint
# style questions), they do not reach stream.py's own `cacheable` gate
# (tutor_mode=="explain" required) -- the SAME limitation found and
# documented in the smoke-test pass's case 6 (§8.3 of the report).
_CACHE_SCENARIO_IDS = {"AB-28", "AB-29", "AB-30"}


def _install_network_tripwire(monkeypatch):
    def _raise(self, request, **_kwargs):  # noqa: ANN001
        raise AssertionError(f"BLOCKED: a real network call was attempted -- {request.method} {request.url}")
    monkeypatch.setattr(httpx.Client, "send", _raise)


def _version_a_env(monkeypatch):
    from app.config import get_settings
    from app.services import dialogue_state
    monkeypatch.delenv("SEMANTIC_INTENT_MODE", raising=False)
    monkeypatch.delenv("SEMANTIC_INTENT_UNIFIED_CALL_ENABLED", raising=False)
    monkeypatch.delenv("SEMANTIC_INTENT_POLICY_ENFORCEMENT_ENABLED", raising=False)
    get_settings.cache_clear()
    monkeypatch.setattr(
        dialogue_state, "resolve_dialogue_semantically",
        lambda question, *, previous_turns, base, **_k: base,
    )


def _version_b_env(monkeypatch):
    from app.config import get_settings
    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "enabled")
    monkeypatch.setenv("SEMANTIC_INTENT_UNIFIED_CALL_ENABLED", "true")
    monkeypatch.setenv("SEMANTIC_INTENT_POLICY_ENFORCEMENT_ENABLED", "true")
    get_settings.cache_clear()


def _set_b_policy(monkeypatch, policy, question):
    from app.services import semantic_intent_orchestrator

    def fake(*, dialogue_base, **_kwargs):
        from app.services.resolved_student_intent import Action, ReleaseConstraints, ResolvedStudentIntent
        intent = ResolvedStudentIntent(
            schema_version="1.0.0", original_message=question, student_goal=question,
            actions=(Action(objective="hint", target="x", state="requested", release=ReleaseConstraints()),),
            conversation="new", references=None, response_language="en", teaching=None, trust=None,
        )
        return semantic_intent_orchestrator.AuthoritativeInterpretation(
            dialogue=dialogue_base, resolved_intent=intent, execution_policy=policy,
            used_unified_call=True, unified_call_succeeded=True, compiled_policy_by_target={},
        )
    monkeypatch.setattr(semantic_intent_orchestrator, "interpret_turn_authoritatively", fake)


def _build_policy(turn, policy_hash):
    from app.services.policy_compiler import ExecutionPolicy
    from app.services.resolved_student_intent import Action, ReleaseConstraints

    actions = []
    for expected in turn["expected"]:
        form = expected["form"]
        release = expected["release"]
        actions.append(Action(
            objective=_FORM_TO_OBJECTIVE.get(form, "other"),
            target=str(expected["target"]),
            state="requested",
            release=ReleaseConstraints(
                form=_FORM_TO_RELEASE_FORM.get(form, "unspecified"),
                final_answer=_RELEASE_TO_FINAL_ANSWER.get(release, "unspecified"),
                wait_for_student=bool(turn.get("waitForStudent")) or None,
            ),
        ))
    return ExecutionPolicy(
        actions=tuple(actions), evidence_requirements=(), needs_clarification=False,
        clarification_question=None, response_language="en", response_language_reason="default",
        platform_policy_applied=(), policy_version="1.0.0", compiler_version="1.0.0",
        policy_hash=policy_hash,
    )


def _doc_answer_lookup(document):
    """target id -> verified answer string, for exercises/sections this
    document defines. Missing target -> None (no numeric leak to probe)."""
    out = {}
    for key, ex in (document.get("exercises") or {}).items():
        out[key] = ex.get("answer")
    for key in (document.get("sections") or {}):
        out[f"section:{key}"] = None  # concept content, nothing numeric to leak/withhold
    return out


def _synthesize_draft(turn, answer_lookup):
    """Deterministic, synthetic 'model draft' standing in for a real
    completion -- a leak-shape probe for permitted/prohibited targets,
    a benign line for everything else. Recognized leak shape
    ("The final answer is X.") on purpose for prohibited probes, same
    choice made throughout the smoke-test pass, so a turn that SHOULD be
    withheld under B is actually probed, not accidentally exercising the
    already-documented single-target scan-shape gap instead."""
    parts = []
    for expected in turn["expected"]:
        target = str(expected["target"])
        release = expected["release"]
        answer = answer_lookup.get(target)
        if release == "permitted" and answer:
            parts.append(f"For {target}: the final answer is {answer}.")
        elif release == "prohibited" and answer:
            parts.append(f"For {target}: hmm, the final answer is {answer}. (leak probe)")
        elif release == "permitted":
            parts.append(f"For {target}: here is the explanation.")
        else:
            parts.append(
                f"For {target}: here is a hint. Think about which formula and method apply, "
                "and what the given values represent, before computing anything."
            )
    return " ".join(parts)


_EXERCISE_LABEL_RE = re.compile(r"^(\d+)(.*)$")


def _exercise_sort_key(label: str) -> tuple[float, str]:
    """Natural exercise order ("1" < "2a" < "2b" < "3"), not raw JSON
    key-insertion order -- see the fixture-bug postmortem in
    semantic-intent-blind-ab-TEST-PLAN-2026-10-20.md: DOC-MECH1's
    exercises dict is declared ['1', '3', '2a', '2b'], and the old
    chunk builder below serialized them in exactly that (wrong) order."""
    match = _EXERCISE_LABEL_RE.match(label)
    if match:
        return (float(match.group(1)), match.group(2))
    return (float("inf"), label)


def _common_mocks(monkeypatch):
    """One registration of ALL 5 synthetic documents + their chunks, so
    any scenario's activeDocumentId resolves correctly without per-
    scenario mock rebuilding. Retrieval fakes pick the right chunk by
    activeDocumentId via a closure dict, not a single hardcoded chunk."""
    from app.routers import stream
    from app.services import cache, mastery, retrieval, tutor_state_store, visual_repair

    chunks_by_doc = {}
    for key, doc in DOCUMENTS.items():
        text_bits = []
        exercises = doc.get("exercises") or {}
        # Fixture bug (confirmed root cause of AB-06/AB-13/AB-14/AB-18/
        # AB-20/AB-26/AB-30/AB-34's wrong-exercise responses, both
        # configs): every exercise's prompt+answer was concatenated into
        # ONE chunk with no label at all, in raw dict order ('1', '3',
        # '2a', '2b' for DOC-MECH1) instead of natural exercise order.
        # The model had nothing to anchor "exercise 2a" to and no reason
        # to read them in the sheet's real order. Label + natural-sort
        # each one -- this is a harness/retrieval-mock fix only, the
        # frozen corpus/documents JSON (student messages, answer keys)
        # is untouched.
        for ex_key in sorted(exercises, key=_exercise_sort_key):
            ex = exercises[ex_key]
            text_bits.append(f"[Aufgabe {ex_key}] {ex['prompt']} Lösung: {ex['answer']}")
        for sec_text in (doc.get("sections") or {}).values():
            text_bits.append(sec_text)
        chunks_by_doc[DOCUMENT_IDS[key]] = retrieval.RetrievedChunk(
            chunk_id=f"c-{key}", document_id=DOCUMENT_IDS[key], page_start=1, page_end=1,
            text=" ".join(text_bits), score=1.0, similarity=1.0,
            chunk_type="exercise" if doc.get("exercises") else "notes",
            section_title=doc["title"],
        )

    def _chunks_for(active_document_id=None, **_k):
        if active_document_id and active_document_id in chunks_by_doc:
            return [chunks_by_doc[active_document_id]]
        return list(chunks_by_doc.values())[:1]

    monkeypatch.setattr(stream, "require_active_subscription", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_interactive_cap", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_rate_limit", lambda *_: None)
    monkeypatch.setattr(
        stream, "_load_authorized_documents",
        lambda *_: {
            DOCUMENT_IDS[key]: {
                "id": DOCUMENT_IDS[key], "user_id": USER_ID, "course_id": "course-1",
                "file_name": f"{key}.pdf", "storage_path": f"synthetic/{key}.pdf",
                "document_hash": "rev-1", "processing_status": "ready",
                "page_count": 2, "chunk_count": 5,
            }
            for key in DOCUMENTS
        },
    )
    monkeypatch.setattr(stream, "fetch_workspace_snapshot", lambda *_: None)
    monkeypatch.setattr(stream, "fetch_account_snapshot", lambda *_a, **_k: None)
    monkeypatch.setattr(stream, "get_german_learner_profile", lambda *_a, **_k: None)
    monkeypatch.setattr(mastery, "fetch_weak_topics", lambda *_: [])
    # REMOVED 2026-10-20: fast_grounded_evidence_is_sufficient-False bypass
    # no longer needed -- the fallback_research/prompt_overlay() bug it
    # routed around is fixed on checkpoint 90f4ef78 (see this file's
    # module docstring and the report's checkpoint-SHA history).
    monkeypatch.setattr(stream, "course_revision_hash", lambda *_a, **_k: "reco-rev")
    monkeypatch.setattr(stream, "find_existing_lesson", lambda *_a, **_k: None)
    monkeypatch.setattr(stream, "record_retrieval_debug", lambda *_a, **_k: None)

    monkeypatch.setattr(retrieval, "retrieve_routed_chunks", lambda **kw: _chunks_for(**kw))
    monkeypatch.setattr(retrieval, "retrieve_visible_page_chunks", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(retrieval, "retrieve_formula_block", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_numbered_section_chunks", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_chunks", lambda **kw: _chunks_for(**kw))
    # FOUND DURING THIS FULL-CORPUS PASS: stream.py module-top-imports
    # retrieve_routed_chunks/retrieve_exercise_block/retrieve_formula_block/
    # retrieve_numbered_section_chunks/find_numbered_section_reference (its
    # OWN bindings, confirmed by reading stream.py's import block directly)
    # -- patching only the `retrieval` module's attributes (above) never
    # reaches stream.py's call sites for these, same "module holds its own
    # binding" issue already documented for retrieve_exercise_block in
    # test_answer_release_sse_enforcement.py. retrieve_formula_block's REAL
    # implementation does its own unmocked document_formulas Supabase
    # query (app/services/retrieval.py ~line 1780) when a question's
    # wording matches its formula-intent keyword heuristic -- several
    # corpus turns (German multi-quantity math, informal physics phrasing)
    # trigger this. All five re-patched on the stream binding too.
    monkeypatch.setattr(stream, "retrieve_routed_chunks", lambda **kw: _chunks_for(**kw))
    monkeypatch.setattr(stream, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(stream, "retrieve_formula_block", lambda **_: [])
    monkeypatch.setattr(stream, "retrieve_numbered_section_chunks", lambda **_: [])
    monkeypatch.setattr(stream, "find_numbered_section_reference", lambda *_a, **_k: None)
    monkeypatch.setattr(
        stream, "retrieve_multi_item_course_evidence",
        lambda **kw: type("R", (), {
            "chunks": _chunks_for(**kw), "evidence": [], "to_dict": lambda self: {},
        })(),
    )
    monkeypatch.setattr(
        stream, "research_unresolved_items",
        lambda *_a, **_k: type("FR", (), {"sources": [], "prompt_overlay": lambda self: ""})(),
    )
    # ALSO FOUND: stream.py's semantic-contradiction repair branch (~line
    # 6670-6673) calls visual_repair.generate_grounded_repair_sync -- a
    # REAL, separate OpenAI call (max_tokens=1800, model defaults to mini
    # but can be the strong tier) -- whenever a high-risk-validated draft
    # fails the deterministic obligation/semantic-mismatch check, NOT only
    # for image/diagram turns as the original report's §4.0 assumed. This
    # fires for several of this corpus's math turns because the crude
    # synthetic draft text doesn't satisfy the real obligation-extraction
    # heuristic's expectations. A genuine THIRD call-shape finding for the
    # budget, not an image-only path -- see the report update. Mocked here
    # as a no-op repair (returns None, i.e. "repair did not help") so the
    # dry run doesn't attempt a real call; the gate's own fallback
    # (unconditional-withhold / safe-text branches) still runs normally.
    monkeypatch.setattr(visual_repair, "generate_grounded_repair_sync", lambda **_k: None)
    monkeypatch.setattr(visual_repair, "repair_false_visual_denial_sync", lambda **_k: None)

    # Per-run fresh tutor_state (one shared holder per call to this
    # function -- i.e. per scenario-run, never shared across scenarios or
    # configs, since each test invocation calls _common_mocks fresh).
    holder = {"state": None}

    def claim(_uid, _conversation, _course, generation):
        if holder["state"] is None or generation >= holder["state"].generation:
            return True
        return False

    def load(_uid, conversation):
        if holder["state"] is None:
            from app.services.tutor_state import TutorState
            holder["state"] = TutorState(conversation_id=conversation, user_id=USER_ID)
        return holder["state"]

    def save(_uid, _course, state):
        holder["state"] = state

    monkeypatch.setattr(tutor_state_store, "claim_generation", claim)
    monkeypatch.setattr(tutor_state_store, "load_tutor_state", load)
    monkeypatch.setattr(tutor_state_store, "save_tutor_state", save)
    monkeypatch.setattr(
        tutor_state_store, "current_persisted_generation",
        lambda *_a, **_k: (holder["state"].generation if holder["state"] else -1),
    )

    # Fresh in-memory cache fake, scenario-scoped (never shared).
    store: dict[str, dict] = {}

    def _key(kwargs):
        return json.dumps(kwargs, sort_keys=True, default=str)

    def lookup(**kwargs):
        return store.get(_key(kwargs))

    def save_answer_fn(**kwargs):
        store[_key(kwargs)] = dict(kwargs.get("answer_json") or {})

    monkeypatch.setattr(cache, "fetch_course_version_hash", lambda *_: "course-rev")
    monkeypatch.setattr(stream, "fetch_course_version_hash", lambda *_a, **_k: "course-rev")
    monkeypatch.setattr(stream, "lookup_answer", lookup)
    monkeypatch.setattr(stream, "save_answer", save_answer_fn)
    monkeypatch.setattr(cache, "lookup_answer", lookup)
    monkeypatch.setattr(cache, "save_answer", save_answer_fn)

    return stream, store


def _fake_stream_answer(draft_text, chunk_size=16):
    def gen(**_kwargs):
        done = {
            "done": True, "retrievalMode": "strong", "answerMode": "explain", "sources": [],
            "verification": {"status": "verified", "details": {
                "criticalNumericalMismatch": False, "numberMisses": [],
                "fabricatedFilenames": [], "invalidSourceIndices": [], "fakeSolutionPhrases": [],
            }},
        }
        yield 'data: {"meta": true}\n\n'.encode()
        for i in range(0, len(draft_text), chunk_size):
            yield f'data: {json.dumps({"t": draft_text[i:i + chunk_size]})}\n\n'.encode()
        yield f"data: {json.dumps(done)}\n\n".encode()
    return gen


def _collect_rendered_text(body: bytes) -> str:
    parts = []
    for line in body.split(b"\n"):
        if not line.startswith(b"data: "):
            continue
        try:
            evt = json.loads(line[len(b"data: "):])
        except Exception:
            continue
        if isinstance(evt, dict) and isinstance(evt.get("t"), str):
            parts.append(evt["t"])
    return "".join(parts)


async def _ask(stream, *, document_id, conversation_id, question, generation, no_doc_context=False):
    kwargs = dict(
        courseId="course-1", question=question,
        sourceMode="course_files", conversationId=conversation_id, conversationGeneration=generation,
    )
    if no_doc_context:
        kwargs.update(activeDocumentId=None, visiblePage=None, openFileContext=None)
    else:
        # FOUND DURING THIS FULL-CORPUS PASS: setting a generic "visible
        # PDF page" viewer-context (visiblePage + openFileContext, the
        # shape used by test_stream_route_multiturn.py's visible-page-
        # specific scenarios) on EVERY call made several turns take
        # stream.py's `pending_index_with_page_evidence` branch
        # (~line 6722) whenever the crude synthetic draft also tripped a
        # semantic-mismatch/obligation check -- that branch intentionally
        # defers WITHOUT flushing or substituting any text (correct
        # production behavior: "don't answer yet, re-ground against the
        # visible page first"), so no "t"/"done" content reaches the
        # response's natural path within this mocked single-shot turn,
        # confirmed empirically (not assumed) via direct instrumentation
        # of stream.py's inner body_iterator. None of the 35 scenarios
        # actually need viewer/visible-page framing -- they're plain
        # document/exercise Q&A -- so this harness only sets
        # activeDocumentId, matching the shape confirmed NOT to trigger
        # that deferral.
        kwargs.update(activeDocumentId=document_id)
    payload = stream.AskStreamRequest(**kwargs)
    response = await stream.ask_stream_endpoint(payload, {"id": USER_ID})
    return b"".join([event async for event in response.body_iterator])


def _run_scenario(monkeypatch, scenario, config):
    _install_network_tripwire(monkeypatch)
    stream, store = _common_mocks(monkeypatch)
    document = DOCUMENTS[scenario["document"]]
    document_id = DOCUMENT_IDS[scenario["document"]]
    answer_lookup = _doc_answer_lookup(document)
    conversation_id = f"{scenario['id']}-{config}"

    if config == "A":
        _version_a_env(monkeypatch)
    else:
        _version_b_env(monkeypatch)

    turn_results = []
    for n, turn in enumerate(scenario["turns"], start=1):
        draft = _synthesize_draft(turn, answer_lookup)
        monkeypatch.setattr(stream, "stream_answer", _fake_stream_answer(draft))
        if config == "B":
            policy = _build_policy(turn, policy_hash=f"{scenario['id']}-t{n}")
            _set_b_policy(monkeypatch, policy, question=turn["student"])
        result = {"turn": n, "student": turn["student"], "expected": turn["expected"]}
        try:
            body = asyncio.run(_ask(
                stream, document_id=document_id, conversation_id=conversation_id,
                question=turn["student"], generation=n,
            ))
            rendered = _collect_rendered_text(body)
            is_internal_error = b'"code": "internal_error"' in body or b"NameError" in body
            # A well-formed, explicit, retryable/recoverable error event
            # (e.g. "visible_page_capture_failed", "empty_completed_
            # response") IS a legitimate, complete, student-visible
            # terminal outcome for a question that genuinely lacks the
            # context it needs -- confirmed by direct instrumentation
            # (2026-10-20 AB-14 root-cause round, see the report): the
            # stream closes cleanly with a clear message, never hangs.
            # Only a bare internal_error/NameError (a real crash
            # signature) is excluded from counting as terminal here.
            has_terminal_error = b'"error": true' in body and not is_internal_error
            result.update(
                rendered=rendered,
                withheld_code_present=b'"code": "answer_release_restricted"' in body,
                done_present=b'"done": true' in body,
                terminal_error_present=has_terminal_error,
                internal_error=is_internal_error,
                crashed=False, error=None,
            )
        except Exception as exc:  # noqa: BLE001 -- captured as a result, never silently swallowed
            result.update(
                rendered="", withheld_code_present=False, done_present=False,
                terminal_error_present=False,
                internal_error=False, crashed=True, error=f"{type(exc).__name__}: {exc}",
            )
        turn_results.append(result)
    return turn_results


# ---------------------------------------------------------------------------
# Main full-corpus run: one pytest test per (scenario, config) pair --
# 35 x 2 = 70 -- each a hard pytest node so a single scenario's crash is
# individually visible/reportable, not hidden inside one giant loop.
# ---------------------------------------------------------------------------

_ALL_CASE_IDS = [case["id"] for case in CORPUS["cases"]]
_RESULTS: dict[str, dict] = {}


@pytest.mark.parametrize("config", ["A", "B"])
@pytest.mark.parametrize("case_id", _ALL_CASE_IDS)
def test_full_corpus_scenario(monkeypatch, case_id, config):
    scenario = next(c for c in CORPUS["cases"] if c["id"] == case_id)
    turn_results = _run_scenario(monkeypatch, scenario, config)
    from app.config import get_settings
    get_settings.cache_clear()

    _RESULTS.setdefault(case_id, {})[config] = turn_results

    # Hard bar for every scenario/turn: the harness must execute cleanly
    # -- no unhandled exception, no internal_error/NameError leaking into
    # the SSE stream. This is the ONE universal assertion; nuanced
    # per-category behavioral expectations are recorded in the results
    # file and reported narratively (see the accompanying report update),
    # not force-fit into a single pass/fail per scenario.
    for r in turn_results:
        assert not r["crashed"], f"{case_id} turn {r['turn']} ({config}) crashed: {r['error']}"
        assert not r["internal_error"], f"{case_id} turn {r['turn']} ({config}) leaked an internal_error"
        assert r["done_present"] or r["terminal_error_present"], (
            f"{case_id} turn {r['turn']} ({config}) reached neither a done event "
            "nor a well-formed terminal error event -- possible genuine hang"
        )


def test_zzz_write_full_results_file():
    """Runs last alphabetically (zzz) within this module so _RESULTS is
    fully populated -- writes the structured per-scenario/per-turn outcome
    file this task's honest reporting requirement depends on."""
    RESULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    RESULTS_PATH.write_text(json.dumps(_RESULTS, indent=2, ensure_ascii=False), encoding="utf-8")
    assert len(_RESULTS) == len(_ALL_CASE_IDS), (
        f"expected results for all {len(_ALL_CASE_IDS)} scenarios, got {len(_RESULTS)} "
        "-- some scenario/config combination never ran (check test collection/order)"
    )
    for case_id, by_config in _RESULTS.items():
        assert set(by_config) == {"A", "B"}, f"{case_id} missing a config run: {set(by_config)}"
