// /api/ai.js
const fetch = require('node-fetch');

async function askGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ]
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  try {
    const json = JSON.parse(text);
    if (json?.contents?.[0]?.parts) {
      return json.contents[0].parts.map(p => p.text || "").join("\n");
    }
    return text;
  } catch (err) {
    return text;
  }
}

module.exports = { askGemini };
