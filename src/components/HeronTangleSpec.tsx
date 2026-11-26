import React, { useMemo, useRef, useState } from 'react';
import { Switch } from '@base-ui/react/switch';
import { CheckCheck, Download, RotateCcw, ShieldAlert, Sliders, Sparkles } from 'lucide-react';
import type {
  ScenarioDefinition,
  ScrubParam,
  SimulationSnapshot,
} from '../core/faultlineEngine';

export interface PiecewiseProofSegment {
  id: string;
  windowLabel: string;
  regimeName: string;
  formulaExpr: string;
  endReservePct: number;
  frac: number;
  passed: boolean;
}

export function buildPiecewiseProofSchedule(
  scenario: ScenarioDefinition,
  paramValues: Record<string, number>,
  toggleValues: Record<string, boolean>,
  snapshot: SimulationSnapshot,
): PiecewiseProofSegment[] {
  const at = (f: number) => {
    const idx = Math.min(
      snapshot.cloudSeries.length - 1,
      Math.max(0, Math.round(f * (snapshot.cloudSeries.length - 1))),
    );
    return snapshot.cloudSeries[idx] ?? 0;
  };

  if (scenario.id === 'typhoon-cpap') {
    const hrs = paramValues.outageHours ?? 36;
    const cpap = paramValues.cpapWatts ?? 38;
    const hum = toggleValues.disableHumidifier ? 0 : 26;
    const tare = toggleValues.dcDirectMode ? 1.5 : paramValues.inverterTareW ?? 14;
    const cooler = paramValues.coolerWatts ?? 24;
    return [
      {
        id: 'pw-01',
        windowLabel: 'T+00h → T+08h',
        regimeName: 'I. BMS Floor & Daytime Cold-Chain',
        formulaExpr: `E₀ = 0.90·C_nom − (${cooler}W + ${tare}W)·Δt`,
        endReservePct: at(8 / Math.max(12, hrs)),
        frac: Math.min(1, 8 / Math.max(12, hrs)),
        passed: at(8 / Math.max(12, hrs)) >= 55,
      },
      {
        id: 'pw-02',
        windowLabel: 'T+08h → T+16h',
        regimeName: 'II. Sleep Window 1 (Peukert η)',
        formulaExpr: `P_sleep = (${cpap}+${hum}W)/η + ${tare}W`,
        endReservePct: at(16 / Math.max(16, hrs)),
        frac: Math.min(1, 16 / Math.max(16, hrs)),
        passed: at(16 / Math.max(16, hrs)) >= 32,
      },
      {
        id: 'pw-03',
        windowLabel: 'T+16h → T+22h',
        regimeName: 'III. 29°C Ambient Peak Drift',
        formulaExpr: toggleValues.preChillPacks ? 'Q_cool × 0.68 PCM' : 'Q_cool × (1+0.18·sin θ)',
        endReservePct: at(22 / Math.max(22, hrs)),
        frac: Math.min(1, 22 / Math.max(22, hrs)),
        passed: at(22 / Math.max(22, hrs)) >= 22,
      },
      {
        id: 'pw-04',
        windowLabel: `T+22h → T+${hrs}h`,
        regimeName: 'IV. Terminal Overnight Holdover',
        formulaExpr: `E_end ≥ 10% BMS Lockout`,
        endReservePct: at(1),
        frac: 1,
        passed: snapshot.isSafe,
      },
    ];
  }

  if (scenario.id === 'singles-day-cutover') {
    const rps = paramValues.rps ?? 5200;
    const retries = paramValues.retries ?? 3;
    const rtt = Math.max(12, (paramValues.crossRegionRttMs ?? 68) - (toggleValues.asyncOutbox ? 24 : 0));
    return [
      {
        id: 'pw-01',
        windowLabel: 'T+00m → T+06m',
        regimeName: 'I. Canary Ingress Ramp',
        formulaExpr: `λ = 0.65→1.0·${rps} req/s`,
        endReservePct: at(6 / 36),
        frac: 6 / 36,
        passed: at(6 / 36) >= 20,
      },
      {
        id: 'pw-02',
        windowLabel: 'T+06m → T+18m',
        regimeName: 'II. Kingman Queue & Retry Wave',
        formulaExpr: toggleValues.tokenBucketRetry ? 'A_retry ≤ 1.08x Cap' : `A_retry = 1 + 0.46·${retries}x`,
        endReservePct: at(18 / 36),
        frac: 18 / 36,
        passed: at(18 / 36) >= 18,
      },
      {
        id: 'pw-03',
        windowLabel: 'T+18m → T+26m',
        regimeName: 'III. Cross-Region WAL Lock Hold',
        formulaExpr: `W_hold = 18ms + ${rtt}ms RTT`,
        endReservePct: at(26 / 36),
        frac: 26 / 36,
        passed: at(26 / 36) >= 18,
      },
      {
        id: 'pw-04',
        windowLabel: 'T+26m → T+36m',
        regimeName: 'IV. Standby Steady-State SLA',
        formulaExpr: `Pool Headroom ≥ 15% Floor`,
        endReservePct: at(1),
        frac: 1,
        passed: snapshot.isSafe,
      },
    ];
  }

  const effLag = Math.max(0.5, (paramValues.relocOneOffMos ?? 3.5) - (toggleValues.staggerMove ? 1.4 : 0));
  const effFx = toggleValues.fxForwardCap ? (paramValues.fxShockPct ?? 16) * 0.4 : paramValues.fxShockPct ?? 16;
  const effBps = toggleValues.rateCapClause ? Math.min(paramValues.rateHikeBps ?? 225, 75) : paramValues.rateHikeBps ?? 225;
  return [
    {
      id: 'pw-01',
      windowLabel: 'M00 → M03',
      regimeName: 'I. Deposit & Dual-Tax Lockup',
      formulaExpr: `R₂ = R₀ − ${effLag.toFixed(1)} mos`,
      endReservePct: at(3 / 36),
      frac: 3 / 36,
      passed: at(3 / 36) >= 25,
    },
    {
      id: 'pw-02',
      windowLabel: 'M04 → M12',
      regimeName: 'II. FX Slide & Rate Reset Onset',
      formulaExpr: `FX −${effFx.toFixed(1)}% · +${effBps}bps`,
      endReservePct: at(12 / 36),
      frac: 12 / 36,
      passed: at(12 / 36) >= 22,
    },
    {
      id: 'pw-03',
      windowLabel: 'M13 → M24',
      regimeName: 'III. Year-2 Tax Lag Compounding',
      formulaExpr: `Δburn +0.16 mos @ M16–M17`,
      endReservePct: at(24 / 36),
      frac: 24 / 36,
      passed: at(24 / 36) >= 20,
    },
    {
      id: 'pw-04',
      windowLabel: 'M25 → M36',
      regimeName: 'IV. 3.0-Month Covenant Floor',
      formulaExpr: `min(R_t) ≥ 3.0 mos`,
      endReservePct: at(1),
      frac: 1,
      passed: snapshot.isSafe,
    },
  ];
}

