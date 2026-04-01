import express from "express";
import multer from "multer";
import { env } from "../config/env.js";
import { asyncHandler } from "../utils/async-handler.js";
import { createHttpError } from "../utils/http-error.js";
import {
  buildSpokenReply,
  buildLeadSystemPrompt,
  buildLeadThinking,
  extractFollowUpQuestion,
  extractLeadDetails,
  mergeAndQualify,
  normalizeAssistantReply
} from "../services/lead-agent.service.js";
import { generateLeadReply, synthesizeSpeech, transcribeAudio } from "../services/sarvam.service.js";
import { deleteSession, getSession, updateSession } from "../services/session-store.js";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

router.get(
  "/session/:sessionId",
  asyncHandler(async (req, res) => {
    const session = getSession(req.params.sessionId);
    res.json({ success: true, data: session });
  })
);

router.delete(
  "/session/:sessionId",
  asyncHandler(async (req, res) => {
    deleteSession(req.params.sessionId);
    res.json({ success: true, message: "Session deleted" });
  })
);

router.post(
  "/transcribe",
  upload.single("audio"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw createHttpError(400, "Audio file is required in the `audio` field.");
    }

    const transcription = await transcribeAudio({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      languageCode: req.body.languageCode
    });

    res.json({
      success: true,
      data: transcription
    });
  })
);

router.post(
  "/speak",
  asyncHandler(async (req, res) => {
    const { text, languageCode, speaker } = req.body;

    if (!text) {
      throw createHttpError(400, "`text` is required.");
    }

    const speech = await synthesizeSpeech({
      text,
      languageCode: languageCode || env.defaultLanguageCode,
      speaker
    });

    res.json({
      success: true,
      data: {
        text,
        languageCode: languageCode || env.defaultLanguageCode,
        speaker: speaker || env.defaultSpeaker,
        audioBase64: speech.audioBase64,
        audioMimeType: "audio/wav"
      }
    });
  })
);

router.post(
  "/respond",
  upload.single("audio"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw createHttpError(400, "Audio file is required in the `audio` field.");
    }

    const sessionId = req.body.sessionId || `session-${Date.now()}`;
    const requestedLanguageCode = req.body.languageCode || null;
    const speaker = req.body.speaker || env.defaultSpeaker;

    const transcription = await transcribeAudio({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      languageCode: requestedLanguageCode
    });

    const session = getSession(sessionId);
    const extractedDetails = extractLeadDetails(transcription.transcript || "", session.leadProfile);
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
        content: transcription.transcript
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
      speaker
    });

    const updatedSession = updateSession(sessionId, (current) => ({
      ...current,
      leadProfile,
      qualification: responseQualification,
      transcript: [
        ...current.transcript,
        {
          user: transcription.transcript,
          assistant: finalAnswer,
          languageCode: detectedLanguageCode,
          createdAt: new Date().toISOString()
        }
      ]
    }));

    res.json({
      success: true,
      data: {
        sessionId,
        userTranscript: transcription.transcript,
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
      }
    });
  })
);

export default router;
