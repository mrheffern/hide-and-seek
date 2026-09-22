import type { Coordinate } from "@hide-and-seek/protocol";

const EARTH_RADIUS_METERS = 6_371_008.8;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

export function distanceMeters(a: Coordinate, b: Coordinate): number {
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function pointInPolygon(point: Coordinate, polygon: Coordinate[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].longitude;
    const yi = polygon[i].latitude;
    const xj = polygon[j].longitude;
    const yj = polygon[j].latitude;
    // The drawn line belongs to the play area, including its vertices.
    const cross = (xj - xi) * (point.latitude - yi) - (yj - yi) * (point.longitude - xi);
    if (
      Math.abs(cross) <= 1e-12 &&
      point.longitude >= Math.min(xi, xj) - 1e-12 &&
      point.longitude <= Math.max(xi, xj) + 1e-12 &&
      point.latitude >= Math.min(yi, yj) - 1e-12 &&
      point.latitude <= Math.max(yi, yj) + 1e-12
    ) return true;
    const intersects =
      yi > point.latitude !== yj > point.latitude &&
      point.longitude < ((xj - xi) * (point.latitude - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function distanceToPolygonBoundaryMeters(point: Coordinate, polygon: Coordinate[]): number {
  if (polygon.length < 2) return Number.POSITIVE_INFINITY;
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos(radians(point.latitude));
  const project = (coordinate: Coordinate) => ({
    x: (coordinate.longitude - point.longitude) * metersPerDegreeLon,
    y: (coordinate.latitude - point.latitude) * metersPerDegreeLat,
  });
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = project(polygon[index]);
    const b = project(polygon[(index + 1) % polygon.length]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared));
    nearest = Math.min(nearest, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return nearest;
}

function orientation(a: Coordinate, b: Coordinate, c: Coordinate): number {
  return (
    (b.longitude - a.longitude) * (c.latitude - a.latitude) -
    (b.latitude - a.latitude) * (c.longitude - a.longitude)
  );
}

function segmentsIntersect(
  a: Coordinate,
  b: Coordinate,
  c: Coordinate,
  d: Coordinate,
): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  const epsilon = 1e-12;
  const onSegment = (start: Coordinate, end: Coordinate, point: Coordinate) =>
    Math.abs(orientation(start, end, point)) <= epsilon &&
    point.longitude >= Math.min(start.longitude, end.longitude) - epsilon &&
    point.longitude <= Math.max(start.longitude, end.longitude) + epsilon &&
    point.latitude >= Math.min(start.latitude, end.latitude) - epsilon &&
    point.latitude <= Math.max(start.latitude, end.latitude) + epsilon;
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return (
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}

export function validateBoundary(boundary: Coordinate[]): string | null {
  if (boundary.length < 3) return "Add at least three boundary points.";
  if (boundary.length > 64) return "Boundary is limited to 64 points.";
  for (const point of boundary) {
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.latitude) > 90 ||
      Math.abs(point.longitude) > 180
    ) {
      return "Boundary contains an invalid coordinate.";
    }
  }
  const uniquePoints = new Set(boundary.map((point) => `${point.latitude},${point.longitude}`));
  if (uniquePoints.size !== boundary.length) return "Boundary points must be unique.";
  const doubleArea = boundary.reduce((sum, point, index) => {
    const next = boundary[(index + 1) % boundary.length];
    return sum + point.longitude * next.latitude - next.longitude * point.latitude;
  }, 0);
  if (Math.abs(doubleArea) <= 1e-12) return "Boundary must enclose an area.";
  for (let i = 0; i < boundary.length; i += 1) {
    const a = boundary[i];
    const b = boundary[(i + 1) % boundary.length];
    for (let j = i + 1; j < boundary.length; j += 1) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === boundary.length - 1)) continue;
      const c = boundary[j];
      const d = boundary[(j + 1) % boundary.length];
      if (segmentsIntersect(a, b, c, d)) return "Boundary cannot cross itself.";
    }
  }
  return null;
}
