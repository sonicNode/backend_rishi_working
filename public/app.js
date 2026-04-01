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
const WELCOME_VARIATIONS = [
  "Welcome to Lead Sathi. Namaste! Let's understand your requirements and see how we can help you better.",
  "Namaste! Welcome to Lead Sathi. Let's get started.",
  "Hello ji! Welcome to Lead Sathi. I'll help qualify your needs."
];
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
const REALTIME_CONFIG = {
  recorderTimesliceMs: 250,
  silenceMs: 850,
  minSpeechMs: 320,
  vadThreshold: 0.025,
  partialDebounceMs: 140,
  autoListenDelayMs: 260,
  websocketTimeoutMs: 1800
};

let mediaRecorder = null;
let mediaStream = null;
let audioContext = null;
let analyserNode = null;
let analyserData = null;
let realtimeSocket = null;
let realtimeConnectPromise = null;
let realtimeAvailable = typeof window.WebSocket !== "undefined";
let speechRecognition = null;
let speechRecognitionActive = false;
let liveUserMessage = null;
let vadFrameId = 0;
let autoListenTimer = 0;
let shouldReleasePipeline = false;
let pendingAutoStartAfterSpeech = false;
let pendingAssistantAudio = null;
let bantState = { ...DEFAULT_BANT };
let activeTurn = null;
let callModeEnabled = false;
let isListening = false;
let isProcessing = false;
let isAssistantSpeaking = false;
let isFinalizingTurn = false;
let lastPartialSent = "";
let lastPartialSentAt = 0;

sessionIdInput.value = `lead-session-${Date.now()}`;
startButton.setAttribute("aria-label", "Start live call");
renderLeadScore({
  score: 0,
  label: "Cold \u2744\uFE0F",
  summary: "Share the requirement and Lead Sathi will qualify the lead live.",
  nextQuestion: "What are you looking to solve right now?"
});
renderBantBoard();
updateActionButtons();
initializeWelcomeExperience();

startButton.addEventListener("click", () => {
  void beginLiveConversation({ autoAttempt: false });
});
stopButton.addEventListener("click", () => {
  void handleStopAction();
});
assistantPlayback.addEventListener("play", handleAssistantPlaybackStart);
assistantPlayback.addEventListener("ended", handleAssistantPlaybackEnd);
assistantPlayback.addEventListener("pause", handleAssistantPlaybackPause);
document.addEventListener("pointerdown", consumePendingAssistantAudio, { passive: true });
document.addEventListener("keydown", consumePendingAssistantAudio);
languageSelect.addEventListener("change", handleConfigChange);
speakerInput.addEventListener("change", handleConfigChange);
sessionIdInput.addEventListener("change", handleConfigChange);
window.addEventListener("beforeunload", teardownRealtimeExperience);

async function beginLiveConversation({ autoAttempt }) {
  if (callModeEnabled && (isListening || isProcessing || isAssistantSpeaking)) {
    return;
  }

  try {
    callModeEnabled = true;
    resetStatus("Connecting...", "connecting");
    updateActionButtons();
    await startListeningTurn();
  } catch (error) {
    console.error(error);
    callModeEnabled = false;
    updateActionButtons();

    if (autoAttempt) {
      resetStatus("Tap Mic to start live mode", "idle");
      return;
    }

    appendMessage("system", `Could not start live mode: ${error.message}`);
    resetStatus("Microphone access failed", "idle");
  }
}

