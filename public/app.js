const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const statusBadge = document.querySelector("#statusBadge");
const statusBadgeVisible = document.querySelector("#statusBadgeVisible");
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
const voiceStage = document.querySelector("#voiceStage");
const waveformCanvas = document.querySelector("#waveformCanvas");
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
  recorderTimesliceMs: 120,
  silenceMs: 680,
  recognitionSilenceMs: 520,
  minSpeechMs: 260,
  vadThreshold: 0.045,
  bargeInThreshold: 0.075,
  bargeInMinSpeechMs: 240,
  partialDebounceMs: 40,
  autoListenDelayMs: 20,
  noiseFloorMargin: 0.035,
  waveformBars: 20,
  websocketTimeoutMs: 1800
};

let mediaRecorder = null;
let mediaStream = null;
let audioContext = null;
let analyserNode = null;
let analyserData = null;
let waveformContext = waveformCanvas?.getContext("2d") || null;
let realtimeSocket = null;
let realtimeConnectPromise = null;
let realtimeAvailable = typeof window.WebSocket !== "undefined";
let speechRecognition = null;
let speechRecognitionActive = false;
let liveUserMessage = null;
let vadFrameId = 0;
let bargeInFrameId = 0;
let bargeInSpeechStartedAt = 0;
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
let committedUserTurnText = "";
let conversationCompleted = false;
let waveformFrameId = 0;
let waveformPeaks = [];
let audioMetrics = createAudioMetrics();
let speechFinalizationTimer = 0;

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
startWaveformLoop();

