import { initializeApp, getApps, type FirebaseOptions } from 'firebase/app';
import {
  getAI,
  GoogleAIBackend,
  getGenerativeModel,
  InferenceMode,
  InferenceSource,
  Schema,
  type GenerativeModel,
} from 'firebase/ai';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import {
  getRemoteConfig,
  fetchAndActivate,
  getValue,
} from 'firebase/remote-config';
import QRCode from 'qrcode';
import {
  assertZeroSensitiveEgress,
  buildBuckinghamAirlockPacket,
  type BuckinghamAirlockPacket,
} from './buckinghamAirlock.ts';

export type BuiltinScenarioId = 'typhoon-cpap' | 'singles-day-cutover' | 'expat-cashflow';
export type ScenarioId = BuiltinScenarioId | (string & {});

export interface ScrubParam {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  description: string;
  /** Direction that increases safety margin for bounded repair root-finding */
  repairDirection?: 'increase' | 'decrease';
}

export interface MitigationToggle {
  key: string;
  label: string;
  effectBadge: string;
  enabled: boolean;
  description: string;
  /** Engineering friction weight used by Pareto minimal-intervention solver */
  frictionCost?: number;
}

export interface ProseClause {
  id: string;
  title: string;
  segments: Array<
    | { type: 'text'; content: string }
    | { type: 'param'; paramKey: string }
    | { type: 'toggle'; toggleKey: string }
  >;
}

export interface ConflictArc {
  id: string;
  fromClauseId: string;
  toClauseId: string;
  severity: 'critical' | 'warning';
  summary: string;
  localLatencyMs: number;
  provenance?: 'deterministic' | 'on_device' | 'in_cloud';
}

export interface RegionNode {
  id: string;
  name: string;
  lat: number;
  lng: number;
  loadPct: number;
  status: 'healthy' | 'degraded' | 'saturated';
}

export type CustomTimeWindow =
  | { kind: 'always' }
  | { kind: 'interval'; startStep: number; endStep: number }
  | { kind: 'periodic'; periodSteps: number; onStart: number; onEnd: number }
  | { kind: 'ramp'; startStep: number; fullStep: number };

export interface CustomLoadSpec {
  id: string;
  label: string;
  value: number;
  unit: string;
  polarity: 'drain' | 'recharge';
  window: CustomTimeWindow;
  mitigationLabel?: string;
  mitigationMult?: number;
  omittedByNaive?: boolean;
}

export interface CustomEnvelopeSpec {
  archetype: 'cumulative_stock' | 'peak_capacity' | 'queue_backpressure';
  safetyFloorPct: number;
  usableInitFraction: number;
  capacityValue: number;
  capacityUnit: string;
  horizonValue: number;
  loads: CustomLoadSpec[];
}

export interface CreateCustomScenarioInput {
  id?: string;
  title: string;
  subtitle?: string;
  archetype: 'cumulative_stock' | 'peak_capacity' | 'queue_backpressure';
  marginUnit: string;
  horizonLabel: string;
  axisXUnit: string;
  axisYLabel?: string;
  safetyFloorPct: number;
  usableInitFraction?: number;
  capacityValue: number;
  capacityUnit: string;
  horizonValue: number;
  rawPrivateSample?: string;
  defaultPrivacyLock?: boolean;
  loads: CustomLoadSpec[];
}

export interface ScenarioDefinition {
  id: ScenarioId;
  badge: string;
  title: string;
  subtitle: string;
  marginUnit: string;
  horizonLabel: string;
  horizonPoints: number;
  axisXUnit: string;
  axisYLabel: string;
  safetyFloorPct: number;
  safeMarginTarget: number;
  defaultPrivacyLock: boolean;
  rawPrivateSample: string;
  params: ScrubParam[];
  toggles: MitigationToggle[];
  clauses: ProseClause[];
  regions: RegionNode[];
  customEnvelope?: CustomEnvelopeSpec;
  pythonTemplate: (vals: Record<string, number>, toggles: Record<string, boolean>) => {
    code: string;
    stdout: string;
    discoveredInvariants: string[];
  };
}

export interface SimulationSnapshot {
  localSeries: number[];
  cloudSeries: number[];
  /** Unclamped latent trajectory (%) preserving non-zero slope past 0%/100% saturation boundaries */
  latentSeries: number[];
  safetyFloorPct: number;
  xLabels: string[];
  localMargin: number;
  cloudMargin: number;
  effectiveMargin: number;
  driftDelta: number;
  isSafe: boolean;
  failurePointLabel: string;
  conflicts: ConflictArc[];
  pythonCode: string;
  pythonStdout: string;
  discoveredInvariants: string[];
  regions: RegionNode[];
}

/**
 * Unconditionally A-stable exact exponential integrator step for transient backlog Q(t + dt)
 * with timeout reneging rate -Q / T_out,s. Exact for arbitrary step size dt > 0 under piecewise-constant arrival.
 */
export function stepExponentialQueueExact(
  qNow: number,
  effectiveArrivalRps: number,
  serviceCapacityRps: number,
  timeoutSec: number,
  dtSec: number,
): number {
  const tout = Math.max(1e-6, timeoutSec);
  const dec = Math.exp(-dtSec / tout);
  const nextQ = qNow * dec + (effectiveArrivalRps - serviceCapacityRps) * tout * (1 - dec);
  return Math.max(0, nextQ);
}

const CUSTOM_SCENARIO_REGISTRY = new Map<string, ScenarioDefinition>();

export function registerCustomScenario(spec: ScenarioDefinition): void {
  CUSTOM_SCENARIO_REGISTRY.set(spec.id, spec);
}

export function getScenarioById(id: ScenarioId): ScenarioDefinition {
  if (id in SCENARIOS) {
    return SCENARIOS[id as BuiltinScenarioId];
  }
  return CUSTOM_SCENARIO_REGISTRY.get(id) ?? SCENARIOS['typhoon-cpap'];
}

function evalCustomWindowWeight(win: CustomTimeWindow, stepIdx: number): number {
  if (win.kind === 'always') return 1;
  if (win.kind === 'interval') {
    return stepIdx >= win.startStep && stepIdx <= win.endStep ? 1 : 0;
  }
  if (win.kind === 'periodic') {
    const p = Math.max(1, win.periodSteps);
    const phase = stepIdx % p;
    return phase >= win.onStart && phase <= win.onEnd ? 1 : 0;
  }
  const span = Math.max(1, win.fullStep - win.startStep);
  if (stepIdx <= win.startStep) return 0;
  return Math.min(1, (stepIdx - win.startStep) / span);
}

function avgCustomWindowDuty(win: CustomTimeWindow, totalSteps: number): number {
  let acc = 0;
  for (let i = 0; i < totalSteps; i++) {
    acc += evalCustomWindowWeight(win, i);
  }
  return acc / Math.max(1, totalSteps);
}

export function createCustomScenario(input: CreateCustomScenarioInput): ScenarioDefinition {
  const slug =
    input.id ??
    `custom-${input.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 28) || 'envelope'}`;

  const usableInitFraction =
    input.usableInitFraction ?? (input.archetype === 'cumulative_stock' ? 0.92 : 1.0);

  const capStep = Math.max(1, Math.round(input.capacityValue * 0.05));
  const horStep = Math.max(1, Math.round(input.horizonValue / 24));

  const params: ScrubParam[] = [
    {
      key: 'capacityValue',
      label:
        input.archetype === 'queue_backpressure'
          ? 'Worker / Pool Ceiling'
          : input.archetype === 'peak_capacity'
            ? 'Rail / Breaker Ceiling'
            : 'Primary Reserve Capacity',
      unit: input.capacityUnit,
      min: Math.max(1, Math.round(input.capacityValue * 0.4)),
      max: Math.max(10, Math.round(input.capacityValue * 2.4)),
      step: capStep,
      value: input.capacityValue,
      description: `Primary ${input.capacityUnit} envelope ceiling`,
      repairDirection: 'increase',
    },
    {
      key: 'horizonValue',
      label: 'Operating Window',
      unit: input.axisXUnit,
      min: Math.max(2, Math.round(input.horizonValue * 0.5)),
      max: Math.max(6, Math.round(input.horizonValue * 2.0)),
      step: horStep,
      value: input.horizonValue,
      description: `Total stress-test duration in ${input.axisXUnit}`,
    },
  ];

  const toggles: MitigationToggle[] = [];

  for (const ld of input.loads) {
    const pKey = `load_${ld.id}`;
    const step = ld.value >= 100 ? Math.max(5, Math.round(ld.value * 0.04)) : ld.value >= 10 ? 1 : 0.5;
    params.push({
      key: pKey,
      label: ld.label,
      unit: ld.unit,
      min: Math.max(0, Number((ld.value * 0.25).toFixed(1))),
      max: Math.max(ld.value + step * 4, Number((ld.value * 2.0).toFixed(1))),
      step,
      value: ld.value,
      description: `${ld.polarity === 'recharge' ? 'Recharge inflow' : 'Active load'}: ${ld.label}`,
      repairDirection: ld.polarity === 'drain' ? 'decrease' : 'increase',
    });

    if (ld.mitigationLabel) {
      toggles.push({
        key: `mit_${ld.id}`,
        label: `${ld.mitigationLabel} (${ld.label})`,
        effectBadge: ld.mitigationLabel,
        enabled: false,
        description: `Applies ×${(ld.mitigationMult ?? 0.6).toFixed(2)} envelope relief to ${ld.label}`,
        frictionCost: 1.0 + toggles.length * 0.45,
      });
    }
  }

  if (input.archetype === 'queue_backpressure') {
    params.push(
      {
        key: 'timeoutMs',
        label: 'Request Timeout',
        unit: 'ms',
        min: 400,
        max: 4000,
        step: 100,
        value: 1800,
        description: 'Per-attempt timeout before client retry / reneging',
      },
      {
        key: 'retries',
        label: 'Sync Retry Count',
        unit: 'x',
        min: 0,
        max: 5,
        step: 1,
        value: 3,
        description: 'Client retry multiplier under queue saturation',
        repairDirection: 'decrease',
      },
    );
    if (toggles.length === 0) {
      toggles.push({
        key: 'mit_retry_cap',
        label: 'Enforce 10% Adaptive Retry Token Bucket',
        effectBadge: 'Cap Retries <= 10%',
        enabled: false,
        description: 'Suppresses retry storm amplification when queue wait approaches timeout',
        frictionCost: 1.0,
      });
    }
  }

  const clause1Segs: ProseClause['segments'] = [
    { type: 'text', content: 'Primary envelope is bounded at ' },
    { type: 'param', paramKey: 'capacityValue' },
    { type: 'text', content: ' across a ' },
    { type: 'param', paramKey: 'horizonValue' },
    { type: 'text', content: ` window with a mandatory ${input.safetyFloorPct}% safety floor.` },
  ];

  const clause2Segs: ProseClause['segments'] = [{ type: 'text', content: 'Active flows combine ' }];
  input.loads.forEach((ld, idx) => {
    if (idx > 0) {
      clause2Segs.push({ type: 'text', content: idx === input.loads.length - 1 ? ' and ' : ', ' });
    }
    clause2Segs.push({ type: 'text', content: `${ld.label} (` });
    clause2Segs.push({ type: 'param', paramKey: `load_${ld.id}` });
    clause2Segs.push({ type: 'text', content: ')' });
  });
  clause2Segs.push({ type: 'text', content: '.' });

  const clause3Segs: ProseClause['segments'] =
    toggles.length > 0
      ? [
          { type: 'text', content: 'Mitigation patches available on blueprint: ' },
          ...toggles.flatMap((tg, idx) =>
            idx === 0
              ? [{ type: 'toggle' as const, toggleKey: tg.key }]
              : [{ type: 'text' as const, content: ' + ' }, { type: 'toggle' as const, toggleKey: tg.key }],
          ),
          { type: 'text', content: '.' },
        ]
      : [
          {
            type: 'text',
            content: 'No discrete switches configured; resize primary capacity pill to clear violations.',
          },
        ];

  const customEnvelope: CustomEnvelopeSpec = {
    archetype: input.archetype,
    safetyFloorPct: input.safetyFloorPct,
    usableInitFraction,
    capacityValue: input.capacityValue,
    capacityUnit: input.capacityUnit,
    horizonValue: input.horizonValue,
    loads: input.loads,
  };

  const spec: ScenarioDefinition = {
    id: slug,
    badge: `Scenario 04 · Custom ${
      input.archetype === 'peak_capacity'
        ? 'Peak Breaker'
        : input.archetype === 'queue_backpressure'
          ? 'Queue Storm'
          : 'Stock & Recharge'
    }`,
    title: input.title,
    subtitle:
      input.subtitle ??
      'Open-domain Hybrid AI specification compiled from nameplate scan / free-form prose into Buckingham-Π verified physics.',
    marginUnit: input.marginUnit,
    horizonLabel: input.horizonLabel,
    horizonPoints: 37,
    axisXUnit: input.axisXUnit,
    axisYLabel:
      input.axisYLabel ??
      (input.archetype === 'peak_capacity'
        ? 'Instantaneous Rail Headroom (%)'
        : input.archetype === 'queue_backpressure'
          ? 'Available Concurrency Headroom (%)'
          : 'Remaining Usable Stock (%)'),
    safetyFloorPct: input.safetyFloorPct,
    safeMarginTarget: 0,
    defaultPrivacyLock: input.defaultPrivacyLock ?? true,
    rawPrivateSample:
      input.rawPrivateSample ??
      `Custom Asset Spec: ${input.title} | Facility Node: Bay-04 Internal | Inspector: Eng_Lead_Local`,
    params,
    toggles,
    clauses: [
      { id: 'x1', title: '§1. Primary Capacity & Safety Covenant', segments: clause1Segs },
      { id: 'x2', title: '§2. Coincident Drain & Recharge Schedule', segments: clause2Segs },
      { id: 'x3', title: '§3. Structural Mitigation Controls', segments: clause3Segs },
    ],
    regions: [
      { id: 'node-a', name: 'Primary Supply Rail', lat: 35.68, lng: 139.76, loadPct: 88, status: 'saturated' },
      { id: 'node-b', name: 'Coincident Bus', lat: 35.44, lng: 139.63, loadPct: 72, status: 'degraded' },
      { id: 'node-c', name: 'Reserve Buffer', lat: 34.69, lng: 135.5, loadPct: 40, status: 'healthy' },
    ],
    customEnvelope,
    pythonTemplate: (vals, tgs) => {
      const cap = Math.max(1e-6, vals.capacityValue ?? input.capacityValue);
      const hor = Math.max(1e-6, vals.horizonValue ?? input.horizonValue);
      const loadsJson = JSON.stringify(
        input.loads.map((ld) => ({
          val: vals[`load_${ld.id}`] ?? ld.value,
          pol: ld.polarity,
          win: ld.window,
          mult: ld.mitigationLabel && tgs[`mit_${ld.id}`] ? (ld.mitigationMult ?? 0.6) : 1.0,
        })),
      );

      const pyWeightHelper = `def weight(w, i):
    k = w['kind']
    if k == 'always': return 1.0
    if k == 'interval': return 1.0 if w['startStep'] <= i <= w['endStep'] else 0.0
    if k == 'periodic':
        ph = i % max(1, w['periodSteps'])
        return 1.0 if w['onStart'] <= ph <= w['onEnd'] else 0.0
    if i <= w['startStep']: return 0.0
    return min(1.0, (i - w['startStep']) / max(1.0, w['fullStep'] - w['startStep']))`;

      if (input.archetype === 'peak_capacity') {
        const code = `import json, numpy as np

cap = float(${cap})
floor_pct = float(${input.safetyFloorPct})
loads = json.loads('${loadsJson}')

${pyWeightHelper}

lat = np.zeros(37)
for i in range(37):
    net = sum((1.0 if l['pol'] == 'drain' else -1.0) * l['val'] * l['mult'] * weight(l['win'], i) for l in loads)
    lat[i] = (1.0 - net / cap) * 100.0

custom_margin = round(float(lat.min() - floor_pct), 1)
print(f"peak_cap={cap:.1f} min_lat_pct={lat.min():.2f} custom_margin={custom_margin:+.1f}")
print("series_json=" + json.dumps(np.round(lat, 2).tolist()))`;
        return {
          code,
          stdout: `archetype=peak_capacity cap=${cap}${input.capacityUnit} floor=${input.safetyFloorPct}%`,
          discoveredInvariants: [
            `Coincident peak envelope evaluates worst-step instantaneous load sum against ${cap} ${input.capacityUnit} rail.`,
            `Naive time-averaged sizing misses simultaneous startup overlap and uncounted auxiliary tare.`,
            `Safety floor enforces ${input.safetyFloorPct}% continuous derating headroom.`,
          ],
        };
      }

      if (input.archetype === 'queue_backpressure') {
        const toutMs = vals.timeoutMs ?? 1800;
        const retries = vals.retries ?? 3;
        const retryCapOn = Boolean(tgs.mit_retry_cap) || Object.values(tgs).some(Boolean);
        const baseRps =
          (vals[`load_${input.loads[0]?.id}`] ?? input.loads[0]?.value ?? 1200) *
          (input.loads[0]?.mitigationLabel && tgs[`mit_${input.loads[0].id}`]
            ? (input.loads[0].mitigationMult ?? 0.6)
            : 1.0);
        const code = `import json, numpy as np

pool = float(${cap})
tout_s = float(${toutMs}) / 1000.0
tau = 0.085
retries = int(${retries})
budget_on = ${retryCapOn ? 'True' : 'False'}
dt = (float(${hor}) * 60.0) / 540.0
q = 0.0
lat = np.zeros(37)

for k in range(541):
    m_frac = k / 540.0
    wave = 0.65 + 3.5 * m_frac if m_frac < (6.0/36.0) else (1.0 + 0.16 * np.sin(((m_frac * 36.0 - 6.0) / 18.0) * np.pi) if m_frac < (24.0/36.0) else 0.82)
    lam0 = float(${baseRps}) * wave
    wq = (q * tau) / pool
    p_to = 1.0 - np.exp(-max(0.0, wq + tau - 0.70 * tout_s) / (0.30 * tout_s))
    amp = 1.0 if p_to < 1e-9 else (1.0 - p_to ** (retries + 1)) / max(1e-9, 1.0 - p_to)
    if budget_on:
        amp = min(1.10, amp)
    rho = (lam0 * amp * tau + (q * tau) / tout_s) / pool
    rho_lat = rho if rho <= 1.0 else 1.0 + np.log(rho)
    if k % 15 == 0:
        lat[k // 15] = (1.0 - rho_lat) * 100.0
    if k < 540:
        dec = np.exp(-dt / tout_s)
        q = max(0.0, q * dec + (lam0 * amp - pool / tau) * tout_s * (1.0 - dec))

custom_margin = round(float(lat.min() - float(${input.safetyFloorPct})), 1)
print(f"pool={pool:.1f} custom_margin={custom_margin:+.1f}")
print("series_json=" + json.dumps(np.round(lat, 2).tolist()))`;
        return {
          code,
          stdout: `archetype=queue_backpressure pool=${cap} timeout=${toutMs}ms`,
          discoveredInvariants: [
            `A-stable exponential queue step captures metastable retry backlog after surge peak subsides.`,
            `Timeout reneging bounds backlog while preserving Little's Law lock-hold saturation.`,
          ],
        };
      }

      const code = `import json, numpy as np

cap = float(${cap})
hor = float(${hor})
dt = hor / 36.0
floor_pct = float(${input.safetyFloorPct})
loads = json.loads('${loadsJson}')

${pyWeightHelper}

stock = np.zeros(37)
stock[0] = cap * float(${usableInitFraction})
for i in range(1, 37):
    rech = sum(l['val'] * l['mult'] * weight(l['win'], i) for l in loads if l['pol'] == 'recharge')
    drn = sum(l['val'] * l['mult'] * weight(l['win'], i) for l in loads if l['pol'] == 'drain')
    stock[i] = min(cap, stock[i - 1] + (rech - drn / 0.94) * dt)

lat = (stock / cap) * 100.0
custom_margin = round(float(lat.min() - floor_pct), 1)
print(f"cap={cap:.1f} min_lat_pct={lat.min():.2f} custom_margin={custom_margin:+.1f}")
print("series_json=" + json.dumps(np.round(lat, 2).tolist()))`;
      return {
        code,
        stdout: `archetype=cumulative_stock cap=${cap}${input.capacityUnit} init=${(usableInitFraction * 100).toFixed(0)}%`,
        discoveredInvariants: [
          `Bidirectional conservation integrates periodic recharge inflows against conversion-loss drains (η=0.94).`,
          `Unclamped latent trajectory tracks exact deficit below ${input.safetyFloorPct}% covenant floor.`,
        ],
      };
    },
  };

  registerCustomScenario(spec);
  return spec;
}

