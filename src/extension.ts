import * as vscode from "vscode"
import OpenAI from "openai"
import ignore from "ignore"

// Define a type for the ignore instance
interface IgnoreInstance {
  add: (pattern: string | string[]) => IgnoreInstance
  ignores: (path: string) => boolean
}

// Global state
const codebaseCache: Map<string, string> = new Map()
let isAnalyzing = false

// Helper to show debug notifications if debug mode is enabled
function showDebugNotification(message: string) {
  const config = vscode.workspace.getConfiguration("shift-v2")
  const debugMode = config.get("debugMode", false) // Changed default to false
  if (debugMode) {
    vscode.window.showInformationMessage(`[DEBUG] ${message}`)
  }
}

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

// Check if a file should be ignored
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
    console.debug("No workspace open, delaying activation")
    showDebugNotification("No workspace open, delaying activation")
    return
  }

  console.debug("Shift-V2 extension activated")
  showDebugNotification("Extension activated")

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
      showDebugNotification("Starting codebase cache load")
      const files = await vscode.workspace.findFiles(
        "**/*.{ts,js,tsx,jsx}",
        "**/node_modules/**"
      )
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
      for (const file of filteredFiles) {
        const content = await vscode.workspace.fs.readFile(file)
        codebaseCache.set(file.fsPath, new TextDecoder().decode(content))
        progress.report({ increment: 100 / filteredFiles.length })
      }
      showDebugNotification("Codebase cache load completed")
    }
  )

  const fileWatcher = vscode.workspace.createFileSystemWatcher(
    "**/*.{ts,js,tsx,jsx}"
  )
  fileWatcher.onDidCreate(async (uri) => {
    if (gitignore && (await isFileIgnored(uri.fsPath, gitignore))) {
      return
    }
    const content = await vscode.workspace.fs.readFile(uri)
    codebaseCache.set(uri.fsPath, new TextDecoder().decode(content))
  })
  fileWatcher.onDidDelete((uri) => {
    codebaseCache.delete(uri.fsPath)
  })
  fileWatcher.onDidChange(async (uri) => {
    if (gitignore && (await isFileIgnored(uri.fsPath, gitignore))) {
      return
    }
    const openDocs = vscode.workspace.textDocuments.map((doc) => doc.fileName)
    if (!openDocs.includes(uri.fsPath)) {
      const content = await vscode.workspace.fs.readFile(uri)
      codebaseCache.set(uri.fsPath, new TextDecoder().decode(content))
    }
  })

  const saveListener = vscode.workspace.onDidSaveTextDocument(
    async (document) => {
      if (gitignore && (await isFileIgnored(document.fileName, gitignore))) {
        return
      }
      codebaseCache.set(document.fileName, document.getText())

      if (!isAnalyzing) {
        isAnalyzing = true
        try {
          const issues = await analyzeCodebase()
          if (issues.length === 0) {
            vscode.window.showInformationMessage(
              "No architectural issues found."
            )
            return
          }

          for (const issue of issues) {
            vscode.window
              .showInformationMessage(
                `Issue in ${issue.file}: ${issue.description}`,
                "Tell Me More"
              )
              .then((selection) => {
                if (selection === "Tell Me More") {
                  showIssueDetails(issue)
                }
              })
          }
        } finally {
          isAnalyzing = false
        }
      }
    }
  )

  context.subscriptions.push(fileWatcher, saveListener)
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
  const apiKey = config.get("openaiApiKey")
  if (!apiKey) {
    vscode.window.showErrorMessage(
      "OpenAI API key is not set. Please configure it in settings."
    )
    return []
  }

  const openai = new OpenAI({ apiKey: apiKey as string })
  const prompt = preparePrompt(codebaseCache)

  try {
    const completion = await openai.chat.completions.create({
      model: "o3-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    })
    const responseContent = completion.choices[0].message.content
    if (!responseContent) {
      return []
    }
    return JSON.parse(responseContent).issues || []
  } catch (error) {
    console.error("Error during OpenAI API call:", error)
    vscode.window.showErrorMessage(
      "Failed to analyze codebase. Check console for details."
    )
    return []
  }
}

function preparePrompt(cache: Map<string, string>): string {
  let prompt = "# Codebase\n\n"
  for (const [filePath, content] of cache) {
    prompt += `## File: ${filePath}\n\n\`\`\`typescript\n${content}\n\`\`\`\n\n`
  }
  prompt += `
Analyze the above codebase and identify any architectural issues such as N+1 queries, suboptimal component usage, or inefficient data fetching. For each issue, provide:
- The file where the issue is located.
- A code snippet or function name to identify the location.
- A brief description of the issue.
- An explanation of why it's a problem.
- A suggested fix.
Return the response in JSON format with the following structure:
{
  "issues": [
    {
      "file": "string",
      "location": "string",
      "description": "string",
      "explanation": "string",
      "suggestion": "string"
    }
  ]
}
`
  return prompt
}

function showIssueDetails(issue: Issue) {
  const panel = vscode.window.createWebviewPanel(
    "shiftV2IssueDetails",
    `Issue in ${issue.file}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  )
  panel.webview.html = getIssueDetailsHtml(issue)

  panel.webview.onDidReceiveMessage((message) => {
    if (message.command === "clarify") {
      vscode.window
        .showInputBox({ prompt: "Ask your question about this issue" })
        .then((question) => {
          if (question) {
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
              .get("openaiApiKey")
            if (!apiKey) {
              vscode.window.showErrorMessage("OpenAI API key is not set.")
              return
            }
            const openai = new OpenAI({ apiKey: apiKey as string })
            openai.chat.completions
              .create({
                model: "o3-mini",
                messages: [{ role: "user", content: followUpPrompt }]
              })
              .then((completion) => {
                const response = completion.choices[0].message.content
                panel.webview.postMessage({
                  command: "showResponse",
                  text: response
                })
              })
              .catch((error) => {
                console.error("Error during clarification:", error)
                vscode.window.showErrorMessage(
                  "Failed to get clarification. See console."
                )
              })
          }
        })
    }
  })
}

function getIssueDetailsHtml(issue: Issue): string {
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
