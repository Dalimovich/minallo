"""Seed / top up the pre-generated German Exam inventory.

Run from backend/python-ai with the service env loaded (SUPABASE_*, OPENAI_*):

    python scripts/seed_german_exam_inventory.py                       # every stocked part up to --target
    python scripts/seed_german_exam_inventory.py --part lesen_1 --target 12
    python scripts/seed_german_exam_inventory.py --dry-run              # show stock levels only

Generation is sequential and uses the normal validated pipeline, so each
stocked task costs the same as one live generation. Inspect the bank before
launch: `select part_id, topic_id, count(*) from german_exam_inventory group by 1,2`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import german_exam_inventory as inv  # noqa: E402
from app.services.german_exam_profiles import get_profile  # noqa: E402

PROFILE_ID = "telc_c1_hochschule"


def stocked_parts(profile_id: str) -> list[tuple[str, str]]:
    profile = get_profile(profile_id)
    return [
        (module, part.part_id)
        for module, parts in profile.modules.items()
        if module in inv.STOCKED_MODULES and parts
        for part in parts
    ]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default=PROFILE_ID)
    ap.add_argument("--part", help="only this part id (e.g. lesen_1)")
    ap.add_argument("--target", type=int, default=inv.target_stock())
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    for module, part_id in stocked_parts(args.profile):
        if args.part and part_id != args.part:
            continue
        have = inv.stock_size(args.profile, module, part_id)
        print(f"{module}/{part_id}: {have}/{args.target}")
        if args.dry_run:
            continue
        for n in range(have, args.target):
            new_id = inv.generate_and_store(args.profile, module, part_id, source="seed")
            print(f"  [{n + 1}/{args.target}] {'stored ' + new_id if new_id else 'FAILED (skipped)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
