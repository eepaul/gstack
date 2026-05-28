#!/usr/bin/env bun
/**
 * gstack-gbrainignore-gen — scaffold a .gbrainignore file by analyzing the
 * current repo.
 *
 * Powers /gbrain-init-ignore. Three modes:
 *
 *   --scan-big-dirs --root <p> [--min-mb N]
 *       JSON list of top-level dirs above the size threshold (default 50MB).
 *       Used by the skill's interactive "exclude these big dirs?" prompt.
 *
 *   --scan-extensions --root <p> [--top N]
 *       JSON list of {ext, count} for the top-N file extensions, ignoring
 *       gbrain's auto-pruned dirs (dotdirs, node_modules, .venv). Used by
 *       the skill's interactive extension-exclusion prompt.
 *
 *   --build [options]
 *       Print the composed .gbrainignore content to stdout. Pure function;
 *       no file I/O on the brain side. Options:
 *           --project-types <csv>      comma-separated, e.g. "python,node"
 *           --gitignore <path>         path to .gitignore (optional)
 *           --big-dirs <json>          JSON array of strings, e.g. '["data/","runs/"]'
 *           --exclude-ext <json>       JSON array of strings, e.g. '["json","yaml"]'
 *           --timestamp <iso>          override timestamp (for deterministic tests)
 *
 * Design (v1.47.0.0 — /gbrain-init-ignore):
 *
 *   - Pure functions are testable + exported.
 *   - Side-effects live below the `// ── Side effects ──` divider.
 *   - The CLI dispatcher at the bottom is the only place that calls them.
 *   - Atomic write (write to .gbrainignore.tmp, fsync, rename) is NOT done
 *     here — the skill drives the write via shell, so writeAtomic stays
 *     simple and the skill owns the backup-on-overwrite step.
 *
 * Why not put this in gbrain proper? Plan D decision (see CHANGELOG): we
 * keep the heuristic logic in gstack so iteration doesn't require an
 * upstream PR cycle. The output format is gbrain-stable (gitignore syntax
 * via the `ignore` lib).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";

// ── Types (exported for tests) ─────────────────────────────────────────────

export type ProjectType =
  | "python"
  | "node"
  | "rust"
  | "go"
  | "ruby"
  | "java"
  | "generic";

export interface BigDir {
  name: string; // trailing slash; e.g. "chrome_profile/"
  size: string; // human-readable; e.g. "450M"
}

export interface ExtensionStat {
  ext: string; // lowercase, no dot; e.g. "json"
  count: number;
}

export interface BuildIgnoreOpts {
  projectTypes: ProjectType[];
  filteredGitignore: string[];
  bigDirs: BigDir[];
  excludeExtensions: string[];
  /** ISO timestamp string. Caller supplies — keeps the function deterministic for tests. */
  timestamp: string;
}

// ── Project type detection ────────────────────────────────────────────────

const PROJECT_TYPE_SIGNALS: Record<Exclude<ProjectType, "generic">, string[]> = {
  python: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "setup.cfg"],
  node: ["package.json"],
  rust: ["Cargo.toml"],
  go: ["go.mod"],
  ruby: ["Gemfile"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts"],
};

/**
 * Detect project type(s) from a list of root-level filenames. Returns sorted
 * unique types. Empty list means "no signals matched" — callers should fall
 * back to 'generic'.
 *
 * Pure function: takes filenames, returns types. No I/O.
 */
export function detectProjectType(rootEntries: string[]): ProjectType[] {
  const types = new Set<ProjectType>();
  const entrySet = new Set(rootEntries);
  for (const [type, signals] of Object.entries(PROJECT_TYPE_SIGNALS)) {
    for (const sig of signals) {
      if (entrySet.has(sig)) {
        types.add(type as ProjectType);
        break;
      }
    }
  }
  return [...types].sort() as ProjectType[];
}

// ── .gitignore filtering ──────────────────────────────────────────────────

/**
 * Patterns that gbrain's walker already prunes by default. Including them in
 * .gbrainignore is harmless but noisy — strip them so the generated file
 * only carries signal.
 *
 * Source: src/core/sync.ts:236-281 in the gbrain repo (directory prune list).
 */
