import { describe, expect, it } from 'vitest';
import {
  LINK_DISTANCE,
  REACH,
  createParticles,
  linkStrength,
  proximity,
  stepParticle,
  type Particle,
} from '../../frontend/src/core/effects/particles';

/** A repeatable random source, so the tests don't depend on luck. */
function seeded(seed = 7) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

const particleAt = (x: number, y: number, alpha = 0): Particle => ({ x, y, vx: 0, vy: 0, size: 1, alpha, phase: 0, tint: 0 });
const field = { width: 800, height: 400 };
const run = (particle: Particle, frames: number, pointer: { x: number; y: number } | null, options = {}) => {
  for (let i = 0; i < frames; i++) stepParticle(particle, 1 / 60, i / 60, field, pointer, options);
};

describe('particle field maths', () => {
  it('lights a particle fully on the pointer and not at all at the edge of its reach', () => {
    expect(proximity(0)).toBe(1);
    expect(proximity(REACH)).toBe(0);
    expect(proximity(REACH * 3)).toBe(0);
    expect(proximity(REACH / 2)).toBeCloseTo(0.5, 5);
  });

  it('gets steadily dimmer with distance, with no sudden edge', () => {
    let previous = 1;
    for (let d = 1; d < REACH; d += 5) {
      const lit = proximity(d);
      expect(lit).toBeLessThanOrEqual(previous);
      previous = lit;
    }
    expect(proximity(REACH - 1)).toBeLessThan(0.001);
  });

  it('scatters particles inside the field, invisible to begin with, more on a bigger field and never too many', () => {
    const small = createParticles(400, 300, seeded());
    const large = createParticles(1600, 900, seeded());
    expect(small.length).toBeGreaterThan(10);
    expect(large.length).toBeGreaterThan(small.length);
    expect(createParticles(8000, 8000, seeded()).length).toBeLessThanOrEqual(240);
    expect(small.every((p) => p.x >= 0 && p.x <= 400 && p.y >= 0 && p.y <= 300 && p.alpha === 0)).toBe(true);
    expect(createParticles(0, 300)).toEqual([]);
    expect(createParticles(400, 300, seeded(1))).toEqual(createParticles(400, 300, seeded(1)));
  });

  it('keeps a far-away particle invisible however long the pointer is around', () => {
    const particle = particleAt(700, 350);
    run(particle, 240, { x: 50, y: 50 });
    expect(particle.alpha).toBe(0);
  });

  it('lights a particle quickly when the pointer comes near', () => {
    const particle = particleAt(400, 200);
    run(particle, 30, { x: 410, y: 205 });
    expect(particle.alpha).toBeGreaterThan(0.9);
    const edge = particleAt(400, 200);
    run(edge, 60, { x: 400 + REACH * 0.6, y: 200 });
    expect(edge.alpha).toBeGreaterThan(0.1);
    expect(edge.alpha).toBeLessThan(0.9); // nearer is brighter
  });

  it('fades out gradually once the pointer leaves, rather than vanishing', () => {
    const particle = particleAt(400, 200, 1);
    run(particle, 5, null);
    expect(particle.alpha).toBeGreaterThan(0.5);
    run(particle, 300, null);
    expect(particle.alpha).toBe(0);
  });

  it('drifts, and wraps around the edge instead of leaving', () => {
    const drifting = { ...particleAt(799, 200), vx: 1.5 };
    run(drifting, 20, null);
    expect(drifting.x).toBeLessThan(100); // came back in from the left
    const still = particleAt(300, 200);
    run(still, 120, null);
    expect(Math.hypot(still.x - 300, still.y - 200)).toBeGreaterThan(0.5); // the slow wobble
  });

  it('does not fling particles after a long pause such as a background tab', () => {
    const particle = { ...particleAt(400, 200), vx: 1 };
    stepParticle(particle, 30, 0, field, null);
    expect(Math.abs(particle.x - 400)).toBeLessThan(10);
  });

  it('with reduced motion nothing moves, and brightness simply follows the pointer', () => {
    const particle = { ...particleAt(400, 200), vx: 2, vy: 2 };
    run(particle, 60, { x: 400, y: 200 }, { reduceMotion: true });
    expect([particle.x, particle.y]).toEqual([400, 200]);
    expect(particle.alpha).toBe(1);
    run(particle, 1, null, { reduceMotion: true });
    expect(particle.alpha).toBe(0);
  });

  it('joins only lit, nearby particles, more strongly the closer and brighter they are', () => {
    const a = particleAt(0, 0, 1);
    expect(linkStrength(a, particleAt(LINK_DISTANCE, 0, 1))).toBe(0);
    expect(linkStrength(a, particleAt(10, 0, 0))).toBe(0);
    const near = linkStrength(a, particleAt(20, 0, 1));
    const far = linkStrength(a, particleAt(70, 0, 1));
    const dim = linkStrength(a, particleAt(20, 0, 0.3));
    expect(near).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(dim);
    expect(far).toBeGreaterThan(0);
  });
});
