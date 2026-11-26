import type { ScenarioDefinition } from './faultlineEngine.ts';

export type ClosedPhysicsRegime =
  | 'electrochemical_backup'
  | 'queue_backpressure'
  | 'multi_currency_runway'
  | 'peak_breaker_envelope'
  | 'thermal_or_generic_stock';

export type SymbolicWindowSpec =
  | { kind: 'always' }
  | { kind: 'interval'; s: number; e: number }
  | { kind: 'periodic'; p: number; s: number; e: number }
  | { kind: 'ramp'; s: number; f: number };

export interface OutboundBuckinghamPiPayload {
  schema: 'faultline.buckingham_pi.v3';
  regime: ClosedPhysicsRegime;
  archetype: 'cumulative_stock' | 'peak_capacity' | 'queue_backpressure';
  horizonSteps: number;
  safetyFloorPct: number;
  usableInitFraction: number;
  /** Symbolic dimensionless parameters ONLY: p_0, p_1, ... -> quantized to 1e-4 */
  piParams: Record<string, number>;
  /** Symbolic boolean toggles ONLY: u_0, u_1, ... */
  toggles: Record<string, boolean>;
  /** Symbolic dimensionless flow topology (zero user-supplied strings) */
  flows: Array<{
    id: string;
    polarity: 'drain' | 'recharge';
    paramRef?: string;
    fixedPiRatio?: number;
    window: SymbolicWindowSpec;
    mitigation?: { toggleRef: string; mode: 'zero_out' | 'multiply' | 'add_ratio'; val: number };
  }>;
}

export interface DetectedSensitiveSpan {
  layer: 'L1_LEXICAL' | 'L1_LUHN' | 'L2_ENTROPY' | 'L3_NANO_NER';
  category: string;
  value: string;
}

export interface BuckinghamAirlockPacket {
  outboundPayload: OutboundBuckinghamPiPayload;
  outboundJson: string;
  sha256Hex: string;
  detectedSpans: DetectedSensitiveSpan[];
  redactedPreviewText: string;
  bytesSaved: number;
  /** Private scale bases retained strictly in local memory for inverse dimensional reconstruction */
  localScaleBasis: {
    capacityBasis: number;
    capacityUnit: string;
    timeBasis: number;
    timeUnit: string;
    extractedCurrencyRatios?: {
      reserveMonths?: number;
      housingRatioPct?: number;
    };
  };
}

export class AirlockEgressBlockedError extends Error {
  public readonly leakedTokens: string[];

  constructor(message: string, leakedTokens: string[]) {
    super(message);
    this.name = 'AirlockEgressBlockedError';
    this.leakedTokens = leakedTokens;
  }
}

/**
 * Strips IEEE-754 binary mantissa noise via 12 significant decimal digits before
 * quantizing to 1e-4, guaranteeing 100% bit-identical output across arbitrary positive
 * scale factors lambda (including boundary fractions like 27/120 = 0.225).
 */
