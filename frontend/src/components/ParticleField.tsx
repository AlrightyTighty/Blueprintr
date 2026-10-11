import { useEffect, useRef } from 'react';
import {
  REACH,
  createParticles,
  linkStrength,
  stepParticle,
  type Particle,
  type Pointer,
} from '../core/effects/particles';

/** Violet, indigo and sky, to match the rest of the page. */
const TINTS = ['167, 139, 250', '129, 140, 248', '125, 211, 252'];

/**
 * A field of particles that are invisible until the mouse gets near them: they light up as it approaches,
 * join their neighbours with faint lines, and fade away behind it. Fills its (relatively positioned) parent
 * and ignores the mouse itself, so the content on top stays clickable.
 */
export default function ParticleField({ className = '' }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    let size = { width: 0, height: 0 };
    let particles: Particle[] = [];
    let client: { x: number; y: number } | null = null;
    let isOnScreen = true;
    let animationFrame = 0;
    let lastTime = 0;

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      size = { width: rect.width, height: rect.height };
      canvas!.width = Math.round(rect.width * ratio);
      canvas!.height = Math.round(rect.height * ratio);
      context!.setTransform(ratio, 0, 0, ratio, 0, 0);
      particles = createParticles(size.width, size.height);
    }

    /** The pointer in the canvas's own coordinates, worked out each frame so scrolling keeps it right. */
    function pointerInCanvas(): Pointer | null {
      if (!client) return null;
      const rect = canvas!.getBoundingClientRect();
      const x = client.x - rect.left;
      const y = client.y - rect.top;
      const margin = REACH;
      return x < -margin || y < -margin || x > rect.width + margin || y > rect.height + margin ? null : { x, y };
    }

    function draw(now: number) {
      animationFrame = 0;
      const time = now / 1000;
      const frameSeconds = lastTime ? time - lastTime : 1 / 60;
      lastTime = time;
      const pointer = pointerInCanvas();
      const reduceMotion = motionQuery.matches;

      context!.clearRect(0, 0, size.width, size.height);
      const lit: Particle[] = [];
      for (const particle of particles) {
        stepParticle(particle, frameSeconds, time, size, pointer, { reduceMotion });
        if (particle.alpha <= 0) continue;
        lit.push(particle);
        const tint = TINTS[particle.tint]!;
        context!.fillStyle = `rgba(${tint}, ${particle.alpha * 0.14})`;
        context!.beginPath();
        context!.arc(particle.x, particle.y, particle.size * 3.2, 0, Math.PI * 2); // soft halo
        context!.fill();
        context!.fillStyle = `rgba(${tint}, ${Math.min(1, particle.alpha * 1.1)})`;
        context!.beginPath();
        context!.arc(particle.x, particle.y, particle.size * (1 + particle.alpha * 0.5), 0, Math.PI * 2);
        context!.fill();
      }
      // Lines only between lit particles, so the cost follows what's visible rather than the whole field.
      context!.lineWidth = 1;
      for (let i = 0; i < lit.length; i++) {
        for (let j = i + 1; j < lit.length; j++) {
          const strength = linkStrength(lit[i]!, lit[j]!);
          if (strength <= 0.01) continue;
          context!.strokeStyle = `rgba(129, 140, 248, ${strength * 0.45})`;
          context!.beginPath();
          context!.moveTo(lit[i]!.x, lit[i]!.y);
          context!.lineTo(lit[j]!.x, lit[j]!.y);
          context!.stroke();
        }
      }
      // Keep going while anything is moving or lit; otherwise wait for the next pointer movement.
      if (isOnScreen && !document.hidden && (!motionQuery.matches || lit.length > 0 || pointer)) schedule();
    }

    function schedule() {
      if (!animationFrame) animationFrame = requestAnimationFrame(draw);
    }

    function handlePointerMove(event: PointerEvent) {
      client = { x: event.clientX, y: event.clientY };
      schedule();
    }
    const handlePointerLeave = () => {
      client = null;
      schedule();
    };
    // A finger has no hover: once it lifts, there is nothing to stay lit around.
    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerType === 'touch') handlePointerLeave();
    };
    const handleVisibility = () => {
      lastTime = 0;
      if (!document.hidden) schedule();
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      isOnScreen = entry?.isIntersecting ?? true;
      lastTime = 0;
      if (isOnScreen) schedule();
    });
    visibilityObserver.observe(canvas);
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerup', handlePointerUp, { passive: true });
    window.addEventListener('blur', handlePointerLeave);
    document.documentElement.addEventListener('pointerleave', handlePointerLeave);
    document.addEventListener('visibilitychange', handleVisibility);
    motionQuery.addEventListener('change', schedule);
    schedule();

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('blur', handlePointerLeave);
      document.documentElement.removeEventListener('pointerleave', handlePointerLeave);
      document.removeEventListener('visibilitychange', handleVisibility);
      motionQuery.removeEventListener('change', schedule);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full [mask-image:linear-gradient(to_bottom,black_70%,transparent)] ${className}`}
    />
  );
}
