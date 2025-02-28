import * as vscode from "vscode"
import Anthropic from "@anthropic-ai/sdk"
import ignore from "ignore"

// Define a type for the ignore instance
interface IgnoreInstance {
  add: (pattern: string | string[]) => IgnoreInstance
  ignores: (path: string) => boolean
}

// Global state
const codebaseCache: Map<string, string> = new Map()
let isAnalyzing = false

// Parse .gitignore files and return an ignore instance
async function getGitignorePatterns(): Promise<IgnoreInstance> {
  const ig = ignore() as IgnoreInstance
  const gitignoreFiles = await vscode.workspace.findFiles(
    "**/.gitignore",
    "**/node_modules/**"
  )
  for (const file of gitignoreFiles) {
    const content = await vscode.workspace.fs.readFile(file)
    const gitignoreContent = new TextDecoder().decode(content)
    ig.add(gitignoreContent)
  }
  ig.add(["node_modules/**", "dist/**", "*.log"])
  return ig
}

// Check if a file should be ignored based on .gitignore patterns
async function isFileIgnored(
  filePath: string,
  ig: IgnoreInstance
): Promise<boolean> {
  const relativePath = vscode.workspace.asRelativePath(filePath, false)
  return ig.ignores(relativePath)
}

export function activate(context: vscode.ExtensionContext) {
  if (
    !vscode.workspace.workspaceFolders ||
    vscode.workspace.workspaceFolders.length === 0
  ) {
    console.debug(
      "No workspace open, delaying activation until a workspace is loaded"
    )
    return
  }

  console.debug("Shift-V2 extension activated")

  let gitignore: IgnoreInstance
  getGitignorePatterns().then((ig) => {
    gitignore = ig
  })

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading codebase into cache...",
      cancellable: false
    },
    async (progress) => {
      console.debug("Starting codebase cache load")
      const files = await vscode.workspace.findFiles(
        "**/*.{ts,js,tsx,jsx}",
        "**/node_modules/**"
      )
      console.debug(`Found ${files.length} files before filtering`)
      let filteredFiles = files
      if (gitignore) {
        filteredFiles = await Promise.all(
          files.map(async (file) => {
            const ignored = await isFileIgnored(file.fsPath, gitignore)
            return ignored ? null : file
          })
        ).then((results) =>
          results.filter((file): file is vscode.Uri => file !== null)
        )
      }
      console.debug(
        `Filtered to ${filteredFiles.length} files after .gitignore`
      )
      for (const file of filteredFiles) {
        const content = await vscode.workspace.fs.readFile(file)
        const decodedContent = new TextDecoder().decode(content)
        codebaseCache.set(file.fsPath, decodedContent)
        progress.report({ increment: 100 / filteredFiles.length })
        console.debug(`Cached file: ${file.fsPath}`)
      }
      console.debug("Codebase cache load completed")
    }
  )

  const fileWatcher = vscode.workspace.createFileSystemWatcher(
    "**/*.{ts,js,tsx,jsx}"
  )
  fileWatcher.onDidCreate(async (uri) => {
    if (gitignore && (await isFileIgnored(uri.fsPath, gitignore))) {
      return
    }
    console.debug(`File created: ${uri.fsPath}`)
    const content = await vscode.workspace.fs.readFile(uri)
    codebaseCache.set(uri.fsPath, new TextDecoder().decode(content))
    console.debug(`Cached new file: ${uri.fsPath}`)
  })
  fileWatcher.onDidDelete((uri) => {
    if (gitignore && codebaseCache.has(uri.fsPath)) {
      console.debug(`File deleted: ${uri.fsPath}`)
    }
    codebaseCache.delete(uri.fsPath)
    console.debug(`Removed from cache: ${uri.fsPath}`)
  })
  fileWatcher.onDidChange(async (uri) => {
    if (gitignore && (await isFileIgnored(uri.fsPath, gitignore))) {
      return
    }
    const openDocs = vscode.workspace.textDocuments.map((doc) => doc.fileName)
    if (!openDocs.includes(uri.fsPath)) {
      console.debug(`File changed externally: ${uri.fsPath}`)
      const content = await vscode.workspace.fs.readFile(uri)
      codebaseCache.set(uri.fsPath, new TextDecoder().decode(content))
      console.debug(`Updated cache for: ${uri.fsPath}`)
    }
  })

  const saveListener = vscode.workspace.onDidSaveTextDocument(
    async (document) => {
      if (gitignore && (await isFileIgnored(document.fileName, gitignore))) {
        return
      }
      console.debug(`File saved: ${document.fileName}`)
      codebaseCache.set(document.fileName, document.getText())
      console.debug(`Cache updated for: ${document.fileName}`)

      if (!isAnalyzing) {
        isAnalyzing = true
        console.debug("Starting codebase analysis")
        try {
          const issues = await analyzeCodebase()
          console.debug(`Found ${issues.length} issues`)

          for (const issue of issues) {
            console.debug(
              `Notifying issue in ${issue.file}: ${issue.description}`
            )
            await vscode.window
              .showWarningMessage(
                `Issue in ${issue.file}: ${issue.description}`,
                "Tell Me More"
              )
              .then((selection) => {
                if (selection === "Tell Me More") {
                  console.debug(`Showing details for issue in ${issue.file}`)
                  showIssueDetails(issue)
                }
              })
          }
        } finally {
          isAnalyzing = false
          console.debug("Codebase analysis completed")
        }
      } else {
        console.debug("Skipping analysis - already in progress")
      }
    }
  )

  context.subscriptions.push(fileWatcher, saveListener)
  console.debug("File watcher and save listener registered")
}

