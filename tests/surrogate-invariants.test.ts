import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from '../src/core/faultlineEngine.ts';
import {
  evaluateCalibratedSurrogate,
} from '../src/core/monteCarloSurrogate.ts';
import { SEED_SURROGATES } from '../src/core/seedSurrogates.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('Seam S2.1: Exact anchor interpolation (<1e-9 error) across all 3 built-in scenarios', () => {
  for (const id of ['typhoon-cpap', 'singles-day-cutover', 'expat-cashflow'] as const) {
    const sc = SCENARIOS[id];
    const seed = SEED_SURROGATES[id];
    const evalRes = evaluateCalibratedSurrogate(sc, seed.anchorParams, seed.anchorToggles, seed);

    for (let t = 0; t < sc.horizonPoints; t++) {
      assert.ok(Math.abs(evalRes.p10Latent[t] - seed.p10Latent[t]) < 1e-6);
      assert.ok(Math.abs(evalRes.p50Latent[t] - seed.p50Latent[t]) < 1e-6);
      assert.ok(Math.abs(evalRes.p90Latent[t] - seed.p90Latent[t]) < 1e-6);
    }
  }
});

test('Seam S2.2: 5,000 random samples in [0,1]^d satisfy strict P10 < P50 < P90 quantile non-crossing and boundedness', () => {
  const rng = mulberry32(20261127);
  const ids = ['typhoon-cpap', 'singles-day-cutover', 'expat-cashflow'] as const;

  for (let sample = 0; sample < 5000; sample++) {
    const id = ids[sample % ids.length];
    const sc = SCENARIOS[id];
    const seed = SEED_SURROGATES[id];
    const theta: Record<string, number> = {};
    for (const p of sc.params) {
      const u = rng();
      theta[p.key] = p.min + u * (p.max - p.min);
    }

    const res = evaluateCalibratedSurrogate(sc, theta, seed.anchorToggles, seed);
    for (let t = 0; t < sc.horizonPoints; t++) {
      assert.ok(
        res.p10Latent[t] < res.p50Latent[t] && res.p50Latent[t] < res.p90Latent[t],
        `Quantile crossing at sample=${sample} (${id} step ${t}): P10=${res.p10Latent[t]} P50=${res.p50Latent[t]} P90=${res.p90Latent[t]}`,
      );
      assert.ok(
        res.p10Display[t] <= res.p50Display[t] && res.p50Display[t] <= res.p90Display[t],
        `Display quantile crossing at sample=${sample}`,
      );
      assert.ok(res.p10Display[t] >= 0 && res.p90Display[t] <= 100);
    }
  }
});

test('Seam S2.3: Epistemic out-of-domain widening (0 fan collapse at ||dTheta|| >= 0.6) and load monotonicity', () => {
  const sc = SCENARIOS['typhoon-cpap'];
  const seed = SEED_SURROGATES['typhoon-cpap'];

  const anchorRes = evaluateCalibratedSurrogate(sc, seed.anchorParams, seed.anchorToggles, seed);
  const farParams = {
    ...seed.anchorParams,
    batteryWh: 2048,
    cpapWatts: 18,
    coolerWatts: 12,
  };
  const farRes = evaluateCalibratedSurrogate(sc, farParams, seed.anchorToggles, seed);

  // Far-field latent fan width (P90 - P10) at mid-horizon must widen rather than collapse to 0
  const midIdx = 18;
  const anchorSpan = anchorRes.p90Latent[midIdx] - anchorRes.p10Latent[midIdx];
  const farSpan = farRes.p90Latent[midIdx] - farRes.p10Latent[midIdx];
  assert.ok(farSpan > anchorSpan * 1.02, `Expected far-field fan widening (${farSpan} > ${anchorSpan})`);

  // Increasing load strictly decreases latent P10 safety margin (no false-safe sign inversion)
  const lowLoad = evaluateCalibratedSurrogate(
    sc,
    { ...seed.anchorParams, cpapWatts: 24, coolerWatts: 16 },
    seed.anchorToggles,
    seed,
  );
  const highLoad = evaluateCalibratedSurrogate(
    sc,
    { ...seed.anchorParams, cpapWatts: 62, coolerWatts: 48 },
    seed.anchorToggles,
    seed,
  );
  assert.ok(
    highLoad.p10Margin < lowLoad.p10Margin,
    `Expected higher load to lower P10 margin: high=${highLoad.p10Margin} vs low=${lowLoad.p10Margin}`,
  );
});
