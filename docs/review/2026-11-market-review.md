# Market review, November 2026: professional and hobby CAM against swarf

Written 2026-11-24 at `a3e22f2`. Docs only: nothing here is implemented, and nothing here starts
L4–L14, C12 or C13.

## Executive summary

1. No tool in this survey combines what swarf already has in one place: an agent that fills
   tested operations, checks that block output, a lathe and a mill material model, and
   camera, microphone and probe at the machine. The professional AI assistants (CloudNC, Toolpath,
   Mastercam Copilot, Hexagon ProPlanAI, Siemens NX) all work the same way round as swarf, choosing
   operations inside a CAM kernel and never writing G-code text, but they start from a 3D model,
   cost a subscription on top of a CAM seat, and barely cover lathes.
2. The hobby lathe is the emptiest part of the market. FreeCAD's turning add-on says its threading
   "does not currently produce valid G-code", Kiri:Moto's "lathe" is a rotary axis on a mill,
   CamBam's is experimental, CAMotics has no lathe simulation. People use conversational screens
   (ioSender, PathPilot, Intercon) or an electronic leadscrew. swarf's lathe side is its strongest card.
3. Where swarf is behind is ordinary and cheap to fix: it cannot drill the holes of a drawing, has
   no hole patterns, no thread or fit tables, no tube stock, no second clamping on the lathe, no
   rest machining, no internal profile, no holder check. Most of these are S-size.
4. The cheapest gaps have one thing in common: they take a number away from the model and give
   it to deterministic code (hole positions, bolt circles, thread data). They close the failure the
   README names: "a 3 read as an 8 makes a part that passes every check".
5. The earlier ranking (C1–C13) mostly holds. Changes: C6 (tables) moves up, three gaps the earlier
   study missed are added (hole patterns, the lathe's other end, a tailstock in the model), and
   C13 (coolant) is now six PRs, not one, because of the output-mapping design.
6. The new ideas (section 5) all use something professional CAM lacks: swarf knows what the user
   *said* the part is, simulates in milliseconds, and is present at the machine. The best three:
   stated dimensions become checks ("the part contract"), measure-and-compensate finishing on the
   lathe ("sneak up on it"), and checks that work out their own smallest fix.
7. C4 (spindle power) is parked for lack of nameplate figures. Idea N3 (a test piece that measures
   the machine) is a way round that needs no ratings.
8. Nothing proposed lets the model write or patch G-code, and nothing weakens a check. Every idea
   is a new operation, check, Job field, read of the material model, or agent tool that names
   things for deterministic code.
9. Recommended after L4–L14: holes and patterns from the drawing, standards tables, the part
   contract, sneak-up finishing, then the two approved items (C13, C12).
10. Five decisions are Martin's (section 7). None blocks the rest.

## How this was done, and what it does not cover

- **swarf's side** was read in the code at `a3e22f2`: `packages/cam/src/schema.ts` (all 21
  operations, `Machine`, `Tool`, `Stock`), `check.ts`, `lint-gcode.ts`, `review.ts`, `feeds.ts`,
  `sim.ts`, `setups.ts`, `carry.ts`, `packages/agent/src/{prompt,tools}.ts`,
  `packages/grbl/src/status.ts`, and the exports of the camera, listening, probing and
  tool-change modules in `apps/web/src/lib`. README claims were used only where the code agreed.
- **The market side** was researched on the web on 2026-11-24, on top of the study of 2026-11-22.
  Every claim carries a tag:
  - **[F]** the page was fetched and read on 2026-11-24;
  - **[S]** seen only in a search-result snippet on 2026-11-24 (autodesk.com and hexagon.com
    refused fetches, so all of their claims are [S]);
  - **[P]** from the 2026-11-22 study, whose URLs were checked then;
  - **[K]** from general knowledge, not live-checked.
  Prices change and vendor claims ("75 % faster") are the vendors' own. URLs are in "Sources".
- **Not covered:** no product was installed or run; nothing was tried on a machine; grblHAL's
  behaviour (G96, X during G33, aux outputs) is from its wiki, which marks lathe mode and spindle
  sync as preliminary.

## 1. Frame

swarf is for one person with a benchtop lathe or 3-axis mill on grblHAL, who makes one-off parts in
aluminium, brass, plastic and some steel, often from a sketch or a DXF rather than a 3D model, and
who is not a full-time CAM programmer. The machine has little power and rigidity, usually no tool
changer, often no probe, and no second chance on a crash.

Left out of every recommendation: 5-axis, mill-turn, Swiss, production cells, 3D surfacing (Tier 3
in ARCHITECTURE), wood-router features (V-carve inlays, nesting). They appear in the survey only
where they suggest something a benchtop machine can use.

## 2. Market survey

"How swarf differs" is one sentence each; the common part is not repeated: in swarf an agent fills
tested operations, the model never writes G-code, check errors block every output, and the
material model, camera, listening and multi-setup carry are built in.

### Professional CAM

