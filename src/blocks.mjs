/**
 * Block programs: write Gimkit block code as text, compile to an AST, build it
 * in the device's Blockly workspace via the Blockly API (no mouse dragging).
 *
 * Text syntax (one statement per line or `;`-separated):
 *
 *   set A = {input1}                      // variable A = Get Property "input1"
 *   set Z1 = {bias1} + A * {weight1-1}    // arithmetic on vars/props/numbers (+ - * / %)
 *   if Z1 < 0 then set Z1 = 0             // single-line if [else <stmt>]
 *   if A > 1 and B == 0 { ... }           // and / or / not, true / false
 *   if A > 1 { ... } else if A < 0 { ... } else { ... }
 *   property output1 = A                  // Set Property "output1" = A
 *   property net = round(({H1}*{w31} + H2*{w32}) / 100 + {bias3})
 *   property label = "hello"              // text literal → Text block
 *   text = "XOR = " + {net_output}        // Set Text (Text devices); + with text = join
 *   broadcast "nn-done"                   // Broadcast Message On Channel
 *   relu H1                               // sugar: if H1 < 0 then set H1 = 0
 *   var X                                 // declare a variable read before it is set
 *   block "Add Activity Feed Item For All Players" "Hello"   // any Gimkit block by its name
 *   # comment  |  // comment
 *
 * Functions: round floor ceil abs sqrt random(a,b) text(x) number(x) len(x)
 * Player data: player.name player.team player.score ("Triggering Player's ...")
 *
 * Identifiers: bare `A` = variable, `{name}` or prop(name) = Property device.
 * Anything goes inside braces: {weight1-1} {Forward Pass} {Score ✓}. Bare
 * identifiers are letters/digits/underscore only — `weight1-1` outside braces
 * is `weight1 - 1`, which the linter rejects (variable never assigned).
 */

// Inner text of `{...}` that counts as a property reference (vs. an if-block body):
// starts with a non-space, contains no `{ } = ;` or newline (statement bodies do).
export const PROP_REF_INNER = /^[^\s{}=;\n][^{}=;\n]*$/;
export const PROP_REF_RE = /\{[^\s{}=;\n][^{}=;\n]*\}/g;

/** Gimkit's per-workspace block cap (documented "75 blocks per block code"). */
export const BLOCK_CAP = 75;

const KEYWORDS = new Set(["if", "else", "then", "set", "let", "var", "declare", "property", "prop", "relu", "broadcast", "text", "block", "and", "or", "not", "true", "false", "settext"]);
const TEXT_FUNCS = new Set(["text", "str", "tostring"]);

// ---------------------------------------------------------------- tokenizer
function readString(s, i) {
  const q = s[i];
  let out = "";
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === "\\" && j + 1 < s.length) {
      const nx = s[j + 1];
      out += nx === "n" ? "\n" : nx === "t" ? "\t" : nx;
      j += 2;
      continue;
    }
    if (ch === q) return { value: out, end: j + 1 };
    if (ch === "\n") break;
    out += ch;
    j += 1;
  }
  throw new Error(`Unclosed string starting at column ${i + 1}`);
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const s = String(src);
  const push = (t, v, start) => tokens.push({ t, v, pos: start, end: i });
  while (i < s.length) {
    const ch = s[i];
    const start = i;
    if (ch === "\n") {
      i += 1;
      push("nl", "\n", start);
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if ((ch === "/" && s[i + 1] === "/") || (ch === "#" && (i === 0 || /[\s;]/.test(s[i - 1])))) {
      while (i < s.length && s[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "{") {
      const end = s.indexOf("}", i);
      const inner = end < 0 ? "" : s.slice(i + 1, end);
      if (end >= 0 && PROP_REF_INNER.test(inner)) {
        i = end + 1;
        push("prop", inner.trim(), start);
        continue;
      }
      i += 1;
      push("op", "{", start);
      continue;
    }
    if (ch === '"' || ch === "'") {
      const r = readString(s, i);
      i = r.end;
      push("str", r.value, start);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(s[i + 1] || ""))) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j += 1;
      const raw = s.slice(i, j);
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`Bad number "${raw}"`);
      i = j;
      push("num", n, start);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j += 1;
      i = j;
      push("id", s.slice(start, j), start);
      continue;
    }
    const two = s.slice(i, i + 2);
    if (["<=", ">=", "==", "!=", "<>", "&&", "||"].includes(two)) {
      i += 2;
      push("op", two === "<>" ? "!=" : two === "&&" ? "and" : two === "||" ? "or" : two, start);
      continue;
    }
    if (ch === "." && /[A-Za-z_]/.test(s[i + 1] || "")) {
      i += 1;
      push("op", ".", start);
      continue;
    }
    if (ch === "!") {
      i += 1;
      push("op", "not", start);
      continue;
    }
    if ("+-*/%()<>=,;}".includes(ch)) {
      i += 1;
      push("op", ch, start);
      continue;
    }
    throw new Error(`Unexpected character "${ch}" at column ${i + 1}`);
  }
  push("eof", null, i);
  return tokens;
}

// ---------------------------------------------------------------- type helpers
/** Does this expression produce text (so `+` means join)? */
export function isTextExpr(e, propTypes = null) {
  if (!Array.isArray(e)) return false;
  const k = e[0];
  if (k === "text" || k === "join" || k === "tostr") return true;
  if (k === "player" && e[1] === "name") return true;
  if (k === "prop" && propTypes) {
    const t = propTypes.get ? propTypes.get(e[1]) : propTypes[e[1]];
    return /text/i.test(t || "");
  }
  return false;
}

/** Rewrite `+` into `join` wherever an operand is text-typed (bottom-up). */
export function retypeExpr(e, propTypes = null) {
  if (!Array.isArray(e)) return e;
  const k = e[0];
  if (k === "num" || k === "text" || k === "bool" || k === "prop" || k === "var" || k === "player") return e;
  const out = [k, ...e.slice(1).map((c) => (Array.isArray(c) ? retypeExpr(c, propTypes) : c))];
  if (k === "+" && (isTextExpr(out[1], propTypes) || isTextExpr(out[2], propTypes))) out[0] = "join";
  return out;
}

export function retypeProgram(program, propTypes = null) {
  const visit = (list) =>
    (list || []).map((s) => {
      const c = { ...s };
      if (c.expr) c.expr = retypeExpr(c.expr, propTypes);
      if (c.cond) c.cond = retypeExpr(c.cond, propTypes);
      if (c.then) c.then = visit(c.then);
      if (c.else) c.else = visit(c.else);
      if (c.args) c.args = c.args.map((a) => ({ ...a, expr: retypeExpr(a.expr, propTypes) }));
      return c;
    });
  return { statements: visit(program.statements) };
}

