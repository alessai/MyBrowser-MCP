import { performance } from "node:perf_hooks";

import { TelemetryManager } from "../src/telemetry/manager.js";

const ROUNDS = 7;
const ITERATIONS = 1_000;
const WORK_UNITS = 50_000;

const input = {
  sessionId: "benchmark-session",
  toolName: "browser_click",
  arguments: { tabId: 1, element: "benchmark" },
};
const manager = TelemetryManager.disabled();
let checksum = 0;

async function representativeOperation(): Promise<number> {
  let value = checksum;
  for (let index = 0; index < WORK_UNITS; index += 1) {
    value = Math.imul(value ^ index, 16_777_619) >>> 0;
  }
  checksum = value;
  await Promise.resolve();
  return value;
}

async function measure(operation: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  for (let index = 0; index < ITERATIONS; index += 1) await operation();
  return performance.now() - started;
}

function median(values: number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
}

for (let index = 0; index < 200; index += 1) {
  await representativeOperation();
  await manager.runToolCall(input, representativeOperation);
}

const baseline: number[] = [];
const disabled: number[] = [];
for (let round = 0; round < ROUNDS; round += 1) {
  if (round % 2 === 0) {
    baseline.push(await measure(representativeOperation));
    disabled.push(await measure(() => manager.runToolCall(input, representativeOperation)));
  } else {
    disabled.push(await measure(() => manager.runToolCall(input, representativeOperation)));
    baseline.push(await measure(representativeOperation));
  }
}

const baselineMedianMs = median(baseline);
const disabledMedianMs = median(disabled);
const overheadPercent = ((disabledMedianMs - baselineMedianMs) / baselineMedianMs) * 100;
console.log(JSON.stringify({
  rounds: ROUNDS,
  iterationsPerRound: ITERATIONS,
  workUnitsPerOperation: WORK_UNITS,
  baselineMedianMs: Number(baselineMedianMs.toFixed(3)),
  disabledMedianMs: Number(disabledMedianMs.toFixed(3)),
  overheadPercent: Number(overheadPercent.toFixed(3)),
}, null, 2));

if (overheadPercent > 5) {
  throw new Error(`Disabled telemetry overhead ${overheadPercent.toFixed(3)}% exceeds 5%`);
}
