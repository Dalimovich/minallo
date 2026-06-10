"""Load test for the Minallo AI service — Phase 0 of the scaling initiative.

Goal: find the real tip-over (threadpool saturation vs OpenAI quota vs memory)
so the remaining Phase-2b items (async streaming, job+poll, TPM governor,
machine count) are driven by numbers, not guesses.

Run (install first: `pip install locust`):

    BASE_URL=https://python-ai.fly.dev \
    INTERNAL_TOKEN=<INTERNAL_SECRET> \
    SUPA_JWT=<a real Supabase user JWT> \
    COURSE_ID=<a course with indexed docs> \
    locust -f scripts/loadtest/locustfile.py --headless \
           -u 100 -r 10 -t 3m --host $BASE_URL

While it runs, watch saturation on BOTH workers:

    watch -n2 'curl -s -H "X-Internal-Token: $INTERNAL_TOKEN" \
              $BASE_URL/internal/metrics'

Read `threadpool.borrowed` approaching `threadpool.total` (64) and
`llmFanout.in_use` approaching `llmFanout.limit` — whichever pins first is the
bottleneck to attack next.

Tasks that need a JWT/course are skipped automatically if those env vars are
absent, so the file is runnable as a pure liveness probe with no secrets.
"""

from __future__ import annotations

import os

from locust import HttpUser, between, task

_INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "")
_JWT = os.environ.get("SUPA_JWT", "")
_COURSE_ID = os.environ.get("COURSE_ID", "")


class AiUser(HttpUser):
    # Think-time between a user's requests; keep modest so we actually push load.
    wait_time = between(1, 3)

    @task(3)
    def health(self):
        self.client.get("/health", name="GET /health")

    @task(1)
    def metrics(self):
        if not _INTERNAL_TOKEN:
            return
        self.client.get(
            "/internal/metrics",
            headers={"X-Internal-Token": _INTERNAL_TOKEN},
            name="GET /internal/metrics",
        )

    @task(6)
    def ask_stream(self):
        """The long-lived hot path — each open stream borrows a threadpool
        thread for its full duration, so this is what saturates first."""
        if not (_JWT and _COURSE_ID):
            return
        with self.client.post(
            "/ask-stream",
            headers={"Authorization": f"Bearer {_JWT}", "Accept": "text/event-stream"},
            json={
                "courseId": _COURSE_ID,
                "question": "Give me a one-paragraph summary of the key concepts.",
            },
            name="POST /ask-stream",
            stream=True,
            catch_response=True,
        ) as resp:
            # Drain the SSE body so we measure full stream duration, not just TTFB.
            try:
                for _ in resp.iter_lines():
                    pass
                resp.success()
            except Exception as exc:  # noqa: BLE001
                resp.failure(str(exc))
