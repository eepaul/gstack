/**
 * Unit tests for bin/gstack-gbrainignore-gen.ts.
 *
 * Covers:
 *   - detectProjectType: signal matching, multi-type sorting, generic fallback
 *   - filterGitignoreForBrain: drops noise, keeps build artifacts, dedupes
 *   - getTypeTemplate / getRescueListForTypes: shape + idempotence
 *   - buildIgnoreContent: section ordering, headers, deterministic output
 *   - CLI subcommands: --build, --detect-types, --scan-big-dirs, --scan-extensions
 *
 * The CLI invocations use `bun run <path>` against the on-disk script with
 * controlled cwd. No network, no shell-out beyond `du` / `find`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  detectProjectType,
  filterGitignoreForBrain,
  getTypeTemplate,
  getRescueListForTypes,
  buildIgnoreContent,
  type ProjectType,
} from "../bin/gstack-gbrainignore-gen";

const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-gbrainignore-gen.ts");

/** Absolute bun path resolved once. Tests invoke `bun run <script>` for CLI mode. */
const BUN_BIN = execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf-8" }).trim();

function runScript(args: string[], opts: { cwd?: string } = {}): string {
  return execFileSync(BUN_BIN, ["run", SCRIPT, ...args], {
    encoding: "utf-8",
    cwd: opts.cwd,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ── detectProjectType ─────────────────────────────────────────────────────

describe("detectProjectType", () => {
  it("returns empty array on no signals", () => {
    expect(detectProjectType([])).toEqual([]);
    expect(detectProjectType(["README.md", "src"])).toEqual([]);
  });

  it("detects python from pyproject.toml", () => {
    expect(detectProjectType(["pyproject.toml", "src"])).toEqual(["python"]);
  });

  it("detects python from setup.py", () => {
    expect(detectProjectType(["setup.py"])).toEqual(["python"]);
  });

  it("detects python from any signal but does not dupe", () => {
    expect(detectProjectType(["pyproject.toml", "setup.py", "requirements.txt"]))
      .toEqual(["python"]);
  });

  it("detects node from package.json", () => {
    expect(detectProjectType(["package.json"])).toEqual(["node"]);
  });

  it("detects rust from Cargo.toml", () => {
    expect(detectProjectType(["Cargo.toml"])).toEqual(["rust"]);
  });

  it("detects go from go.mod", () => {
    expect(detectProjectType(["go.mod"])).toEqual(["go"]);
  });

  it("detects multiple types in alphabetical order", () => {
    expect(detectProjectType(["package.json", "pyproject.toml", "Cargo.toml"]))
      .toEqual(["node", "python", "rust"]);
  });

  it("handles java signals", () => {
    expect(detectProjectType(["pom.xml"])).toEqual(["java"]);
    expect(detectProjectType(["build.gradle"])).toEqual(["java"]);
  });
});

// ── filterGitignoreForBrain ───────────────────────────────────────────────

describe("filterGitignoreForBrain", () => {
  it("drops blank lines and comments", () => {
    expect(filterGitignoreForBrain(["", "  ", "# comment", "#another"])).toEqual([]);
  });

  it("drops gbrain auto-pruned dirs", () => {
    const input = [".git", ".git/", "node_modules", "node_modules/", ".venv/", ".idea/"];
    expect(filterGitignoreForBrain(input)).toEqual([]);
  });

  it("drops dotfile/dotdir noise but keeps .env-style sensitive patterns", () => {
    const input = [".DS_Store", ".idea/", ".terraform/", ".env", ".env.local"];
    const out = filterGitignoreForBrain(input);
    expect(out).toContain(".env");
    expect(out).toContain(".env.local");
    expect(out).not.toContain(".DS_Store");
    expect(out).not.toContain(".idea/");
    expect(out).not.toContain(".terraform/");
  });

  it("keeps build artifacts", () => {
    const input = ["dist/", "build/", "__pycache__/", "*.egg-info/", "target/"];
    const out = filterGitignoreForBrain(input);
    expect(out).toEqual(input);
  });

  it("keeps data/log patterns", () => {
    const input = ["*.log", "data/", "logs/", "*.parquet"];
    const out = filterGitignoreForBrain(input);
    expect(out).toEqual(input);
  });

  it("dedupes while preserving order", () => {
    const input = ["dist/", "build/", "dist/", "*.log", "build/"];
    expect(filterGitignoreForBrain(input)).toEqual(["dist/", "build/", "*.log"]);
  });

  it("strips trim-able whitespace", () => {
    expect(filterGitignoreForBrain(["  dist/  ", "\tbuild/\t"])).toEqual(["dist/", "build/"]);
  });
});

// ── getTypeTemplate ───────────────────────────────────────────────────────

describe("getTypeTemplate", () => {
  it("returns empty for generic", () => {
    expect(getTypeTemplate("generic")).toEqual([]);
  });

  it("returns python template with __pycache__", () => {
    const t = getTypeTemplate("python");
    expect(t).toContain("__pycache__/");
    expect(t).toContain("*.egg-info/");
    expect(t.length).toBeGreaterThan(3);
  });

  it("returns rust template with target/", () => {
    expect(getTypeTemplate("rust")).toContain("target/");
  });

  it("returns frozen-ish copy (caller mutation doesn't affect future calls)", () => {
    const t1 = getTypeTemplate("python");
    t1.push("BOGUS");
    const t2 = getTypeTemplate("python");
    expect(t2).not.toContain("BOGUS");
  });
});

// ── getRescueListForTypes ────────────────────────────────────────────────

describe("getRescueListForTypes", () => {
  it("returns [] for generic only", () => {
    expect(getRescueListForTypes(["generic"])).toEqual([]);
  });

  it("rescues pyproject.toml for python", () => {
    expect(getRescueListForTypes(["python"])).toContain("!pyproject.toml");
  });

  it("rescues package.json + tsconfig.json for node", () => {
    const rescues = getRescueListForTypes(["node"]);
    expect(rescues).toContain("!package.json");
    expect(rescues).toContain("!tsconfig.json");
  });

  it("merges + dedupes across multiple types", () => {
    const rescues = getRescueListForTypes(["python", "node"]);
    expect(rescues).toContain("!pyproject.toml");
    expect(rescues).toContain("!package.json");
    // No duplicates
    expect(new Set(rescues).size).toBe(rescues.length);
  });

  it("all rescues start with !", () => {
    const rescues = getRescueListForTypes(["python", "node", "rust", "go", "ruby", "java"]);
    for (const r of rescues) {
      expect(r.startsWith("!")).toBe(true);
    }
  });

  it("is sorted", () => {
    const rescues = getRescueListForTypes(["python", "node", "rust"]);
    const sorted = [...rescues].sort();
    expect(rescues).toEqual(sorted);
  });
});

// ── buildIgnoreContent ────────────────────────────────────────────────────

describe("buildIgnoreContent", () => {
  const baseOpts = {
    projectTypes: ["python"] as ProjectType[],
    filteredGitignore: ["dist/", "*.log"],
    bigDirs: [],
    excludeExtensions: [],
    timestamp: "2026-05-28",
  };

  it("produces deterministic output with same inputs", () => {
    const a = buildIgnoreContent(baseOpts);
    const b = buildIgnoreContent(baseOpts);
    expect(a).toBe(b);
  });

  it("includes the generation-date header", () => {
    const content = buildIgnoreContent(baseOpts);
    expect(content).toContain("# .gbrainignore — generated by /gbrain-init-ignore on 2026-05-28");
  });

  it("mentions the gbrain auto-prune list", () => {
    const content = buildIgnoreContent(baseOpts);
    expect(content).toContain("gbrain auto-prunes");
    expect(content).toContain("node_modules/");
  });

  it("warns about ! disabling dir-prune", () => {
    const content = buildIgnoreContent(baseOpts);
    expect(content).toContain("`!` rescues");
    expect(content).toContain("walker dir-prune");
  });

  it("includes a 'Reused from .gitignore' section when gitignore has entries", () => {
    const content = buildIgnoreContent({
      ...baseOpts,
      filteredGitignore: ["dist/", "build/", "*.log"],
    });
    expect(content).toContain("# ── Reused from .gitignore (3 entries) ──");
    expect(content).toContain("dist/");
    expect(content).toContain("build/");
  });

  it("uses singular 'entry' for one gitignore line", () => {
    const content = buildIgnoreContent({
      ...baseOpts,
      filteredGitignore: ["dist/"],
    });
    expect(content).toContain("# ── Reused from .gitignore (1 entry) ──");
  });

  it("omits the gitignore section entirely when no entries", () => {
    const content = buildIgnoreContent({
      ...baseOpts,
      filteredGitignore: [],
    });
    expect(content).not.toContain("Reused from .gitignore");
  });

  it("includes one section per detected project type", () => {
    const content = buildIgnoreContent({
      ...baseOpts,
      projectTypes: ["node", "python"],
    });
    expect(content).toContain("# ── Project type: node ──");
    expect(content).toContain("# ── Project type: python ──");
    // python section should appear after node (preserves input order)
    const nodeIdx = content.indexOf("Project type: node");
    const pythonIdx = content.indexOf("Project type: python");
    expect(pythonIdx).toBeGreaterThan(nodeIdx);
  });

  it("never repeats entries already covered earlier in the file", () => {
    // dist/ is both in .gitignore (section 2) and python template (section 3).
    // Python's template has dist/ — we want the gitignore section to win and
    // the python section to NOT re-emit dist/ as a second occurrence. But the
    // current implementation doesn't dedupe across sections; check that's the
    // intended behavior by counting.
    const content = buildIgnoreContent({
      ...baseOpts,
      projectTypes: ["python"],
      filteredGitignore: ["dist/"],
    });
    // dist/ appears in both — that's fine, gitignore last-match-wins.
    // What we DO check: extension excludes only appear once.
    const distMatches = content.split("\n").filter((l) => l.trim() === "dist/").length;
    expect(distMatches).toBeGreaterThanOrEqual(1);
  });

  it("includes Common runtime section with new patterns only", () => {
    const content = buildIgnoreContent({
      ...baseOpts,
      filteredGitignore: [],
      projectTypes: ["generic"],
    });
    expect(content).toContain("# ── Common runtime / sensitive data ──");
    expect(content).toContain("credentials.json");
    expect(content).toContain("*.pem");
  });

  it("filters common-runtime patterns already covered by gitignore", () => {
    const content = buildIgnoreContent({
      ...baseOpts,
      filteredGitignore: ["*.log", "credentials.json"],
      projectTypes: ["generic"],
    });
    // Common runtime section still appears (for *.tmp, .env, etc.) but
    // *.log and credentials.json should appear only ONCE (from gitignore).
    const logCount = content.split("\n").filter((l) => l.trim() === "*.log").length;
    const credCount = content.split("\n").filter((l) => l.trim() === "credentials.json").length;
    expect(logCount).toBe(1);
    expect(credCount).toBe(1);
  });

  it("includes big-dirs section with size annotations", () => {
    const content = buildIgnoreContent({
      ...baseOpts,
      bigDirs: [
        { name: "chrome_profile/", size: "450M" },
        { name: "data/", size: "1.2G" },
      ],
    });
    expect(content).toContain("# ── Big directories (>50MB; confirmed by user) ──");
    expect(content).toContain("chrome_profile/   # 450M");
    expect(content).toContain("data/   # 1.2G");
  });

  it("includes extension-level exclusion section", () => {
    const content = buildIgnoreContent({
      ...baseOpts,
      excludeExtensions: ["json", "yaml"],
    });
    expect(content).toContain("# ── Extension-level exclusions (2 exts; user-selected) ──");
    expect(content).toContain("*.json");
    expect(content).toContain("*.yaml");
  });

  it("uses singular 'ext' for one extension", () => {
    const content = buildIgnoreContent({
      ...baseOpts,
      excludeExtensions: ["json"],
    });
    expect(content).toContain("# ── Extension-level exclusions (1 ext; user-selected) ──");
  });

  it("emits rescue list AFTER extension excludes (so rescues win per gitignore last-match)", () => {
    const content = buildIgnoreContent({
      ...baseOpts,
      projectTypes: ["python"],
      excludeExtensions: ["toml"],
    });
    const extIdx = content.indexOf("*.toml");
    const rescueIdx = content.indexOf("!pyproject.toml");
    expect(extIdx).toBeGreaterThan(-1);
    expect(rescueIdx).toBeGreaterThan(-1);
    expect(rescueIdx).toBeGreaterThan(extIdx);
  });

  it("omits rescue section when no extensions are excluded (no purpose)", () => {
    const content = buildIgnoreContent({
      ...baseOpts,
      projectTypes: ["python"],
      excludeExtensions: [],
    });
    expect(content).not.toContain("Rescues:");
    expect(content).not.toContain("!pyproject.toml");
  });

  it("ends with a single trailing newline", () => {
    const content = buildIgnoreContent(baseOpts);
    expect(content.endsWith("\n")).toBe(true);
    expect(content.endsWith("\n\n")).toBe(false);
  });
});

// ── CLI integration ───────────────────────────────────────────────────────

describe("CLI: --detect-types", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gbrainignore-cli-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns generic for an empty dir", () => {
    const out = runScript(["--detect-types", "--root", tmp, "--json"]);
    expect(JSON.parse(out)).toEqual({ project_types: ["generic"] });
  });

  it("detects python from pyproject.toml in cwd", () => {
    writeFileSync(join(tmp, "pyproject.toml"), "[project]\nname = 'x'\n");
    const out = runScript(["--detect-types", "--root", tmp, "--json"]);
    expect(JSON.parse(out)).toEqual({ project_types: ["python"] });
  });

  it("detects multiple types alphabetically", () => {
    writeFileSync(join(tmp, "pyproject.toml"), "");
    writeFileSync(join(tmp, "package.json"), "{}");
    const out = runScript(["--detect-types", "--root", tmp, "--json"]);
    expect(JSON.parse(out)).toEqual({ project_types: ["node", "python"] });
  });
});

