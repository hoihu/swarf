/**
 * The things around the work in the preview: the mill's table with its T-slots, cutters with
 * flutes one can see turn, the lathe's tool in its holder, a chuck with jaws, the coolant nozzle.
 * Scene units are millimetres, Y is up; cutters point down with their tip at the origin.
 */
import * as THREE from 'three';

const steel = (color: string, rough = 0.4) => new THREE.MeshStandardMaterial({ color, metalness: 0.9, roughness: rough });

/** A cast-iron table under the block: ground top, T-slots along X. `top`: its surface (scene Y). */
export function tableMesh(sx: number, sy: number, top: number): THREE.Group {
  const g = new THREE.Group();
  const w = sx + Math.max(120, sx);
  const d = sy + Math.max(90, sy * 0.8);
  const h = 22;
  // the top as a picture: ground iron, slots as dark bands with a lighter chamfer
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 512;
  const x = c.getContext('2d')!;
  x.fillStyle = '#8b9296';
  x.fillRect(0, 0, 64, 512);
  // grinding marks
  for (let i = 0; i < 500; i++) {
    x.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${0.02 + Math.random() * 0.04})`;
    x.fillRect(0, Math.random() * 512, 64, 1);
  }
  const pitch = 63; // mm between slots
  const slots = Math.max(1, Math.round(d / pitch));
  const px = 512 / slots;
  for (let i = 0; i < slots; i++) {
    const y = (i + 0.5) * px;
    const half = (6 / pitch) * px;
    x.fillStyle = '#c0c6c9';
    x.fillRect(0, y - half - 2, 64, 2);
    x.fillRect(0, y + half, 64, 2);
    x.fillStyle = '#2b2f32';
    x.fillRect(0, y - half, 64, half * 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(w / 40, 1);
  tex.anisotropy = 4;
  const side = steel('#5d6468', 0.6);
  const topMat = new THREE.MeshStandardMaterial({ map: tex, metalness: 0.75, roughness: 0.45 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, topMat, side, side, side]);
  box.position.set(sx / 2, top - h / 2 - 0.02, -sy / 2);
  box.receiveShadow = true;
  g.add(box);
  g.userData.extent = { x0: sx / 2 - w / 2, x1: sx / 2 + w / 2, z0: -sy / 2 - d / 2, z1: -sy / 2 + d / 2 };
  return g;
}

/** The lathe's bed below the work: two ways along the spindle axis. */
export function bedMesh(zFrom: number, zTo: number, y: number, width: number): THREE.Group {
  const g = new THREE.Group();
  const len = zTo - zFrom;
  const base = new THREE.Mesh(new THREE.BoxGeometry(len, 14, width), steel('#4a5155', 0.7));
  base.position.set((zFrom + zTo) / 2, y - 7, 0);
  base.receiveShadow = true;
  g.add(base);
  for (const s of [-1, 1]) {
    const way = new THREE.Mesh(new THREE.BoxGeometry(len, 5, width * 0.16), steel('#aab1b5', 0.25));
    way.position.set((zFrom + zTo) / 2, y + 2.5, s * width * 0.3);
    way.receiveShadow = true;
    g.add(way);
  }
  return g;
}

/**
 * A cutter body whose section is drawn in by `flutes` grooves winding up it (an end mill, or a
 * drill with a point): one can see it turn.
 */
function fluted(diameter: number, length: number, flutes: number, point: number): THREE.BufferGeometry {
  const r = diameter / 2;
  const g = new THREE.CylinderGeometry(r, r, length, 40, 28, false);
  g.translate(0, length / 2, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const lead = diameter * 3.2; // one turn of the helix
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const rr = Math.hypot(x, z);
    if (rr < 1e-6) {
      // the middle of the end faces: the drill's point comes down to the tip
      if (y < 1e-6) p.setY(i, 0);
      else p.setY(i, y);
      continue;
    }
    const a = Math.atan2(z, x) + (y / lead) * 2 * Math.PI;
    // a groove per flute: deep and rounded, the lands between them at full size
    const s = 0.5 + 0.5 * Math.cos(a * flutes);
    const k = 1 - 0.34 * Math.pow(s, 1.6);
    // the drill's point: the rim rises towards the outside
    const up = point > 0 && y < 1e-6 ? r * point : 0;
    p.setXYZ(i, x * k, y + up, z * k);
  }
  g.computeVertexNormals();
  return g;
}

/** The cutter as it hangs in the spindle: flutes, shank, collet nut. `spin`: the part that turns. */
export function millToolMesh(type: 'endmill' | 'drill' | 'chamfer' | 'threadmill', diameter: number, fluteLength: number | undefined, flutes = 3, angle = 90): THREE.Group & { userData: { spin: THREE.Object3D } } {
  const g = new THREE.Group();
  const spin = new THREE.Group();
  if (type === 'chamfer' || type === 'threadmill') {
    const metal = new THREE.MeshStandardMaterial({ color: '#9ea5ab', metalness: 0.95, roughness: 0.22, flatShading: type === 'chamfer' });
    const r = diameter / 2;
    let top: number;
    if (type === 'chamfer') {
      // a cone from the point up to the full diameter (with flats, so its turning shows), then the shank
      const h = r / Math.tan(((angle / 2) * Math.PI) / 180);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, Math.max(3, flutes) * 2).rotateX(Math.PI).translate(0, h / 2, 0), metal);
      cone.castShadow = true;
      spin.add(cone);
      top = h;
    } else {
      // one row of teeth on a thinner neck
      const head = new THREE.Mesh(fluted(diameter, diameter * 0.35, Math.max(3, flutes), 0), metal);
      head.castShadow = true;
      spin.add(head);
      const neckLen = Math.max(diameter, fluteLength ?? diameter * 2.5);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, neckLen, 24), metal);
      neck.position.y = diameter * 0.35 + neckLen / 2;
      spin.add(neck);
      top = diameter * 0.35 + neckLen;
    }
    const shankLen = Math.max(8, diameter * 1.6);
    const shank = new THREE.Mesh(new THREE.CylinderGeometry(r, r, shankLen, 32), new THREE.MeshStandardMaterial({ color: '#9ea5ab', metalness: 0.95, roughness: 0.22 }));
    shank.position.y = top + shankLen / 2;
    shank.castShadow = true;
    spin.add(shank);
    const nutR = Math.max(diameter * 1.25, 9);
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(nutR * 0.82, nutR, nutR * 1.1, 6), steel('#596167', 0.4));
    nut.position.y = top + shankLen + nutR * 0.55;
    spin.add(nut);
    g.add(spin);
    g.userData.spin = spin;
    g.userData.top = top + shankLen;
    return g as never;
  }
  const cut = Math.max(diameter * 1.5, Math.min(fluteLength ?? diameter * 3, diameter * 6));
  const carbide = new THREE.MeshStandardMaterial({ color: type === 'drill' ? '#c9a94a' : '#9ea5ab', metalness: 0.95, roughness: 0.22 });
  const body = new THREE.Mesh(fluted(diameter, cut, type === 'drill' ? 2 : flutes, type === 'drill' ? 0.6 : 0), carbide);
  body.castShadow = true;
  spin.add(body);
  const shankLen = Math.max(8, diameter * 1.6);
  const shank = new THREE.Mesh(new THREE.CylinderGeometry(diameter / 2, diameter / 2, shankLen, 32), carbide);
  shank.position.y = cut + shankLen / 2;
  shank.castShadow = true;
  spin.add(shank);
  // collet nut: a knurled ring with flats, and the spindle nose above it
  const nutR = Math.max(diameter * 1.25, 9);
  const nut = new THREE.Mesh(new THREE.CylinderGeometry(nutR * 0.82, nutR, nutR * 1.1, 6), steel('#596167', 0.4));
  nut.position.y = cut + shankLen + nutR * 0.55;
  nut.castShadow = true;
  spin.add(nut);
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(nutR * 1.25, nutR * 1.08, nutR * 0.9, 40), new THREE.MeshStandardMaterial({ color: '#c3c9cd', metalness: 0.6, roughness: 0.35 }));
  nose.position.y = cut + shankLen + nutR * 1.1 + nutR * 0.45;
  nose.castShadow = true;
  g.add(nose);
  g.add(spin);
  g.userData.spin = spin;
  g.userData.top = cut + shankLen;
  return g as never;
}

/** The lathe's tool: a gold insert on a black holder, its tip at the origin, the holder going up and back. */
export function latheToolMesh(): THREE.Group {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(5, 2.5);
  shape.lineTo(3.5, 9);
  shape.lineTo(-1.5, 6.5);
  shape.closePath();
  const insert = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: true, bevelSize: 0.25, bevelThickness: 0.25, bevelSegments: 2 }), new THREE.MeshStandardMaterial({ color: '#d8a520', metalness: 0.85, roughness: 0.28 }));
  insert.geometry.translate(0, 0, -1.5);
  insert.castShadow = true;
  g.add(insert);
  // the screw in the middle of the insert
  const screw = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.6, 16), steel('#2a2d30', 0.4));
  screw.rotation.x = Math.PI / 2;
  screw.position.set(1.8, 4.6, 1.9);
  g.add(screw);
  const holder = new THREE.Mesh(new THREE.BoxGeometry(12, 46, 12), new THREE.MeshStandardMaterial({ color: '#23272a', metalness: 0.7, roughness: 0.5 }));
  holder.position.set(3.2, 29, -7.6);
  holder.castShadow = true;
  g.add(holder);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(9, 9, 3), new THREE.MeshStandardMaterial({ color: '#23272a', metalness: 0.7, roughness: 0.5 }));
  seat.position.set(2.2, 6.2, -3.1);
  g.add(seat);
  return g;
}

/** The chuck: body, three stepped jaws gripping the bar. It turns about scene X (`userData.spin`). */
export function chuckGroup(chuckZ: number, diameter: number, barDiameter: number): THREE.Group {
  const g = new THREE.Group();
  const spin = new THREE.Group();
  const len = Math.max(20, diameter * 0.35);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(diameter / 2, diameter / 2, len, 64).rotateZ(-Math.PI / 2), steel('#4a5257', 0.45));
  body.position.x = -len / 2;
  body.castShadow = true;
  spin.add(body);
  // a chamfer ring and the scroll's key holes make its turning visible
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const jaw = new THREE.Group();
    const steps = 2;
    for (let s = 0; s < steps; s++) {
      const inner = barDiameter / 2 + (s * (diameter / 2 - barDiameter / 2)) / (steps + 0.5);
      const outer = diameter / 2 - 2;
      const jl = (Math.min(9, len * 0.4) * (steps - s)) / steps;
      const box = new THREE.Mesh(new THREE.BoxGeometry(jl, Math.max(2, outer - inner), diameter * 0.12), steel('#7d858a', 0.35));
      box.position.set(jl / 2, (inner + outer) / 2, 0);
      box.castShadow = true;
      jaw.add(box);
    }
    jaw.rotation.x = a;
    spin.add(jaw);
    const hole = new THREE.Mesh(new THREE.CylinderGeometry(diameter * 0.035, diameter * 0.035, 1, 12), steel('#15181a', 0.8));
    hole.position.set(-len * 0.5, Math.cos(a + 1) * (diameter / 2), Math.sin(a + 1) * (diameter / 2));
    hole.rotation.x = a + 1;
    hole.scale.y = 2;
    spin.add(hole);
  }
  spin.position.x = chuckZ;
  g.add(spin);
  g.userData.spin = spin;
  return g;
}

/** A segmented coolant hose ending in a nozzle; from `from` (where it is fixed) to its mouth at `mouth` (local coordinates). */
export function nozzleMesh(from: THREE.Vector3, mouth: THREE.Vector3, size: number): THREE.Group {
  const g = new THREE.Group();
  const blue = new THREE.MeshStandardMaterial({ color: '#2b6cb0', metalness: 0, roughness: 0.45 });
  const orange = new THREE.MeshStandardMaterial({ color: '#e07b1a', metalness: 0, roughness: 0.45 });
  // a sagging curve of beads
  const mid = from.clone().lerp(mouth, 0.5).add(new THREE.Vector3(0, size * 2.2, 0));
  const curve = new THREE.QuadraticBezierCurve3(from, mid, mouth);
  const n = 9;
  for (let i = 0; i < n; i++) {
    const bead = new THREE.Mesh(new THREE.SphereGeometry(size * (i === n - 1 ? 0.75 : 1), 12, 10), i === n - 1 ? orange : blue);
    bead.position.copy(curve.getPoint(i / (n - 1)));
    g.add(bead);
  }
  const dir = curve.getTangent(1);
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.35, size * 0.7, size * 2.4, 12), orange);
  tip.position.copy(mouth).addScaledVector(dir, size * 0.6);
  tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.add(tip);
  g.userData.mouth = mouth.clone().addScaledVector(dir, size * 1.8);
  return g;
}

/** How each work material looks once cut, and as it came (raw: duller, a little darker). */
export const METAL: Record<string, { color: string; raw: string; metalness: number; roughness: number }> = {
  aluminium: { color: '#d3d8dc', raw: '#a9afb3', metalness: 0.92, roughness: 0.3 },
  steel: { color: '#a3a9af', raw: '#5f6569', metalness: 0.92, roughness: 0.36 },
  free_cutting_steel: { color: '#aeb4b9', raw: '#73797d', metalness: 0.92, roughness: 0.34 },
  stainless: { color: '#c3c6ca', raw: '#a2a6aa', metalness: 0.95, roughness: 0.26 },
  brass: { color: '#dcb95a', raw: '#b0913f', metalness: 0.93, roughness: 0.28 },
  plastic: { color: '#f3f1e8', raw: '#e2dfd3', metalness: 0, roughness: 0.5 },
};
