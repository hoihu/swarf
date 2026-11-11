# swarf

AI-assisted CAM for a hobby CNC lathe or mill running grblHAL. You describe the part in your own
words; an agent builds it from parametric operations; a deterministic generator turns those into
toolpaths, checks them and writes plain G-code; you review the 3D preview and run the file with
the sender you already use.

The model never writes G-code. It fills in operations (face, turn Ø20 to Z-30, pocket 40×20…),
which are tested code, so the worst an AI mistake can do is pick a wrong value, and the checks
and the preview show that before anything reaches the machine.

```
npm install
npm run dev        # the web app at http://localhost:5173
npm test           # CAM core and agent loop
npm run typecheck
```

## Who answers the chat

- **A coding agent on this computer** (no API key, your own login and plan): Claude Code, GitHub
  Copilot CLI, Codex CLI or OpenCode, picked under **Assistant**. Run `npm run build && npm run server` and
  open the link it prints. The server runs the CLI headlessly for each message with swarf as its
  only MCP server: no shell, no files, no web, just the CAM tools, which act on the open tab.
  Conversations continue; if the checks still find errors when the agent finishes, the app sends it
  back to fix them (twice at most). Set `SWARF_CLAUDE_BIN`, `SWARF_COPILOT_BIN`,
  `SWARF_CODEX_BIN` or `SWARF_OPENCODE_BIN` if a CLI is not on the PATH.
  Copilot, Codex and OpenCode have no single "only these tools" switch, so the server turns off
  what each would add, the user's own MCP servers included. `npm run check:copilot`,
  `npm run check:codex` and `npm run check:opencode` run the real CLIs (offline, against a stand-in model API, no login needed)
  and fail if a new version offers the model anything else.
- **A model API with your key**, under **Assistant**: Anthropic, OpenAI, OpenRouter, Gemini, a local
  Ollama/LM Studio, or any compatible gateway. The key stays in the browser.
- Neither: an offline demo with two scripted requests.

By default the chat uses the chosen coding agent whenever the server is running and has it, and the API otherwise.

## Claude Code in the terminal drives the app (MCP)

swarf ships a small MCP server. Claude Code starts it; it relays every tool call to the open app
tab, so you watch the part appear in the preview while Claude Code works (the 4k7 pattern).

```
claude mcp add swarf -- node /path/to/swarf/tools/server/src/main.ts
```

Inside this checkout the bundled `.mcp.json` does that already. Ask Claude Code for a part; the
first tool call answers with a link (`http://localhost:7790/#connect=…`) that opens the app
connected to it (`npm run build` first, or it points at `npm run dev`). The header then shows
"Claude Code connected". Tools: `get_context`, the job edits, `get_gcode` and `save_gcode`, which
writes the .nc file next to your project (refused while the job has errors).

The server listens on 127.0.0.1 only, accepts the tab only from localhost pages, and only with
the access key from `~/.swarf/server.json`.

## How the preview looks

The 3D preview shows the work in its surroundings: the mill's table with its T-slots, cutters
with flutes one can see turn, a chuck with jaws that goes round, the work's material (aluminium,
steel, brass, plastic) with cut surfaces bright and the raw stock's skin duller. Press play and
it cuts: **chips** fly off the cutter in the material's own way (curls of aluminium, blued steel,
a spray of brass needles, long white strings of plastic), tumble, land on the work and the table
and fade after a while; with **coolant** on, a hose looks at the cutter and the stream splashes
off it; **sound** (off unless switched on) hums with the spindle and hisses with the cut. The
same happens while a connected machine runs.

**Look** (top right of the preview) picks the surroundings: a painted workshop, a studio, a
night shift under the machine's own lamp, or none. Or your own: **drop a picture of your
workshop onto the preview**. It stands behind the machine and is what the metal reflects; a 360°
panorama (twice as wide as high, a phone's photo sphere) surrounds the machine and turns with the
view. The picture stays in this browser only. Turn the view by dragging, zoom with the wheel, pan with the
right button; **3D / Top / Front / Side** (End on the lathe) jump to fixed viewpoints, and the
view you leave is kept per kind of machine, over reloads and for the next job's stock (3D
forgets it). None of this touches the checks or the G-code
(`apps/web/src/lib/workshop/`).

## Run it on the machine

