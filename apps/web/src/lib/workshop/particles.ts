/**
 * Chips and coolant for the preview: a few hundred instanced bits with simple physics (scene
 * units are millimetres, Y is up). Chips fly off the cutter, tumble, bounce, come to rest on the
 * work or the table and fade after a while; coolant runs from a nozzle onto the cutter and
 * splashes off. Looks, not a cutting simulation: the checks know nothing of these.
 */
import * as THREE from 'three';

/** What chips of each work material look like. */
export interface ChipLook {
  /** Their colours (picked at random per chip). */
  colors: string[];
  /** Size against the cutter (1: about a tenth of its diameter). */
  size: number;
  /** How long and curly: 1 a tight curl, 3 a long string. */
  curl: number;
  /** Chips per second while cutting. */
  rate: number;
  metal: boolean;
}

export const CHIPS: Record<string, ChipLook> = {
  aluminium: { colors: ['#e9edf0', '#d6dbdf', '#f6f8f9', '#c3c9ce'], size: 1.1, curl: 1.4, rate: 110, metal: true },
  // steel chips come off hot: straw to blue
  steel: { colors: ['#8d949b', '#6f7d95', '#5a6fa8', '#b89a5a', '#7b8189'], size: 0.8, curl: 1, rate: 90, metal: true },
  free_cutting_steel: { colors: ['#9aa1a8', '#7d8794', '#b8a26a', '#8b9198'], size: 0.6, curl: 0.7, rate: 130, metal: true },
  stainless: { colors: ['#c9ccd0', '#b3b7bc', '#d9c88f', '#a9adb3'], size: 0.9, curl: 2.2, rate: 70, metal: true },
  // brass breaks into a spray of small needles
  brass: { colors: ['#e2c05e', '#cfa843', '#edd27e', '#b8933a'], size: 0.45, curl: 0.5, rate: 220, metal: true },
  // plastic comes off in long white strings
  plastic: { colors: ['#f7f5ee', '#ecebe4', '#ffffff'], size: 1.3, curl: 3, rate: 60, metal: false },
};

/** How high the ground is under a point (scene X/Z → Y), or -Infinity where there is none. */
export type Ground = (x: number, z: number) => number;

const G = 6000; // mm/s²: a little under the real thing, so the eye can follow
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpC = new THREE.Color();

/** A curled strip: part of a flat-sectioned ring. */
function chipGeometry(): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(1, 0.22, 4, 14, Math.PI * 1.5);
  g.scale(1, 1, 2.2);
  // a little pitch: a curl, not a ring
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + Math.atan2(p.getY(i), p.getX(i)) * 0.25);
  g.computeVertexNormals();
  return g;
}

/** A fixed pool of bits, the oldest reused when it is full. */
class Pool {
  readonly n: number;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  /** Seconds left (0: free). */
  readonly life: Float32Array;
  readonly size: Float32Array;
  readonly mesh: THREE.InstancedMesh;
  #next = 0;
  alive = 0;

  constructor(n: number, geometry: THREE.BufferGeometry, material: THREE.Material) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.size = new Float32Array(n);
    this.mesh = new THREE.InstancedMesh(geometry, material, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  /** The slot for a new bit. */
  take(): number {
    const i = this.#next;
    this.#next = (this.#next + 1) % this.n;
    return i;
  }

  clear(): void {
    this.life.fill(0);
    this.alive = 0;
    this.mesh.count = 0;
  }
}

export class Chips {
  readonly pool: Pool;
  /** Tumbling: axis and angle, and how fast. */
  #axis: Float32Array;
  #angle: Float32Array;
  #spin: Float32Array;
  /** Stretch along the curl's axis (long strings for plastic). */
  #long: Float32Array;
  /** Lying still. */
  #rest: Uint8Array;
  #carry = 0;
  ground: Ground = () => -Infinity;
  /** Seconds a chip lies before it fades. */
  lie = 7;

  constructor(n = 420) {
    const mat = new THREE.MeshStandardMaterial({ metalness: 0.85, roughness: 0.32, side: THREE.DoubleSide });
    this.pool = new Pool(n, chipGeometry(), mat);
    this.pool.mesh.castShadow = true;
    this.#axis = new Float32Array(n * 3);
    this.#angle = new Float32Array(n);
    this.#spin = new Float32Array(n);
    this.#long = new Float32Array(n);
    this.#rest = new Uint8Array(n);
    this.pool.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  }

  get mesh(): THREE.InstancedMesh {
    return this.pool.mesh;
  }

