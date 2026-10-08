/**
 * Release defaults. A cell stores only the owner's changes (the role-to-model map and added
 * specialists); everything here ships with the release and applies wherever no change exists.
 */

/** The one model gateway: every model call goes through OpenRouter with one key. */
export const GATEWAY_PROVIDER = "openrouter";

/** The lead's role name in the role-to-model map. */
export const LEAD_ROLE = "lead";

/** A frontier model for the lead (Anthropic messages API, so prompt caching applies). */
export const DEFAULT_LEAD_MODEL = "anthropic/claude-opus-5.5";

/** A cheaper model for every specialist. */
export const DEFAULT_SPECIALIST_MODEL = "anthropic/claude-haiku-4.5";

export interface StarterSpecialist {
  readonly name: string;
  readonly instruction: string;
}

const NO_TOOLS_YET =
  "You have no outside tools yet: no web, shell, mail, or accounts. You can search the lead's history. If you need something you cannot reach, say so in your answer and ask the lead.";

/** The four starter specialists, with short starter instructions (the owner can replace them). */
export const STARTER_SPECIALISTS: readonly StarterSpecialist[] = [
  {
    name: "household",
    instruction: `You are the household specialist: meals, shopping, chores, and the household's shared plans. ${NO_TOOLS_YET}`,
  },
  {
    name: "developer",
    instruction: `You are the developer specialist: software, code, and the agent system itself. ${NO_TOOLS_YET}`,
  },
  {
    name: "research",
    instruction: `You are the research specialist: find out what is known about a question and summarize it with its uncertainty. ${NO_TOOLS_YET}`,
  },
  {
    name: "health",
    instruction: `You are the health specialist: sleep, food, exercise, and general wellbeing. You are not a doctor; say when a question needs one. ${NO_TOOLS_YET}`,
  },
];

/** The lead's standing instructions. Routing is the lead's own decision, through the handoff tool. */
export const LEAD_INSTRUCTIONS =
  "You are the lead agent of one person's personal assistant. Answer the person directly when you can. When a request fits one of your specialists, brief that specialist with the handoff tool: write a self-contained brief in your own words. The specialist's answer comes back to you later as a message that starts with [handoff <name> answered]; relay what matters to the person. You can search your own earlier conversation with search_history.";

/**
 * The release owner rule: agents never pay. It cannot be removed; the owner can only add stricter
 * rules. The pay group is every tool named `pay_…`.
 */
export const RELEASE_OWNER_RULES = [{ agent: "all", tool: "pay", verdict: "prohibit" }] as const;

/**
 * The reviewer's role name in the role-to-model map. The reviewer is a model call inside the guard,
 * not a conversation; it reviews only the calls the decision model marks or cannot judge.
 */
export const REVIEWER_ROLE = "reviewer";

/** The reviewer's default model. */
export const DEFAULT_REVIEWER_MODEL = "anthropic/claude-sonnet-5.5";

/** The decision models the owner can switch between, by adapter name (OpenRouter catalogue ids). */
export const DECISION_MODELS = { clef: "cloudflare/clef", jev: "typesafe/jev-1.13" } as const;

export type DecisionAdapter = keyof typeof DECISION_MODELS;

/** Every cell starts on Clef. */
export const DEFAULT_DECISION_ADAPTER: DecisionAdapter = "clef";

/**
 * OpenRouter's Decisions API path (alpha), on the gateway origin. Kept in one place: the shape
 * probe found it working; the built-in System One route is `/api/v1/systemone`.
 */
export const DECISIONS_PATH = "/api/alpha/decisions";

/**
 * The mark score (the probability of "risky" plus "unclear") at or above which a call goes to the
 * reviewer, per tool. Reads are less risky, so they need a higher score. Starting values: the
 * shadow week calibrates them before any cell enforces.
 */
export const MARK_THRESHOLDS: Readonly<Record<string, number>> = {
  handoff: 0.5,
  household_change: 0.5,
  household_read: 0.7,
  set_reminder: 0.5,
  search_history: 0.7,
};

/** The threshold of a tool not listed above. */
export const DEFAULT_MARK_THRESHOLD = 0.5;

/** A decision model slower than this goes to the reviewer (the latency budget is 500 ms at p95). */
export const DECISION_TIMEOUT_MS = 1_500;

/** A reviewer slower than this holds the call for the person ("reviewer unavailable"). */
export const REVIEWER_TIMEOUT_MS = 30_000;

/** The largest decision-model state, in UTF-8 bytes. */
export const DECISION_STATE_LIMIT = 4_096;

/**
 * The reviewer's outbound account-data check: the check point exists, and it starts with the first
 * outside tool (a later release). Until then the reviewer is told the check is not active.
 */
export const OUTBOUND_CHECK_ACTIVE = false;

/** How long a held call waits for an answer before it lapses as a refusal: 24 hours. */
export const HOLD_MS = 24 * 60 * 60 * 1000;

/**
 * The argument an "allow always" rule matches when the holding rule matched none: the field that
 * names what the call acts on. A tool not listed gets a rule with no argument match.
 */
export const ALWAYS_KEY_FIELD: Readonly<Record<string, string>> = {
  handoff: "specialist",
  household_change: "document",
  household_read: "document",
  set_reminder: "text",
  search_history: "query",
};

/**
 * A new person's own rules: permit the four tools agents have today (hand-off, household list
 * edits, reminders, history search). Reading the household list matches no rule and passes.
 */
export const DEFAULT_PERSON_RULES = [
  { agent: "all", tool: "handoff", verdict: "permit" },
  { agent: "all", tool: "household_change", verdict: "permit" },
  { agent: "all", tool: "set_reminder", verdict: "permit" },
  { agent: "all", tool: "search_history", verdict: "permit" },
] as const;

/** A new person's monthly spending limit, in USD. The owner changes it per person. */
export const DEFAULT_PERSON_LIMIT_USD = 25;

/** The household's developer budget, in USD a month: developer jobs draw on it, not on a person. */
export const DEFAULT_DEVELOPER_BUDGET_USD = 50;

/** The specialist whose model and guard costs count against the developer budget. */
export const DEVELOPER_ROLE = "developer";

/** The largest monthly limit or budget the owner can set, in USD. */
export const LIMIT_MAX_USD = 10_000;

/** The two lines of a limit, in percent: a notice and an owner alert at each. */
export const LIMIT_LINES = [80, 100] as const;

/**
 * The tool keys under which the guard adds its own model usage to the calling conversation's
 * `pi.usage`. A colon cannot appear in a model tool name, so these never mix with a real tool.
 */
export const GUARD_USAGE_KEYS = {
  decision: "secbot-guard:decision",
  reviewer: "secbot-guard:reviewer",
} as const;

/** A person cell reports its month to the household budget board at most this often. */
export const SPEND_REPORT_MIN_MS = 5_000;
