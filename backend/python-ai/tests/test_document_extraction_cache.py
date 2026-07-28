from app.services.document_extraction_cache import (
    ExtractionCacheQuality,
    canonical_extraction_target,
    should_replace_cache,
)


def _quality(**changes):
    values = {
        "scope_complete": True,
        "sections_found": 10,
        "question_pages_processed": 12,
        "question_pages_total": 12,
        "questions_found": 45,
        "out_of_scope_count": 0,
        "failed_pages": [],
    }
    values.update(changes)
    return ExtractionCacheQuality(**values)


def test_equivalent_kurzfragen_prompts_share_canonical_target() -> None:
    assert canonical_extraction_target("all Kurzfragen") == "kurzfragen"
    assert canonical_extraction_target("every short question") == "kurzfragen"
    assert canonical_extraction_target("do not leave any Kurzfragen out") == "kurzfragen"


def test_partial_candidate_cannot_replace_complete_inventory() -> None:
    assert not should_replace_cache(
        _quality(),
        _quality(
            scope_complete=False, sections_found=0,
            question_pages_processed=0, question_pages_total=0,
            questions_found=6,
        ),
    )


def test_smaller_same_revision_inventory_cannot_replace_complete_inventory() -> None:
    assert not should_replace_cache(_quality(), _quality(questions_found=44))


def test_same_count_candidate_cannot_replace_when_exact_ids_regress() -> None:
    assert not should_replace_cache(
        _quality(), _quality(),
        current_ids={"2.1", "2.2"}, candidate_ids={"2.1", "12.20"},
    )


def test_equal_or_stronger_verified_inventory_can_be_promoted() -> None:
    assert should_replace_cache(_quality(), _quality(questions_found=46))


def test_out_of_scope_candidate_is_never_promoted() -> None:
    assert not should_replace_cache(None, _quality(out_of_scope_count=1))
