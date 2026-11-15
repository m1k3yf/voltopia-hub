// Voltopia: Dragon Mode.
//
// You are the dragon of the cave above the town. Brigands creep in with torches after the
// town's treasures; hold Space and they jump, drop everything and run. Nothing here can be
// lost for good and the dragon cannot crash: see "flight" below for how that is guaranteed.
//
// Conventions shared with index.html:
//   game (x, y) is metres east and north of Piazza Roma; height is kept separately.
//   three.js position = (x, height, -y): Y is up and north is -Z.
//   A heading `hd` is a rotation about Y. Forward is (-sin hd, 0, -cos hd), so hd = 0 looks
//   north and a growing hd turns left. A compass bearing b (0 north, 90 east) is hd = -b.
//
// Titles, card text, colours, counts and positions all come from dragon.json.
// Nothing is built until the mode is first entered, so walking mode pays nothing for it.

import * as THREE from 'three';

const TAU = Math.PI * 2, DEG = Math.PI / 180;
const CENTRE_X = 60, CENTRE_Y = 0;            // the same centre walking mode uses for its boundary
const SOFT_R = 430, SOFT_BAND = 85;           // past SOFT_R the dragon is steered home, fully so by SOFT_R + SOFT_BAND (still over the terrain)
const CRUISE = 30, BURST = 52;                // m/s
const TURN = 1.3, CLIMB = 16;                 // rad/s and m/s at full stick
const CLEAR = 7;                              // metres kept between the dragon and whatever is below it
const CEILING = 85, SINK_ABOVE = 60;          // metres above that floor: hard-ish top, and where a hands-off dragon drifts back down to
const FIRE_RANGE = 80, FIRE_CLOSE = 14;       // metres along the ground: the cone's reach, and "right underneath counts too"
const FIRE_COS = Math.cos(35 * DEG);          // half-angle of the cone, measured on the ground from the dragon's heading
const FIRE_DROP = 120;                        // fire does not reach further down than this
const MAX_RAIDERS = 40, RAIDER_SCALE = 1.9;   // figures are drawn oversized so they read from the air
const CARRY_K = .6, FLEE_SPEED = 16;          // a treasure slows its carrier; a singed brigand does not hang about
const CELL = 3, ROOF_CELL = 6;                // metres: path grid and roof map resolution
const HOME = 0, CARRIED = 1, RETURNING = 2, LOST = 3;   // treasure states
const WALK = 0, JUMP = 1, FLEE = 2, POOF = 3;           // raider states
const HALOS = 48;                             // glow sprites for torches, treasure and the cave

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const mix = (a, b, k) => a + (b - a) * k;
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);                 // frame-rate independent smoothing factor
const wrap = a => { a = (a + Math.PI) % TAU; return (a < 0 ? a + TAU : a) - Math.PI; };
const Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1), DOWN = new THREE.Vector3(0, -1, 0), ONE = new THREE.Vector3(1, 1, 1);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------- geometry helpers (build time only)

const _c = new THREE.Color();
function M(px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(V(px, py, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), V(sx, sy, sz));
}
// Bake a transform into a primitive and give it flat faces and a vertex colour.
// `color` is a hex/CSS colour, an [r, g, b] linear triple (may exceed 1 so bloom picks it up),
// or a function of the vertex position. `under` recolours downward-facing faces (bellies).
function paint(geo, color, m, under) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (m) g.applyMatrix4(m);
  g.deleteAttribute('uv'); g.computeVertexNormals();
  const p = g.attributes.position, n = g.attributes.normal, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    let k = under !== undefined && n.getY(i) < -.45 ? under : color;
    if (typeof k === 'function') k = k(p.getX(i), p.getY(i), p.getZ(i));
    Array.isArray(k) ? _c.setRGB(k[0], k[1], k[2]) : _c.set(k);
    c[i * 3] = _c.r; c[i * 3 + 1] = _c.g; c[i * 3 + 2] = _c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
// A tapered prism from point a (radius r0) to point b (radius r1): necks, tails, limbs, wing bones.
function limb(a, b, r0, r1, sides = 6) {
  const d = b.clone().sub(a), len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, sides, 1);
  return g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(.5), new THREE.Quaternion().setFromUnitVectors(Y, d.normalize()), ONE));
}
// Loose triangles (wing membranes, pennants), wound so their normals point up. Alternate triangles are shaded slightly apart.
function tris(list, color) {
  const P = [];
  list.forEach(([a, b, c]) => { const up = b.clone().sub(a).cross(c.clone().sub(a)).y >= 0; for (const v of [a, up ? b : c, up ? c : b]) P.push(v.x, v.y, v.z); });
  const g = paint(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(P, 3)), color), col = g.attributes.color.array;
  for (let i = 0; i < col.length; i++) if (((i / 9) | 0) % 2) col[i] *= .82;
  return g;
}
function merge(parts) {
  let n = 0; for (const g of parts) n += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) {
    const a = new Float32Array(n * 3); let o = 0;
    for (const g of parts) { a.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(a, 3));
  }
  parts.forEach(g => g.dispose());
  return out;
}
// A lumpy low-poly rock. The wobble is hashed from the (rounded) vertex position so faces stay joined.
function rockGeo(seed, color, m) {
  const g = new THREE.IcosahedronGeometry(1, 1), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = Math.round(p.getX(i) * 1e3), y = Math.round(p.getY(i) * 1e3), z = Math.round(p.getZ(i) * 1e3);
    const h = Math.sin(x * .1271 + y * .3117 + z * .0747 + seed * 12.9898) * 43758.5453, k = .84 + .3 * (h - Math.floor(h));
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
  }
  return paint(g, color, m);
}

// ---------------------------------------------------------------- the dragon

// Built facing -Z from primitives: no model or texture is downloaded. Returns the pieces that get animated.
// `mouths` is [middle, left, right]: all three breathe.
function buildDragon(glow) {
  const hide = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x33100a });
  const membrane = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x40160a, side: THREE.DoubleSide });
  const RED = 0xb8351f, DARK = 0x6b1d15, BELLY = 0xf2b368, HORN = 0xf2e6c2, WING = 0xdb6a2c;
  const spike = (y, z, r, h) => paint(new THREE.ConeGeometry(r, h, 4), DARK, M(0, y, z, .5, 0, 0));
  const root = new THREE.Group(), model = new THREE.Group();
  root.rotation.order = 'YXZ'; root.add(model);

  // body, legs tucked up, neck
  const body = [paint(new THREE.IcosahedronGeometry(1, 1), RED, M(0, 0, 0, 0, 0, 0, 1.2, 1.05, 2.9), BELLY)];
  for (let z = -2; z <= 2.3; z += .72) body.push(spike(1.05 * Math.sqrt(1 - (z / 2.9) ** 2) + .22, z, .2, .8));
  for (const s of [-1, 1]) {
    body.push(paint(limb(V(s * .85, -.3, -1.3), V(s * 1.05, -1, -.3), .4, .2, 5), RED), paint(limb(V(s * 1.05, -1, -.3), V(s * 1.05, -1.2, -1.1), .2, .07, 4), DARK));
    body.push(paint(limb(V(s * .9, -.25, 1.2), V(s * 1.1, -1.05, 2.2), .48, .22, 5), RED), paint(limb(V(s * 1.1, -1.05, 2.2), V(s * 1.1, -1.28, 1.3), .22, .07, 4), DARK));
  }
  // Three necks and three heads with one glowing eye each, as the town's legend has it. The middle head turns to aim
  // and has a hinged jaw; the outer two are fixed and baked into the body mesh, so the legend costs one extra draw call.
  const skullParts = () => {
    const p = [paint(limb(V(0, 0, .5), V(0, -.14, -2), .6, .25, 5), RED, M(0, 0, 0, 0, 0, 0, 1, .8, 1)), paint(new THREE.ConeGeometry(.11, .34, 4), HORN, M(0, .1, -1.75, .3, 0, 0))];
    for (const s of [-1, 1]) p.push(paint(limb(V(s * .3, .28, .2), V(s * .66, 1, 1.8), .18, .02, 4), HORN), paint(limb(V(s * .46, -.05, .25), V(s * 1.05, -.12, 1.1), .12, .02, 3), DARK));
    return p;
  };
  const jawGeo = m => paint(limb(V(0, 0, 0), V(0, -.02, -1.85), .38, .14, 5), BELLY, m.multiply(M(0, 0, 0, 0, 0, 0, 1, .45, 1)));
  const eyeGeo = () => paint(new THREE.IcosahedronGeometry(.21, 0), [5, 3.2, .6], M(0, .3, -.72));
  const necks = [[V(0, .25, -2.2), V(0, .78, -3.5), V(0, 1.22, -4.7), V(0, 1.42, -5.8)]], nr = [.8, .62, .48, .4], sideEyes = [], mouths = [];
  for (const s of [-1, 1]) necks.push([V(s * .5, .15, -2), V(s * 1.5, .5, -3.2), V(s * 2.45, .8, -4.15), V(s * 3.1, .9, -5)]);
  necks.forEach((neck, n) => {
    const k = n ? .82 : 1;                                                    // the outer necks are a little slimmer
    for (let i = 0; i < 3; i++) {
      body.push(paint(limb(neck[i], neck[i + 1], nr[i] * k, nr[i + 1] * k, 6), RED, null, BELLY));
      if (!n) body.push(spike((neck[i].y + neck[i + 1].y) / 2 + (nr[i] + nr[i + 1]) / 2 + .15, (neck[i].z + neck[i + 1].z) / 2, .15, .6));
    }
    if (!n) return;
    const m = M(neck[3].x, neck[3].y, neck[3].z, 0, -Math.sign(neck[3].x) * .4, 0, .85);      // a fixed outer head, turned a little outward
    for (const g of [...skullParts(), jawGeo(M(0, -.3, .3, -.22, 0, 0))]) body.push(g.applyMatrix4(m));
    sideEyes.push(eyeGeo().applyMatrix4(m));
    const mo = new THREE.Object3D(); mo.position.set(0, -.22, -1.9).applyMatrix4(m); model.add(mo); mouths.push(mo);
  });
  model.add(new THREE.Mesh(merge(body), hide), new THREE.Mesh(merge(sideEyes), glow));
  const head = new THREE.Group(); head.position.copy(necks[0][3]); head.rotation.order = 'YXZ'; model.add(head);
  head.add(new THREE.Mesh(merge(skullParts()), hide), new THREE.Mesh(eyeGeo(), glow));
  const jaw = new THREE.Group(); jaw.position.set(0, -.3, .3); head.add(jaw);
  jaw.add(new THREE.Mesh(jawGeo(M()), hide));
  const mouth = new THREE.Object3D(); mouth.position.set(0, -.22, -1.9); head.add(mouth); mouths.unshift(mouth);

  // tail: seven nested segments so a sway travels down it, ending in a spade
  const tail = []; let parent = model;
  for (let i = 0; i < 7; i++) {
    const r0 = .8 - i * .1, r1 = .7 - i * .1, parts = [paint(limb(V(0, 0, -.2), V(0, 0, 1.5), r0, r1, 6), RED, null, BELLY), spike((r0 + r1) / 2 + .12, .75, .16 * (1 - i / 9), .55)];
    if (i === 6) parts.push(paint(new THREE.OctahedronGeometry(1, 0), DARK, M(0, 0, 2.25, 0, 0, 0, 1, .14, 1.25)));
    const seg = new THREE.Group(); seg.position.set(0, i ? 0 : .05, i ? 1.5 : 2.45); seg.add(new THREE.Mesh(merge(parts), hide));
    parent.add(seg); parent = seg; tail.push(seg);
  }

  // wings: an inner panel hinged at the shoulder and an outer hand of three fingers hinged at the wrist.
  // Points are in the right wing's frame (x outward, z toward the tail); the left wing is the same geometry mirrored.
  const S0 = V(0, 0, -.55), R0 = V(0, -.1, 2.3), W = V(4.1, .45, -1.5), T1 = V(3.5, 0, 2.7), F1 = V(9.2, .25, .3), F2 = V(7.5, 0, 3.4), F3 = V(5.3, 0, 3.8);
  const sag = (a, b, to) => a.clone().lerp(b, .5).lerp(to, .21);          // scalloped trailing edge between two finger tips
  const innerGeo = merge([tris([[S0, W, T1], [S0, T1, sag(T1, R0, S0)], [S0, sag(T1, R0, S0), R0]], WING), paint(limb(V(0, 0, -.4), W, .28, .17, 5), DARK)]);
  const outerGeo = merge([
    tris([[W, F1, sag(F1, F2, W)], [W, sag(F1, F2, W), F2], [W, F2, sag(F2, F3, W)], [W, sag(F2, F3, W), F3], [W, F3, sag(F3, T1, W)], [W, sag(F3, T1, W), T1]], WING),
    paint(limb(W, F1, .17, .03, 4), DARK), paint(limb(W, F2, .12, .03, 4), DARK), paint(limb(W, F3, .11, .03, 4), DARK), paint(limb(W, V(4.3, .55, -2.5), .11, .01, 4), HORN),
  ]);
  const hinge = new THREE.Quaternion().setFromUnitVectors(Z, T1.clone().sub(W).normalize());   // the wrist folds about the line W to T1
  outerGeo.applyMatrix4(new THREE.Matrix4().compose(W, hinge, ONE).invert());
  const wings = [];
  for (const s of [1, -1]) {
    const side = new THREE.Group(), inner = new THREE.Group(), outer = new THREE.Group();
    side.position.set(s, .78, -1.25); side.scale.x = s; outer.position.copy(W);
    inner.add(new THREE.Mesh(innerGeo, membrane), outer); outer.add(new THREE.Mesh(outerGeo, membrane));
    side.add(inner); model.add(side); wings.push({ inner, outer });
  }
  return { root, model, head, jaw, mouth, mouths, tail, wings, hinge };
}

