# Coolant and other outputs, per tool (design)

Status: proposal, nothing built. Question: how does the user say which machine function (flood,
mist, air blast, dust shoe / vacuum) a tool or operation uses, and which controller output drives
it on this machine, without ever typing G-code?

## Where we are

- `emit.ts` writes no M7/M8/M9. Every program runs dry.
- The grbl simulator (`packages/grbl/src/sim.ts`) knows M7, M8, M9 (`flood`, `mist`, `A:FM` in the
  status) and clears them on reset. It does not know M62–M65: today it answers `ok` and does nothing.
- The preview's coolant is a look setting (`workshop/look.svelte.ts`, saved in localStorage): with
  it on, every cut gets a hose and a stream, whatever the program says.
- **The flood output is already taken on the mill:** the line laser is switched by M8/M9
  (`camera/laserscan.svelte.ts`, README "Line laser"). If a program wrote M8 for flood coolant
  there, it would light the laser; and if a pump were wired to M8, the laser scan would run it.
  So the mapping has to cover the laser too, and "flood = M8" cannot be assumed on every machine.

## How others do it

- **Fusion 360**: coolant is a property of the tool (tool library, Cutting data: Disabled, Flood,
  Mist, Air, Through tool, Suction, Flood + mist …), copied into each operation, where it can be
  changed. The post-processor maps each mode to M-codes in a `coolants` table (`{id:
  COOLANT_FLOOD, on: 8, off: 9}`); a mode the table lacks stops posting with "coolant not
  supported". It switches coolant off at tool changes and the end. Wiring lives in the post, edited
  as JavaScript — exactly what swarf must not ask of anyone.
- **Estlcam** (from memory, not checked): the CAM side has a coolant choice per tool; the
  controller settings give the M-codes / pins for coolant on and off. Two outputs, no named
  functions.
- **LinuxCNC**: M7/M8/M9 drive the HAL pins `iocontrol.0.coolant-mist` / `-flood`; what they switch
  is wiring in the HAL file. M62/M63 P n (in step with motion) and M64/M65 P n (immediately) drive
  `motion.digital-out-NN`. The tool table has no coolant; the CAM post decides.
- **grblHAL**: M7 mist, M8 flood, M9 both off, on fixed pins of the board map (invertible with a
  `$` setting). Aux digital outputs: M62/M63 P n (synchronised with motion), M64/M65 P n
  (immediate), P counted from 0; how many there are depends on the board (the newer `$I` lists
  them; I could not find grblHAL's source or docs in this repo or `node_modules`, so this comes
  from memory and **must be verified on Martin's controllers** before PR 3). Unsure, too: whether
  M7 is compiled in on every board (in grbl 1.1 it needed `ENABLE_M7`), whether M30 or a reset
  switch aux outputs off, and what grblHAL answers to a P beyond its outputs.

## Options

### A. Coolant on the tool, outputs on the machine

```
 Tool T3  6 mm endmill                 Machine: Mill  ▸ Outputs   (Flood M8 · Laser M8 ⚠)
   Coolant  [ Flood          ▾]          Function     Output
            Off / Flood / Mist / Air     Flood        [ M8 (flood) ▾]
                                         Mist         [ M7 (mist)  ▾]
                                         Air blast    [ aux 0      ▾]   wait [0.5] s
                                         Line laser   [ M8 (flood) ▾]
                                         + function
```

\+ One place per tool, like the tool library people know from Fusion; library tools carry it.
\− A drill that wants flood in steel and air in aluminium needs two tools, or editing the tool.

### B. As A, with an override per operation (recommended)

```
 Operation  Pocket 2        Tool [T3 6 mm endmill ▾]
   Coolant  [ as the tool: Flood ▾]
            as the tool / Off / Flood / Mist / Air / Flood + air …
```

\+ The tool's choice works with zero clicks; the rare exception (dry finishing pass, air for the
  engraving) is one dropdown on that operation. Same model as Fusion, without the post.
