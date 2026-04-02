import express from "express";
import multer from "multer";
import { env } from "../config/env.js";
import { asyncHandler } from "../utils/async-handler.js";
import { createHttpError } from "../utils/http-error.js";
import { synthesizeSpeech, transcribeAudio } from "../services/sarvam.service.js";
import { deleteSession, getSession } from "../services/session-store.js";
import { processVoiceTurn } from "../services/voice-turn.service.js";

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
    const fallbackTranscript = req.body.fallbackTranscript || "";
    const data = await processVoiceTurn({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      sessionId,
      requestedLanguageCode,
      speaker,
      fallbackTranscript
    });

    res.json({
      success: true,
      data
    });
  })
);

export default router;
