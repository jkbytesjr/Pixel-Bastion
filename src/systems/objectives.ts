/** Capture shrines, plate puzzles and brazier trials. Pure logic, unit-tested. */

export type CaptureState = 'idle' | 'capturing' | 'contested' | 'captured';
export const CAPTURE_STATES: readonly CaptureState[] = ['idle', 'capturing', 'contested', 'captured'];

/** Seconds for one hero to capture a shrine. */
export const CAPTURE_TIME = 14;
/** Each extra hero in the circle speeds it up by this much. */
export const CAPTURE_PER_EXTRA_HERO = 0.35;
/** An empty shrine slips back at this fraction of the capture speed. */
export const CAPTURE_DECAY = 0.4;

export interface Capture {
  /** 0..1 */
  progress: number;
  state: CaptureState;
}

export function newCapture(): Capture {
  return { progress: 0, state: 'idle' };
}

/**
 * Advance a capture. Heroes in the circle push it up; any monster in the
 * circle stops it (contested) until it's cleared out; an empty circle slowly
 * slips back. Returns true on the tick it becomes captured.
 */
export function tickCapture(c: Capture, dt: number, heroesInside: number, enemiesInside: number): boolean {
  if (c.state === 'captured') return false;
  if (heroesInside > 0 && enemiesInside > 0) {
    c.state = 'contested';
    return false;
  }
  if (heroesInside > 0) {
    c.state = 'capturing';
    c.progress = Math.min(1, c.progress + (dt / CAPTURE_TIME) * (1 + CAPTURE_PER_EXTRA_HERO * (heroesInside - 1)));
    if (c.progress >= 1) {
      c.state = 'captured';
      return true;
    }
    return false;
  }
  c.state = 'idle';
  c.progress = Math.max(0, c.progress - (dt / CAPTURE_TIME) * CAPTURE_DECAY);
  return false;
}

export type PlateResult = 'next' | 'wrong' | 'solved' | 'ignored';

/** A pressure-plate sequence: step on the plates in `order`. A wrong plate resets it. */
export class PlateSequence {
  /** How many plates of the order are done. */
  step = 0;
  solved = false;

  constructor(readonly order: readonly number[]) {}

  press(plate: number): PlateResult {
    if (this.solved) return 'ignored';
    // Re-pressing a plate that's already done (standing around) doesn't count against you.
    if (this.order.slice(0, this.step).includes(plate)) return 'ignored';
    if (this.order[this.step] !== plate) {
      this.step = 0;
      return 'wrong';
    }
    this.step++;
    if (this.step === this.order.length) {
      this.solved = true;
      return 'solved';
    }
    return 'next';
  }
}

export type BrazierResult = 'lit' | 'solved' | 'ignored';

/**
 * Light every brazier before the flames die: the first one lit starts the
 * clock, and if it runs out they all go dark and the trial starts over.
 */
export class BrazierTrial {
  readonly lit: boolean[];
  /** Seconds left before the lit braziers burn out (0 while none are lit). */
  left = 0;
  solved = false;

  constructor(
    count: number,
    readonly burn: number,
  ) {
    this.lit = new Array<boolean>(count).fill(false);
  }

  get litCount(): number {
    return this.lit.filter(Boolean).length;
  }

  light(i: number): BrazierResult {
    if (this.solved || this.lit[i]) return 'ignored';
    if (!this.litCount) this.left = this.burn;
    this.lit[i] = true;
    if (this.lit.every(Boolean)) {
      this.solved = true;
      this.left = 0;
      return 'solved';
    }
    return 'lit';
  }

  /** Returns true on the tick the flames burn out. */
  tick(dt: number): boolean {
    if (this.solved || !this.litCount) return false;
    this.left -= dt;
    if (this.left > 0) return false;
    this.left = 0;
    this.lit.fill(false);
    return true;
  }
}