\− Two places to look; the operation must show what "as the tool" means (it says "as the tool:
  Flood").

### C. Per operation only, M8 fixed

```
 Operation  Pocket 2      [x] Coolant (M8)
```

\+ Smallest. \− No mist/air/vacuum, no laser conflict handling, and every new operation needs the
box ticked. Rules out the cases Martin asked about.

Rejected: the tool naming an output (`T3 → aux 1`). Wiring belongs to the machine; a library tool
must keep meaning the same on the lathe and the mill.

## Recommendation: B

### Data model (`cam/src/schema.ts`)

```ts
/** What an output is for. Coolant functions can be asked for by tools; 'laser' only by the laser scan. */
export const Coolant = z.enum(['flood', 'mist', 'air', 'vacuum']);
export const OutputUse = z.enum([...Coolant.options, 'laser']);
/** The fixed vocabulary: M8, M7, or an aux digital output (M64/M65 P n). */
export const OutputPin = z.union([z.enum(['flood', 'mist']), z.object({ aux: z.number().int().min(0).max(15) })]);

Machine += {
  outputs: z.array(z.object({
    use: OutputUse,
    pin: OutputPin,
    /** Seconds to wait after switching on (a vacuum spinning up, a pump filling its hose). */
    wait: z.number().min(0).max(10).default(0),
  })).default([{ use: 'flood', pin: 'flood' }, { use: 'mist', pin: 'mist' }]),
  /** How many aux outputs the controller has (M64 P0 … P n-1). */
  auxOutputs: z.number().int().min(0).max(16).default(0),
}
Tool += { coolant: z.array(Coolant).max(3).optional() }   // absent or [] = dry
common (every operation) += { coolant: z.array(Coolant).max(3).optional() } // absent = as the tool; [] = dry
```

A list, not one value, because flood + air or air + vacuum are real combinations; the UI offers
them as dropdown entries, not as a list editor. No free text anywhere: the pin is `flood`, `mist`
or an aux number, so nothing but M7, M8, M9, M64, M65 (and the G4 dwells already used) can come
out.

Defaults: existing jobs and library files parse unchanged and run dry (no tool has `coolant`).
A new machine maps flood → M8 and mist → M7, so choosing Flood on a tool works with no setup.
The mill preset (`presets.ts` MILL) gets `{ use: 'laser', pin: 'flood' }` added, which makes the conflict visible.

### UI

- **Tool form** (Tools tab, `form.ts` `toolFieldsFor`): "Coolant" dropdown: Off, then each function
  the machine has an output for, then the combinations of those. A function without an output is
  not offered; a hint under the field says "Air blast, vacuum: add an output in Machine settings".
- **Operation form**: "Coolant" dropdown, first entry "as the tool: Flood" (default), then Off and
  the same list. The op list's sub-line shows it when it differs from the tool ("T3 · dry").
- **Machine settings** (Setup tab): an "Outputs" section, collapsed, its summary one line ("Flood
  M8 · Mist M7"; a warning sign when two uses share a pin). Opened: the table from option A, a
  number field for aux outputs, "+ function". This is the only place pins appear.
- **Setup sheet**: a coolant column per tool and operation, so the machinist fills the tank.
- **Preview**: the coolant stream follows the program (flood/mist: drops, air: a faint puff or
  nothing, vacuum: nothing); the look toggle stays as "show coolant" to hide it when it distracts.

### Emitting (`emit.ts`)

What a segment wants: `op.coolant ?? tool.coolant ?? []`, each function looked up in
`machine.outputs`. The emitter tracks what is on, like it tracks `rpm`:

1. **Segment start**, after `S… M3` and its `G4` dwell (the spindle turns first): switch off what
   is no longer wanted, then on what is newly wanted, then `G4 P<wait>` if any newly switched use
   has a wait. If M7 or M8 must go off, write `M9` and switch the one that stays back on (grbl has
   no "M8 off"). If no dwell came just before (same tool, same rpm), write `G4 P0` first.
2. **Tool change**: `M9` and `M65 P n` for every aux that is on, then `M5`, the comments, `M0`.
   After the change nothing is assumed on, the same as with the modes.
3. **Program end**: `M9`, `M65 P n` for every aux the program used, `M5`, `M30`. Written even if
   M30 switches some of it off, because I am not sure it does for aux outputs.
4. **Starting again** (`fromSegment`): the segment begins like a tool change, so its outputs are
   switched on there.
5. `laser` is never written into a program.

Why M64/M65 (immediate) and not M62/M63: every place we switch already follows something that
waits for the moves to finish (`M5`, `M9` and `G4` all sync grbl's planner), so "immediately" is
exactly in step, and it avoids M62's "at the next motion" semantics, which differ between
controllers and leave the output on when no motion follows. To be confirmed on the machine.

### Checks (`check.ts`, errors unless said)

- A segment wants a function the machine has no output for: "Pocket 2 wants air blast; this mill
  has no output for it (Machine settings → Outputs)."
- A used function shares a pin with another use: "Flood would switch M8, which drives the line
  laser on this mill." (Warning only when the shared use is not in the program.)
- An aux pin ≥ `auxOutputs`.
- Emitted vocabulary: a test (not a runtime check) runs every fixture job through `emit()` and
  asserts each line only uses the words of the subset in `emit.ts`'s header, now including
  M7/M8/M9/M64/M65 with P < `auxOutputs`.
- The simulator must accept every emitted program without `error:` and end with all outputs off.

### Stop and reset

The app's Stop (`machine.svelte.ts`) resets; grbl's reset switches M7/M8 off. For aux outputs,
after the reset, send `M65 P n` for every aux the machine maps (cheap, harmless). The laser scan
uses the machine's `laser` output (M8/M9 or M64/M65 P n) instead of hard-coding M8.

### The agent

`set_tool` and `add_operation`/`update_operation` take the Tool and operation schemas, so the
`coolant` field arrives with them; its `.describe()` lists the functions. The agent never sees
pins and has no tool to edit the machine. Prompt line: "Coolant: set it on the tool (flood, mist,
air, vacuum) only when the user says the machine has it; a check says when the machine has no
output for it — tell the user then, do not drop the coolant to silence it." The compact job state
shows the machine's coolant functions ("coolant: flood, mist") so it knows what exists.

## Pull requests

1. **Schema.** `Coolant`, `OutputUse`, `OutputPin`, `Machine.outputs`, `auxOutputs`,
   `Tool.coolant`, operation `coolant`; mill preset gets the laser output.
   *Tests:* old job and library files parse; the defaults are flood→M8, mist→M7; `emit()` text of
   every existing fixture is byte-identical; a free-text pin (`"M8 S0"`) is rejected.
2. **Simulator.** `sim.ts` learns `M64/M65 P n` (and `M62/M63` queued with the moves, for
   completeness), `aux: boolean[]`, cleared on reset; a P beyond its outputs is an error (the code
   grblHAL really uses, once looked up).
   *Tests:* `M64 P1` sets `aux[1]`, `M65 P1` clears it; reset clears all; `M64 P9` on a 4-output
   sim is refused; M7/M8/M9 tests unchanged.
3. **Emitter and checks.** The rules above; the three checks; the vocabulary test.
   *Tests:* tool with flood → `M8` after the first `G4`, `M9` before `M5`/`M0` and before `M30`;
   op override `[]` → no coolant in that op only; flood→mist between ops → `M9`, `M7`; same tool
   and rpm with a change → `G4 P0` first; aux with wait 0.5 → `M64 P0`, `G4 P0.5`; `fromSegment`
   switches the segment's outputs on; air with no output → error; flood on the laser's pin →
   error; running the emitted program on the sim ends with `flood`, `mist`, all `aux` off.
4. **UI.** Tool and operation dropdowns, the Outputs section, the setup sheet column.
   *Tests:* `form.ts` offers only mapped functions; "as the tool: Flood" is the op default;
   editing outputs writes `machine.outputs` through `Machine.safeParse`; the summary warns on a
   shared pin.
5. **Preview, stop, laser.** The stream follows the program's coolant per segment; Stop sends
   `M65` for mapped aux; the laser scan switches the `laser` output.
   *Tests:* particles on only in flood/mist segments (unit test on the segment → coolant
   function); laser scan on a sim with the laser on `aux 2` sends `M64 P2`/`M65 P2` and never M8.
6. **Agent.** Field descriptions, the prompt line, coolant functions in the compact state.
   *Tests:* the tool schemas the agent gets contain `coolant` as an enum list and nothing that
   takes a pin or text; the demo provider sets flood on a tool and the check passes.

## Open questions for Martin

1. Which outputs are wired on the lathe and the mill today (flood pump? mist? air valve? dust
   shoe?), and how many aux outputs do the boards report in `$I`?
2. Can the line laser move to an aux output, freeing M8 for coolant, or stays it on M8?
3. Does M30 / a reset switch the aux outputs off on your grblHAL build, and is M7 compiled in?
4. Coolant on at the first move of the operation (simple, recommended) or only once the tool is
   near the work (less mess, more logic)?
5. Should a missing output be an error (blocks the download) or a warning?
6. Spindle-through coolant: out of scope for now (no machine has it), or a function already?
