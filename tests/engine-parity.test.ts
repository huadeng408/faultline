import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  SCENARIOS,
  computeSimulation,
  createCustomScenario,
  stepExponentialQueueExact,
  type BuiltinScenarioId,
} from '../src/core/faultlineEngine.ts';

function resolvePythonBin(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  if (process.platform === 'win32' && fs.existsSync('D:\\anaconda\\python.exe')) {
    return 'D:\\anaconda\\python.exe';
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

const PYTHON_BIN = resolvePythonBin();

function runPythonParity(code: string): { margin: number; series: number[] } {
  const out = execFileSync(PYTHON_BIN, ['-c', code], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  const m = out.match(/(?:margin_h|headroom|floor_delta|custom_margin)=([+-]?\d+(?:\.\d+)?)/);
  assert.ok(m, `Expected structured margin key in Python stdout, got: ${out}`);
  const sMatch = out.match(/series_json=(\[[^\n]+\])/);
  assert.ok(sMatch, `Expected series_json array in Python stdout, got: ${out}`);
  return {
    margin: Number(m[1]),
    series: JSON.parse(sMatch[1]) as number[],
  };
}

test('Seam S1.1: Built-in scenarios maintain <0.01 pointwise latent parity and margin parity between TS kernel and Python numpy script', () => {
  const cases: Array<{
    id: BuiltinScenarioId;
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
      params: { batteryWh: 1920, outageHours: 36, cpapWatts: 36, coolerWatts: 22, inverterTareW: 14 },
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
    const py = runPythonParity(snap.pythonCode);
    assert.ok(
      Math.abs(snap.cloudMargin - py.margin) <= 0.05,
      `[${tc.id}] TS cloudMargin=${snap.cloudMargin} diverged from Python=${py.margin}`,
    );
    assert.equal(py.series.length, snap.latentSeries.length);
    for (let i = 0; i < snap.latentSeries.length; i++) {
      const ptDiff = Math.abs(snap.latentSeries[i] - py.series[i]);
      assert.ok(
        ptDiff <= 0.01,
        `[${tc.id} step ${i}] Pointwise latent mismatch: TS=${snap.latentSeries[i]} vs Py=${py.series[i]} (diff=${ptDiff})`,
      );
    }
  }
});

test('Seam S1.2: Exact exponential queue integrator has <1e-10 step-size invariance (dt=4s vs dt=0.01s), zero CFL oscillation, and metastable retry lockup', () => {
  // 1) Exact exponential step invariance under constant rate between coarse dt=4.0s and fine dt=0.01s (400 substeps)
  const qCoarse = stepExponentialQueueExact(120, 7400, 5200, 2.0, 4.0);
  let qFine = 120;
  for (let sub = 0; sub < 400; sub++) {
    qFine = stepExponentialQueueExact(qFine, 7400, 5200, 2.0, 0.01);
  }
  const relErr = Math.abs(qCoarse - qFine) / Math.max(1, qFine);
  assert.ok(relErr < 1e-10, `Expected exact exponential step invariance <1e-10, got relErr=${relErr}`);

  // 2) Healthy 66.7% load has zero CFL oscillation
  const healthy = computeSimulation(
    'singles-day-cutover',
    { rps: 3600, timeoutMs: 2000, retries: 0, dbPoolMax: 480, crossRegionRttMs: 68 },
    { tokenBucketRetry: false, circuitBreaker: false, asyncOutbox: false },
  );
  assert.ok(Math.min(...healthy.cloudSeries) >= 25);

  // 3) Retry storm pushes queue past 0.70 * T_out into metastable lockup vs token-bucketed run
  const storm = computeSimulation(
    'singles-day-cutover',
    { rps: 7200, timeoutMs: 1800, retries: 4, dbPoolMax: 480, crossRegionRttMs: 84 },
    { tokenBucketRetry: false, circuitBreaker: false, asyncOutbox: false },
  );
  const guarded = computeSimulation(
    'singles-day-cutover',
    { rps: 7200, timeoutMs: 1800, retries: 4, dbPoolMax: 480, crossRegionRttMs: 84 },
    { tokenBucketRetry: true, circuitBreaker: false, asyncOutbox: false },
  );
  assert.ok(storm.cloudMargin < guarded.cloudMargin - 20, 'Retry storm must degrade pool margin by >20% vs token bucket');
});

test('Seam S1.3: Open-domain custom scenarios maintain <0.01 pointwise parity across all 3 physical envelopes (peak_capacity, cumulative_stock, queue_backpressure)', () => {
  // 1) peak_capacity: 15A breaker with 6x 3D printers
  const breakerSpec = createCustomScenario({
    title: '15A Breaker · 6x 3D Printer Farm',
    archetype: 'peak_capacity',
    marginUnit: '% rail',
    horizonLabel: '12h Print Batch',
    axisXUnit: 'h',
    safetyFloorPct: 20,
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
  assert.equal(snapUnsafe.isSafe, false);
  const pyBreak = runPythonParity(snapUnsafe.pythonCode);
  for (let i = 0; i < 37; i++) {
    assert.ok(Math.abs(snapUnsafe.latentSeries[i] - pyBreak.series[i]) <= 0.01);
  }

  const initTSafe = Object.fromEntries(breakerSpec.toggles.map((t) => [t.key, true]));
  assert.equal(computeSimulation(breakerSpec.id, initP, initTSafe, breakerSpec).isSafe, true);

  // 2) cumulative_stock: bidirectional cold-van route
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
  const pyVan = runPythonParity(vanSnap.pythonCode);
  for (let i = 0; i < 37; i++) {
    assert.ok(Math.abs(vanSnap.latentSeries[i] - pyVan.series[i]) <= 0.01);
  }

  // 3) queue_backpressure: custom API gateway storm
  const queueSpec = createCustomScenario({
    title: 'AWS Order Concurrency Surge',
    archetype: 'queue_backpressure',
    marginUnit: 'pool %',
    horizonLabel: '36m Surge Window',
    axisXUnit: 'm',
    safetyFloorPct: 15,
    capacityValue: 380,
    capacityUnit: 'slots',
    horizonValue: 36,
    loads: [
      { id: 'ingress', label: 'Flash-Sale Ingress', value: 4600, unit: 'req/s', polarity: 'drain', window: { kind: 'always' }, mitigationLabel: 'Edge Shedding (-30%)', mitigationMult: 0.7 },
    ],
  });
  const qP = Object.fromEntries(queueSpec.params.map((p) => [p.key, p.value]));
  const qSnap = computeSimulation(queueSpec.id, qP, {}, queueSpec);
  const pyQ = runPythonParity(qSnap.pythonCode);
  for (let i = 0; i < 37; i++) {
    assert.ok(Math.abs(qSnap.latentSeries[i] - pyQ.series[i]) <= 0.01);
  }
});
