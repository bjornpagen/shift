import * as vscode from "vscode";
import ignore from "ignore";
import { analyze } from "./backend/analysis";
import { showIssueDetails } from "./frontend/issueDetails";
import type { Issue } from "./types";

// Define a type for the ignore instance
interface IgnoreInstance {
  add: (pattern: string | string[]) => IgnoreInstance;
  ignores: (path: string) => boolean;
}

// Global state
export const codebaseCache: Map<string, string> = new Map();
const previousCodebaseCache: Map<string, string> = new Map();
let isAnalyzing = false;
let hasSentInitialCodebase = false;
let currentIssues: Issue[] = [];
// Track which issues have been notified to avoid duplicates
const notifiedIssues = new Set<string>();

// Parse .gitignore files and return an ignore instance
async function getGitignorePatterns(): Promise<IgnoreInstance> {
  const ig = ignore() as IgnoreInstance;
  const gitignoreFiles = await vscode.workspace.findFiles(
    "**/.gitignore",
    "**/node_modules/**"
  );
  for (const file of gitignoreFiles) {
    const content = await vscode.workspace.fs.readFile(file);
    const gitignoreContent = new TextDecoder().decode(content);
    ig.add(gitignoreContent);
  }
  ig.add(["node_modules/**", "dist/**", "*.log"]);
  return ig;
}

// Check if a file should be ignored based on .gitignore patterns
async function isFileIgnored(
  filePath: string,
  ig: IgnoreInstance
): Promise<boolean> {
  const relativePath = vscode.workspace.asRelativePath(filePath, false);
  return ig.ignores(relativePath);
}

// Compute a simple diff between old and new content
function computeDiff(oldContent: string, newContent: string): string {
  if (!oldContent) {
    return `New file created:\n${newContent}`;
  }
  return `Old version:\n${oldContent}\n\nNew version:\n${newContent}`;
}

