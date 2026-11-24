# Lean review, November 2026

Reviewed at `e68ccea` (branch `bot/app-review-lean`). No code was changed; this file is the only
addition.

## Executive summary

1. The pipeline shape (Job → `generate` → Program → `simulate`/checks → `emit` → text) is sound and
   should stay. Nothing found lets the model write G-code, and lathe X is a radius everywhere inside.
2. Two real bugs: `save_gcode` refuses every job that has an imported drawing (R1), and the review
   card stays empty when a turn changes only the workpiece material or the clamps (R6).
3. "Check errors block output" holds, but it is hand-written at five call sites, `machine.run()`
   itself takes any text, and `get_gcode` returns the program of a job with errors (R2, R3).
4. The G-code is emitted for the block *as measured* while travel and clamps were checked for the
   block *as drawn* (documented, a warning only); and the travel envelope cannot be edited in the
   app although the README says "as you entered it" (R4, R5).
5. Dead code is small: about 75 lines of unused functions, a barrel nobody imports, and 145 lines of
   G-code parser that only tests use (R7–R9). No unused npm dependency.
6. 22 Playwright scripts (1,240 lines) need `playwright`, which no package.json declares; 14 of
   them are mentioned nowhere (R10).
7. Duplication is local and cheap to remove: four G-code line readers, three copies of the wall
   finishing loop, four of the cone formula, twelve number formatters, twelve localStorage wrappers.
8. One hot spot explains both the slow tests and the UI latency: the mill height map takes 89 % of
   `analyze` (236 ms for the 147-move example), and `analyze` runs two to three times per edit (R20, R21).
9. Tests take 22 s wall because one 1,807-line file holds 120 tests (20.7 s); splitting it is free (R22).
10. The bundle is one 1,496 kB chunk (439 kB gzip): three.js 38 %, the Anthropic SDK 13 %. OpenCV
    (13.3 MB) is already lazy. Recommendation: keep the architecture, do the 13 small PRs below.

## How this was done, and what it does not cover

Read line by line: `packages/cam/src` (schema, program, generate, check, emit, lint-gcode, parse,
sim, feeds, planner, align, carry, setups, review, sheet, jobfile, diff, presets, materials, geom2d,
`ops/*`), `packages/grbl/src/{streamer,status}.ts`, `packages/agent/src/tools.ts`,
`tools/server/src/{mcp.ts,harness/types.ts}`, `apps/web/src/lib/{store,ui}.svelte.ts`, `ops.ts`,
README, ARCHITECTURE, CLAUDE.md, all configs.

Read in part, plus `rg`, `knip` and the TypeScript checker: the importers, `arcfit.ts`, `profile.ts`,
`font.ts`, `grbl/src/sim.ts`, the agent's loop, prompt and providers, the server's relay and the four
harnesses, the Svelte components, `camera/`, `workshop/`, `listen/`, `sim/`. Findings there are
limited to what those tools prove (unused exports, duplicated helpers, gates); their internals were
not reviewed for correctness. Nothing was run on a machine or in a browser.

### Measurements

