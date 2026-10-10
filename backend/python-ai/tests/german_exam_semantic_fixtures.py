"""Small, intentionally flawed content excerpts for verifier contract tests.

These isolate semantic faults; the live runner injects faults into full parts.
"""
from copy import deepcopy


def bad_content(part_id: str, code: str) -> dict:
    segments = [
        {"id": "s1", "speakerId": "speaker_1", "spokenText":
         "Wir sollten die Busse abends haeufiger fahren lassen. Das hilft Studierenden nach spaeten Seminaren."},
        {"id": "s2", "speakerId": "speaker_2", "spokenText":
         "Zusaetzliche Fahrradstaender kosten 20000 Euro. Der Bau beginnt im Oktober."},
    ]
    if part_id == "hv1":
        question = {"questionId": "q1", "prompt": "Ein dichterer Abendtakt erleichtert den Heimweg.",
                    "matching": {"correctSpeakerId": "speaker_1", "isDistractor": False,
                                 "evidenceSegmentIds": ["s1"]}}
        if code == "AMBIGUOUS_MAPPING":
            segments[1]["spokenText"] = "Mehr Busse am Abend sind wichtig fuer alle, die lange an der Uni bleiben."
        elif code == "PARAPHRASE_TOO_LITERAL":
            question["prompt"] = "Wir sollten die Busse abends haeufiger fahren lassen."
        else:
            question["prompt"] = "Auf dem Mond wachsen sprechende Fahrkarten."
            question["matching"].update(correctSpeakerId=None, isDistractor=True, evidenceSegmentIds=[])
    elif part_id == "hv2":
        question = {"questionId": "q1", "mc3": {"stem": "Die Fahrradstaender kosten",
                    "options": ["20000 Euro", "30000 Euro", "40000 Euro"],
                    "correctIndex": 0, "evidenceSegmentIds": ["s2"]}}
        if code == "MULTIPLE_DEFENSIBLE_ANSWERS":
            question["mc3"]["options"][1] = "zwanzigtausend Euro"
        elif code == "UNSUPPORTED_CORRECT_ANSWER":
            question["mc3"]["correctIndex"] = 1
        elif code == "IMPLAUSIBLE_DISTRACTOR":
            question["mc3"]["options"][1] = "alle Kreuzungen werden abgeschafft"
        else:
            question["mc3"]["stem"] = "Die gesetzlich vorgeschriebene Mindestbreite eines Radwegs betraegt"
    else:
        question = {"questionId": "q1", "note": {"fieldLabel": "Kosten der Fahrradstaender",
                    "outlineContext": "Infrastruktur", "correctFill": "20000 Euro",
                    "evidenceSegmentIds": ["s2"]}}
        if code == "UNSUPPORTED_CORRECT_ANSWER":
            question["note"]["correctFill"] = "50000 Euro"
        elif code == "TRIVIAL_ITEM":
            segments[0]["spokenText"] += " Guten Abend."
            question["note"].update(fieldLabel="Begruessung", correctFill="Guten Abend", evidenceSegmentIds=["s1"])
    questions = [question]
    if code == "DUPLICATE_INFORMATION":
        duplicate = deepcopy(question)
        duplicate["questionId"] = "q2"
        duplicate["note"].update(fieldLabel="Budget fuer die Fahrradstaender", correctFill="zwanzigtausend Euro")
        questions.append(duplicate)
    return {"segments": segments, "questions": questions}
