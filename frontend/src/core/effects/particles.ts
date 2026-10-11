// The maths behind the landing page's particle field, kept free of the canvas and React so it can be tested.
// Particles are invisible until the pointer comes near; they fade in as it approaches and out as it leaves.

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radius in CSS pixels. */
  size: number;
  /** 0 (invisible) to 1 (fully lit). */
  alpha: number;
  /** Offsets the slow wobble so particles don't move in step. */
  phase: number;
  /** Index into the palette. */
  tint: number;
}

export interface Pointer {
  x: number;
  y: number;
}

/** How far from the pointer a particle starts to appear. */
export const REACH = 150;
/** Two lit particles closer than this are joined by a faint line. */
export const LINK_DISTANCE = 95;
/** Roughly one particle per this many square pixels. */
const AREA_PER_PARTICLE = 5200;
const MAX_PARTICLES = 240;
export const TINT_COUNT = 3;

/** Evenly scattered particles for a field of this size. `random` is injectable so tests are repeatable. */
export function createParticles(width: number, height: number, random: () => number = Math.random): Particle[] {
  if (width <= 0 || height <= 0) return [];
  const count = Math.min(MAX_PARTICLES, Math.round((width * height) / AREA_PER_PARTICLE));
  return Array.from({ length: count }, () => ({
    x: random() * width,
    y: random() * height,
    vx: (random() - 0.5) * 0.18,
    vy: (random() - 0.5) * 0.18,
    size: 0.9 + random() * 1.7,
    alpha: 0,
    phase: random() * Math.PI * 2,
    tint: Math.floor(random() * TINT_COUNT),
  }));
}

/** How lit a particle should be at this distance from the pointer: 1 on top of it, 0 at `reach` and beyond. */
export function proximity(distance: number, reach: number = REACH): number {
  if (distance >= reach) return 0;
  const closeness = 1 - Math.max(0, distance) / reach;
  return closeness * closeness * (3 - 2 * closeness); // smoothstep: no sudden edge to the lit area
}

export function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Moves a particle one frame and eases its brightness toward the target. It lights up quickly when the
 * pointer arrives and fades slowly when it leaves, which is what makes the trail feel alive.
 * With `reduceMotion` nothing drifts, and brightness follows the pointer without easing.
 */
export function stepParticle(
  particle: Particle,
  frameSeconds: number,
  timeSeconds: number,
  size: { width: number; height: number },
  pointer: Pointer | null,
  options: { reduceMotion?: boolean } = {},
): void {
  const frames = Math.min(frameSeconds, 0.05) * 60; // 1 at 60fps; a long pause (background tab) doesn't fling particles
  if (!options.reduceMotion) {
    particle.x += (particle.vx + Math.sin(timeSeconds * 0.6 + particle.phase) * 0.06) * frames;
    particle.y += (particle.vy + Math.cos(timeSeconds * 0.5 + particle.phase) * 0.06) * frames;
    // Wrap around the edges so the field never empties.
    if (particle.x < -4) particle.x = size.width + 4;
    else if (particle.x > size.width + 4) particle.x = -4;
    if (particle.y < -4) particle.y = size.height + 4;
    else if (particle.y > size.height + 4) particle.y = -4;
  }
  const target = pointer ? proximity(distanceBetween(particle, pointer)) : 0;
  if (options.reduceMotion) {
    particle.alpha = target;
    return;
  }
  const easing = target > particle.alpha ? 0.22 : 0.05;
  particle.alpha += (target - particle.alpha) * Math.min(1, easing * frames);
  if (particle.alpha < 0.004) particle.alpha = 0;
}

/** How strong the line between two lit particles is: fades with distance and with the dimmer end. 0 when too far. */
export function linkStrength(a: Particle, b: Particle): number {
  const distance = distanceBetween(a, b);
  if (distance >= LINK_DISTANCE) return 0;
  return Math.min(a.alpha, b.alpha) * (1 - distance / LINK_DISTANCE);
}
