import dotenv from "dotenv";

// ---------------------------------------------------------------------------
// Environment loading strategy
// ---------------------------------------------------------------------------
// On Vercel (and any other cloud platform), environment variables are injected
// directly into process.env by the platform — no .env file is involved.
// We only load the local .env file when running in development so that secrets
// never need to be committed to the repository.
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV !== "production") {
  dotenv.config();
  console.log("[env] Loaded variables from local .env file (development mode)");
} else {
  console.log("[env] Running in production — using platform-injected environment variables");
}

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
    if (env.nodeEnv === "production") {
      // In production (Vercel), this is a hard failure — the key must be set
      // in Vercel's Environment Variables dashboard.
      throw new Error(
        "SARVAM_API_KEY is not set. " +
        "Add it in the Vercel dashboard under Settings → Environment Variables."
      );
    } else {
      // In local development, just warn so the dev server still starts.
      console.warn(
        "[env] WARNING: SARVAM_API_KEY is not set. " +
        "Voice API routes will not work until you add it to your .env file."
      );
    }
  }
}