async function startListeningTurn() {
  if (!callModeEnabled || isListening || isProcessing || isAssistantSpeaking) {
    return;
  }

  window.clearTimeout(autoListenTimer);
  await ensureRealtimeReady();

  if (assistantPlayback && !assistantPlayback.paused) {
    assistantPlayback.pause();
  }

  if (audioContext?.state === "suspended") {
    await audioContext.resume().catch(() => {});
  }

  const mimeType = mediaRecorder?.mimeType || getSupportedMimeType() || "audio/webm";
  activeTurn = createTurnState(mimeType);
  activeTurn.streamOverSocket = isRealtimeSocketOpen();
  lastPartialSent = "";
  lastPartialSentAt = 0;

  if (activeTurn.streamOverSocket) {
    sendRealtimeMessage({
      type: "listen_start",
      mimeType,
      filename: getFilenameForMimeType(mimeType)
    });
  }

  mediaRecorder.start(REALTIME_CONFIG.recorderTimesliceMs);
  isListening = true;
  isProcessing = false;
  isFinalizingTurn = false;
  resetStatus("Listening...", "recording");
  updateActionButtons();
  startVoiceActivityMonitor();
  startSpeechRecognition();
}

async function handleStopAction() {
  if (isListening) {
    await finishListeningTurn("manual");
    return;
  }

  stopLiveConversation();
}

function stopLiveConversation() {
  callModeEnabled = false;
  pendingAutoStartAfterSpeech = false;
  window.clearTimeout(autoListenTimer);
  sendRealtimeMessage({ type: "listen_abort" });

  if (assistantPlayback && !assistantPlayback.paused) {
    assistantPlayback.pause();
  }

  if (activeTurn && mediaRecorder?.state === "recording") {
    activeTurn.shouldProcess = false;
    shouldReleasePipeline = true;
    mediaRecorder.stop();
  } else {
    activeTurn = null;
    releaseVoicePipeline();
  }

  isListening = false;
  isProcessing = false;
  isFinalizingTurn = false;
  removeLiveUserMessage();
  resetStatus("Idle", "idle");
  updateActionButtons();
}

async function ensureRealtimeReady() {
  await Promise.all([ensureMediaPipeline(), ensureRealtimeSocket()]);
  ensureSpeechRecognition();
  syncRealtimeConfig();
}

async function ensureMediaPipeline() {
  if (mediaStream?.active && mediaRecorder) {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support microphone access.");
  }

  if (typeof MediaRecorder === "undefined") {
    throw new Error("This browser does not support live audio recording.");
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  if (AudioContextClass) {
    audioContext = new AudioContextClass();
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);

    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.82;
    analyserData = new Uint8Array(analyserNode.fftSize);
    sourceNode.connect(analyserNode);
  }

  const mimeType = getSupportedMimeType();

  mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
  mediaRecorder.addEventListener("dataavailable", handleRecorderData);
  mediaRecorder.addEventListener("stop", handleRecorderStop);
}

function ensureSpeechRecognition() {
  if (speechRecognition || !(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    return;
  }

  const RecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;

  speechRecognition = new RecognitionClass();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  speechRecognition.maxAlternatives = 1;
  speechRecognition.addEventListener("result", handleRecognitionResult);
  speechRecognition.addEventListener("end", handleRecognitionEnd);
  speechRecognition.addEventListener("error", handleRecognitionError);
}

async function ensureRealtimeSocket() {
  if (!realtimeAvailable) {
    return false;
  }

  if (isRealtimeSocketOpen()) {
    return true;
  }

  if (realtimeConnectPromise) {
    return realtimeConnectPromise;
  }

  realtimeConnectPromise = new Promise((resolve) => {
    let settled = false;
    let opened = false;
    const socket = new WebSocket(getRealtimeUrl());
    const timeoutId = window.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      realtimeAvailable = false;
      realtimeConnectPromise = null;
      realtimeSocket = null;
      socket.close();
      resolve(false);
    }, REALTIME_CONFIG.websocketTimeoutMs);

    socket.addEventListener("open", () => {
      opened = true;
      settled = true;
      window.clearTimeout(timeoutId);
      realtimeSocket = socket;
      realtimeConnectPromise = null;
      attachRealtimeListeners(socket);
      syncRealtimeConfig();
      resolve(true);
    }, { once: true });

    socket.addEventListener("error", () => {
      if (opened || settled) {
        return;
      }

      settled = true;
      realtimeAvailable = false;
      window.clearTimeout(timeoutId);
      realtimeConnectPromise = null;
      realtimeSocket = null;
      resolve(false);
    }, { once: true });

    socket.addEventListener("close", () => {
      if (realtimeSocket === socket) {
        realtimeSocket = null;
      }

      if (!opened && !settled) {
        settled = true;
        realtimeAvailable = false;
        window.clearTimeout(timeoutId);
        realtimeConnectPromise = null;
        resolve(false);
      }
    });
  });

  return realtimeConnectPromise;
}

