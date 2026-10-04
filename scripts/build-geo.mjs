// One-off: convert Texas Legislative Council district plans into compact TopoJSON.
// Usage: node scripts/build-geo.mjs <PlanH2316.kml> <PlanS2168.kml> [<PLANC2333 shapefile dir>]
// Source plans (public domain, TLC): https://data.capitol.texas.gov/dataset/planh2316, /plans2168, /planc2333
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as topojsonServer from "topojson-server";
import * as topojsonSimplify from "topojson-simplify";
import { readShapefile, readDbf, lambertConformalConicInverse } from "./shapefile.mjs";

const [houseKmlPath, senateKmlPath, congressShapeDir] = process.argv.slice(2);
if (!houseKmlPath || !senateKmlPath) {
  console.error("usage: node scripts/build-geo.mjs <house.kml> <senate.kml> [<congress shapefile dir>]");
  process.exit(1);
}

/** TLC congressional plans ship as NAD83 Lambert Conformal Conic shapefiles; reproject to lon/lat GeoJSON. */
function shapefileToGeoJson(directory) {
  const base = readdirSync(directory).find((f) => f.toLowerCase().endsWith(".shp")).replace(/\.shp$/i, "");
  const prj = readFileSync(join(directory, `${base}.prj`), "utf8");
  const param = (name) => Number((prj.match(new RegExp(`PARAMETER\\["${name}",([-\\d.]+)\\]`)) || [])[1]);
  const inverse = lambertConformalConicInverse({
    falseEasting: param("False_Easting"), falseNorthing: param("False_Northing"), centralMeridian: param("Central_Meridian"),
    standardParallel1: param("Standard_Parallel_1"), standardParallel2: param("Standard_Parallel_2"), latitudeOfOrigin: param("Latitude_Of_Origin"),
  });
  const shapes = readShapefile(join(directory, `${base}.shp`));
  const { records } = readDbf(join(directory, `${base}.dbf`));
  const features = shapes.map((shape, index) => {
    const attributes = records[index] || {};
    const district = Number(attributes.District ?? attributes.DISTRICT ?? attributes.district ?? index + 1);
    // Shapefile rings: clockwise = outer, counter-clockwise = hole. Group holes with the preceding outer ring.
    const polygons = [];
    for (const ring of shape.rings) {
      const projected = ring.map(inverse);
      if (signedArea(ring) < 0 || polygons.length === 0) polygons.push([projected]); else polygons[polygons.length - 1].push(projected);
    }
    return { type: "Feature", id: district, properties: { district }, geometry: polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0] } : { type: "MultiPolygon", coordinates: polygons } };
  });
  features.sort((a, b) => a.id - b.id);
  return { type: "FeatureCollection", features };
}
function signedArea(ring) { let s = 0; for (let i = 0; i < ring.length - 1; i += 1) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]; return s / 2; }

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

const inputs = [
  ["house", () => kmlToGeoJson(readFileSync(houseKmlPath, "utf8")), "public/geo/tx-house.json", 16000],
  ["senate", () => kmlToGeoJson(readFileSync(senateKmlPath, "utf8")), "public/geo/tx-senate.json", 7000],
];
if (congressShapeDir) inputs.push(["congress", () => shapefileToGeoJson(congressShapeDir), "public/geo/tx-congress.json", 8000]);
for (const [label, load, outputFile, targetPointCount] of inputs) {
  const geojson = load();
  const topology = buildTopology("districts", geojson, targetPointCount);
  const json = JSON.stringify(topology);
  writeFileSync(outputFile, json);
  console.log(`${label}: ${geojson.features.length} districts -> ${outputFile} (${(json.length / 1024).toFixed(0)} KB)`);
}
