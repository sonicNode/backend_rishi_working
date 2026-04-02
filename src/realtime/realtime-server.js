import { createHash } from "crypto";
import { env } from "../config/env.js";
import { processVoiceTurn } from "../services/voice-turn.service.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_SIZE_BYTES = 8 * 1024 * 1024;

export function attachRealtimeServer(server) {
  server.on("upgrade", (req, socket) => {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname !== "/realtime") {
      socket.destroy();
      return;
    }

    if ((req.headers.upgrade || "").toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }

    const websocketKey = req.headers["sec-websocket-key"];

    if (!websocketKey) {
      socket.destroy();
      return;
    }

    const acceptKey = createHash("sha1")
      .update(`${websocketKey}${WEBSOCKET_GUID}`)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        "\r\n"
      ].join("\r\n")
    );

    const state = createConnectionState({
      sessionId: requestUrl.searchParams.get("sessionId"),
      languageCode: requestUrl.searchParams.get("languageCode"),
      speaker: requestUrl.searchParams.get("speaker")
    });
    let bufferedFrameData = Buffer.alloc(0);

    sendJson(socket, {
      type: "ready",
      sessionId: state.sessionId,
      languageCode: state.languageCode,
      speaker: state.speaker
    });

    socket.on("data", (chunk) => {
      try {
        bufferedFrameData = Buffer.concat([bufferedFrameData, chunk]);
        const { frames, remainingBuffer } = extractFrames(bufferedFrameData);

        bufferedFrameData = remainingBuffer;

        frames.forEach((frame) => {
          void handleFrame({ frame, socket, state });
        });
      } catch (error) {
        sendJson(socket, {
          type: "error",
          message: error instanceof Error ? error.message : "Realtime frame parsing failed."
        });
        safeClose(socket);
      }
    });

    socket.on("error", () => {
      resetTurnState(state);
    });

    socket.on("close", () => {
      resetTurnState(state);
    });

    socket.on("end", () => {
      resetTurnState(state);
    });
  });
}

async function handleFrame({ frame, socket, state }) {
  if (frame.opcode === 0x8) {
    safeClose(socket);
    return;
  }

  if (frame.opcode === 0x9) {
    socket.write(createFrame(frame.payload, 0xA));
    return;
  }

  if (frame.opcode === 0x1) {
    const text = frame.payload.toString("utf8");
    const message = JSON.parse(text);
    await handleControlMessage({ message, socket, state });
    return;
  }

  if (frame.opcode === 0x2 && state.isListening && !state.isProcessing) {
    state.chunks.push(Buffer.from(frame.payload));
  }
}

async function handleControlMessage({ message, socket, state }) {
  switch (message.type) {
    case "config":
      state.sessionId = message.sessionId || state.sessionId || `session-${Date.now()}`;
      state.languageCode = message.languageCode || state.languageCode || env.defaultLanguageCode;
      state.speaker = message.speaker || state.speaker || env.defaultSpeaker;
      sendJson(socket, {
        type: "config_ack",
        sessionId: state.sessionId,
        languageCode: state.languageCode,
        speaker: state.speaker
      });
      break;
    case "listen_start":
      resetTurnState(state);
      state.isListening = true;
      state.mimeType = message.mimeType || "audio/webm";
      state.filename = message.filename || getFilenameForMimeType(state.mimeType);
      sendJson(socket, { type: "state", state: "listening" });
      break;
    case "partial_transcript":
      state.partialTranscript = (message.transcript || "").trim() || state.partialTranscript;
      sendJson(socket, {
        type: "partial_transcript",
        transcript: state.partialTranscript,
        final: !!message.final
      });
      break;
    case "speech_end":
      await finalizeSpeechTurn({ socket, state });
      break;
    case "listen_abort":
      resetTurnState(state);
      sendJson(socket, { type: "state", state: "idle" });
      break;
    case "ping":
      sendJson(socket, { type: "pong", now: Date.now() });
      break;
    default:
      sendJson(socket, {
        type: "error",
        message: `Unsupported realtime message type: ${message.type}`
      });
  }
}

