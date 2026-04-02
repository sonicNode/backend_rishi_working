import { env } from "../config/env.js";
import { createHttpError } from "../utils/http-error.js";

const GEMINI_PROMPT = `You are Lead Sathi, a friendly AI sales assistant.

Your goal is to qualify a lead using these dimensions:
- Budget
- Authority
- Need
- Timeline

Conversation rules:
- Have a natural conversation, not a questionnaire
- Ask only one question at a time
- Do not explicitly mention BANT
- Start by understanding the user's need first
- Then explore budget naturally, for example investment range
- Then understand who makes the decision
- Then ask about timeline
- Adapt questions based on what the user already shared
- Do not repeat questions that are already answered
- Keep responses short, human-like, and conversational
- If the user uses mixed language or Hinglish, respond similarly

Analysis rules:
- Extract Budget as text or null
- Extract Authority as true or false
- Extract Need as true or false
- Extract Timeline as urgent, flexible, a specific short phrase, or null
- Score the lead from 0 to 10
- Classify as Hot, Warm, or Cold
- Generate a short natural final answer
- Ask the next relevant question only if needed

Return strict JSON only.`;

const GEMINI_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    final_answer: {
      type: "string",
      description: "Short, natural, conversational answer in the same language as the user."
    },
    thinking: {
      type: "string",
      description: "Detailed reasoning for UI only."
    },
    bant: {
      type: "object",
      properties: {
        budget: {
          type: ["string", "null"],
          description: "Budget captured as text, for example 10000, 10k, or Rs 5000."
        },
        authority: {
          type: "boolean",
          description: "Whether the user is the decision maker."
        },
        need: {
          type: "boolean",
          description: "Whether a clear need is present."
        },
        timeline: {
          type: ["string", "null"],
          description: "Timeline classification, typically urgent or flexible, or null."
        }
      },
      required: ["budget", "authority", "need", "timeline"],
      additionalProperties: false
    },
    score: {
      type: ["integer", "null"],
      description: "Lead score from 0 to 10."
    },
    label: {
      type: ["string", "null"],
      enum: ["Hot", "Warm", "Cold", null],
      description: "Lead label."
    },
    next_question: {
      type: ["string", "null"],
      description: "Next relevant question, if any."
    }
  },
  required: ["final_answer", "thinking", "bant", "score", "label", "next_question"],
  additionalProperties: false
};

export async function generateLeadIntelligence({
  transcriptText,
  languageCode,
  leadProfile,
  qualification,
  transcriptHistory
}) {
  if (!env.geminiApiKey) {
    return null;
  }

  const response = await fetch(`${env.geminiBaseUrl}/models/${env.geminiModel}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.geminiApiKey
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: buildGeminiPrompt({
                transcriptText,
                languageCode,
                leadProfile,
                qualification,
                transcriptHistory
              })
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseJsonSchema: GEMINI_RESPONSE_SCHEMA
      }
    })
  });

  const payload = await parseGeminiResponse(response);
  const candidateText = payload?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!candidateText) {
    throw createHttpError(502, "Gemini response did not include structured content.", payload);
  }

  return normalizeGeminiLeadResult(parseStructuredJson(candidateText));
}

function buildGeminiPrompt({ transcriptText, languageCode, leadProfile, qualification, transcriptHistory }) {
  const recentTurns = (transcriptHistory || [])
    .slice(-4)
    .map((entry, index) => `${index + 1}. User: ${entry.user}\nAssistant: ${entry.assistant}`)
    .join("\n\n");

  return [
    GEMINI_PROMPT,
    "",
    `Latest user transcript: ${transcriptText}`,
    `Current language code: ${languageCode}`,
    "",
    "Current lead profile:",
    JSON.stringify(leadProfile, null, 2),
    "",
    "Current qualification snapshot:",
    JSON.stringify(
      {
        bant: qualification.bant,
        score: qualification.scoreOutOf10,
        label: qualification.label,
        next_question: qualification.nextQuestion
      },
      null,
      2
    ),
    "",
    "Conversation priority:",
    "1. Understand the need first if it is still unclear.",
    "2. Then ask about budget naturally.",
    "3. Then ask who makes the decision.",
    "4. Then ask about timeline.",
    "5. Never repeat a question if the answer is already available in the current context or recent conversation.",
    "",
    "Recent conversation:",
    recentTurns || "None",
    "",
    "Only confirm fields that are clearly supported by the transcript or current context. If uncertain, return null or false. Do not include markdown or explanations outside the JSON."
  ].join("\n");
}

async function parseGeminiResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    throw createHttpError(response.status, "Gemini API request failed", payload);
  }

  return payload;
}

function parseStructuredJson(text) {
  const cleaned = (text || "")
    .replace(/```json/gi, "```")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw createHttpError(502, "Gemini returned invalid JSON.", {
      message: error instanceof Error ? error.message : "Unknown JSON parsing error",
      text
    });
  }
}

function normalizeGeminiLeadResult(result) {
  const score = Number.isFinite(Number(result?.score)) ? clampScore(Number(result.score)) : null;
  const normalizedLabel = normalizeLabel(result?.label, score);

  return {
    final_answer: normalizePlainText(result?.final_answer),
    thinking: normalizePlainText(result?.thinking),
    bant: {
      budget: normalizeBudget(result?.bant?.budget),
      authority: Boolean(result?.bant?.authority),
      need: Boolean(result?.bant?.need),
      timeline: normalizeTimeline(result?.bant?.timeline)
    },
    score,
    label: normalizedLabel,
    next_question: normalizePlainText(result?.next_question)
  };
}

function normalizePlainText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function normalizeBudget(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  const normalized = normalizePlainText(String(value));
  return normalized || null;
}

function normalizeTimeline(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = normalizePlainText(String(value)).toLowerCase();

  if (!normalized) {
    return null;
  }

  if (normalized.includes("urgent") || normalized.includes("asap") || normalized.includes("immediate")) {
    return "urgent";
  }

  if (normalized.includes("flexible")) {
    return "flexible";
  }

  return normalized;
}

function normalizeLabel(label, score) {
  const normalized = normalizePlainText(label).toLowerCase();

  if (normalized === "hot" || normalized === "warm" || normalized === "cold") {
    return normalized === "hot" ? "Hot" : normalized === "warm" ? "Warm" : "Cold";
  }

  if (score === null) {
    return null;
  }

  if (score >= 8) {
    return "Hot";
  }

  if (score >= 5) {
    return "Warm";
  }

  return "Cold";
}

function clampScore(score) {
  return Math.max(0, Math.min(10, Math.round(score)));
}