function attachRealtimeListeners(socket) {
  socket.addEventListener("message", handleRealtimeMessage);
  socket.addEventListener("close", () => {
    if (realtimeSocket === socket) {
      realtimeSocket = null;
    }

    if (activeTurn) {
      activeTurn.streamOverSocket = false;
    }
  });
}

function handleRealtimeMessage(event) {
  const message = JSON.parse(event.data);

  switch (message.type) {
    case "ready":
    case "config_ack":
      break;
    case "state":
      handleRealtimeState(message.state);
      break;
    case "partial_transcript":
      if (message.transcript) {
        upsertLiveUserMessage(message.transcript);
      }
      break;
    case "final_transcript":
      finalizeLiveUserMessage(message.transcript);
      break;
    case "assistant_reply":
      isProcessing = false;
      isFinalizingTurn = false;
      renderRoundtrip(message.data, {
        autoplayAssistant: callModeEnabled
      });
      break;
    case "error":
      handleTurnError(message.message || "Realtime processing failed.");
      break;
    default:
      break;
  }
}

function handleRealtimeState(state) {
  if (state === "listening" && isListening) {
    resetStatus("Listening...", "recording");
    return;
  }

  if (state === "thinking" && isProcessing) {
    resetStatus("Thinking...", "processing");
    return;
  }

  if (state === "idle" && !isListening && !isProcessing && !isAssistantSpeaking) {
    resetStatus("Idle", "idle");
  }
}

function handleRecorderData(event) {
  if (!activeTurn || event.data.size === 0) {
    return;
  }

  activeTurn.audioChunks.push(event.data);

  if (!activeTurn.streamOverSocket || !isRealtimeSocketOpen()) {
    activeTurn.streamOverSocket = false;
    return;
  }

  try {
    realtimeSocket.send(event.data);
  } catch (error) {
    console.error(error);
    activeTurn.streamOverSocket = false;
  }
}

function handleRecorderStop() {
  stopVoiceActivityMonitor();
  stopSpeechRecognition();

  const completedTurn = activeTurn;

  activeTurn = null;
  isListening = false;

  if (shouldReleasePipeline) {
    releaseVoicePipeline();
  }

  if (!completedTurn || !completedTurn.shouldProcess) {
    isProcessing = false;
    isFinalizingTurn = false;
    updateActionButtons();
    return;
  }

  void processCompletedTurn(completedTurn);
}

async function finishListeningTurn(reason) {
  if (!activeTurn || isFinalizingTurn) {
    return;
  }

  const hasTranscriptHint = !!activeTurn.partialTranscript.trim();

  if (!activeTurn.hasSpoken && !hasTranscriptHint) {
    return;
  }

  isFinalizingTurn = true;
  isListening = false;
  isProcessing = true;
  activeTurn.shouldProcess = true;
  activeTurn.stopReason = reason;
  publishPartialTranscript(activeTurn.partialTranscript, { final: true, force: true });
  resetStatus("Thinking...", "processing");
  updateActionButtons();
  stopVoiceActivityMonitor();
  stopSpeechRecognition();

  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    return;
  }

  const completedTurn = activeTurn;

  activeTurn = null;
  await processCompletedTurn(completedTurn);
}

