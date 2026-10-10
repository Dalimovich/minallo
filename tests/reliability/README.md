# Reliability regression selection

From the repository root, using the backend virtual environment:

```powershell
backend/python-ai/.venv/Scripts/python.exe tests/reliability/run.py
```

On Unix use `backend/python-ai/.venv/bin/python`. Install the repository dependencies and Playwright Chromium first. The runner selects backend and frontend regressions, compiles the frontend, and runs eight browser scenarios against a local fixture server. It returns nonzero if any command fails and writes `audit/critical-journey-execution.json`.

The browser exercises the actual chat shell and browser storage: send, empty completion, retry, partial disconnect, reload, Stop, next prompt, and switching chats during delayed submission. Its authentication, backend and model responses are synthetic. Browser observations are written to `audit/repros/browser-results.json`.

This suite contains integration, unit and source-wiring tests. It does **not** represent 25 successful live journeys. See [the 25-journey coverage matrix](../../audit/critical-journey-coverage.md) for exact anchors and missing assertions, and [failure injections](../../audit/failure-injection-matrix.md) for boundary coverage. Missing full journeys are not represented by passing placeholders.