export function activate(context: vscode.ExtensionContext) {
  if (
    !vscode.workspace.workspaceFolders ||
    vscode.workspace.workspaceFolders.length === 0
  ) {
    console.debug(
      "No workspace open, delaying activation until a workspace is loaded"
    );
    return;
  }

  console.debug("Shift-V2 extension activated");

  let gitignore: IgnoreInstance;
  getGitignorePatterns().then((ig) => {
    gitignore = ig;
  });

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading codebase into cache...",
      cancellable: false,
    },
    async (progress) => {
      console.debug("Starting codebase cache load");
      const files = await vscode.workspace.findFiles(
        "**/*.{ts,js,tsx,jsx}",
        "**/node_modules/**"
      );
      console.debug(`Found ${files.length} files before filtering`);
      let filteredFiles = files;
      if (gitignore) {
        filteredFiles = await Promise.all(
          files.map(async (file) => {
            const ignored = await isFileIgnored(file.fsPath, gitignore);
            return ignored ? null : file;
          })
        ).then((results) =>
          results.filter((file): file is vscode.Uri => file !== null)
        );
      }
      console.debug(
        `Filtered to ${filteredFiles.length} files after .gitignore`
      );
      for (const file of filteredFiles) {
        const content = await vscode.workspace.fs.readFile(file);
        const decodedContent = new TextDecoder().decode(content);
        codebaseCache.set(file.fsPath, decodedContent);
        previousCodebaseCache.set(file.fsPath, decodedContent);
        progress.report({ increment: 100 / filteredFiles.length });
        console.debug(`Cached file: ${file.fsPath}`);
      }
      console.debug("Codebase cache load completed");
    }
  );

  const fileWatcher = vscode.workspace.createFileSystemWatcher(
    "**/*.{ts,js,tsx,jsx}"
  );
  fileWatcher.onDidCreate(async (uri) => {
    if (gitignore && (await isFileIgnored(uri.fsPath, gitignore))) {
      return;
    }
    console.debug(`File created: ${uri.fsPath}`);
    const content = await vscode.workspace.fs.readFile(uri);
    codebaseCache.set(uri.fsPath, new TextDecoder().decode(content));
    console.debug(`Cached new file: ${uri.fsPath}`);
  });
  fileWatcher.onDidDelete((uri) => {
    if (gitignore && codebaseCache.has(uri.fsPath)) {
      console.debug(`File deleted: ${uri.fsPath}`);
    }
    codebaseCache.delete(uri.fsPath);
    previousCodebaseCache.delete(uri.fsPath);
    console.debug(`Removed from cache: ${uri.fsPath}`);
  });
  fileWatcher.onDidChange(async (uri) => {
    if (gitignore && (await isFileIgnored(uri.fsPath, gitignore))) {
      return;
    }
    const openDocs = vscode.workspace.textDocuments.map((doc) => doc.fileName);
    if (!openDocs.includes(uri.fsPath)) {
      console.debug(`File changed externally: ${uri.fsPath}`);
      const content = await vscode.workspace.fs.readFile(uri);
      codebaseCache.set(uri.fsPath, new TextDecoder().decode(content));
      console.debug(`Updated cache for: ${uri.fsPath}`);
    }
  });

  // Define decoration type for code highlights with softer yellow squiggly lines
  const issueDecorationType = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline wavy #FFECB3', // Softer pale goldenrod yellow
    overviewRulerColor: "#FFECB3",
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  // Parse line range from issue location (e.g., "lines 5-7")
  function parseLineRange(location: string): { start: number; end: number } | null {
    const match = location.match(/lines (\d+)-(\d+)/);
    if (match) {
      return { start: Number.parseInt(match[1]), end: Number.parseInt(match[2]) };
    }
    return null;
  }

  // Update decorations for all visible editors
  function updateDecorations() {
    const issuesByFile: Map<string, Issue[]> = new Map();
    for (const issue of currentIssues) {
      if (!issuesByFile.has(issue.file)) {
        issuesByFile.set(issue.file, []);
      }
      issuesByFile.get(issue.file)!.push(issue);
    }
    for (const editor of vscode.window.visibleTextEditors) {
      const filePath = editor.document.fileName;
      const fileIssues = issuesByFile.get(filePath) || [];
      const ranges = fileIssues
        .map(issue => {
          const lineRange = parseLineRange(issue.location);
          if (lineRange) {
            // Convert to 0-based line numbers
            return new vscode.Range(lineRange.start - 1, 0, lineRange.end - 1, 0);
          }
          return null;
        })
        .filter((range): range is vscode.Range => range !== null);
      editor.setDecorations(issueDecorationType, ranges);
    }
  }

  // Register command to open issue details
  const openIssueDetailsCommand = vscode.commands.registerCommand(
    "shift-v2.openIssueDetails",
    (issueIndex: number) => {
      if (issueIndex >= 0 && issueIndex < currentIssues.length) {
        const issue = currentIssues[issueIndex];
        showIssueDetails(issue);
      }
    }
  );

  // Register hover provider with clickable link
  const hoverProvider = vscode.languages.registerHoverProvider(
    ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'],
    {
      provideHover(document, position, token) {
        const filePath = document.fileName;
        const line = position.line + 1; // Convert to 1-based line numbers
        const fileIssues = currentIssues.filter(issue => issue.file === filePath);
        for (let i = 0; i < fileIssues.length; i++) {
          const issue = fileIssues[i];
          const lineRange = parseLineRange(issue.location);
          if (lineRange && line >= lineRange.start && line <= lineRange.end) {
            const issueIndex = currentIssues.indexOf(issue);
            const hoverContent = new vscode.MarkdownString();
            hoverContent.appendMarkdown(`**Issue:** ${issue.description}\n\n`);
            hoverContent.appendMarkdown(`**Explanation:** ${issue.explanation}\n\n`);
            hoverContent.appendMarkdown(`**Suggestion:** ${issue.suggestion}\n\n`);
            hoverContent.appendMarkdown(`[Open Details](command:shift-v2.openIssueDetails?${encodeURIComponent(JSON.stringify([issueIndex]))})`);
            hoverContent.isTrusted = true; // Allow command links
            return new vscode.Hover(hoverContent);
          }
        }
        return null;
      }
    }
  );

  const saveListener = vscode.workspace.onDidSaveTextDocument(
    async (document) => {
      if (gitignore && (await isFileIgnored(document.fileName, gitignore))) {
        return;
      }
      console.debug(`File saved: ${document.fileName}`);
      const oldContent = codebaseCache.get(document.fileName) || "";
      codebaseCache.set(document.fileName, document.getText());
      console.debug(`Cache updated for: ${document.fileName}`);

      if (!isAnalyzing) {
        isAnalyzing = true;
        console.debug("Starting codebase analysis");
        try {
          let userContent: string;
          if (!hasSentInitialCodebase) {
            userContent = "# Initial Codebase\n\n";
            for (const [filePath, content] of codebaseCache) {
              const lines = content.split("\n");
              const numberedContent = lines
                .map((line, index) => `${index + 1}: ${line}`)
                .join("\n");
              userContent += `## File: ${filePath}\n\n\`\`\`typescript\n${numberedContent}\n\`\`\`\n\n`;
            }
            hasSentInitialCodebase = true;
          } else {
            const newContent = document.getText();
            const lines = newContent.split("\n");
            const numberedContent = lines
              .map((line, index) => `${index + 1}: ${line}`)
              .join("\n");
            const diff = computeDiff(oldContent, newContent);
            userContent = `# Changed File: ${document.fileName}\n\n## Diff\n\`\`\`diff\n${diff}\n\`\`\`\n\n## Updated Content\n\`\`\`typescript\n${numberedContent}\n\`\`\``;
          }
          const issues = await analyze(userContent);
          console.debug(`Found ${issues.length} issues`);
          currentIssues = issues;
          updateDecorations(); // Apply squiggly lines after analysis

          for (const issue of issues) {
            console.debug(
              `Notifying issue in ${issue.file}: ${issue.description}`
            );
            const relativeFile = vscode.workspace.asRelativePath(
              issue.file,
              false
            );
            await vscode.window
              .showWarningMessage(
                `Issue in ${relativeFile}: ${issue.description}`,
                "Tell Me More"
              )
              .then((selection) => {
                if (selection === "Tell Me More") {
                  console.debug(`Showing details for issue in ${issue.file}`);
                  showIssueDetails(issue);
                }
              });
          }
        } finally {
          previousCodebaseCache.set(document.fileName, document.getText());
          isAnalyzing = false;
          console.debug("Codebase analysis completed");
        }
      } else {
        console.debug("Skipping analysis - already in progress");
      }
    }
  );

  // Register disposables
  context.subscriptions.push(fileWatcher, saveListener, hoverProvider, openIssueDetailsCommand);
  vscode.window.onDidChangeVisibleTextEditors(updateDecorations, null, context.subscriptions);
  console.debug("File watcher, save listener, hover provider, and command registered");
}