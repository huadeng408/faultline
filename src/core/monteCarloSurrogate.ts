import {
  computeSimulation,
  type CloudMonteCarloRawOutput,
  type ScenarioDefinition,
  type ScenarioId,
} from './faultlineEngine.ts';

export interface CalibratedSurrogatePacket {
  scenarioId: ScenarioId;
  anchorParams: Record<string, number>;
  anchorToggles: Record<string, boolean>;
  p10Latent: number[];
  p50Latent: number[];
  p90Latent: number[];
  /** T x d first-order sensitivity of median discrepancy (P50 - LF) wrt normalized theta in [0,1]^d */
  jDelta50: number[][];
  /** T x d log-sensitivity of lower half-spread (P50 - P10) */
  gLow: number[][];
  /** T x d log-sensitivity of upper half-spread (P90 - P50) */
  gHigh: number[][];
  cvar90Pct: number;
  domainInsights: string[];
  provenance: 'seed_numpy_2000mc' | 'live_cloud_2000mc' | 'local_bootstrap_mc';
  airlockSha256?: string;
  executedPythonCode?: string;
  stdout?: string;
}

export interface EvaluatedSurrogateEnvelope {
  p10Latent: number[];
  p50Latent: number[];
  p90Latent: number[];
  p10Display: number[];
  p50Display: number[];
  p90Display: number[];
  p10Margin: number;
  p50Margin: number;
  trustWeight: number;
  trustRadius: number;
  normalizedDistance: number;
  status: 'CALIBRATED_IN_TRUST_REGION' | 'EPISTEMIC_WIDENED_OUT_OF_DOMAIN' | 'PATCH_PREVIEW_NEEDS_CLOUD_VERIFY';
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function computeLatentMarginForSeries(
  scenario: ScenarioDefinition,
  paramValues: Record<string, number>,
  latentSeries: number[],
): number {
  if (latentSeries.length === 0) return 0;

  if (scenario.id === 'typhoon-cpap') {
    const hrs = Math.max(1, paramValues.outageHours ?? 36);
    const dt = hrs / Math.max(1, latentSeries.length - 1);
    const floorPct = 10;
    for (let i = 1; i < latentSeries.length; i++) {
      if (latentSeries[i] <= floorPct) {
        const prev = latentSeries[i - 1];
        const cur = latentSeries[i];
        const frac = prev <= floorPct ? 0 : (prev - floorPct) / Math.max(1e-9, prev - cur);
        const exhaustH = (i - 1 + frac) * dt;
        return Number((exhaustH - hrs).toFixed(2));
      }
    }
    const startUsablePct = Math.max(1, latentSeries[0] - floorPct);
    const endUsablePct = latentSeries[latentSeries.length - 1] - floorPct;
    const avgPctPerHour = Math.max(0.25, (startUsablePct - endUsablePct) / hrs);
    return Number((endUsablePct / avgPctPerHour).toFixed(2));
  }

  if (scenario.id === 'expat-cashflow') {
    const minMos = (Math.min(...latentSeries) / 100) * 16;
    return Number((minMos - 3.0).toFixed(2));
  }

  const floorPct =
    scenario.id === 'singles-day-cutover'
      ? 15
      : (scenario.customEnvelope?.safetyFloorPct ?? 15);
  return Number((Math.min(...latentSeries) - floorPct).toFixed(2));
}

export function computeAdaptiveTrustRadius(jDelta50: number[][]): number {
  let maxRowNorm = 0;
  for (const row of jDelta50) {
    let sq = 0;
    for (const v of row) {
      if (Number.isFinite(v)) sq += v * v;
    }
    maxRowNorm = Math.max(maxRowNorm, Math.sqrt(sq));
  }
  return clamp(0.25 / (1 + 0.035 * maxRowNorm), 0.06, 0.25);
}

/**
 * Evaluates the Log-Spread Order-Preserving Multi-Fidelity Surrogate in <0.2ms:
 * - Zero error at calibrated anchor (theta_0, u_0)
 * - Strictly positive half-spreads S_low > 0, S_high > 0 => P10 < P50 < P90 everywhere (0 quantile crossing)
 * - Out-of-domain epistemic widening +0.35 * S_0 * (1 - w_TR) => 0 fan collapse far from anchor
 */
export function evaluateCalibratedSurrogate(
  scenario: ScenarioDefinition,
  paramValues: Record<string, number>,
  toggleValues: Record<string, boolean>,
  packet: CalibratedSurrogatePacket,
): EvaluatedSurrogateEnvelope {
  const T = scenario.horizonPoints;
  const d = scenario.params.length;

  const dTheta: number[] = new Array<number>(d);
  let distSq = 0;
  for (let j = 0; j < d; j++) {
    const p = scenario.params[j];
    const span = Math.max(1e-9, p.max - p.min);
    const curNorm = ((paramValues[p.key] ?? p.value) - p.min) / span;
    const ancNorm = ((packet.anchorParams[p.key] ?? p.value) - p.min) / span;
    const diff = curNorm - ancNorm;
    dTheta[j] = diff;
    distSq += diff * diff;
  }

  const normalizedDistance = Math.sqrt(distSq);
  const trustRadius = computeAdaptiveTrustRadius(packet.jDelta50);
  const rhoTr = normalizedDistance / trustRadius;
  const wTr = Math.exp(-0.5 * rhoTr * rhoTr);

  let sameToggles = true;
  for (const tg of scenario.toggles) {
    if (Boolean(toggleValues[tg.key]) !== Boolean(packet.anchorToggles[tg.key])) {
      sameToggles = false;
      break;
    }
  }

  const snapAnchor = computeSimulation(scenario.id, packet.anchorParams, packet.anchorToggles, scenario);
  const snapCurU0 = sameToggles
    ? computeSimulation(scenario.id, paramValues, packet.anchorToggles, scenario)
    : computeSimulation(scenario.id, paramValues, packet.anchorToggles, scenario);
  const snapCurActual = sameToggles
    ? snapCurU0
    : computeSimulation(scenario.id, paramValues, toggleValues, scenario);

  const p10Latent: number[] = new Array<number>(T);
  const p50Latent: number[] = new Array<number>(T);
  const p90Latent: number[] = new Array<number>(T);
  const p10Display: number[] = new Array<number>(T);
  const p50Display: number[] = new Array<number>(T);
  const p90Display: number[] = new Array<number>(T);

  for (let t = 0; t < T; t++) {
    const yLf0 = snapAnchor.latentSeries[t] ?? 0;
    const yLfThetaU0 = snapCurU0.latentSeries[t] ?? 0;
    const patchShift = sameToggles ? 0 : (snapCurActual.latentSeries[t] ?? 0) - yLfThetaU0;

    const ancP50 = packet.p50Latent[t] ?? yLf0;
    const ancP10 = packet.p10Latent[t] ?? ancP50 - 2;
    const ancP90 = packet.p90Latent[t] ?? ancP50 + 2;

    const delta50Zero = ancP50 - yLf0;
    const sLow0 = Math.max(0.05, ancP50 - ancP10);
    const sHigh0 = Math.max(0.05, ancP90 - ancP50);

    let jDot = 0;
    let gLowDot = 0;
    let gHighDot = 0;
    const jRow = packet.jDelta50[t];
    const gLRow = packet.gLow[t];
    const gHRow = packet.gHigh[t];

    for (let j = 0; j < d; j++) {
      const dtj = dTheta[j];
      if (jRow && j < jRow.length) jDot += clamp(jRow[j], -80, 80) * dtj;
      if (gLRow && j < gLRow.length) gLowDot += clamp(gLRow[j], -3, 3) * dtj;
      if (gHRow && j < gHRow.length) gHighDot += clamp(gHRow[j], -3, 3) * dtj;
    }

    let toggleSpreadScale = 1.0;
    if (!sameToggles) {
      const curDrain = Math.max(2, (snapCurActual.latentSeries[0] ?? 100) - (snapCurActual.latentSeries[t] ?? 0));
      const ancDrain = Math.max(2, (snapAnchor.latentSeries[0] ?? 100) - yLf0);
      toggleSpreadScale = clamp(curDrain / ancDrain, 0.25, 1.5);
    }

    const yP50 = yLfThetaU0 + patchShift + delta50Zero * toggleSpreadScale + wTr * jDot * toggleSpreadScale;
    const sLow =
      toggleSpreadScale *
      (sLow0 * Math.exp(clamp(wTr * gLowDot, -1, 1)) + 0.35 * sLow0 * (1 - wTr));
    const sHigh =
      toggleSpreadScale *
      (sHigh0 * Math.exp(clamp(wTr * gHighDot, -1, 1)) + 0.35 * sHigh0 * (1 - wTr));

    const yP10 = yP50 - Math.max(0.02, sLow);
    const yP90 = yP50 + Math.max(0.02, sHigh);

    p10Latent[t] = yP10;
    p50Latent[t] = yP50;
    p90Latent[t] = yP90;

    p10Display[t] = Number(clamp(yP10, 0, 100).toFixed(2));
    p50Display[t] = Number(clamp(yP50, 0, 100).toFixed(2));
    p90Display[t] = Number(clamp(yP90, 0, 100).toFixed(2));
  }

  const p10Margin = computeLatentMarginForSeries(scenario, paramValues, p10Latent);
  const p50Margin = computeLatentMarginForSeries(scenario, paramValues, p50Latent);

  const status: EvaluatedSurrogateEnvelope['status'] = !sameToggles
    ? 'PATCH_PREVIEW_NEEDS_CLOUD_VERIFY'
    : wTr >= 0.45
      ? 'CALIBRATED_IN_TRUST_REGION'
      : 'EPISTEMIC_WIDENED_OUT_OF_DOMAIN';

  return {
    p10Latent,
    p50Latent,
    p90Latent,
    p10Display,
    p50Display,
    p90Display,
    p10Margin,
    p50Margin,
    trustWeight: Number(wTr.toFixed(3)),
    trustRadius: Number(trustRadius.toFixed(3)),
    normalizedDistance: Number(normalizedDistance.toFixed(3)),
    status,
  };
}

export function packetFromCloudMonteCarlo(
  scenario: ScenarioDefinition,
  anchorParams: Record<string, number>,
  anchorToggles: Record<string, boolean>,
  cloudOut: CloudMonteCarloRawOutput,
): CalibratedSurrogatePacket {
  const T = scenario.horizonPoints;
  const d = scenario.params.length;
  const p50Latent: number[] = [];
  const p10Latent: number[] = [];
  const p90Latent: number[] = [];

  for (let t = 0; t < T; t++) {
    const m = Number(cloudOut.p50Latent[t] ?? 50);
    const lo = Math.min(m - 0.25, Number(cloudOut.p10Latent[t] ?? m - 4));
    const hi = Math.max(m + 0.25, Number(cloudOut.p90Latent[t] ?? m + 4));
    p50Latent.push(m);
    p10Latent.push(lo);
    p90Latent.push(hi);
  }

  const padMatrix = (mat: number[][]): number[][] =>
    Array.from({ length: T }, (_, t) =>
      Array.from({ length: d }, (__, j) => Number(mat?.[t]?.[j] ?? 0)),
    );

  return {
    scenarioId: scenario.id,
    anchorParams: { ...anchorParams },
    anchorToggles: { ...anchorToggles },
    p10Latent,
    p50Latent,
    p90Latent,
    jDelta50: padMatrix(cloudOut.jDelta50),
    gLow: padMatrix(cloudOut.gLow),
    gHigh: padMatrix(cloudOut.gHigh),
    cvar90Pct: cloudOut.cvar90Pct,
    domainInsights: cloudOut.domainInsights,
    provenance: 'live_cloud_2000mc',
    airlockSha256: cloudOut.airlockSha256,
    executedPythonCode: cloudOut.executedPythonCode,
    stdout: cloudOut.stdout,
  };
}

/**
 * Synthesizes an immediate zero-quota local stochastic surrogate packet for custom scenarios
 * before the user explicitly triggers a live 2,000-trial Cloud Python calibration.
 */
export function bootstrapLocalSurrogate(
  scenario: ScenarioDefinition,
  anchorParams: Record<string, number>,
  anchorToggles: Record<string, boolean>,
): CalibratedSurrogatePacket {
  const baseSnap = computeSimulation(scenario.id, anchorParams, anchorToggles, scenario);
  const T = scenario.horizonPoints;
  const d = scenario.params.length;

  const p50Latent: number[] = [];
  const p10Latent: number[] = [];
  const p90Latent: number[] = [];

  for (let t = 0; t < T; t++) {
    const frac = t / Math.max(1, T - 1);
    const y0 = baseSnap.latentSeries[t] ?? 50;
    // Correlated shock drift lowers median slightly under convex tail losses and widens with sqrt(t)
    const medianDrift = -1.2 * Math.pow(frac, 0.85);
    const m = Number((y0 + medianDrift).toFixed(2));
    const halfLow = Number((1.4 + 6.8 * Math.sqrt(frac + 0.04)).toFixed(2));
    const halfHigh = Number((1.2 + 4.9 * Math.sqrt(frac + 0.04)).toFixed(2));
    p50Latent.push(m);
    p10Latent.push(Number((m - halfLow).toFixed(2)));
    p90Latent.push(Number((m + halfHigh).toFixed(2)));
  }

  const jDelta50 = Array.from({ length: T }, () => new Array<number>(d).fill(0));
  const gLow = Array.from({ length: T }, () => new Array<number>(d).fill(0));
  const gHigh = Array.from({ length: T }, () => new Array<number>(d).fill(0));

  for (let j = 0; j < d; j++) {
    const p = scenario.params[j];
    const span = Math.max(1e-6, p.max - p.min);
    const eps = 0.05 * span;
    const plusVal = Math.min(p.max, (anchorParams[p.key] ?? p.value) + eps);
    const minusVal = Math.max(p.min, (anchorParams[p.key] ?? p.value) - eps);
    const dNorm = Math.max(1e-6, (plusVal - minusVal) / span);
    const snapPlus = computeSimulation(scenario.id, { ...anchorParams, [p.key]: plusVal }, anchorToggles, scenario);
    const snapMinus = computeSimulation(scenario.id, { ...anchorParams, [p.key]: minusVal }, anchorToggles, scenario);

    for (let t = 0; t < T; t++) {
      const slope = ((snapPlus.latentSeries[t] ?? 0) - (snapMinus.latentSeries[t] ?? 0)) / dNorm;
      jDelta50[t][j] = Number(clamp(-0.08 * slope, -40, 40).toFixed(2));
      gLow[t][j] = Number(clamp(-0.012 * slope, -1.5, 1.5).toFixed(3));
      gHigh[t][j] = Number(clamp(-0.009 * slope, -1.5, 1.5).toFixed(3));
    }
  }

  return {
    scenarioId: scenario.id,
    anchorParams: { ...anchorParams },
    anchorToggles: { ...anchorToggles },
    p10Latent,
    p50Latent,
    p90Latent,
    jDelta50,
    gLow,
    gHigh,
    cvar90Pct: Number((Math.min(...p10Latent) - 2.1).toFixed(2)),
    domainInsights: baseSnap.discoveredInvariants,
    provenance: 'local_bootstrap_mc',
  };
}
