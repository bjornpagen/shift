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
  const debugMode = config.get("debugMode", true)
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
  // Add default exclusions
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
  // Check if a workspace is open
  if (
    !vscode.workspace.workspaceFolders ||
    vscode.workspace.workspaceFolders.length === 0
  ) {
    console.debug(
      "No workspace open, delaying activation until a workspace is loaded"
    )
    showDebugNotification("No workspace open, delaying activation")
    return
  }

  console.debug("Shift-V2 extension activated")
  showDebugNotification("Extension activated")

  // Load gitignore patterns once at startup
  let gitignore: IgnoreInstance
  getGitignorePatterns().then((ig) => {
    gitignore = ig
  })

  // Load codebase into cache when a workspace is confirmed
  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading codebase into cache...",
      cancellable: false
    },
    async (progress) => {
      showDebugNotification("Starting codebase cache load")
      const files = await vscode.workspace.findFiles(
        "**/*.{ts,js,tsx,jsx}", // Include common code file types
        "**/node_modules/**" // Base exclusion
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
        showDebugNotification(`Cached file: ${file.fsPath}`)
      }
      showDebugNotification("Codebase cache load completed")
    }
  )

  // File system watcher for creates, deletes, and external changes
  const fileWatcher = vscode.workspace.createFileSystemWatcher(
    "**/*.{ts,js,tsx,jsx}"
  )
  fileWatcher.onDidCreate(async (uri) => {
    if (gitignore && (await isFileIgnored(uri.fsPath, gitignore))) {
      return
    }
    console.debug(`File created: ${uri.fsPath}`)
    showDebugNotification(`File created: ${uri.fsPath}`)
    const content = await vscode.workspace.fs.readFile(uri)
    codebaseCache.set(uri.fsPath, new TextDecoder().decode(content))
    console.debug(`Cached new file: ${uri.fsPath}`)
    showDebugNotification(`Cached new file: ${uri.fsPath}`)
  })
  fileWatcher.onDidDelete((uri) => {
    if (gitignore && codebaseCache.has(uri.fsPath)) {
      console.debug(`File deleted: ${uri.fsPath}`)
      showDebugNotification(`File deleted: ${uri.fsPath}`)
    }
    codebaseCache.delete(uri.fsPath)
    console.debug(`Removed from cache: ${uri.fsPath}`)
    showDebugNotification(`Removed from cache: ${uri.fsPath}`)
  })
  fileWatcher.onDidChange(async (uri) => {
    if (gitignore && (await isFileIgnored(uri.fsPath, gitignore))) {
      return
    }
    const openDocs = vscode.workspace.textDocuments.map((doc) => doc.fileName)
    if (!openDocs.includes(uri.fsPath)) {
      console.debug(`File changed externally: ${uri.fsPath}`)
      showDebugNotification(`File changed externally: ${uri.fsPath}`)
      const content = await vscode.workspace.fs.readFile(uri)
      codebaseCache.set(uri.fsPath, new TextDecoder().decode(content))
      console.debug(`Updated cache for: ${uri.fsPath}`)
      showDebugNotification(`Updated cache for: ${uri.fsPath}`)
    }
  })

  // Analyze on file save
  const saveListener = vscode.workspace.onDidSaveTextDocument(
    async (document) => {
      if (gitignore && (await isFileIgnored(document.fileName, gitignore))) {
        return
      }
      console.debug(`File saved: ${document.fileName}`)
      showDebugNotification(`File saved: ${document.fileName}`)
      codebaseCache.set(document.fileName, document.getText())
      console.debug(`Cache updated for: ${document.fileName}`)
      showDebugNotification(`Cache updated for: ${document.fileName}`)

      if (!isAnalyzing) {
        isAnalyzing = true
        console.debug("Starting codebase analysis")
        showDebugNotification("Starting codebase analysis")
        try {
          const issues = await analyzeCodebase()
          console.debug(`Found ${issues.length} issues`)
          showDebugNotification(`Found ${issues.length} issues`)
          for (const issue of issues) {
            console.debug(
              `Notifying issue in ${issue.file}: ${issue.description}`
            )
            showDebugNotification(
              `Notifying issue in ${issue.file}: ${issue.description}`
            )
            vscode.window
              .showInformationMessage(
                `Issue in ${issue.file}: ${issue.description}`,
                "See details"
              )
              .then((selection) => {
                if (selection === "See details") {
                  console.debug(`Showing details for issue in ${issue.file}`)
                  showDebugNotification(
                    `Showing details for issue in ${issue.file}`
                  )
                  showIssueDetails(issue)
                }
              })
          }
        } finally {
          isAnalyzing = false
          console.debug("Codebase analysis completed")
          showDebugNotification("Codebase analysis completed")
        }
      } else {
        console.debug("Skipping analysis - already in progress")
        showDebugNotification("Skipping analysis - already in progress")
      }
    }
  )

  // Register disposables
  context.subscriptions.push(fileWatcher, saveListener)
  console.debug("File watcher and save listener registered")
  showDebugNotification("File watcher and save listener registered")
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
    console.debug("No OpenAI API key found")
    showDebugNotification("No OpenAI API key found")
    vscode.window.showErrorMessage(
      "OpenAI API key is not set. Please set it in the extension settings."
    )
    return []
  }

  console.debug("Initializing OpenAI client")
  showDebugNotification("Initializing OpenAI client")
  const openai = new OpenAI({ apiKey: apiKey as string })
  const prompt = preparePrompt(codebaseCache)
  console.debug("Prepared prompt for analysis")
  showDebugNotification("Prepared prompt for analysis")

  try {
    console.debug("Sending request to OpenAI API")
    showDebugNotification("Sending request to OpenAI API")
    const completion = await openai.chat.completions.create({
      model: "o3-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    })
    const responseContent = completion.choices[0].message.content
    if (!responseContent) {
      console.error("No content received from OpenAI")
      showDebugNotification("No content received from OpenAI")
      return []
    }
    console.debug("Received response from OpenAI")
    showDebugNotification("Received response from OpenAI")
    const jsonResponse = JSON.parse(responseContent)
    console.debug("Parsed JSON response")
    showDebugNotification("Parsed JSON response")
    return jsonResponse.issues || []
  } catch (error) {
    console.error("Error during OpenAI API call:", error)
    showDebugNotification(`Error during OpenAI API call: ${error}`)
    vscode.window.showErrorMessage(
      "Failed to analyze codebase. See console for details."
    )
    return []
  }
}

function preparePrompt(cache: Map<string, string>): string {
  console.debug("Preparing prompt from cache")
  showDebugNotification("Preparing prompt from cache")
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
  console.debug("Prompt preparation completed")
  showDebugNotification("Prompt preparation completed")
  return prompt
}

function showIssueDetails(issue: Issue) {
  console.debug("Creating webview panel for issue details")
  showDebugNotification("Creating webview panel for issue details")
  const panel = vscode.window.createWebviewPanel(
    "shiftV2IssueDetails",
    "Issue Details",
    vscode.ViewColumn.One,
    { enableScripts: true }
  )
  panel.webview.html = getIssueDetailsHtml(issue)
  console.debug("Webview panel created")
  showDebugNotification("Webview panel created")

  panel.webview.onDidReceiveMessage((message) => {
    if (message.command === "clarify") {
      console.debug("Received clarify request from webview")
      showDebugNotification("Received clarify request from webview")
      vscode.window
        .showInputBox({ prompt: "Ask your question about this issue" })
        .then((question) => {
          if (question) {
            console.debug(`User asked: ${question}`)
            showDebugNotification(`User asked: ${question}`)
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
              console.debug("No OpenAI API key for clarification")
              showDebugNotification("No OpenAI API key for clarification")
              vscode.window.showErrorMessage("OpenAI API key is not set.")
              return
            }
            console.debug("Sending clarification request to OpenAI")
            showDebugNotification("Sending clarification request to OpenAI")
            const openai = new OpenAI({ apiKey: apiKey as string })
            openai.chat.completions
              .create({
                model: "o3-mini",
                messages: [{ role: "user", content: followUpPrompt }]
              })
              .then((completion) => {
                const response = completion.choices[0].message.content
                console.debug("Received clarification response")
                showDebugNotification("Received clarification response")
                panel.webview.postMessage({
                  command: "showResponse",
                  text: response
                })
              })
              .catch((error) => {
                console.error("Error during clarification:", error)
                showDebugNotification(`Error during clarification: ${error}`)
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
  showDebugNotification("Generating HTML for issue details")
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
