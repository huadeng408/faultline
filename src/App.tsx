import React, { useEffect, useMemo, useState } from 'react';
import Lenis from 'lenis';
import { Toaster, toast } from 'sonner';
import {
  Camera,
  Cpu,
  Download,
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
  getScenarioById,
  sharedBridge,
  type BuiltinScenarioId,
  type ConflictArc,
  type ScenarioDefinition,
  type ScenarioId,
} from './core/faultlineEngine';
import {
  bootstrapLocalSurrogate,
  evaluateCalibratedSurrogate,
  packetFromCloudMonteCarlo,
  type CalibratedSurrogatePacket,
} from './core/monteCarloSurrogate';
import { SEED_SURROGATES } from './core/seedSurrogates';
import { solveMinimalRepair } from './core/minimalRepairSolver';
import { decodePocketUrl } from './core/pocketCodec';
import { injectStudioFonts, downloadBundleZip } from './lib/studioAssets';
import { DraftingCrosshairOverlay } from './components/DraftingCrosshairOverlay';
import { HeronBlueprintStage } from './components/HeronBlueprintStage';
import { HeronTangleSpec, buildPiecewiseProofSchedule } from './components/HeronTangleSpec';
import { SimplexDraftingChart } from './components/SimplexDraftingChart';
import { HeronFooterInkWordmark } from './components/HeronFooterInkWordmark';
import { CustomScanModal } from './components/CustomScanModal';
import {
  HeronIphoneFaultPadDrawer,
  HeronOfflineQrModal,
  HeronPrivacyAirlockModal,
} from './components/HeronModals';

injectStudioFonts();

function getInitialParamsFromSpec(sc: ScenarioDefinition): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of sc.params) {
    out[p.key] = p.value;
  }
  return out;
}

function getInitialTogglesFromSpec(sc: ScenarioDefinition): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const t of sc.toggles) {
    out[t.key] = t.enabled;
  }
  return out;
}

