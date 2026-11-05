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

## Run it on the machine

The **Machine** tab streams the program to a grblHAL controller over USB (Web Serial: Chrome or
Edge on a computer) or over the network (the board's WebSocket server, `$307`, usually port 81). It uses grbl's character-counting protocol, learns the receive buffer size
from `$I`, polls status for the DRO and the tool marker in the preview, and offers hold, resume,
soft reset, feed override, unlock, home and a command line. The program pauses at every tool
change (M0); Resume continues. It refuses to start while the job has errors or the controller is
not idle. The protocol logic lives in `packages/grbl` and is tested against a pretend controller.

After every assistant turn the chat shows what changed (operations added, changed, removed) with
**Keep** and **Revert this turn**.

## What works

| | |
|---|---|
| Lathe | face, turn a diameter (roughing + finishing pass, shoulder), profile (a whole outline with steps, tapers, chamfers and radii: roughing, semi-finish and a nose-radius-compensated finish), 45° chamfer, groove, boring, external and internal threads, single or multi-start (G33 passes, flank or radial infeed, spring passes), part off, drill on centre with pecking |
| Mill (2.5D) | face, rectangular and circular pocket, rectangular contour inside/outside with holding tabs, drill hole patterns with pecking; and any imported outline: cut it out (holes included, with tabs), run inside it, follow its lines (engraving), or pocket it around islands |
| Drawings | DXF (lines, arcs, circles, polylines with bulges, ellipses, splines, blocks; units from the file) and SVG (paths, shapes, transforms, mm sizes). Mill: placed on the stock and shown in the preview. Lathe: a side view of the part (full outline or the half above the axis) becomes a profile |
| G-code size | runs of short lines on a circle (or helix) are written as G2/G3 arcs within 5 µm: XY on the mill, ZX (G18) on the lathe, where I stays a radius in diameter mode as grblHAL reads it |
| Speeds and feeds | from the workpiece material (aluminium, free-cutting steel, steel, stainless, brass, plastic) × the tool (HSS or carbide, turning / grooving / threading / drilling / milling): cutting speed, feed per rev or per tooth, depth per pass. A tool's own values override the table; everything is clamped to the machine |
| Entry and finish | ramped entry for pockets and contours, helical entry for circular pockets; lathe chamfers compensated for the insert's nose radius |
| Time | estimated like grbl's planner: acceleration and junction deviation, forward and backward pass |
| Checks | machine travel, chuck collision, rapids into material, boring into solid material, boring bars that don't fit or reach, cuts deeper than the flutes or the depth of cut for the material, plunging with a non-centre-cutting endmill, impossible operations |
| G-code | a "boring" subset (G0–G3, G17/G18, G7/G8, G21, G90, G94, G54, M0 tool changes) that runs the same on grblHAL, LinuxCNC and most others |
| Preview | three.js: toolpath (feeds blue, rapids orange), the part as it is cut, timeline scrubber, tool marker |
| Agent | Claude or any OpenAI-compatible model; edits are validated, every edit answers with the checks, and the turn is not finished while errors remain |

Threading needs grblHAL in lathe mode with an index + pulse encoder ($32=2, $38, PID tuned), and
"Spindle sync" switched on under Stock → Machine settings. Passes start far enough out for Z to
reach speed, since grblHAL does not correct the sync while accelerating. There is no pull-out at
the end of a pass: end at a groove, or the thread runs out on the shank.

Not yet: profiles from DXF for the mill. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Safety

This is a young tool. Simulate, check the G-code, run the first time in the air with the feed
override low and a hand on the E-stop. The material model is coarse (no nose radius, no drill
point angle), so it catches crashes, not every gouge.

## Origin

The agent loop and the model providers are ported from [4k7](https://github.com/hoihu/4k7)
(`packages/agent`), with the PCB kernel swapped for the CAM job.
