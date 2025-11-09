// server.js
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} from "@aws-sdk/client-transcribe-streaming";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();
import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract";

// ---- AWS clients ----
const REGION = process.env.AWS_REGION || "ap-south-1";
const transcribeClient = new TranscribeStreamingClient({ region: REGION });

const awsTextTractConfig = {
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID_OCR,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_OCR,
  },
};
const textractClient = new TextractClient(awsTextTractConfig);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Async queue ----------
class IncomingQueue {
  constructor() {
    this._buffers = [];
    this._resolvers = [];
    this._closed = false;
  }
  push(buf) {
    if (this._closed) return;
    if (this._resolvers.length > 0) {
      const r = this._resolvers.shift();
      r({ value: buf, done: false });
    } else {
      this._buffers.push(buf);
    }
  }
  close() {
    this._closed = true;
    while (this._resolvers.length > 0) {
      const r = this._resolvers.shift();
      r({ value: undefined, done: true });
    }
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this._buffers.length > 0) {
          const v = this._buffers.shift();
          return Promise.resolve({ value: v, done: false });
        }
        if (this._closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this._resolvers.push(resolve));
      },
    };
  }
}

// Wrap queue items into AWS AudioEvents
async function* audioEventGenerator(incomingQueue) {
  for await (const chunk of incomingQueue) {
    const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    yield { AudioEvent: { AudioChunk: u8 } };
  }
}

// ---- Silence helpers (16kHz mono PCM16) ----
// 20 ms is a good, light keepalive frame (16000*0.02*2 = 640 bytes)
function makeSilenceFrame(durationMs = 20) {
  const samples = Math.floor(16000 * (durationMs / 1000));
  const bytes = samples * 2;
  return new Uint8Array(bytes); // zeros
}

const server = http.createServer();

// Basic CORS + Textract endpoint
server.on("request", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/textract") {
    try {
      const body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });

      let payload = {};
      try {
        payload = JSON.parse(body.toString("utf-8"));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      let params;
      if (payload.dataUrl) {
        const m = /^data:([\w/+.-]+);base64,(.+)$/i.exec(payload.dataUrl);
        if (!m) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "dataUrl must be a base64 data URL" }));
          return;
        }
        const bytes = Buffer.from(m[2], "base64");
        params = { Document: { Bytes: Uint8Array.from(bytes) } };
      } else if (payload.s3 && payload.s3.Bucket && payload.s3.Name) {
        params = { Document: { S3Object: { Bucket: payload.s3.Bucket, Name: payload.s3.Name } } };
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Provide either { dataUrl } or { s3: { Bucket, Name } }" }));
        return;
      }

      const command = new DetectDocumentTextCommand(params);
      const result = await textractClient.send(command);
      const blocks = result.Blocks || [];
      const lines = blocks.filter((b) => b.BlockType === "LINE" && b.Text).map((b) => b.Text);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: lines.join("\n"), lines, rawBlocks: blocks }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }

  // Not found for other HTTP routes; WS handled below.
  if (req.url !== "/transcribe") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

// ---- WebSocket for /transcribe ----
const wss = new WebSocketServer({ server, path: "/transcribe" });

