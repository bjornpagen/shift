import * as vscode from "vscode"
import { getClarification } from "../backend/api"
import { codebaseCache } from "../extension"
import type { Issue } from "../types"

function parseLineRange(
  location: string
): { start: number; end: number } | null {
  const match = location.match(/lines (\d+)-(\d+)/)
  if (match) {
    return { start: Number.parseInt(match[1]), end: Number.parseInt(match[2]) }
  }
  return null
}

// Find the absolute path in codebaseCache that matches the provided relative path or file name
function getAbsolutePath(relativePath: string): string | undefined {
  for (const absPath of codebaseCache.keys()) {
    if (absPath.endsWith(relativePath)) {
      return absPath
    }
  }
  return undefined
}

export function showIssueDetails(issue: Issue) {
  const panel = vscode.window.createWebviewPanel(
    "shiftV2IssueDetails",
    `Issue in ${issue.file}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  )
  const lineRange = parseLineRange(issue.location)
  let codeSnippet = ""
  if (lineRange) {
    const absPath = getAbsolutePath(issue.file)
    if (absPath) {
      const content = codebaseCache.get(absPath)
      if (content) {
        const lines = content.split("\n")
        const snippetLines = lines
          .slice(lineRange.start - 1, lineRange.end)
          .map((line, index) => `${lineRange.start + index}: ${line}`)
        codeSnippet = snippetLines.join("\n")
      }
    }
  }
  panel.webview.html = getIssueDetailsHtml(issue, codeSnippet, lineRange)

  panel.webview.onDidReceiveMessage((message) => {
    if (message.command === "openFile") {
      const absPath = getAbsolutePath(message.file)
      if (absPath) {
        const uri = vscode.Uri.file(absPath)
        const startLine = message.startLine - 1 // Convert to 0-based index
        const endLine = message.endLine - 1
        const selection = new vscode.Range(startLine, 0, endLine, 0)
        vscode.commands.executeCommand("vscode.open", uri, { selection })
      } else {
        vscode.window.showErrorMessage(`File not found: ${message.file}`)
      }
    } else if (message.command === "clarify") {
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
            getClarification(followUpPrompt)
              .then((clarification) => {
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

function getIssueDetailsHtml(
  issue: Issue,
  codeSnippet: string,
  lineRange: { start: number; end: number } | null
): string {
  let codeSection = ""
  if (codeSnippet) {
    codeSection = `<h2>Code Snippet</h2><pre><code>${codeSnippet}</code></pre>`
  }
  let openButton = ""
  if (lineRange) {
    openButton = `<button onclick="openFile('${issue.file}', ${lineRange.start}, ${lineRange.end})">Go to Code</button>`
  }
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
    h2 { font-size: 1.2em; margin-top: 20px; }
    p { margin: 10px 0; }
    pre { background-color: #f0f0f0; padding: 10px; overflow: auto; }
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
  ${codeSection}
  ${openButton}
  <button onclick="vscode.postMessage({ command: 'clarify' })">Ask for Clarification</button>
  <div id="response"></div>
  <script>
    const vscode = acquireVsCodeApi();
    function openFile(file, startLine, endLine) {
      vscode.postMessage({ command: 'openFile', file: file, startLine: startLine, endLine: endLine });
    }
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
