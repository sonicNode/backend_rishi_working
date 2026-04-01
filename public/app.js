const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const statusBadge = document.querySelector("#statusBadge");
const messageList = document.querySelector("#messageList");
const leadProfileView = document.querySelector("#leadProfile");
const qualificationView = document.querySelector("#qualification");
const leadScoreValue = document.querySelector("#leadScoreValue");
const leadLabelBadge = document.querySelector("#leadLabelBadge");
const leadSummary = document.querySelector("#leadSummary");
const leadNextQuestion = document.querySelector("#leadNextQuestion");
const bantBoard = document.querySelector("#bantBoard");
const sessionIdInput = document.querySelector("#sessionId");
const languageSelect = document.querySelector("#languageCode");
const speakerInput = document.querySelector("#speaker");
const userPlayback = document.querySelector("#userPlayback");
const assistantPlayback = document.querySelector("#assistantPlayback");
const messageTemplate = document.querySelector("#messageTemplate");
const BANT_FIELDS = [
  { key: "budget", label: "Budget" },
  { key: "authority", label: "Authority" },
  { key: "need", label: "Need" },
  { key: "timeline", label: "Timeline" }
];
const DEFAULT_BANT = {
  budget: null,
  authority: null,
  need: null,
  timeline: null
};

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let bantState = { ...DEFAULT_BANT };

sessionIdInput.value = `lead-session-${Date.now()}`;
renderLeadScore({
  score: 0,
  label: "Cold \u2744\uFE0F",
  summary: "We'll update this as the conversation moves through BANT.",
  nextQuestion: "What budget range have you set aside for this?"
});
renderBantBoard();

startButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);

async function startRecording() {
  resetStatus("Requesting microphone...", "processing");

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    const mimeType = getSupportedMimeType();
    mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener("stop", handleRecordingStop);
    mediaRecorder.start();

    startButton.disabled = true;
    stopButton.disabled = false;
    resetStatus("Recording...", "recording");
  } catch (error) {
    console.error(error);
    resetStatus("Microphone access failed", "idle");
    appendMessage("system", `Could not start recording: ${error.message}`);
  }
}

function stopRecording() {
  if (!mediaRecorder) {
    return;
  }

  stopButton.disabled = true;
  resetStatus("Uploading audio...", "processing");
  mediaRecorder.stop();

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }
}

async function handleRecordingStop() {
  const mimeType = mediaRecorder.mimeType || "audio/webm";
  const extension = mimeType.includes("ogg") ? "ogg" : "webm";
  const audioBlob = new Blob(audioChunks, { type: mimeType });

  previewAudio(userPlayback, audioBlob);

  const formData = new FormData();
  formData.append("audio", audioBlob, `recording.${extension}`);
  formData.append("sessionId", sessionIdInput.value.trim());
  formData.append("languageCode", languageSelect.value);
  formData.append("speaker", speakerInput.value.trim() || "shubh");

  try {
    const response = await fetch("/api/voice/respond", {
      method: "POST",
      body: formData
    });

    const payload = await response.json();

    if (!response.ok || !payload.success) {
      throw new Error(payload.error || "Voice request failed.");
    }

    renderRoundtrip(payload.data);
    resetStatus("Reply ready", "ready");
  } catch (error) {
    console.error(error);
    appendMessage("system", `Backend request failed: ${error.message}`);
    resetStatus("Request failed", "idle");
  } finally {
    startButton.disabled = false;
    stopButton.disabled = true;
    mediaRecorder = null;
    mediaStream = null;
    audioChunks = [];
  }
}

function renderRoundtrip(data) {
  const finalAnswer = data.final_answer || data.assistantText || "";
  const thinking = data.thinking || "";
  const score = Number.isFinite(data.score) ? data.score : data.qualification?.scoreOutOf10 || 0;
  const label = data.label || data.qualification?.label || "Cold \u2744\uFE0F";
  const summary = data.summary || data.qualification?.summary || "We'll keep updating the lead score as details come in.";
  const nextQuestion = data.next_question || data.qualification?.nextQuestion || "";

  bantState = {
    ...DEFAULT_BANT,
    ...(data.bant || data.qualification?.bant || {})
  };

  appendMessage("you", data.userTranscript);
  appendMessage("assistant", finalAnswer, { thinking });

  renderLeadScore({
    score,
    label,
    summary,
    nextQuestion
  });
  renderBantBoard();

  leadProfileView.textContent = JSON.stringify(data.leadProfile, null, 2);
  qualificationView.textContent = JSON.stringify(
    {
      ...data.qualification,
      nextQuestion
    },
    null,
    2
  );

  const audioBytes = base64ToUint8Array(data.assistantAudioBase64);
  const assistantBlob = new Blob([audioBytes], {
    type: data.assistantAudioMimeType || "audio/wav"
  });

  previewAudio(assistantPlayback, assistantBlob);
  assistantPlayback.play().catch(() => {
    appendMessage("system", "Assistant audio is ready. Press play if the browser blocks autoplay.");
  });
}

function appendMessage(role, text, options = {}) {
  const fragment = messageTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".message-card");
  const roleElement = fragment.querySelector(".message-role");
  const textElement = fragment.querySelector(".message-text");
  const thinkingElement = fragment.querySelector(".message-thinking");

  card.classList.add(`role-${role}`);
  roleElement.textContent = role;
  textElement.textContent = text;

  if (options.thinking) {
    thinkingElement.textContent = options.thinking;
    thinkingElement.classList.remove("hidden");
  }

  messageList.prepend(fragment);
}

function renderLeadScore({ score, label, summary, nextQuestion }) {
  leadScoreValue.textContent = `${score}/10`;
  leadLabelBadge.textContent = label;
  leadLabelBadge.className = `lead-label ${getLeadLabelVariant(label)}`;
  leadSummary.textContent = summary;
  leadNextQuestion.textContent = nextQuestion
    ? `Next question: ${nextQuestion}`
    : "Next question: BANT is covered, so the lead is ready for a follow-up.";
}

function renderBantBoard() {
  bantBoard.replaceChildren();

  BANT_FIELDS.forEach(({ key, label }) => {
    const item = document.createElement("article");
    const fieldLabel = document.createElement("span");
    const fieldValue = document.createElement("strong");
    const value = bantState[key];

    item.className = `bant-item ${value ? "filled" : "pending"}`;
    fieldLabel.className = "bant-label";
    fieldLabel.textContent = label;
    fieldValue.className = "bant-value";
    fieldValue.textContent = value ? formatBantValue(value) : "Pending";

    item.append(fieldLabel, fieldValue);
    bantBoard.append(item);
  });
}

function previewAudio(element, blob) {
  element.src = URL.createObjectURL(blob);
  element.classList.remove("hidden");
}

function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);

  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }

  return bytes;
}

function getSupportedMimeType() {
  const mimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return mimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

function resetStatus(label, variant) {
  statusBadge.textContent = label;
  statusBadge.className = `status-badge ${variant}`;
}

function getLeadLabelVariant(label) {
  const normalized = label.toLowerCase();

  if (normalized.includes("hot")) {
    return "hot";
  }

  if (normalized.includes("warm")) {
    return "warm";
  }

  return "cold";
}

function formatBantValue(value) {
  return value
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
