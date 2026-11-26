import {
  computeSimulation,
  type ScenarioDefinition,
  type ScrubParam,
} from './faultlineEngine.ts';
import {
  evaluateCalibratedSurrogate,
  type CalibratedSurrogatePacket,
} from './monteCarloSurrogate.ts';

export interface MinimalRepairPlan {
  kind:
    | 'already_safe'
    | 'discrete_sufficient'
    | 'hybrid_continuous_sized'
    | 'out_of_range_extrapolated';
  repairedParams: Record<string, number>;
  repairedToggles: Record<string, boolean>;
  activatedToggleKeys: string[];
  totalFrictionCost: number;
  achievedMargin: number;
  targetMargin: number;
  /** Preview trajectory of the repaired configuration for the emerald Minimal-Fix Fork curve */
  repairedCloudSeries: number[];
  sizedParam?: {
    key: string;
    label: string;
    unit: string;
    fromValue: number;
    toValue: number;
  };
  extrapolatedRequirement?: {
    key: string;
    label: string;
    unit: string;
    sliderLimit: number;
    requiredValue: number;
  };
  summary: string;
}

function getSafeTargetMargin(scenario: ScenarioDefinition): number {
  if (scenario.id === 'typhoon-cpap') return 1.5;
  if (scenario.id === 'singles-day-cutover') return 5.0;
  if (scenario.id === 'expat-cashflow') return 0.5;
  return 0.0;
}

function evaluateSafetyExcess(
  scenario: ScenarioDefinition,
  params: Record<string, number>,
  toggles: Record<string, boolean>,
  targetMargin: number,
  surrogate?: CalibratedSurrogatePacket,
): { excess: number; nominalMargin: number; cloudSeries: number[] } {
  const snap = computeSimulation(scenario.id, params, toggles, scenario);
  let excess = snap.cloudMargin - targetMargin;

  if (surrogate) {
    const surr = evaluateCalibratedSurrogate(scenario, params, toggles, surrogate);
    // Require worst-10% (P10) storm trajectory to also stay non-negative (>= 0% covenant floor)
    const p10FloorTarget = 0.0;
    excess = Math.min(excess, surr.p10Margin - p10FloorTarget);
  }

  return { excess, nominalMargin: snap.cloudMargin, cloudSeries: snap.cloudSeries };
}

/**
 * Derivative-free 16-step bounded Dekker-Brent / bisection hybrid root finder on [xBad, xGood]
 * where f(xBad) < 0 and f(xGood) >= 0. Guaranteed zero NaN / zero division even across flat regions.
 */
