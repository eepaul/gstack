/**
 * Preamble composition order — gate-tier test.
 *
 * Asserts that the AskUserQuestion Format section renders BEFORE the
 * Model-Specific Behavioral Patch section in tier-≥2 preamble output.
 * This order is load-bearing: Opus 4.7 reads top-to-bottom and absorbs
 * the first pacing directive it hits. v1.6.4.0 regressed plan-review
 * cadence because the overlay rendered first with "Batch your questions"
 * as the ambient default.
 *
 * If someone later reorders `scripts/resolvers/preamble.ts` so Overlay
 * comes before Format, this test catches it before the next model
 * migration can silently re-break the plan-review pacing.
 */
import { describe, test, expect } from 'bun:test';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { generatePreamble } from '../scripts/resolvers/preamble';

function makeCtx(
  host: 'claude' | 'codex' | 'opencode',
  tier: 1 | 2 | 3 | 4,
  model?: string,
): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host,
    paths: HOST_PATHS[host],
    preambleTier: tier,
    ...(model ? { model } : {}),
  };
}

describe('Preamble composition order', () => {
  test('AskUserQuestion Format renders before Model-Specific Behavioral Patch (tier 2, claude)', () => {
    const out = generatePreamble(makeCtx('claude', 2, 'claude'));
    const formatIdx = out.indexOf('## AskUserQuestion Format');
    const overlayIdx = out.indexOf('## Model-Specific Behavioral Patch');
    expect(formatIdx).toBeGreaterThan(-1);
    expect(overlayIdx).toBeGreaterThan(-1);
    expect(formatIdx).toBeLessThan(overlayIdx);
  });

  test('AskUserQuestion Format renders before Model-Specific Behavioral Patch (tier 2, opus-4-7)', () => {
    const out = generatePreamble(makeCtx('claude', 2, 'opus-4-7'));
    const formatIdx = out.indexOf('## AskUserQuestion Format');
    const overlayIdx = out.indexOf('## Model-Specific Behavioral Patch');
    expect(formatIdx).toBeGreaterThan(-1);
    expect(overlayIdx).toBeGreaterThan(-1);
    expect(formatIdx).toBeLessThan(overlayIdx);
  });

  test('AskUserQuestion Format renders before Model-Specific Behavioral Patch (tier 3)', () => {
    const out = generatePreamble(makeCtx('claude', 3, 'opus-4-7'));
    const formatIdx = out.indexOf('## AskUserQuestion Format');
    const overlayIdx = out.indexOf('## Model-Specific Behavioral Patch');
    expect(formatIdx).toBeLessThan(overlayIdx);
  });

  test('AskUserQuestion Format renders before Model-Specific Behavioral Patch (codex host)', () => {
    const out = generatePreamble(makeCtx('codex', 2, 'opus-4-7'));
    const formatIdx = out.indexOf('## AskUserQuestion Format');
    const overlayIdx = out.indexOf('## Model-Specific Behavioral Patch');
    expect(formatIdx).toBeLessThan(overlayIdx);
  });

  test('tier 1 preamble does NOT include AskUserQuestion Format (but MAY include overlay)', () => {
    const out = generatePreamble(makeCtx('claude', 1));
    expect(out).not.toContain('## AskUserQuestion Format');
  });

  /**
   * Regression: GSTACK_ROOT re-point check must require bin/ subdirectory.
   *
   * Bug (v1.3.0.0 – v1.46.0.0): the check `[ -d "$_ROOT/.opencode/skills/gstack" ]`
   * was too lenient. In the canonical gstack development repo, that directory
   * exists (gen-skill-docs creates it for the root skill artifact) but contains
   * ONLY SKILL.md — no bin/, browse/, design/. The lenient check re-pointed
   * GSTACK_ROOT to that incomplete path, GSTACK_BIN became non-existent, and
   * every $GSTACK_BIN/gstack-* call silently failed via `|| echo "default"`.
   * Symptom: SLUG defaulted to "unknown", learnings.jsonl pointed at the wrong
   * path (projects/unknown/), every config get returned its fallback.
   *
   * Fix: require the bin/ subdirectory to exist, not just the parent dir.
   * This way vendored installs (which copy/symlink the full subtree) still
   * re-point correctly, while gstack-itself contributors get the global
   * install path.
   */
  test('GSTACK_ROOT re-point check requires bin/ subdirectory (opencode)', () => {
    const out = generatePreamble(makeCtx('opencode', 2, 'claude'));
    // The GSTACK_ROOT re-point chain must check bin/ specifically — not just
    // the parent dir. Otherwise the gstack-itself development repo (where
    // .opencode/skills/gstack/ exists with only SKILL.md, no bin/) gets
    // GSTACK_BIN pointed at a non-existent path. The full assertion includes
    // the assignment to keep this narrow to the re-point check and not the
    // vendored-gstack detection further down (which uses the same prefix).
    expect(out).toContain('[ -d "$_ROOT/.opencode/skills/gstack/bin" ] && GSTACK_ROOT="$_ROOT/.opencode/skills/gstack"');
    expect(out).not.toContain('[ -d "$_ROOT/.opencode/skills/gstack" ] && GSTACK_ROOT=');
  });

  test('GSTACK_ROOT re-point check requires bin/ subdirectory (codex → .agents path)', () => {
    const out = generatePreamble(makeCtx('codex', 2, 'claude'));
    // codex host's localSkillRoot is .agents/skills/gstack per hosts/codex.ts.
    expect(out).toContain('[ -d "$_ROOT/.agents/skills/gstack/bin" ] && GSTACK_ROOT="$_ROOT/.agents/skills/gstack"');
    expect(out).not.toContain('[ -d "$_ROOT/.agents/skills/gstack" ] && GSTACK_ROOT=');
  });

  test('claude host does NOT inject GSTACK_ROOT re-point (usesEnvVars=false)', () => {
    const out = generatePreamble(makeCtx('claude', 2, 'claude'));
    // Sanity guard: claude inlines `~/.claude/skills/gstack/...` paths
    // directly and never emits the `_ROOT=$(git rev-parse...)` block.
    // If a future change flips usesEnvVars for claude, this test forces
    // the author to also update the regression assertion above.
    expect(out).not.toContain('_ROOT=$(git rev-parse');
    expect(out).not.toContain('GSTACK_ROOT="$_ROOT/');
  });
});
