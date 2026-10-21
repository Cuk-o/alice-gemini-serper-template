import test from "node:test";
import assert from "node:assert/strict";
import { aliceResponse, fitAliceText, isPersonalQuestion, isSearchIntent, safeHistory } from "../api/index.js";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 12", () => {
  const input = Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 12);
  assert.equal(result[0].text, "4");
  assert.equal(result[11].text, "15");
});

test("GET health check returns an ok response", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-gemini-serper");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
});

async function askHandler(command, history = [], session = {}) {
  const handler = (await import("../api/index.js")).default;
  let payload;
  const res = {
    status() { return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { session, request: { command }, state: { session: { history } } } }, res);
  return payload;
}

test("slow model answer becomes a timeout message", async t => {
  t.mock.method(globalThis, "fetch", (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
  }));
  process.env.LLM_API_KEY = "test";
  t.after(() => delete process.env.LLM_API_KEY);
  const payload = await askHandler("привет");
  assert.match(payload.response.text, /Не успела/);
});

test("OpenAI-compatible provider is used when LLM_API_KEY is set", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ choices: [{ message: { content: "Привет!" } }] }),
    { status: 200 }
  ));
  process.env.LLM_API_KEY = "test";
  t.after(() => delete process.env.LLM_API_KEY);
  const payload = await askHandler("привет");
  assert.equal(payload.response.text, "Привет!");
  assert.match(fetchMock.mock.calls[0].arguments[0], /groq/);
  assert.equal(payload.session_state.history.at(-1).role, "model");
});

test("searches everything except one-word small talk, rewriting follow-ups", async t => {
  const serperQueries = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes("serper")) {
      serperQueries.push(body.q);
      return new Response(JSON.stringify({ organic: [{ title: "t", snippet: "s", link: "l" }] }), { status: 200 });
    }
    const question = body.messages.at(-1).content.split("Пользователь: ").at(-1);
    const rewrite = question.includes("вышел") ? "дата выхода последнего фильма Marvel" : question;
    const content = body.max_tokens === 60 ? rewrite : "ответ";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
  process.env.LLM_API_KEY = "test";
  process.env.SERPER_API_KEY = "test";
  t.after(() => { delete process.env.LLM_API_KEY; delete process.env.SERPER_API_KEY; });

  await askHandler("спасибо");
  await askHandler("кто чемпион мира");
  await askHandler("а когда он вышел", [{ role: "user", text: "последний фильм марвел" }, { role: "model", text: "ответ" }]);
  assert.deepEqual(serperQueries, ["кто чемпион мира", "дата выхода последнего фильма Marvel"]);
});

test("follow-up search falls back to the previous question when rewrite fails", async t => {
  const serperQueries = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes("serper")) {
      serperQueries.push(body.q);
      return new Response("{}", { status: 200 });
    }
    if (body.max_tokens === 60) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ответ" } }] }), { status: 200 });
  });
  process.env.LLM_API_KEY = "test";
  process.env.SERPER_API_KEY = "test";
  t.after(() => { delete process.env.LLM_API_KEY; delete process.env.SERPER_API_KEY; });

  await askHandler("а когда он вышел", [{ role: "user", text: "последний фильм марвел" }, { role: "model", text: "ответ" }]);
  assert.deepEqual(serperQueries, ["последний фильм марвел а когда он вышел"]);
});

test("rewrite NO skips search for meta questions but never for explicit «найди»", async t => {
  const serperQueries = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes("serper")) {
      serperQueries.push(body.q);
      return new Response("{}", { status: 200 });
    }
    const content = body.max_tokens === 60 ? "НЕТ" : "ответ";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
  process.env.LLM_API_KEY = "test";
  process.env.SERPER_API_KEY = "test";
  t.after(() => { delete process.env.LLM_API_KEY; delete process.env.SERPER_API_KEY; });

  const history = [{ role: "user", text: "последний фильм марвел" }, { role: "model", text: "ответ" }];
  await askHandler("почему ты сразу не сказала", history);
  await askHandler("найди", history);
  assert.deepEqual(serperQueries, ["последний фильм марвел найди"]);
});

test("empty LLM answer is retried once", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    const content = calls === 1 ? "" : "Всё отлично!";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
  process.env.LLM_API_KEY = "test";
  t.after(() => delete process.env.LLM_API_KEY);
  const payload = await askHandler("как дела");
  assert.equal(payload.response.text, "Всё отлично!");
  assert.equal(calls, 2);
});

test("two topics become two parallel searches", async t => {
  const serperQueries = [];
  let answerPrompt = "";
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes("serper")) {
      serperQueries.push([body.q, body.num]);
      const organic = body.q.includes("курс") ? [] : [{ title: body.q, snippet: "s", link: "l" }];
      return new Response(JSON.stringify({ organic }), { status: 200 });
    }
    if (body.max_tokens === 60) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "1. погода в Актау на выходные\n2. курс тенге к рублю" } }] }), { status: 200 });
    }
    answerPrompt = body.messages.at(-1).content;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ответ" } }] }), { status: 200 });
  });
  process.env.LLM_API_KEY = "test";
  process.env.SERPER_API_KEY = "test";
  t.after(() => { delete process.env.LLM_API_KEY; delete process.env.SERPER_API_KEY; });

  await askHandler("а в актау на выходных и курс кз-рф подскажи");
  assert.deepEqual(serperQueries, [["погода в Актау на выходные", 2], ["курс тенге к рублю", 2]]);
  assert.match(answerPrompt, /По запросу «погода в Актау на выходные»/);
  assert.match(answerPrompt, /По запросу «курс тенге к рублю»: результатов нет/);
});