| What | Value | How |
|---|---|---|
| `npm run typecheck` | 8.4 s, 0 errors | `time npm run typecheck` |
| `npm test` | 23 files, 288 tests, 21.6 s wall (61 s CPU) | `vitest run --reporter=verbose` |
| `npm run build` | 1.9 s; `index.js` 1,496 kB (gzip 439 kB), `index.css` 47 kB, `opencv.js` 13,299 kB (lazy) | `npm run build` |
| Source lines (src / test) | cam 5,846 / 2,228; web 11,931 / 1,505; agent 1,509 / 213; server 1,493 / 560; grbl 982 / 422; scripts 1,742; docs 934 | `git ls-files … \| xargs cat \| wc -l` |
| Largest files | `cam.test.ts` 1,807; `Viewer.svelte` 1,058; `ops/mill.ts` 740; `scene.ts` 628; `schema.ts` 587; `camera.svelte.ts` 580 | `wc -l` |
| Bundle by package (minified) | three 565 kB; `@anthropic-ai/sdk` 193; web app 302; cam + agent 156; clipper-lib 98; zod 97; svelte 46; dxf-parser 25; grbl 15 | throwaway vite config with one chunk per package, built to `/tmp` |
| `analyze()` | mill example (147 moves) 236 ms: simulate 221, generate 0.3, planner 0.2, emit 0.3, lint 0.8. Lathe example 1.2 ms | 5 runs each, Node 24 |
| CPU profile of `analyze` (mill) | `MillMaterial.each` 33.9 %, `cutPath` 30.4 %, its inner closure 20.2 %, `engagement` closure 4.5 % | `node --cpu-prof`, 20 runs |
| Test time by file | `cam.test.ts` 20.7 s; `server/chat.test.ts` 14.3; `grbl.test.ts` 5.9; `simrun` 5.4; `tooling` 3.5; `caliper` 3.5; `simsetups` 3.3; `agent` 2.4; `jog` 2.2 | vitest JSON reporter |
| Barrel exports nobody outside the package imports | cam 83 of 166; agent 25 of 59; grbl 10 of 19; server 29 of 30 | TS checker for the export list, `rg -w` per name |
| Unused dependencies | none; `ws` is used by `scripts/check-*.mjs` but declared only in `tools/server` | `npx knip` |
| `node_modules` | 225 MB: three 38, typescript 23, opencv-js 15, `@anthropic-ai/sdk` 14, zod 8.2, MCP SDK 6.3 | `du -sh` |

## Findings

Size: S under an hour, M half a day, L more. LOC delta is an estimate for `src` unless said.

### Safety and correctness

| id | Area | Finding | Evidence | Proposed change | Size | Risk | LOC |
|---|---|---|---|---|---|---|---|
| R1 | server | `save_gcode` fails for every job with a drawing. It asks the tab for `get_job` and parses the answer as a `Job`, but `get_job` deliberately sends drawings as a summary without their points. It fails closed (no file), so it is a bug, not a hole. | `tools/server/src/mcp.ts:104-108`; `packages/agent/src/tools.ts:188`. Reproduced: mill example plus one imported SVG → `Job.safeParse` fails with `shapes.0.paths.0.pts: expected array, received undefined`. No test covers `save_gcode` with a shape. | Test first (`server.test.ts`: save a job with a shape). Then let the tab do the work: a tab-only tool that returns `{ text, errors }` from the tab's own `analyze` + `emit`, so the server only writes the file. That also removes the server's second copy of the gate. | S | low | +25 |
| R2 | agent | `get_gcode` returns G-code for a job with errors (`isError: false`). In MCP "cli" mode the client (Claude Code in a terminal) has a file system, so the refusal in `save_gcode` can be walked around. | `packages/agent/src/tools.ts:273-283` has no error check. Reproduced: a drill at X500 gives `OUT_OF_RANGE`, `get_gcode` answers 26 lines. README names only `save_gcode` as refused. | The agent needs to read G-code to debug, so keep the tool, but when the job has errors start the answer with a line saying so and that it must not be saved or run. Whether to refuse outright is Martin's call (Q1). | S | low | +6 |
| R3 | web, server, agent | The error gate is written out five times and the function that sends a program has none. `machine.run(gcode)` accepts any string; it is reachable as `window.__swarfMachine` in production builds (13 `window.__swarf*` hooks, none behind `import.meta.env.DEV`). | Gates: `MachinePanel.svelte:82,155`, `FileMenu.svelte:11,51`, `JobPanel.svelte:392` (the `download()` at `:190` is ungated; only the button is disabled), `tools/server/src/mcp.ts:111`, `packages/agent/src/loop.ts:142`. Ungated: `machine.svelte.ts:171-178`. Hooks: `rg __swarf apps/web/src`. | One function in cam, `runnable(job, analysis, o?)`, that returns the text or the errors; download, save, and Run take their text only from it. `machine.run` takes that result, not a string. The manual scripts use the hooks against `vite preview`, so keeping them in production is a decision (Q2). | M | low | −10 |
| R4 | cam | What is emitted is not what was checked when `job.measured` is set: `emit` turns the program and follows the touched top after the checks ran on the block as drawn. The gap is only a `TURNED` warning ("keep that much to spare"). | `emit.ts:43` (`alignPieces`), `check.ts:179`, `align.ts:157-163`. Documented in ARCHITECTURE "The block as measured". | Run the travel and obstacle checks a second time on the aligned program (both are in work coordinates, where clamps and limits really are); keep the material checks on the block as drawn. This makes the checks stricter, never looser. Behaviour change, so Q3. | M | medium | +40 |
| R5 | web, docs | The travel envelope cannot be set in the app. `OUT_OF_RANGE` therefore checks against the preset (mill 300 × 200, lathe Z −200…60) unless the job file was edited by hand. README Safety says "the envelope is in work coordinates as you entered it". | `apps/web/src/lib/form.ts:178-181` ("stays out of the form for now"), `JobPanel.svelte:119`, `presets.ts:11,28`, README "What is not checked". | Either add the six numbers to Machine settings (lathe X shown as a diameter like everything else the user types), or correct the README sentence and say where the preset's travel comes from. | S–M | low | +30 or docs |
| R6 | cam | The review card ("Keep / Revert this turn") does not see a change of `workMaterial`, obstacles, notes, measurements or setups: `diffJobs` compares only stock, tools, machine, shapes, the free-text `material` and the name. A turn that switches aluminium to stainless changes every speed and feed and shows nothing. | `diff.ts:45-59`. Reproduced: `isEmptyDiff(diffJobs(a, {...a, workMaterial: 'stainless'}))` is `true`; the same for an added obstacle. | Test first, then add `workMaterial`, `obstacles`, `notes`, `measured`, `setups` to `other`. | S | low | +8 |
| R7 | cam | `lintGcode` is finished and tested but nothing calls it (0.8 ms per program). | `rg -w lintGcode` finds only its test; ARCHITECTURE:47 "Not wired into the app yet". | Call it inside the gate of R3; a lint finding is an error that blocks, with its line. One more net for 10 lines. | S | low | +10 |