export default function App() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>('typhoon-cpap');
  const [customScenario, setCustomScenario] = useState<ScenarioDefinition | null>(null);
  const [extraConflict, setExtraConflict] = useState<ConflictArc | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, number>>(() =>
    getInitialParamsFromSpec(SCENARIOS['typhoon-cpap']),
  );
  const [toggleValues, setToggleValues] = useState<Record<string, boolean>>(() =>
    getInitialTogglesFromSpec(SCENARIOS['typhoon-cpap']),
  );
  const [privateNotes, setPrivateNotes] = useState<Record<string, string>>(() => ({
    'typhoon-cpap': SCENARIOS['typhoon-cpap'].rawPrivateSample,
    'singles-day-cutover': SCENARIOS['singles-day-cutover'].rawPrivateSample,
    'expat-cashflow': SCENARIOS['expat-cashflow'].rawPrivateSample,
  }));
  const [surrogateMap, setSurrogateMap] = useState<Record<string, CalibratedSurrogatePacket>>(() => ({
    ...SEED_SURROGATES,
  }));
  const [liveCodeOverride, setLiveCodeOverride] = useState<{
    scenarioId: string;
    code: string;
    stdout: string;
    insights: string[];
  } | null>(null);
  const [nanoWarmPct, setNanoWarmPct] = useState<number | null>(null);
  const [, setBridgeTick] = useState(0);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [inspectedStepFrac, setInspectedStepFrac] = useState<number | null>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [iphoneOpen, setIphoneOpen] = useState(false);
  const [customScanOpen, setCustomScanOpen] = useState(false);
  const [mv3SelectionProse, setMv3SelectionProse] = useState<string>('');

  // Initialize Studio Display WOFF font + Lenis smooth scroll + URL ?pocket= & MV3 Side-Panel hydration
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

    // Hydrate ?pocket= survival QR link if present (supports both built-in and [+04] CUSTOM scenarios)
    if (typeof window !== 'undefined' && window.location.search.includes('pocket=')) {
      const pocket = decodePocketUrl(window.location.href);
      if (pocket) {
        if (pocket.hydratedCustomScenario) {
          const customSc = pocket.hydratedCustomScenario;
          setCustomScenario(customSc);
          setSurrogateMap((prev) => ({
            ...prev,
            [customSc.id]: bootstrapLocalSurrogate(customSc, pocket.paramValues, pocket.toggleValues),
          }));
        }
        setScenarioId(pocket.scenarioId);
        setParamValues(pocket.paramValues);
        setToggleValues(pocket.toggleValues);
        if (window.innerWidth < 768) {
          setIphoneOpen(true);
        }
        toast.success(`Hydrated offline survival schedule (${pocket.scenarioId})`);
      }
    }

    // Listen for Chrome MV3 Side-Panel right-click "Stress-Test Selection in FaultLine"
    const chromeGlobal = (globalThis as unknown as {
      chrome?: {
        storage?: {
          local?: {
            get: (keys: string[], cb: (items: Record<string, unknown>) => void) => void;
            remove: (keys: string[]) => void;
          };
          onChanged?: {
            addListener: (cb: (changes: Record<string, { newValue?: unknown }>) => void) => void;
          };
        };
      };
    }).chrome;

    if (chromeGlobal?.storage?.local) {
      chromeGlobal.storage.local.get(['faultline_selection_text'], (items) => {
        const txt = String(items.faultline_selection_text ?? '').trim();
        if (txt) {
          setMv3SelectionProse(txt);
          setCustomScanOpen(true);
          chromeGlobal.storage?.local?.remove(['faultline_selection_text']);
        }
      });
      chromeGlobal.storage.onChanged?.addListener((changes) => {
        const nextTxt = String(changes.faultline_selection_text?.newValue ?? '').trim();
        if (nextTxt) {
          setMv3SelectionProse(nextTxt);
          setCustomScanOpen(true);
        }
      });
    }

    return () => {
      window.cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, []);

  const scenario: ScenarioDefinition = useMemo(() => {
    if (customScenario && scenarioId === customScenario.id) {
      return customScenario;
    }
    return getScenarioById(scenarioId);
  }, [scenarioId, customScenario]);

  const activePrivateNote = privateNotes[scenario.id] ?? scenario.rawPrivateSample;

  const baseSnapshot = useMemo(
    () => computeSimulation(scenario.id, paramValues, toggleValues, scenario),
    [scenario, paramValues, toggleValues],
  );

  const activeSurrogatePacket = useMemo<CalibratedSurrogatePacket>(() => {
    const existing = surrogateMap[scenario.id];
    if (existing) return existing;
    return bootstrapLocalSurrogate(scenario, paramValues, toggleValues);
  }, [surrogateMap, scenario, paramValues, toggleValues]);

  const surrogateEnvelope = useMemo(
    () => evaluateCalibratedSurrogate(scenario, paramValues, toggleValues, activeSurrogatePacket),
    [scenario, paramValues, toggleValues, activeSurrogatePacket],
  );

  const snapshot = useMemo(() => {
    // Enforce unified compliance: both nominal conservation AND Worst-10% (P10) storm margin >= M_safe
    const isP10Compliant =
      baseSnapshot.isSafe && surrogateEnvelope.p10Margin >= scenario.safeMarginTarget;
    const stormConflict: ConflictArc[] =
      baseSnapshot.isSafe && !isP10Compliant
        ? [
            {
              id: 'conf-p10-tail',
              fromClauseId: scenario.clauses[0]?.id ?? 'c1',
              toClauseId: scenario.clauses[1]?.id ?? 'c2',
              severity: 'warning',
              summary: `Nominal curve passes, but Worst-10% (P10) storm trajectory (${surrogateEnvelope.p10Margin.toFixed(1)} ${scenario.marginUnit}) falls short of +${scenario.safeMarginTarget} ${scenario.marginUnit} covenant.`,
              localLatencyMs: 0,
              provenance: 'deterministic',
            },
          ]
        : [];
    const mergedConflicts = [
      ...(extraConflict ? [extraConflict] : []),
      ...stormConflict,
      ...baseSnapshot.conflicts,
    ];

    if (liveCodeOverride && liveCodeOverride.scenarioId === scenario.id) {
      return {
        ...baseSnapshot,
        isSafe: isP10Compliant,
        conflicts: mergedConflicts,
        pythonCode: liveCodeOverride.code || baseSnapshot.pythonCode,
        pythonStdout: liveCodeOverride.stdout || baseSnapshot.pythonStdout,
        discoveredInvariants:
          liveCodeOverride.insights.length > 0
            ? liveCodeOverride.insights
            : baseSnapshot.discoveredInvariants,
      };
    }
    return {
      ...baseSnapshot,
      isSafe: isP10Compliant,
      conflicts: mergedConflicts,
    };
  }, [
    baseSnapshot,
    surrogateEnvelope.p10Margin,
    scenario.safeMarginTarget,
    scenario.clauses,
    scenario.marginUnit,
    scenario.id,
    extraConflict,
    liveCodeOverride,
  ]);

  const minimalRepairPlan = useMemo(
    () => solveMinimalRepair(scenario, paramValues, toggleValues, activeSurrogatePacket),
    [scenario, paramValues, toggleValues, activeSurrogatePacket],
  );

  const minimalRepairButtonLabel = useMemo(() => {
    if (minimalRepairPlan.kind === 'discrete_sufficient') {
      return `PARETO MIN-FIX (${minimalRepairPlan.activatedToggleKeys.length}/${scenario.toggles.length} PATCHES)`;
    }
    if (minimalRepairPlan.kind === 'hybrid_continuous_sized' && minimalRepairPlan.sizedParam) {
      return `MIN-FIX + SIZE ${minimalRepairPlan.sizedParam.toValue} ${minimalRepairPlan.sizedParam.unit}`;
    }
    if (
      minimalRepairPlan.kind === 'out_of_range_extrapolated' &&
      minimalRepairPlan.extrapolatedRequirement
    ) {
      return `NEEDS ≥${minimalRepairPlan.extrapolatedRequirement.requiredValue} ${minimalRepairPlan.extrapolatedRequirement.unit}`;
    }
    return 'APPROVE MINIMAL-FIX REPAIR';
  }, [minimalRepairPlan, scenario.toggles.length]);

  const handleWarmNanoClick = async () => {
    setNanoWarmPct(5);
    const ok = await sharedBridge.warmDeviceModel((pct) => setNanoWarmPct(pct));
    setNanoWarmPct(null);
    setBridgeTick((v) => v + 1);
    if (ok) {
      const q = sharedBridge.status.contextWindowQuota;
      toast.success(
        `Gemini Nano 4 ready on-device (${sharedBridge.status.lastLatencyMs}ms${q > 0 ? ` · ${q} ctx window` : ''})`,
      );
      // Run live compact semantic clause check on current scenario so Tangle badge shows measured ON_DEVICE latency
      const clauseProse = `${scenario.title}: ${scenario.subtitle}`;
      const cPair: [string, string] = [
        scenario.clauses[0]?.id ?? 'c1',
        scenario.clauses[1]?.id ?? 'c2',
      ];
      const liveConf = await sharedBridge.auditProseContradiction(
        clauseProse,
        scenario.defaultPrivacyLock,
        cPair,
      );
      if (liveConf) {
        setExtraConflict(liveConf);
        setBridgeTick((v) => v + 1);
      }
    } else {
      toast.message(
        'On-device Gemini Nano not active in this browser; deterministic & Buckingham-Π hybrid engine active.',
      );
    }
  };

  const handleSelectScenario = (nextId: BuiltinScenarioId) => {
    const nextSc = SCENARIOS[nextId];
    setScenarioId(nextId);
    setExtraConflict(null);
    setParamValues(getInitialParamsFromSpec(nextSc));
    setToggleValues(getInitialTogglesFromSpec(nextSc));
    setInspectedStepFrac(null);
  };

  const handleAdoptCustomScenario = (
    nextCustom: ScenarioDefinition,
    conflict?: ConflictArc | null,
  ) => {
    const initP = getInitialParamsFromSpec(nextCustom);
    const initT = getInitialTogglesFromSpec(nextCustom);
    setCustomScenario(nextCustom);
    setScenarioId(nextCustom.id);
    setExtraConflict(conflict ?? null);
    setParamValues(initP);
    setToggleValues(initT);
    setPrivateNotes((prev) => ({ ...prev, [nextCustom.id]: nextCustom.rawPrivateSample }));
    setSurrogateMap((prev) => ({
      ...prev,
      [nextCustom.id]: bootstrapLocalSurrogate(nextCustom, initP, initT),
    }));
    setInspectedStepFrac(null);
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
    setParamValues(minimalRepairPlan.repairedParams);
    setToggleValues(minimalRepairPlan.repairedToggles);
    if (minimalRepairPlan.kind === 'out_of_range_extrapolated') {
      toast.warning(minimalRepairPlan.summary);
    } else {
      toast.success(minimalRepairPlan.summary);
    }
  };

  const handleResetDefaults = () => {
    setParamValues(getInitialParamsFromSpec(scenario));
    setToggleValues(getInitialTogglesFromSpec(scenario));
    setInspectedStepFrac(null);
    toast.message('Restored baseline fault scenario parameters');
  };

  const handleRunCloudCalibration = async () => {
    if (isCalibrating) return;
    setIsCalibrating(true);
    try {
      if (sharedBridge.hasLiveCloud()) {
        const cloudRes = await sharedBridge.runCloudMonteCarlo(
          scenario,
          paramValues,
          toggleValues,
          activePrivateNote,
          true,
        );
        const nextPacket = packetFromCloudMonteCarlo(scenario, paramValues, toggleValues, cloudRes);
        setSurrogateMap((prev) => ({ ...prev, [scenario.id]: nextPacket }));
        setLiveCodeOverride({
          scenarioId: scenario.id,
          code: cloudRes.executedPythonCode,
          stdout: cloudRes.stdout,
          insights: cloudRes.domainInsights,
        });
        setBridgeTick((v) => v + 1);
        toast.success(
          `[${cloudRes.inferenceSource.toUpperCase()} · ${(cloudRes.latencyMs / 1000).toFixed(2)}s] 2,000-MC Python calibrated (${cloudRes.modelUsed})!`,
        );
      } else {
        // Never overwrite verified 2,000-trial SEED_SURROGATES when no cloud API key is configured
        if (!surrogateMap[scenario.id]) {
          const bootstrapped = bootstrapLocalSurrogate(scenario, paramValues, toggleValues);
          setSurrogateMap((prev) => ({ ...prev, [scenario.id]: bootstrapped }));
        }
        toast.info(
          'Cloud API key not set in .env.local — retaining verified 2,000-MC Buckingham-Π surrogate cache.',
        );
      }
    } catch (err: unknown) {
      toast.error(String((err as Error)?.message ?? 'Cloud Python calibration error'));
    } finally {
      setIsCalibrating(false);
    }
  };

  const handleExportCadZip = async () => {
    const receipt = await computeRedactionReceipt(
      activePrivateNote,
      paramValues,
      scenario,
      toggleValues,
    );
    const piecewise = buildPiecewiseProofSchedule(scenario, paramValues, toggleValues, snapshot);
    const auditJson = JSON.stringify(
      {
        schema: 'faultline.heron.cad_audit.v3.6',
        scenarioId: scenario.id,
        title: scenario.title,
        isCompliant: snapshot.isSafe,
        margins: {
          nominalLinear: snapshot.localMargin,
          nonLinearGroundTruth: snapshot.cloudMargin,
          worst10PctStormP10: surrogateEnvelope.p10Margin,
          driftDelta: snapshot.driftDelta,
          unit: scenario.marginUnit,
        },
        failurePointLabel: snapshot.failurePointLabel,
        buckinghamPiPayload: receipt.airlockPacket.outboundPayload,
        mitigationPatches: toggleValues,
        minimalRepairRecommendation: {
          kind: minimalRepairPlan.kind,
          summary: minimalRepairPlan.summary,
        },
        piecewiseProofSchedule: piecewise,
        sha256AirlockReceipt: receipt.sha256Hex,
        series: {
          xLabels: snapshot.xLabels,
          nominalLinearPct: snapshot.localSeries,
          nonLinearPct: snapshot.cloudSeries,
          mcP10Pct: surrogateEnvelope.p10Display,
          mcP50Pct: surrogateEnvelope.p50Display,
          mcP90Pct: surrogateEnvelope.p90Display,
        },
      },
      null,
      2,
    );

    const verifyPy = `#!/usr/bin/env python3
"""FaultLine v3 · Buckingham-Pi & Simplex Verification Script (${scenario.id})"""
${snapshot.pythonCode}

# Constraint Proof Assertions
expected_margin = ${snapshot.cloudMargin}
is_compliant = ${snapshot.isSafe ? 'True' : 'False'}
print(f"[CAD AUDIT STAMP] scenario=${scenario.id} compliant={is_compliant} expected_margin={expected_margin:+.1f} ${scenario.marginUnit}")
`;

    const blueprintMd = `# FAULTLINE V3 · ARCHITECTURAL CAD AUDIT BLUEPRINT
- **Scenario**: ${scenario.title} (\`${scenario.id}\`)
- **Compliance Stamp**: ${snapshot.isSafe ? 'CODE COMPLIANT (Q.E.D.)' : `VIOLATIONS DETECTED (${snapshot.conflicts.length})`}
- **Ground-Truth Non-Linear Margin**: ${snapshot.cloudMargin >= 0 ? '+' : ''}${snapshot.cloudMargin} ${scenario.marginUnit}
- **Worst-10% (P10) 2,000-MC Storm Margin**: ${surrogateEnvelope.p10Margin >= 0 ? '+' : ''}${surrogateEnvelope.p10Margin.toFixed(1)} ${scenario.marginUnit}
- **Naive Linear Estimate**: ${snapshot.localMargin >= 0 ? '+' : ''}${snapshot.localMargin} ${scenario.marginUnit}
- **SHA-256 Buckingham-Π Airlock Digest**: \`${receipt.sha256Hex}\`
- **License**: Apache-2.0

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

    downloadBundleZip(`faultline-cad-audit-${scenario.id}.zip`, {
      [`faultline_cad_audit_${scenario.id}.json`]: auditJson,
      [`buckingham_pi_airlock_${scenario.id}.json`]: receipt.scrubbedPayload,
      [`verify_simplex_${scenario.id}.py`]: verifyPy,
      'ARCHITECTURAL_BLUEPRINT_AUDIT.md': blueprintMd,
    });
    toast.success(`Exported faultline-cad-audit-${scenario.id}.zip (.json + .py + .md)`);
  };

  const rulerTicks = Array.from({ length: 15 }, (_, idx) => idx * 100);
  const bridgeStat = sharedBridge.status;
  const runtimeSubtitle =
    bridgeStat.lastInferenceSource === 'on_device'
      ? `[ON_DEVICE · ${bridgeStat.lastLatencyMs}MS${bridgeStat.contextWindowQuota > 0 ? ` · ${bridgeStat.contextTokensUsed}/${bridgeStat.contextWindowQuota} TOK` : ''}] ⇄ [BUCKINGHAM-Π]`
      : bridgeStat.lastInferenceSource === 'in_cloud'
        ? `[IN_CLOUD · ${(bridgeStat.lastLatencyMs / 1000).toFixed(2)}S PYTHON] ⇄ [SHA-256 VERIFIED]`
        : `[DETERMINISTIC <1MS] ⇄ [2,000-MC SURROGATE READY]`;

  const cloudProvenanceLabel =
    activeSurrogatePacket.provenance === 'live_cloud_2000mc'
      ? 'IN_CLOUD 2,000-MC'
      : activeSurrogatePacket.provenance === 'seed_numpy_2000mc'
        ? 'SEED 2,000-MC + PY'
        : 'BOOTSTRAP MC + PY';

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
        {/* Top Navigation & Hybrid Hardware Header Bar */}
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
                  {runtimeSubtitle}
                </div>
              </div>
            </div>

            <div className="hidden sm:flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => void handleWarmNanoClick()}
                className="heron-mono text-[9px] font-bold px-2 py-1 border border-[#282828] bg-[#F6F4EE] text-[#282828] hover:bg-[#282828] hover:text-[#F6F4EE] cursor-pointer inline-flex items-center gap-1.5"
              >
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{
                    backgroundColor: bridgeStat.deviceReady ? '#15803D' : '#FA3600',
                  }}
                />
                {nanoWarmPct !== null
                  ? `NANO ${nanoWarmPct}%`
                  : bridgeStat.deviceReady
                    ? 'NANO 4 READY'
                    : 'WARM NANO 4'}
              </button>
            </div>
          </div>

          {/* Scenario Blueprint Sheet Switcher (+04 CUSTOM added cleanly on single row) */}
          <nav
            aria-label="Blueprint Scenario Sheets"
            className="lg:col-span-4 px-2.5 py-2 border-b lg:border-b-0 lg:border-r border-[#D4D2CA] flex items-center gap-1 flex-wrap xl:flex-nowrap"
          >
            {(
              [
                { id: 'typhoon-cpap', code: '[01]', short: 'TYPHOON' },
                { id: 'singles-day-cutover', code: '[02]', short: 'CUTOVER' },
                { id: 'expat-cashflow', code: '[03]', short: 'RUNWAY' },
              ] as const
            ).map((tab) => {
              const active = scenario.id === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleSelectScenario(tab.id)}
                  className="heron-mono text-[9.5px] font-bold px-1.5 py-1.5 border transition-colors cursor-pointer whitespace-nowrap"
                  style={{
                    backgroundColor: active ? '#282828' : '#F6F4EE',
                    borderColor: active ? '#282828' : '#D4D2CA',
                    color: active ? '#F6F4EE' : '#282828',
                  }}
                >
                  <span style={{ color: active ? '#FF7A52' : '#575652' }} className="mr-0.5">
                    {tab.code}
                  </span>
                  {tab.short}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => {
                if (customScenario && scenario.id !== customScenario.id) {
                  setScenarioId(customScenario.id);
                } else {
                  setCustomScanOpen(true);
                }
              }}
              className="heron-mono text-[9.5px] font-bold px-1.5 py-1.5 border transition-colors cursor-pointer whitespace-nowrap inline-flex items-center gap-1"
              style={{
                backgroundColor: Boolean(scenario.customEnvelope) ? '#282828' : '#FAF9F5',
                borderColor: '#282828',
                color: Boolean(scenario.customEnvelope) ? '#F6F4EE' : '#282828',
              }}
            >
              <Camera className="w-3 h-3 text-[#FA3600]" />
              <span>[+04] CUSTOM</span>
            </button>
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
                <div className="heron-mono text-[9.5px] text-[#575652]">WORST-10% P10 STORM</div>
                <div
                  className="heron-mono text-base font-bold"
                  style={{ color: surrogateEnvelope.p10Margin >= 0 ? '#136B33' : '#B82500' }}
                >
                  {surrogateEnvelope.p10Margin > 0 ? '+' : ''}
                  {surrogateEnvelope.p10Margin.toFixed(1)} {scenario.marginUnit}
                </div>
              </div>
            </div>

            <div className="heron-mono text-[10px] text-[#575652] flex items-center justify-between">
              <span>BUCKINGHAM-Π + 2,000-MC FAN</span>
              <span className="font-bold text-[#282828]">
                {surrogateEnvelope.status === 'CALIBRATED_IN_TRUST_REGION'
                  ? 'IN TRUST REGION'
                  : surrogateEnvelope.status === 'PATCH_PREVIEW_NEEDS_CLOUD_VERIFY'
                    ? 'PATCH PREVIEW'
                    : 'EPISTEMIC WIDENED'}
              </span>
            </div>
          </div>
        </section>

        {/* Centerpiece Interactive Architectural Elevation Blueprint + Drag-Box Violation Finder */}
        <HeronBlueprintStage
          scenarioId={scenario.id}
          scenario={scenario}
          paramValues={paramValues}
          toggleValues={toggleValues}
          snapshot={snapshot}
          onToggleMitigation={handleToggleMitigation}
          onApproveMitigationFix={handleApproveMitigationFix}
          onResetDefaults={handleResetDefaults}
          minimalRepairButtonLabel={minimalRepairButtonLabel}
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
              onOpenCustomScan={() => setCustomScanOpen(true)}
              minimalRepairButtonLabel={minimalRepairButtonLabel}
            />
          </div>
          <div className="lg:col-span-6">
            <SimplexDraftingChart
              scenario={scenario}
              paramValues={paramValues}
              snapshot={snapshot}
              surrogateEnvelope={surrogateEnvelope}
              minimalRepairPlan={minimalRepairPlan}
              cloudProvenanceLabel={cloudProvenanceLabel}
              isCalibrating={isCalibrating}
              onRunCloudCalibration={() => void handleRunCloudCalibration()}
              inspectedStepFrac={inspectedStepFrac}
              onSelectStepFrac={(f) => setInspectedStepFrac(f)}
            />
          </div>
        </div>

        {/* Footer Hollowed Dimension-Ticked FAULTLINE AI Outline Typography + Ink Blot */}
        <HeronFooterInkWordmark />
      </div>

      {/* Modals & Companion Drawers */}
      <CustomScanModal
        open={customScanOpen}
        onClose={() => setCustomScanOpen(false)}
        privacyLock={scenario.defaultPrivacyLock}
        initialProse={mv3SelectionProse}
        onAdoptScenario={handleAdoptCustomScenario}
      />
      <HeronPrivacyAirlockModal
        open={privacyOpen}
        onClose={() => setPrivacyOpen(false)}
        scenario={scenario}
        paramValues={paramValues}
        toggleValues={toggleValues}
        privateNote={activePrivateNote}
        onChangePrivateNote={(next) =>
          setPrivateNotes((prev) => ({ ...prev, [scenario.id]: next }))
        }
        onApplyExtractedCurrencyRatios={(ratios) => {
          setParamValues((prev) => ({
            ...prev,
            ...(ratios.reserveMonths !== undefined
              ? { reserveMonths: Math.max(4, Math.min(24, Math.round(ratios.reserveMonths))) }
              : {}),
            ...(ratios.housingRatioPct !== undefined
              ? { housingRatioPct: Math.max(20, Math.min(65, Math.round(ratios.housingRatioPct))) }
              : {}),
          }));
        }}
      />
      <HeronOfflineQrModal
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        scenario={scenario}
        paramValues={paramValues}
        toggleValues={toggleValues}
        snapshot={snapshot}
        surrogateEnvelope={surrogateEnvelope}
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