| Product | Who it is for | What it does well | Weak for a hobby grblHAL user | How swarf differs |
|---|---|---|---|---|
| **Autodesk Fusion** (Manufacture, incl. turning) | From hobbyists to job shops; the default hobby CAM. Free for non-commercial use under $1,000/yr revenue; paid about $680/yr [S: A-personal, A-price] | 2D/3D adaptive with rest machining [P: F-adaptive]; turning with OD and ID profile, groove, thread, part [S: A-turn; P: F-turn-rough]; stock simulation with comparison colours [P: F-sim-forum]; setup sheets; a post library | The free tier posts no rapids and no tool changes, one tool per program [S: A-free]; hole recognition, geometry probing and part alignment are in the paid Manufacturing Extension [S: A-ext]; needs a 3D model first; grblHAL lathe posts are community work [K]; cloud account | swarf starts from words, a sketch or a DXF, needs no model, and its checks know the chuck and the clamps without a modelled fixture. |
| **Mastercam** (Mill, Lathe) | Production shops; sold by resellers, about $10–15k a seat (third-party estimate) [S: MC-price] | Dynamic Motion (constant chip load) on mill and lathe [P: MC-dyn, MC-lathe-dyn]; depth of options; Copilot answers from the help and executes commands on request [F: MC-copilot] | Price; the free Learning Edition posts no G-code [S: MC-learn]; no hobby posts or support | swarf has a fraction of the strategies, but each is a tested function with checks, and one person can read all of it. |
| **HSMWorks / Inventor CAM** | SOLIDWORKS and Inventor users | The Fusion kernel inside the CAD they already own | HSMWorks left new Fusion subscriptions in March 2025 and is retired in March 2028 [S: A-hsm]; needs a CAD seat | Nothing to add beyond Fusion; a reminder that a CAM tied to someone's CAD goes when the vendor says so. swarf is a checkout. |
| **SolidCAM** (iMachining) | SOLIDWORKS shops; a free Maker version for non-commercial use [F: SC-maker] | The Technology Wizard: feeds, speeds, depth and engagement from material, tool, the machine's limits and an 8-level slider for how rigid machine and holding are [F: SC-wizard] | Maker needs SOLIDWORKS desktop and has fixed posts only (ISO milling, Mach3, ISO turning) [F: SC-maker]; no grblHAL lathe post | swarf's table is one conservative row per material; it has nothing like the rigidity level (see gap G14 and idea N3, which measures it instead of asking). |
| **Hexagon ESPRIT EDGE** | Production turning, mill-turn, Swiss [S: HX-swiss] | ProfitTurning (high-speed lathe roughing) [S: HX-profit]; ProPlanAI proposes processes learned from the shop's own past programs [S: HX-ai] | Price and scope; ProPlanAI needs a history of files a hobbyist does not have | swarf needs no history: the rules are in the operations and the review list. The idea of learning from the shop's own past work returns as N4. |
| **Open Mind hyperMILL** | Mould, aerospace, 5-axis | MAXX Machining; VIRTUAL Machining with a two-way link to the machine (CONNECTED Machining) [S: OM-virtual]; automatic rest-material detection in 2026 [S: OM-2026] | Out of reach in price and scope | swarf already has the two-way link at hobby scale (it streams, reads positions, probes, sees and hears); few tools below this tier do. |
| **AI assistants on top of CAM**: CloudNC CAM Assist, Toolpath, Siemens NX suggestions, Limitless Labs, Sandvik Copilot | Shops with a CAM seat and 3D models | CAM Assist generates strategies, operations and feeds from the shop's tool library, "up to 80 %" of a program, inside Fusion, Mastercam, NX, GibbsCAM, SolidCAM [F: CNC]; Toolpath: $0–$125 per seat and month, automated programming exported to Fusion [F: TP]; NX offers three suggestions per selected face [S: NX-ai]; Fusion has announced AI-generated CAM programming [S: A-ai] | 3-axis and 3+2 milling; lathes "in development" at CloudNC [F: CNC]; need a solid model and a paid host CAM; none found that targets hobby machines or uses a camera or microphone | Same principle (the model picks operations, the kernel writes the code), but swarf closes the loop: the agent cannot finish while checks fail, and the machine side feeds back. |
| **Verification**: Vericut, NCSIMUL | Shops protecting expensive machines | AUTO-DIFF compares the simulated part with the design model for gouges and excess [F: VC-diff]; Force sets feeds from chip thickness, force and spindle power [S: VC-force] | Price | swarf's model is coarse (0.05 mm slices, a height map), but it is in the loop on every edit, and it has a lathe. |
| **In-process monitoring**: Harmonizer, Caron TMAC, Marposs, CoroPlus | Production | Harmonizer: a microphone hears the cut and recommends a stable spindle speed [S: HZ]; TMAC: spindle power and vibration, adaptive feed override [S: TMAC] | Thousands per machine (one unverified figure: about $5k for TMAC) [S: TMAC-price] | swarf's listening panel is the Harmonizer idea with a laptop microphone, for nothing; it has not heard a real cut yet (README). |

### Hobby and mid-tier CAM

| Product | Who it is for | What it does well | Weak for a hobby grblHAL user | How swarf differs |
|---|---|---|---|---|
| **Vectric VCarve / Aspire** | Wood routers, sign makers; $349 / $699 / $1,995 perpetual [F: VEC] | V-carving, inlays, multi-tool rest clearance, a realistic preview [F: VEC] | No lathe toolpaths at all; wood-first feeds; no machine-side features [F: VEC] | swarf is metal-first and has a lathe; it has no V-carve and should not chase it. |
| **Carbide Create** | Shapeoko/Nomad owners; free, Pro $120/yr or $360 [F: CC-pro] | Simple 2.5D that works; Pro adds rest machining and 3D [F: CC-pro] | Core is for Carbide machines; no lathe, no probing mentioned [F: CC-pro] | swarf matches Core's 2.5D and adds checks against clamps; Pro's rest machining is gap G6. |
| **Estlcam** | Hobby mills and routers; about €49 [S: EST-price] | Fast from DXF to chips: trochoidal milling, thread milling, its own controller [F: EST]; automatic drill points from drawing holes [P: Estl-auto] | Mill only; no material model, no collision checks | Estlcam is the benchmark for "DXF in, part out in ten minutes"; swarf cannot yet drill a drawing's holes (G1). |
| **FreeCAD CAM** (1.1, March 2026) | Open-source users who model in FreeCAD | Adaptive, helix, thread milling, V-carve, deburr, probe grid with Z correction, dogbone / ramp / lead-in dress-ups, a simulator, a new tool library, experimental tapping [F: FC-11, FC-cam] | "Operations are not clamp-aware"; lathe only through an experimental add-on whose threading does not produce valid G-code [F: FC-cam, FC-turn]; steep learning curve | swarf's lathe works end to end with threads, and its checks know clamps and chuck. FreeCAD has lead-ins and dogbones; swarf has neither (G15). |
| **Kiri:Moto** | Browser users with STL models | Runs locally in the browser like swarf; roughing, outline, contour from a mesh [F: KM] | Its "lathe" is indexed stock on a mill's fourth axis, by the developer's own word [F: KM-lathe]; no checks against fixtures | Both are browser-local; Kiri:Moto is model-in, swarf is words-in and has a real lathe. |
| **CAMotics** | Anyone wanting a free G-code simulator | 3-axis material removal from G-code | "No lathe simulation"; no collision, gouge or rapid-in-material detection [F: CAMO] | swarf's built-in checks already do what the free verifier does not. |
| **Senders with CAM-like features**: bCNC, gSender, ioSender, Candle | grbl users at the machine | bCNC: autolevel, centre finder, tool-length probing, camera overlay for zeroing [F: BCNC]; gSender: probing, surfacing and tool-change wizards [F: GS]; Candle: height map on conductive stock [S: CANDLE] | They do not know the part: no material, no clamps, no operations | swarf's machine side knows the job, so its camera can ask "is this the right cutter?" and its restart knows which operation it stopped in. Bore and boss centring (bCNC has it) is gap G11. |

### Lathe-specific