test("Exa is used first and Serper only when Exa returns an error", async t => {
  const calls = [];
  let exaStatus = 200;
  let answerPrompt = "";
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes("exa.ai")) {
      calls.push("exa");
      if (exaStatus !== 200) return new Response(JSON.stringify({ error: "credits exhausted" }), { status: exaStatus });
      return new Response(JSON.stringify({ results: [{ title: "Погода в Астане", publishedDate: "2026-10-21T00:00:00Z", highlights: ["днём +6…+8 °C"] }] }), { status: 200 });
    }
    if (url.includes("serper")) {
      calls.push("serper");
      return new Response(JSON.stringify({ organic: [{ title: "Serper", snippet: "s", link: "l" }] }), { status: 200 });
    }
    if (body.max_tokens !== 60) answerPrompt = body.messages.at(-1).content;
    return new Response(JSON.stringify({ choices: [{ message: { content: body.max_tokens === 60 ? "погода в Астане" : "ответ" } }] }), { status: 200 });
  });
  process.env.LLM_API_KEY = "test";
  process.env.EXA_API_KEY = "test";
  process.env.SERPER_API_KEY = "test";
  t.after(() => { delete process.env.LLM_API_KEY; delete process.env.EXA_API_KEY; delete process.env.SERPER_API_KEY; });

  await askHandler("какая погода в астане");
  assert.deepEqual(calls, ["exa"]);
  assert.match(answerPrompt, /Погода в Астане \(2026-10-21\): днём \+6…\+8 °C/);

  exaStatus = 402;
  await askHandler("какая погода в астане");
  assert.deepEqual(calls, ["exa", "exa", "serper"]);
});

test("rate-limited answer is retried on the fallback model", async t => {
  const models = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    models.push(body.model);
    if (models.length === 1) return new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "Привет!" } }] }), { status: 200 });
  });
  process.env.LLM_API_KEY = "test";
  t.after(() => delete process.env.LLM_API_KEY);
  const payload = await askHandler("привет");
  assert.equal(payload.response.text, "Привет!");
  assert.deepEqual(models, ["qwen/qwen3.8-27b", "openai/gpt-oss-120b"]);
});

test("memory remembers facts across sessions and forgets on request", async t => {
  const store = new Map();
  let answerPrompt = "";
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/pipeline")) {
      return new Response(JSON.stringify(body.map(([cmd, key, value]) => {
        if (cmd === "GET") return { result: store.get(key) ?? null };
        store.set(key, value);
        return { result: "OK" };
      })), { status: 200 });
    }
    answerPrompt = body.messages.at(-1).content;
    return new Response(JSON.stringify({ choices: [{ message: { content: "Барсик." } }] }), { status: 200 });
  });
  process.env.LLM_API_KEY = "test";
  process.env.KV_REST_API_URL = "https://redis.test";
  process.env.KV_REST_API_TOKEN = "test";
  t.after(() => { delete process.env.LLM_API_KEY; delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; });
  const session = { application: { application_id: "device-1" } };

  assert.equal((await askHandler("запомни что кота зовут Барсик", [], session)).response.text, "Запомнила.");
  // A new session sends no session_state history; memory comes from Redis.
  await askHandler("как зовут кота", [], session);
  assert.match(answerPrompt, /кота зовут Барсик/);
  assert.equal(JSON.parse(store.get("alice:device-1")).history.length, 4);

  assert.equal((await askHandler("забудь всё", [], session)).response.text, "Готово, я всё забыла.");
  assert.deepEqual(JSON.parse(store.get("alice:device-1")), { history: [], facts: [] });
});

test("personal questions are recognized, questions about the world are not", () => {
  for (const q of ["как зовут моего кота", "напомни есть ли у меня животные", "что я просил запомнить", "когда день рождения моей мамы"]) assert.equal(isPersonalQuestion(q), true, q);
  for (const q of ["есть ли у кошек паразиты", "какая погода в омске", "мойка машин рядом", "кто чемпион мира"]) assert.equal(isPersonalQuestion(q), false, q);
});

test("only the configured skill may call the webhook", async t => {
  process.env.ALICE_SKILL_ID = "my-skill";
  t.after(() => delete process.env.ALICE_SKILL_ID);
  let status;
  const res = { status(code) { status = code; return this; }, json() {}, setHeader() {} };
  const handler = (await import("../api/index.js")).default;
  await handler({ method: "POST", body: { session: { skill_id: "someone-else" }, request: { command: "привет" } } }, res);
  assert.equal(status, 403);
  assert.match((await askHandler("", [], { skill_id: "my-skill" })).response.text, /Привет/);
});

test("ping is answered without calling the LLM", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not be called"); });
  process.env.LLM_API_KEY = "test";
  t.after(() => delete process.env.LLM_API_KEY);
  assert.equal((await askHandler("ping")).response.text, "ok");
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("session_state is trimmed to the Yandex size limit", () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: "ответ ".repeat(30) + i }));
  const state = aliceResponse("x", false, history).session_state;
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 1000);
  assert.equal(state.history.at(-1).text, history.at(-1).text);
});
