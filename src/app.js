import cors from "cors";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import voiceRoutes from "./routes/voice.routes.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../public");

app.use(
  cors({
    origin: true,
    credentials: true
  })
);
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));

app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Voice assistant backend is running",
    env: {
      NODE_ENV: process.env.NODE_ENV || "(not set)",
      SARVAM_API_KEY: process.env.SARVAM_API_KEY ? "✅ set" : "❌ MISSING",
      PORT: process.env.PORT || "(not set — using default 3000)"
    }
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use("/api/voice", voiceRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
