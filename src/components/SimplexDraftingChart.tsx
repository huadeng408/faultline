import React, { useMemo, useState } from 'react';
import NumberFlow from '@number-flow/react';
import { line, area, curveMonotoneX } from 'd3-shape';
import { scaleLinear } from 'd3-scale';
import { Delaunay } from 'd3-delaunay';
import { Code2, Crosshair, Play, Terminal } from 'lucide-react';
import type { ScenarioDefinition, SimulationSnapshot } from '../core/faultlineEngine';

interface SimplexDraftingChartProps {
  scenario: ScenarioDefinition;
  paramValues: Record<string, number>;
  snapshot: SimulationSnapshot;
  isCalibrating: boolean;
  onRunCloudCalibration: () => void;
  inspectedStepFrac: number | null;
  onSelectStepFrac: (frac: number) => void;
}

interface VoronoiSampleNode {
  id: number;
  frac: number;
  curve: 'nano' | 'python';
  cx: number;
  cy: number;
  nanoPct: number;
  pythonPct: number;
  nanoAbs: number;
  pythonAbs: number;
  absUnit: string;
  timeStampLabel: string;
  marginAtPoint: number;
}

const CHART_W = 680;
const CHART_H = 264;
const PAD = { top: 26, right: 20, bottom: 34, left: 44 };

function lerpAt(arr: number[], frac: number): number {
  if (arr.length === 0) return 0;
  const pos = Math.max(0, Math.min(arr.length - 1, frac * (arr.length - 1)));
  const i0 = Math.floor(pos);
  const i1 = Math.min(arr.length - 1, i0 + 1);
  const t = pos - i0;
  return arr[i0] * (1 - t) + arr[i1] * t;
}

