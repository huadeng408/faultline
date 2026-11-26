import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, createCustomScenario } from '../src/core/faultlineEngine.ts';
import { SEED_SURROGATES } from '../src/core/seedSurrogates.ts';
import { evaluateCalibratedSurrogate } from '../src/core/monteCarloSurrogate.ts';
import {
  encodePocketUrl,
  decodePocketUrl,
  summarizeSurrogateForPocket,
} from '../src/core/pocketCodec.ts';

test('Seam S5.1: Pocket codec packs parameters + quantized surrogate knots into <320-char https:// URL and round-trips custom scenarios', () => {
  const sc = SCENARIOS['expat-cashflow'];
  const params = {
    reserveMonths: 13,
    housingRatioPct: 39,
    fxShockPct: 18,
    rateHikeBps: 250,
    relocOneOffMos: 3.0,
  };
  const toggles = {
    fxForwardCap: true,
    rateCapClause: false,
    staggerMove: true,
  };
  const surrEnv = evaluateCalibratedSurrogate(sc, params, toggles, SEED_SURROGATES['expat-cashflow']);
  const surrSummary = summarizeSurrogateForPocket(surrEnv);

  const url = encodePocketUrl('https://faultline-v3.web.app', {
    scenarioId: sc.id,
    paramValues: params,
    toggleValues: toggles,
    verifiedMargin: 2.4,
    isSafe: true,
    surrogateSummary: surrSummary,
  });

  assert.ok(url.startsWith('https://faultline-v3.web.app/?pocket='), `Unexpected URL prefix: ${url}`);
  assert.ok(url.length < 320, `Expected compact QR URL < 320 chars, got ${url.length}: ${url}`);

  const decoded = decodePocketUrl(url);
  assert.ok(decoded, 'Expected non-null decoded pocket state');
  assert.equal(decoded.scenarioId, 'expat-cashflow');
  assert.deepEqual(decoded.paramValues, params);
  assert.deepEqual(decoded.toggleValues, toggles);
  assert.equal(decoded.verifiedMargin, 2.4);
  assert.equal(decoded.isSafe, true);
  assert.deepEqual(decoded.surrogateSummary, surrSummary);

  // Also verify [+04] CUSTOM scenario round-trips losslessly with full custom envelope reconstruction
  const custom = createCustomScenario({
    id: 'custom-qr-printer',
    title: '15A Printer Breaker',
    archetype: 'peak_capacity',
    marginUnit: '% rail',
    horizonLabel: '12h Window',
    axisXUnit: 'h',
    safetyFloorPct: 20,
    capacityValue: 1800,
    capacityUnit: 'W',
    horizonValue: 12,
    loads: [
      { id: 'bed', label: 'Heated Beds', value: 1320, unit: 'W', polarity: 'drain', window: { kind: 'interval', startStep: 0, endStep: 6 }, mitigationLabel: 'Stagger', mitigationMult: 0.55 },
    ],
  });
  const customParams = Object.fromEntries(custom.params.map((p) => [p.key, p.value]));
  const customUrl = encodePocketUrl('https://faultline-v3.web.app', {
    scenarioId: custom.id,
    paramValues: customParams,
    toggleValues: { mit_bed: true },
    verifiedMargin: 19.1,
    isSafe: true,
    customScenario: custom,
  });
  const decodedCustom = decodePocketUrl(customUrl);
  assert.ok(decodedCustom?.hydratedCustomScenario, 'Custom scenario must hydrate from ?pocket= URL');
  assert.equal(decodedCustom?.hydratedCustomScenario?.title, '15A Printer Breaker');
  assert.equal(decodedCustom?.toggleValues.mit_bed, true);
});
