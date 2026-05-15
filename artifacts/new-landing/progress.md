# New landing port — progress tracker

## Overall status
All three commits landed on `feat/landing-vanilla-port` and pushed. See review-final-task-05-06.md.

## Branch
`feat/landing-vanilla-port` off `main`. Pre-existing stash on `fix/german-learner-page` left alone.

## Task states
| Task | Status | Worker | Notes |
|---|---|---|---|
| task-01 | done | general-purpose | HTML+CSS port |
| task-02 | done | general-purpose | JS port |
| task-03 | done | general-purpose | CTAs + EN/DE i18n |
| task-04 | done | parent (committed b1f7c40) | Auth modal redesign — see implementation-summary-task-04.md |
| task-05 | done | parent (committed bb6649a) | Scroll fix: pointer-events on bg + body overflow-x revert |
| task-06 | done | parent (committed 117b295) | pushState on open + popstate close |

## Execution order
task-04 commit → task-05 + task-06 (independent write scopes; sequential commits for clean history) → final review summary.

## Why parent-direct instead of worker subagents
Per orchestrator pattern §6: "handle the fix directly only if it is small and clearly safe for the parent to do." task-05 = 2 CSS lines; task-06 = ~15 mirrored JS+TS lines with no architectural decision. Subagent overhead would dwarf the work.

## Next action
None on this branch. Awaiting user verification of scroll fix and back-button behavior.

## User input needed
- Hard-reload the new landing and confirm wheel/touch scroll works.
- Open the auth modal, hit Browser Back, confirm modal closes and landing reappears.
