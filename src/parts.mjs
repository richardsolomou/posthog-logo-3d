import fs from "node:fs";
import path from "node:path";
import { DOMParser } from "linkedom";
import Module from "manifold-3d";
import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

globalThis.DOMParser = DOMParser;
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((r) => {
      this.result = r;
      this.onloadend?.();
    });
  }
};

const outDir = process.argv[2];

// All dimensions in mm.
const SCALE = 2; // SVG is 52 units wide -> ~104 mm
const THICKNESS = 8;
const PIECE_INSET = 0.1; // per side, so neighbours have a 0.2 mm gap
const EYE_INSET = 0.15;
const TENON_LENGTH = 4; // how far it reaches into the neighbour
const TENON_WIDTH = 5; // along the seam
const TENON_BOTTOM = 1.2; // at the root; the underside rises at 45 degrees so it prints without supports
const TENON_TOP = 6.8;
const TENON_CLEARANCE = 0.15; // per side, leaves room for glue
const RIB = 0.3; // crush ribs on each side, so the fit is RIB - TENON_CLEARANCE tight
const TENON_SPOTS = [0.25, 0.75]; // along each seam

const wasm = await Module();
wasm.setup();
const { CrossSection, Manifold } = wasm;

const data = new SVGLoader().parse(
  fs.readFileSync(new URL("posthog-logomark.svg", import.meta.url), "utf8"),
);
const toPts = (pts) => pts.map((p) => [p.x * SCALE, -p.y * SCALE]);
const pathSections = data.paths.map((p) => {
  const polys = p.toShapes(true).flatMap((s) => {
    const { shape, holes } = s.extractPoints(48);
    return [toPts(shape), ...holes.map(toPts)];
  });
  return new CrossSection(polys, "EvenOdd");
});

// SVG path order: 0-2 blue, 3-5 orange, 6-8 yellow, 9 head (with the eye as a hole).
const groups = { blue: [0, 1, 2], orange: [3, 4, 5], yellow: [6, 7, 8], head: [9] };
const COLORS = {
  blue: "#1d4aff",
  orange: "#f54e00",
  yellow: "#f9bd2b",
  head: "#151515",
  eye: "#ffffff",
};

// The pieces meet along vertical lines in the SVG; tenons cross each one horizontally.
const SEAMS = [
  { x: 10.74, left: "blue", right: "orange" },
  { x: 21.96, left: "orange", right: "yellow" },
  { x: 33.28, left: "yellow", right: "head" },
];

// Grow-union-shrink closes hairline slivers between the SVG's abutting sub-paths.
const outlines = Object.fromEntries(
  Object.entries(groups).map(([name, idx]) => [
    name,
    CrossSection.union(idx.map((i) => pathSections[i].offset(0.05, "Round"))).offset(
      -(0.05 + PIECE_INSET),
      "Round",
    ),
  ]),
);
const solids = Object.fromEntries(
  Object.entries(outlines).map(([name, cs]) => [name, cs.extrude(THICKNESS)]),
);

// Vertical extent both neighbours share just either side of the seam.
const seamSpan = (x, a, b) => {
  const probe = (name, side) =>
    outlines[name]
      .intersect(CrossSection.square([1, 200]).translate([x * SCALE + side * 1.5 - 0.5, -150]))
      .bounds();
  const [ba, bb] = [probe(a, -1), probe(b, 1)];
  return [Math.max(ba.min[1], bb.min[1]), Math.min(ba.max[1], bb.max[1])];
};

const L = TENON_LENGTH;
const profile = new CrossSection([
  [-0.6, TENON_BOTTOM],
  [0, TENON_BOTTOM],
  [L, TENON_BOTTOM + L],
  [L, TENON_TOP - 0.5],
  [L - 0.5, TENON_TOP],
  [-0.6, TENON_TOP],
]);
// Profile is drawn in (across-seam, thickness); extrude along the seam, then stand it up.
const prism = (cs, width) =>
  cs
    .extrude(width)
    .rotate([90, 0, 0])
    .translate([0, width / 2, 0]);
const ribs = [-1, 1].map((side) =>
  Manifold.cube([L - 0.8, RIB * 2, 0.8], true).translate([
    0.4 + (L - 0.8) / 2,
    (side * TENON_WIDTH) / 2,
    TENON_TOP - 1.1,
  ]),
);
const tenon = Manifold.union([prism(profile, TENON_WIDTH), ...ribs]);
const pocket = prism(profile.offset(TENON_CLEARANCE, "Miter"), TENON_WIDTH + TENON_CLEARANCE * 2);

for (const { x, left, right } of SEAMS) {
  const [y0, y1] = seamSpan(x, left, right);
  const ys = TENON_SPOTS.map((t) => y0 + (y1 - y0) * t);
  for (const y of ys) {
    const at = [x * SCALE, y, 0];
    solids[left] = solids[left].add(tenon.translate(at));
    solids[right] = solids[right].subtract(pocket.translate(at));
  }
  console.log(`seam ${left}/${right}: tenons at y`, ys.map((y) => y.toFixed(1)).join(", "));
}

const eyeHole = new CrossSection(
  toPts(data.paths[9].toShapes(true)[0].extractPoints(48).holes[0]),
  "EvenOdd",
);
solids.eye = eyeHole.offset(-EYE_INSET, "Round").extrude(THICKNESS);

const toMesh = (m, color) => {
  const { vertProperties, triVerts, numProp } = m.getMesh();
  const pos = new Float32Array((vertProperties.length / numProp) * 3);
  for (let i = 0; i < pos.length / 3; i++)
    pos.set(vertProperties.slice(i * numProp, i * numProp + 3), i * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(triVerts, 1));
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  return new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
};

fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (f.endsWith(".stl")) fs.rmSync(path.join(outDir, f));
const scene = new THREE.Scene();
for (const [name, solid] of Object.entries(solids)) {
  if (solid.status() !== "NoError") throw new Error(`${name}: ${solid.status()}`);
  const mesh = toMesh(solid, COLORS[name]);
  mesh.name = name;
  scene.add(mesh);
  const b = solid.boundingBox();
  const print = toMesh(
    solid.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]]),
    COLORS[name],
  );
  fs.writeFileSync(
    path.join(outDir, `${name}.stl`),
    Buffer.from(new STLExporter().parse(print, { binary: true }).buffer),
  );
  console.log(
    name,
    [0, 1, 2].map((i) => (b.max[i] - b.min[i]).toFixed(1)).join(" x "),
    "mm, genus",
    solid.genus(),
  );
}

const center = new THREE.Box3().setFromObject(scene).getCenter(new THREE.Vector3());
for (const m of scene.children) m.position.sub(center);
fs.writeFileSync(
  path.join(outDir, "assembled.glb"),
  Buffer.from(await new GLTFExporter().parseAsync(scene, { binary: true })),
);

// Assembled, only the crush ribs may overlap a neighbour.
const ribOverlap = 2 * (RIB - TENON_CLEARANCE) * 0.8 * (L - 0.8) * TENON_SPOTS.length;
const neighbours = new Set(SEAMS.map(({ left, right }) => `${left}/${right}`));
const names = Object.keys(solids);
for (let a = 0; a < names.length; a++)
  for (let b = a + 1; b < names.length; b++) {
    const pair = `${names[a]}/${names[b]}`;
    const v = solids[names[a]].intersect(solids[names[b]]).volume();
    const expected = neighbours.has(pair) ? ribOverlap : 0;
    if (Math.abs(v - expected) > 1e-3)
      throw new Error(`${pair} overlap is ${v.toFixed(3)} mm3, expected ${expected.toFixed(3)}`);
  }