export const SCENARIOS: Record<BuiltinScenarioId, ScenarioDefinition> & Record<string, ScenarioDefinition> = {
  'typhoon-cpap': {
    id: 'typhoon-cpap',
    badge: 'Scenario 01 · Emergency Holdover',
    title: '36-Hour Typhoon Blackout Power Plan',
    subtitle: 'Keep home CPAP therapy, 2–8°C cooler storage, and emergency comms alive on one portable LiFePO4 station.',
    marginUnit: 'hrs',
    horizonLabel: '36h Storm Window',
    horizonPoints: 37,
    axisXUnit: 'h',
    axisYLabel: 'Remaining Total Pack SoC (%)',
    safetyFloorPct: 10,
    safeMarginTarget: 1.5,
    defaultPrivacyLock: false,
    rawPrivateSample:
      'Household: Lin Family Apt 1402, Minato-ku | Emergency Contact: +81-90-4412-8890 | Device Serial: AirSense11-JP-99281',
    params: [
      {
        key: 'batteryWh',
        label: 'Station Capacity',
        unit: 'Wh',
        min: 512,
        max: 2048,
        step: 32,
        value: 1024,
        description: 'Nominal LiFePO4 portable power station energy capacity',
        repairDirection: 'increase',
      },
      {
        key: 'outageHours',
        label: 'Blackout Duration',
        unit: 'h',
        min: 12,
        max: 60,
        step: 1,
        value: 36,
        description: 'Projected utility grid restoration window during typhoon stall',
      },
      {
        key: 'cpapWatts',
        label: 'Nightly CPAP Draw',
        unit: 'W',
        min: 18,
        max: 68,
        step: 2,
        value: 38,
        description: 'Blower draw during 8h sleep cycles (excluding heated humidifier tube)',
        repairDirection: 'decrease',
      },
      {
        key: 'coolerWatts',
        label: '2–8°C Cooler Avg',
        unit: 'W',
        min: 12,
        max: 55,
        step: 1,
        value: 24,
        description: 'Thermoelectric/compressor duty-cycle draw at 29°C indoor ambient',
        repairDirection: 'decrease',
      },
      {
        key: 'inverterTareW',
        label: 'AC Inverter Idle Loss',
        unit: 'W',
        min: 0,
        max: 22,
        step: 1,
        value: 14,
        description: 'Hidden pure-sine AC inverter quiescent tare uncovered by nameplate/Python audit',
        repairDirection: 'decrease',
      },
    ],
    toggles: [
      {
        key: 'disableHumidifier',
        label: 'Disable CPAP Heated Humidifier (+26W saved)',
        effectBadge: '-26W Sleep Load',
        enabled: false,
        description: 'Switch CPAP to passive HME inline moisture filter during outage nights',
        frictionCost: 2.1,
      },
      {
        key: 'dcDirectMode',
        label: 'Use 12V/24V DC Buck Cable (Kill AC Inverter Tare)',
        effectBadge: 'Eliminates AC Tare',
        enabled: false,
        description: 'Shut off 110V AC inverter stage and power CPAP + cooler via regulated DC rails',
        frictionCost: 1.0,
      },
      {
        key: 'preChillPacks',
        label: 'Pre-Freeze Phase-Change Ice Bricks (6h Duty Buffer)',
        effectBadge: '-32% Cooler Duty',
        enabled: false,
        description: 'Thermal mass buffer cuts compressor cycling during peak afternoon heat',
        frictionCost: 1.4,
      },
    ],
    clauses: [
      {
        id: 'c1',
        title: '§1. Primary Energy Envelope',
        segments: [
          { type: 'text', content: 'Our household relies on a single portable LiFePO4 pack rated at ' },
          { type: 'param', paramKey: 'batteryWh' },
          { type: 'text', content: ' to survive a projected ' },
          { type: 'param', paramKey: 'outageHours' },
          { type: 'text', content: ' grid outage without rooftop solar recharge.' },
        ],
      },
      {
        id: 'c2',
        title: '§2. Critical Nighttime Respiratory Load',
        segments: [
          { type: 'text', content: 'Across two 8-hour overnight sleep windows, CPAP therapy draws ' },
          { type: 'param', paramKey: 'cpapWatts' },
          { type: 'text', content: ' base blower power, while passive humidification is currently ' },
          { type: 'toggle', toggleKey: 'disableHumidifier' },
          { type: 'text', content: '.' },
        ],
      },
      {
        id: 'c3',
        title: '§3. Continuous Cold-Chain & Conversion Path',
        segments: [
          { type: 'text', content: 'The 2–8°C medical cooler averages ' },
          { type: 'param', paramKey: 'coolerWatts' },
          { type: 'text', content: ' continuously, plus ' },
          { type: 'param', paramKey: 'inverterTareW' },
          { type: 'text', content: ' AC inverter quiescent overhead unless ' },
          { type: 'toggle', toggleKey: 'dcDirectMode' },
          { type: 'text', content: ' and ' },
          { type: 'toggle', toggleKey: 'preChillPacks' },
          { type: 'text', content: ' are engaged.' },
        ],
      },
    ],
    regions: [
      { id: 'tokyo', name: 'Tokyo Grid Sector 4', lat: 35.6762, lng: 139.6503, loadPct: 94, status: 'saturated' },
      { id: 'yokohama', name: 'Yokohama Substation', lat: 35.4437, lng: 139.638, loadPct: 86, status: 'degraded' },
      { id: 'osaka', name: 'Osaka Backup Relay', lat: 34.6937, lng: 135.5023, loadPct: 41, status: 'healthy' },
    ],
    pythonTemplate: (v, t) => {
      const bat = v.batteryWh ?? 1024;
      const hrs = v.outageHours ?? 36;
      const cpap = v.cpapWatts ?? 38;
      const cooler = v.coolerWatts ?? 24;
      const tare = v.inverterTareW ?? 14;
      const usableWh = bat * 0.9;
      const humW = t.disableHumidifier ? 0 : (26 / 1024) * bat;
      const effTare = t.dcDirectMode ? (1.5 / 1024) * bat : tare;
      const coolerFactor = t.preChillPacks ? 0.68 : 1.0;
      const auxW = (5.5 / 1024) * bat;
      const kneeW = (75 / 1024) * bat;
      return {
        code: `import json, numpy as np

# Cloud Gemini Code Execution — Non-Linear LiFePO4 BMS & Thermal Solver
bat_wh = float(${bat})
hrs = float(${hrs})
usable_wh = bat_wh * 0.90  # 10% BMS low-voltage lockout floor
n = 37
dt = hrs / (n - 1)
rem = np.zeros(n)
rem[0] = usable_wh
exhaust_h = None

for i in range(1, n):
    h = i * dt
    clock_h = (14.0 + h) % 24.0
    is_sleep = (clock_h >= 22.0) or (clock_h < 6.0)
    cpap_w = (${cpap} + ${humW.toFixed(6)}) if is_sleep else 0.0
    ambient_drift = 1.0 + 0.18 * np.sin((h - 8.0) * np.pi / 12.0)
    cooler_w = ${cooler} * ${coolerFactor.toFixed(4)} * max(0.82, ambient_drift)
    peukert_eff = 0.94 if (cpap_w + cooler_w) < ${kneeW.toFixed(6)} else 0.88
    draw = ((cpap_w + cooler_w + ${auxW.toFixed(6)}) / peukert_eff + ${effTare.toFixed(6)}) * dt
    rem[i] = rem[i - 1] - draw
    if rem[i] <= 0.0 and exhaust_h is None:
        prev_h = (i - 1) * dt
        exhaust_h = prev_h + (rem[i - 1] / max(1e-9, rem[i - 1] - rem[i])) * dt

lat_pct = 10.0 + (rem / bat_wh) * 100.0
if exhaust_h is not None:
    margin_h = round(float(exhaust_h - hrs), 1)
else:
    avg_draw = (usable_wh - rem[-1]) / max(1.0, hrs)
    margin_h = round(float(rem[-1] / max(1.0, avg_draw)), 1)
print(f"usable_wh={usable_wh:.1f} end_rem_wh={rem[-1]:.1f} margin_h={margin_h:+.1f}")
print("series_json=" + json.dumps(np.round(lat_pct, 2).tolist()))`,
        stdout: `usable_wh=${usableWh.toFixed(1)} inverter_tare=${effTare.toFixed(1)}W humidifier_extra=${humW.toFixed(1)}W`,
        discoveredInvariants: [
          `BMS low-voltage cutoff locks out bottom 10% (${(bat * 0.1).toFixed(0)} Wh unavailable below safety floor).`,
          `AC pure-sine inverter burns ${effTare.toFixed(1)}W × ${hrs}h = ${(effTare * hrs).toFixed(0)} Wh even when loads idle.`,
          `Heated humidifier tube adds +${humW.toFixed(0)}W across overnight sleep windows (22:00–06:00).`,
        ],
      };
    },
  },
  'singles-day-cutover': {
    id: 'singles-day-cutover',
    badge: 'Scenario 02 · Distributed SRE Cutover',
    title: 'Global Payment Active-Active Cutover (99.99% SLA)',
    subtitle: 'Stress-test retry amplification against PostgreSQL connection pools before draining primary region.',
    marginUnit: 'pool %',
    horizonLabel: '36-Min Drain Window',
    horizonPoints: 37,
    axisXUnit: 'm',
    axisYLabel: 'Available DB Pool Headroom (%)',
    safetyFloorPct: 15,
    safeMarginTarget: 5.0,
    defaultPrivacyLock: false,
    rawPrivateSample:
      'Internal DSN: postgres://svc_ledger_prod@10.48.19.12:5432/settle_v4 | Merchant Tier-0 Key: mk_live_99104a8c',
    params: [
      {
        key: 'rps',
        label: 'Peak Checkout RPS',
        unit: 'req/s',
        min: 1500,
        max: 9000,
        step: 100,
        value: 5200,
        description: 'Sustained payment authorization ingress traffic during regional drain',
        repairDirection: 'decrease',
      },
      {
        key: 'timeoutMs',
        label: 'Gateway Timeout',
        unit: 'ms',
        min: 400,
        max: 3500,
        step: 100,
        value: 2000,
        description: 'Upstream API gateway per-attempt timeout before triggering retry',
      },
      {
        key: 'retries',
        label: 'Client Retry Count',
        unit: 'x',
        min: 0,
        max: 5,
        step: 1,
        value: 3,
        description: 'Automatic synchronous retries configured in mobile checkout SDK',
        repairDirection: 'decrease',
      },
      {
        key: 'dbPoolMax',
        label: 'PgBouncer Max Pool',
        unit: 'conns',
        min: 200,
        max: 1000,
        step: 20,
        value: 480,
        description: 'Hard PostgreSQL primary transaction pool connection ceiling',
        repairDirection: 'increase',
      },
      {
        key: 'crossRegionRttMs',
        label: 'Failover Cross-Region RTT',
        unit: 'ms',
        min: 18,
        max: 160,
        step: 4,
        value: 68,
        description: 'Added lock-hold latency per 2-phase ledger write across regions',
        repairDirection: 'decrease',
      },
    ],
    toggles: [
      {
        key: 'tokenBucketRetry',
        label: 'Adaptive Retry Budget (Cap Retries <= 10%)',
        effectBadge: 'Kills Retry Storm',
        enabled: false,
        description: 'Enforce Envoy client-side retry token bucket to prevent 3x amplification',
        frictionCost: 1.0,
      },
      {
        key: 'circuitBreaker',
        label: 'Fail-Fast Queue Shedding at 250ms P99',
        effectBadge: '-42% Lock Hold',
        enabled: false,
        description: 'Trip regional circuit breaker before PgBouncer wait queue cascades',
        frictionCost: 1.7,
      },
      {
        key: 'asyncOutbox',
        label: 'Defer Audit Writes to Async Outbox',
        effectBadge: '-24ms Tx Hold',
        enabled: false,
        description: 'Remove synchronous cross-region audit insert from critical lock path',
        frictionCost: 1.35,
      },
    ],
    clauses: [
      {
        id: 's1',
        title: '§1. Ingress Cutover Traffic Target',
        segments: [
          { type: 'text', content: 'During primary region drain, standby cluster absorbs ' },
          { type: 'param', paramKey: 'rps' },
          { type: 'text', content: ' checkout authorizations while maintaining <=0.01% error budget.' },
        ],
      },
      {
        id: 's2',
        title: '§2. Retry & Timeout Policy',
        segments: [
          { type: 'text', content: 'Mobile SDKs enforce a ' },
          { type: 'param', paramKey: 'timeoutMs' },
          { type: 'text', content: ' timeout with ' },
          { type: 'param', paramKey: 'retries' },
          { type: 'text', content: ' immediate retries unless ' },
          { type: 'toggle', toggleKey: 'tokenBucketRetry' },
          { type: 'text', content: ' is active.' },
        ],
      },
      {
        id: 's3',
        title: '§3. Database Connection Pool Ceiling',
        segments: [
          { type: 'text', content: 'PgBouncer caps active ledger connections at ' },
          { type: 'param', paramKey: 'dbPoolMax' },
          { type: 'text', content: ' across ' },
          { type: 'param', paramKey: 'crossRegionRttMs' },
          { type: 'text', content: ' cross-region RTT, guarded by ' },
          { type: 'toggle', toggleKey: 'circuitBreaker' },
          { type: 'text', content: ' and ' },
          { type: 'toggle', toggleKey: 'asyncOutbox' },
          { type: 'text', content: '.' },
        ],
      },
    ],
    regions: [
      { id: 'ap-ne1', name: 'ap-northeast-1 (Tokyo)', lat: 35.68, lng: 139.76, loadPct: 96, status: 'saturated' },
      { id: 'eu-ce1', name: 'eu-central-1 (Frankfurt)', lat: 50.11, lng: 8.68, loadPct: 78, status: 'degraded' },
      { id: 'us-ea1', name: 'us-east-1 (N. Virginia)', lat: 38.95, lng: -77.45, loadPct: 52, status: 'healthy' },
      { id: 'ap-se1', name: 'ap-southeast-1 (Singapore)', lat: 1.35, lng: 103.82, loadPct: 64, status: 'healthy' },
    ],
    pythonTemplate: (v, t) => {
      const rps = v.rps ?? 5200;
      const timeoutMs = v.timeoutMs ?? 2000;
      const retries = v.retries ?? 3;
      const pool = v.dbPoolMax ?? 480;
      const rtt = v.crossRegionRttMs ?? 68;
      const budgetOn = Boolean(t.tokenBucketRetry);
      const cbOn = Boolean(t.circuitBreaker);
      const asyncOn = Boolean(t.asyncOutbox);
      const baseMs = Math.max(
        0.006 * timeoutMs,
        0.009 * timeoutMs + rtt - (asyncOn ? 0.012 * timeoutMs : 0),
      );
      const tau = (baseMs / 1000) * (cbOn ? 0.58 : 1.0);
      return {
        code: `import json, numpy as np

# Unconditionally A-Stable Exact Exponential Queue Integrator (dt=4s, 540 substeps)
rps = float(${rps})
tout_s = float(${timeoutMs}) / 1000.0
retries = int(${retries})
pool = float(${pool})
tau = float(${tau.toFixed(8)})
budget_on = ${budgetOn ? 'True' : 'False'}
dt = 4.0
q = 0.0
lat_pct = np.zeros(37)

for k in range(541):
    m = (k * dt) / 60.0
    wave = (0.65 + m * 0.06) if m < 6.0 else (1.0 + 0.16 * np.sin(((m - 6.0) / 18.0) * np.pi) if m < 24.0 else 0.82)
    lam0 = rps * wave
    wq = (q * tau) / pool
    p_to = 1.0 - np.exp(-max(0.0, wq + tau - 0.70 * tout_s) / (0.30 * tout_s))
    amp = 1.0 if p_to < 1e-9 else (1.0 - p_to ** (retries + 1)) / max(1e-9, 1.0 - p_to)
    if budget_on:
        amp = min(1.10, amp)
    rho = (lam0 * amp * tau + (q * tau) / tout_s) / pool
    rho_lat = rho if rho <= 1.0 else (1.0 + np.log(rho))
    if k % 15 == 0:
        lat_pct[k // 15] = (1.0 - rho_lat) * 100.0
    if k < 540:
        dec = np.exp(-dt / tout_s)
        q = max(0.0, q * dec + (lam0 * amp - pool / tau) * tout_s * (1.0 - dec))

headroom = round(float(lat_pct.min() - 15.0), 1)
print(f"tau_ms={tau*1000:.1f} min_lat_pct={lat_pct.min():.2f} headroom={headroom:+.1f}")
print("series_json=" + json.dumps(np.round(lat_pct, 2).tolist()))`,
        stdout: `tau_ms=${(tau * 1000).toFixed(1)}ms retries=${retries}x pool_cap=${pool}`,
        discoveredInvariants: [
          `Little's Law: ${rps} req/s × ${(tau * 1000).toFixed(0)}ms effective hold consumes ${Math.round(rps * tau)} conns before retry amplification.`,
          `Metastable backlog hysteresis: once queue wait W_q exceeds 70% of ${timeoutMs}ms timeout, synchronous ${retries}x retries pin PgBouncer even after traffic subsides.`,
          `A-stable exponential step exp(-Δt/T_out) resolves timeout reneging without CFL stiffness oscillation.`,
        ],
      };
    },
  },
  'expat-cashflow': {
    id: 'expat-cashflow',
    badge: 'Scenario 03 · Privacy-Locked Cashflow',
    title: 'Cross-Border Relocation & Floating-Rate Runway',
    subtitle: 'Keep exact salary & bank balances Strictly On-Device while Cloud tests FX + floating-rate shocks on scrubbed ratios.',
    marginUnit: 'mos',
    horizonLabel: '36-Month Runway',
    horizonPoints: 37,
    axisXUnit: 'mo',
    axisYLabel: 'Liquid Emergency Buffer (%)',
    safetyFloorPct: 18.75,
    safeMarginTarget: 0.5,
    defaultPrivacyLock: true,
    rawPrivateSample:
      'Employee: Kenji Sato (Passport JP-8831042) | Net Salary: ¥1,180,000/mo | Shinsei Vault Acct #0049-8829104: ¥12,980,000 | Rent: ¥495,600/mo',
    params: [
      {
        key: 'reserveMonths',
        label: 'Initial Liquid Runway',
        unit: 'mos',
        min: 4,
        max: 24,
        step: 1,
        value: 11,
        description: 'Starting liquid savings expressed in baseline monthly income multiples',
        repairDirection: 'increase',
      },
      {
        key: 'housingRatioPct',
        label: 'Floating Housing Ratio',
        unit: '%',
        min: 20,
        max: 65,
        step: 1,
        value: 42,
        description: 'Share of monthly net income committed to floating-rate lease/mortgage',
        repairDirection: 'decrease',
      },
      {
        key: 'fxShockPct',
        label: 'FX Depreciation Shock',
        unit: '%',
        min: 0,
        max: 30,
        step: 1,
        value: 16,
        description: 'Home-currency slide against destination tuition & settlement obligations',
        repairDirection: 'decrease',
      },
      {
        key: 'rateHikeBps',
        label: 'Central Bank Rate Hike',
        unit: 'bps',
        min: 0,
        max: 400,
        step: 25,
        value: 225,
        description: 'Cumulative floating-rate reset shock over months 6–18',
        repairDirection: 'decrease',
      },
      {
        key: 'relocOneOffMos',
        label: 'Upfront Deposit & Tax Lag',
        unit: 'mos',
        min: 1,
        max: 8,
        step: 0.5,
        value: 3.5,
        description: 'Dual-residency withholding lag + key-money/deposit cash lockup at month 2',
        repairDirection: 'decrease',
      },
    ],
    toggles: [
      {
        key: 'fxForwardCap',
        label: 'Lock 60% FX Forward Corridor',
        effectBadge: '-60% FX Tail Risk',
        enabled: false,
        description: 'Hedge foreign-currency fixed commitments via 12-month forward contract',
        frictionCost: 1.15,
      },
      {
        key: 'rateCapClause',
        label: 'Switch to 3-Year Fixed Rate Cap (+35bps)',
        effectBadge: 'Caps Hike at +75bps',
        enabled: false,
        description: 'Eliminate uncapped floating reset exposure after month 6',
        frictionCost: 1.45,
      },
      {
        key: 'staggerMove',
        label: 'Stagger Lease Overlap by 45 Days',
        effectBadge: '+1.4 mos Buffer',
        enabled: false,
        description: 'Avoid paying dual-country rent + deposit lockup in the same billing cycle',
        frictionCost: 1.0,
      },
    ],
    clauses: [
      {
        id: 'f1',
        title: '§1. Privacy-Locked Baseline Runway',
        segments: [
          { type: 'text', content: 'Household holds ' },
          { type: 'param', paramKey: 'reserveMonths' },
          { type: 'text', content: ' of baseline runway after absorbing ' },
          { type: 'param', paramKey: 'relocOneOffMos' },
          { type: 'text', content: ' upfront relocation & dual-tax withholding lag (' },
          { type: 'toggle', toggleKey: 'staggerMove' },
          { type: 'text', content: ').' },
        ],
      },
      {
        id: 'f2',
        title: '§2. Floating Debt & FX Exposure',
        segments: [
          { type: 'text', content: 'Fixed housing consumes ' },
          { type: 'param', paramKey: 'housingRatioPct' },
          { type: 'text', content: ' of net inflow, exposed to a ' },
          { type: 'param', paramKey: 'fxShockPct' },
          { type: 'text', content: ' currency slide and +' },
          { type: 'param', paramKey: 'rateHikeBps' },
          { type: 'text', content: ' floating reset.' },
        ],
      },
      {
        id: 'f3',
        title: '§3. Downside Hedge Covenants',
        segments: [
          { type: 'text', content: 'Minimum 3.0-month emergency floor is enforced via ' },
          { type: 'toggle', toggleKey: 'fxForwardCap' },
          { type: 'text', content: ' and ' },
          { type: 'toggle', toggleKey: 'rateCapClause' },
          { type: 'text', content: '.' },
        ],
      },
    ],
    regions: [
      { id: 'tyo-home', name: 'Tokyo JPY Payroll', lat: 35.6762, lng: 139.6503, loadPct: 88, status: 'degraded' },
      { id: 'lon-dest', name: 'London GBP Lease', lat: 51.5072, lng: -0.1276, loadPct: 91, status: 'saturated' },
      { id: 'sgp-fx', name: 'Singapore FX Clearing', lat: 1.3521, lng: 103.8198, loadPct: 48, status: 'healthy' },
    ],
    pythonTemplate: (v, t) => {
      const resMos = v.reserveMonths ?? 11;
      const housing = v.housingRatioPct ?? 42;
      const fx = v.fxShockPct ?? 16;
      const bps = v.rateHikeBps ?? 225;
      const lag = v.relocOneOffMos ?? 3.5;
      const effFx = t.fxForwardCap ? fx * 0.4 : fx;
      const effBps = t.rateCapClause ? Math.min(bps, 75) : bps;
      const effLag = Math.max(0.5, lag - (t.staggerMove ? 1.4 : 0));
      return {
        code: `import json, numpy as np

# Buckingham-Pi Scrubbed Ratio Cashflow Stress Solver (Zero Raw Currency Egress)
runway = np.zeros(37)
runway[0] = float(${resMos})
for m in range(1, 37):
    fx_drag = (${effFx.toFixed(6)} / 100.0) * 0.55 * min(1.0, m / 6.0)
    rate_drag = (${housing} / 100.0) * (${effBps} / 10000.0) * 11.5 * (1.0 if m >= 6 else 0.25)
    tax_lag = 0.15 if (m in (4, 5, 16, 17)) else 0.0
    net_burn = (0.385 + (${housing} / 100.0) + fx_drag + rate_drag + tax_lag) - 0.82
    lockup = ${effLag.toFixed(6)} if m == 2 else 0.0
    runway[m] = runway[m - 1] - lockup - max(-0.06, net_burn)

lat_pct = (runway / 16.0) * 100.0
min_runway = float(runway.min())
floor_delta = round(min_runway - 3.0, 1)
print(f"m2_runway={runway[2]:.2f} min_runway_36m={min_runway:+.2f} floor_delta={floor_delta:+.1f}")
print("series_json=" + json.dumps(np.round(lat_pct, 2).tolist()))`,
        stdout: `scrubbed_ratios_only=True eff_fx=${effFx.toFixed(1)}% eff_bps=${effBps}bps lag=${effLag.toFixed(1)}mos`,
        discoveredInvariants: [
          `Month-2 deposit + dual-residency withholding lag drops liquid buffer by ${effLag.toFixed(1)} mos alongside regular rent burn.`,
          `FX depreciation (${effFx.toFixed(1)}%) + floating reset (+${effBps}bps) compound continuously after month 6.`,
          `Raw salary, passport, and vault balances remain 100% on-device via Buckingham-Π dimensionless normalization.`,
        ],
      };
    },
  },
};