async function processCompletedTurn(turn) {
  const audioBlob = new Blob(turn.audioChunks, { type: turn.mimeType });

  if (audioBlob.size > 0) {
    previewAudio(userPlayback, audioBlob);
  }

  if (!turn.hasSpoken && !turn.partialTranscript.trim() && audioBlob.size === 0) {
    isProcessing = false;
    isFinalizingTurn = false;
    updateActionButtons();

    if (callModeEnabled) {
      scheduleNextListeningTurn();
    }

    return;
  }

  if (turn.streamOverSocket && sendRealtimeMessage({ type: "speech_end" })) {
    resetStatus("Thinking...", "processing");
    updateActionButtons();
    return;
  }

  try {
    const formData = new FormData();

    formData.append("audio", audioBlob, getFilenameForMimeType(turn.mimeType));
    formData.append("sessionId", sessionIdInput.value.trim());
    formData.append("languageCode", languageSelect.value);
    formData.append("speaker", speakerInput.value.trim() || "shubh");
    formData.append("fallbackTranscript", turn.partialTranscript.trim());

    const response = await fetch("/api/voice/respond", {
      method: "POST",
      body: formData
    });
    const payload = await response.json();

    if (!response.ok || !payload.success) {
      throw new Error(payload.error || "Voice request failed.");
    }

    isProcessing = false;
    isFinalizingTurn = false;
    renderRoundtrip(payload.data, {
      autoplayAssistant: callModeEnabled
    });
  } catch (error) {
    handleTurnError(`Backend request failed: ${error.message}`);
  }
}

function handleRecognitionResult(event) {
  if (!activeTurn) {
    return;
  }

  const finalSegments = [];
  const interimSegments = [];

  for (let index = 0; index < event.results.length; index += 1) {
    const transcript = event.results[index][0]?.transcript?.trim();

    if (!transcript) {
      continue;
    }

    if (event.results[index].isFinal) {
      finalSegments.push(transcript);
    } else {
      interimSegments.push(transcript);
    }
  }

  const combinedTranscript = [...finalSegments, ...interimSegments]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!combinedTranscript) {
    return;
  }

  activeTurn.partialTranscript = combinedTranscript;
  publishPartialTranscript(combinedTranscript, {
    final: interimSegments.length === 0
  });
}

function handleRecognitionEnd() {
  speechRecognitionActive = false;

  if (!callModeEnabled || !isListening || isFinalizingTurn) {
    return;
  }

  window.setTimeout(() => {
    startSpeechRecognition();
  }, 140);
}

function handleRecognitionError(error) {
  if (error.error === "not-allowed" || error.error === "service-not-allowed") {
    console.warn("Speech recognition permission was denied.");
    return;
  }

  console.warn("Speech recognition error:", error.error);
}

function startSpeechRecognition() {
  if (!speechRecognition || speechRecognitionActive || !callModeEnabled || !isListening) {
    return;
  }

  speechRecognition.lang = languageSelect.value;

  try {
    speechRecognition.start();
    speechRecognitionActive = true;
  } catch (error) {
    if (!/already started/i.test(error.message)) {
      console.warn(error);
    }
  }
}

function stopSpeechRecognition() {
  if (!speechRecognition || !speechRecognitionActive) {
    return;
  }

  speechRecognitionActive = false;

  try {
    speechRecognition.stop();
  } catch (error) {
    console.warn(error);
  }
}

function startVoiceActivityMonitor() {
  if (!analyserNode || !analyserData || !activeTurn) {
    return;
  }

  stopVoiceActivityMonitor();

  const tick = () => {
    if (!analyserNode || !analyserData || !activeTurn || !isListening) {
      return;
    }

    analyserNode.getByteTimeDomainData(analyserData);

    const level = getAudioLevel(analyserData);
    const now = Date.now();

    if (level > REALTIME_CONFIG.vadThreshold) {
      if (!activeTurn.voiceStartedAt) {
        activeTurn.voiceStartedAt = now;
      }

      activeTurn.lastSpeechAt = now;

      if (now - activeTurn.voiceStartedAt >= REALTIME_CONFIG.minSpeechMs) {
        activeTurn.hasSpoken = true;
      }
    } else if (
      !activeTurn.hasSpoken &&
      activeTurn.voiceStartedAt &&
      activeTurn.lastSpeechAt &&
      now - activeTurn.lastSpeechAt > 180
    ) {
      activeTurn.voiceStartedAt = 0;
      activeTurn.lastSpeechAt = 0;
    }

    if (
      activeTurn.hasSpoken &&
      activeTurn.lastSpeechAt &&
      now - activeTurn.lastSpeechAt >= REALTIME_CONFIG.silenceMs
    ) {
      void finishListeningTurn("silence");
      return;
    }

    vadFrameId = window.requestAnimationFrame(tick);
  };

  vadFrameId = window.requestAnimationFrame(tick);
}

