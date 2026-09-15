/**
 * Offline simulator: runs a parsed script's block code with Gimkit semantics —
 * no browser. Properties default 0 / "" / false by type, variables start at 0,
 * `round` is Math.round, DIVIDE yields decimals, channels propagate: firing a
 * channel runs every block code that receives it (triggers via `receives`, and
 * `blocks ... on <channel>`), `broadcast` cascades with a loop guard.
 *
 *   const sim = new GkcSim(parseScript(src));
 *   sim.set("input1", 1); sim.fire("nn-forward"); sim.get("net_output");
 */
import { parseProgram, formatProgram, retypeProgram } from "./blocks.mjs";

const MAX_STEPS = 10000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultFor(type) {
  if (/text/i.test(type || "")) return "";
  if (/true/i.test(type || "")) return false;
  return 0;
}

export class GkcSim {
  /**
   * @param {object[]} actions parsed script actions (parseScript output)
   * @param {object} [opts]
   * @param {number} [opts.seed]      seed for random()
   * @param {object} [opts.player]    { name, team, score } for player.* getters
   */
  constructor(actions, { seed = 1, player = { name: "Player", team: 1, score: 0 } } = {}) {
    this.rand = mulberry32(seed);
    this.player = { ...player };
    this.props = new Map(); // exact name → { type, value }
    this.propLower = new Map();
    this.texts = new Map(); // text device name → content
    this.buttons = new Map(); // button name → channel
    this.triggers = new Map(); // trigger name → { channel, max, fired }
    this.deviceTypes = new Map(); // name(lower) → type
    this.codes = []; // { device, event, ast }
    this.warnings = [];
    this.trace = [];
    this.steps = 0;
    this.load(actions);
  }

  load(actions) {
    const propTypes = new Map();
    for (const a of actions) {
      if (a.kind === "place" && a.name) {
        this.deviceTypes.set(a.name.toLowerCase(), a.deviceType);
        if (a.deviceType === "Property" && !this.props.has(a.name)) this.declareProp(a.name, "Number", 0);
        if (a.deviceType === "Text") this.texts.set(a.name, this.texts.get(a.name) ?? "");
      }
    }
    for (const a of actions) {
      if (a.kind === "property" && a.name) {
        this.declareProp(a.name, a.propertyType || "Number", a.default ?? defaultFor(a.propertyType));
        propTypes.set(a.name, a.propertyType || "Number");
      } else if (a.kind === "text") {
        this.texts.set(a.name || a.text, a.text);
        this.deviceTypes.set((a.name || a.text).toLowerCase(), "Text");
      } else if (a.kind === "button") {
        this.buttons.set(a.name, a.channel);
        this.deviceTypes.set(a.name.toLowerCase(), "Button");
      } else if (a.kind === "trigger") {
        const max = (a.options || []).find((o) => o.key === "max")?.value;
        this.triggers.set(a.name, { channel: a.channel, max: Number.isFinite(max) ? max : Infinity, fired: 0 });
        this.deviceTypes.set(a.name.toLowerCase(), "Trigger");
      }
    }
    for (const a of actions) {
      if (a.kind !== "blocks") continue;
      const ast = retypeProgram(parseProgram(a.ast || a.program, { lint: false }), propTypes);
      this.codes.push({ device: a.name, event: a.event || null, ast, clear: a.clear !== false, line: a.line });
    }
    // Replace semantics: a later `blocks "X"` (same device/event, not append) supersedes earlier ones.
    const seen = new Map();
    const kept = [];
    for (const c of this.codes) {
      const key = `${c.device}|${JSON.stringify(c.event)}`;
      if (c.clear && seen.has(key)) kept[seen.get(key)] = null;
      seen.set(key, kept.length);
      kept.push(c);
    }
    this.codes = kept.filter(Boolean);
  }

  declareProp(name, type, value) {
    this.props.set(name, { type, value });
    this.propLower.set(name.toLowerCase(), name);
  }

