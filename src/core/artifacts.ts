import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactMetadata, ArtifactRef, ReadArtifactResult } from "./types.ts";
import { readYaml, sha256, SfgError, writeFileAtomic, writeYaml } from "./util.ts";

/**
 * Immutable, versioned artifacts with provenance.
 *
 *   .sfg/artifacts/<station-id>/owner.yaml
 *   .sfg/artifacts/<station-id>/<name>/<version>/raw
 *   .sfg/artifacts/<station-id>/<name>/<version>/metadata.yaml
 *   .sfg/artifacts/<station-id>/<name>/latest
 *
 * A write never modifies an existing version: it claims the next version number with an
 * atomic mkdir, writes content and metadata via temp-file-and-rename, then moves `latest`.
 */

export interface ParsedRef {
  station: string;
  name: string;
  version: number | "latest";
}

export function parseRef(ref: string): ParsedRef {
  const m = /^([^/@\s]+)\/([^/@\s]+)(?:@(\d+|latest))?$/.exec(ref.trim());
  if (!m) throw new SfgError(`invalid artifact reference '${ref}'`, "use station/name or station/name@version");
  return { station: m[1]!, name: m[2]!, version: m[3] === undefined || m[3] === "latest" ? "latest" : Number(m[3]) };
}

export function formatRef(station: string, name: string, version: number): ArtifactRef {
  return `${station}/${name}@${version}`;
}

export function isTextual(contentType: string): boolean {
  return /^text\/|json|yaml|xml|x-diff|javascript|typescript/.test(contentType);
}

interface Owner {
  stationId: string;
  stationName: string;
  stationType: string;
}

export interface WriteInput {
  owner: ArtifactMetadata["owner"];
  name: string;
  content: Buffer;
  kind: ArtifactMetadata["kind"];
  contentType: string;
  tags?: Record<string, string>;
  provenance: ArtifactMetadata["provenance"];
}