  /**
   * Chips for `dt` seconds of cutting between `from` and `to` (the cutter's tip), thrown mostly
   * along `away` (unit, scene) with spread; `scale`: the cutter's diameter.
   */
  emit(look: ChipLook, from: THREE.Vector3, to: THREE.Vector3, away: THREE.Vector3, scale: number, dt: number, rnd: () => number = Math.random): void {
    const p = this.pool;
    (p.mesh.material as THREE.MeshStandardMaterial).metalness = look.metal ? 0.85 : 0;
    this.#carry += look.rate * 1.3 * dt;
    const n = Math.min(40, Math.floor(this.#carry));
    this.#carry -= n;
    for (let k = 0; k < n; k++) {
      const i = p.take();
      const t = rnd();
      const r = scale * 0.5;
      // somewhere on the cutter's edge, on the side it throws to
      const a = rnd() * Math.PI * 2;
      p.pos[i * 3] = from.x + (to.x - from.x) * t + away.x * r + Math.cos(a) * r * 0.3;
      p.pos[i * 3 + 1] = from.y + (to.y - from.y) * t + rnd() * scale * 0.2;
      p.pos[i * 3 + 2] = from.z + (to.z - from.z) * t + away.z * r + Math.sin(a) * r * 0.3;
      const speed = 250 + rnd() * 650;
      const spread = 1.1;
      const dx = away.x + (rnd() - 0.5) * spread;
      const dz = away.z + (rnd() - 0.5) * spread;
      const l = Math.hypot(dx, dz) || 1;
      p.vel[i * 3] = (dx / l) * speed;
      p.vel[i * 3 + 1] = away.y * speed * 0.5 + 150 + rnd() * 500;
      p.vel[i * 3 + 2] = (dz / l) * speed;
      p.life[i] = this.lie + 2 + rnd() * 3;
      p.size[i] = Math.max(0.3, scale * 0.13 * look.size * (0.6 + rnd() * 0.8));
      this.#long[i] = 1 + (look.curl - 1) * rnd();
      tmpA.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
      this.#axis.set([tmpA.x, tmpA.y, tmpA.z], i * 3);
      this.#angle[i] = rnd() * 6.28;
      this.#spin[i] = (rnd() - 0.5) * 60;
      this.#rest[i] = 0;
      tmpC.set(look.colors[Math.floor(rnd() * look.colors.length)]!);
      p.mesh.instanceColor!.setXYZ(i, tmpC.r, tmpC.g, tmpC.b);
    }
    if (n) p.mesh.instanceColor!.needsUpdate = true;
  }

  /** Move everything on by `dt` seconds; true while anything is still to be seen. */
  update(dt: number): boolean {
    const p = this.pool;
    let alive = 0;
    let last = -1;
    for (let i = 0; i < p.n; i++) {
      if (p.life[i]! <= 0) {
        tmpM.makeScale(0, 0, 0);
        p.mesh.setMatrixAt(i, tmpM);
        continue;
      }
      p.life[i]! -= dt;
      const j = i * 3;
      if (!this.#rest[i]) {
        p.vel[j + 1]! -= G * dt;
        // air: light things slow down quickly
        const drag = Math.exp(-1.6 * dt);
        p.vel[j]! *= drag;
        p.vel[j + 2]! *= drag;
        p.pos[j]! += p.vel[j]! * dt;
        p.pos[j + 1]! += p.vel[j + 1]! * dt;
        p.pos[j + 2]! += p.vel[j + 2]! * dt;
        this.#angle[i]! += this.#spin[i]! * dt;
        const floor = this.ground(p.pos[j]!, p.pos[j + 2]!) + p.size[i]! * 0.4;
        if (p.pos[j + 1]! < floor) {
          if (floor === -Infinity || !Number.isFinite(floor)) {
            // off the edge of everything
            if (p.pos[j + 1]! < -2000) p.life[i] = 0;
          } else {
            p.pos[j + 1] = floor;
            if (Math.abs(p.vel[j + 1]!) < 220) {
              this.#rest[i] = 1;
              p.life[i] = Math.min(p.life[i]!, this.lie * (0.6 + 0.4 * ((i * 7919) % 100) / 100));
            } else {
              p.vel[j + 1] = -p.vel[j + 1]! * 0.32;
              p.vel[j]! *= 0.55;
              p.vel[j + 2]! *= 0.55;
              this.#spin[i]! *= 0.5;
            }
          }
        }
      }
      if (p.life[i]! <= 0) {
        tmpM.makeScale(0, 0, 0);
        p.mesh.setMatrixAt(i, tmpM);
        continue;
      }
      alive++;
      last = i;
      // shrink away at the end
      const s = p.size[i]! * Math.min(1, p.life[i]! / 0.6);
      tmpA.set(this.#axis[j]!, this.#axis[j + 1]!, this.#axis[j + 2]!);
      tmpQ.setFromAxisAngle(tmpA, this.#angle[i]!);
      tmpM.compose(tmpP.set(p.pos[j]!, p.pos[j + 1]!, p.pos[j + 2]!), tmpQ, tmpS.set(s, s, s * this.#long[i]!));
      p.mesh.setMatrixAt(i, tmpM);
    }
    p.alive = alive;
    p.mesh.count = last + 1;
    p.mesh.instanceMatrix.needsUpdate = true;
    return alive > 0;
  }

  clear(): void {
    this.pool.clear();
    this.#carry = 0;
  }
}

/**
 * Coolant: drops leave the nozzle towards the cutter, fall a little on the way, and splash off
 * where they meet it (or the ground).
 */
export class Coolant {
  readonly pool: Pool;
  /** Free, in the jet, or splashed off. */
  #stage: Uint8Array;
  #carry = 0;
  ground: Ground = () => -Infinity;
  /** Drops per second. */
  rate = 320;

  constructor(n = 360) {
    // a milky emulsion, a little see-through
    const mat = new THREE.MeshStandardMaterial({ color: '#eef8fb', emissive: '#8fc3d6', emissiveIntensity: 0.35, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.86, depthWrite: false });
    this.pool = new Pool(n, new THREE.SphereGeometry(1, 6, 5), mat);
    this.#stage = new Uint8Array(n);
  }

  get mesh(): THREE.InstancedMesh {
    return this.pool.mesh;
  }

  /** `dt` seconds of flow from the nozzle's mouth to the target (the cutter where it meets the work). */
  emit(nozzle: THREE.Vector3, target: THREE.Vector3, width: number, dt: number, rnd: () => number = Math.random): void {
    const p = this.pool;
    this.#carry += this.rate * dt;
    const n = Math.min(30, Math.floor(this.#carry));
    this.#carry -= n;
    const d = tmpA.copy(target).sub(nozzle);
    const dist = d.length() || 1;
    const speed = 620;
    const time = dist / speed;
    for (let k = 0; k < n; k++) {
      const i = p.take();
      const j = i * 3;
      p.pos[j] = nozzle.x + (rnd() - 0.5) * width * 0.3;
      p.pos[j + 1] = nozzle.y + (rnd() - 0.5) * width * 0.3;
      p.pos[j + 2] = nozzle.z + (rnd() - 0.5) * width * 0.3;
      // aimed so that gravity brings it down onto the target
      p.vel[j] = d.x / time + (rnd() - 0.5) * 40;
      p.vel[j + 1] = d.y / time + 0.5 * G * time + (rnd() - 0.5) * 40;
      p.vel[j + 2] = d.z / time + (rnd() - 0.5) * 40;
      p.life[i] = time;
      p.size[i] = width * (0.35 + rnd() * 0.35);
      this.#stage[i] = JET;
    }
  }

  update(dt: number, rnd: () => number = Math.random): boolean {
    const p = this.pool;
    let alive = 0;
    let last = -1;
    for (let i = 0; i < p.n; i++) {
      const j = i * 3;
      if (this.#stage[i] === JET || this.#stage[i] === SPLASH) {
        p.life[i]! -= dt;
        p.vel[j + 1]! -= G * dt;
        p.pos[j]! += p.vel[j]! * dt;
        p.pos[j + 1]! += p.vel[j + 1]! * dt;
        p.pos[j + 2]! += p.vel[j + 2]! * dt;
        if (this.#stage[i] === JET && p.life[i]! <= 0) {
          // it met the cutter: off it goes, sideways and up, as a smaller drop
          this.#stage[i] = SPLASH;
          const a = rnd() * Math.PI * 2;
          const v = 120 + rnd() * 380;
          p.vel[j] = Math.cos(a) * v;
          p.vel[j + 1] = 60 + rnd() * 320;
          p.vel[j + 2] = Math.sin(a) * v;
          p.life[i] = 0.25 + rnd() * 0.45;
          p.size[i]! *= 0.6;
        } else if (this.#stage[i] === SPLASH && (p.life[i]! <= 0 || p.pos[j + 1]! < this.ground(p.pos[j]!, p.pos[j + 2]!))) this.#stage[i] = FREE;
      }
      if (this.#stage[i] === FREE) {
        tmpM.makeScale(0, 0, 0);
        p.mesh.setMatrixAt(i, tmpM);
        continue;
      }
      alive++;
      last = i;
      // drawn out along the way it flies
      const v = Math.hypot(p.vel[j]!, p.vel[j + 1]!, p.vel[j + 2]!) || 1;
      tmpA.set(p.vel[j]! / v, p.vel[j + 1]! / v, p.vel[j + 2]! / v);
      tmpQ.setFromUnitVectors(UP, tmpA);
      const s = p.size[i]!;
      tmpM.compose(tmpP.set(p.pos[j]!, p.pos[j + 1]!, p.pos[j + 2]!), tmpQ, tmpS.set(s, s * (this.#stage[i] === SPLASH ? 1.6 : 3.2), s));
      p.mesh.setMatrixAt(i, tmpM);
    }
    p.alive = alive;
    p.mesh.count = last + 1;
    p.mesh.instanceMatrix.needsUpdate = true;
    return alive > 0;
  }

  clear(): void {
    this.pool.clear();
    this.#stage.fill(FREE);
    this.#carry = 0;
  }
}

const FREE = 0;
const JET = 1;
const SPLASH = 2;
const UP = new THREE.Vector3(0, 1, 0);
