# Sarvam Voice Agent Backend

Node.js backend for a multilingual lead qualification voice assistant using Sarvam AI.

## What it does

- Accepts recorded audio from a client
- Transcribes speech with Sarvam Speech-to-Text
- Generates the assistant reply with Sarvam Chat Completions
- Converts the reply back to audio with Sarvam Text-to-Speech
- Keeps lightweight in-memory session history for lead qualification

## Endpoints

- `GET /health`
- `GET /`
- `POST /api/voice/transcribe`
- `POST /api/voice/speak`
- `POST /api/voice/respond`
- `GET /api/voice/session/:sessionId`
- `DELETE /api/voice/session/:sessionId`

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Add your Sarvam API key to `.env`:

```env
SARVAM_API_KEY=your_real_key
```

Then open the browser demo:

```text
http://localhost:3000
```

The demo page:

- asks for microphone access
- records browser audio
- posts it to `POST /api/voice/respond`
- shows transcript and lead qualification JSON
- plays the Sarvam AI voice reply in the browser

## Request examples

### 1. Full voice roundtrip

`POST /api/voice/respond` as `multipart/form-data`

Fields:

- `audio`: audio file
- `sessionId`: optional string
- `languageCode`: optional BCP-47 code like `hi-IN`
- `speaker`: optional lowercase Sarvam speaker like `shubh`

Response shape:

```json
{
  "success": true,
  "data": {
    "sessionId": "lead-session-1",
    "userTranscript": "I am looking for CRM automation for my sales team",
    "detectedLanguageCode": "en-IN",
    "assistantText": "Thanks. How many sales reps will use it?",
    "assistantAudioBase64": "UklGR...",
    "assistantAudioMimeType": "audio/wav",
    "leadProfile": {
      "name": null,
      "company": null,
      "budget": null
    },
    "qualification": {
      "status": "discovery",
      "score": 20,
      "missingFields": [
        "name",
        "company",
        "useCase",
        "budget",
        "timeline"
      ]
    }
  }
}
```

### 2. Text to speech only

`POST /api/voice/speak`

```json
{
  "text": "Namaste, aapka swagat hai.",
  "languageCode": "hi-IN",
  "speaker": "shubh"
}
```

## Frontend example flow

The browser demo is served from:

- [`/Users/rb18/Documents/New project/public/index.html`](/Users/rb18/Documents/New%20project/public/index.html)
- [`/Users/rb18/Documents/New project/public/app.js`](/Users/rb18/Documents/New%20project/public/app.js)
- [`/Users/rb18/Documents/New project/public/styles.css`](/Users/rb18/Documents/New%20project/public/styles.css)

If you open `http://localhost:3000`, you can:

1. Click `Start Recording`
2. Speak into the microphone
3. Click `Stop & Send`
4. Hear the AI reply voice and inspect transcript/lead data

## Notes

- Session state is stored in memory for now.
- MongoDB and AWS can be added later without changing the API contract much.
- Sarvam speaker names are lowercase.
- This project expects Node.js 20+ for native `fetch`, `FormData`, and `File`.