// ---------------------------------------------------------------- parser
const CMP_OPS = ["<", ">", "<=", ">=", "==", "!=", "="];

class Parser {
  constructor(src) {
    this.src = String(src);
    this.toks = tokenize(this.src);
    this.i = 0;
  }
  peek(off = 0) {
    return this.toks[Math.min(this.i + off, this.toks.length - 1)];
  }
  next() {
    const t = this.toks[this.i];
    if (this.i < this.toks.length - 1) this.i += 1;
    return t;
  }
  isOp(v) {
    const p = this.peek();
    return p.t === "op" && p.v === v;
  }
  isKw(v) {
    const p = this.peek();
    return (p.t === "id" && p.v.toLowerCase() === v) || (p.t === "op" && p.v === v);
  }
  eatOp(v, what = "") {
    if (!this.isOp(v)) throw this.error(`Expected "${v}"${what ? ` ${what}` : ""} but found ${this.describe(this.peek())}`);
    return this.next();
  }
  describe(tok) {
    if (tok.t === "eof") return "end of program";
    if (tok.t === "nl") return "end of line";
    if (tok.t === "prop") return `{${tok.v}}`;
    if (tok.t === "str") return `"${tok.v}"`;
    return `"${tok.v}"`;
  }
  error(msg, tok = this.peek()) {
    const lineStart = this.src.lastIndexOf("\n", Math.max(0, tok.pos - 1)) + 1;
    let lineEnd = this.src.indexOf("\n", tok.pos);
    if (lineEnd < 0) lineEnd = this.src.length;
    const lineNo = this.src.slice(0, tok.pos).split("\n").length;
    const lineText = this.src.slice(lineStart, lineEnd).trim();
    return new Error(`${msg} (line ${lineNo}: "${lineText}")`);
  }
  skipSeparators() {
    while (this.peek().t === "nl" || this.isOp(";")) this.next();
  }
  /** Raw source text of the tokens from `from` (inclusive) to current position (exclusive). */
  rawSince(fromTok) {
    const last = this.toks[this.i - 1] || fromTok;
    return this.src.slice(fromTok.pos, last.end).trim();
  }
  atStatementEnd() {
    const p = this.peek();
    return p.t === "eof" || p.t === "nl" || this.isOp(";") || this.isOp("}");
  }

