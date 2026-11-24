/**
 * Phase 2.6 threshold / confusion-matrix analysis over calibration/results/*.jsonl.
 * Run: npx tsx calibration/analyze.ts > calibration/results/analysis.md
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const THRESHOLDS = [0.4, 0.5, 0.6];

interface ResultLine { set: "friction" | "aup"; id: string; label: string; p: number; latencyMs: number }

const load = (set: string): ResultLine[] =>
	readFileSync(join(HERE, "results", `${set}.jsonl`), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as ResultLine);

function matrix(items: ResultLine[], pred: (p: number) => boolean, positive: string): {
	tp: number; fp: number; fn: number; tn: number; fpr: number; fnr: number; acc: number; errors: ResultLine[]
} {
	const tp = items.filter((i) => i.label === positive && pred(i.p)).length;
	const fp = items.filter((i) => i.label !== positive && pred(i.p)).length;
	const fn = items.filter((i) => i.label === positive && !pred(i.p)).length;
	const tn = items.filter((i) => i.label !== positive && !pred(i.p)).length;
	const errors = items.filter((i) => i.label === positive !== pred(i.p));
	return {
		tp, fp, fn, tn,
		fpr: fp / (fp + tn || 1),
		fnr: fn / (fn + tp || 1),
		acc: (tp + tn) / items.length,
		errors,
	};
}

const header = "| しきい値 | TP | FP | FN | TN | 偽陽性率 | 偽陰性率 | accuracy |";
const bar = "| --- | --- | --- | --- | --- | --- | --- | --- |";

for (const [set, positive, note] of [
	["friction", "high", "positive=high (P(Yes) を摩擦 high と解釈)"],
	["aup", "violation", "positive=violation (doc/09 §4: 偽陰性を最重視)"],
] as const) {
	const items = load(set);
	console.log(`\n## ${set}（${note}, n=${items.length}）\n`);
	console.log(header);
	console.log(bar);
	for (const th of THRESHOLDS) {
		const m = matrix(items, (p) => p >= th, positive);
		console.log(
			`| ${th} | ${m.tp} | ${m.fp} | ${m.fn} | ${m.tn} | ${m.fpr.toFixed(3)} | ${m.fnr.toFixed(3)} | ${m.acc.toFixed(3)} |`,
		);
	}
	const kind = (label: string, predictedPositive: boolean): string =>
		label === positive && !predictedPositive ? "偽陰性" : label !== positive && predictedPositive ? "偽陽性" : "";

	console.log(`\n### ${set} 個別誤判定（しきい値 0.5 基準。0.4/0.5/0.6 で判定不変）\n`);
	console.log("| id | 正解ラベル | P(Yes) | 判定 |");
	console.log("| --- | --- | --- | --- |");
	for (const e of items.filter((i) => (i.label === positive) !== (i.p >= 0.5))) {
		console.log(`| ${e.id} | ${e.label} | ${e.p.toFixed(4)} | ${kind(e.label, e.p >= 0.5)} |`);
	}

	// latency stats
	const lat = items.map((i) => i.latencyMs).sort((a, b) => a - b);
	console.log(
		`\nlatency: min=${lat[0]}ms p50=${lat[Math.floor(lat.length / 2)]}ms max=${lat[lat.length - 1]}ms`,
	);
}
