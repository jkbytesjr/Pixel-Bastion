/** Pure hit-test helpers for melee attacks. */

/** Smallest signed difference between two angles, in [-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Is a target circle inside a melee arc?
 * `facing` uses the same convention as the models: atan2(dx, dz).
 */
export function inArc(
  ox: number,
  oz: number,
  facing: number,
  tx: number,
  tz: number,
  range: number,
  arc: number,
  targetRadius: number,
): boolean {
  const dx = tx - ox;
  const dz = tz - oz;
  const dist = Math.hypot(dx, dz);
  if (dist > range + targetRadius) return false;
  // Very close targets are always hit, so enemies hugging the player can't dodge the arc.
  if (dist < targetRadius + 0.3) return true;
  // Widen the arc by the target's angular size.
  const slack = Math.asin(Math.min(1, targetRadius / dist));
  return Math.abs(angleDiff(Math.atan2(dx, dz), facing)) <= arc / 2 + slack;
}

// ---- Tactics: elements, high ground, exposed windows ----

/** The element each weapon power deals. */
export type Element = 'fire' | 'frost' | 'lightning' | 'force';

export const POWER_ELEMENT = {
  ignite: 'fire',
  frost: 'frost',
  chain: 'lightning',
  shockwave: 'force',
  detonate: 'fire',
} as const satisfies Record<string, Element>;

/** Damage multipliers by element: above 1 is a weakness, below 1 a resistance. Missing = 1. */
export type Affinity = Partial<Record<Element, number>>;

/**
 * What each monster (and boss) is weak or resistant to, so the right weapon
 * powers matter: burn the spiders, shock the wraiths, freeze the exploders.
 */
export const AFFINITIES: Record<string, Affinity> = {
  grunt: { fire: 1.5 },
  archer: { lightning: 1.5, frost: 0.75 },
  exploder: { frost: 1.75, fire: 0.25 },
  spider: { fire: 1.75, force: 1.25 },
  shieldbearer: { lightning: 1.75, force: 0.6 },
  shaman: { frost: 1.5, fire: 0.6 },
  wraith: { lightning: 1.75, frost: 0.4, force: 0.5 },
  colossus: { frost: 1.4, force: 0.5 },
  huntress: { lightning: 1.4, frost: 0.7 },
  pyromancer: { frost: 1.5, fire: 0.2 },
  necromancer: { fire: 1.5, frost: 0.6 },
};

/** Multiplier for `element` against a monster kind (or boss kind). */
export function affinity(kind: string, element: Element): number {
  return AFFINITIES[kind]?.[element] ?? 1;
}

/** How a multiplier reads to the player. */
export function affinityLabel(mult: number): 'weak' | 'resist' | null {
  return mult > 1.01 ? 'weak' : mult < 0.99 ? 'resist' : null;
}

/** Height difference (visual floor steps) that counts as higher ground. */
export const HIGH_GROUND = 0.2;
export const HIGH_GROUND_BONUS = 1.2;
export const LOW_GROUND_PENALTY = 0.85;

/** Damage multiplier for attacking from `attackerY` at a target standing at `targetY`. */
export function heightMult(attackerY: number, targetY: number): number {
  const d = attackerY - targetY;
  return d > HIGH_GROUND ? HIGH_GROUND_BONUS : d < -HIGH_GROUND ? LOW_GROUND_PENALTY : 1;
}

/** Extra damage taken while an enemy is exposed (recovering from its own attack). */
export const EXPOSED_MULT = 1.5;
