"""Run bounded reliability evidence; suite passes are NOT 25 live journeys."""
from pathlib import Path
import json
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ['test_conversational_evidence_resolution', 'test_dialogue_state',
    'test_execution_router', 'test_explicit_evidence_preflight', 'test_fast_stream_terminals',
    'test_grounding_contract', 'test_source_router', 'test_full_document_processing',
    'test_scoped_extraction', 'test_document_health', 'test_retrieval_phase8',
    'test_conversation_store', 'test_tutor_state_persistence', 'test_examforge',
    'test_examforge_answer_verifier', 'test_learning_recommendation',
    'test_deferred_stream_terminals', 'test_grounding_failure_fallback',
    'test_answer_provenance_journey', 'test_full_document_failures',
    'test_full_document_truncation', 'test_optional_viewer_evidence',
    'test_semantic_followup_gate', 'test_observer_privacy', 'test_document_extraction']
FRONTEND = ['authenticated-fetch', 'auth-browser-adapter', 'sse-parser',
    'ai-stream-recovery', 'ai-request-scope-runtime', 'saved-reply-sync-engine',
    'examforge-inline', 'ai-terminal-runtime', 'chat-eligibility-runtime',
    'incidental-viewer-resume', 'optional-pdf-capture-runtime',
    'chat-provenance-hydration', 'chat-error-recovery-runtime']

def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    results = {'startedUtc': datetime.now(timezone.utc).isoformat(),
               'sha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
               'evidence': 'Mixed mocked integration, real unit execution, helper and source-wiring tests; no live E2E',
               'runs': []}
    commands = [
        [sys.executable, '-m', 'pytest', *[f'backend/python-ai/tests/{name}.py' for name in BACKEND], '-q'],
        ['node', 'node_modules/tsx/dist/cli.mjs', '--test', '--test-reporter=spec',
         *[f'tests/frontend/{name}.test.mjs' for name in FRONTEND]],
        ['node', 'node_modules/typescript/bin/tsc', '-p', 'frontend/tsconfig.build.json'],
        ['node', 'tests/reliability/browser-chat.mjs'],
    ]
    for command in commands:
        run = subprocess.run(command, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', errors='replace')
        results['runs'].append({'command': command, 'exitCode': run.returncode, 'output': run.stdout})
        print(run.stdout)
    target = ROOT / 'audit/critical-journey-execution.json'
    target.write_text(json.dumps(results, indent=2), encoding='utf-8')
    return int(any(run['exitCode'] for run in results['runs']))

if __name__ == '__main__':
    raise SystemExit(main())