export class ArtifactStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  write(input: WriteInput): { ref: ArtifactRef; metadata: ArtifactMetadata } {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.name)) {
      throw new SfgError(`invalid artifact name '${input.name}'`);
    }
    const stationDir = join(this.dir, input.owner.stationId);
    const owner: Owner = {
      stationId: input.owner.stationId,
      stationName: input.owner.stationName,
      stationType: input.owner.stationType,
    };
    const ownerFile = join(stationDir, "owner.yaml");
    const known = existsSync(ownerFile) ? (readYaml(ownerFile) as Owner) : undefined;
    if (!known || known.stationName !== owner.stationName) writeYaml(ownerFile, owner);

    const nameDir = join(stationDir, input.name);
    mkdirSync(nameDir, { recursive: true });
    let version = this.latestVersion(nameDir) + 1;
    for (;;) {
      try {
        mkdirSync(join(nameDir, String(version)));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        version++;
      }
    }
    const versionDir = join(nameDir, String(version));
    const metadata: ArtifactMetadata = {
      id: randomUUID(),
      name: input.name,
      version,
      kind: input.kind,
      contentType: input.contentType,
      size: input.content.byteLength,
      sha256: sha256(input.content),
      createdAt: new Date().toISOString(),
      owner: input.owner,
      provenance: input.provenance,
      tags: input.tags ?? {},
    };
    writeFileAtomic(join(versionDir, "raw"), input.content);
    writeYaml(join(versionDir, "metadata.yaml"), metadata);
    // Only move `latest` forward (a concurrent writer may have claimed a higher version).
    if (version > this.latestVersion(nameDir)) writeFileAtomic(join(nameDir, "latest"), `${version}\n`);
    return { ref: formatRef(input.owner.stationName, input.name, version), metadata };
  }

  private latestVersion(nameDir: string): number {
    const file = join(nameDir, "latest");
    if (!existsSync(file)) return 0;
    return Number(readFileSync(file, "utf8").trim()) || 0;
  }

  private owners(): Owner[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.dir, d.name, "owner.yaml")))
      .map((d) => readYaml(join(this.dir, d.name, "owner.yaml")) as Owner);
  }

  private stationDir(station: string): string | undefined {
    const owner = this.owners().find((o) => o.stationName === station || o.stationId === station);
    return owner ? join(this.dir, owner.stationId) : undefined;
  }

  /** Resolve `station/name[@version]` to an exact version. */
  resolve(ref: ArtifactRef): { ref: ArtifactRef; dir: string; metadata: ArtifactMetadata } {
    const parsed = parseRef(ref);
    const stationDir = this.stationDir(parsed.station);
    const nameDir = stationDir && join(stationDir, parsed.name);
    if (!nameDir || !existsSync(nameDir)) throw new SfgError(`artifact '${parsed.station}/${parsed.name}' not found`);
    const version = parsed.version === "latest" ? this.latestVersion(nameDir) : parsed.version;
    const dir = join(nameDir, String(version));
    if (!existsSync(join(dir, "metadata.yaml"))) throw new SfgError(`artifact '${ref}' not found`);
    const metadata = readYaml(join(dir, "metadata.yaml")) as ArtifactMetadata;
    return { ref: formatRef(metadata.owner.stationName, metadata.name, metadata.version), dir, metadata };
  }

  read(ref: ArtifactRef): ReadArtifactResult {
    const { ref: exact, dir, metadata } = this.resolve(ref);
    const content = readFileSync(join(dir, "raw"));
    return {
      ref: exact,
      metadata,
      content,
      text: () => content.toString("utf8"),
      json: () => JSON.parse(content.toString("utf8")),
    };
  }

  versions(station: string, name: string): ArtifactMetadata[] {
    const stationDir = this.stationDir(station);
    const nameDir = stationDir && join(stationDir, name);
    if (!nameDir || !existsSync(nameDir)) return [];
    return readdirSync(nameDir)
      .filter((v) => /^\d+$/.test(v) && existsSync(join(nameDir, v, "metadata.yaml")))
      .map((v) => readYaml(join(nameDir, v, "metadata.yaml")) as ArtifactMetadata)
      .sort((a, b) => a.version - b.version);
  }

  /** Every artifact version, optionally filtered. */
  list(filter: { station?: string; runId?: string; latestOnly?: boolean } = {}): ArtifactMetadata[] {
    const out: ArtifactMetadata[] = [];
    for (const owner of this.owners()) {
      if (filter.station && owner.stationName !== filter.station && owner.stationId !== filter.station) continue;
      const stationDir = join(this.dir, owner.stationId);
      for (const entry of readdirSync(stationDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        let versions = this.versions(owner.stationId, entry.name);
        if (filter.latestOnly && !filter.runId) versions = versions.slice(-1);
        out.push(...versions);
      }
    }
    return out
      .filter((m) => !filter.runId || m.provenance.runId === filter.runId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Walk provenance backwards: what was read to produce this artifact, recursively. */
  lineage(ref: ArtifactRef): LineageNode {
    const seen = new Map<string, LineageNode>();
    const walk = (r: ArtifactRef): LineageNode => {
      let resolved;
      try {
        resolved = this.resolve(r);
      } catch {
        return { ref: r, missing: true, inputs: [] };
      }
      const existing = seen.get(resolved.ref);
      if (existing) return { ...existing, inputs: [], repeated: true };
      const node: LineageNode = { ref: resolved.ref, metadata: resolved.metadata, inputs: [] };
      seen.set(resolved.ref, node);
      node.inputs = resolved.metadata.provenance.consumed.map(walk);
      return node;
    };
    return walk(ref);
  }
}

export interface LineageNode {
  ref: ArtifactRef;
  metadata?: ArtifactMetadata;
  missing?: boolean;
  repeated?: boolean;
  inputs: LineageNode[];
}
