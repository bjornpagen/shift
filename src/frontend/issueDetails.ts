import * as vscode from "vscode"
import { getClarification } from "../backend/api"
import type { Issue } from "../types"

export function showIssueDetails(issue: Issue) {
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
