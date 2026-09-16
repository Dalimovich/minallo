"""Run from backend/python-ai: python -m scripts.verify_german_exam_live.

Writes local QA artifacts only. Does not publish exercises or create audio.
"""
import argparse
from collections import Counter
from copy import deepcopy
from dataclasses import asdict
import json
from pathlib import Path
from time import perf_counter

from app.services import german_exam_listening as listening
from app.services import german_exam_semantic_verify as verifier
from app.services import german_exam_semantic_repair as repair
from app.services.german_exam_profiles import get_profile, get_part
from app.services import llm_json
from app.services.german_exam_validator import hard_issues, validate_content


def inject_fault(part, content):
    if hard_issues(validate_content(part, content)):
        raise ValueError("injection source must be structurally valid")
    bad = deepcopy(content)
    if part.part_id == "hv1":
        question = next(q for q in bad["questions"] if not q["matching"]["isDistractor"])
        source = next(s for s in bad["segments"] if s["speakerId"] == question["matching"]["correctSpeakerId"])
        target = next(s for s in bad["segments"] if s["speakerId"] != source["speakerId"])
        target["spokenText"] = source["spokenText"]
    elif part.part_id == "hv2":
        mc3 = bad["questions"][0]["mc3"]
        mc3["options"][(mc3["correctIndex"] + 1) % 3] = "alle Kreuzungen abschaffen und durch fliegende Einhoerner ersetzen"
    else:
        bad["questions"][1]["note"] = deepcopy(bad["questions"][0]["note"])
        bad["questions"][1]["note"]["correctFill"] += "."
    if hard_issues(validate_content(part, bad)):
        raise ValueError("injection changed official structure")
    return bad


def summarize(report):
    usage = report["usage"]
    totals = {}
    codes = Counter()
    for event in usage:
        feature = event["feature"]
        total = totals.setdefault(feature, {"calls": 0, "seconds": 0, "promptTokens": 0, "completionTokens": 0})
        total["calls"] += 1
        for key in ("seconds", "promptTokens", "completionTokens"):
            total[key] += event.get(key) or 0
        if feature == "verification":
            result = event.get("result", {})
            issues = list(result.get("partWideIssues") or [])
            issues.extend(issue for item in result.get("items", []) for issue in item.get("issues", []))
            codes.update(issue.get("code", "INVALID") for issue in issues)
    report["totals"] = totals
    report["issueCounts"] = dict(codes)
    report["rejectedSamples"] = sum(bool(s.get("failed")) for s in report["samples"])
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--output", default="scripts/diag_runs/german-semantic.json")
    parser.add_argument("--verifier-model")
    parser.add_argument("--generation-model")
    parser.add_argument("--injections-from")
    parser.add_argument("--accepted-from")
    args = parser.parse_args()
    events, findings, samples = [], [], []
    active = {}
    original = llm_json.chat_json

    def measured(feature):
        def call(**kwargs):
            start = perf_counter()
            if feature == "verification" and args.verifier_model:
                kwargs["model"] = args.verifier_model
            elif feature != "verification" and args.generation_model:
                kwargs["model"] = args.generation_model
            result = original(**kwargs)
            events.append({"feature": feature, "seconds": perf_counter() - start,
                           "promptTokens": result.prompt_tokens,
                           "completionTokens": result.completion_tokens, "model": result.model,
                           "result": deepcopy(result.data), "sample": dict(active)})
            if feature != "repair":
                output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            return result
        return call

    for module, name in ((listening, "generation"), (verifier, "verification"), (repair, "repair")):
        module.chat_json = measured(name)
    profile = get_profile("telc_c1_hochschule")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {"samples": samples, "injections": findings, "usage": events}
    if args.injections_from or args.accepted_from:
        previous = json.loads(Path(args.injections_from or args.accepted_from).read_text(encoding="utf-8"))
        if args.accepted_from:
            sources = {}
            for sample in previous["samples"]:
                if "content" in sample:
                    sources.setdefault(sample["part"], sample["content"])
            previous["injections"] = [{"part": key, "content": inject_fault(
                get_part(profile.profile_id, "listening", key), content)} for key, content in sources.items()]
        expected = {"hv1": {"AMBIGUOUS_MAPPING"}, "hv2": {"IMPLAUSIBLE_DISTRACTOR"},
                    "hv3": {"DUPLICATE_INFORMATION"}}
        for injection in previous["injections"]:
            part_id = injection["part"]
            active = {"part": part_id, "injection": True}
            result = verifier.verify_semantic(get_part(profile.profile_id, "listening", part_id), injection["content"])
            codes = {issue.code for issue in result.part_wide_issues}
            codes.update(issue.code for item in result.items for issue in item.issues)
            findings.append({**injection, "caught": not result.passed and bool(codes & expected[part_id]),
                             "result": asdict(result)})
            print(f"{part_id}: caught={findings[-1]['caught']}", flush=True)
        output.write_text(json.dumps(summarize(report), ensure_ascii=False, indent=2), encoding="utf-8")
        return
    try:
        for part_id in ("hv1", "hv2", "hv3"):
            part = get_part(profile.profile_id, "listening", part_id)
            for index in range(args.samples):
                active = {"part": part_id, "index": index, "injection": False}
                start = perf_counter()
                try:
                    content, metadata = listening.generate_listening_part(
                        profile, part, [], {"label": "Nachhaltige Mobilitaet auf dem Hochschulcampus"})
                except listening.ListeningGenerationError:
                    samples.append({"part": part_id, "index": index, "failed": True,
                                    "seconds": perf_counter() - start})
                    print(f"{part_id} sample {index + 1}: rejected", flush=True)
                    metadata = None
                if metadata is not None:
                    samples.append({"part": part_id, "index": index, "seconds": perf_counter() - start,
                                    "content": content, "validation": metadata})
                    print(f"{part_id} sample {index + 1}: accepted", flush=True)
                if index or metadata is None:
                    continue
                bad = inject_fault(part, content)
                expected = {"hv1": {"AMBIGUOUS_MAPPING"}, "hv2": {"IMPLAUSIBLE_DISTRACTOR"},
                            "hv3": {"DUPLICATE_INFORMATION"}}[part_id]
                active["injection"] = True
                result = verifier.verify_semantic(part, bad)
                codes = {issue.code for issue in result.part_wide_issues}
                codes.update(issue.code for item in result.items for issue in item.issues)
                findings.append({"part": part_id, "caught": not result.passed and bool(codes & expected),
                                 "content": bad, "result": asdict(result)})
    except Exception as exc:
        report["error"] = type(exc).__name__
        raise
    finally:
        count = len(samples)
        report["rates"] = {key: sum(predicate(s["validation"]["semantic"]) for s in samples if "validation" in s) / count if count else None
                           for key, predicate in {
                               "passWithoutRepair": lambda m: m["repairCount"] == 0 and m["regenerationCount"] == 0,
                               "repair": lambda m: m["repairCount"] > 0,
                               "regeneration": lambda m: m["regenerationCount"] > 0}.items()}
        report["releaseGatePassed"] = False  # Human inspection and latency/cost acceptance remain required.
        output.write_text(json.dumps(summarize(report), ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