function stopVoiceActivityMonitor() {
  if (!vadFrameId) {
    return;
  }

  window.cancelAnimationFrame(vadFrameId);
  vadFrameId = 0;
}

function renderRoundtrip(data, options = {}) {
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

  finalizeLiveUserMessage(data.userTranscript);
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

  if (data.assistantAudioBase64) {
    const audioBytes = base64ToUint8Array(data.assistantAudioBase64);
    const assistantBlob = new Blob([audioBytes], {
      type: data.assistantAudioMimeType || "audio/wav"
    });

    queueAssistantAudio(
      assistantBlob,
      "Assistant audio is ready. Tap anywhere to continue if the browser blocks autoplay.",
      {
        autoplay: options.autoplayAssistant !== false
      }
    );
  } else if (callModeEnabled) {
    scheduleNextListeningTurn();
  }
}

function appendMessage(role, text, options = {}) {
  const card = createMessageElement(role, text, options);

  messageList.append(card);
  scrollConversationToLatest(card);
  return card;
}

function createMessageElement(role, text, options = {}) {
  const fragment = messageTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".message-card");

  updateMessageElement(card, role, text, options);
  return card;
}

function updateMessageElement(card, role, text, options = {}) {
  const roleElement = card.querySelector(".message-role");
  const textElement = card.querySelector(".message-text");
  const thinkingElement = card.querySelector(".message-thinking");

  card.className = "message-card";
  card.classList.add(`role-${role}`);

  if (options.live) {
    card.classList.add("is-live");
  }

  roleElement.textContent = getRoleLabel(role, options.live);
  textElement.textContent = text;

  if (options.thinking) {
    thinkingElement.textContent = options.thinking;
    thinkingElement.classList.remove("hidden");
  } else {
    thinkingElement.textContent = "";
    thinkingElement.classList.add("hidden");
  }
}

function upsertLiveUserMessage(text) {
  const normalizedText = (text || "").trim();

  if (!normalizedText) {
    return;
  }

  if (!liveUserMessage) {
    liveUserMessage = createMessageElement("you", normalizedText, { live: true });
    messageList.append(liveUserMessage);
  } else {
    updateMessageElement(liveUserMessage, "you", normalizedText, { live: true });
  }

  scrollConversationToLatest(liveUserMessage);
}

function finalizeLiveUserMessage(text) {
  const normalizedText = (text || "").trim();

  if (liveUserMessage) {
    if (!normalizedText) {
      liveUserMessage.remove();
    } else {
      updateMessageElement(liveUserMessage, "you", normalizedText);
    }

    scrollConversationToLatest(liveUserMessage);
    liveUserMessage = null;
    return;
  }

  if (normalizedText) {
    appendMessage("you", normalizedText);
  }
}

