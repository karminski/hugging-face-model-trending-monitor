import { describe, expect, it } from "vitest";
import { applyDelta, encodeDelta } from "./device.js";

describe("scene deltas", () => {
  it("round-trips sparse and dense changes", () => {
    const from = Buffer.alloc(9504);
    for (let i = 0; i < from.length; i++) from[i] = (i * 37) & 0xff;
    const to = Buffer.from(from);
    for (const i of [0, 1, 5, 9, 600, 9503]) to[i] ^= 0x5a;
    to.fill(0xff, 2000, 2600);

    const delta = encodeDelta(from, to);
    const frame = Buffer.from(from);
    applyDelta(frame, delta);
    expect(frame.equals(to)).toBe(true);
    expect(delta.length).toBeLessThan(700);
  });

  it("encodes identical frames as an empty delta", () => {
    const frame = Buffer.alloc(64, 3);
    expect(encodeDelta(frame, Buffer.from(frame))).toEqual(Buffer.from([0, 0, 0, 0]));
  });
});
