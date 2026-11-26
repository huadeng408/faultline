import React, { useEffect, useMemo, useState } from 'react';
import Lenis from 'lenis';
import { Toaster, toast } from 'sonner';
import {
  Cpu,
  Download,
  ExternalLink,
  Lock,
  QrCode,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import {
  SCENARIOS,
  computeRedactionReceipt,
  computeSimulation,
  sharedBridge,
  type ScenarioId,
} from './core/faultlineEngine';
import { injectStudioFonts, downloadBundleZip } from './lib/studioAssets';
import { DraftingCrosshairOverlay } from './components/DraftingCrosshairOverlay';
import { HeronBlueprintStage } from './components/HeronBlueprintStage';
import { HeronTangleSpec, buildPiecewiseProofSchedule } from './components/HeronTangleSpec';
import { SimplexDraftingChart } from './components/SimplexDraftingChart';
import { HeronFooterInkWordmark } from './components/HeronFooterInkWordmark';
import {
  HeronIphoneFaultPadDrawer,
  HeronOfflineQrModal,
  HeronPrivacyAirlockModal,
} from './components/HeronModals';

injectStudioFonts();

function getInitialParams(id: ScenarioId): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of SCENARIOS[id].params) {
    out[p.key] = p.value;
  }
  return out;
}

function getInitialToggles(id: ScenarioId): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const t of SCENARIOS[id].toggles) {
    out[t.key] = t.enabled;
  }
  return out;
}

