import { zlibSync, unzlibSync, strToU8, strFromU8 } from 'fflate';
import {
  SCENARIOS,
  createCustomScenario,
  type BuiltinScenarioId,
  type CreateCustomScenarioInput,
  type ScenarioDefinition,
  type ScenarioId,
} from './faultlineEngine.ts';
import type { EvaluatedSurrogateEnvelope } from './monteCarloSurrogate.ts';

export interface PocketSurrogateSummary {
  p10Margin: number;
  /** 5 quantized P10/P90 display knots (indices 0, 9, 18, 27, 36) for instant offline fan rendering */
  p10Knots: number[];
  p90Knots: number[];
}

export interface PocketSurvivalState {
  scenarioId: ScenarioId;
  paramValues: Record<string, number>;
  toggleValues: Record<string, boolean>;
  verifiedMargin: number;
  isSafe: boolean;
  surrogateSummary?: PocketSurrogateSummary;
  hydratedCustomScenario?: ScenarioDefinition;
}

const BUILTIN_SHORT_MAP: Record<BuiltinScenarioId, string> = {
  'typhoon-cpap': 't',
  'singles-day-cutover': 's',
  'expat-cashflow': 'e',
};

const SHORT_TO_BUILTIN: Record<string, BuiltinScenarioId> = {
  t: 'typhoon-cpap',
  s: 'singles-day-cutover',
  e: 'expat-cashflow',
};

const KNOT_INDICES = [0, 9, 18, 27, 36];

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(token: string): Uint8Array {
  const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((token.length + 3) % 4);
  if (typeof atob === 'function') {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

export function summarizeSurrogateForPocket(env?: EvaluatedSurrogateEnvelope): PocketSurrogateSummary | undefined {
  if (!env) return undefined;
  return {
    p10Margin: Number(env.p10Margin.toFixed(1)),
    p10Knots: KNOT_INDICES.map((i) => Math.round(env.p10Display[i] ?? 0)),
    p90Knots: KNOT_INDICES.map((i) => Math.round(env.p90Display[i] ?? 0)),
  };
}

/**
 * Compresses operational survival parameters, toggles, quantized surrogate fan knots,
 * and custom scenario envelopes into a compact `?pocket=<base64url>` link (<300 chars for built-in).
 */
export function encodePocketUrl(
  origin: string,
  state: PocketSurvivalState & { customScenario?: ScenarioDefinition },
): string {
  const cleanOrigin = origin.replace(/\/+$/g, '') || 'https://faultline-v3.web.app';
  const isBuiltin = state.scenarioId in BUILTIN_SHORT_MAP;
  const sur = state.surrogateSummary
    ? [state.surrogateSummary.p10Margin, state.surrogateSummary.p10Knots, state.surrogateSummary.p90Knots]
    : null;

  let compactPayload: unknown;
  if (isBuiltin) {
    const bId = state.scenarioId as BuiltinScenarioId;
    const sc = SCENARIOS[bId];
    const pArr = sc.params.map((p) => Number((state.paramValues[p.key] ?? p.value).toFixed(2)));
    let tMask = 0;
    sc.toggles.forEach((tg, idx) => {
      if (state.toggleValues[tg.key]) tMask |= 1 << idx;
    });
    compactPayload = sur
      ? [1, BUILTIN_SHORT_MAP[bId], pArr, tMask, Number(state.verifiedMargin.toFixed(2)), state.isSafe ? 1 : 0, sur]
      : [1, BUILTIN_SHORT_MAP[bId], pArr, tMask, Number(state.verifiedMargin.toFixed(2)), state.isSafe ? 1 : 0];
  } else {
    const env = state.customScenario?.customEnvelope;
    const customCreateInput: CreateCustomScenarioInput | null =
      state.customScenario && env
        ? {
            id: state.customScenario.id,
            title: state.customScenario.title,
            archetype: env.archetype,
            marginUnit: state.customScenario.marginUnit,
            horizonLabel: state.customScenario.horizonLabel,
            axisXUnit: state.customScenario.axisXUnit,
            safetyFloorPct: env.safetyFloorPct,
            usableInitFraction: env.usableInitFraction,
            capacityValue: env.capacityValue,
            capacityUnit: env.capacityUnit,
            horizonValue: env.horizonValue,
            loads: env.loads,
          }
        : null;

    compactPayload = [
      2,
      state.scenarioId,
      state.paramValues,
      state.toggleValues,
      Number(state.verifiedMargin.toFixed(2)),
      state.isSafe ? 1 : 0,
      sur,
      customCreateInput,
    ];
  }

  const rawBytes = strToU8(JSON.stringify(compactPayload));
  const compressed = zlibSync(rawBytes, { level: 9 });
  return `${cleanOrigin}/?pocket=${toBase64Url(compressed)}`;
}

function parseSurrogateTuple(raw: unknown): PocketSurrogateSummary | undefined {
  if (!Array.isArray(raw) || raw.length < 3) return undefined;
  return {
    p10Margin: Number(raw[0]),
    p10Knots: Array.isArray(raw[1]) ? (raw[1] as unknown[]).map(Number) : [],
    p90Knots: Array.isArray(raw[2]) ? (raw[2] as unknown[]).map(Number) : [],
  };
}

export function decodePocketUrl(urlOrToken: string): PocketSurvivalState | null {
  try {
    let token = urlOrToken.trim();
    if (token.includes('pocket=')) {
      const parsedUrl = new URL(token, 'https://faultline-v3.web.app');
      token = parsedUrl.searchParams.get('pocket') ?? '';
    }
    if (!token) return null;

    const decompressed = unzlibSync(fromBase64Url(token));
    const tuple = JSON.parse(strFromU8(decompressed)) as unknown[];
    if (!Array.isArray(tuple) || tuple.length < 6) return null;

    if (tuple[0] === 1) {
      const bId = SHORT_TO_BUILTIN[String(tuple[1])];
      if (!bId) return null;
      const sc = SCENARIOS[bId];
      const pArr = tuple[2] as number[];
      const tMask = Number(tuple[3]) || 0;
      const paramValues: Record<string, number> = {};
      sc.params.forEach((p, idx) => {
        paramValues[p.key] = Number(pArr?.[idx] ?? p.value);
      });
      const toggleValues: Record<string, boolean> = {};
      sc.toggles.forEach((tg, idx) => {
        toggleValues[tg.key] = (tMask & (1 << idx)) !== 0;
      });
      return {
        scenarioId: bId,
        paramValues,
        toggleValues,
        verifiedMargin: Number(tuple[4]),
        isSafe: Boolean(tuple[5]),
        surrogateSummary: parseSurrogateTuple(tuple[6]),
      };
    }

    if (tuple[0] === 2) {
      const customDef = tuple[7]
        ? createCustomScenario(tuple[7] as CreateCustomScenarioInput)
        : undefined;
      return {
        scenarioId: String(tuple[1]),
        paramValues: (tuple[2] as Record<string, number>) ?? {},
        toggleValues: (tuple[3] as Record<string, boolean>) ?? {},
        verifiedMargin: Number(tuple[4]),
        isSafe: Boolean(tuple[5]),
        surrogateSummary: parseSurrogateTuple(tuple[6]),
        hydratedCustomScenario: customDef,
      };
    }
    return null;
  } catch {
    return null;
  }
}