// ---------------------------------------------------------------- the cave, the hoard, the brigands

// A stylised cave mouth: a rock mound, an arch of stones, teeth, a ledge, and a disc that fades from ember glow to black.
function buildLair(glow) {
  const g = new THREE.Group(), rock = [], rnd = i => { const h = Math.sin(i * 91.7) * 43758.5; return h - Math.floor(h); };
  rock.push(rockGeo(1, 0x3d4035, M(0, 1.5, 6.5, 0, 0, 0, 15, 11.5, 12)), rockGeo(5, 0x34372e, M(0, -1.1, -9.5, 0, 0, 0, 8.5, 1.6, 6)));
  for (let k = 0; k < 9; k++) { const a = (-15 + k * 26.25) * DEG, s = 1.9 + rnd(k) * .9; rock.push(rockGeo(10 + k, k % 2 ? 0x4c4f42 : 0x44473b, M(Math.cos(a) * 6.7, Math.sin(a) * 6.9 + .5, -4.7, k, k * 2, 0, s, s * .9, s))); }
  for (let k = 0; k < 5; k++) { const x = -3.6 + k * 1.8, h = 1.7 + rnd(k + 20) * .9; rock.push(paint(new THREE.ConeGeometry(.45, h, 5), 0xd8d0b8, M(x, .6 + 6.5 * Math.sqrt(1 - (x / 6.2) ** 2) - h / 2, -5, Math.PI, 0, 0))); }
  for (const x of [-4.2, -1.7, 1.7, 4.2]) rock.push(paint(new THREE.ConeGeometry(.5, 1.6, 5), 0xd8d0b8, M(x, .6, -5.1)));
  g.add(new THREE.Mesh(merge(rock), new THREE.MeshLambertMaterial({ vertexColors: true })));
  const ember = (x, y) => { const k = clamp((y - .2) / 5, 0, 1) ** .7; return [mix(3.2, .02, k), mix(1.25, .012, k), mix(.22, .01, k)]; };
  g.add(new THREE.Mesh(paint(new THREE.CircleGeometry(1, 14), ember, M(0, .6, -4.9, 0, Math.PI, 0, 6.2, 6.6, 1)), glow));
  return g;
}

// An open chest (lit) and its gold (unlit and over-bright, so it glows through the bloom).
function buildChest() {
  const WOOD = 0x6a4424, BAND = 0xd9a441, GOLD = [2.4, 1.6, .35], GEM = [3, 2.2, .7];
  return {
    wood: merge([paint(new THREE.BoxGeometry(1.7, .85, 1.1), WOOD, M(0, .43, 0)), paint(new THREE.BoxGeometry(1.76, .12, 1.16), BAND, M(0, .82, 0)),
      paint(new THREE.BoxGeometry(.16, .9, 1.18), BAND, M(-.5, .45, 0)), paint(new THREE.BoxGeometry(.16, .9, 1.18), BAND, M(.5, .45, 0)),
      paint(new THREE.BoxGeometry(1.7, .14, 1.1), WOOD, M(0, 1.25, .72, -1.15, 0, 0))]),
    gold: merge([paint(new THREE.BoxGeometry(1.5, .3, .9), GOLD, M(0, .95, 0)), paint(new THREE.OctahedronGeometry(.28, 0), GEM, M(-.3, 1.2, .1)), paint(new THREE.OctahedronGeometry(.22, 0), GEM, M(.35, 1.18, -.15))]),
  };
}

// One shared brigand silhouette, readable from the air, dressed as the local records describe: a low round dark felt
// hat with a floppy brim, a long dark cloak, a neckerchief, ash-grey trousers (the legs), a money pouch at the belt.
// Colours come from the night's `look`; the face is the same neutral toy tone for everyone.
const HAND = [.36, .98, -.12], LIGHT = [-.42, 2.32, -.2];     // right hand (the leader's pole) and the top of the torch stick
function brigandGeo(look) {
  const cloak = look.cloak, hat = look.hat ?? '#1b1714', scarf = look.neckerchief ?? '#c8372d', FACE = 0xd8c7a3, STICK = 0x4a3220, POUCH = 0xb08a4a;
  return merge([
    paint(new THREE.ConeGeometry(.5, 1.3, 7), cloak, M(0, .98, .03, 0, 0, 0, 1, 1, .85)),               // long cloak, neck to shin
    paint(new THREE.CylinderGeometry(.17, .21, .1, 6), scarf, M(0, 1.5, 0)),                             // neckerchief, with its knot at the front
    paint(new THREE.ConeGeometry(.11, .2, 4), scarf, M(0, 1.37, -.2, Math.PI, 0, 0)),
    paint(new THREE.IcosahedronGeometry(.19, 0), FACE, M(0, 1.67, 0)),
    paint(new THREE.CylinderGeometry(.2, .43, .07, 8), hat, M(0, 1.8, 0)),                               // floppy brim
    paint(new THREE.SphereGeometry(.2, 7, 3, 0, TAU, 0, Math.PI / 2), hat, M(0, 1.82, 0, 0, 0, 0, 1, .7, 1)),   // low round crown
    paint(limb(V(-.3, 1.4, 0), V(-.42, 1.8, -.18), .08, .06, 4), cloak),                                 // arm up with the light
    paint(limb(V(-.42, 1.74, -.18), V(LIGHT[0], LIGHT[1] - .12, LIGHT[2]), .035, .035, 4), STICK),
    paint(limb(V(.3, 1.4, 0), V(HAND[0], HAND[1], HAND[2]), .08, .06, 4), cloak),
    paint(new THREE.IcosahedronGeometry(.11, 0), POUCH, M(.24, .82, -.34)),                              // money pouch
  ]);
}
const legGeo = () => paint(new THREE.BoxGeometry(.15, .74, .17), 0xffffff, M(0, -.37, 0));                // pivots at the hip
// What goes on the back: a sack, a short carbine, or a woodcutter's axe. Costume only: nothing in the game ever uses them.
const sackGeo = () => paint(new THREE.IcosahedronGeometry(.27, 0), 0x8a6a3a, M(.04, 1.2, .36, 0, 0, 0, 1, 1.25, .9));
const carbineGeo = () => merge([paint(limb(V(-.24, .92, .31), V(-.02, 1.22, .28), .055, .04, 4), 0x5a3a22), paint(limb(V(-.02, 1.22, .28), V(.26, 1.6, .24), .032, .03, 5), 0x2c2c30)]);
const axeGeo = () => merge([paint(limb(V(.22, .85, .31), V(-.12, 1.6, .24), .03, .03, 4), 0x5a3a22), paint(new THREE.BoxGeometry(.26, .2, .05), 0x9aa0a6, M(-.2, 1.56, .25, 0, 0, -.42))]);
// A sheep: the flock is one of the treasures, and now and then a brigand has one under an arm.
function sheepGeo() {
  const WOOL = 0xe9e4d6, DARK = 0x2d2a27;
  return merge([paint(new THREE.IcosahedronGeometry(.3, 0), WOOL, M(0, .42, 0, 0, 0, 0, .85, .8, 1.25)), paint(new THREE.IcosahedronGeometry(.13, 0), DARK, M(0, .52, -.42)),
    ...[[-.14, -.2], [.14, -.2], [-.14, .22], [.14, .22]].map(([x, z]) => paint(new THREE.BoxGeometry(.06, .24, .06), DARK, M(x, .12, z)))]);
}
function penGeo() {                                                       // a small round pen: posts and two rails, one bay left open
  const parts = [], n = 10, R = 4.6, WOOD = 0x6b4a2c, at = k => V(Math.cos(k / n * TAU) * R, 0, Math.sin(k / n * TAU) * R);
  for (let k = 0; k < n; k++) {
    const a = at(k), b = at(k + 1); parts.push(paint(new THREE.BoxGeometry(.22, 1.5, .22), WOOD, M(a.x, .75, a.z)));
    if (k) for (const h of [.55, 1.15]) parts.push(paint(limb(V(a.x, h, a.z), V(b.x, h, b.z), .07, .07, 4), WOOD));
  }
  return merge(parts);
}
function bannerGeo(color) {
  return merge([paint(limb(V(0, 0, 0), V(0, 4, 0), .045, .045, 4), 0x4a3220), tris([[V(0, 3.95, 0), V(0, 3.05, 0), V(0, 3.5, 1.9)]], color)]);
}
const lightGeo = kind => kind === 'lantern' ? new THREE.BoxGeometry(.22, .28, .22) : new THREE.OctahedronGeometry(.17, 0).applyMatrix4(M(0, 0, 0, 0, 0, 0, 1, 1.7, 1));
// A treasure's name, floating over its beacon at a constant size on screen.
function nameSprite(text) {
  const c = document.createElement('canvas'), g = c.getContext('2d'); c.width = 512; c.height = 80;
  g.font = "italic 600 40px Fraunces, Georgia, serif"; g.textAlign = 'center'; g.textBaseline = 'middle'; g.shadowColor = 'rgba(0,0,0,.95)'; g.shadowBlur = 9; g.fillStyle = '#F2E6C2';
  g.fillText(text, 256, 42); g.fillText(text, 256, 42);
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false, sizeAttenuation: false, fog: false }));
  s.scale.set(.4, .0625, 1); s.renderOrder = 5; return s;
}

// ---------------------------------------------------------------- what is below the dragon

