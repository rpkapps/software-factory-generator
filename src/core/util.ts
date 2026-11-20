import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";

export class SfgError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "SfgError";
    this.hint = hint;
  }
}

export const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function assertName(kind: string, name: string): void {
  if (!NAME_RE.test(name)) {
    throw new SfgError(
      `invalid ${kind} name '${name}'`,
      "names use lowercase letters, digits, '.', '_' and '-', and start with a letter or digit",
    );
  }
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Sortable, readable ids: 20261120T174501-3f9a2c */
export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  return `${ts}-${randomBytes(3).toString("hex")}`;
}

export function writeFileAtomic(path: string, data: string | Uint8Array, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}

export function readYaml(path: string): unknown {
  return YAML.parse(readFileSync(path, "utf8"));
}

export function toYaml(value: unknown): string {
  return YAML.stringify(value, { lineWidth: 0, aliasDuplicateObjects: false });
}

export function writeYaml(path: string, value: unknown): void {
  writeFileAtomic(path, toYaml(value));
}

export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : "…" + text.slice(text.length - maxChars);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
