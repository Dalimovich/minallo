from app.services.verified_exam import validate_verified_exam


def _question(prompt: str, answer: str, **extra):
    return {
        "id": "q1", "type": "short_answer", "question": prompt, "points": 5,
        "solution": {"questionId": "q1", "keySteps": ["derive"], "finalAnswer": answer},
        **extra,
    }


def test_canonical_exam_rejects_procedure_and_solution_id_drift():
    question = _question("Solve the heat equation.", "Use separation of variables.")
    question["solution"]["questionId"] = "old-q"
    issues = validate_verified_exam({"totalPoints": 5, "questions": [question]})
    assert {issue.code for issue in issues} == {"final_answer", "solution_id"}


def test_canonical_exam_checks_points_and_generated_parameter_drift():
    question = _question(
        "For F = 5 kN, calculate the stress.", "F = 3 kN; sigma = 83.7 MPa.",
        generatedParameters={"F": "5 kN"},
    )
    issues = validate_verified_exam({"totalPoints": 7, "questions": [question]})
    assert {issue.code for issue in issues} == {"parameter_mismatch", "point_total"}


def test_fixed_boundary_wave_mode_is_a_result_bearing_answer():
    question = _question(
        "Solve the fixed-fixed wave equation with u(t,0)=u(t,L)=0.",
        r"u(t,x)=A\cos(c\pi t/L)\sin(\pi x/L).",
        generatedParameters={"L": "2 m"},
    )
    assert validate_verified_exam({"totalPoints": 5, "questions": [question]}) == []
