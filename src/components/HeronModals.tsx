import React, { useEffect, useState } from 'react';
import { Check, Copy, Lock, QrCode, ShieldCheck, Smartphone, WifiOff, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  makeQrDataUrl,
  type ScenarioDefinition,
  type SimulationSnapshot,
} from '../core/faultlineEngine';
import {
  buildBuckinghamAirlockPacket,
  type BuckinghamAirlockPacket,
} from '../core/buckinghamAirlock';
import { encodePocketUrl } from '../core/pocketCodec';

function copySafe(text: string): boolean {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

interface PrivacyModalProps {
  open: boolean;
  onClose: () => void;
  scenario: ScenarioDefinition;
  paramValues: Record<string, number>;
  toggleValues: Record<string, boolean>;
  privateNote: string;
  onChangePrivateNote: (next: string) => void;
  onApplyExtractedCurrencyRatios?: (ratios: { reserveMonths?: number; housingRatioPct?: number }) => void;
}

export const HeronPrivacyAirlockModal: React.FC<PrivacyModalProps> = ({
  open,
  onClose,
  scenario,
  paramValues,
  toggleValues,
  privateNote,
  onChangePrivateNote,
  onApplyExtractedCurrencyRatios,
}) => {
  const [packet, setPacket] = useState<BuckinghamAirlockPacket | null>(null);
  const [scaleProofHash, setScaleProofHash] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setScaleProofHash(null);
    void buildBuckinghamAirlockPacket(scenario, paramValues, toggleValues, {
      rawPrivateText: privateNote,
      scaleCurrencyOverrides: true,
    }).then((res) => {
      if (active) setPacket(res);
    });
    return () => {
      active = false;
    };
  }, [open, scenario, paramValues, toggleValues, privateNote]);

  if (!open) return null;

  const handleVerify100xScaleInvariance = async () => {
    if (!packet) return;
    const lam = 100;
    const scaledParams = { ...paramValues };
    if (scenario.id === 'typhoon-cpap') {
      scaledParams.batteryWh = (paramValues.batteryWh ?? 1024) * lam;
      scaledParams.cpapWatts = (paramValues.cpapWatts ?? 38) * lam;
      scaledParams.coolerWatts = (paramValues.coolerWatts ?? 24) * lam;
      scaledParams.inverterTareW = (paramValues.inverterTareW ?? 14) * lam;
    } else if (scenario.id === 'singles-day-cutover') {
      scaledParams.dbPoolMax = (paramValues.dbPoolMax ?? 480) * lam;
      scaledParams.rps = (paramValues.rps ?? 5200) * lam;
    } else if (scenario.customEnvelope) {
      scaledParams.capacityValue = (paramValues.capacityValue ?? scenario.customEnvelope.capacityValue) * lam;
      for (const ld of scenario.customEnvelope.loads) {
        scaledParams[`load_${ld.id}`] = (paramValues[`load_${ld.id}`] ?? ld.value) * lam;
      }
    }

    const scaledNote = privateNote.replace(/([¥$€£]\s*)(\d[\d,]*(?:\.\d+)?)/g, (_, sym: string, numStr: string) => {
      const n = Number(numStr.replace(/,/g, ''));
      return Number.isFinite(n) ? `${sym}${(n * lam).toFixed(2)}` : `${sym}${numStr}`;
    });

    const scaledPkt = await buildBuckinghamAirlockPacket(scenario, scaledParams, toggleValues, {
      rawPrivateText: scaledNote,
      scaleCurrencyOverrides: true,
    });
    setScaleProofHash(scaledPkt.sha256Hex);
    if (scaledPkt.sha256Hex === packet.sha256Hex) {
      toast.success('100× Buckingham-Π scale-invariance verified: SHA-256 digests match bit-for-bit!');
    }
  };

  const extractedRatios = packet?.localScaleBasis.extractedCurrencyRatios;

  return (
    <div
      className="fixed inset-0 z-50 bg-[#282828]/65 flex items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-[#F6F4EE] border-2 border-[#282828] shadow-2xl my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 bg-[#282828] text-[#F6F4EE] flex items-center justify-between">
          <span className="heron-mono text-xs font-bold flex items-center gap-2">
            <Lock className="w-3.5 h-3.5 text-[#FA3600]" />
            [BUCKINGHAM-Π DIMENSIONLESS AIRLOCK · ZERO RAW PII EGRESS]
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Privacy Airlock Modal"
            className="heron-mono text-xs px-2 py-0.5 bg-[#FA3600] text-[#FFFFFF] cursor-pointer"
          >
            [ESC]
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          <div className="p-3 border border-[#282828] bg-[#FAF9F5] border-l-4 border-l-[#FA3600] flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="heron-mono text-[10px] font-bold text-[#BE2800]">
                [STRICTLY ON-DEVICE INPUT · EDIT NAMES, CARDS, DSN OR BALANCES LIVE]
              </span>
              {extractedRatios && onApplyExtractedCurrencyRatios && (
                <button
                  type="button"
                  onClick={() => {
                    onApplyExtractedCurrencyRatios(extractedRatios);
                    toast.success('Synced dimensionless currency ratios to Tangle pills locally!');
                  }}
                  className="heron-mono text-[9.5px] font-bold px-2 py-0.5 bg-[#282828] text-[#F6F4EE] cursor-pointer"
                >
                  [SYNC RATIOS TO PILLS]
                </button>
              )}
            </div>

            <textarea
              value={privateNote}
              onChange={(e) => onChangePrivateNote(e.target.value)}
              rows={3}
              aria-label="Editable strictly on-device private note"
              className="w-full p-2 border border-[#D4D2CA] bg-[#F6F4EE] heron-mono text-xs text-[#282828] resize-y"
            />

            {packet && packet.detectedSpans.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {packet.detectedSpans.map((sp, idx) => (
                  <span
                    key={`${sp.category}-${idx}`}
                    className="heron-mono text-[9px] font-bold px-1.5 py-0.5 bg-[#FEF2F2] border border-[#B82500] text-[#B82500]"
                  >
                    STRIPPED [{sp.layer.replace('_', ' ')}: {sp.category}]
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="p-3 border border-[#282828] bg-[#EFECE4]">
            <div className="heron-mono text-[10px] font-bold text-[#136B33] mb-1 flex items-center justify-between">
              <span>[CLOSED-VOCABULARY BUCKINGHAM-Π PAYLOAD SENT TO CLOUD PYTHON]</span>
              <span>0 USER STRINGS</span>
            </div>
            <pre className="heron-mono text-[10.5px] text-[#282828] m-0 max-h-44 overflow-auto">
              {packet?.outboundJson ?? 'Computing Buckingham-Π dimensionless packet…'}
            </pre>
          </div>

          <div className="p-2.5 border border-[#D4D2CA] bg-[#FAF9F5] flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="heron-mono text-[9.5px] text-[#575652]">
                  WEBCRYPTO SHA-256 RECEIPT (1× BASELINE)
                </div>
                <div className="heron-mono text-[11px] font-bold text-[#282828] truncate">
                  {packet?.sha256Hex ?? '—'}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleVerify100xScaleInvariance()}
                  className="heron-mono text-[10px] font-bold px-2.5 py-1 border border-[#15803D] bg-[#ECFDF5] text-[#136B33] cursor-pointer flex items-center gap-1"
                >
                  <ShieldCheck className="w-3 h-3" />
                  [PROVE 100× INVARIANCE]
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!packet) return;
                    copySafe(packet.sha256Hex);
                    setCopied(true);
                    toast.success('Copied SHA-256 Buckingham-Π digest');
                    setTimeout(() => setCopied(false), 1800);
                  }}
                  className="heron-mono text-[10px] font-bold px-2.5 py-1 bg-[#282828] text-[#F6F4EE] cursor-pointer flex items-center gap-1"
                >
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copied ? 'COPIED' : 'COPY SHA-256'}
                </button>
              </div>
            </div>

            {scaleProofHash && packet && (
              <div className="p-2 border border-[#15803D] bg-[#ECFDF5] heron-mono text-[10px] text-[#136B33]">
                <strong>100× SCALED SHA-256:</strong> {scaleProofHash} —{' '}
                <strong>
                  {scaleProofHash === packet.sha256Hex ? 'BIT-IDENTICAL MATCH (Q.E.D.)' : 'MISMATCH'}
                </strong>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

interface QrModalProps {
  open: boolean;
  onClose: () => void;
  scenario: ScenarioDefinition;
  paramValues: Record<string, number>;
  toggleValues: Record<string, boolean>;
  snapshot: SimulationSnapshot;
}

export const HeronOfflineQrModal: React.FC<QrModalProps> = ({
  open,
  onClose,
  scenario,
  paramValues,
  toggleValues,
  snapshot,
}) => {
  const [qrUrl, setQrUrl] = useState<string>('');
  const [pocketHref, setPocketHref] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    const origin =
      typeof window !== 'undefined' && window.location.origin.startsWith('http')
        ? window.location.origin
        : 'https://faultline-v3.web.app';
    const encodedUrl = encodePocketUrl(origin, {
      scenarioId: scenario.id,
      paramValues,
      toggleValues,
      verifiedMargin: snapshot.cloudMargin,
      isSafe: snapshot.isSafe,
    });
    setPocketHref(encodedUrl);
    void makeQrDataUrl(encodedUrl, '#282828', '#F6F4EE').then(setQrUrl);
  }, [open, scenario.id, paramValues, toggleValues, snapshot.isSafe, snapshot.cloudMargin]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-[#282828]/65 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-[#F6F4EE] border-2 border-[#282828] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 bg-[#282828] text-[#F6F4EE] flex items-center justify-between">
          <span className="heron-mono text-xs font-bold flex items-center gap-2">
            <QrCode className="w-3.5 h-3.5 text-[#FA3600]" />
            [OFFLINE SURVIVAL SCHEDULE QR · FFLATE URL]
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Offline QR Modal"
            className="heron-mono text-xs px-2 py-0.5 bg-[#FA3600] text-[#FFFFFF] cursor-pointer"
          >
            [X]
          </button>
        </div>

        <div className="p-5 flex flex-col items-center text-center gap-3">
          <div className="heron-mono text-[10.5px] font-bold text-[#282828] flex items-center gap-1.5">
            <WifiOff className="w-3.5 h-3.5 text-[#FA3600]" />
            SCAN WITH PHONE CAMERA · HYDRATES OFFLINE FIELD PAD
          </div>

          <div className="p-3 border-2 border-[#282828] bg-[#F6F4EE]">
            {qrUrl ? (
              <img
                src={qrUrl}
                alt="FaultLine Offline Survival Schedule QR Code"
                className="w-48 h-48 block"
              />
            ) : (
              <div className="w-48 h-48 flex items-center justify-center heron-mono text-xs text-[#575652]">
                GENERATING QR…
              </div>
            )}
          </div>

          <div className="w-full p-2.5 border border-[#D4D2CA] bg-[#FAF9F5] text-left heron-mono text-[10px] text-[#282828] flex flex-col gap-1">
            <div>SCENARIO: {scenario.title.toUpperCase()}</div>
            <div>
              VERIFIED BUFFER: {snapshot.cloudMargin > 0 ? '+' : ''}
              {snapshot.cloudMargin} {scenario.marginUnit} ({snapshot.isSafe ? 'SAFE' : 'BREACH'})
            </div>
            <div className="truncate text-[#575652]">
              URL ({pocketHref.length} CHARS): {pocketHref}
            </div>
            <button
              type="button"
              onClick={() => {
                copySafe(pocketHref);
                toast.success(`Copied ${pocketHref.length}-char ?pocket= survival URL`);
              }}
              className="mt-1 w-full py-1 bg-[#282828] text-[#F6F4EE] font-bold cursor-pointer flex items-center justify-center gap-1"
            >
              <Copy className="w-3 h-3" /> COPY SHAREABLE ?POCKET= LINK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface IphoneDrawerProps {
  open: boolean;
  onClose: () => void;
  scenario: ScenarioDefinition;
  paramValues: Record<string, number>;
  toggleValues: Record<string, boolean>;
  snapshot: SimulationSnapshot;
  onScrubParam: (key: string, val: number) => void;
  onToggleMitigation: (key: string, nextVal: boolean) => void;
}

export const HeronIphoneFaultPadDrawer: React.FC<IphoneDrawerProps> = ({
  open,
  onClose,
  scenario,
  paramValues,
  toggleValues,
  snapshot,
  onScrubParam,
  onToggleMitigation,
}) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-[#282828]/55 flex justify-end"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm h-full bg-[#F6F4EE] border-l-2 border-[#282828] p-4 flex flex-col justify-between overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between pb-2.5 border-b border-[#282828]">
            <span className="heron-mono text-xs font-bold text-[#282828] flex items-center gap-1.5">
              <Smartphone className="w-4 h-4 text-[#FA3600]" />
              OFFLINE POCKET FAULT PAD · PWA SYNC
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Virtual iPhone Fault Pad"
              className="p-1 border border-[#282828] bg-[#FAF9F5] text-[#282828] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Simulated iPhone Frame */}
          <div className="rounded-[28px] border-[3px] border-[#282828] bg-[#FAF9F5] p-3.5 shadow-lg flex flex-col gap-3">
            <div className="mx-auto w-28 h-4 rounded-full bg-[#282828] flex items-center justify-center">
              <span className="heron-mono text-[8px] text-[#F6F4EE]">OFFLINE READY</span>
            </div>

            <div
              className="p-2.5 border border-[#282828]"
              style={{
                backgroundColor: snapshot.isSafe ? '#15803D' : '#FA3600',
                color: '#FFFFFF',
              }}
            >
              <div className="heron-mono text-[9.5px] font-bold">FIELD COMPANION ENVELOPE</div>
              <div className="heron-display text-2xl font-extrabold mt-0.5">
                {snapshot.cloudMargin > 0 ? '+' : ''}
                {snapshot.cloudMargin} {scenario.marginUnit.toUpperCase()}
              </div>
              <div className="heron-mono text-[9.5px] opacity-90">{snapshot.failurePointLabel}</div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="heron-mono text-[10px] font-bold text-[#282828]">
                FIELD PARAMETER SCRUBBERS
              </div>
              {scenario.params.slice(0, 3).map((p) => {
                const v = paramValues[p.key] ?? p.value;
                return (
                  <div key={p.key} className="p-2 border border-[#D4D2CA] bg-[#F6F4EE]">
                    <div className="flex justify-between heron-mono text-[10px] font-bold text-[#282828]">
                      <span>{p.label}</span>
                      <span>
                        {v} {p.unit}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      value={v}
                      onChange={(e) => onScrubParam(p.key, Number(e.target.value))}
                      className="w-full accent-[#FA3600] mt-1 cursor-pointer"
                    />
                  </div>
                );
              })}
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="heron-mono text-[10px] font-bold text-[#282828]">
                ONE-TAP FIELD MITIGATIONS
              </div>
              {scenario.toggles.map((tg) => {
                const on = !!toggleValues[tg.key];
                return (
                  <button
                    key={tg.key}
                    type="button"
                    onClick={() => onToggleMitigation(tg.key, !on)}
                    className="w-full text-left px-2.5 py-2 border border-[#282828] heron-mono text-[10px] font-bold cursor-pointer flex items-center justify-between"
                    style={{
                      backgroundColor: on ? '#15803D' : '#EFECE4',
                      color: on ? '#FFFFFF' : '#282828',
                    }}
                  >
                    <span className="truncate pr-2">{tg.effectBadge.toUpperCase()}</span>
                    <span>[{on ? 'ON' : 'OFF'}]</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="pt-3 heron-mono text-[10px] text-[#575652]">
          CHANGES SYNC INSTANTLY WITH SHEET ELEVATION &amp; 60FPS SURROGATE FAN.
        </div>
      </div>
    </div>
  );
};
