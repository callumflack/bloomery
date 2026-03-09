import * as readline from "node:readline";
// Step 7: Import execSync so the agent can run bash commands.
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

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

type GeminiFunctionResponse = {
  name: string;
  response: {
    name: string;
    content: string;
  };
};

type GeminiPart =
  | { text: string }
  | { functionCall: GeminiFunctionCall }
  | { functionResponse: GeminiFunctionResponse };

type GeminiMessage = {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
};

// Step 2: Keep conversation history outside the loop so it persists across turns.
const messages: GeminiMessage[] = [];

const getToolCallParts = (
  parts: GeminiPart[],
): Array<{ functionCall: GeminiFunctionCall }> =>
  parts.filter(
    (part: GeminiPart): part is { functionCall: GeminiFunctionCall } => "functionCall" in part,
  );

// Step 6: Route tool execution by tool name instead of hardcoding a single tool.
function runToolCall(toolCall: GeminiFunctionCall): string {
  switch (toolCall.name) {
    case "list_files": {
      const directory =
        typeof toolCall.args.directory === "string" ? toolCall.args.directory : ".";

      try {
        return readdirSync(directory).join("\n");
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }

    case "read_file": {
      const path = typeof toolCall.args.path === "string" ? toolCall.args.path : "";

      try {
        return readFileSync(path, "utf-8");
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }

    // Step 7: Route run_bash tool calls into a real shell command execution path.
    case "run_bash": {
      // Step 7: Read the command argument that Gemini asked the runtime to execute.
      const command = typeof toolCall.args.command === "string" ? toolCall.args.command : "";

      try {
        // Step 7: Run the command with a 30 second timeout and capture output as text.
        const output = execSync(command, {
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 30_000,
          shell: "/bin/bash",
        });

        return output;
      } catch (error: unknown) {
        // Step 7: Non-zero exits should return output, not crash the agent.
        const commandError = error as {
          stdout?: { toString(): string };
          stderr?: { toString(): string };
          status?: number | string;
        };
        const stdout = commandError.stdout?.toString?.() ?? "";
        const stderr = commandError.stderr?.toString?.() ?? "";
        const status = commandError.status ?? "unknown";
        const combined = `${stdout}${stderr}`.trim();

        return combined ? `Exit code ${status}: ${combined}` : `Exit code ${status}`;
      }
    }

    default:
      return `Unknown tool: ${toolCall.name}`;
  }
}

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
              // Step 6: Declare a read_file tool so Gemini can request file contents by path.
              {
                name: "read_file",
                description: "Read the contents of a file at the given path",
                parameters: {
                  type: "object",
                  properties: {
                    path: {
                      type: "string",
                      description: "File path to read",
                    },
                  },
                  required: ["path"],
                },
              },
              // Step 7: Declare a run_bash tool so Gemini can execute shell commands.
              {
                name: "run_bash",
                description: "Execute a bash command and return its output",
                parameters: {
                  type: "object",
                  properties: {
                    command: {
                      type: "string",
                      description: "Bash command to execute",
                    },
                  },
                  required: ["command"],
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
  const toolCallParts = getToolCallParts(parts);

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

    // Step 5: Keep looping until Gemini stops asking for tools and returns text.
    while (true) {
      const reply = await chat(messages);
      const toolCallParts = getToolCallParts(reply.parts);

      // Step 5: Append Gemini's tool-call message before sending function results back.
      messages.push(reply);

      if (toolCallParts.length > 0) {
        const functionResponseParts = toolCallParts.map(({ functionCall }) => {
          const result = runToolCall(functionCall);

          // Step 5: Print the real tool result so you can see what the runtime executed.
          console.log(`📄 ${result}`);

          return {
            functionResponse: {
              name: functionCall.name,
              response: {
                name: functionCall.name,
                content: result,
              },
            },
          };
        });

        // Step 5: Send all tool results back in a single Gemini function-role message.
        messages.push({
          role: "function",
          parts: functionResponseParts,
        });
        continue;
      }

      // Step 5: Once there are no tool calls, print the final text answer and stop looping.
      const textPart = reply.parts.find((part): part is { text: string } => "text" in part);
      if (textPart) {
        console.log(textPart.text);
      }

      break;
    }
  }

  rl.close();
}

main().catch(console.error);
