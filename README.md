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

Without an API key the chat runs an offline demo (two scripted requests). Add a key under
**Assistant**: Anthropic, OpenAI, OpenRouter, Gemini, a local Ollama/LM Studio, or any compatible
gateway. The key stays in the browser.

## Claude Code drives the app (MCP)

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
Edge on a computer). It uses grbl's character-counting protocol, learns the receive buffer size
from `$I`, polls status for the DRO and the tool marker in the preview, and offers hold, resume,
soft reset, feed override, unlock, home and a command line. The program pauses at every tool
change (M0); Resume continues. It refuses to start while the job has errors or the controller is
not idle. The protocol logic lives in `packages/grbl` and is tested against a pretend controller.

## What works (tier 1)

| | |
|---|---|
| Lathe | face, turn a diameter (roughing + finishing pass, shoulder), 45° chamfer, groove, part off, drill on centre with pecking |
| Mill (2.5D) | face, rectangular and circular pocket, rectangular contour inside/outside, drill hole patterns with pecking |
| Speeds and feeds | from the tool table (cutting speed, chip load or feed per rev), clamped to the machine |
| Entry and finish | ramped entry for pockets and contours, helical entry for circular pockets; lathe chamfers compensated for the insert's nose radius |
| Time | estimated like grbl's planner: acceleration and junction deviation, forward and backward pass |
| Checks | machine travel, chuck collision, rapids into material, cuts deeper than the flutes or the tool's depth of cut, plunging with a non-centre-cutting endmill, impossible operations |
| G-code | a "boring" subset (G0–G3, G17/G18, G7/G8, G21, G90, G94, G54, M0 tool changes) that runs the same on grblHAL, LinuxCNC and most others |
| Preview | three.js: toolpath (feeds blue, rapids orange), the part as it is cut, timeline scrubber, tool marker |
| Agent | Claude or any OpenAI-compatible model; edits are validated, every edit answers with the checks, and the turn is not finished while errors remain |

Not yet: threading (G33/G76 need spindle sync) and arbitrary profiles from DXF. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Safety

This is a young tool. Simulate, check the G-code, run the first time in the air with the feed
override low and a hand on the E-stop. The material model is coarse (no nose radius, no drill
point angle), so it catches crashes, not every gouge.

## Origin

The agent loop and the model providers are ported from [4k7](https://github.com/hoihu/4k7)
(`packages/agent`), with the PCB kernel swapped for the CAM job.
