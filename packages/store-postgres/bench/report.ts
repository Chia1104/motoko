import { readFile } from "node:fs/promises";

export interface Sample {
  readonly target: string;
  readonly scenario: string;
  readonly rep: number;
  readonly wallMs: number;
  readonly statements: number;
  readonly renewals: number;
  readonly storageCalls: number;
  readonly commits: number;
  readonly maxInFlight: number;
  readonly byKind: Record<string, number>;
  readonly byCaller: Record<string, number>;
  readonly callsByMethod: Record<string, number>;
  readonly callsByCaller: Record<string, number>;
  readonly runtimeCalls: Record<string, number>;
  readonly metrics: Record<string, number>;
}

export interface Results {
  readonly startedAt: string;
  readonly machine: Record<string, unknown>;
  readonly config: Record<string, unknown>;
  readonly calibration: { path: string; rttMs: number; selectOneMs: number[]; connectMs: number[] }[];
  readonly samples: Sample[];
}

const sorted = (values: readonly number[]) => values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
export const median = (values: readonly number[]): number => {
  const s = sorted(values);
  if (s.length === 0) return Number.NaN;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};
const quantile = (values: readonly number[], q: number) => {
  const s = sorted(values);
  return s.length === 0 ? Number.NaN : (s[Math.min(s.length - 1, Math.floor(q * s.length))] as number);
};
const ms = (value: number) =>
  !Number.isFinite(value) ? "–" : value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
const count = (value: number) =>
  !Number.isFinite(value) ? "–" : Number.isInteger(value) ? String(value) : value.toFixed(1);
const spread = (values: readonly number[]) =>
  `${ms(median(values))} (${ms(Math.min(...values))}–${ms(Math.max(...values))})`;

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

const groups = (samples: readonly Sample[]) => {
  const byScenario = new Map<string, Map<string, Sample[]>>();
  for (const sample of samples) {
    let targets = byScenario.get(sample.scenario);
    if (!targets) byScenario.set(sample.scenario, (targets = new Map()));
    let list = targets.get(sample.target);
    if (!list) targets.set(sample.target, (list = []));
    list.push(sample);
  }
  return byScenario;
};

const EXTRA: Record<string, string[]> = {
  "turn.plain": [
    "submitMs",
    "modelRequestMs",
    "firstDeltaMs",
    "gapP50Ms",
    "gapP95Ms",
    "lagP50Ms",
    "lagP95Ms",
    "lagMaxMs",
    "answerToEndMs",
  ],
  "turn.tools": ["submitMs", "modelRequestMs", "firstDeltaMs", "toolRoundMs", "lagP95Ms", "answerToEndMs"],
  "turn.approval": ["submitMs", "approvalRequestMs", "approveMs", "approveToToolEndMs", "lagP95Ms", "answerToEndMs"],
  "events.historyFromStart": ["firstEventMs", "lastEventMs", "events"],
  "events.historyFromCursor": ["lastEventMs", "events"],
  "lease.idle20": ["renewalsPerSecond", "otherStatements"],
  "turn.concurrent": ["submitMs", "firstDeltaMs", "firstDeltaMaxMs", "runEndMs", "runEndMaxMs", "gapP95Ms"],
};

