import { describe, expect, it } from 'bun:test';
import { inboxViewOptions, lensSegments } from './inboxViews';

describe('the phone inbox view picker', () => {
  it('offers By priority, after By status, only while the workspace has Priorities on', () => {
    const on = inboxViewOptions({ hasPriorities: true, hasLabels: false, hasPlans: false });
    expect(on.map((o) => o.key)).toEqual(['grouped', 'priorities', 'recent', 'time']);
    expect(on.find((o) => o.key === 'priorities')!.label).toBe('By priority');
    const off = inboxViewOptions({ hasPriorities: false, hasLabels: true, hasPlans: true });
    expect(off.map((o) => o.key)).toEqual(['grouped', 'recent', 'time', 'bucket', 'plan']);
  });

  it("the bar's segments carry Priorities while it is on, and always the view in use", () => {
    expect(lensSegments('grouped', true)).toEqual(['grouped', 'priorities', 'recent', 'time']);
    expect(lensSegments('priorities', true)).toEqual(['grouped', 'priorities', 'recent', 'time']);
    expect(lensSegments('grouped', false)).toEqual(['grouped', 'recent', 'time']);
    // Picked on the desktop while it is off here: still shown, so the switch never hides the list's view.
    expect(lensSegments('priorities', false)).toEqual(['grouped', 'recent', 'time', 'priorities']);
    expect(lensSegments('bucket', true)).toEqual(['grouped', 'priorities', 'recent', 'time', 'bucket']);
  });
});
