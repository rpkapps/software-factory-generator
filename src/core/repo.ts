import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { readYaml, SfgError } from "./util.ts";

export const MARKER = ".sfg.yaml";

export const RepoConfigSchema = z.object({
  version: z.literal(1).default(1),
  stationsDir: z.string().default("stations"),
  linesDir: z.string().default("lines"),
  extensionsDir: z.string().default("extensions/stations"),
  /** where runs, artifacts and the local vault live; not committed */
  datastore: z.string().default(".sfg"),
  /** max jobs running at once in a line run */
  concurrency: z.number().int().min(1).default(4),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export class Repo {
  readonly root: string;
  readonly config: RepoConfig;

  constructor(root: string, config: RepoConfig) {
    this.root = root;
    this.config = config;
  }

  get stationsDir() {
    return join(this.root, this.config.stationsDir);
  }
  get linesDir() {
    return join(this.root, this.config.linesDir);
  }
  get extensionsDir() {
    return join(this.root, this.config.extensionsDir);
  }
  get dataDir() {
    return join(this.root, this.config.datastore);
  }
  get artifactsDir() {
    return join(this.dataDir, "artifacts");
  }
  get runsDir() {
    return join(this.dataDir, "runs");
  }
  get vaultDir() {
    return join(this.dataDir, "vault");
  }

  static find(start: string = process.cwd()): Repo {
    let dir = resolve(start);
    for (;;) {
      if (existsSync(join(dir, MARKER))) return Repo.open(dir);
      const parent = dirname(dir);
      if (parent === dir) {
        throw new SfgError(`not inside a factory repo (no ${MARKER} found from ${start})`, "run `sfg init` first");
      }
      dir = parent;
    }
  }

  static open(root: string): Repo {
    const raw = readYaml(join(root, MARKER)) ?? {};
    const parsed = RepoConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SfgError(`invalid ${MARKER}: ${z.prettifyError(parsed.error)}`);
    }
    return new Repo(resolve(root), parsed.data);
  }
}
