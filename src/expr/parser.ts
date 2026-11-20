/**
 * A small, safe expression language: a CEL-compatible subset.
 *
 * Supported: literals (numbers, 'strings', "strings", true, false, null, [lists], {'maps': 1}),
 * identifiers, member access (a.b), indexing (a[0], a['b']), calls (f(x), x.f(y)),
 * unary (! -), binary (* / % + - < <= > >= == != in && ||) and the ternary (c ? a : b).
 *
 * There is no access to JavaScript globals: evaluation only sees the context it is given.
 */

export type Node =
  | { kind: "literal"; value: unknown }
  | { kind: "ident"; name: string }
  | { kind: "member"; object: Node; property: string }
  | { kind: "index"; object: Node; index: Node }
  | { kind: "call"; callee: Node; args: Node[] }
  | { kind: "unary"; op: "!" | "-"; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "ternary"; test: Node; consequent: Node; alternate: Node }
  | { kind: "list"; items: Node[] }
  | { kind: "map"; entries: Array<{ key: Node; value: Node }> };

type Token =
  | { t: "num"; v: number; pos: number }
  | { t: "str"; v: string; pos: number }
  | { t: "ident"; v: string; pos: number }
  | { t: "op"; v: string; pos: number }
  | { t: "eof"; pos: number };

export class ExpressionError extends Error {
  readonly expression: string;
  constructor(message: string, expression: string) {
    super(message);
    this.name = "ExpressionError";
    this.expression = expression;
  }
}

