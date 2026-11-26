import React, { useRef } from 'react';
import gsap from 'gsap';
import { ExternalLink } from 'lucide-react';

export const HeronFooterInkWordmark: React.FC = () => {
  const blotRef = useRef<SVGCircleElement | null>(null);
  const secondaryBlotRef = useRef<SVGCircleElement | null>(null);

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 1200;
    const y = ((e.clientY - rect.top) / rect.height) * 230;
    if (blotRef.current) {
      gsap.to(blotRef.current, {
        attr: { cx: x, cy: y, r: 240 },
        duration: 0.65,
        ease: 'power3.out',
        overwrite: 'auto',
      });
    }
    if (secondaryBlotRef.current) {
      gsap.to(secondaryBlotRef.current, {
        attr: { cx: x - 95, cy: y + 18, r: 155 },
        duration: 1.05,
        ease: 'power2.out',
        overwrite: 'auto',
      });
    }
  };

  const handlePointerLeave = () => {
    if (blotRef.current) {
      gsap.to(blotRef.current, {
        attr: { cx: 360, cy: 125, r: 145 },
        duration: 0.9,
        ease: 'power2.inOut',
      });
    }
    if (secondaryBlotRef.current) {
      gsap.to(secondaryBlotRef.current, {
        attr: { cx: 250, cy: 135, r: 95 },
        duration: 1.1,
        ease: 'power2.inOut',
      });
    }
  };

  return (
    <footer className="border-t border-[#D4D2CA] bg-[#F6F4EE]">
      {/* Dimension-Ticked Hollowed FAULTLINE AI Wordmark with Lagging Black Ink Blot */}
      <div className="px-4 pt-5 pb-3 border-b border-[#D4D2CA] bg-[#FAF9F5] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1 heron-mono text-[10px] text-[#575652]">
          <span>[ARCHITECTURAL INK-BLOT CALLOUT · MOVE CURSOR ACROSS GLYPHS TO INK]</span>
          <span>|&lt;——— 1,200 MM FULL-SHEET TITLE SPAN ———&gt;|</span>
        </div>

        <svg
          viewBox="0 0 1200 220"
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          className="w-full h-auto block select-none cursor-crosshair"
          role="img"
          aria-label="FAULTLINE AI Hollowed Architectural Typography with Interactive Ink Fill"
        >
          <defs>
            <filter id="heron-footer-ink-blot" x="-25%" y="-25%" width="150%" height="150%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.032"
                numOctaves="4"
                seed="7"
                result="blotNoise"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="blotNoise"
                scale="46"
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>

            <mask id="heron-wordmark-ink-mask">
              <rect x="0" y="0" width="1200" height="220" fill="black" />
              <g filter="url(#heron-footer-ink-blot)" fill="white">
                <circle ref={blotRef} cx="360" cy="125" r="145" />
                <circle ref={secondaryBlotRef} cx="250" cy="135" r="95" />
              </g>
            </mask>
          </defs>

          {/* Architectural Dimension Extension Ticks */}
          <g stroke="#A8A59B" strokeWidth="1">
            <line x1="24" y1="22" x2="1176" y2="22" />
            <line x1="24" y1="14" x2="24" y2="198" strokeDasharray="3 3" />
            <line x1="1176" y1="14" x2="1176" y2="198" strokeDasharray="3 3" />
            <line x1="24" y1="196" x2="1176" y2="196" />
            {[0, 200, 400, 600, 800, 1000, 1176].map((x) => (
              <line key={x} x1={Math.max(24, x)} y1="17" x2={Math.max(24, x)} y2="27" stroke="#282828" />
            ))}
          </g>

          {/* Hollowed Dimension-Ticked Outline Letters */}
          <text
            x="600"
            y="164"
            textAnchor="middle"
            fontSize="148"
            fontWeight="900"
            fill="none"
            stroke="#282828"
            strokeWidth="2.2"
            letterSpacing="4"
            className="heron-display"
          >
            FAULTLINE AI
          </text>

          {/* Lagging Organic Solid Ink Fill Masked by <feTurbulence> Blot */}
          <g mask="url(#heron-wordmark-ink-mask)">
            <text
              x="600"
              y="164"
              textAnchor="middle"
              fontSize="148"
              fontWeight="900"
              fill="#282828"
              letterSpacing="4"
              className="heron-display"
            >
              FAULTLINE AI
            </text>
          </g>

          {/* Corner Registration Marks */}
          <text x="30" y="42" fontSize="12" fill="#FA3600" fontWeight="700" className="heron-mono">
            +
          </text>
          <text x="1162" y="42" fontSize="12" fill="#FA3600" fontWeight="700" className="heron-mono">
            +
          </text>
        </svg>
      </div>

      {/* Attribution & Hybrid SDK Provenance Strip */}
      <div className="px-4 py-3 bg-[#EFECE4] flex flex-wrap items-center justify-between gap-3">
        <div className="heron-mono text-[10.5px] text-[#282828]">
          <strong>#BUILDHYBRIDAI 2026</strong> · FIREBASE AI LOGIC HYBRID SDK (`PREFER_ON_DEVICE` + `ONLY_IN_CLOUD` PYTHON)
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="heron-mono text-[10px] text-[#575652]">1:1 ARCHITECTURAL HOMAGE:</span>
          <a
            href="https://www.awwwards.com/sites/heron-ai"
            target="_blank"
            rel="noopener noreferrer"
            className="heron-mono text-[10px] font-bold px-2 py-0.5 border border-[#282828] bg-[#FAF9F5] text-[#282828] hover:bg-[#282828] hover:text-[#F6F4EE] inline-flex items-center gap-1 no-underline"
          >
            AWWWARDS SOTD <ExternalLink className="w-2.5 h-2.5" />
          </a>
          <a
            href="https://legacy.thefwa.com/cases/heronai"
            target="_blank"
            rel="noopener noreferrer"
            className="heron-mono text-[10px] font-bold px-2 py-0.5 border border-[#282828] bg-[#FAF9F5] text-[#282828] hover:bg-[#282828] hover:text-[#F6F4EE] inline-flex items-center gap-1 no-underline"
          >
            THE FWA FOTD <ExternalLink className="w-2.5 h-2.5" />
          </a>
          <a
            href="https://heronaiapp.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="heron-mono text-[10px] font-bold px-2 py-0.5 border border-[#282828] bg-[#FAF9F5] text-[#282828] hover:bg-[#282828] hover:text-[#F6F4EE] inline-flex items-center gap-1 no-underline"
          >
            HERONAIAPP.COM <ExternalLink className="w-2.5 h-2.5" />
          </a>
        </div>
      </div>
    </footer>
  );
};
