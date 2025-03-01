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

// Global state
let initializationPromise: Promise<KuzuConnection> | undefined
const gitignorePromise = getGitignorePatterns()
let currentIssues: Issue[] = []
let isAnalyzing = false

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
    console.debug(
      "Added default ignore patterns: node_modules/**, dist/**, *.log"
    )
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

// Define decoration type for code highlights with softer yellow squiggly lines
const issueDecorationType = vscode.window.createTextEditorDecorationType({
  textDecoration: "underline wavy #FFECB3",
  overviewRulerColor: "#FFECB3",
  overviewRulerLane: vscode.OverviewRulerLane.Right
})

// Parse line range from issue location (e.g., "lines 5-7")
function parseLineRange(
  location: string
): { start: number; end: number } | null {
  const match = location.match(/lines (\d+)-(\d+)/)
  if (match) {
    return { start: Number.parseInt(match[1]), end: Number.parseInt(match[2]) }
  }
  return null
}

// Update decorations for all visible editors
function updateDecorations() {
  const issuesByFile: Map<string, Issue[]> = new Map()
  for (const issue of currentIssues) {
    if (!issuesByFile.has(issue.file)) {
      issuesByFile.set(issue.file, [])
    }
    issuesByFile.get(issue.file)?.push(issue)
  }
  for (const editor of vscode.window.visibleTextEditors) {
    const filePath = editor.document.fileName
    const fileIssues = issuesByFile.get(filePath) || []
    const ranges = fileIssues
      .map((issue) => {
        const lineRange = parseLineRange(issue.location)
        if (lineRange) {
          // Convert to 0-based line numbers
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

    // Run analysis on save if we're not already analyzing
    if (!isAnalyzing) {
      isAnalyzing = true
      console.debug("Starting file analysis")
      try {
        // Prepare content for analysis
        const lines = newContent.split("\n")
        const numberedContent = lines
          .map((line, index) => `${index + 1}: ${line}`)
          .join("\n")
        const userContent = `# Analyzing File: ${document.fileName}\n\n## Content\n\`\`\`typescript\n${numberedContent}\n\`\`\``

        // Get issues from the current file
        const issues = await analyze(userContent, []) // Using empty array for kuzuIssues parameter
        console.debug(`Found ${issues.length} issues`)
        currentIssues = issues
        updateDecorations() // Apply squiggly lines after analysis

        // Notify about each issue
        for (const issue of issues) {
          console.debug(
            `Notifying issue in ${issue.file}: ${issue.description}`
          )
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
                console.debug(`Showing details for issue in ${issue.file}`)
                showIssueDetails(issue)
              }
            })
        }
      } catch (error) {
        console.error("Error in file analysis:", error)
      } finally {
        isAnalyzing = false
        console.debug("File analysis completed")
      }
    } else {
      console.debug("Skipping analysis - already in progress")
    }
  } else {
    console.debug(
      `No language detected or no initialization for ${document.fileName}`
    )
  }
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

      const analyzeResult = await tryCatch(
        analyzeWorkspace(connectionResult.data, igResult.data)
      )

      if (analyzeResult.error) {
        console.error("Analysis failed:", analyzeResult.error)
        vscode.window.showErrorMessage(
          "Failed to analyze workspace. Check the logs for details."
        )
        return
      }

      console.debug("Analyze command completed")
      vscode.window.showInformationMessage("Analysis completed.")
    }
  )

  // Register hover provider with clickable link
  const hoverProvider = vscode.languages.registerHoverProvider(
    ["javascript", "typescript", "javascriptreact", "typescriptreact"],
    {
      provideHover(document, position) {
        const filePath = document.fileName
        const line = position.line + 1 // Convert to 1-based line numbers
        const fileIssues = currentIssues.filter(
          (issue) => issue.file === filePath
        )
        for (let i = 0; i < fileIssues.length; i++) {
          const issue = fileIssues[i]
          const lineRange = parseLineRange(issue.location)
          if (lineRange && line >= lineRange.start && line <= lineRange.end) {
            const issueIndex = currentIssues.indexOf(issue)
            const hoverContent = new vscode.MarkdownString()
            hoverContent.appendMarkdown(`**Issue:** ${issue.description}\n\n`)
            hoverContent.appendMarkdown(
              `**Explanation:** ${issue.explanation}\n\n`
            )
            hoverContent.appendMarkdown(
              `**Suggestion:** ${issue.suggestion}\n\n`
            )
            hoverContent.appendMarkdown(
              `[Open Details](command:shift-v2.openIssueDetails?${encodeURIComponent(JSON.stringify([issueIndex]))})`
            )
            hoverContent.isTrusted = true // Allow command links
            return new vscode.Hover(hoverContent)
          }
        }
        return null
      }
    }
  )

  // Register command to open issue details
  const openIssueDetailsCommand = vscode.commands.registerCommand(
    "shift-v2.openIssueDetails",
    (issueIndex: number) => {
      if (issueIndex >= 0 && issueIndex < currentIssues.length) {
        const issue = currentIssues[issueIndex]
        showIssueDetails(issue)
      }
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
    saveListener,
    hoverProvider,
    openIssueDetailsCommand
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