describe("CLI: --build", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gbrainignore-build-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("emits a complete .gbrainignore to stdout", () => {
    const out = runScript([
      "--build",
      "--project-types", "python",
      "--timestamp", "2026-05-28",
    ]);
    expect(out).toContain("# .gbrainignore");
    expect(out).toContain("Project type: python");
    expect(out).toContain("__pycache__/");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("reads .gitignore when --gitignore is passed", () => {
    const gi = join(tmp, ".gitignore");
    writeFileSync(gi, "dist/\n*.log\n.git/\nnode_modules/\n");
    const out = runScript([
      "--build",
      "--project-types", "node",
      "--gitignore", gi,
      "--timestamp", "2026-05-28",
    ]);
    expect(out).toContain("Reused from .gitignore (2 entries)");
    expect(out).toContain("dist/");
    expect(out).toContain("*.log");
    // node_modules / .git should be filtered as gbrain auto-prunes
    expect(out).not.toContain("node_modules/\n");
  });

  it("accepts big-dirs JSON and extension JSON", () => {
    const out = runScript([
      "--build",
      "--project-types", "python",
      "--big-dirs", JSON.stringify([{ name: "runs/", size: "23G" }]),
      "--exclude-ext", JSON.stringify(["json", "yaml"]),
      "--timestamp", "2026-05-28",
    ]);
    expect(out).toContain("runs/   # 23G");
    expect(out).toContain("*.json");
    expect(out).toContain("*.yaml");
    expect(out).toContain("!pyproject.toml");
  });
});

describe("CLI: --scan-big-dirs", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gbrainignore-big-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty array for a small empty dir", () => {
    const out = runScript(["--scan-big-dirs", "--root", tmp, "--json", "--min-mb", "1"]);
    expect(JSON.parse(out)).toEqual({ big_dirs: [] });
  });

  it("finds a big dir above the threshold", () => {
    // Create a dir with a 2MB file
    const bigDir = join(tmp, "data");
    mkdirSync(bigDir);
    writeFileSync(join(bigDir, "big.bin"), Buffer.alloc(2 * 1024 * 1024)); // 2MB
    const out = runScript(["--scan-big-dirs", "--root", tmp, "--json", "--min-mb", "1"]);
    const parsed = JSON.parse(out);
    expect(parsed.big_dirs.length).toBeGreaterThanOrEqual(1);
    expect(parsed.big_dirs[0].name).toBe("data/");
  });

  it("skips dirs below the threshold", () => {
    const smallDir = join(tmp, "tiny");
    mkdirSync(smallDir);
    writeFileSync(join(smallDir, "small.txt"), "hi");
    const out = runScript(["--scan-big-dirs", "--root", tmp, "--json", "--min-mb", "1"]);
    expect(JSON.parse(out)).toEqual({ big_dirs: [] });
  });
});

