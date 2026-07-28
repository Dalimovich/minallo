from app.services.explicit_questions import detect_explicit_questions
from app.services.multi_item_retrieval import analyse_request
from app.services.reference_resolution import decide_evidence, resolve_question_reference


EXACT_REQUEST = """Wie können Umformverfahren eingeteilt werden (drei Gruppen)?
Wie kann das Umformen nach der DIN 8582 bzw. dem Spannungszustand eingeteilt werden?
Was kann beim Gesenkschmieden unterschieden werden?
Nennen Sie drei Vorteile des Verzahnungswalzens.
Nennen Sie die sechs Hauptgruppen des Trennens nach der DIN 8580.
Welche beiden Schneidenarten werden beim Trennen unterschieden? Nennen Sie je ein Beispiel.
Wie setzt sich die Schweißbarkeit eines Bauteils zusammen? (Schweißdreieck)
Nennen Sie zwei Beschichtungsgruppen nach der DIN 8580.
Nennen Sie zwei Vor- und zwei Nachteile der Stereolithographie.
Was sind die drei Zonen einer Standard-3-Zonen-Schnecke?
I want the answers to all of these questions from the course files. in detail please and explained. The terms should be in german so don't screw this up. I want these questions to be answered and none other"""


def test_verbatim_request_has_ten_self_contained_questions_and_exact_scope():
    detected = detect_explicit_questions(EXACT_REQUEST)
    manifest = analyse_request(EXACT_REQUEST)
    assert detected.question_count == 10
    assert detected.self_contained is True
    assert detected.contains_visual_reference is False
    assert detected.exact_scope is True
    assert len(manifest.requested_items) == 10
    assert manifest.language == "de"


def test_passive_pdf_and_stale_selection_cannot_trigger_marked_question_fallback():
    reference = resolve_question_reference(
        question=EXACT_REQUEST,
        course_id="course", active_document_id="doc", active_document_name="lecture.pdf",
        visible_page=6, selected_text=None, selected_region_id=None,
        visible_text="Unrelated current page", has_visible_image=False,
    )
    decision = decide_evidence(reference, question=EXACT_REQUEST, has_history=True)
    assert decision.can_answer is True
    assert decision.action == "answer"
    assert decision.recovery_code != "exact_question_not_resolved"


def test_real_marked_question_request_still_requires_visual_resolution():
    question = "Explain this marked question"
    detected = detect_explicit_questions(question)
    reference = resolve_question_reference(
        question=question, course_id="course", active_document_id=None,
        active_document_name=None, visible_page=None, selected_text=None,
        selected_region_id=None, visible_text=None, has_visible_image=False,
    )
    decision = decide_evidence(reference, question=question, has_history=False)
    assert detected.question_count == 0
    assert detected.contains_visual_reference is True
    assert decision.can_answer is False
    assert decision.recovery_code == "exact_question_not_resolved"
