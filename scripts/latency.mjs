// Usage: node scripts/latency.mjs https://YOUR-PROJECT.vercel.app/api [count]
const [url, count = "5"] = process.argv.slice(2);
if (!url) {
  console.error("Usage: node scripts/latency.mjs https://YOUR-PROJECT.vercel.app/api [count]");
  process.exit(1);
}

const GAP_MS = 4500; // free Gemini tier allows 15 requests per minute
const questions = [
  "привет",
  "сколько планет в солнечной системе",
  "кто написал войну и мир",
  "почему небо голубое",
  "как сказать кошка по-английски"
];

const times = [];
for (let i = 0; i < Number(count); i++) {
  if (i) await new Promise(resolve => setTimeout(resolve, GAP_MS));
  const command = questions[i % questions.length];
  const startedAt = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: "1.0",
      session: { new: false },
      request: { command, original_utterance: command, type: "SimpleUtterance" },
      state: { session: { history: [] } }
    })
  });
  const data = await response.json();
  const ms = Math.round(performance.now() - startedAt);
  times.push(ms);
  console.log(`${ms}ms | ${response.headers.get("server-timing") ?? "-"} | ${response.headers.get("x-vercel-id")} | ${command} → ${data.response?.text}`);
}

times.sort((a, b) => a - b);
console.log(`median ${times[times.length >> 1]}ms, max ${times.at(-1)}ms`);
