/**
 * The `.gkc` command language — plain-English-ish lines that compile to actions.
 *
 *   layout origin 72,72 gap 95,68
 *   place trigger "Forward Pass" at r6c0
 *   place property input1 at r1c0
 *   place item granter at r3c3                   // multi-word device types work unnamed
 *   place "Damage Boost" "DB" at r4c4            // any Gimkit device: quote the type if unknown
 *   property input1 = 0                          // position looked up by name
 *   property "weight1-1" = -80 at r2c0           // or explicit
 *   property title = "hi" type Text scope player
 *   button "Run NN" transmits nn-forward at r7c2
 *   button "Run NN" transmits nn-forward message "Run the network"
 *   trigger "Forward Pass" receives nn-forward   // position by name
 *   trigger "Step" receives go hidden delay 2 max 1
 *   text "=== XOR ===" size 32 at r0c0
 *   option "Forward Pass" "Trigger Delay" = 2    // any option by its sidebar label
 *   blocks "Forward Pass" {                      // multi-line block program (REPLACES existing code)
 *     set A = {input1}
 *     property output1 = A
 *   }
 *   blocks "Set input1=1": property input1 = 1   // one-liner
 *   blocks "Forward Pass" append { ... }         // keep existing blocks, add after them
 *   blocks "Result" on nn-done { text = ... }    // block code for event "when receiving on channel"
 *   blocks "Zone A" when triggered { ... }       // block code for event "when triggered"
 *   wait 500 | wait 1.5s | click 100,200 | press e | screenshot after-place | prepare
 *
 * Positions: `at 400,300` | `at r2c1` | `at "Device Name"` | omitted → by own name.
 * `place X "Name" at ...` also remembers Name → position for later lines.
 * Names with spaces must be quoted: place trigger "Forward Pass" at r0c0.
 */
import { normalizeDeviceType, DEVICE_TYPES } from "./actions.mjs";
import { parseProgram, lintProgram, PROP_REF_RE } from "./blocks.mjs";

const NAME = `"[^"]+"|'[^']+'|[A-Za-z0-9_\\-.=]+`;
const POS = `"[^"]+"|'[^']+'|r\\d+\\s*c\\d+|-?\\d+\\s*,\\s*-?\\d+`;
const PROPERTY_TYPES = { number: "Number", text: "Text", "true/false": "True/False", boolean: "True/False", bool: "True/False" };
const PROPERTY_SCOPES = new Set(["global", "player", "team"]);

/**
 * Device options with dedicated syntax. `label` is a case-insensitive regex source
 * matched against the sidebar label text; `kind` tells the executor which control
 * to expect below the label. Unverified labels are a data fix, never a wrong map:
 * the executor re-opens the device and reads the value back.
 */
export const DEVICE_OPTIONS = {
  trigger: {
    hidden: { flag: true, label: "visible", display: "Visible In-Game", kind: "select", value: "No" },
    invisible: { flag: true, label: "visible", display: "Visible In-Game", kind: "select", value: "No" },
    visible: { flag: true, label: "visible", display: "Visible In-Game", kind: "select", value: "Yes" },
    delay: { label: "delay", display: "Trigger Delay", kind: "number" },
    max: { label: "max(imum)?\\s*triggers?", display: "Max Triggers", kind: "number" },
  },
  button: {
    message: { label: "button message|message", display: "Button Message", kind: "text" },
    hidden: { flag: true, label: "visible", display: "Visible In-Game", kind: "select", value: "No" },
    visible: { flag: true, label: "visible", display: "Visible In-Game", kind: "select", value: "Yes" },
  },
  text: {
    size: { label: "font size|size", display: "Font Size", kind: "number" },
  },
};

