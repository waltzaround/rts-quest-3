#!/usr/bin/env python3
"""Compare completed, identically seeded balance reports without scoring timeouts."""
import argparse
import json
from collections import Counter
from pathlib import Path
from statistics import mean

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("before", type=Path)
parser.add_argument("after", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
before, after = [json.loads(path.read_text()) for path in (args.before, args.after)]
for report in (before, after):
    assert report["sourceUnchanged"], "Source changed during the run"
    assert report["completedMatches"] == report["plannedMatches"], "Incomplete run"
assert before["maxTicks"] == after["maxTicks"], "Different time limits"
old = {match["id"]: match for match in before["matches"]}
new = {match["id"]: match for match in after["matches"]}
assert old.keys() == new.keys(), "Different matchup sets"
for key in old:
    assert old[key]["options"] == new[key]["options"], f"Scenario differs: {key}"
    assert old[key]["geometryHash"] == new[key]["geometryHash"], f"Map differs: {key}"

cross_ids = [key for key in old if len(set(old[key]["factions"])) > 1]
result = {
    "beforeSourceHash": before["sourceHash"], "afterSourceHash": after["sourceHash"],
    "crossFactionGames": len(cross_ids), "timeLimitSeconds": before["maxTicks"] / 20,
    "beforeOutcomes": dict(Counter(old[key]["outcome"] for key in cross_ids)),
    "afterOutcomes": dict(Counter(new[key]["outcome"] for key in cross_ids)),
    "newlyDecisive": [key for key in cross_ids if old[key]["outcome"] == "timeout" and new[key]["outcome"] == "victory"],
    "newlyUnresolved": [key for key in cross_ids if old[key]["outcome"] == "victory" and new[key]["outcome"] == "timeout"],
    "checkpoints": {},
}
yard_types = ("shipyard", "fleetShipyard", "capitalShipyard")
for seconds in (60, 300, 600, 1200, 1800):
    rows = {}
    for key in cross_ids:
        paths = [args.before.parent / "matches" / f"{key}.json", args.after.parent / "matches" / f"{key}.json"]
        points = [next((point for point in json.loads(path.read_text())["timeline"] if point["seconds"] == seconds), None) for path in paths]
        if not all(points):
            continue
        for index, player in enumerate(points[0]["players"]):
            faction = player["faction"]
            sample = rows.setdefault(faction, [])
            sample.append([{
                "combatShips": point["players"][index]["combatShips"],
                "completedYards": sum(point["players"][index]["structures"].get(kind, 0) for kind in yard_types),
                "alloyIncome": point["players"][index]["economy"]["alloyIncome"],
            } for point in points])
    result["checkpoints"][seconds] = {faction: {"pairedAppearances": len(samples),
        **{label: {metric: mean(sample[index][metric] for sample in samples)
                    for metric in ("combatShips", "completedYards", "alloyIncome")}
           for index, label in enumerate(("before", "after"))}}
        for faction, samples in rows.items()}
args.output.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