export function computeSimulation(
  scenarioId: ScenarioId,
  paramValues: Record<string, number>,
  toggleValues: Record<string, boolean>,
  customScenario?: ScenarioDefinition,
): SimulationSnapshot {
  const sc = customScenario ?? getScenarioById(scenarioId);
  const n = sc.horizonPoints;
  const localSeries: number[] = [];
  const cloudSeries: number[] = [];
  const latentSeries: number[] = [];
  const xLabels: string[] = [];
  const conflicts: ConflictArc[] = [];

  if (sc.id === 'typhoon-cpap') {
    const bat = paramValues.batteryWh ?? 1024;
    const hrs = paramValues.outageHours ?? 36;
    const cpap = paramValues.cpapWatts ?? 38;
    const cooler = paramValues.coolerWatts ?? 24;
    const tare = paramValues.inverterTareW ?? 14;
    const noHum = Boolean(toggleValues.disableHumidifier);
    const dcMode = Boolean(toggleValues.dcDirectMode);
    const preChill = Boolean(toggleValues.preChillPacks);

    const safetyFloorPct = 10;
    const naiveHourly = (cpap * (8 / 24) + cooler + (4 / 1024) * bat) * (noHum ? 0.86 : 1.0);
    const usableWh = bat * 0.9;
    const humW = noHum ? 0 : (26 / 1024) * bat;
    const effTare = dcMode ? (1.5 / 1024) * bat : tare;
    const coolerMult = preChill ? 0.68 : 1.0;
    const auxW = (5.5 / 1024) * bat;
    const kneeW = (75 / 1024) * bat;
    const dt = hrs / (n - 1);

    let remUsable = usableWh;
    let exhaustHour: number | null = null;

    for (let i = 0; i < n; i++) {
      const h = i * dt;
      xLabels.push(`${Math.round(h)}h`);
      const localPct = Math.max(0, Math.min(100, ((bat - naiveHourly * h) / bat) * 100));
      localSeries.push(Number(localPct.toFixed(1)));

      if (i === 0) {
        latentSeries.push(100.0);
        cloudSeries.push(100.0);
      } else {
        const prevRem = remUsable;
        const clockH = (14 + h) % 24;
        const isSleep = clockH >= 22 || clockH < 6;
        const sleepW = isSleep ? cpap + humW : 0;
        const ambient = 1 + 0.18 * Math.sin(((h - 8) * Math.PI) / 12);
        const cW = cooler * coolerMult * Math.max(0.82, ambient);
        const eff = sleepW + cW < kneeW ? 0.94 : 0.88;
        const draw = ((sleepW + cW + auxW) / eff + effTare) * dt;
        remUsable -= draw;

        if (remUsable <= 0 && exhaustHour === null) {
          const prevH = (i - 1) * dt;
          exhaustHour = prevH + (prevRem / Math.max(1e-9, prevRem - remUsable)) * dt;
        }

        const latPct = Number((safetyFloorPct + (remUsable / bat) * 100).toFixed(2));
        latentSeries.push(latPct);
        cloudSeries.push(Number(Math.max(0, Math.min(100, latPct)).toFixed(1)));
      }
    }

    const avgCloudDraw = (usableWh - remUsable) / Math.max(1, hrs);
    const localMargin = Number((bat / Math.max(1, naiveHourly) - hrs).toFixed(1));
    const cloudMargin =
      exhaustHour !== null
        ? Number((exhaustHour - hrs).toFixed(1))
        : Number((remUsable / Math.max(1, avgCloudDraw)).toFixed(1));

    if (cloudMargin < 1.5) {
      conflicts.push({
        id: 'conf-cpap-1',
        fromClauseId: 'c1',
        toClauseId: 'c2',
        severity: cloudMargin < 0 ? 'critical' : 'warning',
        summary: noHum
          ? `Battery envelope (${bat}Wh) falls short of +1.5h safety buffer over ${hrs}h storm.`
          : `Heated CPAP tube (+${humW.toFixed(0)}W) drains ${bat}Wh pack ${Math.abs(cloudMargin).toFixed(1)}h before grid returns.`,
        localLatencyMs: 0,
        provenance: 'deterministic',
      });
    }
    if (!dcMode && tare >= 8) {
      conflicts.push({
        id: 'conf-cpap-2',
        fromClauseId: 'c1',
        toClauseId: 'c3',
        severity: cloudMargin < 0 ? 'critical' : 'warning',
        summary: `AC inverter idle tare (${tare}W × ${hrs}h = ${Math.round(tare * hrs)}Wh) silently consumes ${Math.round(((tare * hrs) / bat) * 100)}% of pack.`,
        localLatencyMs: 0,
        provenance: 'deterministic',
      });
    }

    const py = sc.pythonTemplate(paramValues, toggleValues);
    return {
      localSeries,
      cloudSeries,
      latentSeries,
      safetyFloorPct,
      xLabels,
      localMargin,
      cloudMargin,
      effectiveMargin: cloudMargin,
      driftDelta: Number((cloudMargin - localMargin).toFixed(1)),
      isSafe: cloudMargin >= 1.5,
      failurePointLabel:
        exhaustHour !== null
          ? `BMS 10% Lockout at Hour ${exhaustHour.toFixed(1)}h`
          : `Holds past ${hrs}h (+${cloudMargin.toFixed(1)}h buffer)`,
      conflicts,
      pythonCode: py.code,
      pythonStdout: py.stdout,
      discoveredInvariants: py.discoveredInvariants,
      regions: sc.regions.map((r, idx) => ({
        ...r,
        loadPct: Math.min(99, Math.max(25, Math.round(r.loadPct + (cloudMargin < 0 ? 5 : -14) - idx * 3))),
        status: cloudMargin < 0 && idx === 0 ? 'saturated' : cloudMargin < 1.5 && idx < 2 ? 'degraded' : 'healthy',
      })),
    };
  }

  if (sc.id === 'singles-day-cutover') {
    const rps = paramValues.rps ?? 5200;
    const timeoutMs = paramValues.timeoutMs ?? 2000;
    const retries = paramValues.retries ?? 3;
    const pool = paramValues.dbPoolMax ?? 480;
    const rtt = paramValues.crossRegionRttMs ?? 68;
    const budgetOn = Boolean(toggleValues.tokenBucketRetry);
    const cbOn = Boolean(toggleValues.circuitBreaker);
    const asyncOn = Boolean(toggleValues.asyncOutbox);

    const safetyFloorPct = 15;
    const toutS = timeoutMs / 1000;
    const baseMs = Math.max(
      0.006 * timeoutMs,
      0.009 * timeoutMs + rtt - (asyncOn ? 0.012 * timeoutMs : 0),
    );
    const tau = (baseMs / 1000) * (cbOn ? 0.58 : 1.0);
    const dt = 4.0; // 540 substeps over 36 minutes (2160s)
    let q = 0;

    for (let k = 0; k <= 540; k++) {
      const m = (k * dt) / 60;
      const wave =
        m < 6 ? 0.65 + m * 0.06 : m < 24 ? 1.0 + 0.16 * Math.sin(((m - 6) / 18) * Math.PI) : 0.82;
      const lam0 = rps * wave;
      const wq = (q * tau) / pool;
      const pTo = 1 - Math.exp(-Math.max(0, wq + tau - 0.7 * toutS) / (0.3 * toutS));
      let amp = pTo < 1e-9 ? 1 : (1 - Math.pow(pTo, retries + 1)) / Math.max(1e-9, 1 - pTo);
      if (budgetOn) {
        amp = Math.min(1.1, amp);
      }

      const rho = (lam0 * amp * tau + (q * tau) / toutS) / pool;
      const rhoLat = rho <= 1 ? rho : 1 + Math.log(rho);

      if (k % 15 === 0) {
        const i = k / 15;
        xLabels.push(`${i}m`);
        const localConns = lam0 * 0.042;
        const localHeadroom = Math.max(0, Math.min(100, ((pool - localConns) / pool) * 100));
        localSeries.push(Number(localHeadroom.toFixed(1)));

        const latPct = Number(((1 - rhoLat) * 100).toFixed(2));
        latentSeries.push(latPct);
        cloudSeries.push(Number(Math.max(0, Math.min(100, latPct)).toFixed(1)));
      }

      if (k < 540) {
        q = stepExponentialQueueExact(q, lam0 * amp, pool / tau, toutS, dt);
      }
    }

    const minLocal = Math.min(...localSeries);
    const minLatent = Math.min(...latentSeries);
    const minCloudDisplay = Math.min(...cloudSeries);
    const localMargin = Number((minLocal - safetyFloorPct).toFixed(1));
    const cloudMargin = Number((minLatent - safetyFloorPct).toFixed(1));

    if (!budgetOn && retries >= 2 && timeoutMs >= 1000) {
      conflicts.push({
        id: 'conf-sre-1',
        fromClauseId: 's1',
        toClauseId: 's2',
        severity: cloudMargin < 0 ? 'critical' : 'warning',
        summary: `${retries}x synchronous retries × ${timeoutMs}ms timeout locks queue into metastable amplification.`,
        localLatencyMs: 0,
        provenance: 'deterministic',
      });
    }
    if (cloudMargin < 5) {
      conflicts.push({
        id: 'conf-sre-2',
        fromClauseId: 's2',
        toClauseId: 's3',
        severity: cloudMargin < 0 ? 'critical' : 'warning',
        summary: `PgBouncer ceiling (${pool} conns) breaches 15% SLA floor under ${(tau * 1000).toFixed(0)}ms lock hold.`,
        localLatencyMs: 0,
        provenance: 'deterministic',
      });
    }

    const py = sc.pythonTemplate(paramValues, toggleValues);
    const breachIdx = latentSeries.findIndex((v) => v < safetyFloorPct);
    return {
      localSeries,
      cloudSeries,
      latentSeries,
      safetyFloorPct,
      xLabels,
      localMargin,
      cloudMargin,
      effectiveMargin: cloudMargin,
      driftDelta: Number((cloudMargin - localMargin).toFixed(1)),
      isSafe: cloudMargin >= 5,
      failurePointLabel:
        breachIdx >= 0
          ? `Pool Collapse at Drain Minute +${breachIdx}m`
          : `Pool Stable (${minCloudDisplay.toFixed(1)}% min headroom)`,
      conflicts,
      pythonCode: py.code,
      pythonStdout: py.stdout,
      discoveredInvariants: py.discoveredInvariants,
      regions: sc.regions.map((r, idx) => ({
        ...r,
        loadPct: Math.min(99, Math.max(22, Math.round(100 - minCloudDisplay * (0.65 + idx * 0.15)))),
        status: cloudMargin < 0 && idx < 2 ? 'saturated' : cloudMargin < 5 && idx < 3 ? 'degraded' : 'healthy',
      })),
    };
  }

  if (sc.id === 'expat-cashflow') {
    const resMos = paramValues.reserveMonths ?? 11;
    const housing = paramValues.housingRatioPct ?? 42;
    const fx = paramValues.fxShockPct ?? 16;
    const bps = paramValues.rateHikeBps ?? 225;
    const lag = paramValues.relocOneOffMos ?? 3.5;
    const fxCap = Boolean(toggleValues.fxForwardCap);
    const rateCap = Boolean(toggleValues.rateCapClause);
    const stagger = Boolean(toggleValues.staggerMove);

    const safetyFloorPct = 18.75; // 3.0 mos / 16.0 mos * 100
    const effFx = fxCap ? fx * 0.4 : fx;
    const effBps = rateCap ? Math.min(bps, 75) : bps;
    const effLag = Math.max(0.5, lag - (stagger ? 1.4 : 0));

    let cloudRunway = resMos;
    const runwayMosSeries: number[] = [];

    for (let i = 0; i < n; i++) {
      xLabels.push(`M${i}`);
      const localMos = Math.max(0, resMos - lag * 0.55 - i * ((housing - 34) * 0.012 + fx * 0.006));
      localSeries.push(Number(Math.min(100, (localMos / 16) * 100).toFixed(1)));

      if (i === 0) {
        cloudRunway = resMos;
      } else {
        const fxDrag = (effFx / 100) * 0.55 * Math.min(1, i / 6);
        const rateDrag = (housing / 100) * (effBps / 10000) * 11.5 * (i >= 6 ? 1 : 0.25);
        const taxLag = i === 4 || i === 5 || i === 16 || i === 17 ? 0.15 : 0;
        const netBurn = 0.385 + housing / 100 + fxDrag + rateDrag + taxLag - 0.82;
        const lockup = i === 2 ? effLag : 0;
        cloudRunway = cloudRunway - lockup - Math.max(-0.06, netBurn);
      }

      runwayMosSeries.push(cloudRunway);
      const latPct = Number(((cloudRunway / 16) * 100).toFixed(2));
      latentSeries.push(latPct);
      cloudSeries.push(Number(Math.max(0, Math.min(100, latPct)).toFixed(1)));
    }

    const minLocalMos = (Math.min(...localSeries) / 100) * 16;
    const minCloudMos = Math.min(...runwayMosSeries);
    const localMargin = Number((minLocalMos - 3.0).toFixed(1));
    const cloudMargin = Number((minCloudMos - 3.0).toFixed(1));

    if (cloudMargin < 0.5) {
      conflicts.push({
        id: 'conf-fin-1',
        fromClauseId: 'f1',
        toClauseId: 'f2',
        severity: cloudMargin < 0 ? 'critical' : 'warning',
        summary: `Upfront ${effLag.toFixed(1)}-mo lockup + ${effFx.toFixed(0)}% FX / +${effBps}bps reset breaches 3.0-mo covenant by ${Math.abs(cloudMargin).toFixed(1)} mos.`,
        localLatencyMs: 0,
        provenance: 'deterministic',
      });
    }
    if (!fxCap || !rateCap) {
      conflicts.push({
        id: 'conf-fin-2',
        fromClauseId: 'f2',
        toClauseId: 'f3',
        severity: 'warning',
        summary: `Unhedged floating housing (${housing}%) exposes §3 3.0-month emergency floor under dual macro shock.`,
        localLatencyMs: 0,
        provenance: 'deterministic',
      });
    }

    const py = sc.pythonTemplate(paramValues, toggleValues);
    const breachIdx = runwayMosSeries.findIndex((m) => m < 3.0);
    return {
      localSeries,
      cloudSeries,
      latentSeries,
      safetyFloorPct,
      xLabels,
      localMargin,
      cloudMargin,
      effectiveMargin: cloudMargin,
      driftDelta: Number((cloudMargin - localMargin).toFixed(1)),
      isSafe: cloudMargin >= 0.5,
      failurePointLabel:
        breachIdx >= 0
          ? `Breaches 3-Mo Floor at Month M${breachIdx}`
          : `Holds 3-Mo Floor (+${cloudMargin.toFixed(1)} mos above covenant)`,
      conflicts,
      pythonCode: py.code,
      pythonStdout: py.stdout,
      discoveredInvariants: py.discoveredInvariants,
      regions: sc.regions,
    };
  }

  // Open-Domain Custom Scenario Execution (peak_capacity | cumulative_stock | queue_backpressure)
  const env = sc.customEnvelope!;
  const cap = Math.max(1e-6, paramValues.capacityValue ?? env.capacityValue);
  const hor = Math.max(1e-6, paramValues.horizonValue ?? env.horizonValue);
  const safetyFloorPct = env.safetyFloorPct;
  const dt = hor / (n - 1);

  if (env.archetype === 'peak_capacity') {
    for (let i = 0; i < n; i++) {
      const tVal = i * dt;
      xLabels.push(`${Number(tVal.toFixed(1))}${sc.axisXUnit}`);

      let naiveNet = 0;
      let trueNet = 0;
      for (const ld of env.loads) {
        const val = paramValues[`load_${ld.id}`] ?? ld.value;
        const mult = ld.mitigationLabel && toggleValues[`mit_${ld.id}`] ? (ld.mitigationMult ?? 0.6) : 1.0;
        const sign = ld.polarity === 'drain' ? 1 : -1;
        trueNet += sign * val * mult * evalCustomWindowWeight(ld.window, i);
        if (!ld.omittedByNaive) {
          naiveNet += sign * val * mult * avgCustomWindowDuty(ld.window, n);
        }
      }

      const localPct = Math.max(0, Math.min(100, (1 - naiveNet / cap) * 100));
      const latPct = Number(((1 - trueNet / cap) * 100).toFixed(2));
      localSeries.push(Number(localPct.toFixed(1)));
      latentSeries.push(latPct);
      cloudSeries.push(Number(Math.max(0, Math.min(100, latPct)).toFixed(1)));
    }
  } else if (env.archetype === 'queue_backpressure') {
    const toutMs = paramValues.timeoutMs ?? 1800;
    const toutS = toutMs / 1000;
    const retries = paramValues.retries ?? 3;
    const tau = 0.085;
    const budgetOn = Boolean(toggleValues.mit_retry_cap) || Object.values(toggleValues).some(Boolean);
    const primaryLoad = env.loads[0];
    const baseRps =
      (paramValues[`load_${primaryLoad?.id}`] ?? primaryLoad?.value ?? 1200) *
      (primaryLoad?.mitigationLabel && toggleValues[`mit_${primaryLoad.id}`]
        ? (primaryLoad.mitigationMult ?? 0.6)
        : 1.0);
    const subDt = (hor * 60) / 540;
    let q = 0;

    for (let k = 0; k <= 540; k++) {
      const mFrac = k / 540;
      const wave =
        mFrac < 6 / 36
          ? 0.65 + 3.5 * mFrac
          : mFrac < 24 / 36
            ? 1.0 + 0.16 * Math.sin(((mFrac * 36 - 6) / 18) * Math.PI)
            : 0.82;
      const lam0 = baseRps * wave;
      const wq = (q * tau) / cap;
      const pTo = 1 - Math.exp(-Math.max(0, wq + tau - 0.7 * toutS) / (0.3 * toutS));
      let amp = pTo < 1e-9 ? 1 : (1 - Math.pow(pTo, retries + 1)) / Math.max(1e-9, 1 - pTo);
      if (budgetOn) amp = Math.min(1.1, amp);

      const rho = (lam0 * amp * tau + (q * tau) / toutS) / cap;
      const rhoLat = rho <= 1 ? rho : 1 + Math.log(rho);

      if (k % 15 === 0) {
        const i = k / 15;
        xLabels.push(`${Number((i * dt).toFixed(1))}${sc.axisXUnit}`);
        const localPct = Math.max(0, Math.min(100, (1 - (lam0 * 0.05) / cap) * 100));
        const latPct = Number(((1 - rhoLat) * 100).toFixed(2));
        localSeries.push(Number(localPct.toFixed(1)));
        latentSeries.push(latPct);
        cloudSeries.push(Number(Math.max(0, Math.min(100, latPct)).toFixed(1)));
      }
      if (k < 540) {
        q = stepExponentialQueueExact(q, lam0 * amp, cap / tau, toutS, subDt);
      }
    }
  } else {
    // cumulative_stock (bidirectional recharge + drain)
    let naiveStock = cap;
    let trueStock = cap * env.usableInitFraction;

    for (let i = 0; i < n; i++) {
      xLabels.push(`${Number((i * dt).toFixed(1))}${sc.axisXUnit}`);
      if (i > 0) {
        let rech = 0;
        let drn = 0;
        let naiveRech = 0;
        let naiveDrn = 0;
        for (const ld of env.loads) {
          const val = paramValues[`load_${ld.id}`] ?? ld.value;
          const mult = ld.mitigationLabel && toggleValues[`mit_${ld.id}`] ? (ld.mitigationMult ?? 0.6) : 1.0;
          const w = evalCustomWindowWeight(ld.window, i);
          const avgW = avgCustomWindowDuty(ld.window, n);
          if (ld.polarity === 'recharge') {
            rech += val * mult * w;
            naiveRech += val * mult * avgW;
          } else {
            drn += val * mult * w;
            if (!ld.omittedByNaive) naiveDrn += val * mult * avgW;
          }
        }
        trueStock = Math.min(cap, trueStock + (rech - drn / 0.94) * dt);
        naiveStock = Math.min(cap, naiveStock + (naiveRech - naiveDrn) * dt);
      }

      const localPct = Math.max(0, Math.min(100, (naiveStock / cap) * 100));
      const latPct = Number(((trueStock / cap) * 100).toFixed(2));
      localSeries.push(Number(localPct.toFixed(1)));
      latentSeries.push(latPct);
      cloudSeries.push(Number(Math.max(0, Math.min(100, latPct)).toFixed(1)));
    }
  }

  const localMargin = Number((Math.min(...localSeries) - safetyFloorPct).toFixed(1));
  const cloudMargin = Number((Math.min(...latentSeries) - safetyFloorPct).toFixed(1));
  const breachIdx = latentSeries.findIndex((v) => v < safetyFloorPct);

  if (cloudMargin < 0) {
    conflicts.push({
      id: 'conf-custom-1',
      fromClauseId: 'x1',
      toClauseId: 'x2',
      severity: 'critical',
      summary: `Envelope drops ${Math.abs(cloudMargin).toFixed(1)} ${sc.marginUnit} below ${safetyFloorPct}% safety covenant at step ${Math.max(0, breachIdx)}.`,
      localLatencyMs: 0,
      provenance: 'deterministic',
    });
  }

  const py = sc.pythonTemplate(paramValues, toggleValues);
  return {
    localSeries,
    cloudSeries,
    latentSeries,
    safetyFloorPct,
    xLabels,
    localMargin,
    cloudMargin,
    effectiveMargin: cloudMargin,
    driftDelta: Number((cloudMargin - localMargin).toFixed(1)),
    isSafe: cloudMargin >= 0,
    failurePointLabel:
      breachIdx >= 0
        ? `Envelope Breach at ${xLabels[breachIdx]}`
        : `Envelope Holds (+${cloudMargin.toFixed(1)} ${sc.marginUnit})`,
    conflicts,
    pythonCode: py.code,
    pythonStdout: py.stdout,
    discoveredInvariants: py.discoveredInvariants,
    regions: sc.regions,
  };
}

