import { analyzeCodebase as apiAnalyzeCodebase } from "./api"
import { trySync } from "../utils/try-catch"
import type { Issue } from "../types"

const analysisInstructions = `
[...existing intro and architectural issue definitions unchanged...]

### Instructions for Analysis:
- Identify issues with a **clear, measurable impact** on performance, scalability, or maintainability (e.g., increased latency, excessive resource use, unnecessary complexity/dependencies).
- **Avoid buzzwords** like "separation of concerns" unless tied to a concrete consequence (e.g., "this doubles CPU usage").
- Do **not** flag stylistic choices or hypothetical problems without current evidence (e.g., "this caused a 500ms delay in tests").
- Focus on patterns where libraries, tools, or architectural choices mismatch the project's needs, backed by specific metrics or observations.

### Output Format:
- Return a JSON array of objects with these keys:
  - "file": full file path.
  - "location": specific lines (e.g., 'lines 10-15').
  - "description": concise summary (max 100 characters).
  - "explanation": detailed, measurable impact (3-5 sentences).
  - "suggestion": specific fix with brief justification.
  - "reasoning": a detailed explanation (**YOU MUST PROVIDE 5-7 SENTENCES**) that:
    - Explains the architectural issue in depth, referencing specific code (e.g., "the loop on lines 5-10 queries the database per user").
    - Quantifies its impact with metrics (e.g., "this fires 101 queries for 100 users, increasing latency by 5s").
    - Describes consequences if unaddressed (e.g., "server costs rise due to load").
    - Justifies the suggestion as the best fix (e.g., "a batch query reduces this to 2 queries").
    - Compares alternatives (e.g., "JOINs work but complicate the result set").
    Ensure reasoning focuses **more on the problem’s depth** than the solution.
- Always return a valid JSON array (e.g., [{ ... }] even for one issue).

**Example Output:**
[
  {
    "file": "/app/users.ts",
    "location": "lines 5-10",
    "description": "N+1 query in user fetch loop.",
    "explanation": "A loop runs a query per user, firing 100 queries for 100 users instead of 1. This increases latency as user count grows. It’s inefficient due to repeated network round-trips.",
    "suggestion": "Use a single 'SELECT * FROM posts WHERE user_id IN (...)' query to fetch all data at once.",
    "reasoning": "The loop on lines 5-10 iterates over each user and runs a separate database query to fetch their posts, creating an N+1 problem. For 100 users, this triggers 101 queries (1 for users, 100 for posts), causing latency to spike from 50ms to 5s as data scales. This strains the database with unnecessary overhead, as each query incurs network and processing costs. If unaddressed, server resource usage balloons, raising costs and slowing page loads for users. A single batch query with 'WHERE user_id IN (...)' cuts this to 2 queries, leveraging the database’s batch efficiency. Alternatives like JOINs could work but often return redundant user data, complicating parsing. This fix is optimal for its simplicity and performance gain."
  }
]

**CRITICAL**: Output ONLY the JSON array. No extra text.
`

export async function analyze(userContent: string): Promise<Issue[]> {
  const responseContent = await apiAnalyzeCodebase(
    analysisInstructions,
    userContent
  )
  if (!responseContent) {
    return []
  }
  const parseResult = trySync(() => JSON.parse(responseContent))
  if (parseResult.error) {
    console.error("Failed to parse JSON response:", parseResult.error)
    console.error("Response content:", responseContent)
    return []
  }
  let issues = parseResult.data
  if (!Array.isArray(issues)) {
    if (
      typeof issues === "object" &&
      issues !== null &&
      "file" in issues &&
      "location" in issues &&
      "description" in issues &&
      "explanation" in issues &&
      "suggestion" in issues &&
      "reasoning" in issues
    ) {
      issues = [issues] // Wrap single object in an array
    } else {
      console.error(
        "Response is not an array or a valid issue object:",
        responseContent
      )
      return []
    }
  }
  return issues.map((issue: Issue) => ({
    file: issue.file,
    location: issue.location,
    description: issue.description,
    explanation: issue.explanation,
    suggestion: issue.suggestion,
    reasoning: issue.reasoning
  }))
}