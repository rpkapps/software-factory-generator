import { ExpressionError, parse, type Node } from "./parser.ts";

export type Scope = Record<string, unknown>;

/** A missing key is an error (like CEL), with a hint about what does exist. */
class MissingKey extends ExpressionError {}

const MACROS = new Set(["has", "default"]);
const LIST_MACROS = new Set(["all", "exists", "exists_one", "filter", "map"]);

export function typeName(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "list";
  if (typeof v === "object") return "map";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "double";
  return typeof v;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return (
    ka.length === kb.length &&
    ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

export function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 2);
}

function lines(s: string): string[] {
  const parts = s.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

type Method = (self: never, ...args: unknown[]) => unknown;

const STRING_METHODS: Record<string, Method> = {
  size: (s: string) => [...s].length,
  contains: (s: string, x) => s.includes(String(x)),
  startsWith: (s: string, x) => s.startsWith(String(x)),
  endsWith: (s: string, x) => s.endsWith(String(x)),
  matches: (s: string, re) => new RegExp(String(re)).test(s),
  lower: (s: string) => s.toLowerCase(),
  lowerAscii: (s: string) => s.toLowerCase(),
  upper: (s: string) => s.toUpperCase(),
  upperAscii: (s: string) => s.toUpperCase(),
  trim: (s: string) => s.trim(),
  split: (s: string, sep) => s.split(String(sep)),
  replace: (s: string, a, b) => s.split(String(a)).join(String(b)),
  indexOf: (s: string, x) => s.indexOf(String(x)),
  /** last n lines (handy for feeding test failures back to an agent) */
  tail: (s: string, n = 40) => lines(s).slice(-Number(n)).join("\n"),
  /** first n lines */
  head: (s: string, n = 40) => lines(s).slice(0, Number(n)).join("\n"),
};

const LIST_METHODS: Record<string, Method> = {
  size: (l: unknown[]) => l.length,
  contains: (l: unknown[], x) => l.some((y) => deepEqual(x, y)),
  join: (l: unknown[], sep = ",") => l.map(stringify).join(String(sep)),
};

const MAP_METHODS: Record<string, Method> = {
  size: (m: Record<string, unknown>) => Object.keys(m).length,
  keys: (m: Record<string, unknown>) => Object.keys(m),
  values: (m: Record<string, unknown>) => Object.values(m),
};

const GLOBAL_FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  size: (x) => {
    if (typeof x === "string") return [...x].length;
    if (Array.isArray(x)) return x.length;
    if (x && typeof x === "object") return Object.keys(x).length;
    throw new Error(`size() does not apply to ${typeName(x)}`);
  },
  string: (x) => stringify(x),
  int: (x) => {
    const n = Math.trunc(Number(x));
    if (Number.isNaN(n)) throw new Error(`int(): cannot convert ${JSON.stringify(x)}`);
    return n;
  },
  double: (x) => {
    const n = Number(x);
    if (Number.isNaN(n)) throw new Error(`double(): cannot convert ${JSON.stringify(x)}`);
    return n;
  },
  bool: (x) => (typeof x === "string" ? x === "true" : truthy(x)),
  type: (x) => typeName(x),
  json: (x) => JSON.stringify(x, null, 2),
  fromJson: (x) => JSON.parse(String(x)),
};

function getMember(obj: unknown, key: string | number, src: string): unknown {
  if (Array.isArray(obj)) {
    if (typeof key !== "number" || !Number.isInteger(key)) {
      throw new ExpressionError(`lists are indexed by integers, got ${JSON.stringify(key)}`, src);
    }
    const idx = key < 0 ? obj.length + key : key;
    if (idx < 0 || idx >= obj.length) {
      throw new MissingKey(`index ${key} out of range (size ${obj.length})`, src);
    }
    return obj[idx];
  }
  if (obj !== null && typeof obj === "object") {
    const k = String(key);
    if (!Object.hasOwn(obj, k)) {
      const available = Object.keys(obj).slice(0, 20);
      throw new MissingKey(
        `no such key '${k}'` + (available.length ? ` (available: ${available.join(", ")})` : " (map is empty)"),
        src,
      );
    }
    return (obj as Record<string, unknown>)[k];
  }
  throw new MissingKey(`cannot read '${key}' of ${typeName(obj)}`, src);
}

