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
        // Keep original indentation by not trimming the lines
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

function getStyles(): string {
  return `
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background-color: var(--vscode-editor-background);
      padding: 24px;
      line-height: 1.5;
      margin: 0;
    }
    
    h1, h2 {
      color: var(--vscode-editor-foreground);
      font-weight: 600;
      margin: 0;
    }
    
    h1 {
      font-size: 1.4em;
      margin-bottom: 24px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-editorGroup-border);
    }
    
    h2 {
      font-size: 1.1em;
      margin-top: 16px;
      margin-bottom: 8px;
    }
    
    .issue-details {
      background: var(--vscode-editor-background);
      border-radius: 6px;
      margin-bottom: 24px;
    }
    
    .detail-item {
      display: flex;
      margin-bottom: 16px;
      align-items: flex-start;
    }
    
    .label {
      flex: 0 0 100px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      padding-right: 16px;
    }
    
    .value {
      flex: 1;
      line-height: 1.6;
    }
    
    .code-snippet {
      margin: 24px 0;
      background: var(--vscode-editorWidget-background);
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }
    
    .code-snippet-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-editorGroup-border);
    }
    
    .code-box {
      background-color: var(--vscode-editorWidget-background);
      padding: 12px;
      overflow: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    
    #code-block {
      margin: 0;
      padding: 0;
      background-color: transparent;
    }
    
    .code-line-wrapper {
      display: flex;
      align-items: flex-start;
      min-height: 20px;
      padding: 0 4px;
    }
    
    .code-line-wrapper:hover {
      background-color: var(--vscode-editor-hoverHighlightBackground);
    }
    
    .line-number {
      width: 40px;
      padding-right: 12px;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground);
      flex-shrink: 0;
      user-select: none;
      opacity: 0.5;
    }
    
    .code-line {
      flex: 1;
      white-space: pre;
      color: var(--vscode-editor-foreground);
    }
    
    .actions {
      margin-top: 24px;
      display: flex;
      gap: 8px;
    }
    
    button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      transition: background-color 0.2s;
    }
    
    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    
    button.secondary {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    
    button.secondary:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }
    
    .copy-code {
      position: absolute;
      top: 6px;
      right: 8px;
      opacity: 0.7;
      padding: 4px 8px;
      font-size: 11px;
    }
    
    .copy-code:hover {
      opacity: 1;
    }
    
    #feedback {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--vscode-editorWidget-background);
      color: var(--vscode-editorWidget-foreground);
      padding: 8px 16px;
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.2s ease;
    }
    
    #feedback.visible {
      opacity: 1;
      transform: translateY(0);
    }
    
    #reasoning {
      background: var(--vscode-sideBar-background);
      border-radius: 4px;
      padding: 12px;
      margin-top: 8px;
    }
  `
}

