export const PHASES = {
  SHAPE: {
    id: "P1",
    title: "SHAPE",
    purpose: "Find the real job, cut a thin vertical slice, keep one live plan.",
    anchors: [
      "Jobs To Be Done -- Clayton Christensen",
      "XY Problem",
      "EARS Requirements Syntax -- Alistair Mavin",
      "INVEST -- Bill Wake",
      "Thin Vertical Slice -- Alistair Cockburn",
      "Spike Solution -- Kent Beck",
      "YAGNI -- Ron Jeffries",
      "Live Plan, Current Task Only",
    ],
  },
  CONTRACT: {
    id: "P2",
    title: "CONTRACT",
    purpose: "Put the meaning in types, names and signatures. Nothing restates the code in prose.",
    anchors: [
      "Ubiquitous Language -- Eric Evans",
      "Intention-Revealing Names -- Robert C. Martin",
      "Well-Typed Programs Cannot Go Wrong -- Robin Milner",
      "Make Illegal States Unrepresentable -- Yaron Minsky",
      "Parse, Don't Validate -- Alexis King",
      "Theorems for Free -- Philip Wadler",
      "Design by Contract -- Bertrand Meyer",
      "Command-Query Separation -- Bertrand Meyer",
      "Information Hiding -- David Parnas",
      "Deep Modules -- John Ousterhout",
      "Ports and Adapters -- Alistair Cockburn",
      "A Comment Is a Deodorant for Bad Smells -- Fowler and Beck",
    ],
  },
  BUILD: {
    id: "P3",
    title: "BUILD",
    purpose: "Total functions, guard clauses, one level of abstraction per function.",
    anchors: [
      "Total Functional Programming -- David Turner",
      "Guard Clause -- Martin Fowler",
      "Single Level of Abstraction -- Kent Beck",
      "Structured Programming -- Edsger Dijkstra",
      "Purely Functional Data Structures -- Chris Okasaki",
      "Ownership and Borrowing -- Matsakis and Klock",
      "Don't Repeat Yourself -- Hunt and Thomas",
      "KISS -- Kelly Johnson",
    ],
  },
  VERIFY: {
    id: "P4",
    title: "VERIFY",
    purpose: "Properties and invariants, checked by an agent that has not read the implementation.",
    anchors: [
      "Testing Shows Presence, Never Absence -- Edsger Dijkstra",
      "Implementation-Biased Test Generation",
      "Independence-Based Verification -- Grabowski",
      "Adversarial Red-Blue Agent Verification -- Thukkaram",
      "QuickCheck Property-Based Testing -- Claessen and Hughes",
      "Stateful Invariant Runs over Random Call Sequences",
      "Metamorphic Testing -- T. Y. Chen",
      "Coverage-Guided Fuzzing -- Michal Zalewski",
      "Consumer-Driven Contract Test -- Ian Robinson",
      "Characterization Test, Legacy Only -- Michael Feathers",
      "LLM as a Judge",
      "Sanitizer and Static Analysis Gate",
    ],
  },
  RECORD: {
    id: "P5",
    title: "RECORD",
    purpose: "The commit message carries the why. Git is the state.",
    anchors: [
      "Conventional Commits",
      "50/72 Commit Format -- Tim Pope",
      "The Diff Records What, the Message Records Why",
      "Git Is the State",
      "git blame as the Index",
      "git bisect as the Regression Oracle -- Linus Torvalds",
      "Semantic Versioning -- Tom Preston-Werner",
      "ADR, Irreversible Forks Only -- Michael Nygard",
    ],
  },
  PRESSURE: {
    id: "P6",
    title: "PRESSURE",
    purpose: "Superseded paths gone and unreachable. Growth needs a reason on the record.",
    anchors: [
      "Agents Avoid Deleting Code -- Ebrahimi et al.",
      "Guard-and-Go Fallback Accumulation",
      "Type-4 Semantic Clones in Agent Pull Requests",
      "Rising Churn and Duplication -- Harding and Kloster",
      "Behavioural Drift over Long Trajectories -- Orlanski et al.",
      "Deletion-Completeness Check",
      "Reachability Analysis",
      "Net-Negative Diff Target",
      "Out of the Tar Pit -- Moseley and Marks",
      "A Plea for Lean Software -- Niklaus Wirth",
      "Kolmogorov Complexity -- Kolmogorov and Chaitin",
    ],
  },
  CONTEXT: {
    id: "P7",
    title: "CONTEXT ECONOMY",
    purpose: "The smallest set of high-signal tokens. Applies at every phase, not one point.",
    appliesEverywhere: true,
    anchors: [
      "The Smallest Set of High-Signal Tokens",
      "Context Rot -- Hong et al.",
      "Rework Loops Dominate Token Spend",
      "Progressive Disclosure via SKILL.md",
      "Subagent Context Isolation",
      "Phase-Boundary Compaction",
      "Observational Context Compression",
      "Stable Prefix for Cache Hits",
      "Exact-String Retrieval Before Embedding Retrieval",
    ],
  },
  TENSIONS: {
    id: "P8",
    title: "STANDING TENSIONS",
    purpose: "Costs this method accepts. A fired tension takes a local exception with a reason.",
    accepted: true,
    anchors: [
      "Comments Capture What Code Cannot -- John Ousterhout",
      "Programming as Theory Building -- Peter Naur",
      "Tacit Knowledge Resists Specification",
      "Hyrum's Law -- Hyrum Wright",
      "Regulated Environments Need an Evidence Trail",
      "Measured Maintenance Cost of Agent Code",
      "Silent Spec-Code Drift -- Grabowski",
      "Context Explosion in Whole-Repo Reasoning -- Grabowski",
    ],
  },
  CONVERGENCE: {
    id: "P9",
    title: "CONVERGENCE",
    purpose: "A decreasing variant, monotonic gains, two terminals and only two.",
    anchors: [
      "Least Fixed Point -- Kleene and Tarski",
      "Monotonic Improvement Only",
      "No Regression Across Sweeps",
      "Well-Founded Variant -- Robert Floyd",
      "Bounded Retry, Then Surface",
      "Rice's Theorem -- Henry Gordon Rice",
      "Halting Problem -- Alan Turing",
      "Lehman's Laws of Software Evolution -- Meir Lehman",
      "Premature Optimization -- Donald Knuth",
      "Lower Bound Reached",
    ],
  },
};

