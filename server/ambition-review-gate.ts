export type AmbitionReviewOption = "Altitude" | "Depth" | "Range";

type BotTextMessage = {
  id: string;
  role: string;
  kind: string;
  text?: string;
  from?: { botId: string };
};

/** A short human confirmation may rely only on the latest bot text, and in a
 * shared thread that text must have come from this Chief. */
export function precedingCoSAssistantText(
  messages: readonly BotTextMessage[],
  currentMessageId: string,
  chiefBotId: string,
  sharedThread: boolean,
  afterMessageId?: string | null,
): string | undefined {
  const currentIndex = messages.findIndex((message) => message.id === currentMessageId);
  if (currentIndex < 0 || afterMessageId === null) return undefined;
  const afterIndex = afterMessageId === undefined ? -1 : messages.findIndex((message) => message.id === afterMessageId);
  if (afterMessageId !== undefined && (afterIndex < 0 || afterIndex >= currentIndex)) return undefined;
  let preceding: BotTextMessage | undefined;
  for (let index = currentIndex - 1; index > afterIndex; index--) {
    const message = messages[index]!;
    if (message.role === "bot" && message.kind === "text") {
      preceding = message;
      break;
    }
  }
  if (!preceding || (sharedThread
    ? preceding.from?.botId !== chiefBotId
    : preceding.from !== undefined && preceding.from.botId !== chiefBotId)) return undefined;
  return preceding.text;
}

