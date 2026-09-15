# Gimkit Creative SDK

Program Gimkit Creative maps with **high-level commands** instead of scripting
individual mouse movements. Say `place trigger "Forward Pass" at r6c0` and the
SDK does the whole dance: Escape → E → Devices → search "Trigger" → click tile →
click map → Escape. Every verb is pre-programmed, verified by re-opening the
device, and retried on failure.

Built from the battle-tested primitives in `gimkit-creative-nn-builder`
(the XOR neural-network bot) — this is the reusable version for any map.

```
gimkit-creative-sdk/
  src/index.mjs      GkcMap — the API (open / dryRun / place / property / button / trigger / option / blocks / run / simulate)
  src/cli.mjs        gkc — command line (run / check / plan / simulate / probe / do / repl / blocks / devices)
  src/commands.mjs   the .gkc command language → actions
  src/blocks.mjs     block-code compiler: text → AST → lint → Blockly API in the device's workspace
  src/simulate.mjs   offline interpreter with Gimkit semantics (properties, variables, channels, Set Text)
  src/actions.mjs    verbs: primitive click recipe (dry-run) + executor (live), device tables
  src/layout.mjs     grid rows/cols → screen coords, named-device registry
  src/spec.mjs       JSON map spec → actions
  src/runner.mjs     validate (cross-script lints), retries, position resolution, run-report.json
  src/session.mjs    connect to Chrome, auto-login, wait for build mode, wait for save on close
  src/probe.mjs      gkc probe — dump the live Blockly registry / sidebar labels to build-output/probe.json
  src/editor/        low-level Gimkit editor primitives (block-code.mjs, device-options.mjs, ...)
  examples/          xor-nn.gkc, hello.gkc, counter.map.json
  test/              106 offline tests — `npm test`
```

## Pipeline

```
.gkc / map.json → parse (+ eager block AST) → lint + validate (Gimkit rules)
               → simulate (offline interpreter) → execute in the editor → reopen + read back
gkc probe → build-output/probe.json  (real block/panel names, feeds the vocabulary table)
```

## Quick start

```powershell
git clone https://github.com/srwilliamson/gimkit-creative-sdk.git
cd gimkit-creative-sdk
npm install                                # Playwright (drives your installed Google Chrome; no browser download)
npm test                                   # offline: parser, lints, simulator, mock-Blockly builder
node src/cli.mjs check examples/xor-nn.gkc # static check: 0 errors, 0 warnings
node src/cli.mjs simulate examples/xor-nn.gkc --set input1=1 --set input2=0 --fire nn-forward
node src/cli.mjs plan examples/hello.gkc   # print the click plan, touch nothing

# live (Chrome must be logged into Gimkit, or set GKC_EMAIL/GKC_PASSWORD)
$env:GKC_HOST_URL = "https://www.gimkit.com/host?id=<your map id>"
$env:GKC_AUTO = "1"
node src/cli.mjs run examples/hello.gkc
node src/cli.mjs probe --at r0c0           # dump what the editor really calls things
```

## The command language (`.gkc`)

