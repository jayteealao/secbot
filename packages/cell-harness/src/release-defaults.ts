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
 * A new person's own rules: permit the four tools agents have today (hand-off, household list
 * edits, reminders, history search). Reading the household list matches no rule and passes.
 */
export const DEFAULT_PERSON_RULES = [
  { agent: "all", tool: "handoff", verdict: "permit" },
  { agent: "all", tool: "household_change", verdict: "permit" },
  { agent: "all", tool: "set_reminder", verdict: "permit" },
  { agent: "all", tool: "search_history", verdict: "permit" },
] as const;