### Dead and redundant code

| id | Area | Finding | Evidence | Proposed change | Size | Risk | LOC |
|---|---|---|---|---|---|---|---|
| R8 | all | Unused functions (definition is the only hit of `rg -w`, apart from barrels): `clampRpm` and its `clamp` (`feeds.ts:32,109`); `estimateSeconds` (`program.ts:115-123`, comment "No acceleration model yet" is stale, used by one assertion in `cam.test.ts:501`); `chuckMesh`, `toolMesh` (`scene.ts:184-191`, `609-628`); `undistortedToDistorted` (`camera/geometry.ts:83-87`); `findClaude` alias (`harness/claude.ts:11`); `CodexHarness.models()` (`codex.ts:65-68`); `listOpenAIModels` (`providers/openai.ts:130-142`); the re-export at `camera.svelte.ts:580`. | `npx knip`; `rg -w <name>` for each. | Delete. For `estimateSeconds`, replace the one assertion with a fixed lower bound or delete it. | S | none | −75 |
| R9 | server | `tools/server/src/index.ts` and the package's `exports` field have no importer: tests and `main.ts` import the modules directly. | `rg "@swarf/server"` finds only its own `package.json`. | Delete `index.ts` and `exports`. | S | none | −11 |
| R10 | cam | `parse.ts` (145 lines, "for previewing files from elsewhere") is production code exported from the barrel, but only tests call it; the preview of foreign files does not exist. | `rg -w parseGcode`: `cam.test.ts`, `parts.test.ts`, `mill-parts.test.ts` only. | Move to `packages/cam/test/support/parse.ts` and drop the barrel line, unless Q4 says the feature is coming. | S | none | −145 src |
| R11 | scripts | 22 `.cjs` scripts (1,240 lines) `require('playwright')`; it is in no `package.json` and not installed, so none runs from a clean checkout. 14 are referenced nowhere: `check-adaptive`, `-block`, `-camera`, `-files`, `-log`, `-pictures`, `-review`, `-setups`, `-tools`, `-view`, `shot-carried`, `-look`, `-ops`, `-setups`. | `ls node_modules/playwright` fails; `rg -l -F <name>` over docs, package.json, CI and sources per script. | Q5: either make them runnable (devDependency, one `npm run check:ui` that starts `vite preview` and runs them all) or delete the 14 and keep the 8 the README cites. Declare `ws` at the root for the three `.mjs` checks either way. | M | none | 0 or −680 |
| R12 | cam | 83 of 166 barrel exports of `@swarf/cam` are not imported by any other package (e.g. every single operation schema, `toPlane`, `fromPlane`, `PLANE_AXES`, `Segment`, `homeOf`, `rpmFor`). About 30 further symbols are exported but used only in their own file (knip list). | barrel script in "Measurements"; `npx knip`. | Replace `export *` for `schema.ts` and `program.ts` with named lists; drop `export` where knip says so. Optional: run knip in CI (Q6). | S | none | ±0 |
| R13 | agent, web | Compatibility with versions that cannot meet: `welcome.chat` ("older tabs read it") and its fallback, although server and tab come from one checkout and `SERVER_PROTOCOL` already refuses a mismatch; engine value `'claude-code'` and key `swarf.ccModel`. | `protocol.ts:49-50`, `bridge.svelte.ts:109`, `server.ts:53,214`, `store.svelte.ts:41,46`. | Remove the protocol field and fallback. Keep the two localStorage migrations one more release, then drop. | S | low | −10 |
| R14 | cam, grbl | Leftovers: an extra block and `const g = { closed }` in `pocketLoops` (`mill.ts:185-227`); `zPrev` written and never read, silenced with `void zPrev` (`mill.ts:522-530`); `Math.max(zA, zB) + 0` (`:709`); `cut.doc ?? Infinity` on a non-optional number (`:649`); `const pts = …; return pts` (`sim.ts:16-17`); two JSDoc blocks on one function (`check.ts:27-28`, `streamer.ts:177-181`); a doc comment for `Shape` sitting on `Obstacle` (`schema.ts:301`); `default: return` after an exhaustive switch (`streamer.ts:426`). | as cited | Tidy in the same PR as R8; the pinned `.nc` files prove the output is unchanged. | S | none | −12 |

