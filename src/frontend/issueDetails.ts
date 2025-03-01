import * as vscode from "vscode"
import * as fs from "node:fs"
import * as path from "node:path"
import type { Issue } from "../types"

// Define a codebase cache manually since it's not exported from extension
const codebaseCache = new Map<string, string>()

// Update the cache based on workspace files
async function updateCodebaseCache() {
  console.debug("DEBUG: Updating codebase cache")
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders) {
      console.error("DEBUG: No workspace folders found when updating cache")
      return
    }

    const rootPath = workspaceFolders[0].uri.fsPath
    console.debug(`DEBUG: Root workspace path: ${rootPath}`)

    const files = await vscode.workspace.findFiles(
      "**/*.{ts,tsx,js,jsx}",
      "**/node_modules/**"
    )
    console.debug(`DEBUG: Found ${files.length} files to cache`)

    for (const file of files) {
      try {
        const content = await vscode.workspace.fs.readFile(file)
        const contentStr = new TextDecoder().decode(content)
        codebaseCache.set(file.fsPath, contentStr)
        console.debug(
          `DEBUG: Cached file ${file.fsPath}, size: ${contentStr.length} chars`
        )
      } catch (err) {
        console.error(`DEBUG: Error caching file ${file.fsPath}:`, err)
      }
    }
    console.debug(
      `DEBUG: Codebase cache updated with ${codebaseCache.size} files`
    )
  } catch (err) {
    console.error("DEBUG: Error updating codebase cache:", err)
  }
}

function parseLineRange(
  location: string
): { start: number; end: number } | null {
  console.debug(`DEBUG: Parsing line range from location: "${location}"`)
  const match = location.match(/lines (\d+)-(\d+)/)
  if (match) {
    const start = Number.parseInt(match[1])
    const end = Number.parseInt(match[2])
    console.debug(
      `DEBUG: Line range parsed successfully - start: ${start}, end: ${end}`
    )
    return { start, end }
  }
  console.warn(`DEBUG: Failed to parse line range from location: "${location}"`)
  return null
}

function getAbsolutePath(relativePath: string): string | undefined {
  console.debug(`DEBUG: Searching for absolute path for: "${relativePath}"`)
  console.debug(`DEBUG: Current codebase cache size: ${codebaseCache.size}`)

  // Log some sample paths from cache to aid debugging
  const samplePaths = Array.from(codebaseCache.keys()).slice(0, 5)
  console.debug(`DEBUG: Sample paths in cache: ${JSON.stringify(samplePaths)}`)

  let result: string | undefined

  for (const absPath of codebaseCache.keys()) {
    if (absPath.endsWith(relativePath)) {
      console.debug(`DEBUG: Found matching absolute path: ${absPath}`)
      result = absPath
      break
    }
  }

  if (!result) {
    console.warn(`DEBUG: No matching absolute path found for "${relativePath}"`)

    // Try filesystem-based lookup as fallback
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders
      if (workspaceFolders) {
        const rootPath = workspaceFolders[0].uri.fsPath
        const possiblePath = path.join(rootPath, relativePath)
        if (fs.existsSync(possiblePath)) {
          console.debug(`DEBUG: Found file via filesystem at: ${possiblePath}`)
          // Add to cache for future use
          try {
            const content = fs.readFileSync(possiblePath, "utf8")
            codebaseCache.set(possiblePath, content)
            console.debug(
              `DEBUG: Added file to cache from filesystem: ${possiblePath}`
            )
            result = possiblePath
          } catch (err) {
            console.error(
              `DEBUG: Error reading file from filesystem: ${possiblePath}`,
              err
            )
          }
        }
      }
    } catch (err) {
      console.error(
        `DEBUG: Error in filesystem fallback for ${relativePath}:`,
        err
      )
    }
  }

  return result
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

