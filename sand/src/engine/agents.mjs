/**
 * The agent registry.
 *
 * Everything that differs between the two harnesses lives here and nowhere
 * else. The supervisor treats an agent as: a repo to clone, a command to
 * spawn, and a mapping from its argv conventions to ours. Adding a third
 * agent means adding a row here, not touching the supervisor.
 *
 * Both harnesses read OPENAI_API_KEY from process.env, and in both the
 * process environment wins over their own .env file. That is why the
 * sandbox injects the credential at spawn time and never writes it to disk
 * inside a clone.
 */

export const AGENTS = [
  {
    id: "pilean",
    label: "pilean",
    discipline: "lean method",
    repo: "https://github.com/sallespro/pilean.git",
    // Path to the package root within the clone, relative to the clone dir.
    packageDir: ".",
    entry: "bin/lean-har.mjs",
    /**
     * pilean takes the workspace as `--root`. It also accepts `--contract`,
     * which is what lets its BUILD -> VERIFY gate pass; without one the run
     * still completes but that gate refuses.
     */
    argv({ task, workspace, contract }) {
      const args = [task, "--root", workspace];
      if (contract) args.push("--contract", contract);
      return args;
    },
    /**
     * lean's gates read `git diff HEAD`, so work that is never staged is
     * invisible to them: an agent that writes a perfect file and stages
     * nothing is judged as if it had done nothing. Saying so plainly is
     * cheaper than letting every run surface on an empty diff.
     */
    briefing:
      "The workspace is a git repository whose HEAD is an empty baseline commit. " +
      "Run `git add -A` after creating or modifying files, so your work appears in " +
      "`git diff HEAD` -- that diff is what the gates evaluate.",
    /**
     * Exit 0 means the sweep reached a fixed point; exit 1 means it
     * surfaced a condition needing a person. Neither is a crash.
     */
    classifyExit(code) {
      if (code === 0) return { outcome: "fixpoint", ok: true };
      if (code === 1) return { outcome: "surfaced", ok: false };
      return { outcome: "error", ok: false };
    },
    /**
     * pilean prints the raw assistant content, which for this provider is a
     * JSON array of content blocks rather than a string. Unwrap it to the
     * text a person would read; anything else is already text.
     */
    formatAnswer(text) {
      const trimmed = text.trim();
      if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return trimmed;
      try {
        const parsed = JSON.parse(trimmed);
        const blocks = Array.isArray(parsed) ? parsed : [parsed];
        const joined = blocks
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return joined || trimmed;
      } catch {
        // Not the shape we expected: show what the agent actually printed.
        return trimmed;
      }
    },
  },
  {
    id: "pigmy",
    label: "pigmy",
    discipline: "gm admission",
    repo: "https://github.com/sallespro/pigmy.git",
    // pigmy has no root package.json; the gm harness lives in har/.
    packageDir: "har",
    entry: "bin/pi-gm.mjs",
    /** pigmy names the same concept `--workspace`. */
    argv({ task, workspace }) {
      return [task, "--workspace", workspace];
    },
    /**
     * gm's phase chain starts at SPECIFY, and a run that writes only a
     * `.gm-pi/prd.yml` still exits 0 -- it looks like success while the
     * requested artifact does not exist. Ask for the deliverable itself.
     */
    briefing:
      "Specifying the work is not finishing it: create the actual files the task asks " +
      "for in the workspace root, run them, and report what happened. A specification " +
      "in .gm-pi/ alone does not satisfy the request.",
    classifyExit(code) {
      if (code === 0) return { outcome: "completed", ok: true };
      if (code === 2) return { outcome: "misconfigured", ok: false };
      return { outcome: "refused", ok: false };
    },
    /**
     * pigmy appends a `--- 3 turn(s), 2 witness(es), ... ---` trailer to its
     * answer. The card already shows that as structured status, so drop it
     * rather than saying the same thing twice in two formats.
     */
    formatAnswer(text) {
      return text.replace(/\n*---[^\n]*turn\(s\)[^\n]*---\s*$/, "").trim();
    },
  },
];

export function agentById(id) {
  const agent = AGENTS.find((a) => a.id === id);
  if (!agent) throw new Error(`unknown agent: ${id}`);
  return agent;
}
