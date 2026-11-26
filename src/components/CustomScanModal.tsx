import React, { useState } from 'react';
import { Camera, Cpu, FileText, Sparkles, Upload, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import {
  createCustomScenario,
  sharedBridge,
  type ConflictArc,
  type NameplateExtractionResult,
  type ScenarioDefinition,
} from '../core/faultlineEngine';

interface CustomScanModalProps {
  open: boolean;
  onClose: () => void;
  privacyLock: boolean;
  initialProse?: string;
  onAdoptScenario: (
    scenario: ScenarioDefinition,
    extraConflict?: ConflictArc | null,
  ) => void;
}

interface SyntheticNameplatePreset {
  id: string;
  badge: string;
  title: string;
  lines: string[];
  fallbackResult: Omit<NameplateExtractionResult, 'inferenceSource' | 'latencyMs'>;
}

const SYNTHETIC_NAMEPLATES: SyntheticNameplatePreset[] = [
  {
    id: 'np-lifepo4',
    badge: 'CARD 01 · BATTERY STATION',
    title: 'LiFePO4 1280Wh Station Label',
    lines: [
      'MODEL: FL-1280P PORTABLE STATION',
      'NOMINAL ENERGY: 25.6V === 50Ah (1280Wh)',
      'PURE-SINE AC INVERTER IDLE TARE: 16W',
      'CONTINUOUS SLEEP + COLD LOAD: 78W',
      'SERIAL NO: LFP-JP-884120 [KEEP LOCAL]',
    ],
    fallbackResult: {
      title: 'Scanned 1280Wh LiFePO4 Holdover Plan',
      archetype: 'cumulative_stock',
      capacityValue: 1280,
      capacityUnit: 'Wh',
      primaryLoadLabel: 'CPAP + Cold-Box Combined Draw',
      primaryLoadValue: 78,
      primaryLoadUnit: 'W',
      hiddenTareW: 16,
      redactedSerialOrPii: ['LFP-JP-884120'],
    },
  },
  {
    id: 'np-breaker',
    badge: 'CARD 02 · 15A BREAKER RAIL',
    title: '6x 3D Printer Farm + PSU Brick',
    lines: [
      'CIRCUIT: NEC 15A @ 120V AC (1800W MAX)',
      '6x HEATED BED WARMUP: 220W x 6 = 1320W',
      'FILAMENT DRYER + CONTROLLER TARE: 370W',
      'CONTINUOUS NEC DERATING FLOOR: 20%',
      'ASSET TAG: BAY04-FAB-99412 [KEEP LOCAL]',
    ],
    fallbackResult: {
      title: '15A Breaker · 6x 3D Printer Farm',
      archetype: 'peak_capacity',
      capacityValue: 1800,
      capacityUnit: 'W',
      primaryLoadLabel: '6x Printer Bed Coincident Warmup',
      primaryLoadValue: 1320,
      primaryLoadUnit: 'W',
      hiddenTareW: 370,
      redactedSerialOrPii: ['BAY04-FAB-99412'],
    },
  },
  {
    id: 'np-pgbouncer',
    badge: 'CARD 03 · SRE POOL CONFIG',
    title: 'PgBouncer Transaction Pool Spec',
    lines: [
      'max_client_conn = 420 | pool_mode = tx',
      'PEAK FAILOVER INGRESS: 4600 req/s',
      'GATEWAY TIMEOUT: 1800ms | RETRIES: 3x',
      'DSN: postgres://prod@10.48.19.12:5432',
    ],
    fallbackResult: {
      title: 'Scanned PgBouncer 420-Conn Cutover',
      archetype: 'queue_backpressure',
      capacityValue: 420,
      capacityUnit: 'conns',
      primaryLoadLabel: 'Checkout Surge Ingress',
      primaryLoadValue: 4600,
      primaryLoadUnit: 'req/s',
      hiddenTareW: 0,
      redactedSerialOrPii: ['postgres://prod@10.48.19.12:5432', '10.48.19.12'],
    },
  },
];

const OFF_SCRIPT_PROSE_SAMPLES: Array<{ label: string; text: string }> = [
  {
    label: '15A Breaker · 6x 3D Printers',
    text: 'Workshop Bay-04 (Inspector: T. Watanabe) runs 6x 3D printers on a single 15A 120V breaker. Simultaneous bed warmup draws 1320W for the first 2h, steady printing draws 620W, plus a 370W filament dryer running continuously over a 12h print batch.',
  },
  {
    label: 'Wedding Cold-Van + Recharge',
    text: 'Catering Van #TK-8821 (Client: Sato Wedding) carries 100 thU thermal cold-chain capacity across a 12h summer route. Venue door-openings drain 18 thU/h periodically, roof conduction leaks 4.5 thU/h, while highway alternator chiller recharges 8 thU/h between stops.',
  },
  {
    label: 'AWS Concurrency & Retry Storm',
    text: 'Order API gateway absorbs 4400 req/s flash-sale surge against 380 reserved concurrency slots over a 36m drain window with 3x synchronous SDK retries and 1800ms timeout (Internal endpoint: 10.22.8.14:8443).',
  },
];

function sliceDataUrlBase64(dataUrl: string): { dataUrl: string; base64NoPrefix: string } {
  const commaIdx = dataUrl.indexOf(',');
  return {
    dataUrl,
    base64NoPrefix: commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl,
  };
}

function renderSyntheticPlateJpegBase64(preset: SyntheticNameplatePreset): {
  dataUrl: string;
  base64NoPrefix: string;
} {
  const canvas = document.createElement('canvas');
  canvas.width = 680;
  canvas.height = 340;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { dataUrl: '', base64NoPrefix: '' };

  ctx.fillStyle = '#1F2022';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#E5E2D9';
  ctx.lineWidth = 4;
  ctx.strokeRect(14, 14, canvas.width - 28, canvas.height - 28);

  ctx.fillStyle = '#FA3600';
  ctx.fillRect(28, 28, canvas.width - 56, 42);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 20px monospace';
  ctx.fillText(`HARDWARE RATING PLATE · ${preset.badge}`, 42, 56);

  ctx.fillStyle = '#F6F4EE';
  ctx.font = 'bold 21px monospace';
  preset.lines.forEach((ln, idx) => {
    ctx.fillText(ln, 42, 112 + idx * 42);
  });

  return sliceDataUrlBase64(canvas.toDataURL('image/jpeg', 0.9));
}

async function fileToResizedJpegBase64(file: File): Promise<{ dataUrl: string; base64NoPrefix: string }> {
  const bitmap = await createImageBitmap(file);
  const maxDim = 1024;
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return sliceDataUrlBase64(canvas.toDataURL('image/jpeg', 0.88));
}

function buildScenarioFromNameplate(res: NameplateExtractionResult): ScenarioDefinition {
  if (res.archetype === 'peak_capacity') {
    return createCustomScenario({
      title: res.title,
      archetype: 'peak_capacity',
      marginUnit: '% rail',
      horizonLabel: '12h Load Window',
      axisXUnit: 'h',
      safetyFloorPct: 20,
      capacityValue: Math.max(100, res.capacityValue),
      capacityUnit: res.capacityUnit || 'W',
      horizonValue: 12,
      rawPrivateSample: `Scanned Plate: ${res.title} | Redacted Local IDs: ${res.redactedSerialOrPii.join(', ') || 'LOCAL_ASSET'}`,
      loads: [
        {
          id: 'peak',
          label: res.primaryLoadLabel || 'Coincident Startup Load',
          value: Math.max(10, res.primaryLoadValue),
          unit: res.primaryLoadUnit || 'W',
          polarity: 'drain',
          window: { kind: 'interval', startStep: 0, endStep: 8 },
          mitigationLabel: 'Stagger Startup (-45%)',
          mitigationMult: 0.55,
        },
        {
          id: 'steady',
          label: 'Steady Operating Load',
          value: Math.round(Math.max(10, res.primaryLoadValue) * 0.48),
          unit: res.primaryLoadUnit || 'W',
          polarity: 'drain',
          window: { kind: 'interval', startStep: 9, endStep: 36 },
        },
        ...(res.hiddenTareW > 0
          ? [
              {
                id: 'tare',
                label: 'Hidden Auxiliary / Dryer Tare',
                value: res.hiddenTareW,
                unit: res.primaryLoadUnit || 'W',
                polarity: 'drain' as const,
                window: { kind: 'always' as const },
                omittedByNaive: true,
              },
            ]
          : []),
      ],
    });
  }

  if (res.archetype === 'queue_backpressure') {
    return createCustomScenario({
      title: res.title,
      archetype: 'queue_backpressure',
      marginUnit: 'pool %',
      horizonLabel: '36m Drain Window',
      axisXUnit: 'm',
      safetyFloorPct: 15,
      capacityValue: Math.max(20, res.capacityValue),
      capacityUnit: res.capacityUnit || 'conns',
      horizonValue: 36,
      rawPrivateSample: `Scanned Config: ${res.title} | Redacted Local DSN: ${res.redactedSerialOrPii.join(', ') || '10.0.0.1'}`,
      loads: [
        {
          id: 'ingress',
          label: res.primaryLoadLabel || 'Peak Surge Ingress',
          value: Math.max(100, res.primaryLoadValue),
          unit: 'req/s',
          polarity: 'drain',
          window: { kind: 'always' },
          mitigationLabel: 'Edge Queue Shedding (-30%)',
          mitigationMult: 0.7,
        },
      ],
    });
  }

  return createCustomScenario({
    title: res.title,
    archetype: 'cumulative_stock',
    marginUnit: '% reserve',
    horizonLabel: '24h Holdover Window',
    axisXUnit: 'h',
    safetyFloorPct: 12,
    capacityValue: Math.max(50, res.capacityValue),
    capacityUnit: res.capacityUnit || 'Wh',
    horizonValue: 24,
    rawPrivateSample: `Scanned Plate: ${res.title} | Serial Kept On-Device: ${res.redactedSerialOrPii.join(', ') || 'SN-LOCAL'}`,
    loads: [
      {
        id: 'main',
        label: res.primaryLoadLabel || 'Primary Rated Load',
        value: Math.max(5, res.primaryLoadValue),
        unit: res.primaryLoadUnit || 'W',
        polarity: 'drain',
        window: { kind: 'always' },
        mitigationLabel: 'Eco Duty Cycle (-32%)',
        mitigationMult: 0.68,
      },
      ...(res.hiddenTareW > 0
        ? [
            {
              id: 'tare',
              label: 'Inverter / Quiescent Tare',
              value: res.hiddenTareW,
              unit: res.primaryLoadUnit || 'W',
              polarity: 'drain' as const,
              window: { kind: 'always' as const },
              mitigationLabel: 'Direct DC Bypass (-88%)',
              mitigationMult: 0.12,
              omittedByNaive: true,
            },
          ]
        : []),
    ],
  });
}

export const CustomScanModal: React.FC<CustomScanModalProps> = ({
  open,
  onClose,
  privacyLock,
  initialProse = '',
  onAdoptScenario,
}) => {
  const [prose, setProse] = useState<string>(
    initialProse || OFF_SCRIPT_PROSE_SAMPLES[0].text,
  );
  const [previewImg, setPreviewImg] = useState<string>('');
  const [scanResult, setScanResult] = useState<NameplateExtractionResult | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);

  if (!open) return null;

  const handleScanSyntheticCard = async (preset: SyntheticNameplatePreset) => {
    setBusyLabel(`SCANNING ${preset.badge} ON-DEVICE…`);
    const t0 = performance.now();
    try {
      const { dataUrl, base64NoPrefix } = renderSyntheticPlateJpegBase64(preset);
      setPreviewImg(dataUrl);
      try {
        const liveVision = await sharedBridge.extractNameplateVision(
          base64NoPrefix,
          privacyLock,
          preset.title,
        );
        setScanResult(liveVision);
        toast.success(
          `[${liveVision.inferenceSource.toUpperCase()} VISION · ${liveVision.latencyMs}ms] Extracted ${liveVision.capacityValue}${liveVision.capacityUnit} spec!`,
        );
      } catch {
        // Honest deterministic preset fallback when multimodal model is not enabled
        const ms = Math.max(1, Math.round(performance.now() - t0));
        setScanResult({
          ...preset.fallbackResult,
          inferenceSource: 'deterministic',
          latencyMs: ms,
        });
        toast.message(
          `[DETERMINISTIC · ${ms}ms] Loaded synthetic plate spec (enable Chrome multimodal Nano for live vision OCR)`,
        );
      }
    } finally {
      setBusyLabel(null);
    }
  };

  const handleUploadImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusyLabel('RUNNING MULTIMODAL NAMEPLATE EXTRACTION…');
    try {
      const { dataUrl, base64NoPrefix } = await fileToResizedJpegBase64(file);
      setPreviewImg(dataUrl);
      const res = await sharedBridge.extractNameplateVision(base64NoPrefix, privacyLock, file.name);
      setScanResult(res);
      toast.success(`[${res.inferenceSource.toUpperCase()} VISION · ${res.latencyMs}ms] Extracted ${res.title}`);
    } catch (err: unknown) {
      toast.error(String((err as Error)?.message ?? 'Multimodal vision unavailable'));
    } finally {
      setBusyLabel(null);
    }
  };

  const handleCompileProse = async () => {
    if (!prose.trim()) return;
    setBusyLabel('COMPILING PROSE TO TANGLE SPEC…');
    try {
      const [{ scenario, source, latencyMs }, extraConflict] = await Promise.all([
        sharedBridge.compileProseToCustomScenario(prose, privacyLock),
        sharedBridge.auditProseContradiction(prose, privacyLock, ['x1', 'x2']),
      ]);
      onAdoptScenario(scenario, extraConflict);
      toast.success(
        `[${source.toUpperCase()} · ${latencyMs}ms] Compiled "${scenario.title}" into Section D—D′ blueprint!`,
      );
      onClose();
    } finally {
      setBusyLabel(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-[#282828]/65 flex items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl bg-[#F6F4EE] border-2 border-[#282828] shadow-2xl my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Architectural Title Bar */}
        <div className="px-4 py-2.5 bg-[#282828] text-[#F6F4EE] flex items-center justify-between gap-2">
          <span className="heron-mono text-xs font-bold flex items-center gap-2">
            <Camera className="w-3.5 h-3.5 text-[#FA3600]" />
            [SHEET +04 · ON-DEVICE NAMEPLATE VISION &amp; OPEN-DOMAIN SPEC COMPILER]
          </span>
          <button
            type="button"
            onClick={onClose}
            className="heron-mono text-xs px-2 py-0.5 bg-[#FA3600] text-[#FFFFFF] cursor-pointer"
          >
            [ESC]
          </button>
        </div>

        <div className="p-4 grid grid-cols-1 md:grid-cols-12 gap-4">
          {/* Left Column: Hardware Nameplate Multimodal Scanner */}
          <div className="md:col-span-6 border border-[#282828] bg-[#FAF9F5] p-3.5 flex flex-col justify-between gap-3">
            <div className="flex flex-col gap-2">
              <div className="heron-mono text-[10.5px] font-bold text-[#282828] flex items-center justify-between">
                <span>[A · ONLY_ON_DEVICE NAMEPLATE SCANNER]</span>
                <span className="text-[#136B33] flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" /> 0 BYTES UPLOADED
                </span>
              </div>
              <p className="text-[11.5px] text-[#575652] m-0 leading-snug">
                Click a synthetic rating plate below or upload a photo of any power brick / breaker / config screen. Gemini Nano 4 computes{' '}
                <code className="heron-mono">W = V × A</code> and strips serials locally.
              </p>

              <div className="flex flex-col gap-1.5 mt-1">
                {SYNTHETIC_NAMEPLATES.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    disabled={Boolean(busyLabel)}
                    onClick={() => void handleScanSyntheticCard(card)}
                    className="text-left p-2 border border-[#282828] bg-[#F6F4EE] hover:bg-[#282828] hover:text-[#F6F4EE] transition-colors cursor-pointer flex items-center justify-between gap-2"
                  >
                    <div>
                      <div className="heron-mono text-[9.5px] font-bold text-[#FA3600]">
                        {card.badge}
                      </div>
                      <div className="text-[11.5px] font-bold">{card.title}</div>
                    </div>
                    <span className="heron-mono text-[9.5px] font-bold px-1.5 py-0.5 border border-current shrink-0">
                      [SCAN]
                    </span>
                  </button>
                ))}
              </div>

              <label className="mt-1 heron-mono text-[10px] font-bold px-3 py-2 border border-dashed border-[#282828] bg-[#EFECE4] text-[#282828] hover:bg-[#282828] hover:text-[#F6F4EE] cursor-pointer flex items-center justify-center gap-1.5">
                <Upload className="w-3.5 h-3.5 text-[#FA3600]" />
                UPLOAD LOCAL PHOTO / SCREENSHOT (JPEG/PNG)
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => void handleUploadImage(e)}
                  className="hidden"
                />
              </label>

              {previewImg && (
                <div className="border border-[#282828] bg-[#1F2022] p-1.5">
                  <img
                    src={previewImg}
                    alt="Scanned hardware nameplate preview"
                    className="w-full h-24 object-contain block"
                  />
                </div>
              )}

              {scanResult && (
                <div className="p-2.5 border border-[#15803D] bg-[#ECFDF5] heron-mono text-[10px] text-[#282828] flex flex-col gap-1">
                  <div className="font-bold text-[#136B33] flex items-center justify-between">
                    <span>EXTRACTED ({scanResult.inferenceSource.toUpperCase()} · {scanResult.latencyMs}MS)</span>
                    <span>{scanResult.archetype.toUpperCase()}</span>
                  </div>
                  <div>
                    CAPACITY: <strong>{scanResult.capacityValue} {scanResult.capacityUnit}</strong> · LOAD:{' '}
                    <strong>{scanResult.primaryLoadValue} {scanResult.primaryLoadUnit}</strong>
                    {scanResult.hiddenTareW > 0 ? ` · TARE: ${scanResult.hiddenTareW}W` : ''}
                  </div>
                  <div className="text-[#B82500] truncate">
                    KEPT LOCAL: {scanResult.redactedSerialOrPii.join(', ') || 'SERIAL_SCRUBBED'}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const sc = buildScenarioFromNameplate(scanResult);
                      onAdoptScenario(sc, null);
                      onClose();
                    }}
                    className="mt-1 w-full py-1.5 bg-[#15803D] text-[#FFFFFF] font-bold cursor-pointer"
                  >
                    [MOUNT SCANNED PLATE ON BLUEPRINT →]
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Free-Form Operational Plan Prose Compiler */}
          <div className="md:col-span-6 border border-[#282828] bg-[#FAF9F5] p-3.5 flex flex-col justify-between gap-3">
            <div className="flex flex-col gap-2">
              <div className="heron-mono text-[10.5px] font-bold text-[#282828] flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <FileText className="w-3.5 h-3.5 text-[#FA3600]" />
                  [B · FREE-PROSE TO TANGLE COMPILER]
                </span>
                <span className="text-[#575652]">&lt;120-TOK NANO</span>
              </div>
              <p className="text-[11.5px] text-[#575652] m-0 leading-snug">
                Paste any custom operational plan, breaker budget, cold-chain route, or SRE runbook. Compiles into draggable{' '}
                <code className="heron-mono">[↔]</code> pills across all 3 physical archetypes:
              </p>

              <div className="flex flex-wrap gap-1">
                {OFF_SCRIPT_PROSE_SAMPLES.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => setProse(s.text)}
                    className="heron-mono text-[9.5px] font-bold px-2 py-0.5 border border-[#D4D2CA] bg-[#F6F4EE] text-[#282828] hover:border-[#282828] cursor-pointer"
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              <textarea
                value={prose}
                onChange={(e) => setProse(e.target.value)}
                rows={7}
                aria-label="Custom operational plan prose"
                className="w-full p-2.5 border border-[#282828] bg-[#F6F4EE] heron-mono text-[11px] text-[#282828] leading-relaxed resize-y"
              />
            </div>

            <div className="flex flex-col gap-2">
              {busyLabel && (
                <div className="heron-mono text-[10px] font-bold text-[#FA3600] flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 animate-spin" />
                  {busyLabel}
                </div>
              )}
              <button
                type="button"
                disabled={Boolean(busyLabel)}
                onClick={() => void handleCompileProse()}
                className="w-full py-2 px-3 bg-[#282828] text-[#F6F4EE] hover:bg-[#FA3600] transition-colors heron-mono text-[10.5px] font-bold cursor-pointer flex items-center justify-center gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5 text-[#FF7A52]" />
                [COMPILE TO SECTION D—D′ BLUEPRINT &amp; TANGLE SPEC]
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
