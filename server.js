// El Chicho — servidor Express. Sirve la web y hace de proxy a la API de Claude.
// La API key vive SOLO aquí (variable de entorno ANTHROPIC_API_KEY en Render).
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { RULES_BASE, MODES } from "./prompts.js";

const PORT = process.env.PORT || 3000;
// Claude Fable 5.1: el modelo más capaz de Anthropic (piensa siempre antes de responder)
const MODEL = process.env.CHICHO_MODEL || "claude-fable-5-1";
const EFFORT = { quick: "medium", default: "high", complex: "xhigh" };

// Límites anti-abuso (ajústalos con variables de entorno)
const RATE_MAX = Number(process.env.RATE_MAX || 20);                 // mensajes por ventana por IP
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MIN || 10) * 60_000;
const MAX_TURNS = 20;
const MAX_CHARS = 8000;                                               // por mensaje

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Falta ANTHROPIC_API_KEY. Configúrala en Render → Environment.");
}

const client = new Anthropic(); // lee ANTHROPIC_API_KEY del entorno
const app = express();
app.set("trust proxy", 1);      // Render va detrás de un proxy: IP real del visitante
app.use(express.json({ limit: "200kb" }));
app.use(express.static("public"));

// ===== Rate limit simple en memoria =====
const hits = new Map(); // ip -> [timestamps]
function allowed(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) if (!list.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(ip);
}, 60_000).unref();

// ===== Validación del historial que manda el navegador =====
function cleanMessages(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const msgs = raw.slice(-MAX_TURNS).map((m) => ({
    role: m?.role === "assistant" ? "assistant" : "user",
    content: String(m?.content ?? "").slice(0, MAX_CHARS),
  })).filter((m) => m.content.trim());
  while (msgs[0] && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;
  return msgs;
}

app.get("/health", (_req, res) => res.send("ok"));

app.post("/api/chat", async (req, res) => {
  if (!allowed(req.ip)) {
    return res.status(429).json({ error: "Demasiados mensajes. Espera unos minutos." });
  }
  const messages = cleanMessages(req.body?.messages);
  if (!messages) return res.status(400).json({ error: "Mensaje inválido." });

  const system = RULES_BASE + (MODES[req.body?.mode] || "");
  const effort = EFFORT[req.body?.tier] || "high";

  // Respuesta en streaming: una línea JSON por evento
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    system,
    messages,
    output_config: { effort },
    // Si el modelo rechaza la petición, la API reintenta con otro modelo
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });

  // Si el visitante cierra la pestaña o pulsa Detener, cortamos (y dejamos de pagar)
  res.on("close", () => { if (!res.writableEnded) stream.abort(); });

  try {
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        send({ t: event.delta.text });
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") send({ error: "No puedo responder a eso. Cambia la petición." });
    else send({ done: true, truncated: final.stop_reason === "max_tokens" });
  } catch (err) {
    if (res.destroyed) return; // el visitante se fue
    let msg = "Error del servidor. Intenta de nuevo.";
    if (err instanceof Anthropic.AuthenticationError) msg = "El servidor no tiene una API key válida.";
    else if (err instanceof Anthropic.RateLimitError) msg = "El Chicho está saturado. Prueba en un minuto.";
    else if (err instanceof Anthropic.APIConnectionError) msg = "Sin conexión con la IA. Intenta de nuevo.";
    else if (err instanceof Anthropic.APIError) msg = `Error de la IA (${err.status ?? "?"}).`;
    console.error(err);
    send({ error: msg });
  }
  res.end();
});

app.listen(PORT, () => console.log(`El Chicho escuchando en http://localhost:${PORT}`));
