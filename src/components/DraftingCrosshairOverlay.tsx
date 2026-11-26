import React, { useEffect, useRef, useState } from 'react';

interface TrailPoint {
  x: number;
  y: number;
  alpha: number;
}

export const DraftingCrosshairOverlay: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hLineRef = useRef<HTMLDivElement | null>(null);
  const vLineRef = useRef<HTMLDivElement | null>(null);
  const readoutRef = useRef<HTMLDivElement | null>(null);
  const [enabled, setEnabled] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth > 991 : true,
  );

  useEffect(() => {
    const checkViewport = () => {
      setEnabled(window.innerWidth > 991);
    };
    window.addEventListener('resize', checkViewport);
    return () => window.removeEventListener('resize', checkViewport);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let pointerX = Math.round(window.innerWidth * 0.28);
    let pointerY = Math.round(window.innerHeight * 0.64);
    let smoothX = pointerX;
    let smoothY = pointerY;
    let hasMoved = false;
    const trail: TrailPoint[] = [];

    const resizeCanvas = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const updateCrosshairDom = (x: number, y: number) => {
      if (hLineRef.current) {
        hLineRef.current.style.transform = `translate3d(0, ${y}px, 0)`;
      }
      if (vLineRef.current) {
        vLineRef.current.style.transform = `translate3d(${x}px, 0, 0)`;
      }
      if (readoutRef.current) {
        const clampedX = Math.min(window.innerWidth - 178, x + 12);
        const clampedY = Math.max(42, y - 24);
        readoutRef.current.style.transform = `translate3d(${clampedX}px, ${clampedY}px, 0)`;
        readoutRef.current.textContent = `X: ${String(Math.round(x)).padStart(4, '0')}PX / Y: ${String(
          Math.round(y),
        ).padStart(4, '0')}PX`;
      }
    };

    updateCrosshairDom(pointerX, pointerY);

    const onPointerMove = (e: PointerEvent) => {
      pointerX = e.clientX;
      pointerY = e.clientY;
      hasMoved = true;
      updateCrosshairDom(pointerX, pointerY);
      trail.push({ x: pointerX, y: pointerY, alpha: 1 });
      if (trail.length > 18) {
        trail.shift();
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });

    const renderLoop = () => {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      smoothX += (pointerX - smoothX) * 0.22;
      smoothY += (pointerY - smoothY) * 0.22;

      for (let i = trail.length - 1; i >= 0; i--) {
        trail[i].alpha *= 0.86;
        if (trail[i].alpha < 0.04) {
          trail.splice(i, 1);
        }
      }

      if (trail.length > 1) {
        for (let i = 1; i < trail.length; i++) {
          const p0 = trail[i - 1];
          const p1 = trail[i];
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.strokeStyle = `rgba(250, 54, 0, ${(p1.alpha * 0.55).toFixed(3)})`;
          ctx.lineWidth = 2.2;
          ctx.stroke();
        }
      }

      // Signature 9px #FA3600 trailing drafting cursor square/circle marker
      if (hasMoved) {
        ctx.fillStyle = '#FA3600';
        ctx.beginPath();
        ctx.arc(smoothX, smoothY, 4.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Subtle resting registration reticle on initial viewport load
        ctx.strokeStyle = 'rgba(250, 54, 0, 0.65)';
        ctx.lineWidth = 1.25;
        ctx.strokeRect(smoothX - 4.5, smoothY - 4.5, 9, 9);
      }

      rafId = window.requestAnimationFrame(renderLoop);
    };

    rafId = window.requestAnimationFrame(renderLoop);

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      window.removeEventListener('pointermove', onPointerMove);
      window.cancelAnimationFrame(rafId);
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-40 overflow-hidden select-none"
    >
      {/* Full-sheet 1px horizontal & vertical drafting hairlines */}
      <div
        ref={hLineRef}
        className="absolute left-0 top-0 w-full h-[1px]"
        style={{ backgroundColor: 'rgba(40, 40, 40, 0.14)' }}
      />
      <div
        ref={vLineRef}
        className="absolute left-0 top-0 h-full w-[1px]"
        style={{ backgroundColor: 'rgba(40, 40, 40, 0.14)' }}
      />
      <div
        ref={readoutRef}
        className="heron-mono absolute left-0 top-0 px-1.5 py-0.5 text-[9.5px] font-medium tracking-wider border border-[#D4D2CA] bg-[#F6F4EE]/92 text-[#282828]"
      >
        X: 0806PX / Y: 0386PX
      </div>
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
};