export async function computeRedactionReceipt(
  rawText: string,
  paramValues: Record<string, number>,
  scenario?: ScenarioDefinition,
  toggleValues?: Record<string, boolean>,
): Promise<{
  scrubbedPayload: string;
  sha256Hex: string;
  bytesSaved: number;
  airlockPacket: BuckinghamAirlockPacket;
}> {
  const sc = scenario ?? SCENARIOS['typhoon-cpap'];
  const tgs = toggleValues ?? {};
  const nanoEntities = await sharedBridge.extractSensitiveEntitiesLocal(rawText);
  const packet = await buildBuckinghamAirlockPacket(sc, paramValues, tgs, {
    rawPrivateText: rawText,
    nanoEntities,
    scaleCurrencyOverrides: true,
  });
  return {
    scrubbedPayload: packet.outboundJson,
    sha256Hex: packet.sha256Hex,
    bytesSaved: packet.bytesSaved,
    airlockPacket: packet,
  };
}

export async function makeQrDataUrl(payload: string, dark = '#0f172a', light = '#ffffff'): Promise<string> {
  try {
    return await QRCode.toDataURL(payload, {
      margin: 1,
      width: 220,
      color: { dark, light },
      errorCorrectionLevel: 'M',
    });
  } catch {
    return '';
  }
}

