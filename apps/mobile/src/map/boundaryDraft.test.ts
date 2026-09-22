import { describe, expect, it } from "vitest";
import { appendBoundaryPoint, coordinateFromMapPress } from "./boundaryDraft";

describe("boundary map presses", () => {
  it("copies a coordinate before React Native releases the synthetic event", () => {
    const event: { nativeEvent: { coordinate: { latitude: number; longitude: number } } | null } = {
      nativeEvent: { coordinate: { latitude: 34, longitude: -118 } },
    };
    const coordinate = coordinateFromMapPress(event);
    event.nativeEvent = null;
    expect(coordinate).toEqual({ latitude: 34, longitude: -118 });
  });

  it("ignores released, missing, and invalid coordinates", () => {
    expect(coordinateFromMapPress(null)).toBeNull();
    expect(coordinateFromMapPress({ nativeEvent: null })).toBeNull();
    expect(coordinateFromMapPress({ nativeEvent: {} })).toBeNull();
    expect(
      coordinateFromMapPress({ nativeEvent: { coordinate: { latitude: Number.NaN, longitude: -118 } } }),
    ).toBeNull();
    expect(
      coordinateFromMapPress({ nativeEvent: { coordinate: { latitude: 91, longitude: -118 } } }),
    ).toBeNull();
  });

  it("appends without mutating the existing draft", () => {
    const current = [{ latitude: 34, longitude: -118 }];
    const next = appendBoundaryPoint(current, { latitude: 34.001, longitude: -118.001 });
    expect(current).toHaveLength(1);
    expect(next).toEqual([
      { latitude: 34, longitude: -118 },
      { latitude: 34.001, longitude: -118.001 },
    ]);
  });

  it("caps a boundary at the server-supported maximum", () => {
    const current = Array.from({ length: 64 }, (_, index) => ({
      latitude: 34 + index / 100_000,
      longitude: -118,
    }));
    expect(appendBoundaryPoint(current, { latitude: 35, longitude: -118 })).toHaveLength(64);
  });
});