| Product | Who it is for | What it does well | Weak for a hobby grblHAL user | How swarf differs |
|---|---|---|---|---|
| **Fusion turning** | Hobby to job shop | The only widely used hobby-reachable lathe CAM: OD/ID profile roughing and finishing, grooves on OD, ID and face, threads from standard tables, part [S: A-turn; P: F-turn-guide] | Needs a revolved model; the free tier's limits; grblHAL lathe posts are not Autodesk's [K] | swarf turns from "Ø20 to Z-30" or a side-view DXF, and writes G33 passes for grblHAL directly. No ID profile yet (G8). |
| **Mastercam Lathe, ESPRIT** | Production | Dynamic / ProfitTurning roughing with button inserts [S: MC-x7, HX-profit] | Price; a benchtop lathe cannot use the removal rates | Not a target. |
| **LinuxCNC G71/G72/G70, G76, G33** | LinuxCNC lathe owners who write G-code | Profile roughing from a subroutine in the controller; G76 with tapers, degression, compound angle, spring passes; G33 follows X and Z, so taper threads work [F: LCNC] | G71/G72 need a monotonic profile and are documented as "somewhat fragile" [F: LCNC]; hand-written G-code; no material check | swarf does the cycle's work in tested code and writes plain G0/G1/G33, so the same file runs where there is no G71. Its profile is monotonic too. |
| **grblHAL lathe mode** | swarf's target | G7/G8, G33, G76, G95, G96/G97, depending on driver and encoder [F: GH-codes] | No G70–G72; spindle sync page marked "PRELIMINARY" [F: GH-sync]; whether G33 takes X is not verified (S8 stays parked) | swarf is, as far as this survey found, the only CAM that targets this controller's lathe mode on purpose. |
| **Conversational screens**: ioSender lathe mode, Tormach PathPilot, Centroid Intercon, Mach4 | Owners of that controller | One form per cut (turn, face, thread, part), no CAD or CAM; ioSender has it for grblHAL lathe mode [F: IOS]; Intercon is a $175 licence on an Acorn [S: CENT] | One feature at a time; nothing knows the whole part or the material left; Windows only for ioSender [F: IOS] | swarf's forms are the same idea, but the operations share one material model and one check run, and an agent can fill them in. |
| **FreeCAD Turning add-on, CamBam turning, Kiri:Moto** | Open-source users | Roughing, profiling, drilling, parting from a model [F: FC-turn] | Experimental; no valid threading [F: FC-turn]; CamBam's lathe "experimental" [S: CB] | See summary point 2. |
| **Electronic leadscrew** (Clough42 and others) | Manual-lathe owners | Feeds and threads without change gears [S: ELS] | Not CNC: no cycles, no profiles | The real competitor for many hobby lathes; swarf's answer has to be "a threaded, chamfered, parted part from one sentence". |

### What the survey says

- **Everyone serious has converged on swarf's rule.** No product found lets a language model write
  G-code text; the assistants place operations in a kernel and the host's post writes the code
  [F: CNC, TP, MC-copilot]. Direct LLM-to-G-code appears only in research, with reported failure
  rates that rule it out (one study: a chatbot "optimising" a program dropped about 31 % of it)
  [S: MDPI, GLLM]. The invariant is not a limitation to apologise for; it is where the field is.
- **Nobody in the AI tier has a lathe or a hobby machine**, and nobody uses sensors at the machine.
- **The paid tiers gate exactly the hobby pain points**: rapids and tool changes (Fusion free),
  rest machining (Carbide Create Pro), probing and hole recognition (Fusion extension).
- **The free tools check almost nothing.** "Not clamp-aware" (FreeCAD) and "no collision
  detection" (CAMotics) are their own words.

## 3. Feature table

Value is for Martin's users (hobby lathe and mill, one-offs). Effort: S under a day or 300 lines,
M one to three days, L more. Risk is to G-code safety first.

| Feature | Who has it | swarf | Value | Effort | Risk |
|---|---|---|---|---|---|
| **2.5D: face, pocket, contour, slot, drill, chamfer, engrave, thread mill** | all mill CAM | yes (`schema.ts` `Mill*`, 12 operations; README "What works") | high: it is the daily work | – | – |
| Round contour or boss without a drawing | Fusion, Estlcam | partial: `mill_contour_rect` and `mill_contour` (drawing) only; a disc needs a DXF | medium: flanges and discs are common | S | low: reuses the contour code |
| Hole patterns (bolt circle, grid, line) | Fusion, FreeCAD, conversational screens | no: `mill_drill.points` are typed one by one (`schema.ts:356`), so the model does the trigonometry | high: removes model arithmetic | S | low: positions become deterministic |
| Counterbore / countersink | Fusion (hole templates) | partial: `mill_pocket_circle` and `mill_chamfer` do the cuts; no sizes from a screw standard | medium | S (with the tables) | low |
| Lead-in / lead-out arcs, dogbone corners | Fusion, FreeCAD dress-ups | no (ramp and helix entry only; nothing of the kind in `ops/mill.ts`) | medium: witness marks on finished walls; dogbones for fitted plates | M | medium: a lead-in is a move outside the wall being cut and must be checked like any other |
| V-carve (variable depth) | Vectric, Estlcam, FreeCAD | no | low on metal | M | low |
| Tapping cycle | Fusion; FreeCAD experimental | no, on purpose (prompt: hand tap or thread mill) | low without a synchronised mill spindle | M | high: leave it |
| **Adaptive / HSM in pockets** | Fusion, Mastercam, SolidCAM, FreeCAD, Estlcam (trochoidal) | partial: `strategy: adaptive` on the three pocket operations (`ops/adaptive.ts`); no constant engagement, no blended links | high in steel on a small mill | – | – |
| Adaptive slots and open regions (around a boss) | Fusion, Estlcam | no: `mill_slot` has no `strategy` (`schema.ts:362`) | high: a full-width slot is the worst cut a small mill makes | M | medium: more moves, the link-over-cleared rule must hold |
| **Rest machining** | Fusion, Carbide Create Pro, Vectric, FreeCAD 1.0+, hyperMILL (automatic) | no | high: big cutter then small, 10 minutes instead of 40 | M | medium: a thin leftover taken for air would allow a rapid through it; needs a margin |
| **Lathe: face, turn, OD profile, chamfer, groove, bore, part, drill** | Fusion, conversational screens | yes (`schema.ts` `Lathe*`, `ops/lathe.ts`, `ops/profile.ts`) | high | – | – |
| Lathe threads: external, internal, multi-start | Fusion, LinuxCNC G76 | yes as G33 passes (`LatheThread`); no pull-out, no taper, no left-hand | high | – | pull-out parked (S8) |
| Lathe internal profile | Fusion | no (ARCHITECTURE Tier 2) | medium: stepped bores, bearing seats, a chamfer at the mouth | M | medium: the bar's back against the bore wall |
| Tube stock, pre-shaped stock | Fusion (stock from solid) | no: `Stock` bar has no bore (`schema.ts:99`); boring a tube fires `BORE_SOLID` | high: bushings from tube | S | medium: a wrong bore makes a rapid inside it look safe; show it, and let the camera check the bar |
| Second clamping on the lathe (the other end) | Fusion (setups), every machinist | no: `setups.ts:225` refuses the lathe | high: most turned parts have two ends | M–L | medium: gripping on a turned diameter, jaws against the finished part |
| Tailstock or centre in the model | Fusion | no: only a sentence in `review.ts` (`SLENDER_PART`) | medium: long thin parts are where hobby lathes fail | M | medium: a new solid the tool must avoid |
| Grooving family: flank finish, face grooves, chamfered part-off | Fusion | partial: plunge groove with peck only | medium | M | high for face grooves without tool geometry |
| Undercuts, non-monotonic profiles | Fusion (with tool angles), LinuxCNC no | no, refused by design (`profile.ts:39`) | low: grooves cover most | L | high |
| **Feeds and speeds from material × tool** | all | yes (`materials.ts`, `feeds.ts`; six materials, HSS/carbide) | high | – | – |
| Spindle power / torque limit, rigidity level | SolidCAM wizard, G-Wizard (power curve), Vericut Force | no: `Machine` has no power field (`schema.ts:19`) | high in steel | M | low (a warning); parked for ratings (C4) |
| Chip thinning outside adaptive | SolidCAM, HSMAdvisor | partial: adaptive only (×1.4–2) | medium | S | medium: it raises feeds |
| Constant surface speed (G96) | Fusion, LinuxCNC, grblHAL lathe | no, approved (C12) | medium: finish on faces, parting | S–M | medium: rpm climbs at the centre; lint, sim and planner must learn it |
| **Stock: bar, block** | all | yes | high | – | – |
| Fixtures: clamps, vise, chuck | Fusion (modelled by hand); FreeCAD: none | yes, from typing, the laser scan, or the chuck size (`Obstacle`, `OBSTACLE`, `CHUCK`, `CHUCK_UNKNOWN`) | high | – | – |
| Tool holder and spindle nose against clamps | Fusion, Vericut | no: the cutter is a cylinder from its tip (README "What is not checked"; S7) | high: the commonest real crash after a wrong zero | M | low: adds a check |
| **Simulation in the loop** | Fusion; FreeCAD 1.0 simulator; CAMotics | yes: lathe slices and mill height map on every edit (`sim.ts`), carried across setups (`carry.ts`) | high | – | – |
| As cut against as meant | Fusion (colours), Vericut AUTO-DIFF | no: there is no "as meant" to compare with | high: the one error the checks cannot see is a wrong value | M | low: read-only; must be honest about tolerance |
| Independent look at the emitted text | Vericut (reads G-code) | partial: `lint-gcode.ts` exists, wired in by L9 | high | (L9) | – |
| **Probing: Z plate, top grid, corner with angle, tool setter** | gSender, bCNC, Fusion (extension) | yes (`probe.svelte.ts`, `tooling.ts`); angle and top applied in `emit()` (`align.ts`) | high | – | – |
| Bore / boss centre as a datum | bCNC, Fusion extension | no (S10) | medium: second operations on round parts | M | medium: machine motion; needs the simulator tests |
| G55–G59, fixture offsets | Fusion, grblHAL | no (G54 only) | low for one-offs | S | low |
| **Tool library** | all | yes: own tools, per browser, as a file (`files.svelte.ts`) | high | – | – |
| Import of vendor or Fusion libraries | Fusion | no (C11) | low–medium | S–M | medium: a wrong flute length weakens `TOO_DEEP` |
| **Drawing import (DXF, SVG)** | Estlcam, Vectric, Carbide Create | yes (`importers/`), also lathe side views | high | – | – |
| Hole recognition from the drawing | Estlcam, Fusion (extension) | no: the agent sees extents, loop counts and areas only (`formatJobContext` in `prompt.ts`) | high: the plate with holes is the commonest mill part | S–M | low: less transcription than today |
| STEP / 3D models | Fusion, FreeCAD, Kiri:Moto | no (Tier 3) | medium, later | L | – |
| **Standards tables** (threads, tap drills, clearance holes, fits) | Fusion (thread standards) | no: pitches live in the prompt (`CAM_GUIDE` in `prompt.ts`), the model types them | high: stops "M8 pitch 1.0" | S | low: pin the tables with tests |
| **Setup sheet** | Fusion, Vectric Pro (job sheets) | yes, per setup, with stick-out and times (`sheet.ts`) | high | – | – |
| **Post: one plain subset** | Fusion posts (hundreds) | yes, on purpose; one dialect | high for trust | – | keep |
| Coolant M7/M8/M9, aux outputs | all | no: `emit.ts` writes none; approved (C13) with a design (`docs/design/output-mapping.md`) | medium | M (six PRs) | low–medium: the laser shares M8 today |
| Time estimate from the planner | few (most guess) | yes (`planner.ts`) | medium | – | – |
| Review of the job by rules of thumb | none found | yes (`review.ts`, 13 kinds of finding) | high | – | – |
| Camera, listening | bCNC (camera zeroing); Harmonizer (sound) | yes (`camera/`, `listen/`) | high once tried on a real machine | – | – |

