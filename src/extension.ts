import * as vscode from "vscode"
import ignore from "ignore"
import { analyze } from "./backend/analysis"
import { showIssueDetails } from "./frontend/issueDetails"

// Define a type for the ignore instance
interface IgnoreInstance {
  add: (pattern: string | string[]) => IgnoreInstance
  ignores: (path: string) => boolean
}

// Global state
export const codebaseCache: Map<string, string> = new Map()
const previousCodebaseCache: Map<string, string> = new Map()
let isAnalyzing = false
let hasSentInitialCodebase = false

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

// Check if a file should be ignored based on .gitignore patterns
async function isFileIgnored(
  filePath: string,
  ig: IgnoreInstance
): Promise<boolean> {
  const relativePath = vscode.workspace.asRelativePath(filePath, false)
  return ig.ignores(relativePath)
}

// Compute a simple diff between old and new content
function computeDiff(oldContent: string, newContent: string): string {
  if (!oldContent) {
    return `New file created:\n${newContent}`
  }
  return `Old version:\n${oldContent}\n\nNew version:\n${newContent}`
}

export function activate(context: vscode.ExtensionContext) {
  if (
    !vscode.workspace.workspaceFolders ||
    vscode.workspace.workspaceFolders.length === 0
  ) {
    console.debug(
      "No workspace open, delaying activation until a workspace is loaded"
    )
    return
  }

  console.debug("Shift-V2 extension activated")

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
      console.debug("Starting codebase cache load")
      const files = await vscode.workspace.findFiles(
        "**/*.{ts,js,tsx,jsx}",
        "**/node_modules/**"
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
        previousCodebaseCache.set(file.fsPath, decodedContent)
        progress.report({ increment: 100 / filteredFiles.length })
        console.debug(`Cached file: ${file.fsPath}`)
      }
      console.debug("Codebase cache load completed")
    }
  )

  const fileWatcher = vscode.workspace.createFileSystemWatcher(
    "**/*.{ts,js,tsx,jsx}"
  )
  fileWatcher.onDidCreate(async (uri) => {
    if (gitignore && (await isFileIgnored(uri.fsPath, gitignore))) {
      return
    }
    console.debug(`File created: ${uri.fsPath}`)
    const content = await vscode.workspace.fs.readFile(uri)
    codebaseCache.set(uri.fsPath, new TextDecoder().decode(content))
    console.debug(`Cached new file: ${uri.fsPath}`)
  })
  fileWatcher.onDidDelete((uri) => {
    if (gitignore && codebaseCache.has(uri.fsPath)) {
      console.debug(`File deleted: ${uri.fsPath}`)
    }
    codebaseCache.delete(uri.fsPath)
    previousCodebaseCache.delete(uri.fsPath)
    console.debug(`Removed from cache: ${uri.fsPath}`)
  })
  fileWatcher.onDidChange(async (uri) => {
    if (gitignore && (await isFileIgnored(uri.fsPath, gitignore))) {
      return
    }
    const openDocs = vscode.workspace.textDocuments.map((doc) => doc.fileName)
    if (!openDocs.includes(uri.fsPath)) {
      console.debug(`File changed externally: ${uri.fsPath}`)
      const content = await vscode.workspace.fs.readFile(uri)
      codebaseCache.set(uri.fsPath, new TextDecoder().decode(content))
      console.debug(`Updated cache for: ${uri.fsPath}`)
    }
  })

  const saveListener = vscode.workspace.onDidSaveTextDocument(
    async (document) => {
      if (gitignore && (await isFileIgnored(document.fileName, gitignore))) {
        return
      }
      console.debug(`File saved: ${document.fileName}`)
      const oldContent = codebaseCache.get(document.fileName) || ""
      codebaseCache.set(document.fileName, document.getText())
      console.debug(`Cache updated for: ${document.fileName}`)

      if (!isAnalyzing) {
        isAnalyzing = true
        console.debug("Starting codebase analysis")
        try {
          let userContent: string
          if (!hasSentInitialCodebase) {
            userContent = "# Initial Codebase\n\n"
            for (const [filePath, content] of codebaseCache) {
              const lines = content.split("\n")
              const numberedContent = lines
                .map((line, index) => `${index + 1}: ${line}`)
                .join("\n")
              userContent += `## File: ${filePath}\n\n\`\`\`typescript\n${numberedContent}\n\`\`\`\n\n`
            }
            hasSentInitialCodebase = true
          } else {
            const newContent = document.getText()
            const lines = newContent.split("\n")
            const numberedContent = lines
              .map((line, index) => `${index + 1}: ${line}`)
              .join("\n")
            const diff = computeDiff(oldContent, newContent)
            userContent = `# Changed File: ${document.fileName}\n\n## Diff\n\`\`\`diff\n${diff}\n\`\`\`\n\n## Updated Content\n\`\`\`typescript\n${numberedContent}\n\`\`\``
          }
          const issues = await analyze(userContent)
          console.debug(`Found ${issues.length} issues`)

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
        } finally {
          previousCodebaseCache.set(document.fileName, document.getText())
          isAnalyzing = false
          console.debug("Codebase analysis completed")
        }
      } else {
        console.debug("Skipping analysis - already in progress")
      }
    }
  )

  context.subscriptions.push(fileWatcher, saveListener)
  console.debug("File watcher and save listener registered")
}
