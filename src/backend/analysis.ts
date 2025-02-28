import { analyzeCodebase as apiAnalyzeCodebase } from "./api"
import type { Issue } from "../types"

const analysisInstructions = `You are an AI assistant tasked with analyzing codebases for architectural issues. When given the full codebase initially, store it in your context. For subsequent requests, analyze the provided diff or changed file content in the context of the previously seen codebase. Identify architectural issues such as N+1 queries, suboptimal component usage, or inefficient data fetching. For each issue, provide the following fields separated by a "|" character, with each issue separated by "---":

- The file where the issue is located.
- A code snippet or function name to identify the location.
- A brief description of the issue.
- An explanation of why it's a problem.
- A suggested fix.

**Important**: Respond with plain text only, using this exact format. Do not include JSON, extra explanations, or any text outside the issue list. Use "---" to separate issues and "|" to separate fields within an issue. If no issues are found, return an empty string.

Example response:
file1.ts|function fetchData|N+1 query detected|Multiple database queries in a loop reduce performance|Use a single batch query instead---
file2.js|component render|Suboptimal component usage|Re-rendering occurs due to missing memoization|Add React.memo to prevent unnecessary renders
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
      description: description.trim(),
      explanation: explanation.trim(),
      suggestion: suggestion.trim()
    })
  }
  return issues
}