export interface LiveHybridStatus {
  sdkVersion: string;
  activeMode: string;
  cloudModel: string;
  deepModel: string;
  deviceReady: boolean;
  visionReady: boolean;
  lastInferenceSource: 'on_device' | 'in_cloud' | 'deterministic';
  lastLatencyMs: number;
  contextTokensUsed: number;
  contextWindowQuota: number;
}

export interface NameplateExtractionResult {
  title: string;
  archetype: 'cumulative_stock' | 'peak_capacity' | 'queue_backpressure';
  capacityValue: number;
  capacityUnit: string;
  primaryLoadLabel: string;
  primaryLoadValue: number;
  primaryLoadUnit: string;
  hiddenTareW: number;
  redactedSerialOrPii: string[];
  inferenceSource: 'on_device' | 'in_cloud' | 'deterministic';
  latencyMs: number;
}

export interface CloudMonteCarloRawOutput {
  p10Latent: number[];
  p50Latent: number[];
  p90Latent: number[];
  jDelta50: number[][];
  gLow: number[][];
  gHigh: number[][];
  cvar90Pct: number;
  domainInsights: string[];
  executedPythonCode: string;
  stdout: string;
  inferenceSource: 'on_device' | 'in_cloud';
  latencyMs: number;
  modelUsed: string;
  airlockSha256: string;
}