function unquote(s) {
  return String(s ?? "").trim().replace(/^["']|["']$/g, "");
}

/** Strip a trailing `// comment` that is not inside quotes. */
function stripLineComment(line) {
  let inStr = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inStr) {
      if (ch === "\\") i += 1;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

/** Count `{` / `}` that are outside quotes and are not `{property}` references. */
function braceDelta(line) {
  const stripped = line.replace(PROP_REF_RE, "");
  let depth = 0;
  let inStr = null;
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (inStr) {
      if (ch === "\\") i += 1;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  return depth;
}

function splitLines(src) {
  // Keep `blocks ... { ... }` bodies together.
  const out = [];
  let cur = "";
  let depth = 0;
  let startLine = 0;
  const lines = String(src).split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = stripLineComment(lines[idx]);
    if (depth === 0 && !line.trim()) continue;
    if (depth === 0 && /^\s*#/.test(line)) continue;
    if (!cur) startLine = idx + 1;
    cur += (cur ? "\n" : "") + line;
    depth += braceDelta(line);
    if (depth <= 0) {
      depth = 0;
      if (cur.trim()) out.push({ text: cur.trim(), line: startLine });
      cur = "";
    }
  }
  if (cur.trim()) {
    if (depth > 0) throw new Error(`Line ${startLine}: unclosed "{" — the blocks body never ends`);
    out.push({ text: cur.trim(), line: startLine });
  }
  return out;
}

/** Split "... at <pos>" off the end of a command. */
function splitAt(rest) {
  const m = rest.match(/^(.*?)\s+at\s+("[^"]+"|'[^']+'|r\d+\s*c\d+|-?\d+\s*,\s*-?\d+|[A-Za-z0-9_\-. ]+)\s*$/i);
  if (!m) return { head: rest.trim(), at: null };
  return { head: m[1].trim(), at: m[2].trim() };
}

/** Split a string into whitespace-separated words, keeping quoted strings intact. */
function words(s) {
  const out = [];
  const re = /"[^"]*"|'[^']*'|\S+/g;
  let m;
  while ((m = re.exec(s))) out.push(m[0]);
  return out;
}

/**
 * Device type + optional name from the head of a place command:
 *   trigger "Forward Pass"  |  property input1  |  item granter  |  "Damage Boost" "DB"  |  damage boost "DB"
 */
function splitDeviceType(head, line) {
  const trimmed = head.trim();
  let m;
  if ((m = trimmed.match(/^("[^"]+"|'[^']+')\s*(.*)$/))) return { type: unquote(m[1]), rest: m[2].trim(), quotedType: true };
  const lower = trimmed.toLowerCase();
  const known = Object.keys(DEVICE_TYPES).sort((a, b) => b.length - a.length);
  for (const k of known) {
    if (lower === k) return { type: k, rest: "" };
    if (lower.startsWith(k + " ")) return { type: k, rest: trimmed.slice(k.length).trim() };
  }
  // Unknown type: words before a trailing quoted name are the type.
  if ((m = trimmed.match(/^(.*?)\s*("[^"]+"|'[^']+')$/))) {
    if (!m[1].trim()) throw new Error(`Cannot parse place command: "${line}" — missing device type before the name`);
    return { type: m[1].trim(), rest: m[2] };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { type: parts[0], rest: "" };
  // Several unquoted words and no known prefix: it's an unnamed multi-word device type.
  return { type: trimmed, rest: "", unknownMultiWord: true };
}

function parseDeviceName(rest, line) {
  if (!rest) return undefined;
  const m = rest.match(new RegExp(`^(${NAME})$`));
  if (!m) {
    throw new Error(`Cannot parse place command: "${line}" — a device name with spaces must be quoted, e.g. place trigger "${rest}" at r0c0`);
  }
  return unquote(m[1]);
}

function parsePropertyValue(rawVal, line) {
  if (/^-?\d+(\.\d+)?$/.test(rawVal)) {
    const n = Number(rawVal);
    if (!Number.isInteger(n)) {
      throw new Error(
        `Property default ${rawVal} is not an integer in "${line}" — Gimkit stores whole numbers only. Scale it (e.g. ×100 → ${Math.round(n * 100)}) and divide in block code.`,
      );
    }
    return n;
  }
  if (/^(true|false)$/i.test(rawVal)) return rawVal.toLowerCase() === "true";
  return unquote(rawVal);
}

/** Literal option value: number, "text", yes/no/true/false, or a bare word. */
function parseOptionValue(raw) {
  const v = String(raw).trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^(false|no|off)$/i.test(v)) return false;
  return unquote(v);
}

/**
 * Parse trailing device options (`hidden delay 2 max 1`, `message "Go"`, `size 24`)
 * against the DEVICE_OPTIONS table for that device kind.
 */
function parseDeviceOptions(rest, deviceKind, line) {
  const table = DEVICE_OPTIONS[deviceKind] || {};
  const toks = words(rest);
  const options = [];
  for (let i = 0; i < toks.length; i += 1) {
    const key = toks[i].toLowerCase();
    const spec = table[key];
    if (!spec) {
      const allowed = Object.keys(table).join(", ");
      throw new Error(`Unknown ${deviceKind} option "${toks[i]}" in "${line}" — allowed: ${allowed}${allowed ? "" : "(none)"}. For anything else use: option "${deviceKind} name" "Sidebar Label" = value`);
    }
    if (spec.flag) {
      options.push({ key, label: spec.label, display: spec.display, kind: spec.kind, value: spec.value });
      continue;
    }
    const raw = toks[i + 1];
    if (raw == null) throw new Error(`Option "${toks[i]}" needs a value in "${line}"`);
    i += 1;
    const value = parseOptionValue(raw);
    if (spec.kind === "number" && typeof value !== "number") throw new Error(`Option "${key}" needs a number in "${line}", got ${JSON.stringify(value)}`);
    options.push({ key, label: spec.label, display: spec.display, kind: spec.kind, value });
  }
  return options;
}

/** Index of the first `{` or `:` that is outside quotes (and not inside a `{prop}` ref). */
function findBodyStart(s) {
  let inStr = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\") i += 1;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === "{" || ch === ":") return i;
  }
  return -1;
}

/** Header of a blocks command: [at POS] [on CH | when triggered | when "Event"] [append|clear|replace]. */
function parseBlocksHeader(header, name, line) {
  const out = { at: null, mode: "replace", event: undefined };
  const toks = words(header);
  for (let i = 0; i < toks.length; i += 1) {
    const w = toks[i].toLowerCase();
    if (w === "at") {
      const pos = toks[i + 1];
      if (!pos) throw new Error(`blocks "${name}": "at" needs a position in "${line}"`);
      // `at 100, 200` may have been split into several words
      let spec = pos;
      let j = i + 1;
      while (/,\s*$/.test(spec) || (/^-?\d+$/.test(spec) && toks[j + 1] === ",")) {
        j += 1;
        spec += toks[j] || "";
      }
      if (/^-?\d+,$/.test(spec) && toks[j + 1]) {
        j += 1;
        spec += toks[j];
      }
      if (!new RegExp(`^(?:${POS})$`).test(spec)) throw new Error(`blocks "${name}": bad position "${spec}" in "${line}"`);
      out.at = spec;
      i = j;
    } else if (w === "on" || w === "receiving" || w === "receives") {
      let j = i + 1;
      if (toks[j] && /^(channel|on)$/i.test(toks[j])) j += 1;
      const ch = toks[j];
      if (!ch) throw new Error(`blocks "${name}": "on" needs a channel name in "${line}"`);
      out.event = { kind: "channel", channel: unquote(ch) };
      i = j;
    } else if (w === "when") {
      const what = toks[i + 1];
      if (!what) throw new Error(`blocks "${name}": "when" needs an event, e.g. when triggered  |  when "Button Pressed"  |  on <channel>`);
      const lw = what.toLowerCase();
      if (lw === "triggered") out.event = { kind: "triggered" };
      else if (lw === "receiving" || lw === "receives") {
        let j = i + 2;
        if (toks[j] && /^(on|channel)$/i.test(toks[j])) j += 1;
        if (toks[j] && /^(on|channel)$/i.test(toks[j])) j += 1;
        if (!toks[j]) throw new Error(`blocks "${name}": "when receiving" needs a channel in "${line}"`);
        out.event = { kind: "channel", channel: unquote(toks[j]) };
        i = j;
        continue;
      } else out.event = { kind: "custom", label: unquote(what) };
      i += 1;
    } else if (w === "append" || w === "clear" || w === "replace") {
      out.mode = w;
    } else {
      throw new Error(`blocks "${name}": unexpected "${toks[i]}" in the header of "${line}" — expected [at <pos>] [on <channel> | when triggered] [append]`);
    }
  }
  return out;
}

/**
 * Parse one command line → action object (positions unresolved: `at` is a spec string
 * or null; `name` may be used to look the position up). Returns null for blank.
 */
export function parseCommand(line) {
  const l = line.trim();
  if (!l) return null;
  let m;

  if ((m = l.match(/^layout\s+(.+)$/i))) {
    const a = { kind: "layout" };
    let mm;
    if ((mm = m[1].match(/origin\s+(-?\d+)\s*,\s*(-?\d+)/i))) {
      a.originX = Number(mm[1]);
      a.originY = Number(mm[2]);
    }
    if ((mm = m[1].match(/gap\s+(\d+)\s*,\s*(\d+)/i))) {
      a.gapX = Number(mm[1]);
      a.gapY = Number(mm[2]);
    }
    if ((mm = m[1].match(/fit\s+(\d+)\s*(?:rows?)?\s*[x,]\s*(\d+)/i))) {
      a.fitRows = Number(mm[1]);
      a.fitCols = Number(mm[2]);
    }
    if (a.originX == null && a.gapX == null && a.fitRows == null) throw new Error(`Cannot parse layout command: "${line}" — use "layout origin X,Y gap X,Y" or "layout fit ROWSxCOLS"`);
    return a;
  }

  if (/^prepare$/i.test(l)) return { kind: "prepare" };
  if ((m = l.match(/^wait\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?$/i))) {
    const unit = (m[2] || "ms").toLowerCase();
    const ms = Math.round(Number(m[1]) * (unit === "ms" ? 1 : 1000));
    if (unit === "ms" && !Number.isInteger(Number(m[1]))) throw new Error(`Cannot parse wait command: "${line}" — milliseconds must be whole (or use seconds: wait 1.5s)`);
    return { kind: "wait", ms };
  }
  if (/^wait\b/i.test(l)) throw new Error(`Cannot parse wait command: "${line}" — use "wait 500", "wait 500ms" or "wait 1.5s"`);
  if ((m = l.match(/^click\s+(-?\d+)\s*,\s*(-?\d+)$/i))) return { kind: "click", x: Number(m[1]), y: Number(m[2]) };
  if ((m = l.match(/^press\s+(\S+)$/i))) return { kind: "press", key: normalizeKey(m[1]) };
  if ((m = l.match(/^screenshot(?:\s+(\S+))?$/i))) return { kind: "screenshot", name: m[1] || undefined };
  if ((m = l.match(/^(?:note|say|#)\s*(.*)$/i))) return { kind: "note", text: m[1] };

  // place <type> ["Name"] at <pos>
  if ((m = l.match(/^(?:place|add|put)\s+(.+)$/i))) {
    const { head, at } = splitAt(m[1]);
    if (!head) throw new Error(`Cannot parse place command: "${line}" — missing device type`);
    const { type, rest, quotedType, unknownMultiWord } = splitDeviceType(head, line);
    if (!/^[A-Za-z][A-Za-z0-9 /'-]*$/.test(type)) throw new Error(`Cannot parse place command: "${line}" — bad device type "${type}"`);
    const name = parseDeviceName(rest, line);
    if (!at && !name) throw new Error(`Cannot parse place command: "${line}" — needs "at <pos>" (unnamed devices cannot be looked up later)`);
    const a = { kind: "place", deviceType: normalizeDeviceType(type), name, at };
    if (quotedType) a.quotedType = true;
    if (unknownMultiWord) a.unknownType = true;
    return a;
  }

  // property <name> = <value> [type Number] [scope global] [at <pos>]
  if ((m = l.match(/^(?:set\s+)?(?:property|prop)\s+(.+)$/i))) {
    const { head, at } = splitAt(m[1]);
    const mm = head.match(
      new RegExp(`^("[^"]+"|'[^']+'|[A-Za-z0-9_\\-.]+)\\s*=\\s*(-?[0-9][0-9.]*|"[^"]*"|'[^']*'|true|false)((?:\\s+(?:type|scope)\\s+\\S+)*)$`, "i"),
    );
    if (!mm) {
      if (/^[A-Za-z0-9_\-.]+(\s+[A-Za-z0-9_\-.]+)+\s*=/.test(head)) {
        throw new Error(`Cannot parse property command: "${line}" — a property name with spaces must be quoted: property "${head.split("=")[0].trim()}" = ...`);
      }
      if (/=\s*(?=[^\s"'\d\-tf])/i.test(head) || /[{}+*/]/.test(head.split("=").slice(1).join("="))) {
        throw new Error(`Cannot parse property command: "${line}" — the default must be a literal (number, "text", true/false). To compute a value at runtime use blocks: blocks "Trigger" { property x = ... }`);
      }
      throw new Error(`Cannot parse property command: "${line}" — expected: property <name> = <value> [type Number|Text|True/False] [scope global|player|team] [at <pos>]`);
    }
    const value = parsePropertyValue(mm[2], line);
    const inferredType = typeof value === "number" ? "Number" : typeof value === "boolean" ? "True/False" : "Text";
    let propertyType = inferredType;
    let scope = "global";
    for (const opt of mm[3].matchAll(/(type|scope)\s+(\S+)/gi)) {
      const key = opt[1].toLowerCase();
      const val = opt[2];
      if (key === "type") {
        const t = PROPERTY_TYPES[String(val).toLowerCase()];
        if (!t) throw new Error(`Unknown property type "${val}" in "${line}" — use Number, Text or True/False`);
        propertyType = t;
      } else if (key === "scope") {
        const s = String(val).toLowerCase();
        if (!PROPERTY_SCOPES.has(s)) throw new Error(`Unknown property scope "${val}" in "${line}" — use global, player or team`);
        scope = s;
      }
    }
    if (propertyType !== inferredType) {
      throw new Error(`Property default ${JSON.stringify(value)} is ${inferredType} but type ${propertyType} was requested in "${line}"`);
    }
    const a = { kind: "property", name: unquote(mm[1]), default: value, propertyType, scope, at };
    if (typeof value === "number" && Math.abs(value) > Number.MAX_SAFE_INTEGER) a.warning = `Default ${mm[2]} is beyond the exact integer range (±2^53); Gimkit will round it`;
    return a;
  }

  // button "Name" transmits <channel> [message "..."] [at <pos>]
  if ((m = l.match(/^button\s+(.+)$/i))) {
    const { head, at } = splitAt(m[1]);
    const mm = head.match(new RegExp(`^(${NAME})\\s+(?:transmits?|sends?|broadcasts?|->|on|channel)\\s+(?:on\\s+)?(?:channel\\s+)?(${NAME})(?:\\s+(.*))?$`, "i"));
    if (!mm) throw new Error(`Cannot parse button command: "${line}" — expected: button "Name" transmits <channel> [message "..."] [at <pos>] (quote names/channels with spaces)`);
    const options = parseDeviceOptions(mm[3] || "", "button", line);
    return { kind: "button", name: unquote(mm[1]), channel: unquote(mm[2]), at, ...(options.length ? { options } : {}) };
  }

  // trigger "Name" receives <channel> [hidden|visible] [delay N] [max N] [at <pos>]
  if ((m = l.match(/^trigger\s+(.+)$/i))) {
    const { head, at } = splitAt(m[1]);
    const mm = head.match(new RegExp(`^(${NAME})\\s+(?:receives?|listens?(?:\\s+to)?|<-|on|channel)\\s+(?:on\\s+)?(?:channel\\s+)?(${NAME})(?:\\s+(.*))?$`, "i"));
    if (!mm) throw new Error(`Cannot parse trigger command: "${line}" — expected: trigger "Name" receives <channel> [hidden] [delay N] [max N] [at <pos>] (quote names/channels with spaces)`);
    const options = parseDeviceOptions(mm[3] || "", "trigger", line);
    return { kind: "trigger", name: unquote(mm[1]), channel: unquote(mm[2]), at, ...(options.length ? { options } : {}) };
  }

  // text "content" [size N] [at <pos>]
  if ((m = l.match(/^text\s+(.+)$/i))) {
    const { head, at } = splitAt(m[1]);
    let content = head;
    let options = [];
    const mm = head.match(/^("[^"]+"|'[^']+')\s+(.+)$/);
    if (mm) {
      content = mm[1];
      options = parseDeviceOptions(mm[2], "text", line);
    }
    content = unquote(content);
    if (!content) throw new Error(`Cannot parse text command: "${line}" — missing content`);
    return { kind: "text", text: content, name: content, at, ...(options.length ? { options } : {}) };
  }

  // option "Device" "Label" = value [at <pos>]
  if ((m = l.match(/^(?:option|set\s+option|setting)\s+(.+)$/i))) {
    const { head, at } = splitAt(m[1]);
    const mm = head.match(new RegExp(`^(${NAME})\\s+("[^"]+"|'[^']+')\\s*=\\s*(.+)$`));
    if (!mm) throw new Error(`Cannot parse option command: "${line}" — expected: option "Device Name" "Sidebar Label" = value [at <pos>]`);
    const value = parseOptionValue(mm[3]);
    return { kind: "option", name: unquote(mm[1]), label: unquote(mm[2]), value, at };
  }

  // blocks "Name" [at <pos>] [on <channel> | when triggered] [append|clear] { program }   |   blocks "Name" [...]: one-liner
  if ((m = l.match(new RegExp(`^blocks?\\s+(${NAME})([\\s\\S]*)$`, "i")))) {
    const name = unquote(m[1]);
    const rest = m[2];
    const bodyAt = findBodyStart(rest);
    if (bodyAt < 0) throw new Error(`Cannot parse blocks command: "${l.split("\n")[0]}" — expected: blocks "Name" [at <pos>] [on <channel>] [append] { ... }  or  blocks "Name": <one statement>`);
    const header = rest.slice(0, bodyAt).trim();
    let program;
    if (rest[bodyAt] === "{") {
      const body = rest.slice(bodyAt + 1);
      const close = body.lastIndexOf("}");
      if (close < 0 || body.slice(close + 1).trim()) throw new Error(`blocks "${name}": the program body must end with "}"`);
      program = body.slice(0, close).trim();
    } else {
      program = rest.slice(bodyAt + 1).trim();
    }
    const { at, mode, event } = parseBlocksHeader(header, name, l.split("\n")[0]);
    if (!program) throw new Error(`blocks "${name}" has an empty program in "${l.split("\n")[0]}"`);
    let ast;
    try {
      ast = parseProgram(program);
    } catch (err) {
      throw new Error(`blocks "${name}": ${err.message}`);
    }
    const { warnings } = lintProgram(ast);
    const a = {
      kind: "blocks",
      name,
      at,
      clear: mode !== "append",
      program,
      ast,
      warnings,
    };
    if (event) a.event = event;
    return a;
  }
  if (/^blocks?\s/i.test(l)) {
    throw new Error(`Cannot parse blocks command: "${l.split("\n")[0]}" — expected: blocks "Name" [at <pos>] [on <channel>] [append] { ... }  or  blocks "Name": <one statement>`);
  }

  if ((m = l.match(/^read\s+(?:property\s+)?(.+)$/i))) {
    const { head, at } = splitAt(m[1]);
    return { kind: "read", name: unquote(head) || undefined, at: at || (head ? head : null) };
  }

  throw new Error(`Unknown command: "${l.split("\n")[0]}"`);
}

/** Map friendly key names onto Playwright's. */
function normalizeKey(key) {
  const k = key.trim();
  if (k.length === 1) return k.toLowerCase();
  const parts = k.split("+").map((p) => {
    const lower = p.toLowerCase();
    const map = { ctrl: "Control", control: "Control", cmd: "Meta", meta: "Meta", alt: "Alt", shift: "Shift", esc: "Escape", escape: "Escape", enter: "Enter", return: "Enter", tab: "Tab", space: " ", del: "Delete", delete: "Delete", backspace: "Backspace" };
    if (map[lower]) return map[lower];
    return p.length === 1 ? lower : p[0].toUpperCase() + p.slice(1);
  });
  return parts.join("+");
}

/** Parse a whole `.gkc` script → array of unresolved actions. Throws with the line number on error. */
export function parseScript(src) {
  const actions = [];
  for (const { text, line } of splitLines(src)) {
    let a;
    try {
      a = parseCommand(text);
    } catch (err) {
      throw new Error(`Line ${line}: ${err.message}`);
    }
    if (a) actions.push({ ...a, line, source: text.split("\n")[0].slice(0, 80) });
  }
  return actions;
}
