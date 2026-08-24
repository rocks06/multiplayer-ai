import { describe, expect, it } from "vitest";
import { SequenceTracker } from "../apps/api/src/realtime/protocol.js";

describe("realtime sequence protocol", () => {
  it("ignores duplicates without advancing application state", () => {
    const tracker = new SequenceTracker(4);
    expect(tracker.observe(4)).toBe("duplicate");
    expect(tracker.contiguousSeq).toBe(4);
  });

  it("detects a gap and advances only after missing events arrive", () => {
    const tracker = new SequenceTracker(4);
    expect(tracker.observe(6)).toBe("gap");
    expect(tracker.contiguousSeq).toBe(4);
    expect(tracker.observe(5)).toBe("next");
    expect(tracker.observe(6)).toBe("next");
    expect(tracker.contiguousSeq).toBe(6);
  });
});