## 4. Gaps worth closing, ranked

Ranking: value to a hobby user, weighted by whether it removes a silently wrong value, divided by
size. Old C- and S-numbers are kept. "First PR" is the smallest piece worth reviewing alone.
All of this waits for L4–L14.

Does the 2026-11-22 ranking hold? Mostly. C10 is done. C1 and C5 stay at the top. C6 moves up from
sixth, because it is S-size and N9 builds on it. C2 moves down a little: it depends on the height
map that L12 is about to rework. C4 stays parked. C12 and C13 are approved, so they are listed
by cost, not argued again. Three gaps are new (G2, G5, G13), and G15 is noted.

**G1. Holes from the drawing (C1, S–M).**
Build: the importer keeps circles (centre, Ø) per shape; the job state lists them grouped
("8 × Ø5.5, 2 × Ø8"); `mill_drill`, `mill_spot`, `mill_thread` and `mill_pocket_circle` accept
`{ shape, diameter }` instead of points. Why now: Estlcam does this for €49, and it is the first
thing a DXF user asks for. Pipeline: Job (a reference in place of numbers) → `generate` resolves it
to points → Program and checks unchanged. First PR: circles on `Shape` and in the job state, no
operation change; test with a DXF of circles, of polylines that are circles, and of two circles on
one centre.

**G2. Hole patterns (new, S).**
Build: `pattern` on the same four operations: `{ circle: { cx, cy, diameter, count, startAngle } }`,
`{ grid: … }`, `{ line: … }`. Why: today the model computes bolt-circle coordinates in its head and
types sixteen numbers; a slip passes every check. Pipeline: Job → `generate` expands → unchanged
after. First PR: `pattern.circle` on `mill_drill` with a test against hand-computed points; the
operation label says "6 × on Ø40".

**G3. Thread, tap-drill and clearance tables (C6, S).**
Build: `standards.ts` with ISO metric coarse and fine, UNC/UNF, G (BSP): pitch, depths, tap drill,
clearance hole, ISO 4762 counterbore. `lathe_thread` and `mill_thread` accept `standard: 'M8'` or
`'M8x1'` and fill pitch, depth and the diameter to turn or bore first; the label says what was
filled. Remove the pitch list from the prompt. Pipeline: Job → `generate` looks up → new check
`THREAD_NOT_STANDARD` (a note) when a typed pitch contradicts a named size. First PR: the metric
table with tests against published values, used by `lathe_thread` only.

**G4. Tube stock (C5, S).**
Build: `Stock` bar gets `bore`; `LatheMaterial` starts with it (it already has a bore radius per
slice). Why: bushings from tube are everyday parts and fail with `BORE_SOLID` today. Pipeline:
stock data only; every check then runs on the truth. Risk and its answer: a bore typed too large
makes a rapid inside look free, so the camera's "Check the bar" should later read the bore from
the end, and the setup sheet prints the bore in large type. First PR: the field, the material
start, one test that boring a tube passes and that a rapid into its wall still fails.

**G5. The lathe's other end (new, M–L).**
Build: a second setup on the lathe: the part turned end for end and gripped on a finished
diameter. The stock of setup 2 is setup 1's final profile, mirrored; the chuck check uses where the
jaws grip. Why: most turned parts need both ends worked, and today that is a second job whose
stock is a lie (a plain bar). Pipeline: the mill's `setups` and `carried()` pattern applied to
`LatheMaterial`; operations unchanged. First PR: pre-shaped lathe stock alone
(`Stock.bar.profile`: a list of Ø/Z steps the material model starts from), which G4 sits beside
and which already makes a second job honest. The setup link comes after.

