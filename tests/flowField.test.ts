import { describe, expect, it } from 'vitest';
import { Tile, TileGrid } from '../src/world/grid';
import { FlowField } from '../src/systems/flowField';

describe('FlowField', () => {
  it('routes around a wall instead of through it', () => {
    // Room with a vertical wall at x=5 that has a gap only at the bottom (z=7).
    const g = new TileGrid(11, 10);
    g.fillRect(1, 1, 9, 7, Tile.Floor);
    for (let z = 1; z <= 6; z++) g.set(5, z, Tile.Wall);
    const f = new FlowField(g);
    f.update(8.5, 2.5);
    // Follow the field from the left side; we must reach the target.
    const pos = { x: 2.5, z: 2.5 };
    for (let i = 0; i < 40 && f.distanceAt(pos.x, pos.z) > 0; i++) {
      const step = f.nextStep(pos.x, pos.z);
      expect(step).not.toBeNull();
      pos.x = step!.x;
      pos.z = step!.z;
      expect(g.isWalkableAt(pos.x, pos.z)).toBe(true);
    }
    expect(f.distanceAt(pos.x, pos.z)).toBe(0);
  });

  it('marks unreachable tiles as -1', () => {
    const g = new TileGrid(10, 5);
    g.fillRect(1, 1, 3, 3, Tile.Floor);
    g.fillRect(6, 1, 3, 3, Tile.Floor);
    const f = new FlowField(g);
    f.update(2.5, 2.5);
    expect(f.distanceAt(7.5, 2.5)).toBe(-1);
    expect(f.nextStep(7.5, 2.5)).toBeNull();
  });
});

describe('FlowField with several targets', () => {
  it('leads each tile toward the nearest target', () => {
    const grid = new TileGrid(20, 3);
    grid.fillRect(0, 1, 20, 1, Tile.Floor);
    const flow = new FlowField(grid);
    flow.updateMany([
      { x: 1.5, z: 1.5 },
      { x: 18.5, z: 1.5 },
    ]);
    expect(flow.distanceAt(4.5, 1.5)).toBe(3);
    expect(flow.distanceAt(15.5, 1.5)).toBe(3);
    expect(flow.nextStep(4.5, 1.5)!.x).toBe(3.5);
    expect(flow.nextStep(15.5, 1.5)!.x).toBe(16.5);
  });
});
