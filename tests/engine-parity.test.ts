import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  SCENARIOS,
  computeSimulation,
  createCustomScenario,
  type ScenarioId,
} from '../src/core/faultlineEngine.ts';

const PYTHON_BIN = 'D:\\anaconda\\python.exe';

function runPythonMargin(code: string): number {
  const out = execFileSync(PYTHON_BIN, ['-c', code], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  const m = out.match(/(?:margin_h|headroom|floor_delta|custom_margin)=([+-]?\d+(?:\.\d+)?)/);
  assert.ok(m, `Expected structured margin key in Python stdout, got: ${out}`);
  return Number(m[1]);
}

test('Seam S1.1: Built-in scenarios maintain mathematical parity (<0.15 units) between TS kernel and executed Python numpy script', () => {
  const cases: Array<{
    id: ScenarioId;
    params: Record<string, number>;
    toggles: Record<string, boolean>;
  }> = [
    {
      id: 'typhoon-cpap',
      params: { batteryWh: 1024, outageHours: 36, cpapWatts: 38, coolerWatts: 24, inverterTareW: 14 },
      toggles: { disableHumidifier: false, dcDirectMode: false, preChillPacks: false },
    },
    {
      id: 'typhoon-cpap',
      params: { batteryWh: 1280, outageHours: 36, cpapWatts: 36, coolerWatts: 22, inverterTareW: 14 },
      toggles: { disableHumidifier: true, dcDirectMode: true, preChillPacks: true },
    },
    {
      id: 'singles-day-cutover',
      params: { rps: 5200, timeoutMs: 2000, retries: 3, dbPoolMax: 480, crossRegionRttMs: 68 },
      toggles: { tokenBucketRetry: false, circuitBreaker: false, asyncOutbox: false },
    },
    {
      id: 'singles-day-cutover',
      params: { rps: 5200, timeoutMs: 2000, retries: 3, dbPoolMax: 480, crossRegionRttMs: 68 },
      toggles: { tokenBucketRetry: true, circuitBreaker: true, asyncOutbox: true },
    },
    {
      id: 'expat-cashflow',
      params: { reserveMonths: 11, housingRatioPct: 42, fxShockPct: 16, rateHikeBps: 225, relocOneOffMos: 3.5 },
      toggles: { fxForwardCap: false, rateCapClause: false, staggerMove: false },
    },
  ];

  for (const tc of cases) {
    const snap = computeSimulation(tc.id, tc.params, tc.toggles);
    assert.equal(snap.cloudSeries.length, SCENARIOS[tc.id].horizonPoints);
    for (const v of snap.cloudSeries) {
      assert.ok(v >= 0 && v <= 100, `Expected clamped display pct in [0,100], got ${v}`);
    }
    const pyMargin = runPythonMargin(snap.pythonCode);
    const diff = Math.abs(snap.cloudMargin - pyMargin);
    assert.ok(
      diff <= 0.15,
      `[${tc.id}] TS cloudMargin=${snap.cloudMargin} diverged from executed Python=${pyMargin} (diff=${diff.toFixed(3)})`,
    );
  }
});

test('Seam S1.2: Transient exponential queue integrator has zero CFL oscillation at healthy 66.7% load and captures metastable retry lockup', () => {
  const healthy = computeSimulation(
    'singles-day-cutover',
    { rps: 3600, timeoutMs: 2000, retries: 0, dbPoolMax: 480, crossRegionRttMs: 68 },
    { tokenBucketRetry: false, circuitBreaker: false, asyncOutbox: false },
  );
  // Under healthy load with 0 retries, pool headroom must remain smoothly positive (> 25%) with no wild step-to-zero oscillation
  const minHealthy = Math.min(...healthy.cloudSeries);
  assert.ok(minHealthy >= 25, `Expected smooth healthy headroom >= 25%, got ${minHealthy}%`);

  // Under severe retry storm (rps=5600, retries=4), surge pushes queue into metastable backlog so minute 28 remains degraded compared to token-bucketed run
  const storm = computeSimulation(
    'singles-day-cutover',
    { rps: 5600, timeoutMs: 1800, retries: 4, dbPoolMax: 480, crossRegionRttMs: 84 },
    { tokenBucketRetry: false, circuitBreaker: false, asyncOutbox: false },
  );
  const guarded = computeSimulation(
    'singles-day-cutover',
    { rps: 5600, timeoutMs: 1800, retries: 4, dbPoolMax: 480, crossRegionRttMs: 84 },
    { tokenBucketRetry: true, circuitBreaker: false, asyncOutbox: false },
  );
  assert.ok(storm.cloudMargin < guarded.cloudMargin - 10, 'Retry storm must degrade pool margin by >10% vs token bucket');
});

test('Seam S1.3: Open-domain custom scenarios support all 3 physical envelopes (peak_capacity, cumulative_stock with recharge, queue_backpressure)', () => {
  // 1) 15A / 120V breaker (1440W NEC 80% safe continuous limit) with 6x 3D printers + filament dryer (peak_capacity)
  const breakerSpec = createCustomScenario({
    title: '15A Breaker · 6x 3D Printer Farm',
    archetype: 'peak_capacity',
    marginUnit: '% rail',
    horizonLabel: '12h Print Batch',
    axisXUnit: 'h',
    safetyFloorPct: 20, // 20% NEC continuous headroom floor on 1800W breaker = 1440W max continuous
    capacityValue: 1800,
    capacityUnit: 'W',
    horizonValue: 12,
    loads: [
      { id: 'beds', label: '6x Printer Bed Warmup', value: 1320, unit: 'W', polarity: 'drain', window: { kind: 'interval', startStep: 0, endStep: 6 }, mitigationLabel: 'Stagger Warmup (-45% Peak)', mitigationMult: 0.55 },
      { id: 'steady', label: 'Steady Extruder Print', value: 620, unit: 'W', polarity: 'drain', window: { kind: 'interval', startStep: 7, endStep: 36 } },
      { id: 'dryer', label: 'Filament Dryer + Tare', value: 370, unit: 'W', polarity: 'drain', window: { kind: 'always' }, omittedByNaive: true },
    ],
  });
  const initP = Object.fromEntries(breakerSpec.params.map((p) => [p.key, p.value]));
  const initT = Object.fromEntries(breakerSpec.toggles.map((t) => [t.key, false]));
  const snapUnsafe = computeSimulation(breakerSpec.id, initP, initT, breakerSpec);
  assert.equal(snapUnsafe.isSafe, false, 'Coincident 1690W warmup + dryer on 1800W (20% NEC floor) must breach');
  const pyUnsafe = runPythonMargin(snapUnsafe.pythonCode);
  assert.ok(Math.abs(snapUnsafe.cloudMargin - pyUnsafe) <= 0.2);

  const initTSafe = Object.fromEntries(breakerSpec.toggles.map((t) => [t.key, true]));
  const snapSafe = computeSimulation(breakerSpec.id, initP, initTSafe, breakerSpec);
  assert.equal(snapSafe.isSafe, true, 'Staggering warmup must bring 15A breaker back within NEC 80% safe envelope');

  // 2) Wedding catering cold-storage van with driving recharge & door-open thermal drain (cumulative_stock bidirectional)
  const vanSpec = createCustomScenario({
    title: 'Wedding Catering Cold-Van Route',
    archetype: 'cumulative_stock',
    marginUnit: '% thermal',
    horizonLabel: '12h Delivery Route',
    axisXUnit: 'h',
    safetyFloorPct: 20,
    capacityValue: 100,
    capacityUnit: 'thU',
    horizonValue: 12,
    loads: [
      { id: 'doors', label: 'Venue Door-Open Heat Shock', value: 18, unit: 'thU/h', polarity: 'drain', window: { kind: 'periodic', periodSteps: 9, onStart: 3, onEnd: 5 }, mitigationLabel: 'Strip Curtains (-50% Shock)', mitigationMult: 0.5 },
      { id: 'ambient', label: '34C Roof Conduction Leak', value: 4.5, unit: 'thU/h', polarity: 'drain', window: { kind: 'always' }, omittedByNaive: true },
      { id: 'chiller', label: 'Highway Alternator Chiller Recharge', value: 8.0, unit: 'thU/h', polarity: 'recharge', window: { kind: 'periodic', periodSteps: 9, onStart: 0, onEnd: 2 } },
    ],
  });
  const vanP = Object.fromEntries(vanSpec.params.map((p) => [p.key, p.value]));
  const vanSnap = computeSimulation(vanSpec.id, vanP, {}, vanSpec);
  const pyVan = runPythonMargin(vanSnap.pythonCode);
  assert.ok(Math.abs(vanSnap.cloudMargin - pyVan) <= 0.25);
});