function removeLiveUserMessage() {
  if (!liveUserMessage) {
    return;
  }

  liveUserMessage.remove();
  liveUserMessage = null;
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

function initializeWelcomeExperience() {
  const welcomeMessage = getWelcomeMessage();

  appendMessage("assistant", welcomeMessage);
  playAssistantText(welcomeMessage, { startCallAfterPlayback: true }).catch((error) => {
    console.error(error);
    window.setTimeout(() => {
      void beginLiveConversation({ autoAttempt: true });
    }, 420);
  });
}

async function playAssistantText(text, options = {}) {
  const response = await fetch("/api/voice/speak", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      languageCode: languageSelect.value,
      speaker: speakerInput.value.trim() || "shubh"
    })
  });
  const payload = await response.json();

  if (!response.ok || !payload.success) {
    throw new Error(payload.error || "Could not generate speech.");
  }

  const audioBytes = base64ToUint8Array(payload.data.audioBase64);
  const audioBlob = new Blob([audioBytes], {
    type: payload.data.audioMimeType || "audio/wav"
  });

  queueAssistantAudio(audioBlob, undefined, {
    autoplay: true,
    startCallAfterPlayback: options.startCallAfterPlayback
  });
}

function queueAssistantAudio(blob, fallbackMessage, options = {}) {
  const {
    autoplay = true,
    startCallAfterPlayback = false
  } = options;

  previewAudio(assistantPlayback, blob);

  if (startCallAfterPlayback) {
    pendingAutoStartAfterSpeech = true;
  }

  if (!autoplay) {
    resetStatus("Reply ready", "ready");
    updateActionButtons();
    return;
  }

  assistantPlayback.play().catch(() => {
    pendingAssistantAudio = {
      blob,
      fallbackMessage
    };

    if (fallbackMessage) {
      appendMessage("system", fallbackMessage);
    }

    resetStatus("Reply ready", "ready");
    updateActionButtons();
  });
}

function consumePendingAssistantAudio(event) {
  if (!pendingAssistantAudio) {
    return;
  }

  if (event?.target && (event.target === startButton || startButton.contains(event.target))) {
    return;
  }

  const { blob, fallbackMessage } = pendingAssistantAudio;

  pendingAssistantAudio = null;
  previewAudio(assistantPlayback, blob);
  assistantPlayback.play().catch(() => {
    pendingAssistantAudio = { blob, fallbackMessage };
  });
}

function handleAssistantPlaybackStart() {
  isAssistantSpeaking = true;
  resetStatus("Speaking...", "speaking");
  updateActionButtons();
}

function handleAssistantPlaybackEnd() {
  isAssistantSpeaking = false;
  updateActionButtons();

  if (pendingAutoStartAfterSpeech) {
    pendingAutoStartAfterSpeech = false;
    void beginLiveConversation({ autoAttempt: true });
    return;
  }

  if (callModeEnabled) {
    scheduleNextListeningTurn();
    return;
  }

  resetStatus("Idle", "idle");
}

function handleAssistantPlaybackPause() {
  if (assistantPlayback.ended) {
    return;
  }

  isAssistantSpeaking = false;
  updateActionButtons();

  if (!callModeEnabled && !isProcessing) {
    resetStatus("Idle", "idle");
  }
}

function scheduleNextListeningTurn() {
  window.clearTimeout(autoListenTimer);

  if (!callModeEnabled) {
    resetStatus("Idle", "idle");
    updateActionButtons();
    return;
  }

  autoListenTimer = window.setTimeout(() => {
    void startListeningTurn().catch((error) => {
      console.error(error);
      resetStatus("Tap Mic to continue", "idle");
      callModeEnabled = false;
      updateActionButtons();
    });
  }, REALTIME_CONFIG.autoListenDelayMs);
}

function publishPartialTranscript(transcript, { final = false, force = false } = {}) {
  const normalizedTranscript = (transcript || "").replace(/\s+/g, " ").trim();

  if (!normalizedTranscript) {
    return;
  }

  upsertLiveUserMessage(normalizedTranscript);

  if (!isRealtimeSocketOpen()) {
    return;
  }

  const now = Date.now();

  if (!force) {
    if (normalizedTranscript === lastPartialSent) {
      return;
    }

    if (now - lastPartialSentAt < REALTIME_CONFIG.partialDebounceMs) {
      return;
    }
  }

  sendRealtimeMessage({
    type: "partial_transcript",
    transcript: normalizedTranscript,
    final
  });

  lastPartialSent = normalizedTranscript;
  lastPartialSentAt = now;
}

