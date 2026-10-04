// Minimal ESRI shapefile (.shp) polygon reader plus a Lambert Conformal Conic inverse, enough to turn
// Texas Legislative Council plans (NAD83 LCC, meters) into lon/lat GeoJSON without GIS dependencies.
import { readFileSync } from "node:fs";

/** Read polygon/polyline records from a .shp file. Returns [{ recordNumber, rings: [[[x,y],...], ...] }]. */
export function readShapefile(path) {
  const buffer = readFileSync(path);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const fileLength = view.getInt32(24, false) * 2; // 16-bit words, big-endian
  let offset = 100;
  const records = [];
  while (offset < fileLength) {
    const recordNumber = view.getInt32(offset, false);
    const contentLength = view.getInt32(offset + 4, false) * 2;
    const start = offset + 8;
    const shapeType = view.getInt32(start, true);
    if (shapeType === 5 || shapeType === 15 || shapeType === 25) {
      const numParts = view.getInt32(start + 36, true);
      const numPoints = view.getInt32(start + 40, true);
      const parts = [];
      for (let i = 0; i < numParts; i += 1) parts.push(view.getInt32(start + 44 + i * 4, true));
      const pointsStart = start + 44 + numParts * 4;
      const points = [];
      for (let i = 0; i < numPoints; i += 1) points.push([view.getFloat64(pointsStart + i * 16, true), view.getFloat64(pointsStart + i * 16 + 8, true)]);
      const rings = parts.map((p, i) => points.slice(p, i + 1 < parts.length ? parts[i + 1] : numPoints));
      records.push({ recordNumber, rings });
    } else if (shapeType !== 0) {
      throw new Error(`Unsupported shape type ${shapeType}`);
    }
    offset = start + contentLength;
  }
  return records;
}

/** Read a .dbf and return an array of attribute objects (one per record), enough for district numbers. */
export function readDbf(path) {
  const buffer = readFileSync(path);
  const recordCount = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const fields = [];
  for (let position = 32; position < headerLength - 1; position += 32) {
    if (buffer[position] === 0x0d) break;
    const name = buffer.toString("ascii", position, position + 11).replace(/\0.*$/, "").trim();
    const type = String.fromCharCode(buffer[position + 11]);
    const length = buffer[position + 16];
    fields.push({ name, type, length });
  }
  const records = [];
  for (let r = 0; r < recordCount; r += 1) {
    let cursor = headerLength + r * recordLength + 1; // skip deletion flag
    const record = {};
    for (const field of fields) {
      const raw = buffer.toString("latin1", cursor, cursor + field.length).trim();
      record[field.name] = field.type === "N" || field.type === "F" ? Number(raw) : raw;
      cursor += field.length;
    }
    records.push(record);
  }
  return { fields, records };
}

/** Lambert Conformal Conic (2SP) inverse on the GRS80 ellipsoid; parameters as in the TLC .prj files. */
export function lambertConformalConicInverse({ falseEasting, falseNorthing, centralMeridian, standardParallel1, standardParallel2, latitudeOfOrigin }) {
  const a = 6378137.0;
  const f = 1 / 298.257222101;
  const e = Math.sqrt(2 * f - f * f);
  const rad = (d) => (d * Math.PI) / 180;
  const phi1 = rad(standardParallel1), phi2 = rad(standardParallel2), phi0 = rad(latitudeOfOrigin), lambda0 = rad(centralMeridian);
  const m = (phi) => Math.cos(phi) / Math.sqrt(1 - e * e * Math.sin(phi) ** 2);
  const t = (phi) => Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi)), e / 2);
  const n = (Math.log(m(phi1)) - Math.log(m(phi2))) / (Math.log(t(phi1)) - Math.log(t(phi2)));
  const F = m(phi1) / (n * Math.pow(t(phi1), n));
  const rho0 = a * F * Math.pow(t(phi0), n);
  return ([x, y]) => {
    const dx = x - falseEasting;
    const dy = rho0 - (y - falseNorthing);
    const rho = Math.sign(n) * Math.sqrt(dx * dx + dy * dy);
    const theta = Math.atan2(dx, dy);
    const tPrime = Math.pow(rho / (a * F), 1 / n);
    let phi = Math.PI / 2 - 2 * Math.atan(tPrime);
    for (let i = 0; i < 8; i += 1) {
      phi = Math.PI / 2 - 2 * Math.atan(tPrime * Math.pow((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi)), e / 2));
    }
    const lambda = lambda0 + theta / n;
    return [Math.round((lambda * 180) / Math.PI * 1e5) / 1e5, Math.round((phi * 180) / Math.PI * 1e5) / 1e5];
  };
}
