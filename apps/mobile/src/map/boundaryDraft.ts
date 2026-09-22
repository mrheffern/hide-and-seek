import type { Coordinate } from "@hide-and-seek/protocol";

interface MapPressLike {
  nativeEvent?: {
    coordinate?: unknown;
  } | null;
}

export function coordinateFromMapPress(event: MapPressLike | null | undefined): Coordinate | null {
  const value = event?.nativeEvent?.coordinate;
  if (!value || typeof value !== "object") return null;
  const latitude = (value as Partial<Coordinate>).latitude;
  const longitude = (value as Partial<Coordinate>).longitude;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }
  // Return a plain copy. React Native may release and null the synthetic event
  // immediately after the callback returns.
  return { latitude, longitude };
}

export function appendBoundaryPoint(
  current: readonly Coordinate[],
  point: Coordinate,
  limit = 64,
): Coordinate[] {
  if (current.length >= limit) return current.slice(0, limit);
  return [...current, { ...point }];
}
