const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4200;
const SEARCH_TIMEOUT_MS = 2500;
const LLM_RESERVE_MS = 1800;
const LLM_TIMEOUT_MS = 3000;
const QUERY_REWRITE_TIMEOUT_MS = 1000;
const RETRYABLE_LLM_ERRORS = ["LLM_EMPTY_RESPONSE", "LLM_REQUEST_FAILED", "LLM_QUOTA"];
const DEFAULT_LLM_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_LLM_MODEL = "qwen/qwen3.8-27b";
// Groq rate-limits each model separately, so a 429 on the main model can be retried on this one.
const DEFAULT_LLM_FALLBACK_MODEL = "openai/gpt-oss-120b";

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, только по-русски, без слов из других языков, кратко и так, чтобы ответ было удобно слушать.",
  "Числа, суммы, курсы и температуру пиши цифрами (например, 525,4 тенге, +15 °C): голосовой движок сам их правильно прочитает.",
  "Курс валют называй за 1 единицу, пересчитав при необходимости: не «18,3 рубля за 100 тенге», а «1 рубль — около 5,46 тенге».",
  "Если по одной из тем вопроса результатов поиска нет, не говори «данных нет»: скажи, что не успела найти, и предложи спросить про это ещё раз.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Поиск в интернете выполняется автоматически, его результаты приходят вместе с вопросом. Никогда не говори, что не умеешь искать.",
  "Результаты поиска свежее твоих знаний: если они расходятся с тем, что ты помнишь, верь поиску. Не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом.",
  "Твои знания могут быть устаревшими: если вопрос о текущем положении дел, а результатов поиска нет, скажи, что не получилось проверить в интернете, и предложи повторить вопрос."
].join(" ");

const QUERY_REWRITE_PROMPT = [
  "Перепиши последнюю реплику пользователя в короткий самодостаточный поисковый запрос с учётом контекста диалога.",
  "Ответь только запросом, без пояснений. Если в реплике две разные темы, напиши два запроса, каждый на отдельной строке.",
  "НЕТ отвечай только на реплики о самом разговоре или ассистенте (например «почему ты так ответила», «спасибо, понял»); на любой вопрос о мире, даже простой, пиши запрос.",
  "Примеры: после вопроса о последнем фильме Marvel «а когда он вышел» → дата выхода последнего фильма Marvel;",
  "«найди» или «поищи» без темы → поисковый запрос по предыдущему вопросу пользователя с названиями из диалога.",
  "Если спрашивают о последнем, новом или свежем, добавь в запрос текущий год, иначе поисковик вернёт старые статьи: «какой последний фильм марвел» → последний фильм Marvel 2026."
].join(" ");

// The model can't count weekdays, so name the nearest weekend explicitly.
function today(now = new Date()) {
  const format = date => date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });
  const weekday = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Moscow" })).getDay();
  const saturday = new Date(now.getTime() + ((6 - weekday + 7) % 7) * 86400000);
  const sunday = new Date(saturday.getTime() + 86400000);
  const date = now.toLocaleDateString("ru-RU", { dateStyle: "full", timeZone: "Europe/Moscow" });
  return `${date}, ближайшие выходные — ${format(saturday)} и ${format(sunday)}`;
}

function systemPrompt() {
  return `${SYSTEM_PROMPT} Сегодня ${today()}.`;
}

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(error => {
      if (error.name === "AbortError") throw error;
      return {};
    });
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

// Exa first (fresh highlights with real numbers, $10 of free credit every month); Serper if Exa
// errors out, e.g. when the monthly credit is spent. A timeout does not fall back: no time left.
async function searchWeb(query, timeoutMs, limit = 5) {
  if (timeoutMs < 150) return "";
  if (process.env.EXA_API_KEY) {
    const found = await searchExa(query, timeoutMs, limit);
    if (found !== null || !process.env.SERPER_API_KEY) return found || "";
  }
  return process.env.SERPER_API_KEY ? searchSerper(query, timeoutMs, limit) : "";
}

