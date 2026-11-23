# Coolant and other outputs, per tool (design)

Status: proposal, nothing built. Question: how does the user say which machine function (flood,
mist, air blast, dust shoe / vacuum, line laser, or one they define) a tool or operation uses,
and which controller output drives it on this machine, without ever typing G-code?

Premise (Martin, 2026-11-23): no machine yet, so **maximum flexibility**. Nothing below assumes a
particular machine, wiring or controller build; see [Decisions](#decisions-2026-11-23).

## Where we are

- `emit.ts` writes no M7/M8/M9. Every program runs dry.
- The grbl simulator (`packages/grbl/src/sim.ts`) knows M7, M8, M9 (`flood`, `mist`, `A:FM` in the
  status) and clears them on reset. It does not know M62–M65: today it answers `ok` and does nothing.
- The preview's coolant is a look setting (`workshop/look.svelte.ts`, saved in localStorage): with
  it on, every cut gets a hose and a stream, whatever the program says.
- The line laser is hard-wired to M8/M9 (`camera/laserscan.svelte.ts`, README "Line laser"). If a
  program wrote M8 for flood there, it would light the laser, and a pump on M8 would run during a
  scan. This is why no function may be hard-wired to an M-code, the laser included.

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
  from memory and is **to verify on hardware later**). It differs between builds whether M7 is
  compiled in (in grbl 1.1 it needed `ENABLE_M7`), whether M30 or a reset switch aux outputs off,
  and what grblHAL answers to a P beyond its outputs. The design below assumes none of it.

## Options

### A. Coolant on the tool, outputs on the machine

```
 Tool T3  6 mm endmill                 Machine: Mill  ▸ Outputs   (Flood M8 · Mist M7)
   Outputs  [ Flood          ▾]          Function     Output
            Off / Flood / Mist / Air…    Flood        [ M8 (flood) ▾]
                                         Mist         [ M7 (mist)  ▾]
                                         Air blast    [ aux 0      ▾]   wait [0.5] s
                                         Line laser   [ not wired  ▾]
                                         + function
```

\+ One place per tool, like the tool library people know from Fusion; library tools carry it.
\− A drill that wants flood in steel and air in aluminium needs two tools, or editing the tool.

### B. As A, with an override per operation (recommended)

```
 Operation  Pocket 2        Tool [T3 6 mm endmill ▾]
   Outputs  [ as the tool: Flood ▾]
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

## Recommendation: B, with functions and outputs fully configurable

A **function** is a named thing the machine can switch (flood, mist, air blast, vacuum, line
laser, through-spindle coolant, anything the user adds). An **output** is how this machine
switches it: M8, M7, or aux output P n (M64/M65, or M62/M63 if synchronised). Tools and
operations name functions; only the machine profile maps them to outputs. Any function can go to
any output; none has a fixed one.

### Data model (`cam/src/schema.ts`)

```ts
/** A function id: built-ins are flood, mist, air, vacuum, laser; users add their own. */
export const FunctionId = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);
/** The fixed vocabulary of outputs; nothing else can be written. */
export const Output = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('m8') }),
  z.object({ kind: z.literal('m7') }),
  z.object({ kind: z.literal('aux'), p: z.number().int().min(0).max(255),
             sync: z.boolean().default(false) }),   // false: M64/M65, true: M62/M63
]);