export const SPINE = ["SHAPE", "CONTRACT", "BUILD", "VERIFY", "PRESSURE", "RECORD", "CONVERGENCE"];

export const GATES = {
  ONE_TASK_IN_FLIGHT: {
    name: "one task in flight",
    holdsWhen: "No second plan is live. Finish or abandon before starting.",
  },
  CONTRACT_ONLY_DURABLE: {
    name: "contract is the only durable description",
    holdsWhen:
      "Types, names and signatures carry the meaning. A rule the type cannot express becomes a precondition in the signature. Nothing restates the code in prose.",
  },
  VERIFIER_BLIND: {
    name: "verifier has not read the implementation",
    holdsWhen:
      "The checking agent works from the contract in a separate context with no shared history.",
  },
  NET_NEGATIVE: {
    name: "change closes net-negative, or states why not",
    holdsWhen: "Superseded paths are unreachable and gone. Growth needs a reason on the record.",
  },
  CONTRACT_SATISFIED: {
    name: "contract satisfied and recorded",
    holdsWhen: "Properties hold, and the commit message carries the reason the contract changed.",
  },
};

export const SPINE_EDGES = [
  { from: null, to: "SHAPE", gate: "ONE_TASK_IN_FLIGHT" },
  { from: "SHAPE", to: "CONTRACT", gate: "CONTRACT_ONLY_DURABLE" },
  { from: "CONTRACT", to: "BUILD", gate: null },
  { from: "BUILD", to: "VERIFY", gate: "VERIFIER_BLIND" },
  { from: "VERIFY", to: "PRESSURE", gate: "NET_NEGATIVE" },
  { from: "PRESSURE", to: "RECORD", gate: null },
  { from: "RECORD", to: "CONVERGENCE", gate: "CONTRACT_SATISFIED" },
];

