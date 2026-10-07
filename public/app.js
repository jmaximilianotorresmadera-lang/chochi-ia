// El Chicho — cliente web. Habla con /api/chat (servidor Node en Render).
const $ = (id) => document.getElementById(id);
const thread = $("thread"), scroller = $("scroller"), box = $("box"), sendBtn = $("send"), form = $("form");
let turns = [];          // [{role, content}] historial del chat
let ctl = null, busy = false;

// ===== Memoria local (solo en tu navegador) =====
function load() { try { const t = JSON.parse(localStorage.getItem("chicho.turns") || "[]"); if (Array.isArray(t)) turns = t; } catch {} }
function save() { try { localStorage.setItem("chicho.turns", JSON.stringify(turns.slice(-40))); } catch {} }

// ===== Markdown mínimo con bloques de código =====
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
}
function prose(text) {
  const out = []; let list = null;
  const flush = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = line.match(/^#{1,6}\s+(.*)/))) { flush(); out.push(`<h4>${inline(m[1])}</h4>`); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { flush(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { flush(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    flush(); out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join("");
}
const LANG_ALIAS = { luau: "lua", py: "python", js: "javascript", ts: "typescript", kt: "kotlin", "c++": "cpp", ino: "arduino", sh: "bash", html: "xml" };
function codeBlock(lang, code) {
  const l = (lang || "").toLowerCase(), hl = LANG_ALIAS[l] || l;
  let html = esc(code);
  try { if (window.hljs && hl && hljs.getLanguage(hl)) html = hljs.highlight(code, { language: hl }).value; } catch {}
  return `<div class="code"><div class="code-bar"><span>${esc(lang || "código")}</span><button class="copy" type="button">Copiar</button></div><pre><code>${html}</code></pre></div>`;
}
function render(text) {
  // Divide por bloques ``` (soporta bloque abierto mientras se escribe)
  let html = "";
  text.split(/```/).forEach((part, i) => {
    if (i % 2 === 0) { html += prose(part); return; }
    const nl = part.indexOf("\n");
    const lang = nl === -1 ? part.trim() : part.slice(0, nl).trim();
    const code = nl === -1 ? "" : part.slice(nl + 1).replace(/\n$/, "");
    html += codeBlock(lang, code);
  });
  return html;
}

// Copiar código
thread.addEventListener("click", async (e) => {
  const b = e.target.closest(".copy"); if (!b) return;
  const code = b.closest(".code").querySelector("code");
  try { await navigator.clipboard.writeText(code.textContent); b.textContent = "Copiado"; }
  catch { const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = "Selecciona y copia"; }
  setTimeout(() => (b.textContent = "Copiar"), 1600);
});

// ===== UI =====
function addMsg(role, html) {
  const el = document.createElement("div");
  el.className = "msg " + (role === "user" ? "user" : "bot");
  el.innerHTML = `<div class="who">${role === "user" ? "Tú" : "Ch"}</div><div class="bubble">${html}</div>`;
  thread.append(el);
  return el.querySelector(".bubble");
}
const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };

function drawAll() {
  thread.innerHTML = "";
  if (!turns.length) { thread.innerHTML = '<div class="empty"><b>El Chicho</b>Escribe lo que necesites.</div>'; return; }
  for (const t of turns) addMsg(t.role, t.role === "user" ? esc(t.content) : render(t.content));
  toBottom();
}
function setBusy(on) {
  busy = on;
  sendBtn.textContent = on ? "Detener" : "Enviar";
  sendBtn.type = on ? "button" : "submit";
}

// ===== Llamada al servidor (respuesta en streaming NDJSON) =====
async function callServer(messages, signal, onText) {
  const res = await fetch("/api/chat", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, mode: $("mode").value, tier: $("tier").value }),
  });
  if (!res.ok) {
    let msg = "Error " + res.status;
    try { msg = (await res.json()).error || msg; } catch {}
    throw { message: msg };
  }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "", text = "", truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.t) { text += ev.t; onText(text); }
        else if (ev.done) truncated = !!ev.truncated;
        else if (ev.error) throw { message: ev.error, text };
      }
    }
  } catch (e) {
    if (e?.name === "AbortError") throw { cancelled: true, text };
    throw e?.message ? { ...e, text: e.text ?? text } : { message: "Se cortó la conexión.", text };
  }
  if (!text) throw { message: "No llegó respuesta. Reformula la petición." };
  return { text, truncated };
}

async function ask(text) {
  if (busy || !text.trim()) return;
  if (!turns.length) thread.innerHTML = "";
  turns.push({ role: "user", content: text });
  addMsg("user", esc(text));
  const bubble = addMsg("bot", '<span class="thinking">Pensando</span>');
  toBottom();
  box.value = ""; autosize();
  setBusy(true);
  ctl = new AbortController();

  // Últimos turnos, empezando siempre en un mensaje del usuario
  const history = turns.slice(-20);
  while (history[0] && history[0].role !== "user") history.shift();

  try {
    const { text: answer, truncated } = await callServer(history, ctl.signal, (t) => {
      const stick = nearBottom(); bubble.innerHTML = render(t); if (stick) toBottom();
    });
    bubble.innerHTML = render(answer) + (truncated ? '<div class="note">Respuesta cortada por longitud. Pide “continúa”.</div>' : "");
    turns.push({ role: "assistant", content: answer });
  } catch (e) {
    if (e.text) { bubble.innerHTML = render(e.text); turns.push({ role: "assistant", content: e.text }); }
    else bubble.innerHTML = "";
    if (e.cancelled) { if (!e.text) bubble.innerHTML = '<div class="note">Detenido.</div>'; }
    else bubble.insertAdjacentHTML("beforeend", `<div class="err">${esc(e.message || "Error de conexión.")}</div>`);
  } finally {
    setBusy(false); save(); ctl = null;
  }
}

// ===== Eventos =====
function autosize() { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 200) + "px"; }
box.addEventListener("input", autosize);
box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(box.value); } });
form.addEventListener("submit", (e) => { e.preventDefault(); ask(box.value); });
sendBtn.addEventListener("click", () => { if (busy) ctl?.abort(); });
$("reset").addEventListener("click", () => { ctl?.abort(); turns = []; save(); drawAll(); box.focus(); });

load();
drawAll();