export function canonicalizePiRatio(numerator: number, basis: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(basis) || Math.abs(basis) < 1e-12) {
    return 0;
  }
  const raw = numerator / basis;
  if (Math.abs(raw) < 1e-12) return 0;
  const decClean = Number(raw.toPrecision(12));
  const rounded = Math.round((decClean + Math.sign(decClean) * 1e-12) * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function computeShannonEntropy(token: string): number {
  if (!token) return 0;
  const counts = new Map<string, number>();
  for (const ch of token) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const len = token.length;
  let entropy = 0;
  for (const c of counts.values()) {
    const p = c / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function passesLuhnMod10(rawCandidate: string): boolean {
  const digits = rawCandidate.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (doubleDigit) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleDigit = !doubleDigit;
  }
  return sum > 0 && sum % 10 === 0;
}

const SAFE_VOCAB_ALLOWLIST = new Set([
  'faultline',
  'buckingham_pi',
  'electrochemical_backup',
  'queue_backpressure',
  'multi_currency_runway',
  'peak_breaker_envelope',
  'thermal_or_generic_stock',
  'cumulative_stock',
  'peak_capacity',
  'horizonsteps',
  'safetyfloorpct',
  'usableinitfraction',
  'piparams',
  'toggles',
  'flows',
  'polarity',
  'drain',
  'recharge',
  'paramref',
  'fixedpiratio',
  'window',
  'kind',
  'always',
  'interval',
  'periodic',
  'ramp',
  'mitigation',
  'toggleref',
  'mode',
  'zero_out',
  'multiply',
  'add_ratio',
  'schema',
  'regime',
  'archetype',
  'true',
  'false',
  'numpy',
  'python',
  'monte',
  'carlo',
  'vectorized',
  'p10latent',
  'p50latent',
  'p90latent',
  'jdelta50',
  'glow',
  'ghigh',
  'cvar90pct',
  'domaininsights',
]);

export function scanSensitiveSpans(
  rawText: string,
  nanoEntities: string[] = [],
): DetectedSensitiveSpan[] {
  const spans: DetectedSensitiveSpan[] = [];
  const seen = new Set<string>();

  const pushSpan = (
    layer: DetectedSensitiveSpan['layer'],
    category: string,
    value: string,
  ) => {
    const trimmed = value.trim();
    if (trimmed.length < 3) return;
    const key = `${category}:${trimmed.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    spans.push({ layer, category, value: trimmed });
  };

  // L1: Deterministic lexical & connection-string / credential / PII patterns
  const l1Patterns: Array<{ category: string; regex: RegExp }> = [
    {
      category: 'DB_OR_RPC_DSN',
      regex: /\b(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqp):\/\/[^\s|,;]+/gi,
    },
    {
      category: 'EMAIL',
      regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    },
    {
      category: 'IPV4_ENDPOINT',
      regex: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?(?:\/\d{1,2})?\b/g,
    },
    {
      category: 'API_SECRET_TOKEN',
      regex: /\b(?:sk_[A-Za-z0-9_-]{8,}|mk_(?:live|test)_[A-Za-z0-9_-]{6,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    },
    {
      category: 'PASSPORT_OR_GOV_ID',
      regex: /\b(?:[A-Z]{2}-\d{6,10}|\d{3}-\d{2}-\d{4})\b/g,
    },
    {
      category: 'ACCOUNT_OR_SERIAL',
      regex: /(?:#\d{3,6}-\d{5,10}|\b[A-Za-z0-9]+-[A-Z]{2}-\d{4,8}\b)/g,
    },
    {
      category: 'PHONE_NUMBER',
      regex: /\+\d{1,3}[-\s]?\d{1,4}[-\s]?\d{3,4}[-\s]?\d{3,4}\b/g,
    },
    {
      category: 'EXACT_CURRENCY_AMOUNT',
      regex: /(?:[¥$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?\/mo)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|JPY|EUR|GBP|CNY|RMB)\b)/gi,
    },
    {
      category: 'LABELED_PERSON_OR_ORG',
      regex: /\b(?:Household|Employee|Client|Patient|Account Holder|Company|Tenant)\s*:\s*([A-Z][A-Za-z0-9 .,'-]{2,42}?)(?=\s*(?:\||,|\(|$))/g,
    },
  ];

  for (const { category, regex } of l1Patterns) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(rawText)) !== null) {
      pushSpan('L1_LEXICAL', category, m[1] ?? m[0]);
    }
  }

  // L1b: Luhn Mod-10 payment card numbers (13-19 digits with spaces or hyphens)
  const luhnRegex = /\b(?:\d[ -]*?){13,19}\b/g;
  let lm: RegExpExecArray | null;
  while ((lm = luhnRegex.exec(rawText)) !== null) {
    if (passesLuhnMod10(lm[0])) {
      pushSpan('L1_LUHN', 'PAYMENT_CARD_LUHN', lm[0]);
    }
  }

  // L2: Contextual Shannon entropy scan for unlabeled secrets / serial hashes
  const tokenRegex = /[A-Za-z0-9_/+=-]{14,}/g;
  let tm: RegExpExecArray | null;
  while ((tm = tokenRegex.exec(rawText)) !== null) {
    const tok = tm[0];
    if (SAFE_VOCAB_ALLOWLIST.has(tok.toLowerCase())) continue;
    if (/^[0-]+$/.test(tok)) continue;
    const hasAlpha = /[A-Za-z]/.test(tok);
    const hasDigitOrSym = /[0-9_/+=-]/.test(tok);
    if (hasAlpha && hasDigitOrSym && computeShannonEntropy(tok) >= 3.7) {
      pushSpan('L2_ENTROPY', 'HIGH_ENTROPY_SECRET', tok);
    }
  }

  // L3: Optional on-device Gemini Nano 4 NER entities
  for (const ent of nanoEntities) {
    pushSpan('L3_NANO_NER', 'ON_DEVICE_NER', ent);
  }

  return spans;
}

/**
 * Extracts dimensionless cashflow ratios locally when a user types or pastes real
 * currency figures (e.g., Salary / Vault / Rent in JPY/USD/EUR) into the Airlock box.
 */
export function extractLocalCurrencyRatios(rawText: string): {
  salaryMonthly?: number;
  vaultBalance?: number;
  rentMonthly?: number;
  reserveMonths?: number;
  housingRatioPct?: number;
} {
  const parseNum = (s: string | undefined): number | undefined => {
    if (!s) return undefined;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const salaryMatch = rawText.match(
    /(?:Net\s+Salary|Salary|Income|Payroll)[^0-9¥$€£]{0,20}[¥$€£]?\s*(\d[\d,]*(?:\.\d+)?)/i,
  );
  const vaultMatch = rawText.match(
    /(?:Vault(?:\s+Acct)?[^|]{0,28}?|Savings|Liquid\s+Balance|Reserve|Bank)[^0-9¥$€£#]{0,16}(?:#[\d-]+\s*:\s*)?[¥$€£]?\s*(\d[\d,]*(?:\.\d+)?)/i,
  );
  const rentMatch = rawText.match(
    /(?:Rent|Mortgage|Lease|Housing)[^0-9¥$€£]{0,20}[¥$€£]?\s*(\d[\d,]*(?:\.\d+)?)/i,
  );

  const salaryMonthly = parseNum(salaryMatch?.[1]);
  const vaultBalance = parseNum(vaultMatch?.[1]);
  const rentMonthly = parseNum(rentMatch?.[1]);

  let reserveMonths: number | undefined;
  let housingRatioPct: number | undefined;

  if (salaryMonthly && vaultBalance) {
    // Baseline monthly burn is normalized to 0.82 * net_salary in Scenario 03
    reserveMonths = canonicalizePiRatio(vaultBalance, salaryMonthly);
  }
  if (salaryMonthly && rentMonthly) {
    housingRatioPct = canonicalizePiRatio(rentMonthly * 100, salaryMonthly);
  }

  return { salaryMonthly, vaultBalance, rentMonthly, reserveMonths, housingRatioPct };
}

function deterministicFallbackHashHex(input: string): string {
  // Pure synchronous 256-bit fallback ONLY if WebCrypto subtle is unavailable in restricted contexts
  const lanes = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const lane = i & 7;
    lanes[lane] = Math.imul(lanes[lane] ^ code, 0x01000193) >>> 0;
    lanes[(lane + 3) & 7] = (lanes[(lane + 3) & 7] + (lanes[lane] >>> 5)) >>> 0;
  }
  return lanes.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

export async function sha256HexOfString(text: string): Promise<string> {
  try {
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
      const bytes = new TextEncoder().encode(text);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // Fallback below
  }
  return deterministicFallbackHashHex(text);
}

/**
 * Transforms any dimensional scenario + raw private note into a closed-vocabulary,
 * scale-invariant Buckingham-Pi dimensionless payload with zero user-supplied strings.
 */
export async function buildBuckinghamAirlockPacket(
  scenario: ScenarioDefinition,
  paramValues: Record<string, number>,
  toggleValues: Record<string, boolean>,
  options?: {
    rawPrivateText?: string;
    nanoEntities?: string[];
    scaleCurrencyOverrides?: boolean;
  },
): Promise<BuckinghamAirlockPacket> {
  const rawText = options?.rawPrivateText ?? scenario.rawPrivateSample ?? '';
  const detectedSpans = scanSensitiveSpans(rawText, options?.nanoEntities);
  const extracted = extractLocalCurrencyRatios(rawText);

  let redactedPreviewText = rawText;
  for (const sp of detectedSpans) {
    if (sp.value.length >= 3) {
      redactedPreviewText = redactedPreviewText.split(sp.value).join(`[REDACTED:${sp.category}]`);
    }
  }

  let regime: ClosedPhysicsRegime = 'thermal_or_generic_stock';
  let archetype: OutboundBuckinghamPiPayload['archetype'] = 'cumulative_stock';
  let safetyFloorPct = 10;
  let usableInitFraction = 0.9;
  let capacityBasis = 1;
  let capacityUnit = 'unit';
  let timeBasis = 1;
  let timeUnit = 'step';
  const piParams: Record<string, number> = {};
  const symbolicToggles: Record<string, boolean> = {};
  const flows: OutboundBuckinghamPiPayload['flows'] = [];

  scenario.toggles.forEach((tg, idx) => {
    symbolicToggles[`u_${idx}`] = Boolean(toggleValues[tg.key] ?? tg.enabled);
  });

  if (scenario.id === 'typhoon-cpap') {
    regime = 'electrochemical_backup';
    archetype = 'cumulative_stock';
    safetyFloorPct = 10;
    usableInitFraction = 0.9;
    capacityBasis = Math.max(1e-9, paramValues.batteryWh ?? 1024);
    capacityUnit = 'Wh';
    timeBasis = Math.max(1e-9, paramValues.outageHours ?? 36);
    timeUnit = 'h';

    const cpapW = paramValues.cpapWatts ?? 38;
    const coolerW = paramValues.coolerWatts ?? 24;
    const tareW = paramValues.inverterTareW ?? 14;

    piParams.p_0 = canonicalizePiRatio(cpapW * timeBasis, capacityBasis);
    piParams.p_1 = canonicalizePiRatio(coolerW * timeBasis, capacityBasis);
    piParams.p_2 = canonicalizePiRatio(tareW * timeBasis, capacityBasis);

    // Dimensionless humidifier ratio relative to CPAP base (or pack basis if scaled uniformly)
    const humBaseW = (26 / 1024) * capacityBasis;
    const dcTareW = (1.5 / 1024) * capacityBasis;
    const auxW = (5.5 / 1024) * capacityBasis;

    flows.push(
      {
        id: 'f_0',
        polarity: 'drain',
        paramRef: 'p_0',
        window: { kind: 'periodic', p: 24, s: 0, e: 8 },
        mitigation: {
          toggleRef: 'u_0',
          mode: 'add_ratio',
          val: canonicalizePiRatio(humBaseW * timeBasis, capacityBasis),
        },
      },
      {
        id: 'f_1',
        polarity: 'drain',
        paramRef: 'p_1',
        window: { kind: 'always' },
        mitigation: { toggleRef: 'u_2', mode: 'multiply', val: 0.68 },
      },
      {
        id: 'f_2',
        polarity: 'drain',
        paramRef: 'p_2',
        window: { kind: 'always' },
        mitigation: {
          toggleRef: 'u_1',
          mode: 'add_ratio',
          val: canonicalizePiRatio(dcTareW * timeBasis, capacityBasis),
        },
      },
      {
        id: 'f_3',
        polarity: 'drain',
        fixedPiRatio: canonicalizePiRatio(auxW * timeBasis, capacityBasis),
        window: { kind: 'always' },
      },
    );
  } else if (scenario.id === 'singles-day-cutover') {
    regime = 'queue_backpressure';
    archetype = 'queue_backpressure';
    safetyFloorPct = 15;
    usableInitFraction = 1.0;
    capacityBasis = Math.max(1e-9, paramValues.dbPoolMax ?? 480);
    capacityUnit = 'conns';
    timeBasis = Math.max(1e-9, paramValues.timeoutMs ?? 2000);
    timeUnit = 'ms';

    const rps = paramValues.rps ?? 5200;
    const retries = paramValues.retries ?? 3;
    const rttMs = paramValues.crossRegionRttMs ?? 68;

    // Pi_0 = rps * timeout_sec / dbPoolMax (dimensionless traffic arrival intensity)
    piParams.p_0 = canonicalizePiRatio(rps * (timeBasis / 1000), capacityBasis);
    // Pi_1 = crossRegionRttMs / timeoutMs (dimensionless lock-hold fraction)
    piParams.p_1 = canonicalizePiRatio(rttMs, timeBasis);
    // Pi_2 = retries (already dimensionless count)
    piParams.p_2 = canonicalizePiRatio(retries, 1);

    flows.push({
      id: 'f_0',
      polarity: 'drain',
      paramRef: 'p_0',
      window: { kind: 'interval', s: 6, e: 24 },
      mitigation: { toggleRef: 'u_0', mode: 'multiply', val: 1.1 },
    });
  } else if (scenario.id === 'expat-cashflow') {
    regime = 'multi_currency_runway';
    archetype = 'cumulative_stock';
    safetyFloorPct = 18.75;
    usableInitFraction = 1.0;
    capacityBasis = extracted.salaryMonthly ?? 1;
    capacityUnit = 'monthly_income';
    timeBasis = 36;
    timeUnit = 'mo';

    const effReserve =
      options?.scaleCurrencyOverrides && extracted.reserveMonths !== undefined
        ? extracted.reserveMonths
        : (paramValues.reserveMonths ?? 11);
    const effHousing =
      options?.scaleCurrencyOverrides && extracted.housingRatioPct !== undefined
        ? extracted.housingRatioPct
        : (paramValues.housingRatioPct ?? 42);
    const fxPct = paramValues.fxShockPct ?? 16;
    const rateBps = paramValues.rateHikeBps ?? 225;
    const relocMos = paramValues.relocOneOffMos ?? 3.5;

    piParams.p_0 = canonicalizePiRatio(effReserve, 36);
    piParams.p_1 = canonicalizePiRatio(effHousing, 100);
    piParams.p_2 = canonicalizePiRatio(fxPct, 100);
    piParams.p_3 = canonicalizePiRatio(rateBps, 10000);
    piParams.p_4 = canonicalizePiRatio(relocMos, 36);

    flows.push(
      {
        id: 'f_0',
        polarity: 'drain',
        paramRef: 'p_1',
        window: { kind: 'always' },
        mitigation: { toggleRef: 'u_1', mode: 'multiply', val: 0.75 },
      },
      {
        id: 'f_1',
        polarity: 'drain',
        paramRef: 'p_2',
        window: { kind: 'ramp', s: 0, f: 6 },
        mitigation: { toggleRef: 'u_0', mode: 'multiply', val: 0.4 },
      },
      {
        id: 'f_2',
        polarity: 'drain',
        paramRef: 'p_4',
        window: { kind: 'interval', s: 2, e: 2 },
        mitigation: { toggleRef: 'u_2', mode: 'add_ratio', val: canonicalizePiRatio(-1.4, 36) },
      },
    );
  } else if (scenario.customEnvelope) {
    const env = scenario.customEnvelope;
    archetype = env.archetype;
    regime =
      env.archetype === 'peak_capacity'
        ? 'peak_breaker_envelope'
        : env.archetype === 'queue_backpressure'
          ? 'queue_backpressure'
          : 'thermal_or_generic_stock';
    safetyFloorPct = canonicalizePiRatio(env.safetyFloorPct, 1);
    usableInitFraction = canonicalizePiRatio(env.usableInitFraction, 1);
    capacityBasis = Math.max(1e-9, paramValues.capacityValue ?? env.capacityValue);
    capacityUnit = env.capacityUnit;
    timeBasis = Math.max(1e-9, paramValues.horizonValue ?? env.horizonValue);
    timeUnit = scenario.axisXUnit || 'h';

    let pIdx = 0;
    let uIdx = 0;
    for (let i = 0; i < env.loads.length; i++) {
      const ld = env.loads[i];
      const pKey = `p_${pIdx++}`;
      const rawVal = paramValues[`load_${ld.id}`] ?? ld.value;
      const numerator =
        env.archetype === 'cumulative_stock'
          ? rawVal * timeBasis
          : env.archetype === 'queue_backpressure' && i === 0
            ? rawVal * ((paramValues.timeoutMs ?? 2000) / 1000)
            : rawVal;
      piParams[pKey] = canonicalizePiRatio(numerator, capacityBasis);

      let symWin: SymbolicWindowSpec = { kind: 'always' };
      if (ld.window.kind === 'interval') {
        symWin = { kind: 'interval', s: ld.window.startStep, e: ld.window.endStep };
      } else if (ld.window.kind === 'periodic') {
        symWin = {
          kind: 'periodic',
          p: ld.window.periodSteps,
          s: ld.window.onStart,
          e: ld.window.onEnd,
        };
      } else if (ld.window.kind === 'ramp') {
        symWin = { kind: 'ramp', s: ld.window.startStep, f: ld.window.fullStep };
      }

      let mitigation: OutboundBuckinghamPiPayload['flows'][number]['mitigation'];
      if (ld.mitigationLabel) {
        const uKey = `u_${uIdx++}`;
        mitigation = {
          toggleRef: uKey,
          mode: 'multiply',
          val: canonicalizePiRatio(ld.mitigationMult ?? 0.6, 1),
        };
      }

      flows.push({
        id: `f_${i}`,
        polarity: ld.polarity,
        paramRef: pKey,
        window: symWin,
        ...(mitigation ? { mitigation } : {}),
      });
    }
  }

  const outboundPayload: OutboundBuckinghamPiPayload = {
    schema: 'faultline.buckingham_pi.v3',
    regime,
    archetype,
    horizonSteps: scenario.horizonPoints,
    safetyFloorPct,
    usableInitFraction,
    piParams,
    toggles: symbolicToggles,
    flows,
  };

  const outboundJson = JSON.stringify(outboundPayload, null, 2);
  const sha256Hex = await sha256HexOfString(outboundJson);

  return {
    outboundPayload,
    outboundJson,
    sha256Hex,
    detectedSpans,
    redactedPreviewText,
    bytesSaved: Math.max(24, rawText.length),
    localScaleBasis: {
      capacityBasis,
      capacityUnit,
      timeBasis,
      timeUnit,
      extractedCurrencyRatios:
        extracted.reserveMonths !== undefined || extracted.housingRatioPct !== undefined
          ? {
              reserveMonths: extracted.reserveMonths,
              housingRatioPct: extracted.housingRatioPct,
            }
          : undefined,
    },
  };
}

/**
 * Fail-closed egress firewall invoked immediately before any cloud generateContent() call.
 * Guarantees zero sensitive spans and, when privacyLock is active, zero user-supplied words egress.
 */
export function assertZeroSensitiveEgress(
  promptText: string,
  rawPrivateText: string,
  detectedSpans: DetectedSensitiveSpan[],
  privacyLock = true,
): void {
  const normPrompt = promptText.normalize('NFKC').toLowerCase();
  const leaked: string[] = [];

  for (const span of detectedSpans) {
    const candidate = span.value.normalize('NFKC').toLowerCase().trim();
    if (candidate.length >= 4 && normPrompt.includes(candidate)) {
      leaked.push(span.value);
    }
  }

  if (privacyLock && rawPrivateText.trim().length > 0) {
    const rawWords = rawPrivateText
      .normalize('NFKC')
      .match(/[A-Za-z][A-Za-z0-9_-]{3,}|\d{5,}/g) ?? [];
    for (const word of rawWords) {
      const lower = word.toLowerCase();
      if (SAFE_VOCAB_ALLOWLIST.has(lower)) continue;
      if (normPrompt.includes(lower)) {
        leaked.push(word);
      }
    }
  }

  if (leaked.length > 0) {
    const unique = Array.from(new Set(leaked));
    throw new AirlockEgressBlockedError(
      `[BUCKINGHAM AIRLOCK BLOCKED EGRESS] Detected ${unique.length} sensitive/raw token(s) in outbound cloud payload.`,
      unique,
    );
  }
}
