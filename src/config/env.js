import dotenv from "dotenv";

// dotenv.config() is safe to call unconditionally:
// - Locally: loads secrets from your .env file
// - On Vercel: .env doesn't exist, so this is a silent no-op.
//   Vercel injects environment variables directly into process.env
//   before the Node process starts, so they are already available.
dotenv.config();

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  sarvamApiKey: process.env.SARVAM_API_KEY || "",
  sarvamBaseUrl: process.env.SARVAM_BASE_URL || "https://api.sarvam.ai",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiBaseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
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
  const sarvamConfigured = Boolean(env.sarvamApiKey);
  const geminiConfigured = Boolean(env.geminiApiKey);

  console.log(
    `[env] NODE_ENV=${env.nodeEnv} | SARVAM_API_KEY=${sarvamConfigured ? "SET" : "MISSING"} | GEMINI_API_KEY=${geminiConfigured ? "SET" : "MISSING"}`
  );

  if (!sarvamConfigured) {
    if (env.nodeEnv === "production") {
      throw new Error(
        "SARVAM_API_KEY is not set. " +
          "Add it in the Vercel dashboard: Settings -> Environment Variables -> SARVAM_API_KEY"
      );
    }

    console.warn("[env] SARVAM_API_KEY missing - add it to your local .env file.");
  }

  if (!geminiConfigured) {
    console.warn("[env] GEMINI_API_KEY missing - Lead Sathi will fall back to Sarvam chat for intelligence.");
  }
}
