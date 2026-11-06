<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { camera } from './camera.svelte.ts';
  import { project } from './geometry.ts';
  import { store } from '../store.svelte.ts';

  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let raf = 0;
  /** The picture's place on the canvas: scale and offset (image pixels → canvas pixels). */
  let fit = { s: 1, x: 0, y: 0 };
  let shown = -1;
  let shownAt = 0;

  function draw(): void {
    raf = requestAnimationFrame(draw);
    const v = camera.frame;
    const vw = camera.width;
    const vh = camera.height;
    const dpr = window.devicePixelRatio || 1;
    const w = host.clientWidth * dpr;
    const h = host.clientHeight * dpr;
    // only on a new picture (or now and then, for what is drawn over it)
    const n = camera.newFrame(shown);
    const now = performance.now();
    if (canvas.width === w && canvas.height === h && n === shown && now - shownAt < 250) return;
    shown = n;
    shownAt = now;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#111';
    g.fillRect(0, 0, w, h);
    if (!v || !vw) return;
    const s = Math.min(w / vw, h / vh);
    fit = { s, x: (w - vw * s) / 2, y: (h - vh * s) / 2 };
    g.drawImage(v, fit.x, fit.y, vw * s, vh * s);
    // image pixel coordinates (OpenCV: centres at whole numbers) → canvas
    const P = (p: [number, number]): [number, number] => [fit.x + (p[0] + 0.5) * s, fit.y + (p[1] + 0.5) * s];
    g.lineWidth = 2 * dpr;

    // views kept so far: faint outlines of where the board was
    for (const view of camera.views) {
      g.strokeStyle = 'rgba(111, 178, 232, 0.35)';
      g.beginPath();
      for (const q of hull(view.img)) g.lineTo(...P(q));
      g.closePath();
      g.stroke();
    }
    // what the detector sees now
    const b = camera.board;
    if (b) {
      g.strokeStyle = '#ef8a4c';
      for (const m of b.markers) {
        g.beginPath();
        for (const q of m) g.lineTo(...P(q));
        g.closePath();
        g.stroke();
      }
      g.fillStyle = '#9ed3a6';
      for (const q of b.img) {
        const [x, y] = P(q);
        g.beginPath();
        g.arc(x, y, 3 * dpr, 0, Math.PI * 2);
        g.fill();
      }
    }
    for (const m of camera.markers) {
      g.strokeStyle = '#f2d16b';
      g.beginPath();
      for (const q of m.corners) g.lineTo(...P(q));
      g.closePath();
      g.stroke();
      g.fillStyle = '#f2d16b';
      g.font = `${12 * dpr}px system-ui`;
      g.fillText(String(m.id), ...P(m.corners[0]));
    }
    for (const c of camera.clicks) cross(g, ...P(c), '#9ed3a6', dpr);
    // the setup check: where the job has the block (dashed) and where the camera found it
    const measured = camera.block;
    const st = store.job.stock;
    if (measured && st.kind === 'block' && camera.calib.lens && camera.calib.pose) {
      const L = camera.calib.lens;
      const pose = camera.calib.pose;
      const wco: [number, number, number] | null = pose.frame === 'machine' ? camera.wco() : [0, 0, 0];
      const k = L.width / vw;
      const at = (x: number, y: number): [number, number] | null => {
        if (!wco) return null;
        const q = project(L, pose, [x + wco[0], y + wco[1], st.top + wco[2]]);
        return q ? P([q[0] / k, q[1] / k]) : null;
      };
      const outline = (pts: [number, number][], color: string, dash: number[]) => {
        g.strokeStyle = color;
        g.setLineDash(dash.map((d) => d * dpr));
        g.beginPath();
        for (const [i, p] of [...pts, pts[0]!].entries()) {
          // straight in the world, bent by the lens: draw in short pieces
          const prev = i ? (i === pts.length ? pts[pts.length - 1]! : pts[i - 1]!) : p;
          for (let t = i ? 0.1 : 1; t <= 1.0001; t += 0.1) {
            const q = at(prev[0] + (p[0] - prev[0]) * t, prev[1] + (p[1] - prev[1]) * t);
            if (q) g.lineTo(...q);
          }
        }
        g.stroke();
        g.setLineDash([]);
      };
      outline([[0, 0], [st.x, 0], [st.x, st.y], [0, st.y]], 'rgba(255, 255, 255, 0.75)', [6, 5]);
      outline(measured.corners, '#9ed3a6', []);
      g.fillStyle = '#9ed3a6';
      for (const e of measured.edges)
        for (const h of e.hits) {
          const q = at(h[0], h[1]);
          if (q) g.fillRect(q[0] - dpr, q[1] - dpr, 2 * dpr, 2 * dpr);
        }
    }
    // once calibrated: where the camera thinks work zero is
    const { lens, pose } = camera.calib;
    if (lens && pose && pose.kind === store.job.machine.kind) {
      const wco: [number, number, number] | null = pose.frame === 'machine' ? camera.wco() : [0, 0, 0];
      if (wco) {
        const o = project(lens, pose, [wco[0], wco[1], wco[2]]);
        const k = lens.width / vw;
        if (o) cross(g, ...P([o[0] / k, o[1] / k]), '#f2d16b', dpr);
      }
    }
  }

  function cross(g: CanvasRenderingContext2D, x: number, y: number, color: string, dpr: number): void {
    g.strokeStyle = color;
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.moveTo(x - 9 * dpr, y);
    g.lineTo(x + 9 * dpr, y);
    g.moveTo(x, y - 9 * dpr);
    g.lineTo(x, y + 9 * dpr);
    g.stroke();
  }

  /** Outline of a point set (gift wrapping; a few dozen points). */
  function hull(pts: [number, number][]): [number, number][] {
    if (pts.length < 3) return pts;
    const out: [number, number][] = [];
    let p = pts.reduce((a, b) => (b[0] < a[0] ? b : a));
    do {
      out.push(p);
      let q = pts[0]!;
      for (const r of pts) {
        const c = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
        if (q === p || c < 0) q = r;
      }
      p = q;
    } while (p !== out[0] && out.length < pts.length);
    return out;
  }

  /** A click on the picture, in image pixels (exposed for tests: `window.__swarfCameraClick`). */
  function toImage(clientX: number, clientY: number): [number, number] {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return [((clientX - r.left) * dpr - fit.x) / fit.s - 0.5, ((clientY - r.top) * dpr - fit.y) / fit.s - 0.5];
  }

  function onClick(e: MouseEvent): void {
    if (camera.awaitingClick) camera.click(toImage(e.clientX, e.clientY));
  }

  onMount(() => {
    draw();
    (window as unknown as { __swarfImageToClient?: unknown }).__swarfImageToClient = (u: number, v: number) => {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      return [r.left + (fit.x + (u + 0.5) * fit.s) / dpr, r.top + (fit.y + (v + 0.5) * fit.s) / dpr];
    };
  });
  onDestroy(() => cancelAnimationFrame(raf));
</script>

<div class="cam" bind:this={host}>
  <canvas bind:this={canvas} class:pick={camera.awaitingClick} onclick={onClick}></canvas>
  {#if camera.progress || camera.status}
    <div class="note">{camera.progress || camera.status}</div>
  {/if}
</div>

<style>
  .cam { position: absolute; inset: 0; background: #111; }
  canvas { display: block; width: 100%; height: 100%; }
  canvas.pick { cursor: crosshair; }
  .note { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); background: rgba(0, 0, 0, 0.7); color: #fff; padding: 6px 12px; border-radius: 8px; font-size: 13px; max-width: 90%; text-align: center; }
</style>
