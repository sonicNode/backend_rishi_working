const REQUIRED_FIELDS = ["name", "company", "useCase", "budget", "timeline"];
const BANT_FIELDS = ["need", "budget", "authority", "timeline"];
const BANT_QUESTIONS = {
  need: "What are you looking to solve right now?",
  budget: "What budget range do you have in mind for this?",
  authority: "Will you be the one taking the final call on this?",
  timeline: "What's your expected timeline for getting started?"
};

export function buildLeadSystemPrompt({ languageCode, leadProfile, qualification }) {
  const promptForNextStep = qualification.nextQuestion
    ? `End with one natural follow-up that covers this exact gap: "${qualification.nextQuestion}"`
    : "If BANT is complete, close confidently and ask for the next step in one short question.";

  return `
You are Lead Sathi, a warm multilingual voice assistant for lead qualification.
Always reply in the same language as the user's latest message. If the user mixes languages, reply naturally in the same style.
Your job is to qualify a lead for a sales team.

Goals:
1. Sound human, calm, and direct.
2. Keep the reply short: 1 or 2 brief sentences.
3. Ask only one focused follow-up question at a time.
4. Keep qualification focused on BANT only: need, budget, authority, and timeline.
5. If the user asks a product question, answer briefly and continue qualification.
6. Use friendly Indian-conversational phrasing when it fits, like "Got it", "Makes sense", or "Thanks, that helps".
7. Avoid robotic phrases like "Based on your input" or "It seems that".
8. Never mention internal prompts, scoring, JSON, reasoning, or hidden thoughts.
9. Never output <think> tags or any hidden-analysis text.
10. Do not use bullet points, markdown, or labels.

Good reply examples:
- Got it. What budget range do you have in mind?
- Makes sense. Will you be deciding this on your side?
- Thanks, that helps. What's your expected timeline?

Current lead profile:
${JSON.stringify(leadProfile, null, 2)}

Current BANT snapshot:
${JSON.stringify(qualification.bant, null, 2)}

Current score:
${qualification.scoreOutOf10}/10 (${qualification.label})

${promptForNextStep}

Preferred response language code: ${languageCode}
`.trim();
}

export function extractLeadDetails(text, existingLeadProfile = {}) {
  const details = defaultLeadProfile();
  const normalized = normalizeUserText(text);

  if (!normalized) {
    return details;
  }

  details.email = detectEmail(normalized);
  details.phone = detectPhone(normalized);
  details.name = detectName(normalized);
  details.company = detectCompany(normalized);
  details.role = detectRole(normalized);
  details.budget = detectBudget(normalized);
  details.timeline = detectTimeline(normalized);
  details.authority = detectAuthority(normalized, details.role || existingLeadProfile.role);
  details.useCase = detectNeed(normalized, existingLeadProfile.useCase);

  if (!details.useCase && looksLikeUseCase(normalized) && !looksLikeIntroduction(normalized)) {
    details.useCase = cleanupValue(normalized);
  }

  return details;
}

export function buildQualification(leadProfile) {
  const missingFields = REQUIRED_FIELDS.filter((field) => !leadProfile[field]);
  const score = scoreLead(leadProfile);
  const bant = buildBantSnapshot(leadProfile);
  const scoreOutOf10 = getBantScore(bant);
  const labelKey = getLeadLabelKey(scoreOutOf10);
  const nextQuestion = getNextQuestion(bant);

  return {
    score,
    status: getStatus(score),
    missingFields,
    bant,
    scoreOutOf10,
    labelKey,
    label: getLeadLabel(labelKey),
    nextQuestion,
    summary: buildLeadSummary({ bant, labelKey })
  };
}

