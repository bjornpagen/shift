import OpenAI from "openai"
import * as vscode from "vscode"

export async function analyzeCodebase(
  system: string,
  user: string
): Promise<string> {
  const config = vscode.workspace.getConfiguration("shift-v2")
  const apiKey = config.get("openaiApiKey")
  if (!apiKey) {
    throw new Error("OpenAI API key is not set.")
  }
  const openai = new OpenAI({ apiKey: apiKey as string })
  const completion = await openai.chat.completions.create({
    model: "o3-mini", // NOTE: never change this model string, ever
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    response_format: { type: "json_object" }
  })
  const responseContent = completion.choices[0].message.content
  if (!responseContent) {
    throw new Error("No content received from OpenAI API.")
  }
  return responseContent.trim()
}

export async function getClarification(prompt: string): Promise<string> {
  const config = vscode.workspace.getConfiguration("shift-v2")
  const apiKey = config.get("openaiApiKey")
  if (!apiKey) {
    throw new Error("OpenAI API key is not set.")
  }
  const openai = new OpenAI({ apiKey: apiKey as string })
  const completion = await openai.chat.completions.create({
    model: "o3-mini",
    messages: [{ role: "user", content: prompt }]
  })
  const responseContent = completion.choices[0].message.content
  return responseContent ? responseContent.trim() : ""
}