function getScripts(): string {
  return `
    const vscode = acquireVsCodeApi();
    
    function escapeHtml(text) {
      var div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function showFeedback(text) {
      const feedback = document.getElementById('feedback');
      feedback.innerText = text;
      feedback.classList.add('visible');
      setTimeout(() => {
        feedback.classList.remove('visible');
        setTimeout(() => { feedback.innerText = ''; }, 200);
      }, 2000);
    }

    document.addEventListener('DOMContentLoaded', () => {
      // Format code block with line numbers
      const codeBlock = document.getElementById('code-block');
      if (codeBlock) {
        const lines = codeBlock.innerText.split('\\n');
        codeBlock.innerHTML = lines
          .map(line => {
            const colonIndex = line.indexOf(':');
            if (colonIndex === -1) return '';
            const number = line.substring(0, colonIndex);
            const code = line.substring(colonIndex + 1);
            return \`<div class="code-line-wrapper">
              <span class="line-number">\${escapeHtml(number.trim())}:</span>
              <span class="code-line">\${escapeHtml(code)}</span>
            </div>\`;
          })
          .join('');
      }

      // Show code container by default
      const container = document.getElementById('code-snippet-container');
      if (container) {
        container.style.display = 'block';
      }

      // Setup reasoning toggle
      const toggleButton = document.getElementById('toggle-reasoning');
      if (toggleButton) {
        toggleButton.addEventListener('click', () => {
          const reasoningDiv = document.getElementById('reasoning');
          if (reasoningDiv) {
            const isHidden = reasoningDiv.style.display === 'none';
            reasoningDiv.style.display = isHidden ? 'block' : 'none';
            toggleButton.innerText = isHidden ? 'Hide Reasoning' : 'Show Reasoning';
          }
        });
      }

      // Add hover effect for code lines
      document.querySelectorAll('.code-line-wrapper').forEach(wrapper => {
        wrapper.addEventListener('mouseenter', () => {
          wrapper.style.backgroundColor = 'var(--vscode-editor-hoverHighlightBackground)';
        });
        wrapper.addEventListener('mouseleave', () => {
          wrapper.style.backgroundColor = '';
        });
      });
    });

    function openFile(file, startLine, endLine) {
      vscode.postMessage({
        command: 'openFile',
        file,
        startLine,
        endLine
      });
    }

    function copyToClipboard() {
      vscode.postMessage({ command: 'copyToClipboard' });
    }

    function copyCode() {
      const codeBlock = document.getElementById('code-block');
      const lines = Array.from(codeBlock.getElementsByClassName('code-line'))
        .map(span => span.innerText);
      
      navigator.clipboard.writeText(lines.join('\\n'))
        .then(
          () => showFeedback('Code copied to clipboard!'),
          () => showFeedback('Failed to copy code.')
        );
    }

    function toggleCode() {
      const container = document.getElementById('code-snippet-container');
      const button = document.querySelector('.code-snippet-header button');
      const isHidden = container.style.display === 'none';
      
      container.style.display = isHidden ? 'block' : 'none';
      button.innerText = isHidden ? 'Hide' : 'Show';
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'copySuccess' || message.command === 'copyError') {
        showFeedback(message.text);
      }
    });
  `;
}

function getIssueDetailsHtml(
  issue: Issue,
  codeSnippet: string,
  lineRange: { start: number; end: number } | null,
  relativeFile: string
): string {
  const openButton = lineRange
    ? `<button onclick="openFile('${issue.file}', ${lineRange.start}, ${lineRange.end})">
        <span>Go to Code</span>
       </button>`
    : ""

  const codeSection = codeSnippet
    ? `<div class="code-snippet">
        <div class="code-snippet-header">
          <h2>Code Snippet</h2>
          <button class="secondary" onclick="toggleCode()">Hide</button>
        </div>
        <div class="code-container" style="position: relative;">
          <div id="code-snippet-container" class="code-box" style="max-height: 400px;">
            <pre id="code-block">${escapeHtml(codeSnippet)}</pre>
          </div>
          <button class="copy-code secondary" onclick="copyCode()">Copy</button>
        </div>
      </div>`
    : ""

  const reasoningSection = `<div class="detail-item">
      <div class="label">Reasoning</div>
      <div class="value">
        <button class="secondary" id="toggle-reasoning">Show Reasoning</button>
        <div id="reasoning" style="display: none;">
          <p>${escapeHtml(issue.reasoning)}</p>
        </div>
      </div>
    </div>`

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Issue Details</title>
    <style>${getStyles()}</style>
  </head>
  <body>
    <div class="issue-details">
      <h1>Issue in ${relativeFile}</h1>
      <div class="detail-item">
        <div class="label">Location</div>
        <div class="value">${escapeHtml(relativeFile)}: ${escapeHtml(issue.location)}</div>
      </div>
      <div class="detail-item">
        <div class="label">Description</div>
        <div class="value">${escapeHtml(issue.description)}</div>
      </div>
      <div class="detail-item">
        <div class="label">Explanation</div>
        <div class="value">${escapeHtml(issue.explanation)}</div>
      </div>
      <div class="detail-item">
        <div class="label">Suggestion</div>
        <div class="value">${escapeHtml(issue.suggestion)}</div>
      </div>
      ${reasoningSection}
    </div>
    ${codeSection}
    <div class="actions">
      ${openButton}
      <button class="secondary" onclick="copyToClipboard()">Copy Issue Details</button>
    </div>
    <div id="feedback"></div>
    <script>${getScripts()}</script>
  </body>
</html>`
}