  // ---- expressions: or → and → not → comparison → sum → term → unary → primary
  parseExpr() {
    return this.parseOr();
  }
  parseCondition() {
    return this.parseOr();
  }
  parseOr() {
    let left = this.parseAnd();
    while (this.isKw("or")) {
      this.next();
      left = ["or", left, this.parseAnd()];
    }
    return left;
  }
  parseAnd() {
    let left = this.parseNot();
    while (this.isKw("and")) {
      this.next();
      left = ["and", left, this.parseNot()];
    }
    return left;
  }
  parseNot() {
    if (this.isKw("not")) {
      this.next();
      return ["not", this.parseNot()];
    }
    return this.parseComparison();
  }
  parseComparison() {
    const left = this.parseSum();
    const p = this.peek();
    if (p.t === "op" && CMP_OPS.includes(p.v)) {
      this.next();
      const right = this.parseSum();
      const q = this.peek();
      if (q.t === "op" && CMP_OPS.includes(q.v)) {
        throw this.error(`Chained comparisons are not supported — write "a ${p.v} b and b ${q.v} c"`, q);
      }
      return ["cmp", p.v === "=" ? "==" : p.v, left, right];
    }
    return left;
  }
  parseSum() {
    let left = this.parseTerm();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().v;
      left = [op, left, this.parseTerm()];
    }
    return left;
  }
  parseTerm() {
    let left = this.parseUnary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.next().v;
      left = [op, left, this.parseUnary()];
    }
    return left;
  }
  parseUnary() {
    if (this.isOp("-")) {
      this.next();
      const e = this.parseUnary();
      if (e[0] === "num") return ["num", -e[1]];
      return ["-", ["num", 0], e];
    }
    if (this.isOp("+")) {
      this.next();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }
  parseArgs(nameTok) {
    this.eatOp("(");
    const args = [];
    if (!this.isOp(")")) {
      args.push(this.parseExpr());
      while (this.isOp(",")) {
        this.next();
        args.push(this.parseExpr());
      }
    }
    this.eatOp(")", `to close ${nameTok.v}(`);
    return args;
  }
  parsePrimary() {
    const p = this.next();
    if (p.t === "num") return ["num", p.v];
    if (p.t === "prop") return ["prop", p.v];
    if (p.t === "str") return ["text", p.v];
    if (p.t === "op" && p.v === "(") {
      const e = this.parseExpr();
      this.eatOp(")", "to close the parenthesis");
      return e;
    }
    if (p.t === "id") {
      const name = p.v;
      const lower = name.toLowerCase();
      if (lower === "true" || lower === "false") return ["bool", lower === "true"];
      if (this.isOp("(")) {
        const args = this.parseArgs(p);
        const need = (n) => {
          if (args.length !== n) throw this.error(`${name}() takes exactly ${n} argument${n === 1 ? "" : "s"}`, p);
        };
        if (lower === "prop" || lower === "property" || lower === "get") {
          need(1);
          const a = args[0];
          return ["prop", a[0] === "prop" || a[0] === "var" || a[0] === "text" ? a[1] : String(a[1])];
        }
        if (["round", "floor", "ceil", "abs", "sqrt"].includes(lower)) {
          need(1);
          return [lower, args[0]];
        }
        if (lower === "random" || lower === "randint") {
          need(2);
          return ["random", args[0], args[1]];
        }
        if (TEXT_FUNCS.has(lower)) {
          need(1);
          return ["tostr", args[0]];
        }
        if (lower === "number" || lower === "num" || lower === "tonumber") {
          need(1);
          return ["tonum", args[0]];
        }
        if (lower === "len" || lower === "length") {
          need(1);
          return ["len", args[0]];
        }
        if (lower === "max" || lower === "min") {
          throw this.error(
            `${name}() has no Gimkit block. Use an if instead: "set X = a" then "if X ${lower === "max" ? "<" : ">"} b then set X = b" (or "relu X" for max(X, 0))`,
            p,
          );
        }
        throw this.error(`Unknown function ${name}() — known: round floor ceil abs sqrt random text number len prop`, p);
      }
      if (lower === "player" && this.isOp(".")) {
        this.next();
        const f = this.next();
        const field = (f.v || "").toString().toLowerCase();
        const map = { name: "name", team: "team", teamnumber: "team", score: "score" };
        if (f.t !== "id" || !map[field]) throw this.error(`Unknown player field "${f.v}" — use player.name, player.team or player.score`, f);
        return ["player", map[field]];
      }
      if (KEYWORDS.has(lower)) throw this.error(`Unexpected keyword "${name}" inside an expression`, p);
      return ["var", name];
    }
    if (p.t === "eof" || p.t === "nl") throw this.error("Expression is incomplete", p);
    throw this.error(`Unexpected ${this.describe(p)} in expression`, p);
  }

  // ---- statements
  parseStatements(inBlock = false) {
    const out = [];
    for (;;) {
      this.skipSeparators();
      const p = this.peek();
      if (p.t === "eof") {
        if (inBlock) throw this.error('Missing closing "}"', p);
        return out;
      }
      if (this.isOp("}")) {
        if (!inBlock) throw this.error('Unexpected "}" with no matching "{"', p);
        return out;
      }
      const s = this.parseStatement();
      if (s) out.push(s);
      this.endStatement();
    }
  }
  endStatement() {
    if (this.atStatementEnd()) return;
    const p = this.peek();
    if (this.isKw("else")) throw this.error('"else" must follow an if — put it on the same line as the closing "}" or after "then <statement>"', p);
    throw this.error(`Unexpected ${this.describe(p)} after statement — missing operator, newline or ";"?`, p);
  }
  parseBody(what) {
    const p = this.peek();
    if (p.t === "prop") {
      this.next();
      return parseProgram(p.v, { lint: false }).statements;
    }
    this.eatOp("{", `to start the ${what} body`);
    const body = this.parseStatements(true);
    this.eatOp("}", `to close the ${what} body`);
    return body;
  }
  elseFollows() {
    let j = this.i;
    while (this.toks[j] && this.toks[j].t === "nl") j += 1;
    const t = this.toks[j];
    if (t && t.t === "id" && t.v.toLowerCase() === "else") {
      this.i = j;
      return true;
    }
    return false;
  }
  parseStatement() {
    const p = this.peek();
    if (p.t !== "id") {
      if (p.t === "prop") throw this.error(`Cannot assign to {${p.v}} like that — write "property ${p.v} = <expr>"`, p);
      throw this.error(`Expected a statement but found ${this.describe(p)}`, p);
    }
    const kw = p.v.toLowerCase();
    const nextIsEq = this.peek(1).t === "op" && this.peek(1).v === "=";

    if (kw === "relu") {
      this.next();
      const id = this.next();
      if (id.t !== "id") throw this.error(`relu needs a variable name, found ${this.describe(id)}`, id);
      return { op: "if", cond: ["cmp", "<", ["var", id.v], ["num", 0]], then: [{ op: "setVar", name: id.v, expr: ["num", 0] }] };
    }
    if (kw === "if") return this.parseIf();
    if (kw === "else") throw this.error('"else" without a matching if', p);
    if (kw === "then") throw this.error('"then" without an if', p);

    if ((kw === "text" && nextIsEq) || kw === "settext") {
      this.next();
      if (this.isOp("=")) this.next();
      const expr = this.parseExpr();
      return { op: "setText", expr: retypeExpr(expr) };
    }

    if (kw === "set" || kw === "let" || kw === "var" || kw === "declare") {
      this.next();
      const nxt = this.peek();
      const nxtLower = nxt.t === "id" ? nxt.v.toLowerCase() : "";
      if (["property", "prop"].includes(nxtLower) && !(this.peek(1).t === "op" && this.peek(1).v === "=")) return this.parseSetProperty();
      if (nxtLower === "text" && this.peek(1).t === "op" && this.peek(1).v === "=") {
        this.next();
        this.next();
        return { op: "setText", expr: retypeExpr(this.parseExpr()) };
      }
      const id = this.next();
      if (id.t !== "id") throw this.error(`${p.v} needs a variable name, found ${this.describe(id)}`, id);
      if (KEYWORDS.has(id.v.toLowerCase())) throw this.error(`"${id.v}" is a keyword and cannot be a variable name`, id);
      if ((kw === "var" || kw === "declare") && !this.isOp("=")) return { op: "declare", name: id.v };
      this.eatOp("=", `after variable name "${id.v}"`);
      return { op: "setVar", name: id.v, expr: retypeExpr(this.parseExpr()) };
    }

    if (kw === "property" || kw === "prop") return this.parseSetProperty();

    if (kw === "broadcast") {
      this.next();
      if (this.isKw("on")) this.next();
      if (this.isKw("channel")) this.next();
      const first = this.peek();
      if (first.t === "str" || first.t === "prop") {
        this.next();
        return { op: "broadcast", channel: first.v };
      }
      if (first.t !== "id" && first.t !== "num") throw this.error("broadcast needs a channel name", first);
      while (!this.atStatementEnd()) this.next();
      return { op: "broadcast", channel: this.rawSince(first) };
    }

    if (kw === "block" || kw === "call") return this.parseGenericBlock();

    // Bare assignment: `A = expr`
    if (nextIsEq) {
      const id = this.next();
      this.next();
      if (KEYWORDS.has(id.v.toLowerCase())) throw this.error(`"${id.v}" is a keyword and cannot be a variable name`, id);
      return { op: "setVar", name: id.v, expr: retypeExpr(this.parseExpr()) };
    }

    throw this.error(`Cannot parse block statement starting with "${p.v}"`, p);
  }
  parseSetProperty() {
    const kwTok = this.next(); // property | prop
    const first = this.peek();
    let name;
    if (first.t === "prop" || first.t === "str") {
      this.next();
      name = first.v;
    } else {
      if (first.t !== "id" && first.t !== "num") throw this.error("property needs a name", first);
      while (!this.isOp("=") && !["eof", "nl"].includes(this.peek().t)) this.next();
      name = this.rawSince(first);
      if (!name) throw this.error("property needs a name", kwTok);
    }
    this.eatOp("=", `after property name "${name}"`);
    const expr = retypeExpr(this.parseExpr());
    if (expr[0] === "round") return { op: "setPropRound", prop: name, expr: expr[1] };
    return { op: "setProp", prop: name, expr };
  }
  /** block "<visible block name>" [key = expr | expr] [, ...] */
  parseGenericBlock() {
    const kwTok = this.next();
    const nameTok = this.next();
    if (nameTok.t !== "str") throw this.error(`${kwTok.v} needs the block's visible name in quotes, e.g. block "Add Activity Feed Item For All Players" "Hi"`, nameTok);
    const args = [];
    while (!this.atStatementEnd()) {
      if (this.isOp(",")) {
        this.next();
        continue;
      }
      let key;
      if (this.peek().t === "id" && this.peek(1).t === "op" && this.peek(1).v === "=") {
        key = this.next().v;
        this.next();
      }
      args.push({ key, expr: retypeExpr(this.parseExpr()) });
    }
    return { op: "block", name: nameTok.v, args };
  }
  parseIf() {
    const ifTok = this.next();
    const cond = retypeExpr(this.parseExpr());
    const node = { op: "if", cond };
    if (this.isKw("then")) {
      this.next();
      const s = this.parseStatement();
      node.then = s ? [s] : [];
      if (this.isKw("else")) {
        this.next();
        const e = this.parseStatement();
        node.else = e ? [e] : [];
      }
      return node;
    }
    if (!this.isOp("{") && this.peek().t !== "prop") {
      throw this.error(`if needs "then <statement>" or a "{ ... }" body, found ${this.describe(this.peek())}`, ifTok);
    }
    node.then = this.parseBody("if");
    if (this.elseFollows()) {
      this.next();
      if (this.isKw("if")) node.else = [this.parseIf()];
      else node.else = this.parseBody("else");
    }
    return node;
  }
}