// The roof map: the height of the highest thing (ground, roof, tower, tree) near every 6 m node of the terrain square.
// The dragon's floor is read from it, which is what makes flight unable to go wrong.
function buildRoofMap({ data, H, town, scene }, skip) {
  const half = data.terrain.half, n = Math.round(2 * half / ROOF_CELL) + 1, top = new Float32Array(n * n);
  const node = v => clamp(Math.round((v + half) / ROOF_CELL), 0, n - 1);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) top[j * n + i] = H(-half + i * ROOF_CELL, half - j * ROOF_CELL);
  const raise = (x, z, h) => { const q = node(z) * n + node(x); if (h > top[q]) top[q] = h; };
  // every vertex of the town model
  town.updateMatrixWorld(true);
  town.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh) return;
    const p = o.geometry.attributes.position, e = o.matrixWorld.elements, fast = !p.isInterleavedBufferAttribute && !p.normalized && p.itemSize === 3, a = p.array;
    for (let k = 0; k < p.count; k++) {
      const x = fast ? a[k * 3] : p.getX(k), y = fast ? a[k * 3 + 1] : p.getY(k), z = fast ? a[k * 3 + 2] : p.getZ(k);
      raise(e[0] * x + e[4] * y + e[8] * z + e[12], e[2] * x + e[6] * y + e[10] * z + e[14], e[1] * x + e[5] * y + e[9] * z + e[13]);
    }
  });
  // big roofs have few vertices: spread each building's highest point over its whole footprint
  const inside = [];
  for (const s of data.solids) {
    const R = Math.hypot(s[2], s[3]) + 3, c = Math.cos(-s[4]), sn = Math.sin(-s[4]); let hi = -Infinity; inside.length = 0;
    for (let j = node(-s[1] - R); j <= node(-s[1] + R); j++) for (let i = node(s[0] - R); i <= node(s[0] + R); i++) {
      const dx = -half + i * ROOF_CELL - s[0], dy = half - j * ROOF_CELL - s[1];
      if (Math.abs(dx * c - dy * sn) < s[2] + 2 && Math.abs(dx * sn + dy * c) < s[3] + 2) { inside.push(j * n + i); hi = Math.max(hi, top[j * n + i]); }
    }
    for (const q of inside) top[q] = hi;
  }
  // trees and any other instanced props, from their real instance matrices and bounding boxes
  const m = new THREE.Matrix4();
  scene.traverse(o => {
    if (!o.isInstancedMesh || skip(o)) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox, reach = Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z) * .8;
    for (let k = 0; k < o.count; k++) {
      o.getMatrixAt(k, m); const e = m.elements, sc = Math.hypot(e[0], e[1], e[2]), r = reach * sc, h = e[13] + b.max.y * sc;
      for (let z = e[14] - r; z <= e[14] + r + .01; z += ROOF_CELL) for (let x = e[12] - r; x <= e[12] + r + .01; x += ROOF_CELL) raise(x, z, h);
    }
  });
  // widen everything by one node so wing tips clear it too
  const wide = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let h = -Infinity;
    for (let b = Math.max(j - 1, 0); b <= Math.min(j + 1, n - 1); b++) for (let a = Math.max(i - 1, 0); a <= Math.min(i + 1, n - 1); a++) h = Math.max(h, top[b * n + a]);
    wide[j * n + i] = h;
  }
  const at = (x, z) => {                                              // bilinear, in three.js x/z
    const u = clamp((x + half) / ROOF_CELL, 0, n - 1.001), v = clamp((z + half) / ROOF_CELL, 0, n - 1.001), i = u | 0, j = v | 0, a = u - i, b = v - j, q = j * n + i;
    return (wide[q] * (1 - a) + wide[q + 1] * a) * (1 - b) + (wide[q + n] * (1 - a) + wide[q + n + 1] * a) * b;
  };
  at.bump = (x, z, r, h) => { for (let j = node(z - r); j <= node(z + r); j++) for (let i = node(x - r); i <= node(x + r); i++) wide[j * n + i] = Math.max(wide[j * n + i], h); };
  return at;
}

// The path grid: 3 m cells, blocked wherever a building solid is. A "field" holds, for every free cell, the walking
// distance to a goal; a raider only ever steps to a neighbour that is nearer, so it cannot get stuck behind a wall.
function buildPaths(data, reach) {
  const R = data.radius, ext = Math.max(R + 30, reach), n = Math.ceil(2 * ext / CELL), x0 = CENTRE_X - ext, y0 = CENTRE_Y - ext, blocked = new Uint8Array(n * n);
  const cellOf = (x, y) => { const i = Math.floor((x - x0) / CELL), j = Math.floor((y - y0) / CELL); return i < 0 || j < 0 || i >= n || j >= n ? -1 : j * n + i; };
  for (const s of data.solids) {
    const r = Math.hypot(s[2], s[3]) + 2, c = Math.cos(-s[4]), sn = Math.sin(-s[4]);
    for (let j = Math.max(0, Math.floor((s[1] - r - y0) / CELL)); j <= Math.min(n - 1, Math.floor((s[1] + r - y0) / CELL)); j++)
      for (let i = Math.max(0, Math.floor((s[0] - r - x0) / CELL)); i <= Math.min(n - 1, Math.floor((s[0] + r - x0) / CELL)); i++) {
        const dx = x0 + (i + .5) * CELL - s[0], dy = y0 + (j + .5) * CELL - s[1];
        if (Math.abs(dx * c - dy * sn) < s[2] + 1.7 && Math.abs(dx * sn + dy * c) < s[3] + 1.7) blocked[j * n + i] = 1;
      }
  }
  const NX = [1, -1, 0, 0, 1, 1, -1, -1], NY = [0, 0, 1, -1, 1, -1, 1, -1];
  // Dijkstra over the 8-connected grid with a small binary heap (reused for every field).
  const cap = n * n * 8 + 16, hk = new Float32Array(cap), hv = new Int32Array(cap);
  function field(sources) {
    const F = new Float32Array(n * n).fill(Infinity); let size = 0;
    const push = (k, v) => { let i = size++; while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; } hk[i] = k; hv[i] = v; };
    for (const s of sources) { F[s] = 0; push(0, s); }
    while (size) {
      const d = hk[0], cur = hv[0]; size--;
      if (size) { const k = hk[size], v = hv[size]; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= size) break; if (c + 1 < size && hk[c + 1] < hk[c]) c++; if (hk[c] >= k) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c; } hk[i] = k; hv[i] = v; }
      if (d > F[cur]) continue;
      const ci = cur % n, cj = (cur / n) | 0;
      for (let k = 0; k < 8; k++) {
        const i = ci + NX[k], j = cj + NY[k]; if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const q = j * n + i; if (blocked[q]) continue;
        if (k > 3 && (blocked[cj * n + i] || blocked[j * n + ci])) continue;      // no squeezing between two corners
        const nd = Math.fround(d + (k > 3 ? CELL * Math.SQRT2 : CELL));
        if (nd < F[q]) { F[q] = nd; push(nd, q); }
      }
    }
    return F;
  }
  const freeNear = (x, y) => {                                         // the nearest unblocked cell to a point
    const i0 = clamp(Math.floor((x - x0) / CELL), 0, n - 1), j0 = clamp(Math.floor((y - y0) / CELL), 0, n - 1);
    for (let r = 0; r < 14; r++) for (let j = Math.max(0, j0 - r); j <= Math.min(n - 1, j0 + r); j++) for (let i = Math.max(0, i0 - r); i <= Math.min(n - 1, i0 + r); i++) if (!blocked[j * n + i]) return j * n + i;
    return j0 * n + i0;
  };
  const edge = []; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (!blocked[j * n + i] && Math.hypot(x0 + (i + .5) * CELL - CENTRE_X, y0 + (j + .5) * CELL - CENTRE_Y) >= R) edge.push(j * n + i);
  // Aim a walker at (x, y) down a field: two cells of descent, then toward that cell's centre (plus the walker's own
  // small offset so a band does not collapse into single file). Falls back to a straight line where the field is blind.
  const dir = { x: 0, y: 0 };
  function steer(F, x, y, gx, gy, ox, oy) {
    let cur = cellOf(x, y), tx = gx, ty = gy, moved = false;
    for (let s = 0; s < 2 && cur >= 0; s++) {
      const ci = cur % n, cj = (cur / n) | 0; if (ci < 1 || cj < 1 || ci >= n - 1 || cj >= n - 1) break;
      let best = F[cur], bn = -1;
      for (let k = 0; k < 8; k++) {
        const q = cur + NX[k] + NY[k] * n;
        if (!(F[q] < best) || (k > 3 && (blocked[cur + NX[k]] || blocked[cur + NY[k] * n]))) continue;
        best = F[q]; bn = q;
      }
      if (bn < 0) break; cur = bn; moved = true;
    }
    if (moved) { tx = x0 + (cur % n + .5) * CELL + ox; ty = y0 + (((cur / n) | 0) + .5) * CELL + oy; }
    const dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy) || 1; dir.x = dx / d; dir.y = dy / d; return dir;
  }
  return { field, edgeField: field(edge), steer, freeNear, blockedAt: (x, y) => { const q = cellOf(x, y); return q < 0 || blocked[q] === 1; }, value: (F, x, y) => { const q = cellOf(x, y); return q < 0 ? Infinity : F[q]; }, centre: q => [x0 + (q % n + .5) * CELL, y0 + (((q / n) | 0) + .5) * CELL] };
}

// ---------------------------------------------------------------- sprites (fire, smoke, halos)