export function extractLastMonteCarloExecution(
  parts: Array<Record<string, unknown>>,
): { parsed: Omit<CloudMonteCarloRawOutput, 'executedPythonCode' | 'stdout' | 'inferenceSource' | 'latencyMs' | 'modelUsed' | 'airlockSha256'>; code: string; stdout: string } | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const execRes = part.codeExecutionResult as { outcome?: string; output?: string } | undefined;
    if (!execRes || execRes.outcome !== 'OUTCOME_OK' || typeof execRes.output !== 'string') {
      continue;
    }
    const out = execRes.output;
    const sIdx = out.indexOf('__FL_MC_JSON_START__');
    const eIdx = out.indexOf('__FL_MC_JSON_END__');
    if (sIdx < 0 || eIdx <= sIdx) continue;

    const jsonSlice = out.slice(sIdx + '__FL_MC_JSON_START__'.length, eIdx).trim();
    try {
      const obj = JSON.parse(jsonSlice) as Record<string, unknown>;
      if (!Array.isArray(obj.p10Latent) || !Array.isArray(obj.p50Latent) || !Array.isArray(obj.p90Latent)) {
        continue;
      }
      let code = '';
      for (let j = i - 1; j >= 0; j--) {
        const prevExec = parts[j].executableCode as { code?: string } | undefined;
        if (prevExec && typeof prevExec.code === 'string') {
          code = prevExec.code;
          break;
        }
      }
      return {
        parsed: {
          p10Latent: (obj.p10Latent as number[]).map(Number),
          p50Latent: (obj.p50Latent as number[]).map(Number),
          p90Latent: (obj.p90Latent as number[]).map(Number),
          jDelta50: Array.isArray(obj.jDelta50) ? (obj.jDelta50 as number[][]) : [],
          gLow: Array.isArray(obj.gLow) ? (obj.gLow as number[][]) : [],
          gHigh: Array.isArray(obj.gHigh) ? (obj.gHigh as number[][]) : [],
          cvar90Pct: Number(obj.cvar90Pct ?? 0),
          domainInsights: Array.isArray(obj.domainInsights)
            ? (obj.domainInsights as unknown[]).map(String).slice(0, 3)
            : [],
        },
        code,
        stdout: out,
      };
    } catch {
      continue;
    }
  }
  return null;
}

const PLAIN_CONFLICT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'summary'],
  properties: {
    severity: { type: 'string', enum: ['critical', 'warning'] },
    summary: { type: 'string', maxLength: 160 },
  },
};

const PLAIN_CUSTOM_SPEC_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'archetype', 'capacityValue', 'capacityUnit', 'horizonValue', 'axisXUnit', 'safetyFloorPct', 'loads'],
  properties: {
    title: { type: 'string', maxLength: 64 },
    archetype: { type: 'string', enum: ['cumulative_stock', 'peak_capacity', 'queue_backpressure'] },
    capacityValue: { type: 'number' },
    capacityUnit: { type: 'string', maxLength: 12 },
    horizonValue: { type: 'number' },
    axisXUnit: { type: 'string', maxLength: 6 },
    safetyFloorPct: { type: 'number' },
    loads: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'value', 'unit', 'polarity', 'windowKind'],
        properties: {
          id: { type: 'string', maxLength: 16 },
          label: { type: 'string', maxLength: 36 },
          value: { type: 'number' },
          unit: { type: 'string', maxLength: 12 },
          polarity: { type: 'string', enum: ['drain', 'recharge'] },
          windowKind: { type: 'string', enum: ['always', 'interval', 'periodic'] },
          mitigationLabel: { type: 'string', maxLength: 32 },
        },
      },
    },
  },
};

const PLAIN_NAMEPLATE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'archetype', 'capacityValue', 'capacityUnit', 'primaryLoadLabel', 'primaryLoadValue', 'primaryLoadUnit', 'hiddenTareW', 'redactedSerialOrPii'],
  properties: {
    title: { type: 'string', maxLength: 56 },
    archetype: { type: 'string', enum: ['cumulative_stock', 'peak_capacity', 'queue_backpressure'] },
    capacityValue: { type: 'number' },
    capacityUnit: { type: 'string', maxLength: 10 },
    primaryLoadLabel: { type: 'string', maxLength: 36 },
    primaryLoadValue: { type: 'number' },
    primaryLoadUnit: { type: 'string', maxLength: 10 },
    hiddenTareW: { type: 'number' },
    redactedSerialOrPii: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
};

const PLAIN_NER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entities'],
  properties: {
    entities: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string', maxLength: 48 },
    },
  },
};

const DEFAULT_FAST_CLOUD_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_MC_PRIMARY_MODEL = 'gemini-3.8-flash';
const DEFAULT_MC_FALLBACK_MODEL = 'gemini-3.5-flash-lite';

/**
 * Genuine multi-instance Firebase AI Logic Hybrid SDK runtime (@firebase/ai 3.1.0)
 * + Chrome 158 direct Prompt API (`self.LanguageModel`) local hardware bridge.
 */
export class FaultLineHybridBridge {
  private aiInstance: ReturnType<typeof getAI> | null = null;
  private fastHybridModel: GenerativeModel | null = null;
  private specCompilerHybridModel: GenerativeModel | null = null;
  private cloudFallbackConflictModel: GenerativeModel | null = null;
  private cloudFallbackSpecModel: GenerativeModel | null = null;
  private cloudVisionFallbackModel: GenerativeModel | null = null;
  private strictLocalTextModel: GenerativeModel | null = null;
  private strictLocalVisionModel: GenerativeModel | null = null;
  private cloudMonteCarloPrimary: GenerativeModel | null = null;
  private cloudMonteCarloFallback: GenerativeModel | null = null;
  private inFlightMonteCarlo: Promise<CloudMonteCarloRawOutput> | null = null;
  private mcPrimaryModel = DEFAULT_MC_PRIMARY_MODEL;
  private mcFallbackModel = DEFAULT_MC_FALLBACK_MODEL;
  private appCheckInitialized = false;

  public readonly status: LiveHybridStatus = {
    sdkVersion: 'firebase@13.4.0 / @firebase/ai@3.1.0',
    activeMode: InferenceMode.PREFER_ON_DEVICE,
    cloudModel: DEFAULT_FAST_CLOUD_MODEL,
    deepModel: DEFAULT_MC_PRIMARY_MODEL,
    deviceReady: false,
    visionReady: false,
    lastInferenceSource: 'deterministic',
    lastLatencyMs: 0,
    contextTokensUsed: 0,
    contextWindowQuota: 0,
  };