### Duplication

| id | Area | Finding | Evidence | Proposed change | Size | Risk | LOC |
|---|---|---|---|---|---|---|---|
| R15 | cam, grbl | Four readers of a G-code line: `lint-gcode.ts:60-67`, `parse.ts:45-47`, `streamer.ts:49` (`prepare`), `grbl/src/sim.ts:214`. Three slightly different number patterns (`sim.ts` accepts `1.2.3`). | `rg "matchAll\("`, `rg -F "replace(/\([^)]*\)/g"` | Inside cam: one `words(line)` used by lint and parse (sharing a tokenizer does not share assumptions with `emit` or `check`). grbl stays dependency-free; align its pattern. | S | low | −8 |
| R16 | cam | In `ops/mill.ts`: the wall finishing loop three times (`215-225`, `305-315`, `508-517`); a circle as a polygon three times plus `adaptive.ts`'s `circle()` (`399`, `556-557`, `625`). The half-angle of a pointed cutter four times: `generate.ts:120`, `check.ts:158`, `sim.ts:170`, `mill.ts:320`. | as cited | A local `finishWalls(loops, zTop, zBottom, tabs?)`; export `circle` from `geom2d.ts`; one `cone(tool)` → `{ tan, tipR, height }` next to the `Tool` type. | S | low (golden files) | −35 |
| R17 | cam | ISO thread depth with different digits: `0.54127 / 0.61343` (`lathe.ts:217`), `0.5413 / 0.6134` (`mill.ts:673`, `schema.ts:216`). A lathe and a milled M10 differ by 0.00005 × pitch. | `rg "0\.5413\|0\.6134\|0\.54127\|0\.61343"` | One exported pair of constants; the mill golden file `tapped-block.nc` may move in the fourth decimal, review that diff. | S | low | −2 |
| R18 | cam | Time and deepest point per segment are worked out twice with the same loop: `review.ts:37-47` and `sheet.ts:100-126` (each calls `plannedSeconds` once per segment). | as cited | `segmentStats(program, machine)` in `planner.ts`, used by both. | S | low | −15 |
| R19 | cam, schema | Schema text repeated: the `strategy` and `load` fields verbatim three times (`schema.ts:268-269`, `283-284`, `349-350`); `MillDrill.points` inline although `holes` exists (`356` vs `377`); `SetupPart` and `Job.setups` both spell out `name`, `turn`, `from` (`541-551`, `575-584`). | as cited | `const adaptive = { strategy, load }` like `wallFinish`; use `holes`; build `Job.setups` from `SetupPart.pick(...)`. JSON schema output must stay identical (the agent test can assert it). | S | low | −12 |
| R20 | web | localStorage read/write with try/catch in 12 modules for 14 keys; `store.svelte.ts:14-33` already has `load`/`save` but keeps them private. `store.replace()` and `store.setup()` have identical bodies (`:79-90`). | `rg "localStorage\.(get\|set)Item"` | Move `load`/`save` to `persist.ts` and use them everywhere; make `setup` call `replace`. | S–M | low | −60 |
| R21 | all | Small helpers repeated: `hasErrors` exists, yet `severity === 'error'` is filtered by hand in 8 places (`JobPanel` ×3, `App.svelte:32`, `Chat.svelte:252,274`, `loop.ts:142`, `mcp.ts:112`); 12 local number formatters `n1`/`n2`/`n3`/`fmt`/`round` (`sheet.ts:63-64`, `review.ts:22`, `setups.ts:213`, `SetupSheet.svelte:13`, `SetupBar.svelte:67`, `tooling.ts:69`, `tooling.svelte.ts:13,147`, `probe.svelte.ts:27`, `laserscan.svelte.ts:206`, …); `tools.find((t) => t.id === …)` 21 times in `src`; `secretsMatch` (`server.ts:36`) and `tokensMatch` (`mcp.ts:84`) are the same function; real-time bytes as literals in `grbl/src/sim.ts` although `RT` is exported next door; `VERSION = '0.1.0'` in `mcp.ts:17` beside `package.json`. | `rg` counts in the cited files | `errorsOf(d)` beside `hasErrors`; `fixed(n, digits)` in cam next to `num`; `toolOf(job, id)`; one `sameSecret`; `RT` in the simulator; read the version from `package.json`. | S | none | −40 |
| R22 | tests | `parts.test.ts` and `mill-parts.test.ts` are the same harness twice (read-back loop, `same`, `near`), differing in axes and the size table. | `diff` of the bodies: 40 differing lines of about 100 | One table-driven file, or a shared `support/readback.ts`. Low priority. | S | none | −50 test |