export const BACKREFERENCES = [
  { condition: "the stated problem is not the real one", to: "SHAPE" },
  { condition: "the requirement is not falsifiable", to: "CONTRACT" },
  { condition: "the task depends on another task", to: "SHAPE" },
  { condition: "the slice cuts across a module boundary", to: "CONTRACT" },
  { condition: "the unknown survived the spike", to: "SHAPE" },
  { condition: "generality has one caller", to: "PRESSURE" },
  { condition: "the plan outlived its task", to: "SHAPE" },
  { condition: "a second durable description appeared", to: "CONTRACT" },
  { condition: "the domain term is absent from the type", to: "CONTRACT" },
  { condition: "the name cannot carry the meaning", to: "CONTRACT" },
  { condition: "prose was needed to explain the code", to: "CONTRACT" },
  { condition: "a stuck state is reachable", to: "CONTRACT" },
  { condition: "the type cannot express the rule", to: "CONTRACT" },
  { condition: "validation repeats in the interior", to: "CONTRACT" },
  { condition: "the signature permits what the contract forbids", to: "CONTRACT" },
  { condition: "a query mutated state", to: "CONTRACT" },
  { condition: "a decision is not hidden by any module", to: "CONTRACT" },
  { condition: "an adapter leaked into the core", to: "CONTRACT" },
  { condition: "a partial function escaped its domain", to: "CONTRACT" },
  { condition: "the function mixes abstraction levels", to: "BUILD" },
  { condition: "control flow is untraceable", to: "BUILD" },
  { condition: "shared mutable state crossed a boundary", to: "BUILD" },
  { condition: "one fact has two representations", to: "PRESSURE" },
  { condition: "the solution exceeds the problem", to: "SHAPE" },
  { condition: "the verifier read the implementation", to: "VERIFY" },
  { condition: "green does not mean correct", to: "VERIFY" },
  { condition: "the assertion mirrors the code", to: "VERIFY" },
  { condition: "the two agents shared context", to: "VERIFY" },
  { condition: "the property is falsified", to: "CONTRACT" },
  { condition: "the invariant broke under a call sequence", to: "CONTRACT" },
  { condition: "the input crashed the parser", to: "CONTRACT" },
  { condition: "a consumer broke on an unpromised behaviour", to: "TENSIONS" },
  { condition: "a sanitizer or analyser reports", to: "BUILD" },
  { condition: "the message says what, not why", to: "RECORD" },
  { condition: "the reason is unrecoverable from history", to: "RECORD" },
  { condition: "state exists outside the repository", to: "SHAPE" },
  { condition: "the old path survives beside the new", to: "PRESSURE" },
  { condition: "a fallback was added, not removed", to: "PRESSURE" },
  { condition: "two functions mean the same thing", to: "BUILD" },
  { condition: "the diff is net-positive again", to: "PRESSURE" },
  { condition: "behaviour drifted across iterations", to: "VERIFY" },
  { condition: "superseded code is still reachable", to: "PRESSURE" },
  { condition: "the state is accidental", to: "CONTRACT" },
  { condition: "size grew without a reason", to: "PRESSURE" },
  { condition: "the description exceeds the content", to: "CONTRACT" },
  { condition: "context grew without new signal", to: "CONTEXT" },
  { condition: "quality fell as the window filled", to: "CONTEXT" },
  { condition: "iteration, not generation, spent the budget", to: "VERIFY" },
  { condition: "two documents describe one fact", to: "BUILD" },
  { condition: "the knowledge has no home in the code", to: "RECORD" },
  { condition: "the theory died with the session", to: "CONTEXT" },
  { condition: "the constraint was never stated anywhere", to: "RECORD" },
  { condition: "an unpromised behaviour became a contract", to: "VERIFY" },
  { condition: "merged code costs more than it saved", to: "PRESSURE" },
  { condition: "two descriptions disagree", to: "CONTRACT" },
  { condition: "the agent must read the whole repository", to: "CONTEXT" },
  { condition: "the contract is not satisfied", to: "VERIFY" },
  { condition: "the environment changed under a converged system", to: "SHAPE" },
];

export const SWEEP_TRIGGERS = [
  { condition: "a gate reopened", to: "SHAPE" },
  { condition: "a property was falsified", to: "VERIFY" },
  { condition: "a budget sits above its floor", to: "CONVERGENCE" },
  { condition: "the artifact grew", to: "PRESSURE" },
  { condition: "context spend rose per unit of change", to: "CONTEXT" },
  { condition: "a tension fired", to: "TENSIONS" },
];

export function gateGuarding(from, to) {
  const edge = SPINE_EDGES.find((e) => e.from === from && e.to === to);
  if (!edge || !edge.gate) return null;
  return { key: edge.gate, ...GATES[edge.gate] };
}

export function nextPhase(from) {
  const edge = SPINE_EDGES.find((e) => e.from === from);
  return edge ? edge.to : null;
}

export function routeCondition(condition) {
  if (typeof condition !== "string") return null;
  const normalized = condition.trim().toLowerCase();
  if (!normalized) return null;
  const all = [...BACKREFERENCES, ...SWEEP_TRIGGERS];
  const exact = all.find((b) => b.condition === normalized);
  if (exact) return exact.to;
  const partial = all.find(
    (b) => normalized.includes(b.condition) || b.condition.includes(normalized),
  );
  return partial ? partial.to : null;
}
