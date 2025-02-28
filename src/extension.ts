import * as vscode from "vscode"
import OpenAI from "openai"

// Global state
const codebaseCache: Map<string, string> = new Map()
let isAnalyzing = false

export function activate(context: vscode.ExtensionContext) {
  console.log("Shift-V2 extension activated")

  // Load codebase into cache on startup
  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading codebase into cache...",
      cancellable: false
    },
    async (progress) => {
      const files = await vscode.workspace.findFiles(
        "**/*",
        "**/node_modules/**"
      )
      for (const file of files) {
        const content = await vscode.workspace.fs.readFile(file)
        codebaseCache.set(file.fsPath, content.toString("utf8"))
        progress.report({ increment: 100 / files.length })
      }
    }
  )

  // File system watcher for creates, deletes, and external changes
  const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*")
  fileWatcher.onDidCreate(async (uri) => {
    const content = await vscode.workspace.fs.readFile(uri)
    codebaseCache.set(uri.fsPath, content.toString("utf8"))
  })
  fileWatcher.onDidDelete((uri) => {
    codebaseCache.delete(uri.fsPath)
  })
  fileWatcher.onDidChange(async (uri) => {
    const openDocs = vscode.workspace.textDocuments.map((doc) => doc.fileName)
    if (!openDocs.includes(uri.fsPath)) {
      const content = await vscode.workspace.fs.readFile(uri)
      codebaseCache.set(uri.fsPath, content.toString("utf8"))
    }
  })

  // Analyze on file save
  const saveListener = vscode.workspace.onDidSaveTextDocument(
    async (document) => {
      codebaseCache.set(document.fileName, document.getText())
      if (!isAnalyzing) {
        isAnalyzing = true
        try {
          const issues = await analyzeCodebase()
          for (const issue of issues) {
            vscode.window
              .showInformationMessage(
                `Issue in ${issue.file}: ${issue.description}`,
                "See details"
              )
              .then((selection) => {
                if (selection === "See details") {
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

  // Register disposables
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
  const apiKey = vscode.workspace
    .getConfiguration("shift-v2")
    .get("openaiApiKey")
  if (!apiKey) {
    vscode.window.showErrorMessage(
      "OpenAI API key is not set. Please set it in the extension settings."
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
      console.error("No content received from OpenAI")
      return []
    }
    const jsonResponse = JSON.parse(responseContent)
    return jsonResponse.issues || []
  } catch (error) {
    console.error("Error during OpenAI API call:", error)
    vscode.window.showErrorMessage(
      "Failed to analyze codebase. See console for details."
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
    "Issue Details",
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
                  "Failed to get clarification. See console for details."
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
</head>
<body>
  <h1>Issue in ${issue.file}</h1>
  <p><strong>Location:</strong> ${issue.location}</p>
  <p><strong>Description:</strong> ${issue.description}</p>
  <p><strong>Explanation:</strong> ${issue.explanation}</p>
  <p><strong>Suggestion:</strong> ${issue.suggestion}</p>
  <button onclick="vscode.postMessage({ command: 'clarify' })">Clarify</button>
  <div id="response"></div>
  <script>
    const vscode = acquireVsCodeApi();
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'showResponse') {
        const responseDiv = document.getElementById('response');
        responseDiv.innerHTML = \`<p><strong>Response:</strong> \${message.text}</p>\`;
      }
    });
  </script>
</body>
</html>
`
}

export function deactivate() {
  console.log("Shift-V2 extension deactivated")
}
`
}

export function deactivate() {
  console.log("Shift-V2 extension deactivated")
}
`
}

export function deactivate() {
  console.log("Shift-V2 extension deactivated")
}
`
}

export function deactivate() {
  console.log("Shift-V2 extension deactivated")
}
`
}

export function deactivate() {
  console.log("Shift-V2 extension deactivated")
}
`
}

export function deactivate() {
  console.log("Shift-V2 extension deactivated")
}