### Inconsistencies and drift

| id | Area | Finding | Evidence | Proposed change | Size | Risk | LOC |
|---|---|---|---|---|---|---|---|
| R23 | docs | The G-code subset is stated five times with three contents. README "What works" and CLAUDE.md: `G0–G3, G17/G18, G7/G8, G21, G90, G94, G54, M0`. The emitter also writes `G4`, `G97`, `G33`, `S`, `M3`, `M5`, `M30` (the two examples alone: `G0 G1 G17 G18 G21 G4 G54 G7 G90 G94 G97 M0 M3 M30 M5`). `emit.ts:1-8` lists most but not `G97`; the lint allows `M4` and `M2`, which are never written; `parse.ts:23-24` has its own list. | `emit.ts:60,105,119-121,128,164-165`; `lint-gcode.ts:20-25`; README:325 | Export one `GCODE_SUBSET` from cam, used by lint and parse; write the full list once in README and point CLAUDE.md at it. | S | none | −5 |
| R24 | docs | Other drift: ARCHITECTURE's package block lists 3 of 5 workspaces (no `grbl`, no `tools/server`) and calls Program moves "rapid, feed, XY arc" (there are ZX arcs and thread moves); README:15 "`npm test` # CAM core and agent loop" (it runs 23 files in 5 workspaces); CLAUDE.md "the emitter writes diameters (G7)" while `xMode: 'radius'` writes `G18 G8 G97`; ARCHITECTURE:39 names two of the four blocked outputs; `ops/lathe.ts:5` "nose radius compensation is not applied yet" (profile and chamfer apply it); `ops/mill.ts:2` "with a flat endmill (or a drill for holes)" (pointed cutters and thread mills exist). | as cited; `xMode` run: `emit` of the lathe example with `xMode: 'radius'` | One docs PR. | S | none | docs |
| R25 | cam, agent | Six shapes for "something to tell the user": `Diagnostic` (`generate.ts:14`: severity, code, message, opId, move), `LintDiagnostic` (severity, code, line, message), `Parsed.warnings` (line, message), `Finding` (code, opId, **text**), `Sheet.problems` (severity, message), and `ToolOutcome`/`CallResult` for tools. `Diagnostic` lives in `generate.ts` but is imported by `align.ts`, `check.ts` and the agent. | as cited | `diagnostic.ts` with one `Diagnostic` (optional `opId`, `move`, `line`); lint and review return it (`Finding.text` → `message`, severity `'note'`). Tool results stay separate. | M | low | −15 |
| R26 | cam | `Machine` is one flat object, so the mill preset carries `xMode: 'diameter'` and `spindleSync` (`presets.ts:33-34`), the form hides them by a hand-kept list (`form.ts:180`), and `generate` checks `STOCK_KIND` and `OP_MACHINE` at run time. | as cited | A discriminated union would be cleaner but changes the job file. Not worth it now; listed so nobody rediscovers it. | L | medium | – |
| R27 | cam | Naming: lathe depth per pass is `doc` (`lathe_turn`, `_profile`, `_bore`) but `stepDown` on `lathe_face`; mill is `stepDown` throughout. `sim` means five things: `cam/sim.ts` (material), `check.ts::simulate`, `grbl/sim.ts` (controller), `web/lib/sim/` (workshop), `camera/sim.ts`. `sheet.ts:132` numbers operations by `o.id ?? ''` where everything else uses `withIds`. | as cited | Rename `cam/sim.ts` → `material.ts` and `grbl/sim.ts` → `simgrbl.ts` when next touched; use `withIds` in the sheet. Leave the field names: they are in saved job files and in the agent's schema. | S | low | ±0 |

