/**
 * Gimkit Creative SDK — public API.
 *
 *   import { GkcMap } from "gimkit-creative-sdk";
 *   const map = await GkcMap.open({ hostUrl: "https://www.gimkit.com/host?id=..." });
 *   await map.place("trigger", "Forward Pass", "r6c0");
 *   await map.trigger("Forward Pass", "nn-forward");
 *   await map.blocks("Forward Pass", `set A = {input1}; property output1 = A`);
 *   await map.close();
 *
 * Or drive it with text:  await map.run(`place trigger "T1" at r0c0\ntrigger "T1" receives go`);
 * Or dry-run offline:      GkcMap.dryRun().run(script)
 */
import { GkcSession } from "./session.mjs";
import { GkcRunner } from "./runner.mjs";
import { Layout } from "./layout.mjs";
import { parseScript, parseCommand } from "./commands.mjs";
import { specToActions, validateSpec } from "./spec.mjs";
import { normalizeDeviceType, describeAction, labelAction, DEVICE_TYPES, BLOCK_DEVICES, NO_BLOCKS_DEVICES } from "./actions.mjs";
import { parseProgram, formatProgram, estimateBlockCount, parseExpression, lintProgram, retypeProgram, BLOCK_CAP } from "./blocks.mjs";
import { GkcSim, simulate } from "./simulate.mjs";
import { probeEditor } from "./probe.mjs";

export class GkcMap {
  constructor(runner, session = null) {
    this.runner = runner;
    this.session = session;
    this.layout = runner.layout;
  }

  /** Connect to a live editor (Chrome via CDP or saved profile; auto-login if creds set). */
  static async open(opts = {}) {
    const session = new GkcSession(opts);
    const page = await session.open();
    await session.waitForEditor();
    const runner = new GkcRunner({
      page,
      retries: opts.retries ?? 2,
      layout: opts.layout || new Layout(),
      verbose: opts.verbose ?? true,
      stopOnFail: !!opts.stopOnFail,
      strict: !!opts.strict,
    });
    return new GkcMap(runner, session);
  }

  /** Offline runner that prints the primitive click plan instead of executing. */
  static dryRun(opts = {}) {
    return new GkcMap(
      new GkcRunner({ page: null, dryRun: true, layout: opts.layout || new Layout(), verbose: opts.verbose ?? true, stopOnFail: !!opts.stopOnFail, strict: !!opts.strict }),
    );
  }

  // ---- verbs ------------------------------------------------------------
  place(type, name, at) {
    return this.runner.runOne({ kind: "place", deviceType: normalizeDeviceType(type), name, at: at ?? name });
  }
  property(name, value, { at, type, scope } = {}) {
    const inferred = typeof value === "number" ? "Number" : typeof value === "boolean" ? "True/False" : "Text";
    return this.runner.runOne({ kind: "property", name, default: value, propertyType: type || inferred, scope: scope || "global", at });
  }
  button(name, channel, at) {
    return this.runner.runOne({ kind: "button", name, channel, at });
  }
  trigger(name, channel, at) {
    return this.runner.runOne({ kind: "trigger", name, channel, at });
  }
  text(content, at) {
    return this.runner.runOne({ kind: "text", text: content, name: content, at });
  }
  /** Set any sidebar option by its label: option("Forward Pass", "Trigger Delay", 2). */
  option(name, label, value, at) {
    return this.runner.runOne({ kind: "option", name, label, value, at });
  }
  /**
   * Build block code on a device. Replaces existing code unless { append: true }.
   * `on: "<channel>"` targets the "when receiving on channel" block code, `when: "triggered"` the trigger event.
   */
  blocks(name, program, { at, append = false, clear, on, when } = {}) {
    const ast = parseProgram(program);
    const event = on ? { kind: "channel", channel: on } : when === "triggered" ? { kind: "triggered" } : when ? { kind: "custom", label: when } : undefined;
    return this.runner.runOne({ kind: "blocks", name, program, ast, clear: clear ?? !append, at, warnings: lintProgram(ast).warnings, ...(event ? { event } : {}) });
  }
  /** Offline simulation of `.gkc` script text (or parsed actions): returns a GkcSim. */
  static simulate(scriptOrActions, opts) {
    const actions = typeof scriptOrActions === "string" ? parseScript(scriptOrActions) : scriptOrActions;
    return simulate(actions, opts);
  }
  /** Dump Blockly registry / sidebar labels of the live editor to build-output/probe.json. */
  probe(opts) {
    return probeEditor(this.runner.page, this.runner.layout, opts);
  }
  read(nameOrAt) {
    return this.runner.runOne({ kind: "read", name: typeof nameOrAt === "string" ? nameOrAt : undefined, at: nameOrAt });
  }
  wait(ms) {
    return this.runner.runOne({ kind: "wait", ms });
  }
  screenshot(name) {
    return this.runner.runOne({ kind: "screenshot", name });
  }

  /** Run `.gkc` script text (validated first; opts: { validate, force }). */
  run(script, opts) {
    return this.runner.runScript(script, opts);
  }
  /** Static-check `.gkc` script text without executing: { errors, warnings }. */
  check(script) {
    return this.runner.validate(parseScript(script));
  }
  /** Run a single command line (no whole-script validation — use run() for that). */
  do(line) {
    return this.runner.runOne(parseCommand(line));
  }
  /** Run a JSON map spec. */
  runSpec(spec, opts) {
    const errors = validateSpec(spec);
    if (errors.length) throw new Error(`Invalid map spec:\n - ${errors.join("\n - ")}`);
    return this.runner.run(specToActions(spec), opts);
  }

  report() {
    return this.runner.report();
  }

  async close(opts) {
    if (this.session) await this.session.close(opts);
  }
}

export {
  GkcSession,
  GkcRunner,
  Layout,
  parseScript,
  parseCommand,
  specToActions,
  validateSpec,
  normalizeDeviceType,
  describeAction,
  labelAction,
  DEVICE_TYPES,
  BLOCK_DEVICES,
  NO_BLOCKS_DEVICES,
  parseProgram,
  formatProgram,
  estimateBlockCount,
  parseExpression,
  lintProgram,
  retypeProgram,
  BLOCK_CAP,
  GkcSim,
  simulate,
  probeEditor,
};
