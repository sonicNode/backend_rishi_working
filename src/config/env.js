import dotenv from "dotenv";

dotenv.config();

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  sarvamApiKey: process.env.SARVAM_API_KEY || "",
  sarvamBaseUrl: process.env.SARVAM_BASE_URL || "https://api.sarvam.ai",
  sttModel: process.env.SARVAM_STT_MODEL || "saaras:v3",
  sttMode: process.env.SARVAM_STT_MODE || "transcribe",
  chatModel: process.env.SARVAM_CHAT_MODEL || "sarvam-m",
  ttsModel: process.env.SARVAM_TTS_MODEL || "bulbul:v3",
  defaultLanguageCode: process.env.SARVAM_DEFAULT_LANGUAGE_CODE || "en-IN",
  defaultSpeaker: process.env.SARVAM_DEFAULT_SPEAKER || "shubh",
  ttsSampleRate: Number(process.env.SARVAM_TTS_SAMPLE_RATE || 24000),
  ttsPace: Number(process.env.SARVAM_TTS_PACE || 1)
};

export function assertRequiredEnv() {
  if (!env.sarvamApiKey) {
    // Keep startup friendly for scaffolding; real calls will fail with a clear message.
    console.warn("SARVAM_API_KEY is not set. Voice API routes will not work until you add it.");
  }
}