const OPERATORS = [
  "&&", "||", "==", "!=", "<=", ">=",
  "<", ">", "+", "-", "*", "/", "%", "!", "?", ":", ".", ",", "(", ")", "[", "]", "{", "}",
];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(src.slice(i))!;
      tokens.push({ t: "num", v: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\") {
          const n = src[j + 1];
          const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
          if (n === undefined) break;
          out += map[n] ?? n;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (src[j] !== quote) throw new ExpressionError(`unterminated string starting at ${i}`, src);
      tokens.push({ t: "str", v: out, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ t: "ident", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressionError(`unexpected character '${c}' at ${i}`, src);
    tokens.push({ t: "op", v: op, pos: i });
    i += op.length;
  }
  tokens.push({ t: "eof", pos: src.length });
  return tokens;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3, "!=": 3, "<": 3, "<=": 3, ">": 3, ">=": 3, in: 3,
  "+": 4, "-": 4,
  "*": 5, "/": 5, "%": 5,
};

export function parse(src: string): Node {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p]!;
  const next = () => tokens[p++]!;
  const isOp = (v: string) => {
    const tk = peek();
    return tk.t === "op" && tk.v === v;
  };
  const expectOp = (v: string) => {
    const tk = next();
    if (tk.t !== "op" || tk.v !== v) {
      throw new ExpressionError(`expected '${v}' at ${tk.pos}`, src);
    }
  };

  function parseTernary(): Node {
    const test = parseBinary(1);
    if (isOp("?")) {
      next();
      const consequent = parseTernary();
      expectOp(":");
      const alternate = parseTernary();
      return { kind: "ternary", test, consequent, alternate };
    }
    return test;
  }

  function binaryOp(): string | undefined {
    const tk = peek();
    if (tk.t === "op" && BINARY_PRECEDENCE[tk.v] !== undefined) return tk.v;
    if (tk.t === "ident" && tk.v === "in") return "in";
    return undefined;
  }

  function parseBinary(minPrec: number): Node {
    let left = parseUnary();
    for (;;) {
      const op = binaryOp();
      if (!op) break;
      const prec = BINARY_PRECEDENCE[op]!;
      if (prec < minPrec) break;
      next();
      const right = parseBinary(prec + 1);
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  function parseUnary(): Node {
    if (isOp("!") || isOp("-")) {
      const op = (next() as { v: "!" | "-" }).v;
      return { kind: "unary", op, operand: parseUnary() };
    }
    return parsePostfix(parsePrimary());
  }

  function parseArgs(close: string): Node[] {
    const args: Node[] = [];
    if (isOp(close)) {
      next();
      return args;
    }
    for (;;) {
      args.push(parseTernary());
      if (isOp(",")) {
        next();
        if (isOp(close)) break; // trailing comma
        continue;
      }
      break;
    }
    expectOp(close);
    return args;
  }

  function parsePostfix(node: Node): Node {
    for (;;) {
      if (isOp(".")) {
        next();
        const tk = next();
        if (tk.t !== "ident") throw new ExpressionError(`expected a name after '.' at ${tk.pos}`, src);
        node = { kind: "member", object: node, property: tk.v };
      } else if (isOp("[")) {
        next();
        const index = parseTernary();
        expectOp("]");
        node = { kind: "index", object: node, index };
      } else if (isOp("(")) {
        next();
        node = { kind: "call", callee: node, args: parseArgs(")") };
      } else {
        return node;
      }
    }
  }

  function parsePrimary(): Node {
    const tk = next();
    switch (tk.t) {
      case "num":
        return { kind: "literal", value: tk.v };
      case "str":
        return { kind: "literal", value: tk.v };
      case "ident":
        if (tk.v === "true") return { kind: "literal", value: true };
        if (tk.v === "false") return { kind: "literal", value: false };
        if (tk.v === "null") return { kind: "literal", value: null };
        return { kind: "ident", name: tk.v };
      case "op":
        if (tk.v === "(") {
          const inner = parseTernary();
          expectOp(")");
          return inner;
        }
        if (tk.v === "[") return { kind: "list", items: parseArgs("]") };
        if (tk.v === "{") {
          const entries: Array<{ key: Node; value: Node }> = [];
          if (!isOp("}")) {
            for (;;) {
              const key = parseTernary();
              expectOp(":");
              const value = parseTernary();
              entries.push({ key, value });
              if (isOp(",")) {
                next();
                if (isOp("}")) break;
                continue;
              }
              break;
            }
          }
          expectOp("}");
          return { kind: "map", entries };
        }
        throw new ExpressionError(`unexpected '${tk.v}' at ${tk.pos}`, src);
      case "eof":
        throw new ExpressionError("unexpected end of expression", src);
    }
  }

  const ast = parseTernary();
  const tail = peek();
  if (tail.t !== "eof") throw new ExpressionError(`unexpected token at ${tail.pos}`, src);
  return ast;
}

/**
 * Returns the dotted reference paths an expression reads, e.g. `steps.test.status` -> ["steps","test","status"].
 * Used by static validation to check that lines only reference things that exist.
 */
export function references(ast: Node): string[][] {
  const out: string[][] = [];
  const pathOf = (n: Node): string[] | undefined => {
    if (n.kind === "ident") return [n.name];
    if (n.kind === "member") {
      const base = pathOf(n.object);
      return base ? [...base, n.property] : undefined;
    }
    if (n.kind === "index" && n.index.kind === "literal" && typeof n.index.value === "string") {
      const base = pathOf(n.object);
      return base ? [...base, n.index.value] : undefined;
    }
    return undefined;
  };
  const visit = (n: Node, asCallee = false): void => {
    switch (n.kind) {
      case "ident":
      case "member":
      case "index": {
        const path = pathOf(n);
        if (path) {
          // a method call like `x.size()` reads `x`, not `x.size`
          out.push(asCallee && n.kind === "member" ? path.slice(0, -1) : path);
          if (n.kind === "index") visit(n.index);
          return;
        }
        if (n.kind === "member") visit(n.object);
        if (n.kind === "index") {
          visit(n.object);
          visit(n.index);
        }
        return;
      }
      case "call":
        visit(n.callee, true);
        n.args.forEach((a) => visit(a));
        return;
      case "unary":
        visit(n.operand);
        return;
      case "binary":
        visit(n.left);
        visit(n.right);
        return;
      case "ternary":
        visit(n.test);
        visit(n.consequent);
        visit(n.alternate);
        return;
      case "list":
        n.items.forEach((a) => visit(a));
        return;
      case "map":
        n.entries.forEach((e) => {
          visit(e.key);
          visit(e.value);
        });
        return;
      case "literal":
        return;
    }
  };
  visit(ast);
  return out.filter((p) => p.length > 0);
}
