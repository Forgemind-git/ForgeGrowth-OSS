// The funnel counts who REACHED a stage, not who is standing in it — the old
// chart divided current headcounts and reported Engaged 48 → Hot 186 as "388%".
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../api.js', () => ({ api: {} }));
import { funnelRows } from '../FunnelViewerPage.jsx';

const live = [
  { stageKey: 'new', label: 'New', count: 626 },
  { stageKey: 'engaged', label: 'Engaged', count: 48 },
  { stageKey: 'hot', label: 'Hot', count: 186 },
  { stageKey: 'enrolled', label: 'Enrolled', count: 64 },
];

describe('funnelRows', () => {
  it('counts everyone in a stage or any later one as having reached it', () => {
    const r = funnelRows(live);
    expect(r.map(x => x.reached)).toEqual([924, 298, 250, 64]);
    expect(r.map(x => x.now)).toEqual([626, 48, 186, 64]);
  });
  it('never shows a step above 100%, even when a later stage holds more people now', () => {
    const r = funnelRows(live);
    for (const x of r.slice(1)) expect(x.step).toBeLessThanOrEqual(100);
    expect(r[2].step).toBe(83.9); // 250 of 298
  });
  it('reports the people lost between two stages', () => {
    const r = funnelRows(live);
    expect(r.map(x => x.dropped)).toEqual([0, 626, 48, 186]);
    expect(r[3].ofTop).toBe(6.9);
  });
  it('copes with an empty funnel and an empty top stage', () => {
    expect(funnelRows([])).toEqual([]);
    const r = funnelRows([{ stageKey: 'a', count: 0 }, { stageKey: 'b', count: 0 }]);
    expect(r[1].step).toBe(0);
    expect(r[0].ofTop).toBe(0);
  });
});