interface Issue {
  file: string
  location: string
  description: string
  explanation: string
  suggestion: string
}

async function analyzeCodebase(): Promise<Issue[]> {
  const config = vscode.workspace.getConfiguration("shift-v2")
  const apiKey = config.get("anthropicApiKey")
  if (!apiKey) {
    console.debug("No Anthropic API key found")
    vscode.window.showErrorMessage(
      "Anthropic API key is not set. Please set it in the extension settings."
    )
    return []
  }

  console.debug("Initializing Anthropic client")
  const anthropic = new Anthropic({ apiKey: apiKey as string })

  const analysisInstructions = `You are an AI assistant tasked with analyzing codebases for architectural issues. Analyze the provided codebase and identify any architectural issues such as N+1 queries, suboptimal component usage, or inefficient data fetching. For each issue, provide the following fields separated by a "|" character, with each issue separated by "---":

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

  let codebaseContent = "# Codebase\n\n"
  for (const [filePath, content] of codebaseCache) {
    codebaseContent += `## File: ${filePath}\n\n\`\`\`typescript\n${content}\n\`\`\`\n\n`
  }

  try {
    console.debug("Sending request to Anthropic API")
    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: analysisInstructions,
          cache_control: { type: "ephemeral" }
        }
      ],
      messages: [
        {
          role: "user",
          content: codebaseContent
        }
      ],
      temperature: 0 // Ensures consistent output
    })

    const responseContent = response.content[0].text.trim()
    console.debug("Received response from Anthropic:", responseContent)

    // Parse the plain text response
    if (!responseContent) {
      console.debug("No issues found in codebase")
      return []
    }

    const issueLines = responseContent
      .split("---")
      .filter((line) => line.trim())
    const issues: Issue[] = []

    for (const line of issueLines) {
      const [file, location, description, explanation, suggestion] =
        line.split("|")
      if (!file || !location || !description || !explanation || !suggestion) {
        console.error("Malformed issue line:", line)
        continue // Skip malformed lines
      }
      issues.push({
        file: file.trim(),
        location: location.trim(),
        description: description.trim(),
        explanation: explanation.trim(),
        suggestion: suggestion.trim()
      })
    }

    console.debug(`Parsed ${issues.length} issues from response`)
    return issues
  } catch (error) {
    console.error("Error during Anthropic API call:", error)
    vscode.window.showErrorMessage(
      "Failed to analyze codebase. See console for details."
    )
    return []
  }
}

function showIssueDetails(issue: Issue) {
  console.debug("Creating webview panel for issue details")
  const panel = vscode.window.createWebviewPanel(
    "shiftV2IssueDetails",
    `Issue in ${issue.file}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  )
  panel.webview.html = getIssueDetailsHtml(issue)
  console.debug("Webview panel created")

  panel.webview.onDidReceiveMessage((message) => {
    if (message.command === "clarify") {
      console.debug("Received clarify request from webview")
      vscode.window
        .showInputBox({ prompt: "Ask your question about this issue" })
        .then((question) => {
          if (question) {
            console.debug(`User asked: ${question}`)
            const followUpPrompt = `
Regarding the following issue:
File: ${issue.file}
Location: ${issue.location}
Description: ${issue.description}
Explanation: ${issue.explanation}
Suggestion: ${issue.suggestion}
The user has asked: "${question}"
Please provide a detailed response.
`
            const apiKey = vscode.workspace
              .getConfiguration("shift-v2")
              .get("anthropicApiKey")
            if (!apiKey) {
              console.debug("No Anthropic API key for clarification")
              vscode.window.showErrorMessage("Anthropic API key is not set.")
              return
            }
            console.debug("Sending clarification request to Anthropic")
            const anthropic = new Anthropic({ apiKey: apiKey as string })
            anthropic.messages
              .create({
                model: "claude-3-5-sonnet-20240620", // Adjust to 3.7 if available
                max_tokens: 1024,
                messages: [
                  {
                    role: "user",
                    content: followUpPrompt
                  }
                ]
              })
              .then((response) => {
                const clarification =
                  response.content[0].type === "text"
                    ? response.content[0].text
                    : ""
                console.debug("Received clarification response")
                panel.webview.postMessage({
                  command: "showResponse",
                  text: clarification
                })
              })
              .catch((error) => {
                console.error("Error during clarification:", error)
                vscode.window.showErrorMessage(
                  "Failed to get clarification. See console for details."
                )
              })
          }
        })
    }
  })
}

function getIssueDetailsHtml(issue: Issue): string {
  console.debug("Generating HTML for issue details")
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Issue Details</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; }
    h1 { font-size: 1.5em; }
    p { margin: 10px 0; }
    button { padding: 8px 16px; cursor: pointer; }
    #response { margin-top: 20px; }
  </style>
</head>
<body>
  <h1>Issue in ${issue.file}</h1>
  <p><strong>Location:</strong> ${issue.location}</p>
  <p><strong>Description:</strong> ${issue.description}</p>
  <p><strong>Explanation:</strong> ${issue.explanation}</p>
  <p><strong>Suggestion:</strong> ${issue.suggestion}</p>
  <button onclick="vscode.postMessage({ command: 'clarify' })">Ask for Clarification</button>
  <div id="response"></div>
  <script>
    const vscode = acquireVsCodeApi();
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'showResponse') {
        document.getElementById('response').innerHTML =
          '<h2>Clarification:</h2><p>' + message.text + '</p>';
      }
    });
  </script>
</body>
</html>
`
}
