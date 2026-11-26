import React, { useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import { CheckCircle2, Crosshair, ScanSearch, Sparkles, AlertOctagon } from 'lucide-react';
import type { ScenarioDefinition, ScenarioId, SimulationSnapshot } from '../core/faultlineEngine';

interface BlueprintHotspot {
  id: string;
  codeTag: string;
  clausePair: string;
  zoneLabel: string;
  cx: number;
  cy: number;
  side: 'left' | 'right';
  slotIdx: number;
  activeWhenUnsafe: boolean;
  title: string;
  detail: string;
  toggleKey: string;
  fixActionLabel: string;
}

interface MarqueeRect {
  startX: number;
  startY: number;
  curX: number;
  curY: number;
}

interface HeronBlueprintStageProps {
  scenarioId: ScenarioId;
  scenario: ScenarioDefinition;
  paramValues: Record<string, number>;
  toggleValues: Record<string, boolean>;
  snapshot: SimulationSnapshot;
  onToggleMitigation: (key: string, nextVal: boolean) => void;
  onApproveMitigationFix: () => void;
  onResetDefaults: () => void;
}

const SVG_W = 1240;
const SVG_H = 380;

export const HeronBlueprintStage: React.FC<HeronBlueprintStageProps> = ({
  scenarioId,
  scenario,
  paramValues,
  toggleValues,
  snapshot,
  onToggleMitigation,
  onApproveMitigationFix,
  onResetDefaults,
}) => {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const maskCircleRef = useRef<SVGCircleElement | null>(null);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const [auditedIds, setAuditedIds] = useState<string[]>(['hs-1', 'hs-2']);
  const [inkProgress, setInkProgress] = useState<number>(snapshot.isSafe ? 1 : 0);

  useEffect(() => {
    setAuditedIds(['hs-1', 'hs-2']);
    setMarquee(null);
  }, [scenarioId]);

  useEffect(() => {
    const circle = maskCircleRef.current;
    if (!circle) return;
    const targetR = snapshot.isSafe ? 1280 : 0;
    gsap.killTweensOf(circle);
    const proxy = { r: Number(circle.getAttribute('r') || 0) };
    gsap.to(proxy, {
      r: targetR,
      duration: snapshot.isSafe ? 1.15 : 0.55,
      ease: snapshot.isSafe ? 'power3.out' : 'power2.inOut',
      onUpdate: () => {
        circle.setAttribute('r', proxy.r.toFixed(1));
        setInkProgress(Math.min(1, proxy.r / 1150));
      },
    });
  }, [snapshot.isSafe]);

  const hotspots = useMemo<BlueprintHotspot[]>(() => {
    if (scenarioId === 'typhoon-cpap') {
      const bat = paramValues.batteryWh ?? 1024;
      const hrs = paramValues.outageHours ?? 36;
      const cpap = paramValues.cpapWatts ?? 38;
      const tare = paramValues.inverterTareW ?? 14;
      const cooler = paramValues.coolerWatts ?? 24;
      return [
        {
          id: 'hs-1',
          codeTag: 'VIO-01',
          clausePair: 'CLAUSE §1↔§2',
          zoneLabel: '2F BEDROOM · CPAP HUMIDIFIER',
          cx: 536,
          cy: 138,
          side: 'left',
          slotIdx: 0,
          activeWhenUnsafe: !toggleValues.disableHumidifier,
          title: `CPAP HEATED TUBE +26W BREACHES ${hrs}H ENVELOPE`,
          detail: `${cpap}W blower + 26W heated hose drains ${bat}Wh LiFePO4 pack ${Math.abs(
            snapshot.cloudMargin,
          ).toFixed(1)}h early.`,
          toggleKey: 'disableHumidifier',
          fixActionLabel: toggleValues.disableHumidifier ? 'PASSIVE HME ENGAGED' : 'DISABLE HEATED TUBE',
        },
        {
          id: 'hs-2',
          codeTag: 'VIO-02',
          clausePair: 'CLAUSE §1↔§3',
          zoneLabel: '1F CONDUIT · AC INVERTER TARE',
          cx: 678,
          cy: 236,
          side: 'right',
          slotIdx: 0,
          activeWhenUnsafe: !toggleValues.dcDirectMode && tare >= 8,
          title: `${tare}W AC INVERTER TARE BURNS ${Math.round(((tare * hrs) / bat) * 100)}% PACK`,
          detail: `Pure-sine 110V stage wastes ${Math.round(tare * hrs)}Wh across ${hrs}h even while loads idle.`,
          toggleKey: 'dcDirectMode',
          fixActionLabel: toggleValues.dcDirectMode ? '24V DC RAIL ENGAGED' : 'SWITCH TO DC BUCK RAIL',
        },
        {
          id: 'hs-3',
          codeTag: 'VIO-03',
          clausePair: 'CLAUSE §3 · THERMAL',
          zoneLabel: '1F KITCHEN · 2–8°C COOLER',
          cx: 848,
          cy: 242,
          side: 'right',
          slotIdx: 1,
          activeWhenUnsafe: !toggleValues.preChillPacks,
          title: `29°C AMBIENT SPIKES ${cooler}W COOLER DUTY +18%`,
          detail: `Afternoon thermal drift accelerates compressor cycling without phase-change ice buffer.`,
          toggleKey: 'preChillPacks',
          fixActionLabel: toggleValues.preChillPacks ? 'PCM BRICKS PRE-CHILLED' : 'ENGAGE PCM ICE BUFFER',
        },
      ];
    }

    if (scenarioId === 'singles-day-cutover') {
      const rps = paramValues.rps ?? 5200;
      const retries = paramValues.retries ?? 3;
      const timeoutMs = paramValues.timeoutMs ?? 2000;
      const pool = paramValues.dbPoolMax ?? 480;
      const rtt = paramValues.crossRegionRttMs ?? 68;
      return [
        {
          id: 'hs-1',
          codeTag: 'SRE-01',
          clausePair: 'CLAUSE §1↔§2',
          zoneLabel: 'EDGE GATEWAY · RETRY AMPLIFIER',
          cx: 484,
          cy: 134,
          side: 'left',
          slotIdx: 0,
          activeWhenUnsafe: !toggleValues.tokenBucketRetry && retries >= 2,
          title: `${retries}X SYNC RETRIES MULTIPLY ${rps} RPS INTO STORM`,
          detail: `${timeoutMs}ms gateway timeout triggers ${Math.round(
            rps * (1 + retries * 0.46),
          )} req/s surge during drain.`,
          toggleKey: 'tokenBucketRetry',
          fixActionLabel: toggleValues.tokenBucketRetry ? 'RETRY TOKEN BUCKET ON' : 'CAP RETRIES <= 10%',
        },
        {
          id: 'hs-2',
          codeTag: 'SRE-02',
          clausePair: 'CLAUSE §2↔§3',
          zoneLabel: 'CORE VAULT · PGBOUNCER CEILING',
          cx: 876,
          cy: 142,
          side: 'right',
          slotIdx: 0,
          activeWhenUnsafe: !toggleValues.circuitBreaker,
          title: `PGBOUNCER ${pool} CONNS COLLAPSE AT +${rtt}MS RTT`,
          detail: `Kingman 1/(1-ρ) wait queue explodes past 85% pool saturation without P99 shedding.`,
          toggleKey: 'circuitBreaker',
          fixActionLabel: toggleValues.circuitBreaker ? 'P99 SHEDDING ENGAGED' : 'TRIP 250MS BREAKER',
        },
        {
          id: 'hs-3',
          codeTag: 'SRE-03',
          clausePair: 'CLAUSE §3 · WAL LOCK',
          zoneLabel: 'CROSS-REGION AUDIT WRITE PATH',
          cx: 678,
          cy: 256,
          side: 'right',
          slotIdx: 1,
          activeWhenUnsafe: !toggleValues.asyncOutbox,
          title: `SYNC AUDIT INSERT ADDS +24MS TX LOCK HOLD`,
          detail: `Two-phase cross-region audit write pins ledger connections on critical checkout path.`,
          toggleKey: 'asyncOutbox',
          fixActionLabel: toggleValues.asyncOutbox ? 'ASYNC OUTBOX ACTIVE' : 'DEFER TO ASYNC OUTBOX',
        },
      ];
    }

    const resMos = paramValues.reserveMonths ?? 11;
    const housing = paramValues.housingRatioPct ?? 42;
    const fx = paramValues.fxShockPct ?? 16;
    const bps = paramValues.rateHikeBps ?? 225;
    const lag = paramValues.relocOneOffMos ?? 3.5;
    return [
      {
        id: 'hs-1',
        codeTag: 'FIN-01',
        clausePair: 'CLAUSE §1↔§2',
        zoneLabel: 'MONTH-02 · RELOCATION TAX LOCKUP',
        cx: 504,
        cy: 132,
        side: 'left',
        slotIdx: 0,
        activeWhenUnsafe: !toggleValues.staggerMove,
        title: `${lag} MOS DEPOSIT + DUAL-TAX LAG DROPS BUFFER`,
        detail: `Upfront key-money & withholding cut ${resMos}-mo liquid reserve to ${(resMos - lag).toFixed(
          1,
        )} mos at M2.`,
        toggleKey: 'staggerMove',
        fixActionLabel: toggleValues.staggerMove ? '45D STAGGER ENGAGED' : 'STAGGER LEASE 45 DAYS',
      },
      {
        id: 'hs-2',
        codeTag: 'FIN-02',
        clausePair: 'CLAUSE §2↔§3',
        zoneLabel: 'FX BRIDGE · UNHEDGED CURRENCY SLIDE',
        cx: 696,
        cy: 138,
        side: 'right',
        slotIdx: 0,
        activeWhenUnsafe: !toggleValues.fxForwardCap,
        title: `-${fx}% FX SHOCK BREACHES 3.0-MO COVENANT FLOOR`,
        detail: `Destination obligations compound against unhedged home-currency payroll inflow.`,
        toggleKey: 'fxForwardCap',
        fixActionLabel: toggleValues.fxForwardCap ? '60% FX CORRIDOR LOCKED' : 'LOCK 60% FX FORWARD',
      },
      {
        id: 'hs-3',
        codeTag: 'FIN-03',
        clausePair: 'CLAUSE §2↔§3',
        zoneLabel: 'DEBT SLAB · FLOATING RESET EXPOSURE',
        cx: 882,
        cy: 138,
        side: 'right',
        slotIdx: 1,
        activeWhenUnsafe: !toggleValues.rateCapClause,
        title: `${housing}% HOUSING RATIO × +${bps}BPS RESET DRAG`,
        detail: `Uncapped floating debt service erodes emergency runway after Month 6 reset.`,
        toggleKey: 'rateCapClause',
        fixActionLabel: toggleValues.rateCapClause ? '3YR FIXED CAP ACTIVE' : 'CAP RATE AT +75BPS',
      },
    ];
  }, [scenarioId, paramValues, toggleValues, snapshot.cloudMargin]);

  const checkIntersections = (rect: MarqueeRect, containerRect: DOMRect) => {
    const x1 = Math.min(rect.startX, rect.curX);
    const x2 = Math.max(rect.startX, rect.curX);
    const y1 = Math.min(rect.startY, rect.curY);
    const y2 = Math.max(rect.startY, rect.curY);

    const hits: string[] = [];
    for (const hs of hotspots) {
      const px = (hs.cx / SVG_W) * containerRect.width;
      const py = (hs.cy / SVG_H) * containerRect.height;
      if (px >= x1 - 24 && px <= x2 + 24 && py >= y1 - 24 && py <= y2 + 24) {
        hits.push(hs.id);
      }
    }
    if (hits.length > 0) {
      setAuditedIds((prev) => Array.from(new Set([...prev, ...hits])));
    }
  };

  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const nextMarquee = { startX: x, startY: y, curX: x, curY: y };
    setMarquee(nextMarquee);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!marquee || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const curX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const curY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const updated = { ...marquee, curX, curY };
    setMarquee(updated);
    if (Math.hypot(curX - marquee.startX, curY - marquee.startY) > 8) {
      checkIntersections(updated, rect);
    }
  };

  const handleStagePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!marquee) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Safe fallback
    }
    setMarquee(null);
  };

  const toggleHotspotInspect = (id: string) => {
    setAuditedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const getMarqueeStyle = (m: MarqueeRect): React.CSSProperties => {
    const left = Math.min(m.startX, m.curX);
    const top = Math.min(m.startY, m.curY);
    const width = Math.max(2, Math.abs(m.curX - m.startX));
    const height = Math.max(2, Math.abs(m.curY - m.startY));
    const dx = m.curX - m.startX;
    const dy = m.curY - m.startY;
    const angleDeg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI + 90);
    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
      border: '1.5px solid #FA3600',
      background: `linear-gradient(${angleDeg}deg, rgba(250, 54, 0, 0.03) 0%, rgba(250, 54, 0, 0.14) 55%, rgba(250, 54, 0, 0.34) 100%)`,
      boxShadow: 'inset 0 0 0 1px rgba(250,54,0,0.18)',
    };
  };

  const sheetIndex =
    scenarioId === 'typhoon-cpap' ? '01/03' : scenarioId === 'singles-day-cutover' ? '02/03' : '03/03';

  return (
    <section
      aria-label="Architectural Elevation Constraint Blueprint"
      className="border-b border-[#D4D2CA] bg-[#F6F4EE] flex flex-col"
    >
      {/* Top Blueprint Toolbar Strip */}
      <div className="px-4 py-2 border-b border-[#D4D2CA] bg-[#EFECE4] flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="heron-mono text-[10.5px] font-bold px-2 py-0.5 bg-[#282828] text-[#F6F4EE]">
            [SHEET {sheetIndex}]
          </span>
          <span className="heron-mono text-[10.5px] font-semibold text-[#282828] flex items-center gap-1.5">
            <Crosshair className="w-3.5 h-3.5 text-[#FA3600]" />
            [DRAG SELECTION BOX TO AUDIT]
          </span>
          <span className="heron-mono text-[10px] text-[#575652] hidden sm:inline">
            OR CLICK ANY PULSING NODE ON ELEVATION
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setAuditedIds(hotspots.map((h) => h.id))}
            className="heron-mono text-[10px] font-semibold px-2.5 py-1 border border-[#282828] bg-[#F6F4EE] text-[#282828] hover:bg-[#282828] hover:text-[#F6F4EE] transition-colors cursor-pointer flex items-center gap-1"
          >
            <ScanSearch className="w-3 h-3" />
            [AUDIT ALL {hotspots.length} ZONES]
          </button>

          {!snapshot.isSafe ? (
            <button
              type="button"
              onClick={onApproveMitigationFix}
              className="heron-mono text-[10px] font-bold px-3 py-1 bg-[#282828] text-[#F6F4EE] border border-[#282828] hover:bg-[#FA3600] hover:border-[#FA3600] transition-colors cursor-pointer flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5 text-[#FA3600]" />
              APPROVE MITIGATION FIX
            </button>
          ) : (
            <button
              type="button"
              onClick={onResetDefaults}
              className="heron-mono text-[10px] font-bold px-3 py-1 bg-[#15803D] text-[#FFFFFF] border border-[#15803D] hover:opacity-90 transition-opacity cursor-pointer flex items-center gap-1.5"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              STAMPED SAFE · RESET FAULTS
            </button>
          )}
        </div>
      </div>

      {/* Interactive Blueprint Stage Container (Wide 1240x380 Cinematic Sheet Ratio) */}
      <div
        ref={stageRef}
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={handleStagePointerUp}
        onPointerCancel={handleStagePointerUp}
        className="relative heron-blueprint-grid select-none cursor-crosshair overflow-hidden"
      >
        <span className="heron-mono text-xs text-[#72726F] absolute top-1.5 left-2 pointer-events-none">+</span>
        <span className="heron-mono text-xs text-[#72726F] absolute top-1.5 right-2 pointer-events-none">+</span>
        <span className="heron-mono text-xs text-[#72726F] absolute bottom-1.5 left-2 pointer-events-none">+</span>
        <span className="heron-mono text-xs text-[#72726F] absolute bottom-1.5 right-2 pointer-events-none">+</span>

        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          className="w-full h-auto block"
          role="img"
          aria-label={`${scenario.title} Architectural Schematic`}
        >
          <defs>
            <filter id="heron-ink-seep-filter" x="-20%" y="-20%" width="140%" height="140%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.028"
                numOctaves="4"
                seed="11"
                result="noise"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="noise"
                scale="68"
                xChannelSelector="R"
                yChannelSelector="G"
                result="displaced"
              />
              <feColorMatrix
                in="displaced"
                type="matrix"
                values="1 0 0 0 0
                        0 1 0 0 0
                        0 0 1 0 0
                        0 0 0 18 -7"
              />
            </filter>

            <mask id="heron-ink-seep-mask">
              <rect x="0" y="0" width={SVG_W} height={SVG_H} fill="black" />
              <circle
                ref={maskCircleRef}
                cx="620"
                cy="200"
                r={snapshot.isSafe ? 1280 : 0}
                fill="white"
                filter="url(#heron-ink-seep-filter)"
              />
            </mask>

            <pattern id="heron-hatch" width="8" height="8" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="0" y2="8" stroke="#D4D2CA" strokeWidth="1" />
            </pattern>
          </defs>

          {/* Center Architectural Dimension Header (Strictly within x=330..910 so side callout margins stay 100% clear) */}
          <g stroke="#72726F" strokeWidth="0.9" fill="none">
            <line x1="340" y1="26" x2="900" y2="26" />
            <line x1="340" y1="20" x2="340" y2="32" />
            <line x1="900" y1="20" x2="900" y2="32" />
            <text
              x="620"
              y="19"
              textAnchor="middle"
              fill="#282828"
              fontSize="10"
              fontWeight="700"
              className="heron-mono"
            >
              {scenarioId === 'typhoon-cpap'
                ? 'SECTION A—A\u2032 · 8,400 MM RESIDENTIAL POWER ELEVATION'
                : scenarioId === 'singles-day-cutover'
                  ? 'SECTION B—B\u2032 · MULTI-REGION PAYMENT DRAIN & PGBOUNCER'
                  : 'SECTION C—C\u2032 · PRIVACY-LOCKED CROSS-BORDER COVENANT SLAB'}
            </text>
          </g>

          {/* Architectural Leader Lines from Hotspots to Left/Right Margin Callout Docks */}
          <g className="hidden lg:block" stroke="#A8A59B" strokeWidth="1" strokeDasharray="3 3" fill="none">
            {hotspots
              .filter((hs) => auditedIds.includes(hs.id))
              .map((hs) => {
                const targetX = hs.side === 'left' ? 302 : 938;
                const targetY = hs.slotIdx === 0 ? 84 : 254;
                return (
                  <path
                    key={`leader-${hs.id}`}
                    d={`M ${hs.cx} ${hs.cy} L ${(hs.cx + targetX) / 2} ${targetY} L ${targetX} ${targetY}`}
                  />
                );
              })}
          </g>

          {/* SCENARIO 1: Centered 2-Story Typhoon Blackout House Elevation (x=335..895) */}
          {scenarioId === 'typhoon-cpap' && (
            <g>
              <rect x="330" y="334" width="580" height="20" fill="url(#heron-hatch)" stroke="#282828" strokeWidth="1.2" />
              <line x1="318" y1="334" x2="922" y2="334" stroke="#282828" strokeWidth="1.8" />

              {/* Pitched Roof */}
              <polygon
                points="440,104 665,46 895,104"
                fill="#F6F4EE"
                stroke="#282828"
                strokeWidth="2"
              />
              <polygon
                points="456,104 665,55 879,104"
                fill="none"
                stroke="#72726F"
                strokeWidth="0.9"
              />
              {/* Rooftop PV */}
              <line x1="685" y1="57" x2="845" y2="96" stroke="#282828" strokeWidth="3" />
              <text x="772" y="68" fill="#575652" fontSize="9" className="heron-mono">
                [PV · 0W TYPHOON]
              </text>

              {/* 1F Garage Left Wing */}
              <rect x="340" y="218" width="115" height="116" fill="#FAF9F5" stroke="#282828" strokeWidth="1.8" />
              <text x="350" y="236" fill="#282828" fontSize="9" fontWeight="700" className="heron-mono">
                01 GARAGE
              </text>
              <rect x="354" y="274" width="86" height="50" fill="#EFECE4" stroke="#282828" strokeWidth="1.5" />
              <rect x="361" y="282" width="44" height="16" fill="#282828" />
              <text x="383" y="293" textAnchor="middle" fill="#F6F4EE" fontSize="8" className="heron-mono">
                {paramValues.batteryWh ?? 1024}Wh
              </text>
              <text x="397" y="314" textAnchor="middle" fill="#282828" fontSize="8" className="heron-mono">
                LiFePO4 · 90%
              </text>

              {/* 2F Bedroom Volume */}
              <rect x="455" y="104" width="425" height="114" fill="#FAF9F5" stroke="#282828" strokeWidth="1.8" />
              <text x="468" y="122" fill="#282828" fontSize="9.5" fontWeight="700" className="heron-mono">
                02 UPSTAIRS SLEEP SUITE (2× 8H)
              </text>
              {/* Bed + Nightstand CPAP */}
              <rect x="474" y="182" width="112" height="28" fill="#EFECE4" stroke="#282828" strokeWidth="1.3" />
              <rect x="480" y="171" width="28" height="11" fill="#F6F4EE" stroke="#282828" strokeWidth="1.1" />
              <rect x="602" y="158" width="66" height="52" fill="#EFECE4" stroke="#282828" strokeWidth="1.4" />
              <text x="635" y="180" textAnchor="middle" fill="#282828" fontSize="8.5" fontWeight="700" className="heron-mono">
                CPAP
              </text>
              <text x="635" y="194" textAnchor="middle" fill="#575652" fontSize="8" className="heron-mono">
                {paramValues.cpapWatts ?? 38}W BASE
              </text>
              {/* Upstairs Window */}
              <rect x="752" y="132" width="92" height="56" fill="#F6F4EE" stroke="#282828" strokeWidth="1.2" />
              <line x1="798" y1="132" x2="798" y2="188" stroke="#282828" strokeWidth="1" />
              <line x1="752" y1="160" x2="844" y2="160" stroke="#282828" strokeWidth="1" />

              {/* 1F Utility & Kitchen */}
              <rect x="455" y="218" width="425" height="116" fill="#FAF9F5" stroke="#282828" strokeWidth="1.8" />
              <line x1="696" y1="218" x2="696" y2="334" stroke="#282828" strokeWidth="1.2" strokeDasharray="4 3" />
              <text x="468" y="236" fill="#282828" fontSize="9" fontWeight="700" className="heron-mono">
                03 CONVERSION WALL
              </text>
              <text x="708" y="236" fill="#282828" fontSize="9" fontWeight="700" className="heron-mono">
                04 KITCHEN COOLER
              </text>

              {/* Wall Inverter (hotspot sits cleanly on top-right corner cx=678,cy=236 away from text) */}
              <rect x="588" y="248" width="84" height="54" fill="#EFECE4" stroke="#282828" strokeWidth="1.5" />
              <text x="630" y="271" textAnchor="middle" fill="#282828" fontSize="8.5" fontWeight="700" className="heron-mono">
                INVERTER
              </text>
              <text x="630" y="286" textAnchor="middle" fill="#575652" fontSize="8" className="heron-mono">
                {toggleValues.dcDirectMode ? '1.5W DC' : `${paramValues.inverterTareW ?? 14}W TARE`}
              </text>

              {/* Kitchen Cooler (hotspot sits cleanly on top-right corner cx=848,cy=242 away from text) */}
              <rect x="748" y="250" width="96" height="74" fill="#EFECE4" stroke="#282828" strokeWidth="1.5" />
              <line x1="748" y1="278" x2="844" y2="278" stroke="#282828" strokeWidth="1.1" />
              <text x="796" y="268" textAnchor="middle" fill="#282828" fontSize="8.5" fontWeight="700" className="heron-mono">
                2–8°C COOLER
              </text>
              <text x="796" y="298" textAnchor="middle" fill="#575652" fontSize="8" className="heron-mono">
                {paramValues.coolerWatts ?? 24}W AVG
              </text>
              <text x="796" y="312" textAnchor="middle" fill="#575652" fontSize="8" className="heron-mono">
                {toggleValues.preChillPacks ? 'PCM ON' : '29°C AMB'}
              </text>

              {/* Fault Red Dashed Circuits */}
              <g stroke="#FA3600" strokeWidth="2.3" fill="none" className="heron-dash-flow">
                <path d="M 440 298 L 588 276" />
                <path d="M 635 248 L 635 210" />
                <path d="M 602 170 C 568 134, 535 134, 508 171" />
                <path d="M 672 276 L 748 286" />
              </g>

              {/* Ink-Seep Masked Resolved Green Circuits */}
              <g mask="url(#heron-ink-seep-mask)">
                <rect x="340" y="104" width="540" height="230" fill="rgba(21, 128, 61, 0.05)" />
                <g stroke="#15803D" strokeWidth="2.8" fill="none">
                  <path d="M 440 298 L 588 276" />
                  <path d="M 635 248 L 635 210" />
                  <path d="M 602 170 C 568 148, 535 148, 508 171" />
                  <path d="M 672 276 L 748 286" />
                </g>
              </g>
            </g>
          )}

          {/* SCENARIO 2: Centered Multi-Region Payment Gateway & PgBouncer Blueprint */}
          {scenarioId === 'singles-day-cutover' && (
            <g>
              <rect x="335" y="72" width="570" height="270" fill="#FAF9F5" stroke="#282828" strokeWidth="1.8" />
              <line x1="518" y1="72" x2="518" y2="342" stroke="#282828" strokeWidth="1.2" strokeDasharray="5 4" />
              <line x1="706" y1="72" x2="706" y2="342" stroke="#282828" strokeWidth="1.2" strokeDasharray="5 4" />

              <text x="350" y="94" fill="#282828" fontSize="9" fontWeight="700" className="heron-mono">
                01 EDGE INGRESS
              </text>
              <text x="532" y="94" fill="#282828" fontSize="9" fontWeight="700" className="heron-mono">
                02 FAILOVER MESH
              </text>
              <text x="720" y="94" fill="#282828" fontSize="9" fontWeight="700" className="heron-mono">
                03 PGBOUNCER POOL
              </text>

              <rect x="352" y="138" width="146" height="86" fill="#EFECE4" stroke="#282828" strokeWidth="1.6" />
              <text x="425" y="164" textAnchor="middle" fill="#282828" fontSize="9" fontWeight="700" className="heron-mono">
                CHECKOUT SDK
              </text>
              <text x="425" y="182" textAnchor="middle" fill="#575652" fontSize="8.5" className="heron-mono">
                {paramValues.rps ?? 5200} RPS
              </text>
              <text x="425" y="200" textAnchor="middle" fill="#282828" fontSize="8" className="heron-mono">
                {toggleValues.tokenBucketRetry ? '<=10% CAP' : `${paramValues.retries ?? 3}X RETRIES`}
              </text>

              <rect x="540" y="146" width="144" height="74" fill="#EFECE4" stroke="#282828" strokeWidth="1.6" />
              <text x="612" y="172" textAnchor="middle" fill="#282828" fontSize="8.5" fontWeight="700" className="heron-mono">
                FAILOVER RTT
              </text>
              <text x="612" y="190" textAnchor="middle" fill="#575652" fontSize="8" className="heron-mono">
                +{paramValues.crossRegionRttMs ?? 68}MS HOLD
              </text>

              <rect x="544" y="254" width="136" height="60" fill="#F6F4EE" stroke="#282828" strokeWidth="1.3" />
              <text x="612" y="280" textAnchor="middle" fill="#282828" fontSize="8.5" fontWeight="700" className="heron-mono">
                AUDIT OUTBOX
              </text>
              <text x="612" y="296" textAnchor="middle" fill="#575652" fontSize="8" className="heron-mono">
                {toggleValues.asyncOutbox ? 'ASYNC (-24MS)' : 'SYNC 2PC'}
              </text>

              <rect x="726" y="142" width="160" height="168" fill="#EFECE4" stroke="#282828" strokeWidth="1.8" />
              <text x="806" y="166" textAnchor="middle" fill="#282828" fontSize="9" fontWeight="700" className="heron-mono">
                PGBOUNCER ({paramValues.dbPoolMax ?? 480})
              </text>
              {[0, 1, 2, 3].map((slot) => (
                <rect
                  key={slot}
                  x={742 + slot * 34}
                  y="188"
                  width="26"
                  height="98"
                  fill={snapshot.isSafe ? '#FAF9F5' : '#F6E3DC'}
                  stroke="#282828"
                  strokeWidth="1.2"
                />
              ))}

              <g stroke="#FA3600" strokeWidth="2.4" fill="none" className="heron-dash-flow">
                <path d="M 498 180 L 540 180" />
                <path d="M 684 182 L 726 212" />
                <path d="M 612 220 L 612 254" />
                <path d="M 680 284 L 726 266" />
              </g>

              <g mask="url(#heron-ink-seep-mask)">
                <rect x="335" y="72" width="570" height="270" fill="rgba(21, 128, 61, 0.05)" />
                <g stroke="#15803D" strokeWidth="2.8" fill="none">
                  <path d="M 498 180 L 540 180" />
                  <path d="M 684 182 L 726 212" />
                  <path d="M 612 220 L 612 254" />
                  <path d="M 680 284 L 726 266" />
                </g>
              </g>
            </g>
          )}

          {/* SCENARIO 3: Centered Cross-Border Cashflow Vault Blueprint */}
          {scenarioId === 'expat-cashflow' && (
            <g>
              <rect x="335" y="72" width="570" height="270" fill="#FAF9F5" stroke="#282828" strokeWidth="1.8" />
              <rect x="352" y="296" width="536" height="30" fill="url(#heron-hatch)" stroke="#282828" strokeWidth="1.5" />
              <text x="620" y="315" textAnchor="middle" fill="#282828" fontSize="9" fontWeight="700" className="heron-mono">
                MANDATORY 3.0-MONTH LIQUID EMERGENCY COVENANT SLAB
              </text>

              <rect x="356" y="132" width="154" height="138" fill="#EFECE4" stroke="#282828" strokeWidth="1.6" />
              <text x="433" y="158" textAnchor="middle" fill="#282828" fontSize="8.5" fontWeight="700" className="heron-mono">
                ON-DEVICE VAULT
              </text>
              <text x="433" y="184" textAnchor="middle" fill="#282828" fontSize="9" fontWeight="700" className="heron-mono">
                {paramValues.reserveMonths ?? 11} MOS RESERVE
              </text>
              <text x="433" y="206" textAnchor="middle" fill="#575652" fontSize="8" className="heron-mono">
                LOCKUP: -{paramValues.relocOneOffMos ?? 3.5}M
              </text>

              <rect x="546" y="142" width="152" height="92" fill="#EFECE4" stroke="#282828" strokeWidth="1.6" />
              <text x="622" y="170" textAnchor="middle" fill="#282828" fontSize="8.5" fontWeight="700" className="heron-mono">
                FX CORRIDOR
              </text>
              <text x="622" y="192" textAnchor="middle" fill="#575652" fontSize="8.5" className="heron-mono">
                SHOCK: -{paramValues.fxShockPct ?? 16}%
              </text>

              <rect x="734" y="136" width="150" height="134" fill="#EFECE4" stroke="#282828" strokeWidth="1.6" />
              <text x="809" y="162" textAnchor="middle" fill="#282828" fontSize="8.5" fontWeight="700" className="heron-mono">
                HOUSING LOAD
              </text>
              <text x="809" y="186" textAnchor="middle" fill="#575652" fontSize="8.5" className="heron-mono">
                {paramValues.housingRatioPct ?? 42}% INFLOW
              </text>
              <text x="809" y="208" textAnchor="middle" fill="#575652" fontSize="8.5" className="heron-mono">
                +{paramValues.rateHikeBps ?? 225} BPS
              </text>

              <g stroke="#FA3600" strokeWidth="2.4" fill="none" className="heron-dash-flow">
                <path d="M 510 198 L 546 188" />
                <path d="M 698 188 L 734 198" />
                <path d="M 809 270 L 809 296" />
              </g>

              <g mask="url(#heron-ink-seep-mask)">
                <rect x="335" y="72" width="570" height="270" fill="rgba(21, 128, 61, 0.05)" />
                <g stroke="#15803D" strokeWidth="2.8" fill="none">
                  <path d="M 510 198 L 546 188" />
                  <path d="M 698 188 L 734 198" />
                  <path d="M 809 270 L 809 296" />
                </g>
              </g>
            </g>
          )}

          {/* Interactive Blueprint Hotspot Nodes */}
          {hotspots.map((hs) => {
            const isResolved = !hs.activeWhenUnsafe || snapshot.isSafe;
            const strokeColor = isResolved ? '#15803D' : '#FA3600';
            const isSelected = auditedIds.includes(hs.id);
            return (
              <g
                key={hs.id}
                onClick={(ev) => {
                  ev.stopPropagation();
                  toggleHotspotInspect(hs.id);
                }}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    toggleHotspotInspect(hs.id);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`Inspect ${hs.codeTag}: ${hs.title}`}
                className="cursor-pointer"
              >
                {!isResolved && (
                  <circle
                    cx={hs.cx}
                    cy={hs.cy}
                    r="16"
                    fill="none"
                    stroke="#FA3600"
                    strokeWidth="1.5"
                    className="heron-hotspot-ring"
                  />
                )}
                <circle
                  cx={hs.cx}
                  cy={hs.cy}
                  r="10.5"
                  fill={isSelected ? strokeColor : '#FAF9F5'}
                  stroke={strokeColor}
                  strokeWidth="2"
                />
                <text
                  x={hs.cx}
                  y={hs.cy + 3.5}
                  textAnchor="middle"
                  fontSize="8.5"
                  fontWeight="700"
                  fill={isSelected ? '#FFFFFF' : '#282828'}
                  className="heron-mono"
                >
                  {hs.id.replace('hs-', '0')}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Desktop Hanging Blueprint Code Violation Cards (Docked in dedicated left/right callout margins — zero schematic overlap!) */}
        <div className="hidden lg:block pointer-events-none absolute inset-0">
          {hotspots
            .filter((hs) => auditedIds.includes(hs.id))
            .map((hs) => {
              const isResolved = !hs.activeWhenUnsafe || snapshot.isSafe;
              const posStyle: React.CSSProperties =
                hs.side === 'left'
                  ? { left: '14px', top: hs.slotIdx === 0 ? '18px' : '192px' }
                  : { right: '14px', top: hs.slotIdx === 0 ? '18px' : '192px' };
              return (
                <div
                  key={hs.id}
                  style={posStyle}
                  className="pointer-events-auto absolute w-[300px] bg-[#FAF9F5]/97 border border-[#282828] shadow-sm"
                >
                  <div
                    className="px-2.5 py-1 flex items-center justify-between gap-2 text-[9.5px] heron-mono font-bold"
                    style={{
                      backgroundColor: isResolved ? '#15803D' : '#282828',
                      color: '#F6F4EE',
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className="inline-block w-2 h-2"
                        style={{ backgroundColor: isResolved ? '#86EFAC' : '#FA3600' }}
                      />
                      [{hs.clausePair}] · {hs.codeTag}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleHotspotInspect(hs.id)}
                      className="text-[9px] opacity-85 hover:opacity-100 cursor-pointer"
                    >
                      [HIDE]
                    </button>
                  </div>
                  <div
                    className="p-2.5 flex flex-col gap-1 border-l-4"
                    style={{ borderLeftColor: isResolved ? '#15803D' : '#FA3600' }}
                  >
                    <div className="heron-mono text-[10px] font-bold text-[#282828] leading-tight">
                      {hs.title}
                    </div>
                    <p className="text-[10.5px] text-[#575652] leading-snug m-0">{hs.detail}</p>
                    <div className="pt-1 flex items-center justify-between gap-2">
                      <span className="heron-mono text-[9px] text-[#575652] truncate">
                        {hs.zoneLabel}
                      </span>
                      <button
                        type="button"
                        onClick={() => onToggleMitigation(hs.toggleKey, !toggleValues[hs.toggleKey])}
                        className="heron-mono text-[9px] font-bold px-2 py-0.5 border cursor-pointer shrink-0 transition-colors"
                        style={{
                          backgroundColor: toggleValues[hs.toggleKey] ? '#15803D' : '#282828',
                          borderColor: toggleValues[hs.toggleKey] ? '#15803D' : '#282828',
                          color: '#FFFFFF',
                        }}
                      >
                        [{hs.fixActionLabel}]
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
        </div>

        {/* Live Press-and-Drag Orange Translucent Selection Marquee */}
        {marquee && (
          <div className="pointer-events-none absolute z-30" style={getMarqueeStyle(marquee)}>
            <span className="heron-mono absolute -top-5 left-0 px-1.5 py-0.5 text-[9px] font-bold bg-[#FA3600] text-[#FFFFFF] whitespace-nowrap">
              [AUDIT SELECTION · {Math.round(Math.abs(marquee.curX - marquee.startX))}×
              {Math.round(Math.abs(marquee.curY - marquee.startY))}PX]
            </span>
          </div>
        )}
      </div>

      {/* Responsive Violation Stack (Mobile/Tablet <1024px) */}
      <div className="lg:hidden grid grid-cols-1 sm:grid-cols-2 gap-2 p-3 border-t border-[#D4D2CA] bg-[#F6F4EE]">
        {hotspots.map((hs) => {
          const isResolved = !hs.activeWhenUnsafe || snapshot.isSafe;
          return (
            <div
              key={hs.id}
              className="border border-[#282828] bg-[#FAF9F5] p-2.5 border-l-4 flex flex-col gap-1"
              style={{ borderLeftColor: isResolved ? '#15803D' : '#FA3600' }}
            >
              <div className="flex items-center justify-between gap-1 heron-mono text-[10px] font-bold text-[#282828]">
                <span className="flex items-center gap-1">
                  <AlertOctagon className="w-3 h-3 text-[#FA3600]" />[{hs.clausePair}]
                </span>
                <span>{hs.codeTag}</span>
              </div>
              <div className="heron-mono text-[11px] font-bold text-[#282828]">{hs.title}</div>
              <p className="text-[11px] text-[#575652] m-0 leading-snug">{hs.detail}</p>
              <button
                type="button"
                onClick={() => onToggleMitigation(hs.toggleKey, !toggleValues[hs.toggleKey])}
                className="mt-1 self-start heron-mono text-[10px] font-bold px-2.5 py-1 bg-[#282828] text-[#F6F4EE] cursor-pointer"
              >
                [{hs.fixActionLabel}]
              </button>
            </div>
          );
        })}
      </div>

      {/* Bottom-Right Architectural Blueprint Title Block */}
      <div className="border-t border-[#D4D2CA] bg-[#FAF9F5] grid grid-cols-1 md:grid-cols-12">
        <div className="md:col-span-5 px-3.5 py-2 border-b md:border-b-0 md:border-r border-[#D4D2CA] flex items-center justify-between gap-2">
          <span className="heron-mono text-[10.5px] font-bold text-[#282828]">
            PROJECT: FAULTLINE V3 · SPECULATIVE SIMPLEX
          </span>
          <span
            className="heron-mono text-[10px] font-bold px-1.5 py-0.5"
            style={{
              backgroundColor: snapshot.isSafe ? '#15803D' : '#282828',
              color: '#FFFFFF',
            }}
          >
            {snapshot.isSafe ? 'STAMP: SAFE' : `INK MASK ${(inkProgress * 100).toFixed(0)}%`}
          </span>
        </div>
        <div className="md:col-span-5 px-3.5 py-2 border-b md:border-b-0 md:border-r border-[#D4D2CA] flex items-center justify-between gap-2">
          <span className="heron-mono text-[10.5px] text-[#282828]">
            SCALE: 0.28S NANO / 3.0S PYTHON
          </span>
          <span className="heron-mono text-[10px] text-[#575652]">{snapshot.failurePointLabel}</span>
        </div>
        <div className="md:col-span-2 px-3.5 py-2 bg-[#EFECE4] flex items-center justify-between">
          <span className="heron-mono text-[10.5px] font-bold text-[#282828]">SHEET: {sheetIndex}</span>
          <span className="heron-mono text-[10px] text-[#575652]">REV 3.1</span>
        </div>
      </div>
    </section>
  );
};
