# El Chicho

IA que programa en cualquier lenguaje, funciona como diccionario y explica conceptos. Usa Claude (Anthropic).

## Desplegar en Render

1. En [Render](https://dashboard.render.com) → **New → Blueprint** y elige este repositorio (usa `render.yaml`).
2. Cuando lo pida, pega tu `ANTHROPIC_API_KEY` (de [console.anthropic.com](https://console.anthropic.com)).
3. Listo: la web queda en `https://chicho-ia.onrender.com` (o el nombre que asigne Render).

Usa **Claude Fable 5.1**, el modelo más capaz de Anthropic (cámbialo con la variable `CHICHO_MODEL`, p. ej. `claude-opus-5-5`, más barato). La API key solo vive en el servidor. Cada mensaje se cobra a esa cuenta; hay un límite de 20 mensajes cada 10 minutos por IP (`RATE_MAX`, `RATE_WINDOW_MIN`).

## Local

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Abre http://localhost:3000