  warn(msg) {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  // ---------------------------------------------------------------- public API
  /** Set a property (by exact name; case-insensitive fallback with a warning). */
  set(name, value) {
    const p = this.props.get(name) || this.props.get(this.propLower.get(String(name).toLowerCase()));
    if (!p) {
      this.declareProp(name, typeof value === "string" ? "Text" : typeof value === "boolean" ? "True/False" : "Number", value);
      this.warn(`set: property "${name}" is not declared in the script — created for the simulation`);
      return;
    }
    p.value = this.coerce(p.type, value, `set ${name}`);
  }

  get(name) {
    const p = this.props.get(name) || this.props.get(this.propLower.get(String(name).toLowerCase()));
    if (!p) {
      this.warn(`get: unknown property "${name}"`);
      return undefined;
    }
    return p.value;
  }

  text(deviceName) {
    return this.texts.get(deviceName);
  }

  /** Press a Button device by name → fires its channel. */
  press(buttonName) {
    const ch = this.buttons.get(buttonName);
    if (!ch) {
      this.warn(`press: no button named "${buttonName}"`);
      return this;
    }
    this.trace.push(`press "${buttonName}" → "${ch}"`);
    return this.fire(ch);
  }

  /** Fire a channel: runs every block code that receives it, cascading broadcasts. */
  fire(channel) {
    const queue = [channel];
    while (queue.length) {
      const ch = queue.shift();
      this.trace.push(`channel "${ch}"`);
      const ran = this.codesFor(ch);
      if (!ran.length) this.warn(`channel "${ch}" is received by nothing`);
      for (const code of ran) {
        if (this.steps > MAX_STEPS) {
          this.warn(`stopped after ${MAX_STEPS} block executions — broadcast loop?`);
          return this;
        }
        this.runCode(code, queue);
      }
    }
    return this;
  }

  codesFor(channel) {
    const out = [];
    for (const code of this.codes) {
      const trig = this.triggers.get(code.device);
      if (code.event && code.event.kind === "channel") {
        if (code.event.channel === channel) out.push(code);
        continue;
      }
      if (trig && trig.channel === channel) {
        if (trig.fired >= trig.max) {
          this.trace.push(`  trigger "${code.device}" hit its max (${trig.max}) — not fired`);
          continue;
        }
        out.push(code);
      }
    }
    for (const code of out) {
      const trig = this.triggers.get(code.device);
      if (trig && !(code.event && code.event.kind === "channel")) trig.fired += 1;
    }
    return out;
  }

  runCode(code, queue = []) {
    this.trace.push(`  run blocks "${code.device}"${code.event ? ` (${code.event.kind === "channel" ? `on ${code.event.channel}` : code.event.kind})` : ""}`);
    const vars = new Map();
    this.exec(code.ast.statements, vars, code, queue);
  }

  snapshot() {
    const properties = {};
    for (const [n, p] of this.props) properties[n] = p.value;
    const texts = {};
    for (const [n, t] of this.texts) texts[n] = t;
    return { properties, texts, warnings: [...this.warnings], trace: [...this.trace] };
  }

  // ---------------------------------------------------------------- interpreter
  coerce(type, value, where) {
    if (/text/i.test(type)) return typeof value === "string" ? value : String(value);
    if (/true/i.test(type)) return typeof value === "boolean" ? value : !!value;
    if (typeof value === "number") return value === 0 ? 0 : value; // no -0 (Gimkit shows 0)
    if (typeof value === "boolean") return value ? 1 : 0;
    const n = Number(value);
    if (Number.isNaN(n)) {
      this.warn(`${where}: text "${value}" stored into a Number property — Gimkit would keep 0`);
      return 0;
    }
    return n === 0 ? 0 : n;
  }

  truthy(v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    return v !== "" && v != null;
  }

  num(v, where) {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    const n = Number(v);
    if (Number.isNaN(n)) {
      this.warn(`${where}: "${v}" used as a number (treated as 0)`);
      return 0;
    }
    return n;
  }

  evalExpr(e, vars, code) {
    if (!Array.isArray(e)) return e;
    const [k] = e;
    const where = `blocks "${code.device}"`;
    switch (k) {
      case "num":
      case "text":
      case "bool":
        return e[1];
      case "prop": {
        const p = this.props.get(e[1]);
        if (p) return p.value;
        const ci = this.propLower.get(e[1].toLowerCase());
        if (ci) {
          this.warn(`${where}: {${e[1]}} does not match property "${ci}" (case-sensitive) — reads 0`);
          return 0;
        }
        this.warn(`${where}: reads unknown property {${e[1]}} — Gimkit returns 0`);
        return 0;
      }
      case "var":
        return vars.has(e[1]) ? vars.get(e[1]) : 0;
      case "player":
        return this.player[e[1]];
      case "+":
        return this.num(this.evalExpr(e[1], vars, code), where) + this.num(this.evalExpr(e[2], vars, code), where);
      case "-":
        return this.num(this.evalExpr(e[1], vars, code), where) - this.num(this.evalExpr(e[2], vars, code), where);
      case "*":
        return this.num(this.evalExpr(e[1], vars, code), where) * this.num(this.evalExpr(e[2], vars, code), where);
      case "/": {
        const b = this.num(this.evalExpr(e[2], vars, code), where);
        if (b === 0) {
          this.warn(`${where}: division by zero (result 0)`);
          return 0;
        }
        return this.num(this.evalExpr(e[1], vars, code), where) / b;
      }
      case "%": {
        const b = this.num(this.evalExpr(e[2], vars, code), where);
        if (b === 0) {
          this.warn(`${where}: modulo by zero (result 0)`);
          return 0;
        }
        const a = this.num(this.evalExpr(e[1], vars, code), where);
        return ((a % b) + b) % b; // Blockly math_modulo is a true modulo (sign of divisor)
      }
      case "join":
        return String(this.evalExpr(e[1], vars, code)) + String(this.evalExpr(e[2], vars, code));
      case "cmp": {
        let a = this.evalExpr(e[2], vars, code);
        let b = this.evalExpr(e[3], vars, code);
        if (typeof a === "number" || typeof b === "number") {
          a = this.num(a, where);
          b = this.num(b, where);
        }
        switch (e[1]) {
          case "<":
            return a < b;
          case ">":
            return a > b;
          case "<=":
            return a <= b;
          case ">=":
            return a >= b;
          case "!=":
            return a !== b;
          default:
            return a === b;
        }
      }
      case "and":
        return this.truthy(this.evalExpr(e[1], vars, code)) && this.truthy(this.evalExpr(e[2], vars, code));
      case "or":
        return this.truthy(this.evalExpr(e[1], vars, code)) || this.truthy(this.evalExpr(e[2], vars, code));
      case "not":
        return !this.truthy(this.evalExpr(e[1], vars, code));
      case "round":
        return Math.round(this.num(this.evalExpr(e[1], vars, code), where));
      case "floor":
        return Math.floor(this.num(this.evalExpr(e[1], vars, code), where));
      case "ceil":
        return Math.ceil(this.num(this.evalExpr(e[1], vars, code), where));
      case "abs":
        return Math.abs(this.num(this.evalExpr(e[1], vars, code), where));
      case "sqrt":
        return Math.sqrt(this.num(this.evalExpr(e[1], vars, code), where));
      case "random": {
        const lo = Math.ceil(this.num(this.evalExpr(e[1], vars, code), where));
        const hi = Math.floor(this.num(this.evalExpr(e[2], vars, code), where));
        return lo + Math.floor(this.rand() * (hi - lo + 1));
      }
      case "tostr":
        return String(this.evalExpr(e[1], vars, code));
      case "tonum": {
        const v = this.evalExpr(e[1], vars, code);
        const n = Number(v);
        if (Number.isNaN(n)) {
          this.warn(`${where}: number("${v}") is not numeric — 0`);
          return 0;
        }
        return n;
      }
      case "len":
        return String(this.evalExpr(e[1], vars, code)).length;
      default:
        this.warn(`${where}: expression "${k}" is not simulated (0)`);
        return 0;
    }
  }

  exec(statements, vars, code, queue) {
    for (const s of statements || []) {
      this.steps += 1;
      if (this.steps > MAX_STEPS) {
        this.warn(`stopped after ${MAX_STEPS} block executions — broadcast loop?`);
        return;
      }
      switch (s.op) {
        case "declare":
          if (!vars.has(s.name)) vars.set(s.name, 0);
          break;
        case "setVar":
          vars.set(s.name, this.evalExpr(s.expr, vars, code));
          break;
        case "setProp":
        case "setPropRound": {
          let v = this.evalExpr(s.expr, vars, code);
          if (s.op === "setPropRound") v = Math.round(this.num(v, `blocks "${code.device}"`));
          let p = this.props.get(s.prop);
          if (!p) {
            const ci = this.propLower.get(s.prop.toLowerCase());
            if (ci) this.warn(`blocks "${code.device}": property "${s.prop}" written but the device is named "${ci}" (case-sensitive)`);
            else this.warn(`blocks "${code.device}": writes property "${s.prop}" that no Property device declares — Gimkit ignores it`);
            this.declareProp(s.prop, typeof v === "string" ? "Text" : typeof v === "boolean" ? "True/False" : "Number", defaultFor(typeof v === "string" ? "Text" : "Number"));
            p = this.props.get(s.prop);
          }
          p.value = this.coerce(p.type, v, `blocks "${code.device}": property ${s.prop}`);
          this.trace.push(`    ${s.prop} = ${JSON.stringify(p.value)}`);
          break;
        }
        case "setText": {
          const v = String(this.evalExpr(s.expr, vars, code));
          const type = this.deviceTypes.get(String(code.device).toLowerCase());
          if (type && type !== "Text") this.warn(`blocks "${code.device}": "text = ..." on a ${type} — only Text devices have Set Text`);
          this.texts.set(code.device, v);
          this.trace.push(`    text "${code.device}" = ${JSON.stringify(v)}`);
          break;
        }
        case "broadcast":
          this.trace.push(`    broadcast "${s.channel}"`);
          queue.push(s.channel);
          break;
        case "block":
          this.warn(`blocks "${code.device}": block "${s.name}" is not simulated`);
          break;
        case "if": {
          const c = this.evalExpr(s.cond, vars, code);
          if (this.truthy(c)) this.exec(s.then, vars, code, queue);
          else if (s.else) this.exec(s.else, vars, code, queue);
          break;
        }
        default:
          this.warn(`blocks "${code.device}": statement "${s.op}" is not simulated (${formatProgram({ statements: [s] })})`);
      }
    }
  }
}

/**
 * Convenience: parse + simulate in one call.
 *   simulate(actions, { set: { input1: 1 }, fire: ["nn-forward"], press: ["Run NN"] })
 */
export function simulate(actions, { set = {}, fire = [], press = [], seed = 1, player } = {}) {
  const sim = new GkcSim(actions, { seed, player });
  for (const [k, v] of Object.entries(set)) sim.set(k, v);
  for (const b of press) sim.press(b);
  for (const ch of fire) sim.fire(ch);
  return sim;
}
