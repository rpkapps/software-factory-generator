import { evaluate, evaluateCondition, stringify, type Scope } from "./evaluate.ts";
import { ExpressionError } from "./parser.ts";

export interface TemplatePart {
  literal?: string;
  expression?: string;
}

/** Split a string into literal text and `${{ expression }}` parts (quotes inside expressions are respected). */
export function splitTemplate(input: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let i = 0;
  while (i < input.length) {
    const start = input.indexOf("${{", i);
    if (start === -1) {
      parts.push({ literal: input.slice(i) });
      break;
    }
    if (start > i) parts.push({ literal: input.slice(i, start) });
    let j = start + 3;
    let quote: string | null = null;
    let end = -1;
    while (j < input.length) {
      const c = input[j];
      if (quote) {
        if (c === "\\") j++;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === "}" && input[j + 1] === "}") {
        end = j;
        break;
      }
      j++;
    }
    if (end === -1) throw new ExpressionError("unterminated '${{' (missing '}}')", input);
    parts.push({ expression: input.slice(start + 3, end).trim() });
    i = end + 2;
  }
  return parts;
}

export function isTemplate(value: unknown): value is string {
  return typeof value === "string" && value.includes("${{");
}

/**
 * Render a template string. A string that is exactly one `${{ expr }}` returns the raw value
 * (so `${{ steps.test.outputs }}` yields a map, not JSON text); otherwise values are stringified.
 */
export function renderString(input: string, scope: Scope): unknown {
  if (!isTemplate(input)) return input;
  const parts = splitTemplate(input.trim());
  if (parts.length === 1 && parts[0]!.expression !== undefined) {
    return evaluate(parts[0]!.expression, scope);
  }
  return splitTemplate(input)
    .map((p) => (p.expression !== undefined ? stringify(evaluate(p.expression, scope)) : p.literal))
    .join("");
}

/** Deeply render every template string inside a value (objects, lists, strings). */
export function render(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") return renderString(value, scope);
  if (Array.isArray(value)) return value.map((v) => render(v, scope));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = render(v, scope);
    return out;
  }
  return value;
}

/** Accepts either `a == b` or `${{ a == b }}`. */
export function conditionSource(input: string): string {
  const trimmed = input.trim();
  if (!isTemplate(trimmed)) return trimmed;
  const parts = splitTemplate(trimmed);
  if (parts.length !== 1 || parts[0]!.expression === undefined) {
    throw new ExpressionError("a condition must be a single expression", input);
  }
  return parts[0]!.expression;
}

export function renderCondition(input: string, scope: Scope): boolean {
  return evaluateCondition(conditionSource(input), scope);
}

/** Every expression source found inside a value, for static validation. */
export function collectExpressions(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string" && isTemplate(value)) {
    for (const p of splitTemplate(value)) if (p.expression !== undefined) out.push(p.expression);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectExpressions(v, out));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((v) => collectExpressions(v, out));
  }
  return out;
}
