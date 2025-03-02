import * as vscode from "vscode"
import * as path from "node:path"
import type { KuzuConnection } from "./kuzu"
import type { Ignore } from "ignore"
import { tryCatch } from "../utils/try-catch"
import { initialLoad } from "./workspace-init"

interface AnalysisJob {
  filePath: string
  userContent: string
}

export async function analyzeWorkspace(
  connection: KuzuConnection,
  ig: Ignore,
  addToQueue: (job: AnalysisJob) => void
): Promise<void> {
  console.debug("Starting workspace analysis")

  try {
    await initialLoad(connection, ig)

    console.debug("Gathering file information for analysis")

    const filesResult = await tryCatch(
      connection.query<{ path: string }>("MATCH (f:File) RETURN f.path as path")
    )

    if (filesResult.error) {
      console.error(`Error querying files: ${filesResult.error}`)
      vscode.window.showErrorMessage("Failed to retrieve files from database.")
      return
    }

    const filesData = await tryCatch(filesResult.data.getAll())

    if (filesData.error) {
      console.error(`Error getting file data: ${filesData.error}`)
      vscode.window.showErrorMessage("Failed to get file data.")
      return
    }

    const files = filesData.data
    console.debug(`Found ${files.length} files in database for analysis`)

    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders) {
      console.debug("No workspace folders found, aborting analysis")
      vscode.window.showErrorMessage("No workspace folders found.")
      return
    }
    const rootPath = workspaceFolders[0].uri.fsPath

    for (const file of files) {
      console.debug(`Preparing analysis for file: ${file.path}`)
      const filePath = file.path

      const safeFilePath = filePath.replace(/'/g, "''")

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
        continue
      }

      const functionsData = await tryCatch(functionsResult.data.getAll())

      if (functionsData.error) {
        console.error(
          `Error getting function data for ${filePath}: ${functionsData.error}`
        )
        continue
      }

      const functions = functionsData.data
      console.debug(`Found ${functions.length} functions in file ${filePath}`)

      const calledFunctionIds = new Set<string>()
      const functionDependencyPromises = functions.map(async (func) => {
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
          continue
        }

        fileContent = new TextDecoder().decode(contentResult.data)
      } catch (error) {
        console.error(`Error reading file ${filePath}: ${error}`)
        continue
      }

      // Prepend line numbers to the main file content
      const lines = fileContent.split("\n")
      const numberedLines = lines.map((line, index) => `${index + 1}: ${line}`)
      const numberedFileContent = numberedLines.join("\n")
      let analysisContext = `## File Analysis\n${filePath}\n\n\`\`\`typescript\n${numberedFileContent}\n\`\`\`\n\n`

      if (calledFunctionsArray.length > 0) {
        analysisContext += "\n## Function Dependencies\n\n"

        const dependencyPromises = calledFunctionsArray.map(async (funcId) => {
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
            const lines = depContent.split("\n")
            const functionLines = lines.slice(
              functionInfo.startLine - 1,
              functionInfo.endLine
            )
            // Prepend actual line numbers for dependent function
            const functionLinesWithNumbers = functionLines.map(
              (line, index) => `${functionInfo.startLine + index}: ${line}`
            )
            const numberedFunctionCode = functionLinesWithNumbers.join("\n")

            return {
              name: functionInfo.name,
              path: functionInfo.path,
              code: numberedFunctionCode
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

      console.debug(`Adding analysis job for file: ${filePath}`)
      addToQueue({ filePath, userContent: analysisContext })
    }

    console.debug("Workspace analysis jobs queued")
  } catch (error) {
    console.error("Error in workspace analysis:", error)
    vscode.window.showErrorMessage(
      `Analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`
    )
  }
}