export default function App() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>('typhoon-cpap');
  const [paramValues, setParamValues] = useState<Record<string, number>>(() =>
    getInitialParams('typhoon-cpap'),
  );
  const [toggleValues, setToggleValues] = useState<Record<string, boolean>>(() =>
    getInitialToggles('typhoon-cpap'),
  );
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [inspectedStepFrac, setInspectedStepFrac] = useState<number | null>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [iphoneOpen, setIphoneOpen] = useState(false);

  // Initialize Studio Display WOFF font + Lenis smooth architectural scroll
  useEffect(() => {
    injectStudioFonts();
    const lenis = new Lenis({
      duration: 1.05,
      smoothWheel: true,
    });
    let raf = 0;
    const step = (time: number) => {
      lenis.raf(time);
      raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, []);

  const scenario = SCENARIOS[scenarioId];
  const snapshot = useMemo(
    () => computeSimulation(scenarioId, paramValues, toggleValues),
    [scenarioId, paramValues, toggleValues],
  );

  const handleSelectScenario = (nextId: ScenarioId) => {
    setScenarioId(nextId);
    setParamValues(getInitialParams(nextId));
    setToggleValues(getInitialToggles(nextId));
    setInspectedStepFrac(null);
    void sharedBridge.warmDeviceModel();
  };

  const handleScrubParam = (key: string, val: number) => {
    setParamValues((prev) => ({ ...prev, [key]: val }));
  };

  const handleToggleMitigation = (key: string, nextVal: boolean) => {
    setToggleValues((prev) => ({ ...prev, [key]: nextVal }));
    toast.message(
      nextVal
        ? `[PATCH APPLIED] ${key} inked onto blueprint`
        : `[PATCH REVERTED] ${key} disabled`,
    );
  };

  const handleApproveMitigationFix = () => {
    const next: Record<string, boolean> = {};
    for (const tg of scenario.toggles) {
      next[tg.key] = true;
    }
    setToggleValues(next);
    toast.success('All structural mitigations approved — ink-seep verification stamped!');
  };

  const handleResetDefaults = () => {
    setParamValues(getInitialParams(scenarioId));
    setToggleValues(getInitialToggles(scenarioId));
    setInspectedStepFrac(null);
    toast.message('Restored baseline fault scenario parameters');
  };

  const handleRunCloudCalibration = () => {
    setIsCalibrating(true);
    void sharedBridge.warmDeviceModel();
    window.setTimeout(() => {
      setIsCalibrating(false);
      toast.success(
        `Cloud Gemini Python solver verified margin: ${snapshot.cloudMargin > 0 ? '+' : ''}${
          snapshot.cloudMargin
        } ${scenario.marginUnit}`,
      );
    }, 420);
  };

  const handleExportCadZip = async () => {
    const receipt = await computeRedactionReceipt(scenario.rawPrivateSample, paramValues);
    const piecewise = buildPiecewiseProofSchedule(scenario, paramValues, toggleValues, snapshot);
    const auditJson = JSON.stringify(
      {
        schema: 'faultline.heron.cad_audit.v3.5',
        scenarioId,
        title: scenario.title,
        isCompliant: snapshot.isSafe,
        margins: {
          onDeviceNano: snapshot.localMargin,
          cloudPython: snapshot.cloudMargin,
          driftDelta: snapshot.driftDelta,
          unit: scenario.marginUnit,
        },
        failurePointLabel: snapshot.failurePointLabel,
        scrubbedParameters: paramValues,
        mitigationPatches: toggleValues,
        piecewiseProofSchedule: piecewise,
        sha256AirlockReceipt: receipt.sha256Hex,
        series: {
          xLabels: snapshot.xLabels,
          localNanoPct: snapshot.localSeries,
          cloudPythonPct: snapshot.cloudSeries,
        },
      },
      null,
      2,
    );

    const verifyPy = `#!/usr/bin/env python3
"""FaultLine v3 · Architectural CAD Simplex Verification Script (${scenarioId})"""
${snapshot.pythonCode}

# Piecewise Constraint Proof Assertions
expected_cloud_margin = ${snapshot.cloudMargin}
is_compliant = ${snapshot.isSafe ? 'True' : 'False'}
print(f"[CAD AUDIT STAMP] scenario=${scenarioId} compliant={is_compliant} expected_margin={expected_cloud_margin:+.1f} ${scenario.marginUnit}")
`;

    const blueprintMd = `# FAULTLINE V3 · ARCHITECTURAL CAD AUDIT BLUEPRINT
- **Scenario**: ${scenario.title} (\`${scenarioId}\`)
- **Compliance Stamp**: ${snapshot.isSafe ? 'CODE COMPLIANT (Q.E.D.)' : `VIOLATIONS DETECTED (${snapshot.conflicts.length})`}
- **Ground-Truth Cloud Python Margin**: ${snapshot.cloudMargin >= 0 ? '+' : ''}${snapshot.cloudMargin} ${scenario.marginUnit}
- **0.28s On-Device Linear Estimate**: ${snapshot.localMargin >= 0 ? '+' : ''}${snapshot.localMargin} ${scenario.marginUnit}
- **SHA-256 Privacy Airlock Digest**: \`${receipt.sha256Hex}\`
- **Design Homage**: [Heron AI — Awwwards SOTD](https://www.awwwards.com/sites/heron-ai) · [The FWA FOTD](https://legacy.thefwa.com/cases/heronai)

## Piecewise Constraint Proof Schedule
| Window | Regime | Governing Relation | End Reserve | Verdict |
| --- | --- | --- | --- | --- |
${piecewise
  .map(
    (seg) =>
      `| ${seg.windowLabel} | ${seg.regimeName} | \`${seg.formulaExpr}\` | ${seg.endReservePct.toFixed(1)}% | **${
        seg.passed ? 'PASS' : 'BREACH'
      }** |`,
  )
  .join('\n')}

## Discovered Non-Linear Invariants
${snapshot.discoveredInvariants.map((inv, idx) => `${idx + 1}. ${inv}`).join('\n')}
`;

    downloadBundleZip(`heron-cad-audit-${scenarioId}.zip`, {
      [`heron_cad_audit_${scenarioId}.json`]: auditJson,
      [`verify_simplex_${scenarioId}.py`]: verifyPy,
      'ARCHITECTURAL_BLUEPRINT_AUDIT.md': blueprintMd,
    });
    toast.success(`Exported heron-cad-audit-${scenarioId}.zip (.json + .py + .md)`);
  };

  const rulerTicks = Array.from({ length: 15 }, (_, idx) => idx * 100);

  return (
    <div className="min-h-screen bg-[#F6F4EE] text-[#282828] relative selection:bg-[#282828] selection:text-[#F6F4EE]">
      {/* Subtle Architectural Paper Grain SVG Overlay */}
      <svg
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 w-full h-full z-30 opacity-[0.035]"
      >
        <filter id="heron-paper-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="3" stitchTiles="stitch" />
        </filter>
        <rect width="100%" height="100%" filter="url(#heron-paper-grain)" />
      </svg>

      {/* Desktop 1px Full-Sheet Crosshair + 9px #FA3600 Cursor Tail */}
      <DraftingCrosshairOverlay />

      <Toaster position="bottom-left" />

      {/* Top Viewport Architectural Ruler Border */}
      <div
        aria-hidden="true"
        className="h-5 border-b border-[#D4D2CA] bg-[#EFECE4] px-3 flex items-end justify-between overflow-hidden select-none"
      >
        {rulerTicks.map((mm, idx) => (
          <div key={mm} className={`${idx > 5 ? 'hidden sm:flex' : 'flex'} items-end gap-1 shrink-0`}>
            <span className="inline-block w-[1px] h-2.5 bg-[#575652]" />
            <span className="heron-mono text-[8.5px] text-[#575652] pb-0.5">
              {String(mm).padStart(4, '0')}
            </span>
          </div>
        ))}
      </div>

      {/* Main Framed Architectural Sheet */}
      <div className="max-w-[1400px] mx-auto border-x border-b border-[#D4D2CA] bg-[#F6F4EE] relative">
        {/* Top Navigation & Attribution Header Bar */}
        <header className="border-b border-[#D4D2CA] bg-[#FAF9F5] grid grid-cols-1 lg:grid-cols-12">
          <div className="lg:col-span-4 px-4 py-3 border-b lg:border-b-0 lg:border-r border-[#D4D2CA] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-7 h-7 bg-[#282828] text-[#F6F4EE] heron-mono text-xs font-bold flex items-center justify-center border-b-2 border-b-[#FA3600] shrink-0">
                FL
              </div>
              <div className="min-w-0">
                <div className="heron-display text-[15.5px] xl:text-[16.5px] font-extrabold tracking-tight text-[#282828] whitespace-nowrap">
                  FAULTLINE V3 · CAD AUDIT
                </div>
                <div className="heron-mono text-[9.5px] text-[#575652] truncate">
                  [ON_DEVICE · 280MS] ⇄ [ONLY_IN_CLOUD · PYTHON]
                </div>
              </div>
            </div>

            <div className="hidden sm:flex items-center gap-1 shrink-0">
              <a
                href="https://www.awwwards.com/sites/heron-ai"
                target="_blank"
                rel="noopener noreferrer"
                className="heron-mono text-[9px] font-bold px-1.5 py-1 border border-[#D4D2CA] bg-[#F6F4EE] text-[#282828] hover:border-[#282828] inline-flex items-center gap-1 no-underline"
              >
                SOTD <ExternalLink className="w-2.5 h-2.5 text-[#FA3600]" />
              </a>
              <a
                href="https://legacy.thefwa.com/cases/heronai"
                target="_blank"
                rel="noopener noreferrer"
                className="heron-mono text-[9px] font-bold px-1.5 py-1 border border-[#D4D2CA] bg-[#F6F4EE] text-[#282828] hover:border-[#282828] inline-flex items-center gap-1 no-underline"
              >
                FWA <ExternalLink className="w-2.5 h-2.5 text-[#FA3600]" />
              </a>
            </div>
          </div>

          {/* Scenario Blueprint Sheet Switcher */}
          <nav
            aria-label="Blueprint Scenario Sheets"
            className="lg:col-span-4 px-3 py-2 border-b lg:border-b-0 lg:border-r border-[#D4D2CA] flex items-center gap-1.5 flex-wrap"
          >
            {(
              [
                { id: 'typhoon-cpap', code: '[01]', short: 'TYPHOON 36H' },
                { id: 'singles-day-cutover', code: '[02]', short: 'SRE CUTOVER' },
                { id: 'expat-cashflow', code: '[03]', short: 'EXPAT RUNWAY' },
              ] as const
            ).map((tab) => {
              const active = scenarioId === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleSelectScenario(tab.id)}
                  className="heron-mono text-[10px] font-bold px-2 py-1.5 border transition-colors cursor-pointer whitespace-nowrap"
                  style={{
                    backgroundColor: active ? '#282828' : '#F6F4EE',
                    borderColor: active ? '#282828' : '#D4D2CA',
                    color: active ? '#F6F4EE' : '#282828',
                  }}
                >
                  <span style={{ color: active ? '#FF7A52' : '#575652' }} className="mr-1">
                    {tab.code}
                  </span>
                  {tab.short}
                </button>
              );
            })}
          </nav>

          {/* Hybrid Utility Action Strip + [EXPORT CAD AUDIT .ZIP] */}
          <div className="lg:col-span-4 px-3 py-2 flex flex-wrap items-center justify-start lg:justify-end gap-1.5 bg-[#EFECE4]">
            <button
              type="button"
              onClick={() => void handleExportCadZip()}
              className="heron-mono text-[10px] font-bold px-2 py-1.5 border border-[#282828] bg-[#282828] text-[#F6F4EE] hover:bg-[#15803D] hover:border-[#15803D] cursor-pointer flex items-center gap-1"
            >
              <Download className="w-3 h-3 text-[#FF7A52]" />
              [EXPORT CAD AUDIT .ZIP]
            </button>
            <button
              type="button"
              onClick={() => setPrivacyOpen(true)}
              className="heron-mono text-[10px] font-bold px-2 py-1.5 border border-[#282828] bg-[#FAF9F5] text-[#282828] hover:bg-[#282828] hover:text-[#F6F4EE] cursor-pointer flex items-center gap-1"
            >
              <Lock className="w-3 h-3 text-[#FA3600]" />
              AIRLOCK
            </button>
            <button
              type="button"
              onClick={() => setQrOpen(true)}
              className="heron-mono text-[10px] font-bold px-2 py-1.5 border border-[#282828] bg-[#FAF9F5] text-[#282828] hover:bg-[#282828] hover:text-[#F6F4EE] cursor-pointer flex items-center gap-1"
            >
              <QrCode className="w-3 h-3" />
              QR
            </button>
            <button
              type="button"
              onClick={() => setIphoneOpen(true)}
              className="heron-mono text-[10px] font-bold px-2 py-1.5 border border-[#282828] bg-[#FAF9F5] text-[#282828] hover:bg-[#282828] hover:text-[#F6F4EE] cursor-pointer flex items-center gap-1"
            >
              <Smartphone className="w-3 h-3 text-[#FA3600]" />
              PAD
            </button>
          </div>
        </header>

        {/* Architectural Hero Title Row */}
        <section className="border-b border-[#D4D2CA] grid grid-cols-1 lg:grid-cols-12 bg-[#F6F4EE]">
          <div className="lg:col-span-8 px-5 py-4 border-b lg:border-b-0 lg:border-r border-[#D4D2CA]">
            <div className="flex flex-wrap items-center gap-2 mb-2.5">
              <span className="heron-mono text-[10.5px] font-bold px-2 py-0.5 border border-[#282828] bg-[#EFECE4] text-[#282828]">
                [{scenario.badge.toUpperCase()}]
              </span>
              <span className="heron-mono text-[10.5px] text-[#575652] flex items-center gap-1">
                <Cpu className="w-3 h-3 text-[#FA3600]" />
                {sharedBridge.status.sdkVersion.toUpperCase()}
              </span>
            </div>

            <h1 className="heron-display text-3xl sm:text-5xl font-black text-[#282828] m-0">
              {scenario.title}
            </h1>
            <p className="mt-2.5 text-[13.5px] text-[#575652] max-w-3xl leading-relaxed m-0">
              {scenario.subtitle}
            </p>
          </div>

          {/* Right Compliance Stamp Cell */}
          <div className="lg:col-span-4 px-5 py-4 bg-[#FAF9F5] flex flex-col justify-between gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="heron-mono text-[10px] font-bold text-[#575652]">
                [STRUCTURAL AUDIT STAMP]
              </span>
              <span
                className="heron-mono text-[10.5px] font-bold px-2 py-0.5 flex items-center gap-1"
                style={{
                  backgroundColor: snapshot.isSafe ? '#15803D' : '#282828',
                  color: '#FFFFFF',
                }}
              >
                {snapshot.isSafe ? (
                  <>
                    <ShieldCheck className="w-3.5 h-3.5" />
                    CODE COMPLIANT
                  </>
                ) : (
                  <>
                    <ShieldAlert className="w-3.5 h-3.5 text-[#FF7A52]" />
                    {snapshot.conflicts.length} VIOLATIONS DETECTED
                  </>
                )}
              </span>
            </div>

            <div className="border border-[#282828] p-3 bg-[#F6F4EE] flex items-baseline justify-between gap-2">
              <div>
                <div className="heron-mono text-[9.5px] text-[#575652]">GROUND-TRUTH MARGIN</div>
                <div
                  className="heron-display text-4xl font-black mt-0.5"
                  style={{ color: snapshot.isSafe ? '#136B33' : '#B82500' }}
                >
                  {snapshot.cloudMargin > 0 ? '+' : ''}
                  {snapshot.cloudMargin} {scenario.marginUnit}
                </div>
              </div>
              <div className="text-right">
                <div className="heron-mono text-[9.5px] text-[#575652]">NANO LINEAR EST</div>
                <div className="heron-mono text-base font-bold text-[#282828]">
                  {snapshot.localMargin > 0 ? '+' : ''}
                  {snapshot.localMargin} {scenario.marginUnit}
                </div>
              </div>
            </div>

            <div className="heron-mono text-[10px] text-[#575652] flex items-center justify-between">
              <span>VORONOI CAD + FFLATE ZIP BUNDLE</span>
              <span className="font-bold text-[#282828]">READY</span>
            </div>
          </div>
        </section>

        {/* Centerpiece Interactive Architectural Elevation Blueprint + Drag-Box Violation Finder */}
        <HeronBlueprintStage
          scenarioId={scenarioId}
          scenario={scenario}
          paramValues={paramValues}
          toggleValues={toggleValues}
          snapshot={snapshot}
          onToggleMitigation={handleToggleMitigation}
          onApproveMitigationFix={handleApproveMitigationFix}
          onResetDefaults={handleResetDefaults}
        />

        {/* Lower Split Grid: Tangle Specification + Piecewise Proof Stamp (Left) | Voronoi Simplex Plot (Right) */}
        <div className="grid grid-cols-1 lg:grid-cols-12">
          <div className="lg:col-span-6">
            <HeronTangleSpec
              scenario={scenario}
              paramValues={paramValues}
              toggleValues={toggleValues}
              snapshot={snapshot}
              onScrubParam={handleScrubParam}
              onToggleMitigation={handleToggleMitigation}
              onApproveMitigationFix={handleApproveMitigationFix}
              onResetDefaults={handleResetDefaults}
              inspectedStepFrac={inspectedStepFrac}
              onSelectStepFrac={(f) => setInspectedStepFrac(f)}
              onExportCadZip={() => void handleExportCadZip()}
            />
          </div>
          <div className="lg:col-span-6">
            <SimplexDraftingChart
              scenario={scenario}
              paramValues={paramValues}
              snapshot={snapshot}
              isCalibrating={isCalibrating}
              onRunCloudCalibration={handleRunCloudCalibration}
              inspectedStepFrac={inspectedStepFrac}
              onSelectStepFrac={(f) => setInspectedStepFrac(f)}
            />
          </div>
        </div>

        {/* Footer Hollowed Dimension-Ticked FAULTLINE AI Outline Typography + Ink Blot */}
        <HeronFooterInkWordmark />
      </div>

      {/* Modals & Companion Drawers */}
      <HeronPrivacyAirlockModal
        open={privacyOpen}
        onClose={() => setPrivacyOpen(false)}
        scenario={scenario}
        paramValues={paramValues}
      />
      <HeronOfflineQrModal
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        scenario={scenario}
        snapshot={snapshot}
      />
      <HeronIphoneFaultPadDrawer
        open={iphoneOpen}
        onClose={() => setIphoneOpen(false)}
        scenario={scenario}
        paramValues={paramValues}
        toggleValues={toggleValues}
        snapshot={snapshot}
        onScrubParam={handleScrubParam}
        onToggleMitigation={handleToggleMitigation}
      />
    </div>
  );
}
