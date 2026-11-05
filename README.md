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
**Model**: Anthropic, OpenAI, OpenRouter, Gemini, a local Ollama/LM Studio, or any compatible
gateway. The key stays in the browser.

## What works (tier 1)

| | |
|---|---|
| Lathe | face, turn a diameter (roughing + finishing pass, shoulder), 45° chamfer, groove, part off, drill on centre with pecking |
| Mill (2.5D) | face, rectangular and circular pocket, rectangular contour inside/outside, drill hole patterns with pecking |
| Speeds and feeds | from the tool table (cutting speed, chip load or feed per rev), clamped to the machine |
| Checks | machine travel, chuck collision, rapids into material, cuts deeper than the flutes or the tool's depth of cut, plunging with a non-centre-cutting endmill, impossible operations |
| G-code | a "boring" subset (G0–G3, G17/G18, G7/G8, G21, G90, G94, G54, M0 tool changes) that runs the same on grblHAL, LinuxCNC and most others |
| Preview | three.js: toolpath (feeds blue, rapids orange), the part as it is cut, timeline scrubber, tool marker |
| Agent | Claude or any OpenAI-compatible model; edits are validated, every edit answers with the checks, and the turn is not finished while errors remain |

Not yet: tool nose radius compensation, ramp/helical entry, threading (G33/G76 need spindle sync),
arbitrary profiles from DXF, streaming to the machine. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Safety

This is a young tool. Simulate, check the G-code, run the first time in the air with the feed
override low and a hand on the E-stop. The material model is coarse (no nose radius, no drill
point angle), so it catches crashes, not every gouge.

## Origin

The agent loop and the model providers are ported from [4k7](https://github.com/hoihu/4k7)
(`packages/agent`), with the PCB kernel swapped for the CAM job.