**G6. What the part will measure (C3, M).**
Build: from the final material model, a list of the dimensions that came out: diameters and
lengths between shoulders (lathe), pocket sizes, depths, hole positions, floors and walls (mill).
On the review card and the setup sheet. Why: it turns operation parameters into part dimensions a
person can hold against the sketch. Pipeline: a pure read of `Analysis.material`; no new G-code.
Tolerances must be stated (a slice is 0.05 mm, a mill cell 0.2–0.3 mm; nose radius and drill point
are not modelled). First PR: the lathe readout as a pure function with tests on the four golden
lathe parts. Idea N1 builds on it.

**G7. Coolant and outputs (C13, approved; M in six PRs).**
As designed in `docs/design/output-mapping.md`: functions on tools and operations, outputs on the
machine, nothing hard-wired, explicit off before every stop. The lint must learn M7/M8/M9 and
M62–M65 P in the same PR that emits them (PR 3 of the design). First PR: the schema (PR 1 there).

**G8. Constant surface speed (C12, approved; S–M).**
Build: `css: true` on `lathe_face` and `lathe_partoff`, written as G96 S(vc) D(max rpm) and G97
after. What has to learn it, in one PR or the checks lie: `lint-gcode.ts` (today it requires G97
on the lathe), the grbl simulator, `planner.ts` (time), `CHUCK_RPM` (the D word must be at most
the machine's and the chuck's limit), the README subset list. Risk: grblHAL's lathe codes are
marked as not extensively tested [F: GH-codes]; rpm climbs to D at the centre. First PR: the
simulator and the lint accept G96/G97 with tests, nothing emits it yet.

**G9. Tool holder and spindle nose clearance (S7, M).**
Build: optional holder (diameter, length above the flutes) on the tool and a nose diameter on the
machine; `OBSTACLE` and the stock top are checked against the stepped shape, not a cylinder. Why:
FreeCAD has nothing here and Fusion needs a modelled holder; swarf already knows the clamps from
the laser scan, so the check has real inputs. First PR: the holder fields and the check as a
warning, with the vise-jaw case from `simsetups.test.ts`.

**G10. Rest machining (C2, M).** After L12.
Build: `rest: true` on pockets and inside contours: cut only where the material model still has
metal inside the target, with a margin ("ignore less than 0.3 mm"), linking over cleared area as
adaptive does. Pipeline: `generate` reads the material state before the operation (it has it
already for `zTop` after facing), checks unchanged. First PR: a pure function "what is left inside
this region after the operations before", drawn in the preview, no toolpath.

**G11. Lathe internal profile (C7, M).** Mirror of `ops/profile.ts` for the boring bar; the fit
and reach checks exist. First PR: straight steps and chamfers only, no radii.

**G12. Adaptive slots and bosses (C8, M).** `strategy: adaptive` on `mill_slot` and around an
island. First PR: the slot.

**G13. A centre in the lathe model (new, M).** `Stock.bar.support: 'centre'`: `SLENDER_PART`
changes its advice, and the centre is a solid the tool must clear (facing to the middle is then an
error, parting has a warning that the part is held at both ends). First PR: the field and the
review rule only.

**G14. Spindle power (C4, parked).** Unchanged; see N3 for a way to get the number without a
nameplate. Chip thinning outside adaptive can be split off (S), but it raises feeds, so it should
come with N3's measured limit, not before.

**G15. Smaller ones, in no order.** Bore and boss probing (S10, M; bCNC has it); a round contour
without a drawing (S); lead-in arcs on finishing passes (M); the grooving family (C9, M; face
grooves only with tool geometry); tool-library import (C11, S–M).

Left out again: V-carve, tapping, undercuts, G55+, STEP. Nothing in this list lets the model
write G-code or relaxes a check; G4 and G10 are the two that could make a check see less metal
than there is, and both say how that is guarded.

## 5. New ideas

Things the tools in section 2 do not do, or do badly, and that swarf's design makes possible. Each
keeps the rule: the model chooses operations, names standards, points at features and explains;
deterministic code generates, checks and emits.

### N1. The part contract: what the user said becomes a check

**Pitch.** When someone writes "a pin Ø20 h9, 30 long, M10 thread 15 long" or attaches a sketch,
those dimensions are the only statement of intent there is. Today they are consumed once, turned
into operation parameters, and forgotten. Keep them: the agent records each stated dimension as an
entry of `job.intent` ("Ø20 between Z0 and Z-30", "length 30", "thread M10 to Z-15"), with the
words it came from. After every edit a deterministic check measures the simulated part (G6) at
those places and compares. A turn that changes Ø20 to Ø18 while "fixing" something else turns the
contract red, and the review card shows it. The user reads eight plain dimensions, not twelve
operations.

**Why it is new.** Fusion and Vericut compare against a CAD model; without a model they have
nothing. The AI assistants need the model too. swarf's users often have none, and no surveyed tool
treats spoken or sketched dimensions as a testable specification.

