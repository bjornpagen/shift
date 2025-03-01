import * as vscode from "vscode"
import * as path from "node:path"
import { updateKuzuDatabaseForProject, type KuzuConnection } from "./kuzu"
import type { Ignore } from "ignore"
import { tryCatch } from "../utils/try-catch"

async function getRelevantFiles(ig: Ignore): Promise<vscode.Uri[]> {
  console.debug("Fetching relevant files")
  const filesResult = await tryCatch(
    Promise.resolve(
      vscode.workspace.findFiles("**/*.{ts,tsx}", "**/node_modules/**")
    )
  )

  if (filesResult.error) {
    console.error(`Error finding files: ${filesResult.error}`)
    return []
  }

  const files = filesResult.data
  console.debug(`Found ${files.length} files before filtering`)
  const filteredFiles = files.filter(
    (file) => !ig.ignores(vscode.workspace.asRelativePath(file, false))
  )
  console.debug(`Filtered to ${filteredFiles.length} relevant files`)
  for (const file of filteredFiles) {
    console.debug(`Relevant file: ${file.fsPath}`)
  }
  return filteredFiles
}

export async function initialLoad(conn: KuzuConnection, ig: Ignore) {
  console.debug("Starting initial load process")
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (!workspaceFolders) {
    console.debug("No workspace folders found, aborting initial load")
    vscode.window.showErrorMessage("No workspace folders found.")
    return
  }
  const rootPath = workspaceFolders[0].uri.fsPath
  console.debug(`Using root path: ${rootPath}`)

  const filesResultQuery = await tryCatch(
    conn.query("MATCH (f:File) RETURN count(f) as count")
  )

  if (filesResultQuery.error) {
    console.error(`Error querying file count: ${filesResultQuery.error}`)
    vscode.window.showErrorMessage("Failed to query database file count.")
    return
  }

  const filesResultData = await tryCatch(filesResultQuery.data.getAll())

  if (filesResultData.error) {
    console.error(`Error getting file count data: ${filesResultData.error}`)
    vscode.window.showErrorMessage("Failed to get file count data.")
    return
  }

  const count = Number(filesResultData.data[0].count)
  console.debug(`Database contains ${count} files`)
  if (count > 0) {
    console.debug("Database already populated, skipping initial load")
    vscode.window.showInformationMessage(
      "Database already populated. Skipping initial load."
    )
    return
  }

  console.debug("Finding relevant TypeScript files")
  const files = await getRelevantFiles(ig)
  console.debug(`Found ${files.length} files to process`)

  console.debug("Reading file contents")
  const fileContents = await Promise.all(
    files.map(async (file) => {
      const filePath = file.fsPath
      console.debug(`Reading file: ${filePath}`)

      const contentResult = await tryCatch(
        Promise.resolve(vscode.workspace.fs.readFile(file))
      )

      if (contentResult.error) {
        console.error(`Error reading file ${filePath}: ${contentResult.error}`)
        return null
      }

      const content = new TextDecoder().decode(contentResult.data)
      const relativePath = path.relative(rootPath, filePath)
      console.debug(
        `Processed file: ${relativePath}, content length: ${content.length}`
      )
      return {
        path: relativePath,
        content
      }
    })
  )

  const validFileContents = fileContents.filter(
    (fc): fc is { path: string; content: string } => fc !== null
  )

  console.debug(`Processed ${validFileContents.length} file contents`)
  console.debug(
    `Files processed: ${validFileContents.map((fc) => fc.path).join(", ")}`
  )

  console.debug("Updating Kùzu database with all files")
  const updateResult = await tryCatch(
    updateKuzuDatabaseForProject(validFileContents, conn)
  )

  if (updateResult.error) {
    console.error(`Error updating database: ${updateResult.error}`)
    vscode.window.showErrorMessage("Failed to update database with files.")
    return
  }

  console.debug("Initial load completed successfully")
}