function boundedDekkerBrentRoot(
  f: (x: number) => number,
  xBad: number,
  xGood: number,
  maxIter = 16,
): number {
  let a = xBad;
  let b = xGood;
  let fa = f(a);
  let fb = f(b);

  if (fa >= 0) return a;
  if (fb < 0) return b;

  let c = a;
  let fc = fa;
  let d = b - a;
  let e = d;

  for (let iter = 0; iter < maxIter; iter++) {
    if (fb === 0 || Math.abs(b - a) <= 1e-6) break;

    if (Math.sign(fc) === Math.sign(fb)) {
      c = a;
      fc = fa;
      d = b - a;
      e = d;
    }

    if (Math.abs(fc) < Math.abs(fb)) {
      a = b;
      b = c;
      c = a;
      fa = fb;
      fb = fc;
      fc = fa;
    }

    const tol = 2 * Number.EPSILON * Math.abs(b) + 1e-6;
    const m = 0.5 * (c - b);
    if (Math.abs(m) <= tol) break;

    if (Math.abs(e) >= tol && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa;
      let p: number;
      let q: number;
      if (a === c) {
        p = 2 * m * s;
        q = 1 - s;
      } else {
        const qRatio = fa / fc;
        const rRatio = fb / fc;
        p = s * (2 * m * qRatio * (qRatio - rRatio) - (b - a) * (rRatio - 1));
        q = (qRatio - 1) * (rRatio - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      p = Math.abs(p);

      if (2 * p < Math.min(3 * m * q - Math.abs(tol * q), Math.abs(e * q)) && q !== 0) {
        e = d;
        d = p / q;
      } else {
        d = m;
        e = m;
      }
    } else {
      d = m;
      e = m;
    }

    a = b;
    fa = fb;
    if (Math.abs(d) > tol) {
      b += d;
    } else {
      b += m > 0 ? tol : -tol;
    }
    fb = f(b);
  }

  // Ensure returned value lies on the safe side (f >= 0)
  return fb >= 0 ? b : c;
}

function snapTowardSafeEndpoint(rawVal: number, param: ScrubParam, safeEnd: number): number {
  const step = Math.max(1e-6, param.step);
  const stepsFromMin = (rawVal - param.min) / step;
  const snapped =
    safeEnd >= rawVal
      ? param.min + Math.ceil(stepsFromMin - 1e-9) * step
      : param.min + Math.floor(stepsFromMin + 1e-9) * step;
  return Number(Math.max(param.min, Math.min(param.max, snapped)).toFixed(2));
}

/**
 * Two-stage Pareto Minimal-Intervention Repair Solver:
 * - Phase A: Exact 2^m discrete branch-and-bound over mitigation toggles weighted by friction cost.
 * - Phase B: When all toggles combined still fall short, runs 16-step bounded Dekker-Brent
 *            root-finding on unclamped latent trajectory to compute exact continuous sizing.
 */
export function solveMinimalRepair(
  scenario: ScenarioDefinition,
  paramValues: Record<string, number>,
  toggleValues: Record<string, boolean>,
  surrogate?: CalibratedSurrogatePacket,
): MinimalRepairPlan {
  const targetMargin = getSafeTargetMargin(scenario);
  const curEval = evaluateSafetyExcess(scenario, paramValues, toggleValues, targetMargin, surrogate);

  if (curEval.excess >= 0) {
    const activeKeys = scenario.toggles.filter((t) => Boolean(toggleValues[t.key])).map((t) => t.key);
    return {
      kind: 'already_safe',
      repairedParams: { ...paramValues },
      repairedToggles: { ...toggleValues },
      activatedToggleKeys: activeKeys,
      totalFrictionCost: 0,
      achievedMargin: curEval.nominalMargin,
      targetMargin,
      repairedCloudSeries: curEval.cloudSeries,
      summary: `Current specification already holds +${curEval.nominalMargin} ${scenario.marginUnit} (>= ${targetMargin} ${scenario.marginUnit}).`,
    };
  }

  // Phase A: Exact 2^m Discrete Friction-Weighted Search (m <= 8)
  const togglesList = scenario.toggles.slice(0, 8);
  const m = togglesList.length;
  const totalMasks = 1 << m;

  let bestDiscrete: {
    toggles: Record<string, boolean>;
    addedKeys: string[];
    cost: number;
    excess: number;
    nominalMargin: number;
    cloudSeries: number[];
  } | null = null;

  for (let mask = 0; mask < totalMasks; mask++) {
    const candToggles: Record<string, boolean> = { ...toggleValues };
    const addedKeys: string[] = [];
    let cost = 0;

    for (let bit = 0; bit < m; bit++) {
      const tg = togglesList[bit];
      const on = (mask & (1 << bit)) !== 0;
      // Do not turn OFF a toggle the user already enabled unless needed; preserve user choices or add minimal new ones
      if (Boolean(toggleValues[tg.key]) && !on) {
        cost += 999; // skip disabling already-enabled patches
      }
      candToggles[tg.key] = on;
      if (on && !toggleValues[tg.key]) {
        cost += tg.frictionCost ?? 1.0 + bit * 0.25;
        addedKeys.push(tg.key);
      }
    }
    if (cost >= 900) continue;

    const ev = evaluateSafetyExcess(scenario, paramValues, candToggles, targetMargin, surrogate);
    if (ev.excess >= 0) {
      if (
        !bestDiscrete ||
        cost < bestDiscrete.cost - 1e-6 ||
        (Math.abs(cost - bestDiscrete.cost) <= 1e-6 && ev.excess > bestDiscrete.excess)
      ) {
        bestDiscrete = {
          toggles: candToggles,
          addedKeys,
          cost: Number(cost.toFixed(2)),
          excess: ev.excess,
          nominalMargin: ev.nominalMargin,
          cloudSeries: ev.cloudSeries,
        };
      }
    }
  }

  if (bestDiscrete) {
    return {
      kind: 'discrete_sufficient',
      repairedParams: { ...paramValues },
      repairedToggles: bestDiscrete.toggles,
      activatedToggleKeys: bestDiscrete.addedKeys,
      totalFrictionCost: bestDiscrete.cost,
      achievedMargin: bestDiscrete.nominalMargin,
      targetMargin,
      repairedCloudSeries: bestDiscrete.cloudSeries,
      summary: `Minimal Pareto patch: engaged ${bestDiscrete.addedKeys.length}/${m} switch(es) [${bestDiscrete.addedKeys.join(', ')}] → ${bestDiscrete.nominalMargin >= 0 ? '+' : ''}${bestDiscrete.nominalMargin} ${scenario.marginUnit}.`,
    };
  }

  // Phase B: All discrete mitigations ON is still insufficient -> Continuous Latent Dekker-Brent Sizing
  const allOnToggles: Record<string, boolean> = { ...toggleValues };
  for (const tg of togglesList) {
    allOnToggles[tg.key] = true;
  }
  const allOnAddedKeys = togglesList.filter((tg) => !toggleValues[tg.key]).map((tg) => tg.key);
  const baseAllOnEval = evaluateSafetyExcess(scenario, paramValues, allOnToggles, targetMargin, surrogate);

  const controllableParams = scenario.params.filter((p) => p.repairDirection !== undefined);
  // Prioritize primary capacity expansion parameters first (`increase`), then load shedding (`decrease`)
  const sortedControllable = [...controllableParams].sort((a, b) => {
    const aPri = a.repairDirection === 'increase' ? 0 : 1;
    const bPri = b.repairDirection === 'increase' ? 0 : 1;
    return aPri - bPri;
  });

  let bestGainParam: {
    param: ScrubParam;
    bestEndpoint: number;
    endpointEval: ReturnType<typeof evaluateSafetyExcess>;
    gain: number;
  } | null = null;

  for (const p of sortedControllable) {
    const curVal = paramValues[p.key] ?? p.value;
    const bestEndpoint = p.repairDirection === 'increase' ? p.max : p.min;
    if (Math.abs(bestEndpoint - curVal) < 1e-9) continue;

    const endEval = evaluateSafetyExcess(
      scenario,
      { ...paramValues, [p.key]: bestEndpoint },
      allOnToggles,
      targetMargin,
      surrogate,
    );
    const gain = endEval.excess - baseAllOnEval.excess;

    // Prefer the first capacity parameter that actually reaches safety; otherwise track largest latent gain
    if (endEval.excess >= 0 && (!bestGainParam || bestGainParam.endpointEval.excess < 0)) {
      bestGainParam = { param: p, bestEndpoint, endpointEval: endEval, gain };
      if (p.repairDirection === 'increase') break;
    } else if (!bestGainParam || (bestGainParam.endpointEval.excess < 0 && gain > bestGainParam.gain)) {
      bestGainParam = { param: p, bestEndpoint, endpointEval: endEval, gain };
    }
  }

  if (bestGainParam && bestGainParam.endpointEval.excess >= 0) {
    const p = bestGainParam.param;
    const curVal = paramValues[p.key] ?? p.value;
    const safeEnd = bestGainParam.bestEndpoint;

    const rootRaw = boundedDekkerBrentRoot(
      (x) =>
        evaluateSafetyExcess(
          scenario,
          { ...paramValues, [p.key]: x },
          allOnToggles,
          targetMargin,
          surrogate,
        ).excess,
      curVal,
      safeEnd,
      16,
    );

    let snappedVal = snapTowardSafeEndpoint(rootRaw, p, safeEnd);
    let finalEval = evaluateSafetyExcess(
      scenario,
      { ...paramValues, [p.key]: snappedVal },
      allOnToggles,
      targetMargin,
      surrogate,
    );
    // Guarantee discretization rounding never falls 1 step short
    if (finalEval.excess < 0 && snappedVal !== safeEnd) {
      snappedVal = snapTowardSafeEndpoint(
        snappedVal + (safeEnd >= curVal ? p.step : -p.step),
        p,
        safeEnd,
      );
      finalEval = evaluateSafetyExcess(
        scenario,
        { ...paramValues, [p.key]: snappedVal },
        allOnToggles,
        targetMargin,
        surrogate,
      );
    }

    const repairedParams = { ...paramValues, [p.key]: snappedVal };
    return {
      kind: 'hybrid_continuous_sized',
      repairedParams,
      repairedToggles: allOnToggles,
      activatedToggleKeys: allOnAddedKeys,
      totalFrictionCost: Number(
        togglesList.reduce((acc, tg) => acc + (tg.frictionCost ?? 1), 0).toFixed(2),
      ),
      achievedMargin: finalEval.nominalMargin,
      targetMargin,
      repairedCloudSeries: finalEval.cloudSeries,
      sizedParam: {
        key: p.key,
        label: p.label,
        unit: p.unit,
        fromValue: curVal,
        toValue: snappedVal,
      },
      summary: `Switches alone insufficient; sized ${p.label} ${curVal} → ${snappedVal} ${p.unit} + patches (${finalEval.nominalMargin >= 0 ? '+' : ''}${finalEval.nominalMargin} ${scenario.marginUnit}).`,
    };
  }

  // Case B2: Out-of-range linear latent extrapolation
  const fallbackP = bestGainParam?.param ?? sortedControllable[0] ?? scenario.params[0];
  const curVal = paramValues[fallbackP.key] ?? fallbackP.value;
  const endVal =
    bestGainParam?.bestEndpoint ??
    (fallbackP.repairDirection === 'decrease' ? fallbackP.min : fallbackP.max);
  const endEval =
    bestGainParam?.endpointEval ??
    evaluateSafetyExcess(
      scenario,
      { ...paramValues, [fallbackP.key]: endVal },
      allOnToggles,
      targetMargin,
      surrogate,
    );

  const deltaX = endVal - curVal;
  const deltaExcess = Math.max(1e-3, endEval.excess - baseAllOnEval.excess);
  const slopePerUnit = deltaExcess / (Math.abs(deltaX) < 1e-6 ? 1 : deltaX);
  const neededDelta = -baseAllOnEval.excess / slopePerUnit;
  const extrapolatedVal = Math.ceil((curVal + neededDelta) / Math.max(1, fallbackP.step)) * Math.max(1, fallbackP.step);

  return {
    kind: 'out_of_range_extrapolated',
    repairedParams: { ...paramValues, [fallbackP.key]: endVal },
    repairedToggles: allOnToggles,
    activatedToggleKeys: allOnAddedKeys,
    totalFrictionCost: 99,
    achievedMargin: endEval.nominalMargin,
    targetMargin,
    repairedCloudSeries: endEval.cloudSeries,
    extrapolatedRequirement: {
      key: fallbackP.key,
      label: fallbackP.label,
      unit: fallbackP.unit,
      sliderLimit: endVal,
      requiredValue: Math.max(endVal + fallbackP.step, extrapolatedVal),
    },
    summary: `All patches + max ${fallbackP.label} (${endVal} ${fallbackP.unit}) still short; physics requires >= ${Math.max(endVal + fallbackP.step, extrapolatedVal)} ${fallbackP.unit}.`,
  };
}
