import * as vscode from "vscode"
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

function getAbsolutePath(relativePath: string): string | undefined {
  for (const absPath of codebaseCache.keys()) {
    if (absPath.endsWith(relativePath)) {
      return absPath
    }
  }
  return undefined
}

// Escape HTML to prevent injection or rendering issues
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export function showIssueDetails(issue: Issue) {
  // Log the reasoning content to check if it's populated
  console.log('Showing issue details for:', issue.file, 'reasoning:', issue.reasoning)
  const panel = vscode.window.createWebviewPanel(
    "shiftV2IssueDetails",
    `Issue in ${vscode.workspace.asRelativePath(issue.file, false)}`,
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
  const relativeFile = vscode.workspace.asRelativePath(issue.file, false)
  panel.webview.html = getIssueDetailsHtml(issue, codeSnippet, lineRange, relativeFile)

  // Handle messages from the webview
  panel.webview.onDidReceiveMessage((message: { 
    command: string;
    text?: string;
    file?: string;
    startLine?: number;
    endLine?: number;
  }) => {
    if (message.command === 'debug') {
      console.log('Webview debug:', message.text)
    } else if (message.command === 'openFile' && message.file && message.startLine && message.endLine) {
      const absPath = getAbsolutePath(message.file)
      if (absPath) {
        const uri = vscode.Uri.file(absPath)
        const startLine = message.startLine - 1
        const endLine = message.endLine - 1
        const selection = new vscode.Range(startLine, 0, endLine, 0)
        vscode.commands.executeCommand("vscode.open", uri, { selection })
      } else {
        vscode.window.showErrorMessage(`File not found: ${message.file}`)
      }
    } else if (message.command === 'copyToClipboard') {
      const content = [
        `Issue in ${relativeFile}`,
        `Location: ${relativeFile}: ${issue.location}`,
        `Description: ${issue.description}`,
        `Explanation: ${issue.explanation}`,
        `Suggestion: ${issue.suggestion}`,
        `Reasoning: ${issue.reasoning}`,
        ...(codeSnippet ? [`Code Snippet:\n${codeSnippet}`] : [])
      ].join("\n")
      void vscode.env.clipboard.writeText(content).then(() => {
        panel.webview.postMessage({
          command: "copySuccess",
          text: "Issue details copied to clipboard!"
        })
      }, (error: Error) => {
        console.error("Failed to copy to clipboard:", error)
        panel.webview.postMessage({
          command: "copyError",
          text: "Failed to copy issue details."
        })
      })
    }
  })
}

function getIssueDetailsHtml(
  issue: Issue,
  codeSnippet: string,
  lineRange: { start: number; end: number } | null,
  relativeFile: string
): string {
  const openButton = lineRange
    ? `<button onclick="openFile('${issue.file}', ${lineRange.start}, ${lineRange.end})">Go to Code</button>`
    : ""
  const codeSection = codeSnippet
    ? `
    <div class="code-snippet">
      <h2>Code Snippet <button onclick="toggleCode()">Hide</button></h2>
      <div class="code-container" style="position: relative;">
        <div id="code-snippet-container" class="code-box" style="max-height: 400px; overflow: auto;">
          <pre id="code-block">${escapeHtml(codeSnippet)}</pre>
        </div>
        <button class="copy-code" onclick="copyCode()" style="position: absolute; top: 5px; right: 5px; font-size: 0.8em; padding: 4px 8px;">Copy Code</button>
      </div>
    </div>
    `
    : ""
  const reasoningSection = `
    <div class="detail-item">
      <button id="toggle-reasoning">Show Reasoning</button>
      <div id="reasoning" style="display: none;">
        <h2>Reasoning</h2>
        <p>${escapeHtml(issue.reasoning)}</p>
      </div>
    </div>
  `
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Issue Details</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); padding: 20px; }
    h1, h2 { color: var(--vscode-editor-foreground); font-weight: bold; }
    h1 { font-size: 1.5em; margin-bottom: 20px; }
    h2 { font-size: 1.2em; margin-top: 20px; }
    .issue-details { margin-bottom: 20px; }
    .detail-item { display: flex; margin-bottom: 10px; }
    .label { flex: 0 0 120px; font-weight: bold; }
    .value { flex: 1; }
    .code-snippet h2 button { font-size: 0.8em; padding: 2px 6px; margin-left: 10px; }
    .code-box { background-color: var(--vscode-sideBar-background, #2a2d2e); border: 1px solid var(--vscode-editorGroup-border, #3c3c3c); border-radius: 4px; padding: 10px; }
    #code-block { margin: 0; padding: 0; background-color: transparent; }
    .code-line-wrapper { display: flex; align-items: flex-start; }
    .line-number { width: 40px; text-align: right; margin-right: 10px; color: var(--vscode-editorLineNumber-foreground); flex-shrink: 0; }
    .code-line { flex: 1; white-space: pre; color: var(--vscode-editor-foreground); }
    .actions { margin-top: 20px; }
    button { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; cursor: pointer; margin-right: 10px; }
    button:hover { background-color: var(--vscode-button-hoverBackground); }
    #feedback { margin-top: 10px; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div class="issue-details">
    <h1>Issue in ${relativeFile}</h1>
    <div class="detail-item">
      <span class="label">Location:</span>
      <span class="value">${escapeHtml(relativeFile)}: ${escapeHtml(issue.location)}</span>
    </div>
    <div class="detail-item">
      <span class="label">Description:</span>
      <span class="value">${escapeHtml(issue.description)}</span>
    </div>
    <div class="detail-item">
      <span class="label">Explanation:</span>
      <span class="value">${escapeHtml(issue.explanation)}</span>
    </div>
    <div class="detail-item">
      <span class="label">Suggestion:</span>
      <span class="value">${escapeHtml(issue.suggestion)}</span>
    </div>
    ${reasoningSection}
  </div>
  ${codeSection}
  <div class="actions">
    ${openButton}
    <button onclick="copyToClipboard()">Copy Issue Details</button>
  </div>
  <div id="feedback"></div>
  <script>
    const vscode = acquireVsCodeApi();
    function escapeHtml(text) {
      var div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    document.addEventListener('DOMContentLoaded', () => {
      vscode.postMessage({ command: 'debug', text: 'DOM loaded' });
      const codeBlock = document.getElementById('code-block');
      if (codeBlock) {
        const lines = codeBlock.innerText.split('\\n');
        codeBlock.innerHTML = lines.map(line => {
          const [number, ...code] = line.split(':');
          const codeText = code.join(':').trim();
          return \`<div class="code-line-wrapper"><span class="line-number">\${escapeHtml(number.trim())}:</span><span class="code-line">\${escapeHtml(codeText)}</span></div>\`;
        }).join('');
      }
      const container = document.getElementById('code-snippet-container');
      if (container) {
        container.style.display = 'block';
      }
      const toggleButton = document.getElementById('toggle-reasoning');
      if (toggleButton) {
        toggleButton.addEventListener('click', () => {
          vscode.postMessage({ command: 'debug', text: 'Toggle clicked' });
          const reasoningDiv = document.getElementById('reasoning');
          if (reasoningDiv) {
            if (reasoningDiv.style.display === 'none') {
              reasoningDiv.style.display = 'block';
              toggleButton.innerText = 'Hide Reasoning';
              vscode.postMessage({ command: 'debug', text: 'Set display to block' });
            } else {
              reasoningDiv.style.display = 'none';
              toggleButton.innerText = 'Show Reasoning';
              vscode.postMessage({ command: 'debug', text: 'Set display to none' });
            }
          } else {
            vscode.postMessage({ command: 'debug', text: 'reasoning div not found' });
          }
        });
      } else {
        vscode.postMessage({ command: 'debug', text: 'toggle-reasoning button not found' });
      }
    });
    function openFile(file, startLine, endLine) {
      vscode.postMessage({ command: 'openFile', file: file, startLine: startLine, endLine: endLine });
    }
    function copyToClipboard() {
      vscode.postMessage({ command: 'copyToClipboard' });
    }
    function copyCode() {
      const codeBlock = document.getElementById('code-block');
      const lines = Array.from(codeBlock.getElementsByClassName('code-line')).map(span => span.innerText);
      const codeWithoutNumbers = lines.join('\\n');
      navigator.clipboard.writeText(codeWithoutNumbers).then(() => {
        const feedback = document.getElementById('feedback');
        feedback.innerText = 'Code copied to clipboard!';
        setTimeout(() => { feedback.innerText = ''; }, 3000);
      }, (err) => {
        console.error('Failed to copy code:', err);
        const feedback = document.getElementById('feedback');
        feedback.innerText = 'Failed to copy code.';
      });
    }
    function toggleCode() {
      const container = document.getElementById('code-snippet-container');
      const button = document.querySelector('.code-snippet h2 button');
      if (container.style.display === 'none') {
        container.style.display = 'block';
        button.innerText = 'Hide';
      } else {
        container.style.display = 'none';
        button.innerText = 'Show';
      }
    }
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'copySuccess' || message.command === 'copyError') {
        const feedback = document.getElementById('feedback');
        feedback.innerText = message.text;
        setTimeout(() => { feedback.innerText = ''; }, 3000);
      }
    });
  </script>
</body>
</html>
`
}