import OpenAI, { RateLimitError } from "openai"
import * as vscode from "vscode"
import { zodResponseFormat } from "openai/helpers/zod"
import { z } from "zod"
import type { Issue, KuzuIssue } from "../types"
import { tryCatch } from "../utils/try-catch"

const IssueSchema = z.object({
  file: z.string(),
  location: z.string(),
  description: z.string(),
  explanation: z.string(),
  suggestion: z.string(),
  reasoning: z.string()
})

const AnalysisSchema = z.object({
  issues: z.array(IssueSchema)
})

const ClarificationSchema = z.object({
  response: z.string().describe("Clarification response")
})

const analysisInstructions = `You are an AI assistant tasked with analyzing codebases for **architectural issues**. Architectural issues are problems that significantly impact the system's performance, scalability, maintainability, or other key qualities. They are **not** stylistic preferences, syntax errors, linter warnings, or minor programming mistakes.

Note: The code provided has line numbers prepended to each line, like '1: function foo() {'.

### Instructions for Analysis:
- Focus on identifying architectural issues within this snippet and its connections, such as inefficient data fetching, circular dependencies, or improper use of data models.
- Identify issues with a **clear, measurable impact** on performance, scalability, or maintainability (e.g., increased latency, excessive resource use, unnecessary complexity/dependencies).
- **Avoid buzzwords** like "separation of concerns" unless tied to a concrete consequence (e.g., "this doubles CPU usage").
- Do **not** flag stylistic choices or hypothetical problems without current evidence (e.g., "this caused a 500ms delay in tests").
- Focus on patterns where libraries, tools, or architectural choices mismatch the project's needs, backed by specific metrics or observations.

### Output Format:
- Return a JSON object with a single key "issues", which is an array of objects with these keys:
  - "file": full file path.
  - "location": specific lines (e.g., 'lines 10-15').
  - "description": concise summary (max 100 characters).
  - "explanation": detailed, measurable impact (3-5 sentences).
  - "suggestion": specific fix with brief justification.
  - "reasoning": detailed explanation of why this is an issue and how it affects the system.
`

async function retryWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  initialDelay = 1000,
  exponentialBase = 2,
  jitter = true,
  maxRetries = 10,
  errors: ErrorConstructor[] = [RateLimitError as unknown as ErrorConstructor],
  timeout = 30000
): Promise<T> {
  let delay = initialDelay
  let retries = 0
  while (true) {
    const result = await tryCatch<T>(
      Promise.race([
        fn(),
        new Promise<T>((_, reject) => {
          setTimeout(() => reject(new Error("Request timeout")), timeout)
        })
      ])
    )

    if (result.error === null) {
      return result.data as T
    }

    if (
      result.error instanceof Error &&
      result.error.message === "Request timeout"
    ) {
      throw new Error(`Request timed out after ${timeout}ms`)
    }

    if (!errors.some((E) => result.error instanceof E)) {
      throw result.error
    }

    retries++
    if (retries > maxRetries) {
      throw new Error(`Maximum number of retries (${maxRetries}) exceeded.`)
    }

    const sleepTime = delay * (jitter ? 1 + Math.random() : 1)
    await sleep(sleepTime)
    delay *= exponentialBase
  }
}

async function analyzeCodebaseInternal(
  system: string,
  user: string
): Promise<z.infer<typeof AnalysisSchema>> {
  const config = vscode.workspace.getConfiguration("shift-v2")
  const apiKey = config.get("openaiApiKey")
  if (!apiKey) {
    throw new Error("OpenAI API key is not set.")
  }
  const openai = new OpenAI({ apiKey: apiKey as string })

  const apiCall = async () => {
    vscode.window.setStatusBarMessage("Analyzing code...", 5000)
    const completion = await openai.beta.chat.completions.parse({
      model: "o3-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      response_format: zodResponseFormat(AnalysisSchema, "analysis")
    })

    if (!completion.choices[0].message.parsed) {
      throw new Error("Failed to parse response from OpenAI API.")
    }

    return completion.choices[0].message.parsed
  }

  return retryWithExponentialBackoff(
    apiCall,
    1000,
    2,
    true,
    10,
    [RateLimitError as unknown as ErrorConstructor],
    60000
  )
}

export async function analyze(
  userContent: string,
  kuzuIssues: KuzuIssue[]
): Promise<Issue[]> {
  try {
    const issuesContext = JSON.stringify(kuzuIssues, null, 2)
    const fullUserContent = `${userContent}\n\n## Additional Context\n### Graph Issues:\n${issuesContext}`

    vscode.window.setStatusBarMessage("Analyzing file...", 30000)
    const response = await analyzeCodebaseInternal(
      analysisInstructions,
      fullUserContent
    )
    vscode.window.setStatusBarMessage("Analysis complete", 3000)

    if (!response || !response.issues) {
      console.error("Invalid response from API:", response)
      return []
    }

    return response.issues
  } catch (error) {
    console.error("Error in analyze function:", error)
    vscode.window.showErrorMessage(
      `Analysis error: ${error instanceof Error ? error.message : "Unknown error"}`
    )
    return []
  }
}

export async function getClarification(prompt: string): Promise<string> {
  const config = vscode.workspace.getConfiguration("shift-v2")
  const apiKey = config.get("openaiApiKey")
  if (!apiKey) {
    throw new Error("OpenAI API key is not set.")
  }
  const openai = new OpenAI({ apiKey: apiKey as string })

  const apiCall = async () => {
    vscode.window.setStatusBarMessage("Getting clarification...", 5000)
    const completion = await openai.beta.chat.completions.parse({
      model: "o3-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: zodResponseFormat(ClarificationSchema, "clarification")
    })

    if (!completion.choices[0].message.parsed) {
      throw new Error("Failed to parse response from OpenAI API.")
    }

    return completion.choices[0].message.parsed.response
  }

  return retryWithExponentialBackoff(
    apiCall,
    1000,
    2,
    true,
    5,
    [RateLimitError as unknown as ErrorConstructor],
    30000
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type ErrorConstructor = {
  new (...args: unknown[]): Error
}
