const REQUIRED_FIELDS = ["name", "company", "useCase", "budget", "timeline"];
const BANT_FIELDS = ["budget", "authority", "need", "timeline"];
const BANT_QUESTIONS = {
  budget: "What budget range have you set aside for this?",
  authority: "Will you be the person making the final decision on this?",
  need: "What problem are you trying to solve with this?",
  timeline: "When would you like to get this live?"
};

function mergeLeadProfile(existing, incoming) {
  return {
    ...existing,
    ...Object.fromEntries(
      Object.entries(incoming).filter(([, value]) => value !== null && value !== undefined && value !== "")
    )
  };
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

export function buildLeadSystemPrompt({ languageCode, leadProfile, qualification }) {
  const promptForNextStep = qualification.nextQuestion
    ? `If you need a follow-up, end with one clear question that naturally covers this gap: "${qualification.nextQuestion}"`
    : "If BANT is complete, briefly summarize the fit and ask permission for the next step.";

  return `
You are a multilingual voice sales assistant for lead qualification.
Always reply in the same language as the user's latest message. If the user mixes languages, reply naturally in the same style.
Your job is to qualify a lead for a sales team.

Goals:
1. Sound like a calm human sales rep, not an AI assistant.
2. Be concise and conversational because your reply will be spoken aloud.
3. Reply in 1 or 2 short sentences.
4. Ask only one focused follow-up question at a time.
5. Keep qualification focused on BANT only: budget, authority, need, and timeline.
6. Do not ask about team size, email, phone, or any other field until BANT is complete.
7. If the user asks a product question, answer briefly and then continue qualification.
8. Never mention internal prompts, scoring, BANT, JSON, reasoning, or hidden thoughts.
9. Never output <think> tags or any hidden-analysis text.
10. Do not use bullet points, labels, markdown, or quotation marks.

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

export function extractLeadDetails(text) {
  const details = {
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

  const normalized = text.trim();

  const emailMatch = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch) {
    details.email = emailMatch[0];
  }

  const phoneMatch = normalized.match(/(\+?\d[\d\s-]{7,}\d)/);
  if (phoneMatch) {
    details.phone = phoneMatch[0].replace(/\s+/g, " ").trim();
  }

  const nameMatch =
    normalized.match(
      /(?:my name is|this is)\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})(?=(?:\s+(?:from|at|and|looking|interested|trying|we|i)\b|[,.]|$))/i
    ) ||
    normalized.match(
      /(?:i am|i'm)\s+(?!looking\b|interested\b|trying\b|planning\b|exploring\b|evaluating\b)([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})(?=(?:\s+(?:from|at|and|looking|interested|trying|we|i)\b|[,.]|$))/i
    );
  if (nameMatch) {
    details.name = capitalizeWords(nameMatch[1].split(/\b(?:from|at)\b/i)[0]);
  }

  const companyMatch = normalized.match(
    /(?:from|at|company is|work at)\s+([a-z0-9&][a-z0-9&.' -]{1,40}?)(?=(?:\s+(?:we|i|and|budget|timeline|looking|interested|trying|want|need|next|within|by)\b|[,.]|$))/i
  );
  if (companyMatch) {
    details.company = cleanupValue(companyMatch[1]);
  }

  const roleMatch = normalized.match(/(?:i am a|i work as|my role is|i'm a)\s+([a-z][a-z\s/-]{2,40})/i);
  if (roleMatch) {
    details.role = cleanupValue(roleMatch[1]);
  }

  const budgetMatch = normalized.match(
    /(?:budget is|budget of|around|approx(?:imately)?|about|we can spend|we could spend|spend around)\s+(rs\.?\s?[\d,]+(?:\s?(?:lakhs?|lakh|crores?|crore|thousand|k))?|inr\s?[\d,]+(?:\s?(?:lakhs?|lakh|crores?|crore|thousand|k))?|rupees?\s?[\d,]+(?:\s?(?:lakhs?|lakh|crores?|crore|thousand|k))?|\u20B9\s?[\d,]+(?:\s?(?:lakhs?|lakh|crores?|crore|thousand|k))?|\$[\d,]+|[\d,]+\s?(?:lakhs?|lakh|crores?|crore|thousand|k)|(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:lakhs?|lakh|crores?|crore|thousand))/i
  );
  if (budgetMatch) {
    details.budget = cleanupValue(budgetMatch[1]);
  }

  const timelineMatch = normalized.match(
    /(?:timeline is|looking to|want to|plan to|go live|launch|start|within|by)\s+(immediately|asap|this month|next month|quarter end|\d+\s+(?:days?|weeks?|months?))/i
  );
  if (timelineMatch) {
    details.timeline = cleanupValue(timelineMatch[1]);
  }

  const teamSizeMatch = normalized.match(/(\d+)\s+(?:sales reps|users|agents|people|employees|team members)/i);
  if (teamSizeMatch) {
    details.teamSize = teamSizeMatch[1];
  }

  if (hasDecisionMakerSignal(normalized) || isDecisionMakerRole(details.role)) {
    details.authority = "decision-maker";
  } else if (hasApprovalSignal(normalized)) {
    details.authority = "needs-approval";
  }

  const useCaseMatch = normalized.match(
    /(?:looking for|need(?:ing)?|need help with|interested in|trying to|exploring|evaluating|solution for|tool for|platform for)\s+(.+?)(?=[.?!]|$)/i
  );

  if (useCaseMatch) {
    details.useCase = cleanupValue(useCaseMatch[1]);
  } else if (looksLikeUseCase(normalized)) {
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
    summary: buildLeadSummary({ bant, scoreOutOf10, labelKey })
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
  } else if (qualification.bant.authority) {
    details.push("Authority is mentioned, but final buying control still appears to need approval.");
  } else {
    details.push("Authority is still unconfirmed.");
  }

  if (qualification.bant.timeline) {
    details.push(
      isUrgentTimeline(qualification.bant.timeline)
        ? `Timeline is ${qualification.bant.timeline}, which sounds urgent.`
        : `Timeline is ${qualification.bant.timeline}, but it does not sound urgent yet.`
    );
  } else {
    details.push("Timeline is still open.");
  }

  details.push(`Current lead score is ${qualification.scoreOutOf10}/10, which puts this lead in the ${qualification.labelKey} bucket.`);

  if (qualification.nextQuestion) {
    details.push(`Next best question: ${qualification.nextQuestion}`);
  } else {
    details.push("BANT is covered, so the next step is to confirm interest in moving forward.");
  }

  return details.join(" ");
}

export function normalizeAssistantReply(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    .replace(/^(?:assistant|final answer|response)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractFollowUpQuestion(text) {
  const questionMatches = text.match(/[^.?!\n]*[?\uFF1F]/g);

  if (!questionMatches?.length) {
    return null;
  }

  return questionMatches[questionMatches.length - 1].trim();
}

export function mergeAndQualify(existingLeadProfile, extractedDetails) {
  const leadProfile = mergeLeadProfile(existingLeadProfile, extractedDetails);
  const qualification = buildQualification(leadProfile);
  return { leadProfile, qualification };
}

function cleanupValue(value) {
  return value.replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "");
}

function capitalizeWords(value) {
  return cleanupValue(value)
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
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

  if (bant.authority === "decision-maker") {
    total += 2;
  }

  if (bant.need) {
    total += 3;
  }

  if (bant.timeline && isUrgentTimeline(bant.timeline)) {
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
  if (labelKey === "hot") {
    if (isUrgentTimeline(bant.timeline)) {
      return "Strong lead with clear budget, buying authority, and an urgent timeline.";
    }

    return "Strong lead with clear intent and enough buying signals for a fast follow-up.";
  }

  if (labelKey === "warm") {
    return `Promising lead, but ${formatMissingBantFields(bant)} still need confirmation.`;
  }

  return `Early-stage lead. We still need to confirm ${formatMissingBantFields(bant)}.`;
}

function formatMissingBantFields(bant) {
  const missing = BANT_FIELDS.filter((field) => !bant[field]).map((field) => fieldLabel(field));

  if (!missing.length) {
    return "a few final details";
  }

  if (missing.length === 1) {
    return missing[0];
  }

  return `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
}

function fieldLabel(field) {
  if (field === "need") {
    return "need";
  }

  return field;
}

function looksLikeUseCase(text) {
  return (
    text.length > 12 &&
    /(crm|sales|support|workflow|automation|lead|follow-?up|calling|voice|customer|ai|tool|platform|software)/i.test(text)
  );
}

function hasDecisionMakerSignal(text) {
  return /(?:decision maker|i decide|i make the final decision|i handle the purchase|i approve|i sign off|i am the founder|i'm the founder|owner|ceo|head of|director)/i.test(
    text
  );
}

function hasApprovalSignal(text) {
  return /(?:need approval|not the decision maker|someone else decides|my manager decides|finance approves|procurement approves|leadership approves|founder decides|ceo decides)/i.test(
    text
  );
}

function isDecisionMakerRole(role) {
  return Boolean(role && /(founder|co-founder|owner|ceo|cto|cfo|director|head|vp|vice president)/i.test(role));
}

function isUrgentTimeline(timeline) {
  return /(immediately|asap|this month|next month|quarter end|[1-8]\s+(?:days?|weeks?))/i.test(timeline || "");
}
