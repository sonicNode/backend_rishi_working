import { env } from "../config/env.js";
import { createHttpError } from "../utils/http-error.js";
import {
  buildLeadSystemPrompt,
  buildLeadThinking,
  buildSpokenReply,
  extractFollowUpQuestion,
  extractLeadDetails,
  mergeAndQualify,
  normalizeAssistantReply
} from "./lead-agent.service.js";
import { generateLeadIntelligence } from "./gemini.service.js";
import { generateLeadReply, synthesizeSpeech, transcribeAudio } from "./sarvam.service.js";
import { getSession, updateSession } from "./session-store.js";

export async function processVoiceTurn({
  buffer,
  filename,
  mimeType,
  sessionId,
  requestedLanguageCode,
  speaker,
  fallbackTranscript
}) {
  const resolvedSessionId = sessionId || `session-${Date.now()}`;
  const resolvedSpeaker = speaker || env.defaultSpeaker;
  const normalizedFallbackTranscript = (fallbackTranscript || "").trim();
  let transcription = {
    transcript: normalizedFallbackTranscript,
    language_code: requestedLanguageCode || env.defaultLanguageCode
  };

  if (!normalizedFallbackTranscript && buffer?.length) {
    try {
      transcription = await transcribeAudio({
        buffer,
        filename,
        mimeType,
        languageCode: requestedLanguageCode
      });
    } catch (error) {
      if (!normalizedFallbackTranscript) {
        throw error;
      }
    }
  } else if (!buffer?.length && !normalizedFallbackTranscript) {
    throw createHttpError(400, "Audio or transcript input is required for a voice turn.");
  }

  const session = getSession(resolvedSessionId);
  const transcriptText = transcription.transcript || normalizedFallbackTranscript || "";
  const detectedLanguageCode = transcription.language_code || requestedLanguageCode || env.defaultLanguageCode;
  const extractedDetails = extractLeadDetails(transcriptText, session.leadProfile);
  const localTurnState = mergeAndQualify(session.leadProfile, extractedDetails);

  let leadProfile = localTurnState.leadProfile;
  let qualification = localTurnState.qualification;
  let finalAnswer = "";
  let thinking = "";
  let nextQuestion = qualification.nextQuestion;

  const geminiTurnState = await maybeApplyGeminiIntelligence({
    transcriptText,
    languageCode: detectedLanguageCode,
    session,
    leadProfile,
    qualification
  });

  if (geminiTurnState) {
    leadProfile = geminiTurnState.leadProfile;
    qualification = geminiTurnState.qualification;
    finalAnswer = geminiTurnState.finalAnswer;
    thinking = geminiTurnState.thinking;
    nextQuestion = geminiTurnState.nextQuestion;
  } else {
    const assistantReply = await generateLeadReply({
      messages: buildConversationMessages({
        transcriptText,
        languageCode: detectedLanguageCode,
        leadProfile,
        qualification,
        transcriptHistory: session.transcript
      })
    });

    finalAnswer = normalizeAssistantReply(assistantReply.text);
    nextQuestion = extractFollowUpQuestion(finalAnswer) || qualification.nextQuestion;
    thinking = buildLeadThinking({
      leadProfile,
      qualification: {
        ...qualification,
        nextQuestion
      }
    });
  }

  const responseQualification = {
    ...qualification,
    nextQuestion
  };
  const speech = await synthesizeSpeech({
    text: buildSpokenReply(finalAnswer, nextQuestion),
    languageCode: detectedLanguageCode,
    speaker: resolvedSpeaker
  });
  const assistantTranscriptEntry = buildAssistantTranscriptEntry(finalAnswer, nextQuestion);

  const updatedSession = updateSession(resolvedSessionId, (current) => ({
    ...current,
    leadProfile,
    qualification: responseQualification,
    transcript: [
      ...current.transcript,
      {
        user: transcriptText,
        assistant: assistantTranscriptEntry,
        languageCode: detectedLanguageCode,
        createdAt: new Date().toISOString()
      }
    ]
  }));

  return {
    sessionId: resolvedSessionId,
    userTranscript: transcriptText,
    detectedLanguageCode,
    assistantText: finalAnswer,
    final_answer: finalAnswer,
    thinking,
    next_question: nextQuestion,
    bant: responseQualification.bant,
    score: responseQualification.scoreOutOf10,
    label: responseQualification.label,
    summary: responseQualification.summary,
    assistantAudioBase64: speech.audioBase64,
    assistantAudioMimeType: "audio/wav",
    leadProfile: updatedSession.leadProfile,
    qualification: {
      ...updatedSession.qualification,
      nextQuestion
    }
  };
}