export function parseExpression(src) {
  const p = new Parser(src);
  const e = p.parseExpr();
  if (p.peek().t !== "eof") throw p.error(`Trailing tokens in expression: ${p.describe(p.peek())}`);
  return retypeExpr(e);
}

/**
 * Parse a block program (text) → { statements: [...] }. Accepts an existing AST too.
 * Throws with line context on syntax errors and on lint errors (see lintProgram).
 */
export function parseProgram(src, { lint = true, propTypes = null } = {}) {
  if (src && typeof src === "object" && Array.isArray(src.statements)) return src;
  if (Array.isArray(src)) return { statements: src };
  const p = new Parser(src || "");
  const statements = p.parseStatements(false);
  const program = { statements };
  if (lint) {
    const { errors } = lintProgram(program, { propTypes });
    if (errors.length) throw new Error(errors.join("\n"));
  }
  return program;
}

// ---------------------------------------------------------------- lint
const LEAF = new Set(["num", "text", "bool", "prop", "var", "player"]);
const ARITH = new Set(["+", "-", "*", "/", "%"]);
const NUMERIC_FUNCS = new Set(["round", "floor", "ceil", "abs", "sqrt", "random", "tonum", "len"]);

export function walkExpr(e, fn) {
  if (!Array.isArray(e)) return;
  fn(e);
  if (LEAF.has(e[0])) return;
  for (const child of e.slice(1)) walkExpr(child, fn);
}

/** Static type of an expression: "number" | "text" | "bool" | null (unknown). */
export function exprType(e, propTypes = null) {
  if (!Array.isArray(e)) return null;
  const k = e[0];
  if (k === "num" || ARITH.has(k) || NUMERIC_FUNCS.has(k)) return "number";
  if (k === "text" || k === "join" || k === "tostr") return "text";
  if (k === "bool" || k === "cmp" || k === "and" || k === "or" || k === "not") return "bool";
  if (k === "player") return e[1] === "name" ? "text" : "number";
  if (k === "prop" && propTypes) {
    const t = propTypes.get ? propTypes.get(e[1]) : propTypes[e[1]];
    if (/number/i.test(t || "")) return "number";
    if (/text/i.test(t || "")) return "text";
    if (/true/i.test(t || "")) return "bool";
  }
  return null;
}

/**
 * Semantic checks that the Blockly build cannot catch:
 *  - a variable read before any assignment (almost always a forgotten `{...}`)
 *  - text used in arithmetic, comparing text with numbers, division by zero
 *  - Set Property with a value of the wrong type (when property types are known)
 *  - block count over Gimkit's cap (warning)
 */
export function lintProgram(program, { propTypes = null } = {}) {
  const errors = [];
  const warnings = [];
  const assigned = new Set();
  const propsRead = new Set();
  const propsWritten = new Set();
  const channelsBroadcast = new Set();
  let setsText = false;
  let usesPlayer = false;
  const typeOf = (e) => exprType(e, propTypes);

  const checkExpr = (e, where) => {
    walkExpr(e, (node) => {
      const [k] = node;
      if (k === "var" && !assigned.has(node[1])) {
        errors.push(`Variable "${node[1]}" is read before it is set in "${where}" — did you mean the property {${node[1]}}? (or declare it: var ${node[1]})`);
        assigned.add(node[1]); // report once
      }
      if (k === "prop") propsRead.add(node[1]);
      if (k === "player") usesPlayer = true;
      if (ARITH.has(k) || k === "random" || ["round", "floor", "ceil", "abs", "sqrt"].includes(k)) {
        for (const side of node.slice(1)) {
          const t = typeOf(side);
          if (t === "text") errors.push(`Text ${describeExpr(side)} used in arithmetic in "${where}" — use number(x) to convert`);
          if (t === "bool") errors.push(`A true/false value is used in arithmetic in "${where}"`);
        }
      }
      if (k === "cmp") {
        const a = typeOf(node[2]);
        const b = typeOf(node[3]);
        if (a && b && a !== b) errors.push(`Comparing ${a} with ${b} in "${where}" — Gimkit compares values of the same type only`);
        if (["<", ">", "<=", ">="].includes(node[1]) && (a === "text" || b === "text")) errors.push(`Ordering comparison on text in "${where}"`);
      }
      if ((k === "and" || k === "or") && [node[1], node[2]].some((s) => typeOf(s) && typeOf(s) !== "bool")) errors.push(`${k} needs true/false operands in "${where}" — compare first, e.g. A > 0 and B > 0`);
      if (k === "not" && typeOf(node[1]) && typeOf(node[1]) !== "bool") errors.push(`not needs a true/false operand in "${where}"`);
      if (k === "/" && Array.isArray(node[2]) && node[2][0] === "num" && node[2][1] === 0) errors.push(`Division by zero in "${where}"`);
      if (k === "%" && Array.isArray(node[2]) && node[2][0] === "num" && node[2][1] === 0) errors.push(`Modulo by zero in "${where}"`);
      if (k === "num" && Math.abs(node[1]) > Number.MAX_SAFE_INTEGER) warnings.push(`Number ${node[1]} is beyond Gimkit's exact integer range in "${where}"`);
    });
  };
  const visit = (list) => {
    for (const s of list || []) {
      const where = formatProgram({ statements: [s] }).split("\n")[0];
      if (s.op === "declare") assigned.add(s.name);
      else if (s.op === "setVar") {
        checkExpr(s.expr, where);
        assigned.add(s.name);
      } else if (s.op === "setProp" || s.op === "setPropRound") {
        checkExpr(s.expr, where);
        propsWritten.add(s.prop);
        if (propTypes) {
          const declared = propTypes.get ? propTypes.get(s.prop) : propTypes[s.prop];
          const t = s.op === "setPropRound" ? "number" : typeOf(s.expr);
          if (declared && t) {
            const want = /number/i.test(declared) ? "number" : /text/i.test(declared) ? "text" : "bool";
            if (want !== t) errors.push(`Property "${s.prop}" is ${declared} but "${where}" assigns a ${t} value`);
          }
        }
        if (s.op === "setPropRound") {
          const t = typeOf(s.expr);
          if (t && t !== "number") errors.push(`round() needs a number in "${where}"`);
        }
      } else if (s.op === "setText") {
        checkExpr(s.expr, where);
        setsText = true;
      } else if (s.op === "broadcast") channelsBroadcast.add(s.channel);
      else if (s.op === "block") for (const a of s.args || []) checkExpr(a.expr, where);
      else if (s.op === "if") {
        checkExpr(s.cond, where);
        const t = typeOf(s.cond);
        if (t && t !== "bool") warnings.push(`if condition "${where}" is a ${t}, not a comparison — Gimkit treats it as "!= 0"`);
        visit(s.then);
        visit(s.else);
      }
    }
  };
  visit(program.statements);

  const n = estimateBlockCount(program);
  if (n > BLOCK_CAP) warnings.push(`Program needs ~${n} blocks; Gimkit refuses more than ${BLOCK_CAP} per block code — split it across triggers`);
  return {
    errors,
    warnings,
    propsRead: [...propsRead],
    propsWritten: [...propsWritten],
    channelsBroadcast: [...channelsBroadcast],
    setsText,
    usesPlayer,
    blockEstimate: n,
  };
}