startButton.addEventListener("click", () => {
  if (callModeEnabled || isListening || isProcessing || isAssistantSpeaking) {
    stopLiveConversation();
    return;
  }

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
window.addEventListener("resize", syncWaveformCanvasSize);
window.addEventListener("beforeunload", teardownRealtimeExperience);

async function beginLiveConversation({ autoAttempt }) {
  if (callModeEnabled && (isListening || isProcessing || isAssistantSpeaking)) {
    return;
  }

  try {
    conversationCompleted = false;
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
  clearSpeechFinalizationTimer();
  stopBargeInMonitor();
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
  committedUserTurnText = "";
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
  conversationCompleted = false;
  callModeEnabled = false;
  pendingAutoStartAfterSpeech = false;
  window.clearTimeout(autoListenTimer);
  clearSpeechFinalizationTimer();
  stopBargeInMonitor();
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
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.78;
    analyserData = new Uint8Array(analyserNode.frequencyBinCount);
    sourceNode.connect(analyserNode);
    audioMetrics = createAudioMetrics();
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

  if (completedTurn?.audioChunks?.length) {
    previewAudio(userPlayback, new Blob(completedTurn.audioChunks, { type: completedTurn.mimeType }));
  }

  if (shouldReleasePipeline) {
    releaseVoicePipeline();
  }

  if (!completedTurn || !completedTurn.shouldProcess) {
    if (!completedTurn?.realtimeProcessingStarted) {
      isProcessing = false;
      isFinalizingTurn = false;
    }

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
  clearSpeechFinalizationTimer();
  isListening = false;
  isProcessing = true;
  activeTurn.shouldProcess = true;
  activeTurn.stopReason = reason;
  publishPartialTranscript(activeTurn.partialTranscript, { final: true, force: true });
  applyDeterministicLeadSignals(activeTurn.partialTranscript, { syncViews: true });

  if (activeTurn.streamOverSocket && activeTurn.partialTranscript.trim()) {
    activeTurn.realtimeProcessingStarted = sendRealtimeMessage({ type: "speech_end" });
    activeTurn.shouldProcess = !activeTurn.realtimeProcessingStarted;
  }

  resetStatus("Thinking...", "processing");
  updateActionButtons();
  stopVoiceActivityMonitor();
  stopSpeechRecognition();

  if (mediaRecorder?.state === "recording") {
    if (typeof mediaRecorder.requestData === "function") {
      try {
        mediaRecorder.requestData();
      } catch (error) {
        console.warn(error);
      }
    }

    mediaRecorder.stop();
    return;
  }

  const completedTurn = activeTurn;

  activeTurn = null;
  await processCompletedTurn(completedTurn);
}

async function processCompletedTurn(turn) {
  const audioBlob = new Blob(turn.audioChunks, { type: turn.mimeType });

  if (!turn.hasSpoken && !turn.partialTranscript.trim() && audioBlob.size === 0) {
    isProcessing = false;
    isFinalizingTurn = false;
    updateActionButtons();

    if (callModeEnabled) {
      scheduleNextListeningTurn();
    }

    return;
  }

  if (!turn.realtimeProcessingStarted && turn.streamOverSocket && sendRealtimeMessage({ type: "speech_end" })) {
    turn.realtimeProcessingStarted = true;
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

  const now = Date.now();
  activeTurn.partialTranscript = combinedTranscript;
  activeTurn.lastTranscriptAt = now;
  activeTurn.lastSpeechAt = now;
  activeTurn.hasSpoken = true;

  if (!activeTurn.voiceStartedAt) {
    activeTurn.voiceStartedAt = now - REALTIME_CONFIG.minSpeechMs;
  }

  publishPartialTranscript(combinedTranscript, {
    final: interimSegments.length === 0
  });

  if (interimSegments.length > 0) {
    clearSpeechFinalizationTimer();
    return;
  }
}

function handleRecognitionEnd() {
  speechRecognitionActive = false;

  if (!callModeEnabled || !isListening || isFinalizingTurn) {
    return;
  }

  window.setTimeout(() => {
    startSpeechRecognition();
  }, 40);
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
  if (!activeTurn) {
    return;
  }

  stopVoiceActivityMonitor();

  const tick = () => {
    if (!activeTurn || !isListening) {
      return;
    }

    const level = getSpeechActivityLevel();
    const threshold = getDynamicSpeechThreshold();
    const silenceThreshold = Math.max(audioMetrics.noiseFloor + 0.008, threshold * 0.78);
    const now = Date.now();

    if (level > threshold) {
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

    const voiceWentQuiet =
      activeTurn.hasSpoken &&
      activeTurn.lastSpeechAt &&
      now - activeTurn.lastSpeechAt >= REALTIME_CONFIG.silenceMs &&
      level <= silenceThreshold;

    const transcriptSettled =
      !activeTurn.lastTranscriptAt ||
      now - activeTurn.lastTranscriptAt >= REALTIME_CONFIG.recognitionSilenceMs;

    if (voiceWentQuiet && transcriptSettled) {
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

function startBargeInMonitor() {
  if (!callModeEnabled || !isAssistantSpeaking) {
    return;
  }

  stopBargeInMonitor();

  const tick = () => {
    if (!callModeEnabled || !isAssistantSpeaking) {
      return;
    }

    const level = getCurrentAudioLevel();
    const threshold = Math.max(REALTIME_CONFIG.bargeInThreshold, getDynamicSpeechThreshold() + 0.018);
    const now = Date.now();

    if (level > threshold) {
      if (!bargeInSpeechStartedAt) {
        bargeInSpeechStartedAt = now;
      }

      if (now - bargeInSpeechStartedAt >= REALTIME_CONFIG.bargeInMinSpeechMs) {
        interruptAssistantPlayback();
        return;
      }
    } else {
      bargeInSpeechStartedAt = 0;
    }

    bargeInFrameId = window.requestAnimationFrame(tick);
  };

  bargeInFrameId = window.requestAnimationFrame(tick);
}

function stopBargeInMonitor() {
  bargeInSpeechStartedAt = 0;

  if (!bargeInFrameId) {
    return;
  }

  window.cancelAnimationFrame(bargeInFrameId);
  bargeInFrameId = 0;
}

function interruptAssistantPlayback() {
  if (!callModeEnabled || !isAssistantSpeaking) {
    return;
  }

  pendingAutoStartAfterSpeech = false;
  pendingAssistantAudio = null;
  stopBargeInMonitor();
  isAssistantSpeaking = false;

  try {
    assistantPlayback.pause();
    assistantPlayback.currentTime = 0;
  } catch (error) {
    console.warn(error);
  }

  void startListeningTurn().catch((error) => {
    console.error(error);
    resetStatus("Tap Mic to continue", "idle");
    callModeEnabled = false;
    updateActionButtons();
  });
}

function renderRoundtrip(data, options = {}) {
  const finalAnswer = data.final_answer || data.assistantText || "";
  const thinking = data.thinking || "";
  const conversationComplete = Boolean(data.conversation_complete);
  const serverScore = Number.isFinite(data.score) ? data.score : data.qualification?.scoreOutOf10 || 0;
  const serverBant = data.bant || data.qualification?.bant || {};

  applyDeterministicLeadSignals(data.userTranscript, { syncViews: false });
  bantState = mergeBantState(bantState, serverBant);

  const score = Math.max(serverScore, calculateScore(bantState));
  const label = score > serverScore ? getLabel(score) : data.label || data.qualification?.label || getLabel(score);
  const nextQuestion = conversationComplete
    ? null
    : data.next_question || data.qualification?.nextQuestion || getNextQuestion(bantState);
  const summary = conversationComplete
    ? data.summary || data.qualification?.summary || "Lead qualification complete."
    : score > serverScore
      ? buildLeadSummary(bantState, score)
      : data.summary || data.qualification?.summary || "We'll keep updating the lead score as details come in.";

  conversationCompleted = conversationComplete;

  if (conversationComplete) {
    pendingAutoStartAfterSpeech = false;
    window.clearTimeout(autoListenTimer);
    callModeEnabled = false;
    updateActionButtons();
  }

  finalizeLiveUserMessage(data.userTranscript);
  appendMessage("assistant", finalAnswer, { thinking });
  renderLeadScore({
    score,
    label,
    summary,
    nextQuestion,
    conversationComplete
  });
  renderBantBoard();

  leadProfileView.textContent = JSON.stringify(data.leadProfile, null, 2);
  qualificationView.textContent = JSON.stringify(
    {
      ...data.qualification,
      bant: bantState,
      scoreOutOf10: score,
      label,
      summary,
      nextQuestion,
      conversationComplete
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
  } else if (callModeEnabled && !conversationComplete) {
    scheduleNextListeningTurn();
  } else if (conversationComplete) {
    resetStatus("Conversation complete", "idle");
    updateActionButtons();
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
      committedUserTurnText = normalizedText;
    }

    scrollConversationToLatest(liveUserMessage);
    liveUserMessage = null;
    return;
  }

  if (normalizedText) {
    if (committedUserTurnText === normalizedText) {
      return;
    }

    committedUserTurnText = normalizedText;
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

function renderLeadScore({ score, label, summary, nextQuestion, conversationComplete = false }) {
  leadScoreValue.textContent = `${score}/10`;
  leadLabelBadge.textContent = label;
  leadLabelBadge.className = `lead-label ${getLeadLabelVariant(label)}`;
  leadSummary.textContent = summary;
  leadNextQuestion.textContent = conversationComplete
    ? "Conversation complete. Thank you for talking with us. We'll be contacting you soon."
    : nextQuestion
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

function applyDeterministicLeadSignals(text, { syncViews = false } = {}) {
  const extractedBant = extractDeterministicBant(text);
  const mergedBant = mergeBantState(bantState, extractedBant);
  const hasChanged = hasBantChange(bantState, mergedBant);

  if (!hasChanged && !syncViews) {
    return;
  }

  bantState = mergedBant;

  const score = calculateScore(bantState);
  const label = getLabel(score);
  const nextQuestion = getNextQuestion(bantState);
  const summary = buildLeadSummary(bantState, score);

  renderLeadScore({
    score,
    label,
    summary,
    nextQuestion
  });
  renderBantBoard();

  if (syncViews) {
    qualificationView.textContent = JSON.stringify(
      {
        source: "local-deterministic",
        bant: bantState,
        scoreOutOf10: score,
        label,
        nextQuestion,
        summary
      },
      null,
      2
    );
  }
}

function extractDeterministicBant(input) {
  const text = normalizeLeadText(input);

  if (!text) {
    return {};
  }

  const nextBant = {};
  const budgetMatch = text.match(
    /(?:budget(?:\s+is|\s+of|\s*:)?\s*)?(\u20B9?\s?\d[\d,.]*\s?[kKmMlL]?|\d+\s?(?:rupees|rs|lakhs?|lakh|k|thousand))/i
  );
  const needValue = extractNeedHint(text);
  const timelineValue = extractTimelineHint(text);
  const authorityValue = extractAuthorityHint(text);

  if (budgetMatch?.[1]) {
    nextBant.budget = normalizeBantText(budgetMatch[1])
      .replace(/\brs\b\.?/i, "Rs")
      .replace(/\s{2,}/g, " ");
  }

  if (timelineValue) {
    nextBant.timeline = timelineValue;
  }

  if (needValue) {
    nextBant.need = needValue;
  } else if (/\b(i need|i want|looking for|require|we need|we want)\b/i.test(text)) {
    nextBant.need = true;
  }

  if (authorityValue) {
    nextBant.authority = authorityValue;
  }

  return nextBant;
}

function extractNeedHint(text) {
  const needPatterns = [
    /(?:i need|i want|looking for|require|looking to|we need|we want|we are looking for)\s+(.+?)(?=[.?!]|$)/i,
    /(?:need help with|need support with|solution for|tool for|platform for)\s+(.+?)(?=[.?!]|$)/i
  ];

  for (const pattern of needPatterns) {
    const match = text.match(pattern);

    if (!match?.[1]) {
      continue;
    }

    const candidate = normalizeBantText(match[1])
      .replace(/\b(?:urgently|asap|immediately|this week|next week|this month|next month)\b/gi, "")
      .replace(/\b(?:budget|price|timeline).*/i, "")
      .trim();

    if (candidate.length >= 4) {
      return candidate;
    }
  }

  return null;
}

function extractTimelineHint(text) {
  if (/\b(urgent|asap|immediately|this week)\b/i.test(text)) {
    return "urgent";
  }

  const specificMatch = text.match(/\b(today|tomorrow|next week|this month|next month)\b/i);

  if (specificMatch?.[1]) {
    return specificMatch[1].toLowerCase();
  }

  if (/\b(month|later|next month|next quarter|whenever|flexible)\b/i.test(text)) {
    return "flexible";
  }

  return null;
}

function extractAuthorityHint(text) {
  if (
    /\b(i am (?:the )?decision maker|i'm (?:the )?decision maker|i decide|i can decide|i am owner|i'm owner|i am the owner|i'm the owner|my company)\b/i.test(
      text
    )
  ) {
    return "decision-maker";
  }

  if (/\b(need approval|not the decision maker|my manager decides|my boss decides|someone else decides)\b/i.test(text)) {
    return "needs-approval";
  }

  return null;
}

function mergeBantState(currentBant, incomingBant) {
  const mergedBant = {
    ...currentBant
  };

  if (incomingBant.budget) {
    mergedBant.budget = choosePreferredTextValue(mergedBant.budget, incomingBant.budget);
  }

  if (incomingBant.timeline) {
    mergedBant.timeline = chooseTimelineValue(mergedBant.timeline, incomingBant.timeline);
  }

  if (incomingBant.need) {
    mergedBant.need = chooseNeedValue(mergedBant.need, incomingBant.need);
  }

  if (incomingBant.authority) {
    mergedBant.authority = chooseAuthorityValue(mergedBant.authority, incomingBant.authority);
  }

  return mergedBant;
}

function choosePreferredTextValue(existingValue, incomingValue) {
  if (!incomingValue) {
    return existingValue;
  }

  if (!existingValue) {
    return incomingValue;
  }

  return String(incomingValue).length > String(existingValue).length ? incomingValue : existingValue;
}

function chooseTimelineValue(existingValue, incomingValue) {
  if (!incomingValue) {
    return existingValue;
  }

  if (!existingValue || incomingValue === "urgent") {
    return incomingValue;
  }

  if (existingValue === "flexible" && incomingValue !== "flexible") {
    return incomingValue;
  }

  return existingValue;
}

function chooseNeedValue(existingValue, incomingValue) {
  if (!incomingValue) {
    return existingValue;
  }

  if (!existingValue) {
    return incomingValue === true ? "Requirement shared" : incomingValue;
  }

  if (incomingValue === true) {
    return existingValue;
  }

  return choosePreferredTextValue(existingValue, incomingValue);
}

function chooseAuthorityValue(existingValue, incomingValue) {
  if (!incomingValue) {
    return existingValue;
  }

  if (existingValue === "decision-maker" || incomingValue === "decision-maker") {
    return "decision-maker";
  }

  return existingValue || incomingValue;
}

function hasBantChange(previousBant, nextBant) {
  return BANT_FIELDS.some(({ key }) => previousBant[key] !== nextBant[key]);
}

function calculateScore(bant) {
  let score = 0;

  if (bant.budget) {
    score += 3;
  }

  if (bant.authority) {
    score += 2;
  }

  if (bant.need) {
    score += 3;
  }

  if (bant.timeline) {
    score += 2;
  }

  return score;
}

function getLabel(score) {
  if (score >= 8) {
    return "Hot \u{1F525}";
  }

  if (score >= 5) {
    return "Warm \u{1F642}";
  }

  return "Cold \u2744\uFE0F";
}

function getNextQuestion(bant) {
  const nextField = BANT_FIELDS.find(({ key }) => !bant[key])?.key;

  if (!nextField) {
    return null;
  }

  if (nextField === "need") {
    return "What are you looking to solve right now?";
  }

  if (nextField === "budget") {
    return "What budget range do you have in mind for this?";
  }

  if (nextField === "authority") {
    return "Will you be the one taking the final call on this?";
  }

  return "What's your expected timeline for getting started?";
}

function buildLeadSummary(bant, score) {
  const missingFields = BANT_FIELDS.filter(({ key }) => !bant[key]).map(({ key }) => key);

  if (score >= 8) {
    return "Strong lead with clear need, budget, and urgency.";
  }

  if (score >= 5) {
    if (missingFields.length === 1) {
      return `Decent lead, needs clarity on ${missingFields[0]}.`;
    }

    return "Promising lead, but a couple of BANT details are still missing.";
  }

  if (!bant.need) {
    return "Early lead, still understanding the requirement.";
  }

  return "Early-stage lead. We still need a few qualification details.";
}

function normalizeLeadText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function normalizeBantText(value) {
  return (value || "").replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
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
  startBargeInMonitor();
}

function handleAssistantPlaybackEnd() {
  isAssistantSpeaking = false;
  stopBargeInMonitor();
  updateActionButtons();

  if (pendingAutoStartAfterSpeech) {
    pendingAutoStartAfterSpeech = false;
    void beginLiveConversation({ autoAttempt: true });
    return;
  }

  if (conversationCompleted) {
    resetStatus("Conversation complete", "idle");
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
  stopBargeInMonitor();
  updateActionButtons();

  if (!callModeEnabled && !isProcessing) {
    resetStatus("Idle", "idle");
  }
}

function scheduleNextListeningTurn() {
  window.clearTimeout(autoListenTimer);

  if (!callModeEnabled || conversationCompleted) {
    resetStatus(conversationCompleted ? "Conversation complete" : "Idle", "idle");
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
  applyDeterministicLeadSignals(normalizedTranscript, { syncViews: true });

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
  clearSpeechFinalizationTimer();
  isProcessing = false;
  isFinalizingTurn = false;
  conversationCompleted = false;
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
  clearSpeechFinalizationTimer();
  stopVoiceActivityMonitor();
  stopBargeInMonitor();
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
  audioMetrics = createAudioMetrics();
  waveformPeaks = waveformPeaks.map(() => 0);
}

function teardownRealtimeExperience() {
  window.clearTimeout(autoListenTimer);
  clearSpeechFinalizationTimer();
  stopVoiceActivityMonitor();
  stopBargeInMonitor();
  stopSpeechRecognition();
  stopWaveformLoop();

  if (realtimeSocket && realtimeSocket.readyState <= WebSocket.OPEN) {
    realtimeSocket.close();
  }

  releaseVoicePipeline();
}

function startWaveformLoop() {
  if (!waveformCanvas || !waveformContext || waveformFrameId) {
    return;
  }

  const draw = () => {
    waveformFrameId = window.requestAnimationFrame(draw);
    renderWaveformFrame();
  };

  syncWaveformCanvasSize();
  draw();
}

function stopWaveformLoop() {
  if (!waveformFrameId) {
    return;
  }

  window.cancelAnimationFrame(waveformFrameId);
  waveformFrameId = 0;
}

function renderWaveformFrame() {
  if (!waveformCanvas || !waveformContext) {
    return;
  }

  if (!waveformCanvas.width || !waveformCanvas.height) {
    syncWaveformCanvasSize();
  }

  if (analyserNode && analyserData) {
    analyserNode.getByteFrequencyData(analyserData);
    updateAudioMetrics(analyserData);
    drawWaveform(analyserData);
    return;
  }

  decayAudioMetrics();
  drawWaveform();
}

function syncWaveformCanvasSize() {
  if (!waveformCanvas || !waveformContext) {
    return;
  }

  const rect = waveformCanvas.getBoundingClientRect();
  const pixelRatio = Math.max(window.devicePixelRatio || 1, 1);
  const width = Math.max(1, Math.round(rect.width * pixelRatio));
  const height = Math.max(1, Math.round(rect.height * pixelRatio));

  if (waveformCanvas.width === width && waveformCanvas.height === height) {
    return;
  }

  waveformCanvas.width = width;
  waveformCanvas.height = height;
}

function drawWaveform(buffer) {
  const ctx = waveformContext;
  const width = waveformCanvas.width;
  const height = waveformCanvas.height;
  const barCount = REALTIME_CONFIG.waveformBars;
  const state = getWaveformState();
  const centerY = height / 2;
  const minBarHeight = height * 0.08;
  const maxBarHeight = height * 0.74;
  const barWidth = width / (barCount * 1.85);
  const gap = barWidth * 0.85;
  const totalWidth = barCount * barWidth + (barCount - 1) * gap;
  const accent = buildWaveformGradient(ctx, height, state);
  const idleColor = state === "processing" ? "rgba(245, 158, 11, 0.2)" : "rgba(148, 163, 184, 0.2)";

  if (waveformPeaks.length !== barCount) {
    waveformPeaks = Array.from({ length: barCount }, () => 0);
  }

  ctx.clearRect(0, 0, width, height);

  let x = (width - totalWidth) / 2;

  for (let index = 0; index < barCount; index += 1) {
    const target = buffer ? getWaveformIntensity(buffer, index, barCount) : 0;
    waveformPeaks[index] = buffer ? waveformPeaks[index] * 0.7 + target * 0.3 : waveformPeaks[index] * 0.86;

    const normalizedHeight = Math.max(waveformPeaks[index], 0.03);
    const barHeight = minBarHeight + normalizedHeight * maxBarHeight;
    const y = centerY - barHeight / 2;
    const isActive = getCurrentAudioLevel() > getDynamicSpeechThreshold() * 0.92 || normalizedHeight > 0.09;

    ctx.fillStyle = isActive ? accent : idleColor;
    drawRoundedBar(ctx, x, y, barWidth, barHeight, Math.min(barWidth / 2, 12));
    x += barWidth + gap;
  }
}

function buildWaveformGradient(ctx, height, state) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);

  if (state === "processing") {
    gradient.addColorStop(0, "rgba(245, 158, 11, 0.78)");
    gradient.addColorStop(1, "rgba(251, 191, 36, 0.5)");
    return gradient;
  }

  if (state === "speaking") {
    gradient.addColorStop(0, "rgba(99, 102, 241, 0.72)");
    gradient.addColorStop(1, "rgba(14, 165, 233, 0.42)");
    return gradient;
  }

  if (state === "recording" || getCurrentAudioLevel() > getDynamicSpeechThreshold()) {
    gradient.addColorStop(0, "rgba(79, 70, 229, 0.95)");
    gradient.addColorStop(1, "rgba(14, 165, 233, 0.6)");
    return gradient;
  }

  gradient.addColorStop(0, "rgba(148, 163, 184, 0.34)");
  gradient.addColorStop(1, "rgba(203, 213, 225, 0.18)");
  return gradient;
}

function getWaveformState() {
  return voiceStage?.dataset.state || "idle";
}

function getWaveformIntensity(buffer, index, barCount) {
  const usableBins = Math.min(buffer.length, 72);
  const binsPerBar = Math.max(1, Math.floor(usableBins / barCount));
  const start = index * binsPerBar;
  const end = index === barCount - 1 ? usableBins : Math.min(usableBins, start + binsPerBar);
  let sum = 0;

  for (let bin = start; bin < end; bin += 1) {
    sum += buffer[bin];
  }

  const average = sum / Math.max(1, end - start);
  return Math.min(1, (average / 255) * 2.2);
}

function drawRoundedBar(ctx, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);

  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
  ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
  ctx.arcTo(x, y + height, x, y, safeRadius);
  ctx.arcTo(x, y, x + width, y, safeRadius);
  ctx.closePath();
  ctx.fill();
}

function createAudioMetrics() {
  return {
    level: 0,
    smoothedLevel: 0,
    noiseFloor: REALTIME_CONFIG.vadThreshold * 0.45,
    dynamicThreshold: REALTIME_CONFIG.vadThreshold
  };
}

function updateAudioMetrics(buffer) {
  const rawLevel = sampleFrequencyLevel(buffer);
  const targetNoiseFloor =
    !isListening || rawLevel < audioMetrics.dynamicThreshold
      ? rawLevel
      : Math.min(audioMetrics.noiseFloor, rawLevel);

  audioMetrics.noiseFloor = audioMetrics.noiseFloor * 0.94 + targetNoiseFloor * 0.06;
  audioMetrics.level = rawLevel;
  audioMetrics.smoothedLevel = audioMetrics.smoothedLevel * 0.68 + rawLevel * 0.32;
  audioMetrics.dynamicThreshold = Math.max(
    REALTIME_CONFIG.vadThreshold,
    audioMetrics.noiseFloor + REALTIME_CONFIG.noiseFloorMargin
  );
}

function decayAudioMetrics() {
  audioMetrics.level *= 0.86;
  audioMetrics.smoothedLevel *= 0.9;
  audioMetrics.dynamicThreshold = Math.max(
    REALTIME_CONFIG.vadThreshold,
    audioMetrics.noiseFloor + REALTIME_CONFIG.noiseFloorMargin
  );
}

function sampleFrequencyLevel(buffer) {
  const usableBins = Math.min(buffer.length, 40);
  let sum = 0;

  for (let index = 1; index < usableBins; index += 1) {
    sum += buffer[index] / 255;
  }

  return sum / Math.max(1, usableBins - 1);
}

function getCurrentAudioLevel() {
  return Math.max(audioMetrics.level, audioMetrics.smoothedLevel);
}

function getSpeechActivityLevel() {
  return Math.max(audioMetrics.level, audioMetrics.smoothedLevel * 0.55);
}

function getDynamicSpeechThreshold() {
  return audioMetrics.dynamicThreshold || REALTIME_CONFIG.vadThreshold;
}

function previewAudio(element, blob) {
  const previousUrl = element.dataset.objectUrl;

  if (previousUrl) {
    URL.revokeObjectURL(previousUrl);
  }

  const objectUrl = URL.createObjectURL(blob);

  element.dataset.objectUrl = objectUrl;
  element.src = objectUrl;
  element.load();
}

function createTurnState(mimeType) {
  return {
    mimeType,
    audioChunks: [],
    partialTranscript: "",
    streamOverSocket: false,
    realtimeProcessingStarted: false,
    shouldProcess: false,
    stopReason: "silence",
    voiceStartedAt: 0,
    lastSpeechAt: 0,
    lastTranscriptAt: 0,
    hasSpoken: false
  };
}

function scheduleSpeechFinalization(reason) {
  clearSpeechFinalizationTimer();

  speechFinalizationTimer = window.setTimeout(() => {
    speechFinalizationTimer = 0;

    if (!activeTurn || !isListening || isFinalizingTurn) {
      return;
    }

    void finishListeningTurn(reason);
  }, REALTIME_CONFIG.recognitionSilenceMs);
}

function clearSpeechFinalizationTimer() {
  if (!speechFinalizationTimer) {
    return;
  }

  window.clearTimeout(speechFinalizationTimer);
  speechFinalizationTimer = 0;
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
  const liveModeActive = callModeEnabled || isListening || isProcessing || isAssistantSpeaking;

  startButton.disabled = false;
  startButton.classList.toggle("is-active", liveModeActive);
  startButton.setAttribute("aria-label", liveModeActive ? "End live mode" : "Start live mode");
  startButton.title = liveModeActive ? "End live mode" : "Start live mode";

  if (stopButton) {
    stopButton.disabled = true;
    stopButton.textContent = isListening ? "Stop & Send" : "End Live Mode";
  }
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

  if (statusBadgeVisible) {
    statusBadgeVisible.textContent = label;
    statusBadgeVisible.className = `status-badge visible-status ${variant}`;
  }

  if (voiceStage) {
    voiceStage.dataset.state = variant || "idle";
  }
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
