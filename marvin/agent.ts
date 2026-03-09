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

// Step 3: Define the system prompt at the top of the file so the agent has an identity.
const SYSTEM_PROMPT = `You are Marvin, a coding assistant. You help users with programming tasks.

You have access to tools that let you interact with the filesystem and run commands.
Use tools proactively to understand a project before asking for paths or details.
Be concise and helpful.

Working directory: ${process.cwd()}`;

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

// Step 2: Gemini conversation messages are { role, parts } objects.
type GeminiFunctionCall = {
  name: string;
  args: Record<string, unknown>;
};

type GeminiPart = { text: string } | { functionCall: GeminiFunctionCall };

type GeminiMessage = {
  role: "user" | "model";
  parts: GeminiPart[];
};

// Step 2: Keep conversation history outside the loop so it persists across turns.
const messages: GeminiMessage[] = [];

async function chat(messages: GeminiMessage[]): Promise<GeminiMessage> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Step 3: Gemini system prompts go in top-level systemInstruction, not in contents.
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        // Step 4: Declare tools in the request so Gemini can ask to use them.
        tools: [
          {
            functionDeclarations: [
              {
                name: "list_files",
                description: "List files and directories at the given path",
                parameters: {
                  type: "object",
                  properties: {
                    directory: {
                      type: "string",
                      description: "Directory path to list",
                    },
                  },
                  required: ["directory"],
                },
              },
            ],
          },
        ],
        // Step 2: Send the full conversation history, not just the latest user message.
        contents: messages,
        generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const parts = data.candidates[0].content.parts;

  // Step 4: Detect Gemini tool calls by inspecting response.parts directly.
  const toolCallParts = parts.filter(
    (part: GeminiPart): part is { functionCall: GeminiFunctionCall } => "functionCall" in part,
  );

  // Step 4: Print tool calls, but do not execute them yet.
  for (const part of toolCallParts) {
    console.log(`🔧 ${part.functionCall.name}(${JSON.stringify(part.functionCall.args)})`);
  }

  return data.candidates[0].content;
}

async function main() {
  while (true) {
    const input = await prompt("> ");
    if (input === null || input.trim().toLowerCase() === "exit") {
      break;
    }

    // Step 2: Append the user's input as a Gemini user message.
    messages.push({ role: "user", parts: [{ text: input }] });

    const reply = await chat(messages);
    // Step 4: If Gemini returned a tool call, stop here after logging it.
    const hasToolCall = reply.parts.some((part) => "functionCall" in part);
    if (hasToolCall) {
      continue;
    }

    // Step 2: Append Gemini's model message so later turns can reference it.
    messages.push(reply);
    // Step 4: Only print a normal reply when the response contains text instead of a tool call.
    const textPart = reply.parts.find((part): part is { text: string } => "text" in part);
    if (textPart) {
      console.log(textPart.text);
    }
  }

  rl.close();
}

main().catch(console.error);