async function maybeApplyGeminiIntelligence({
  transcriptText,
  languageCode,
  session,
  leadProfile,
  qualification
}) {
  try {
    const geminiResponse = await generateLeadIntelligence({
      transcriptText,
      languageCode,
      leadProfile,
      qualification,
      transcriptHistory: session.transcript
    });

    if (!geminiResponse?.final_answer) {
      return null;
    }

    const geminiDerivedDetails = buildLeadDetailsFromGemini({
      leadProfile,
      bant: geminiResponse.bant
    });
    const mergedTurnState = mergeAndQualify(leadProfile, geminiDerivedDetails);
    const nextQuestion = normalizeQuestion(geminiResponse.next_question) || mergedTurnState.qualification.nextQuestion;
    const responseQualification = buildResponseQualification({
      qualification: mergedTurnState.qualification,
      preferredScore: geminiResponse.score,
      preferredLabel: geminiResponse.label,
      nextQuestion
    });

    return {
      leadProfile: mergedTurnState.leadProfile,
      qualification: responseQualification,
      finalAnswer: normalizeAssistantReply(geminiResponse.final_answer),
      thinking:
        normalizeThinking(geminiResponse.thinking) ||
        buildLeadThinking({
          leadProfile: mergedTurnState.leadProfile,
          qualification: responseQualification
        }),
      nextQuestion
    };
  } catch (error) {
    console.warn("[voice-turn] Gemini intelligence failed. Falling back to Sarvam chat.", error);
    return null;
  }
}

function buildConversationMessages({
  transcriptText,
  languageCode,
  leadProfile,
  qualification,
  transcriptHistory
}) {
  return [
    {
      role: "system",
      content: buildLeadSystemPrompt({
        languageCode,
        leadProfile,
        qualification
      })
    },
    ...(transcriptHistory || []).flatMap((entry) => [
      { role: "user", content: entry.user },
      { role: "assistant", content: entry.assistant }
    ]),
    {
      role: "user",
      content: transcriptText
    }
  ];
}

function buildLeadDetailsFromGemini({ leadProfile, bant }) {
  if (!bant) {
    return {};
  }

  return {
    budget: bant.budget || null,
    timeline: normalizeTimeline(bant.timeline),
    authority: bant.authority ? "decision-maker" : null,
    useCase: bant.need ? leadProfile.useCase || "Requirement shared" : null
  };
}

function buildResponseQualification({ qualification, preferredScore, preferredLabel, nextQuestion }) {
  const scoreOutOf10 = Number.isFinite(preferredScore) ? clampScore(preferredScore) : qualification.scoreOutOf10;
  const labelKey = normalizeLabelKey(preferredLabel, scoreOutOf10);

  return {
    ...qualification,
    scoreOutOf10,
    labelKey,
    label: getDisplayLabel(labelKey),
    nextQuestion,
    summary: buildQualificationSummary(qualification.bant, labelKey)
  };
}

function buildAssistantTranscriptEntry(finalAnswer, nextQuestion) {
  const combined = buildSpokenReply(finalAnswer, nextQuestion);
  return combined || finalAnswer;
}

function normalizeThinking(value) {
  const normalized = (value || "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function normalizeQuestion(value) {
  const normalized = (value || "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function normalizeTimeline(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();

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

function normalizeLabelKey(label, score) {
  const normalizedLabel = (label || "").toLowerCase();

  if (normalizedLabel.includes("hot")) {
    return "hot";
  }

  if (normalizedLabel.includes("warm")) {
    return "warm";
  }

  if (normalizedLabel.includes("cold")) {
    return "cold";
  }

  if (score >= 8) {
    return "hot";
  }

  if (score >= 5) {
    return "warm";
  }

  return "cold";
}

function getDisplayLabel(labelKey) {
  if (labelKey === "hot") {
    return "Hot \u{1F525}";
  }

  if (labelKey === "warm") {
    return "Warm \u{1F642}";
  }

  return "Cold \u2744\uFE0F";
}

function buildQualificationSummary(bant, labelKey) {
  const missingFields = BANT_FIELDS.filter((field) => !bant[field]).map((field) => getReadableFieldName(field));

  if (labelKey === "hot") {
    return "Strong lead with clear need, budget, and decision access.";
  }

  if (labelKey === "warm") {
    if (missingFields.length === 1) {
      return `Decent lead, needs clarity on ${missingFields[0]}.`;
    }

    return `Promising lead, but we still need ${joinList(missingFields)}.`;
  }

  if (!bant.need) {
    return "Early lead, still understanding the requirement.";
  }

  return `Early-stage lead. We still need ${joinList(missingFields)}.`;
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

function getReadableFieldName(field) {
  return field === "need" ? "the need" : field;
}

function clampScore(score) {
  return Math.max(0, Math.min(10, Math.round(score)));
}

const BANT_FIELDS = ["need", "budget", "authority", "timeline"];
