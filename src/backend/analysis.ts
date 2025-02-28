import { analyzeCodebase as apiAnalyzeCodebase } from "./api"
import type { Issue } from "../types"

const analysisInstructions = `You are an AI assistant tasked with analyzing codebases for architectural issues. Focus exclusively on high-level architectural problems such as inefficient data fetching, suboptimal component usage, or poor separation of concerns. Do not report stylistic issues, syntax errors, linter warnings, or low-level programming mistakes.

When given the full codebase initially, store it in your context. For subsequent requests, analyze the provided diff or changed file content in the context of the previously seen codebase.

Identify architectural issues and provide the following fields for each issue, separated by a "|" character, with each issue separated by "---":

- The file where the issue is located.
- A code snippet or function name to identify the location.
- A concise summary of the issue (1-2 sentences, max 100 characters).
- A detailed technical explanation of why it's a problem, from first principles (3-5 sentences).
- A suggested fix, with a brief explanation if necessary.

Ensure that the fields do not contain the '|' or '---' characters.

**Important**: Respond with plain text only, using this exact format. Do not include JSON, extra explanations, or any text outside the issue list. Use "---" to separate issues and "|" to separate fields within an issue. If no issues are found, return an empty string.

Example response:
userController.ts|function getUserPosts|Multiple database queries in loop.|The function getUserPosts runs a query per user in a loop to fetch posts. This N+1 query pattern scales poorly as user count grows, multiplying network latency and database load. Each call has overhead, and separate queries prevent database optimizations, slowing the app.|Fetch all posts with one query like "SELECT * FROM posts WHERE user_id IN (user_ids)" and map in memory. This cuts queries to one.---
pages/index.tsx|component UserProfile|Server component used for dynamic data.|The UserProfile server component fetches dynamic data per request in Next.js. Server components are meant for static data, so this causes excessive re-renders and server load. Dynamic fetching fits client components better, avoiding unnecessary computation.|Add 'use client' to UserProfile and use SWR or React Query for client-side fetching. This optimizes performance.
`

export async function analyze(userContent: string): Promise<Issue[]> {
  const responseContent = await apiAnalyzeCodebase(
    analysisInstructions,
    userContent
  )
  if (!responseContent) {
    return []
  }
  const issueLines = responseContent
    .split("---")
    .filter((line: string) => line.trim())
  const issues: Issue[] = []
  for (const line of issueLines) {
    const [file, location, description, explanation, suggestion] =
      line.split("|")
    if (!file || !location || !description || !explanation || !suggestion) {
      console.error("Malformed issue line:", line)
      continue
    }
    issues.push({
      file: file.trim(),
      location: location.trim(),
      description: description.trim(), // Now the concise summary
      explanation: explanation.trim(), // Now the detailed explanation
      suggestion: suggestion.trim()
    })
  }
  return issues
}
