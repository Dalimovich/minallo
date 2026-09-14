"""Student-designed scenarios; execute real resolution with injected semantic outage.
No expected resolved meaning is stubbed. Prior assistant text is fixture context.
"""
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend/python-ai'))
os.environ.setdefault('SUPABASE_URL', 'https://stub.supabase.co')
os.environ.setdefault('SUPABASE_SERVICE_ROLE_KEY', 'stub')
os.environ.setdefault('OPENAI_API_KEY', 'stub')

# Scenarios are declared before importing or selecting production resolution code.
# goal, prior user, prior assistant, current user, fixture provenance, UI context, event
CASES = [
('General clarification','What is torque?','Torque measures the turning effect of force.','But I do not get it yet.','general','course','none'),
('Grounded clarification','Explain torque from my lecture','The lecture defines torque as force times lever arm.','Can you explain that another way?','grounded','course','none'),
('Grounded verification','What does my professor say about friction?','The lecture uses a constant coefficient.','Are you sure?','grounded','course','none'),
('General verification','What is 7 times 8?','It is 56.','Are you certain about that?','general','course','none'),
('Exact source','Explain torque from the lecture','Torque is introduced as a moment.','Where exactly does the professor say that?','grounded','selected','none'),
('Course unrelated topic','Explain torsion','Torsion twists a shaft.','What is the capital of Italy?','grounded','course','none'),
('PDF unrelated social','Explain this diagram','It shows a beam.','How was your day?','grounded','viewer','none'),
('PDF deictic','Explain this diagram','It shows a beam.','What does this mean?','grounded','viewer','none'),
('Selected only','Use lecture.pdf only','I will use that PDF.','Explain the stress convention using this PDF only.','grounded','selected','none'),
('Deleted selected file','Explain lecture.pdf','The diagram shows a beam.','Show me its exact page again.','grounded','selected','document_deleted'),
('Full scan','Can you help with my exam?','Yes, what should we work on?','Extract all questions in the entire exam.','general','selected','none'),
('Resume full scan','Extract every exam question','Pages 1 through 20 were processed.','Continue from where you stopped.','grounded','selected','worker_interruption'),
('General calculation','Explain speed','Speed is distance per time.','Calculate 120 divided by 3.','general','course','none'),
('Course calculation','Use my lecture assumptions','The script assumes constant acceleration.','Calculate the velocity according to my lecture.','grounded','selected','none'),
('Recommendation without course','I feel behind','We can choose a manageable next step.','What should I study first?','general','none','none'),
('Recommendation with course','I struggle in mechanics','We can focus on weak topics.','What should I study first?','grounded','course','none'),
('Flashcard confirmation','Help me learn this','I can create flashcards for these definitions.','That sounds like a good way to start.','grounded','selected','none'),
('ExamForge reopen','Generate an ExamForge exam','Your exam is saved as session-1.','Open that exact saved exam again.','grounded','course','saved_reopen'),
('Stop then next','Explain stress in detail','Stress describes internal force per area.','Actually explain strain instead.','general','course','stop'),
('Before token failure','Explain stress','Generation could not start.','Try that once more please.','general','course','before_first_token'),
('After token failure','Explain stress','Stress is force divided','Please continue that explanation.','general','course','partial_stream_failure'),
('Expired JWT','Explain my lecture','The first chapter introduces vectors.','Explain the next chapter.','grounded','course','expired_jwt'),
('Revoked session','Explain my lecture','The first chapter introduces vectors.','Can we keep going?','grounded','course','refresh_rejected'),
('Chat switch','Explain beam bending','The beam deflects under load.','What is photosynthesis?','grounded','course_b_viewer_a','switch_chat'),
('Structured model failure','Explain angular momentum','Angular momentum depends on position and momentum.','Can you put it another way?','general','course','semantic_timeout'),
('Unseen plan confirmation','I need a plan','I can make a study plan for your exam.','Sounds sensible, let us run with that.','general','course','none'),
('Same acknowledgement no offer','Hello','Hello!','Sounds sensible, let us run with that.','general','none','none'),
('Plan revision','Make me a seven day study plan','Day 1 vectors, day 2 forces, then practice.','Make it five days instead.','general','course','none'),
('Screw followup','Compare bolts and rivets','Bolts can be removed; rivets are permanent.','Same for screws.','general','course','none'),
('Choice correction','Which example?','We can do the beam or the shaft.','Not that one, the second one.','grounded','course','none'),
('Delegation','Which topic should I revise?','Would you prefer statics or dynamics?','You choose.','general','course','none'),
('Algebra followup','Why does x squared differentiate to 2x?','The exponent comes down and decreases by one.','Why?','general','course','none'),
('Wrong assumption correction','Water boils at 50 C, right?','At normal pressure it boils near 100 C.','Oh, I meant at lower pressure.','general','none','none'),
('Typo question','Explain force','Force changes motion.','cn u explane inertia real simple','general','course','none'),
('Casual slang','Explain entropy','Entropy describes the multiplicity of microscopic states.','nah im still lost lol','general','course','none'),
('German clarification','Was ist Drehmoment?','Kraft mal Hebelarm.','Ich verstehe das irgendwie noch nicht.','general','course','none'),
('Translation','Explain friction','Friction opposes relative motion.','Auf Deutsch bitte.','general','course','none'),
('Web reverify','Find current internship openings','Here are current openings from the web.','Is this still current?','web','course','none'),
('Topic after web','Find current internships','These openings were advertised today.','What is the Pythagorean theorem?','web','course','none'),
('Visible formula','Explain page 7','It contains a bending formula.','Explain this formula.','grounded','viewer','page_7_to_8'),
('Viewer close','Explain this diagram','The arrow is a force.','What does this formula mean?','grounded','viewer','viewer_closed'),
('Cheatsheet request','My exam is tomorrow','A compact review might help.','Create a cheatsheet using my selected PDF.','grounded','selected','none'),
('Deep Learn confirmation','I need depth','I can create a Deep Learn lesson.','Yes, walk me through it properly.','grounded','selected','none'),
('Professor mock exam','Help me practice','We can generate practice questions.','Make a mock exam in my professor style.','grounded','course','none'),
('Quiz malformed output','Make a quiz','The quiz could not be generated.','Try again with three questions.','grounded','selected','malformed_quiz'),
('Missing embedding','Explain my selected script','The script is selected.','According to my script, what is stiffness?','grounded','selected','embedding_unavailable'),
('No relevant chunks','Read lecture.pdf only','The selected PDF is ready.','Using this PDF only, explain quantum entanglement.','grounded','selected','zero_chunks'),
('Rename document','Explain lecture.pdf','The document defines strain.','Show the definition again.','grounded','selected','document_renamed'),
('Reload followup','Explain my lecture','The professor distinguishes static and kinetic friction.','Explain that difference more simply.','grounded','course','reload'),
('Retry source changed','Use lecture.pdf only','Retrieval temporarily failed.','Retry the same request.','grounded','selected','selection_changed_before_retry'),
]

