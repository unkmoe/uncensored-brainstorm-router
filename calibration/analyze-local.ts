/**
 * Local judge (llama.cpp decision model, Kev-4B) calibration analysis: confusion matrices
 * side by side with the Jev results (calibration/results/jev-<set>.jsonl, analysis-jev.md),
 * per-item comparison, threshold sweep, separation intervals, and latency stats.
 * Run: npx tsx calibration/analyze-local.ts > calibration/results/analysis-local.md
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_ID = process.env.LOCAL_JUDGE_MODEL ?? "kev-4b";
const THRESHOLDS = [0.4, 0.5, 0.6]; // same rows as analysis-jev.md
const SWEEP = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

interface ResultLine {
	set: "friction" | "aup";
	id: string;
	label: string;
	frictionHigh: number;
	aup: number;
	latencyMs: number;
	attempts: number;
	inputTokens?: number;
	skipped?: boolean;
	error?: string;
}

const metric = (l: ResultLine): number => (l.set === "friction" ? l.frictionHigh : l.aup);

const load = (prefix: string, set: string): ResultLine[] =>
	readFileSync(join(HERE, "results", `${prefix}-${set}.jsonl`), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as ResultLine);

function matrix(items: ResultLine[], th: number, positive: string) {
	const pred = (l: ResultLine) => metric(l) >= th;
	const tp = items.filter((i) => i.label === positive && pred(i)).length;
	const fp = items.filter((i) => i.label !== positive && pred(i)).length;
	const fn = items.filter((i) => i.label === positive && !pred(i)).length;
	const tn = items.filter((i) => i.label !== positive && !pred(i)).length;
	return {
		tp, fp, fn, tn,
		fpr: fp / (fp + tn || 1),
		fnr: fn / (fn + tp || 1),
		acc: (tp + tn) / items.length,
	};
}

const header = "| しきい値 | TP | FP | FN | TN | 偽陽性率 | 偽陰性率 | accuracy |";
const bar = "| --- | --- | --- | --- | --- | --- | --- | --- |";
const cells = (m: { tp: number; fp: number; fn: number; tn: number; fpr: number; fnr: number; acc: number }) =>
	`| ${m.tp} | ${m.fp} | ${m.fn} | ${m.tn} | ${m.fpr.toFixed(3)} | ${m.fnr.toFixed(3)} | ${m.acc.toFixed(3)} |`;

const all: ResultLine[] = [];
for (const [set, positive] of [
	["friction", "high"],
	["aup", "violation"],
] as const) {
	const items = load(`local-${MODEL_ID}`, set);
	const jev = load("jev", set);
	all.push(...items);
	console.log(`\n## ${set}（positive=${positive}, n=${items.length}, judge=local llama.cpp/${MODEL_ID}）\n`);

	console.log(`### local ${MODEL_ID} vs Jev（analysis-jev.md §並記）\n`);
	console.log("| judge |" + header.slice(1));
	console.log("| --- |" + bar.slice(1));
	for (const th of THRESHOLDS) console.log(`| Kev-4B ${th} ` + cells(matrix(items, th, positive)));
	for (const th of THRESHOLDS) console.log(`| Jev ${th} ` + cells(matrix(jev, th, positive)));

	// best local threshold: midpoint of the separation interval (or widest safe cut)
	const posP = items.filter((i) => i.label === positive).map((i) => metric(i));
	const negP = items.filter((i) => i.label !== positive).map((i) => metric(i));
	const posMin = Math.min(...posP), negMax = Math.max(...negP);
	const bestTh = (posMin + negMax) / 2;
	console.log(`\n### ${set} 個別比較（local ${MODEL_ID} vs Jev 確率、両方のしきい値 0.5 基準）\n`);
	console.log("| id | 正解ラベル | Kev-4B P | Jev P | Kev-4B 判定 | Jev 判定 |");
	console.log("| --- | --- | --- | --- | --- | --- |");
	const judge = (l: ResultLine, th: number) =>
		(l.label === positive) === (metric(l) >= th) ? "○" : (l.label === positive ? "偽陰性" : "偽陽性");
	for (let k = 0; k < items.length; k++) {
		const l = items[k];
		const j = jev[k];
		console.log(`| ${l.id} | ${l.label} | ${metric(l).toFixed(3)} | ${j ? metric(j).toFixed(3) : "—"} | ${judge(l, 0.5)} | ${j ? judge(j, 0.5) : "—"} |`);
	}

	console.log(`\n### ${set} しきい値スイープ（local ${MODEL_ID}）\n`);
	console.log(header);
	console.log(bar);
	for (const th of SWEEP) console.log(`| ${th} |` + cells(matrix(items, th, positive)).slice(1));
	console.log(
		`\n分離: ${positive} 側 min=${posMin.toFixed(3)} / max=${Math.max(...posP).toFixed(3)}、` +
			`非${positive} 側 min=${Math.min(...negP).toFixed(3)} / max=${negMax.toFixed(3)}` +
			` → 完全分離区間: (${negMax.toFixed(3)}, ${posMin.toFixed(3)})` +
			`${negMax < posMin ? "（重なりなし・推奨しきい値 " + bestTh.toFixed(3) + "）" : "（重なりあり）"}`,
	);
}

// --- latency / cost ---
console.log(`\n## 遅延・コスト（全 ${all.length} 呼び出し, local llama-server CPU 10 threads）\n`);
const skipped = all.filter((i) => i.skipped);
if (skipped.length) console.log(`skipped: ${skipped.map((s) => s.id).join(", ")}`);
const lat = all.map((i) => i.latencyMs).sort((a, b) => a - b);
const tokens = all.reduce((a, i) => a + (i.inputTokens ?? 0), 0);
const retries = all.filter((i) => i.attempts > 1).length;
console.log(
	`- latency: min=${lat[0]}ms p50=${lat[Math.floor(lat.length / 2)]}ms p90=${lat[Math.floor(lat.length * 0.9)]}ms max=${lat[lat.length - 1]}ms`,
);
console.log(`- input tokens 合計: ${tokens}（1 判定平均 ${Math.round(tokens / all.length)}）`);
console.log(`- cost: $0（ローカル推論のみ・外部送信ゼロ）`);
console.log(`- リトライ: ${retries} 件 / スキップ: ${skipped.length} 件`);