// A fixed pool of soft points with a world-space size. Dead ones have size 0. `rag` eats into each sprite's edge
// with a little value noise (fixed per sprite, drifting as it rises), so flames and smoke lick and curl instead of being smooth balls.
function spritePool(n, additive, rag) {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n), g = new THREE.BufferGeometry();
  const attr = { position: new THREE.BufferAttribute(pos, 3), aColor: new THREE.BufferAttribute(col, 4), aSize: new THREE.BufferAttribute(size, 1) };
  for (const k in attr) { attr[k].setUsage(THREE.DynamicDrawUsage); g.setAttribute(k, attr[k]); }
  g.setAttribute('aSeed', new THREE.BufferAttribute(Float32Array.from({ length: n }, () => Math.random() * 40), 1));     // fixed per slot
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 500 }, uRag: { value: rag } }, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: `attribute vec4 aColor; attribute float aSize, aSeed; uniform float uScale; varying vec4 vC; varying float vSeed;
      void main() { vC = aColor; vSeed = aSeed + position.y * .08;
        vec4 mv = modelViewMatrix * vec4(position, 1.); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uScale / max(-mv.z, .1); }`,
    fragmentShader: `varying vec4 vC; varying float vSeed; uniform float uRag;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
        return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y); }
      void main() { vec2 q = gl_PointCoord - .5; float d = length(q) * 2.;
        if (uRag > 0.) d += (noise(q * 5. + vSeed) - .45) * uRag;
        float a = smoothstep(1., .15, d) * vC.a; if (a < .004) discard; gl_FragColor = vec4(vC.rgb, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const points = new THREE.Points(g, mat); points.frustumCulled = false;
  return { n, points, mat, pos, col, size, attr, vel: new Float32Array(n * 3), age: new Float32Array(n), life: new Float32Array(n), s0: new Float32Array(n), s1: new Float32Array(n), next: 0 };
}

// ---------------------------------------------------------------- the game

function createGame(ctx, cfg, ui) {
  const { scene, cam, renderer, data, H, surface, keys, mv } = ctx;
  const EDGE_R = data.radius, RING_R = EDGE_R - 12;
  const world = new THREE.Group(); world.name = 'dragon-mode'; world.visible = false; scene.add(world);
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true });       // unlit, over-bright vertex colours: eyes, gold, embers
  const lit = new THREE.MeshLambertMaterial({ vertexColors: true });      // everything plain and lit: cloth, wood, wool

  const roofAt = buildRoofMap(ctx, o => { for (let p = o; p; p = p.parent) if (p === world) return true; return false; });

  // ---- the cave
  const lair = pickLair(cfg.lair ?? {});
  const lairObj = buildLair(glow); lairObj.position.set(lair.x, H(lair.x, lair.y), -lair.y); lairObj.rotation.y = lair.hd; world.add(lairObj);
  roofAt.bump(lair.x + Math.sin(lair.hd) * 6, -lair.y + Math.cos(lair.hd) * 6, 15, lairObj.position.y + 13);
  const perch = V(0, 4.5, -11).applyAxisAngle(Y, lair.hd).add(lairObj.position);
  function pickLair(c) {
    const t = data.terrain, step = 2 * t.half / (t.N - 1), slopeAt = (x, y) => Math.hypot(H(x + 12, y) - H(x - 12, y), H(x, y + 12) - H(x, y - 12)) / 24;
    let x = c.x, y = c.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      // no position given: the highest slope inside the flying area (within 25 degrees of bearingDeg if one is given),
      // marked down where trees would crowd the mouth
      const search = useBearing => { let best = -Infinity;
        for (let j = 1; j < t.N - 1; j++) for (let i = 1; i < t.N - 1; i++) {
          const px = -t.half + i * step, py = t.half - j * step;
          if (Math.hypot(px - CENTRE_X, py - CENTRE_Y) > SOFT_R || slopeAt(px, py) < .18) continue;
          if (useBearing && Math.abs(wrap(Math.atan2(px, py) - c.bearingDeg * DEG)) > 25 * DEG) continue;
          let crowd = 0; for (const tr of data.trees) if (Math.abs(tr[0] - px) < 26 && Math.abs(tr[1] - py) < 26) crowd++;
          if (t.z[j][i] - crowd * 5 > best) { best = t.z[j][i] - crowd * 5; x = px; y = py; }
        } return best > -Infinity; };
      if (!(Number.isFinite(c.bearingDeg) && search(true)) && !search(false)) { x = CENTRE_X; y = CENTRE_Y - SOFT_R * .8; }
    }
    const face = Number.isFinite(c.facingDeg) ? c.facingDeg * DEG : Math.atan2(-(H(x + 12, y) - H(x - 12, y)), -(H(x, y + 12) - H(x, y - 12)));   // downhill
    return { x, y, hd: -face };
  }

  // ---- the treasures. "at" is [x, y] in game metres, or "lair" for the chest kept on the cave's ledge.
  const spots = cfg.treasures.map(t => t.at === 'lair' ? V(-6, 0, -9.5).applyAxisAngle(Y, lair.hd).add(lairObj.position) : V(t.at[0], 0, -t.at[1]));
  const paths = buildPaths(data, Math.max(...spots.map(p => Math.hypot(p.x - CENTRE_X, p.z + CENTRE_Y))) + 40);
  const chest = buildChest(), sheepG = sheepGeo();
  const beamGeo = paint(new THREE.CylinderGeometry(.8, 1.7, 60, 8, 3, true), (x, y) => { const u = clamp(y / 60, 0, 1), k = (1 - u) ** 2 * Math.min(1, .25 + u * 4); return [1.5 * k, 1.05 * k, .32 * k]; }, M(0, 30, 0));   // soft at the foot, so the treasure itself shows
  const treasures = cfg.treasures.map((t, i) => {
    let x = spots[i].x, y = -spots[i].z; if (paths.blockedAt(x, y)) [x, y] = paths.centre(paths.freeNear(x, y));     // keep the given spot unless it is inside a wall
    const g = t.at === 'lair' ? lairObj.position.y + .5 : surface(x, y), box = new THREE.Group();
    if (t.kind === 'sheep') {                                              // a little flock is what gets carried off; its pen stays behind
      for (const [sx, sz, ry] of [[-.45, .1, .4], [.45, .25, -.5], [0, -.5, 2.6]]) { const sh = new THREE.Mesh(sheepG, lit); sh.position.set(sx, 0, sz); sh.rotation.y = ry; box.add(sh); }
      box.scale.setScalar(2.6);
      const pen = new THREE.Mesh(penGeo(), lit); pen.position.set(x, g, -y); world.add(pen);
    } else { box.add(new THREE.Mesh(chest.wood, lit), new THREE.Mesh(chest.gold, glow)); box.scale.setScalar(1.8); box.rotation.y = i * 1.3; }
    const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    const label = nameSprite(t.name); if (i % 2) label.center.y = -.8;                           // every other name sits a line higher, so neighbours do not overprint from afar
    beam.position.set(x, g, -y); label.position.set(x, g + 16, -y); world.add(box, beam, label);
    return { ...t, i, x, y, g, box, beam, label, state: HOME, by: null, t: 0, fx: 0, fy: 0, fg: 0, field: paths.field([paths.freeNear(x, y)]) };
  });
  ui.lootInit(treasures.map(t => t.name));
  const setLoot = (t, state) => { t.state = state; t.label.material.opacity = state === LOST ? .35 : 1; ui.loot(t.i, state); };

  // The town's lit windows and lamps, so the last dawn can turn them up.
  const glowMats = []; ctx.town.traverse(o => { for (const m of [].concat(o.material ?? [])) if (m.emissive && m.emissive.r + m.emissive.g + m.emissive.b > .01 && !glowMats.includes(m)) glowMats.push(m); });
  const glowBase = glowMats.map(m => m.emissiveIntensity), setGlow = k => glowMats.forEach((m, i) => { m.emissiveIntensity = glowBase[i] * k; });

  // ---- the dragon, its fire and its shadow
  const dragon = buildDragon(glow); world.add(dragon.root);
  const rich = ctx.hi !== false;                                           // phones get plainer, sparser flames: the same game for less fill
  const fire = spritePool(600, true, rich ? 1.1 : 0), smoke = spritePool(320, false, rich ? .9 : 0), halos = spritePool(HALOS, true, 0);
  smoke.points.renderOrder = 1; halos.points.renderOrder = 2; fire.points.renderOrder = 3; world.add(smoke.points, halos.points, fire.points);
  const jet = new THREE.Mesh(paint(new THREE.ConeGeometry(1, 1, 8, 1, true), (x, y) => { const k = clamp(-y, 0, 1); return [mix(1.3, 0, k), mix(.8, 0, k ** .6), mix(.25, 0, k ** .4)]; }, M(0, -.5, 0)),
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  jet.scale.setScalar(0); world.add(jet);
  const fireLight = new THREE.PointLight(0xff8a30, 0, 160, 2); fireLight.visible = false; scene.add(fireLight);   // hidden outside the mode so walking mode's shaders are untouched
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: .3, depthWrite: false })); world.add(shadow);

  // ---- the raiders: one pool of 40, drawn as a handful of instanced meshes
  const inst = (geo, mat, n = MAX_RAIDERS) => { const m = new THREE.InstancedMesh(geo, mat, n); m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); world.add(m); return m; };
  const legMat = new THREE.MeshLambertMaterial({ vertexColors: true }), flameMat = new THREE.MeshBasicMaterial(), flagMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const figure = inst(new THREE.BufferGeometry(), lit), legs = inst(legGeo(), legMat, MAX_RAIDERS * 2), flames = inst(new THREE.BufferGeometry(), flameMat), banners = inst(new THREE.BufferGeometry(), flagMat);
  const kits = [inst(sackGeo(), lit), inst(carbineGeo(), lit), inst(axeGeo(), lit)], lambs = inst(sheepG, lit);      // on the back; and the odd sheep under an arm
  const meshes = [figure, legs, flames, banners, ...kits, lambs];
  const raiders = Array.from({ length: MAX_RAIDERS }, (_, i) => ({ i, on: false, band: null, state: WALK, goal: 0, x: 0, y: 0, g: 0, hd: 0, t: 0, ph: 0, ox: 0, oy: 0, k: 1, heat: 0, sp: 0, back: 0, side: 0, flag: false, kit: 0, sheep: false, dropX: 0, dropY: 0, dropG: 0, dropT: -1, puff: 0 }));
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0), lightTint = new THREE.Color(), tint = new THREE.Color();
  const IN_HAND = new THREE.Matrix4().makeTranslation(HAND[0], HAND[1] - .5, HAND[2]), UNDER_ARM = M(.5, .6, -.1, 0, 1.2, 0, .75);
  let siteOrder = [];

  // ---- state
  const S = { phase: 'off', nightIx: 0, night: null, timeLeft: 0, warded: 0, spawned: 0, lost: 0, bandsOut: 0, nextBand: 0, dawnT: 0, flown: 0, emit: 0, rise: 0, warned: false, grade: 0, lair, treasures, raiders };
  const D = { x: perch.x, y: perch.y, z: perch.z, hd: lair.hd, turn: 0, vy: 0, speed: 0, pitch: 0, bank: 0, flap: 0, effort: .3, fire: 0 };
  S.dragon = D;
  const base = { exposure: renderer.toneMappingExposure, sun: ctx.sun.intensity, hemi: ctx.hemi?.intensity ?? 1, fov: cam.fov };
  const camPos = V(), camLook = V(), camWant = V(), lookWant = V(), mp = V(), mpL = V(), mpR = V(), aim = V(0, 0, -1), aimWant = V();
  const _v = V(), _p = V(), _s = V(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _m = new THREE.Matrix4(), _l = new THREE.Matrix4(), _o = new THREE.Matrix4();
  let fireHeld = false; ui.fire.onpointerdown = e => { fireHeld = true; ui.fire.classList.add('on'); e.preventDefault(); try { ui.fire.setPointerCapture(e.pointerId); } catch { /* a pointer that is already gone: nothing to hold on to */ } };
  ui.fire.onpointerup = ui.fire.onpointercancel = () => { fireHeld = false; ui.fire.classList.remove('on'); };
  ui.fire.oncontextmenu = e => e.preventDefault();

  // ---------------------------------------------------------- nights

  function startNight(ix) {
    const n = S.night = cfg.nights[S.nightIx = ix % cfg.nights.length], look = n.look;
    // dress tonight's band: one shared silhouette, recoloured
    figure.geometry.dispose(); figure.geometry = brigandGeo(look);
    banners.geometry.dispose(); banners.geometry = look.banner ? bannerGeo(look.banner) : new THREE.BufferGeometry();
    flames.geometry.dispose(); flames.geometry = lightGeo(look.light);
    legMat.color.set(look.legs ?? '#8e908d');
    lightTint.set(look.lightColor ?? '#ff9a3c'); flameMat.color.copy(lightTint).multiplyScalar(4.5);
    for (const r of raiders) retire(r);
    for (const t of treasures) { setLoot(t, HOME); t.by = null; t.box.visible = true; }
    setGlow(1);
    // far sites first, so every band has time to matter
    const a = n.approach.fromDeg * DEG, ex = CENTRE_X + Math.sin(a) * RING_R, ey = CENTRE_Y + Math.cos(a) * RING_R;
    siteOrder = treasures.map(t => t.i).sort((p, q) => paths.value(treasures[q].field, ex, ey) - paths.value(treasures[p].field, ex, ey));
    Object.assign(S, { phase: 'card', timeLeft: cfg.nightSeconds ?? 90, warded: 0, spawned: 0, lost: 0, bandsOut: 0, nextBand: .5, dawnT: 0, flown: 0 });
    Object.assign(D, { x: perch.x, y: perch.y, z: perch.z, hd: lair.hd, turn: 0, vy: 0, speed: 0, pitch: 0, bank: 0, fire: 0 });
    for (let i = 0; i < fire.n; i++) fire.life[i] = fire.size[i] = 0;
    for (let i = 0; i < smoke.n; i++) smoke.life[i] = smoke.size[i] = 0;
    chase(1, true);
    ui.card(S.nightIx, cfg.nights.length, n, cfg.raiders?.name ?? '', cfg.fallbackCard);
  }
  function takeFlight() { if (S.phase !== 'card') return; S.phase = 'fly'; D.speed = 12; D.vy = 5; ui.hide(); }
  function dawn() {
    S.phase = 'dawn'; S.dawnT = 0;
    for (const r of raiders) if (r.on && r.state === WALK) singe(r, false);     // daylight sends the rest running; these are not counted as yours
    ui.toast('Dawn. The church bells ring.');
  }
  function retire(r) {
    r.on = false; r.band = null;
    for (const m of meshes) { m.setMatrixAt(r.i, ZERO); m.instanceMatrix.needsUpdate = true; }
    legs.setMatrixAt(r.i + MAX_RAIDERS, ZERO); halos.size[r.i] = 0;
  }

  // A band walks in from a point on the edge ring inside tonight's approach arc. Of a few candidate points, take the
  // one whose walk to the target is nearest half a minute, so bands arrive through the night and not all at once.
  function spawnBand() {
    const n = S.night, slots = raiders.filter(r => !r.on);
    const size = Math.min(slots.length, n.bandSize[0] + Math.floor(Math.random() * (n.bandSize[1] - n.bandSize[0] + 1)));
    if (!size) return false;
    const site = siteOrder[S.bandsOut % siteOrder.length], F = treasures[site].field, want = n.speed * (26 + Math.random() * 12);
    let bx = 0, by = 0, score = Infinity;
    for (let c = 0; c < 14; c++) {
      const a = (n.approach.fromDeg + (Math.random() * 2 - 1) * n.approach.spreadDeg) * DEG, x = CENTRE_X + Math.sin(a) * RING_R, y = CENTRE_Y + Math.cos(a) * RING_R;
      const f = paths.value(F, x, y), sc = Math.abs((Number.isFinite(f) ? f : 1e4) - want);
      if (sc < score) { score = sc; bx = x; by = y; }
    }
    const band = { site, lead: slots[0], carrier: null, leaving: false, members: [], trail: [bx, by] };     // trail: breadcrumbs of the way in, walked back out with any loot
    for (let k = 0; k < size; k++) {
      const r = slots[k], row = Math.ceil(k / 2);                         // a loose V behind the leader
      Object.assign(r, { on: true, band, state: WALK, goal: 0, x: bx + (Math.random() - .5) * 11, y: by + (Math.random() - .5) * 11, t: 0, ph: Math.random() * TAU, ox: (Math.random() - .5) * 2.2, oy: (Math.random() - .5) * 2.2,
        k: .92 + Math.random() * .16, heat: 0, sp: 0, back: row * 2.4 + Math.random() * .8, side: (k % 2 ? 1 : -1) * (row ? 1.2 + row * .7 : 0), flag: k === 0, kit: (k + 1) % 3, sheep: k % 4 === 3, dropT: -1, puff: 0 });
      r.hd = Math.atan2(r.x - CENTRE_X, CENTRE_Y - r.y); r.g = surface(r.x, r.y);
      figure.setColorAt(r.i, tint.setScalar(.88 + Math.random() * .24));
      band.members.push(r);
    }
    figure.instanceColor.needsUpdate = true;
    S.spawned += size; S.bandsOut++;
    return true;
  }

  // Singed: jump, drop everything, then run for the edge. Nobody is hurt. `counted` is false for the dawn scatter.
  function singe(r, counted) {
    r.state = JUMP; r.t = 0; r.heat = 0; r.dropX = r.x; r.dropY = r.y; r.dropG = r.g; r.dropT = 0;
    if (counted) S.warded++;
    const b = r.band;
    if (b.carrier === r) {
      const t = treasures[b.site]; b.carrier = null; setLoot(t, RETURNING); t.by = null; t.t = 0; t.fx = r.x; t.fy = r.y; t.fg = r.g + 2.2 * RAIDER_SCALE;
      for (const m of b.members) if (m.on && m.state === WALK) m.goal = 0;       // the rest go back for it
      if (counted) ui.toast(`${t.name}: dropped, and hopping home.`);
    }
    if (b.lead === r) newLead(b);
    figure.setColorAt(r.i, tint.setScalar(.32)); figure.instanceColor.needsUpdate = true;     // sooty
    for (let k = 0; k < 14; k++) flame(r.x + (Math.random() - .5) * 2, r.g + 1 + Math.random() * 3, -r.y + (Math.random() - .5) * 2, (Math.random() - .5) * 8, 4 + Math.random() * 9, (Math.random() - .5) * 8, .35 + Math.random() * .4, .8, 3.2);
    for (let k = 0; k < 8; k++) puff(r.x, r.g + 2, -r.y, 3);
  }
  function newLead(b) { b.lead = b.carrier ?? b.members.find(m => m.on && m.state === WALK) ?? null; }

  function updateRaiders(dt, t) {
    const sp0 = S.night.speed;
    for (const r of raiders) {
      if (!r.on) continue;
      r.t += dt; const b = r.band; let jump = 0, spin = 0, lean = 0, size = 1, stride = 0;
      if (r.state === WALK) {
        const tr = treasures[b.site], L = b.lead, trail = b.trail; let sp = sp0 * r.k;
        if (L && L !== r && L.goal === r.goal) {                                // keep a place in the V behind the leader
          const c = Math.cos(L.hd), sn = Math.sin(L.hd), dx = L.x + sn * r.back + c * r.side - r.x, dy = L.y - c * r.back + sn * r.side - r.y, gap = Math.hypot(dx, dy);
          r.hd += wrap((gap > .7 ? Math.atan2(-dx, dy) : L.hd) - r.hd) * damp(7, dt);
          sp = L.sp * clamp(.3 + gap * .35, .3, 1.8);
        } else if (b.carrier === r) {                                           // carrying: slowly back along the way the band came in
          const n = trail.length;
          if (!n) {                                                             // ...and out at the edge: recorded, and the night goes on
            setLoot(tr, LOST); tr.by = null; tr.box.visible = false; b.carrier = null; b.leaving = true; S.lost++;
            for (const m of b.members) m.goal = 1;
            ui.toast(`${tr.name}: carried off, to be won back another night.`);
            retire(r); newLead(b); continue;
          }
          const dx = trail[n - 2] - r.x, dy = trail[n - 1] - r.y; if (Math.hypot(dx, dy) < 3) trail.length = n - 2;
          r.hd += wrap(Math.atan2(-dx, dy) - r.hd) * damp(7, dt); sp *= CARRY_K;
        } else {                                                                // the leader (or a straggler) reads the path field
          const out = r.goal === 1, d = paths.steer(out ? paths.edgeField : tr.field, r.x, r.y, out ? r.x + (r.x - CENTRE_X) : tr.x, out ? r.y + (r.y - CENTRE_Y) : tr.y, r.ox, r.oy);
          r.hd += wrap(Math.atan2(-d.x, d.y) - r.hd) * damp(7, dt);
          if (!out && r === L) { const n = trail.length; if (Math.hypot(trail[n - 2] - r.x, trail[n - 1] - r.y) > 6) trail.push(r.x, r.y); }
        }
        r.sp = sp;
        r.x -= Math.sin(r.hd) * sp * dt; r.y += Math.cos(r.hd) * sp * dt; r.g = surface(r.x, r.y);
        r.ph += sp * dt * 1.5; stride = .65; lean = -.08;
        if (r.goal === 0 && Math.hypot(r.x - tr.x, r.y - tr.y) < 3.4) {
          if (b.carrier) r.goal = 1;                                              // a straggler: fall in behind the carrier
          else if (tr.state === HOME) {
            setLoot(tr, CARRIED); tr.by = r; b.carrier = b.lead = r; r.goal = 1;
            if (!trail.length) trail.push(r.x, r.y);
            for (const m of b.members) if (m.on && m.state === WALK && Math.hypot(m.x - tr.x, m.y - tr.y) < 14) m.goal = 1;
            ui.toast(`${tr.name}: taken! Singe the carrier.`);
          } else if (tr.state !== RETURNING) {                                    // someone else has it: try another site, or give up
            const next = treasures.filter(q => q.state === HOME).sort((p, q) => paths.value(p.field, r.x, r.y) - paths.value(q.field, r.x, r.y))[0];
            if (next) b.site = next.i; else { b.leaving = true; for (const m of b.members) m.goal = 1; }
          } else { r.x += Math.sin(r.hd) * sp * dt; r.y -= Math.cos(r.hd) * sp * dt; r.sp = 0; stride = .15; }    // wait for it to land
        } else if (r.goal === 1 && !b.carrier && Math.hypot(r.x - CENTRE_X, r.y - CENTRE_Y) > EDGE_R - 4) {    // empty-handed, and off the map
          retire(r); if (b.lead === r) newLead(b); continue;
        }
      } else if (r.state === JUMP) {
        const u = r.t / .6; jump = Math.sin(Math.PI * Math.min(u, 1)) * 2.6; spin = u * TAU; size = 1 + .25 * Math.sin(Math.PI * Math.min(u, 1)); stride = 1.2; r.ph += dt * 30;
        if (u >= 1) { r.state = FLEE; r.t = 0; }
      } else if (r.state === FLEE) {
        const d = paths.steer(paths.edgeField, r.x, r.y, r.x + (r.x - CENTRE_X), r.y + (r.y - CENTRE_Y), r.ox, r.oy);
        r.hd += wrap(Math.atan2(-d.x, d.y) - r.hd) * damp(9, dt);
        r.x -= Math.sin(r.hd) * FLEE_SPEED * dt; r.y += Math.cos(r.hd) * FLEE_SPEED * dt; r.g = surface(r.x, r.y);
        r.ph += dt * 26; stride = 1.05; lean = -.4; jump = Math.abs(Math.sin(r.ph * .5)) * .35;
        r.puff -= dt; if (r.puff <= 0) { r.puff = .06; puff(r.x, r.g + 1.8, -r.y, 1.9); }
        if (r.t > 6.5 || (r.t > 2.2 && Math.hypot(r.x - CENTRE_X, r.y - CENTRE_Y) > EDGE_R - 3)) { r.state = POOF; r.t = 0; for (let k = 0; k < 5; k++) puff(r.x, r.g + 1.5, -r.y, 2.2); }
      } else {
        size = 1 - r.t / .35; if (size <= 0) { retire(r); continue; }
      }
      // write this raider's instances
      _e.set(lean, r.hd + spin, 0); _m.compose(_p.set(r.x, r.g + jump, -r.y), _q.setFromEuler(_e), _s.setScalar(RAIDER_SCALE * size));
      figure.setMatrixAt(r.i, _m);
      const sw = Math.sin(r.ph) * stride;
      legs.setMatrixAt(r.i, _o.multiplyMatrices(_m, _l.makeRotationX(sw).setPosition(-.11, .76, 0)));
      legs.setMatrixAt(r.i + MAX_RAIDERS, _o.multiplyMatrices(_m, _l.makeRotationX(-sw).setPosition(.11, .76, 0)));
      const dropped = r.dropT >= 0; if (dropped) r.dropT += dt;
      const fade = dropped ? clamp(1 - r.dropT / 2.5, 0, 1) : 1, fall = dropped ? Math.max(0, 1 - r.dropT * 2.5) : 0;      // dropped things fall, lie, and fade
      const fl = .85 + .3 * Math.sin(t * 17 + r.i * 2.1) * Math.sin(t * 11 + r.i);
      if (dropped) _o.compose(_p.set(r.dropX - .7, r.dropG + .3 + fall * 3.5, -r.dropY), _q.identity(), _s.setScalar(RAIDER_SCALE * fade * fl));
      else _o.multiplyMatrices(_m, _l.makeScale(fl, fl * 1.1, fl).setPosition(LIGHT[0], LIGHT[1], LIGHT[2]));
      flames.setMatrixAt(r.i, _o);
      const e = _o.elements;
      if (fade > 0) halo(r.i, e[12], e[13], e[14], 6.5 * fade * fl, lightTint.r, lightTint.g, lightTint.b);
      else halo(r.i, r.x, r.g + jump + 1.6, -r.y, 3.2 * size * fl, 1, .32, .05);                       // the torch is out: a smoulder goes with them instead
      if (dropped) _o.compose(_p.set(r.dropX + .6, r.dropG - 1.9 + fall * 3, -r.dropY + .5), _q.identity(), _s.setScalar(RAIDER_SCALE * fade));
      for (let k = 0; k < 3; k++) kits[k].setMatrixAt(r.i, k !== r.kit ? ZERO : dropped ? _o : _m);
      if (!r.sheep) lambs.setMatrixAt(r.i, ZERO);
      else if (dropped) lambs.setMatrixAt(r.i, _o.compose(_p.set(r.dropX - 1.3, r.dropG + fall * 1.5, -r.dropY - .9), _q.setFromAxisAngle(Y, r.i), _s.setScalar(1.5 * fade)));   // set down, unharmed
      else lambs.setMatrixAt(r.i, _o.multiplyMatrices(_m, UNDER_ARM));
      if (!r.flag) banners.setMatrixAt(r.i, ZERO);
      else if (dropped) banners.setMatrixAt(r.i, _o.compose(_p.set(r.dropX, r.dropG + .2 + fall * 2, -r.dropY), _q.setFromAxisAngle(Z, 1.45 * (1 - fall)), _s.setScalar(RAIDER_SCALE * fade)));
      else banners.setMatrixAt(r.i, _o.multiplyMatrices(_m, IN_HAND));
    }
    for (const m of meshes) m.instanceMatrix.needsUpdate = true;
  }

  function updateTreasures(dt, t) {
    const lab = clamp(cam.aspect * 1.35, .55, 1);                                  // names are sized against screen height: rein them in on a tall phone
    for (const tr of treasures) {
      const b = tr.box.position, col = tr.beam.material.color; tr.label.scale.set(.4 * lab, .0625 * lab, 1);
      if (tr.state === HOME) { b.set(tr.x, tr.g, -tr.y); col.setScalar(.85 + .15 * Math.sin(t * 2 + tr.i)); }
      else if (tr.state === CARRIED) { const r = tr.by; b.set(r.x, r.g + 2.2 * RAIDER_SCALE + Math.sin(t * 9) * .12, -r.y); const k = .5 + .5 * Math.sin(t * 9); col.setRGB(.9 + k * .6, .12, .05); }
      else if (tr.state === RETURNING) {                                           // three hops home
        tr.t += dt; const u = Math.min(tr.t / 1.4, 1);
        b.set(mix(tr.fx, tr.x, u), mix(tr.fg, tr.g, u) + Math.abs(Math.sin(u * Math.PI * 3)) * 5 * (1 - u * .6), -mix(tr.fy, tr.y, u)); col.setScalar(.5);
        if (u >= 1) setLoot(tr, HOME);
      } else col.setRGB(.1, .13, .16);
      col.multiplyScalar(clamp((Math.hypot(tr.x - camPos.x, tr.y + camPos.z) - 25) / 130, .1, 1));      // a beacon is for finding the place from afar: up close it fades back
      halo(40 + tr.i, b.x, b.y + 2, b.z, tr.state === LOST ? 0 : 9, .5, .34, .1);
    }
  }

  // ---------------------------------------------------------- sprites

  function halo(i, x, y, z, size, r, g, b) { const p = halos.pos, c = halos.col; p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z; halos.size[i] = size; c[i * 4] = r; c[i * 4 + 1] = g; c[i * 4 + 2] = b; c[i * 4 + 3] = 1; }
  function emit(p, x, y, z, vx, vy, vz, life, s0, s1) {
    const i = p.next; p.next = (p.next + 1) % p.n;
    p.pos[i * 3] = x; p.pos[i * 3 + 1] = y; p.pos[i * 3 + 2] = z; p.vel[i * 3] = vx; p.vel[i * 3 + 1] = vy; p.vel[i * 3 + 2] = vz; p.age[i] = 0; p.life[i] = life; p.s0[i] = s0; p.s1[i] = s1;
  }
  const flame = (x, y, z, vx, vy, vz, life, s0, s1) => emit(fire, x, y, z, vx, vy, vz, life, s0, s1);
  const puff = (x, y, z, s) => emit(smoke, x + (Math.random() - .5), y, z + (Math.random() - .5), (Math.random() - .5) * 2, 2 + Math.random() * 2.5, (Math.random() - .5) * 2, .9 + Math.random() * .8, s * .6, s * 2.6);
  function updateSprites(dt) {
    // fire: thin and pale at the mouth, brightest mid-stream, then cooling to a dull red as it slows and lifts
    let { pos, vel, col, size, age, life, s0, s1 } = fire; const drag = 1 - .9 * dt;
    for (let i = 0; i < fire.n; i++) {
      if (life[i] <= 0) continue;
      const a = age[i] += dt, u = a / life[i], j = i * 3, c = i * 4;
      if (u >= 1) { life[i] = 0; size[i] = 0; col[c + 3] = 0; continue; }
      vel[j] *= drag; vel[j + 1] = vel[j + 1] * drag + 9 * u * dt; vel[j + 2] *= drag;
      pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
      size[i] = mix(s0[i], s1[i], Math.sqrt(u));
      if (u < .3) { const k = u / .3; col[c] = mix(1.7, 1.7, k); col[c + 1] = mix(1.25, .7, k); col[c + 2] = mix(.55, .1, k); }
      else if (u < .7) { const k = (u - .3) / .4; col[c] = mix(1.7, 1.3, k); col[c + 1] = mix(.7, .26, k); col[c + 2] = mix(.1, .03, k); }
      else { const k = (u - .7) / .3; col[c] = mix(1.3, .55, k); col[c + 1] = mix(.26, .06, k); col[c + 2] = .03 * (1 - k); }
      col[c + 3] = Math.min(1, u * 6) * Math.min(1, (1 - u) * 2.5) * .5;
    }
    ({ pos, vel, col, size, age, life, s0, s1 } = smoke);
    for (let i = 0; i < smoke.n; i++) {
      if (life[i] <= 0) continue;
      const a = age[i] += dt, u = a / life[i], j = i * 3, c = i * 4;
      if (u >= 1) { life[i] = 0; size[i] = 0; col[c + 3] = 0; continue; }
      pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
      size[i] = mix(s0[i], s1[i], u); col[c] = col[c + 1] = col[c + 2] = .16 + .1 * u; col[c + 3] = (1 - u) * .6;
    }
    const scale = renderer.domElement.height / (2 * Math.tan(cam.fov * DEG / 2));
    fire.mat.uniforms.uScale.value = smoke.mat.uniforms.uScale.value = halos.mat.uniforms.uScale.value = scale;
    fire.attr.position.needsUpdate = fire.attr.aColor.needsUpdate = fire.attr.aSize.needsUpdate = smoke.attr.position.needsUpdate = smoke.attr.aColor.needsUpdate = smoke.attr.aSize.needsUpdate = true;
    halos.attr.position.needsUpdate = halos.attr.aColor.needsUpdate = halos.attr.aSize.needsUpdate = true;
  }

  // ---------------------------------------------------------- flight

  // The dragon always glides forward. Input only bends that glide; three things make it unable to go wrong:
  // a floor read from the roof map here and ahead, a soft ceiling, and a boundary that turns it back toward town.
  function fly(dt) {
    const boost = keys.ShiftLeft || keys.ShiftRight;
    let turnIn = clamp((keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0) - mv.x, -1, 1);
    const climbIn = clamp((keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) - mv.y, -1, 1);
    const ox = D.x - CENTRE_X, oz = D.z + CENTRE_Y, far = Math.hypot(ox, oz), k = clamp((far - SOFT_R) / SOFT_BAND, 0, 1);
    if (k > 0) {
      turnIn += (clamp(wrap(Math.atan2(ox, oz) - D.hd) * 1.6, -1, 1) - turnIn) * k;      // blend the stick toward "face the centre"
      if (k > .3 && !S.warned) { S.warned = true; ui.toast('The dragon wheels back toward the town.'); }
    } else S.warned = false;
    D.turn += (turnIn - D.turn) * damp(5, dt);
    D.hd = wrap(D.hd + D.turn * TURN * dt);
    D.speed += ((boost ? BURST : CRUISE) - D.speed) * damp(boost ? 2.2 : 1.4, dt);
    const fx = -Math.sin(D.hd), fz = -Math.cos(D.hd);
    D.x += fx * D.speed * dt; D.z += fz * D.speed * dt;
    const lim = SOFT_R + SOFT_BAND + 20; if (far > lim) { D.x = CENTRE_X + ox * lim / far; D.z = -CENTRE_Y + oz * lim / far; }      // belt and braces
    const look = D.speed * .9, floor = Math.max(roofAt(D.x, D.z), roofAt(D.x + fx * look * .5, D.z + fz * look * .5), roofAt(D.x + fx * look, D.z + fz * look)) + CLEAR;
    const above = D.y - floor; let vy = climbIn * CLIMB;
    if (Math.abs(climbIn) < .1 && above > SINK_ABOVE) vy = -Math.min(6, (above - SINK_ABOVE) * .3);     // hands off and very high: drift back into fire range
    if (above > CEILING) vy = Math.min(vy, -Math.min(14, (above - CEILING) * .6));                      // too high (as when leaving the cave): a steady glide down, never a plunge
    if (above < 0) vy = Math.max(vy, 2 - above * 4);                                                    // the ground is coming up: climb
    D.vy += (vy - D.vy) * damp(4, dt); D.y += D.vy * dt;
    const hard = roofAt(D.x, D.z) + 2.5; if (S.flown > 1.5 && D.y < hard) {       // (not during the leap out of the cave)
      D.y = hard; if (D.vy < 0) D.vy = 0; }
    D.pitch += (Math.atan2(D.vy, D.speed) * .9 - D.pitch) * damp(5, dt);
    D.bank += (D.turn * .8 - D.bank) * damp(6, dt);
    D.effort += (clamp(.35 + Math.max(0, D.vy) / CLIMB * .5 + (boost ? .35 : 0) - (D.vy < -4 ? .25 : 0), .1, 1) - D.effort) * damp(3, dt);
    S.flown += dt;
  }

  function pose(dt, t) {
    const { root, model, tail, wings, hinge } = dragon;
    root.position.set(D.x, D.y, D.z); root.rotation.set(D.pitch, D.hd, D.bank);
    D.flap += mix(4.2, 8.5, D.effort) * dt;
    const amp = mix(.3, .62, D.effort), a1 = Math.sin(D.flap) * amp + .1, a2 = Math.sin(D.flap - 1) * amp * 1.15 - .12, sweep = clamp(-D.vy / CLIMB, 0, 1) * .3;
    for (const w of wings) { w.inner.rotation.set(0, -sweep, a1); w.outer.quaternion.copy(hinge).multiply(_q.setFromAxisAngle(Z, a2)); }
    model.position.y = -Math.sin(D.flap) * .28 * amp;
    for (let i = 0; i < tail.length; i++) tail[i].rotation.set(Math.sin(t * 1.7 - i * .5) * .05 - D.pitch * .12, Math.sin(t * 2.2 - i * .6) * .1 - D.turn * .13, 0);
    // a soft shadow on the ground below, tilted to the slope, so height is easy to judge
    const gx = D.x, gy = -D.z, h = H(gx, gy), up = clamp(1 - (D.y - h) / 160, .25, 1);
    shadow.position.set(D.x, h + .4, D.z); shadow.quaternion.setFromUnitVectors(Y, _v.set(-(H(gx + 4, gy) - H(gx - 4, gy)) / 8, 1, (H(gx, gy + 4) - H(gx, gy - 4)) / 8).normalize());
    shadow.scale.setScalar(7 * up); shadow.material.opacity = .34 * up;
  }

  // Fire. The cone is judged on the ground from the dragon's heading, so anything roughly in front is in it at any
  // height the dragon can reach. The flame itself is aimed at the nearest raider in the cone so it is seen to land.
  function breathe(dt, t) {
    const firing = S.phase !== 'card' && (keys.Space || fireHeld), fx = -Math.sin(D.hd), fz = -Math.cos(D.hd);
    D.fire += ((firing ? 1 : 0) - D.fire) * damp(firing ? 14 : 7, dt);
    dragon.mouth.getWorldPosition(mp);
    let target = null, near = Infinity;
    for (const r of raiders) {
      if (!r.on || r.state !== WALK) continue;
      const dx = r.x - D.x, dz = -r.y - D.z, d = Math.hypot(dx, dz);
      if (d < FIRE_RANGE && D.y - r.g < FIRE_DROP && (d < FIRE_CLOSE || (dx * fx + dz * fz) / d > FIRE_COS)) {
        if (d < near) { near = d; target = r; }
        if (firing && (r.heat += dt) > .12 + d / 110) singe(r, true);           // a beat for the flame to get there
      } else if (r.heat > 0) r.heat = Math.max(0, r.heat - dt);
    }
    if (target) aimWant.set(target.x - mp.x, target.g + 1.5 - mp.y, -target.y - mp.z);
    else aimWant.set(fx * 58, Math.min(-8, H(D.x + fx * 58, -(D.z + fz * 58)) - mp.y), fz * 58);          // nobody in the cone: the ground some 60 m ahead
    const reach = target ? aimWant.length() : 55;
    aim.lerp(aimWant.normalize(), damp(target ? 12 : 6, dt)).normalize();
    // the head follows the aim a little, and the jaw opens
    _v.copy(aim).applyQuaternion(_q.copy(dragon.root.quaternion).invert());
    const w = Math.max(D.fire, target ? .6 : 0), head = dragon.head.rotation;
    head.x += (clamp(Math.asin(clamp(_v.y, -1, 1)) * .7, -.9, .4) * w - head.x) * damp(8, dt); head.y += (clamp(Math.atan2(-_v.x, -_v.z) * .7, -.7, .7) * w - head.y) * damp(8, dt);
    dragon.jaw.rotation.x = -D.fire * .55;
    // where the breath lands: walk the aim line out until it meets the ground
    let land = 0; for (let d = 6; d <= 102 && !land; d += 6) if (mp.y + aim.y * d <= H(mp.x + aim.x * d, -(mp.z + aim.z * d)) + .8) land = d;
    // particles from the mouth, a splash where they land, a bright core, and a light on whatever is below
    const sp = clamp(reach / .62, 60, 135), vx = fx * D.speed * .5, vz = fz * D.speed * .5;
    dragon.mouths[1].getWorldPosition(mpL); dragon.mouths[2].getWorldPosition(mpR);
    for (S.emit += D.fire * (rich ? 280 : 170) * dt; S.emit >= 1; S.emit--) {
      const s = sp * (.7 + Math.random() * .55), j = sp * .26;                // about 7 degrees of spread either side
      const q = Math.random(), o = q < .64 ? mp : q < .82 ? mpL : mpR;        // mostly the middle head, with the outer two joining in
      flame(o.x, o.y, o.z, aim.x * s + (Math.random() - .5) * j + vx, aim.y * s + (Math.random() - .5) * j * .7, aim.z * s + (Math.random() - .5) * j + vz, .6 + Math.random() * .45, .5, 4 + reach * .04 + Math.random() * 2.5);
      // ...and where it lands, a strip of fire that burns on for a moment after the dragon has passed
      if (land && Math.random() < .4) flame(mp.x + aim.x * land + (Math.random() - .5) * 15, mp.y + aim.y * land + .6, mp.z + aim.z * land + (Math.random() - .5) * 15, (Math.random() - .5) * 3, 1.5 + Math.random() * 3, (Math.random() - .5) * 3, 1 + Math.random() * .9, 3, 7);
    }
    const flick = .8 + .2 * Math.sin(t * 37) * Math.sin(t * 23);
    jet.position.copy(mp); jet.quaternion.setFromUnitVectors(DOWN, aim); jet.scale.set(.9 * D.fire * flick, (7 + reach * .06) * D.fire * flick, .9 * D.fire * flick);
    fireLight.position.copy(mp).addScaledVector(aim, land ? Math.max(8, land - 7) : 14); fireLight.intensity = D.fire * 2600 * flick;
  }

  // A smooth third-person chase. In the card phase it sits in front of the cave instead.
  function chase(dt, snap) {
    const bx = Math.sin(D.hd), bz = Math.cos(D.hd);
    if (S.phase === 'card') { camWant.set(D.x - bx * 22 + bz * 10, D.y + 2.5, D.z - bz * 22 - bx * 10); lookWant.set(D.x, D.y - 3.5, D.z); }
    else {
      S.rise += ((D.fire > .5 ? 1 : 0) - S.rise) * damp(D.fire > .5 ? 3 : 1.5, dt);          // breathing fire lifts the camera, so the stream and where it lands are seen from above
      const d = 24 + (D.speed - CRUISE) * .12, a = (26 + 8 * S.rise) * clamp((S.flown - .8) / 1.6, 0, 1);      // at launch, keep watching the dragon while the camera swings round behind it
      camWant.set(D.x + bx * d, D.y + 11 + 9 * S.rise, D.z + bz * d); lookWant.set(D.x - bx * a, D.y + 1.5 - a * .18 - 3 * S.rise, D.z - bz * a);
    }
    if (snap) { camPos.copy(camWant); camLook.copy(lookWant); }
    else { camPos.lerp(camWant, damp(S.phase === 'card' ? 3 : mix(1.6, 5, clamp(S.flown / 2.5, 0, 1)), dt)); camLook.lerp(lookWant, damp(8, dt)); }
    camPos.y = Math.max(camPos.y, roofAt(camPos.x, camPos.z) + 3);                 // the camera gets a floor too
    cam.position.copy(camPos); cam.lookAt(camLook); cam.rotateZ(D.bank * .16); cam.updateMatrixWorld();
    const fov = base.fov + clamp((D.speed - CRUISE) / (BURST - CRUISE), 0, 1) * 9;
    if (Math.abs(fov - cam.fov) > .02) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }

  // Dusk deepens to night while you fly and lifts again at dawn. Only exposure and light levels change.
  function grade(dt) {
    const want = S.phase === 'fly' ? clamp(S.timeLeft / 8, 0, 1) : S.phase === 'card' ? .5 : 0;
    S.grade += (want - S.grade) * damp(.9, dt);
    renderer.toneMappingExposure = base.exposure * (1 - .26 * S.grade); ctx.sun.intensity = base.sun * (1 - .5 * S.grade); if (ctx.hemi) ctx.hemi.intensity = base.hemi * (1 - .25 * S.grade);
  }

  // The arrow: the treasure carrier if there is one, else the nearest raider still walking.
  function hud() {
    let who = null, best = Infinity, alert = false;
    if (S.phase === 'fly') for (const r of raiders) {
      if (!r.on || r.state !== WALK) continue;
      const carrying = r.band.carrier === r, d = Math.hypot(r.x - D.x, -r.y - D.z) - (carrying ? 1e4 : 0);
      if (d < best) { best = d; who = r; alert = carrying; }
    }
    if (who) { _v.set(who.x, who.g + 2, -who.y).project(cam); ui.arrow(_v.x, _v.y, _v.z > 1, Math.hypot(who.x - D.x, -who.y - D.z), alert); } else ui.arrow();
    let safe = 0; for (const t of treasures) if (t.state !== LOST) safe++;
    ui.stats(S.nightIx + 1, S.night.title, Math.max(0, Math.ceil(S.timeLeft)), S.warded, safe, treasures.length);
  }

  halo(44, 0, 0, 0, 0, 0, 0, 0);
  const lairGlow = V(0, 3, -6).applyAxisAngle(Y, lair.hd).add(lairObj.position);

  return {
    S,
    start() {
      world.visible = fireLight.visible = true; startNight(S.nightIx);
    },
    stop() {
      world.visible = fireLight.visible = false; S.phase = 'off'; fireHeld = false;
      renderer.toneMappingExposure = base.exposure; ctx.sun.intensity = base.sun; if (ctx.hemi) ctx.hemi.intensity = base.hemi;
      cam.fov = base.fov; cam.updateProjectionMatrix(); setGlow(1); ui.hide(); ui.arrow(); ui.toast();
    },
    takeFlight,
    // After the last night's tally comes the closing card, if dragon.json has one: the town lights every window.
    next() { if (ui.open === 'tally' && cfg.finale && S.nightIx + 1 >= cfg.nights.length) { setGlow(1.9); ui.finale(cfg.finale); } else startNight(S.nightIx + 1); },
    update(dt, t) {
      if (S.phase === 'card') { D.effort += (.12 - D.effort) * damp(2, dt); D.y = perch.y + Math.sin(t * 1.3) * .25; }
      else {
        fly(dt);
        if (S.phase === 'fly') {
          S.timeLeft -= dt;
          if (S.bandsOut < S.night.bands && (S.nextBand -= dt) <= 0) S.nextBand = spawnBand() ? (S.timeLeft - 34) / Math.max(1, S.night.bands - S.bandsOut) : 1;
          if (S.timeLeft <= 0) dawn();
        } else if (S.dawnT >= 0 && (S.dawnT += dt) > 2.6) {
          S.dawnT = -1; let safe = 0; for (const tr of treasures) if (tr.state !== LOST) safe++;
          ui.tally(S.night, S.warded, S.spawned, safe, treasures.length, S.nightIx + 1 >= cfg.nights.length, !!cfg.finale);
        }
      }
      pose(dt, t); breathe(dt, t);
      if (S.phase !== 'card') updateRaiders(dt, t);
      updateTreasures(dt, t);
      halo(44, lairGlow.x, lairGlow.y, lairGlow.z, 20, .5 + .08 * Math.sin(t * 3), .2, .04);
      updateSprites(dt); chase(dt); grade(dt); hud();
    },
  };
}

// ---------------------------------------------------------------- page furniture (built on first entry)

const CSS = `
body.dragon .tp[data-p],body.dragon #place{display:none}
#dstat{display:none;margin-left:auto;gap:4px 16px;flex-wrap:wrap;align-items:baseline;justify-content:flex-end;font:600 12px 'Archivo',sans-serif;text-shadow:0 1px 6px rgba(0,0,0,.8)}
body.dragon #dstat{display:flex}
#dstat i{font-style:normal;font-size:10px;letter-spacing:.1em;text-transform:uppercase;opacity:.8;margin-right:5px}
#dstat b{font:italic 600 16px 'Fraunces',Georgia,serif;color:var(--apr)}
.dov{position:fixed;inset:0;z-index:4;display:none;justify-content:center;align-items:flex-end;padding:16px 16px max(8vh,20px);pointer-events:none}
.dov.on{display:flex}
.dpan{pointer-events:auto;width:min(540px,100%);padding:18px 24px 22px;text-align:center;background:rgba(22,51,47,.88);border:1px solid rgba(242,179,104,.65);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);box-shadow:0 12px 40px rgba(0,0,0,.45)}
.dpan .k{font:600 11px 'Archivo',sans-serif;letter-spacing:.18em;text-transform:uppercase;color:var(--haze)}
.dpan h2{font:600 clamp(28px,6vw,42px)/1.05 'Fraunces',Georgia,serif;margin:6px 0 4px}
.dpan .w{font:italic 600 17px 'Fraunces',Georgia,serif;color:var(--apr)}
.dpan p{margin:10px auto 0;max-width:46ch;line-height:1.45;font-size:15px}
.dpan .n{margin-top:10px;font-size:11px;line-height:1.5;color:var(--haze)}
.dpan .row{display:flex;justify-content:space-between;align-items:baseline;gap:16px;max-width:330px;margin:10px auto 0;font-size:15px}
.dpan .row b{font:italic 600 21px 'Fraunces',Georgia,serif;color:var(--apr)}
.dbtn{margin:16px 5px 0;padding:13px 26px;border:0;background:var(--ember);color:var(--deep);font:600 13px 'Archivo',sans-serif;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
.dbtn.q{background:transparent;color:var(--cream);box-shadow:inset 0 0 0 1px rgba(242,179,104,.65)}
.dbtn:focus-visible{outline:2px solid var(--cream);outline-offset:2px}
#dloot{position:fixed;right:12px;top:calc(max(12px,env(safe-area-inset-top)) + 40px);z-index:3;display:none;pointer-events:none;text-align:right;font:italic 600 13px/1.5 'Fraunces',Georgia,serif;text-shadow:0 1px 6px rgba(0,0,0,.85)}
body.dragon #dloot{display:block}
#dloot div::after{content:' \\25C6';font-style:normal;font-size:9px;color:var(--apr);vertical-align:1px}
#dloot .c{color:#fff;animation:dblink .5s steps(2) infinite}#dloot .c::after{color:#ff5a3c}
#dloot .l{opacity:.45;text-decoration:line-through}#dloot .l::after{color:var(--haze)}
@keyframes dblink{50%{opacity:.45}}
#darrow{position:fixed;left:0;top:0;width:0;height:0;z-index:2;display:none;pointer-events:none}
#darrow i{position:absolute;left:-12px;top:-14px;border-left:12px solid transparent;border-right:12px solid transparent;border-bottom:28px solid var(--ember);filter:drop-shadow(0 1px 4px rgba(0,0,0,.85))}
#darrow.alert i{border-bottom-color:var(--cream)}
#darrow span{position:absolute;left:-45px;top:20px;width:90px;text-align:center;font:600 11px 'Archivo',sans-serif;text-shadow:0 1px 4px rgba(0,0,0,.95)}
#dtoast{position:fixed;left:50%;top:calc(max(12px,env(safe-area-inset-top)) + 58px);transform:translateX(-50%);width:min(92vw,620px);z-index:3;pointer-events:none;text-align:center;font:italic 600 19px 'Fraunces',Georgia,serif;text-shadow:0 1px 8px rgba(0,0,0,.9);opacity:0;transition:opacity .35s}
#dtoast.on{opacity:1}
#dfire{position:fixed;right:22px;bottom:64px;width:116px;height:116px;border-radius:50%;z-index:4;display:none;border:2px solid rgba(242,230,194,.6);background:rgba(232,147,63,.5);color:var(--cream);font:600 15px 'Archivo',sans-serif;letter-spacing:.14em;text-transform:uppercase;touch-action:none}
#dfire.on{background:rgba(232,147,63,.92)}
body.dragon.touch #dfire{display:block}
body.dragon.touch .dov.on~#dfire{display:none}
body.dragon.touch #cred{left:12px;max-width:none;text-align:center}
body.dragon.touch #dtoast{top:calc(max(12px,env(safe-area-inset-top)) + 168px);font-size:16px}
body.dragon.touch #dloot{top:calc(max(12px,env(safe-area-inset-top)) + 88px);font-size:12px}
`;

function buildUi(touch, on) {
  const $ = id => document.getElementById(id);
  const el = (tag, props, parent) => { const e = Object.assign(document.createElement(tag), props); parent?.append(e); return e; };
  el('style', { textContent: CSS }, document.head);
  const stat = el('div', { id: 'dstat' }, $('hud')), cell = label => { const s = el('span', {}, stat); el('i', { textContent: label }, s); return el('b', {}, s); };
  const sNight = cell('Night'), sTime = cell('Dawn in'), sWard = cell('Warded off'), sSafe = cell('Treasures safe');
  const loot = el('div', { id: 'dloot' }, document.body), lootRows = [];
  const over = el('div', { className: 'dov' }, document.body), panel = el('div', { className: 'dpan' }, over);
  const arrow = el('div', { id: 'darrow' }, document.body), tip = el('i', {}, arrow), dist = el('span', {}, arrow);
  const toast = el('div', { id: 'dtoast' }, document.body), fire = el('button', { id: 'dfire', textContent: 'Fire' }, document.body);
  const set = (e, s) => { if (e._s !== s) e.textContent = e._s = s; };
  let toastT = 0, lastDist = -1, shown = 0, statKey = -1;
  const button = (text, fn, quiet) => el('button', { className: 'dbtn' + (quiet ? ' q' : ''), textContent: text, onclick: e => { e.stopPropagation(); e.currentTarget.blur(); fn(); } }, panel);
  // One panel serves the title card, the dawn tally and the closing card: kicker, title, subtitle, then whatever follows.
  const open = (kind, kicker, title, sub) => {
    panel.replaceChildren(); el('div', { className: 'k', textContent: kicker }, panel); el('h2', { textContent: title }, panel); el('div', { className: 'w', textContent: sub }, panel);
    over.classList.add('on'); ui.open = kind; shown = performance.now();
  };
  const ui = {
    fire, open: null,
    // A night's own two lines, or the general card from dragon.json if it has none. Unchecked text says so on screen.
    card(ix, count, night, who, fallback) {
      const src = night.history ? night : fallback ?? { history: [] };
      open('card', `Night ${ix + 1} of ${count}`, night.title, [who, night.date].filter(Boolean).join(', '));
      el('p', { textContent: src.history.join(' ') }, panel);
      el('div', { className: 'n', textContent: (src.verified ? '' : 'History notes are a draft, still being checked. ') + (touch ? 'The stick steers and climbs. Hold Fire to breathe fire.' : 'A/D turn, W/S climb and dive, hold Space to breathe fire, Shift for speed.') }, panel);
      button('Take flight', on.fly);
    },
    tally(night, warded, spawned, safe, sites, last, closing) {
      open('tally', 'Dawn', safe === sites ? 'The town wakes safe' : 'The town wakes', night.title);
      const row = (label, value) => { const r = el('div', { className: 'row' }, panel); el('span', { textContent: label }, r); el('b', { textContent: value }, r); };
      row('Raiders sent packing', `${warded} of ${spawned}`); row('Treasures kept safe', `${safe} of ${sites}`);
      el('p', { textContent: safe === sites ? 'Every treasure is where it belongs.' : 'What was carried off will be won back: nothing is lost for good.' }, panel);
      button(!last ? 'Next night' : closing ? 'The last dawn' : 'Fly the first night again', on.next); button('Walk the town', on.walk, true);
    },
    finale(card) {
      open('finale', 'The last dawn', card.title, card.date ?? '');
      el('p', { textContent: card.history.join(' ') }, panel);
      if (!card.verified) el('div', { className: 'n', textContent: 'History notes are a draft, still being checked.' }, panel);
      button('Fly the first night again', on.next); button('Walk the town', on.walk, true);
    },
    hide() { over.classList.remove('on'); ui.open = null; },
    fresh: () => performance.now() - shown < 700,          // a key held from the last screen must not dismiss the next one
    stats(n, title, secs, warded, safe, sites) {                       // called every frame: only touch the page when a number changes
      const key = ((n * 200 + secs) * 64 + warded) * 8 + safe; if (key === statKey) return; statKey = key;
      set(sNight, `${n}: ${title}`); set(sTime, `${(secs / 60) | 0}:${String(secs % 60).padStart(2, '0')}`); set(sWard, String(warded)); set(sSafe, `${safe} of ${sites}`);
    },
    // The treasures by name, top right: plain when safe, flashing while being carried off, struck through if lost tonight.
    lootInit(names) { loot.replaceChildren(); lootRows.length = 0; for (const n of names) lootRows.push(el('div', { textContent: n }, loot)); },
    loot(i, state) { const c = state === CARRIED ? 'c' : state === LOST ? 'l' : ''; if (lootRows[i] && lootRows[i].className !== c) lootRows[i].className = c; },
    toast(msg) { if (msg) { set(toast, msg); toast.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toast.classList.remove('on'), 3200); } else toast.classList.remove('on'); },
    // Screen-edge arrow. (x, y) are normalised device coordinates of the target; behind the camera they arrive mirrored.
    arrow(x, y, behind, metres, alert) {
      if (x === undefined) { if (arrow._on) { arrow.style.display = 'none'; arrow._on = false; } return; }
      const w = innerWidth, h = innerHeight, top = touch ? 190 : 130, side = 44, bottom = touch ? 210 : 70;
      if (behind) { x = -x; y = -y; }
      let px = (x * .5 + .5) * w, py = (-y * .5 + .5) * h, ang = Math.PI;
      const off = behind || px < side || px > w - side || py < top || py > h - bottom;
      if (off) {
        const cx = w / 2, cy = (top + h - bottom) / 2; let dx = px - cx, dy = py - cy; if (behind) { const m = 1e4 / (Math.hypot(dx, dy) || 1); dx *= m; dy *= m; }
        const k = Math.min((w / 2 - side) / Math.abs(dx || 1e-6), ((h - bottom - top) / 2) / Math.abs(dy || 1e-6));
        px = cx + dx * k; py = cy + dy * k; ang = Math.atan2(dy, dx) + Math.PI / 2;
      } else py -= 46;                                                      // on screen: sit above the target, pointing down at it
      if (!arrow._on) { arrow.style.display = 'block'; arrow._on = true; }
      arrow.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px)`; tip.style.transform = `rotate(${ang.toFixed(3)}rad)`;
      if (arrow._alert !== alert) { arrow.classList.toggle('alert', alert); arrow._alert = alert; }
      const m = Math.round(metres / 10) * 10; if (m !== lastDist) { lastDist = m; dist.textContent = alert ? `treasure! ${m} m` : `${m} m`; }
    },
  };
  return ui;
}

