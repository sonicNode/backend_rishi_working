import { env } from "../config/env.js";
import { createHttpError } from "../utils/http-error.js";

const OPENAI_SYSTEM_PROMPT = `You are a sales qualification assistant using the BANT framework.

Analyze the user input and extract:

* Budget (numeric or null)
* Authority (true/false)
* Need (true/false)
* Timeline (urgent/flexible/null)

Then:

* Score the lead from 0 to 10
* Classify as Hot / Warm / Cold
* Generate a short, natural response (1-2 lines)
* Ask the next relevant question (if needed)

Return STRICT JSON:

{
"final_answer": "...",
"thinking": "...",
"bant": {
"budget": null,
"authority": false,
"need": false,
"timeline": null
},
"score": 0,
"label": "Cold",
"next_question": "..."
}

DO NOT return anything outside JSON.`;

const OPENAI_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "lead_qualification",
    strict: true,
    schema: {
      type: "object",
      properties: {
        final_answer: {
          type: "string"
        },
        thinking: {
          type: "string"
        },
        bant: {
          type: "object",
          properties: {
            budget: {
              anyOf: [
                { type: "number" },
                { type: "string" },
                { type: "null" }
              ]
            },
            authority: {
              type: "boolean"
            },
            need: {
              type: "boolean"
            },
            timeline: {
              anyOf: [
                { type: "string" },
                { type: "null" }
              ]
            }
          },
          required: ["budget", "authority", "need", "timeline"],
          additionalProperties: false
        },
        score: {
          anyOf: [
            {
              type: "number",
              minimum: 0,
              maximum: 10
            },
            { type: "null" }
          ]
        },
        label: {
          anyOf: [
            {
              type: "string",
              enum: ["Hot", "Warm", "Cold"]
            },
            { type: "null" }
          ]
        },
        next_question: {
          anyOf: [
            { type: "string" },
            { type: "null" }
          ]
        }
      },
      required: ["final_answer", "thinking", "bant", "score", "label", "next_question"],
      additionalProperties: false
    }
  }
};

export function isOpenAiConfigured() {
  return Boolean(env.openaiApiKey);
}

export async function generateLeadIntelligence({
  transcriptText,
  languageCode,
  leadProfile,
  qualification,
  transcriptHistory
}) {
  if (!env.openaiApiKey) {
    return null;
  }

  const response = await fetch(`${env.openaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.openaiApiKey}`
    },
    body: JSON.stringify({
      model: env.openaiModel,
      temperature: 0.2,
      response_format: OPENAI_RESPONSE_FORMAT,
      messages: buildOpenAiMessages({
        transcriptText,
        languageCode,
        leadProfile,
        qualification,
        transcriptHistory
      })
    })
  });

  const payload = await parseOpenAiResponse(response);
  const assistantMessage = payload?.choices?.[0]?.message?.content;

  if (!assistantMessage) {
    throw createHttpError(502, "OpenAI response did not include assistant content.", payload);
  }

  return normalizeOpenAiLeadResult(parseStructuredJson(assistantMessage));
}

function buildOpenAiMessages({ transcriptText, languageCode, leadProfile, qualification, transcriptHistory }) {
  const recentTurns = (transcriptHistory || [])
    .slice(-4)
    .map((entry, index) => `${index + 1}. User: ${entry.user}\nAssistant: ${entry.assistant}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        `${OPENAI_SYSTEM_PROMPT}\n\n` +
        `Use the same language as the latest user message. The current language code is ${languageCode}. ` +
        `Keep final_answer short, natural, and conversational. thinking can be more detailed, but it must still be plain text.`
    },
    {
      role: "user",
      content:
        `Latest user transcript:\n${transcriptText}\n\n` +
        `Current lead profile:\n${JSON.stringify(leadProfile, null, 2)}\n\n` +
        `Current qualification snapshot:\n${JSON.stringify(
          {
            bant: qualification.bant,
            score: qualification.scoreOutOf10,
            label: qualification.label,
            next_question: qualification.nextQuestion
          },
          null,
          2
        )}\n\n` +
        `Recent conversation:\n${recentTurns || "None"}\n\n` +
        "Only confirm fields that are actually supported by the transcript or current context. If a value is uncertain, return null or false."
    }
  ];
}

async function parseOpenAiResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    throw createHttpError(response.status, "OpenAI API request failed", payload);
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
    throw createHttpError(502, "OpenAI returned invalid JSON.", {
      message: error instanceof Error ? error.message : "Unknown JSON parsing error",
      text
    });
  }
}

function normalizeOpenAiLeadResult(result) {
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
