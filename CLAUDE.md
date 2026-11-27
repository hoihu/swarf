# CLAUDE.md

swarf is AI-assisted CAM for a hobby CNC lathe or mill running grblHAL: an agent builds a job
from parametric operations, a deterministic generator turns it into toolpaths, checks them and
writes plain G-code, and the user reviews a 3D preview. Start with README.md and
docs/ARCHITECTURE.md.

## Repo map

- `apps/web`: the app (Svelte 5 + Vite + three.js): job panel, 3D preview, chat, the Machine
  mode (Web Serial / WebSocket streaming, jog, probing, camera, listening), the simulated
  workshop (`src/lib/sim/`, `simworld.ts`). Tests in `apps/web/test`.
- `packages/cam`: the CAM core: job schema (`schema.ts`), operations (`ops/`), the Program IR
  (`program.ts`), `generate()`, material model (`sim.ts`), checks (`check.ts`), G-code emitter
  (`emit.ts`), speeds and feeds, setups, DXF/SVG importers, job files and the setup sheet.
- `packages/grbl`: talking to grbl/grblHAL: status parsing, the character-counting streamer,
  and a simulated controller used by the app and the tests.
- `packages/agent`: the agent loop (ported from 4k7), its tools, prompt, model providers and
  the MCP tool definitions.
- `tools/server`: the local relay: an MCP server for Claude Code that forwards tool calls to the
  open app tab, and the harnesses that let Claude Code, Codex, Copilot CLI or OpenCode answer
  the app's chat (`src/harness/`).
- `scripts`: manual checks outside CI: Playwright walks through the app (`check-*.cjs`,
  `tour.cjs`; `npm run check:ui` runs them all against its own dev server, since the
  `window.__swarf*` hooks they drive exist only in dev) and checks of
  the real coding-agent CLIs (`check-codex.mjs`, `check-copilot.mjs`, `check-opencode.mjs`).

## Commands

Node >= 22.18 (`engines` in package.json). These are exactly what CI runs
(`.github/workflows/ci.yml`), in this order:

```
npm ci
npm run typecheck   # tsc over the workspaces + svelte-check --fail-on-warnings
npm test            # vitest: packages/*/test, tools/*/test, apps/*/test
npm run build       # the web app (vite build)
npm run knip        # knip (knip.jsonc): no unused files, exports or dependencies
```

Also: `npm run dev` (app at http://localhost:5173), `npm run mcp` / `npm run server` (the relay),
`npm run check:ui` (the Playwright scripts; `npx playwright install chromium` once; not in CI).
Run all four checks before calling a change done. An export no other package or test uses
fails knip: drop the `export` or the code rather than adding an ignore.

## Invariants

Do not break these; they are what makes the tool safe to point at a machine.

- **The model never writes G-code.** It fills in tested operations; each operation is a pure
  function from parameters to moves. (README intro; ARCHITECTURE "Data flow", Operations.)
- **Rapids only where the air is known to be free**: above the bar, in front of the face, above
  the safe plane, or inside material the same operation just removed. (ARCHITECTURE, Operations.)
- **Lathe X is a radius internally**; the emitter writes diameters (G7), or radii (G8) with
  `xMode: 'radius'`. (ARCHITECTURE, Job.)
- **Mill X0 Y0 is the stock's front-left corner, Z0 the top after facing.** (ARCHITECTURE, Job.)
- **Check errors block** the agent from finishing, the G-code download, `save_gcode` and
  **Run program**. (ARCHITECTURE, Checks; README "Safety", "Claude Code in the terminal drives
  the app".) Never weaken, skip or bypass a check to make a test pass; fix the cause.
- **Emitted G-code stays the boring subset** that runs the same on grblHAL, LinuxCNC and most
  others; the full list is in README "What works", G-code, and nowhere else. Threading adds G33
  passes and needs spindle sync; no G96/G95 (ARCHITECTURE, Materials).
- Every consumer reads the one Program IR (moves grouped by operation). (ARCHITECTURE, Program.)

## House style

- Commit subjects in plain language, saying what the user gets, like the existing log:
  "Chips only where metal comes off", "Setups: the part comes over a turn as it was left".
  No conventional-commit prefixes.
- Keep README "What works" (and the relevant README section) and docs/ARCHITECTURE.md in step
  with any change in behaviour, in the same commit.
- Small, focused diffs; don't reformat or refactor what the change doesn't need.
- A bug fix starts with a test that reproduces it, then the fix.
- Tests go in the package's `test/` directory next to the existing ones; the simulated
  controller (`packages/grbl/src/sim.ts`) and simulated workshop stand in for hardware.