**Sketch.** `Job.intent: { id, kind: 'diameter' | 'length' | 'depth' | 'position' | 'thread', at,
value, tol?, source }[]`. New agent tool `set_intent` (the agent states what it understood; it
cannot edit the measurement side). `intentChecks(job, analysis)` reads the material model:
`INTENT_OFF` is an error when the part differs by more than the tolerance plus the model's own
resolution, `INTENT_UNMEASURED` a note where the model cannot tell (a thread's flanks). The review
card lists the contract; the user can correct a line, which is the fastest way to say "you read
that 3 as an 8".

**First PR.** `intent` with `kind: 'diameter'` on the lathe only, the check, and a test where an
edit to `lathe_turn.diameter` trips it. No agent tool yet: entries typed in the job file.

### N2. Sneak up on it: measure, then finish

**Pitch.** No machinist trusts a hobby lathe to hit Ø20.00 from a touched-off zero. They cut to
Ø20.4, measure with a micrometer, and take what is left. swarf can do that as a first-class thing:
an operation with `finish: 'measured'` roughs and takes a semi-finish pass that leaves a known
allowance, then the program waits (as at a tool change: spindle off, machine free). The app asks
"it should measure Ø20.40: what does it measure?". The user types 20.46. Deterministic code works
out that this tool cuts 0.03 large on the radius, regenerates the finish pass with that correction
(bounded, say ±0.3 mm), runs the checks on it, and Resume cuts it. The correction is offered to
stay with the tool for the later operations of this run.

**Why it is new.** Professional CAM does this with a spindle probe and macros (Fusion's part
alignment and inspection are in the paid extension [S: A-ext]) or leaves it to wear offsets typed
at the control. Hobby CAM does nothing: the G-code is fixed when it is written. swarf generates,
checks and streams in one place, so it can regenerate between two halves of one run.

**Sketch.** The Program IR gets a `measure` stop between segments (the machinery of the
tool-change wait and `resumeFrom` exists). `Job.runtime.wear: { tool, dx }` is applied in
`generate` as a shift of that tool's X, clamped; the re-run goes through `analyze` and (after L9)
`runnable()`, so a correction can never emit unchecked moves. The mill version is a pocket or boss
width measured with calipers, correcting the tool's effective diameter. The agent is not in this
loop at all.

**First PR.** In cam only: `lathe_turn` with `finish: 'measured'` produces two segments with a
`measure` stop between, and `withWear(job, tool, dx)` regenerates the second; tests that the
correction is clamped and that the second half starts from the first half's material.

### N3. A test piece that measures the machine

**Pitch.** Every calculator asks the hobbyist what they cannot answer: spindle power at this rpm,
how rigid the machine is (SolidCAM has an 8-level slider [F: SC-wizard], G-Wizard a power curve
[S: GW-curve]). C4 is parked for this reason. Measure it instead. swarf generates a
standard test job from tested operations: on the lathe a bar turned in steps of rising depth and
feed, and one long light pass; on the mill a row of short slots and side cuts of rising load. While
it runs, swarf records what the controller reports (actual spindle speed against programmed, with
an encoder) and what the microphone hears. Afterwards the user types three caliper readings (the
diameter at both ends of the long pass gives taper and spring). The result is a profile for this
machine: the depth and feed at which it sagged or rang, a taper per 100 mm, a factor for the
material table.

**Why it is new.** The wizards take the machine's limits as inputs. Nobody found derives them
from a cut, because CAM is not present when the cut happens. swarf is.

**Sketch.** `testPiece(machine, material, tool)` in `presets.ts` returns an ordinary Job (so it is
checked like any other). The run diary (N4) gives sag and chatter per operation.
`Machine.measured: { derate, maxDocSeen, taperPer100 }` feeds `feeds.ts` as a cap, never as a
raise above the table without the user saying so. `review.ts` gets "this cut is above what the
machine took in the test".

**First PR.** The lathe test bar as a preset with its setup-sheet page and boxes to write the
readings in. No feedback into feeds yet: it is already a useful shop exercise.

### N4. The run diary: the machine reports back to the job

**Pitch.** When a program ends, swarf knows a great deal and throws it away: how long each
operation really took against the estimate, where the user pulled the feed override down to 60 %,
where they held, where the microphone heard a ring and at what pitch, how far the spindle sagged.
Keep it as a diary entry with the job. Next time the review says: "Last run: the pocket took
9 min, not 6; you ran it at 60 % feed; chatter at 1.9 kHz with T3 at 4,200 rpm." A tool in the
library remembers the speeds at which it rang and the stick-out it had. The agent, asked for a
similar part, starts from what worked.

**Why it is new.** Machine monitoring (MachineMetrics, TMAC) is a production product and does not
feed the CAM. Hexagon's ProPlanAI learns from past *programs*, not from how they ran [S: HX-ai].
Hobby CAM never hears about the run at all.

**Sketch.** `runReport(program, entries)` is a pure function over the session log
(`record.ts` has every line with its time, overrides and events) and the listening panel's
findings, keyed by operation. `Job.history` keeps the last few. `review.ts` gains `RAN_SLOW`,
`OVERRIDDEN`, `RANG` as findings; `feeds.ts` may *lower* a speed from a tool's record, never
raise one. With the relay running, diaries can live in `~/.swarf/` and a read-only agent tool
`find_jobs` can search them.

**First PR.** `runReport` with planned against actual time per operation and the feed override's
range, shown after a run; tested on the simulated controller (`simrun.test.ts` already runs whole
programs).

### N5. Checks that work out their own fix

**Pitch.** A check says "T2 runs into the chuck near Z-38.2". The user, or the agent, then
guesses a new value and tries again; the agent has a fix budget of four. But `analyze` on a lathe
job takes about a millisecond. So let the check search: for each error, try the bounded edits that
could clear it (shorten `zEnd`, raise the clearance, reduce the depth, move the rectangle) and
report the smallest that makes the job pass with no new error: "Ends at Z-35.2 instead of Z-38:
clears the chuck by 0.5 mm. [Apply]". The fix is an ordinary edit on the review card.

**Why it is new.** Simulation in professional CAM marks the collision red and stops there; the
programmer iterates by hand. A search needs a simulation fast enough to run fifty times per
keystroke and operations with few, named parameters. swarf has both.

**Sketch.** `suggest(job, diagnostic)` in cam: a table from check code to candidate parameters,
bisection with `analyze` as the oracle, and the rule that a suggestion is only returned if the
whole job then has no error and the changed value stays inside the schema. The agent gets the
suggestions with the diagnostics, so it stops spending turns on arithmetic and spends them on
whether the shorter part is still the part (with N1: whether the contract still holds). Nothing is
weakened: the search only ever proposes job edits, never a change to a check or a limit.

**First PR.** `suggest` for `CHUCK` and `OUT_OF_RANGE` on `lathe_turn`, `lathe_profile` and
`lathe_partoff`, with tests; shown as text in the diagnostic, no button yet. The mill follows L12.

### N6. A first-article run

**Pitch.** The README tells people to run a new program in the air with a hand on the E-stop.
Make that a mode, not advice. **First run** streams the same checked program, but stops before the
first cut of every operation with the tool at the clearance height above where it will enter, and
says what comes next in the job's words: "Next: pocket 40 × 20, 8 deep, T3 Ø6. The tool should be
2 mm above the top, 12 mm in from the front-left corner." With the camera on, the overlay marks
that spot. The user looks, and presses Go on. Rapids run at 25 %. After one clean first run the
job is marked as proven on this setup.

**Why it is new.** Single block and dry run are controller features that know nothing about the
part; they stop at every line or none. CAM is not at the machine. Only something that holds both
the operations and the stream can stop at the moments that matter and say what should be true.

**Sketch.** No new G-code words: the stops are waits between segments, as tool changes are, and
the 25 % is grbl's rapid override. `firstRunStops(program)` in cam picks the move before each
operation's first feed; `sheet.ts` already has the words. Checks are untouched, since the moves
are the same.

**First PR.** The stop list as a pure function with tests on the golden parts, and a "First run"
switch beside Run on the simulated controller.

### N7. The fixture is a job too

**Pitch.** Setups carry the part over a turn, but holding the half-machined part for its second
side is left to the user, and it is the hard part of two-sided work. swarf knows the part's exact
outline after setup 1. Offer **Make a nest for it**: a second job, on a scrap plate or a pair of
soft jaws, that pockets the part's outline (mirrored for the flip, with a fitting clearance and
relieved corners) to a set depth. The nest's corner is setup 2's zero by construction, and the
nest becomes setup 2's obstacles automatically, so the checks know the fixture before it exists.

**Why it is new.** In Fusion one models soft jaws in CAD, by hand. No hobby tool derives a
fixture from the part as machined so far; none has the part as machined so far.

**Sketch.** `outlineOf(carried)`: marching squares over the carried columns give closed loops,
which become a `Shape`; `fixtureJob(job, setup, { clearance, depth })` returns an ordinary Job
with `mill_pocket` on it; `addSetup` gets the nest's walls as `Obstacle`s. Corner relief is the
dogbone of G15, needed here anyway. Resolution limits apply (cells of 0.2–0.3 mm), so the default
clearance is generous and stated.

**First PR.** `outlineOf` with tests on the golden bracket (cut out with tabs), drawn in the
preview of the next setup. No fixture job yet.