// Returns "" on timeout, null on an HTTP error so the caller can try another provider.
async function searchExa(query, timeoutMs, limit) {
  try {
    const { response, data } = await fetchJson(
      "https://api.exa.ai/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.EXA_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, type: "instant", numResults: limit, contents: { highlights: { maxCharacters: 400 } } })
      },
      Math.min(SEARCH_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Exa request failed with HTTP", response.status, data?.error || "");
      return null;
    }

    return (Array.isArray(data.results) ? data.results : [])
      .slice(0, limit)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const date = item.publishedDate ? ` (${String(item.publishedDate).slice(0, 10)})` : "";
        const highlights = (Array.isArray(item.highlights) ? item.highlights : []).join(" … ").replace(/\s+/g, " ").slice(0, 400);
        return `${i + 1}. ${title}${date}: ${highlights}`.trim();
      })
      .join("\n");
  } catch (error) {
    console.warn("Exa request did not finish in time; continuing without search.");
    return "";
  }
}

async function searchSerper(query, timeoutMs, limit) {
  const key = process.env.SERPER_API_KEY;

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: limit })
      },
      Math.min(SEARCH_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, limit)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

function buildPrompt(text, searchContext) {
  return searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
}

function checkLlmResponse(response, data, provider) {
  if (response.ok) return;
  const status = Number(response.status);
  console.error(`${provider} request failed with HTTP`, status, data?.error?.message || "");
  if (status === 401 || status === 403) throw new Error("LLM_KEY_REJECTED");
  if (status === 429) throw new Error("LLM_QUOTA");
  throw new Error("LLM_REQUEST_FAILED");
}

// Any OpenAI-compatible chat API: Groq by default, or set LLM_API_URL/LLM_MODEL.
async function chatCompletion(messages, options, timeoutMs) {
  const { response, data } = await fetchJson(
    process.env.LLM_API_URL || DEFAULT_LLM_API_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LLM_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || DEFAULT_LLM_MODEL,
        messages,
        ...options
      })
    },
    timeoutMs
  );
  checkLlmResponse(response, data, "LLM");
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

async function askOpenAiCompatible(text, history, searchContext, timeoutMs, model) {
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const answer = await chatCompletion([
    { role: "system", content: systemPrompt() },
    ...safeHistory(history).map(item => ({
      role: item.role === "model" ? "assistant" : "user",
      content: item.text
    })),
    { role: "user", content: buildPrompt(text, searchContext) }
  ], { max_tokens: 240, ...(model && { model }) }, Math.min(LLM_TIMEOUT_MS, timeoutMs));
  if (!answer) throw new Error("LLM_EMPTY_RESPONSE");
  return answer;
}

// Search everything except one-word small talk like «привет» or «спасибо».
function shouldSearch(text) {
  return isSearchIntent(text) || text.split(/\s+/).length > 1;
}

