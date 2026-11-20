/**
 * The station SDK. A station type is TypeScript code that does one kind of work on the
 * production line (run a command, drive a coding agent, talk to git or an API).
 * Station definitions (YAML) configure a type; lines (YAML) wire definitions together.
 */
import type { z } from "zod";

export type MethodKind = "read" | "mutating" | "delete";

/** A reference to one immutable artifact version, written `station/name@version`. */
export type ArtifactRef = string;

export interface ArtifactMetadata {
  id: string;
  name: string;
  version: number;
  kind: "file" | "resource";
  contentType: string;
  size: number;
  sha256: string;
  createdAt: string;
  owner: { stationId: string; stationName: string; stationType: string; typeVersion: string };
  provenance: {
    runId: string;
    line?: string;
    job?: string;
    step?: string;
    iteration?: number;
    item?: number;
    method: string;
    /** artifacts that were read while producing this one (the lineage graph) */
    consumed: ArtifactRef[];
    argumentsSha256: string;
  };
  tags: Record<string, string>;
}

export interface WriteArtifactOptions {
  /** defaults to text/plain for strings, application/json for objects */
  contentType?: string;
  tags?: Record<string, string>;
}

export interface ReadArtifactResult {
  ref: ArtifactRef;
  metadata: ArtifactMetadata;
  content: Buffer;
  text(): string;
  json(): unknown;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** written to the process's stdin */
  input?: string;
  timeoutSeconds?: number;
  /** run through the shell (command must then be a single string) */
  shell?: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface MethodContext<G = Record<string, unknown>> {
  /** the station definition's global arguments, templates resolved and validated */
  globals: G;
  station: { id: string; name: string; type: string; typeVersion: string };
  /** the factory repo (where .sfg.yaml lives) */
  repoDir: string;
  run: { id: string; line?: string; job?: string; step?: string; iteration?: number; item?: number };
  log(message: string): void;
  /** Write a new immutable version of an artifact owned by this station. */
  writeArtifact(name: string, content: string | Uint8Array | object, options?: WriteArtifactOptions): ArtifactRef;
  /** Read an artifact. The read is recorded as lineage for artifacts this method writes. */
  readArtifact(ref: ArtifactRef): ReadArtifactResult;
  /** Run a process. Output is redacted of secrets and appended to the run log. */
  exec(command: string | string[], options?: ExecOptions): Promise<ExecResult>;
  /** Replace known secret values with *** */
  redact(text: string): string;
  signal: AbortSignal;
}

export interface MethodResult {
  /** defaults to "succeeded"; return "failed" for an expected failure (tests failed, review rejected) */
  status?: "succeeded" | "failed";
  /** small JSON values that later steps can read as steps.<name>.outputs */
  outputs?: Record<string, unknown>;
  message?: string;
}

export interface MethodDefinition<G = any, A extends z.ZodType = z.ZodType> {
  description: string;
  /** inferred from the name if omitted: get/list/read/describe/show/diff/status are read */
  kind?: MethodKind;
  arguments?: A;
  execute(args: z.infer<A>, ctx: MethodContext<G>): Promise<MethodResult | void> | MethodResult | void;
}

export interface StationType<G extends z.ZodType = z.ZodType> {
  /** namespaced, e.g. "sfg/shell" or "acme/jira" */
  type: string;
  /** CalVer, YYYY.MM.DD.MICRO */
  version: string;
  description: string;
  globalArguments?: G;
  methods: Record<string, MethodDefinition<z.infer<G>, any>>;
}

export interface StationSdk {
  z: typeof import("zod").z;
  defineStation: typeof defineStation;
  method: typeof method;
}

/** Extensions in extensions/stations/*.ts default-export a StationType or a StationTypeFactory. */
export type StationTypeFactory = (sdk: StationSdk) => StationType<any> | StationType<any>[];

export function defineStation<G extends z.ZodType>(t: StationType<G>): StationType<G> {
  return t;
}

/** Helper that gives `execute` typed arguments inferred from the `arguments` schema. */
export function method<A extends z.ZodType, G = any>(m: MethodDefinition<G, A>): MethodDefinition<G, A> {
  return m;
}

export function methodKind(name: string, def: MethodDefinition): MethodKind {
  if (def.kind) return def.kind;
  if (/^(get|list|read|describe|show|diff|status|head|search|query|check)/i.test(name)) return "read";
  if (/^(delete|destroy|remove)/i.test(name)) return "delete";
  return "mutating";
}
