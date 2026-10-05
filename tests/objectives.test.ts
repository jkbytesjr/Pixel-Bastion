import { describe, expect, it } from 'vitest';
import { CAPTURE_TIME, PlateSequence, newCapture, tickCapture } from '../src/systems/objectives';

const run = (c: ReturnType<typeof newCapture>, seconds: number, heroes: number, enemies: number) => {
  let done = false;
  for (let i = 0; i < Math.round(seconds * 60); i++) done = tickCapture(c, 1 / 60, heroes, enemies) || done;
  return done;
};

describe('capture shrine', () => {
  it('captures after CAPTURE_TIME with one hero inside', () => {
    const c = newCapture();
    expect(run(c, CAPTURE_TIME - 0.5, 1, 0)).toBe(false);
    expect(c.state).toBe('capturing');
    expect(run(c, 1, 1, 0)).toBe(true);
    expect(c.state).toBe('captured');
    expect(c.progress).toBe(1);
  });

  it('is faster with more heroes', () => {
    const solo = newCapture();
    const trio = newCapture();
    run(solo, 5, 1, 0);
    run(trio, 5, 3, 0);
    expect(trio.progress).toBeGreaterThan(solo.progress * 1.5);
  });

  it('stalls while a monster is inside, and slips back when left alone', () => {
    const c = newCapture();
    run(c, 5, 1, 0);
    const p = c.progress;
    run(c, 3, 1, 2);
    expect(c.state).toBe('contested');
    expect(c.progress).toBe(p);
    run(c, 3, 0, 0);
    expect(c.state).toBe('idle');
    expect(c.progress).toBeLessThan(p);
    expect(c.progress).toBeGreaterThan(0);
  });

  it('stays captured', () => {
    const c = newCapture();
    run(c, CAPTURE_TIME + 1, 1, 0);
    run(c, 30, 0, 5);
    expect(c.state).toBe('captured');
  });
});

describe('plate sequence', () => {
  it('opens when the plates are pressed in order', () => {
    const s = new PlateSequence([2, 0, 1]);
    expect(s.press(2)).toBe('next');
    expect(s.press(0)).toBe('next');
    expect(s.press(1)).toBe('solved');
    expect(s.press(0)).toBe('ignored');
  });

  it('a wrong plate resets it; standing on a done plate does not', () => {
    const s = new PlateSequence([1, 2, 0]);
    expect(s.press(1)).toBe('next');
    expect(s.press(1)).toBe('ignored');
    expect(s.press(0)).toBe('wrong');
    expect(s.step).toBe(0);
    expect(s.press(1)).toBe('next');
    expect(s.press(2)).toBe('next');
    expect(s.press(0)).toBe('solved');
  });
});