function compare(op: string, a: unknown, b: unknown, src: string): boolean {
  if (!((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string"))) {
    throw new ExpressionError(`cannot compare ${typeName(a)} ${op} ${typeName(b)}`, src);
  }
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    default:
      return a >= b;
  }
}

export function evaluateNode(node: Node, scope: Scope, src: string): unknown {
  const ev = (n: Node, s: Scope = scope) => evaluateNode(n, s, src);
  switch (node.kind) {
    case "literal":
      return node.value;
    case "ident":
      if (!Object.hasOwn(scope, node.name)) {
        if (GLOBAL_FUNCTIONS[node.name]) return GLOBAL_FUNCTIONS[node.name];
        throw new MissingKey(`unknown name '${node.name}' (available: ${Object.keys(scope).join(", ")})`, src);
      }
      return scope[node.name];
    case "member":
      return getMember(ev(node.object), node.property, src);
    case "index":
      return getMember(ev(node.object), ev(node.index) as string | number, src);
    case "list":
      return node.items.map((i) => ev(i));
    case "map": {
      const out: Record<string, unknown> = {};
      for (const e of node.entries) out[String(ev(e.key))] = ev(e.value);
      return out;
    }
    case "unary": {
      const v = ev(node.operand);
      if (node.op === "!") return !truthy(v);
      if (typeof v !== "number") throw new ExpressionError(`cannot negate ${typeName(v)}`, src);
      return -v;
    }
    case "ternary":
      return truthy(ev(node.test)) ? ev(node.consequent) : ev(node.alternate);
    case "binary":
      return evalBinary(node, scope, src);
    case "call":
      return evalCall(node, scope, src);
  }
}

function evalBinary(node: Extract<Node, { kind: "binary" }>, scope: Scope, src: string): unknown {
  const ev = (n: Node) => evaluateNode(n, scope, src);
  if (node.op === "&&") return truthy(ev(node.left)) && truthy(ev(node.right));
  if (node.op === "||") return truthy(ev(node.left)) || truthy(ev(node.right));
  const a = ev(node.left);
  const b = ev(node.right);
  switch (node.op) {
    case "==":
      return deepEqual(a, b);
    case "!=":
      return !deepEqual(a, b);
    case "<":
    case "<=":
    case ">":
    case ">=":
      return compare(node.op, a, b, src);
    case "in":
      if (Array.isArray(b)) return b.some((x) => deepEqual(a, x));
      if (typeof b === "string") return b.includes(String(a));
      if (b && typeof b === "object") return Object.hasOwn(b, String(a));
      throw new ExpressionError(`'in' needs a list, map or string on the right, got ${typeName(b)}`, src);
    case "+":
      if (typeof a === "number" && typeof b === "number") return a + b;
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
      if (typeof a === "string" || typeof b === "string") return stringify(a) + stringify(b);
      throw new ExpressionError(`cannot add ${typeName(a)} and ${typeName(b)}`, src);
    case "-":
    case "*":
    case "/":
    case "%": {
      if (typeof a !== "number" || typeof b !== "number") {
        throw new ExpressionError(`'${node.op}' needs numbers, got ${typeName(a)} and ${typeName(b)}`, src);
      }
      if (node.op === "-") return a - b;
      if (node.op === "*") return a * b;
      if (b === 0) throw new ExpressionError("division by zero", src);
      return node.op === "/" ? a / b : a % b;
    }
  }
  throw new ExpressionError(`unknown operator ${node.op}`, src);
}

function evalCall(node: Extract<Node, { kind: "call" }>, scope: Scope, src: string): unknown {
  const ev = (n: Node, s: Scope = scope) => evaluateNode(n, s, src);
  const { callee, args } = node;

  // Macros receive unevaluated arguments.
  if (callee.kind === "ident" && MACROS.has(callee.name) && !Object.hasOwn(scope, callee.name)) {
    if (callee.name === "has") {
      if (args.length !== 1) throw new ExpressionError("has() takes exactly one argument", src);
      try {
        ev(args[0]!);
        return true;
      } catch (e) {
        if (e instanceof MissingKey) return false;
        throw e;
      }
    }
    // default(value, fallback): fallback when value is missing or null
    if (args.length !== 2) throw new ExpressionError("default() takes exactly two arguments", src);
    try {
      const v = ev(args[0]!);
      return v ?? ev(args[1]!);
    } catch (e) {
      if (e instanceof MissingKey) return ev(args[1]!);
      throw e;
    }
  }

  if (callee.kind === "member") {
    const target = ev(callee.object);
    const name = callee.property;
    // Host objects (artifact, vault, ...) expose functions as own properties.
    if (target && typeof target === "object" && !Array.isArray(target) && Object.hasOwn(target, name)) {
      const fn = (target as Record<string, unknown>)[name];
      if (typeof fn === "function") return fn(...args.map((a) => ev(a)));
    }
    if (Array.isArray(target) && LIST_MACROS.has(name)) {
      return evalListMacro(name, target, args, scope, src);
    }
    const table =
      typeof target === "string"
        ? STRING_METHODS
        : Array.isArray(target)
          ? LIST_METHODS
          : target && typeof target === "object"
            ? MAP_METHODS
            : undefined;
    const method = table?.[name];
    if (!method) throw new ExpressionError(`no method '${name}' on ${typeName(target)}`, src);
    try {
      return method(target as never, ...args.map((a) => ev(a)));
    } catch (e) {
      throw new ExpressionError(`${name}(): ${(e as Error).message}`, src);
    }
  }

  const fn = ev(callee);
  if (typeof fn !== "function") throw new ExpressionError(`${typeName(fn)} is not callable`, src);
  try {
    return fn(...args.map((a) => ev(a)));
  } catch (e) {
    if (e instanceof ExpressionError) throw e;
    throw new ExpressionError((e as Error).message, src);
  }
}

function evalListMacro(name: string, list: unknown[], args: Node[], scope: Scope, src: string): unknown {
  const [variable, body] = args;
  if (args.length !== 2 || variable?.kind !== "ident") {
    throw new ExpressionError(`${name}() takes a variable name and an expression, e.g. list.${name}(x, x > 1)`, src);
  }
  const run = (item: unknown) => evaluateNode(body!, { ...scope, [variable.name]: item }, src);
  switch (name) {
    case "all":
      return list.every((x) => truthy(run(x)));
    case "exists":
      return list.some((x) => truthy(run(x)));
    case "exists_one":
      return list.filter((x) => truthy(run(x))).length === 1;
    case "filter":
      return list.filter((x) => truthy(run(x)));
    default:
      return list.map(run);
  }
}

const parseCache = new Map<string, Node>();

export function compile(src: string): Node {
  let ast = parseCache.get(src);
  if (!ast) {
    ast = parse(src);
    parseCache.set(src, ast);
  }
  return ast;
}

export function evaluate(src: string, scope: Scope): unknown {
  return evaluateNode(compile(src), scope, src);
}

/** Evaluate a condition that must produce a boolean (`when`, `until`, gate assertions). */
export function evaluateCondition(src: string, scope: Scope): boolean {
  const v = evaluate(src, scope);
  if (typeof v !== "boolean") {
    throw new ExpressionError(`condition must be a boolean, got ${typeName(v)} (${JSON.stringify(v)})`, src);
  }
  return v;
}
