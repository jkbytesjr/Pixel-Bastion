/** Dodge-roll stamina. Pure logic, unit-tested. */

export const STAMINA_MAX = 100;
/** Each roll costs this much: about three rolls from full. */
export const DODGE_COST = 34;
/** Stamina per second once it starts refilling. */
export const STAMINA_REGEN = 32;
/** Seconds after spending before stamina refills. */
export const STAMINA_DELAY = 0.75;

export interface Stamina {
  value: number;
  /** Seconds left before regeneration resumes. */
  wait: number;
}

export function newStamina(): Stamina {
  return { value: STAMINA_MAX, wait: 0 };
}

/** Refill over time. `rate` scales the refill speed (faster cooldowns perk). */
export function tickStamina(s: Stamina, dt: number, rate = 1): void {
  if (s.wait > 0) {
    s.wait = Math.max(0, s.wait - dt);
    return;
  }
  s.value = Math.min(STAMINA_MAX, s.value + STAMINA_REGEN * rate * dt);
}

/** Spend `cost` if there's enough; returns whether it was spent. */
export function spendStamina(s: Stamina, cost: number): boolean {
  if (s.value < cost) return false;
  s.value -= cost;
  s.wait = STAMINA_DELAY;
  return true;
}