// ---------------------------------------------------------------- entry point

// Wires the two "Dragon mode" buttons and returns the handle index.html's loop calls. `active` is what the loop checks.
export function init(ctx) {
  const $ = id => document.getElementById(id), top = $('dm'), intro = $('goD'), help = $('help'), helpText = help?.textContent;
  const api = { active: false, enter, exit, update(dt, t) { game.update(dt, t); }, peek: () => game?.S };
  let game = null, ui = null, busy = false;

  async function enter() {
    if (api.active || busy) return; busy = true;
    document.exitPointerLock?.(); $('intro')?.classList.add('gone');
    try {
      if (!game) {
        if (top) top.textContent = 'Waking the dragon...';
        await new Promise(r => setTimeout(r, 60));                                        // let that label paint before the one-off build
        const cfg = await (await fetch(new URL('dragon.json', import.meta.url))).json();
        ui = buildUi(ctx.touch, { fly: () => game.takeFlight(), next: () => game.next(), walk: exit });
        game = createGame(ctx, cfg, ui);
      }
      for (const k in ctx.keys) ctx.keys[k] = false;
      document.body.classList.add('dragon'); if (top) top.textContent = 'Walk the town';
      if (help) help.textContent = 'A/D or arrows turn. W/S or arrows climb and dive. Hold Space to breathe fire. Shift for speed.';
      game.start(); api.active = true;
    } catch (e) { console.warn('Dragon mode could not start', e); if (top) top.textContent = 'Dragon mode'; }
    busy = false;
  }
  function exit() {
    if (!api.active) return; api.active = false; game.stop();
    document.body.classList.remove('dragon'); if (top) top.textContent = 'Dragon mode'; if (help) help.textContent = helpText;
  }

  for (const b of [top, intro]) if (b) { b.hidden = false; b.onclick = e => { e.stopPropagation(); b.blur(); api.active ? exit() : enter(); }; }
  if (intro) intro.style.visibility = 'visible';
  // Space breathes fire, so it must not scroll the page or re-press a focused button; arrows likewise.
  // Enter (or a fresh press of Space) answers the title card and the dawn tally.
  addEventListener('keydown', e => {
    if (!api.active) return;
    if (e.code === 'Space' || e.code.startsWith('Arrow')) { e.preventDefault(); if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur(); }
    if ((e.code === 'Enter' || e.code === 'Space') && !e.repeat && ui.open && !ui.fresh()) { e.preventDefault(); ui.open === 'card' ? game.takeFlight() : game.next(); }
  });
  addEventListener('keyup', e => { if (api.active && e.code === 'Space') e.preventDefault(); });
  addEventListener('blur', () => { if (api.active) for (const k in ctx.keys) ctx.keys[k] = false; });     // no stuck keys after alt-tab
  return api;
}