```
layout origin 72,72 gap 95,68             # grid → screen coords (or: layout fit 10x3)

place trigger "Forward Pass" at r6c0       # place a device; remembers the name → position
place property input1 at 400,300           # any device type: property, button, text, counter,
place button "Run NN" at r7c2              # zone, popup, item granter, ... (gkc devices)

place item granter at r3c3                 # multi-word types work; names with spaces MUST be quoted
place knockout manager "KO" at r3c4        # the full Gimkit device list is known (gkc devices)
place "Some New Device" "X" at r4c4        # unknown type: quote it; the search box is tried as-is

property input1 = 0                        # configure Property: Number type, global scope,
property weight1-1 = -80 at r2c0           #   name + default; position by name or explicit
property title = "hi" type Text scope player   # Text / True/False types, global|player|team scope
property flag = true                       #   defaults must be literals; Numbers must be integers

button "Run NN" transmits nn-forward       # When button pressed → transmit on channel
button "Run NN" transmits nn-forward message "Run the network"   # + Button Message
trigger "Forward Pass" receives nn-forward # When receiving on channel
trigger "Step" receives go hidden delay 2 max 1   # Visible In-Game=No, Trigger Delay, Max Triggers

text "Hello" at r0c0                       # Text device content (typed for real, read back to verify)
text "Title" size 32 at r0c1               # + Font Size
option "Forward Pass" "Trigger Delay" = 2  # ANY sidebar option by its label (select/switch/input)

blocks "Set input1=1": property input1 = 1 # one-line block program
blocks "Forward Pass" {                    # multi-line block program — REPLACES existing code
  set A = {input1}                         #   {name} = Get Property, bare A = variable
  set Z1 = {bias1} + A * {weight1-1}       #   dashes/spaces only inside braces: {weight1-1}
  relu Z1                                  #   sugar for: if Z1 < 0 then set Z1 = 0
  if A > 1 and not Z1 == 0 { set A = 1 }   #   and / or / not, true / false
  if Z1 > 100 { property big = 1 } else if Z1 > 50 { property big = 2 } else { property big = 0 }
  if A < 0 then set A = 0 else set A = 1   #   single-line form
  property net_output = round(Z1 / 100)    #   Set Property
  property label = "done"                  #   text literal → Text block
  broadcast "nn-done"                      #   Broadcast Message On Channel
  # comments: `#` or `//`
}
blocks "Forward Pass" append { ... }       # keep existing blocks; add after them
blocks "XOR = ?" on nn-done {              # block code for the event "When receiving on channel nn-done"
  text = "XOR = " + {net_output}           #   Set Text (Text devices); + with text = join
}
blocks "Zone A" when triggered { ... }     # block code for "When triggered" (or: when "Player Enters Zone")