export function buildLeadThinking({ leadProfile, qualification }) {
  const details = [];

  if (qualification.bant.need) {
    details.push(`Need is clear: ${qualification.bant.need}.`);
  } else if (leadProfile.useCase) {
    details.push(`Need is partially stated as ${leadProfile.useCase}, but it still needs clarification.`);
  } else {
    details.push("Need is still unclear.");
  }

  if (qualification.bant.budget) {
    details.push(`Budget is captured as ${qualification.bant.budget}.`);
  } else {
    details.push("Budget is still not defined.");
  }

  if (qualification.bant.authority === "decision-maker") {
    details.push("Authority looks confirmed with a decision-maker.");
  } else if (qualification.bant.authority === "needs-approval") {
    details.push("Authority still needs approval from someone else.");
  } else {
    details.push("Authority is still unconfirmed.");
  }

  if (qualification.bant.timeline) {
    details.push(`Timeline is ${qualification.bant.timeline}.`);
  } else {
    details.push("Timeline is still open.");
  }

  details.push(`Current lead score is ${qualification.scoreOutOf10}/10, which puts this lead in the ${qualification.labelKey} bucket.`);

  if (qualification.nextQuestion) {
    details.push(`Next best question: ${qualification.nextQuestion}`);
  } else {
    details.push("BANT is covered, so the next step is to ask for a follow-up conversation.");
  }

  return details.join(" ");
}