// The LLM turns the reply into up to two clean queries, resolving follow-ups like «а когда он вышел»
// from the dialog and splitting «погода в Актау и курс тенге» by topic; [] skips search.
async function buildSearchQueries(text, history) {
  const lastUserText = history.findLast(item => item.role === "user")?.text || "";
  const fallback = [`${lastUserText} ${text}`.trim()];
  if (!process.env.LLM_API_KEY) return fallback;

  const dialog = safeHistory(history)
    .map(item => `${item.role === "model" ? "Ассистент" : "Пользователь"}: ${item.text}`)
    .concat(`Пользователь: ${text}`)
    .join("\n");

  try {
    const answer = await chatCompletion([
      { role: "system", content: `${QUERY_REWRITE_PROMPT} Сегодня ${today()}.` },
      { role: "user", content: dialog }
    ], { max_tokens: 60, temperature: 0 }, QUERY_REWRITE_TIMEOUT_MS);
    if (/^нет[.!\s]*$/i.test(answer)) return /найди|поищи|\b(search|look up)\b/i.test(text) ? fallback : [];
    const queries = answer
      .split("\n")
      .map(line => line.replace(/^(\d+[.)]|[-•])\s+/, "").replace(/^["«](.*)["»]$/, "$1").trim())
      .filter(Boolean)
      .slice(0, 2);
    return queries.length ? queries : fallback;
  } catch (error) {
    console.warn("Search query rewrite failed; searching with the previous question:", error?.message || "unknown error");
    return fallback;
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_LLM_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  contents.push({ role: "user", parts: [{ text: buildPrompt(text, searchContext) }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt() }] },
        contents,
        generationConfig: {
          maxOutputTokens: 240
        }
      })
    },
    Math.min(LLM_TIMEOUT_MS, timeoutMs)
  );
  checkLlmResponse(response, data, "Gemini");

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("LLM_BLOCKED");
    throw new Error("LLM_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_LLM_KEY":
      return "Сервер пока не настроен. Добавьте LLM_API_KEY или GEMINI_API_KEY в настройках Vercel.";
    case "LLM_KEY_REJECTED":
      return "Не удалось подключиться к нейросети. Проверьте API-ключ в настройках Vercel.";
    case "LLM_QUOTA":
      return "Сейчас превышен лимит запросов к нейросети. Попробуйте немного позже.";
    case "LLM_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    let searchContext = "";
    let searchMs = 0;
    let queryMs = 0;
    if ((process.env.EXA_API_KEY || process.env.SERPER_API_KEY) && shouldSearch(text)) {
      const queryStartedAt = Date.now();
      const queries = await buildSearchQueries(text, oldHistory);
      queryMs = Date.now() - queryStartedAt;
      if (queries.length) {
        // Alice waits 4.5 s; leave LLM_RESERVE_MS for a fast model plus network, search gets the rest.
        const searchBudget = Math.min(SEARCH_TIMEOUT_MS, Math.max(0, remainingMs() - LLM_RESERVE_MS));
        const searchStartedAt = Date.now();
        // Two topics run in parallel with fewer results each to keep the prompt small.
        const found = await Promise.all(queries.map(query => searchWeb(query, searchBudget, queries.length > 1 ? 2 : 3)));
        searchMs = Date.now() - searchStartedAt;
        console.log(`Search ${searchMs}ms ${found.map(item => item ? "ok" : "empty").join("/")}: ${queries.join(" | ")}`);
        const noResults = "результатов нет, не называй по этой теме никаких цифр и фактов, скажи, что не успела найти";
        searchContext = queries.length > 1
          ? found.map((item, i) => `По запросу «${queries[i]}»: ${item ? `\n${item}` : noResults}`).join("\n\n")
          : found[0] || `Поиск: ${noResults}.`;
      }
    }

    const ask = process.env.LLM_API_KEY ? askOpenAiCompatible : askGemini;
    const askInBudget = model => ask(text, oldHistory, searchContext, Math.max(0, Math.min(LLM_TIMEOUT_MS, remainingMs() - 600)), model);
    const fallbackModel = process.env.LLM_FALLBACK_MODEL || (process.env.LLM_API_URL ? "" : DEFAULT_LLM_FALLBACK_MODEL);
    const llmStartedAt = Date.now();
    // Groq occasionally returns an empty answer or a 5xx; one retry fits in the budget.
    // A rate limit is retried on the fallback model, which has its own limits.
    const answer = await askInBudget().catch(error => {
      const quota = error?.message === "LLM_QUOTA";
      if (!RETRYABLE_LLM_ERRORS.includes(error?.message) || (quota && !fallbackModel) || remainingMs() < 1500) throw error;
      console.warn("Retrying LLM after:", error.message);
      return askInBudget(quota ? fallbackModel : undefined);
    }).finally(() => res.setHeader("Server-Timing", `query;dur=${queryMs}, search;dur=${searchMs}, llm;dur=${Date.now() - llmStartedAt}`));

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.name === "AbortError" ? new Error("TIME_BUDGET_EXHAUSTED") : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
