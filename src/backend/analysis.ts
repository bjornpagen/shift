import { analyzeCodebase as apiAnalyzeCodebase } from "./api"
import type { Issue } from "../types"

const analysisInstructions = `You are an AI assistant tasked with analyzing codebases for architectural issues. Do not report stylistic issues, syntax errors, linter warnings, or low-level programming mistakes.

Note: The code provided has line numbers prepended to each line, like '1: function foo() {'.

Identify architectural issues and provide the output in JSON format. The JSON should be an array of objects, where each object represents an issue and has the following keys:

- "file": the full file path where the issue is located, as provided in the 'File: ' headers.
- "location": the specific lines of code where the issue is located, using the line numbers provided in the code (e.g., 'lines 10-15').
- "description": a concise summary of the issue (1-2 sentences, max 100 characters).
- "explanation": a detailed technical explanation of why it's a problem, from first principles (3-5 sentences).
- "suggestion": a suggested fix, with a brief explanation if necessary.

Ensure that the JSON is properly formatted and that strings do not contain unescaped quotes or other characters that would invalidate the JSON.

If no issues are found, return an empty array '[]'.

Here is an example of the desired output format:

[
  {
    "file": "/example/path/userController.ts",
    "location": "lines 5-10",
    "description": "Multiple database queries in loop.",
    "explanation": "The function getUserPosts runs a query per user in a loop to fetch posts. This N+1 query pattern scales poorly as user count grows, multiplying network latency and database load. Each call has overhead, and separate queries prevent database optimizations, slowing the app.",
    "suggestion": "Fetch all posts with one query like 'SELECT * FROM posts WHERE user_id IN (user_ids)' and map in memory. This cuts queries to one."
  },
  {
    "file": "/example/path/pages/index.tsx",
    "location": "lines 20-25",
    "description": "Server component used for dynamic data.",
    "explanation": "The UserProfile server component fetches dynamic data per request in Next.js. Server components are meant for static data, so this causes excessive re-renders and server load. Dynamic fetching fits client components better, avoiding unnecessary computation.",
    "suggestion": "Add 'use client' to UserProfile and use SWR or React Query for client-side fetching. This optimizes performance."
  }
]

**CRITICAL**: Output ONLY the JSON array. Do NOT include ANY text, explanations, or formatting (e.g., code blocks) before or after. The response must be valid JSON, parseable without modification.`

export async function analyze(userContent: string): Promise<Issue[]> {
  const responseContent = await apiAnalyzeCodebase(
    analysisInstructions,
    userContent
  )
  if (!responseContent) {
    return []
  }
  try {
    const issues = JSON.parse(responseContent)
    if (!Array.isArray(issues)) {
      console.error("Response is not an array:", responseContent)
      return []
    }
    return issues.map((issue) => ({
      file: issue.file,
      location: issue.location,
      description: issue.description,
      explanation: issue.explanation,
      suggestion: issue.suggestion
    }))
  } catch (error) {
    console.error("Failed to parse JSON response:", error)
    console.error("Response content:", responseContent)
    return []
  }
}