export const SimplexDraftingChart: React.FC<SimplexDraftingChartProps> = ({
  scenario,
  paramValues,
  snapshot,
  isCalibrating,
  onRunCloudCalibration,
  inspectedStepFrac,
  onSelectStepFrac,
}) => {
  const [snappedNodeIdx, setSnappedNodeIdx] = useState<number>(76);
  const [showPython, setShowPython] = useState<boolean>(false);

  const n = snapshot.xLabels.length;

  const {
    localPath,
    cloudPath,
    driftAreaPath,
    xScale,
    yScale,
    floorY,
    voronoiMeshPath,
    voronoiObj,
    sampleNodes,
  } = useMemo(() => {
    const xS = scaleLinear()
      .domain([0, Math.max(1, n - 1)])
      .range([PAD.left, CHART_W - PAD.right]);
    const yS = scaleLinear()
      .domain([0, 100])
      .range([CHART_H - PAD.bottom, PAD.top]);

    const mkLine = line<number>()
      .x((_, i) => xS(i))
      .y((v) => yS(v))
      .curve(curveMonotoneX);

    const mkArea = area<number>()
      .x((_, i) => xS(i))
      .y0((_, i) => yS(snapshot.localSeries[i] ?? 0))
      .y1((v) => yS(v))
      .curve(curveMonotoneX);

    const safetyPct =
      scenario.id === 'singles-day-cutover' ? 15 : scenario.id === 'expat-cashflow' ? 18.75 : 10;

    // Construct dense quarter-step (15-min / sub-interval) 2D CAD nodes for d3-delaunay Voronoi snapping
    const totalSubSteps = 72; // every 30 minutes on 36h window (73 timestamps x 2 curves = 146 Voronoi sites)
    const nodes: VoronoiSampleNode[] = [];
    const totalHorizon =
      scenario.id === 'typhoon-cpap'
        ? paramValues.outageHours ?? 36
        : 36;
    const baseCap =
      scenario.id === 'typhoon-cpap'
        ? paramValues.batteryWh ?? 1024
        : scenario.id === 'singles-day-cutover'
          ? paramValues.dbPoolMax ?? 480
          : 16;
    const absUnit =
      scenario.id === 'typhoon-cpap'
        ? 'Wh'
        : scenario.id === 'singles-day-cutover'
          ? 'conns'
          : 'mos';

    for (let s = 0; s <= totalSubSteps; s++) {
      const frac = s / totalSubSteps;
      const idxFloat = frac * Math.max(1, n - 1);
      const cx = xS(idxFloat);
      const nanoPct = lerpAt(snapshot.localSeries, frac);
      const pythonPct = lerpAt(snapshot.cloudSeries, frac);
      const nanoAbs = (nanoPct / 100) * baseCap;
      const pythonAbs = (pythonPct / 100) * baseCap;

      let timeStampLabel = '';
      if (scenario.id === 'typhoon-cpap') {
        const totalMins = Math.round(frac * totalHorizon * 60);
        const hh = Math.floor(totalMins / 60);
        const mm = totalMins % 60;
        timeStampLabel = `T+${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m`;
      } else if (scenario.id === 'singles-day-cutover') {
        const totalSecs = Math.round(frac * 36 * 60);
        const mm = Math.floor(totalSecs / 60);
        const ss = totalSecs % 60;
        timeStampLabel = `T+${String(mm).padStart(2, '0')}m ${String(ss).padStart(2, '0')}s`;
      } else {
        const moFloat = frac * 36;
        const mo = Math.floor(moFloat);
        const wk = Math.min(3, Math.round((moFloat - mo) * 4));
        timeStampLabel = `M${String(mo).padStart(2, '0')}·W${wk + 1}`;
      }

      const marginAtPoint =
        scenario.id === 'typhoon-cpap'
          ? Number((((pythonPct - nanoPct) / 100) * (totalHorizon * 0.85)).toFixed(2))
          : scenario.id === 'singles-day-cutover'
            ? Number((pythonPct - nanoPct).toFixed(1))
            : Number((((pythonPct - nanoPct) / 100) * 16).toFixed(2));

      nodes.push({
        id: nodes.length,
        frac,
        curve: 'nano',
        cx,
        cy: yS(nanoPct),
        nanoPct,
        pythonPct,
        nanoAbs,
        pythonAbs,
        absUnit,
        timeStampLabel,
        marginAtPoint,
      });

      // Slight 0.35px vertical separation if curves coincide at t=0 so Voronoi cells stay non-degenerate
      const pyCy = Math.abs(yS(pythonPct) - yS(nanoPct)) < 0.4 ? yS(pythonPct) + 0.45 : yS(pythonPct);
      nodes.push({
        id: nodes.length,
        frac,
        curve: 'python',
        cx,
        cy: pyCy,
        nanoPct,
        pythonPct,
        nanoAbs,
        pythonAbs,
        absUnit,
        timeStampLabel,
        marginAtPoint,
      });
    }

    const delaunay = Delaunay.from(
      nodes,
      (d) => d.cx,
      (d) => d.cy,
    );
    const voronoi = delaunay.voronoi([PAD.left, PAD.top, CHART_W - PAD.right, CHART_H - PAD.bottom]);

    return {
      localPath: mkLine(snapshot.localSeries) || '',
      cloudPath: mkLine(snapshot.cloudSeries) || '',
      driftAreaPath: mkArea(snapshot.cloudSeries) || '',
      xScale: xS,
      yScale: yS,
      floorY: yS(safetyPct),
      voronoiMeshPath: voronoi.render(),
      voronoiObj: { delaunay, voronoi },
      sampleNodes: nodes,
    };
  }, [n, snapshot.localSeries, snapshot.cloudSeries, scenario.id, paramValues]);

  // Resolve active node either from external Piecewise Proof click or from d3-delaunay Voronoi hover
  const activeNode: VoronoiSampleNode = useMemo(() => {
    if (inspectedStepFrac !== null) {
      const targetSub = Math.round(Math.max(0, Math.min(1, inspectedStepFrac)) * 72);
      const candidate = sampleNodes[targetSub * 2 + 1];
      if (candidate) return candidate;
    }
    return sampleNodes[Math.max(0, Math.min(sampleNodes.length - 1, snappedNodeIdx))] ?? sampleNodes[0];
  }, [inspectedStepFrac, sampleNodes, snappedNodeIdx]);

  const activeCellPath = useMemo(() => {
    const poly = voronoiObj.voronoi.cellPolygon(activeNode.id);
    if (!poly || poly.length < 3) return '';
    return `M ${poly.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ')} Z`;
  }, [voronoiObj, activeNode.id]);

  const cloudStroke = snapshot.isSafe ? '#15803D' : '#FA3600';
  const absDelta = activeNode.pythonAbs - activeNode.nanoAbs;

  // Position CAD X/Y callout box cleanly away from top/right borders & curves
  const calloutW = 248;
  const calloutH = 54;
  const calloutX =
    activeNode.cx > CHART_W * 0.54
      ? Math.max(PAD.left + 6, activeNode.cx - calloutW - 12)
      : Math.min(CHART_W - PAD.right - calloutW - 6, activeNode.cx + 12);
  const anchorY = activeNode.curve === 'python' ? activeNode.cy : yScale(activeNode.nanoPct);
  const calloutY = Math.max(
    PAD.top + 4,
    Math.min(CHART_H - PAD.bottom - calloutH - 6, anchorY < 105 ? anchorY + 10 : anchorY - calloutH - 10),
  );

  return (
    <section
      aria-label="Dual-Curve Speculative Simplex Plot with Voronoi CAD Snapping"
      className="bg-[#F6F4EE] flex flex-col justify-between h-full"
    >
      {/* Header Cell */}
      <div className="px-4 py-2.5 border-b border-[#D4D2CA] bg-[#EFECE4] flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="heron-mono text-[10.5px] font-bold px-2 py-0.5 border border-[#282828] bg-[#FAF9F5] text-[#282828]">
            [02 · VORONOI SIMPLEX CAD]
          </span>
          <span className="heron-mono text-[10px] text-[#575652] flex items-center gap-1">
            <Crosshair className="w-3 h-3 text-[#FA3600]" />
            D3-DELAUNAY 2D SNAP ({sampleNodes.length} SITES)
          </span>
        </div>

        <button
          type="button"
          onClick={onRunCloudCalibration}
          className="heron-mono text-[10.5px] font-bold px-2.5 py-1 bg-[#282828] text-[#F6F4EE] hover:bg-[#136B33] transition-colors cursor-pointer flex items-center gap-1.5"
        >
          <Play className="w-3 h-3 fill-current" />
          {isCalibrating ? 'CALIBRATING PYTHON…' : 'RE-RUN 3.0S PYTHON SOLVER'}
        </button>
      </div>

      {/* 3-Cell Telemetry Readout Strip */}
      <div className="grid grid-cols-3 border-b border-[#D4D2CA] bg-[#FAF9F5]">
        <div className="p-3 border-r border-[#D4D2CA]">
          <div className="heron-mono text-[10px] text-[#575652] uppercase">
            [ON_DEVICE · 0.28S]
          </div>
          <div className="mt-1 heron-mono text-xl font-bold text-[#282828] flex items-baseline gap-1">
            <span>{snapshot.localMargin > 0 ? '+' : ''}</span>
            <NumberFlow
              value={snapshot.localMargin}
              format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
            />
            <span className="text-[11px] font-normal text-[#575652]">{scenario.marginUnit}</span>
          </div>
        </div>

        <div className="p-3 border-r border-[#D4D2CA]">
          <div className="heron-mono text-[10px] text-[#575652] uppercase">
            [CLOUD PYTHON · 3.0S]
          </div>
          <div
            className="mt-1 heron-mono text-xl font-bold flex items-baseline gap-1"
            style={{ color: snapshot.isSafe ? '#136B33' : '#B82500' }}
          >
            <span>{snapshot.cloudMargin > 0 ? '+' : ''}</span>
            <NumberFlow
              value={snapshot.cloudMargin}
              format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
            />
            <span className="text-[11px] font-normal text-[#575652]">{scenario.marginUnit}</span>
          </div>
        </div>

        <div className="p-3">
          <div className="heron-mono text-[10px] text-[#575652] uppercase">
            [SNAPBACK DRIFT Δ]
          </div>
          <div className="mt-1 heron-mono text-xl font-bold text-[#282828] flex items-baseline gap-1">
            <span>{snapshot.driftDelta > 0 ? '+' : ''}</span>
            <NumberFlow
              value={snapshot.driftDelta}
              format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
            />
            <span className="text-[11px] font-normal text-[#575652]">{scenario.marginUnit}</span>
          </div>
        </div>
      </div>

      {/* SVG Dual-Curve Chart with d3-delaunay Voronoi Mesh + X/Y CAD Callout */}
      <div className="p-3.5 heron-blueprint-grid border-b border-[#D4D2CA]">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2 heron-mono text-[10px] text-[#282828]">
          <span>Y-AXIS: {scenario.axisYLabel.toUpperCase()}</span>
          <span className="font-bold">
            CAD [{activeNode.timeStampLabel}] · Δ {absDelta >= 0 ? '+' : ''}
            {absDelta.toFixed(1)} {activeNode.absUnit} ({activeNode.marginAtPoint >= 0 ? '+' : ''}
            {activeNode.marginAtPoint} {scenario.marginUnit})
          </span>
        </div>

        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className="w-full h-auto block select-none cursor-crosshair"
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const relX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * CHART_W;
            const relY = ((e.clientY - rect.top) / Math.max(1, rect.height)) * CHART_H;
            const foundIdx = voronoiObj.delaunay.find(relX, relY);
            if (foundIdx >= 0 && foundIdx < sampleNodes.length) {
              setSnappedNodeIdx(foundIdx);
              if (inspectedStepFrac !== null) {
                onSelectStepFrac(sampleNodes[foundIdx].frac);
              }
            }
          }}
        >
          {/* Subtle Architectural Voronoi Tessellation Mesh */}
          <path
            d={voronoiMeshPath}
            fill="none"
            stroke="rgba(40, 40, 40, 0.085)"
            strokeWidth="0.65"
          />

          {/* Active Snapped Voronoi Cell Highlight */}
          {activeCellPath && (
            <path
              d={activeCellPath}
              fill={snapshot.isSafe ? 'rgba(21, 128, 61, 0.10)' : 'rgba(250, 54, 0, 0.11)'}
              stroke={snapshot.isSafe ? 'rgba(21, 128, 61, 0.45)' : 'rgba(250, 54, 0, 0.45)'}
              strokeWidth="0.95"
            />
          )}

          {/* Y-Axis Gridlines */}
          {[0, 25, 50, 75, 100].map((tick) => {
            const y = yScale(tick);
            return (
              <g key={tick}>
                <line
                  x1={PAD.left}
                  y1={y}
                  x2={CHART_W - PAD.right}
                  y2={y}
                  stroke="#D4D2CA"
                  strokeWidth="1"
                />
                <text
                  x={PAD.left - 7}
                  y={y + 3}
                  textAnchor="end"
                  fontSize="9.5"
                  fill="#575652"
                  className="heron-mono"
                >
                  {tick}%
                </text>
              </g>
            );
          })}

          {/* Safety Covenant Floor */}
          <line
            x1={PAD.left}
            y1={floorY}
            x2={CHART_W - PAD.right}
            y2={floorY}
            stroke={snapshot.isSafe ? '#15803D' : '#FA3600'}
            strokeWidth="1.2"
            strokeDasharray="3 3"
          />
          <text
            x={CHART_W - PAD.right - 4}
            y={floorY - 5}
            textAnchor="end"
            fontSize="8.5"
            fontWeight="700"
            fill={snapshot.isSafe ? '#136B33' : '#B82500'}
            className="heron-mono"
          >
            MINIMUM SAFETY ENVELOPE FLOOR
          </text>

          {/* Divergence Shaded Band */}
          <path
            d={driftAreaPath}
            fill={snapshot.isSafe ? 'rgba(21, 128, 61, 0.12)' : 'rgba(250, 54, 0, 0.14)'}
          />

          {/* 0.28s Local Optimistic Dashed Line */}
          <path
            d={localPath}
            fill="none"
            stroke="#282828"
            strokeWidth="1.9"
            strokeDasharray="5 4"
          />

          {/* 3.0s Cloud Ground-Truth Solid Line */}
          <path d={cloudPath} fill="none" stroke={cloudStroke} strokeWidth="2.9" />

          {/* Precision X/Y Orthogonal CAD Hairlines */}
          <line
            x1={activeNode.cx}
            y1={PAD.top}
            x2={activeNode.cx}
            y2={CHART_H - PAD.bottom}
            stroke="#282828"
            strokeWidth="1"
          />
          <line
            x1={PAD.left}
            y1={anchorY}
            x2={CHART_W - PAD.right}
            y2={anchorY}
            stroke="#282828"
            strokeOpacity="0.32"
            strokeDasharray="2 3"
            strokeWidth="0.9"
          />

          {/* Snapped Dual-Curve Reticles */}
          <circle
            cx={activeNode.cx}
            cy={yScale(activeNode.nanoPct)}
            r={activeNode.curve === 'nano' ? 5.4 : 4.0}
            fill="#FAF9F5"
            stroke="#282828"
            strokeWidth="2"
          />
          <circle
            cx={activeNode.cx}
            cy={yScale(activeNode.pythonPct)}
            r={activeNode.curve === 'python' ? 5.6 : 4.4}
            fill={cloudStroke}
            stroke="#FAF9F5"
            strokeWidth="1.7"
          />

          {/* Leader Line from Snapped Vertex to X/Y CAD Callout Box */}
          <line
            x1={activeNode.cx}
            y1={anchorY}
            x2={calloutX + (calloutX > activeNode.cx ? 0 : calloutW)}
            y2={calloutY + calloutH * 0.5}
            stroke="#282828"
            strokeWidth="0.9"
          />

          {/* Architectural X/Y CAD Callout Plaque */}
          <g transform={`translate(${calloutX}, ${calloutY})`}>
            <rect
              x="0"
              y="0"
              width={calloutW}
              height={calloutH}
              fill="#FAF9F5"
              stroke="#282828"
              strokeWidth="1.2"
            />
            <rect
              x="0"
              y="0"
              width="4"
              height={calloutH}
              fill={snapshot.isSafe ? '#15803D' : '#FA3600'}
            />
            <text x="10" y="14" fontSize="8.8" fontWeight="700" fill="#282828" className="heron-mono">
              X: {activeNode.timeStampLabel} · SNAP: {activeNode.curve.toUpperCase()}
            </text>
            <text x="10" y="29" fontSize="8.6" fill="#282828" className="heron-mono">
              Y: NANO {activeNode.nanoAbs.toFixed(0)} {activeNode.absUnit} ({activeNode.nanoPct.toFixed(1)}%) · PY{' '}
              {activeNode.pythonAbs.toFixed(0)} {activeNode.absUnit}
            </text>
            <text
              x="10"
              y="44"
              fontSize="8.8"
              fontWeight="700"
              fill={snapshot.isSafe ? '#136B33' : '#B82500'}
              className="heron-mono"
            >
              Δ RESERVE: {absDelta >= 0 ? '+' : ''}
              {absDelta.toFixed(1)} {activeNode.absUnit} · Δ MARGIN: {activeNode.marginAtPoint >= 0 ? '+' : ''}
              {activeNode.marginAtPoint} {scenario.marginUnit}
            </text>
          </g>

          {/* X-Axis Labels */}
          {[0, 9, 18, 27, n - 1].map((idx) => (
            <text
              key={idx}
              x={xScale(idx)}
              y={CHART_H - 10}
              textAnchor="middle"
              fontSize="9.5"
              fill="#575652"
              className="heron-mono"
            >
              {snapshot.xLabels[idx]}
            </text>
          ))}
        </svg>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 heron-mono text-[10px] text-[#575652]">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t-2 border-dashed border-[#282828]" />
            0.28S ON-DEVICE LINEAR ESTIMATE
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block w-4 h-[3px]"
              style={{ backgroundColor: cloudStroke }}
            />
            3.0S CLOUD PYTHON NON-LINEAR SOLVER
          </span>
        </div>
      </div>

      {/* Discovered Physics/Queueing Invariants + Expandable Python Sandbox Code */}
      <div className="p-3.5 bg-[#FAF9F5] flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="heron-mono text-[10.5px] font-bold text-[#282828] flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5 text-[#FA3600]" />
            CLOUD CODE EXECUTION · DISCOVERED INVARIANTS
          </span>
          <button
            type="button"
            onClick={() => setShowPython((prev) => !prev)}
            className="heron-mono text-[10px] font-semibold px-2 py-0.5 border border-[#D4D2CA] bg-[#F6F4EE] text-[#282828] hover:border-[#282828] cursor-pointer flex items-center gap-1"
          >
            <Code2 className="w-3 h-3" />
            {showPython ? '[HIDE PYTHON]' : '[VIEW PYTHON SOLVER]'}
          </button>
        </div>

        <ul className="m-0 p-0 list-none flex flex-col gap-1">
          {snapshot.discoveredInvariants.map((inv, idx) => (
            <li
              key={idx}
              className="text-[11.5px] text-[#282828] leading-snug pl-2.5 border-l-2 border-[#282828]"
            >
              <span className="heron-mono text-[10px] font-bold text-[#575652] mr-1.5">
                [0{idx + 1}]
              </span>
              {inv}
            </li>
          ))}
        </ul>

        {showPython && (
          <div className="mt-1 border border-[#282828] bg-[#282828] text-[#F6F4EE] p-2.5 overflow-x-auto">
            <div className="heron-mono text-[9.5px] text-[#D4D2CA] mb-1.5">
              STDOUT: {snapshot.pythonStdout}
            </div>
            <pre className="heron-mono text-[10.5px] leading-relaxed m-0 whitespace-pre-wrap">
              {snapshot.pythonCode}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
};
