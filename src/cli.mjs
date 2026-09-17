#!/usr/bin/env node
/**
 * gkc — Gimkit Creative SDK command line.
 *
 *   gkc run <file.gkc | map.json> [--dry-run] [--host <url>] [--stop-on-fail] [--strict] [--force]
 *   gkc check <file>           # static validation only (exit 1 on errors)
 *   gkc do "place trigger \"T1\" at r0c0" ["trigger \"T1\" receives go" ...] [--dry-run]
 *   gkc plan <file>            # alias for run --dry-run
 *   gkc repl [--dry-run]       # interactive: type commands, see them execute
 *   gkc blocks "<program>"     # parse a block program, print AST + block count
 *   gkc simulate <file> [--set k=v ...] [--press "Button" ...] [--fire channel ...] [--json]
 *   gkc probe [--at r0c0|x,y|"Name"] [--on channel]   # dump Blockly registry + sidebar labels
 *   gkc devices                # list known device type names
 *
 * Env: GKC_HOST_URL, GKC_CDP_PORT=9222, GKC_EMAIL/GKC_PASSWORD (unattended login),
 *      GKC_ZOOM=0.3, GKC_OUTPUT_DIR, GKC_LOGIN_TIMEOUT_MS, GKC_EDITOR_TIMEOUT_MS
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import { GkcMap, parseScript, parseProgram, formatProgram, estimateBlockCount, lintProgram, BLOCK_CAP, DEVICE_TYPES, simulate } from "./index.mjs";
import { specToActions, validateSpec } from "./spec.mjs";
import { log, setQuiet } from "./editor/config.mjs";

// Flags that take a value: their value must not leak into the positional list.
const VALUE_FLAGS = new Set(["--host", "--retries", "--output", "--at", "--on", "--seed"]);
// Flags that may repeat: collected into arrays.
const MULTI_FLAGS = new Set(["--set", "--press", "--fire"]);
const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    let value;
    if (eq > 0 && !MULTI_FLAGS.has(name)) value = a.slice(eq + 1);
    else if (MULTI_FLAGS.has(name)) value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    else if (VALUE_FLAGS.has(name)) value = argv[++i];
    else value = true;
    if (MULTI_FLAGS.has(name)) flags.set(name, [...(flags.get(name) || []), value]);
    else flags.set(name, value);
  } else positional.push(a);
}
const flagValue = (name) => (flags.has(name) ? flags.get(name) : undefined);
const dryRun = flags.has("--dry-run") || flags.has("--plan") || positional[0] === "plan";
if (flagValue("--host")) process.env.GKC_HOST_URL = flagValue("--host");
if (flags.has("--quiet")) setQuiet(true);
const runnerOpts = {
  stopOnFail: flags.has("--stop-on-fail"),
  strict: flags.has("--strict"),
  retries: flagValue("--retries") != null ? Number(flagValue("--retries")) : undefined,
};

function usage() {
  console.log(`gkc — Gimkit Creative SDK

  gkc run <file.gkc|map.json> [--dry-run] [--host <url>] [--stop-on-fail] [--strict] [--force]
                                       live: opens Chrome; log in / open the map there if asked, then it builds
  gkc check <file.gkc|map.json>        static check only: syntax, positions, names, block lint
  gkc plan <file>                      dry-run: print the click plan, touch nothing
  gkc do "<command>" [...] [--dry-run] run one or more command lines
  gkc repl [--dry-run]                 interactive command prompt
  gkc blocks "<program>"               parse a block program (AST + block count)
  gkc simulate <file> [--set k=v]... [--press "Button"]... [--fire channel]... [--json]
                                       run the block code offline with Gimkit semantics
  gkc probe [--at r0c0|x,y|"Name"] [--on channel]
                                       dump Blockly registry + sidebar labels to build-output/probe.json
  gkc devices                          list device type names

Flags: --strict (warnings fail the check) --force (run despite validation errors)
       --stop-on-fail (abort after first failure) --retries N --quiet

Commands (see README):
  place trigger "Name" at r1c0 | property x = 5 at 400,300 | button "B" transmits ch
  trigger "T" receives ch hidden delay 1 | text "hi" size 24 at r0c0
  option "T" "Max Triggers" = 3 | blocks "T" on ch { set A = {x}; property y = A }
`);
}

async function openMap() {
  if (dryRun) return GkcMap.dryRun(runnerOpts);
  return GkcMap.open({ hostUrl: process.env.GKC_HOST_URL || null, auto: true, ...runnerOpts });
}

function loadActionsFromFile(file) {
  const abs = path.resolve(file);
  const src = fs.readFileSync(abs, "utf8");
  if (/\.json$/i.test(abs)) {
    const spec = JSON.parse(src);
    const errors = validateSpec(spec);
    if (errors.length) throw new Error(`Invalid map spec:\n - ${errors.join("\n - ")}`);
    return specToActions(spec);
  }
  return parseScript(src);
}

async function main() {
  const cmd = positional[0];
  if (!cmd || flags.has("--help") || cmd === "help") return usage();

  if (cmd === "devices") {
    const seen = new Set(Object.values(DEVICE_TYPES));
    for (const d of [...seen].sort()) console.log(d);
    return;
  }

  if (cmd === "blocks") {
    const src = positional.slice(1).join(" ");
    const prog = parseProgram(src);
    const lint = lintProgram(prog);
    console.log(formatProgram(prog));
    console.log(`\n${prog.statements.length} statements, ~${estimateBlockCount(prog)} blocks (Gimkit cap ≈ ${BLOCK_CAP} per workspace)`);
    for (const w of lint.warnings) console.log(`! ${w}`);
    console.log(JSON.stringify(prog, null, 2));
    return;
  }

  if (cmd === "check") {
    const file = positional[1];
    if (!file) throw new Error("gkc check <file>");
    const actions = loadActionsFromFile(file);
    const map = GkcMap.dryRun({ verbose: false, ...runnerOpts });
    const { errors, warnings } = await map.runner.validate(actions);
    for (const e of errors) console.log(`✗ ${e}`);
    for (const w of warnings) console.log(`! ${w}`);
    const bad = errors.length + (flags.has("--strict") ? warnings.length : 0);
    console.log(`${actions.length} actions, ${errors.length} error(s), ${warnings.length} warning(s) — ${bad ? "FAIL" : "OK"}`);
    process.exitCode = bad ? 1 : 0;
    return;
  }

  if (cmd === "simulate" || cmd === "sim") {
    const file = positional[1];
    if (!file) throw new Error('gkc simulate <file> [--set k=v]... [--press "Button"]... [--fire channel]...');
    const actions = loadActionsFromFile(file);
    const set = {};
    for (const kv of flags.get("--set") || []) {
      const eq = String(kv).indexOf("=");
      if (eq <= 0) throw new Error(`--set needs name=value, got "${kv}"`);
      const raw = String(kv).slice(eq + 1);
      set[String(kv).slice(0, eq)] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : /^(true|false)$/i.test(raw) ? raw.toLowerCase() === "true" : raw.replace(/^"|"$/g, "");
    }
    const seed = flagValue("--seed") != null ? Number(flagValue("--seed")) : 1;
    const sim = simulate(actions, { set, press: flags.get("--press") || [], fire: flags.get("--fire") || [], seed });
    const snap = sim.snapshot();
    if (flags.has("--json")) {
      console.log(JSON.stringify(snap, null, 2));
    } else {
      console.log("Properties:");
      for (const [k, v] of Object.entries(snap.properties)) console.log(`  ${k} = ${JSON.stringify(v)}`);
      if (Object.keys(snap.texts).length) {
        console.log("Text devices:");
        for (const [k, v] of Object.entries(snap.texts)) console.log(`  "${k}" → ${JSON.stringify(v)}`);
      }
      if (flags.has("--trace")) {
        console.log("Trace:");
        for (const t of snap.trace) console.log(`  ${t}`);
      }
      for (const w of snap.warnings) console.log(`! ${w}`);
      console.log(`${snap.trace.length} events, ${snap.warnings.length} warning(s)`);
    }
    process.exitCode = snap.warnings.length && flags.has("--strict") ? 1 : 0;
    return;
  }

  if (cmd === "probe") {
    if (dryRun) throw new Error("gkc probe needs a live editor (drop --dry-run)");
    const map = await openMap();
    const on = flagValue("--on");
    const r = await map.probe({ at: flagValue("--at"), event: on ? { kind: "channel", channel: on } : null });
    console.log(JSON.stringify(r, null, 2));
    await map.close();
    return;
  }

  if (cmd === "run" || cmd === "plan") {
    const file = positional[1];
    if (!file) throw new Error("gkc run <file>");
    const actions = loadActionsFromFile(file);
    log(`${dryRun ? "Planning" : "Running"} ${actions.length} actions from ${file}`);
    const map = await openMap();
    const report = await map.runner.run(actions, { force: flags.has("--force") });
    await map.close();
    process.exitCode = report.failed.length ? 1 : 0;
    return;
  }

  if (cmd === "do") {
    const lines = positional.slice(1);
    if (!lines.length) throw new Error('gkc do "<command>" [...]');
    const map = await openMap();
    for (const line of lines) await map.do(line);
    map.report();
    await map.close();
    return;
  }

  if (cmd === "repl") {
    const map = await openMap();
    console.log(`gkc repl ${dryRun ? "(dry-run) " : ""}— type commands, "report", or "exit"`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "gkc> " });
    rl.prompt();
    rl.on("line", async (line) => {
      const l = line.trim();
      if (!l) return rl.prompt();
      if (l === "exit" || l === "quit") return rl.close();
      if (l === "report") {
        map.report();
        return rl.prompt();
      }
      try {
        await map.do(l);
      } catch (err) {
        console.log(`error: ${err.message}`);
      }
      rl.prompt();
    });
    await new Promise((r) => rl.on("close", r));
    await map.close();
    return;
  }

  usage();
  throw new Error(`Unknown command "${cmd}"`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
