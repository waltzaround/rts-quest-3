"""Summarize a completed synthetic-balance report without modifying gameplay."""

import csv
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path


def mean(values):
    return statistics.mean(values) if values else None


def median(values):
    return statistics.median(values) if values else None


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def analyze(path):
    report = json.loads(path.read_text())
    if not report["sourceUnchanged"] or report["completedMatches"] != report["plannedMatches"]:
        raise ValueError("Only completed runs with unchanged sources can be summarized")
    matches = report["matches"]
    cross = [match for match in matches if len(set(match["factions"])) == 2]
    mirrors = [match for match in matches if len(set(match["factions"])) == 1]
    groups = defaultdict(list)
    for match in cross:
        pair = " vs ".join(sorted(match["factions"]))
        groups[("all", pair)].append(match)
        groups[(match["profile"], pair)].append(match)
    matchups = []
    for (profile, pair), games in sorted(groups.items()):
        factions = pair.split(" vs ")
        counts = Counter(match["winnerFaction"] or match["outcome"] for match in games)
        matchups.append({"profile": profile, "pair": pair, "games": len(games),
                         "wins": {faction: counts[faction] for faction in factions},
                         "timeouts": counts["timeout"], "mutualCoreLoss": counts["mutual-core-loss"],
                         "medianDecisiveSeconds": median([game["seconds"] for game in games if game["winnerFaction"]])})
    factions = {}
    for faction in ["industrial", "brood", "concord"]:
        rows = [(match, metric, final) for match in cross
                for metric, final in zip(match["metrics"], match["final"])
                if metric["faction"] == faction]
        if not rows:
            continue
        metrics = [row[1] for row in rows]
        total = lambda key: sum(metric[key] for metric in metrics)
        produced = Counter()
        lost = Counter()
        for metric in metrics:
            produced.update(metric["produced"])
            lost.update(metric["lost"])
        checkpoint_armies = defaultdict(list)
        for match, metric, _ in rows:
            detail = json.loads((path.parent / "matches" / f"{match['id']}.json").read_text())
            for checkpoint in detail["timeline"]:
                if checkpoint["seconds"] not in [60, 180, 300, 600, 1200, 1800]:
                    continue
                player = next(player for player in checkpoint["players"] if player["id"] == metric["id"])
                checkpoint_armies[checkpoint["seconds"]].append(player["combatShips"])
        factions[faction] = {
            "appearances": len(rows), "wins": sum(match["winnerFaction"] == faction for match, _, _ in rows),
            "losses": sum(match["winnerFaction"] not in [None, faction] for match, _, _ in rows),
            "timeouts": sum(match["outcome"] == "timeout" for match, _, _ in rows),
            "producedByClass": dict(produced), "lostByClass": dict(lost),
            "meanProduced": sum(produced.values()) / len(rows), "meanLost": sum(lost.values()) / len(rows),
            "medianFirstCombatSeconds": median([metric["firstCombatUnitSeconds"] for metric in metrics if metric["firstCombatUnitSeconds"] is not None]),
            "medianFirstBuilderSeconds": median([metric["firstBuilderSeconds"] for metric in metrics if metric["firstBuilderSeconds"] is not None]),
            "neverBuiltMobileBuilder": sum(metric["firstBuilderSeconds"] is None for metric in metrics),
            "medianFirstTerritoryNodeSeconds": median([metric["firstTerritoryNodeSeconds"] for metric in metrics if metric["firstTerritoryNodeSeconds"] is not None]),
            "neverBuiltTerritoryNode": sum(metric["firstTerritoryNodeSeconds"] is None for metric in metrics),
            "meanSupplyEfficiency": ratio(total("efficiencySum"), total("samples")),
            "fractionSupplyBelow90Percent": ratio(total("starvedSamples"), total("samples")),
            "fractionFightingInOwnField": ratio(total("fightingInOwnFieldSamples"), total("fightingShipSamples")),
            "fractionReadyBlockedYardTime": ratio(total("readyBlockedYardSamples"), total("completedYardSamples")),
            "fractionNestsAtCap": ratio(total("cappedNestSamples"), total("specializedNestSamples")),
            "fractionNestsUncovered": ratio(total("uncoveredNestSamples"), total("specializedNestSamples")),
            "meanFinalCombatShips": mean([final["combatShips"] for _, _, final in rows]),
            "meanPeakCombatShips": mean([metric["peakCombatShips"] for metric in metrics]),
            "meanAlloySpent": total("alloySpent") / len(rows),
            "meanEnergySpent": total("energySpent") / len(rows),
            "checkpointCombatShips": {str(second): {"mean": mean(values), "median": median(values), "n": len(values)}
                                      for second, values in sorted(checkpoint_armies.items())},
        }
    mirror_results = [{"id": game["id"], "faction": game["factions"][0],
                       "winnerSlot": game["winnerSlot"], "outcome": game["outcome"],
                       "seconds": game["seconds"]} for game in mirrors]
    return {"sourceHash": report["sourceHash"], "backend": report["backend"],
            "crossFactionGames": len(cross), "mirrorGames": len(mirrors),
            "outcomes": dict(Counter(game["outcome"] for game in cross)),
            "decisiveMedianSeconds": median([game["seconds"] for game in cross if game["winnerFaction"]]),
            "decisiveRangeSeconds": [min([game["seconds"] for game in cross if game["winnerFaction"]], default=None),
                                     max([game["seconds"] for game in cross if game["winnerFaction"]], default=None)],
            "firstContactMedianSeconds": median([game["firstHitSeconds"] for game in cross if game["firstHitSeconds"] is not None]),
            "noContactGames": sum(game["firstHitSeconds"] is None for game in cross),
            "victoriesBySlot": dict(Counter(game["winnerSlot"] for game in cross if game["winnerSlot"])),
            "simulatedMinutes": sum(game["seconds"] for game in matches) / 60,
            "wallSeconds": sum(game["wallSeconds"] for game in matches),
            "matchups": matchups, "factions": factions, "mirrorResults": mirror_results}


if __name__ == "__main__":
    report_path = Path(sys.argv[1]).resolve()
    result = analyze(report_path)
    report_path.with_name("summary.json").write_text(json.dumps(result, indent=2) + "\n")
    with report_path.with_name("matchups.csv").open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["profile", "pair", "games", "first_faction_wins", "second_faction_wins", "timeouts", "mutual_core_loss", "median_decisive_seconds"])
        for matchup in result["matchups"]:
            writer.writerow([matchup["profile"], matchup["pair"], matchup["games"],
                             *matchup["wins"].values(), matchup["timeouts"], matchup["mutualCoreLoss"], matchup["medianDecisiveSeconds"]])
    print(json.dumps(result, indent=2))