async function finalizeSpeechTurn({ socket, state }) {
  if (state.isProcessing) {
    return;
  }

  const hasAudio = state.chunks.length > 0;
  const hasTranscript = !!state.partialTranscript;

  state.isListening = false;

  if (!hasAudio && !hasTranscript) {
    sendJson(socket, { type: "state", state: "idle" });
    return;
  }

  state.isProcessing = true;
  sendJson(socket, { type: "state", state: "thinking" });

  try {
    const buffer = hasAudio ? Buffer.concat(state.chunks) : Buffer.alloc(0);
    const data = await processVoiceTurn({
      buffer,
      filename: state.filename || getFilenameForMimeType(state.mimeType),
      mimeType: state.mimeType || "audio/webm",
      sessionId: state.sessionId,
      requestedLanguageCode: state.languageCode,
      speaker: state.speaker,
      fallbackTranscript: state.partialTranscript
    });

    sendJson(socket, {
      type: "final_transcript",
      transcript: data.userTranscript
    });
    sendJson(socket, {
      type: "assistant_reply",
      data
    });
    sendJson(socket, { type: "state", state: "speaking" });
  } catch (error) {
    sendJson(socket, {
      type: "error",
      message: error instanceof Error ? error.message : "Realtime processing failed."
    });
    sendJson(socket, { type: "state", state: "idle" });
  } finally {
    state.isProcessing = false;
    state.chunks = [];
    state.partialTranscript = "";
  }
}

function createConnectionState({ sessionId, languageCode, speaker }) {
  return {
    sessionId: sessionId || `session-${Date.now()}`,
    languageCode: languageCode || env.defaultLanguageCode,
    speaker: speaker || env.defaultSpeaker,
    mimeType: "audio/webm",
    filename: "realtime-turn.webm",
    chunks: [],
    partialTranscript: "",
    isListening: false,
    isProcessing: false
  };
}

function resetTurnState(state) {
  state.isListening = false;
  state.isProcessing = false;
  state.chunks = [];
  state.partialTranscript = "";
}

function sendJson(socket, data) {
  socket.write(createFrame(Buffer.from(JSON.stringify(data)), 0x1));
}

function createFrame(payload, opcode = 0x1) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header = null;

  if (payloadBuffer.length < 126) {
    header = Buffer.alloc(2);
    header[1] = payloadBuffer.length;
  } else if (payloadBuffer.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(payloadBuffer.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadBuffer.length), 2);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payloadBuffer]);
}

function extractFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const fin = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let cursor = offset + 2;

    if (!fin) {
      throw new Error("Fragmented realtime frames are not supported.");
    }

    if (payloadLength === 126) {
      if (cursor + 2 > buffer.length) {
        break;
      }

      payloadLength = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLength === 127) {
      if (cursor + 8 > buffer.length) {
        break;
      }

      const extendedLength = buffer.readBigUInt64BE(cursor);

      if (extendedLength > BigInt(MAX_FRAME_SIZE_BYTES)) {
        throw new Error("Realtime frame exceeded the supported size.");
      }

      payloadLength = Number(extendedLength);
      cursor += 8;
    }

    const maskLength = masked ? 4 : 0;

    if (cursor + maskLength + payloadLength > buffer.length) {
      break;
    }

    let payload = buffer.subarray(cursor + maskLength, cursor + maskLength + payloadLength);

    if (masked) {
      const mask = buffer.subarray(cursor, cursor + 4);
      const unmasked = Buffer.alloc(payloadLength);

      for (let index = 0; index < payloadLength; index += 1) {
        unmasked[index] = payload[index] ^ mask[index % 4];
      }

      payload = unmasked;
    }

    frames.push({ opcode, payload });
    offset = cursor + maskLength + payloadLength;
  }

  return {
    frames,
    remainingBuffer: buffer.subarray(offset)
  };
}

function safeClose(socket) {
  if (socket.destroyed) {
    return;
  }

  socket.write(createFrame(Buffer.alloc(0), 0x8));
  socket.end();
}

function getFilenameForMimeType(mimeType = "") {
  if (mimeType.includes("ogg")) {
    return "realtime-turn.ogg";
  }

  if (mimeType.includes("wav")) {
    return "realtime-turn.wav";
  }

  return "realtime-turn.webm";
}