The **Machine** tab streams the program to a grblHAL controller over USB (Web Serial: Chrome or
Edge on a computer) or over the network (the board's WebSocket server, `$307`, usually port 81). It uses grbl's character-counting protocol, learns the receive buffer size
from `$I`, polls status for the DRO and the tool marker in the preview, and offers hold, resume,
stop, feed override, unlock, home and a command line. It refuses to start while the job has
errors or the controller is not idle. The protocol logic lives in `packages/grbl` and is tested
against a pretend controller.

- **Tool changes.** The way to the tool-change position (straight up to a travel height above
  the rapids and above every known obstacle, then to X0 Y0; on the lathe along Z away from the
  chuck, then out) is part of the program: checked and shown like every other move. There the
  program waits. The M0 is not sent to the controller (a controller paused by M0 takes no jog and
  no zero setting): everything before it is finished, the spindle is off, and the machine is free
  to jog, touch off and set the new tool's Z. **Resume** goes on: the program says its modes
  again (G21 G90 G94 G54, the plane; G97 on the lathe) and the tool first rises straight up to
  the travel height from wherever touching off left it, before it moves across.
- **Tool lengths.** "Tool changes" in the Machine tab carries the work zero over to the new
  tool, by moving the zero (G10 L20) by how the new tool's tip sits against the old one's; no
  tool length offset in the controller is used. Three ways:
  - *Stored offsets*, for tools that come back to the same place every time (a quick-change tool
    post on the lathe, fixed holders): make one tool the reference, touch each other tool off
    once by hand and store that; from then on one click at each change. On the lathe X and Z.
  - *A tool setter* on the mill (a switch on the table, wired to the probe input), for collets:
    jog over it once ("the setter is under the tool now"), take a reading of the first tool, and
    at every change **Measure it on the setter**: guarded moves there, a fast and a slow touch,
    and Z zero moves by the difference of the two readings.
  - *By hand*, as before: touch the new tool off (the plate, or the jog panel's Set buttons).
  Resume asks before going on with a tool whose zero has not been carried over. From above the
  travel height (after the setter) Resume goes across first, so the program's move to the
  travel height does not come down on the setter.
- **Start again in the middle.** After a stop or a broken tool, **Start at** picks the
  operation to go on from (it offers the one the machine stopped in, found from where it
  stands). The rest of the program begins like a tool change: the tool is asked for, the modes
  said, up to the travel height, across, spindle. What came before is taken as done; only what
  will run can hold the start up.
- **Stop** sends nothing more, holds motion (so the position stays true), and resets the
  controller once it stands (or after 1.5 s if it will not): what it had buffered is dropped and
  the spindle stops. It is not an emergency stop.
- **An error from the controller** (a line it refuses) holds and resets at once: it would
  otherwise skip that line and run on with the next ones from the wrong place.
- **A controller that stops answering** (cable, power, network) is noticed within two seconds,
  the job is marked failed and the tab says that nothing can be stopped from here.
- Closing or reloading the page while a program runs asks first.

**Move by hand** (in the Machine tab): a button per axis and direction, in steps of 0.01, 0.1, 1
or 10 mm or for as long as the button is held; optionally the arrow keys (Page Up/Down for Z).
Holding does not send one long move to be cancelled on release: it feeds a tenth of a second of
travel at a time and keeps a quarter of a second queued, so if the cancel is ever lost (cable,
a hung tab) the machine stops by itself within that. Letting go, the pointer leaving the button,
the window losing focus or Esc all stop it at once. Below it: make the place where the tool
stands a given X, Y or Z of the work zero (G10 L20), and the spindle on and off. All of it is
open while the controller is idle, so also at a tool change, and shut while the program runs or
a touching or camera routine moves the machine (`apps/web/src/lib/jog.ts`,
`scripts/check-jog.cjs`).

After every assistant turn the chat shows what changed (operations added, changed, removed) with
**Keep** and **Revert this turn**.

No machine at hand: **Connect a simulated mill/lathe** runs a pretend grblHAL in the browser that
moves in real time, reports MPos and WCO, spindle and probe input, and jogs (`packages/grbl/src/sim.ts`). On
the simulated mill you choose what is on the table: the block alone, two steel blocks beside it,
low edge clamps against a stop, strap clamps across its ends (step blocks, T-bolts and nuts
standing 36 mm above the top) or a machine vise. The block itself is never quite where the job
says (0.8 mm off, turned 0.25°, 0.37 mm low, tilted). The probe touches the same solids the
simulated camera draws and its laser lights (`apps/web/src/lib/sim/`); the simulated camera's
picture lags the machine like a webcam's and has sensor noise, and the laser's fan casts shadows.
A real machine stops when it hits something; the simulated one says so and goes on: "Simulated
crash: the tool ran into the left strap…". The tests run whole programs this way, tool changes
included (`apps/web/test/simrun.test.ts`, in a browser `scripts/check-run.cjs`).

## Zero by touching (mill)

With the cutter wired to grblHAL's probe input, the Machine tab touches off with G38.2 (fast, back
off, slow; positioning near the work as guarded G38.3 moves): **Z on a touch plate** of known
thickness; on conductive stock with a clip, **the top at 3 × 3 points** (how flat and level it is,
then Z zero on the highest point or the average) and **the front-left corner** (top, left side,
front side twice: X, Y and Z zero, and how far the block is turned). On the simulator, against a
block 0.37 mm low, tilted and turned 0.25°: Z to the micrometre, the corner to 0.001 mm, the turn
to 0.001° (`scripts/check-probe.cjs`). Checking the top leaves out points under the job's
obstacles; one where the way down is blocked (a strap over the edge) is left out and reported
with the height it touched at, and a point far off the others (a chip) is reported and left out
of the figures.

### Using what was measured

Two of the measurements can be kept with the job and are then applied when the G-code is written:

- **The block's angle.** After "Find the front-left corner", if the front edge is turned against
  X, "Turn the toolpath with the block" keeps the angle (up to 5°). The whole program is turned by
  it about X0 Y0, arcs staying arcs, instead of you squaring the block.
- **The top.** After "Check the top" (3 × 3, or the finer 6 × 4), "Keep this top for engraving"
  keeps the touched points. An engraving (text, or a drawing's lines) with "Follow the measured
  top" switched on then keeps its depth against that surface: its cuts go out in pieces of at
  most 1 mm, each raised or lowered by what the top is off there. Between the points the top is
  estimated (a plane through all of them, corrected near each point by what it was off).

The preview and the checks go on showing the block as drawn; the G-code's head, the G-code tab
and the setup sheet say what is applied, and the checks note how far the turned moves land from
where they looked (clamps and travel were checked unturned). The measurements belong to one
clamping: "Forget" them when the block comes out. An operation that is to follow a top that was
not touched, or was touched somewhere else, gets a note; a top standing higher than the travel
height is an error.

On the simulated mill with a block turned 0.8° and tilted 0.4 mm per 100 mm, an engraving asked
0.2 mm deep came out 0.187 to 0.189 mm under the real top everywhere; cut flat it would have
been 0.13 to 0.42 mm (`scripts/check-measured.cjs`).

## A camera on the work area

The Machine tab's **Camera** section draws the toolpath, the raw stock and the work zero over the
live picture of a webcam pointed at the work area, so a wrong work zero, a clamp in the way or too
little stock shows before the spindle starts. Calibration, in two steps (OpenCV in the browser,
loaded only here):

1. **Lens:** print the ChArUco board (the app makes the page, A4 at 100 %) and show it to the
   camera from many angles; views are kept as they come. Gives focal length, centre and distortion.
2. **Where the camera is**, in machine coordinates: stick the printed tool marker to the spindle or
   tool post, jog to the middle of the work area, and press Measure. The machine moves the marker
   through a grid (mill: 3 × 3 × 2, lathe: 4 × 4 in X and Z) and the camera finds it each time; then
   you click the tool tip at four points, which gives the marker's offset from the tip. Because the
   pose is in machine coordinates, the overlay follows a new work zero (from the controller's WCO)
   without measuring again. On the mill a quicker way: lay the table marker on the stock at a known
   spot.

3. **Check the setup** (mill): the camera finds the block's four top edges near where the job has
   them and reports where its front-left corner really is (the job's X0 Y0), its length and width
   and whether it sits square, with **Use this size** for the Stock tab. It needs Z zero on the
   block's top and reads to about 0.1–0.3 mm. On the simulated camera: within 0.1 mm of the truth.

4. **Line laser** (mill): a line laser on the spindle head, switched by the flood output (M8/M9),
   slanting down onto the work. Calibrated once over the probed top (the line at four heights
   gives the sheet's place); then **Scan the setup** sweeps the line across the block and 35 mm
   around it: a point cloud in the 3D preview, how flat the top is, and what stands beside the
   block or lies on it (clamps, straps, vise jaws), which **Add to the job** turns into obstacles.
   Something with steps is a box per step (a strap at 10 mm, its nut at 18, the bolt at 36), and
   whatever lies on the top is left out of the top's figures and flagged as in the way of facing.
   Every move, rapids too, is checked against them (OBSTACLE). On the simulator: the sheet to
   0.02 mm, the top's average to 0.001 mm, single points ±0.25 mm, the clamps' height to 0.1 mm
   and their outline to about 1 mm (`scripts/check-laser.cjs [outdir] [setup]`); with the strap
   clamps, bolt, nut, strap and step block each within 0.05 mm of their height, the vise jaws
   within 0.15 mm. The top's slope reads to about 0.05 mm per 100 mm. With a real
   camera: keep the exposure low enough that the line does not turn white on bright metal.
   The tests scan every simulated setup without a browser too, by casting the laser's rays at
   the same solids (with its shadows and what the camera cannot see), and run the checks on what
   the scan found: facing over vise jaws passes, a deep contour into them does not, straps are in
   the way of facing (`apps/web/test/simsetups.test.ts`).

The lens is undone on the GPU for the overlay. A **simulated camera** (a known lens with
distortion, looking at the simulated machine, holding the board up during the lens step) runs the
whole flow without hardware and is how it is tested.

## What works

| | |
|---|---|
| Lathe | face, turn a diameter (roughing + finishing pass, shoulder), profile (a whole outline with steps, tapers, chamfers and radii: roughing, semi-finish and a nose-radius-compensated finish), 45° chamfer, groove, boring, external and internal threads, single or multi-start (G33 passes, flank or radial infeed, spring passes), part off, drill on centre with pecking |
| Mill (2.5D) | face, rectangular and circular pocket, rectangular contour inside/outside with holding tabs, a finishing pass on the walls at full depth (`finish`) and climb or conventional (`direction`) for pockets and contours, drill hole patterns with pecking; and any imported outline: cut it out (holes included, with tabs), run inside it, follow its lines (engraving), or pocket it around islands; slots (the tool's width, or wider with round ends); spotting, chamfering along an edge (a drawing, a rectangle, a circle) and engraving text in a built-in single-line font, all with a pointed cutter (tool type `chamfer`: chamfer mill, V-bit, spot drill); thread milling, internal and external, right- and left-hand (tool type `threadmill`). No tapping cycle |
| Drawings | DXF (lines, arcs, circles, polylines with bulges, ellipses, splines, blocks; units from the file) and SVG (paths, shapes, transforms, mm sizes). Mill: placed on the stock and shown in the preview. Lathe: a side view of the part (full outline or the half above the axis) becomes a profile |
| G-code size | runs of short lines on a circle (or helix) are written as G2/G3 arcs within 5 µm: XY on the mill, ZX (G18) on the lathe, where I stays a radius in diameter mode as grblHAL reads it |
| Speeds and feeds | from the workpiece material (aluminium, free-cutting steel, steel, stainless, brass, plastic) × the tool (HSS or carbide, turning / grooving / threading / drilling / milling): cutting speed, feed per rev or per tooth, depth per pass. A tool's own values override the table; everything is clamped to the machine |
| Entry and finish | ramped entry for pockets and contours, helical entry for circular pockets; lathe chamfers compensated for the insert's nose radius |
| Time | estimated like grbl's planner: acceleration and junction deviation, forward and backward pass |
| Checks | machine travel, chuck collision, rapids into material, boring into solid material, boring bars that don't fit or reach, cuts deeper than the flutes or the depth of cut for the material, plunging with a non-centre-cutting endmill, impossible operations |
| G-code | a "boring" subset (G0–G3, G17/G18, G7/G8, G21, G90, G94, G54, M0 tool changes) that runs the same on grblHAL, LinuxCNC and most others |
| Preview | three.js: toolpath (feeds blue, rapids orange), the part as it is cut, timeline scrubber, tool marker |
| Job files | Save the job as a file (`<name>.swarf.json`: machine, stock, tools, operations, drawings, notes) and open it again, here or on another computer. A file is checked like any other input before it becomes the job |
| Tool library | your own cutters, entered once: "Keep in the library" on a tool, "Add to the job" in any later job (lathe tools keep their stored offset in the tool post). Kept in this browser; saved and read as a file to move it |
| Setup sheet | one printable page per job: stock, where the zero is, what holds the work, the tools in the order the program asks for them and how far each must reach, every operation with rpm, feed, depth and time, a drawing with the zero and the cuts |
| Agent | Claude or any OpenAI-compatible model; edits are validated, every edit answers with the checks, and the turn is not finished while errors remain |

Threading needs grblHAL in lathe mode with an index + pulse encoder ($32=2, $38, PID tuned), and
"Spindle sync" switched on under Stock → Machine settings. Passes start far enough out for Z to
reach speed, since grblHAL does not correct the sync while accelerating. There is no pull-out at
the end of a pass: end at a groove, or the thread runs out on the shank.

Not yet: profiles from DXF for the mill. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Files, your tools, and the sheet for the machine

**The job as a file.** The job is kept in the browser while you work; Save (in the header, or
Stock → Job file) downloads it as `<name>.swarf.json`, Open reads one back. The job you had goes
on the undo stack. A file that does not fit the schema is refused with the field that is wrong,
and nothing opens while a program is under way on the machine.

**Your tool library.** In the Tools tab, open a tool and choose "Keep in the library". The
library is per machine kind and lives in this browser; under the job's tools it lists what you
have, with "Add to the job" (the tool comes under its own number if that is free, else the next
one). A tool that is in the job under the same name is recognised, and "Update in the library"
appears when you changed it. A lathe tool is kept with its stored offset, so a quick-change
holder is measured once. "Save the library as a file" and "Add tools from a file" carry it to
another browser. Offsets are against that machine's reference tool: they mean nothing on another
machine, and are wrong after the reference tool is reground or moved in its holder.

**The setup sheet.** G-code → Setup sheet shows one page and prints it (or saves a PDF) through
the browser's dialog: stock and material, the zero in words, the clamps and jaws the job knows of
(on the lathe, where the jaws are and how close the tools come), your setup notes (Stock → Setup
notes, or tell the assistant), the tools in the order the program stops for them with a box to
tick, how far each goes and the least stick-out that keeps the holder above the stock and the
clamps, stored offsets, then every operation with rpm, feed, deepest point and time. The drawing
is the job from above (mill) or from the side (lathe) with the zero and the cuts. Errors from the
checks are printed at the top. The stick-out is geometry only (top of the highest thing minus
the deepest cut, plus 2 mm): the sheet does not know your holder's shape.

## Safety

This is a young tool. Simulate, check the G-code, run the first time in the air with the feed
override low and a hand on the E-stop. The browser is not a safety device: the machine needs its
own emergency stop, and limit switches or soft limits.

What is checked before a program may run (errors block **Run program**):

- every move against the machine's travel, the chuck (lathe) and the job's obstacles (mill:
  clamps, straps, vise jaws from the laser scan or typed in), rapids too, and the way to and
  from the tool-change position;
- rapids into material; plunges with a cutter that is not centre-cutting; cuts deeper than the
  flutes; boring where there is no hole; threading without spindle sync;
- as warnings: depth per pass well above what the tool and material take, speeds outside the
  spindle's range, cuts through the block into what it sits on.

What the automatic routines do for themselves: probing moves near the work are guarded (they
stop on contact), probing refuses to start with the spindle on or before the probe circuit has
been seen to close once since connecting (a broken wire would drive the cutter into the plate),
its Stop button holds and resets at once; the laser sweep refuses to start below anything the
job knows to stand on the table and switches the laser off however it ends.

What is not checked: the tool holder and spindle nose against clamps (only the cutter, as a
cylinder from its tip up); where work zero really is (a wrong zero moves everything); tool
length (each tool's Z is touched off at its tool change); the travel in machine coordinates
(the envelope is in work coordinates as you entered it: keep the controller's soft limits on);
work offsets other than G54, G92 or a tool length offset being active while probing. The
material model is coarse (no nose radius, no drill point angle), so it catches crashes, not
every gouge. The chat's AI can only edit the job; it has no way to move the machine, change the
machine's limits or remove obstacles.

## Origin

The agent loop and the model providers are ported from [4k7](https://github.com/hoihu/4k7)
(`packages/agent`), with the PCB kernel swapped for the CAM job.
