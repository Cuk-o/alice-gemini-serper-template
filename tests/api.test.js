import test from "node:test";
import assert from "node:assert/strict";
import { aliceResponse, fitAliceText, isSearchIntent, safeHistory } from "../api/index.js";

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

test("history filters malformed messages and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");
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

async function askHandler(command) {
  const handler = (await import("../api/index.js")).default;
  let payload;
  const res = {
    status() { return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command }, state: { session: { history: [] } } } }, res);
  return payload;
}

test("slow model answer becomes a timeout message", async t => {
  t.mock.method(globalThis, "fetch", (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
  }));
  process.env.GEMINI_API_KEY = "test";
  t.after(() => delete process.env.GEMINI_API_KEY);
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

test("model decides when to search and writes the query", async t => {
  const serperQueries = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes("serper")) {
      serperQueries.push(body.q);
      return new Response(JSON.stringify({ organic: [{ title: "t", snippet: "s", link: "l" }] }), { status: 200 });
    }
    const isDecision = body.max_tokens === 40;
    const question = body.messages.at(-1).content;
    const content = isDecision ? (question.includes("чемпион") ? "ПОИСК: чемпион мира по футболу 2026" : "НЕТ") : "ответ";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
  process.env.LLM_API_KEY = "test";
  process.env.SERPER_API_KEY = "test";
  t.after(() => { delete process.env.LLM_API_KEY; delete process.env.SERPER_API_KEY; });

  await askHandler("почему небо голубое");
  await askHandler("кто чемпион мира");
  assert.deepEqual(serperQueries, ["чемпион мира по футболу 2026"]);
});