const EXPLICIT_REVIEW = /\b(?:ambition[\s-]+review|three bolder goals)\b/i;
const STRATEGIC_INTENT = /\b(?:strategic(?:ally)?|strategy|architect(?:ure)?|ambiguous|repeated(?:ly)?|multi[\s-]?step|long[\s-]?term(?:\s+goal)?)\b/i;
const STRATEGIC_DECISION_QUESTION = /\bshould\s+(?:we|i|the team)\b[^.!?\n]{0,100}\b(?:architecture|approach|strategy|roadmap|workflow|system|platform|services?|microservices?|monolith|monorepos?|database|data model|security model|deployment model|product direction|technical direction)\b|\b(?:which|what)\s+(?:architecture|approach|strategy|roadmap|workflow|system|platform|monorepos?)\b[^.!?\n]{0,100}\b(?:should|would|could|use|choose|adopt|build|design|best)\b|\b(?:which|what(?:'s| is)?|how)\b[^.!?\n]{0,80}\b(?:right|best|ideal|appropriate|preferred)\s+(?:architecture|approach|strategy|roadmap|workflow|system|platform|monorepos?)\b/i;
const PROJECT_SCOPE = /\b(?:project|repo|repository|codebase|product|system|platform|workflow|architecture|roadmap|initiative|migration|overhaul|redesign|feature|app|application|service|flow|component|module|endpoint|export|import|integration|pipeline|tool|monorepos?|end[\s-]?to[\s-]?end|from scratch|across (?:multiple|several|all) (?:repos|repositories|projects))\b/i;
const WORK_ACTION = /\b(?:build|create|implement|design|redesign|plan|audit|investigate|evaluate|compare|improve|optimi[sz]e|refactor|migrate|automate|coordinate|ship|develop|launch|replace|review|research|transform|establish|set up|verify|test|document|deploy|measure|track|monitor|summari[sz]e|report|collect|maintain|fix|correct|rename|adjust|change|update|remove|add|edit|configure|split|separate|decompose)\b/gi;
const OPEN_ENDED = /\b(?:improve|optimi[sz]e|simplify|modernize|strengthen|rethink|reimagine|clean up|make (?:it|this|the \w+) better)\b/i;
const REPEATED = /\b(?:daily|weekly|monthly|recurring|repeatable|every (?:day|week|month|time|run))\b/i;
const NARROW_TARGET = /\b(?:typo|spelling|wording|button label|label text|copy|single line|one line|one file|single file|one test|single test|formatting|unused import|type error|lint error|syntax error|icon)\b/i;
const NARROW_VERB = /^\s*(?:(?:please|can|could|would)\s+(?:you\s+)?)?(?:just\s+)?(?:fix|correct|rename|adjust|change|update|remove|add)\b/i;
const QUESTION = /^\s*(?:what|which|how|why|when|where|who|is|are|do|does|did|can|could|should|would)\b/i;

function isClearNarrowFix(text: string): boolean {
  const actionCount = [...text.matchAll(WORK_ACTION)].length;
  return text.length <= 500 && NARROW_VERB.test(text) && NARROW_TARGET.test(text) &&
    actionCount === 1 &&
    !STRATEGIC_DECISION_QUESTION.test(text) &&
    !/(?:[.!?]\s+\S|[;\r\n])/i.test(text) &&
    !/\b(?:and|then|before|after|while|whereas|although|followed by|across|multiple|several|from scratch|separately|additionally|also|in addition|as well as|at the same time|in parallel)\b/i.test(text);
}

/** Deterministic, conservative routing for CoS direct turns. The prompt still
 * handles semantic ambiguity; these explicit and project-scale signals make
 * the server gate fail closed for common multi-step work. */
export function requiresAmbitionReview(text: string): boolean {
  if (EXPLICIT_REVIEW.test(text)) return true;
  if (isClearNarrowFix(text)) return false;
  const actionCount = [...text.matchAll(WORK_ACTION)].length;
  const connectedSteps = /\b(?:and|then|before|after|followed by)\b/i.test(text);
  const strategicSignal = STRATEGIC_INTENT.test(text) || STRATEGIC_DECISION_QUESTION.test(text);
  const projectScope = PROJECT_SCOPE.test(text);
  const question = QUESTION.test(text) || text.includes("?");
  const strategicTask = strategicSignal && (
    (actionCount > 0 && !question) || (question && projectScope)
  );
  return strategicTask ||
    (projectScope && actionCount > 0) ||
    (actionCount > 1 && connectedSteps) ||
    (OPEN_ENDED.test(text) && actionCount > 0) ||
    (REPEATED.test(text) && actionCount > 0);
}

function optionFor(token: string): AmbitionReviewOption | null {
  const normalized = token.toLowerCase();
  if (normalized === "altitude" || normalized === "1" || normalized === "first") return "Altitude";
  if (normalized === "depth" || normalized === "2" || normalized === "second") return "Depth";
  if (normalized === "range" || normalized === "3" || normalized === "third") return "Range";
  return null;
}

function explicitlySelectedOption(text: string): AmbitionReviewOption | null {
  const option = "(?:(?:the\\s+)?option\\s+|the\\s+)?(altitude|depth|range|[123]|first|second|third)(?:\\s+option)?";
  const patterns = [
    new RegExp(`^\\s*${option}[.!]?\\s*$`, "i"),
    new RegExp(`^\\s*(?:i|we)\\s+(?:choose|select|pick|prefer|want|like)\\s+${option}[.!]?\\s*$`, "i"),
    new RegExp(`^\\s*(?:let'?s|let us)\\s+do\\s+${option}[.!]?\\s*$`, "i"),
    new RegExp(`^\\s*go\\s+with\\s+${option}[.!]?\\s*$`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return optionFor(match[1]!);
  }
  return null;
}

function recommendedOption(text: string | undefined): AmbitionReviewOption | null {
  if (!text) return null;
  const cues = /\b(?:recommend(?:ation)?|suggest(?:ion)?|my pick|best (?:choice|option)|i(?:'d| would) choose|i(?:'d| would) go with)\b/i;
  const correction = /\b(?:actually|instead|rather|on second thought|correction|wait|i(?:'ve| have) changed my mind)\b/i;
  const hedge = /\b(?:not|never|no|don['’]t|doesn['’]t|didn['’]t|cannot|can['’]t|won['’]t|wouldn['’]t|shouldn['’]t|against|avoid(?:s|ed|ing)?|maybe|perhaps|might|could|possibly|potentially|consider(?:ing)?|either|or|unless|whether|depending|alternatively|but|though|however|one possibility|candidate)\b/i;
  let candidate: AmbitionReviewOption | null = null;
  let corrected = false;
  for (const clause of text.split(/[.!?;\n]+/)) {
    const isCorrection = correction.test(clause);
    const options = [...clause.matchAll(/\b(altitude|depth|range)\b/gi)]
      .map((match) => optionFor(match[1]!))
      .filter((option): option is AmbitionReviewOption => option !== null);
    if (options.length === 0) continue;
    const hasRecommendationCue = cues.test(clause) || isCorrection;
    // Once a recommendation candidate exists, an uncued mention of another
    // option may be a contradiction. Do not infer a choice from one clause.
    if (!hasRecommendationCue && candidate !== null) return null;
    if (!hasRecommendationCue) continue;
    if (hedge.test(clause) || options.length !== 1) return null;
    const option = options[0]!;
    if (isCorrection) {
      candidate = option;
      corrected = true;
    } else if (corrected && candidate !== option) {
      return null;
    } else if (candidate !== null && candidate !== option) {
      return null;
    } else {
      candidate = option;
    }
  }
  return candidate;
}

export function selectedAmbitionReviewOption(
  text: string,
  precedingAssistantText?: string,
): AmbitionReviewOption | null {
  const explicit = explicitlySelectedOption(text);
  if (explicit) return explicit;
  if (!/^\s*(?:yes|yeah|okay|ok|sounds good|go ahead|proceed|do that|let'?s do (?:that|it)|run with that)[.!]?\s*$/i.test(text)) {
    return null;
  }
  return recommendedOption(precedingAssistantText);
}

export function transitionAmbitionReview(options: {
  pending: boolean;
  chiefOfStaff: boolean;
  humanTurn: boolean;
  text: string;
  precedingAssistantText?: string;
}): { pending: boolean; selected?: AmbitionReviewOption } {
  if (!options.humanTurn) return { pending: options.pending };
  if (options.pending) {
    const selected = selectedAmbitionReviewOption(options.text, options.precedingAssistantText);
    return selected ? { pending: false, selected } : { pending: true };
  }
  return { pending: options.chiefOfStaff && requiresAmbitionReview(options.text) };
}

const READ_ONLY_INTERNAL_PATHS = new Set([
  "/api/internal/agents",
  "/api/internal/computer/select",
  "/api/internal/room-targets",
  "/api/internal/rooms",
  "/api/internal/routines",
  "/api/internal/shared-computers",
  "/api/internal/skills",
  "/api/internal/team-setup-catalog",
  "/api/internal/threads",
  "/api/internal/tool-result",
]);

/** Only a reviewed set of OMB agent reads can run during the selection hold.
 * Unknown routes and every mutation fail closed. */
export function isReadOnlyDuringAmbitionReview(method: string, path: string): boolean {
  return method.toUpperCase() === "GET" && (
    READ_ONLY_INTERNAL_PATHS.has(path) || /^\/api\/internal\/delegations\/[\w-]{4,64}$/.test(path)
  );
}

/** During the hold, allow only explicitly reviewed agent reads. Every other
 * internal capability can cause side effects and must wait for selection. */
export function shouldBlockAmbitionReviewAction(options: {
  pending: boolean;
  capabilityKind: string;
  method: string;
  path: string;
}): boolean {
  return options.pending && !(options.capabilityKind === "agents" &&
    isReadOnlyDuringAmbitionReview(options.method, options.path));
}