function handleTurnError(message) {
  console.error(message);
  isProcessing = false;
  isFinalizingTurn = false;
  callModeEnabled = false;
  releaseVoicePipeline();
  resetStatus("Turn failed", "idle");
  updateActionButtons();
  appendMessage("system", message);
}

function handleConfigChange() {
  syncRealtimeConfig();

  if (speechRecognition) {
    speechRecognition.lang = languageSelect.value;
  }
}

function syncRealtimeConfig() {
  sendRealtimeMessage({
    type: "config",
    sessionId: sessionIdInput.value.trim(),
    languageCode: languageSelect.value,
    speaker: speakerInput.value.trim() || "shubh"
  });
}

function sendRealtimeMessage(message) {
  if (!isRealtimeSocketOpen()) {
    return false;
  }

  try {
    realtimeSocket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

function isRealtimeSocketOpen() {
  return realtimeSocket?.readyState === WebSocket.OPEN;
}

function releaseVoicePipeline() {
  shouldReleasePipeline = false;
  stopVoiceActivityMonitor();
  stopSpeechRecognition();

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  analyserNode = null;
  analyserData = null;
  mediaRecorder = null;
}

function teardownRealtimeExperience() {
  window.clearTimeout(autoListenTimer);
  stopVoiceActivityMonitor();
  stopSpeechRecognition();

  if (realtimeSocket && realtimeSocket.readyState <= WebSocket.OPEN) {
    realtimeSocket.close();
  }

  releaseVoicePipeline();
}

function previewAudio(element, blob) {
  const previousUrl = element.dataset.objectUrl;

  if (previousUrl) {
    URL.revokeObjectURL(previousUrl);
  }

  const objectUrl = URL.createObjectURL(blob);

  element.dataset.objectUrl = objectUrl;
  element.src = objectUrl;
  element.classList.remove("hidden");
}

function createTurnState(mimeType) {
  return {
    mimeType,
    audioChunks: [],
    partialTranscript: "",
    streamOverSocket: false,
    shouldProcess: false,
    stopReason: "silence",
    voiceStartedAt: 0,
    lastSpeechAt: 0,
    hasSpoken: false
  };
}

function getAudioLevel(buffer) {
  let sum = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    const normalized = (buffer[index] - 128) / 128;

    sum += normalized * normalized;
  }

  return Math.sqrt(sum / buffer.length);
}

function base64ToUint8Array(base64 = "") {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);

  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }

  return bytes;
}

function getSupportedMimeType() {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }

  const mimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return mimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

function getRealtimeUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  return `${protocol}//${window.location.host}/realtime`;
}

function getFilenameForMimeType(mimeType = "") {
  if (mimeType.includes("ogg")) {
    return "recording.ogg";
  }

  if (mimeType.includes("wav")) {
    return "recording.wav";
  }

  return "recording.webm";
}

function updateActionButtons() {
  startButton.disabled = isListening || isProcessing || isAssistantSpeaking;
  stopButton.disabled = !callModeEnabled && !isListening && !isAssistantSpeaking && !mediaStream;
  stopButton.textContent = isListening ? "Stop & Send" : "End Live Mode";
  startButton.setAttribute("aria-label", callModeEnabled ? "Resume listening" : "Start live call");
}

function scrollConversationToLatest(target) {
  if (!target) {
    return;
  }

  target.scrollIntoView({
    block: "nearest",
    behavior: "smooth"
  });
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
  if (typeof value !== "string") {
    return value ? "Confirmed" : "Pending";
  }

  return value
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getWelcomeMessage() {
  return WELCOME_VARIATIONS[Math.floor(Math.random() * WELCOME_VARIATIONS.length)];
}

function getRoleLabel(role, live) {
  if (role === "assistant") {
    return "Lead Sathi";
  }

  if (role === "system") {
    return "System";
  }

  return live ? "You live" : "You";
}