  public configure(firebaseConfig: FirebaseOptions, recaptchaSiteKey?: string): void {
    if (!firebaseConfig.apiKey || !firebaseConfig.projectId) return;
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    const protocol = typeof window !== 'undefined' ? window.location?.protocol : '';
    if (
      recaptchaSiteKey &&
      !this.appCheckInitialized &&
      (protocol === 'https:' || protocol === 'http:')
    ) {
      initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
        isTokenAutoRefreshEnabled: true,
      });
      this.appCheckInitialized = true;
    }

    const ai = getAI(app, { backend: new GoogleAIBackend() });
    this.aiInstance = ai;

    const cloudConflictSchema = Schema.object({
      properties: {
        severity: Schema.enumString({ enum: ['critical', 'warning'] }),
        summary: Schema.string({ description: 'Concise physical/operational contradiction' }),
      },
    });

    const cloudCustomSpecSchema = Schema.object({
      properties: {
        title: Schema.string(),
        archetype: Schema.enumString({
          enum: ['cumulative_stock', 'peak_capacity', 'queue_backpressure'],
        }),
        capacityValue: Schema.number(),
        capacityUnit: Schema.string(),
        horizonValue: Schema.number(),
        axisXUnit: Schema.string(),
        safetyFloorPct: Schema.number(),
        loads: Schema.array({
          items: Schema.object({
            properties: {
              id: Schema.string(),
              label: Schema.string(),
              value: Schema.number(),
              unit: Schema.string(),
              polarity: Schema.enumString({ enum: ['drain', 'recharge'] }),
              windowKind: Schema.enumString({ enum: ['always', 'interval', 'periodic'] }),
              mitigationLabel: Schema.string(),
            },
            optionalProperties: ['mitigationLabel'],
          }),
        }),
      },
    });

    const cloudNameplateSchema = Schema.object({
      properties: {
        title: Schema.string(),
        archetype: Schema.enumString({
          enum: ['cumulative_stock', 'peak_capacity', 'queue_backpressure'],
        }),
        capacityValue: Schema.number(),
        capacityUnit: Schema.string(),
        primaryLoadLabel: Schema.string(),
        primaryLoadValue: Schema.number(),
        primaryLoadUnit: Schema.string(),
        hiddenTareW: Schema.number(),
        redactedSerialOrPii: Schema.array({ items: Schema.string() }),
      },
    });

    this.fastHybridModel = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: 'text', languages: ['en'] }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }],
        },
        promptOptions: {
          responseConstraint: PLAIN_CONFLICT_JSON_SCHEMA,
          ...({ omitResponseConstraintInput: true } as Record<string, unknown>),
        },
      },
      inCloudParams: {
        model: this.status.cloudModel,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: cloudConflictSchema,
        },
      },
    });

    this.specCompilerHybridModel = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: 'text', languages: ['en'] }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }],
        },
        promptOptions: {
          responseConstraint: PLAIN_CUSTOM_SPEC_JSON_SCHEMA,
          ...({ omitResponseConstraintInput: true } as Record<string, unknown>),
        },
      },
      inCloudParams: {
        model: this.status.cloudModel,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: cloudCustomSpecSchema,
        },
      },
    });

    this.cloudFallbackConflictModel = getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: {
        model: this.status.cloudModel,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: cloudConflictSchema,
        },
      },
    });

    this.cloudFallbackSpecModel = getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: {
        model: this.status.cloudModel,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: cloudCustomSpecSchema,
        },
      },
    });

    this.cloudVisionFallbackModel = getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: {
        model: this.status.cloudModel,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: cloudNameplateSchema,
        },
      },
    });

    // Strict text-only on-device instance (never mix image input here!)
    this.strictLocalTextModel = getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_ON_DEVICE,
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: 'text', languages: ['en'] }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }],
        },
      },
    });

    this.rebuildCloudModels(this.mcPrimaryModel, this.mcFallbackModel);

    // Optional Remote Config dynamic model override (non-blocking)
    if (typeof window !== 'undefined') {
      try {
        const rc = getRemoteConfig(app);
        rc.settings.minimumFetchIntervalMillis = 3600_000;
        rc.defaultConfig = {
          faultline_mc_primary_model: DEFAULT_MC_PRIMARY_MODEL,
          faultline_mc_fallback_model: DEFAULT_MC_FALLBACK_MODEL,
        };
        void fetchAndActivate(rc)
          .then(() => {
            const pModel =
              getValue(rc, 'faultline_mc_primary_model').asString() || DEFAULT_MC_PRIMARY_MODEL;
            const fModel =
              getValue(rc, 'faultline_mc_fallback_model').asString() || DEFAULT_MC_FALLBACK_MODEL;
            this.mcPrimaryModel = pModel;
            this.mcFallbackModel = fModel;
            this.status.deepModel = pModel;
            this.rebuildCloudModels(pModel, fModel);
          })
          .catch(() => {
            // Keep safe defaults offline or when Remote Config is disabled
          });
      } catch {
        // Ignore RC init errors in headless environments
      }
    }
  }

  private rebuildCloudModels(primaryModel: string, fallbackModel: string): void {
    if (!this.aiInstance) return;
    this.cloudMonteCarloPrimary = getGenerativeModel(this.aiInstance, {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: {
        model: primaryModel,
        tools: [{ codeExecution: {} }],
      },
    });
    this.cloudMonteCarloFallback = getGenerativeModel(this.aiInstance, {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: {
        model: fallbackModel,
        tools: [{ codeExecution: {} }],
      },
    });
  }

  private getOrCreateLocalVisionModel(): GenerativeModel | null {
    if (this.strictLocalVisionModel) return this.strictLocalVisionModel;
    if (!this.aiInstance) return null;
    this.strictLocalVisionModel = getGenerativeModel(this.aiInstance, {
      mode: InferenceMode.ONLY_ON_DEVICE,
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }],
        },
      },
    });
    return this.strictLocalVisionModel;
  }

  private getChromeLanguageModelGlobal(): Record<string, unknown> | null {
    const g = globalThis as Record<string, unknown>;
    if (
      g.LanguageModel &&
      (typeof g.LanguageModel === 'function' || typeof g.LanguageModel === 'object')
    ) {
      return g.LanguageModel as Record<string, unknown>;
    }
    const aiObj = g.ai as Record<string, unknown> | undefined;
    if (
      aiObj?.languageModel &&
      (typeof aiObj.languageModel === 'function' || typeof aiObj.languageModel === 'object')
    ) {
      return aiObj.languageModel as Record<string, unknown>;
    }
    return null;
  }

  private async withAbortTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error(`On-device model timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([run(ac.signal), timeoutPromise]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  public async warmDeviceModel(onProgress?: (pct: number) => void): Promise<boolean> {
    const t0 = performance.now();
    try {
      if (this.fastHybridModel) {
        await this.withAbortTimeout(
          () => this.fastHybridModel!.initializeDeviceModel((p) => onProgress?.(Math.round(p * 100))),
          6000,
        );
      }
      const lmApi = this.getChromeLanguageModelGlobal();
      if (lmApi && typeof lmApi.create === 'function') {
        const session = await this.withAbortTimeout(
          (signal) =>
            (lmApi.create as (opts?: unknown) => Promise<Record<string, unknown>>)({
              signal,
              expectedInputs: [{ type: 'text', languages: ['en'] }],
              expectedOutputs: [{ type: 'text', languages: ['en'] }],
            }),
          14000,
        );
        const quota = Number(session.contextWindow ?? session.inputQuota ?? 0);
        const used = Number(session.contextUsage ?? session.inputUsage ?? 0);
        if (quota > 0) this.status.contextWindowQuota = quota;
        if (used >= 0) this.status.contextTokensUsed = used;
        if (typeof session.destroy === 'function') (session.destroy as () => void)();

        if (typeof lmApi.availability === 'function') {
          const visAvail = await (lmApi.availability as (opts: unknown) => Promise<string>)({
            expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
          }).catch(() => 'unavailable');
          this.status.visionReady = visAvail === 'available' || visAvail === 'downloadable';
        }

        onProgress?.(100);
        this.status.deviceReady = true;
        this.status.lastInferenceSource = InferenceSource.ON_DEVICE;
        this.status.lastLatencyMs = Math.max(1, Math.round(performance.now() - t0));
        return true;
      }

      if (this.fastHybridModel) {
        this.status.deviceReady = true;
        this.status.lastInferenceSource = InferenceSource.ON_DEVICE;
        this.status.lastLatencyMs = Math.max(1, Math.round(performance.now() - t0));
        return true;
      }
    } catch {
      // Device Nano unavailable or still downloading in background
    }
    return false;
  }

  public hasLiveCloud(): boolean {
    return this.cloudMonteCarloPrimary !== null;
  }

  /**
   * L3 ONLY_ON_DEVICE NER pass extracting person names, apartment/room numbers, and hardware serials
   * when on-device Gemini Nano 4 has been warmed. Never transmits rawText off-device.
   */
  public async extractSensitiveEntitiesLocal(rawText: string): Promise<string[]> {
    if (!this.status.deviceReady || !rawText.trim()) return [];
    const prompt = `Extract person names, room/apartment numbers, and device serial IDs as JSON {"entities":[...]}:\n${rawText.slice(0, 600)}`;
    try {
      if (this.strictLocalTextModel) {
        const res = await this.withAbortTimeout(
          () => this.strictLocalTextModel!.generateContent(prompt),
          3500,
        );
        const obj = JSON.parse(res.response.text().replace(/^```json\s*|\s*```$/g, '').trim()) as {
          entities?: unknown[];
        };
        return Array.isArray(obj.entities) ? obj.entities.map(String).filter((s) => s.length >= 3) : [];
      }
      const lmApi = this.getChromeLanguageModelGlobal();
      if (lmApi && typeof lmApi.create === 'function') {
        return await this.withAbortTimeout(async (signal) => {
          const session = (await (lmApi.create as (opts?: unknown) => Promise<Record<string, unknown>>)({
            signal,
            expectedInputs: [{ type: 'text', languages: ['en'] }],
            expectedOutputs: [{ type: 'text', languages: ['en'] }],
          })) as Record<string, unknown>;
          try {
            const raw = String(
              await (session.prompt as (p: string, o?: unknown) => Promise<string>)(prompt, {
                signal,
                responseConstraint: PLAIN_NER_JSON_SCHEMA,
                omitResponseConstraintInput: true,
              }),
            );
            const obj = JSON.parse(raw) as { entities?: unknown[] };
            return Array.isArray(obj.entities)
              ? obj.entities.map(String).filter((s) => s.length >= 3)
              : [];
          } finally {
            if (typeof session.destroy === 'function') (session.destroy as () => void)();
          }
        }, 3500);
      }
    } catch {
      // L1 + L2 scanners remain active if L3 times out
    }
    return [];
  }

  /**
   * Compact (<120 token) on-device / hybrid semantic contradiction checker for prose clauses.
   */
  public async auditProseContradiction(
    proseText: string,
    privacyLock: boolean,
    clauseIds: [string, string] = ['c1', 'c2'],
  ): Promise<ConflictArc | null> {
    const t0 = performance.now();
    const prompt = `Audit operational plan for hidden physical/common-sense contradiction in <=22 words JSON:\n${proseText.slice(0, 900)}`;
    const [fromClauseId, toClauseId] = clauseIds;

    try {
      if (this.strictLocalTextModel && privacyLock) {
        const res = await this.strictLocalTextModel.generateContent(prompt);
        const parsed = JSON.parse(res.response.text().replace(/^```json\s*|\s*```$/g, '').trim()) as {
          severity?: string;
          summary?: string;
        };
        const ms = Math.max(1, Math.round(performance.now() - t0));
        this.status.lastInferenceSource = InferenceSource.ON_DEVICE;
        this.status.lastLatencyMs = ms;
        return {
          id: 'conf-nano-live',
          fromClauseId,
          toClauseId,
          severity: parsed.severity === 'critical' ? 'critical' : 'warning',
          summary: String(parsed.summary ?? 'Implicit physical assumption flagged on-device.'),
          localLatencyMs: ms,
          provenance: 'on_device',
        };
      }

      if (this.fastHybridModel && !privacyLock) {
        let res;
        let src: 'on_device' | 'in_cloud' = 'on_device';
        try {
          res = await this.fastHybridModel.generateContent(prompt);
          src = res.response.inferenceSource === InferenceSource.IN_CLOUD ? 'in_cloud' : 'on_device';
        } catch (err) {
          if (!this.cloudFallbackConflictModel) throw err;
          res = await this.cloudFallbackConflictModel.generateContent(prompt);
          src = 'in_cloud';
        }
        const parsed = JSON.parse(res.response.text()) as { severity?: string; summary?: string };
        const ms = Math.max(1, Math.round(performance.now() - t0));
        this.status.lastInferenceSource = src;
        this.status.lastLatencyMs = ms;
        return {
          id: 'conf-hybrid-live',
          fromClauseId,
          toClauseId,
          severity: parsed.severity === 'critical' ? 'critical' : 'warning',
          summary: String(parsed.summary ?? 'Operational risk flagged by Hybrid AI.'),
          localLatencyMs: ms,
          provenance: src,
        };
      }

      // Direct Chrome 158 LanguageModel API when no Firebase cloud key is configured yet
      const lmApi = this.getChromeLanguageModelGlobal();
      if (lmApi && typeof lmApi.create === 'function') {
        return await this.withAbortTimeout(async (signal) => {
          const session = (await (lmApi.create as (opts?: unknown) => Promise<Record<string, unknown>>)({
            signal,
            expectedInputs: [{ type: 'text', languages: ['en'] }],
            expectedOutputs: [{ type: 'text', languages: ['en'] }],
          })) as Record<string, unknown>;
          try {
            if (typeof session.measureContextUsage === 'function') {
              this.status.contextTokensUsed = Number(
                await (session.measureContextUsage as (p: string) => Promise<number>)(prompt),
              );
            } else if (typeof session.measureInputUsage === 'function') {
              this.status.contextTokensUsed = Number(
                await (session.measureInputUsage as (p: string) => Promise<number>)(prompt),
              );
            }
            const raw = String(
              await (session.prompt as (p: string, o?: unknown) => Promise<string>)(prompt, {
                signal,
                responseConstraint: PLAIN_CONFLICT_JSON_SCHEMA,
                omitResponseConstraintInput: true,
              }),
            );
            const parsed = JSON.parse(raw) as { severity?: string; summary?: string };
            const ms = Math.max(1, Math.round(performance.now() - t0));
            this.status.deviceReady = true;
            this.status.lastInferenceSource = 'on_device';
            this.status.lastLatencyMs = ms;
            return {
              id: 'conf-nano-direct',
              fromClauseId,
              toClauseId,
              severity: parsed.severity === 'critical' ? 'critical' : 'warning',
              summary: String(parsed.summary ?? 'On-device Nano flagged contradiction.'),
              localLatencyMs: ms,
              provenance: 'on_device' as const,
            };
          } finally {
            if (typeof session.destroy === 'function') (session.destroy as () => void)();
          }
        }, 5500);
      }
    } catch {
      // Deterministic heuristics provide resilient offline fallback
    }
    return null;
  }

  /**
   * Compiles free-form user operational plan prose into a structured ScenarioDefinition
   * using dedicated specCompilerHybridModel (with explicit cloud fallback when !privacyLock)
   * or Chrome 158 LanguageModel.
   */
  public async compileProseToCustomScenario(
    freeformProse: string,
    privacyLock = true,
  ): Promise<{ scenario: ScenarioDefinition; source: 'on_device' | 'in_cloud' | 'deterministic'; latencyMs: number }> {
    const t0 = performance.now();
    const prompt = `Extract compact operational stress-test envelope JSON from user plan:\n${freeformProse.slice(0, 1200)}`;

    try {
      let rawJsonText = '';
      let source: 'on_device' | 'in_cloud' = 'on_device';

      if (this.strictLocalTextModel && privacyLock) {
        const res = await this.strictLocalTextModel.generateContent(prompt);
        rawJsonText = res.response.text().replace(/^```json\s*|\s*```$/g, '').trim();
        source = 'on_device';
      } else if (this.specCompilerHybridModel && !privacyLock) {
        try {
          const res = await this.specCompilerHybridModel.generateContent(prompt);
          rawJsonText = res.response.text();
          source = res.response.inferenceSource === InferenceSource.IN_CLOUD ? 'in_cloud' : 'on_device';
        } catch (err) {
          if (!this.cloudFallbackSpecModel) throw err;
          const res = await this.cloudFallbackSpecModel.generateContent(prompt);
          rawJsonText = res.response.text();
          source = 'in_cloud';
        }
      } else {
        const lmApi = this.getChromeLanguageModelGlobal();
        if (lmApi && typeof lmApi.create === 'function') {
          rawJsonText = await this.withAbortTimeout(async (signal) => {
            const session = (await (lmApi.create as (opts?: unknown) => Promise<Record<string, unknown>>)({
              signal,
              expectedInputs: [{ type: 'text', languages: ['en'] }],
              expectedOutputs: [{ type: 'text', languages: ['en'] }],
            })) as Record<string, unknown>;
            try {
              return String(
                await (session.prompt as (p: string, o?: unknown) => Promise<string>)(prompt, {
                  signal,
                  responseConstraint: PLAIN_CUSTOM_SPEC_JSON_SCHEMA,
                  omitResponseConstraintInput: true,
                }),
              );
            } finally {
              if (typeof session.destroy === 'function') (session.destroy as () => void)();
            }
          }, 5500);
          source = 'on_device';
        }
      }

      if (rawJsonText) {
        const obj = JSON.parse(rawJsonText) as {
          title: string;
          archetype: 'cumulative_stock' | 'peak_capacity' | 'queue_backpressure';
          capacityValue: number;
          capacityUnit: string;
          horizonValue: number;
          axisXUnit: string;
          safetyFloorPct: number;
          loads: Array<{
            id: string;
            label: string;
            value: number;
            unit: string;
            polarity: 'drain' | 'recharge';
            windowKind: 'always' | 'interval' | 'periodic';
            mitigationLabel?: string;
          }>;
        };
        const ms = Math.max(1, Math.round(performance.now() - t0));
        this.status.lastInferenceSource = source;
        this.status.lastLatencyMs = ms;
        const scenario = createCustomScenario({
          title: obj.title || 'Custom Operational Plan',
          archetype: obj.archetype,
          marginUnit: obj.archetype === 'peak_capacity' ? '% rail' : obj.archetype === 'queue_backpressure' ? 'pool %' : '% reserve',
          horizonLabel: `${obj.horizonValue}${obj.axisXUnit} Stress Window`,
          axisXUnit: obj.axisXUnit || 'h',
          safetyFloorPct: Math.max(5, Math.min(40, Number(obj.safetyFloorPct) || 15)),
          capacityValue: Math.max(1, Number(obj.capacityValue) || 1000),
          capacityUnit: obj.capacityUnit || 'W',
          horizonValue: Math.max(1, Number(obj.horizonValue) || 12),
          rawPrivateSample: freeformProse,
          defaultPrivacyLock: privacyLock,
          loads: (obj.loads ?? []).slice(0, 4).map((ld, idx) => ({
            id: ld.id || `l${idx}`,
            label: ld.label || `Load ${idx + 1}`,
            value: Math.max(0.1, Number(ld.value) || 100),
            unit: ld.unit || obj.capacityUnit || 'W',
            polarity: ld.polarity === 'recharge' ? 'recharge' : 'drain',
            window:
              ld.windowKind === 'interval'
                ? { kind: 'interval', startStep: 0, endStep: 10 }
                : ld.windowKind === 'periodic'
                  ? { kind: 'periodic', periodSteps: 9, onStart: 2, onEnd: 5 }
                  : { kind: 'always' },
            mitigationLabel: ld.mitigationLabel || (ld.polarity === 'drain' ? 'Stagger / Throttle (-35%)' : undefined),
            mitigationMult: 0.65,
          })),
        });
        return { scenario, source, latencyMs: ms };
      }
    } catch {
      // Deterministic lexical compiler fallback below guarantees 100% reliability
    }

    const fallbackSpec = compileProseDeterministically(freeformProse, privacyLock);
    const ms = Math.max(1, Math.round(performance.now() - t0));
    return { scenario: fallbackSpec, source: 'deterministic', latencyMs: ms };
  }

  /**
   * Extracts hardware capacity, wattage/amps, hidden tare, and serial numbers from a JPEG base64
   * nameplate image. Uses ONLY_ON_DEVICE first; falls back to cloud vision ONLY when privacyLock === false.
   */
  public async extractNameplateVision(
    jpegBase64NoPrefix: string,
    privacyLock = true,
    hintTitle?: string,
  ): Promise<NameplateExtractionResult> {
    const t0 = performance.now();
    const prompt =
      'Read hardware nameplate / config image. Compute watts = volts * amps if shown. Return compact JSON with capacity, load, hidden tare, and serial/IP PII strings to keep local.';
    const imagePart = {
      type: 'inlineData' as const,
      inlineData: { mimeType: 'image/jpeg', data: jpegBase64NoPrefix },
    };

    const visionModel = this.getOrCreateLocalVisionModel();
    if (visionModel) {
      try {
        const res = await visionModel.generateContent([prompt, imagePart]);
        const jsonText = res.response.text().replace(/^```json\s*|\s*```$/g, '').trim();
        const obj = JSON.parse(jsonText) as Omit<NameplateExtractionResult, 'inferenceSource' | 'latencyMs'>;
        const ms = Math.max(1, Math.round(performance.now() - t0));
        this.status.visionReady = true;
        this.status.lastInferenceSource = InferenceSource.ON_DEVICE;
        this.status.lastLatencyMs = ms;
        return {
          ...obj,
          inferenceSource: 'on_device',
          latencyMs: ms,
        };
      } catch (err) {
        if (!privacyLock && this.cloudVisionFallbackModel) {
          const res = await this.cloudVisionFallbackModel.generateContent([prompt, imagePart]);
          const obj = JSON.parse(res.response.text()) as Omit<NameplateExtractionResult, 'inferenceSource' | 'latencyMs'>;
          const ms = Math.max(1, Math.round(performance.now() - t0));
          this.status.lastInferenceSource = InferenceSource.IN_CLOUD;
          this.status.lastLatencyMs = ms;
          return {
            ...obj,
            inferenceSource: 'in_cloud',
            latencyMs: ms,
          };
        }
        if (privacyLock) {
          throw new Error(
            'Privacy Lock is ON and local multimodal Gemini Nano 4 is not enabled; blocked cloud image upload. Enable chrome://flags/#prompt-api-for-gemini-nano-multimodal-input.',
          );
        }
        throw err;
      }
    }

    // Direct Chrome 158 multimodal LanguageModel API when Firebase config is absent
    const lmApi = this.getChromeLanguageModelGlobal();
    if (lmApi && typeof lmApi.create === 'function' && typeof Image !== 'undefined') {
      return await this.withAbortTimeout(async (signal) => {
        const session = (await (lmApi.create as (opts?: unknown) => Promise<Record<string, unknown>>)({
          signal,
          expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }],
        })) as Record<string, unknown>;
        try {
          const blob = base64JpegToBlob(jpegBase64NoPrefix);
          const bitmap = await createImageBitmap(blob);
          const raw = String(
            await (session.prompt as (p: unknown, o?: unknown) => Promise<string>)(
              [
                {
                  role: 'user',
                  content: [
                    { type: 'text', value: prompt },
                    { type: 'image', value: bitmap },
                  ],
                },
              ],
              {
                signal,
                responseConstraint: PLAIN_NAMEPLATE_JSON_SCHEMA,
                omitResponseConstraintInput: true,
              },
            ),
          );
          bitmap.close();
          const obj = JSON.parse(raw) as Omit<NameplateExtractionResult, 'inferenceSource' | 'latencyMs'>;
          const ms = Math.max(1, Math.round(performance.now() - t0));
          this.status.deviceReady = true;
          this.status.visionReady = true;
          this.status.lastInferenceSource = 'on_device';
          this.status.lastLatencyMs = ms;
          return {
            ...obj,
            title: obj.title || hintTitle || 'Scanned Hardware Spec',
            inferenceSource: 'on_device' as const,
            latencyMs: ms,
          };
        } finally {
          if (typeof session.destroy === 'function') (session.destroy as () => void)();
        }
      }, 7500);
    }

    throw new Error(
      privacyLock
        ? 'Privacy Lock is ON: local multimodal Gemini Nano 4 is unavailable, so FaultLine blocked image egress. Enable chrome://flags/#prompt-api-for-gemini-nano-multimodal-input.'
        : 'Multimodal vision model is not configured in this browser.',
    );
  }

  /**
   * Executes genuine ONLY_IN_CLOUD Python 2,000-trajectory vectorized Monte Carlo via `@firebase/ai`
   * strictly on Buckingham-Pi dimensionless payloads after passing `assertZeroSensitiveEgress()`.
   */
  public async runCloudMonteCarlo(
    scenario: ScenarioDefinition,
    paramValues: Record<string, number>,
    toggleValues: Record<string, boolean>,
    rawPrivateText?: string,
    privacyLock = true,
  ): Promise<CloudMonteCarloRawOutput> {
    if (this.inFlightMonteCarlo) return this.inFlightMonteCarlo;

    const runTask = async (): Promise<CloudMonteCarloRawOutput> => {
      const t0 = performance.now();
      const noteText = rawPrivateText ?? scenario.rawPrivateSample;
      const nanoEntities = await this.extractSensitiveEntitiesLocal(noteText);
      const airlock = await buildBuckinghamAirlockPacket(scenario, paramValues, toggleValues, {
        rawPrivateText: noteText,
        nanoEntities,
        scaleCurrencyOverrides: true,
      });

      const d = Object.keys(airlock.outboundPayload.piParams).length;
      const cloudPrompt = [
        'You are a quantitative reliability solver with Python numpy codeExecution.',
        'Given ONLY the dimensionless Buckingham-Pi JSON below (zero PII), execute ONE vectorized numpy script:',
        `1. Allocate a single 2D state array of shape (2000, ${2 * d + 1}) for 2,000 correlated stochastic Monte Carlo trials across the anchor column 0 and +-0.05 finite-difference columns for ${d} parameters. NEVER write nested Python for-loops over trials.`,
        '2. Step through the 37 horizon steps applying realistic domain correlated log-normal / Ornstein-Uhlenbeck shocks (ambient heatwave drift, compressor surge, burst arrival storms, or FX-rate correlation) WITHOUT clamping latent values to [0, 100].',
        `3. Compute p10Latent (37,), p50Latent (37,), p90Latent (37,), finite-difference median sensitivity jDelta50 (37, ${d}), log-spread sensitivities gLow (37, ${d}) and gHigh (37, ${d}), cvar90Pct, and 3 concise domainInsights strings.`,
        '4. Print __FL_MC_JSON_START__, then json.dumps(...), then __FL_MC_JSON_END__.',
        '',
        airlock.outboundJson,
      ].join('\n');

      // Fail-closed egress firewall before touching network
      assertZeroSensitiveEgress(
        cloudPrompt,
        rawPrivateText ?? scenario.rawPrivateSample,
        airlock.detectedSpans,
        privacyLock,
      );

      if (!this.cloudMonteCarloPrimary || !this.cloudMonteCarloFallback) {
        throw new Error(
          'Cloud Gemini API key is not configured in .env.local; using pre-calibrated local Buckingham-Π surrogate.',
        );
      }

      let modelUsed = this.mcPrimaryModel;
      let result;
      try {
        result = await this.cloudMonteCarloPrimary.generateContent(cloudPrompt);
      } catch (err: unknown) {
        const status = Number((err as { customErrorData?: { status?: number } })?.customErrorData?.status ?? 0);
        const msg = String((err as Error)?.message ?? '');
        if ([404, 429, 500, 503].includes(status) || /404|429|500|503|not found|quota/i.test(msg)) {
          modelUsed = this.mcFallbackModel;
          result = await this.cloudMonteCarloFallback.generateContent(cloudPrompt);
        } else {
          throw err;
        }
      }

      const rawParts =
        ((result.response as unknown as { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> })
          .candidates?.[0]?.content?.parts) ?? [];
      const extracted = extractLastMonteCarloExecution(rawParts);
      if (!extracted) {
        throw new Error('Cloud Python sandbox did not emit valid __FL_MC_JSON_START__ envelope.');
      }

      const ms = Math.max(1, Math.round(performance.now() - t0));
      const src =
        result.response.inferenceSource === InferenceSource.ON_DEVICE ? 'on_device' : 'in_cloud';
      this.status.lastInferenceSource = src;
      this.status.lastLatencyMs = ms;

      return {
        ...extracted.parsed,
        executedPythonCode: extracted.code,
        stdout: extracted.stdout,
        inferenceSource: src,
        latencyMs: ms,
        modelUsed,
        airlockSha256: airlock.sha256Hex,
      };
    };

    this.inFlightMonteCarlo = runTask().finally(() => {
      this.inFlightMonteCarlo = null;
    });
    return this.inFlightMonteCarlo;
  }
}

function base64JpegToBlob(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

/**
 * Deterministic zero-latency parser for custom operational plans when offline or before Nano warms,
 * handling breaker peak envelopes, bidirectional van/solar recharge, and API/Lambda queue storms.
 */
export function compileProseDeterministically(
  prose: string,
  privacyLock = true,
): ScenarioDefinition {
  const lower = prose.toLowerCase();

  // Detect archetype
  const isQueue = /\b(?:rps|req\/s|lambda|sqs|queue|pgbouncer|concurrency|retry|timeout|api)\b/.test(lower);
  const isPeak = /\b(?:breaker|15a|20a|amp|circuit|printer|peak|coincident|warmup|fuse)\b/.test(lower) && !/\b(?:wh|kwh|ah)\b/.test(lower);

  if (isPeak) {
    const ampMatch = prose.match(/(\d+(?:\.\d+)?)\s*A\b/i);
    const voltMatch = prose.match(/(\d{3})\s*V\b/i);
    const wattMatches = Array.from(prose.matchAll(/(\d{2,5})\s*W\b/gi)).map((m) => Number(m[1]));
    const countMatch = prose.match(/(\d+)\s*(?:x|×|\s+3d\s+printers?|\s+units?)/i);

    const amps = ampMatch ? Number(ampMatch[1]) : 15;
    const volts = voltMatch ? Number(voltMatch[1]) : 120;
    const capW = Math.round(amps * volts);
    const multCount = countMatch ? Math.min(20, Math.max(1, Number(countMatch[1]))) : 1;
    const primaryW = wattMatches[0] ? (wattMatches[0] < 450 && multCount > 1 ? wattMatches[0] * multCount : wattMatches[0]) : 1320;
    const steadyW = wattMatches[1] ? (wattMatches[1] < 250 && multCount > 1 ? wattMatches[1] * multCount : wattMatches[1]) : Math.round(primaryW * 0.48);
    const auxW = wattMatches[2] ?? 360;

    return createCustomScenario({
      title: prose.slice(0, 48).split(/[.\n|]/)[0].trim() || `${amps}A Breaker Peak Load Audit`,
      archetype: 'peak_capacity',
      marginUnit: '% rail',
      horizonLabel: '12h Batch Window',
      axisXUnit: 'h',
      safetyFloorPct: 20, // NEC 80% continuous load rule
      capacityValue: capW,
      capacityUnit: 'W',
      horizonValue: 12,
      rawPrivateSample: prose,
      defaultPrivacyLock: privacyLock,
      loads: [
        {
          id: 'surge',
          label: 'Coincident Warmup / Startup Peak',
          value: primaryW,
          unit: 'W',
          polarity: 'drain',
          window: { kind: 'interval', startStep: 0, endStep: 7 },
          mitigationLabel: 'Stagger Warmup Phases (-45%)',
          mitigationMult: 0.55,
        },
        {
          id: 'steady',
          label: 'Steady Operating Draw',
          value: steadyW,
          unit: 'W',
          polarity: 'drain',
          window: { kind: 'interval', startStep: 8, endStep: 36 },
        },
        {
          id: 'aux',
          label: 'Auxiliary Dryer / Controller Tare',
          value: auxW,
          unit: 'W',
          polarity: 'drain',
          window: { kind: 'always' },
          omittedByNaive: true,
        },
      ],
    });
  }

  if (isQueue) {
    const rpsMatch = prose.match(/(\d{3,6})\s*(?:rps|req\/s|requests)/i);
    const poolMatch = prose.match(/(\d{2,5})\s*(?:conns?|workers?|slots?|instances?|concurrency)/i);
    const rps = rpsMatch ? Number(rpsMatch[1]) : 3800;
    const pool = poolMatch ? Number(poolMatch[1]) : 350;

    return createCustomScenario({
      title: prose.slice(0, 48).split(/[.\n|]/)[0].trim() || 'Concurrency & Retry Storm Audit',
      archetype: 'queue_backpressure',
      marginUnit: 'pool %',
      horizonLabel: '36m Surge Window',
      axisXUnit: 'm',
      safetyFloorPct: 15,
      capacityValue: pool,
      capacityUnit: 'slots',
      horizonValue: 36,
      rawPrivateSample: prose,
      defaultPrivacyLock: privacyLock,
      loads: [
        {
          id: 'ingress',
          label: 'Peak Surge Ingress Rate',
          value: rps,
          unit: 'req/s',
          polarity: 'drain',
          window: { kind: 'always' },
          mitigationLabel: 'Edge Queue Shedding (-30%)',
          mitigationMult: 0.7,
        },
      ],
    });
  }

  // Default: cumulative_stock (supports recharge keywords like alternator / solar / chiller)
  const capMatch = prose.match(/(\d{2,6})\s*(Wh|kWh|Ah|L|gal|thU)/i);
  const hrsMatch = prose.match(/(\d{1,3})\s*(?:h|hr|hours?)\b/i);
  const hasRecharge = /\b(?:recharge|alternator|solar|driving|chiller|generator)\b/.test(lower);

  const rawCap = capMatch ? Number(capMatch[1]) * (capMatch[2].toLowerCase() === 'kwh' ? 1000 : 1) : 1200;
  const capUnit = capMatch ? (capMatch[2].toLowerCase() === 'kwh' ? 'Wh' : capMatch[2]) : 'Wh';
  const hrs = hrsMatch ? Number(hrsMatch[1]) : 16;

  const loads: CustomLoadSpec[] = [
    {
      id: 'primary',
      label: hasRecharge ? 'Stop / Door-Open Peak Drain' : 'Primary Active Load',
      value: Math.round(rawCap / Math.max(4, hrs * 0.72)),
      unit: `${capUnit}/h`,
      polarity: 'drain',
      window: hasRecharge ? { kind: 'periodic', periodSteps: 9, onStart: 3, onEnd: 6 } : { kind: 'always' },
      mitigationLabel: 'Curtain / Eco Duty (-40%)',
      mitigationMult: 0.6,
    },
    {
      id: 'tare',
      label: 'Ambient Conduction / Quiescent Tare',
      value: Math.max(2, Math.round(rawCap * 0.022)),
      unit: `${capUnit}/h`,
      polarity: 'drain',
      window: { kind: 'always' },
      omittedByNaive: true,
    },
  ];

  if (hasRecharge) {
    loads.push({
      id: 'recharge',
      label: 'Transit / Solar Recharge Inflow',
      value: Math.round(rawCap * 0.075),
      unit: `${capUnit}/h`,
      polarity: 'recharge',
      window: { kind: 'periodic', periodSteps: 9, onStart: 0, onEnd: 2 },
    });
  }

  return createCustomScenario({
    title: prose.slice(0, 48).split(/[.\n|]/)[0].trim() || 'Custom Holdover & Recharge Plan',
    archetype: 'cumulative_stock',
    marginUnit: '% reserve',
    horizonLabel: `${hrs}h Operating Window`,
    axisXUnit: 'h',
    safetyFloorPct: 15,
    capacityValue: rawCap,
    capacityUnit: capUnit,
    horizonValue: hrs,
    rawPrivateSample: prose,
    defaultPrivacyLock: privacyLock,
    loads,
  });
}

export const sharedBridge = new FaultLineHybridBridge();