function describeExpr(e) {
  if (!Array.isArray(e)) return String(e);
  if (e[0] === "text") return JSON.stringify(e[1]);
  return fmtExpr(e);
}

// ---------------------------------------------------------------- formatting
function fmtExpr(e) {
  if (!Array.isArray(e)) return String(e);
  const [k, a, b] = e;
  if (k === "num") return String(a);
  if (k === "prop") return `{${a}}`;
  if (k === "var") return a;
  if (k === "text") return JSON.stringify(a);
  if (k === "bool") return a ? "true" : "false";
  if (k === "player") return `player.${a}`;
  if (["round", "floor", "ceil", "abs", "sqrt", "len"].includes(k)) return `${k}(${fmtExpr(a)})`;
  if (k === "tostr") return `text(${fmtExpr(a)})`;
  if (k === "tonum") return `number(${fmtExpr(a)})`;
  if (k === "random") return `random(${fmtExpr(a)}, ${fmtExpr(b)})`;
  if (k === "cmp") return `${fmtExpr(e[2])} ${a} ${fmtExpr(e[3])}`;
  if (k === "not") return `not ${fmtExpr(a)}`;
  if (k === "and" || k === "or") return `(${fmtExpr(a)} ${k} ${fmtExpr(b)})`;
  if (k === "join") return `(${fmtExpr(a)} + ${fmtExpr(b)})`;
  return `(${fmtExpr(a)} ${k} ${fmtExpr(b)})`;
}

/** Pretty-print an AST back to text (used by dry-run / docs). */
export function formatProgram(program, indent = "") {
  const propName = (n) => (/^[A-Za-z0-9_]+$/.test(n) ? n : `{${n}}`);
  const lines = [];
  for (const s of program.statements) {
    if (s.op === "declare") lines.push(`${indent}var ${s.name}`);
    else if (s.op === "setVar") lines.push(`${indent}set ${s.name} = ${fmtExpr(s.expr)}`);
    else if (s.op === "setProp") lines.push(`${indent}property ${propName(s.prop)} = ${fmtExpr(s.expr)}`);
    else if (s.op === "setPropRound") lines.push(`${indent}property ${propName(s.prop)} = round(${fmtExpr(s.expr)})`);
    else if (s.op === "setText") lines.push(`${indent}text = ${fmtExpr(s.expr)}`);
    else if (s.op === "reluClamp") lines.push(`${indent}relu ${s.name}`);
    else if (s.op === "broadcast") lines.push(`${indent}broadcast "${s.channel}"`);
    else if (s.op === "block") lines.push(`${indent}block ${JSON.stringify(s.name)}${(s.args || []).map((a) => ` ${a.key ? `${a.key} = ` : ""}${fmtExpr(a.expr)}`).join(",")}`);
    else if (s.op === "if") {
      lines.push(`${indent}if ${fmtExpr(s.cond)} {`);
      lines.push(formatProgram({ statements: s.then || [] }, indent + "  "));
      if (s.else) {
        lines.push(`${indent}} else {`);
        lines.push(formatProgram({ statements: s.else }, indent + "  "));
      }
      lines.push(`${indent}}`);
    }
  }
  return lines.filter((l) => l !== "").join("\n");
}

/** Count Blockly pieces the program will create (Gimkit caps 75 per block code). */
export function estimateBlockCount(program) {
  const countE = (e) => {
    if (!Array.isArray(e)) return 0;
    const [k] = e;
    if (LEAF.has(k)) return 1;
    if (k === "cmp") return 1 + countE(e[2]) + countE(e[3]);
    return 1 + e.slice(1).reduce((n, c) => n + countE(c), 0);
  };
  let n = 0;
  for (const s of program.statements) {
    if (s.op === "setVar" || s.op === "setProp" || s.op === "setText") n += 1 + countE(s.expr);
    else if (s.op === "setPropRound") n += 2 + countE(s.expr);
    else if (s.op === "reluClamp") n += 5;
    else if (s.op === "broadcast") n += 1;
    else if (s.op === "block") n += 1 + (s.args || []).reduce((m, a) => m + countE(a.expr), 0);
    else if (s.op === "if") {
      n += 1 + countE(s.cond) + estimateBlockCount({ statements: s.then || [] });
      if (s.else) n += estimateBlockCount({ statements: s.else });
    }
  }
  return n;
}

// ---------------------------------------------------------------- in-page builder
/**
 * Runs inside the Gimkit page. Discovers block types from the live Blockly
 * registry (names vary), builds the AST, chains statements, attaches under
 * the event hat block, and reports back. Every construct whose block type is
 * not found is listed in `unsupported` so the caller fails loudly instead of
 * building a wrong program.
 *
 * opts.clear (default true): remove every existing statement (including the
 * chain hanging under the hat) so re-running a script is idempotent.
 */