interface HeronTangleSpecProps {
  scenario: ScenarioDefinition;
  paramValues: Record<string, number>;
  toggleValues: Record<string, boolean>;
  snapshot: SimulationSnapshot;
  onScrubParam: (key: string, val: number) => void;
  onToggleMitigation: (key: string, nextVal: boolean) => void;
  onApproveMitigationFix: () => void;
  onResetDefaults: () => void;
  inspectedStepFrac: number | null;
  onSelectStepFrac: (frac: number) => void;
  onExportCadZip: () => void;
}

export const HeronTangleSpec: React.FC<HeronTangleSpecProps> = ({
  scenario,
  paramValues,
  toggleValues,
  snapshot,
  onScrubParam,
  onToggleMitigation,
  onApproveMitigationFix,
  onResetDefaults,
  inspectedStepFrac,
  onSelectStepFrac,
  onExportCadZip,
}) => {
  const [selectedParamKey, setSelectedParamKey] = useState<string | null>(null);
  const dragRef = useRef<{
    key: string;
    startX: number;
    startVal: number;
    moved: boolean;
    param: ScrubParam;
  } | null>(null);

  const paramMap = new Map(scenario.params.map((p) => [p.key, p]));
  const toggleMap = new Map(scenario.toggles.map((t) => [t.key, t]));

  const proofSegments = useMemo(
    () => buildPiecewiseProofSchedule(scenario, paramValues, toggleValues, snapshot),
    [scenario, paramValues, toggleValues, snapshot],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>, param: ScrubParam) => {
    dragRef.current = {
      key: param.key,
      startX: e.clientX,
      startVal: paramValues[param.key] ?? param.value,
      moved: false,
      param,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const st = dragRef.current;
    if (!st) return;
    const dx = e.clientX - st.startX;
    if (Math.abs(dx) > 3) {
      st.moved = true;
      const span = st.param.max - st.param.min;
      const raw = st.startVal + (dx / 140) * span;
      const stepped =
        Math.round((raw - st.param.min) / st.param.step) * st.param.step + st.param.min;
      const clamped = Number(Math.max(st.param.min, Math.min(st.param.max, stepped)).toFixed(2));
      if (clamped !== paramValues[st.key]) {
        onScrubParam(st.key, clamped);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>, key: string) => {
    const st = dragRef.current;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Safe release
    }
    if (st && !st.moved) {
      setSelectedParamKey((prev) => (prev === key ? null : key));
    }
  };

  const selectedParam = selectedParamKey ? paramMap.get(selectedParamKey) : null;
  const selectedVal = selectedParam ? paramValues[selectedParam.key] ?? selectedParam.value : 0;

  return (
    <section
      aria-label="Architectural Constraint Schedule and Tangle Controls"
      className="bg-[#F6F4EE] border-b lg:border-b-0 lg:border-r border-[#D4D2CA] flex flex-col justify-between"
    >
      <div>
        {/* Schedule Header */}
        <div className="px-4 py-2.5 border-b border-[#D4D2CA] bg-[#EFECE4] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="heron-mono text-[10.5px] font-bold px-2 py-0.5 border border-[#282828] bg-[#FAF9F5] text-[#282828]">
              [01 · TANGLE SPECIFICATION]
            </span>
            <span className="heron-mono text-[10px] text-[#575652]">
              DRAG [↔] NUMERIC PILLS OR CLICK TO CALIBRATE
            </span>
          </div>

          <button
            type="button"
            onClick={onResetDefaults}
            className="heron-mono text-[10px] font-semibold px-2 py-0.5 border border-[#282828] bg-[#FAF9F5] text-[#282828] hover:bg-[#282828] hover:text-[#F6F4EE] transition-colors cursor-pointer flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" />
            [RESET]
          </button>
        </div>

        {/* Prose Clauses §1 - §3 */}
        <div className="divide-y divide-[#D4D2CA]">
          {scenario.clauses.map((clause, idx) => {
            const relatedConflicts = snapshot.conflicts.filter(
              (c) => c.fromClauseId === clause.id || c.toClauseId === clause.id,
            );
            const hasConflict = relatedConflicts.length > 0;
            return (
              <div key={clause.id} className="p-3.5 bg-[#FAF9F5]/75">
                <div className="flex flex-wrap items-center justify-between gap-1.5 mb-1.5">
                  <span className="heron-mono text-[11px] font-bold text-[#282828]">
                    [{String(idx + 1).padStart(2, '0')}] {clause.title.toUpperCase()}
                  </span>
                  {hasConflict ? (
                    <span className="heron-mono text-[9.5px] font-bold px-1.5 py-0.5 bg-[#282828] text-[#F6F4EE] border-l-4 border-l-[#FA3600]">
                      VIOLATION · {relatedConflicts[0].localLatencyMs}MS NANO
                    </span>
                  ) : (
                    <span className="heron-mono text-[9.5px] font-bold px-1.5 py-0.5 bg-[#15803D] text-[#FFFFFF]">
                      STAMPED OK
                    </span>
                  )}
                </div>

                <p className="text-[13px] leading-[1.9] text-[#282828] m-0">
                  {clause.segments.map((seg, sIdx) => {
                    if (seg.type === 'text') {
                      return <React.Fragment key={sIdx}>{seg.content}</React.Fragment>;
                    }
                    if (seg.type === 'param') {
                      const p = paramMap.get(seg.paramKey);
                      if (!p) return null;
                      const val = paramValues[p.key] ?? p.value;
                      const pct = Math.max(0, Math.min(100, ((val - p.min) / (p.max - p.min)) * 100));
                      const active = selectedParamKey === p.key;
                      return (
                        <button
                          key={sIdx}
                          type="button"
                          onPointerDown={(e) => handlePointerDown(e, p)}
                          onPointerMove={handlePointerMove}
                          onPointerUp={(e) => handlePointerUp(e, p.key)}
                          title={`${p.label}: drag horizontally or click (${p.min}–${p.max} ${p.unit})`}
                          className="relative inline-flex items-center gap-1 mx-1 px-2 py-0.5 heron-mono text-[11.5px] font-bold select-none cursor-ew-resize align-baseline border transition-colors"
                          style={{
                            backgroundColor: active ? '#282828' : '#F6F4EE',
                            color: active ? '#F6F4EE' : '#282828',
                            borderColor: '#282828',
                          }}
                        >
                          <span
                            aria-hidden="true"
                            className="absolute left-0 bottom-0 h-[2.5px]"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: snapshot.isSafe ? '#15803D' : '#FA3600',
                            }}
                          />
                          <span>{val}</span>
                          <span className="text-[10px] opacity-80">{p.unit}</span>
                          <span className="text-[9.5px] text-[#B82500] font-bold">↔</span>
                        </button>
                      );
                    }
                    const tg = toggleMap.get(seg.toggleKey);
                    if (!tg) return null;
                    const isOn = !!toggleValues[tg.key];
                    return (
                      <button
                        key={sIdx}
                        type="button"
                        onClick={() => onToggleMitigation(tg.key, !isOn)}
                        className="inline-flex items-center gap-1 mx-1 px-2 py-0.5 heron-mono text-[10.5px] font-bold align-baseline cursor-pointer border transition-colors"
                        style={{
                          backgroundColor: isOn ? '#15803D' : '#EFECE4',
                          borderColor: isOn ? '#15803D' : '#282828',
                          color: isOn ? '#FFFFFF' : '#282828',
                        }}
                      >
                        <span>[{isOn ? 'ON' : 'OFF'}]</span>
                        <span>{tg.effectBadge.toUpperCase()}</span>
                      </button>
                    );
                  })}
                </p>
              </div>
            );
          })}
        </div>

        {/* Precision Slider Drawer when a Tangle Pill is Clicked */}
        {selectedParam && (
          <div className="p-3.5 border-t border-[#282828] bg-[#EFECE4] flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="heron-mono text-[11px] font-bold text-[#282828] flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[#FA3600]" />
                {selectedParam.label.toUpperCase()}: {selectedVal} {selectedParam.unit}
              </span>
              <button
                type="button"
                onClick={() => setSelectedParamKey(null)}
                className="heron-mono text-[10px] font-bold px-2 py-0.5 bg-[#282828] text-[#F6F4EE] cursor-pointer"
              >
                [CLOSE]
              </button>
            </div>
            <p className="text-[11px] text-[#575652] m-0">{selectedParam.description}</p>
            <input
              type="range"
              min={selectedParam.min}
              max={selectedParam.max}
              step={selectedParam.step}
              value={selectedVal}
              onChange={(e) => onScrubParam(selectedParam.key, Number(e.target.value))}
              aria-label={selectedParam.label}
              className="w-full accent-[#FA3600] cursor-pointer"
            />
          </div>
        )}
      </div>

      {/* Interactive Piecewise Constraint Proof Schedule Stamp */}
      <div className="border-t border-[#D4D2CA] bg-[#FAF9F5] p-3.5 flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="heron-mono text-[10.5px] font-bold px-2 py-0.5 bg-[#282828] text-[#F6F4EE]">
              [PIECEWISE CONSTRAINT PROOF SCHEDULE]
            </span>
            <span
              className="heron-mono text-[9.5px] font-bold px-2 py-0.5 border flex items-center gap-1"
              style={{
                borderColor: snapshot.isSafe ? '#15803D' : '#B82500',
                backgroundColor: snapshot.isSafe ? '#ECFDF5' : '#FEF2F2',
                color: snapshot.isSafe ? '#136B33' : '#B82500',
              }}
            >
              {snapshot.isSafe ? (
                <>
                  <CheckCheck className="w-3 h-3" />
                  PROOF Q.E.D. · 4/4 REGIMES
                </>
              ) : (
                <>
                  <ShieldAlert className="w-3 h-3" />
                  COUNTEREXAMPLE FOUND
                </>
              )}
            </span>
          </div>

          <button
            type="button"
            onClick={onExportCadZip}
            className="heron-mono text-[10px] font-bold px-2.5 py-1 border border-[#282828] bg-[#EFECE4] text-[#282828] hover:bg-[#282828] hover:text-[#F6F4EE] transition-colors cursor-pointer flex items-center gap-1"
          >
            <Download className="w-3 h-3 text-[#FA3600]" />
            [EXPORT CAD AUDIT .ZIP]
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {proofSegments.map((seg) => {
            const isSelected =
              inspectedStepFrac !== null && Math.abs(inspectedStepFrac - seg.frac) < 0.04;
            return (
              <button
                key={seg.id}
                type="button"
                onClick={() => onSelectStepFrac(seg.frac)}
                className="text-left p-2 border transition-colors cursor-pointer flex flex-col gap-0.5"
                style={{
                  backgroundColor: isSelected ? '#EFECE4' : '#F6F4EE',
                  borderColor: isSelected ? '#282828' : '#D4D2CA',
                  borderLeftWidth: '3px',
                  borderLeftColor: seg.passed ? '#15803D' : '#FA3600',
                }}
              >
                <div className="flex items-center justify-between gap-1 heron-mono text-[9.5px] font-bold">
                  <span className="text-[#282828]">{seg.windowLabel}</span>
                  <span style={{ color: seg.passed ? '#136B33' : '#B82500' }}>
                    [{seg.passed ? 'PASS' : 'BREACH'} · {seg.endReservePct.toFixed(1)}%]
                  </span>
                </div>
                <div className="text-[11px] font-bold text-[#282828] truncate">{seg.regimeName}</div>
                <div className="heron-mono text-[9.5px] text-[#575652] truncate">{seg.formulaExpr}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Structural Mitigation Schedule (@base-ui/react Switch) */}
      <div className="border-t border-[#D4D2CA] bg-[#F6F4EE] p-3.5 flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="heron-mono text-[10.5px] font-bold text-[#282828]">
            [STRUCTURAL MITIGATION SCHEDULE · INK-SEEP PATCHES]
          </span>
          {!snapshot.isSafe && (
            <button
              type="button"
              onClick={onApproveMitigationFix}
              className="heron-mono text-[10px] font-bold px-2.5 py-1 bg-[#282828] text-[#F6F4EE] hover:bg-[#136B33] transition-colors cursor-pointer flex items-center gap-1"
            >
              <Sparkles className="w-3 h-3 text-[#FA3600]" />
              [ENGAGE ALL FIXES]
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          {scenario.toggles.map((tg, idx) => {
            const checked = !!toggleValues[tg.key];
            return (
              <div
                key={tg.key}
                className="px-3 py-2 border border-[#D4D2CA] bg-[#FAF9F5] flex items-center justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="heron-mono text-[10px] font-bold text-[#575652]">
                      [M0{idx + 1}]
                    </span>
                    <span className="text-[12px] font-semibold text-[#282828]">{tg.label}</span>
                  </div>
                  <p className="text-[11px] text-[#575652] m-0 mt-0.5 truncate">{tg.description}</p>
                </div>

                <Switch.Root
                  checked={checked}
                  onCheckedChange={(next) => onToggleMitigation(tg.key, next)}
                  aria-label={tg.label}
                  className="relative inline-flex h-5 w-10 shrink-0 cursor-pointer items-center border border-[#282828] transition-colors"
                  style={{
                    backgroundColor: checked ? '#15803D' : '#EFECE4',
                  }}
                >
                  <Switch.Thumb
                    className="block h-3.5 w-3.5 bg-[#282828] transition-transform"
                    style={{
                      backgroundColor: checked ? '#FFFFFF' : '#282828',
                      transform: checked ? 'translateX(21px)' : 'translateX(3px)',
                    }}
                  />
                </Switch.Root>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