read property input1 | wait 500 | wait 1.5s | click 100,200 | press ctrl+z | screenshot name | prepare
```

Positions: `at r2c1` (grid), `at 400,300` (pixels), `at "Some Device"` (named),
or omitted → looked up by the command's own name. Every `place` registers its
name, so the rest of the script never repeats coordinates.

Block programs are compiled to Blockly via the page's own `window.Blockly` API
(block types discovered at runtime), chained, and attached under the event hat
block — no flyout dragging. `gkc blocks "<program>"` prints the AST and block
count (Gimkit caps ≈ 75 blocks per workspace).

### Block vocabulary (construct → Gimkit block)

| You write | Gimkit block | Notes |
|---|---|---|
| `{name}` | Get Property | any name works inside braces: `{Score ✓}`, `{Player's total}` |
| `property name = expr` | Set Property | `property n = round(expr)` uses the Round block |
| `set A = expr` / `A = expr` / `var A` | Set variable / Get variable | variables start at 0 in Gimkit |
| `+ - * /` | Arithmetic (ADD MINUS MULTIPLY DIVIDE) | DIVIDE keeps decimals |
| `%` | Remainder of ÷ | true modulo (sign of the divisor) |
| `< > <= >= == !=` | Compare | same-type operands only |
| `and` `or` `not` (`&&` `\|\|` `!`) | Logic operation / Not | operands must be true/false |
| `true` `false` | Boolean | |
| `round floor ceil` | Round / Round down / Round up | |
| `abs sqrt` | Math single (ABS / ROOT) | |
| `random(a, b)` | Random integer from a to b | |
| `"text"` | Text | escapes: `\"` `\n` |
| `"a" + x` (any text operand) | Create text with (join) | numbers are joined as text |
| `text(x)` / `number(x)` | Convert number → text / text → number | |
| `len(x)` | Length of text | |
| `player.name` `player.team` `player.score` | Triggering Player's Name / Team Number / Score | |
| `text = expr` | Set Text | Text devices only; needs `blocks ... on <channel>` |
| `broadcast "ch"` | Broadcast Message On Channel | |
| `if c { } else if { } else { }` | If / else | |
| `relu X` | if X < 0 then set X = 0 | |
| `block "Visible Block Name" arg, key = arg` | any Gimkit block, matched by its visible text | escape hatch; positional args fill value inputs in order |

Every construct maps to `findType(candidates, regex)` against the live Blockly
registry. Anything the editor does not have lands in `unsupported`, the action
fails, and the reply carries a `registrySample` — a wrong guess is a data fix,
never a silently wrong map. Run `gkc probe` to dump the real registry.

### Block-code events

A fresh device has no Blockly workspace: Gimkit's Blocks tab is a *list* of block
codes, each created for one event. `blocks "Name" on <channel>` selects (or
creates) the "When receiving on channel" code for that channel; `when triggered`
the trigger event; `when "Some Event"` any other entry by its label; with no
event the device's existing (or default) block code is used. Replace/append
semantics apply per workspace.

### Device options

Dedicated syntax: trigger `hidden` / `visible`, `delay N`, `max N`; button
`message "..."`; text `size N`. Everything else: `option "Device" "Label" = value`
— the executor finds the label in the sidebar, drives the control below it
(ant-select, switch, checkbox, radio, input, textarea) with real events, then
re-opens the device and reads the value back. `true`/`false` match Yes/No,
On/Off, Enabled/Disabled.

Negative Number defaults sometimes do not persist in the editor. When that
happens the failure explains the workaround Gimkit users rely on: keep the
default 0 and set the value at game start (Lifecycle "Game Start" → channel →
trigger with `blocks "Init" { property w = -80 }`).

### What the compiler refuses (on purpose)

Every one of these came from a real way to silently build the wrong map:

| You write | What happens | Why |
|---|---|---|
| `set Z = bias1 + 2` | error: *did you mean `{bias1}`?* | a bare name is a workspace variable (starts at 0); the Property is `{bias1}` |
| `A * weight1-1` | error on `weight1` | parses as `weight1 - 1`; dashes only work inside braces |
| `property w = 0.82` | error: *not an integer, scale ×100 → 82* | Gimkit stores whole numbers; decimals are dropped |
| `max(A, 0)` | error with an `if`/`relu` recipe | there is no max block; the old builder emitted just `A` |
| `set A = "x" * 2` | error | text in arithmetic (`+` with text is a join, on purpose) |
| `if 1 == "1"`, `1 < 2 and 3`, `not 5`, `true + 1` | error | Gimkit compares same types; logic blocks take true/false |
| `0 < A < 5` | error: *use `and`* | no chained comparisons in Blockly |
| `place trigger Forward Pass at r0c0` | error: quote it | would have created a device type "Trigger Forward" named "Pass" |
| `blocks "T": frobnicate x` | error at parse time | previously surfaced only after 50 clicks |
| `property x = {a} + 1` | error: *use blocks* | defaults are literals; runtime values live in block code |
| `property label = "x"` then `property label = 5` in blocks | validate error | property types are fixed per device |
| `{Input1}` in blocks vs `property input1` | validate error | Gimkit names are case-sensitive |
| `property score` and `property Score` | validate error | two names differing only by case |
| `blocks "p"` where `p` is a Property/Button/Counter... | validate error | those devices have no Blocks tab |
| a script line at `x=1400` | validate error | that is under the device sidebar; clicks there open nothing |
| two devices named `T` | validate error | later lines look devices up by name |
| `blocks "T"` using `{hits}` with no `property hits` | validate warning | Gimkit needs a Property device with exactly that name |
| `transmits GO` but `receives go` (or a channel nobody receives / transmits) | validate warning | channels are case-sensitive; unwired channels do nothing |
| `text = ...` without `on <channel>`, or on a non-Text device | validate warning | Set Text only runs when its block code fires |
| device placed but never configured | validate warning | an unnamed Property / unwired Button does nothing in-game |
| > ~100 Property devices | validate warning | Gimkit maps cap out around 128 |
| default beyond ±2^53 | warning | not exactly representable |
| > 75 blocks in one program | lint warning | Gimkit's per-device cap |

`gkc check <file>` runs all of these without a browser. `gkc run` runs them
first and refuses to click anything if there are errors (`--force` overrides,
`--strict` also blocks on warnings, `--stop-on-fail` aborts after the first
failed action). A device whose `place` failed marks every later command on that
spot as *skipped* instead of configuring an empty tile.

### What Gimkit Creative constrains (and how the SDK handles it)

- Properties hold whole numbers, text or true/false; one type per device →
  integer defaults, scale weights ×100, type lints across the script.
- Property and channel names are case-sensitive → exact-match lints with the
  other spelling in the message.
- ~75 blocks per block code, ~128 Property devices per map → estimate + warn.
- Only some devices have a Blocks tab (Trigger, Text, Popup, Notification,
  Questioner, Item Granter, Game Overlay, Tag Zone, Knockout Manager,
  Inventory Item Manager, Zone, Vending Machine, Dialogue, Voting, Queue, …) →
  errors for the known-not-to, warnings for the unknown.
- Block code is per event; a fresh device has none → `on <channel>` /
  `when triggered` plus `ensureBlockWorkspace`.
- Set Text exists only on Text devices; it runs when *that device's* block code
  fires → `text = ...` needs `blocks "Text" on <channel>`.
- Variables start at 0, unknown properties read 0, DIVIDE keeps decimals,
  Round is `Math.round` → the simulator uses exactly these rules.
- The editor autosaves asynchronously → `close()` waits for the save indicator.
- Coordinates are screen-space at a fixed zoom → safe-zone validation and an
  anchor re-check before the configure phase (aborts if the map was panned).

### Offline simulation: `gkc simulate`

```powershell
node src/cli.mjs simulate examples/xor-nn.gkc --set input1=1 --set input2=0 --fire nn-forward
node src/cli.mjs simulate examples/xor-nn.gkc --press "In1 ON" --press "Run NN" --trace --json
```

`src/simulate.mjs` interprets the compiled AST with Gimkit semantics and
propagates channels: firing a channel runs every trigger receiving it and every
`blocks ... on <channel>`; `broadcast` cascades (loop-guarded); `max N` on a
trigger is honoured; Text devices keep their `text = ...` result. The test suite
proves the XOR example end to end this way: `00→0 01→1 10→1 11→0`
(`net_output` is ×100, so 99 ≈ 1 and −2 ≈ 0) and the Text device reads
`XOR(1,0) = 1   [net 99]` — no browser needed.

### Verification the executors do

| Action | How success is decided |
|---|---|
| `place` | the spot is clicked before (skip if something is already there) and after (a device sidebar must open) |
| `property` | device re-opened; name, type, default **and scope** read back from the sidebar |
| `button` / `trigger` | device re-opened; channel chip read back; then each option is set and read back |
| `text` | content typed with real key events (synthetic `.value` writes do not persist in Gimkit), device re-opened, text read back |
| `option` | label located, control driven, device re-opened, value read back (Yes/No ↔ true/false) |
| `blocks` | the block code for the event exists (selected or created), statement count matches, no unsupported constructs, and the chain is reachable from the event hat — floating blocks are dead code and count as failure |

Failures are retried (`retries`, default 2) before they are reported. Before the
first configure-phase action the runner re-opens the first device it placed; if
nothing is there the map was panned and the run aborts instead of configuring
the wrong devices.

### `gkc probe` — when the live editor disagrees

Nothing in the block-code flow or option labels could be verified live while this
was written, so every guess fails loudly. `gkc probe --at r0c0 [--on channel]`
opens that device and writes `build-output/probe.json` with: every Blockly block
type (inputs, fields, dropdown options, rendered text), the Blocks-tab texts (the
block-code list / create button / event names) and the device panel's option
labels. Correct `IN_PAGE_BUILDER`'s candidate lists, `DEVICE_OPTIONS`, or
`block-code.mjs` from that data.

## Programmatic API

```js
import { GkcMap } from "./src/index.mjs";

const map = await GkcMap.open({ hostUrl: process.env.GKC_HOST_URL });
await map.place("property", "clicks", "r0c0");
await map.place("button", "Click Me", "r0c1");
await map.place("trigger", "Count", "r0c2");
await map.property("clicks", 0);
await map.button("Click Me", "clicked");
await map.trigger("Count", "clicked");
await map.blocks("Count", "property clicks = {clicks} + 1");           // replaces existing code
await map.blocks("Count", "property total = {total} + 1", { append: true });
await map.option("Count", "Trigger Delay", 1);                          // any sidebar option by label
await map.place("text", "Score: ?", "r1c0");
await map.text("Score: ?");
await map.blocks("Score: ?", 'text = "Score: " + {clicks}', { on: "clicked" }); // Set Text on the channel event
map.report();               // → build-output/run-report.json (ok / failed / skipped / warnings)
await map.close();          // waits for Gimkit's autosave first

// Offline plan (no browser):
await GkcMap.dryRun().run(scriptText);
// Static check only: { errors, warnings }
await GkcMap.dryRun().check(scriptText);
// Offline simulation with Gimkit semantics:
const sim = GkcMap.simulate(scriptText, { set: { input1: 1 }, press: ["Run NN"] });
sim.get("net_output"); sim.text("XOR = ?"); sim.snapshot().warnings;
// Options: GkcMap.open({ ..., stopOnFail: true, strict: true }); map.run(src, { force: true })
```

## JSON map spec

```json
{
  "layout": { "origin": [120, 120], "gap": [110, 80] },
  "devices": [
    { "type": "property", "name": "clicks", "at": "r0c0", "value": 0 },
    { "type": "button",   "name": "Click Me", "at": "r0c1", "transmits": "clicked" },
    { "type": "trigger",  "name": "Count", "at": "r0c2", "receives": "clicked",
      "blocks": "property clicks = {clicks} + 1",
      "options": { "Visible In-Game": false, "Trigger Delay": 1 } },
    { "type": "text", "text": "Score: ?", "at": "r1c0",
      "on": "clicked", "blocks": "text = \"Score: \" + {clicks}" }
  ]
}
```

`gkc run map.json` expands it in the right order: place all → properties/text →
channels → options → blocks. Optional per-device keys: `propertyType` (Number |
Text | True/False), `scope` (global | player | team), `appendBlocks: true`,
`on: "<channel>"` / `when: "triggered"` (block-code event), `options: { "Label":
value }`; `blocks` may be a string or an array of lines. `validateSpec` rejects
non-integer defaults, shared positions, duplicate names, malformed
`on`/`when`/`options` and block programs that do not parse.

## Live session requirements

- Chrome with the map open in **HOST** or **edit** mode, either attached via
  `GKC_CDP_PORT=9222` (start Chrome with `--remote-debugging-port=9222`) or
  launched from a saved profile (`GKC_PROFILE_DIR`; the SDK auto-detects the
  NN-builder / debug-Chrome profiles).
- Login: an existing session, or `GKC_EMAIL` + `GKC_PASSWORD` for unattended
  email login (Google OAuth is blocked in automation).
- Keep the editor at 0.3 zoom (`GKC_ZOOM`) and do not pan between `place` and
  configure lines — coordinates are screen-space.

## Env reference

| Var | Purpose |
|---|---|
| `GKC_HOST_URL` | map to open (`https://www.gimkit.com/host?id=…`) |
| `GKC_CDP_PORT` / `GKC_CDP_URL` | attach to a running debug Chrome |
| `GKC_PROFILE_DIR` | persistent Chrome profile to launch |
| `GKC_EMAIL`, `GKC_PASSWORD` | unattended email login |
| `GKC_AUTO=1` | never wait for ENTER |
| `GKC_HEADLESS=1` | headless launch (profile mode only) |
| `GKC_ZOOM` | editor zoom the coordinates assume (default 0.3) |
| `GKC_OUTPUT_DIR` | where `build.log`, `run-report.json`, screenshots go |
| `GKC_CFG_VERBOSE=1` | per-field configure detail in the terminal |

## Adding a new verb

1. `src/actions.mjs`: add a `stepsFor.<kind>` recipe (what dry-run prints) and
   an `executors.<kind>` that calls the editor primitives.
2. `src/commands.mjs`: add a regex → `{ kind, ... }` in `parseCommand`.
3. `src/index.mjs`: expose a method on `GkcMap`.
4. `test/run-tests.mjs`: one parse test + one dry-run test.

## Adding a block construct

1. `src/blocks.mjs` parser: produce a new AST node (`["kind", ...children]` or
   `{ op: "kind", ... }`).
2. `lintProgram` / `exprType` / `estimateBlockCount` / `formatProgram`: teach
   them the node (the fuzz test checks format → parse round-trips).
3. `IN_PAGE_BUILDER`: add a `T.<key>` discovery entry and a `buildExpr` /
   `buildStatements` branch; use `need(key, label)` so a missing block type is
   reported as unsupported.
4. `src/simulate.mjs`: evaluate it.
5. `test/run-tests.mjs`: add it to `STD_DEFS` in the mock-Blockly harness and
   assert the built block type / fields.

## License

[MIT](LICENSE) — free to use, modify, and redistribute. Not affiliated with
Gimkit; it drives the regular Creative editor UI through your own logged-in
browser, so Gimkit's terms of service apply to whatever you build with it.