### N8. The camera inspects the part against the simulation

**Pitch.** After the last pass on the lathe, before parting off, **Check the part**: the camera
reads the silhouette (it already measures the bar's diameter, its end and shoulders) at stations
along the axis and lays it against the profile the material model predicts. "Shoulder expected at
Z-30.0, seen at Z-30.3. Ø12 section: seen Ø12.4. Thread region: present." It reads to about half a
millimetre, so it is no micrometer; it catches the operation that was skipped, the tool offset
that is 1 mm out, the groove on the wrong side, while the part is still in the chuck and can be
recut.

**Why it is new.** In-process inspection in industry is a touch probe or a CMM. A webcam compared
against a simulated result needs a simulator that predicts the silhouette and a camera calibrated
in machine coordinates. swarf has both, for other reasons.

**Sketch.** `expectedSilhouette(LatheMaterial)` gives Ø per Z; `measureCylinder`, `findEnd` and
`findShoulder` in `camera/caliper.ts` exist; a comparison with a tolerance that is honest about
the camera (README: "it tells Ø6 from Ø8, not Ø6 from Ø6.35"). The result is a note on the run
diary (N4), never a zero and never a gate.

**First PR.** `expectedSilhouette` and the comparison as pure functions, tested with the simulated
camera on a stepped shaft with one step cut 1 mm short.

### N9. Name the mating part, not the number

**Pitch.** People do not want Ø22.00; they want "a seat for a 608 bearing", "a groove for a
Ø20 circlip", "an O-ring groove for a 20 × 2 ring", "a clearance hole and counterbore for an M5
cap screw", "a centre hole for the tailstock". G3's tables, extended, make these the vocabulary:
the agent names the standard part, deterministic tables give the diameter, depth, width and
tolerance, and the label and the contract (N1) say what was filled in. Where the tolerance is
tighter than the machine holds from a touched-off zero (a bearing seat), the operation defaults to
measured finishing (N2).

**Why it is new.** Fusion has thread standards and hole templates; nothing surveyed goes from the
name of a purchased part to the feature that receives it. With a language model in front, the name
is exactly what the user will type, and the place a model is most likely to recall a wrong number.

**Sketch.** `standards.ts` grows by table: ISO 286 fits for common sizes, bearings (the dozen
hobby sizes), DIN 471/472 circlips, O-ring grooves, ISO 4762 screws, DIN 332 centre holes, DIN 76
thread reliefs. Operations take `for: { standard, size }`; `generate` resolves; a check flags a
typed value that contradicts the named standard. Every table is pinned by tests against a
published source, and each resolved value shows its source in the label.

**First PR.** After G3: circlip grooves (DIN 471) on `lathe_groove`, one table, one test file.

### N10. Two plans, compared by numbers

**Pitch.** "Rings or adaptive? One Ø10 cutter, or Ø10 then Ø4? Flip the part or reach from one
side?" Today the agent picks one and the user never sees the other. Let it build two or three
variants of the job side by side, and let deterministic code score them: time from the planner,
tool changes, the widest and deepest bite any pass takes, findings from the review list, the
slenderest tool. A small table, the agent's one-line argument for its choice, and **Keep this
one**.

**Why it is new.** CAM Assist and its peers return one program [F: CNC]; comparing strategies in
classic CAM means duplicating a setup by hand. Variants are cheap in swarf because a job is a
small JSON document and a full analysis takes milliseconds to a quarter of a second.

**Sketch.** `scoreJob(job, analysis)` in cam (time, changes, peak engagement from the material
model, finding counts). Variants live beside the job the way `setups.others` does, never as the
job in hand until kept; only the kept one can reach `runnable()`. An agent tool `propose_variant`
copies the job and applies edits to the copy.

**First PR.** `scoreJob` alone, shown on the review card beside each turn's diff ("+2 min, one
more tool change, widest bite 6.0 → 2.6 mm").

### N11. The setup sheet that talks

**Pitch.** At the machine the hands are oily and the eyes are on the tool. At each tool change
and each first-run stop (N6) the app says what the sheet says: "Tool three, six millimetre end
mill, at least twenty-two millimetres out of the collet. Next: pocket, eight deep." And it
listens for three words: "next", "repeat", "stop" (a feed hold, which is safe to trigger by
mistake). The phone layout exists; this makes the phone in a shirt pocket a pendant that reads the
plan aloud.

**Why it is new.** Controllers beep. Setup sheets are paper. The surveyed senders and CAM have no
spoken guidance, because none holds both the sheet's content and the moment it applies.

**Sketch.** The browser's speech synthesis and recognition on the Machine tab; the text comes
from `sheet.ts`, deterministic, with no model involved. Voice may trigger only hold and "go on at
a wait", never Run, jog or an edit.

**First PR.** Speak the tool-change line (off by default), with the sentence built by a pure
function that has tests.

## 6. Top five after L4–L14

1. **Holes and patterns from the drawing (G1 + G2).** The commonest mill part, the first thing a
   DXF user asks, and it takes coordinates out of the model's hands. Two S-size PRs.
2. **Standards tables (G3), growing into "name the mating part" (N9).** One S-size PR removes a
   class of silently wrong threads and gives the agent a vocabulary instead of numbers.
3. **The part contract (G6 readout, then N1).** The only proposal that attacks the error no check
   can see today: a wrong value that makes a valid part.
4. **Sneak-up finishing (N2).** It is how accurate parts are really made on a hobby lathe, no
   other CAM in reach does it, and it needs no hardware.
5. **The approved pair: coolant by the output-mapping design (G7), then G96 (G8).** Already
   decided; G96 last, with lint, simulator and planner in the same PR.

Next in line: tube stock (G4, S, could ride with any lathe PR), checks that propose their fix
(N5, cheap on the lathe now, on the mill after L12), and the first-article run (N6) before swarf
meets a real machine for the first time.

## 7. Open questions for Martin

1. **Which lathe gap first: tube stock, the other end, or internal profile (G4, G5, G11)?** It
   depends on what you turn. G5 is the largest and changes "the lathe has one clamping per job".
2. **Is a measuring stop in the middle of a program acceptable (N2)?** It means the second half
   of the G-code is written after the first half ran, checked again, but not the file you
   reviewed beforehand. The alternative is two separate programs.
3. **Should a failed contract (N1) block output like a check error, or only warn?** Blocking is
   in the spirit of the invariants, but the contract comes from the agent's reading of your words.
4. **Hardware you expect to have:** an encoder that reports real spindle speed (N3, N4 use it), a
   camera on the lathe (N8), a microphone at the machine (N4). Without them those ideas shrink to
   time and override records.
5. **Which standards (G3, N9)?** Metric coarse and fine are certain. UNC/UNF, BSP, bearings,
   circlips, O-rings: say which you would use, so no table is written for nobody.

## Sources

Tags as defined above. A source listed here was fetched or seen in results on the date given; no
URL was made up.

Fetched 2026-11-24 [F]:
- [SC-wizard] SolidCAM iMachining Technology Wizard: https://solidcam.com/imachining/imachining-technology-wizard/
- [SC-maker] SolidCAM Maker Version: https://solidcam.com/cam-modules/solidcam-maker-version/
- [MC-copilot] Mastercam Copilot: https://www.mastercam.com/community/blog/mastercam-copilot-ai-that-actually-knows-your-software/
- [CNC] CloudNC CAM Assist for Fusion: https://www.cloudnc.com/fusion
- [TP] Toolpath pricing: https://www.toolpath.com/pricing/team
- [VC-diff] Vericut AUTO-DIFF: https://vericut.com/products/auto-diff
- [CAMO] CAMotics: https://camotics.org/
- [VEC] Vectric product summary: https://www.vectric.com/llms-full.txt
- [CC-pro] Carbide Create Core vs Pro: https://carbide3d.com/carbidecreate/core-vs-pro/
- [EST] Estlcam: https://www.estlcam.de/
- [FC-11] FreeCAD 1.1 release notes (mirror of the wiki): https://reqrefusion.github.io/FreeCAD-Documentation-html/wiki/Release_notes_1.1.html
- [FC-cam] FreeCAD CAM workbench (mirror): https://reqrefusion.github.io/FreeCAD-Documentation-html/wiki/CAM_Workbench.html
- [FC-turn] FreeCAD Turning add-on: https://github.com/dubstar-04/TurningAddon
- [KM] Kiri:Moto CAM: https://docs.grid.space/kiri-moto/CAM/
- [KM-lathe] Kiri:Moto forum, lathe mode: https://forum.grid.space/t/lathe-mode-support-real-lathes/934
- [LCNC] LinuxCNC G-codes: https://linuxcnc.org/docs/html/gcode/g-code.html
- [GH-codes] grblHAL additional G and M codes: https://github-wiki-see.page/m/grblHAL/core/wiki/Additional-G--and-M-codes
- [GH-sync] grblHAL spindle sync: https://github.com/grblHAL/core/wiki/Spindle-sync
- [IOS] ioSender: https://github.com/terjeio/ioSender
- [BCNC] bCNC: https://github.com/vlachoudis/bCNC
- [GS] gSender: https://github.com/Sienci-Labs/gsender

Search snippets only, 2026-11-24 [S]:
- [A-personal] Fusion for personal use: https://www.autodesk.com/products/fusion-360/personal/compare
- [A-free] Fusion free licence changes: https://autodesk.com/support/technical/article/Fusion-360-Free-License-Changes
- [A-price] Fusion pricing (blog, may be dated): https://www.autodesk.com/products/fusion-360/blog/how-much-will-fusion-360-cost/
- [A-turn] Fusion turning updates: https://www.autodesk.com/products/fusion-360/blog/autodesk-fusion-turning-updates/
- [A-ext] Fusion Manufacturing Extension: https://www.autodesk.com/products/fusion-360/blog/fusion-360-machining-extension-beyond-5-axis-machining/
- [A-ai] AI-powered workflows in Fusion: https://www.autodesk.com/products/fusion-360/blog/ai-powered-workflows-coming-to-autodesk-fusion/
- [A-hsm] HSMWorks overview: https://autodesk.com/products/hsmworks/overview
- [MC-price] third-party price estimate: https://www.selfcad.com/blog/7-of-the-best-cam-software
- [MC-learn] Mastercam Learning Edition: https://www.mastercam.com/solutions/learning-edition/
- [MC-x7] Mastercam lathe dynamic rough: https://www.digitalengineering247.com/article/mastercam-x7-lathe-updated
- [HX-swiss] Hexagon ESPRIT EDGE 2025: https://hexagon.com/about/news-media/press-releases/2025/hexagon-revolutionises-cam-programming-with-swiss-machining-and-ai-powered-automation
- [HX-profit] ESPRIT EDGE at DMG MORI: https://ca-en.dmgmori.com/products/digitization/work-preparation/cam-software/hexagon-esprit-edge
- [HX-ai] Hexagon AI-powered CAM: https://hexagon.com/solutions/ai-powered-cam
- [OM-virtual] hyperMILL VIRTUAL Machining brochure: https://www.openmind-tech.com/fileadmin/pdf/cam/simulation/bro-hypermill-virtual-machining-en.pdf
- [OM-2026] hyperMILL 2026: https://www.metal-am.com/open-mind-launches-hypermill-2026-with-new-cam-features/
- [NX-ai] Siemens NX machining suggestions: https://blogs.sw.siemens.com/nx-manufacturing/when-ai-becomes-your-cam-programming-partner/
- [VC-force] Vericut brochure: https://vericut.com/hubfs/Decision%20Makers%20Brochure%20UK.pdf
- [HZ] Harmonizer: https://mmsonline.com/articles/find-the-right-speed-for-chatter-free-milling
- [TMAC] Caron TMAC: https://caroneng.com/products/tmac
- [TMAC-price] unverified price class: https://industrialmonitordirect.com/blogs/knowledgebase/fanuc-cnc-tool-monitoring-solutions-mtconnect-tmac-macros
- [EST-price] Estlcam price: https://www.estlcam.de/estlcam.php
- [CANDLE] Candle height map: https://github.com/andaks/Candle
- [CENT] Centroid CNC12 Pro licence: https://www.sherline.com/product/acorn-cnc12-pro-software-license-upgrade/
- [CB] CamBam lathe note: https://smoothieware.github.io/Webif-pack/documentation/web/html/index-70.html
- [ELS] Clough42 electronic leadscrew: https://github.com/clough42/electronic-leadscrew/releases
- [GW-curve] G-Wizard spindle power curve: https://www.cnccookbook.com/taming-an-unruly-spindle-power-curve-with-g-wizard
- [MDPI] ChatGPT and G-code, *Machines* 14(1):89: https://www.mdpi.com/2075-1702/14/1/89/htm
- [GLLM] GLLM, self-corrective G-code generation: https://arxiv.org/abs/2501.17584

From the study of 2026-11-22 [P]:
- [F-adaptive] Fusion Adaptive Clearing, rest machining: https://help.autodesk.com/view/fusion360/ENU/?contextId=MFG-REF-3D-ADAPTIVE-CMD
- [F-turn-rough] Fusion turning profile roughing: https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/TURN-ROUGH-READ.htm
- [F-turn-guide] Fusion turning overview (unofficial guide): https://fusion-guide.vercel.app/docs/13-manufacture-cam/turning/
- [F-sim-forum] Fusion comparison colours: https://forums.autodesk.com/t5/fusion-manufacture-forum/fusion360-simulate-verify/td-p/10889698
- [MC-dyn] Mastercam Dynamic Motion: https://www.mastercam.com/solutions/products/dynamic-motion/
- [MC-lathe-dyn] Mastercam lathe dynamic roughing: https://www.camcut-group.com/en-us/support/instructions/mastercam-toolpaths/mastercam-lathe/mastercam-lathe-dynamic-roughing
- [Estl-auto] Estlcam automatic drill objects: https://forum.v1e.com/t/help-me-how-to-select-multiple-holes-objects-quickly/29054

Not verified and therefore not relied on: the Fusion extension's price; whether grblHAL's G33
accepts X motion; ioSender's list of lathe wizards; PathPilot's list of conversational lathe
operations; Estlcam's grbl post; the calculators' deflection and torque outputs.