export async function showIssueDetails(issue: Issue) {
  console.debug(`DEBUG: Showing issue details for file: ${issue.file}`)
  console.debug(`DEBUG: Issue location: ${issue.location}`)
  console.debug("DEBUG: Full issue object:", JSON.stringify(issue, null, 2))

  // Ensure cache is populated
  if (codebaseCache.size === 0) {
    console.debug("DEBUG: Codebase cache is empty, updating...")
    await updateCodebaseCache()
  }

  const panel = vscode.window.createWebviewPanel(
    "shiftV2IssueDetails",
    `Issue in ${vscode.workspace.asRelativePath(issue.file, false)}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  )

  const lineRange = parseLineRange(issue.location)
  console.debug("DEBUG: Parsed line range:", lineRange)

  let codeSnippet = ""
  if (lineRange) {
    console.debug(
      `DEBUG: Getting code snippet for lines ${lineRange.start}-${lineRange.end}`
    )
    const absPath = getAbsolutePath(issue.file)
    console.debug(`DEBUG: Absolute path resolved to: ${absPath || "undefined"}`)

    if (absPath) {
      const content = codebaseCache.get(absPath)
      console.debug(
        `DEBUG: Retrieved content from cache: ${content ? "yes" : "no"} (length: ${content?.length || 0})`
      )

      if (content) {
        const lines = content.split("\n")
        console.debug(`DEBUG: File has ${lines.length} lines`)

        if (lineRange.start <= lines.length && lineRange.end <= lines.length) {
          // Keep original indentation by not trimming the lines
          const snippetLines = lines
            .slice(lineRange.start - 1, lineRange.end)
            .map((line, index) => `${lineRange.start + index}: ${line}`)

          console.debug(
            `DEBUG: Generated snippet with ${snippetLines.length} lines`
          )
          codeSnippet = snippetLines.join("\n")
        } else {
          console.warn(
            `DEBUG: Line range out of bounds - file has ${lines.length} lines, requested ${lineRange.start}-${lineRange.end}`
          )
        }
      } else {
        console.error(`DEBUG: Content not found in cache for path: ${absPath}`)

        // Try direct file read as fallback
        try {
          if (fs.existsSync(absPath)) {
            const directContent = fs.readFileSync(absPath, "utf8")
            console.debug(
              `DEBUG: Direct file read successful, file size: ${directContent.length}`
            )

            const lines = directContent.split("\n")
            const snippetLines = lines
              .slice(lineRange.start - 1, lineRange.end)
              .map(
                (line: string, index: number) =>
                  `${lineRange.start + index}: ${line}`
              )

            codeSnippet = snippetLines.join("\n")
            console.debug(
              `DEBUG: Generated snippet from direct file read: ${snippetLines.length} lines`
            )

            // Update cache
            codebaseCache.set(absPath, directContent)
          }
        } catch (err) {
          console.error(`DEBUG: Error reading file directly: ${absPath}`, err)
        }
      }
    } else {
      console.error(`DEBUG: Could not resolve absolute path for: ${issue.file}`)
    }
  }

  console.debug(`DEBUG: Final code snippet length: ${codeSnippet.length}`)
  const relativeFile = vscode.workspace.asRelativePath(issue.file, false)
  console.debug(`DEBUG: Relative file path: ${relativeFile}`)

  const html = getIssueDetailsHtml(issue, codeSnippet, lineRange, relativeFile)
  console.debug(`DEBUG: Generated HTML size: ${html.length}`)

  panel.webview.html = html

  // Handle messages from the webview
  panel.webview.onDidReceiveMessage(
    (message: {
      command: string
      text?: string
      file?: string
      startLine?: number
      endLine?: number
    }) => {
      if (message.command === "debug") {
        console.log("Webview debug:", message.text)
      } else if (
        message.command === "openFile" &&
        message.file &&
        message.startLine &&
        message.endLine
      ) {
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
      } else if (message.command === "copyToClipboard") {
        const content = [
          `Issue in ${relativeFile}`,
          `Location: ${relativeFile}: ${issue.location}`,
          `Description: ${issue.description}`,
          `Explanation: ${issue.explanation}`,
          `Suggestion: ${issue.suggestion}`,
          `Reasoning: ${issue.reasoning}`,
          ...(codeSnippet ? [`Code Snippet:\n${codeSnippet}`] : [])
        ].join("\n")
        void vscode.env.clipboard.writeText(content).then(
          () => {
            panel.webview.postMessage({
              command: "copySuccess",
              text: "Issue details copied to clipboard!"
            })
          },
          (error: Error) => {
            console.error("Failed to copy to clipboard:", error)
            panel.webview.postMessage({
              command: "copyError",
              text: "Failed to copy issue details."
            })
          }
        )
      }
    }
  )
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
  `
}

function getIssueDetailsHtml(
  issue: Issue,
  codeSnippet: string,
  lineRange: { start: number; end: number } | null,
  relativeFile: string
): string {
  console.debug(`DEBUG: Generating HTML for issue in ${relativeFile}`)

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
