# Frontend chat state audit

Audited SHA: 1ecddd6b1beaa19a1c633160ef651c2fbd78511f. Production unchanged.

## Finding STATE-01
### Severity
P0
### User scenario
In Chat A select course-file-only PDF A and ask a question. While PDF snapshot/durable preparation is pending, switch to Chat B configured Internet/all course files. A continues preparing in background.
### Expected
A retains source mode, selected scope and PDF from its submitted immutable request.
### Actual
A request reads B's live sourceMode/courseFileScope after asynchronous work: payload retains course-a but sourceMode becomes internet, courseFileScope becomes all_course_files, and original documentIds top-level field is omitted. Explicit grounded intent can be routed as web; requestSnapshot still records the contradictory original course-files mode.
### Evidence
Executed `node --import tsx audit/repros/stream-network.mjs`. Real production streamFromAskStream extracted through TS AST; snapshot capture stub switches live selection getters before resolving. Payload assertions prove mixed A identity/B source mode. No browser/live backend claim.
### Root cause
Request transport reads mutable global active-chat settings rather than captured requestSnapshot. Request snapshot exists but is not authoritative at the transport boundary.
### Files
frontend/js/features/chatbot-new/shell.ts: streamFromAskStream 3379 capture await, 3420 courseFileScopeForActiveChat, 3484 sourceModeForActiveChat; streamAiReply awaits durable conversation and follow-up document before calling transport.
### Structural fix
Capture explicit request scope before any await and pass it through all routing/transport steps; transport uses that immutable snapshot. Revalidate captured PDF identity if viewer changes while snapshot capture runs. Retry/regenerate must not temporarily mutate activeChat to implement request scope.
### Regression test
Real function request/payload execution with controlled delayed capture and chat switch; assert exact origin course, mode, retrieval scope, document access, IDs and snapshot. Extend to delayed durable creation without PDF and a switch back while both chats generate.
### Related findings
Retry/regenerate temporarily overwrite chat's settings for the whole async request and restore old values in finally (8746-8762, 9188-9210). Student selecting new sources during generation can have their new selection overwritten at completion. Same immutable-request root cause; source-only proof of assignment ordering.

## Other state review
Origin chat message array is captured, and in-flight rows are keyed by chat; finalizers compare controller identity, reducing cross-chat answer/composer clobber risk. compactMessageForStorage preserves requestSnapshot and provenance metadata. Reload recovery functions exist but tests mainly assert source strings. No authenticated browser journeys/reload persistence injection were executed. SSE-01 in stream-lifecycle.md demonstrates received text can be discarded before persistence on native transport failure. Empty/error and scoped-job recovery deserve executable store-owner coverage rather than wiring assertions.
