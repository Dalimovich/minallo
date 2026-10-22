# Audit probes

These are investigation artifacts, not the permanent regression entrypoint. Some probes deliberately assert baseline defects and therefore fail after the corresponding fix. Reports in `../findings/` identify their original results and dates.

Use `tests/reliability/run.py` from the repository root for current required-behavior regressions. The permanent browser harness is `tests/reliability/browser-chat.mjs`. Generated logs, screenshots and runtime traces are local evidence and are not deployment proof.
