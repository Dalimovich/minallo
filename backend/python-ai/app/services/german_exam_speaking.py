"""Generated speaking tasks only. Learner turns are evaluated separately."""
import json
from typing import Any

from ..config import get_settings
from .german_exams import ExamProfile, PartBlueprint
from .german_exam_semantic_gate import verify_semantic_full
from .german_exam_validator import hard_issues, validate_content
from .llm_json import chat_json

DISCUSSION_GUIDING_POINTS = [
    "Interpretieren Sie die Aussage.",
    "Stimmen Sie zu oder widersprechen Sie? Begründen Sie Ihre Position.",
    "Nennen Sie Gründe und konkrete Beispiele.",
    "Gehen Sie auf die Argumente Ihres Partners ein und reagieren Sie darauf.",
]


def generate_speaking_part(profile: ExamProfile, part: PartBlueprint, plan, topic: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any]]:
    # DSH's oral part is ALSO named part_id "sprechen_1" (same convention as TELC/Goethe), so this
    # check must run BEFORE the part_id=="sprechen_1" branch below — otherwise DSH would silently
    # get TELC/Goethe's presentation-topic-choice prompt instead of its own Kurzvortrag stimulus
    # shape. Routed to its own generator (german_exam_dsh_generators.py) for the same reason
    # LV/HV/WS/TP are — see that module's docstring.
    from .german_exams.dsh import TASK_TYPE_ORAL as DSH_TASK_TYPE_ORAL
    if part.task_type == DSH_TASK_TYPE_ORAL:
        from .german_exam_dsh_generators import generate_dsh_oral_part
        return generate_dsh_oral_part(profile, part, plan, topic)
    from .german_exam_productive import SPEAKING_TYPES, generate_productive
    if part.task_type in SPEAKING_TYPES:
        return generate_productive(profile, part, plan, topic)
    if part.part_id == "sprechen_1":
        shape = {"questions": [{"questionId": key, "title": "...", "taskInstructions": "..."} for key in ("a", "b")]}
        instruction = ("Exactly TWO distinct presentation topic choices. Each supports a roughly three-minute "
                       "presentation with introduction, clear structure, examples and conclusion. No model answers.")
    else:
        shape = {"quote": "...", "sourceLabel": "Generiertes Übungszitat (keine reale Quelle)", "guidingPoints": DISCUSSION_GUIDING_POINTS}
        instruction = ("ONE original debatable quotation for a six-minute discussion; no identifiable real source "
                       "or attribution. Keep sourceLabel and the four guidingPoints EXACTLY as supplied.")
    system = (f"Generate an original {profile.family} {profile.variant} C1 speaking task in German. "
              "This is exam-style solo AI simulation, not a real partner exam. University/study/general academic "
              "themes only; no specialist knowledge. Never lower the target below C1. " + instruction +
              " Return JSON only in this shape: " + json.dumps(shape, ensure_ascii=False))
    user = json.dumps({"topic": topic, "adaptation": [vars(i) for i in plan]}, ensure_ascii=False)
    for attempt in range(3):
        result = chat_json(system=system, user=user, model=get_settings().german_exam_model, max_tokens=2200)
        content = result.data
        if not isinstance(content, dict) or hard_issues(validate_content(part, content)):
            continue
        verified = verify_semantic_full(part, content)
        if verified.passed:
            return content, {"deterministicPassed": True, "semantic": {"passed": True, "regenerationCount": attempt}}
    raise ValueError("Could not generate a valid speaking task after three attempts")
