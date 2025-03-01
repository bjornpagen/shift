import * as vscode from "vscode"
import * as path from "node:path"
import type { KuzuConnection } from "./kuzu"
import type { Ignore } from "ignore"
import { analyze } from "./analysis"
import { tryCatch } from "../utils/try-catch"
import { initialLoad } from "./workspace-init"
import type { Issue } from "../types"

export async function analyzeWorkspace(
  connection: KuzuConnection,
  ig: Ignore
): Promise<Issue[]> {
  console.debug("Starting workspace analysis")
  const progress = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  )
  let analysisCancellation: vscode.CancellationTokenSource | undefined =
    new vscode.CancellationTokenSource()

  try {
    progress.text = "$(sync~spin) Initializing analysis..."
    progress.show()

    await initialLoad(connection, ig)

    console.debug("Gathering file information for analysis")
    progress.text = "$(sync~spin) Gathering files for analysis..."

    const filesResult = await tryCatch(
      connection.query<{ path: string }>("MATCH (f:File) RETURN f.path as path")
    )

    if (filesResult.error) {
      console.error(`Error querying files: ${filesResult.error}`)
      vscode.window.showErrorMessage("Failed to retrieve files from database.")
      return []
    }

    const filesData = await tryCatch(filesResult.data.getAll())

    if (filesData.error) {
      console.error(`Error getting file data: ${filesData.error}`)
      vscode.window.showErrorMessage("Failed to get file data.")
      return []
    }

    const files = filesData.data
    console.debug(`Found ${files.length} files in database for analysis`)

    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders) {
      console.debug("No workspace folders found, aborting analysis")
      vscode.window.showErrorMessage("No workspace folders found.")
      return []
    }
    const rootPath = workspaceFolders[0].uri.fsPath

    // Show cancel button in notification
    const cancelOption = "Cancel Analysis"
    vscode.window
      .showInformationMessage(
        `Starting analysis of ${files.length} files. This may take some time.`,
        cancelOption
      )
      .then((selection) => {
        if (selection === cancelOption && analysisCancellation) {
          analysisCancellation.cancel()
          vscode.window.showInformationMessage("Analysis cancelled.")
        }
      })

    // Create array of analysis promises to run in parallel
    let completedFiles = 0
    const analysisPromises = files.map(async (file) => {
      if (analysisCancellation?.token.isCancellationRequested) {
        return { file: file.path, issues: [] }
      }

      console.debug(`Preparing analysis for file: ${file.path}`)
      const filePath = file.path
      progress.text = `$(sync~spin) Analyzing (${completedFiles}/${files.length}): ${path.basename(filePath)}`

      const safeFilePath = filePath.replace(/'/g, "''")

      // Get all functions in this file
      const functionsResult = await tryCatch(
        connection.query<{
          id: string
          name: string
          startLine: number
          startColumn: number
          endLine: number
          endColumn: number
        }>(
          `MATCH (f:File {path: '${safeFilePath}'})-[:HasFunction]->(func:Function)
           RETURN func.id as id, func.name as name, func.startLine as startLine,
           func.startColumn as startColumn, func.endLine as endLine, func.endColumn as endColumn`
        )
      )

      if (functionsResult.error) {
        console.error(
          `Error querying functions for ${filePath}: ${functionsResult.error}`
        )
        return { file: filePath, issues: [] }
      }

      const functionsData = await tryCatch(functionsResult.data.getAll())

      if (functionsData.error) {
        console.error(
          `Error getting function data for ${filePath}: ${functionsData.error}`
        )
        return { file: filePath, issues: [] }
      }

      const functions = functionsData.data
      console.debug(`Found ${functions.length} functions in file ${filePath}`)

      // Get all called functions (external dependencies) for each function
      const calledFunctionIds = new Set<string>()
      const functionDependencyPromises = functions.map(async (func) => {
        if (analysisCancellation?.token.isCancellationRequested) {
          return []
        }

        const calledFunctionsResult = await tryCatch(
          connection.query<{
            id: string
            name: string
            path: string
            startLine: number
            endLine: number
          }>(
            `MATCH (caller:Function {id: '${func.id.replace(/'/g, "''")}'})-[:Calls]->(callee:Function)
             MATCH (f:File)-[:HasFunction]->(callee)
             RETURN callee.id as id, callee.name as name, f.path as path,
             callee.startLine as startLine, callee.endLine as endLine`
          )
        )

        if (calledFunctionsResult.error) {
          console.error(
            `Error querying called functions for ${func.id}: ${calledFunctionsResult.error}`
          )
          return []
        }

        const calledFunctionsData = await tryCatch(
          calledFunctionsResult.data.getAll()
        )

        if (calledFunctionsData.error) {
          console.error(
            `Error getting called function data for ${func.id}: ${calledFunctionsData.error}`
          )
          return []
        }

        const calledFunctions = calledFunctionsData.data

        return calledFunctions
          .filter((cf) => cf.path !== filePath)
          .map((cf) => cf.id)
      })

      const calledFunctionsArrays = await Promise.all(
        functionDependencyPromises
      )
      for (const id of calledFunctionsArrays.flat()) {
        calledFunctionIds.add(id)
      }

      const calledFunctionsArray = Array.from(calledFunctionIds)
      console.debug(
        `Found ${calledFunctionsArray.length} external function dependencies for file ${filePath}`
      )

      // Get the source code for the file being analyzed
      let fileContent = ""
      try {
        const absolutePath = path.join(rootPath, filePath)
        const fileUri = vscode.Uri.file(absolutePath)
        const contentResult = await tryCatch(
          Promise.resolve(vscode.workspace.fs.readFile(fileUri))
        )

        if (contentResult.error) {
          console.error(
            `Error reading file ${filePath}: ${contentResult.error}`
          )
          return { file: filePath, issues: [] }
        }

        fileContent = new TextDecoder().decode(contentResult.data)
      } catch (error) {
        console.error(`Error reading file ${filePath}: ${error}`)
        return { file: filePath, issues: [] }
      }

      // Build context with source code and function dependencies
      let analysisContext = `## File Analysis\n${filePath}\n\n\`\`\`typescript\n${fileContent}\n\`\`\`\n\n`

      if (calledFunctionsArray.length > 0) {
        analysisContext += "\n## Function Dependencies\n\n"

        // Get source code for external function dependencies in parallel
        const dependencyPromises = calledFunctionsArray.map(async (funcId) => {
          if (analysisCancellation?.token.isCancellationRequested) {
            return null
          }

          const functionInfoResult = await tryCatch(
            connection.query<{
              name: string
              path: string
              startLine: number
              endLine: number
            }>(
              `MATCH (func:Function {id: '${funcId.replace(/'/g, "''")}'}), (f:File)-[:HasFunction]->(func)
               RETURN func.name as name, f.path as path, func.startLine as startLine, func.endLine as endLine`
            )
          )

          if (functionInfoResult.error) {
            console.error(
              `Error querying function info for ${funcId}: ${functionInfoResult.error}`
            )
            return null
          }

          const functionInfoData = await tryCatch(
            functionInfoResult.data.getAll()
          )

          if (functionInfoData.error || functionInfoData.data.length === 0) {
            console.error(
              `Error getting function info data for ${funcId}: ${functionInfoData.error || "No results"}`
            )
            return null
          }

          const functionInfo = functionInfoData.data[0]

          try {
            const depFilePath = path.join(rootPath, functionInfo.path)
            const depFileUri = vscode.Uri.file(depFilePath)
            const depContentResult = await tryCatch(
              Promise.resolve(vscode.workspace.fs.readFile(depFileUri))
            )

            if (depContentResult.error) {
              console.error(
                `Error reading dependency file ${depFilePath}: ${depContentResult.error}`
              )
              return null
            }

            const depContent = new TextDecoder().decode(depContentResult.data)

            // Extract just the function code using line numbers
            const lines = depContent.split("\n")
            const functionLines = lines.slice(
              functionInfo.startLine - 1,
              functionInfo.endLine
            )
            const functionCode = functionLines.join("\n")

            return {
              name: functionInfo.name,
              path: functionInfo.path,
              code: functionCode
            }
          } catch (error) {
            console.error(
              `Error reading dependency file for function ${functionInfo.name}: ${error}`
            )
            return null
          }
        })

        const dependencyResults = await Promise.all(dependencyPromises)

        for (const dep of dependencyResults) {
          if (dep) {
            analysisContext += `### ${dep.name} (from ${dep.path})\n\n\`\`\`typescript\n${dep.code}\n\`\`\`\n\n`
          }
        }
      }

      // Call the analyze function with the built context
      console.debug(`Generating analysis for file: ${filePath}`)
      try {
        const issues = await analyze(analysisContext, [])
        completedFiles++
        progress.text = `$(sync~spin) Analyzing (${completedFiles}/${files.length}): ${path.basename(filePath)}`
        return { file: filePath, issues }
      } catch (error) {
        console.error(`Error analyzing file ${filePath}: ${error}`)
        completedFiles++
        progress.text = `$(sync~spin) Analyzing (${completedFiles}/${files.length}): ${path.basename(filePath)}`
        return { file: filePath, issues: [] }
      }
    })

    // Run all analyses in parallel with a concurrency limit
    console.debug(`Starting parallel analysis of ${files.length} files`)
    const concurrencyLimit = 5 // Limit concurrent API calls
    const chunks = []
    for (let i = 0; i < analysisPromises.length; i += concurrencyLimit) {
      if (analysisCancellation?.token.isCancellationRequested) {
        break
      }
      chunks.push(analysisPromises.slice(i, i + concurrencyLimit))
    }

    const results: PromiseSettledResult<{ file: string; issues: Issue[] }>[] =
      []
    for (const chunk of chunks) {
      if (analysisCancellation?.token.isCancellationRequested) {
        break
      }
      const chunkResults = await Promise.allSettled(chunk)
      results.push(...chunkResults)
    }

    const allIssues: Issue[] = []

    // Process results
    for (const result of results) {
      if (result.status === "fulfilled") {
        const { issues } = result.value
        if (issues && issues.length > 0) {
          allIssues.push(...issues)
        }
      } else {
        console.error(`Analysis failed: ${result.reason}`)
      }
    }

    console.debug(`Analysis completed with ${allIssues.length} issues found`)
    if (!analysisCancellation?.token.isCancellationRequested) {
      vscode.window.showInformationMessage(
        `Analysis completed with ${allIssues.length} issues found.`
      )
    }

    console.debug("Workspace analysis completed")
    return allIssues
  } catch (error) {
    console.error("Error in workspace analysis:", error)
    vscode.window.showErrorMessage(
      `Analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`
    )
    return []
  } finally {
    progress.dispose()
    analysisCancellation?.dispose()
    analysisCancellation = undefined
  }
}