from app.services.dialogue_state import resolve_dialogue, needs_semantic_resolution, resolve_dialogue_semantically
from app.services.grounding_contract import ViewerContext, resolve_document_access, select_processing_pipeline
from app.services.execution_router import resolve_execution_plan

traces = []
for number, (goal, prior, answer, message, provenance, ui, event) in enumerate(CASES, 1):
    mode = {'general':'general','grounded':'relevance','web':'web'}[provenance]
    turns = [{'role':'user','text':prior}, {'role':'assistant','text':answer,'groundingMode':mode,'sourceScope':{'general':'general_knowledge','grounded':'course_files','web':'internet'}[provenance]}]
    base = resolve_dialogue(message, previous_turns=turns)
    semantic = needs_semantic_resolution(message, base, turns)
    with patch('app.services.openai_client.get_openai_client', side_effect=TimeoutError('injected semantic outage')):
        resolved = resolve_dialogue_semantically(message, previous_turns=turns, base=base) if semantic else base
    viewer = ViewerContext(documentId='fixture-doc-a',visiblePage=8 if event=='page_7_to_8' else 7) if ui=='viewer' else None
    access, reason = resolve_document_access(question=message,requested=None,viewer_context=viewer)
    profile, plan = resolve_execution_plan(question=message,resolved_access=access,processing_pipeline=select_processing_pipeline(message,access),has_previous_answer=True,previous_question=prior,resolved_turn=resolved,has_course_context=ui!='none')
    traces.append({'id':f'S{number:02}', 'goal':goal,'userTurns':[prior,message], 'priorAssistantFixture':answer,'priorProvenanceFixture':provenance,'uiFixture':ui,'scenarioEventNotInjected':None if event in ('none','semantic_timeout') else event,'resolvedMeaning':resolved.to_api(),'semanticModel':'injected TimeoutError; real fallback executed' if semantic else 'not called by production gate','sourceScope':'not executed: source router and stream preflight excluded','requestedRetrievalScope':{'type':'documents','documentIds':['fixture-doc-a']} if ui=='selected' else {'type':'course'},'documentAccess':access.value,'accessReason':reason.value,'executionPlan':plan.to_api(),'toolsAndRetrievalUsed':'not executed','terminalState':'not executed','visibleAnswerOrError':'not executed','evidenceLevel':'REAL UNIT EXECUTION: dialogue, evidence, document access, execution router; synthetic prior conversation; NOT E2E'})

(ROOT/'audit/student-journeys.json').write_text(json.dumps(traces,indent=2,ensure_ascii=False),encoding='utf-8')
print(json.dumps({'journeys':len(traces),'semanticFailureInjections':sum('injected' in t['semanticModel'] for t in traces),'lanes':{lane:sum(t['executionPlan']['executionLane']==lane for t in traces) for lane in sorted({t['executionPlan']['executionLane'] for t in traces})}},indent=2))
for t in traces:
    print(t['id'], t['goal'], t['resolvedMeaning']['relation'], t['resolvedMeaning']['task_family'], t['resolvedMeaning']['evidence_requirement'],t['executionPlan']['executionLane'])
