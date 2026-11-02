// Password-protected proxy for the "Ask the data" tab (a Vercel function). The OpenAI key and the password live
// only in this Vercel project's environment variables, OPENAI_API_KEY and ASK_PASSWORD, so visitors never see the
// key. The browser sends the password, its digest of the page's data, the question, and recent history; this adds
// the fixed instructions, calls OpenAI, and streams the answer back as plain text.
//
//   GET  /api/ask                                           { configured }
//   POST /api/ask { password, action: "models" }            { models, preferred }
//   POST /api/ask { password, model, question, context, history }   text/plain stream
//
// Guard rails: a wrong password waits before answering (slows guessing), requests are size-capped, only the fixed
// instructions are used (a caller cannot swap in their own), and answers are capped at maxCompletionTokens.
import { createHash, timingSafeEqual } from "node:crypto";
import { ASK_SYSTEM } from "../ingest/ask-prompt.js";

export const ASK_LIMITS = { bodyBytes: 400_000, contextChars: 200_000, questionChars: 2_000, historyMessages: 6, historyChars: 6_000, maxCompletionTokens: 4_000, wrongPasswordDelayMs: 800 };
const CHAT_MODEL = /^(gpt-|o\d)/;
const NOT_CHAT = /(audio|realtime|tts|transcribe|search|image|embedding|instruct|moderation|codex|computer-use|oss)/;

export default async function handler(req, res) {
  const apiKey = process.env.OPENAI_API_KEY, password = process.env.ASK_PASSWORD;
  const openAiUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  if (req.method === "GET") return sendJson(res, 200, { configured: Boolean(apiKey && password) });
  if (req.method !== "POST") return sendJson(res, 405, { error: "Use GET or POST." });
  if (!apiKey || !password) return sendJson(res, 503, { error: "The site's OpenAI key is not set up." });

  let body;
  try { body = await readJson(req, ASK_LIMITS.bodyBytes); } catch (error) { return sendJson(res, 400, { error: error.message }); }
  if (!passwordMatches(body.password, password)) {
    await new Promise((resolve) => setTimeout(resolve, ASK_LIMITS.wrongPasswordDelayMs));
    return sendJson(res, 401, { error: "Wrong password." });
  }
  if (body.action === "models") return listModels(res, apiKey, openAiUrl);

  const question = String(body.question ?? "").trim();
  if (!question) return sendJson(res, 400, { error: "Ask a question." });
  if (question.length > ASK_LIMITS.questionChars) return sendJson(res, 400, { error: `Questions are limited to ${ASK_LIMITS.questionChars} characters.` });
  const context = typeof body.context === "string" ? body.context : JSON.stringify(body.context ?? null);
  if (context.length > ASK_LIMITS.contextChars) return sendJson(res, 400, { error: "The page's data digest is too large." });
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((message) => (message?.role === "user" || message?.role === "assistant") && typeof message.content === "string")
    .slice(-ASK_LIMITS.historyMessages)
    .map((message) => ({ role: message.role, content: message.content.slice(0, ASK_LIMITS.historyChars) }));
  const model = typeof body.model === "string" && CHAT_MODEL.test(body.model) && !NOT_CHAT.test(body.model) ? body.model : (process.env.ASK_MODEL || "gpt-5");

  const messages = [{ role: "system", content: ASK_SYSTEM }, { role: "system", content: `DATA ${context}` }, ...history, { role: "user", content: question }];
  let upstream;
  try {
    upstream = await fetch(`${openAiUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true, max_completion_tokens: ASK_LIMITS.maxCompletionTokens }),
    });
  } catch (error) {
    return sendJson(res, 502, { error: `Could not reach OpenAI: ${error.message}` });
  }
  if (!upstream.ok) {
    const detail = await upstream.json().catch(() => null);
    return sendJson(res, upstream.status === 401 ? 502 : upstream.status, { error: describeOpenAiError(upstream.status, detail?.error?.message) });
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Ask-Model": model });
  try {
    await relayTextDeltas(upstream, (text) => res.write(text));
  } catch (error) {
    res.write(`\n\n[The answer was cut off: ${error.message}]`);
  }
  res.end();
}

/** The key's chat models, newest first, and the newest plain "gpt-N" / "gpt-N.N" one as the suggestion. */
async function listModels(res, apiKey, openAiUrl) {
  const response = await fetch(`${openAiUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } }).catch(() => null);
  if (!response?.ok) return sendJson(res, 502, { error: describeOpenAiError(response?.status ?? 502, null) });
  const { data } = await response.json();
  const models = (data || []).filter((m) => CHAT_MODEL.test(m.id) && !NOT_CHAT.test(m.id)).sort((a, b) => b.created - a.created).map((m) => m.id);
  return sendJson(res, 200, { models, preferred: process.env.ASK_MODEL || models.find((id) => /^gpt-\d+(\.\d+)?$/.test(id)) || models[0] || null });
}

function describeOpenAiError(status, message) {
  if (status === 401) return "OpenAI rejected the site's key; check OPENAI_API_KEY in Vercel.";
  if (status === 429) return `OpenAI rate limit or out of API credit${message ? ` (${message})` : ""}.`;
  return message || `OpenAI error ${status}.`;
}

/** Hashing both sides first gives equal-length buffers, so the comparison takes the same time either way. */
function passwordMatches(given, expected) {
  if (typeof given !== "string" || !given) return false;
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
}

/** The request body as JSON: Vercel may have parsed it already; otherwise read it, up to a size limit. */
async function readJson(req, limit) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new Error("Request body is not JSON."); }
}

/** OpenAI's stream is server-sent events, "data: {json}" lines ending in "data: [DONE]"; pass on just the text. */
async function relayTextDeltas(upstream, write) {
  const reader = upstream.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try { const delta = JSON.parse(data).choices?.[0]?.delta?.content; if (delta) write(delta); } catch { /* not JSON; skip */ }
    }
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
