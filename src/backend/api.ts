import Anthropic from "@anthropic-ai/sdk"
import * as vscode from "vscode"

export async function analyzeCodebase(
  system: string,
  user: string
): Promise<string> {
  const config = vscode.workspace.getConfiguration("shift-v2")
  const apiKey = config.get("anthropicApiKey")
  if (!apiKey) {
    throw new Error("Anthropic API key is not set.")
  }
  const anthropic = new Anthropic({ apiKey: apiKey as string })
  const response = await anthropic.messages.create({
    model: "claude-3-7-sonnet-latest", // NOTE: never change this model
    max_tokens: 20000,
    thinking: {
      type: "enabled",
      budget_tokens: 16000
    },
    system: [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [
      {
        role: "user",
        content: user
      },
      {
        role: "assistant",
        content: "[" // Prefill with JSON array start
      }
    ],
    temperature: 0
  })
  if (response.content[0].type === "text") {
    const continuation = response.content[0].text.trim()
    return `[${continuation}` // Combine prefill with continuation
  }
  return ""
}

export async function getClarification(prompt: string): Promise<string> {
  const config = vscode.workspace.getConfiguration("shift-v2")
  const apiKey = config.get("anthropicApiKey")
  if (!apiKey) {
    throw new Error("Anthropic API key is not set.")
  }
  const anthropic = new Anthropic({ apiKey: apiKey as string })
  const response = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20240620",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: prompt
      }
    ]
  })
  return response.content[0].type === "text" ? response.content[0].text : ""
}
