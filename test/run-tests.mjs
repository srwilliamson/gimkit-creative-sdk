/**
 * Offline test suite — no browser needed. Run: npm test
 * Covers: expression/program parsing, command parsing, layout resolution,
 * JSON spec expansion, dry-run of both example scripts, in-page builder syntax.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import assert from "assert/strict";
import { setQuiet } from "../src/editor/config.mjs";
import {
  GkcMap,
  Layout,
  parseScript,
  parseCommand,
  parseProgram,
  parseExpression,
  formatProgram,
  estimateBlockCount,
  specToActions,
  validateSpec,
  normalizeDeviceType,
  describeAction,
  lintProgram,
  retypeProgram,
  simulate,
  DEVICE_TYPES,
} from "../src/index.mjs";
import { IN_PAGE_BUILDER } from "../src/blocks.mjs";
import { DEVICE_OPTIONS } from "../src/commands.mjs";
import { optionValueMatches } from "../src/editor/device-options.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
setQuiet(true);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

console.log("blocks.mjs — expressions & programs");
await test("parses arithmetic with props, vars, numbers", () => {
  const e = parseExpression("{bias1} + A * {weight1-1}");
  assert.deepEqual(e, ["+", ["prop", "bias1"], ["*", ["var", "A"], ["prop", "weight1-1"]]]);
});
await test("precedence: * before +, parentheses, unary minus", () => {
  assert.deepEqual(parseExpression("1 + 2 * 3"), ["+", ["num", 1], ["*", ["num", 2], ["num", 3]]]);
  assert.deepEqual(parseExpression("(1 + 2) * 3"), ["*", ["+", ["num", 1], ["num", 2]], ["num", 3]]);
  assert.deepEqual(parseExpression("-5"), ["num", -5]);
});
await test("round() and comparisons", () => {
  assert.deepEqual(parseExpression("round(A / 100)"), ["round", ["/", ["var", "A"], ["num", 100]]]);
  assert.deepEqual(parseExpression("H1 < 0"), ["cmp", "<", ["var", "H1"], ["num", 0]]);
});
await test("prop() function form", () => {
  assert.deepEqual(parseExpression('prop("net_output")'), ["prop", "net_output"]);
});
await test("statements: set / property / relu / if-then / if-block / broadcast", () => {
  const p = parseProgram(`
    set A = {input1}
    property output1 = A
    set H1 = {h1} - 3
    relu H1
    if A < 0 then set A = 0
    if A > 1 { set A = 1; property flag = 1 }
    broadcast "done"
  `);
  assert.equal(p.statements.length, 7);
  assert.equal(p.statements[0].op, "setVar");
  assert.equal(p.statements[1].op, "setProp");
  assert.equal(p.statements[3].op, "if");
  assert.deepEqual(p.statements[3].cond, ["cmp", "<", ["var", "H1"], ["num", 0]]);
  assert.equal(p.statements[5].then.length, 2);
  assert.equal(p.statements[6].op, "broadcast");
});
await test("property = round(...) becomes setPropRound; round(...) + 1 does NOT", () => {
  const p = parseProgram("set H1 = 1\nproperty net = round({bias3} + H1 / 100)");
  assert.equal(p.statements[1].op, "setPropRound");
  const q = parseProgram("set A = 1\nproperty x = round(A) + 1");
  assert.equal(q.statements[1].op, "setProp");
  assert.deepEqual(q.statements[1].expr, ["+", ["round", ["var", "A"]], ["num", 1]]);
});

console.log("blocks.mjs — parser regressions");
await test("if-then with a {prop} on the right-hand side", () => {
  const p = parseProgram("set A = {a}\nif A > 1 then set B = {a}");
  assert.equal(p.statements[1].op, "if");
  assert.deepEqual(p.statements[1].then[0].expr, ["prop", "a"]);
});
await test("if {prop} in the condition, block body, else / else-if chains, else on next line", () => {
  const p = parseProgram(`
    if {score} > 10 {
      property tier = 3
    } else if {score} > 5 {
      property tier = 2
    }
    else {
      property tier = 1
    }
  `);
  assert.equal(p.statements.length, 1);
  const s = p.statements[0];
  assert.deepEqual(s.cond, ["cmp", ">", ["prop", "score"], ["num", 10]]);
  assert.equal(s.else[0].op, "if");
  assert.equal(s.else[0].else[0].op, "setProp");
});
await test("if-then ... else <stmt>, nested then, empty else body", () => {
  const p = parseProgram("set A = 1\nset B = 1\nif A > 1 then set B = 2 else set B = 3\nif A > 1 then if B > 1 then set B = 4\nif A > 0 { set B = 1 } else { }");
  assert.equal(p.statements[2].else[0].expr[1], 3);
  assert.equal(p.statements[3].then[0].op, "if");
  assert.deepEqual(p.statements[4].else, []);
});
await test("{relu H1} body reinterpreted as a statement block, not a property reference", () => {
  const p = parseProgram("set H1 = -2\nif H1 < 0 {relu H1}");
  assert.equal(p.statements[1].then[0].op, "if");
});
await test("# comments, // comments and blank lines inside programs", () => {
  const p = parseProgram("set A = 1\n# full line\nset B = 2 // trailing\n\n  // indented\nset C = 3");
  assert.equal(p.statements.length, 3);
});
await test("string literals are text blocks, never property lookups", () => {
  assert.deepEqual(parseExpression('"hello"'), ["text", "hello"]);
  // `+` with a text operand is a text join; every other arithmetic op on text is an error
  assert.deepEqual(parseExpression('"x" + 1'), ["join", ["text", "x"], ["num", 1]]);
  assert.throws(() => parseProgram('set A = "x" * 2'), /Text "x" used in arithmetic/);
  assert.throws(() => parseProgram('set A = "x" - 2'), /Text "x" used in arithmetic/);
});
await test("max()/min() are rejected with an if-based suggestion", () => {
  assert.throws(() => parseExpression("max(A, 0)"), /has no Gimkit block.*relu/);
});
await test("bad numbers, unknown functions, unclosed strings and braces fail loudly", () => {
  assert.throws(() => parseExpression("1.2.3"), /Bad number/);
  assert.throws(() => parseExpression("frob(1)"), /Unknown function/);
  assert.throws(() => parseProgram('set A = "oops'), /Unclosed string/);
  assert.throws(() => parseProgram("set A = 1\nif A > 1 {\n set B = 2"), /Missing closing "}"/);
  assert.throws(() => parseProgram("set A = 1 }"), /no matching "{"/);
});
await test("lint: a variable read before it is set points at the {property} spelling", () => {
  assert.throws(() => parseProgram("set Z = bias1 + 2"), /did you mean the property \{bias1\}/);
  assert.throws(() => parseProgram("set Z = {bias1} + A * weight1-1"), /weight1/);
  // declaring the variable silences it
  assert.equal(parseProgram("var X\nset Y = X + 1").statements.length, 2);
});
await test("lint: division by zero, statements glued together, keyword misuse", () => {
  assert.throws(() => parseProgram("set A = 1 / 0"), /Division by zero/);
  assert.throws(() => parseProgram("set A = 1 set B = 2"), /Unexpected "set" after statement/);
  assert.throws(() => parseProgram("else { set A = 1 }"), /"else" without/);
  assert.throws(() => parseProgram("set if = 1"), /keyword/);
});
await test("property names with dashes/spaces in Set Property statements", () => {
  const p = parseProgram("set A = 1\nproperty weight1-1 = A\nproperty {net output} = A\nproperty \"Some Prop\" = A");
  assert.deepEqual(p.statements.slice(1).map((s) => s.prop), ["weight1-1", "net output", "Some Prop"]);
  assert.match(formatProgram(p), /property \{weight1-1\} = A/);
});
await test("lint warns when a program would exceed the block cap", () => {
  const big = ["set A = 1", ...Array.from({ length: 40 }, (_, i) => `property p${i} = A + ${i}`)].join("\n");
  const { warnings } = lintProgram(parseProgram(big));
  assert.ok(warnings.some((w) => /blocks; Gimkit refuses more than/.test(w)));
});
await test("formatProgram round-trips", () => {
  const src = "set A = {input1}\nproperty output1 = A";
  const p = parseProgram(src);
  const again = parseProgram(formatProgram(p));
  assert.deepEqual(again, p);
});
await test("estimateBlockCount stays under Gimkit cap for XOR forward pass", () => {
  const fwd = fs.readFileSync(path.join(ROOT, "examples/xor-nn.gkc"), "utf8").match(/blocks "Forward Pass" \{([\s\S]*?)\n\}/)[1];
  const n = estimateBlockCount(parseProgram(fwd));
  assert.ok(n > 30 && n < 75, `expected 30<n<75, got ${n}`);
});
await test("in-page builder source is valid JS", () => {
  // eslint-disable-next-line no-new-func
  new Function(IN_PAGE_BUILDER + "\nreturn typeof gkcBuild;");
});

console.log("commands.mjs — command language");
await test("place with quoted name and grid position", () => {
  const a = parseCommand('place trigger "Forward Pass" at r6c0');
  assert.equal(a.kind, "place");
  assert.equal(a.deviceType, "Trigger");
  assert.equal(a.name, "Forward Pass");
  assert.equal(a.at, "r6c0");
});
await test("place with bare name and x,y", () => {
  const a = parseCommand("place property input1 at 400,300");
  assert.equal(a.deviceType, "Property");
  assert.equal(a.name, "input1");
  assert.equal(a.at, "400,300");
});
await test("property with negative value, no position", () => {
  const a = parseCommand("property weight1-1 = -80");
  assert.equal(a.kind, "property");
  assert.equal(a.name, "weight1-1");
  assert.equal(a.default, -80);
  assert.equal(a.propertyType, "Number");
  assert.equal(a.at, null);
});
await test("property text value infers Text type", () => {
  const a = parseCommand('property title = "hello" at r0c0');
  assert.equal(a.propertyType, "Text");
  assert.equal(a.default, "hello");
});
await test("button transmits / trigger receives", () => {
  const b = parseCommand('button "Run NN" transmits nn-forward at r7c2');
  assert.deepEqual([b.kind, b.name, b.channel, b.at], ["button", "Run NN", "nn-forward", "r7c2"]);
  const t = parseCommand('trigger "Forward Pass" receives nn-forward');
  assert.deepEqual([t.kind, t.name, t.channel, t.at], ["trigger", "Forward Pass", "nn-forward", null]);
});
await test("blocks one-liner and block form", () => {
  const one = parseCommand('blocks "Set input1=1": property input1 = 1');
  assert.equal(one.kind, "blocks");
  assert.equal(one.name, "Set input1=1");
  assert.equal(parseProgram(one.program).statements.length, 1);
  const multi = parseCommand('blocks "FP" at r6c0 {\n set A = {input1}\n property output1 = A\n}');
  assert.equal(multi.at, "r6c0");
  assert.equal(parseProgram(multi.program).statements.length, 2);
});
await test("misc: wait / click / press / screenshot / layout", () => {
  assert.deepEqual(parseCommand("wait 2s"), { kind: "wait", ms: 2000 });
  assert.deepEqual(parseCommand("click 10,20"), { kind: "click", x: 10, y: 20 });
  assert.deepEqual(parseCommand("press E"), { kind: "press", key: "e" });
  assert.equal(parseCommand("screenshot done").name, "done");
  const l = parseCommand("layout origin 72,72 gap 95,68");
  assert.deepEqual([l.originX, l.originY, l.gapX, l.gapY], [72, 72, 95, 68]);
});
await test("unknown command throws a helpful error", () => {
  assert.throws(() => parseCommand("frobnicate the map"), /Unknown command/);
});

console.log("commands.mjs — parser regressions");
await test("multi-word device types without a name (item granter, wire repeater)", () => {
  const a = parseCommand("place item granter at r0c0");
  assert.equal(a.deviceType, "Item Granter");
  assert.equal(a.name, undefined);
  const b = parseCommand('place wire repeater "WR" at r0c1');
  assert.deepEqual([b.deviceType, b.name], ["Wire Repeater", "WR"]);
});
await test("unquoted multi-word device names are rejected with the quoted form suggested", () => {
  assert.throws(() => parseCommand("place trigger Forward Pass at r0c0"), /must be quoted.*"Forward Pass"/);
  assert.throws(() => parseCommand("property player score = 0 at r0c0"), /must be quoted/);
});
await test('a text containing " at " keeps its content intact', () => {
  assert.equal(parseCommand('place text "Look at me" at r0c0').name, "Look at me");
  assert.equal(parseCommand('text "Meet at 5" at r0c0').text, "Meet at 5");
});
await test("blocks: replace by default, append keyword, name containing 'clear' is not a flag", () => {
  assert.equal(parseCommand('blocks "Clear Score": property s = 0').clear, true);
  assert.equal(parseCommand('blocks "T" append { property s = 0 }').clear, false);
  assert.equal(parseCommand('blocks "T" at r1c1 append: property s = 0').clear, false);
  assert.equal(parseCommand('blocks "T" replace { property s = 0 }').clear, true);
});
await test("blocks programs are parsed eagerly so a typo fails before anything is clicked", () => {
  assert.throws(() => parseCommand('blocks "T": frobnicate x'), /blocks "T": Cannot parse block statement/);
  assert.throws(() => parseCommand('blocks "T" { }'), /empty program/);
  const ok = parseCommand('blocks "T": property s = 1');
  assert.equal(ok.ast.statements.length, 1);
  assert.deepEqual(ok.warnings, []);
});
await test("property defaults must be integers; type/scope validated and consistent", () => {
  assert.throws(() => parseCommand("property w = 0.82 at r0c0"), /not an integer.*82/);
  assert.throws(() => parseCommand("property t = 5 type Text at r0c0"), /is Number but type Text/);
  assert.throws(() => parseCommand("property t = 5 scope everyone at r0c0"), /Unknown property scope/);
  assert.throws(() => parseCommand("property t = 5 type Fancy at r0c0"), /Unknown property type/);
  const a = parseCommand('property t = "hi" type text scope Player at r0c0');
  assert.deepEqual([a.propertyType, a.scope], ["Text", "player"]);
  const b = parseCommand("property flag = true at r0c0");
  assert.deepEqual([b.propertyType, b.default], ["True/False", true]);
});
await test("property with an expression hints at blocks", () => {
  assert.throws(() => parseCommand("property x = {a} + 1 at r0c0"), /use blocks/);
});
await test("press maps friendly key names onto Playwright names", () => {
  assert.equal(parseCommand("press ctrl+z").key, "Control+z");
  assert.equal(parseCommand("press esc").key, "Escape");
});
await test("parseScript reports the line number and rejects an unclosed blocks body", () => {
  assert.throws(() => parseScript('place trigger "T" at r0c0\n\nproperty w = 0.5 at r1c0'), /Error: Line 3:/);
  assert.throws(() => parseScript('blocks "T" {\n set A = 1\n'), /unclosed "\{"/);
});
await test("// inside a quoted string is not a comment", () => {
  const [a] = parseScript('text "see http://x.y/z" at r0c0');
  assert.equal(a.text, "see http://x.y/z");
});
await test("parseScript keeps multi-line blocks together and skips comments", () => {
  const actions = parseScript(fs.readFileSync(path.join(ROOT, "examples/xor-nn.gkc"), "utf8"));
  const kinds = actions.reduce((m, a) => ((m[a.kind] = (m[a.kind] || 0) + 1), m), {});
  assert.equal(kinds.place, 27);
  assert.equal(kinds.text, 3);
  assert.equal(kinds.property, 14);
  assert.equal(kinds.button, 5);
  assert.equal(kinds.trigger, 5);
  assert.equal(kinds.blocks, 6);
  assert.equal(kinds.layout, 1);
  const display = actions.find((a) => a.kind === "blocks" && a.event);
  assert.deepEqual(display.event, { kind: "channel", channel: "nn-done" });
});

console.log("layout.mjs");
await test("grid → coords, named lookup, string specs", () => {
  const L = new Layout({ originX: 72, originY: 72, gapX: 95, gapY: 68 });
  assert.deepEqual(L.grid(1, 2), { x: 262, y: 140 });
  assert.deepEqual(L.resolve("r1c2"), { x: 262, y: 140 });
  assert.deepEqual(L.resolve("400,300"), { x: 400, y: 300 });
  L.remember("Run NN", { x: 1, y: 2 }, "Button");
  assert.deepEqual(L.resolve('"Run NN"'), { x: 1, y: 2 });
  assert.deepEqual(L.resolve("run nn"), { x: 1, y: 2 });
  assert.equal(L.resolve("nope"), null);
});
await test("fitToViewport shrinks gaps to fit", () => {
  const L = new Layout().fitToViewport({ width: 1200, height: 700 }, 10, 3);
  assert.ok(L.gapY * 9 + L.originY <= 700 - 105 + 1);
});

console.log("spec.mjs");
await test("JSON spec expands in phases: place → property/text → channels → blocks", () => {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "examples/counter.map.json"), "utf8"));
  assert.deepEqual(validateSpec(spec), []);
  const actions = specToActions(spec);
  const kinds = actions.map((a) => a.kind);
  assert.deepEqual(kinds, ["layout", "place", "place", "place", "place", "property", "text", "button", "trigger", "blocks"]);
});
await test("validateSpec catches missing position and duplicate names", () => {
  const errs = validateSpec({ devices: [{ type: "property", name: "a" }, { type: "button", name: "a", at: "r0c0" }] });
  assert.ok(errs.some((e) => /no position/.test(e)));
  assert.ok(errs.some((e) => /duplicate/.test(e)));
});

console.log("actions.mjs");
await test("device type normalization", () => {
  assert.equal(normalizeDeviceType("trigger"), "Trigger");
  assert.equal(normalizeDeviceType("item granter"), "Item Granter");
  assert.equal(normalizeDeviceType("Zone"), "Zone");
  assert.equal(normalizeDeviceType("mystery thing"), "Mystery Thing");
});
await test("describeAction expands place into the primitive click recipe", () => {
  const steps = describeAction({ kind: "place", deviceType: "Trigger", x: 400, y: 300 });
  assert.ok(steps.some((s) => /Press E/.test(s)));
  assert.ok(steps.some((s) => /Devices/.test(s)));
  assert.ok(steps.some((s) => /\(400, 300\)/.test(s)));
});

console.log("runner (dry-run, end to end)");
await test("hello.gkc dry-run: all actions resolve and succeed", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const report = await map.run(fs.readFileSync(path.join(ROOT, "examples/hello.gkc"), "utf8"));
  assert.equal(report.failed.length, 0, JSON.stringify(report.failed));
  assert.equal(report.total, 8);
  assert.ok(report.devices.some((d) => d.name === "click me"));
});
await test("xor-nn.gkc dry-run: 62 actions, positions resolved by name", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const report = await map.run(fs.readFileSync(path.join(ROOT, "examples/xor-nn.gkc"), "utf8"));
  assert.equal(report.failed.length, 0, JSON.stringify(report.failed));
  assert.equal(report.total, 62);
  const fp = map.runner.results.find((r) => r.action.kind === "blocks" && r.action.name === "Forward Pass");
  assert.deepEqual({ x: fp.action.x, y: fp.action.y }, { x: 72, y: 480 });
});
await test("counter.map.json dry-run via runSpec", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "examples/counter.map.json"), "utf8"));
  const report = await map.runSpec(spec);
  assert.equal(report.failed.length, 0);
});
await test("missing position reports a clear failure instead of clicking blindly", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const r = await map.do('trigger "Ghost" receives x');
  assert.equal(r.ok, false);
  assert.match(r.detail, /no position/);
});
await test("programmatic verbs", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  await map.place("trigger", "T1", "r0c0");
  await map.trigger("T1", "go");
  const r = await map.blocks("T1", "property hits = {hits} + 1");
  assert.equal(r.ok, true);
  assert.equal(r.action.clear, true);
  const r2 = await map.blocks("T1", "property hits = 0", { append: true });
  assert.equal(r2.action.clear, false);
  assert.equal(map.report().failed.length, 0);
});

console.log("runner.validate — whole-script static checks");
await test("positions outside the clickable map area are errors (sidebar swallows clicks)", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const { errors } = await map.check('place trigger "T" at 1400,300\nplace trigger "U" at 100,10');
  assert.equal(errors.length, 2);
  assert.match(errors[0], /outside the clickable map area/);
});
await test("duplicate names, two devices on one spot, wrong device kind", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const { errors } = await map.check(`
    place trigger "T" at r0c0
    place button "T" at r0c1
    place property p at r0c0
    trigger "p" receives go
  `);
  assert.ok(errors.some((e) => /duplicate device name "T"/.test(e)));
  assert.ok(errors.some((e) => /already placed at/.test(e)));
  assert.ok(errors.some((e) => /placed as a Property, not a Trigger/.test(e)));
});
await test("block programs referencing properties the script never creates warn", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const { errors, warnings } = await map.check('place trigger "T" at r0c0\nblocks "T": property hits = {hits} + 1');
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /uses property \{hits\} but no "property hits/.test(w)));
});
await test("run() refuses to execute a script with validation errors (unless forced)", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const report = await map.run('place trigger "T" at r0c0\ntrigger "Ghost" receives x');
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].detail, /no position/);
  assert.equal(report.results.length, 1, "nothing else should have run");
  const forced = await GkcMap.dryRun({ verbose: false }).run('place trigger "T" at r0c0\ntrigger "Ghost" receives x', { force: true });
  assert.equal(forced.total, 2);
});
await test("strict mode turns warnings into blocking errors", async () => {
  const map = GkcMap.dryRun({ verbose: false, strict: true });
  const report = await map.run('place trigger "T" at r0c0\nblocks "T": property hits = {hits} + 1');
  assert.equal(report.results.length, 1);
  assert.match(report.failed[0].detail, /uses property \{hits\}/);
});
await test("the xor example passes validation with no errors", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const { errors, warnings } = await map.check(fs.readFileSync(path.join(ROOT, "examples/xor-nn.gkc"), "utf8"));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
await test("stopOnFail skips the rest after the first failure", async () => {
  const map = GkcMap.dryRun({ verbose: false, stopOnFail: true });
  await map.do('trigger "Ghost" receives x');
  const r = await map.do('place trigger "T" at r0c0');
  assert.equal(r.skipped, true);
});

// =====================================================================================
// Pass 2 — parser fixes, vocabulary, events, options, cross-script lints, simulator,
// mock-Blockly builder harness.
// =====================================================================================

console.log("blocks.mjs — pass 2 parser fixes");
await test("string escapes: \\\" and \\n inside literals", () => {
  assert.deepEqual(parseExpression('"say \\"hi\\""'), ["text", 'say "hi"']);
  assert.deepEqual(parseExpression("'a\\nb'"), ["text", "a\nb"]);
});
await test("{prop} accepts any Gimkit property name: %, unicode, apostrophes, spaces", () => {
  assert.deepEqual(parseExpression("{Score ✓} + {Player's total} + {50% off}"), ["+", ["+", ["prop", "Score ✓"], ["prop", "Player's total"]], ["prop", "50% off"]]);
  assert.deepEqual(parseProgram("property {Score ✓} = 1").statements[0], { op: "setProp", prop: "Score ✓", expr: ["num", 1] });
});
await test("% is modulo (term precedence), true/false are literals, not variables", () => {
  assert.deepEqual(parseExpression("A + B % 2"), ["+", ["var", "A"], ["%", ["var", "B"], ["num", 2]]]);
  assert.deepEqual(parseExpression("true"), ["bool", true]);
  const p = parseProgram("set Done = false\nif Done == true { set X = 1 }");
  assert.equal(p.statements.length, 2);
  assert.throws(() => parseProgram("set A = 1 % 0"), /Modulo by zero/);
});
await test("chained comparison suggests 'and'", () => {
  assert.throws(() => parseExpression("0 < A < 5"), /Chained comparisons.*a < b and b < c/);
});
await test("and / or / not precedence and symbols", () => {
  assert.deepEqual(parseExpression("not A > 1 and B == 2 or false"), ["or", ["and", ["not", ["cmp", ">", ["var", "A"], ["num", 1]]], ["cmp", "==", ["var", "B"], ["num", 2]]], ["bool", false]]);
  assert.deepEqual(parseExpression("A > 1 && !(B < 2) || C == 3"), ["or", ["and", ["cmp", ">", ["var", "A"], ["num", 1]], ["not", ["cmp", "<", ["var", "B"], ["num", 2]]]], ["cmp", "==", ["var", "C"], ["num", 3]]]);
});
await test("math/text/player vocabulary parses to dedicated nodes", () => {
  assert.deepEqual(parseExpression("random(1, 6)"), ["random", ["num", 1], ["num", 6]]);
  assert.deepEqual(parseExpression("floor(A / 2) + ceil(B) + abs(C) + sqrt(D)"), ["+", ["+", ["+", ["floor", ["/", ["var", "A"], ["num", 2]]], ["ceil", ["var", "B"]]], ["abs", ["var", "C"]]], ["sqrt", ["var", "D"]]]);
  assert.deepEqual(parseExpression("text(5)"), ["tostr", ["num", 5]]);
  assert.deepEqual(parseExpression('number("12")'), ["tonum", ["text", "12"]]);
  assert.deepEqual(parseExpression('len("abc")'), ["len", ["text", "abc"]]);
  assert.deepEqual(parseExpression("player.name"), ["player", "name"]);
  assert.deepEqual(parseExpression("player.team + player.score"), ["+", ["player", "team"], ["player", "score"]]);
  assert.throws(() => parseExpression("player.hat"), /Unknown player field/);
  assert.throws(() => parseExpression("random(1)"), /exactly 2 arguments/);
});
await test("`+` becomes a text join whenever an operand is text; stays arithmetic otherwise", () => {
  assert.deepEqual(parseExpression('"XOR = " + {net}'), ["join", ["text", "XOR = "], ["prop", "net"]]);
  assert.deepEqual(parseExpression('"a" + (1 + 2)'), ["join", ["text", "a"], ["+", ["num", 1], ["num", 2]]]);
  assert.deepEqual(parseExpression("text(1) + 2"), ["join", ["tostr", ["num", 1]], ["num", 2]]);
  assert.deepEqual(parseExpression("player.name + 1"), ["join", ["player", "name"], ["num", 1]]);
  assert.deepEqual(parseExpression("{a} + {b}"), ["+", ["prop", "a"], ["prop", "b"]]);
});
await test("text = ... (Set Text) statement, set text = ..., settext", () => {
  const p = parseProgram('text = "XOR = " + {net}\nset text = 5\nsettext "hi"');
  assert.deepEqual(p.statements[0], { op: "setText", expr: ["join", ["text", "XOR = "], ["prop", "net"]] });
  assert.deepEqual(p.statements[1], { op: "setText", expr: ["num", 5] });
  assert.deepEqual(p.statements[2], { op: "setText", expr: ["text", "hi"] });
  assert.equal(lintProgram(p).setsText, true);
  assert.match(formatProgram(p), /^text = \("XOR = " \+ \{net\}\)/);
});
await test('generic block "<visible name>" statement with positional and keyed args', () => {
  const p = parseProgram('block "Add Activity Feed Item For All Players" "Hello", text = {n} + 1\nblock "End Game"');
  assert.deepEqual(p.statements[0], { op: "block", name: "Add Activity Feed Item For All Players", args: [{ key: undefined, expr: ["text", "Hello"] }, { key: "text", expr: ["+", ["prop", "n"], ["num", 1]] }] });
  assert.deepEqual(p.statements[1], { op: "block", name: "End Game", args: [] });
  assert.throws(() => parseProgram("block EndGame"), /visible name in quotes/);
  assert.deepEqual(parseProgram(formatProgram(p)), p);
});
await test("lint: type errors across text/number/bool", () => {
  assert.throws(() => parseProgram('if 1 == "1" { set B = 2 }'), /Comparing number with text/);
  assert.throws(() => parseProgram('set A = 1\nif A + 1 == "1" { set B = 2 }'), /Comparing number with text/);
  assert.throws(() => parseProgram('set A = "x" < 2'), /Comparing text with number|Ordering comparison on text/);
  assert.throws(() => parseProgram("set A = 1 < 2 and 3"), /and needs true\/false operands/);
  assert.throws(() => parseProgram("set A = not 5"), /not needs a true\/false operand/);
  assert.throws(() => parseProgram("set A = true + 1"), /true\/false value is used in arithmetic/);
  assert.throws(() => parseProgram("property p = round(\"x\")"), /Text "x" used in arithmetic|round\(\) needs a number/);
});
await test("lint with property types: wrong-type assignment, Text property in arithmetic, `+` on Text property → join", () => {
  const propTypes = new Map([["label", "Text"], ["count", "Number"]]);
  const bad = parseProgram('property label = 5', { lint: false });
  assert.match(lintProgram(bad, { propTypes }).errors.join("\n"), /Property "label" is Text but .* assigns a number/);
  const bad2 = parseProgram("set A = {label} * 2", { lint: false });
  assert.match(lintProgram(bad2, { propTypes }).errors.join("\n"), /Text \{label\} used in arithmetic/);
  const typed = retypeProgram(parseProgram("set A = {label} + {count}", { lint: false }), propTypes);
  assert.deepEqual(typed.statements[0].expr, ["join", ["prop", "label"], ["prop", "count"]]);
  const cmp = parseProgram('set A = {count} == "x"', { lint: false });
  assert.match(lintProgram(cmp, { propTypes }).errors.join("\n"), /Comparing number with text/);
  assert.deepEqual(lintProgram(parseProgram("property count = 1\nproperty label = \"x\""), { propTypes }).errors, []);
});
await test("lint warns on integers beyond 2^53", () => {
  const { warnings } = lintProgram(parseProgram("property p = 9007199254740993"));
  assert.ok(warnings.some((w) => /beyond Gimkit's exact integer range/.test(w)));
});
await test("estimateBlockCount covers the new nodes", () => {
  const n = (src) => estimateBlockCount(parseProgram(src));
  assert.equal(n('text = "a" + {b}'), 4); // set_text + join + text + getProp
  assert.equal(n("set A = random(1, 6) % 2"), 6); // set + modulo + random + 1 + 6 + 2
  assert.equal(n("set A = not true"), 3);
  assert.equal(n("set A = player.name"), 2);
  assert.equal(n('block "End Game"'), 1);
  assert.equal(n('block "Feed" "hi", 2'), 3);
});
await test("expression round-trip fuzz: generate → format → parse → deep-equal", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const genNum = (depth) => {
    if (depth <= 0 || rnd() < 0.3) return pick([["num", Math.floor(rnd() * 200) - 100], ["var", pick(["A", "B"])], ["prop", pick(["input1", "weight1-1", "Score ✓"])]]);
    const r = rnd();
    if (r < 0.55) return [pick(["+", "-", "*", "/", "%"]), genNum(depth - 1), genNum(depth - 1)];
    if (r < 0.75) return [pick(["round", "floor", "ceil", "abs", "sqrt"]), genNum(depth - 1)];
    if (r < 0.85) return ["random", genNum(depth - 1), genNum(depth - 1)];
    if (r < 0.92) return ["len", ["text", pick(["a", "b c", 'q"uote'])]];
    return ["player", pick(["team", "score"])];
  };
  const genBool = (depth) => {
    if (depth <= 0 || rnd() < 0.4) return ["cmp", pick(["<", ">", "<=", ">=", "==", "!="]), genNum(1), genNum(1)];
    const r = rnd();
    if (r < 0.4) return ["and", genBool(depth - 1), genBool(depth - 1)];
    if (r < 0.8) return ["or", genBool(depth - 1), genBool(depth - 1)];
    return ["not", genBool(depth - 1)];
  };
  const noDivZero = (e) => {
    if (!Array.isArray(e)) return e;
    if ((e[0] === "/" || e[0] === "%") && Array.isArray(e[2]) && e[2][0] === "num" && e[2][1] === 0) return [e[0], noDivZero(e[1]), ["num", 7]];
    if (e[0] === "num" || e[0] === "var" || e[0] === "prop" || e[0] === "player" || e[0] === "text") return e;
    return [e[0], ...e.slice(1).map((c) => (Array.isArray(c) ? noDivZero(c) : c))];
  };
  for (let i = 0; i < 300; i += 1) {
    const expr = noDivZero(i % 3 === 0 ? genBool(3) : genNum(4));
    const prog = { statements: [{ op: "declare", name: "A" }, { op: "declare", name: "B" }, { op: "setVar", name: "X", expr }] };
    const text = formatProgram(prog);
    let again;
    try {
      again = parseProgram(text);
    } catch (err) {
      throw new Error(`${err.message}\n  from: ${text}`);
    }
    assert.deepEqual(again.statements[2].expr, expr, `round-trip mismatch for: ${text}`);
  }
});

console.log("commands.mjs — pass 2 parser fixes");
await test("braces inside quotes do not open a blocks body", () => {
  const actions = parseScript('text "a { b" at r0c0\nplace trigger "T" at r1c0\ntext "c } d" at r2c0');
  assert.deepEqual(actions.map((a) => a.kind), ["text", "place", "text"]);
  assert.equal(actions[0].text, "a { b");
});
await test("wait accepts decimals in seconds and rejects fractional milliseconds", () => {
  assert.equal(parseCommand("wait 1.5s").ms, 1500);
  assert.equal(parseCommand("wait 500ms").ms, 500);
  assert.equal(parseCommand("wait 2 seconds").ms, 2000);
  assert.throws(() => parseCommand("wait 0.5"), /milliseconds must be whole/);
  assert.throws(() => parseCommand("wait forever"), /wait 1.5s/);
});
await test("device types: quoted, unknown multi-word with quoted name, unnamed multi-word, full Gimkit list", () => {
  assert.deepEqual(parseCommand('place "Damage Boost" "DB" at r0c0'), { kind: "place", deviceType: "Damage Boost", name: "DB", at: "r0c0", quotedType: true });
  assert.equal(parseCommand('place damage boost "DB" at r0c0').name, "DB");
  assert.equal(parseCommand("place damage boost at r0c0").deviceType, "Damage Boost");
  assert.equal(parseCommand('place "Some Future Device" "X" at r0c0').deviceType, "Some Future Device");
  const unknown = parseCommand("place mystery gadget at r0c0");
  assert.equal(unknown.deviceType, "Mystery Gadget");
  assert.equal(unknown.unknownType, true);
  for (const t of ["Knockout Manager", "Speed Modifier", "Health Granter", "Inventory Item Manager", "Item Spawner", "Camera Point", "Crafting Table", "Crafting Recipe", "Damager", "End of Game Widget", "Flag", "Flag Capture Zone", "Image", "Laser Beam Manager", "Movement Meter", "Player Appearance Modifier", "Respawn", "Starting Inventory", "Team Settings", "Team Switcher", "Waypoint", "XP Granter", "Checkpoint", "Ball", "Ball Capture Zone", "Dialogue", "Voting", "Queue", "Cosmetic Modifier"]) {
    assert.equal(parseCommand(`place ${t.toLowerCase()} "X" at r0c0`).deviceType, t, t);
    assert.equal(DEVICE_TYPES[t.toLowerCase()], t);
  }
  assert.equal(normalizeDeviceType("ko manager"), "Knockout Manager");
  assert.equal(normalizeDeviceType("end game widget"), "End of Game Widget");
});
await test("trigger / button / text options with dedicated syntax", () => {
  const t = parseCommand('trigger "Step" receives go hidden delay 2 max 1 at r0c0');
  assert.deepEqual(t.options.map((o) => [o.key, o.value, o.kind]), [["hidden", "No", "select"], ["delay", 2, "number"], ["max", 1, "number"]]);
  assert.equal(t.channel, "go");
  const b = parseCommand('button "B" transmits go message "Press me"');
  assert.deepEqual(b.options.map((o) => [o.key, o.value]), [["message", "Press me"]]);
  const x = parseCommand('text "Hi there" size 32 at r0c0');
  assert.equal(x.text, "Hi there");
  assert.deepEqual(x.options.map((o) => [o.key, o.value]), [["size", 32]]);
  assert.throws(() => parseCommand('trigger "T" receives go bounce 3'), /Unknown trigger option "bounce".*allowed: hidden/);
  assert.throws(() => parseCommand('trigger "T" receives go delay soon'), /needs a number/);
  assert.equal(parseCommand('trigger "T" receives go').options, undefined);
  for (const [kind, table] of Object.entries(DEVICE_OPTIONS)) for (const [key, spec] of Object.entries(table)) assert.ok(spec.label && spec.kind, `${kind}.${key}`);
});
await test('generic option "Device" "Label" = value', () => {
  assert.deepEqual(parseCommand('option "Forward Pass" "Trigger Delay" = 2'), { kind: "option", name: "Forward Pass", label: "Trigger Delay", value: 2, at: null });
  assert.deepEqual(parseCommand('option "Forward Pass" "Visible In-Game" = no at r1c0').value, false);
  assert.equal(parseCommand('option "B" "Button Message" = "Go now"').value, "Go now");
  assert.throws(() => parseCommand('option "B" Message = 1'), /expected: option "Device Name" "Sidebar Label" = value/);
  assert.ok(optionValueMatches(false, "No") && optionValueMatches(true, "Yes") && optionValueMatches(2, "2") && optionValueMatches("Go", "go"));
  assert.ok(!optionValueMatches(false, "Yes") && !optionValueMatches(3, "2"));
});
await test("blocks header: on <channel>, when triggered, append, at with spaces, one-liner with {prop}", () => {
  const a = parseCommand('blocks "R" on nn-done { text = "a" + {x} }');
  assert.deepEqual(a.event, { kind: "channel", channel: "nn-done" });
  assert.equal(a.clear, true);
  const b = parseCommand('blocks "R" when triggered append: set A = {in}');
  assert.deepEqual(b.event, { kind: "triggered" });
  assert.equal(b.clear, false);
  assert.deepEqual(b.ast.statements[0].expr, ["prop", "in"]);
  const c = parseCommand('blocks "R" at 100, 200 when receiving on channel "my ch" { set A = 1 }');
  assert.equal(c.at, "100,200");
  assert.deepEqual(c.event, { kind: "channel", channel: "my ch" });
  const d = parseCommand('blocks "Z" when "Player Enters Zone" { set A = 1 }');
  assert.deepEqual(d.event, { kind: "custom", label: "Player Enters Zone" });
  assert.equal(parseCommand('blocks "R" { set A = 1 }').event, undefined);
  assert.throws(() => parseCommand('blocks "R" sideways { set A = 1 }'), /unexpected "sideways"/);
  assert.throws(() => parseCommand('blocks "R" on { set A = 1 }'), /"on" needs a channel/);
});
await test("property defaults beyond 2^53 carry a warning; text with size and at keeps content", () => {
  assert.match(parseCommand("property p = 9007199254740993").warning, /beyond the exact integer range/);
  assert.equal(parseCommand("property p = 5").warning, undefined);
  const t = parseCommand('text "net_output → check at the Property" size 20 at r9c1');
  assert.equal(t.text, "net_output → check at the Property");
  assert.equal(t.at, "r9c1");
});
await test("JSON spec: on/when events, options, and validation of the new keys", () => {
  const spec = {
    devices: [
      { type: "trigger", name: "T", at: "r0c0", receives: "go", blocks: "set A = 1", options: { "Visible In-Game": false, "Trigger Delay": 2 } },
      { type: "text", text: "Out", at: "r1c0", on: "done", blocks: 'text = "x"' },
      { type: "zone", name: "Z", at: "r2c0", when: "triggered", blocks: "set A = 1" },
    ],
  };
  assert.deepEqual(validateSpec(spec), []);
  const actions = specToActions(spec);
  const opts = actions.filter((a) => a.kind === "option");
  assert.deepEqual(opts.map((o) => [o.name, o.label, o.value]), [["T", "Visible In-Game", false], ["T", "Trigger Delay", 2]]);
  const blocks = actions.filter((a) => a.kind === "blocks");
  assert.equal(blocks[0].event, undefined);
  assert.deepEqual(blocks[1].event, { kind: "channel", channel: "done" });
  assert.equal(blocks[1].name, "Out");
  assert.deepEqual(blocks[2].event, { kind: "triggered" });
  assert.ok(validateSpec({ devices: [{ type: "trigger", name: "T", at: "r0c0", options: [1] }] }).some((e) => /"options" must be an object/.test(e)));
  assert.ok(validateSpec({ devices: [{ type: "trigger", name: "T", at: "r0c0", on: 5 }] }).some((e) => /"on" must be a channel name/.test(e)));
});

console.log("runner.validate — cross-script lints");
await test("property type mismatches and case mismatches are errors", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const { errors } = await map.check(`
    place property label at r0c0
    place property Input1 at r0c1
    place trigger "T" at r1c0
    property label = "hi"
    property Input1 = 0
    trigger "T" receives go
    blocks "T" { property label = 5; set A = {input1} + 1; property Input1 = A }
  `);
  assert.ok(errors.some((e) => /Property "label" is Text but .* assigns a number/.test(e)), errors.join("\n"));
  assert.ok(errors.some((e) => /\{input1\} does not match "Input1" — Gimkit property names are case-sensitive/.test(e)), errors.join("\n"));
});
await test("two property declarations differing only by case are an error", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const { errors } = await map.check("place property score at r0c0\nplace property Score at r0c1\nproperty score = 0\nproperty Score = 0");
  assert.ok(errors.some((e) => /differ only by case/.test(e)), errors.join("\n"));
});
await test("Text-typed property makes `+` a join and Text vs number comparison an error", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const script = `
    place property label at r0c0
    place property n at r0c1
    place text "Out" at r1c0
    text "Out"
    property label = "x"
    property n = 0
    blocks "Out" on show { text = {label} + {n} }
    place trigger "T" at r2c0
    trigger "T" receives show
    blocks "T" { if {label} > {n} { property n = 1 } }
  `;
  const actions = parseScript(script);
  const { errors } = await map.runner.validate(actions);
  assert.ok(errors.some((e) => /Ordering comparison on text|Comparing text with number/.test(e)), errors.join("\n"));
  const out = actions.find((a) => a.kind === "blocks" && a.name === "Out");
  assert.deepEqual(out.ast.statements[0].expr, ["join", ["prop", "label"], ["prop", "n"]]);
});
await test("channel graph: unreceived transmits, untransmitted receives, case-only mismatches", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const { warnings } = await map.check(`
    place button "B" at r0c0
    place trigger "T" at r0c1
    place trigger "U" at r0c2
    button "B" transmits GO
    trigger "T" receives go
    trigger "U" receives never-sent
    blocks "T" { broadcast "orphan" }
  `);
  assert.ok(warnings.some((w) => /transmits "GO" but the receiver spells it "go"/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some((w) => /receives "never-sent" but nothing in this script transmits it/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some((w) => /transmits "orphan" but nothing in this script receives it/.test(w)), warnings.join("\n"));
});
await test("blocks on devices without a Blocks tab; Set Text on non-Text devices; text without an event", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const { errors, warnings } = await map.check(`
    place property p at r0c0
    place trigger "T" at r0c1
    place text "Out" at r0c2
    place "Future Gadget" "F" at r0c3
    property p = 0
    trigger "T" receives go
    text "Out"
    blocks "p" { property p = 1 }
    blocks "T" { text = "x"; broadcast "go" }
    blocks "Out" { text = "y" }
    blocks "F" { set A = 1 }
  `);
  assert.ok(errors.some((e) => /blocks "p": a Property has no Blocks tab/.test(e)), errors.join("\n"));
  assert.ok(warnings.some((w) => /"text = ..." \(Set Text\) only exists on Text devices, but "T" is a Trigger/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some((w) => /blocks "Out" sets text but has no event/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some((w) => /Future Gadget is not known to have a Blocks tab/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some((w) => /"Future Gadget" is not a known Gimkit Creative device/.test(w)), warnings.join("\n"));
});
await test("placed-but-never-configured devices and the property-count ceiling warn", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const { warnings } = await map.check('place property lonely at r0c0\nplace button "B" at r0c1\nplace trigger "T" at r0c2\nplace text "Hi" at r0c3');
  assert.ok(warnings.some((w) => /Property "lonely" is placed but never configured — add: property lonely = 0/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some((w) => /Button "B" is placed but never configured/.test(w)));
  assert.ok(warnings.some((w) => /Trigger "T" is placed but never configured/.test(w)));
  assert.ok(warnings.some((w) => /Text "Hi" is placed but never configured/.test(w)));
  const many = Array.from({ length: 110 }, (_, i) => `place property p${i} at ${100 + (i % 8) * 80},${100 + Math.floor(i / 8) * 45}\nproperty p${i} = 0`).join("\n");
  const big = await GkcMap.dryRun({ verbose: false }).check(many);
  assert.deepEqual(big.errors, []);
  assert.ok(big.warnings.some((w) => /110 Property devices — Gimkit maps cap out around 128/.test(w)), big.warnings.join("\n"));
});
await test("blocks on a trigger with a different channel than it receives only warns", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  const { errors, warnings } = await map.check('place trigger "T" at r0c0\nplace button "B" at r0c1\nbutton "B" transmits a\nbutton "B" transmits b\ntrigger "T" receives a\nblocks "T" on b { set A = 1 }');
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /runs on channel "b" but the trigger receives "a"/.test(w)), warnings.join("\n"));
});
await test("hello.gkc and counter.map.json still validate cleanly", async () => {
  const hello = await GkcMap.dryRun({ verbose: false }).check(fs.readFileSync(path.join(ROOT, "examples/hello.gkc"), "utf8"));
  assert.deepEqual(hello.errors, [], hello.errors.join("\n"));
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "examples/counter.map.json"), "utf8"));
  const counter = await GkcMap.dryRun({ verbose: false }).runner.validate(specToActions(spec));
  assert.deepEqual(counter.errors, [], counter.errors.join("\n"));
});
await test("programmatic verbs: option(), blocks({ on }), simulate()", async () => {
  const map = GkcMap.dryRun({ verbose: false });
  await map.place("text", "Out", "r0c0");
  const o = await map.option("Out", "Font Size", 24);
  assert.equal(o.ok, true);
  assert.equal(o.action.kind, "option");
  const b = await map.blocks("Out", 'text = "hi"', { on: "show" });
  assert.deepEqual(b.action.event, { kind: "channel", channel: "show" });
  assert.ok(b.steps.some((s) => /When receiving on channel.*"show"/.test(s)));
  const sim = GkcMap.simulate('place property n at r0c0\nproperty n = 1\nplace trigger "T" at r1c0\ntrigger "T" receives go\nblocks "T": property n = {n} * 10', { fire: ["go"] });
  assert.equal(sim.get("n"), 10);
});

console.log("simulate.mjs — offline interpreter");
const xorActions = parseScript(fs.readFileSync(path.join(ROOT, "examples/xor-nn.gkc"), "utf8"));
await test("XOR example produces the full truth table with the scaled weights (net_output ×100)", () => {
  for (const [a, b, want] of [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0]]) {
    const sim = simulate(xorActions, { set: { input1: a, input2: b }, fire: ["nn-forward"] });
    const net = sim.get("net_output");
    const bit = net > 50 ? 1 : 0;
    assert.equal(bit, want, `XOR(${a},${b}) → net_output ${net}`);
    assert.ok(Math.abs(net - want * 100) <= 5, `net_output ${net} should be within 5 of ${want * 100}`);
    assert.equal(sim.text("XOR = ?"), `XOR(${a},${b}) = ${want}   [net ${net}]`);
    assert.deepEqual(sim.snapshot().warnings, []);
  }
});
await test("XOR example via the buttons: In1 ON + In2 OFF + Run NN", () => {
  const sim = simulate(xorActions, { press: ["In1 ON", "In2 OFF", "Run NN"] });
  assert.equal(sim.get("input1"), 1);
  assert.equal(sim.get("input2"), 0);
  assert.ok(sim.get("net_output") > 50);
  assert.equal(sim.get("output1"), 0); // relu clipped
  assert.equal(sim.get("output2"), 3);
  assert.equal(Object.is(simulate(xorActions, { fire: ["nn-forward"] }).get("net_output"), -0), false, "no negative zero");
});
await test("Gimkit semantics: variables start at 0, unknown property reads warn and read 0, DIVIDE keeps decimals, round", () => {
  const sim = simulate(parseScript('place property r at r0c0\nproperty r = 0\nplace trigger "T" at r1c0\ntrigger "T" receives go\nblocks "T" { var Q; set X = Q + {ghost} + 7 / 2; property r = X }'), { fire: ["go"] });
  assert.equal(sim.get("r"), 3.5);
  assert.ok(sim.snapshot().warnings.some((w) => /reads unknown property \{ghost\}/.test(w)));
  const r2 = simulate(parseScript('place property r at r0c0\nproperty r = 0\nplace trigger "T" at r1c0\ntrigger "T" receives go\nblocks "T": property r = round(7 / 2)'), { fire: ["go"] });
  assert.equal(r2.get("r"), 4);
});
await test("broadcast cascades, max triggers is honoured, loops are guarded", () => {
  const script = `
    place property n at r0c0
    property n = 0
    place trigger "A" at r1c0
    place trigger "B" at r1c1
    place trigger "Once" at r1c2
    trigger "A" receives a
    trigger "B" receives b
    trigger "Once" receives a max 1
    blocks "A" { property n = {n} + 1; broadcast "b" }
    blocks "B" { property n = {n} + 10 }
    blocks "Once" { property n = {n} + 100 }
  `;
  const sim = simulate(parseScript(script), { fire: ["a", "a"] });
  assert.equal(sim.get("n"), 122); // (1 + 10) twice, +100 once
  const loop = simulate(parseScript('place property n at r0c0\nproperty n = 0\nplace trigger "L" at r1c0\ntrigger "L" receives go\nblocks "L" { property n = {n} + 1; broadcast "go" }'), { fire: ["go"] });
  assert.ok(loop.snapshot().warnings.some((w) => /broadcast loop/.test(w)));
  assert.ok(loop.get("n") > 100);
});
await test("text join, player getters, modulo, random range, tonum", () => {
  const script = `
    place property n at r0c0
    property n = 7
    place text "Out" at r0c1
    text "Out"
    place trigger "T" at r1c0
    trigger "T" receives go
    blocks "T" { set R = random(1, 6); property n = {n} % 3 + R * 0 + number("5") + len("ab"); broadcast "show" }
    blocks "Out" on show { text = player.name + " has " + {n} + " (team " + player.team + ")" }
  `;
  const sim = simulate(parseScript(script), { fire: ["go"], player: { name: "Silas", team: 2, score: 0 } });
  assert.equal(sim.get("n"), 8);
  assert.equal(sim.text("Out"), "Silas has 8 (team 2)");
  for (let s = 1; s < 20; s += 1) {
    const r = simulate(parseScript('place property r at r0c0\nproperty r = 0\nplace trigger "T" at r1c0\ntrigger "T" receives go\nblocks "T": property r = random(1, 6)'), { fire: ["go"], seed: s }).get("r");
    assert.ok(Number.isInteger(r) && r >= 1 && r <= 6, `random gave ${r}`);
  }
});
await test("later blocks on the same device replace earlier ones; append keeps both", () => {
  const base = 'place property n at r0c0\nproperty n = 0\nplace trigger "T" at r1c0\ntrigger "T" receives go\n';
  assert.equal(simulate(parseScript(base + 'blocks "T": property n = 1\nblocks "T": property n = 2'), { fire: ["go"] }).get("n"), 2);
  assert.equal(simulate(parseScript(base + 'blocks "T": property n = 1\nblocks "T" append: property n = {n} + 5'), { fire: ["go"] }).get("n"), 6);
});
await test("case-mismatched property writes and unsimulated generic blocks warn instead of failing", () => {
  const sim = simulate(parseScript('place property Score at r0c0\nproperty Score = 0\nplace trigger "T" at r1c0\ntrigger "T" receives go\nblocks "T" { property score = 5; block "End Game" }'), { fire: ["go"] });
  const w = sim.snapshot().warnings.join("\n");
  assert.match(w, /property "score" written but the device is named "Score"/);
  assert.match(w, /block "End Game" is not simulated/);
});

console.log("in-page builder — mock Blockly harness");
function makeBlockly(defs) {
  const INPUT_VALUE = 1;
  const NEXT_STATEMENT = 3;
  class Connection {
    constructor(block, type) {
      this.block = block;
      this.type = type;
      this.targetConnection = null;
    }
    connect(other) {
      if (!other) throw new Error("connect(null)");
      if (this.targetConnection) this.disconnect();
      if (other.targetConnection) other.disconnect();
      this.targetConnection = other;
      other.targetConnection = this;
    }
    disconnect() {
      if (this.targetConnection) {
        this.targetConnection.targetConnection = null;
        this.targetConnection = null;
      }
    }
    targetBlock() {
      return this.targetConnection ? this.targetConnection.block : null;
    }
  }
  let nextId = 1;
  class Block {
    constructor(ws, type, def) {
      this.workspace = ws;
      this.type = type;
      this.id = `b${nextId++}`;
      this.disposed = false;
      this.inputList = (def.inputs || []).map((i) => ({
        name: i.name,
        connection: i.kind ? new Connection(this, i.kind === "value" ? INPUT_VALUE : NEXT_STATEMENT) : null,
        fieldRow: (i.fields || []).map((f) => ({ name: f.name, value: f.value ?? "", EDITABLE: true })),
      }));
      this.outputConnection = def.output ? new Connection(this, 2) : null;
      this.previousConnection = def.previous ? new Connection(this, 4) : null;
      this.nextConnection = def.next ? new Connection(this, NEXT_STATEMENT) : null;
      this.tooltip = def.tooltip || "";
      this.text = def.text || type;
    }
    getInput(name) {
      return this.inputList.find((i) => i.name === name) || null;
    }
    getField(name) {
      for (const i of this.inputList) for (const f of i.fieldRow) if (f.name === name) return f;
      return null;
    }
    setFieldValue(v, name) {
      const f = this.getField(name);
      if (!f) throw new Error(`no field ${name} on ${this.type}`);
      f.value = v;
    }
    getFieldValue(name) {
      return this.getField(name)?.value ?? null;
    }
    toString() {
      return this.text;
    }
    initSvg() {}
    render() {}
    loadExtraState(state) {
      if (state.hasElse && !this.getInput("ELSE")) this.inputList.push({ name: "ELSE", connection: new Connection(this, NEXT_STATEMENT), fieldRow: [] });
    }
    getParent() {
      for (const c of [this.outputConnection, this.previousConnection]) if (c && c.targetConnection) return c.targetConnection.block;
      return null;
    }
    dispose() {
      this.disposed = true;
      for (const c of [this.outputConnection, this.previousConnection]) if (c) c.disconnect();
      for (const i of this.inputList) if (i.connection && i.connection.targetBlock()) i.connection.targetBlock().dispose(false);
      if (this.nextConnection && this.nextConnection.targetBlock()) this.nextConnection.targetBlock().dispose(false);
      this.workspace.blocks.delete(this);
    }
  }
  class Workspace {
    constructor() {
      this.blocks = new Set();
      this.vars = new Map();
    }
    newBlock(type) {
      const def = defs[type];
      if (!def) throw new Error(`unknown block type ${type}`);
      const b = new Block(this, type, def);
      this.blocks.add(b);
      return b;
    }
    getTopBlocks() {
      return [...this.blocks].filter((b) => !b.getParent());
    }
    getAllBlocks() {
      return [...this.blocks];
    }
    getVariable(name) {
      return this.vars.get(name) || null;
    }
    createVariable(name) {
      const v = { name, id_: `id_${name}`, getId() { return this.id_; } };
      this.vars.set(name, v);
      return v;
    }
    render() {}
  }
  const ws = new Workspace();
  const Blockly = { Blocks: Object.fromEntries(Object.keys(defs).map((t) => [t, {}])), getMainWorkspace: () => ws, INPUT_VALUE, utils: {} };
  return { Blockly, ws };
}
const STD_DEFS = {
  when_receiving_on_channel: { next: true, text: "When receiving on channel ?" },
  math_number: { output: true, inputs: [{ name: "DUMMY", fields: [{ name: "NUM", value: "0" }] }] },
  text: { output: true, inputs: [{ name: "DUMMY", fields: [{ name: "TEXT", value: "" }] }] },
  logic_boolean: { output: true, inputs: [{ name: "DUMMY", fields: [{ name: "BOOL", value: "TRUE" }] }] },
  variables_set: { previous: true, next: true, inputs: [{ name: "VALUE", kind: "value", fields: [{ name: "VAR" }] }], text: "set ? to ?" },
  variables_get: { output: true, inputs: [{ name: "DUMMY", fields: [{ name: "VAR" }] }] },
  gamHud_setProperty: { previous: true, next: true, inputs: [{ name: "VALUE", kind: "value", fields: [{ name: "PROPERTY" }] }], text: "set property ? value ?" },
  gamHud_getProperty: { output: true, inputs: [{ name: "DUMMY", fields: [{ name: "PROPERTY" }] }], text: "get property ?" },
  math_arithmetic: { output: true, inputs: [{ name: "A", kind: "value", fields: [{ name: "OP", value: "ADD" }] }, { name: "B", kind: "value" }] },
  math_modulo: { output: true, inputs: [{ name: "DIVIDEND", kind: "value" }, { name: "DIVISOR", kind: "value" }] },
  math_round: { output: true, inputs: [{ name: "NUM", kind: "value", fields: [{ name: "OP", value: "ROUND" }] }] },
  math_single: { output: true, inputs: [{ name: "NUM", kind: "value", fields: [{ name: "OP", value: "ROOT" }] }] },
  math_random_int: { output: true, inputs: [{ name: "FROM", kind: "value" }, { name: "TO", kind: "value" }] },
  logic_compare: { output: true, inputs: [{ name: "A", kind: "value", fields: [{ name: "OP", value: "EQ" }] }, { name: "B", kind: "value" }] },
  logic_operation: { output: true, inputs: [{ name: "A", kind: "value", fields: [{ name: "OP", value: "AND" }] }, { name: "B", kind: "value" }] },
  logic_negate: { output: true, inputs: [{ name: "BOOL", kind: "value" }] },
  controls_if: { previous: true, next: true, inputs: [{ name: "IF0", kind: "value" }, { name: "DO0", kind: "statement" }], text: "if ? do ?" },
  text_join: { output: true, inputs: [{ name: "ADD0", kind: "value" }, { name: "ADD1", kind: "value" }], text: "create text with ? ?" },
  text_length: { output: true, inputs: [{ name: "VALUE", kind: "value" }] },
  set_text: { previous: true, next: true, inputs: [{ name: "TEXT", kind: "value" }], text: "set text ?" },
  broadcast_message_on_channel: { previous: true, next: true, inputs: [{ name: "DUMMY", fields: [{ name: "CHANNEL", value: "" }] }], text: "broadcast message on channel ?" },
  triggering_player_name: { output: true, text: "triggering player's name" },
  add_activity_feed_item_for_all_players: { previous: true, next: true, inputs: [{ name: "TEXT", kind: "value" }], text: "add activity feed item for all players ?" },
  end_game: { previous: true, next: true, text: "end game" },
};
function buildWith(defs, program, opts = {}, setup = null) {
  const { Blockly, ws } = makeBlockly(defs);
  const win = { Blockly };
  if (setup) setup(ws);
  // eslint-disable-next-line no-new-func
  const gkcBuild = new Function("window", `${IN_PAGE_BUILDER}\nreturn gkcBuild;`)(win);
  const res = gkcBuild(parseProgram(program), opts);
  return { res, ws, Blockly };
}
const chainTypes = (hat) => {
  const out = [];
  let cur = hat.nextConnection.targetBlock();
  while (cur) {
    out.push(cur.type);
    cur = cur.nextConnection && cur.nextConnection.targetBlock();
  }
  return out;
};
const withHat = (ws) => {
  const hat = ws.newBlock("when_receiving_on_channel");
  return hat;
};
await test("clear (default): old chain under the hat is disposed, new chain attached, count is exact", () => {
  let hat;
  let old;
  const { res, ws } = buildWith(STD_DEFS, "set A = 1\nproperty p = A", {}, (w) => {
    hat = withHat(w);
    old = w.newBlock("variables_set");
    hat.nextConnection.connect(old.previousConnection);
    const stray = w.newBlock("math_number");
    void stray;
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.attachedHat, true);
  assert.equal(res.hatType, "when_receiving_on_channel");
  assert.equal(old.disposed, true, "old chain should be disposed");
  assert.deepEqual(chainTypes(hat), ["variables_set", "gamHud_setProperty"]);
  assert.equal(ws.getAllBlocks().length, 5); // hat + 2 statements + number + variables_get
  const setVar = hat.nextConnection.targetBlock();
  assert.equal(setVar.getFieldValue("VAR"), "id_A");
  assert.equal(setVar.getInput("VALUE").connection.targetBlock().getFieldValue("NUM"), "1");
});
await test("append (clear:false): new statements go after the existing tail, nothing disposed", () => {
  let hat;
  let old;
  const { res } = buildWith(STD_DEFS, "property q = 2", { clear: false }, (w) => {
    hat = withHat(w);
    old = w.newBlock("variables_set");
    hat.nextConnection.connect(old.previousConnection);
  });
  assert.equal(res.ok, true);
  assert.equal(res.attachedHat, true);
  assert.equal(old.disposed, false);
  assert.deepEqual(chainTypes(hat), ["variables_set", "gamHud_setProperty"]);
});
await test("if / else wiring: condition on IF0, then on DO0, else on ELSE via loadExtraState", () => {
  let hat;
  const { res } = buildWith(STD_DEFS, "set A = {x}\nif A > 0 { property p = 1 } else { property p = 2 }", {}, (w) => {
    hat = withHat(w);
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const ifb = hat.nextConnection.targetBlock().nextConnection.targetBlock();
  assert.equal(ifb.type, "controls_if");
  const cmp = ifb.getInput("IF0").connection.targetBlock();
  assert.equal(cmp.type, "logic_compare");
  assert.equal(cmp.getFieldValue("OP"), "GT");
  assert.equal(ifb.getInput("DO0").connection.targetBlock().type, "gamHud_setProperty");
  assert.equal(ifb.getInput("ELSE").connection.targetBlock().getInput("VALUE").connection.targetBlock().getFieldValue("NUM"), "2");
});
await test("text = ... builds set_text ← text_join ← (text, get property); numbers get wrapped in a join", () => {
  let hat;
  const { res } = buildWith(STD_DEFS, 'text = "XOR = " + {net}\ntext = 5', {}, (w) => {
    hat = withHat(w);
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const [st1, st2] = [hat.nextConnection.targetBlock(), hat.nextConnection.targetBlock().nextConnection.targetBlock()];
  assert.equal(st1.type, "set_text");
  const join = st1.getInput("TEXT").connection.targetBlock();
  assert.equal(join.type, "text_join");
  assert.equal(join.getInput("ADD0").connection.targetBlock().getFieldValue("TEXT"), "XOR = ");
  assert.equal(join.getInput("ADD1").connection.targetBlock().getFieldValue("PROPERTY"), "net");
  const wrap = st2.getInput("TEXT").connection.targetBlock();
  assert.equal(wrap.type, "text_join");
  assert.equal(wrap.getInput("ADD0").connection.targetBlock().getFieldValue("NUM"), "5");
});
await test("vocabulary maps to the right Blockly types and OP fields", () => {
  let hat;
  const { res } = buildWith(STD_DEFS, 'set A = 1\nset B = A % 2 + random(1, 6) + floor(A) + sqrt(A) + len("x")\nif not (A > 1 and B < 2 or true) { broadcast "go" }\nset C = player.name', {}, (w) => {
    hat = withHat(w);
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const setB = hat.nextConnection.targetBlock().nextConnection.targetBlock();
  const types = [];
  const walk = (b) => {
    if (!b) return;
    types.push(b.type + (b.getField("OP") ? `:${b.getFieldValue("OP")}` : ""));
    for (const i of b.inputList) if (i.connection && i.connection.type === 1) walk(i.connection.targetBlock());
  };
  walk(setB.getInput("VALUE").connection.targetBlock());
  for (const want of ["math_modulo", "math_random_int", "math_round:ROUNDDOWN", "math_single:ROOT", "text_length"]) assert.ok(types.includes(want), `${want} in ${types}`);
  const ifb = setB.nextConnection.targetBlock();
  const neg = ifb.getInput("IF0").connection.targetBlock();
  assert.equal(neg.type, "logic_negate");
  const or = neg.getInput("BOOL").connection.targetBlock();
  assert.equal(or.getFieldValue("OP"), "OR");
  assert.equal(or.getInput("A").connection.targetBlock().getFieldValue("OP"), "AND");
  assert.equal(or.getInput("B").connection.targetBlock().type, "logic_boolean");
  assert.equal(ifb.getInput("DO0").connection.targetBlock().getFieldValue("CHANNEL"), "go");
  assert.equal(ifb.nextConnection.targetBlock().getInput("VALUE").connection.targetBlock().type, "triggering_player_name");
});
await test("generic block by visible name: positional arg → first value input; no match → unsupported", () => {
  let hat;
  const { res } = buildWith(STD_DEFS, 'block "Add Activity Feed Item For All Players" "Hello"\nblock "End Game"', {}, (w) => {
    hat = withHat(w);
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const feed = hat.nextConnection.targetBlock();
  assert.equal(feed.type, "add_activity_feed_item_for_all_players");
  assert.equal(feed.getInput("TEXT").connection.targetBlock().getFieldValue("TEXT"), "Hello");
  assert.equal(feed.nextConnection.targetBlock().type, "end_game");
  const miss = buildWith(STD_DEFS, 'block "Summon Dragon"', {}, withHat);
  assert.equal(miss.res.ok, false);
  assert.ok(miss.res.unsupported.some((u) => /Summon Dragon.*no block with that name/.test(u)), JSON.stringify(miss.res.unsupported));
});
await test("missing block types are reported as unsupported with a registry sample, never built wrong", () => {
  const defs = { ...STD_DEFS };
  delete defs.set_text;
  delete defs.math_modulo;
  const { res } = buildWith(defs, 'text = "x"\nset A = 5 % 2', {}, withHat);
  assert.equal(res.ok, false);
  assert.match(res.reason, /unsupported/);
  assert.ok(res.unsupported.includes("text = ... (Set Text)"), JSON.stringify(res.unsupported));
  assert.ok(res.unsupported.includes("% (remainder)"));
  assert.ok(Array.isArray(res.registrySample) && res.registrySample.length > 0);
});
await test("no event hat → attachedHat false (executor fails with not-attached-to-event-hat)", () => {
  const { res } = buildWith(STD_DEFS, "set A = 1");
  assert.equal(res.ok, true);
  assert.equal(res.attachedHat, false);
  assert.equal(res.hatType, null);
});
await test("core types missing → missing-types reason", () => {
  const defs = { ...STD_DEFS };
  delete defs.controls_if;
  const { res } = buildWith(defs, "set A = 1", {}, withHat);
  assert.equal(res.ok, false);
  assert.match(res.reason, /missing-types:ifb/);
});
await test("XOR forward pass + result display build fully in the mock workspace under the block cap", () => {
  const src = fs.readFileSync(path.join(ROOT, "examples/xor-nn.gkc"), "utf8");
  const fwd = src.match(/blocks "Forward Pass" \{([\s\S]*?)\n\}/)[1];
  const a = buildWith(STD_DEFS, fwd, {}, withHat);
  assert.equal(a.res.ok, true, JSON.stringify(a.res));
  assert.equal(a.res.attachedHat, true);
  assert.equal(a.res.overCap, false, `blockCount ${a.res.blockCount}`);
  const show = src.match(/blocks "XOR = \?" on nn-done \{([\s\S]*?)\n\}/)[1];
  const b = buildWith(STD_DEFS, show, {}, withHat);
  assert.equal(b.res.ok, true, JSON.stringify(b.res));
  assert.equal(b.res.overCap, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
