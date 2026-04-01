import { env } from "../config/env.js";
import { createHttpError } from "../utils/http-error.js";
import {
  buildSpokenReply,
  buildLeadSystemPrompt,
  buildLeadThinking,
  extractFollowUpQuestion,
  extractLeadDetails,
  mergeAndQualify,
  normalizeAssistantReply
} from "./lead-agent.service.js";
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
  let transcription = {
    transcript: fallbackTranscript || "",
    language_code: requestedLanguageCode || env.defaultLanguageCode
  };

  if (buffer?.length) {
    try {
      transcription = await transcribeAudio({
        buffer,
        filename,
        mimeType,
        languageCode: requestedLanguageCode
      });
    } catch (error) {
      if (!fallbackTranscript) {
        throw error;
      }
    }
  } else if (!fallbackTranscript) {
    throw createHttpError(400, "Audio or transcript input is required for a voice turn.");
  }

  const session = getSession(resolvedSessionId);
  const transcriptText = transcription.transcript || fallbackTranscript || "";
  const extractedDetails = extractLeadDetails(transcriptText, session.leadProfile);
  const { leadProfile, qualification } = mergeAndQualify(session.leadProfile, extractedDetails);
  const detectedLanguageCode = transcription.language_code || requestedLanguageCode || env.defaultLanguageCode;

  const conversationMessages = [
    {
      role: "system",
      content: buildLeadSystemPrompt({
        languageCode: detectedLanguageCode,
        leadProfile,
        qualification
      })
    },
    ...session.transcript.flatMap((entry) => [
      { role: "user", content: entry.user },
      { role: "assistant", content: entry.assistant }
    ]),
    {
      role: "user",
      content: transcriptText
    }
  ];

  const assistantReply = await generateLeadReply({
    messages: conversationMessages
  });

  let finalAnswer = normalizeAssistantReply(assistantReply.text);
  const nextQuestion = extractFollowUpQuestion(finalAnswer) || qualification.nextQuestion;

  if (nextQuestion && !finalAnswer.includes(nextQuestion)) {
    finalAnswer = `${finalAnswer} ${nextQuestion}`.trim();
  }

  const responseQualification = {
    ...qualification,
    nextQuestion
  };
  const thinking = buildLeadThinking({
    leadProfile,
    qualification: responseQualification
  });

  const speech = await synthesizeSpeech({
    text: buildSpokenReply(finalAnswer, nextQuestion),
    languageCode: detectedLanguageCode,
    speaker: resolvedSpeaker
  });

  const updatedSession = updateSession(resolvedSessionId, (current) => ({
    ...current,
    leadProfile,
    qualification: responseQualification,
    transcript: [
      ...current.transcript,
      {
        user: transcriptText,
        assistant: finalAnswer,
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
