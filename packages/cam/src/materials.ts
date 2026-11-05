/**
 * Cutting data by workpiece material, for HSS and carbide, sized for hobby machines (a lathe like a
 * small Weiler or a converted mill: modest rigidity and power). Conservative starting points from
 * the usual handbook ranges, at the lower end; a tool's own values override them.
 *
 * vc in m/min per kind of cut; feed per revolution (turning, grooving) in mm; drill feed and
 * endmill feed per tooth as a fraction of the tool diameter; depth of cut per pass radial on the
 * lathe (mm) and axial on the mill (× tool diameter).
 */
import { z } from 'zod';

export const MaterialId = z.enum(['aluminium', 'free_cutting_steel', 'steel', 'stainless', 'brass', 'plastic']);
export type MaterialId = z.infer<typeof MaterialId>;
export type ToolMaterial = 'hss' | 'carbide';
export type CutKind = 'turning' | 'grooving' | 'threading' | 'drilling' | 'milling';

interface MaterialData {
  name: string;
  /** Typical grades, for the user and the assistant. */
  examples: string;
  vc: Record<CutKind, Record<ToolMaterial, number>>;
  /** mm/rev */
  turnFeed: number;
  grooveFeed: number;
  /** drill feed per rev = drill × d */
  drill: number;
  /** endmill feed per tooth = mill × d (carbide; HSS gets 70 %) */
  mill: number;
  /** radial depth per turning pass, mm */
  turnDoc: number;
  /** axial depth per milling pass, × d */
  millDoc: number;
}

const v = (turning: [number, number], grooving: [number, number], threading: [number, number], drilling: [number, number], milling: [number, number]) => {
  const e = (x: [number, number]) => ({ hss: x[0], carbide: x[1] });
  return { turning: e(turning), grooving: e(grooving), threading: e(threading), drilling: e(drilling), milling: e(milling) };
};

export const MATERIALS: Record<MaterialId, MaterialData> = {
  aluminium: { name: 'Aluminium', examples: '6082, 6061, 5083, 2007', vc: v([80, 150], [40, 120], [30, 100], [40, 80], [60, 200]), turnFeed: 0.12, grooveFeed: 0.05, drill: 0.015, mill: 0.005, turnDoc: 1, millDoc: 0.5 },
  free_cutting_steel: { name: 'Free-cutting steel', examples: '11SMnPb30 (1.0718), 9SMn28, ETG 100', vc: v([35, 150], [20, 80], [15, 60], [25, 60], [25, 120]), turnFeed: 0.1, grooveFeed: 0.04, drill: 0.012, mill: 0.0035, turnDoc: 0.75, millDoc: 0.3 },
  steel: { name: 'Steel', examples: 'S235, C45, 42CrMo4 (annealed)', vc: v([25, 120], [15, 60], [12, 50], [20, 50], [20, 100]), turnFeed: 0.08, grooveFeed: 0.03, drill: 0.01, mill: 0.003, turnDoc: 0.5, millDoc: 0.25 },
  stainless: { name: 'Stainless steel', examples: '1.4305 (303), 1.4301 (304), 1.4404 (316L)', vc: v([12, 90], [8, 45], [6, 35], [10, 30], [10, 70]), turnFeed: 0.08, grooveFeed: 0.03, drill: 0.008, mill: 0.0025, turnDoc: 0.4, millDoc: 0.2 },
  brass: { name: 'Brass', examples: 'CuZn39Pb3 (Ms58), CuZn37', vc: v([70, 150], [35, 100], [25, 80], [50, 90], [60, 180]), turnFeed: 0.1, grooveFeed: 0.05, drill: 0.015, mill: 0.005, turnDoc: 1, millDoc: 0.5 },
  plastic: { name: 'Plastic', examples: 'POM (Delrin), PA6, PE, PVC', vc: v([100, 250], [60, 150], [40, 100], [50, 80], [100, 250]), turnFeed: 0.15, grooveFeed: 0.06, drill: 0.02, mill: 0.008, turnDoc: 1.5, millDoc: 0.75 },
};

/** What kind of cut a tool makes. */
export function cutKind(toolType: string): CutKind {
  switch (toolType) {
    case 'grooving':
      return 'grooving';
    case 'threading':
      return 'threading';
    case 'drill':
      return 'drilling';
    case 'endmill':
      return 'milling';
    default:
      return 'turning';
  }
}

/** Drills are usually HSS, inserts and endmills carbide, unless the tool says. */
export const defaultToolMaterial = (toolType: string): ToolMaterial => (toolType === 'drill' ? 'hss' : 'carbide');
