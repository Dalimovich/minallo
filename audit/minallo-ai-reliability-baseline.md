# Minallo AI reliability baseline

Date: 2026-09-09. Recorded before production edits.

- Fetched `origin/main` successfully.
- HEAD and origin/main: `1ecddd6b1beaa19a1c633160ef651c2fbd78511f`.
- Existing WIP: `.claude/scheduled_tasks.lock` (modified; excluded from this audit).
- Frontend/Node: `npm test`: **568 passed**, zero failed (includes frontend and backend Node tests).
- Python backend: `backend/python-ai/.venv/Scripts/python.exe -m pytest backend/python-ai/tests -q`: **1563 passed, 8 skipped**, three dependency deprecation warnings.
- Typecheck: `npm run typecheck`: **passed** (backend, frontend, Pages).
- Build: `npm run build`: **passed**.
- Frontend lint: `npm run lint`: **passed**.
- Python static analysis: `python -m ruff check app tests`: **failed**, three pre-existing unused imports in `tests/test_conversational_evidence_resolution.py`.
- Python typecheck: `python -m pyright`: **passed**, zero errors/warnings, using the repository's deliberately restricted basic configuration.
- Known failing tests: none in the executed suites. Skips and unexecuted/live coverage are not counted as passes.
- Browser/live E2E: not yet executed. Existing Playwright setup requires E2E_EMAIL/E2E_PASSWORD; neither is present in process environment. Existing chatbot spec stubs AI responses, so it does not establish live model/retrieval reliability.

Raw outputs: `baseline-frontend.log`, `baseline-backend.log`, `baseline-typecheck.log`, `baseline-build.log`, `baseline-lint.log`, `baseline-ruff.log`, `baseline-pyright.log` beside this report (local artifacts).

Investigation is read-only for production code. Three concurrent investigators cover nine requested roles; the coordinator covers error contracts, adversarial journeys, and test quality. Consolidation precedes all production fixes, which are serialized by the coordinator.
