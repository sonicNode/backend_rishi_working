const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const statusBadge = document.querySelector("#statusBadge");
const messageList = document.querySelector("#messageList");
const leadProfileView = document.querySelector("#leadProfile");
const qualificationView = document.querySelector("#qualification");
const sessionIdInput = document.querySelector("#sessionId");
const languageSelect = document.querySelector("#languageCode");
const speakerInput = document.querySelector("#speaker");
const userPlayback = document.querySelector("#userPlayback");
const assistantPlayback = document.querySelector("#assistantPlayback");
const messageTemplate = document.querySelector("#messageTemplate");

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];

sessionIdInput.value = `lead-session-${Date.now()}`;

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
  appendMessage("you", data.userTranscript);
  appendMessage("assistant", data.assistantText);

  leadProfileView.textContent = JSON.stringify(data.leadProfile, null, 2);
  qualificationView.textContent = JSON.stringify(data.qualification, null, 2);

  const audioBytes = base64ToUint8Array(data.assistantAudioBase64);
  const assistantBlob = new Blob([audioBytes], {
    type: data.assistantAudioMimeType || "audio/wav"
  });

  previewAudio(assistantPlayback, assistantBlob);
  assistantPlayback.play().catch(() => {
    appendMessage("system", "Assistant audio is ready. Press play if the browser blocks autoplay.");
  });
}

function appendMessage(role, text) {
  const fragment = messageTemplate.content.cloneNode(true);
  fragment.querySelector(".message-role").textContent = role;
  fragment.querySelector(".message-text").textContent = text;
  messageList.prepend(fragment);
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
