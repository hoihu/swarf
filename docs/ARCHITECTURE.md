# Architecture

```
apps/web          Svelte 5 + Vite + three.js: job panel, 3D preview, chat
packages/agent    agent loop, tools, prompt, providers (ported from 4k7)
packages/cam      job model, operations, toolpath IR, material model, checks, G-code
```

## Data flow

```
user text ──► agent ──tool calls──► Job (zod-validated)
                 ▲                     │
                 │ checks              ▼
                 └──────────── generate() ──► Program (moves per operation)
                                       │
                         simulate() ◄──┤──► emit() ──► G-code (.nc)
                       material model  │
                                       └──► three.js preview
```

- **Job** (`cam/src/schema.ts`): machine, tool table, stock and an ordered list of operations.
  Lathe X is a radius internally; the emitter writes diameters (G7). Mill X0 Y0 is the stock's
  front-left corner, Z0 the top after facing.
- **Operations** (`cam/src/ops/`): each is a pure function from parameters to moves. They only
  rapid where the air is known to be free (above the bar, in front of the face, above the safe
  plane, or inside material the same operation just removed).
- **Program** (`cam/src/program.ts`): moves (rapid, feed, XY arc) grouped by operation. Every
  consumer reads this one IR.
- **Material model** (`cam/src/sim.ts`): lathe = outer and bore radius per 0.05 mm slice of Z;
  mill = a height map. Fast enough to rerun on every edit and while scrubbing.
- **Checks** (`cam/src/check.ts`): travel, chuck, rapids into material, depth of cut, plunging.
  Errors block the agent from finishing (fix budget 4) and the G-code download.
- **Agent** (`agent/src/loop.ts`): the 4k7 loop. The model sees a compact job state with every
  user message, edits through tools that answer with fresh checks, may ask one question per turn,
  and is sent back to fix errors when it tries to finish with any.

## Roadmap

Tier 1 (this): parametric 2-axis lathe and 2.5D mill operations, checks, preview, agent.

Tier 2, toward everyday use (done: forms, MCP for Claude Code, the app chat answered by Claude
Code headless, streaming over Web Serial, planner time estimate, ramp/helix entry, nose radius on
chamfers, external threading as G33 passes):
- Internal threads, multi-start threads, a thread pull-out (G33 with X moving).
- Profiles: turn an arbitrary 2D profile (polyline with arcs) on the lathe; DXF/SVG import for
  mill contours and pockets, offsets via clipper2.
- Tabs for contours; climb/conventional choice.
- Streaming over WebSocket for networked grblHAL boards (the streamer takes any transport).
- Nose radius compensation for general profiles (tapers and arcs), once profiles exist.
- Other headless agents for the chat (Copilot CLI, Codex, OpenCode), as 4k7 has.
- A changeset review step like 4k7 (accept or reject an agent turn) instead of plain undo.

Tier 3 (only by reusing libraries): STEP import (build123d / OpenCascade), adaptive clearing,
3D finishing.