export const IN_PAGE_BUILDER = `
function gkcBuild(program, opts) {
  opts = Object.assign({ clear: true }, opts || {});
  const B = window.Blockly;
  if (!B) return { ok: false, reason: "no-blockly" };
  const ws = B.getMainWorkspace && B.getMainWorkspace();
  if (!ws) return { ok: false, reason: "no-workspace" };

  const registry = Object.keys(B.Blocks || {});
  const findType = (candidates, re) => {
    for (const c of candidates) if (B.Blocks[c]) return c;
    const hit = registry.find((t) => re.test(t));
    return hit || null;
  };

  const T = {
    setProp: findType(["gamHud_setProperty","set_property","properties_set","setProperty"], /set.*propert/i),
    getProp: findType(["gamHud_getProperty","get_property","properties_get","getProperty"], /get.*propert/i),
    setVar:  findType(["variables_set"], /variables?_set|set.*variable/i),
    getVar:  findType(["variables_get"], /variables?_get|get.*variable/i),
    num:     findType(["math_number"], /math_number|^number$/i),
    text:    findType(["text"], /^text$|text_literal/i),
    bool:    findType(["logic_boolean"], /logic_boolean/i),
    arith:   findType(["math_arithmetic"], /math_arithmetic|arithmetic/i),
    modulo:  findType(["math_modulo"], /math_modulo|modulo|remainder/i),
    compare: findType(["logic_compare"], /logic_compare|compare/i),
    logicOp: findType(["logic_operation"], /logic_operation/i),
    negate:  findType(["logic_negate"], /logic_negate/i),
    ifb:     findType(["controls_if"], /controls_if|^if/i),
    round:   findType(["math_round"], /math_round/i),
    single:  findType(["math_single"], /math_single/i),
    random:  findType(["math_random_int"], /random_int|random.*int/i),
    join:    findType(["text_join"], /text_join|create.*text/i),
    length:  findType(["text_length"], /text_length/i),
    tostr:   findType(["convert_number_to_text","number_to_text","gamHud_numberToText"], /number.*to.*text|to_?text|numtotext/i),
    tonum:   findType(["convert_text_to_number","text_to_number","gamHud_textToNumber"], /text.*to.*number|to_?number|texttonum/i),
    setText: findType(["set_text","gamHud_setText","text_set"], /set_?text|text_?set/i),
    playerName: findType(["triggering_player_name","gamHud_triggeringPlayerName"], /triggering.*player.*name|player.*name/i),
    playerTeam: findType(["triggering_player_team_number","gamHud_triggeringPlayerTeam"], /triggering.*player.*team|player.*team/i),
    playerScore: findType(["triggering_player_score","gamHud_triggeringPlayerScore"], /triggering.*player.*score|player.*score/i),
    broadcast: findType(["broadcast_message_on_channel","gamHud_broadcast","broadcastOnChannel"], /broadcast.*channel|channel.*broadcast|broadcast/i),
  };

  const missing = ["setProp","getProp","setVar","getVar","num","arith","ifb","compare"].filter((k) => !T[k]);
  if (missing.length) return { ok: false, reason: "missing-types:" + missing.join(","), types: T, registrySample: registry.slice(0, 80) };

  const unsupported = [];
  const isHatBlock = (t) => {
    const s = ((t.type || "") + " " + (t.toString ? t.toString() : "")).toLowerCase();
    return /when|receiv|trigger|event|channel/.test(s) || (!!t.nextConnection && !t.previousConnection && !t.outputConnection);
  };

  const tops0 = ws.getTopBlocks ? ws.getTopBlocks(true) : [];
  let hat = tops0.find(isHatBlock) || null;

  if (opts.clear) {
    if (hat && hat.nextConnection && hat.nextConnection.targetBlock()) {
      try { hat.nextConnection.targetBlock().dispose(false); } catch (e) {}
    }
    for (const t of tops0) {
      if (t === hat || isHatBlock(t)) continue;
      try { t.dispose(false); } catch (e) {}
    }
  }

  // ---- visible-name index for generic \`block "..."\` statements (built lazily, cached on window)
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\\s+/g, " ").trim();
  const blockIndex = () => {
    if (window.__gkcBlockIndex && window.__gkcBlockIndex.size === registry.length) return window.__gkcBlockIndex;
    const idx = new Map();
    for (const type of registry) {
      if (/^procedures_|^variables_|^math_number$|^text$/.test(type)) continue;
      try {
        const b = ws.newBlock(type);
        const label = norm((b.toString ? b.toString() : "") + " " + (typeof b.tooltip === "string" ? b.tooltip : ""));
        idx.set(type, label);
        b.dispose(false);
      } catch (e) {}
    }
    window.__gkcBlockIndex = idx;
    return idx;
  };
  const findByVisibleName = (name) => {
    const want = norm(name);
    const idx = blockIndex();
    let best = null;
    let bestScore = 0;
    for (const [type, label] of idx) {
      let score = 0;
      if (label === want) score = 100;
      else if (label.startsWith(want)) score = 60 + want.length / Math.max(label.length, 1) * 30;
      else if (label.includes(want)) score = 40 + want.length / Math.max(label.length, 1) * 30;
      else if (norm(type).includes(want.replace(/ /g, "_")) || norm(type).includes(want)) score = 30;
      if (score > bestScore) { bestScore = score; best = type; }
    }
    return bestScore >= 30 ? best : null;
  };

  const setFieldMulti = (block, names, value) => {
    for (const n of names) {
      try { if (block.getField && block.getField(n)) { block.setFieldValue(value, n); return true; } } catch (e) {}
    }
    for (const n of names) { try { block.setFieldValue(value, n); return true; } catch (e) {} }
    return false;
  };
  const newBlock = (type) => { const b = ws.newBlock(type); if (b.initSvg) b.initSvg(); if (b.render) b.render(); return b; };
  const connectValue = (parent, inputNames, child) => {
    if (!child) return false;
    for (const n of inputNames) {
      const inp = parent.getInput && parent.getInput(n);
      if (inp && inp.connection && child.outputConnection) { try { inp.connection.connect(child.outputConnection); return true; } catch (e) {} }
    }
    if (parent.inputList) {
      for (const inp of parent.inputList) {
        if (inp.connection && inp.connection.type === B.INPUT_VALUE && !inp.connection.targetConnection && child.outputConnection) {
          try { inp.connection.connect(child.outputConnection); return true; } catch (e) {}
        }
      }
    }
    return false;
  };
  const connectStatement = (parent, inputNames, child) => {
    if (!child) return false;
    for (const n of inputNames) {
      const inp = parent.getInput && parent.getInput(n);
      if (inp && inp.connection && child.previousConnection) { try { inp.connection.connect(child.previousConnection); return true; } catch (e) {} }
    }
    return false;
  };
  const varId = (name) => {
    let v = ws.getVariable ? ws.getVariable(name) : null;
    if (!v && ws.createVariable) v = ws.createVariable(name);
    return v ? (v.getId ? v.getId() : v.id_) : name;
  };
  const need = (key, label) => { if (!T[key]) { unsupported.push(label); return false; } return true; };

  const mkNum = (n) => { const b = newBlock(T.num); setFieldMulti(b, ["NUM","num","number"], String(n)); return b; };
  const mkText = (s) => { if (!need("text", 'text "' + s + '"')) return mkNum(0); const b = newBlock(T.text); setFieldMulti(b, ["TEXT","text","value"], String(s)); return b; };
  const mkBool = (v) => { if (!need("bool", "true/false")) return mkNum(v ? 1 : 0); const b = newBlock(T.bool); setFieldMulti(b, ["BOOL","bool"], v ? "TRUE" : "FALSE"); return b; };
  const mkGetProp = (p) => { const b = newBlock(T.getProp); setFieldMulti(b, ["PROPERTY","property","FIELD","var","VAR","value"], p); return b; };
  const mkGetVar = (n) => { const b = newBlock(T.getVar); setFieldMulti(b, ["VAR","var","VARIABLE"], varId(n)); return b; };
  const mkArith = (op, a, b2) => { const b = newBlock(T.arith); setFieldMulti(b, ["OP","op"], op); connectValue(b, ["A","a"], a); connectValue(b, ["B","b"], b2); return b; };
  const cmpMap = { "<":"LT", ">":"GT", "<=":"LTE", ">=":"GTE", "==":"EQ", "!=":"NEQ" };
  const opMap = { "+":"ADD","-":"MINUS","*":"MULTIPLY","/":"DIVIDE" };
  const singleOps = { abs: "ABS", sqrt: "ROOT" };
  const roundOps = { round: "ROUND", floor: "ROUNDDOWN", ceil: "ROUNDUP" };

  const buildExpr = (e) => {
    if (!Array.isArray(e)) return null;
    const k = e[0];
    if (k === "num") return mkNum(e[1]);
    if (k === "text") return mkText(e[1]);
    if (k === "bool") return mkBool(e[1]);
    if (k === "prop") return mkGetProp(e[1]);
    if (k === "var") return mkGetVar(e[1]);
    if (opMap[k]) return mkArith(opMap[k], buildExpr(e[1]), buildExpr(e[2]));
    if (k === "%") { if (!need("modulo", "% (remainder)")) return buildExpr(e[1]); const b = newBlock(T.modulo); connectValue(b, ["DIVIDEND","dividend"], buildExpr(e[1])); connectValue(b, ["DIVISOR","divisor"], buildExpr(e[2])); return b; }
    if (k === "cmp") { const b = newBlock(T.compare); setFieldMulti(b, ["OP","op"], cmpMap[e[1]] || "EQ"); connectValue(b, ["A","a"], buildExpr(e[2])); connectValue(b, ["B","b"], buildExpr(e[3])); return b; }
    if (k === "and" || k === "or") { if (!need("logicOp", k)) return buildExpr(e[1]); const b = newBlock(T.logicOp); setFieldMulti(b, ["OP","op"], k.toUpperCase()); connectValue(b, ["A","a"], buildExpr(e[1])); connectValue(b, ["B","b"], buildExpr(e[2])); return b; }
    if (k === "not") { if (!need("negate", "not")) return buildExpr(e[1]); const b = newBlock(T.negate); connectValue(b, ["BOOL","bool"], buildExpr(e[1])); return b; }
    if (roundOps[k]) { if (!need("round", k + "()")) return buildExpr(e[1]); const b = newBlock(T.round); setFieldMulti(b, ["OP","op"], roundOps[k]); connectValue(b, ["NUM","num","value","VALUE"], buildExpr(e[1])); return b; }
    if (singleOps[k]) { if (!need("single", k + "()")) return buildExpr(e[1]); const b = newBlock(T.single); setFieldMulti(b, ["OP","op"], singleOps[k]); connectValue(b, ["NUM","num"], buildExpr(e[1])); return b; }
    if (k === "random") { if (!need("random", "random()")) return buildExpr(e[1]); const b = newBlock(T.random); connectValue(b, ["FROM","from"], buildExpr(e[1])); connectValue(b, ["TO","to"], buildExpr(e[2])); return b; }
    if (k === "join") {
      if (!need("join", "text join (+)")) return buildExpr(e[1]);
      const b = newBlock(T.join);
      // "create text with" is a mutator block: make sure it has exactly two inputs.
      try {
        if (!(b.getInput && b.getInput("ADD1"))) {
          if (b.loadExtraState) b.loadExtraState({ itemCount: 2 });
          else if (b.itemCount_ !== undefined) { b.itemCount_ = 2; if (b.updateShape_) b.updateShape_(); }
        }
      } catch (err) {}
      connectValue(b, ["ADD0","add0"], buildExpr(e[1]));
      connectValue(b, ["ADD1","add1"], buildExpr(e[2]));
      return b;
    }
    if (k === "len") { if (!need("length", "len()")) return buildExpr(e[1]); const b = newBlock(T.length); connectValue(b, ["VALUE","value","TEXT"], buildExpr(e[1])); return b; }
    if (k === "tostr") { if (!need("tostr", "text() conversion")) return buildExpr(e[1]); const b = newBlock(T.tostr); connectValue(b, ["NUM","VALUE","value","number","INPUT"], buildExpr(e[1])); return b; }
    if (k === "tonum") { if (!need("tonum", "number() conversion")) return buildExpr(e[1]); const b = newBlock(T.tonum); connectValue(b, ["TEXT","VALUE","value","text","INPUT"], buildExpr(e[1])); return b; }
    if (k === "player") { const key = { name: "playerName", team: "playerTeam", score: "playerScore" }[e[1]]; if (!need(key, "player." + e[1])) return mkNum(0); return newBlock(T[key]); }
    unsupported.push("expression " + k);
    return null;
  };

  const addElse = (ifBlock) => {
    try { if (ifBlock.loadExtraState) { ifBlock.loadExtraState({ hasElse: true, elseIfCount: 0 }); return true; } } catch (e) {}
    try { if (ifBlock.elseCount_ !== undefined) { ifBlock.elseCount_ = 1; if (ifBlock.updateShape_) ifBlock.updateShape_(); return true; } } catch (e) {}
    try {
      if (ifBlock.domToMutation && B.utils && B.utils.xml) {
        const m = B.utils.xml.createElement("mutation"); m.setAttribute("else", "1"); ifBlock.domToMutation(m); return true;
      }
    } catch (e) {}
    return false;
  };

  const isLiteral = (e) => Array.isArray(e) && (e[0] === "num" || e[0] === "text" || e[0] === "bool");
  const literalValue = (e) => (e[0] === "bool" ? (e[1] ? "TRUE" : "FALSE") : String(e[1]));
  const buildGeneric = (s) => {
    const type = findByVisibleName(s.name);
    if (!type) { unsupported.push('block "' + s.name + '" (no block with that name)'); return null; }
    const b = newBlock(type);
    const fieldNames = [];
    for (const inp of b.inputList || []) for (const f of inp.fieldRow || []) if (f.name && f.EDITABLE !== false) fieldNames.push(f.name);
    const valueInputs = (b.inputList || []).filter((i) => i.connection && i.connection.type === B.INPUT_VALUE);
    let vi = 0;
    for (const a of s.args || []) {
      if (a.key) {
        const fn = fieldNames.find((n) => n.toLowerCase() === a.key.toLowerCase());
        const inp = (b.inputList || []).find((i) => i.name && i.name.toLowerCase() === a.key.toLowerCase());
        if (fn && isLiteral(a.expr)) { try { b.setFieldValue(literalValue(a.expr), fn); continue; } catch (e) {} }
        if (inp && inp.connection) { connectValue(b, [inp.name], buildExpr(a.expr)); continue; }
        unsupported.push('block "' + s.name + '": no field or input named ' + a.key);
        continue;
      }
      if (vi < valueInputs.length) { connectValue(b, [valueInputs[vi].name], buildExpr(a.expr)); vi += 1; continue; }
      const freeField = fieldNames.find((n) => { try { const v = b.getFieldValue(n); return v === "" || v == null; } catch (e) { return false; } }) || fieldNames[0];
      if (freeField && isLiteral(a.expr)) { try { b.setFieldValue(literalValue(a.expr), freeField); continue; } catch (e) {} }
      unsupported.push('block "' + s.name + '": too many arguments');
    }
    if (!b.previousConnection) { unsupported.push('block "' + s.name + '" is a value block, not a statement'); try { b.dispose(false); } catch (e) {} return null; }
    return b;
  };

  const buildStatements = (list) => {
    const out = [];
    for (const s of list || []) {
      let b = null;
      if (s.op === "declare") { varId(s.name); continue; }
      else if (s.op === "setVar") { b = newBlock(T.setVar); setFieldMulti(b, ["VAR","var","VARIABLE"], varId(s.name)); connectValue(b, ["VALUE","value"], buildExpr(s.expr)); }
      else if (s.op === "setProp") { b = newBlock(T.setProp); setFieldMulti(b, ["PROPERTY","property","FIELD"], s.prop); connectValue(b, ["VALUE","value","NUM"], buildExpr(s.expr)); }
      else if (s.op === "setPropRound") { b = newBlock(T.setProp); setFieldMulti(b, ["PROPERTY","property","FIELD"], s.prop); connectValue(b, ["VALUE","value","NUM"], buildExpr(["round", s.expr])); }
      else if (s.op === "setText") {
        if (need("setText", "text = ... (Set Text)")) {
          b = newBlock(T.setText);
          // Set Text wants a text value: numbers/expressions are wrapped in a join with "" (Blockly type check).
          const textLike = (e) => Array.isArray(e) && (e[0] === "text" || e[0] === "join" || e[0] === "tostr" || (e[0] === "player" && e[1] === "name"));
          const valueExpr = textLike(s.expr) || !T.join ? s.expr : ["join", s.expr, ["text", ""]];
          connectValue(b, ["TEXT","text","VALUE","value"], buildExpr(valueExpr));
        }
      }
      else if (s.op === "reluClamp") { b = buildStatements([{ op: "if", cond: ["cmp","<",["var",s.name],["num",0]], then: [{ op:"setVar", name:s.name, expr:["num",0] }] }])[0]; }
      else if (s.op === "broadcast") {
        if (need("broadcast", 'broadcast "' + s.channel + '"')) { b = newBlock(T.broadcast); if (!setFieldMulti(b, ["CHANNEL","channel","TEXT","text"], s.channel)) connectValue(b, ["CHANNEL","channel","TEXT","text"], mkText(s.channel)); }
      }
      else if (s.op === "block") { b = buildGeneric(s); }
      else if (s.op === "if") {
        b = newBlock(T.ifb);
        connectValue(b, ["IF0","if0","IF"], buildExpr(s.cond));
        const thenList = buildStatements(s.then);
        if (thenList[0]) connectStatement(b, ["DO0","do0","DO"], thenList[0]);
        if (s.else && s.else.length) {
          if (!addElse(b)) unsupported.push("else branch");
          const elseList = buildStatements(s.else);
          if (elseList[0] && !connectStatement(b, ["ELSE","else"], elseList[0])) unsupported.push("else branch (no ELSE input)");
        }
      }
      else unsupported.push("statement " + s.op);
      if (b) out.push(b);
    }
    for (let i = 0; i + 1 < out.length; i += 1) {
      if (out[i].nextConnection && out[i+1].previousConnection) { try { out[i].nextConnection.connect(out[i+1].previousConnection); } catch (e) {} }
    }
    return out;
  };

  const statements = buildStatements(program.statements);

  if (!hat) {
    const tops = ws.getTopBlocks ? ws.getTopBlocks(true) : [];
    hat = tops.find((t) => !statements.includes(t) && isHatBlock(t)) || null;
  }
  let attachedHat = false;
  if (hat && statements[0] && hat.nextConnection && statements[0].previousConnection) {
    let tail = hat;
    let guard = 0;
    while (tail.nextConnection && tail.nextConnection.targetBlock() && !statements.includes(tail.nextConnection.targetBlock()) && guard++ < 200) {
      const nxt = tail.nextConnection.targetBlock();
      if (nxt.disposed || (nxt.isDisposed && nxt.isDisposed())) { try { tail.nextConnection.disconnect(); } catch (e) {} break; }
      tail = nxt;
    }
    try {
      if (tail.nextConnection.targetConnection && !tail.nextConnection.targetBlock()) tail.nextConnection.disconnect();
      tail.nextConnection.connect(statements[0].previousConnection);
    } catch (e) {}
    let cur = hat.nextConnection.targetBlock();
    guard = 0;
    while (cur && guard++ < 400) { if (cur === statements[0]) { attachedHat = true; break; } cur = cur.nextConnection && cur.nextConnection.targetBlock(); }
  }
  if (ws.render) ws.render();
  const all = ws.getAllBlocks ? ws.getAllBlocks(false) : [];
  const expected = (program.statements || []).filter((s) => s.op !== "declare").length;
  return {
    ok: statements.length > 0 && statements.length === expected && unsupported.length === 0,
    built: statements.length,
    expected,
    blockCount: all.length,
    overCap: all.length > ${BLOCK_CAP},
    types: T,
    attachedHat,
    hatType: hat ? hat.type : null,
    unsupported,
    registrySample: unsupported.length ? registry.slice(0, 120) : undefined,
    reason: unsupported.length ? "unsupported:" + unsupported.join("|") : statements.length === 0 ? "nothing-built" : statements.length !== expected ? "partial-build" : null,
  };
}
`;

/** Build a (parsed or text) program in the currently open Blockly workspace. */
export async function buildProgramInWorkspace(page, program, { clear = true } = {}) {
  const prog = parseProgram(program);
  return page.evaluate(
    ({ src, prog: p, opts }) => {
      // eslint-disable-next-line no-eval
      eval(src);
      // eslint-disable-next-line no-undef
      return gkcBuild(p, opts);
    },
    { src: IN_PAGE_BUILDER, prog, opts: { clear } },
  );
}
