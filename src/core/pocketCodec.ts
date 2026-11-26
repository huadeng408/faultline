import { zlibSync, unzlibSync, strToU8, strFromU8 } from 'fflate';
import { SCENARIOS, type BuiltinScenarioId, type ScenarioId } from './faultlineEngine.ts';

export interface PocketSurvivalState {
  scenarioId: ScenarioId;
  paramValues: Record<string, number>;
  toggleValues: Record<string, boolean>;
  verifiedMargin: number;
  isSafe: boolean;
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

/**
 * Compresses operational survival parameters + toggles into a compact (<300 char)
 * `https://<origin>/?pocket=<base64url>` link that opens natively in any mobile camera QR scanner.
 */
export function encodePocketUrl(origin: string, state: PocketSurvivalState): string {
  const cleanOrigin = origin.replace(/\/+$/g, '') || 'https://faultline-v3.web.app';
  const isBuiltin = state.scenarioId in BUILTIN_SHORT_MAP;

  let compactObj: unknown;
  if (isBuiltin) {
    const bId = state.scenarioId as BuiltinScenarioId;
    const sc = SCENARIOS[bId];
    const pArr = sc.params.map((p) => Number((state.paramValues[p.key] ?? p.value).toFixed(2)));
    let tMask = 0;
    sc.toggles.forEach((tg, idx) => {
      if (state.toggleValues[tg.key]) tMask |= 1 << idx;
    });
    compactObj = [
      1, // version 1 positional tuple
      BUILTIN_SHORT_MAP[bId],
      pArr,
      tMask,
      Number(state.verifiedMargin.toFixed(2)),
      state.isSafe ? 1 : 0,
    ];
  } else {
    compactObj = [
      2,
      state.scenarioId,
      state.paramValues,
      state.toggleValues,
      Number(state.verifiedMargin.toFixed(2)),
      state.isSafe ? 1 : 0,
    ];
  }

  const rawBytes = strToU8(JSON.stringify(compactObj));
  const compressed = zlibSync(rawBytes, { level: 9 });
  return `${cleanOrigin}/?pocket=${toBase64Url(compressed)}`;
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
      };
    }

    if (tuple[0] === 2) {
      return {
        scenarioId: String(tuple[1]),
        paramValues: (tuple[2] as Record<string, number>) ?? {},
        toggleValues: (tuple[3] as Record<string, boolean>) ?? {},
        verifiedMargin: Number(tuple[4]),
        isSafe: Boolean(tuple[5]),
      };
    }
    return null;
  } catch {
    return null;
  }
}
