import { env } from "../config/env.js";
import { createHttpError } from "../utils/http-error.js";

function getHeaders(extraHeaders = {}) {
  if (!env.sarvamApiKey) {
    throw createHttpError(500, "SARVAM_API_KEY is missing. Add it to your environment before calling voice routes.");
  }

  return {
    "api-subscription-key": env.sarvamApiKey,
    ...extraHeaders
  };
}

async function parseSarvamResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    throw createHttpError(response.status, "Sarvam API request failed", payload);
  }

  return payload;
}

export async function transcribeAudio({ buffer, filename, mimeType, languageCode }) {
  const form = new FormData();
  const file = new File([buffer], filename || "audio.wav", {
    type: mimeType || "audio/wav"
  });

  form.append("file", file);
  form.append("model", env.sttModel);
  form.append("mode", env.sttMode);

  if (languageCode) {
    form.append("language_code", languageCode);
  }

  const response = await fetch(`${env.sarvamBaseUrl}/speech-to-text`, {
    method: "POST",
    headers: getHeaders(),
    body: form
  });

  return parseSarvamResponse(response);
}

export async function generateLeadReply({ messages }) {
  const response = await fetch(`${env.sarvamBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: getHeaders({
      "Content-Type": "application/json"
    }),
    body: JSON.stringify({
      model: env.chatModel,
      temperature: 0.2,
      messages
    })
  });

  const payload = await parseSarvamResponse(response);
  const assistantMessage = payload?.choices?.[0]?.message?.content;

  if (!assistantMessage) {
    throw createHttpError(502, "Sarvam chat response did not include assistant content.", payload);
  }

  return {
    raw: payload,
    text: assistantMessage.trim()
  };
}

export async function synthesizeSpeech({ text, languageCode, speaker }) {
  const response = await fetch(`${env.sarvamBaseUrl}/text-to-speech`, {
    method: "POST",
    headers: getHeaders({
      "Content-Type": "application/json"
    }),
    body: JSON.stringify({
      text,
      target_language_code: languageCode || env.defaultLanguageCode,
      speaker: (speaker || env.defaultSpeaker).toLowerCase(),
      model: env.ttsModel,
      speech_sample_rate: env.ttsSampleRate,
      pace: env.ttsPace
    })
  });

  const payload = await parseSarvamResponse(response);
  const audioBase64 = payload?.audios?.[0];

  if (!audioBase64) {
    throw createHttpError(502, "Sarvam TTS response did not include audio.", payload);
  }

  return {
    raw: payload,
    audioBase64
  };
}
