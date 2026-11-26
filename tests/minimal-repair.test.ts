import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, computeSimulation } from '../src/core/faultlineEngine.ts';
import { SEED_SURROGATES } from '../src/core/seedSurrogates.ts';
import { solveMinimalRepair } from '../src/core/minimalRepairSolver.ts';

test('Seam S3.1: Exact discrete Pareto search selects minimal-friction toggle subset without turning on unnecessary high-cost switches', () => {
  // On default Scenario 02 (singles-day-cutover), enabling tokenBucketRetry (cost 1.0) + asyncOutbox (cost 1.35)
  // achieves +7.1% pool headroom (>= 5% target) WITHOUT tripping high-friction circuitBreaker (cost 1.7)
  const scSre = SCENARIOS['singles-day-cutover'];
  const paramsSre = Object.fromEntries(scSre.params.map((p) => [p.key, p.value]));
  const togglesSre = Object.fromEntries(scSre.toggles.map((t) => [t.key, false]));

  const planSre = solveMinimalRepair(scSre, paramsSre, togglesSre);
  assert.equal(planSre.kind, 'discrete_sufficient');
  const enabledSre = Object.values(planSre.repairedToggles).filter(Boolean).length;
  assert.ok(enabledSre < 3, `Expected minimal subset (<3 switches) on SRE cutover, got ${enabledSre}`);
  assert.equal(planSre.repairedToggles.circuitBreaker, false, 'Should spare high-friction circuitBreaker');
  const verifySre = computeSimulation(scSre.id, planSre.repairedParams, planSre.repairedToggles);
  assert.equal(verifySre.isSafe, true);

  // Also verify Scenario 01 (typhoon-cpap) with 1792Wh / 32h selects 2 switches instead of all 3
  const scCpap = SCENARIOS['typhoon-cpap'];
  const paramsCpap = {
    batteryWh: 1792,
    outageHours: 32,
    cpapWatts: 34,
    coolerWatts: 20,
    inverterTareW: 14,
  };
  const togglesCpap = { disableHumidifier: false, dcDirectMode: false, preChillPacks: false };
  const planCpap = solveMinimalRepair(scCpap, paramsCpap, togglesCpap);
  assert.equal(planCpap.kind, 'discrete_sufficient');
  assert.ok(Object.values(planCpap.repairedToggles).filter(Boolean).length < 3);
  assert.equal(computeSimulation(scCpap.id, planCpap.repairedParams, planCpap.repairedToggles).isSafe, true);
});

test('Seam S3.2: Bounded 16-step Dekker-Brent continuous sizing rescues undersized 512Wh pack with zero NaN on saturated plateau', () => {
  const sc = SCENARIOS['typhoon-cpap'];
  const params = {
    batteryWh: 512,
    outageHours: 36,
    cpapWatts: 38,
    coolerWatts: 24,
    inverterTareW: 14,
  };
  const toggles = { disableHumidifier: false, dcDirectMode: false, preChillPacks: false };

  const plan = solveMinimalRepair(sc, params, toggles, SEED_SURROGATES['typhoon-cpap']);
  assert.equal(plan.kind, 'hybrid_continuous_sized');
  assert.equal(plan.sizedParam?.key, 'batteryWh');
  assert.ok(Number.isFinite(plan.sizedParam?.toValue ?? NaN));
  assert.ok((plan.sizedParam?.toValue ?? 0) > 512 && (plan.sizedParam?.toValue ?? 0) <= 2048);

  const verifySnap = computeSimulation(sc.id, plan.repairedParams, plan.repairedToggles);
  assert.equal(verifySnap.isSafe, true, 'Bounded Brent repair must achieve compliant margin');
});

test('Seam S3.3: Out-of-range scenario extrapolates minimum required physical capacity honestly', () => {
  const sc = SCENARIOS['typhoon-cpap'];
  const extremeParams = {
    batteryWh: 512,
    outageHours: 60,
    cpapWatts: 68,
    coolerWatts: 55,
    inverterTareW: 22,
  };
  const toggles = { disableHumidifier: false, dcDirectMode: false, preChillPacks: false };

  const plan = solveMinimalRepair(sc, extremeParams, toggles);
  assert.equal(plan.kind, 'out_of_range_extrapolated');
  assert.ok(
    (plan.extrapolatedRequirement?.requiredValue ?? 0) > 2048,
    `Expected extrapolated battery requirement > 2048Wh max slider, got ${plan.extrapolatedRequirement?.requiredValue}`,
  );
});