const GBRAIN_AUTO_PRUNED = new Set([
  ".git",
  ".git/",
  "node_modules",
  "node_modules/",
  "ops",
  "ops/",
  ".venv",
  ".venv/",
  "venv",
  "venv/",
  ".idea",
  ".idea/",
  ".vscode",
  ".vscode/",
  ".DS_Store",
  "Thumbs.db",
  ".pytest_cache",
  ".pytest_cache/",
  ".mypy_cache",
  ".mypy_cache/",
  ".ruff_cache",
  ".ruff_cache/",
  ".cache",
  ".cache/",
  ".opencode",
  ".opencode/",
  ".claude",
  ".claude/",
  ".obsidian",
  ".obsidian/",
  ".sources",
  ".sources/",
  ".terraform",
  ".terraform/",
]);

/**
 * Heuristic: a pattern starting with `.` (and not in our explicit no-op list)
 * is probably a dotdir/dotfile that gbrain auto-prunes. Drop it from the
 * adopted list. Keep an allow-list for the rare case where a dotfile actually
 * matters (e.g. `.env` — sensitive content the user wants to confirm is
 * excluded, even though gbrain doesn't index dotfiles by default).
 */
const KEEP_DOT_PATTERNS = new Set([
  ".env",
  ".env.*",
  ".env.local",
  ".env.*.local",
]);

/**
 * Filter .gitignore lines down to the subset that's meaningful for gbrain:
 *   - drop comments + blank lines
 *   - drop entries gbrain auto-prunes (.git/, node_modules/, dotdirs, ...)
 *   - keep build artifacts (dist/, __pycache__/, *.egg-info/, target/, ...)
 *   - keep data/log patterns (*.log, data/, logs/, ...)
 *   - de-dupe while preserving order
 *
 * Pure function — input string array, output string array.
 */
