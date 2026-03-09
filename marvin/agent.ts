import * as readline from "node:readline";
import { readFileSync } from "node:fs";

// Load .env file
const env = readFileSync(".env", "utf-8");
for (const line of env.split("\n")) {
  const [key, ...vals] = line.split("=");
  if (key?.trim() && vals.length) {
    const v = vals.join("=").trim();
    if (v && !v.startsWith("#")) process.env[key.trim()] = v;
  }
}

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY in .env file");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q: string): Promise<string | null> =>
  new Promise((resolve) => {
    const handleClose = () => resolve(null);
    rl.once("close", handleClose);

    try {
      rl.question(q, (answer) => {
        rl.off("close", handleClose);
        resolve(answer);
      });
    } catch {
      rl.off("close", handleClose);
      resolve(null);
    }
  });

async function chat(userMessage: string): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

async function main() {
  while (true) {
    const input = await prompt("> ");
    if (input === null || input.trim().toLowerCase() === "exit") {
      break;
    }

    const reply = await chat(input);
    console.log(reply);
  }

  rl.close();
}

main().catch(console.error);