### Performance, tests, build

| id | Area | Finding | Evidence | Proposed change | Size | Risk | LOC |
|---|---|---|---|---|---|---|---|
| R28 | cam, agent, web | `analyze` is recomputed for the same job. Per in-app agent tool call: `tools.ts:164` (`after`), then `store.svelte.ts:68` (derived), then `Viewer.svelte:379` (`simulate` again with walls); per message `prompt.ts:48`; at the end `loop.ts:142`. On the mill example each is about 230 ms. | timings above; `rg "\banalyze\("` | Keep the last few results in `analyze`, keyed the way `carry.ts:35-39` already keys its cache. The walls variant needs its own entry or a flag in the key. | S | low | +15 |
| R29 | cam | `MillMaterial.each` with a closure per sample is 89 % of `analyze` on the mill; `cutPath` visits every cell under the cutter twice per sample (engagement, then cut) at a step of half a cell. | CPU profile above; `sim.ts:228-244,264-317` | Same sampling, same results, cheaper loop: per row a span of columns from the circle's half-width (no per-cell distance test for flat cutters), no closure. Do not coarsen the step: that would weaken the checks. The 8 golden parts and the height assertions pin the result. | M | medium | +20 |
| R30 | tests | Wall time is one file: `cam.test.ts` has 120 tests in 28 `describe` blocks and takes 20.7 of 21.6 s, while vitest used 61 s of CPU. Real timers cost another 10 s that hides behind it: `grbl.test.ts` waits 2.4 s and 1.6 s for timeouts, `tooling.test.ts` 3.6 s, `jog.test.ts` 2.2 s, `chat.test.ts` sleeps 400 ms and spawns a Node process per harness call (14.3 s). | per-file and per-test times above | Split `cam.test.ts` by its describe groups into about five files (lathe, mill, setups and carry, adaptive, files and sheet): no test changes, wall time falls to the slowest file. Then fake timers for the two grbl timeouts. R29 shrinks the rest. | S | none | ±0 |
| R31 | web | First load carries everything: one 1,496 kB chunk. The Anthropic SDK (193 kB, 13 %) is needed only when an API key is set; the OpenAI-compatible provider next to it is 253 lines of `fetch`. three.js (565 kB) is imported as `* as THREE` in six files, which tree-shakes; most of it is the renderer and cannot go. | bundle table above; `rg "from 'three"` | `await import()` the provider in `apiProvider` (`providers/services.ts`), so the SDK loads when first used. Leave three alone. A fetch-only Anthropic provider would drop the dependency but leave the 4k7 port; not recommended. | S | low | +5 |