export function formatReport(results: Results): string {
  const out: string[] = [];
  out.push(`## Run ${results.startedAt}`);
  out.push("");
  out.push(`Machine: ${JSON.stringify(results.machine)}`);
  out.push(`Config: ${JSON.stringify(results.config)}`);
  if (results.calibration.length > 0) {
    out.push("");
    out.push("### Calibration: one `SELECT 1` on a warm connection, and a new connection's first `SELECT 1`");
    out.push("");
    out.push(
      table(
        ["path", "configured RTT", "SELECT 1 p50 (p10–p90)", "new connection + SELECT 1 p50 (min–max)"],
        results.calibration.map((row) => [
          row.path,
          `${row.rttMs} ms`,
          `${ms(median(row.selectOneMs))} (${ms(quantile(row.selectOneMs, 0.1))}–${ms(quantile(row.selectOneMs, 0.9))}) ms`,
          row.connectMs.length === 0 ? "–" : `${spread(row.connectMs)} ms`,
        ]),
      ),
    );
  }
  for (const [scenario, targets] of groups(results.samples)) {
    const extra = EXTRA[scenario] ?? EXTRA[scenario.replace(/\d+$/, "")] ?? [];
    out.push("");
    out.push(`### ${scenario}`);
    out.push("");
    out.push(
      table(
        ["target", "n", "wall ms p50 (min–max)", "statements", "commits", "storage calls", "max in flight", ...extra],
        [...targets].map(([target, list]) => [
          target,
          String(list.length),
          spread(list.map((sample) => sample.wallMs)),
          count(median(list.map((sample) => sample.statements))),
          count(median(list.map((sample) => sample.commits))),
          count(median(list.map((sample) => sample.storageCalls))),
          count(median(list.map((sample) => sample.maxInFlight))),
          ...extra.map((key) => {
            const values = list.map((sample) => sample.metrics[key] ?? Number.NaN);
            return key === "events" || key.startsWith("renewals") || key === "otherStatements"
              ? count(median(values))
              : spread(values);
          }),
        ]),
      ),
    );
  }
  return out.join("\n");
}

export function formatAttribution(results: Results, target: string): string {
  const out: string[] = [`### Statements per operation on ${target} (the sample with the median statement count)`, ""];
  for (const [scenario, targets] of groups(results.samples)) {
    const list = targets.get(target);
    if (!list || list.length === 0) continue;
    const middle = [...list].sort((a, b) => a.statements - b.statements)[Math.floor(list.length / 2)] as Sample;
    out.push(
      `#### ${scenario}: ${middle.statements} statements, ${middle.commits} commits, ${middle.storageCalls} storage calls`,
    );
    out.push("");
    out.push(
      table(
        ["statement ← caller", "n"],
        Object.entries(middle.byCaller).map(([key, n]) => [key.replaceAll("|", "\\|"), String(n)]),
      ),
    );
    out.push("");
    if (Object.keys(middle.runtimeCalls ?? {}).length > 0) {
      out.push(
        `Motoko calls into pi-durable: ${Object.entries(middle.runtimeCalls)
          .map(([key, n]) => `${key} ×${n}`)
          .join("; ")}`,
      );
      out.push("");
    }
  }
  return out.join("\n");
}

export function formatComparison(before: Results, after: Results): string {
  const a = groups(before.samples);
  const b = groups(after.samples);
  const rows: string[][] = [];
  for (const [scenario, targets] of b) {
    for (const [target, list] of targets) {
      const old = a.get(scenario)?.get(target);
      if (!old) continue;
      const wa = median(old.map((s) => s.wallMs));
      const wb = median(list.map((s) => s.wallMs));
      rows.push([
        scenario,
        target,
        `${spread(old.map((s) => s.wallMs))}`,
        `${spread(list.map((s) => s.wallMs))}`,
        `${wb - wa >= 0 ? "+" : ""}${ms(wb - wa)}`,
        `${count(median(old.map((s) => s.statements)))} → ${count(median(list.map((s) => s.statements)))}`,
      ]);
    }
  }
  return table(
    ["scenario", "target", "before ms p50 (min–max)", "after ms p50 (min–max)", "Δ p50 ms", "statements"],
    rows,
  );
}

export function printReport(results: Results): void {
  console.log(formatReport(results));
  const targets = new Set(results.samples.map((sample) => sample.target));
  const pick = ["postgres 0ms", "postgres direct"].find((target) => targets.has(target));
  if (pick) {
    console.log("");
    console.log(formatAttribution(results, pick));
  }
}

if (import.meta.main) {
  const [first, second] = process.argv.slice(2);
  if (first === undefined) throw new Error("usage: report.ts results.json [after.json]");
  const load = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Results;
  if (second === undefined) printReport(await load(first));
  else console.log(formatComparison(await load(first), await load(second)));
}