export function filterGitignoreForBrain(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    // Drop gbrain-auto-pruned patterns (exact match)
    if (GBRAIN_AUTO_PRUNED.has(line)) continue;
    // Drop bare-dotfile patterns unless explicitly preserved
    if (line.startsWith(".") && !KEEP_DOT_PATTERNS.has(line)) {
      // Heuristic: if it looks like a dotfile/dir pattern, skip.
      // Examples dropped: .DS_Store, .idea/, .vscode/, .terraform/
      // Examples kept: .env, .env.local
      if (line.endsWith("/") || !line.includes(".", 1)) continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

// ── Project-type templates ────────────────────────────────────────────────

/**
 * Type-specific gbrainignore lines. Hand-curated from real-world projects.
 * Kept minimal — the goal is "covers 80% of users with project type X",
 * not "exhaustive". User-specific patterns go through Step 4 (big dirs) and
 * Step 5 (extensions).
 */
const TYPE_TEMPLATES: Record<Exclude<ProjectType, "generic">, string[]> = {
  python: [
    "__pycache__/",
    "*.py[cod]",
    "*.egg-info/",
    "dist/",
    "build/",
    ".coverage",
    "htmlcov/",
    ".tox/",
    ".nox/",
    "*.so",
  ],
  node: [
    "dist/",
    "build/",
    ".next/",
    ".nuxt/",
    "coverage/",
    "*.tsbuildinfo",
    ".turbo/",
  ],
  rust: ["target/", "Cargo.lock"],
  go: ["vendor/", "bin/", "*.test"],
  ruby: ["vendor/bundle/", "tmp/", "log/", "*.gem"],
  java: ["target/", "build/", "*.class", "*.jar", ".gradle/"],
};

export function getTypeTemplate(type: ProjectType): string[] {
  if (type === "generic") return [];
  return [...TYPE_TEMPLATES[type]];
}

// ── Rescue list (auto-! based on detected project types) ─────────────────

const TYPE_RESCUES: Record<Exclude<ProjectType, "generic">, string[]> = {
  python: ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"],
  node: ["package.json", "tsconfig.json", "*.config.js", "*.config.ts", "*.config.mjs", "*.config.cjs"],
  rust: ["Cargo.toml"],
  go: ["go.mod"],
  ruby: ["Gemfile"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts"],
};

/**
 * For a set of project types, return the rescue patterns (with leading `!`)
 * that should never be excluded by extension-level rules. Sorted + deduped.
 */
export function getRescueListForTypes(types: ProjectType[]): string[] {
  const set = new Set<string>();
  for (const t of types) {
    if (t === "generic") continue;
    for (const r of TYPE_RESCUES[t]) set.add(r);
  }
  return [...set].sort().map((p) => `!${p}`);
}

// ── Common runtime/data exclusions ────────────────────────────────────────

/**
 * Patterns that virtually every project benefits from excluding, regardless
 * of project type. Kept minimal: log files, temp files, OS junk that's
 * NOT already in the gbrain auto-prune list.
 */
const COMMON_RUNTIME = [
  "*.log",
  "*.tmp",
  "logs/",
  "tmp/",
  ".env",
  ".env.local",
  "*.pem",
  "*.key",
  "credentials.json",
  "secrets.json",
];

// ── Build the final .gbrainignore content ─────────────────────────────────

/**
 * Compose the .gbrainignore file content. Sections in order:
 *
 *   1. Header (auto-generated comment + timestamp + auto-prune reminder)
 *   2. Reused from .gitignore (filtered)
 *   3. Project type templates (one section per detected type)
 *   4. Common runtime/data (logs, tmp, secrets)
 *   5. Big dirs (user-confirmed)
 *   6. Extension-level excludes (user-selected)
 *   7. Rescue list (auto-! for config files)
 *
 * Pure function — input opts object, output string. Deterministic when
 * timestamp is fixed.
 */
export function buildIgnoreContent(opts: BuildIgnoreOpts): string {
  const sections: string[] = [];

  // Header
  sections.push(
    "# .gbrainignore — generated by /gbrain-init-ignore on " + opts.timestamp,
    "#",
    "# gbrain auto-prunes these (no need to repeat):",
    "#   .git/, .venv/, node_modules/, ops/, *.raw/, git submodules, all dot-prefix dirs",
    "#",
    "# Syntax: gitignore (parsed by the `ignore` npm lib).",
    "# Last match wins. `!` rescues — use sparingly; any `!` disables gbrain's",
    "# walker dir-prune optimization (see gbrain v0.40.9.0 design notes).",
  );

  // Section 2 — adopted from .gitignore
  if (opts.filteredGitignore.length > 0) {
    sections.push("", `# ── Reused from .gitignore (${opts.filteredGitignore.length} entr${opts.filteredGitignore.length === 1 ? "y" : "ies"}) ──`);
    sections.push(...opts.filteredGitignore);
  }

  // Section 3 — project type templates (skip entries already covered by gitignore)
  const gitignoreSet = new Set(opts.filteredGitignore);
  const emittedTypePatterns = new Set<string>();
  for (const type of opts.projectTypes) {
    const tmpl = getTypeTemplate(type).filter(
      (p) => !gitignoreSet.has(p) && !emittedTypePatterns.has(p),
    );
    if (tmpl.length === 0) continue;
    for (const p of tmpl) emittedTypePatterns.add(p);
    sections.push("", `# ── Project type: ${type} ──`);
    sections.push(...tmpl);
  }

  // Section 4 — common runtime (only entries not already covered above)
  const alreadyCovered = new Set<string>([
    ...opts.filteredGitignore,
    ...emittedTypePatterns,
  ]);
  const commonNew = COMMON_RUNTIME.filter((p) => !alreadyCovered.has(p));
  if (commonNew.length > 0) {
    sections.push("", "# ── Common runtime / sensitive data ──");
    sections.push(...commonNew);
  }

  // Section 5 — big dirs (only entries not already covered above)
  const allSoFar = new Set<string>([
    ...alreadyCovered,
    ...commonNew,
  ]);
  const bigDirsNew = opts.bigDirs.filter((d) => !allSoFar.has(d.name));
  if (bigDirsNew.length > 0) {
    sections.push("", "# ── Big directories (>50MB; confirmed by user) ──");
    for (const d of bigDirsNew) {
      sections.push(`${d.name}   # ${d.size}`);
    }
  }

  // Section 6 — extension excludes
  if (opts.excludeExtensions.length > 0) {
    sections.push("", `# ── Extension-level exclusions (${opts.excludeExtensions.length} ext${opts.excludeExtensions.length === 1 ? "" : "s"}; user-selected) ──`);
    sections.push("# gbrain's auto strategy treats these as code; opted out so retrieval");
    sections.push("# stays focused on actual source files.");
    for (const ext of opts.excludeExtensions) {
      sections.push(`*.${ext}`);
    }
  }

  // Section 7 — rescues (only if there are extension excludes; otherwise no point)
  if (opts.excludeExtensions.length > 0) {
    const rescues = getRescueListForTypes(opts.projectTypes);
    if (rescues.length > 0) {
      sections.push("", "# ── Rescues: important config files always indexed ──");
      sections.push(...rescues);
    }
  }

  return sections.join("\n") + "\n";
}

// ── Side effects ──────────────────────────────────────────────────────────

/**
 * Scan top-level entries in `root`. Returns plain filenames (no path).
 * Excludes dotfiles + dotdirs to keep the signal-set small.
 */
function listRootEntries(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Find top-level directories larger than `minMb` MB. Uses `du -sh` because
 * it's ~10x faster than walking ourselves and skips perms issues quietly.
 *
 * `du` output format: "1.2G\tchrome_profile" (size, tab, name). We parse
 * conservatively and skip rows where the size unit is K (always under
 * threshold) or B (unusual; not worth handling).
 *
 * Returns sorted by size descending.
 */
function scanBigDirs(root: string, minMb: number): BigDir[] {
  let raw: string;
  try {
    raw = execSync(`du -sh */ 2>/dev/null`, {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 5 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch {
    return [];
  }

  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const out: BigDir[] = [];
  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const sizeStr = match[1]!;
    let name = match[2]!.trim();
    // Normalize: ensure trailing slash; strip leading ./
    if (name.startsWith("./")) name = name.slice(2);
    if (!name.endsWith("/")) name = name + "/";

    // Parse size into MB for thresholding
    const unit = sizeStr.slice(-1);
    const num = parseFloat(sizeStr.slice(0, -1));
    if (!Number.isFinite(num)) continue;
    let mb: number;
    if (unit === "K") mb = num / 1024;
    else if (unit === "M") mb = num;
    else if (unit === "G") mb = num * 1024;
    else if (unit === "T") mb = num * 1024 * 1024;
    else continue; // Skip "B" rows etc.

    if (mb < minMb) continue;
    out.push({ name, size: sizeStr });
  }
  // Sort descending by MB equivalent
  out.sort((a, b) => sizeToMb(b.size) - sizeToMb(a.size));
  return out;
}

function sizeToMb(s: string): number {
  const unit = s.slice(-1);
  const num = parseFloat(s.slice(0, -1));
  if (!Number.isFinite(num)) return 0;
  if (unit === "K") return num / 1024;
  if (unit === "M") return num;
  if (unit === "G") return num * 1024;
  if (unit === "T") return num * 1024 * 1024;
  return 0;
}

/**
 * Scan file extensions in `root`. Skips gbrain-auto-pruned dirs (dotdirs,
 * node_modules, .venv) so the distribution reflects what gbrain would
 * actually see. Returns top-N extensions sorted by file count descending.
 *
 * Uses `find` for the same reason as `du`: shells out, fast, handles
 * perms quietly.
 */
function scanExtensions(root: string, topN: number): ExtensionStat[] {
  // -prune for dotdirs and well-known noise. Note: -prune must come BEFORE -o for the
  // OR fork to apply correctly. The script lives one-line so the bash inside it stays
  // readable.
  //
  // CRITICAL: `-name '.?*'` (not `-name '.*'`). The latter matches `.` itself
  // (the cwd) and prunes the entire traversal before any file is found. The
  // `?` requires at least one character after the dot — matches `.cache`,
  // `.git`, etc. but never `.`.
  const cmd = `find . -type d \\( -name '.?*' -o -name 'node_modules' -o -name '.venv' -o -name 'venv' \\) -prune -o -type f -name '*.*' -print 2>/dev/null | sed 's/.*\\.//' | tr 'A-Z' 'a-z' | sort | uniq -c | sort -rn | head -${topN * 2}`;
  let raw: string;
  try {
    raw = execSync(cmd, {
      cwd: root,
      encoding: "utf-8",
      shell: "/bin/bash",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 5 * 1024 * 1024,
      timeout: 60_000,
    });
  } catch {
    return [];
  }
  const out: ExtensionStat[] = [];
  for (const line of raw.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const count = parseInt(m[1]!, 10);
    const ext = m[2]!.trim();
    // Sanity-cap: ext should be short; longer values are bogus matches
    // (filenames with no real extension produce noise).
    if (ext.length === 0 || ext.length > 20) continue;
    // Skip obviously-noise extensions
    if (/[^a-z0-9_]/.test(ext)) continue;
    out.push({ ext, count });
  }
  return out.slice(0, topN);
}

/**
 * Read a .gitignore file as lines. Returns empty array on missing file.
 */
function readGitignoreLines(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    return raw.split(/\r?\n/);
  } catch {
    return [];
  }
}

// ── CLI dispatcher ─────────────────────────────────────────────────────────

interface ParsedArgs {
  mode: "scan-big-dirs" | "scan-extensions" | "build" | "detect-types" | "help";
  root: string;
  minMb: number;
  topN: number;
  projectTypes: ProjectType[];
  gitignorePath: string | null;
  bigDirs: BigDir[];
  excludeExtensions: string[];
  timestamp: string;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    mode: "help",
    root: process.cwd(),
    minMb: 50,
    topN: 20,
    projectTypes: [],
    gitignorePath: null,
    bigDirs: [],
    excludeExtensions: [],
    timestamp: new Date().toISOString().split("T")[0]!,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--scan-big-dirs") args.mode = "scan-big-dirs";
    else if (arg === "--scan-extensions") args.mode = "scan-extensions";
    else if (arg === "--build") args.mode = "build";
    else if (arg === "--detect-types") args.mode = "detect-types";
    else if (arg === "--help" || arg === "-h") args.mode = "help";
    else if (arg === "--json") args.json = true;
    else if (arg === "--root") args.root = resolve(argv[++i]!);
    else if (arg === "--min-mb") args.minMb = parseInt(argv[++i]!, 10);
    else if (arg === "--top") args.topN = parseInt(argv[++i]!, 10);
    else if (arg === "--gitignore") args.gitignorePath = argv[++i]!;
    else if (arg === "--timestamp") args.timestamp = argv[++i]!;
    else if (arg === "--project-types") {
      const csv = argv[++i]!;
      args.projectTypes = csv.split(",").map((s) => s.trim()).filter(Boolean) as ProjectType[];
    } else if (arg === "--big-dirs") {
      try {
        const parsed = JSON.parse(argv[++i]!);
        // Accept either string[] (legacy) or BigDir[]
        if (Array.isArray(parsed)) {
          args.bigDirs = parsed.map((p: unknown) => {
            if (typeof p === "string") return { name: p, size: "?" };
            const obj = p as { name?: unknown; size?: unknown };
            return { name: String(obj.name ?? ""), size: String(obj.size ?? "?") };
          }).filter((b) => b.name !== "");
        }
      } catch {
        // Ignore malformed input — caller will see empty list
      }
    } else if (arg === "--exclude-ext") {
      try {
        const parsed = JSON.parse(argv[++i]!);
        if (Array.isArray(parsed)) {
          args.excludeExtensions = parsed.map((s: unknown) => String(s).toLowerCase().replace(/^\./, ""));
        }
      } catch {
        // Ignore malformed input
      }
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`gstack-gbrainignore-gen — scaffold a .gbrainignore file

Usage:
  bun run gstack-gbrainignore-gen.ts --detect-types --root <p> --json
  bun run gstack-gbrainignore-gen.ts --scan-big-dirs --root <p> [--min-mb N] --json
  bun run gstack-gbrainignore-gen.ts --scan-extensions --root <p> [--top N] --json
  bun run gstack-gbrainignore-gen.ts --build \\
      --project-types python,node \\
      --gitignore .gitignore \\
      --big-dirs '["runs/","data/"]' \\
      --exclude-ext '["json","yaml"]' \\
      [--timestamp YYYY-MM-DD]

See /gbrain-init-ignore skill for the interactive workflow.`);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "help") {
    printHelp();
    return 0;
  }

  if (args.mode === "detect-types") {
    const entries = listRootEntries(args.root);
    const types = detectProjectType(entries);
    if (args.json) {
      console.log(JSON.stringify({ project_types: types.length > 0 ? types : ["generic"] }));
    } else {
      console.log(types.length > 0 ? types.join(",") : "generic");
    }
    return 0;
  }

  if (args.mode === "scan-big-dirs") {
    const dirs = scanBigDirs(args.root, args.minMb);
    if (args.json) {
      console.log(JSON.stringify({ big_dirs: dirs }));
    } else {
      for (const d of dirs) console.log(`${d.size}\t${d.name}`);
    }
    return 0;
  }

  if (args.mode === "scan-extensions") {
    const exts = scanExtensions(args.root, args.topN);
    if (args.json) {
      console.log(JSON.stringify({ extensions: exts }));
    } else {
      for (const e of exts) console.log(`${e.count}\t.${e.ext}`);
    }
    return 0;
  }

  if (args.mode === "build") {
    const types = args.projectTypes.length > 0 ? args.projectTypes : ["generic" as ProjectType];
    const gitignoreLines = args.gitignorePath
      ? readGitignoreLines(args.gitignorePath)
      : [];
    const filtered = filterGitignoreForBrain(gitignoreLines);
    const content = buildIgnoreContent({
      projectTypes: types,
      filteredGitignore: filtered,
      bigDirs: args.bigDirs,
      excludeExtensions: args.excludeExtensions,
      timestamp: args.timestamp,
    });
    process.stdout.write(content);
    return 0;
  }

  printHelp();
  return 1;
}

// Only run main() when invoked directly. When imported (e.g. by tests), the
// CLI stays inert so the test file can call the pure exports without
// triggering side effects.
if (import.meta.main) {
  process.exit(main());
}