## Architecture

### How the parts relate today

```
Job ─ generate() ─► Program ─┬─ simulate()      material model + checks      check.ts, sim.ts
     (ops/*, arcfit)         ├─ alignmentChecks()                            align.ts
                             ├─ plannedSeconds()                             planner.ts
                             └─ emit() ─ alignPieces() ─► text ─► lintGcode() (tests only)
                                                           └────► parseGcode() (tests only)
```

- Dependency direction between packages is clean: `cam` and `grbl` depend on nothing of ours;
  `agent` → `cam`; `server` → `agent`, `cam`; `web` → all three. No package imports "upwards".
- Inside cam there is one cycle: `check.ts` imports `carried` from `carry.ts`, which imports
  `analyze` from `check.ts` (`check.ts:9`, `carry.ts:14`). It works because both are only called
  late, but it is why `check.ts` cannot be split without care.
- `check.ts` is three things: the checks (`simulate`), the pipeline (`analyze`), and restart
  (`resumeFrom`).
- **Do `check.ts` and `lint-gcode.ts` overlap?** Hardly. The checks need the Job and the material
  (travel, chuck, clamps, rapids into metal, depth); the lint needs only the text and looks at what
  the Program does not have (modal state, feed and spindle before a cut, the subset, the end, printed
  arc digits). The one shared idea is "no low sideways rapid on the mill" (`RAPID_LOW` against
  `RAPID_IN_MATERIAL`), and there the lint is the cruder, independent version on purpose. Keep both;
  share only the subset list (R23).
- State in the web app is twelve module singletons (`store`, `ui`, `machine`, `tooling`, `files`,
  `bridge`, `probe`, `camera`, `laserScan`, `listening`, `look`, `simWorld`), each owning one concern
  and its own persistence. `store.analysis` and `store.gcode` are the only derived pipeline state and
  every panel reads them. That is a reasonable shape; the cost is the repeated persistence code (R20)
  and that "may this text be run" is decided in components, not in state (R3).

### Option A: keep the shape, add the three missing seams (recommended)

1. `diagnostic.ts`: the one `Diagnostic` type (R25).
2. `pipeline.ts`: `analyze`, `resumeFrom` and the new `runnable()` move out of `check.ts`;
   `simulate` takes the carried start as an argument instead of fetching it, which removes the
   cycle. `check.ts` is then only checks.
3. `runnable(job, analysis, { fromSegment? })` → `{ ok: true, text, lineOfMove } | { ok: false,
   errors }`: check errors plus lint findings. The only way to get text that may leave the program.

Cost: about 60 lines moved, 30 added, callers in `store`, `MachinePanel`, `FileMenu`, `JobPanel`,
the server. Gain: the invariant "errors block output" is one function with one test, and the lint is
in use. Nothing changes for operations, the IR or the emitter.

### Option B: one staged result object

`build(job) → Built { program, aligned, diagnostics, material, seconds, gcode, lint }`, with the
measured alignment as an explicit Program → Program stage *before* the checks that can use it, and
every consumer taking `Built` instead of calling stages itself.

- For: one place where order is fixed (ops → align → check → emit → lint); R4 falls out naturally;
  no consumer can emit an unchecked program by accident.
- Against: every caller changes at once (store, agent tools, server, setup sheet, carry, restart);
  the viewer scrubs with partial simulations and restart emits from a segment, so `Built` grows
  options until it is `analyze` + `emit` again; emitting on every keystroke is wasted on jobs with
  errors (cheap today at 0.3 ms, but it couples the stages).
- Verdict: the right direction if a third output format or a second aligned check appears. Option A
  is its first third and does not block it.

### Option C: check what was written

Parse the emitted text back to a Program (`parse.ts`) and run `simulate` on *that*, so the checks
see exactly what the machine gets, alignment included; the lint's geometry rules and the tests'
read-back loops become redundant.

- For: the strongest form of the safety invariant; closes R4 completely; `parse.ts` earns its place.
- Against: doubles the dominant cost (220 ms per mill analysis) unless it replaces the first run, and
  then diagnostics lose their operation ids and move indices unless a line map is carried back;
  moves the emitter does not write (zero-length, merged) and followed cuts in pieces make the
  mapping fiddly; the material checks are meant to run on the block as drawn.
