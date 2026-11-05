// Провайдер ИИ: Z.ai (GLM) через OpenAI-совместимый endpoint.
// Ключ НИКОГДА не хранится в git и не передаётся в чат: читается из
// переменной окружения ZAI_API_KEY или файла ~/.dashgen/zai_api_key (chmod 600).
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  baseUrl: 'https://api.z.ai/api/paas/v4',
  model: 'glm-4.6',
  temperature: 0,
  timeoutMs: 240000,
  // генерация JSON не требует «размышлений»: отключаем thinking glm-4.6 (иначе запрос идёт минуты)
  thinking: { type: 'disabled' }
};

function readApiKey() {
  if (process.env.ZAI_API_KEY) return process.env.ZAI_API_KEY.trim();
  const keyFile = path.join(os.homedir(), '.dashgen', 'zai_api_key');
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim();
  throw new Error('Ключ Z.ai не найден: положите его в ~/.dashgen/zai_api_key (chmod 600) или задайте переменную ZAI_API_KEY. В чат и git ключ не вставляйте.');
}

// chat(aiCfg, system, prompt) → текст ответа модели
// Сетевые сбои (fetch failed) ретраятся 3 раза с паузой — разовые глюки DNS/TLS не роняют цикл.
async function chat(aiCfg, system, prompt) {
  const cfg = { ...DEFAULTS, ...(aiCfg || {}) };
  const apiKey = readApiKey();
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: cfg.temperature,
          thinking: cfg.thinking,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt }
          ]
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs)
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 401/403/402 — проблема ключа/баланса, ретраить бессмысленно
        if ([401, 402, 403].includes(res.status)) {
          throw new Error('ИИ-провайдер HTTP ' + res.status + ': ' + body.slice(0, 300));
        }
        throw Object.assign(new Error('ИИ-провайдер HTTP ' + res.status + ': ' + body.slice(0, 300)), { httpStatus: res.status });
      }
      const data = await res.json();
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text) throw new Error('Пустой ответ модели');
      return text;
    } catch (e) {
      lastErr = e;
      const retryable = !e.httpStatus || ![401, 402, 403].includes(e.httpStatus);
      if (retryable && attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

// Извлечение JSON из ответа модели: чистый JSON или блок ```json ... ```
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('В ответе модели нет JSON-объекта');
  return JSON.parse(raw.slice(start, end + 1));
}

module.exports = { chat, extractJson, DEFAULTS };