wss.on("connection", async (ws) => {
  console.log("Client connected");

  // Per-connection state
  const queue = new IncomingQueue();
  const audioStream = audioEventGenerator(queue);

  let closed = false;
  let lastAudioAt = Date.now();
  let paused = false;

  // Silence watchdog: if no audio in > idleThresholdMs, push a 20ms silence frame every tick
  const tickMs = 200;            // check 5x per second
  const idleThresholdMs = 800;   // if we've been idle for >0.8s, start feeding silence
  const silenceFrame = makeSilenceFrame(20);

  const idleInterval = setInterval(() => {
    if (closed) return;
    const now = Date.now();
    if (now - lastAudioAt > idleThresholdMs) {
      // keep the stream alive with a tiny silence packet
      queue.push(silenceFrame);
      // don't update lastAudioAt here; we only track real audio for diagnostics
    }
  }, tickMs);

  // Optional: WS heartbeat to keep some proxies happy
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  const pingInterval = setInterval(() => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }, 30000);

  // Start AWS Transcribe stream
  const command = new StartStreamTranscriptionCommand({
    LanguageCode: "en-US",
    MediaEncoding: "pcm",
    MediaSampleRateHertz: 16000,
    EnablePartialResultsStabilization: true,
    PartialResultsStability: "medium",
    AudioStream: audioStream,
  });

  let transcribeResponse;
  try {
    transcribeResponse = await transcribeClient.send(command);
  } catch (e) {
    console.error("Failed to start Transcribe:", e);
    try { ws.send(JSON.stringify({ type: "error", message: String(e?.message || e) })); } catch {}
    try { ws.close(); } catch {}
    cleanup();
    return;
  }

  // Read AWS results → send to client
  (async () => {
    try {
      for await (const evt of transcribeResponse.TranscriptResultStream) {
        if (!evt?.TranscriptEvent) continue;
        const results = evt.TranscriptEvent.Transcript?.Results || [];
        for (const r of results) {
          const isPartial = !!r.IsPartial;
          const alt = r.Alternatives?.[0];
          if (!alt) continue;
          const text = alt.Transcript || "";
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "transcript", transcript: text, isPartial }));
          }
        }
      }
    } catch (e) {
      console.error("AWS read error:", e);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "error", message: String(e?.message || e) }));
      }
    } finally {
      // If AWS ends (including idle timeout), close client WS to sync states
      if (!closed) {
        try { ws.close(); } catch {}
      }
      cleanup();
      console.log("Transcribe stream ended");
    }
  })();

  ws.on("message", async (msg, isBinary) => {
    try {
      if (isBinary) {
        // raw PCM 16k mono PCM16 from client
        lastAudioAt = Date.now();
        queue.push(msg);
        return;
      }

      const data = JSON.parse(msg.toString());

      if (data.type === "stop") {
        // graceful end
        cleanup();
        try { ws.close(); } catch {}
        return;
      }

      if (data.type === "pause") {
        paused = true;
        // No special action needed: the idle watchdog already feeds silence automatically.
        return;
      }

      if (data.type === "resume") {
        paused = false;
        lastAudioAt = Date.now();
        return;
      }

      if (data.type === "ask_ai") {
        const questionContext = String(data.text || "").slice(0, 4000);
        const prompt = `
You are not advising. You are answering as the candidate in an interview.

1) From the transcript, find the last actual question asked. Ignore filler.
2) Answer that question directly, as if you are speaking naturally.

Rules:
- Max 80 words
- No preamble
- Tone: natural, calm, confident
- Do NOT say "The question is" or "You should"
- If it's a DSA-style problem, include the code in Cpp.

TRANSCRIPT (recent):
${questionContext}

Now respond as the candidate:
        `.trim();

        try {
          const resp = await openai.responses.create({
            model: "gpt-4o-mini",
            input: prompt,
          });

          const text =
            resp.output_text ??
            (resp.output?.[0]?.content?.[0]?.text ?? "Sorry, I couldn't generate an answer.");

          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "ai_answer", text }));
          }
        } catch (e) {
          console.error("OpenAI error:", e);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "ai_answer", text: "AI error: " + String(e?.message || e) }));
          }
        }
        return;
      }
    } catch (e) {
      console.error("WS message parse error:", e);
    }
  });

  ws.on("close", () => {
    cleanup();
    console.log("Client closed");
  });

  ws.on("error", (err) => {
    console.error("WS error:", err);
    cleanup();
  });

  function cleanup() {
    if (closed) return;
    closed = true;
    try { clearInterval(idleInterval); } catch {}
    try { clearInterval(pingInterval); } catch {}
    queue.close(); // ends audioEventGenerator
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
