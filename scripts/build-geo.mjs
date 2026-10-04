// One-off: convert Texas Legislative Council KML district plans into compact TopoJSON.
// Usage: node scripts/build-geo.mjs <PlanH2316.kml> <PlanS2168.kml>
// Source plans (public domain, TLC): https://data.capitol.texas.gov/dataset/planh2316 and /plans2168
import { readFileSync, writeFileSync } from "node:fs";
import * as topojsonServer from "topojson-server";
import * as topojsonSimplify from "topojson-simplify";

const [houseKmlPath, senateKmlPath] = process.argv.slice(2);
if (!houseKmlPath || !senateKmlPath) {
  console.error("usage: node scripts/build-geo.mjs <house.kml> <senate.kml>");
  process.exit(1);
}

/** Parse a TLC KML plan into a GeoJSON FeatureCollection keyed by district number. */
function kmlToGeoJson(kmlText) {
  const features = [];
  const placemarkRegex = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  let placemarkMatch;
  while ((placemarkMatch = placemarkRegex.exec(kmlText))) {
    const placemark = placemarkMatch[1];
    const nameMatch = placemark.match(/<name>\s*District\s+(\d+)\s*<\/name>/);
    if (!nameMatch) continue;
    const districtNumber = Number(nameMatch[1]);
    const polygons = [];
    const polygonRegex = /<Polygon>([\s\S]*?)<\/Polygon>/g;
    let polygonMatch;
    while ((polygonMatch = polygonRegex.exec(placemark))) {
      const polygon = polygonMatch[1];
      const outer = polygon.match(/<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/);
      if (!outer) continue;
      const rings = [parseRing(outer[1])];
      const innerRegex = /<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g;
      let innerMatch;
      while ((innerMatch = innerRegex.exec(polygon))) rings.push(parseRing(innerMatch[1]));
      polygons.push(rings);
    }
    features.push({
      type: "Feature",
      id: districtNumber,
      properties: { district: districtNumber },
      geometry: polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0] }
        : { type: "MultiPolygon", coordinates: polygons },
    });
  }
  features.sort((a, b) => a.id - b.id);
  return { type: "FeatureCollection", features };
}

function parseRing(coordinateText) {
  return coordinateText
    .trim()
    .split(/\s+/)
    .map((triple) => {
      const [lon, lat] = triple.split(",").map(Number);
      return [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
    });
}

function buildTopology(name, geojson, targetPointCount) {
  // Quantize to a grid, build shared arcs, then simplify so adjacent districts keep matching borders.
  // The threshold is chosen so roughly `targetPointCount` vertices survive (TLC plans have ~0.5M).
  let topology = topojsonServer.topology({ [name]: geojson }, 3e5);
  topology = topojsonSimplify.presimplify(topology);
  const weights = [];
  for (const arc of topology.arcs) for (const point of arc) if (Number.isFinite(point[2])) weights.push(point[2]);
  weights.sort((a, b) => b - a);
  const threshold = weights[Math.min(targetPointCount, weights.length - 1)];
  topology = topojsonSimplify.simplify(topology, threshold);
  // Drop the per-point weights topojson-simplify leaves behind so the file stays small.
  topology.arcs = topology.arcs.map((arc) => arc.map(([x, y]) => [x, y]));
  return topology;
}

for (const [label, path, outputFile, targetPointCount] of [
  ["house", houseKmlPath, "public/geo/tx-house.json", 16000],
  ["senate", senateKmlPath, "public/geo/tx-senate.json", 7000],
]) {
  const geojson = kmlToGeoJson(readFileSync(path, "utf8"));
  const topology = buildTopology("districts", geojson, targetPointCount);
  const json = JSON.stringify(topology);
  writeFileSync(outputFile, json);
  console.log(`${label}: ${geojson.features.length} districts -> ${outputFile} (${(json.length / 1024).toFixed(0)} KB)`);
}