Machine += {
  functions: z.array(z.object({
    id: FunctionId,
    name: z.string().max(40),          // the label; only in the UI and (sanitised) G-code comments
    output: Output.optional(),         // absent = not wired
    /** Seconds to wait after switching on (a vacuum spinning up, a pump filling its hose). */
    wait: z.number().min(0).max(10).default(0),
  })).default(STARTING_FUNCTIONS),
  /** What the controller build can do; safe defaults for a machine nobody has seen yet. */
  controller: z.object({
    m7: z.boolean().default(true),                         // M7 compiled in
    auxOutputs: z.number().int().min(0).max(256).optional(), // absent = unknown
    unmapped: z.enum(['warning', 'error']).default('warning'),
  }).default({}),
}
Tool += { functions: z.array(FunctionId).max(4).optional() }   // absent or [] = dry
common (every operation) += { functions: z.array(FunctionId).max(4).optional() } // absent = as the tool; [] = dry
```

`STARTING_FUNCTIONS`, the preset of a new machine profile and nothing more: flood → M8,
mist → M7, air, vacuum, laser (the last three not wired). Every row can be rewired, renamed or
deleted, and "+ function" adds one (id from the name, e.g. `through_spindle`). The lathe and
mill presets get the same list; the laser is not wired on either.

A list, not one value, because flood + air or air + vacuum are real combinations; the UI offers
them as dropdown entries, not as a list editor. Tools store function ids, never outputs, so a
library tool means the same on every machine. The only free text is the function name, which
never becomes a G-code word: only M7, M8, M9, M62–M65 with an integer P (and the G4 dwells
already used) can come out.

Existing jobs and library files parse unchanged and run dry (no tool has `functions`).

### UI

- **Tool form** (Tools tab, `form.ts` `toolFieldsFor`): "Outputs" dropdown: Off, then each
  function of the machine, then the combinations of those. Unwired functions are offered too,
  marked "(not wired)", so a library can be prepared before the machine exists.
- **Operation form**: the same dropdown, first entry "as the tool: Flood" (default). The op list's
  sub-line shows it when it differs from the tool ("T3 · dry").
- **Machine settings** (Setup tab): an "Outputs" section, collapsed, its summary one line ("Flood
  M8 · Mist M7"; a warning sign when two functions share an output). Opened: the table from
  option A (output dropdown: not wired, M8, M7, aux P n, aux P n synchronised), "+ function",
  and the controller fields: "M7 available", "Aux outputs (unknown)", "Unwired function used:
  warn / block". This is the only place outputs appear.
- **Setup sheet**: a column per tool and operation listing its functions and outputs.
- **Preview**: the stream follows the program (flood/mist: drops, air: a faint puff, others:
  nothing); the look toggle stays as "show coolant" to hide it when it distracts.

### Emitting (`emit.ts`)

What a segment wants: `op.functions ?? tool.functions ?? []`, each looked up in
`machine.functions`. The emitter tracks what is on, like it tracks `rpm`:

1. **Segment start** (the first move of the operation), after `S… M3` and its `G4` dwell (the
   spindle turns first): switch off what is no longer wanted, then on what is newly wanted, then
   `G4 P<wait>` if any newly switched function has a wait. If M7 or M8 must go off, write `M9`
   and switch the one that stays back on (grbl has no "M8 off"). If no dwell came just before
   (same tool, same rpm), write `G4 P0` first. Aux on is `M64 P n`, or `M62 P n` if `sync`.
2. **Tool change**: `M9` and `M65 P n` for every aux that is on, then `M5`, the comments, `M0`.
   After the change nothing is assumed on.
3. **Program end**: `M9` and `M65 P n` for every aux the program used, then `M5`, `M30`. Always
   explicit, never relying on M30 or a reset to switch anything off.
4. **Starting again** (`fromSegment`): the segment begins like a tool change, so its outputs are
   switched on there.
5. A wanted function that is not wired writes nothing but a comment at segment start
   ("(air blast: not wired)"), so the reader of the G-code sees it.
6. The laser is not special: if a tool or op asked for it, it would be switched like any other.

M64/M65 is the default because every place we switch already follows something that waits for
the moves (`M5`, `M9`, `G4` sync grbl's planner), so "immediately" is exactly in step, and it
avoids M62's "at the next motion" semantics, which differ between controllers. `sync` is there
for a controller where M62 is the better choice; offs are always M65.

Later option, not in this plan: switching on only once the tool is near the work (less mess,
more logic).

### Checks (`check.ts`)

- **Unwired function**: "Pocket 2 wants air blast; this mill has no output for it (Machine
  settings → Outputs)." A **warning** by default: the program can still be downloaded, runs that
  function dry, and the G-code says so. With `controller.unmapped: 'error'` it is an error and
  blocks like every other. The same for an id the machine does not know at all.
- **M7 not available**: a function wired to M7 used while `controller.m7` is false: error (the
  controller would refuse the line).
- **Aux out of range**: P ≥ `auxOutputs`, when the count is known: error. Unknown count: not
  checked.
- **Shared output**: a used function shares an output with another function: warning ("Flood
  would switch M8, which also drives the line laser"). Sharing can be deliberate.
- Emitted vocabulary: a test (not a runtime check) runs every fixture job through `emit()` and
  asserts each line only uses the words of the subset in `emit.ts`'s header, now including
  M7/M8/M9/M62–M65 with an integer P.
- The simulator must accept every emitted program without `error:` and end with all outputs off.

### Stop and reset

The app's Stop (`machine.svelte.ts`) resets, then sends `M9` and `M65 P n` for every aux the
machine maps, whatever the build does on reset (cheap, harmless). The laser scan switches the
output wired to `laser`; if there is none, it asks for one in Machine settings instead of
assuming M8.

### The agent

`set_tool` and `add_operation`/`update_operation` take the Tool and operation schemas, so
`functions` arrives with them; its `.describe()` says "ids of the machine's functions". The agent
never sees outputs and has no tool to edit the machine. The compact job state lists the
machine's functions and whether each is wired ("functions: flood, mist, air (not wired)").
Prompt line: "Outputs: set functions on the tool (flood, mist, air, …, or one the machine
defines) when the user asks for them; if a check says one is not wired, tell the user, do not
drop it to silence the check."

## Pull requests

1. **Schema.** `FunctionId`, `Output`, `Machine.functions`, `Machine.controller`,
   `Tool.functions`, operation `functions`; `STARTING_FUNCTIONS` in both presets.
   *Tests:* old job and library files parse; a new machine has flood→M8, mist→M7, the rest
   unwired; a user function parses; `emit()` text of every existing fixture is byte-identical;
   a free-text output (`"M8 S0"`) and an id with spaces are rejected.
2. **Simulator.** `sim.ts` learns `M64/M65 P n` and `M62/M63` (queued with the moves),
   `aux: boolean[]`, sim options for the aux count, M7 present and whether reset clears aux, so
   tests cover the builds we cannot yet look at.
   *Tests:* `M64 P1` sets `aux[1]`, `M65 P1` clears it; `M62 P1` takes effect with the next
   move; `M64 P9` on a 4-output sim is refused; `M7` on a sim without it is refused; M7/M8/M9
   tests unchanged.
3. **Emitter and checks.** The rules above; the four checks; the vocabulary test.
   *Tests:* tool with flood → `M8` after the first `G4`, `M9` before `M5`/`M0` and before
   `M30`; op override `[]` → none in that op only; flood→mist → `M9`, `M7`; same tool and rpm
   → `G4 P0` first; aux with wait 0.5 → `M64 P0`, `G4 P0.5`; `sync` → `M62`; user function on
   aux 3 → `M64 P3`/`M65 P3`; `fromSegment` switches on; unwired air → warning plus comment, and
   error with `unmapped: 'error'`; M7 with `m7: false` → error; shared output → warning; the
   emitted program on a sim whose reset keeps aux ends with everything off.
4. **UI.** Tool and operation dropdowns, the Outputs section with "+ function" and the
   controller fields, the setup sheet column.
   *Tests:* `form.ts` offers every machine function, unwired ones marked; "as the tool: Flood"
   is the op default; adding and rewiring functions writes `machine.functions` through
   `Machine.safeParse`; the summary warns on a shared output.
5. **Preview, stop, laser.** The stream follows the program per segment; Stop sends `M9` and
   `M65` for mapped aux; the laser scan switches the `laser` function's output.
   *Tests:* particles only in flood/mist segments; laser scan with the laser on `aux 2` sends
   `M64 P2`/`M65 P2` and never M8; with the laser unwired it asks instead of switching.
6. **Agent.** Field descriptions, the prompt line, functions in the compact state.
   *Tests:* the agent's tool schemas contain `functions` as a list of ids and nothing that takes
   an output or G-code; the demo provider sets flood on a tool and the check passes.

## Decisions (2026-11-23)

Martin: "At the moment I have no machine and need maximum flexibility."

1. Any function (flood, mist, air, vacuum, line laser, user-defined) maps to any output: M8, M7,
   aux M64/M65 P n or M62/M63 P n, per machine profile. Nothing is hard-wired.
2. Users add their own functions; through-spindle coolant is just one they might define.
3. Flood→M8 and mist→M7 are only the presets of a new machine, fully editable; the line laser
   has no fixed output.
4. Controller-build differences are machine settings with safe defaults: M7 available (on),
   aux count (unknown, unchecked), and outputs are always switched off explicitly before M30,
   at tool changes and after Stop, so whether M30 or reset clears them does not matter.
5. A used function without an output is a warning (download still possible, the G-code says
   so); a per-machine switch makes it an error.
6. Outputs switch on at the first move of the operation; "near the work" is a possible later
   option.

To verify on hardware later (not blocking): what grblHAL answers to a P beyond its outputs and
to M7 when not compiled in (the sim's error codes), and whether M62 or M64 is the better default.