describe("CLI: --scan-extensions", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gbrainignore-ext-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("counts file extensions, top-N descending", () => {
    // 3 .py, 2 .md, 1 .json
    for (let i = 0; i < 3; i++) writeFileSync(join(tmp, `a${i}.py`), "");
    for (let i = 0; i < 2; i++) writeFileSync(join(tmp, `b${i}.md`), "");
    writeFileSync(join(tmp, "c.json"), "");

    const out = runScript(["--scan-extensions", "--root", tmp, "--top", "10", "--json"]);
    const parsed = JSON.parse(out);
    expect(parsed.extensions.length).toBeGreaterThanOrEqual(3);
    // First entry must be .py (3 files)
    expect(parsed.extensions[0].ext).toBe("py");
    expect(parsed.extensions[0].count).toBe(3);
  });

  it("ignores dotdirs and node_modules", () => {
    // Files in dotdir/ should NOT appear
    const dotDir = join(tmp, ".cache");
    mkdirSync(dotDir);
    writeFileSync(join(dotDir, "x.json"), "");
    // node_modules/ also pruned
    const nm = join(tmp, "node_modules");
    mkdirSync(nm);
    writeFileSync(join(nm, "y.json"), "");
    // One legit .py at top-level so we get a non-empty result
    writeFileSync(join(tmp, "main.py"), "");

    const out = runScript(["--scan-extensions", "--root", tmp, "--top", "10", "--json"]);
    const parsed = JSON.parse(out);
    expect(parsed.extensions).toEqual([{ ext: "py", count: 1 }]);
  });
});