- Verdict: not now. Worth revisiting after R29 makes simulation cheap; the golden-part tests already
  do this read-back for eight real programs.

**Recommendation: A.** Keep the current architecture; it is already "one IR, every consumer reads
it". The leanness to be had is in the seams and duplicates above, not in a new pipeline.

## Proposed PR sequence

Each is independent unless noted, reviewable alone, and ends with `npm run typecheck && npm test &&
npm run build` green. Deletions first.

| PR | Contents | Acceptance |
|---|---|---|
| 1 | Delete dead code: R8, R9, R14 | `npx knip` no longer lists them; pinned `.nc` files unchanged; `src` −95 lines |
| 2 | Docs in step: R23 (text only), R24, README sentence of R5 | every G/M word in the two examples and the eight golden files is in the README list; ARCHITECTURE names five workspaces |
| 3 | `save_gcode` with drawings: R1 | new test fails before, passes after: a job with one shape is written to a temp dir and equals the tab's G-code |
| 4 | The review card sees material and clamps: R6 | new `diffJobs` tests for `workMaterial`, `obstacles`, `notes`, `setups` |
| 5 | Parser to test support: R10 (after Q4) | `rg parseGcode packages/*/src apps tools` empty; tests unchanged |
| 6 | cam dedupe: R16, R17, R18, R19, `words()` of R15 | golden `.nc` unchanged except a reviewed fourth-decimal change from R17; tool JSON schemas byte-identical (assert in `agent.test.ts`) |
| 7 | Small helpers: R21, R13 | `rg "severity === 'error'"` only in cam; one secret comparison; server test still refuses a wrong protocol |
| 8 | Web persistence: R20 | `rg localStorage apps/web/src` only in `persist.ts`; a manual reload keeps job, mode, look, sections |
| 9 | One gate, lint wired: R3, R7, R2 (Option A, steps 2–3) | tests: `runnable` refuses on a check error and on a lint error; `machine.run` has no `string` overload; `get_gcode` on a job with errors starts with the warning line |
| 10 | One Diagnostic, no cycle: R25 (Option A, step 1), R12 | `madge`-style check or a test importing `check.ts` alone; barrel is a named list |
| 11 | Split `cam.test.ts`, fake timers in grbl tests: R30 | same 288 tests; `npm test` wall under 12 s on the same machine |
| 12 | `analyze` cache, then faster height map: R28, R29 | cache: second `analyze` of an equal job under 1 ms, existing "is quick the second time" style test; height map: golden files and height assertions unchanged, mill example `analyze` under 100 ms |
| 13 | Lazy API provider: R31 | `npm run build`: main chunk under 1,320 kB; the SDK in its own chunk; chat with a key still answers (manual) |

After Q3 and Q5 are answered: a PR for R4 (aligned travel and clamp checks, test first with a
turned block next to a clamp) and one for the scripts (R11).

## Open questions for Martin

- **Q1 (R2).** Should `get_gcode` refuse while the job has errors, or answer with a warning line on
  top? Refusing is stricter; the agent then debugs from diagnostics alone.
- **Q2 (R3).** The `window.__swarf*` hooks are what the Playwright scripts drive, against a
  production build. Keep them in production (then `machine.run` must be gated itself), or build
  them only in dev and run the scripts against `npm run dev`?
- **Q3 (R4).** With a measured angle, should travel and clamp checks run on the turned program
  (new errors can appear for jobs that pass today), or does the `TURNED` warning stay the answer?
- **Q4 (R10).** Is "preview a G-code file from elsewhere" still planned? If yes, `parse.ts` stays
  in `src`; if no, it moves to the tests.
- **Q5 (R11).** The 22 Playwright scripts: make them runnable (`playwright` as a devDependency,
  about 300 MB of browsers on first use, one runner) or delete the 14 nothing refers to?
- **Q6 (R12).** Add `knip` to CI so unused exports and files do not come back? It needs a small
  config for the scripts and the `.svelte` entry points.
- **Q7 (R5).** Travel envelope in the Machine settings form now, or only the README correction?
