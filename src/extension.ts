import * as vscode from "vscode"
import ignore, { type Ignore } from "ignore"
import {
  initializeKuzu,
  updateKuzuDatabase,
  type KuzuConnection
} from "./backend/kuzu"
import { initialLoad } from "./backend/workspace-init"
import { analyzeWorkspace } from "./backend/workspace-analysis"
import { tryCatch } from "./utils/try-catch"
import { analyze } from "./backend/analysis"
import { showIssueDetails } from "./frontend/issueDetails"
import type { Issue } from "./types"
import * as path from "node:path"

// Global state for analysis queue
interface AnalysisJob {
  filePath: string
  userContent: string
}

const analysisQueue: AnalysisJob[] = []
let currentJob: AnalysisJob | null = null
let statusBarItem: vscode.StatusBarItem | null = null
let initializationPromise: Promise<KuzuConnection> | undefined
const gitignorePromise = getGitignorePatterns()
const issuesByFile: Map<string, Issue[]> = new Map()

async function processQueue() {
  while (true) {
    if (currentJob === null && analysisQueue.length > 0) {
      const nextJob = analysisQueue.shift()
      if (nextJob) {
        currentJob = nextJob
        updateStatusBar()
        try {
          const issues = await analyze(currentJob.userContent, [])
          issuesByFile.set(currentJob.filePath, issues)
          updateDecorations()
          for (const issue of issues) {
            const relativeFile = vscode.workspace.asRelativePath(
              issue.file,
              false
            )
            await vscode.window
              .showWarningMessage(
                `Issue in ${relativeFile}: ${issue.description}`,
                "Tell Me More"
              )
              .then((selection) => {
                if (selection === "Tell Me More") {
                  showIssueDetails(issue)
                }
              })
          }
        } catch (error) {
          console.error(`Error analyzing ${currentJob.filePath}:`, error)
        } finally {
          currentJob = null
          updateStatusBar()
        }
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

function updateStatusBar() {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    )
    statusBarItem.command = "shift-v2.showAllIssues"
  }
  if (currentJob) {
    const pending = analysisQueue.length
    statusBarItem.text = `$(sync~spin) Analyzing: ${path.basename(currentJob.filePath)} (${pending} pending)`
    statusBarItem.tooltip = "Shift-V2 is analyzing files"
  } else if (analysisQueue.length > 0) {
    statusBarItem.text = `$(sync~spin) Analysis pending: ${analysisQueue.length} jobs`
    statusBarItem.tooltip = "Shift-V2 is analyzing files"
  } else {
    const allIssues = Array.from(issuesByFile.values()).flat()
    const totalIssues = allIssues.length
    statusBarItem.text = `Shift-V2: ${totalIssues} issues`
    statusBarItem.tooltip = "Click to view all issues"
  }
  statusBarItem.show()
}

async function addToQueue(job: AnalysisJob) {
  analysisQueue.push(job)
  updateStatusBar()
}

async function getGitignorePatterns(): Promise<Ignore> {
  console.debug("Fetching .gitignore patterns")
  const ig = ignore()

  const gitignoreFilesResult = await tryCatch(
    Promise.resolve(
      vscode.workspace.findFiles("**/.gitignore", "**/node_modules/**")
    )
  )

  if (gitignoreFilesResult.error) {
    console.error(
      `Error finding .gitignore files: ${gitignoreFilesResult.error}`
    )
    console.debug("Using default ignore patterns only")
    ig.add(["node_modules/**", "dist/**", "*.log"])
    return ig
  }

  const gitignoreFiles = gitignoreFilesResult.data
  console.debug(`Found ${gitignoreFiles.length} .gitignore files`)

  for (const file of gitignoreFiles) {
    const contentResult = await tryCatch(
      Promise.resolve(vscode.workspace.fs.readFile(file))
    )

    if (contentResult.error) {
      console.error(
        `Error reading .gitignore file ${file.fsPath}: ${contentResult.error}`
      )
      continue
    }

    const gitignoreContent = new TextDecoder().decode(contentResult.data)
    console.debug(`Adding patterns from ${file.fsPath}`)
    ig.add(gitignoreContent)
  }

  ig.add(["node_modules/**", "dist/**", "*.log"])
  console.debug(
    "Added default ignore patterns: node_modules/**, dist/**, *.log"
  )
  return ig
}

async function isFileIgnored(filePath: string, ig: Ignore): Promise<boolean> {
  const relativePath = vscode.workspace.asRelativePath(filePath, false)
  const ignored = ig.ignores(relativePath)
  console.debug(`Checking if ${relativePath} is ignored: ${ignored}`)
  return ignored
}

function detectLanguage(filePath: string): string | null {
  const extension = filePath.split(".").pop()?.toLowerCase()
  console.debug(`Detecting language for ${filePath}, extension: ${extension}`)
  switch (extension) {
    case "js":
    case "jsx":
      return "JavaScript"
    case "ts":
    case "tsx":
      return "TypeScript"
    default:
      console.debug(`No language detected for ${filePath}`)
      return null
  }
}

const issueDecorationType = vscode.window.createTextEditorDecorationType({
  textDecoration: "underline wavy #FFECB3",
  overviewRulerColor: "#FFECB3",
  overviewRulerLane: vscode.OverviewRulerLane.Right
})

function parseLineRange(
  location: string
): { start: number; end: number } | null {
  const match = location.match(/lines (\d+)-(\d+)/)
  if (match) {
    return { start: Number.parseInt(match[1]), end: Number.parseInt(match[2]) }
  }
  return null
}

function updateDecorations() {
  for (const editor of vscode.window.visibleTextEditors) {
    const filePath = editor.document.fileName
    const fileIssues = issuesByFile.get(filePath) || []
    const ranges = fileIssues
      .map((issue) => {
        const lineRange = parseLineRange(issue.location)
        if (lineRange) {
          return new vscode.Range(lineRange.start - 1, 0, lineRange.end - 1, 0)
        }
        return null
      })
      .filter((range): range is vscode.Range => range !== null)
    editor.setDecorations(issueDecorationType, ranges)
  }
}

async function handleDocumentUpdate(
  document: vscode.TextDocument
): Promise<void> {
  console.debug(`Processing update for ${document.fileName}`)

  const ig = await gitignorePromise
  if (await isFileIgnored(document.fileName, ig)) {
    console.debug(`${document.fileName} is ignored, skipping update`)
    return
  }

  const newContent = document.getText()
  const language = detectLanguage(document.fileName)

  if (language && initializationPromise) {
    console.debug(`Updating database for ${document.fileName} (${language})`)

    const connectionResult = await tryCatch(initializationPromise)
    if (connectionResult.error) {
      console.error(
        "Failed to get database connection:",
        connectionResult.error
      )
      return
    }

    const updateResult = await tryCatch(
      updateKuzuDatabase(document.fileName, newContent, connectionResult.data)
    )

    if (updateResult.error) {
      console.error("Failed to update Kùzu database:", updateResult.error)
    } else {
      console.debug(`Database updated for ${document.fileName}`)
    }

    const lines = newContent.split("\n")
    const numberedContent = lines
      .map((line, index) => `${index + 1}: ${line}`)
      .join("\n")
    const userContent = `# Analyzing File: ${document.fileName}\n\n## Content\n\`\`\`typescript\n${numberedContent}\n\`\`\``
    await addToQueue({ filePath: document.fileName, userContent })
  } else {
    console.debug(
      `No language detected or no initialization for ${document.fileName}`
    )
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

export function showAllIssues(issues: Issue[]) {
  const panel = vscode.window.createWebviewPanel(
    "shiftV2AllIssues",
    "All Issues",
    vscode.ViewColumn.One,
    { enableScripts: true }
  )

  const styles = `
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background-color: var(--vscode-editor-background);
      padding: 24px;
      line-height: 1.5;
      margin: 0;
    }

    h1 {
      color: var(--vscode-editor-foreground);
      font-weight: 600;
      margin: 0 0 24px 0;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-editorGroup-border);
      font-size: 1.4em;
    }

    .issue {
      background: var(--vscode-editorWidget-background);
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 16px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }

    .issue h3 {
      margin: 0 0 8px 0;
      font-size: 1.1em;
      color: var(--vscode-editor-foreground);
    }

    .issue p {
      margin: 4px 0;
      color: var(--vscode-descriptionForeground);
    }

    button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: background-color 0.2s;
    }

    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
  `

  const html = `
    <html>
      <head>
        <style>${styles}</style>
      </head>
      <body>
        <h1>All Issues</h1>
        ${issues
          .map(
            (issue, index) => `
          <div class="issue">
            <h3>${escapeHtml(issue.description)}</h3>
            <p>File: ${escapeHtml(issue.file)}</p>
            <p>Location: ${escapeHtml(issue.location)}</p>
            <button onclick="vscode.postMessage({command: 'openIssue', index: ${index}})">View Details</button>
          </div>
        `
          )
          .join("")}
        <script>
          const vscode = acquireVsCodeApi();
        </script>
      </body>
    </html>
  `

  panel.webview.html = html

  panel.webview.onDidReceiveMessage((message) => {
    if (message.command === "openIssue") {
      const index = message.index
      if (index >= 0 && index < issues.length) {
        showIssueDetails(issues[index])
      }
    }
  })
}

export function activate(context: vscode.ExtensionContext) {
  console.debug("Activating Shift-V2 extension")
  if (
    !vscode.workspace.workspaceFolders ||
    vscode.workspace.workspaceFolders.length === 0
  ) {
    console.debug("No workspace folders open, delaying activation")
    return
  }

  console.debug("Workspace detected, proceeding with activation")
  const storagePath = context.globalStorageUri.fsPath
  console.debug(`Using storage path: ${storagePath}`)

  initializationPromise = Promise.resolve(
    vscode.workspace.fs.createDirectory(context.globalStorageUri)
  )
    .then(() => {
      console.debug("Global storage directory ensured")
      return initializeKuzu(storagePath)
    })
    .then((connection) => {
      console.debug("Kùzu database initialized successfully")
      processQueue().catch((error) =>
        console.error("Queue processor error:", error)
      )
      return connection
    })
    .catch((err: unknown) => {
      console.error("Failed to initialize Kùzu:", err)
      throw err
    })

  const initialLoadDisposable = vscode.commands.registerCommand(
    "shift-v2.initialLoad",
    async () => {
      console.debug("Executing command: shift-v2.initialLoad")
      if (!initializationPromise) {
        console.debug("Initialization promise not set")
        vscode.window.showErrorMessage(
          "Database initialization has not started."
        )
        return
      }

      const connectionResult = await tryCatch(initializationPromise)
      if (connectionResult.error) {
        console.error("Initial load failed:", connectionResult.error)
        vscode.window.showErrorMessage(
          "Failed to initialize database. Check the logs for details."
        )
        return
      }

      const igResult = await tryCatch(gitignorePromise)
      if (igResult.error) {
        console.error("Failed to get ignore patterns:", igResult.error)
        vscode.window.showErrorMessage(
          "Failed to get ignore patterns. Check the logs for details."
        )
        return
      }

      console.debug("Database connection and ignore patterns ready")

      const initialLoadResult = await tryCatch(
        initialLoad(connectionResult.data, igResult.data)
      )

      if (initialLoadResult.error) {
        console.error("Initial load failed:", initialLoadResult.error)
        vscode.window.showErrorMessage(
          "Failed to initialize database. Check the logs for details."
        )
        return
      }

      console.debug("Initial load command completed")
      vscode.window.showInformationMessage("Initial load completed.")
    }
  )

  const analyzeDisposable = vscode.commands.registerCommand(
    "shift-v2.analyze",
    async () => {
      console.debug("Executing command: shift-v2.analyze")
      if (!initializationPromise) {
        console.debug("Initialization promise not set")
        vscode.window.showErrorMessage(
          "Database initialization has not started."
        )
      return
    }

      const connectionResult = await tryCatch(initializationPromise)
      if (connectionResult.error) {
        console.error("Analysis failed:", connectionResult.error)
        vscode.window.showErrorMessage(
          "Failed to initialize database. Check the logs for details."
        )
      return
    }

      const igResult = await tryCatch(gitignorePromise)
      if (igResult.error) {
        console.error("Failed to get ignore patterns:", igResult.error)
        vscode.window.showErrorMessage(
          "Failed to get ignore patterns. Check the logs for details."
        )
        return
      }

      console.debug(
        "Database connection and ignore patterns ready for analysis"
      )

      await analyzeWorkspace(connectionResult.data, igResult.data, addToQueue)
    }
  )

  const showAllIssuesCommand = vscode.commands.registerCommand(
    "shift-v2.showAllIssues",
    () => {
      const allIssues = Array.from(issuesByFile.values()).flat()
      showAllIssues(allIssues)
    }
  )

  const hoverProvider = vscode.languages.registerHoverProvider(
    ["javascript", "typescript", "javascriptreact", "typescriptreact"],
    {
      provideHover(document, position) {
        const filePath = document.fileName
        const line = position.line + 1
        const fileIssues = issuesByFile.get(filePath) || []
        for (const issue of fileIssues) {
          const lineRange = parseLineRange(issue.location)
          if (lineRange && line >= lineRange.start && line <= lineRange.end) {
            const hoverContent = new vscode.MarkdownString()
            hoverContent.appendMarkdown(`**Issue:** ${issue.description}\n\n`)
            hoverContent.appendMarkdown(
              `**Explanation:** ${issue.explanation}\n\n`
            )
            hoverContent.appendMarkdown(
              `**Suggestion:** ${issue.suggestion}\n\n`
            )
            hoverContent.appendMarkdown(
              `[View Details](command:_shift-v2.showIssueDetails?${encodeURIComponent(
                JSON.stringify([issue])
              )})`
            )
            hoverContent.isTrusted = true
            return new vscode.Hover(hoverContent)
          }
        }
        return null
      }
    }
  )

  // Register a private command to show issue details directly from hover
  const showIssueDetailsCommand = vscode.commands.registerCommand(
    "_shift-v2.showIssueDetails",
    (issue: Issue) => {
      showIssueDetails(issue)
    }
  )

  const saveListener = vscode.workspace.onDidSaveTextDocument(
    async (document) => {
      console.debug(`File saved: ${document.fileName}`)
      await handleDocumentUpdate(document)
    }
  )

  context.subscriptions.push(
    initialLoadDisposable,
    analyzeDisposable,
    showAllIssuesCommand,
    saveListener,
    hoverProvider,
    showIssueDetailsCommand
  )

  vscode.window.onDidChangeVisibleTextEditors(
    updateDecorations,
    null,
    context.subscriptions
  )
  console.debug("Commands, save listener, hover provider registered")
}

export function deactivate() {
  console.debug("Deactivating Shift-V2 extension")
}
