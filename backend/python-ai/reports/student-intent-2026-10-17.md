# Student intent evaluation

Initial diagnostic sample, not production accuracy proof.
Model lane invokes production classification directly. Effective lane replays through its gate.
Injected failures excluded from accuracy/latency totals. Known gaps reported as failures.

```json
{
  "model": {
    "primary_task_accuracy": 0.5714285714285714,
    "prohibited_tasks_accuracy": 0.9047619047619048,
    "depth_accuracy": 0.8571428571428571,
    "visual_requirement_accuracy": 0.9523809523809523,
    "needs_clarification_accuracy": 0.9523809523809523,
    "scope_accuracy": 0.9523809523809523,
    "n": 21,
    "prohibition_recall": 0.5,
    "prohibition_precision": 1.0,
    "all_fields_pass": 9
  },
  "effective": {
    "primary_task_accuracy": 0.9047619047619048,
    "prohibited_tasks_accuracy": 0.9523809523809523,
    "depth_accuracy": 0.9047619047619048,
    "visual_requirement_accuracy": 1.0,
    "needs_clarification_accuracy": 1.0,
    "scope_accuracy": 1.0,
    "n": 21,
    "prohibition_recall": 0.75,
    "prohibition_precision": 1.0,
    "all_fields_pass": 16
  },
  "http_attempts": 21,
  "sdk_retries": 0,
  "model_invocations": 21,
  "prompt_tokens": 10725,
  "completion_tokens": 1080,
  "unknown_usage_attempts": 0,
  "estimated_usd": 0.00225675,
  "conservative_usd_including_unknown": 0.00225675,
  "reserved_usd": 0.405468,
  "latency_mean_ms": 1166.3839142849956,
  "latency_median_ms": 947.0163999940269,
  "latency_p95_ms": 1356.5224999983911,
  "structured_output_rate": 0.9523809523809523,
  "escalation_frequency": 0.2857142857142857,
  "fallback_rate": 0.047619047619047616
}
```

| Case | Effective source | Result | Mismatched fields |
|---|---|---|---|
| historical-bwl-page6 | semantic_model | FAIL | prohibited_tasks |
| negative-instruction-quiz | semantic_model | FAIL | primary_task |
| positive-summary-request | deterministic | FAIL | depth |
| summarize-task | deterministic | FAIL | depth |
| contradictory-instruction | fallback | PASS |  |
| german-negative-instruction | semantic_model | PASS |  |
| english-plain-question | deterministic | PASS |  |
| mixed-language-code-switch | semantic_model | PASS |  |
| follow-up-why | deterministic | PASS |  |
| correction | semantic_model | FAIL | primary_task |
| malformed-model-output | fallback | PASS |  |
| timeout | fallback | FAIL | depth |
| diagram-reference | deterministic | PASS |  |
| page-reference | deterministic | PASS |  |
| quiz-request | deterministic | PASS |  |
| quiz-answer-hiding-known-gap | deterministic | FAIL |  |
| hint-request | deterministic | PASS |  |
| solve-request | deterministic | PASS |  |
| explain-request | deterministic | PASS |  |
| compare-request | deterministic | PASS |  |
| missing-context-deictic | deterministic | PASS |  |
| missing-context-resolved-via-visible-context | deterministic | PASS |  |
| ordinal-deictic-false-positive-known-gap | deterministic | FAIL |  |