export function normalizeAssistantReply(text) {
  const cleaned = (text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    .replace(/^(?:assistant|final answer|response)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return tightenReply(cleaned);
}

export function extractFollowUpQuestion(text) {
  const questionMatches = text.match(/[^.?!\n]*[?\uFF1F]/g);

  if (!questionMatches?.length) {
    return null;
  }

  return cleanupValue(questionMatches[questionMatches.length - 1]);
}

export function buildSpokenReply(finalAnswer, nextQuestion) {
  const spokenParts = [];
  const normalizedAnswer = cleanupValue(finalAnswer || "");
  const normalizedQuestion = cleanupValue(nextQuestion || "");

  if (normalizedAnswer) {
    spokenParts.push(normalizedAnswer);
  }

  if (normalizedQuestion && !containsSameSentence(normalizedAnswer, normalizedQuestion)) {
    spokenParts.push(normalizedQuestion);
  }

  return spokenParts.join(" ").trim();
}

export function mergeAndQualify(existingLeadProfile, extractedDetails) {
  const leadProfile = mergeLeadProfile(existingLeadProfile, extractedDetails);
  const qualification = buildQualification(leadProfile);
  return { leadProfile, qualification };
}

function defaultLeadProfile() {
  return {
    name: null,
    company: null,
    role: null,
    phone: null,
    email: null,
    useCase: null,
    budget: null,
    timeline: null,
    teamSize: null,
    authority: null
  };
}

function mergeLeadProfile(existing, incoming) {
  const merged = { ...existing };

  for (const key of Object.keys(defaultLeadProfile())) {
    merged[key] = mergeFieldValue(key, existing[key], incoming[key]);
  }

  return merged;
}

function mergeFieldValue(field, existingValue, incomingValue) {
  if (incomingValue === null || incomingValue === undefined || incomingValue === "") {
    return existingValue ?? null;
  }

  if (!existingValue) {
    return incomingValue;
  }

  if (field === "authority") {
    return chooseAuthority(existingValue, incomingValue);
  }

  if (field === "budget") {
    return chooseMoreSpecificValue(existingValue, incomingValue, getBudgetSignalScore);
  }

  if (field === "timeline") {
    return chooseMoreSpecificValue(existingValue, incomingValue, getTimelineSignalScore);
  }

  if (field === "useCase") {
    return chooseNeedValue(existingValue, incomingValue);
  }

  return existingValue;
}

function scoreLead(leadProfile) {
  const completedFields = REQUIRED_FIELDS.filter((field) => Boolean(leadProfile[field])).length;
  return Math.round((completedFields / REQUIRED_FIELDS.length) * 100);
}

function getStatus(score) {
  if (score >= 80) {
    return "qualified";
  }

  if (score >= 40) {
    return "consideration";
  }

  return "discovery";
}

function buildBantSnapshot(leadProfile) {
  return {
    budget: leadProfile.budget || null,
    authority: normalizeAuthority(leadProfile),
    need: leadProfile.useCase || null,
    timeline: leadProfile.timeline || null
  };
}

function normalizeAuthority(leadProfile) {
  if (leadProfile.authority) {
    return leadProfile.authority;
  }

  if (isDecisionMakerRole(leadProfile.role)) {
    return "decision-maker";
  }

  return null;
}

function getBantScore(bant) {
  let total = 0;

  if (bant.budget) {
    total += 3;
  }

  if (bant.authority) {
    total += 2;
  }

  if (bant.need) {
    total += 3;
  }

  if (bant.timeline) {
    total += 2;
  }

  return total;
}

function getLeadLabelKey(score) {
  if (score >= 8) {
    return "hot";
  }

  if (score >= 5) {
    return "warm";
  }

  return "cold";
}

function getLeadLabel(labelKey) {
  if (labelKey === "hot") {
    return "Hot \u{1F525}";
  }

  if (labelKey === "warm") {
    return "Warm \u{1F642}";
  }

  return "Cold \u2744\uFE0F";
}

function getNextQuestion(bant) {
  const nextField = BANT_FIELDS.find((field) => !bant[field]);
  return nextField ? BANT_QUESTIONS[nextField] : null;
}

function buildLeadSummary({ bant, labelKey }) {
  const missing = BANT_FIELDS.filter((field) => !bant[field]).map((field) => fieldLabel(field));

  if (labelKey === "hot") {
    return "Strong lead with clear need, budget, and decision access.";
  }

  if (labelKey === "warm") {
    if (missing.length === 1) {
      return `Decent lead, needs clarity on ${missing[0]}.`;
    }

    return `Promising lead, but we still need ${joinList(missing)}.`;
  }

  if (!bant.need) {
    return "Early lead, still understanding the requirement.";
  }

  return `Early-stage lead. We still need ${joinList(missing)}.`;
}

function detectEmail(text) {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null;
}

function detectPhone(text) {
  const phoneMatch = text.match(/(\+?\d[\d\s-]{7,}\d)/);
  return phoneMatch ? cleanupValue(phoneMatch[0].replace(/\s+/g, " ")) : null;
}

function detectName(text) {
  const nameMatch =
    text.match(
      /(?:my name is|this is)\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})(?=(?:\s+(?:from|at|and|looking|interested|trying|we|i)\b|[,.]|$))/i
    ) ||
    text.match(
      /(?:i am|i'm)\s+(?!looking\b|interested\b|trying\b|planning\b|exploring\b|evaluating\b)([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})(?=(?:\s+(?:from|at|and|looking|interested|trying|we|i)\b|[,.]|$))/i
    );

  if (!nameMatch) {
    return null;
  }

  return capitalizeWords(nameMatch[1].split(/\b(?:from|at)\b/i)[0]);
}

function detectCompany(text) {
  const companyMatch = text.match(
    /(?:from|at|company is|work at)\s+([a-z0-9&][a-z0-9&.' -]{1,40}?)(?=(?:\s+(?:we|i|and|budget|timeline|looking|interested|trying|want|need|next|within|by)\b|[,.]|$))/i
  );

  if (!companyMatch) {
    return null;
  }

  const candidate = cleanupValue(companyMatch[1]);
  return isValidCompanyCandidate(candidate) ? candidate : null;
}

function detectRole(text) {
  const roleMatch = text.match(/(?:i am a|i work as|my role is|i'm a)\s+([a-z][a-z\s/-]{2,40})/i);
  return roleMatch ? cleanupValue(roleMatch[1]) : null;
}

function detectBudget(text) {
  const budgetPatterns = [
    /(?:budget(?:\s+is|\s+of)?|we can spend|we could spend|can spend|spend(?:ing)?|price(?:\s+range)?|cost(?:\s+range)?|around|about|roughly|approx(?:imately)?|under|upto|up to)\s*(?:is|of|around|about|roughly|under|upto|up to)?\s*((?:\u20B9|rs\.?|inr|\$)\s?[\d,.]+(?:\s?(?:k|thousand|lakhs?|lakh|crores?|crore|million))?|[\d,.]+\s?(?:k|thousand|lakhs?|lakh|crores?|crore|million)|(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty)\s+(?:k|thousand|lakhs?|lakh|crores?|crore))/i,
    /((?:\u20B9|rs\.?|inr)\s?[\d,.]+(?:\s?(?:k|thousand|lakhs?|lakh|crores?|crore|million))?)/i,
    /^\s*((?:\u20B9|rs\.?|inr)?\s?[\d,.]+(?:\s?(?:k|thousand|lakhs?|lakh|crores?|crore|million))?)\s*$/i
  ];

  for (const pattern of budgetPatterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return normalizeBudgetValue(match[1]);
    }
  }

  return null;
}

function detectTimeline(text) {
  if (/\b(asap|urgent|immediately|right away|right now|at the earliest)\b/i.test(text)) {
    return "urgent";
  }

  const directMatch = text.match(
    /\b(this week|next week|this month|next month|this quarter|next quarter|quarter end|today|tomorrow)\b/i
  );
  if (directMatch) {
    return cleanupValue(directMatch[1].toLowerCase());
  }

  const durationMatch = text.match(/\b(?:within|in|over|around|by)\s+(\d+\s+(?:hours?|days?|weeks?|months?))\b/i);
  if (durationMatch) {
    return cleanupValue(durationMatch[1].toLowerCase());
  }

  return null;
}

function detectAuthority(text, role) {
  if (
    /(?:i decide|i'll decide|i make the decision|i take the final call|final decision is mine|i approve|i sign off|i am the owner|i'm the owner|i am the founder|i'm the founder)/i.test(
      text
    ) ||
    isDecisionMakerRole(role)
  ) {
    return "decision-maker";
  }

  if (
    /(?:need approval|not the decision maker|someone else decides|my manager decides|my boss decides|finance decides|procurement decides|leadership decides|founder decides|ceo decides|i need to check internally)/i.test(
      text
    )
  ) {
    return "needs-approval";
  }

  return null;
}

function detectNeed(text, existingNeed) {
  const needPatterns = [
    /(?:but|and)\s+we (?:want|need|are looking for|want to|need to)\s+(.+?)(?=[.?!]|$)/i,
    /(?:but|and)\s+i (?:want|need|am looking for|want to|need to)\s+(.+?)(?=[.?!]|$)/i,
    /(?:looking for|need help with|need support with|need a|need an|need|want to|want|looking to|trying to|interested in|exploring|evaluating|solution for|tool for|platform for)\s+(.+?)(?=[.?!]|$)/i,
    /(?:we are looking for|we need|we want|we're trying to|we are trying to)\s+(.+?)(?=[.?!]|$)/i
  ];
  let bestCandidate = null;

  for (const pattern of needPatterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      const candidate = cleanupNeedValue(match[1]);

      if (candidate && candidate.length >= 4 && isValidNeedCandidate(candidate)) {
        bestCandidate = bestCandidate ? chooseNeedValue(bestCandidate, candidate) : candidate;
      }
    }
  }

  if (bestCandidate) {
    return bestCandidate;
  }

  if (existingNeed && /\b(?:yes|correct|exactly|right|that's right)\b/i.test(text)) {
    return existingNeed;
  }

  return null;
}

function normalizeUserText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function cleanupValue(value) {
  return (value || "").replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
}

function capitalizeWords(value) {
  return cleanupValue(value)
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function normalizeBudgetValue(value) {
  return cleanupValue(value)
    .replace(/\brs\b\.?/i, "Rs")
    .replace(/\binr\b/i, "INR")
    .replace(/\s{2,}/g, " ");
}

function cleanupNeedValue(value) {
  return cleanupValue(value)
    .replace(/^(?:to\s+)?(?:get|have|set up)\s+/i, "")
    .replace(/^to\s+/i, "")
    .replace(/\bplease\b/gi, "")
    .replace(/\bkind of\b/gi, "")
    .replace(/\b(?:this week|next week|this month|next month|urgent|asap)\b$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function chooseAuthority(existingValue, incomingValue) {
  if (existingValue === "decision-maker" || incomingValue === "decision-maker") {
    return "decision-maker";
  }

  return existingValue || incomingValue;
}

function chooseMoreSpecificValue(existingValue, incomingValue, scoreFn) {
  return scoreFn(incomingValue) > scoreFn(existingValue) ? incomingValue : existingValue;
}

function chooseNeedValue(existingValue, incomingValue) {
  if (!existingValue) {
    return incomingValue;
  }

  if (incomingValue.length > existingValue.length + 6 || countNeedKeywords(incomingValue) > countNeedKeywords(existingValue)) {
    return incomingValue;
  }

  return existingValue;
}

function getBudgetSignalScore(value) {
  if (!value) {
    return 0;
  }

  let score = value.length;

  if (/(?:\u20B9|rs|inr|\$)/i.test(value)) {
    score += 20;
  }

  if (/\d/.test(value)) {
    score += 10;
  }

  if (/(?:k|thousand|lakhs?|lakh|crores?|crore|million)/i.test(value)) {
    score += 8;
  }

  return score;
}

function getTimelineSignalScore(value) {
  if (!value) {
    return 0;
  }

  let score = value.length;

  if (/urgent|asap|today|tomorrow|this week/i.test(value)) {
    score += 10;
  }

  if (/\d/.test(value)) {
    score += 6;
  }

  return score;
}

function tightenReply(text) {
  if (!text) {
    return "";
  }

  const softened = text
    .replace(/^thanks for sharing the details[,]?\s*/i, "Got it. ")
    .replace(/^based on your input[,]?\s*/i, "")
    .replace(/^it seems that\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const sentences = softened.match(/[^.!?\n]+[.!?]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) || [];

  if (!sentences.length) {
    return softened;
  }

  if (sentences.length <= 2 && softened.length <= 220) {
    return softened;
  }

  const statement = sentences.find((sentence) => !/[?]\s*$/.test(sentence)) || sentences[0];
  const question = extractFollowUpQuestion(softened);
  const selected = [];

  if (statement) {
    selected.push(cleanupSentence(statement));
  }

  if (question && !containsSameSentence(statement, question)) {
    selected.push(cleanupSentence(question));
  }

  return selected.join(" ").trim() || cleanupSentence(sentences.slice(0, 2).join(" "));
}

function cleanupSentence(text) {
  const cleaned = cleanupValue(text);

  if (!cleaned) {
    return "";
  }

  return /[.!?]\s*$/.test(text.trim()) ? text.trim() : `${cleaned}.`;
}

function containsSameSentence(source, candidate) {
  const normalizedSource = normalizeCompare(source);
  const normalizedCandidate = normalizeCompare(candidate);

  return normalizedSource.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedSource);
}

function normalizeCompare(value) {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function joinList(items) {
  if (!items.length) {
    return "a few more details";
  }

  if (items.length === 1) {
    return items[0];
  }

  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function fieldLabel(field) {
  if (field === "need") {
    return "the need";
  }

  return field;
}

function countNeedKeywords(text) {
  const matches = text.match(/crm|sales|support|workflow|automation|lead|follow-?up|calling|voice|customer|tool|platform|software/gi);
  return matches ? matches.length : 0;
}

function isValidNeedCandidate(value) {
  if (!value) {
    return false;
  }

  if (/^(?:approval|approval from|manager approval|budget|pricing|quote|timeline|urgent|asap)\b/i.test(value)) {
    return false;
  }

  if (/(?:approval|approve|decision maker|budget|pricing|quote|timeline|asap|urgent)$/i.test(value)) {
    return countNeedKeywords(value) > 0;
  }

  return true;
}

function isValidCompanyCandidate(value) {
  return !/^(?:my manager|my boss|manager|boss|founder|ceo|owner|team|company)$/i.test(value || "");
}

function looksLikeUseCase(text) {
  return (
    text.length > 12 &&
    /(crm|sales|support|workflow|automation|lead|follow-?up|calling|voice|customer|ai|tool|platform|software)/i.test(text)
  );
}

function looksLikeIntroduction(text) {
  return /(?:my name is|this is|i am|i'm)\s+[a-z]/i.test(text) && !/(looking for|need|want|trying to|interested in)/i.test(text);
}

function isDecisionMakerRole(role) {
  return Boolean(role && /(founder|co-founder|owner|ceo|cto|cfo|director|head|vp|vice president|partner)/i.test(role));
}
